import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseVideoUrl } from '../shared/video-url.js';
import { playerFor } from './players.js';
import './style.css';

const makeRoom = () => Math.random().toString(36).slice(2, 8);
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
  const [connected, setConnected] = useState(false); const ws = useRef(); const player = useRef(); const stage = useRef(); const suppress = useRef(false); const playback = useRef({ state: 'paused', currentTime: 0 }); const currentVideo = useRef(null);
  useEffect(() => { if (!initial) history.replaceState({}, '', `/room/${roomId}`); }, [initial, roomId]);
  const send = useCallback(message => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(message)); }, []);
  const dispose = useCallback(() => { player.current?.destroy(); player.current = null; }, []);
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
          suppress.current = true; await instance.seek(Math.max(0, sync.currentTime + elapsed)); if (sync.state === 'playing') await instance.play(); suppress.current = false;
        }
      });
      instance.on('error', () => setNotice('Unable to load video'));
      instance.on('playing', async () => { if (!suppress.current) send({ type: 'play', time: await instance.getCurrentTime() }); });
      instance.on('paused', async () => { if (!suppress.current) send({ type: 'pause', time: await instance.getCurrentTime() }); });
      instance.on('ended', async () => { if (!suppress.current) send({ type: 'ended', time: await instance.getCurrentTime() }); });
    } catch (error) { console.error('Player creation error:', error); setNotice('Unable to load video'); }
  }, [dispose, send]);
  const applySync = useCallback(async (data) => {
    if (!player.current) return; playback.current = data.playback; const p = player.current; const elapsed = data.playback?.state === 'playing' ? (Date.now() - data.playback.updatedAt) / 1000 : 0; const target = data.playback?.currentTime + elapsed;
    suppress.current = true; await p.seek(Math.max(0, target)); if (data.playback?.state === 'playing') await p.play(); else await p.pause(); suppress.current = false;
  }, []);
  useEffect(() => {
    // Vite runs on 5173 in development while the realtime server runs on 3001.
    // In a production build both share the same origin and port.
    const socketHost = import.meta.env.DEV ? `${location.hostname}:3001` : location.host;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${socketHost}/ws?room=${encodeURIComponent(roomId)}`); ws.current = socket;
    socket.onopen = () => setConnected(true); socket.onclose = () => setConnected(false);
    socket.onmessage = async ({ data }) => { let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'welcome') { setPeople(msg.participants); if (msg.video) load(msg.video, msg.playback); }
      if (msg.type === 'participants') setPeople(msg.participants);
      if (msg.type === 'loadVideo') load(msg.video, msg.playback);
      if (msg.type === 'sync') { if (!currentVideo.current && msg.video) load(msg.video, msg.playback); else applySync(msg); }
      if (['play','pause','seek','ended'].includes(msg.type)) applySync({ playback: { state: msg.type === 'play' ? 'playing' : msg.type === 'pause' || msg.type === 'ended' ? 'paused' : playback.current.state, currentTime: msg.time, updatedAt: msg.timestamp } });
      if (msg.type === 'error') setNotice(msg.message);
    };
    const timer = setInterval(() => send({ type: 'syncRequest' }), 8000);
    return () => { clearInterval(timer); socket.close(); dispose(); };
  }, [roomId, load, applySync, dispose, send]);
  const add = e => { e.preventDefault(); try { parseVideoUrl(url); send({ type: 'loadVideo', url }); setUrl(''); } catch (error) { setNotice(error.message); } };
  const copy = async () => { await navigator.clipboard.writeText(location.href); setNotice('Link copied!'); };
  return <main><header><a className="brand" href="/">watch<span>together</span></a><div className="room-state"><i className={connected ? 'on' : ''}/>{connected ? 'Live room' : 'Reconnecting…'}</div><button className="copy" onClick={copy}>Copy room link</button></header>
    <section className="shell"><div className="stage" ref={stage}>{!video && <div className="empty"><div className="play-icon">▶</div><h1>Bring everyone to the same moment.</h1><p>Paste a video link below and start watching together.</p></div>}</div><div className="status">{notice}</div>
      <div className="people"><div className="avatars">{people.slice(0, 4).map((p, i) => <span key={p.id} style={{ '--n': i }}>{p.name.slice(0, 1).toUpperCase()}</span>)}</div><span>{people.length || 1} watching now</span><div className="names">{people.map(p => p.name).join(' · ')}</div></div>
      <form onSubmit={add}><input value={url} onChange={e => setUrl(e.target.value)} placeholder="Paste video URL…" aria-label="Video URL"/><button type="submit">Add video <b>→</b></button></form>
    </section><p className="hint">One room, one video, perfectly in sync.</p></main>;
}
createRoot(document.getElementById('root')).render(<AppErrorBoundary><App/></AppErrorBoundary>);
