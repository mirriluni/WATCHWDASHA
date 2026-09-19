const DIRECT_EXTENSIONS = /\.(mp4|webm|og[gv]|m4v|mov)(?:$|\?)/i;

export class VideoUrlError extends Error {
  constructor(message) { super(message); this.name = 'VideoUrlError'; }
}

/** Parse supported video URLs into a safe, serializable description. */
export function parseVideoUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new VideoUrlError('Invalid video URL');
  let url;
  try { url = new URL(input.trim()); } catch { throw new VideoUrlError('Invalid video URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new VideoUrlError('Invalid video URL');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const originalUrl = url.toString();
  let videoId;
  if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0];
  if (host.endsWith('youtube.com')) {
    videoId = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1];
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
  // VK now exposes public video pages on both vk.com and vkvideo.ru.
  if (host === 'vk.com' || host.endsWith('.vk.com') || host === 'vkvideo.ru' || host.endsWith('.vkvideo.ru')) {
    const vkId = url.pathname.match(/video(-?\d+_\d+)/)?.[1] || url.searchParams.get('z')?.match(/video(-?\d+_\d+)/)?.[1];
    if (vkId) return { provider: 'vk', videoId: vkId, originalUrl, type: 'embed' };
  }
  if (DIRECT_EXTENSIONS.test(url.pathname) || DIRECT_EXTENSIONS.test(originalUrl)) return { provider: 'direct', url: originalUrl, originalUrl, type: 'html5' };
  throw new VideoUrlError('Unsupported video link');
}
