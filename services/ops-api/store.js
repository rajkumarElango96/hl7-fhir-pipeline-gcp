// SQLite read model: one row per HL7 message (keyed by MSH-10), filled in as the
// message shows up on each topic. Status is derived from which stage timestamps exist,
// so it is correct no matter which topic's record ops-api happens to read first.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const COLUMNS = [
  'control_id', 'mrn', 'patient', 'trigger', 'facility', 'raw_hl7', 'canonical', 'bundle', 'fhir_result',
  'dlq_reason', 'received_at', 'parsed_at', 'mapped_at', 'written_at', 'dlq_at',
];

export const STATUS_SQL = `CASE
  WHEN written_at IS NOT NULL THEN 'written'
  WHEN mapped_at IS NOT NULL THEN 'mapped'
  WHEN parsed_at IS NOT NULL THEN 'parsed'
  WHEN dlq_at IS NOT NULL THEN 'dlq'
  ELSE 'received' END`;

const SUMMARY = `control_id, mrn, patient, trigger, facility, dlq_reason, received_at, parsed_at, mapped_at,
  written_at, dlq_at, replay_count, updated_at, ${STATUS_SQL} AS status`;

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      control_id TEXT PRIMARY KEY,
      mrn TEXT, patient TEXT, trigger TEXT, facility TEXT,
      raw_hl7 TEXT, canonical TEXT, bundle TEXT, fhir_result TEXT, dlq_reason TEXT,
      received_at TEXT, parsed_at TEXT, mapped_at TEXT, written_at TEXT, dlq_at TEXT,
      replay_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_updated ON messages(updated_at DESC);
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO messages (${COLUMNS.join(', ')}, updated_at)
    VALUES (${COLUMNS.map((c) => `:${c}`).join(', ')}, :updated_at)
    ON CONFLICT(control_id) DO UPDATE SET
      ${COLUMNS.slice(1).map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(',\n      ')},
      updated_at = excluded.updated_at`);

  return {
    // Merge whatever this stage knows; nulls never overwrite earlier values.
    upsert(fields) {
      const row = Object.fromEntries(COLUMNS.map((c) => [c, fields[c] ?? null]));
      upsertStmt.run({ ...row, updated_at: new Date().toISOString() });
      return this.summary(fields.control_id);
    },
    summary(id) {
      return db.prepare(`SELECT ${SUMMARY} FROM messages WHERE control_id = ?`).get(id);
    },
    get(id) {
      const row = db.prepare(`SELECT *, ${STATUS_SQL} AS status FROM messages WHERE control_id = ?`).get(id);
      if (!row) return null;
      for (const k of ['canonical', 'bundle', 'fhir_result']) row[k] = row[k] ? JSON.parse(row[k]) : null;
      return row;
    },
    list({ status, q, limit = 200 } = {}) {
      const where = [];
      const params = {};
      if (status) { where.push(`${STATUS_SQL} = :status`); params.status = status; }
      if (q) { where.push('(control_id LIKE :q OR mrn LIKE :q OR patient LIKE :q)'); params.q = `%${q}%`; }
      return db.prepare(`SELECT ${SUMMARY} FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(received_at, updated_at) DESC, control_id DESC LIMIT :limit`).all({ ...params, limit: Number(limit) });
    },
    // Reset a DLQ'd message before it is re-sent, keeping its history counter.
    markReplayed(id) {
      db.prepare(`UPDATE messages SET dlq_at = NULL, dlq_reason = NULL, replay_count = replay_count + 1,
        updated_at = ? WHERE control_id = ?`).run(new Date().toISOString(), id);
    },
    counts() {
      const row = db.prepare(`SELECT
        COUNT(received_at) AS received, COUNT(parsed_at) AS parsed, COUNT(mapped_at) AS mapped,
        COUNT(written_at) AS written, SUM(CASE WHEN ${STATUS_SQL} = 'dlq' THEN 1 ELSE 0 END) AS dlq,
        AVG(CASE WHEN written_at IS NOT NULL AND received_at IS NOT NULL
          THEN (julianday(written_at) - julianday(received_at)) * 86400000 END) AS avg_latency_ms
        FROM messages`).get();
      return { ...row, dlq: row.dlq ?? 0, avg_latency_ms: row.avg_latency_ms ? Math.round(row.avg_latency_ms) : null };
    },
  };
}
