const eventTarget = () => new EventTarget();
export class BasePlayer {
  constructor() { this.events = eventTarget(); }
  on(event, callback) { this.events.addEventListener(event, callback); }
  emit(event) { this.events.dispatchEvent(new Event(event)); }
  destroy() { this.root?.remove(); }
}
export class Html5Player extends BasePlayer {
  constructor(container, video) { super(); this.root = document.createElement('video'); this.root.controls = true; this.root.playsInline = true; this.root.className = 'media'; this.root.src = video.url; container.replaceChildren(this.root); ['play','pause','ended','timeupdate','seeked','error','loadeddata'].forEach(e => this.root.addEventListener(e, () => this.emit(e === 'loadeddata' ? 'ready' : e === 'play' ? 'playing' : e === 'pause' ? 'paused' : e))); }
  async play() { await this.root.play(); } async pause() { this.root.pause(); } async seek(time) { this.root.currentTime = time; } async getCurrentTime() { return this.root.currentTime || 0; } async getDuration() { return this.root.duration || 0; }
}
function frame(container, src, label) { const el = document.createElement('iframe'); el.className = 'media'; el.src = src; el.title = label; el.allow = 'autoplay; fullscreen; picture-in-picture'; el.allowFullscreen = true; container.replaceChildren(el); return el; }
export class VimeoPlayer extends BasePlayer {
  constructor(container, v) {
    super();
    this.root = frame(container, `https://player.vimeo.com/video/${v.videoId}?api=1&autoplay=0`, 'Vimeo video');
    this.ready = loadScript('https://player.vimeo.com/api/player.js').then(() => { this.player = new window.Vimeo.Player(this.root); ['play','pause','ended','timeupdate','loaded'].forEach(e => this.player.on(e, () => this.emit(e === 'play' ? 'playing' : e === 'pause' ? 'paused' : e === 'loaded' ? 'ready' : e))); })
      // A blocked/failed script load used to leave this.ready silently
      // rejected forever: playback and the room's sync badge for this
      // person would just stop working with no visible explanation.
      .catch(error => { this.emit('error'); throw error; });
  }
  async play(){ await this.ready; return this.player.play(); } async pause(){ await this.ready; return this.player.pause(); } async seek(t){ await this.ready; return this.player.setCurrentTime(t); } async getCurrentTime(){ await this.ready; return this.player.getCurrentTime(); } async getDuration(){ await this.ready; return this.player.getDuration(); }
}
export class YouTubePlayer extends BasePlayer {
  constructor(container, v) {
    super();
    this.host = document.createElement('div'); container.replaceChildren(this.host);
    this.ready = youtubeApi().then(() => new Promise(resolve => { this.player = new window.YT.Player(this.host, { videoId: v.videoId, playerVars: { playsinline: 1 }, events: { onReady: () => { this.emit('ready'); resolve(); }, onStateChange: e => { const map = { 1:'playing', 2:'paused', 0:'ended' }; if (map[e.data]) this.emit(map[e.data]); }, onError: () => this.emit('error') } }); }))
      .catch(error => { this.emit('error'); throw error; });
  }
  async play(){ await this.ready; this.player.playVideo(); } async pause(){ await this.ready; this.player.pauseVideo(); } async seek(t){ await this.ready; this.player.seekTo(t, true); } async getCurrentTime(){ await this.ready; return this.player.getCurrentTime(); } async getDuration(){ await this.ready; return this.player.getDuration(); } destroy(){ this.player?.destroy(); }
}
export class TwitchPlayer extends BasePlayer { constructor(container, v) { super(); this.root = frame(container, `https://player.twitch.tv/?${v.twitchKind}=${encodeURIComponent(v.videoId)}&parent=${encodeURIComponent(location.hostname)}&autoplay=false`, 'Twitch video'); setTimeout(() => this.emit('ready'), 500); } async play(){} async pause(){} async seek(){} async getCurrentTime(){ return 0; } async getDuration(){ return 0; } }
export class VkPlayer extends BasePlayer {
  constructor(container, v) {
    super();
    const [ownerId, id] = v.videoId.split('_');
    // js_api=1 enables VK's supported VideoPlayer SDK for this iframe.
    this.root = frame(container, `https://vkvideo.ru/video_ext.php?oid=${encodeURIComponent(ownerId)}&id=${encodeURIComponent(id)}&hd=2&autoplay=0&js_api=1`, 'VK Video');
    this.root.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock';
    this.ready = Promise.all([vkApi(), new Promise((resolve, reject) => { this.root.addEventListener('load', resolve, { once: true }); this.root.addEventListener('error', reject, { once: true }); })]).then(() => new Promise(resolve => {
      this.player = window.VK.VideoPlayer(this.root);
      const relay = event => state => { if (Number.isFinite(state?.time)) this.currentTime = state.time; this.emit(event); };
      this.player.on('inited', state => { if (Number.isFinite(state?.time)) this.currentTime = state.time; this.emit('ready'); resolve(); });
      this.player.on('started', relay('playing')); this.player.on('resumed', relay('playing')); this.player.on('paused', relay('paused'));
      this.player.on('ended', relay('ended')); this.player.on('timeupdate', relay('timeupdate')); this.player.on('error', relay('error'));
    }))
      // VK's control API is a separate script from the video iframe itself,
      // and it's a common target for ad/tracker blockers - the video can
      // keep playing natively in the iframe even when this fails, which
      // used to make the failure invisible: no error, just a room where
      // this person's time never updates and can't be remote-controlled.
      .catch(error => { this.emit('error'); throw error; });
  }
  async play(){ await this.ready; this.player.play(); } async pause(){ await this.ready; this.player.pause(); } async seek(t){ await this.ready; this.player.seek(t); } async getCurrentTime(){ await this.ready; return this.player.getCurrentTime?.() ?? this.currentTime ?? 0; } async getDuration(){ await this.ready; return this.player.getDuration?.() ?? 0; } destroy(){ this.player?.destroy?.(); super.destroy(); }
}
const loadScript = src => new Promise((ok, bad) => { if (document.querySelector(`script[src="${src}"]`)) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.append(s); });
let yt; function youtubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (yt) return yt;
  yt = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('YouTube API unavailable')), 10000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); };
    loadScript('https://www.youtube.com/iframe_api').catch(error => { clearTimeout(timer); reject(error); });
  });
  return yt;
}
let vk; function vkApi() { if (window.VK?.VideoPlayer) return Promise.resolve(); if (vk) return vk; vk = loadScript('https://vk.com/js/api/videoplayer.js').then(() => new Promise((resolve, reject) => { const started = Date.now(); const check = setInterval(() => { if (window.VK?.VideoPlayer) { clearInterval(check); resolve(); } else if (Date.now() - started > 10000) { clearInterval(check); reject(new Error('VK Video API unavailable')); } }, 50); })); return vk; }
export const playerFor = { youtube: YouTubePlayer, vimeo: VimeoPlayer, direct: Html5Player, twitch: TwitchPlayer, vk: VkPlayer };
