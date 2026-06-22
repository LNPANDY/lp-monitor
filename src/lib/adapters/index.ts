import type { PublicClient } from "viem";
import { V3RangeStatus, readRangeStatus } from "./v3-fork";

/** 仓位读取结果的三态：closed=已平仓 / unreadable=读不到（保留旧状态）/ ok=正常。 */
export type RangeReadResult =
  | { kind: "closed" }
  | { kind: "unreadable" }
  | {
      kind: "ok";
      status: V3RangeStatus;
      token0: string;
      token1: string;
      fee: number;
      tickLower: number;
      tickUpper: number;
      liquidity: bigint;
    };

/** 适配器统一接口。后续接入 Trader Joe LB / Uniswap V4 时实现新类型即可。 */
export interface PositionAdapter {
  type: string;
  readRange(
    client: PublicClient,
    ctx: { factory: string; npm: string },
    tokenId: bigint
  ): Promise<RangeReadResult>;
}

const v3ForkAdapter: PositionAdapter = {
  type: "v3-fork",
  async readRange(client, ctx, tokenId) {
    const r = await readRangeStatus(
      client,
      ctx.factory as `0x${string}`,
      ctx.npm as `0x${string}`,
      tokenId
    );
    if (r.kind !== "ok") return r; // closed / unreadable 原样透传
    return {
      kind: "ok",
      status: r.status,
      token0: r.meta.token0,
      token1: r.meta.token1,
      fee: r.meta.fee,
      tickLower: r.meta.tickLower,
      tickUpper: r.meta.tickUpper,
      liquidity: r.meta.liquidity,
    };
  },
};

const registry: Record<string, PositionAdapter> = {
  "v3-fork": v3ForkAdapter,
};

export function getAdapter(type: string): PositionAdapter {
  const a = registry[type];
  if (!a) throw new Error(`unsupported dex type: ${type}`);
  return a;
}

export function supportedTypes(): string[] {
  return Object.keys(registry);
}
