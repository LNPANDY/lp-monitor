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
    const result = db
      .prepare("UPDATE positions SET pair_flip=? WHERE id=?")
      .run(body.flip ? 1 : 0, Number(params.id));

    if (result.changes === 0) {
      return fail("Position not found");
    }

    return ok({
      id: params.id,
      pair_flip: body.flip ? 1 : 0,
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
