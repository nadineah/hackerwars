import { luminance, toHex, type Rgba } from './contrast';

/**
 * Is a page light or dark where people read it? A new design keeps that direction unless the request clearly asks
 * for the opposite, because flipping it is what breaks readability (the site's text, icons and inputs are tuned for
 * its own background). Decided from what is behind the text in the main content; text over pictures does not count,
 * and when too little text is left (a video grid) or the vote is split, the page background decides.
 */

export type Tone = 'light' | 'dark';
/** What is behind one piece of text: a colour, or a picture/gradient (not judged). */
export type Backdrop = Rgba | 'picture';

const LIGHT = 0.4; // about #aaaaaa and lighter
const DARK = 0.15; // about #6b6b6b and darker
const MIN_SAMPLES = 8;
const MAJORITY = 0.65;

const toneOf = (c: Rgba): Tone | null => {
  const L = luminance(c);
  return L >= LIGHT ? 'light' : L <= DARK ? 'dark' : null;
};

export function decideTone(samples: Backdrop[], pageBackground: Rgba): { tone: Tone; basis: string } {
  const votes = { light: 0, dark: 0 };
  const colours: Rgba[] = [];
  for (const s of samples) {
    if (s === 'picture') continue;
    const t = toneOf(s);
    if (!t) continue;
    votes[t]++;
    colours.push(s);
  }
  const total = votes.light + votes.dark;
  if (total >= MIN_SAMPLES) {
    const winner: Tone = votes.light >= votes.dark ? 'light' : 'dark';
    if (votes[winner] / total >= MAJORITY) {
      const typical = colours.find((c) => toneOf(c) === winner)!;
      return { tone: winner, basis: `text mostly on ${toHex(typical)}` };
    }
  }
  return { tone: luminance(pageBackground) >= 0.3 ? 'light' : 'dark', basis: `page background ${toHex(pageBackground)}` };
}
