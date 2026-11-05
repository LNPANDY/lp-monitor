import { ok, fail, getBody } from "@/lib/api";
import { setPairFlip } from "@/lib/db";
import { listDexes } from "@/lib/chains/dexes";

export const dynamic = "force-dynamic";

/**
 * PUT: 翻转探针或建仓面板池子的交易对展示顺序。
 * 复用 setPairFlip（与仓位翻转、收藏列表、建仓面板共享偏好）。
 *
 * body: { chain_id, token0, token1, flip: boolean, npm? }
 */
export async function PUT(req: Request) {
  const b = await getBody<{
    chain_id?: number;
    token0?: string;
    token1?: string;
    flip?: boolean;
    npm?: string;
  }>(req);

  if (!b.chain_id || !b.token0 || !b.token1 || b.flip === undefined) {
    return fail("缺少 chain_id / token0 / token1 / flip");
  }

  const t0 = b.token0.trim().toLowerCase();
  const t1 = b.token1.trim().toLowerCase();

  // npm → dex_name 反查
  let dexName = "";
  if (b.npm) {
    const matched = listDexes(b.chain_id, false).find(
      (d) => d.npm.toLowerCase() === b.npm!.trim().toLowerCase()
    );
    dexName = matched?.name ?? "";
  }

  const flipBool = !!b.flip;
  setPairFlip(b.chain_id, t0, t1, flipBool, dexName);

  return ok({
    chain_id: b.chain_id,
    token0: t0,
    token1: t1,
    pair_flip: flipBool ? 1 : 0,
    dex_name: dexName,
    message: flipBool ? "交易对已翻转为 token1/token0" : "交易对已重置为 token0/token1",
  });
}
