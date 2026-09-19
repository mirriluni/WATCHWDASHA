const eventTarget = () => new EventTarget();
export class BasePlayer {
  constructor() { this.events = eventTarget(); }
  on(event, callback) { this.events.addEventListener(event, callback); }
  emit(event) { this.events.dispatchEvent(new Event(event)); }
  destroy() { this.root?.remove(); }
}
export class Html5Player extends BasePlayer {
  constructor(container, video) { super(); this.root = document.createElement('video'); this.root.controls = true; this.root.playsInline = true; this.root.className = 'media'; this.root.src = video.url; container.replaceChildren(this.root); ['play','pause','ended','timeupdate','error','loadeddata'].forEach(e => this.root.addEventListener(e, () => this.emit(e === 'loadeddata' ? 'ready' : e === 'play' ? 'playing' : e === 'pause' ? 'paused' : e))); }
  async play() { await this.root.play(); } async pause() { this.root.pause(); } async seek(time) { this.root.currentTime = time; } async getCurrentTime() { return this.root.currentTime || 0; } async getDuration() { return this.root.duration || 0; }
}
function frame(container, src, label) { const el = document.createElement('iframe'); el.className = 'media'; el.src = src; el.title = label; el.allow = 'autoplay; fullscreen; picture-in-picture'; el.allowFullscreen = true; container.replaceChildren(el); return el; }
export class VimeoPlayer extends BasePlayer {
  constructor(container, v) { super(); this.root = frame(container, `https://player.vimeo.com/video/${v.videoId}?api=1&autoplay=0`, 'Vimeo video'); this.ready = loadScript('https://player.vimeo.com/api/player.js').then(() => { this.player = new window.Vimeo.Player(this.root); ['play','pause','ended','timeupdate','loaded'].forEach(e => this.player.on(e, () => this.emit(e === 'play' ? 'playing' : e === 'pause' ? 'paused' : e === 'loaded' ? 'ready' : e))); }); }
  async play(){ await this.ready; return this.player.play(); } async pause(){ await this.ready; return this.player.pause(); } async seek(t){ await this.ready; return this.player.setCurrentTime(t); } async getCurrentTime(){ await this.ready; return this.player.getCurrentTime(); } async getDuration(){ await this.ready; return this.player.getDuration(); }
}
export class YouTubePlayer extends BasePlayer {
  constructor(container, v) { super(); this.host = document.createElement('div'); container.replaceChildren(this.host); this.ready = youtubeApi().then(() => new Promise(resolve => { this.player = new window.YT.Player(this.host, { videoId: v.videoId, playerVars: { playsinline: 1 }, events: { onReady: () => { this.emit('ready'); resolve(); }, onStateChange: e => { const map = { 1:'playing', 2:'paused', 0:'ended' }; if (map[e.data]) this.emit(map[e.data]); }, onError: () => this.emit('error') } }); })); }
  async play(){ await this.ready; this.player.playVideo(); } async pause(){ await this.ready; this.player.pauseVideo(); } async seek(t){ await this.ready; this.player.seekTo(t, true); } async getCurrentTime(){ await this.ready; return this.player.getCurrentTime(); } async getDuration(){ await this.ready; return this.player.getDuration(); } destroy(){ this.player?.destroy(); }
}
export class TwitchPlayer extends BasePlayer { constructor(container, v) { super(); this.root = frame(container, `https://player.twitch.tv/?${v.twitchKind}=${encodeURIComponent(v.videoId)}&parent=${encodeURIComponent(location.hostname)}&autoplay=false`, 'Twitch video'); setTimeout(() => this.emit('ready'), 500); } async play(){} async pause(){} async seek(){} async getCurrentTime(){ return 0; } async getDuration(){ return 0; } }
export class VkPlayer extends BasePlayer {
  constructor(container, v) {
    super();
    const [ownerId, id] = v.videoId.split('_');
    // video_ext.php is VK's embeddable player endpoint; a normal video page
    // is deliberately protected from framing and would only show a blank area.
    this.root = frame(container, `https://vkvideo.ru/video_ext.php?oid=${encodeURIComponent(ownerId)}&id=${encodeURIComponent(id)}&hd=2&autoplay=0`, 'VK Video');
    this.root.addEventListener('load', () => this.emit('ready'), { once: true });
    this.root.addEventListener('error', () => this.emit('error'), { once: true });
  }
  async play(){} async pause(){} async seek(){} async getCurrentTime(){ return 0; } async getDuration(){ return 0; }
}
const loadScript = src => new Promise((ok, bad) => { if (document.querySelector(`script[src="${src}"]`)) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.append(s); });
let yt; function youtubeApi() { if (window.YT?.Player) return Promise.resolve(); if (yt) return yt; yt = new Promise(resolve => { window.onYouTubeIframeAPIReady = resolve; loadScript('https://www.youtube.com/iframe_api'); }); return yt; }
export const playerFor = { youtube: YouTubePlayer, vimeo: VimeoPlayer, direct: Html5Player, twitch: TwitchPlayer, vk: VkPlayer };
