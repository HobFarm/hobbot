// Attack catalog management

export interface AttackEntry {
  id: number;
  entry_number: number;
  timestamp: string;
  geometry: string;
  technique_summary: string;
  origin_hash: string;
  severity: number;
  response_given: string | null;
  notes: string | null;
}

export async function getAttackCount(db: D1Database): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM attack_collection')
    .first<{ count: number }>();

  return result?.count ?? 0;
}

export async function getNextEntryNumber(db: D1Database): Promise<number> {
  const result = await db
    .prepare('SELECT MAX(entry_number) as max_num FROM attack_collection')
    .first<{ max_num: number | null }>();

  const maxNum = result?.max_num ?? 0;
  return maxNum + 1;
}

export async function addToCollection(
  db: D1Database,
  geometry: string,
  technique: string,
  severity: number,
  originHash: string,
  notes?: string
): Promise<number> {
  const entryNumber = await getNextEntryNumber(db);
  const timestamp = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO attack_collection
       (entry_number, timestamp, geometry, technique_summary, origin_hash, severity, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(entryNumber, timestamp, geometry, technique, originHash, severity, notes ?? null)
    .run();

  return entryNumber;
}

export async function recordAttackResponse(
  db: D1Database,
  entryNumber: number,
  response: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE attack_collection
       SET response_given = ?
       WHERE entry_number = ?`
    )
    .bind(response, entryNumber)
    .run();
}

export async function getRecentAttacks(
  db: D1Database,
  limit: number = 10
): Promise<AttackEntry[]> {
  const result = await db
    .prepare(
      `SELECT * FROM attack_collection
       ORDER BY entry_number DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<AttackEntry>();

  return result.results ?? [];
}

export async function getAttackByNumber(
  db: D1Database,
  entryNumber: number
): Promise<AttackEntry | null> {
  const result = await db
    .prepare('SELECT * FROM attack_collection WHERE entry_number = ?')
    .bind(entryNumber)
    .first<AttackEntry>();

  return result ?? null;
}
