import express from 'express';
import { WebSocketServer } from 'ws';
import { parseVideoUrl, VideoUrlError } from '../shared/video-url.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, register, login, logout, resolveSession, AuthError, addWatchSeconds, getStats, pairKey } from './db.js';

initDb().catch(error => console.error('initDb failed:', error));

const app = express();
app.use(express.json({ limit: '10kb' }));

const authHandler = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (error) {
    if (error instanceof AuthError) return res.status(400).json({ error: error.message });
    console.error(error); res.status(500).json({ error: 'Server error' });
  }
};
app.post('/api/register', authHandler(req => register(req.body?.username, req.body?.password)));
app.post('/api/login', authHandler(req => login(req.body?.username, req.body?.password)));
app.post('/api/logout', authHandler(async req => { await logout(req.body?.token); return { ok: true }; }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '../dist');
app.use(express.static(dist));
app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, '0.0.0.0', () => console.log(`WatchTogether server on http://localhost:${port}`));
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Stop the other WatchTogether server, or start this one with PORT=3002 npm start.`);
  else console.error(error);
  process.exitCode = 1;
});
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();
const now = () => Date.now();
function room(id) { if (!rooms.has(id)) rooms.set(id, { video: null, playback: { state: 'paused', currentTime: 0, updatedAt: now() }, clients: new Map(), messages: [] }); return rooms.get(id); }
function actualTime(r) { return r.playback.state === 'playing' ? r.playback.currentTime + (now() - r.playback.updatedAt) / 1000 : r.playback.currentTime; }
function emit(r, message, except) { const payload = JSON.stringify(message); for (const ws of r.clients.keys()) if (ws !== except && ws.readyState === ws.OPEN) ws.send(payload); }
function participants(r) { return [...r.clients.values()].map(({ id, name, position, positionUpdatedAt }) => ({ id, name, position: Number.isFinite(position) ? position : null, positionUpdatedAt: positionUpdatedAt || null })); }
function sendRoster(r) { emit(r, { type: 'participants', participants: participants(r) }); }

// Watch-time accumulation, keyed by account id now that viewing requires
// being logged in - every connection has one.
const WATCH_TICK_MS = 20000;
setInterval(() => {
  const accountSeconds = new Map(); const pairSeconds = new Map(); const tickSeconds = WATCH_TICK_MS / 1000;
  for (const r of rooms.values()) {
    if (r.playback.state !== 'playing') continue;
    const ids = [...new Set([...r.clients.values()].map(u => u.accountId).filter(Boolean))];
    for (const id of ids) accountSeconds.set(id, (accountSeconds.get(id) || 0) + tickSeconds);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = pairKey(ids[i], ids[j]); pairSeconds.set(key, (pairSeconds.get(key) || 0) + tickSeconds);
    }
  }
  addWatchSeconds(accountSeconds, pairSeconds);
}, WATCH_TICK_MS);

// A phone that drops off Wi-Fi, switches to cellular, or has a VPN blip
// often never sends a TCP FIN - the connection just goes silent. Without
// this, the server keeps believing that person is still in the room for
// however long the OS takes to notice (minutes, sometimes never), showing
// a ghost participant next to the one real reconnected copy of them and
// leaving stale state that never advances. `ws` clients answer WebSocket
// ping frames with a pong automatically (no browser-side code needed);
// anyone who hasn't in two heartbeats gets forcibly dropped.
const HEARTBEAT_MS = 30000;
wss.on('connection', async (ws, request) => {
  const params = new URL(request.url, 'http://localhost').searchParams;
  const roomId = params.get('room');
  if (!roomId || !/^[a-zA-Z0-9_-]{4,64}$/.test(roomId)) return ws.close(1008, 'Invalid room');
  // Watching requires an account: every connection must present a valid
  // session token from /api/login or /api/register, or it's rejected
  // outright rather than falling back to an anonymous guest.
  const session = await resolveSession(params.get('token'));
  if (!session) return ws.close(4001, 'Unauthorized');
  const r = room(roomId);
  const user = { id: randomUUID(), accountId: session.accountId, name: session.username, position: null, positionUpdatedAt: null };
  r.clients.set(ws, user);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'welcome', you: user, video: r.video, playback: { ...r.playback, currentTime: actualTime(r), updatedAt: now() }, participants: participants(r), messages: r.messages, serverTime: now() }));
  sendRoster(r);
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'stats') { getStats(user.accountId).then(stats => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'stats', ...stats }))); return; }
    if (msg.type === 'chat' && (typeof msg.text === 'string' || typeof msg.image === 'string')) {
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
      // Images travel as compressed data: URLs from the client; cap the
      // encoded size so a handful of screenshots can't blow up the room's
      // in-memory history (there is no persistent storage, by design).
      const image = typeof msg.image === 'string' && msg.image.startsWith('data:image/') && msg.image.length <= 600_000 ? msg.image : null;
      if (!text && !image) return;
      const message = { id: randomUUID(), authorId: user.id, author: user.name, text, image, timestamp: now() };
      r.messages.push(message); if (r.messages.length > 30) r.messages.shift(); emit(r, { type: 'chat', message }); return;
    }
    if (msg.type === 'presence') {
      const time = Number(msg.time); if (!Number.isFinite(time) || time < 0 || time > 172800) return;
      user.position = time; user.positionUpdatedAt = now(); return sendRoster(r);
    }
    if (msg.type === 'loadVideo') {
      try { r.video = parseVideoUrl(msg.url); r.playback = { state: 'paused', currentTime: 0, updatedAt: now() }; emit(r, { type: 'loadVideo', video: r.video, playback: r.playback, by: user.id }); }
      catch (e) { ws.send(JSON.stringify({ type: 'error', message: e instanceof VideoUrlError ? e.message : 'Unable to load video' })); }
      return;
    }
    if (!r.video || !['play', 'pause', 'seek', 'ended', 'syncRequest', 'forceSync'].includes(msg.type)) return;
    if (msg.type === 'syncRequest') return ws.send(JSON.stringify({ type: 'sync', video: r.video, playback: { ...r.playback, currentTime: actualTime(r), updatedAt: now() }, serverTime: now() }));
    if (msg.type === 'forceSync') {
      const time = Number(msg.time); if (!Number.isFinite(time) || time < 0 || time > 172800) return;
      r.playback.currentTime = time; r.playback.updatedAt = now(); user.position = time; user.positionUpdatedAt = now();
      // Don't echo back to the sender: it is already at this position, and
      // re-applying the seek on an iframe player (YouTube/VK) re-triggers a
      // buffering "playing" state change, which would bounce right back here.
      emit(r, { type: 'sync', video: r.video, playback: { ...r.playback }, serverTime: now(), by: user.id }, ws); sendRoster(r); return;
    }
    const time = Number(msg.time); if (!Number.isFinite(time) || time < 0 || time > 172800) return;
    user.position = time; user.positionUpdatedAt = now();
    r.playback = { state: msg.type === 'play' ? 'playing' : msg.type === 'ended' ? 'paused' : r.playback.state, currentTime: time, updatedAt: now() };
    if (msg.type === 'pause') r.playback.state = 'paused';
    // Same reasoning as forceSync above: exclude the sender to avoid a
    // self-feedback loop of seek -> buffering -> state event -> seek ...
    emit(r, { type: msg.type, time, timestamp: r.playback.updatedAt, by: user.id }, ws); sendRoster(r);
  });
  ws.on('close', () => { r.clients.delete(ws); sendRoster(r); if (!r.clients.size) setTimeout(() => !r.clients.size && rooms.delete(roomId), 60 * 60 * 1000); });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
