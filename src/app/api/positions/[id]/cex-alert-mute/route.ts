import { ok, fail, getBody } from "@/lib/api";
import { getDb } from "@/lib/db";

/** PUT: 切换该仓位 token 对的 CEX 差价预警静音状态 */
export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  const body = await getBody<{
    mute?: boolean;
  }>(req);

  try {
    const db = getDb();
    const id = Number(params.id);

    // 查仓位信息，获取 chain_id_ref + token0/token1（小写）
    const pos = db.prepare(
      `SELECT chain_id_ref, token0, token1 FROM positions WHERE id=?`
    ).get(id) as { chain_id_ref: number; token0: string; token1: string } | undefined;

    if (!pos) {
      return fail("Position not found");
    }

    const t0 = pos.token0.toLowerCase();
    const t1 = pos.token1.toLowerCase();

    if (body.mute) {
      // 静音：写入记录（已存在则忽略）
      db.prepare(
        `INSERT OR IGNORE INTO cex_alert_mutes (chain_id_ref, token0, token1) VALUES (?,?,?)`
      ).run(pos.chain_id_ref, t0, t1);
    } else {
      // 取消静音：删除记录
      db.prepare(
        `DELETE FROM cex_alert_mutes WHERE chain_id_ref=? AND token0=? AND token1=?`
      ).run(pos.chain_id_ref, t0, t1);
    }

    return ok({
      id: params.id,
      muted: body.mute,
      message: body.mute ? "已静音该交易对的 CEX 差价预警" : "已恢复该交易对的 CEX 差价预警"
    });
  } catch (e: any) {
    return fail(e.message);
  }
}

/** GET: 获取该仓位 token 对的 CEX 差价预警静音状态 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDb();
    const id = Number(params.id);

    const pos = db.prepare(
      `SELECT chain_id_ref, token0, token1 FROM positions WHERE id=?`
    ).get(id) as { chain_id_ref: number; token0: string; token1: string } | undefined;

    if (!pos) {
      return fail("Position not found");
    }

    const row = db.prepare(
      `SELECT id FROM cex_alert_mutes WHERE chain_id_ref=? AND token0=? AND token1=?`
    ).get(pos.chain_id_ref, pos.token0.toLowerCase(), pos.token1.toLowerCase());

    return ok({
      id: params.id,
      muted: !!row,
    });
  } catch (e: any) {
    return fail(e.message);
  }
}
