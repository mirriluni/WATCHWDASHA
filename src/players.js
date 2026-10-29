// Every provider is wrapped in the same small interface so main.jsx never
// has to care which one is on screen:
//   events:  ready, playing, paused, ended, seeked, timeupdate, error,
//            adStarted, adCompleted, autoplayBlocked, retrying
//   methods: play, pause, seek, getCurrentTime, getDuration, getState
//            (playing|paused|ended|unstarted|null), mute, unmute, isMuted, destroy
export class BasePlayer {
  constructor() { this.events = new EventTarget(); }
  on(event, callback) { this.events.addEventListener(event, e => callback(e.detail)); }
  emit(event, detail) { this.events.dispatchEvent(new CustomEvent(event, { detail })); }
  async getState() { return null; }
  async mute() {} async unmute() {} async isMuted() { return false; }
  destroy() { this.root?.remove(); }
}

export class Html5Player extends BasePlayer {
  constructor(container, video, { startTime = 0 } = {}) {
    super();
    const el = document.createElement('video');
    el.controls = true; el.playsInline = true; el.className = 'media'; el.preload = 'auto'; el.src = video.url;
    this.root = el; container.replaceChildren(el);
    el.addEventListener('loadedmetadata', () => { if (startTime > 0) el.currentTime = startTime; this.emit('ready'); });
    el.addEventListener('play', () => this.emit('playing'));
    el.addEventListener('pause', () => { if (!el.ended) this.emit('paused'); });
    el.addEventListener('ended', () => this.emit('ended'));
    el.addEventListener('seeked', () => this.emit('seeked'));
    el.addEventListener('timeupdate', () => this.emit('timeupdate'));
    el.addEventListener('error', () => this.emit('error', { code: el.error?.code || 'media' }));
  }
  async play() { await this.root.play(); } async pause() { this.root.pause(); } async seek(t) { this.root.currentTime = t; }
  async getCurrentTime() { return this.root.currentTime || 0; } async getDuration() { return this.root.duration || 0; }
  async getState() { return this.root.ended ? 'ended' : this.root.paused ? 'paused' : 'playing'; }
  async mute() { this.root.muted = true; } async unmute() { this.root.muted = false; } async isMuted() { return this.root.muted; }
}

function frame(container, src, label) {
  const el = document.createElement('iframe');
  el.className = 'media'; el.src = src; el.title = label;
  el.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock'; el.allowFullscreen = true;
  container.replaceChildren(el); return el;
}

export class VimeoPlayer extends BasePlayer {
  constructor(container, v, { startTime = 0 } = {}) {
    super();
    this.root = frame(container, `https://player.vimeo.com/video/${v.videoId}?api=1&autoplay=0${startTime > 0 ? `#t=${Math.floor(startTime)}s` : ''}`, 'Vimeo video');
    this.ready = loadScript('https://player.vimeo.com/api/player.js').then(() => {
      this.player = new window.Vimeo.Player(this.root);
      this.player.on('loaded', () => this.emit('ready'));
      this.player.on('play', () => this.emit('playing')); this.player.on('pause', () => this.emit('paused'));
      this.player.on('ended', () => this.emit('ended')); this.player.on('seeked', () => this.emit('seeked'));
      this.player.on('timeupdate', () => this.emit('timeupdate')); this.player.on('error', e => this.emit('error', { code: e?.name || 'vimeo' }));
    }).catch(error => { this.emit('error', { code: 'sdk' }); throw error; });
  }
  async play(){ await this.ready; return this.player.play(); } async pause(){ await this.ready; return this.player.pause(); } async seek(t){ await this.ready; return this.player.setCurrentTime(t); }
  async getCurrentTime(){ await this.ready; return this.player.getCurrentTime(); } async getDuration(){ await this.ready; return this.player.getDuration(); }
  async getState(){ await this.ready; const [paused, ended] = await Promise.all([this.player.getPaused(), this.player.getEnded()]); return ended ? 'ended' : paused ? 'paused' : 'playing'; }
  async mute(){ await this.ready; return this.player.setMuted(true); } async unmute(){ await this.ready; return this.player.setMuted(false); } async isMuted(){ await this.ready; return this.player.getMuted(); }
}

export class YouTubePlayer extends BasePlayer {
  constructor(container, v, { startTime = 0 } = {}) {
    super();
    this.host = document.createElement('div'); container.replaceChildren(this.host);
    this.ready = youtubeApi().then(() => new Promise(resolve => {
      this.player = new window.YT.Player(this.host, {
        videoId: v.videoId, playerVars: { playsinline: 1, start: Math.max(0, Math.floor(startTime)), rel: 0 },
        events: {
          onReady: () => { this.emit('ready'); resolve(); },
          onStateChange: e => { const map = { 1: 'playing', 2: 'paused', 0: 'ended' }; if (map[e.data]) this.emit(map[e.data]); },
          onError: e => this.emit('error', { code: e?.data ?? 'youtube' }),
        },
      });
    })).catch(error => { this.emit('error', { code: 'sdk' }); throw error; });
  }
  async play(){ await this.ready; this.player.playVideo(); } async pause(){ await this.ready; this.player.pauseVideo(); } async seek(t){ await this.ready; this.player.seekTo(t, true); }
  async getCurrentTime(){ await this.ready; return this.player.getCurrentTime(); } async getDuration(){ await this.ready; return this.player.getDuration(); }
  async getState(){ await this.ready; const s = this.player.getPlayerState(); return s === 1 || s === 3 ? 'playing' : s === 0 ? 'ended' : s === 2 ? 'paused' : 'unstarted'; }
  async mute(){ await this.ready; this.player.mute(); } async unmute(){ await this.ready; this.player.unMute(); } async isMuted(){ await this.ready; return this.player.isMuted(); }
  destroy(){ try { this.player?.destroy(); } catch { /* already gone */ } this.host?.remove(); }
}

export class TwitchPlayer extends BasePlayer {
  constructor(container, v) { super(); this.root = frame(container, `https://player.twitch.tv/?${v.twitchKind}=${encodeURIComponent(v.videoId)}&parent=${encodeURIComponent(location.hostname)}&autoplay=false`, 'Twitch video'); setTimeout(() => this.emit('ready'), 500); }
  async play(){} async pause(){} async seek(){} async getCurrentTime(){ return 0; } async getDuration(){ return 0; }
}

// VK serves the exact same embed + SDK from several hosts. Which ones are
// reachable depends entirely on the viewer's country, ISP and VPN - one host
// being blocked while another works is normal, so we try them in turn
// instead of hard-coding one and failing for everyone it doesn't resolve for.
export const VK_HOSTS = ['vkvideo.ru', 'vk.com', 'vk.ru'];
const VK_INIT_TIMEOUT_MS = 9000;

// Opaque no-cors GET of the SDK script: resolves if the host answers at all
// (any status), rejects on DNS failure, connection block, or a content
// blocker. That's enough to tell "VK unreachable from this network" apart
// from "VK reachable but this video is broken" in ~2s instead of waiting for
// three 9s init timeouts in a row.
export async function probeHost(host, timeoutMs = 3500) {
  const started = Date.now(); const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { await fetch(`https://${host}/js/api/videoplayer.js`, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal }); return { host, ok: true, ms: Date.now() - started }; }
  catch (error) { return { host, ok: false, ms: Date.now() - started, error: error?.name || 'error' }; }
  finally { clearTimeout(timer); }
}
let probeCache = null;
export async function probeVkHosts(force = false) {
  if (!force && probeCache && Date.now() - probeCache.at < 60000) return probeCache.results;
  const results = await Promise.all(VK_HOSTS.map(h => probeHost(h)));
  probeCache = { at: Date.now(), results };
  return results;
}
const vkTime = seconds => { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`; };

export class VkPlayer extends BasePlayer {
  constructor(container, v, { startTime = 0 } = {}) {
    super();
    this.container = container; this.video = v; this.startTime = startTime;
    this.hostIndex = 0; this.destroyed = false; this.inited = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.emit('status', { text: 'Проверяем, какой адрес VK доступен…' });
    probeVkHosts().then(results => {
      if (this.destroyed) return;
      const firstOk = VK_HOSTS.findIndex(h => results.find(r => r.host === h)?.ok);
      if (firstOk === -1) { this.emit('error', { code: 'unreachable', reason: 'probe', probes: results }); this.rejectReady(new Error('VK unreachable')); return; }
      this.hostIndex = firstOk;
      this.emit('status', { text: `Загружаем плеер VK (${this.host})…` });
      this.attach();
    });
  }
  get host() { return VK_HOSTS[this.hostIndex]; }
  embedSrc() {
    const [ownerId, id] = this.video.videoId.split('_');
    const params = new URLSearchParams({ oid: ownerId, id, hd: '2', js_api: '1' });
    if (this.video.hash) params.set('hash', this.video.hash);
    if (this.startTime > 1) params.set('t', vkTime(this.startTime));
    return `https://${this.host}/video_ext.php?${params}`;
  }
  attach() {
    if (this.destroyed) return;
    clearTimeout(this.initTimer);
    try { this.player?.destroy(); } catch { /* ignore */ }
    this.player = null; this.inited = false;
    this.root = frame(this.container, this.embedSrc(), 'VK Video');
    // The SDK is host-agnostic (it validates any vk/vkvideo .com/.ru embed),
    // so once it's loaded from any host we keep using it.
    vkApi(this.host).then(() => {
      if (this.destroyed || !this.root) return;
      this.player = window.VK.VideoPlayer(this.root);
      const p = this.player;
      const E = window.VK.VideoPlayer.Events || {};
      p.on('inited', state => { this.inited = true; clearTimeout(this.initTimer); this.applyState(state); this.emit('ready'); this.resolveReady(); });
      p.on('started', s => { this.applyState(s); this.emit('playing'); });
      p.on('resumed', s => { this.applyState(s); this.emit('playing'); });
      p.on('paused', s => { this.applyState(s); this.emit('paused'); });
      p.on('ended', s => { this.applyState(s); this.emit('ended'); });
      p.on('timeupdate', s => this.applyState(s));
      p.on(E.SEEKED || 'seeked', s => { this.applyState(s); this.emit('seeked'); });
      p.on(E.ADSTARTED || 'adStarted', () => { this.inAd = true; this.emit('adStarted'); });
      p.on(E.ADCOMPLETED || 'adCompleted', () => { this.inAd = false; this.emit('adCompleted'); });
      p.on(E.AUTOPLAY_SOUND_PROHIBITED || 'autoplaySoundProhibited', () => this.emit('autoplayBlocked'));
      p.on('error', s => { this.applyState(s); this.emit('error', { code: p.getErrorCode?.() ?? s?.errorCode ?? 'vk', host: this.host }); });
    }).catch(() => this.nextHost('sdk'));
    this.initTimer = setTimeout(() => { if (!this.inited) this.nextHost('timeout'); }, VK_INIT_TIMEOUT_MS);
  }
  applyState(state) { if (Number.isFinite(state?.time)) this.currentTime = state.time; if (Number.isFinite(state?.duration)) this.duration = state.duration; if (state?.state) this.state = state.state; }
  nextHost(reason) {
    if (this.destroyed || this.inited) return;
    if (this.hostIndex < VK_HOSTS.length - 1) { this.hostIndex++; this.emit('retrying', { host: this.host, reason }); this.emit('status', { text: `VK не ответил, пробуем ${this.host}…` }); this.attach(); return; }
    this.emit('error', { code: 'unreachable', reason, probes: probeCache?.results });
    this.rejectReady(new Error('VK video unreachable'));
  }
  async play(){ await this.ready; this.player.play(); } async pause(){ await this.ready; this.player.pause(); } async seek(t){ await this.ready; this.player.seek(t); }
  async getCurrentTime(){ await this.ready; return this.player.getCurrentTime?.() ?? this.currentTime ?? 0; } async getDuration(){ await this.ready; return this.player.getDuration?.() ?? this.duration ?? 0; }
  async getState(){ await this.ready; return this.player.getState?.() ?? this.state ?? null; }
  async mute(){ await this.ready; this.player.mute(); } async unmute(){ await this.ready; this.player.unmute(); } async isMuted(){ await this.ready; return !!this.player.isMuted?.(); }
  destroy(){ this.destroyed = true; clearTimeout(this.initTimer); try { this.player?.destroy(); } catch { /* ignore */ } super.destroy(); }
}

const loadScript = src => new Promise((ok, bad) => {
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) { if (existing.dataset.loaded) return ok(); existing.addEventListener('load', ok); existing.addEventListener('error', bad); return; }
  const s = document.createElement('script'); s.src = src; s.async = true;
  s.onload = () => { s.dataset.loaded = '1'; ok(); }; s.onerror = () => { s.remove(); bad(new Error(`Failed to load ${src}`)); };
  document.head.append(s);
});
let yt; function youtubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (yt) return yt;
  yt = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('YouTube API unavailable')), 10000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); };
    loadScript('https://www.youtube.com/iframe_api').catch(error => { clearTimeout(timer); reject(error); });
  });
  yt.catch(() => { yt = null; });
  return yt;
}
function vkApi(host) {
  if (window.VK?.VideoPlayer) return Promise.resolve();
  return loadScript(`https://${host}/js/api/videoplayer.js`).then(() => new Promise((resolve, reject) => {
    const started = Date.now();
    const check = setInterval(() => {
      if (window.VK?.VideoPlayer) { clearInterval(check); resolve(); }
      else if (Date.now() - started > 8000) { clearInterval(check); reject(new Error('VK Video API unavailable')); }
    }, 50);
  }));
}
export const playerFor = { youtube: YouTubePlayer, vimeo: VimeoPlayer, direct: Html5Player, twitch: TwitchPlayer, vk: VkPlayer };
