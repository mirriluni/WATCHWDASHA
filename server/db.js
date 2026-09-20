import { createClient } from '@libsql/client';

// Watch-time stats are a nice-to-have on top of the core room experience, not
// a requirement to run the app - if Turso isn't configured (local dev, or a
// deploy where the owner hasn't set it up yet), everything below just quietly
// no-ops instead of crashing the server.
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
export const db = url ? createClient({ url, authToken }) : null;

export async function initDb() {
  if (!db) { console.warn('TURSO_DATABASE_URL not set - watch-time stats are disabled.'); return; }
  await db.execute(`CREATE TABLE IF NOT EXISTS viewers (
    id TEXT PRIMARY KEY,
    name TEXT,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  // viewer_a/viewer_b is always stored with viewer_a < viewer_b (see
  // pairKey below) so a pair only ever has one row regardless of who
  // triggers the update.
  await db.execute(`CREATE TABLE IF NOT EXISTS pairs (
    viewer_a TEXT NOT NULL,
    viewer_b TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (viewer_a, viewer_b)
  )`);
}

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export async function touchViewerName(id, name) {
  if (!db || !id || !name) return;
  try {
    await db.execute({
      sql: `INSERT INTO viewers (id, name, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      args: [id, name, Date.now()],
    });
  } catch (error) { console.error('touchViewerName failed:', error); }
}

// viewerSeconds: Map<viewerId, seconds>, pairSeconds: Map<"a|b", seconds>
export async function addWatchSeconds(viewerSeconds, pairSeconds) {
  if (!db || (!viewerSeconds.size && !pairSeconds.size)) return;
  const now = Date.now();
  const statements = [];
  for (const [id, seconds] of viewerSeconds) {
    statements.push({
      sql: `INSERT INTO viewers (id, total_seconds, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds, updated_at = excluded.updated_at`,
      args: [id, seconds, now],
    });
  }
  for (const [key, seconds] of pairSeconds) {
    const [a, b] = key.split('|');
    statements.push({
      sql: `INSERT INTO pairs (viewer_a, viewer_b, seconds, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(viewer_a, viewer_b) DO UPDATE SET seconds = seconds + excluded.seconds, updated_at = excluded.updated_at`,
      args: [a, b, seconds, now],
    });
  }
  try { await db.batch(statements, 'write'); } catch (error) { console.error('addWatchSeconds failed:', error); }
}

export async function getStats(id) {
  if (!db || !id) return { totalSeconds: 0, partners: [] };
  try {
    const totalRes = await db.execute({ sql: 'SELECT total_seconds FROM viewers WHERE id = ?', args: [id] });
    const totalSeconds = Number(totalRes.rows[0]?.total_seconds ?? 0);
    const pairsRes = await db.execute({
      sql: 'SELECT viewer_a, viewer_b, seconds FROM pairs WHERE viewer_a = ? OR viewer_b = ? ORDER BY seconds DESC LIMIT 20',
      args: [id, id],
    });
    const partnerIds = pairsRes.rows.map(r => (r.viewer_a === id ? r.viewer_b : r.viewer_a));
    const names = new Map();
    if (partnerIds.length) {
      const placeholders = partnerIds.map(() => '?').join(',');
      const namesRes = await db.execute({ sql: `SELECT id, name FROM viewers WHERE id IN (${placeholders})`, args: partnerIds });
      for (const row of namesRes.rows) names.set(row.id, row.name);
    }
    const partners = pairsRes.rows.map(r => {
      const otherId = r.viewer_a === id ? r.viewer_b : r.viewer_a;
      return { id: otherId, name: names.get(otherId) || 'Гость', seconds: Number(r.seconds) };
    });
    return { totalSeconds, partners };
  } catch (error) { console.error('getStats failed:', error); return { totalSeconds: 0, partners: [] }; }
}
