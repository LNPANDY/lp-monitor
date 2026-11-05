import { ok, fail, getBody } from "@/lib/api";
import { getDb, setPairFlip, isPairFlipped } from "@/lib/db";

/** PUT: 翻转交易对展示顺序（同步更新同链同交易对的所有仓位、探针与建仓面板） */
export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  const body = await getBody<{
    flip?: boolean;
  }>(req);

  try {
    const db = getDb();
    const id = Number(params.id);

    const pos = db.prepare(
      `SELECT chain_id_ref, dex_name, token0, token1, pair_flip FROM positions WHERE id=?`
    ).get(id) as { chain_id_ref: number; dex_name: string; token0: string; token1: string; pair_flip: number } | undefined;

    if (!pos) {
      return fail("Position not found");
    }

    const flipBool = !!body.flip;
    const flipVal = flipBool ? 1 : 0;
    setPairFlip(pos.chain_id_ref, pos.token0, pos.token1, flipBool, pos.dex_name);

    return ok({
      id: params.id,
      pair_flip: flipVal,
      message: flipBool ? "交易对已翻转为 token1/token0" : "交易对已重置为 token0/token1"
    });
  } catch (e: any) {
    return fail(e.message);
  }
}

/** GET: 获取当前交易对翻转状态 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT chain_id_ref, pair_flip, token0, token1, token0_symbol, token1_symbol
         FROM positions WHERE id=?`
      )
      .get(Number(params.id)) as
      | { chain_id_ref: number; pair_flip: number; token0: string; token1: string; token0_symbol: string; token1_symbol: string }
      | undefined;

    if (!row) {
      return fail("Position not found");
    }

    const { chain_id_ref, token0, token1, token0_symbol, token1_symbol } = row;
    const flipped = row.pair_flip === 1 || isPairFlipped(chain_id_ref, token0, token1);
    const pair_flip = flipped ? 1 : 0;

    return ok({
      id: params.id,
      pair_flip,
      tokens: {
        token0,
        token1,
        token0_symbol: token0_symbol || token0.substring(0, 6),
        token1_symbol: token1_symbol || token1.substring(0, 6)
      },
      current_display: pair_flip ? `${token1_symbol}/${token0_symbol}` : `${token0_symbol}/${token1_symbol}`,
      original_display: `${token0_symbol}/${token1_symbol}`
    });
  } catch (e: any) {
    return fail(e.message);
  }
}
