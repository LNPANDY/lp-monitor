import { ok, fail, getBody } from "@/lib/api";
import { getDb } from "@/lib/db";

/** PUT: 翻转交易对展示顺序 */
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

    // 先查仓位信息，用于同步 pair_flips 表
    const pos = db.prepare(
      `SELECT chain_id_ref, dex_name, token0, token1, pair_flip FROM positions WHERE id=?`
    ).get(id) as { chain_id_ref: number; dex_name: string; token0: string; token1: string; pair_flip: number } | undefined;

    if (!pos) {
      return fail("Position not found");
    }

    // 更新 positions 表
    const flipVal = body.flip ? 1 : 0;
    const result = db
      .prepare("UPDATE positions SET pair_flip=? WHERE id=?")
      .run(flipVal, id);

    if (result.changes === 0) {
      return fail("Position not found");
    }

    // 同步 pair_flips 表：翻转时写入/忽略，取消翻转时删除
    const t0 = pos.token0.toLowerCase();
    const t1 = pos.token1.toLowerCase();
    if (flipVal === 1) {
      db.prepare(
        `INSERT OR IGNORE INTO pair_flips (chain_id_ref, dex_name, token0, token1) VALUES (?,?,?,?)`
      ).run(pos.chain_id_ref, pos.dex_name, t0, t1);
    } else {
      db.prepare(
        `DELETE FROM pair_flips WHERE chain_id_ref=? AND dex_name=? AND token0=? AND token1=?`
      ).run(pos.chain_id_ref, pos.dex_name, t0, t1);
    }

    return ok({
      id: params.id,
      pair_flip: flipVal,
      message: body.flip ? "交易对已翻转为 token1/token0" : "交易对已重置为 token0/token1"
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
        `SELECT pair_flip, token0, token1, token0_symbol, token1_symbol
         FROM positions WHERE id=?`
      )
      .get(Number(params.id)) as
      | { pair_flip: number; token0: string; token1: string; token0_symbol: string; token1_symbol: string }
      | undefined;

    if (!row) {
      return fail("Position not found");
    }

    const { pair_flip, token0, token1, token0_symbol, token1_symbol } = row;

    return ok({
      id: params.id,
      pair_flip: pair_flip,
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
