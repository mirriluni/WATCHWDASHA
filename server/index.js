import express from 'express';
import { WebSocketServer } from 'ws';
import { parseVideoUrl, VideoUrlError } from '../shared/video-url.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
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

wss.on('connection', (ws, request) => {
  const params = new URL(request.url, 'http://localhost').searchParams;
  const roomId = params.get('room');
  if (!roomId || !/^[a-zA-Z0-9_-]{4,64}$/.test(roomId)) return ws.close(1008, 'Invalid room');
  const r = room(roomId); const user = { id: randomUUID(), name: `Guest ${r.clients.size + 1}`, position: null, positionUpdatedAt: null };
  r.clients.set(ws, user);
  ws.send(JSON.stringify({ type: 'welcome', you: user, video: r.video, playback: { ...r.playback, currentTime: actualTime(r), updatedAt: now() }, participants: participants(r), messages: r.messages, serverTime: now() }));
  sendRoster(r);
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'setName' && typeof msg.name === 'string') { user.name = msg.name.trim().slice(0, 24) || user.name; return sendRoster(r); }
    if (msg.type === 'chat' && typeof msg.text === 'string') {
      const text = msg.text.trim().slice(0, 500); if (!text) return;
      const message = { id: randomUUID(), authorId: user.id, author: user.name, text, timestamp: now() };
      r.messages.push(message); if (r.messages.length > 50) r.messages.shift(); emit(r, { type: 'chat', message }); return;
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
      emit(r, { type: 'sync', video: r.video, playback: { ...r.playback }, serverTime: now(), by: user.id }); sendRoster(r); return;
    }
    const time = Number(msg.time); if (!Number.isFinite(time) || time < 0 || time > 172800) return;
    user.position = time; user.positionUpdatedAt = now();
    r.playback = { state: msg.type === 'play' ? 'playing' : msg.type === 'ended' ? 'paused' : r.playback.state, currentTime: time, updatedAt: now() };
    if (msg.type === 'pause') r.playback.state = 'paused';
    emit(r, { type: msg.type, time, timestamp: r.playback.updatedAt, by: user.id }); sendRoster(r);
  });
  ws.on('close', () => { r.clients.delete(ws); sendRoster(r); if (!r.clients.size) setTimeout(() => !r.clients.size && rooms.delete(roomId), 60 * 60 * 1000); });
});
