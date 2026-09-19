import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseVideoUrl } from '../shared/video-url.js';
import { playerFor } from './players.js';
import './style.css';

const makeRoom = () => Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const formatTime = value => { if (!Number.isFinite(value)) return '—'; const total = Math.max(0, Math.floor(value)); return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`; };
const exactSyncProviders = ['youtube', 'vimeo', 'direct', 'vk'];
// A drift smaller than this is imperceptible and not worth re-seeking for:
// re-seeking an iframe player (YouTube/VK) forces it to rebuffer, which
// fires its own "playing" state event and can bounce back through the room.
const SYNC_DRIFT_THRESHOLD = 1.5;
class AppErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('WatchTogether interface error:', error); }
  render() {
    if (this.state.error) return <main><section className="fatal"><div className="play-icon">!</div><h1>Unable to display the room</h1><p>{this.state.error.message || 'Unexpected interface error'}</p><button onClick={() => location.reload()}>Reload room</button></section></main>;
    return this.props.children;
  }
}
function App() {
  const initial = location.pathname.match(/^\/room\/([\w-]+)/)?.[1];
  const [roomId] = useState(initial || makeRoom());
  const [url, setUrl] = useState(''); const [video, setVideo] = useState(null);
  const [people, setPeople] = useState([]); const [notice, setNotice] = useState('Paste a link to begin');
  const [messages, setMessages] = useState([]); const [chat, setChat] = useState(''); const [you, setYou] = useState(null);
  const [connected, setConnected] = useState(false); const ws = useRef(); const player = useRef(); const stage = useRef(); const suppressDepth = useRef(0); const playback = useRef({ state: 'paused', currentTime: 0 }); const currentVideo = useRef(null);
  useEffect(() => { if (!initial) history.replaceState({}, '', `/room/${roomId}`); }, [initial, roomId]);
  const send = useCallback(message => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(message)); }, []);
  const dispose = useCallback(() => { player.current?.destroy(); player.current = null; }, []);
  // Counter (not a boolean) so overlapping async player operations - e.g. an
  // initial "ready" sync still resolving while a periodic correction comes
  // in - can't stomp on each other and prematurely stop suppressing events.
  // try/finally guarantees it's released even if seek/play throws. The
  // iframe providers (YouTube/VK) don't resolve seek()/play() when the
  // player is actually done buffering - they resolve as soon as the command
  // is issued - and then fire their own delayed "playing" state event once
  // buffering finishes. A short grace period after the call keeps that
  // trailing event suppressed too, instead of it looking like a fresh user
  // action and being echoed straight back into the room (the original
  // "reloads every millisecond" loop).
  const withSuppressed = useCallback(async (fn, graceMs = 800) => {
    suppressDepth.current++;
    try { await fn(); } finally { setTimeout(() => { suppressDepth.current = Math.max(0, suppressDepth.current - 1); }, graceMs); }
  }, []);
  const load = useCallback(async (nextVideo, sync) => {
    dispose(); currentVideo.current = nextVideo; setVideo(nextVideo); if (!nextVideo) return;
    // Let React remove its empty-state child before a provider replaces the
    // stage contents with an iframe/video element. Otherwise React can try to
    // remove a node the player has already removed and blank the whole app.
    await new Promise(resolve => requestAnimationFrame(resolve));
    setNotice('Loading video…');
    const Player = playerFor[nextVideo.provider];
    if (!Player) { setNotice('This video cannot be embedded'); return; }
    try {
      const instance = new Player(stage.current, nextVideo); player.current = instance;
      instance.on('ready', async () => {
        setNotice('Video ready');
        if (sync) {
          const elapsed = sync.state === 'playing' ? (Date.now() - sync.updatedAt) / 1000 : 0;
          const target = Math.max(0, sync.currentTime + elapsed);
          await withSuppressed(async () => { await instance.seek(target); if (sync.state === 'playing') await instance.play(); });
          playback.current = { state: sync.state, currentTime: target, updatedAt: Date.now() };
        }
      });
      instance.on('error', () => setNotice('Unable to load video'));
      instance.on('playing', async () => { if (suppressDepth.current) return; const time = await instance.getCurrentTime(); playback.current = { state: 'playing', currentTime: time, updatedAt: Date.now() }; send({ type: 'play', time }); });
      instance.on('paused', async () => { if (suppressDepth.current) return; const time = await instance.getCurrentTime(); playback.current = { state: 'paused', currentTime: time, updatedAt: Date.now() }; send({ type: 'pause', time }); });
      instance.on('ended', async () => { if (suppressDepth.current) return; const time = await instance.getCurrentTime(); playback.current = { state: 'paused', currentTime: time, updatedAt: Date.now() }; send({ type: 'ended', time }); });
    } catch (error) { console.error('Player creation error:', error); setNotice('Unable to load video'); }
  }, [dispose, send, withSuppressed]);
  const applySync = useCallback(async (data) => {
    if (!player.current || !data.playback) return;
    const p = player.current;
    const elapsed = data.playback.state === 'playing' ? (Date.now() - data.playback.updatedAt) / 1000 : 0;
    const target = Math.max(0, data.playback.currentTime + elapsed);
    playback.current = data.playback;
    await withSuppressed(async () => {
      // Only re-seek when the drift is actually noticeable: seeking an
      // iframe player (YouTube/VK) forces a rebuffer every time, which is
      // the main source of the constant stutter/reload behavior.
      const current = await p.getCurrentTime();
      if (Math.abs(current - target) > SYNC_DRIFT_THRESHOLD) await p.seek(target);
      if (data.playback.state === 'playing') await p.play(); else await p.pause();
    });
  }, [withSuppressed]);
  useEffect(() => {
    // Vite runs on 5173 in development while the realtime server runs on 3001.
    // In a production build both share the same origin and port.
    const socketHost = import.meta.env.DEV ? `${location.hostname}:3001` : location.host;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${socketHost}/ws?room=${encodeURIComponent(roomId)}`); ws.current = socket;
    socket.onopen = () => setConnected(true); socket.onclose = () => setConnected(false);
    socket.onmessage = async ({ data }) => { let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'welcome') { setYou(msg.you); setPeople(msg.participants); setMessages(msg.messages || []); if (msg.video) load(msg.video, msg.playback); }
      if (msg.type === 'participants') setPeople(msg.participants);
      if (msg.type === 'chat') setMessages(current => [...current, msg.message].slice(-50));
      if (msg.type === 'loadVideo') load(msg.video, msg.playback);
      if (msg.type === 'sync') { if (!currentVideo.current && msg.video) load(msg.video, msg.playback); else applySync(msg); }
      if (['play','pause','seek','ended'].includes(msg.type)) applySync({ playback: { state: msg.type === 'play' ? 'playing' : msg.type === 'pause' || msg.type === 'ended' ? 'paused' : playback.current.state, currentTime: msg.time, updatedAt: msg.timestamp } });
      if (msg.type === 'error') setNotice(msg.message);
    };
    const timer = setInterval(() => send({ type: 'syncRequest' }), 8000);
    const positionTimer = setInterval(async () => {
      if (!player.current || !exactSyncProviders.includes(currentVideo.current?.provider)) return;
      send({ type: 'presence', time: await player.current.getCurrentTime() });
    }, 4000);
    return () => { clearInterval(timer); clearInterval(positionTimer); socket.close(); dispose(); };
  }, [roomId, load, applySync, dispose, send]);
  const add = e => { e.preventDefault(); try { parseVideoUrl(url); send({ type: 'loadVideo', url }); setUrl(''); } catch (error) { setNotice(error.message); } };
  const copy = async () => { await navigator.clipboard.writeText(location.href); setNotice('Link copied!'); };
  const syncEveryone = async () => {
    if (!player.current || !exactSyncProviders.includes(currentVideo.current?.provider)) return setNotice('Exact sync is unavailable for this video');
    send({ type: 'forceSync', time: await player.current.getCurrentTime() }); setNotice('Synchronizing everyone…');
  };
  const submitChat = e => { e.preventDefault(); if (!chat.trim()) return; send({ type: 'chat', text: chat }); setChat(''); };
  return <main><header><a className="brand" href="/">watch<span>together</span></a><div className="room-state"><i className={connected ? 'on' : ''}/>{connected ? 'Live room' : 'Reconnecting…'}</div><button className="copy" onClick={copy}>Copy room link</button></header>
    <section className="shell"><div className="stage" ref={stage}>{!video && <div className="empty"><div className="play-icon">▶</div><h1>Bring everyone to the same moment.</h1><p>Paste a video link below and start watching together.</p></div>}</div><div className="status">{notice}</div>
      <div className="people"><div className="avatars">{people.slice(0, 4).map((p, i) => <span key={p.id} style={{ '--n': i }}>{p.name.slice(0, 1).toUpperCase()}</span>)}</div><span>{people.length || 1} watching now</span><div className="names">{people.map(p => p.name).join(' · ')}</div></div>
      <form onSubmit={add}><input value={url} onChange={e => setUrl(e.target.value)} placeholder="Paste video URL…" aria-label="Video URL"/><button type="submit">Add video <b>→</b></button></form>
      <div className="room-tools"><section className="sync-card"><div><small>ROOM SYNC</small><strong>{people.length > 1 ? 'Everyone follows the room timeline' : 'Invite someone to start watching together'}</strong></div><button onClick={syncEveryone}>Sync everyone</button><div className="watchers">{people.map(person => <div className="watcher" key={person.id}><span className="presence-dot"/><b>{person.id === you?.id ? 'You' : person.name}</b><em>{exactSyncProviders.includes(video?.provider) ? `at ${formatTime(person.position)}` : 'position unavailable'}</em></div>)}</div></section>
        <section className="chat-card"><div className="chat-title">Room chat <span>{messages.length}</span></div><div className="messages">{messages.length ? messages.map(message => <p key={message.id} className={message.authorId === you?.id ? 'mine' : ''}><b>{message.authorId === you?.id ? 'You' : message.author}</b>{message.text}</p>) : <p className="chat-empty">Say hello to the room.</p>}</div><form className="chat-form" onSubmit={submitChat}><input value={chat} onChange={e => setChat(e.target.value)} maxLength="500" placeholder="Write a message…"/><button type="submit">Send</button></form></section>
      </div>
    </section><p className="hint">One room, one video, perfectly in sync.</p></main>;
}
createRoot(document.getElementById('root')).render(<AppErrorBoundary><App/></AppErrorBoundary>);
