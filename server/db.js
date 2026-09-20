import { createClient } from '@libsql/client';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Accounts require a real database - without one configured, nobody can
// register or log in (unlike the earlier anonymous stats feature, this is
// no longer optional once accounts are mandatory to use the site at all).
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
export const db = url ? createClient({ url, authToken }) : null;

export async function initDb() {
  if (!db) { console.warn('TURSO_DATABASE_URL not set - accounts/login will not work.'); return; }
  await db.execute(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // No expiry column on purpose: logging in is meant to stick until the
  // person explicitly logs out, not time out on its own.
  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS watch_totals (
    account_id TEXT PRIMARY KEY,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  // account_a/account_b always stored with account_a < account_b (see
  // pairKey below) so a pair only ever has one row either way round.
  await db.execute(`CREATE TABLE IF NOT EXISTS watch_pairs (
    account_a TEXT NOT NULL,
    account_b TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_a, account_b)
  )`);
}

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}
async function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, 'hex');
  const testBuf = await scryptAsync(password, salt, 64);
  return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf);
}

export class AuthError extends Error {}

const USERNAME_RE = /^[a-zA-Zа-яА-ЯёЁ0-9_-]{3,20}$/;

export async function register(username, password) {
  if (!db) throw new AuthError('Регистрация временно недоступна');
  username = (username || '').trim();
  if (!USERNAME_RE.test(username)) throw new AuthError('Имя пользователя: 3-20 символов, буквы/цифры/_/-');
  if (typeof password !== 'string' || password.length < 6) throw new AuthError('Пароль должен быть не короче 6 символов');
  const existing = await db.execute({ sql: 'SELECT id FROM accounts WHERE username = ?', args: [username] });
  if (existing.rows.length) throw new AuthError('Это имя пользователя уже занято');
  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  await db.execute({ sql: 'INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', args: [id, username, passwordHash, Date.now()] });
  return createSession(id);
}

export async function login(username, password) {
  if (!db) throw new AuthError('Вход временно недоступен');
  username = (username || '').trim();
  const res = await db.execute({ sql: 'SELECT id, username, password_hash FROM accounts WHERE username = ?', args: [username] });
  const account = res.rows[0];
  // Same generic error either way - don't reveal whether the username exists.
  if (!account || !(await verifyPassword(password, account.password_hash))) throw new AuthError('Неверное имя пользователя или пароль');
  return createSession(account.id, account.username);
}

async function createSession(accountId, username) {
  const token = randomBytes32();
  await db.execute({ sql: 'INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)', args: [token, accountId, Date.now()] });
  if (!username) { const res = await db.execute({ sql: 'SELECT username FROM accounts WHERE id = ?', args: [accountId] }); username = res.rows[0]?.username; }
  return { token, accountId, username };
}
function randomBytes32() { return randomBytes(32).toString('hex'); }

export async function resolveSession(token) {
  if (!db || typeof token !== 'string' || !token) return null;
  try {
    const res = await db.execute({
      sql: 'SELECT sessions.account_id as accountId, accounts.username as username FROM sessions JOIN accounts ON accounts.id = sessions.account_id WHERE sessions.token = ?',
      args: [token],
    });
    return res.rows[0] || null;
  } catch (error) { console.error('resolveSession failed:', error); return null; }
}

export async function logout(token) {
  if (!db || !token) return;
  try { await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] }); } catch (error) { console.error('logout failed:', error); }
}

// accountSeconds: Map<accountId, seconds>, pairSeconds: Map<"a|b", seconds>
export async function addWatchSeconds(accountSeconds, pairSeconds) {
  if (!db || (!accountSeconds.size && !pairSeconds.size)) return;
  const now = Date.now();
  const statements = [];
  for (const [id, seconds] of accountSeconds) {
    statements.push({
      sql: `INSERT INTO watch_totals (account_id, total_seconds, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds, updated_at = excluded.updated_at`,
      args: [id, seconds, now],
    });
  }
  for (const [key, seconds] of pairSeconds) {
    const [a, b] = key.split('|');
    statements.push({
      sql: `INSERT INTO watch_pairs (account_a, account_b, seconds, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(account_a, account_b) DO UPDATE SET seconds = seconds + excluded.seconds, updated_at = excluded.updated_at`,
      args: [a, b, seconds, now],
    });
  }
  try { await db.batch(statements, 'write'); } catch (error) { console.error('addWatchSeconds failed:', error); }
}

export async function getStats(accountId) {
  if (!db || !accountId) return { totalSeconds: 0, partners: [] };
  try {
    const totalRes = await db.execute({ sql: 'SELECT total_seconds FROM watch_totals WHERE account_id = ?', args: [accountId] });
    const totalSeconds = Number(totalRes.rows[0]?.total_seconds ?? 0);
    const pairsRes = await db.execute({
      sql: 'SELECT account_a, account_b, seconds FROM watch_pairs WHERE account_a = ? OR account_b = ? ORDER BY seconds DESC LIMIT 20',
      args: [accountId, accountId],
    });
    const partnerIds = pairsRes.rows.map(r => (r.account_a === accountId ? r.account_b : r.account_a));
    const names = new Map();
    if (partnerIds.length) {
      const placeholders = partnerIds.map(() => '?').join(',');
      const namesRes = await db.execute({ sql: `SELECT id, username FROM accounts WHERE id IN (${placeholders})`, args: partnerIds });
      for (const row of namesRes.rows) names.set(row.id, row.username);
    }
    const partners = pairsRes.rows.map(r => {
      const otherId = r.account_a === accountId ? r.account_b : r.account_a;
      return { id: otherId, name: names.get(otherId) || 'Бывший участник', seconds: Number(r.seconds) };
    });
    return { totalSeconds, partners };
  } catch (error) { console.error('getStats failed:', error); return { totalSeconds: 0, partners: [] }; }
}
