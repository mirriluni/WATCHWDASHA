import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseVideoUrl } from '../shared/video-url.js';
import { playerFor } from './players.js';
import './style.css';

const makeRoom = () => Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const formatTime = value => { if (!Number.isFinite(value)) return '—'; const total = Math.max(0, Math.floor(value)); return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`; };
const formatClock = ts => { if (!Number.isFinite(ts)) return ''; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const avatarColor = id => { let hash = 0; for (let i = 0; i < (id || '').length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0; return `hsl(${hash % 360}, 46%, 47%)`; };
const exactSyncProviders = ['youtube', 'vimeo', 'direct', 'vk'];
// A drift smaller than this is imperceptible and not worth re-seeking for:
// re-seeking an iframe player (YouTube/VK) forces it to rebuffer, which
// fires its own "playing" state event and can bounce back through the room.
const SYNC_DRIFT_THRESHOLD = 1.5;
const MAX_IMAGE_DATA_URL = 550_000;

const Icon = ({ children }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">{children}</svg>;
const IconPlus = () => <Icon><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Icon>;
const IconLink = () => <Icon><circle cx="7" cy="12" r="3.4" /><circle cx="17" cy="12" r="3.4" /><line x1="10.2" y1="12" x2="13.8" y2="12" /></Icon>;
const IconImage = () => <Icon><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 15 9 5 19" /></Icon>;
const IconSend = () => <Icon><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></Icon>;
const IconRefresh = () => <Icon><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></Icon>;

const compressImage = file => new Promise((resolve, reject) => {
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(objectUrl);
    let { width, height } = img;
    const maxSide = 1000;
    if (width > maxSide || height > maxSide) { const scale = maxSide / Math.max(width, height); width = Math.round(width * scale); height = Math.round(height * scale); }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    let quality = 0.78; let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > MAX_IMAGE_DATA_URL && quality > 0.3) { quality -= 0.12; dataUrl = canvas.toDataURL('image/jpeg', quality); }
    if (dataUrl.length > MAX_IMAGE_DATA_URL) return reject(new Error('Картинка слишком большая, попробуйте другую'));
    resolve(dataUrl);
  };
  img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Не удалось прочитать файл')); };
  img.src = objectUrl;
});

class AppErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('WatchTogether interface error:', error); }
  render() {
    if (this.state.error) return <main className="fatal-screen"><section className="fatal"><div className="play-icon">!</div><h1>Не удалось отобразить комнату</h1><p>{this.state.error.message || 'Непредвиденная ошибка интерфейса'}</p><button onClick={() => location.reload()}>Перезагрузить</button></section></main>;
    return this.props.children;
  }
}
function App() {
  const initial = location.pathname.match(/^\/room\/([\w-]+)/)?.[1];
  const [roomId] = useState(initial || makeRoom());
  const [url, setUrl] = useState(''); const [video, setVideo] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [people, setPeople] = useState([]); const [notice, setNotice] = useState('Вставьте ссылку, чтобы начать');
  const [messages, setMessages] = useState([]); const [chat, setChat] = useState(''); const [you, setYou] = useState(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [, setTick] = useState(0);
  const [connected, setConnected] = useState(false); const ws = useRef(); const player = useRef(); const stage = useRef(); const suppressDepth = useRef(0); const playback = useRef({ state: 'paused', currentTime: 0 }); const currentVideo = useRef(null); const lastPoll = useRef(null);
  const fileInput = useRef(); const messagesEnd = useRef(); const noticeTimer = useRef();
  // Transient status messages (link copied, sync triggered, errors) used to
  // just sit in the toolbar forever because nothing ever reset them. This
  // shows the message, then settles back to the ambient player status after
  // a few seconds instead of getting stuck.
  const flashNotice = useCallback((text, ms = 2500) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(video ? 'Видео готово' : 'Вставьте ссылку, чтобы начать'), ms);
  }, [video]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  // Read via a ref inside the socket effect below so a fresh flashNotice
  // (it changes whenever `video` does) never forces that effect to
  // reconnect the websocket - only [roomId, load, applySync, dispose, send]
  // should ever do that.
  const flashNoticeRef = useRef(flashNotice);
  useEffect(() => { flashNoticeRef.current = flashNotice; }, [flashNotice]);
  useEffect(() => { if (!initial) history.replaceState({}, '', `/room/${roomId}`); }, [initial, roomId]);
  // Drives the live-ticking time badges: without a heartbeat, a person's
  // displayed position only updates when a network message happens to
  // arrive, which looks stuck/jumpy instead of counting seconds smoothly.
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);
  // Mobile browsers don't shrink `100dvh` consistently when the on-screen
  // keyboard opens (support varies a lot by browser/webview), so the page
  // used to grow taller than the visible area and get auto-scrolled to keep
  // the focused chat input visible - pushing the video off-screen. Tracking
  // the real visual viewport height in JS and feeding it back as a CSS
  // variable keeps the whole app pinned to exactly what's actually visible.
  useEffect(() => {
    const vv = window.visualViewport;
    const setAppHeight = () => document.documentElement.style.setProperty('--app-height', `${(vv?.height ?? window.innerHeight)}px`);
    setAppHeight();
    vv?.addEventListener('resize', setAppHeight);
    window.addEventListener('resize', setAppHeight);
    return () => { vv?.removeEventListener('resize', setAppHeight); window.removeEventListener('resize', setAppHeight); };
  }, []);
  const send = useCallback(message => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(message)); }, []);
  const dispose = useCallback(() => { player.current?.destroy(); player.current = null; lastPoll.current = null; }, []);
  // Counter (not a boolean) so overlapping async player operations - e.g. an
  // initial "ready" sync still resolving while a periodic correction comes
  // in - can't stomp on each other and prematurely stop suppressing events.
  // try/finally guarantees it's released even if seek/play throws. The
  // iframe providers (YouTube/VK) don't resolve seek()/play() when the
  // player is actually done buffering - they resolve as soon as the command
  // is issued - and then fire their own delayed "playing" state event once
  // buffering finishes. A short grace period after the call keeps that
  // trailing event suppressed too, instead of it looking like a fresh user
  // action and being echoed straight back into the room.
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
    setNotice('Загрузка видео…');
    const Player = playerFor[nextVideo.provider];
    if (!Player) { setNotice('Это видео нельзя встроить'); return; }
    try {
      const instance = new Player(stage.current, nextVideo); player.current = instance;
      instance.on('ready', async () => {
        setNotice('Видео готово');
        if (sync) {
          const elapsed = sync.state === 'playing' ? (Date.now() - sync.updatedAt) / 1000 : 0;
          const target = Math.max(0, sync.currentTime + elapsed);
          await withSuppressed(async () => { await instance.seek(target); if (sync.state === 'playing') await instance.play(); });
          playback.current = { state: sync.state, currentTime: target, updatedAt: Date.now() };
        }
      });
      instance.on('error', () => setNotice('Не удалось загрузить видео'));
      instance.on('playing', async () => { if (suppressDepth.current) return; const time = await instance.getCurrentTime(); playback.current = { state: 'playing', currentTime: time, updatedAt: Date.now() }; send({ type: 'play', time }); });
      instance.on('paused', async () => { if (suppressDepth.current) return; const time = await instance.getCurrentTime(); playback.current = { state: 'paused', currentTime: time, updatedAt: Date.now() }; send({ type: 'pause', time }); });
      instance.on('ended', async () => { if (suppressDepth.current) return; const time = await instance.getCurrentTime(); playback.current = { state: 'paused', currentTime: time, updatedAt: Date.now() }; send({ type: 'ended', time }); });
      // Scrubbing the timeline doesn't change play/paused state, so it never
      // reaches the handlers above - and without this, the periodic sync
      // correction below would snap the video back to the old, un-seeked
      // position within a few seconds.
      instance.on('seeked', async () => { if (suppressDepth.current) return; const time = await instance.getCurrentTime(); playback.current = { ...playback.current, currentTime: time, updatedAt: Date.now() }; send({ type: 'seek', time }); });
    } catch (error) { console.error('Player creation error:', error); setNotice('Не удалось загрузить видео'); }
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
      if (msg.type === 'chat') setMessages(current => [...current, msg.message].slice(-30));
      if (msg.type === 'loadVideo') load(msg.video, msg.playback);
      if (msg.type === 'sync') { if (!currentVideo.current && msg.video) load(msg.video, msg.playback); else applySync(msg); }
      if (['play','pause','seek','ended'].includes(msg.type)) applySync({ playback: { state: msg.type === 'play' ? 'playing' : msg.type === 'pause' || msg.type === 'ended' ? 'paused' : playback.current.state, currentTime: msg.time, updatedAt: msg.timestamp } });
      if (msg.type === 'error') flashNoticeRef.current(msg.message);
    };
    const timer = setInterval(() => send({ type: 'syncRequest' }), 8000);
    const positionTimer = setInterval(async () => {
      if (!player.current || !exactSyncProviders.includes(currentVideo.current?.provider)) { lastPoll.current = null; return; }
      const time = await player.current.getCurrentTime();
      send({ type: 'presence', time });
      // Generic seek detection: YouTube/Vimeo/VK don't reliably fire a
      // dedicated "seeked" event (especially when scrubbing while paused),
      // so catch it here by comparing against where playback should be if
      // nothing but normal time flow had happened. Without this the 8s
      // periodic sync below would otherwise roll a silent seek back.
      const prev = lastPoll.current; lastPoll.current = { time, at: Date.now() };
      if (suppressDepth.current || !prev) return;
      const expected = prev.time + (playback.current.state === 'playing' ? (Date.now() - prev.at) / 1000 : 0);
      if (Math.abs(time - expected) > SYNC_DRIFT_THRESHOLD) {
        playback.current = { ...playback.current, currentTime: time, updatedAt: Date.now() };
        send({ type: 'seek', time });
      }
    }, 1500);
    return () => { clearInterval(timer); clearInterval(positionTimer); socket.close(); dispose(); };
  }, [roomId, load, applySync, dispose, send]);
  const add = e => { e.preventDefault(); try { parseVideoUrl(url); send({ type: 'loadVideo', url }); setUrl(''); setShowAdd(false); } catch (error) { flashNotice(error.message); } };
  const onUrlKeyDown = e => { if (e.key === 'Enter') add(e); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); flashNotice('Ссылка скопирована!'); }
    catch { flashNotice('Не удалось скопировать ссылку'); }
  };
  const syncEveryone = async () => {
    if (!player.current || !exactSyncProviders.includes(currentVideo.current?.provider)) return flashNotice('Точная синхронизация недоступна для этого видео');
    send({ type: 'forceSync', time: await player.current.getCurrentTime() }); flashNotice('Синхронизируем всех…', 2000);
  };
  const submitChat = e => { e.preventDefault(); if (!chat.trim()) return; send({ type: 'chat', text: chat }); setChat(''); };
  const onChatKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) submitChat(e); };
  const sendImageFile = useCallback(async file => {
    if (!file || !file.type?.startsWith('image/')) return;
    setImageBusy(true);
    try { const dataUrl = await compressImage(file); send({ type: 'chat', image: dataUrl }); }
    catch (error) { flashNotice(error.message || 'Не удалось отправить картинку'); }
    finally { setImageBusy(false); }
  }, [send, flashNotice]);
  const onPickImage = e => { const file = e.target.files?.[0]; e.target.value = ''; sendImageFile(file); };
  const onPasteChat = e => { const file = [...(e.clipboardData?.files || [])].find(f => f.type?.startsWith('image/')); if (file) { e.preventDefault(); sendImageFile(file); } };
  const extrapolate = person => {
    if (!person || !Number.isFinite(person.position)) return null;
    const elapsed = playback.current.state === 'playing' && person.positionUpdatedAt ? Math.max(0, (Date.now() - person.positionUpdatedAt) / 1000) : 0;
    return person.position + elapsed;
  };
  const timeKnown = exactSyncProviders.includes(video?.provider);
  const yourTime = extrapolate(people.find(p => p.id === you?.id));
  const visiblePeople = people.slice(0, 5);
  const overflow = Math.max(0, people.length - visiblePeople.length);
  return <div className="app">
    <header className="topbar">
      <a className="brand" href="/">watch<span>together</span></a>
      <div className={`status-pill ${connected ? 'on' : ''}`}><i /><span>{connected ? 'В сети' : 'Переподключение…'}</span></div>
      <div className="topbar-actions">
        {video && <button className="icon-btn" onClick={() => setShowAdd(v => !v)} title="Добавить видео" aria-label="Добавить видео"><IconPlus /></button>}
        <button className="icon-btn" onClick={copy} title="Скопировать ссылку на комнату" aria-label="Скопировать ссылку"><IconLink /></button>
      </div>
    </header>
    {showAdd && <form className="add-video-bar" onSubmit={add}>
      <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={onUrlKeyDown} placeholder="Вставьте ссылку на видео…" aria-label="Ссылка на видео" autoFocus />
      <button type="submit">Добавить</button>
    </form>}
    <div className="room">
      <div className="stage-wrap">
        <div className={`stage ${video ? 'has-video' : ''}`} ref={stage}>
          {!video && <div className="empty">
            <div className="play-icon">▶</div>
            <h1>Смотрите вместе, минута в минуту.</h1>
            <p>Вставьте ссылку на видео и позовите друзей в комнату.</p>
            <form className="empty-form" onSubmit={add}>
              <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={onUrlKeyDown} placeholder="Вставьте ссылку на видео…" aria-label="Ссылка на видео" />
              <button type="submit">Добавить <b>→</b></button>
            </form>
          </div>}
          {video && people.length > 0 && <div className="stage-badges">
            {visiblePeople.map(person => {
              const t = extrapolate(person);
              const isYou = person.id === you?.id;
              const drift = !isYou && Number.isFinite(t) && Number.isFinite(yourTime) ? Math.abs(t - yourTime) : null;
              const state = isYou ? 'me' : drift === null ? '' : drift > SYNC_DRIFT_THRESHOLD ? 'drift' : 'synced';
              return <div className={`badge ${state}`} key={person.id} title={isYou ? 'Вы' : person.name}>
                <span className="badge-avatar" style={{ background: avatarColor(person.id) }}>{person.name.slice(0, 1).toUpperCase()}</span>
                {timeKnown && <span className="badge-time">{formatTime(t)}</span>}
              </div>;
            })}
            {overflow > 0 && <div className="badge more">+{overflow}</div>}
          </div>}
        </div>
        <div className="stage-toolbar">
          <div className="toolbar-notice"><span className={`dot ${connected ? 'on' : ''}`} />{notice}</div>
          <div className="toolbar-actions">
            <span className="watch-count">{people.length || 1} смотрит{people.length === 1 ? '' : people.length ? 'ят' : ''}</span>
            <button className="sync-btn" onClick={syncEveryone} disabled={people.length <= 1}><IconRefresh /><span>Синхронизировать</span></button>
          </div>
        </div>
      </div>
      <aside className="chat-pane">
        <div className="chat-header">Чат комнаты <span>{messages.length}</span></div>
        <div className="messages">
          {messages.length ? messages.map(message => <div key={message.id} className={`msg ${message.authorId === you?.id ? 'mine' : ''}`}>
            <div className="msg-meta"><b style={{ color: avatarColor(message.authorId) }}>{message.authorId === you?.id ? 'Вы' : message.author}</b><time>{formatClock(message.timestamp)}</time></div>
            {message.image && <img className="msg-image" src={message.image} alt="Скриншот из чата" onClick={() => window.open(message.image, '_blank')} />}
            {message.text && <p>{message.text}</p>}
          </div>) : <p className="chat-empty">Скажите привет в комнате.</p>}
          <div ref={messagesEnd} />
        </div>
        <form className="chat-form" onSubmit={submitChat}>
          <input type="file" accept="image/*" ref={fileInput} hidden onChange={onPickImage} />
          <button type="button" className="attach-btn" onClick={() => fileInput.current?.click()} disabled={imageBusy} title="Отправить изображение" aria-label="Отправить изображение"><IconImage /></button>
          <input value={chat} onChange={e => setChat(e.target.value)} onPaste={onPasteChat} onKeyDown={onChatKeyDown} maxLength="500" placeholder="Написать сообщение…" aria-label="Сообщение" />
          <button type="submit" className="send-btn" aria-label="Отправить"><IconSend /></button>
        </form>
      </aside>
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<AppErrorBoundary><App/></AppErrorBoundary>);
