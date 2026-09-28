# PROTOTYPE: Example Hosts against a proposed embedding API (throwaway)

Sketches for [Example Hosts: sketch Host code and Scripts against a proposed embedding API](https://github.com/odogono/odgn-talk/issues/24).
Nothing here compiles or runs: there is no Core yet. The files exist to show where the proposed API holds up and where it strains.

**Superseded by the decisions in [ADR 0015](https://github.com/odogono/odgn-talk/pull/31) (the Host drives the Core through a Pump) and ADR 0016 (messages reach Scripts through Core-owned object parents).** Where these sketches disagree with the ADRs, the ADRs win. For example, Damocles trigger arming moves to the Host, and Message Path parents are Core-owned rather than a Host `parent` function.

- `// ??` or `-- ??` marks a place where the API (or the language) strained while writing.
- `DEPARTURE` (Damocles only) marks where the re-expression does more than, or differs from, the original game.
- Scripts use the spellings settled so far (ADR 0012: `ask`/`tell … to <operation>`, `set` for Host Object properties, suffix queueing modifiers).

Read in order:

| Path | What it is |
| --- | --- |
| `api/talk.go` | The proposed Go Core API: values, shapes, Capabilities and Operations, Host Objects, limits, Groups, pump, reports, save and restore, Traces |
| `api/talk.ts` | The same for the TS Core (Bun and browser), with its deliberate differences |
| `01-go-multitenant/host.go` | Multi-tenant Go server: one Group per tenant, a worker pool pumping Groups in parallel, grants with costs and modes, a `Charge` budget handle, quotas from counters, revocation, reload |
| `01-go-multitenant/scripts/` | `invoices.talk` (from syntax-sketch 08) and `approvals.talk`, in one tenant Group |
| `02-bun-rules/host.ts` | Bun webhook rules service: real-time Clock, promise-backed Suspending Operations with `AbortSignal`, synchronous `bun:sqlite` as an Immediate Operation, HTTP request to Handler reply |
| `02-bun-rules/scripts/` | `rules.talk`, plus `weather.talk` (the syntax sketch's HTTP fetch Script, reused) |
| `03-browser-damocles/host.ts` | Damocles slice in the TS browser port: game events from Host Callouts, a per-VBL pump with Fuel Slices, game time as the Clock, pause, save anywhere with catalogue ids as stable Host Object ids, a Message Path by Object Residence |
| `03-browser-damocles/scripts/` | `session.talk` (pickup responses, landing messages, first offer, deflection ending) and `tolosa.talk` (TOLOSA's sticky landing), rebuilt from the mercenary repo's research on the real Damocles Scripts |
| `04-parity/` | Two Scripts, a `case.json` of inputs and an `expected.trace`, replayed by `runner.go` and `runner.ts` (under `bun.ts` and `browser.ts`), plus the lockstep version check and per-tick Trace digest |
| `NOTES.md` | What held up, Go vs TS differences and why, and the open API questions each sketch exposed |
