const DIRECT_EXTENSIONS = /\.(mp4|webm|og[gv]|m4v|mov)(?:$|\?)/i;
const VK_HOST = /(^|\.)vk(video)?\.(com|ru)$/;

export class VideoUrlError extends Error {
  constructor(message) { super(message); this.name = 'VideoUrlError'; }
}

/** Parse supported video URLs (or a pasted <iframe> embed code) into a safe, serializable description. */
export function parseVideoUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new VideoUrlError('Вставьте ссылку на видео');
  let text = input.trim();
  // People paste the whole "Экспортировать" iframe snippet from VK/YouTube -
  // pull the src out of it instead of rejecting the whole thing.
  const iframeSrc = text.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i)?.[1];
  if (iframeSrc) text = iframeSrc.replace(/&amp;/g, '&');
  let url;
  try { url = new URL(text.startsWith('//') ? `https:${text}` : text); } catch { throw new VideoUrlError('Это не похоже на ссылку'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new VideoUrlError('Ссылка должна начинаться с http(s)://');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const originalUrl = url.toString();
  let videoId;
  if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0];
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    videoId = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)?.[1];
  }
  if (videoId && /^[\w-]{6,}$/.test(videoId)) return { provider: 'youtube', videoId, originalUrl, type: 'embed' };
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    videoId = url.pathname.match(/\/(?:video\/)?(\d+)/)?.[1];
    if (videoId) return { provider: 'vimeo', videoId, originalUrl, type: 'embed' };
  }
  if (host.endsWith('twitch.tv')) {
    const vod = url.pathname.match(/\/videos\/(\d+)/)?.[1];
    const channel = url.pathname.split('/').filter(Boolean)[0];
    if (vod || (channel && !['directory', 'videos', 'downloads'].includes(channel))) return { provider: 'twitch', videoId: vod || channel, originalUrl, type: 'embed', twitchKind: vod ? 'video' : 'channel' };
  }
  if (VK_HOST.test(host)) {
    // Accepted forms:
    //   https://vkvideo.ru/video-123_456            (watch page, also vk.com / vk.ru / m.vk.com)
    //   https://vk.com/clip-123_456                 (clips are embeddable the same way)
    //   https://vk.com/feed?z=video-123_456%2F...   (feed/wall overlay links)
    //   https://vk.ru/video_ext.php?oid=-123&id=456&hash=abc   (export/embed code - carries the access hash)
    const pathId = url.pathname.match(/(?:video|clip)(-?\d+_\d+)/)?.[1] || url.searchParams.get('z')?.match(/(?:video|clip)(-?\d+_\d+)/)?.[1];
    const oid = url.searchParams.get('oid'); const id = url.searchParams.get('id');
    const vkId = pathId || (oid && id && /^-?\d+$/.test(oid) && /^\d+$/.test(id) ? `${oid}_${id}` : null);
    if (vkId) {
      const hash = url.searchParams.get('hash');
      const video = { provider: 'vk', videoId: vkId, originalUrl, type: 'embed' };
      // The export hash is what unlocks private / link-only videos for the
      // embed player; without it VK just shows "видео недоступно".
      if (hash && /^[a-zA-Z0-9_-]{4,64}$/.test(hash)) video.hash = hash;
      return video;
    }
  }
  if (DIRECT_EXTENSIONS.test(url.pathname) || DIRECT_EXTENSIONS.test(originalUrl)) return { provider: 'direct', url: originalUrl, originalUrl, type: 'html5' };
  throw new VideoUrlError('Такая ссылка не поддерживается. Подходят VK Видео, YouTube, Vimeo, Twitch и прямые ссылки на .mp4');
}
