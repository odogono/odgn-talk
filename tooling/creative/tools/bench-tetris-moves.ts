// The scripted Tetris game both benchmarks play (#1542): one seed and one
// list of keys, so Element and Canvas Tetris play the same game without a
// human. Pure data; no DOM, no Play Session.

/** Seeds `random`, so both games deal the same pieces. */
export const SEED = 1542n;

/** One frame at 60 Hz, in ms. */
export const FRAME_MS = 1000 / 60;

/** Frames between keys: about 7.5 keys a second, a quick human's pace. */
export const KEY_EVERY = 8;

/**
 * The keys for `pieces` pieces: each piece turns 0–3 times, slides up to
 * four columns either way, then hard-drops. The counts come from a fixed
 * linear congruential sequence, not the game, so the list is the same
 * whatever the board holds.
 */
export const tetrisKeys = (pieces = 400): string[] => {
  const keys: string[] = [];
  let state = 1542;
  const next = (n: number) => {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    return state % n;
  };
  for (let i = 0; i < pieces; i++) {
    for (let turns = next(4); turns > 0; turns--) {
      keys.push('ArrowUp');
    }
    const slide = next(9) - 4;
    for (let j = 0; j < Math.abs(slide); j++) {
      keys.push(slide < 0 ? 'ArrowLeft' : 'ArrowRight');
    }
    // A couple of soft drops, so gravity and scoring both run.
    keys.push('ArrowDown', 'ArrowDown', ' ');
  }
  return keys;
};
