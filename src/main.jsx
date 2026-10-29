import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseVideoUrl } from '../shared/video-url.js';
import { playerFor, probeVkHosts } from './players.js';
import './style.css';

const makeRoom = () => Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const formatTime = value => { if (!Number.isFinite(value)) return '—'; const total = Math.max(0, Math.floor(value)); return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`; };
const formatClock = ts => { if (!Number.isFinite(ts)) return ''; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const avatarColor = id => { let hash = 0; for (let i = 0; i < (id || '').length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0; return `hsl(${hash % 360}, 46%, 47%)`; };
const formatDuration = seconds => {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин`;
  return 'меньше минуты';
};
// A plain "N смотрят" told you nothing about who - but a full name-by-name
// list gets unwieldy fast, so this caps it at two names plus a "+N" tail.
const formatWatchers = (people, youId) => {
  const names = people.map(p => (p.id === youId ? 'Вы' : (p.name || 'Гость')));
  names.sort((a, b) => (a === 'Вы' ? -1 : b === 'Вы' ? 1 : 0));
  if (names.length <= 1) return names[0] || 'Вы';
  if (names.length === 2) return `${names[0]} и ${names[1]}`;
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
};
// The logged-in account, kept in localStorage so a login sticks until the
// person explicitly logs out - never a silent timeout, by design.
const ACCOUNT_KEY = 'wt_account';
const getSavedAccount = () => { try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY)); } catch { return null; } };
const saveAccount = account => { try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch { /* private mode / storage blocked - stays logged in only for this tab session */ } };
const clearSavedAccount = () => { try { localStorage.removeItem(ACCOUNT_KEY); } catch { /* nothing to clear */ } };
// Opening the bare site used to drop you into a brand-new random room every
// time - so two people who each "just opened the site" were never together.
// Remember the last room and return to it; links to a specific room still win.
const LAST_ROOM_KEY = 'wt_last_room';
const getLastRoom = () => { try { const id = localStorage.getItem(LAST_ROOM_KEY); return /^[a-zA-Z0-9_-]{4,64}$/.test(id || '') ? id : null; } catch { return null; } };
const saveLastRoom = id => { try { localStorage.setItem(LAST_ROOM_KEY, id); } catch { /* ignore */ } };
const parseRoomCode = text => { const t = (text || '').trim(); const fromUrl = t.match(/\/room\/([a-zA-Z0-9_-]{4,64})/)?.[1]; const code = fromUrl || t; return /^[a-zA-Z0-9_-]{4,64}$/.test(code) ? code : null; };
// In-app browsers (Telegram, Instagram, VK app...) run a stripped-down
// WebView: third-party cookies/storage for the vk.* iframe are often blocked
// and autoplay rules are stricter. VK's own docs warn the widget breaks under
// tracking protection. We can't fix that from inside the page - but we can
// tell the person to open a real browser instead of letting it look broken.
const UA = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IN_APP_BROWSER = /Telegram|Instagram|FBAN|FBAV|FB_IAB|VKClient|VKAndroidApp|Viber|Line\/|MicroMessenger|Snapchat|TikTok/i.test(UA)
  || (IS_IOS && !/Safari\//.test(UA) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(UA))
  || /; wv\)/.test(UA);
const describePlayerError = (error, video) => {
  const vk = video?.provider === 'vk';
  const open = vk ? 'Открыть в VK Видео' : 'Открыть на сайте источника';
  if (error.code === 'unreachable' || error.code === 'sdk' || error.code === 'init') return {
    title: vk ? 'VK Видео не отвечает с вашего интернета' : 'Плеер не загрузился',
    text: vk ? `Ни один из адресов VK (vkvideo.ru, vk.com, vk.ru) не ответил${error.probes ? ` — проверка заняла ${Math.max(...error.probes.map(p => p.ms))} мс` : ''}. Это блокировка со стороны сети/страны, VPN или блокировщика — у другого человека в комнате при этом всё может работать.` : 'Скрипт плеера не загрузился.',
    steps: [
      IN_APP_BROWSER ? 'Сайт открыт внутри Telegram/Instagram — нажмите «⋯» → «Открыть в браузере» (Safari или Chrome). Во встроенном браузере VK чаще всего не работает.' : null,
      IS_IOS && !IN_APP_BROWSER ? 'iPhone/Safari: Настройки → Safari → выключите «Не отслеживать» (Prevent Cross-Site Tracking) и отключите контент-блокировщики для этого сайта — VK прямо пишет, что из-за них плеер не загружается. Либо откройте сайт в Chrome.' : null,
      'Если включён VPN — выключите его; если выключен — попробуйте включить (VK блокируют в одних странах и не любят VPN-адреса в других).',
      'Отключите блокировщик рекламы для этого сайта. В Safari: Настройки → Safari → выключите «Не отслеживать» (VK прямо пишет, что из-за этого плеер не работает).',
      'Нажмите «Попробовать снова» — иногда помогает просто перезапуск плеера.',
    ].filter(Boolean), open,
  };
  if (vk) return {
    title: `VK отказался показать это видео${error.code ? ` (код ${error.code})` : ''}`,
    text: 'Обычно так бывает, если видео приватное, доступно только по ссылке, удалено или недоступно в вашей стране.',
    steps: [
      'Откройте видео в VK → «Поделиться» → «Экспортировать» и вставьте сюда весь код с <iframe> — в нём есть ключ доступа (hash), без него плеер не покажет закрытое видео.',
      'Проверьте, что видео вообще открывается у вас в VK напрямую (кнопка ниже).',
      'Если видео заблокировано для вашей страны — поможет только VPN.',
    ], open,
  };
  if (video?.provider === 'youtube') return {
    title: `YouTube не воспроизводит это видео${error.code ? ` (код ${error.code})` : ''}`,
    text: [101, 150].includes(Number(error.code)) ? 'Автор запретил встраивание этого видео на другие сайты.' : Number(error.code) === 100 ? 'Видео удалено или приватное.' : 'Проверьте, что видео открывается у вас напрямую.',
    steps: ['Попробуйте другое видео или другую ссылку.', 'Если YouTube недоступен в вашей стране — поможет только VPN.'], open,
  };
  return { title: 'Видео не воспроизводится', text: 'Проверьте ссылку и попробуйте ещё раз.', steps: [], open };
};
const exactSyncProviders = ['youtube', 'vimeo', 'direct', 'vk'];
// A drift smaller than this is imperceptible and not worth re-seeking for:
// re-seeking an iframe player (YouTube/VK) forces it to rebuffer, which
// fires its own "playing" state event and can bounce back through the room.
const SYNC_DRIFT_THRESHOLD = 5;
// Threshold for the red "out of sync" badge color, kept as its own constant
// in case it ever needs to move independently of the re-seek threshold above.
const BADGE_DRIFT_THRESHOLD = 5;
const MAX_IMAGE_DATA_URL = 550_000;

const Icon = ({ children }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">{children}</svg>;
const IconPlus = () => <Icon><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Icon>;
const IconLink = () => <Icon><circle cx="7" cy="12" r="3.4" /><circle cx="17" cy="12" r="3.4" /><line x1="10.2" y1="12" x2="13.8" y2="12" /></Icon>;
const IconImage = () => <Icon><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 15 9 5 19" /></Icon>;
const IconSend = () => <Icon><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></Icon>;
const IconRefresh = () => <Icon><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></Icon>;
const IconChart = () => <Icon><line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" /></Icon>;
const IconLogout = () => <Icon><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></Icon>;
const IconPlay = () => <Icon><polygon points="6 3 20 12 6 21 6 3" /></Icon>;
const IconSound = () => <Icon><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9 9 0 0 1 0 14" /></Icon>;

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

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    setError(''); setBusy(true);
    try {
      const res = await fetch(`/api/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
      onAuthenticated({ token: data.token, accountId: data.accountId, username: data.username });
    } catch (err) { setError(err.message || 'Не удалось подключиться к серверу'); }
    finally { setBusy(false); }
  };
  return <main className="fatal-screen">
    <form className="auth-card" onSubmit={submit}>
      <a className="brand" href="/">watch<span>together</span></a>
      <h1>{mode === 'login' ? 'Вход' : 'Регистрация'}</h1>
      <p>Чтобы смотреть видео вместе, нужен аккаунт — вход сохраняется, пока вы сами не выйдете.</p>
      <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Имя пользователя" autoComplete="username" maxLength="20" required />
      <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Пароль" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength="6" required />
      {error && <p className="auth-error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}</button>
      <button type="button" className="auth-switch" onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setError(''); }}>
        {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
      </button>
    </form>
  </main>;
}

function Room({ account, onLogout }) {
  const initial = location.pathname.match(/^\/room\/([\w-]+)/)?.[1];
  const [roomId] = useState(initial || getLastRoom() || makeRoom());
  const [url, setUrl] = useState(''); const [video, setVideo] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  // 'tap' = playback needs a user gesture; 'unmute' = we started muted and
  // need a gesture to turn sound on; null = nothing to show.
  const [overlay, setOverlay] = useState(null);
  const [playerError, setPlayerError] = useState(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [loadStatus, setLoadStatus] = useState('');
  const loadStartedAt = useRef(0);
  const [diag, setDiag] = useState(null);
  const [hintDismissed, setHintDismissed] = useState(() => { try { return !!localStorage.getItem('wt_hint_dismissed'); } catch { return true; } });
  const [people, setPeople] = useState([]); const [notice, setNotice] = useState('Вставьте ссылку, чтобы начать');
  const [messages, setMessages] = useState([]); const [chat, setChat] = useState(''); const [you, setYou] = useState(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [chatTab, setChatTab] = useState('chat');
  const [stats, setStats] = useState(null);
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
  const onLogoutRef = useRef(onLogout);
  useEffect(() => { onLogoutRef.current = onLogout; }, [onLogout]);
  useEffect(() => { if (initial !== roomId) history.replaceState({}, '', `/room/${roomId}`); saveLastRoom(roomId); }, [initial, roomId]);
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
    // The keyboard doesn't just shrink the visible area - on many mobile
    // browsers the page also pans down so the focused input stays in view
    // (visualViewport.offsetTop > 0). Matching only the height and not this
    // offset left the app pinned to the top of the *layout* viewport while
    // the *visible* area had scrolled past it - the video was still "there",
    // just above the fold, which read as it vanishing.
    const setAppMetrics = () => {
      document.documentElement.style.setProperty('--app-height', `${(vv?.height ?? window.innerHeight)}px`);
      document.documentElement.style.setProperty('--app-top', `${vv?.offsetTop ?? 0}px`);
    };
    setAppMetrics();
    vv?.addEventListener('resize', setAppMetrics);
    vv?.addEventListener('scroll', setAppMetrics);
    window.addEventListener('resize', setAppMetrics);
    // In-app browsers (Telegram, Instagram, ...) and some WebViews fire the
    // viewport resize for the keyboard late, or in several steps while it
    // animates in - a single measurement taken right on focus can land in
    // the middle of that and freeze on a wrong (often near-empty) layout
    // until something else happens to trigger a re-measurement, like typing.
    // Re-checking a few times over the keyboard's animation window fixes
    // that without waiting on an event that may never (re)fire.
    const settleTimers = [];
    const resettle = () => { settleTimers.forEach(clearTimeout); settleTimers.length = 0; [50, 150, 300, 500].forEach(delay => settleTimers.push(setTimeout(setAppMetrics, delay))); };
    const onFocusIn = e => { if (e.target.matches?.('input, textarea')) resettle(); };
    const onFocusOut = e => { if (e.target.matches?.('input, textarea')) resettle(); };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      vv?.removeEventListener('resize', setAppMetrics); vv?.removeEventListener('scroll', setAppMetrics); window.removeEventListener('resize', setAppMetrics);
      document.removeEventListener('focusin', onFocusIn); document.removeEventListener('focusout', onFocusOut);
      settleTimers.forEach(clearTimeout);
    };
  }, []);
  const send = useCallback(message => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(message)); }, []);
  const dispose = useCallback(() => {
    try { player.current?.destroy(); } catch (error) { console.error('Player destroy error:', error); }
    player.current = null; lastPoll.current = null;
  }, []);
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
  // Phones refuse a programmatic play() that didn't come from a tap on
  // *this* device - which is exactly what "the other person pressed play"
  // is. Browsers do allow a *muted* start though, so the fallback ladder is:
  // play → (blocked?) mute+play → show a one-tap "включить звук" button →
  // (even that blocked?) show a one-tap "смотреть" button. The tap handlers
  // call play()/unmute() synchronously inside the gesture, which is what
  // makes them count. Without this, a remote play() just silently did
  // nothing on the phone and the room looked "broken" for that person.
  const playAttempt = useRef(0);
  const ensurePlaying = useCallback(async p => {
    const attempt = ++playAttempt.current;
    const stillWanted = () => attempt === playAttempt.current && player.current === p && playback.current.state === 'playing';
    const settled = async () => { await new Promise(r => setTimeout(r, 1300)); if (!stillWanted()) return true; const s = await p.getState().catch(() => null); return s === 'playing' || s === 'ended' || s === null; };
    try {
      await p.play();
      if (await settled()) { if (stillWanted() && !(await p.isMuted().catch(() => false))) setOverlay(null); return; }
      await p.mute(); await p.play();
      if (await settled()) { if (stillWanted()) setOverlay('unmute'); return; }
      if (stillWanted()) setOverlay('tap');
    } catch { if (stillWanted()) setOverlay('tap'); }
  }, []);
  const tapToPlay = useCallback(async () => {
    const p = player.current; if (!p) return;
    const attempt = ++playAttempt.current;
    try { await Promise.all([p.unmute(), p.play()]); } catch { /* gesture-driven, nothing more we can do */ }
    setOverlay(null);
    // Some browsers (notably iOS Safari) won't let a tap on *our* page start
    // media inside a cross-origin iframe. The player's own ▶ always works,
    // so if nothing happened, step aside and point at it; the "playing"
    // handler below then snaps the person to the room's position.
    await new Promise(r => setTimeout(r, 2500));
    if (attempt !== playAttempt.current || player.current !== p || playback.current.state !== 'playing') return;
    const s = await p.getState().catch(() => null);
    if (s !== 'playing' && s !== 'ended' && s !== null) setOverlay('manual');
  }, []);
  const tapToUnmute = useCallback(async () => { const p = player.current; if (!p) return; try { await p.unmute(); } catch { /* ignore */ } setOverlay(null); }, []);
  // A flaky connection (mobile data, VPN) reconnects a lot, and every
  // reconnect gets a fresh "welcome" that calls load() again. If a new
  // load() starts while an older one is still in its startup `await`, both
  // would end up racing to build a player into the same `stage.current`
  // node - a real source of the "loads for one person but not the other"
  // and inconsistent-state reports. Each call gets a generation number and
  // bails as soon as it notices a newer one has taken over.
  const loadGen = useRef(0);
  const inAd = useRef(false);
  const load = useCallback(async (nextVideo, sync) => {
    const gen = ++loadGen.current;
    dispose(); currentVideo.current = nextVideo; setVideo(nextVideo); setPlayerError(null); setOverlay(null); setPlayerReady(false); setLoadStatus('Загружаем плеер…'); loadStartedAt.current = Date.now(); inAd.current = false; if (!nextVideo) return;
    const elapsed0 = sync?.state === 'playing' ? (Date.now() - sync.updatedAt) / 1000 : 0;
    const startTime = sync ? Math.max(0, sync.currentTime + elapsed0) : 0;
    playback.current = sync ? { state: sync.state, currentTime: startTime, updatedAt: Date.now() } : { state: 'paused', currentTime: 0, updatedAt: Date.now() };
    // Let React finish its own render/commit before a provider replaces the
    // stage contents with an iframe/video element, so the two never touch
    // the DOM at the same moment. requestAnimationFrame never fires at all
    // while the tab is backgrounded (browsers suspend it to save power) -
    // on a phone that's normal (switching apps for a second, a notification
    // shade), and without the timeout fallback here this would hang forever
    // instead of just a frame, leaving the video stuck on "Loading" forever.
    await new Promise(resolve => { const raf = requestAnimationFrame(resolve); setTimeout(() => { cancelAnimationFrame(raf); resolve(); }, 300); });
    if (gen !== loadGen.current) return;
    setNotice('Загрузка видео…');
    const Player = playerFor[nextVideo.provider];
    if (!Player) { setNotice('Это видео нельзя встроить'); return; }
    try {
      // Start the embed at the room's position (VK `t=`, YouTube `start`,
      // ...) instead of loading at 0:00 and seeking afterwards - one fewer
      // rebuffer, and the first frame the person sees is already in sync.
      const instance = new Player(stage.current, nextVideo, { startTime });
      if (gen !== loadGen.current) { instance.destroy(); return; }
      player.current = instance;
      const timeOf = () => instance.getCurrentTime().catch(() => playback.current.currentTime);
      instance.on('status', ({ text }) => { if (player.current === instance) setLoadStatus(text); });
      instance.on('ready', async () => {
        if (player.current !== instance) return;
        setNotice('Видео готово'); setPlayerError(null); setPlayerReady(true);
        if (!sync) return;
        const elapsed = sync.state === 'playing' ? (Date.now() - sync.updatedAt) / 1000 : 0;
        const target = Math.max(0, sync.currentTime + elapsed);
        playback.current = { state: sync.state, currentTime: target, updatedAt: Date.now() };
        await withSuppressed(async () => {
          try {
            const current = await instance.getCurrentTime();
            if (Math.abs(current - target) > SYNC_DRIFT_THRESHOLD) await instance.seek(target);
            if (sync.state === 'playing') await ensurePlaying(instance);
          } catch { /* handled through the error event */ }
        }, 1500);
      });
      instance.on('retrying', ({ host }) => setNotice(`VK не ответил, пробуем другой адрес (${host})…`));
      instance.on('error', detail => { if (player.current === instance) { setPlayerError({ provider: nextVideo.provider, ...detail }); setNotice('Видео не загрузилось'); } });
      // Only real *transitions* are forwarded to the room. Providers re-fire
      // "playing" after every rebuffer/seek and "paused" during stalls; if
      // the room already is in that state this is noise, not a user action -
      // forwarding it is how a video used to "start by itself" for others.
      instance.on('playing', async () => {
        if (inAd.current || player.current !== instance) return;
        setOverlay(o => (o === 'tap' || o === 'manual' ? null : o));
        if (suppressDepth.current) return;
        if (playback.current.state === 'playing') {
          // Already playing room-wide (e.g. the person just pressed the
          // player's own ▶ after a blocked remote start): don't re-announce,
          // but do jump to where the room actually is right now.
          const room = playback.current; const target = Math.max(0, room.currentTime + (Date.now() - room.updatedAt) / 1000);
          const time = await timeOf();
          if (Math.abs(time - target) > SYNC_DRIFT_THRESHOLD) await withSuppressed(() => instance.seek(target).catch(() => {}));
          return;
        }
        const time = await timeOf(); playback.current = { state: 'playing', currentTime: time, updatedAt: Date.now() }; send({ type: 'play', time });
      });
      instance.on('paused', async () => { if (suppressDepth.current || inAd.current || player.current !== instance) return; if (playback.current.state !== 'playing') return; const time = await timeOf(); playback.current = { state: 'paused', currentTime: time, updatedAt: Date.now() }; send({ type: 'pause', time }); });
      instance.on('ended', async () => { if (suppressDepth.current || inAd.current || player.current !== instance) return; if (playback.current.state !== 'playing') return; const time = await timeOf(); playback.current = { state: 'paused', currentTime: time, updatedAt: Date.now() }; send({ type: 'ended', time }); });
      instance.on('seeked', async () => { if (suppressDepth.current || inAd.current || player.current !== instance) return; const time = await timeOf(); if (Math.abs(time - playback.current.currentTime - (playback.current.state === 'playing' ? (Date.now() - playback.current.updatedAt) / 1000 : 0)) < 1) return; playback.current = { ...playback.current, currentTime: time, updatedAt: Date.now() }; send({ type: 'seek', time }); });
      // VK plays pre-roll ads: the timeline reports ad time, play/pause
      // during the ad don't mean anything for the room, and when the ad
      // ends we're behind everyone else - so freeze outgoing sync for the
      // duration and ask the server where the room is once it's over.
      instance.on('adStarted', () => { inAd.current = true; setNotice('Реклама VK — после неё догоним комнату'); });
      instance.on('adCompleted', () => { inAd.current = false; setNotice('Видео готово'); send({ type: 'syncRequest' }); });
      instance.on('autoplayBlocked', () => { if (player.current === instance && playback.current.state === 'playing') ensurePlaying(instance); });
    } catch (error) { console.error('Player creation error:', error); setPlayerError({ provider: nextVideo.provider, code: 'init' }); setNotice('Не удалось загрузить видео'); }
  }, [dispose, send, withSuppressed, ensurePlaying]);
  const applySync = useCallback(async (data) => {
    if (!player.current || !data.playback) return;
    const p = player.current;
    const elapsed = data.playback.state === 'playing' ? (Date.now() - data.playback.updatedAt) / 1000 : 0;
    const target = Math.max(0, data.playback.currentTime + elapsed);
    playback.current = { ...data.playback, currentTime: target, updatedAt: Date.now() };
    if (inAd.current) return;
    await withSuppressed(async () => {
      try {
        // Only re-seek when the drift is actually noticeable: seeking an
        // iframe player (YouTube/VK) forces a rebuffer every time, which is
        // the main source of the constant stutter/reload behavior.
        const current = await p.getCurrentTime();
        if (Math.abs(current - target) > SYNC_DRIFT_THRESHOLD) await p.seek(target);
        const state = await p.getState().catch(() => null);
        if (data.playback.state === 'playing') { if (state !== 'playing') await ensurePlaying(p); }
        else if (state !== 'paused' && state !== 'ended' && state !== 'unstarted') { await p.pause(); setOverlay(null); }
      } catch { /* provider SDK unavailable for this session - nothing to do */ }
    });
  }, [withSuppressed, ensurePlaying]);
  // Reconnects used to tear the whole player down and rebuild it from the
  // "welcome" message every time - on a flaky phone connection that meant
  // the VK iframe reloading (and re-running its pre-roll ad) over and over.
  // If the room still has the same video, just realign instead.
  const loadOrSync = useCallback((nextVideo, playbackState) => {
    const current = currentVideo.current;
    if (current && nextVideo && player.current && current.provider === nextVideo.provider && current.videoId === nextVideo.videoId && (current.url || '') === (nextVideo.url || '')) return applySync({ playback: playbackState });
    return load(nextVideo, playbackState);
  }, [applySync, load]);
  useEffect(() => {
    let stopped = false; let reconnectTimer; let attempt = 0;
    // Vite runs on 5173 in development while the realtime server runs on 3001.
    // In a production build both share the same origin and port.
    const socketHost = import.meta.env.DEV ? `${location.hostname}:3001` : location.host;
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${socketHost}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(account.token)}`); ws.current = socket;
      socket.onopen = () => { setConnected(true); attempt = 0; };
      // Mobile browsers routinely kill the socket (screen lock, backgrounding,
      // switching Wi-Fi/cellular) without any user action. Without a retry
      // here, that one device silently drops out of the room forever - it
      // looks like "sync stopped working" when really nothing was listening
      // any more. Reconnecting also gets a fresh "welcome" message, which
      // re-syncs video/playback/roster/chat from scratch.
      socket.onclose = event => {
        setConnected(false);
        if (stopped) return;
        // The server only ever rejects the connection outright (4001) when
        // the session token itself is bad - retrying with the same token
        // would just fail forever, so send the person back to login instead
        // of spinning silently.
        if (event.code === 4001) return onLogoutRef.current();
        const delay = Math.min(1000 * 2 ** attempt, 8000); attempt++;
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onmessage = async ({ data }) => { let msg; try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'welcome') { setYou(msg.you); setPeople(msg.participants); setMessages(msg.messages || []); if (msg.video) loadOrSync(msg.video, msg.playback); }
        if (msg.type === 'participants') setPeople(msg.participants);
        if (msg.type === 'chat') setMessages(current => [...current, msg.message].slice(-30));
        if (msg.type === 'loadVideo') loadOrSync(msg.video, msg.playback);
        if (msg.type === 'sync') { if (msg.video) loadOrSync(msg.video, msg.playback); }
        if (['play','pause','seek','ended'].includes(msg.type)) applySync({ playback: { state: msg.type === 'play' ? 'playing' : msg.type === 'pause' || msg.type === 'ended' ? 'paused' : playback.current.state, currentTime: msg.time, updatedAt: msg.timestamp } });
        if (msg.type === 'error') flashNoticeRef.current(msg.message);
        if (msg.type === 'stats') setStats({ totalSeconds: msg.totalSeconds, partners: msg.partners || [] });
      };
    };
    connect();
    // A backgrounded mobile tab can leave a dead socket without ever firing
    // "close" until much later - check as soon as the tab is foregrounded
    // again instead of waiting for that.
    const onVisible = () => { if (document.visibilityState === 'visible' && ws.current && ws.current.readyState !== WebSocket.OPEN && ws.current.readyState !== WebSocket.CONNECTING) { clearTimeout(reconnectTimer); attempt = 0; connect(); } };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => send({ type: 'syncRequest' }), 8000);
    const positionTimer = setInterval(async () => {
      if (!player.current || inAd.current || !exactSyncProviders.includes(currentVideo.current?.provider)) { lastPoll.current = null; return; }
      let time;
      // If the provider's control SDK failed to initialize (e.g. blocked by
      // an ad-blocker), getCurrentTime() rejects forever - without this
      // catch, presence for this person silently stops being sent every
      // single tick and their badge is stuck on "-" with no indication why.
      try { time = await player.current.getCurrentTime(); } catch { return; }
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
    return () => { stopped = true; clearTimeout(reconnectTimer); document.removeEventListener('visibilitychange', onVisible); clearInterval(timer); clearInterval(positionTimer); ws.current?.close(); dispose(); };
  }, [roomId, loadOrSync, dispose, send, account.token]);
  const joinRoom = e => {
    e?.preventDefault?.();
    const code = parseRoomCode(joinCode);
    if (!code) return flashNotice('Введите код комнаты (например, k3x9qa) или ссылку на неё');
    if (code === roomId) { setShowAdd(false); return; }
    saveLastRoom(code); location.href = `/room/${code}`;
  };
  const retryPlayer = () => { setDiag(null); if (currentVideo.current) load(currentVideo.current, playback.current); };
  // Manual diagnostics: a screenshot of this panel tells us exactly which
  // VK hosts are reachable from *that* phone/network, whether the SDK
  // loaded, and what browser it really is - instead of guessing remotely.
  const openDiag = async () => {
    setDiag({ loading: true });
    const probes = await probeVkHosts(true).catch(() => []);
    let state = null; try { state = await Promise.race([player.current?.getState(), new Promise(r => setTimeout(() => r('—'), 1500))]); } catch { state = 'ошибка'; }
    setDiag({ loading: false, probes, state: state ?? '—', sdk: !!window.VK?.VideoPlayer, ua: UA, inApp: IN_APP_BROWSER, ios: IS_IOS, online: navigator.onLine });
  };
  const dismissHint = () => { setHintDismissed(true); try { localStorage.setItem('wt_hint_dismissed', '1'); } catch { /* ignore */ } };
  const add = e => { e.preventDefault(); try { parseVideoUrl(url); send({ type: 'loadVideo', url }); setUrl(''); setShowAdd(false); } catch (error) { flashNotice(error.message); } };
  // Opening the panel used to always start from a blank field, so there was
  // no way to see what's currently playing without leaving the room - now it
  // shows the current video's link, ready to edit or replace.
  const toggleAddPanel = () => { if (!showAdd) setUrl(video?.originalUrl || ''); setShowAdd(v => !v); };
  const onUrlKeyDown = e => { if (e.key === 'Enter') add(e); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); flashNotice('Ссылка скопирована!'); }
    catch { flashNotice('Не удалось скопировать ссылку'); }
  };
  const syncEveryone = async () => {
    if (!player.current || !exactSyncProviders.includes(currentVideo.current?.provider)) return flashNotice('Точная синхронизация недоступна для этого видео');
    try { send({ type: 'forceSync', time: await player.current.getCurrentTime() }); flashNotice('Синхронизируем всех…', 2000); }
    catch { flashNotice('Не удалось прочитать время видео (возможно, заблокирован скрипт плеера)'); }
  };
  // Poll the stats tab periodically while it's open so the numbers visibly
  // move if you keep watching instead of only updating on the next visit.
  useEffect(() => {
    if (chatTab !== 'stats') return;
    send({ type: 'stats' });
    const id = setInterval(() => send({ type: 'stats' }), 20000);
    return () => clearInterval(id);
  }, [chatTab, send]);
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
        <button className="icon-btn" onClick={toggleAddPanel} title="Добавить видео / перейти в другую комнату" aria-label="Добавить видео или перейти в другую комнату"><IconPlus /></button>
        <button className="room-pill" onClick={copy} title="Нажмите, чтобы скопировать ссылку на эту комнату"><IconLink /><span>комната</span><b>{roomId}</b></button>
        <div className="account-pill" title={`Вы вошли как ${account.username}`}>
          <span className="account-avatar" style={{ background: avatarColor(account.accountId) }}>{account.username.slice(0, 1).toUpperCase()}</span>
          <span>{account.username}</span>
        </div>
        <button className="icon-btn" onClick={onLogout} title="Выйти из аккаунта" aria-label="Выйти из аккаунта"><IconLogout /></button>
      </div>
    </header>
    {IN_APP_BROWSER && !hintDismissed && <div className="hint-banner">
      <span>Похоже, сайт открыт внутри другого приложения (Telegram и т.п.). Плеер VK там часто не запускается. Нажмите «⋯» → «Открыть в браузере» (Safari/Chrome) — так всё будет работать.</span>
      <button onClick={dismissHint}>Понятно</button>
    </div>}
    {showAdd && <>
      <form className="add-video-bar" onSubmit={add}>
        <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={onUrlKeyDown} placeholder="Ссылка на видео или код <iframe> из «Экспортировать»" aria-label="Ссылка на видео" autoFocus />
        <button type="submit">Добавить</button>
      </form>
      <form className="join-row" onSubmit={joinRoom}>
        <span>Другая комната:</span>
        <input value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder="код или ссылка на комнату" aria-label="Код комнаты" />
        <button type="submit">Перейти</button>
      </form>
    </>}
    <div className="room">
      <div className="stage-wrap">
        <div className={`stage-shell ${video ? 'has-video' : ''}`}>
          {/* The player classes take over this node with imperative DOM
              calls (container.replaceChildren(...)) at unpredictable times
              relative to React's own render/commit cycle. React had no way
              to know its own children here had already been ripped out from
              under it, and would occasionally crash the whole app trying to
              remove a node that wasn't there any more (NotFoundError / "The
              object can not be found here" on Safari) - most often hit the
              first time a video loads into a room. `.stage` must stay
              permanently empty of React-rendered children; the empty-state
              CTA below is a sibling drawn in the exact same spot instead. */}
          <div className="stage" ref={stage} />
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
              const state = isYou ? 'me' : drift === null ? '' : drift > BADGE_DRIFT_THRESHOLD ? 'drift' : 'synced';
              return <div className={`badge ${state}`} key={person.id} title={isYou ? 'Вы' : person.name}>
                <span className="badge-avatar" style={{ background: avatarColor(person.id) }}>{person.name.slice(0, 1).toUpperCase()}</span>
                {timeKnown && <span className="badge-time">{formatTime(t)}</span>}
              </div>;
            })}
            {overflow > 0 && <div className="badge more">+{overflow}</div>}
          </div>}
          {video && !playerReady && !playerError && !diag && <div className="stage-overlay">
            <div className="spinner" />
            <p className="overlay-text"><b>{loadStatus || 'Загружаем плеер…'}</b></p>
            {Date.now() - loadStartedAt.current > 7000 && <p className="overlay-text">Долго? Не обновляйте страницу — сайт сам перебирает адреса VK. {IS_IOS ? 'На iPhone чаще всего мешает Safari: Настройки → Safari → выключите «Не отслеживать», или откройте сайт в Chrome.' : ''}</p>}
            {Date.now() - loadStartedAt.current > 7000 && <button className="overlay-btn small" onClick={openDiag}>Что не так?</button>}
          </div>}
          {video && diag && <div className="stage-overlay"><div className="diag">
            <h3>Диагностика</h3>
            {diag.loading ? <p>Проверяем адреса VK…</p> : <>
              <ul className="diag-list">
                {diag.probes.map(p => <li key={p.host}><code>{p.host}</code> — {p.ok ? `отвечает (${p.ms} мс)` : `НЕ отвечает (${p.error || 'ошибка'})`}</li>)}
                <li>Скрипт плеера VK: <code>{diag.sdk ? 'загружен' : 'не загружен'}</code></li>
                <li>Состояние плеера: <code>{String(diag.state)}</code></li>
                <li>Браузер: <code>{diag.inApp ? 'встроенный (Telegram/Instagram и т.п.)' : diag.ios ? 'iOS' : 'обычный'}</code>, интернет: <code>{diag.online ? 'есть' : 'нет'}</code></li>
                <li className="diag-ua">{diag.ua}</li>
              </ul>
              <p>{diag.probes.every(p => !p.ok) ? 'Ни один адрес VK не отвечает с этого интернета. Это блокировка сети/страны или блокировщик — включите/выключите VPN либо смените сеть (Wi-Fi ↔ мобильный).' : !diag.sdk ? 'Адреса VK отвечают, но скрипт плеера не загрузился — отключите блокировщик рекламы и «Не отслеживать» в Safari (Настройки → Safari), или откройте сайт в Chrome.' : diag.state === 'uninited' || diag.state === '—' ? 'VK отвечает и скрипт загружен, но сам плеер внутри не запускается — почти всегда это Safari-защита «Не отслеживать» (Настройки → Safari → выключить) или контент-блокировщик. Проще всего открыть сайт в Chrome.' : 'VK доступен и плеер инициализирован. Если видео не идёт — нажмите ▶ прямо на плеере, вы догоните комнату автоматически.'}</p>
            </>}
            <div className="diag-actions">
              <button className="primary" onClick={retryPlayer}>Перезапустить плеер</button>
              {video.originalUrl && <button onClick={() => window.open(video.originalUrl, '_blank', 'noopener')}>Открыть в VK</button>}
              <button onClick={() => setDiag(null)}>Закрыть</button>
            </div>
          </div></div>}
          {video && !playerError && overlay === 'tap' && <div className="stage-overlay">
            <button className="overlay-btn" onClick={tapToPlay}><IconPlay />Смотреть вместе</button>
            <p className="overlay-text">Браузер не даёт запустить видео без вашего касания. Одно нажатие — и вы на той же секунде, что и все.</p>
          </div>}
          {video && !playerError && overlay === 'manual' && <div className="stage-overlay soft">
            <div className="overlay-pill"><IconPlay />Нажмите ▶ прямо на видео — и вы сразу догоните комнату</div>
          </div>}
          {video && !playerError && overlay === 'unmute' && <div className="stage-overlay soft">
            <button className="overlay-btn small" onClick={tapToUnmute}><IconSound />Включить звук</button>
          </div>}
          {video && playerError && (() => { const d = describePlayerError(playerError, video); return <div className="stage-overlay"><div className="diag">
            <h3>{d.title}</h3>
            <p>{d.text}</p>
            {d.steps.length > 0 && <ol>{d.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
            <div className="diag-actions">
              <button className="primary" onClick={retryPlayer}>Попробовать снова</button>
              {video.originalUrl && <button onClick={() => window.open(video.originalUrl, '_blank', 'noopener')}>{d.open}</button>}
              <button onClick={() => setPlayerError(null)}>Скрыть</button>
            </div>
          </div></div>; })()}
        </div>
        <div className="stage-toolbar">
          <div className="toolbar-notice"><span className={`dot ${connected ? 'on' : ''}`} />{notice}</div>
          <div className="toolbar-actions">
            <span className="watch-count" title={people.map(p => p.id === you?.id ? 'Вы' : (p.name || 'Гость')).join(', ')}>{formatWatchers(people, you?.id)}</span>
            {video && <button className="help-btn" onClick={openDiag}>Не грузится?</button>}
            <button className="sync-btn" onClick={syncEveryone} disabled={people.length <= 1}><IconRefresh /><span>Синхронизировать</span></button>
          </div>
        </div>
      </div>
      <aside className="chat-pane">
        <div className="chat-header">
          <button className={`chat-tab ${chatTab === 'chat' ? 'active' : ''}`} onClick={() => setChatTab('chat')}>Чат <span>{messages.length}</span></button>
          <button className={`chat-tab ${chatTab === 'stats' ? 'active' : ''}`} onClick={() => setChatTab('stats')}><IconChart /> Статистика</button>
        </div>
        {chatTab === 'chat' ? <>
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
        </> : <div className="stats-panel">
          <div className="stats-total">
            <span className="stats-total-label">Всего вы посмотрели</span>
            <span className="stats-total-value">{stats ? formatDuration(stats.totalSeconds) : '…'}</span>
          </div>
          <div className="stats-partners">
            <div className="stats-partners-title">Вместе с</div>
            {!stats ? <p className="chat-empty">Загрузка…</p> : stats.partners.length ? stats.partners.map(p => <div className="stats-partner" key={p.id}>
              <span className="badge-avatar" style={{ background: avatarColor(p.id) }}>{(p.name || 'Г').slice(0, 1).toUpperCase()}</span>
              <span className="stats-partner-name">{p.name}</span>
              <span className="stats-partner-time">{formatDuration(p.seconds)}</span>
            </div>) : <p className="chat-empty">Пока не с кем сравнивать — смотрите видео вместе с кем-нибудь.</p>}
          </div>
        </div>}
      </aside>
    </div>
  </div>;
}

function App() {
  const [account, setAccount] = useState(getSavedAccount);
  const handleAuthenticated = account => { saveAccount(account); setAccount(account); };
  const handleLogout = useCallback(() => {
    const current = getSavedAccount();
    if (current?.token) fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: current.token }) }).catch(() => {});
    clearSavedAccount(); setAccount(null);
  }, []);
  if (!account) return <AuthScreen onAuthenticated={handleAuthenticated} />;
  return <Room key={account.accountId} account={account} onLogout={handleLogout} />;
}
createRoot(document.getElementById('root')).render(<AppErrorBoundary><App/></AppErrorBoundary>);
