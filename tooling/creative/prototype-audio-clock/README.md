# PROTOTYPE: audio-clock timing for Folio Play (#1888)

Throwaway. Not part of Folio; it lives on the `prototype/1888-audio-clock` branch only.

- `bun tooling/creative/prototype-audio-clock/serve.ts` serves the page at <http://127.0.0.1:3929/>
  (query: `lead`, `margin` in seconds, `pumpCostMs`, `mode=delivery|now`, `ticker=1`, `bpm`).
- `bun tooling/creative/prototype-audio-clock/measure.ts [--headless] [--only <name>]` runs every scenario in Playwright Chromium.
- `bun tooling/creative/prototype-audio-clock/measure-hidden.ts` runs the hidden-tab case over raw CDP, since Playwright keeps pages visible.

`worklet.ts` is a ChipHost-style click processor (after odogono/mercenary `web/src/sound/workletHost.ts`),
`worker.ts` the Play worker running a Core Group, and `page.ts` the AudioContext, clock anchors and stats.
`results-macos-chromium.json` holds the recorded run.
