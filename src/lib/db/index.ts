import Database from "better-sqlite3";
import { appEnv, dbPath } from "./config";

export type DB = Database.Database;

let _db: DB | null = null;

export function getDb(): DB {
  if (_db) return _db;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  _db = db;
  return db;
}

/**
 * 初始化所有表。幂等：用 IF NOT EXISTS。
 * 设计原则：chains / dexes / staking_contracts 全部可由用户在前端增删改，
 * wallets 关联 chain，positions 由扫描器自动发现并缓存最新状态。
 */

/** 安全新增列：已存在则跳过。用于数据库迁移兼容。 */
function safeAddColumn(db: DB, table: string, column: string, type: string) {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // 列已存在，忽略
  }
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chains (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT    NOT NULL UNIQUE,        -- 'ethereum' / 'bsc' / 自定义
      name          TEXT    NOT NULL,               -- 显示名
      chain_id      INTEGER NOT NULL UNIQUE,        -- EVM chainId
      rpc_urls      TEXT    NOT NULL,               -- JSON 数组，多个做 failover
      explorer_url  TEXT    NOT NULL DEFAULT '',    -- https://etherscan.io
      symbol        TEXT    NOT NULL DEFAULT 'ETH', -- 原生代币符号
      enabled       INTEGER NOT NULL DEFAULT 1,
      is_default    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dexes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id_ref  INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL,               -- 'Uniswap V3'
      type          TEXT    NOT NULL DEFAULT 'v3-fork', -- 适配器类型，第一版只支持 v3-fork
      factory       TEXT    NOT NULL,               -- V3 factory 地址
      npm           TEXT    NOT NULL,               -- NonfungiblePositionManager 地址
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id_ref, factory)
    );

    CREATE TABLE IF NOT EXISTS staking_contracts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id_ref  INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      platform      TEXT    NOT NULL,               -- 平台名：'Uniswap V3 Staker' / 'Gamma' 等
      pair_label    TEXT    NOT NULL DEFAULT '',    -- 交易对/池描述：'WETH/USDC 0.05%'
      contract      TEXT    NOT NULL,               -- 质押合约地址
      read_type     TEXT    NOT NULL DEFAULT 'deposits_owner',
                      -- 'deposits_owner' : deposits(tokenId).owner
                      -- 'user_info_token' : userInfo/positions 映射，按合约自定义
      dex_id        INTEGER REFERENCES dexes(id) ON DELETE SET NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id_ref, contract)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id_ref  INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      address       TEXT    NOT NULL,
      label         TEXT    NOT NULL DEFAULT '',
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id_ref, address)
    );

    -- 仓位：由扫描器发现并缓存。chain+dex+token_id 唯一。
    CREATE TABLE IF NOT EXISTS positions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id       INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      chain_id_ref    INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      dex_id          INTEGER REFERENCES dexes(id) ON DELETE SET NULL,
      dex_name        TEXT    NOT NULL DEFAULT '',
      token_id        TEXT    NOT NULL,             -- NFT tokenId（字符串，避免大整数溢出）
      token0          TEXT    NOT NULL,
      token1          TEXT    NOT NULL,
      token0_symbol   TEXT    NOT NULL DEFAULT '',  -- ERC20 symbol，展示用
      token1_symbol   TEXT    NOT NULL DEFAULT '',
      fee             INTEGER NOT NULL DEFAULT 0,
      pool            TEXT    NOT NULL DEFAULT '',
      tick_lower      INTEGER NOT NULL DEFAULT 0,
      tick_upper      INTEGER NOT NULL DEFAULT 0,
      source          TEXT    NOT NULL DEFAULT 'direct',
                        -- 'direct' : 钱包直接持有
                        -- 'staking': 质押在 staking_contracts 中
      staker_contract TEXT    NOT NULL DEFAULT '',  -- source=staking 时记录
      staking_id      INTEGER REFERENCES staking_contracts(id) ON DELETE SET NULL,
      last_current_tick INTEGER NOT NULL DEFAULT 0,
      last_in_range   INTEGER NOT NULL DEFAULT 1,   -- 1=在区间内 0=越界
      last_price0     TEXT    NOT NULL DEFAULT '',  -- 整币单位价格（1 token0 = ? token1，已按 decimals 换算），便于展示
      last_liquidity  TEXT    NOT NULL DEFAULT '',  -- 当前 liquidity，0=已关闭
      last_checked_at TEXT    NOT NULL DEFAULT '',
      last_notified_at TEXT   NOT NULL DEFAULT '',  -- 上次告警时间，用于去重
      notify_state    TEXT    NOT NULL DEFAULT 'unknown',
                        -- 'unknown' | 'in_range' | 'out_of_range'
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id_ref, dex_name, token_id)
    );
    CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(notify_state);

    CREATE TABLE IF NOT EXISTS alerts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id   INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
      type          TEXT    NOT NULL,               -- 'out_of_range' | 're_in_range' | 'test'
      tick_at       INTEGER NOT NULL DEFAULT 0,
      message       TEXT    NOT NULL,
      channels      TEXT    NOT NULL DEFAULT '',    -- JSON: 成功推送的渠道列表
      sent_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent_at DESC);

    -- token 元数据缓存：地址→符号/名称，扫描时按链读取并缓存，避免重复 RPC
    CREATE TABLE IF NOT EXISTS tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id_ref INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      address     TEXT    NOT NULL,
      symbol      TEXT    NOT NULL DEFAULT '',
      name        TEXT    NOT NULL DEFAULT '',
      decimals    INTEGER NOT NULL DEFAULT 18,
      updated_at  TEXT    NOT NULL DEFAULT '',
      UNIQUE(chain_id_ref, address)
    );

    -- 应用设置（键值对，可动态修改，如扫描频率 cron 表达式）
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- CEX 报价匹配：链上 token 地址 → 币安交易对 symbol（如 0G token → '0GUSDT'）
    -- 用户在配置页手动为每个 token 配对计价货币（USDT/USDC 自选）
    -- fixed_price 非空时走固定价（如 USDC.e=1），不再查币安；quote 货币由 cex_symbol 的 quote 部分确定（如 USDT）
    CREATE TABLE IF NOT EXISTS token_symbols (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id_ref  INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      token_addr    TEXT    NOT NULL,               -- 链上 token 合约地址（小写）
      token_symbol  TEXT    NOT NULL DEFAULT '',    -- 缓存的 ERC20 symbol，展示用
      cex_symbol    TEXT    NOT NULL,               -- 币安交易对 symbol，如 '0GUSDT'；固定价时此字段仅用于确定计价币种
      fixed_price   REAL,                            -- 固定价（如 USDC.e 填 1，计价 USDT）。非空时走固定价
      quote         TEXT    NOT NULL DEFAULT '',    -- 计价币种，如 'USDT'。固定价时必填；走币安时从 cex_symbol 推导
      inverted      INTEGER NOT NULL DEFAULT 0,     -- 翻转：1=取倒数（如币安只有 USDCUSDT，USDT token 配 USDCUSDT 并翻转）
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id_ref, token_addr)
    );

    -- 流动性快照缓存：手动触发「流动性分析」时写入，10 天过期，避免重复打 RPC
    CREATE TABLE IF NOT EXISTS liquidity_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id     INTEGER REFERENCES positions(id) ON DELETE CASCADE,  -- 功能1用（可为空）
      chain_id_ref    INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      pool_addr       TEXT    NOT NULL DEFAULT '',
      staker_addr     TEXT    NOT NULL DEFAULT '',     -- 场景B/probe 用
      token0_symbol   TEXT    NOT NULL DEFAULT '',
      token1_symbol   TEXT    NOT NULL DEFAULT '',
      total_token0    TEXT    NOT NULL DEFAULT '',     -- 区间内总流动性 token0 数量（可读字符串）
      total_token1    TEXT    NOT NULL DEFAULT '',
      mine_token0     TEXT    NOT NULL DEFAULT '',     -- 你自己的（场景A）
      mine_token1     TEXT    NOT NULL DEFAULT '',
      share           REAL    NOT NULL DEFAULT 0,      -- 你的占比 0~1
      price_low       TEXT    NOT NULL DEFAULT '',
      price_high      TEXT    NOT NULL DEFAULT '',
      price_label     TEXT    NOT NULL DEFAULT '',
      tick_lower      INTEGER NOT NULL DEFAULT 0,
      tick_upper      INTEGER NOT NULL DEFAULT 0,
      current_tick    INTEGER NOT NULL DEFAULT 0,
      position_count  INTEGER NOT NULL DEFAULT 0,
      payload         TEXT    NOT NULL DEFAULT '',     -- 完整 JSON 结果，前端直接渲染
      sampled_at      TEXT    NOT NULL DEFAULT '',
      expires_at      TEXT    NOT NULL DEFAULT ''      -- sampled_at + 10天
    );
    CREATE INDEX IF NOT EXISTS idx_liq_snap_pos ON liquidity_snapshots(position_id);
    CREATE INDEX IF NOT EXISTS idx_liq_snap_pool ON liquidity_snapshots(chain_id_ref, pool_addr, staker_addr);

    -- 流动性探针收藏：用户把常用的 chain+pool+staker 组合存下来，方便一键查询。
    CREATE TABLE IF NOT EXISTS liquidity_favorites (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id_ref  INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      label         TEXT    NOT NULL DEFAULT '',   -- 自定义备注，如 '0G/WETH 0.3% 主池'
      pool_addr     TEXT    NOT NULL,             -- V3 池子地址（小写）
      staker_addr   TEXT    NOT NULL DEFAULT '',  -- 可选 vault/质押地址（小写）
      npm_addr      TEXT    NOT NULL DEFAULT '',  -- 可选 NPM 地址（留空则按链取第一个 v3-fork）
      sort_order    INTEGER NOT NULL DEFAULT 0,   -- 排序权重，越大越靠前
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id_ref, pool_addr, staker_addr)
    );
    CREATE INDEX IF NOT EXISTS idx_liq_fav_chain ON liquidity_favorites(chain_id_ref);

    -- 交易对翻转偏好（独立于 positions 表，钱包/链删除重建后仍可恢复）
    -- 唯一键: chain_id_ref + dex_name + token0 + token1（忽略 token_id，同一交易对共享翻转）
    CREATE TABLE IF NOT EXISTS pair_flips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id_ref  INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      dex_name      TEXT    NOT NULL,
      token0        TEXT    NOT NULL,
      token1        TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id_ref, dex_name, token0, token1)
    );
  `);

  // 兼容已有数据库：新增列用 ADD COLUMN（忽略已存在的错误）
  safeAddColumn(db, "positions", "last_liquidity", "TEXT NOT NULL DEFAULT ''");
  safeAddColumn(db, "positions", "token0_symbol", "TEXT NOT NULL DEFAULT ''");
  safeAddColumn(db, "positions", "token1_symbol", "TEXT NOT NULL DEFAULT ''");
  // pair_flip: 0=原始token0/token1, 1=用户翻转为token1/token0
  safeAddColumn(db, "positions", "pair_flip", "INTEGER NOT NULL DEFAULT 0");
  // tick 波动预警：上次扫描时 tick 距区间边界的相对位置（百分比 0~1）
  safeAddColumn(db, "positions", "last_margin_lower", "REAL NOT NULL DEFAULT 0");
  safeAddColumn(db, "positions", "last_margin_upper", "REAL NOT NULL DEFAULT 0");
  // CEX 报价对比：上次扫描时该仓位 token 对应的币安参考价（JSON 字符串，存 token0/token1 的报价）
  safeAddColumn(db, "positions", "last_cex_price", "TEXT NOT NULL DEFAULT ''");
  // token_symbols 固定价支持：USDC.e 这类恒定价格 token（如 =1 USDT），不再查币安
  safeAddColumn(db, "token_symbols", "fixed_price", "REAL");
  safeAddColumn(db, "token_symbols", "quote", "TEXT NOT NULL DEFAULT ''");
  // token_symbols 翻转支持：币安只有 USDCUSDT 没有 USDTUSDC，USDT token 配 USDCUSDT 并翻转取倒数
  safeAddColumn(db, "token_symbols", "inverted", "INTEGER NOT NULL DEFAULT 0");
  // staking_contracts 关联 DEX：合约直查时需要知道用哪个 DEX 的 NPM ABI
  safeAddColumn(db, "staking_contracts", "dex_id", "INTEGER REFERENCES dexes(id) ON DELETE SET NULL");

  seedDefaults(db);
}

/** 初始化默认设置 */
function seedDefaultSettings(db: DB) {
  const defaultSettings = [
    { key: "staking_scan_method", value: "transfer_scan" }, // 默认使用转账扫描方式
    { key: "staking_scan_fallback_enabled", value: "true" }, // 启用兜底机制：转账扫描失败时尝试合约直查
    { key: "staking_scan_contract_batch_size", value: "50" }, // 合约直查时的批量大小
    { key: "staking_scan_concurrent_limit", value: "6" }, // 并发限制
  ];
  
  for (const setting of defaultSettings) {
    try {
      db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)").run(setting.key, setting.value);
    } catch {
      // 设置已存在，忽略
    }
  }
}

/** 内置 Ethereum 主网作为默认链 + Uniswap V3 作为默认 DEX。用户可自行扩展。 */
function seedDefaults(db: DB) {
  const hasChain = db.prepare("SELECT COUNT(*) c FROM chains WHERE key=?").get("ethereum") as { c: number };
  if (hasChain.c === 0) {
    const rpcUrls = JSON.stringify([
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
      "https://cloudflare-eth.com",
    ]);
    db.prepare(
      `INSERT INTO chains (key, name, chain_id, rpc_urls, explorer_url, symbol, enabled, is_default)
       VALUES (?, 'Ethereum', 1, ?, 'https://etherscan.io', 'ETH', 1, 1)`
    ).run("ethereum", rpcUrls);

    const chainRow = db.prepare("SELECT id FROM chains WHERE key=?").get("ethereum") as { id: number };
    // Uniswap V3 官方地址
    db.prepare(
      `INSERT INTO dexes (chain_id_ref, name, type, factory, npm, enabled)
       VALUES (?, 'Uniswap V3', 'v3-fork', '0x1F98431c8aD98523631AE4a59f267346ea31F984', '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', 1)`
    ).run(chainRow.id);
  }
  seedDefaultSettings(db);
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// 触发 appEnv 引用以提示缺失关键配置（目前都可选）
void appEnv;
