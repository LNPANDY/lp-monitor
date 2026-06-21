import type { PublicClient } from "viem";
import { V3RangeStatus, readRangeStatus } from "./v3-fork";

/** 适配器统一接口。后续接入 Trader Joe LB / Uniswap V4 时实现新类型即可。 */
export interface PositionAdapter {
  type: string;
  readRange(
    client: PublicClient,
    ctx: { factory: string; npm: string },
    tokenId: bigint
  ): Promise<{ status: V3RangeStatus; token0: string; token1: string; fee: number; tickLower: number; tickUpper: number; liquidity: bigint } | null>;
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
    if (!r) return null;
    return {
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
