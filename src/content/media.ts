/** Protect media itself, common player libraries and custom players recognised by their markup. */
const PLAYER_MARK = 'data-ww-player-controls';
export const MEDIA_BOUNDARY = [
  'video', 'audio', 'video-js', 'media-controller', 'mux-player', 'wistia-player',
  '.html5-video-player', '.video-js', '.vjs-control-bar', '.plyr', '.jwplayer', '.shaka-video-container',
  '.mejs__container', '.bitmovinplayer-container', '.dplayer', '.xgplayer',
  'iframe[allow*="autoplay"]', 'iframe[title*="video player" i]', `[${PLAYER_MARK}]`,
].join(',');
const MEDIA = 'video,audio';
const BUTTON = 'button,[role="button"]';
const TRACK = 'input[type="range"],[role="slider"]';
const SIGNAL = `${BUTTON},${TRACK}`;
const PLAYER_NAME = /(?:^|[-_\s])(?:(?:audio|video|media)[-_ ]?)?player(?:$|[-_\s])/i;

/** Find an anonymous player only around a media element and its nearby playback controls. */
export function recogniseMediaPlayers(added?: readonly Element[]): void {
  const media = new Set<Element>();
  if (!added) {
    for (const el of document.querySelectorAll(MEDIA)) media.add(el);
  } else {
    for (const root of added) {
      if (!root.isConnected) continue;
      if (root.matches(MEDIA)) media.add(root);
      for (const el of root.querySelectorAll(MEDIA)) media.add(el);
      if (!root.matches(SIGNAL) && !root.querySelector(TRACK)) continue;
      for (let n = root.parentElement, depth = 0; n && n !== document.body && depth < 3; n = n.parentElement, depth++) {
        const el = n.querySelector(MEDIA);
        if (el) {
          media.add(el);
          break;
        }
      }
    }
  }
  let checked = 0;
  for (const el of media) {
    if (++checked > 32) break;
    if (el.parentElement?.closest(MEDIA_BOUNDARY)) continue;
    for (let root = el.parentElement, depth = 0; root && depth < 4; root = root.parentElement, depth++) {
      if (root.matches('body,html,main,article,section[role="main"]')) break;
      if (root.querySelectorAll(MEDIA).length !== 1) break;
      const named = PLAYER_NAME.test(`${root.id} ${root.getAttribute('class') ?? ''}`);
      if ((named && root.querySelector(BUTTON)) || (root.querySelector(TRACK) && root.querySelectorAll(BUTTON).length >= 2)) {
        root.setAttribute(PLAYER_MARK, '');
        break;
      }
    }
  }
}

export function mediaExclusion(boundary: string): string {
  return boundary ? `:where(:not(:is(${boundary}),:is(${boundary}) *))` : '';
}

let repairBoundary = '';

/** The visible design decides where the browser's automatic colour repairs can run. */
export function setMediaRepairBoundary(boundary: string): void {
  repairBoundary = boundary;
}

export const mediaRepairExclusion = (): string => mediaExclusion(repairBoundary);
export const isProtectedMedia = (el: Element): boolean => !!repairBoundary && !!el.closest(repairBoundary);
