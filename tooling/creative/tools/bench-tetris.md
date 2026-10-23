# Tetris benchmark: Canvas against Element

Element Tetris and Canvas Tetris run the same game, and only the way each one
draws differs. The Element version recolours 200 cell Elements it placed in
advance. The Canvas version clears its board and redraws it whenever the view
changes. This note measures what that choice costs (#1542). Run from the
repository root:

```sh
bun tooling/creative/tools/bench-tetris.ts            # headless, about 10 s
bun tooling/creative/tools/bench-tetris-browser.ts    # Chromium, about 6 min
```

## The scripted game

[bench-tetris-moves.ts](bench-tetris-moves.ts) fixes the seed for `random` (so
both games get the same pieces) and the list of keys. For each piece it
rotates 0–3 times, slides up to four columns, soft-drops twice, then
hard-drops. A key goes every 8 frames, and the game restarts when it ends.

- **Headless** ([bench-tetris.ts](bench-tetris.ts)): the Play worker's
  `PlayHost`, on a simulated 60 Hz clock, runs each frame's Pumps to idle
  before the next frame. It plays 3,600 frames (60 s) in each of 5 runs,
  and the two games alternate. The game is fully deterministic, so the run
  fails unless both games end on the same score, lines and number of games.
- **Browser** ([bench-tetris-browser.ts](bench-tetris-browser.ts) with
  [bench-tetris.page.ts](bench-tetris.page.ts)): a minified build in headless
  Chromium. Each run Browses with the Performance window open, plays for 30 s
  on `requestAnimationFrame`, and starts in a fresh context; there are 5
  runs. Browse is seeded with the same seed. Frame timing is real here, so
  the browser's game differs from the headless one, but both browser games
  ended on the same score in every run. Main-thread times come from
  Chromium's `Performance.getMetrics`, and include the benchmark's own
  `requestAnimationFrame` loop. Rasterising and compositing happen off the
  main thread, so these times leave them out.

## Results

Measured on 2026-10-23 at `dd4b8cb1` on an Apple M5 with Bun 1.4.3 and
Playwright's Chromium headless shell. Each figure is a median over 5 runs.

Headless:

| Per frame unless stated                | Element | Canvas |
| -------------------------------------- | ------: | -----: |
| Fuel, all Runs                         |   2,597 |  2,620 |
| Fuel, `frame` Runs                     |      82 |     82 |
| Fuel per key, `keyDown` Runs           |  19,040 | 20,041 |
| Worker ms                              |    0.28 |   0.22 |
| Views sent                             |    0.72 |   1.71 |
| View bytes                             |   2,510 |  1,592 |
| Board views painted partly drawn, 60 s |       0 |    432 |

Browser, 30 s:

| Per frame unless stated       | Element | Canvas |
| ----------------------------- | ------: | -----: |
| Page frames per second        |    59.9 |   60.0 |
| `frame`s delivered per second |    53.3 |   52.9 |
| `frame`s skipped, busy        |     200 |    213 |
| Fuel, all Runs                |   1,337 |  1,353 |
| Views handled                 |    0.30 |   0.77 |
| View handling ms              |    1.01 |   0.63 |
| Main thread task ms           |    1.52 |   1.26 |
| Main thread script ms         |    0.99 |   0.63 |
| Main thread style ms          |    0.14 |   0.15 |
| Main thread layout ms         |    0.08 |   0.11 |

Fuel is deterministic headless, so its spread was 0%. In the browser the
Fuel and frame figures varied by 1–2%, which is within the ±5–8% noise seen
in earlier benchmarks. Main-thread times varied by 10% for Element and up to
47% for Canvas, so only differences larger than that count.

## Findings

- **Neither costs more in Fuel.** Both run the same rules and the same
  `paint` loop over all 200 cells. Canvas uses about 1% more Fuel overall and
  5% more per key, from issuing `fill` and `rectangle` for each filled cell
  where the Element version compares each cell with the colour it last set.
  Script work is the same either way.
- **Canvas costs less to paint.** Both games hold 60 fps in the browser.
  Handling the worker's views takes about 40% less main-thread script time
  for Canvas: it sends about 20 small drawing commands per frame and paints
  them with Canvas 2D, while the Element version sends whole Element entries
  that update the DOM. Style and layout costs are small and within noise
  for both.
- **The real cost is one `paint`, in both games.** A key that changes the
  view costs about 20,000 Fuel. That is four 5,000-Fuel Pumps, and `frame`s
  that arrive meanwhile are skipped: about 1 in 9 in the browser.
- **Canvas Tetris shows partly drawn boards.** Every sliced Pump publishes a
  view. A Canvas `paint` clears the board in its first Pump and adds cells in
  the later ones, so the page draws an emptied or half-drawn board in
  between. This happened 432 times in 60 s headless, which is why Canvas
  sends more than twice as many views. The Element version only ever shows
  a mix of old and new colours.

Filed as #1543 (both games repaint all 200 cells for every changed view) and
#1544 (sliced Pumps publish half-painted Canvas Drawings).
