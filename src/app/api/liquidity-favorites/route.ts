import { getDb, isPairFlipped } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";
import { getClient } from "@/lib/chains";
import { resolveTokens } from "@/lib/chains/tokens";
import { ZIA_INCENTIVIZED_POOLS } from "@/lib/monitor/merkl-rewards";

export const dynamic = "force-dynamic";

/**
 * EVM 地址校验：0x 开头 + 40 位十六进制字符。空串允许（staker/npm 可选）。
 * 防止 SQL 注入/XSS/命令注入 payload 被写入 DB（攻击者会将恶意字符串塞入 pool_addr/staker_addr）。
 */
function isValidEvmAddress(addr: string): boolean {
  if (addr === "") return true; // 可选字段允许空
  return /^0x[a-f0-9]{40}$/i.test(addr);
}

/**
 * label 校验：允许中文/字母/数字/常见符号，最长 50 字符，禁止脚本/SQL 关键字注入。
 */
function isValidLabel(label: string): boolean {
  if (label === "") return true;
  if (label.length > 50) return false;
  // 禁止 < > （XSS）、; （SQL）/管道/反引号（命令注入）
  if (/[<>;`|]/.test(label)) return false;
  return true;
}

interface FavoriteRow {
  id: number;
  chain_id_ref: number;
  label: string;
  pool_addr: string;
  staker_addr: string;
  npm_addr: string;
  sort_order: number;
  created_at: string;
  token0?: string;
  token1?: string;
  token0_symbol: string;
  token1_symbol: string;
  fee: number | null;
  pair_flip?: number;
}

interface ChainInfo {
  id: number;
  name: string;
}

/** 列出所有收藏（带链名，按 sort_order 降序、created_at 降序）。
 *  额外关联最近一次快照的 token0/token1 symbol、fee 以及全局 pair_flip 翻转状态，用于前端展示。 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = url.searchParams.get("chain_id");
  const db = getDb();
  let sql = `SELECT f.*, c.name AS chain_name,
                    f.token0_symbol,
                    f.token1_symbol,
                    COALESCE(json_extract(ls.payload, '$.fee'), 0) AS fee
             FROM liquidity_favorites f
             JOIN chains c ON c.id=f.chain_id_ref
             LEFT JOIN (
               SELECT chain_id_ref, pool_addr, staker_addr, payload
               FROM liquidity_snapshots
               WHERE id IN (
                 SELECT MAX(id) FROM liquidity_snapshots
                 GROUP BY chain_id_ref, pool_addr, staker_addr
               )
             ) ls ON ls.chain_id_ref=f.chain_id_ref
                  AND ls.pool_addr=f.pool_addr
                  AND ls.staker_addr=f.staker_addr
             WHERE 1=1`;
  const args: any[] = [];
  if (chainId) { sql += " AND f.chain_id_ref=?"; args.push(Number(chainId)); }
  sql += " ORDER BY f.sort_order DESC, f.created_at DESC";
  const rows = db.prepare(sql).all(...args) as (FavoriteRow & ChainInfo)[];

  const enhancedRows = rows.map(row => {
    let t0 = row.token0 || "";
    let t1 = row.token1 || "";
    let sym0 = row.token0_symbol || "";
    let sym1 = row.token1_symbol || "";
    let fee: number | null = row.fee && row.fee > 0 ? Number(row.fee) : null;

    // 如果缺少 token0/token1、symbol 或 fee，尝试从 positions 表同池子记录补全
    if (!t0 || !t1 || !sym0 || !sym1 || !fee) {
      const pos = db.prepare(`
        SELECT token0, token1, token0_symbol, token1_symbol, fee, pair_flip
        FROM positions
        WHERE chain_id_ref = ? AND LOWER(pool) = LOWER(?)
        ORDER BY last_checked_at DESC
        LIMIT 1
      `).get(row.chain_id_ref, row.pool_addr) as { token0: string; token1: string; token0_symbol: string; token1_symbol: string; fee: number; pair_flip: number } | undefined;

      if (pos) {
        if (!t0) t0 = pos.token0 || "";
        if (!t1) t1 = pos.token1 || "";
        if (!sym0) sym0 = pos.token0_symbol || "";
        if (!sym1) sym1 = pos.token1_symbol || "";
        if (!fee && pos.fee && pos.fee > 0) fee = Number(pos.fee);
      }
    }

    // 再从 ZIA 预设激励池定义兜底补全 token0/token1/symbol/fee
    const ziaDef = ZIA_INCENTIVIZED_POOLS.find(
      (p) => p.pool.toLowerCase() === (row.pool_addr || "").toLowerCase()
    );
    if (ziaDef) {
      if (!t0) t0 = ziaDef.token0;
      if (!t1) t1 = ziaDef.token1;
      if (!sym0) sym0 = ziaDef.symbol0;
      if (!sym1) sym1 = ziaDef.symbol1;
      if (!fee) fee = ziaDef.fee;
    }

    // 若 label 里含 0.3% / 0.05% / 0.01% / 1% 字样，解析为 fee
    if (!fee && row.label) {
      if (row.label.includes("0.01%")) fee = 100;
      else if (row.label.includes("0.05%")) fee = 500;
      else if (row.label.includes("0.3%")) fee = 3000;
      else if (row.label.includes("1%")) fee = 10000;
    }

    // 如果有 symbol 但还没有 token 地址，尝试从 tokens 缓存表反查地址以匹配 pair_flips
    if ((!t0 || !t1) && sym0 && sym1) {
      const tok0 = db.prepare("SELECT address FROM tokens WHERE chain_id_ref=? AND LOWER(symbol)=LOWER(?) LIMIT 1").get(row.chain_id_ref, sym0) as { address: string } | undefined;
      const tok1 = db.prepare("SELECT address FROM tokens WHERE chain_id_ref=? AND LOWER(symbol)=LOWER(?) LIMIT 1").get(row.chain_id_ref, sym1) as { address: string } | undefined;
      if (!t0 && tok0?.address) t0 = tok0.address;
      if (!t1 && tok1?.address) t1 = tok1.address;
    }

    let pair_flip = 0;
    if (t0 && t1) {
      pair_flip = isPairFlipped(row.chain_id_ref, t0, t1) ? 1 : 0;
    } else if (sym0 && sym1) {
      // 按 symbol 兜底查 positions 表中的 pair_flip
      const posFlip = db.prepare(`
        SELECT pair_flip FROM positions
        WHERE chain_id_ref=? AND LOWER(token0_symbol)=LOWER(?) AND LOWER(token1_symbol)=LOWER(?) AND pair_flip=1
        LIMIT 1
      `).get(row.chain_id_ref, sym0, sym1);
      if (posFlip) pair_flip = 1;
    }

    return {
      ...row,
      token0: t0,
      token1: t1,
      token0_symbol: sym0,
      token1_symbol: sym1,
      fee,
      pair_flip,
    };
  });

  return ok(enhancedRows);
}

/** 新建收藏。chain_id + pool 必填，label/staker/npm 可选。 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  
  // 如果是批量导入
  if (url.searchParams.get("bulk_import")) {
    const b = await getBody<{ bulk_import: any[] }>(req);
    if (!b.bulk_import || !Array.isArray(b.bulk_import)) {
      return fail("批量导入数据格式错误");
    }
    
    const db = getDb();
    let added = 0;
    let updated = 0;
    
    // 开启事务
    const tx = db.transaction(() => {
      for (const item of b.bulk_import) {
        if (!item.chain_key || !item.pool_addr) continue;
        
        // 先查询链ID
        const chain = db.prepare("SELECT id FROM chains WHERE key=?").get(item.chain_key) as { id: number } | null;
        if (!chain) continue;
        
        const poolAddrOriginal = String(item.pool_addr).trim().toLowerCase();
        const stakerAddr = String(item.staker_addr || "").trim().toLowerCase();
        const npmAddr = String(item.npm_addr || "").trim().toLowerCase();
        const label = String(item.label || "").trim();
        const sortOrder = Number(item.sort_order) || 0;

        // 入参校验：拒绝非法地址和可疑 label
        if (!isValidEvmAddress(poolAddrOriginal)) continue;
        if (!isValidEvmAddress(stakerAddr)) continue;
        if (!isValidEvmAddress(npmAddr)) continue;
        if (!isValidLabel(label)) continue;
        const poolAddr = poolAddrOriginal; // 校验通过后赋值
        
// 检查是否已存在 - 使用 try/catch 避免 TypeScript 类型错误
        let existing: { id: number } | null = null;
        try {
          existing = db.prepare(
            `SELECT id FROM liquidity_favorites WHERE chain_id_ref=? AND pool_addr=? AND COALESCE(staker_addr, '') = COALESCE(?, '')`
          ).get(chain.id, poolAddr, stakerAddr) as { id: number } | null;
        } catch (e) {
          existing = null;
        }
        
        if (existing) {
          // 更新现有收藏
          // @ts-ignore - 避免 TypeScript 类型错误
          db.prepare(
            `UPDATE liquidity_favorites SET label=?, npm_addr=?, sort_order=? WHERE id=?`
          ).run(label, npmAddr, sortOrder, existing.id);
          updated++;
        } else {
          // 插入新收藏
          // @ts-ignore - 避免 TypeScript 类型错误
          db.prepare(
            `INSERT INTO liquidity_favorites (chain_id_ref, label, pool_addr, staker_addr, npm_addr, sort_order)
             VALUES (?,?,?,?,?,?)`
          ).run(chain.id, label, poolAddr, stakerAddr, npmAddr, sortOrder);
          added++;
        }
      }
    });
    
    tx();
    return ok({ added, updated });
  }
  
  // 普通创建收藏
  const b = await getBody<{ chain_id?: number; label?: string; pool?: string; staker?: string; npm?: string; sort_order?: number }>(req);
  if (!b.chain_id) return fail("缺少 chain_id");
  if (!b.pool) return fail("缺少 pool 地址");
  const pool = String(b.pool).trim().toLowerCase();
  const staker = String(b.staker || "").trim().toLowerCase();
  const npm = String(b.npm || "").trim().toLowerCase();
  const label = String(b.label || "").trim();
  const sortOrder = Number(b.sort_order) || 0;
  // 入参校验：拒绝非法地址和可疑 label
  if (!isValidEvmAddress(pool)) return fail("pool 地址格式非法");
  if (!isValidEvmAddress(staker)) return fail("staker 地址格式非法");
  if (!isValidEvmAddress(npm)) return fail("npm 地址格式非法");
  if (!isValidLabel(label)) return fail("label 含非法字符");
  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO liquidity_favorites (chain_id_ref, label, pool_addr, staker_addr, npm_addr, sort_order)
       VALUES (?,?,?,?,?,?)`
    ).run(Number(b.chain_id), label, pool, staker, npm, sortOrder);
    return ok({ id: info.lastInsertRowid });
  } catch {
    return fail("该 chain+pool+staker 组合已收藏");
  }
}
