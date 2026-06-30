import { getDb } from "../db";

export interface DexRow {
  id: number;
  chain_id_ref: number;
  name: string;
  type: string; // 'v3-fork'
  factory: string;
  npm: string; // NonfungiblePositionManager
  enabled: number;
}

export function listDexes(chainDbId?: number, enabledOnly = false): DexRow[] {
  const db = getDb();
  let sql = "SELECT * FROM dexes WHERE 1=1";
  const args: any[] = [];
  if (chainDbId !== undefined) { sql += " AND chain_id_ref=?"; args.push(chainDbId); }
  if (enabledOnly) sql += " AND enabled=1";
  return db.prepare(sql).all(...args) as DexRow[];
}

export function getDexe(id: number): DexRow | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM dexes WHERE id=?").get(id) as DexRow) ?? null;
}

export interface StakingRow {
  id: number;
  chain_id_ref: number;
  platform: string;
  pair_label: string;
  contract: string;
  read_type: string; // 'deposits_owner' | 'user_info_token'
  dex_id: number | null;
  enabled: number;
}

export function listStaking(chainDbId?: number, enabledOnly = false): StakingRow[] {
  const db = getDb();
  let sql = "SELECT * FROM staking_contracts WHERE 1=1";
  const args: any[] = [];
  if (chainDbId !== undefined) { sql += " AND chain_id_ref=?"; args.push(chainDbId); }
  if (enabledOnly) sql += " AND enabled=1";
  return db.prepare(sql).all(...args) as StakingRow[];
}
