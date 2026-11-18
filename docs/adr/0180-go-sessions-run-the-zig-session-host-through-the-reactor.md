---
status: accepted
---

# Go sessions run the Zig Session Host through the reactor

For [#2271](https://github.com/odogono/odgn-talk/issues/2271), the Go `session` package becomes an adapter over the Zig Session Host, which the embedded reactor serves under a new `session-v1` feature. ADR 0117 retired the Go Core but kept a Go Session Host, so Session Commands still existed three times: TS, Zig and Go. `:script add` (ADR 0170) landed three times, and `go-core` failed on every PR from #2130 until the Go copy caught up in #2141. With this change, Session Commands, observation, `:describe`, inspection and Transcript replay live once per Core, in TS and Zig. Go keeps its terminal, filesystem, Clock and Host Objects. ADR 0014 is unchanged: the Go session is still an ordinary Host, and only where its command logic runs moves.

The boundary sits at whole inputs. Go sends one Entry or Session Command at a time, and keeps the Session Driver: multiline collection, queueing input while the session sleeps, waking at deadlines and turning an interrupt into `:cancel`. The Driver is not normative and is specific to each terminal, so it belongs to each Host. Everything the Zig Session Host asks its embedder for becomes a `need` that Go answers under the same `ref`, the way Capability calls already work. That includes Clock readings, console lines, Capability answers, file writes, sleeping and live Host Object crossings (amended for [#2277](https://github.com/odogono/odgn-talk/issues/2277) on 2026-11-18, below: only file writes, live crossings and live Restore stay `need`s). Go reads a file a Session Command names before sending the command. It sends the file's lines in place of the path, as a Transcript records them and as the Zig REPL already does, so no path reaches the guest. Output, Trace lines and Transcript Items come back as reply records.

## Considered Options

- **Keep the Go copy and enforce parity in CI:** CI already enforced it. That is how `go-core` went red, and every Session Command change still lands three times.
- **Drop the Go Session Host and ship the Zig REPL as `northtalk repl`:** this loses Go-defined Host Objects and Go I/O in sessions.
- **Send raw lines and move the Session Driver into Zig:** this puts terminal behaviour that is not normative behind the boundary, so every Host would get Zig's Driver.
- **Let Go keep the session's Group and call Zig for command logic only:** `session.zig` drives its Group in-process over `talk.h`. Splitting it across the boundary would mean rewriting it and adding a crossing on every Group call.
- **A separate session-only `.wasm`:** this is one more artifact to keep version-matched, to save roughly 4k lines of Zig in each Go binary.

## Consequences

- **Supersedes in part [ADR 0117](0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md):** the Go Session Host and REPL keep working, but their command logic is the Zig Session Host's, not Go's.
- **`session-v1`** adds `session-open`, `session-input`, `session-pump`, `session-describe-prompt` and `session-close` to the existing reactor. `session-open` takes the Clock mode, limits, a recorded Transcript to replay and any Host Object Kinds. `:cancel`, `:save` and every other Session Command arrive as `session-input`.
- **Amended by [#2277](https://github.com/odogono/odgn-talk/issues/2277) (2026-11-18): most embedder answers travel with the next message, not as `need`s.** The Zig Session Host uses each `Driver` answer several frames deep, so pausing for every one would mean restructuring all of `session.zig`. Go's Driver already sends lines and prompt answers in as later calls and pumps on its own timer, so the boundary follows it:
  - Every `session-input` and `session-pump` carries the Clock reading, which a `real` Clock requires and a `virtual` one refuses.
  - A console line or a `user` prompt's answer is a `session-input`. Until one arrives, the session waits.
  - Nothing sleeps. Each reply ends with what the session waits for (prompt, read, user, deadline or paused) and its next deadline, and Go sends `session-pump` when that deadline comes.
  - A second `user` prompt while one waits is answered `user busy` by the guest, as Go does today.
  - Three `need`s remain, each able to stay open across frames: `prop` for a live crossing and `resolve` for a live Restore, as chapter 9 names them, and a new `write` for `:export` and `:store save`, whose output depends on whether the write worked.
- **One guest per session, which owns its Group.** Go holds no `talk.Group` for a session, and reaches it only through session messages.
- **The guest records the Transcript.** It produces the Transcript Items, so the format and the replay rules live in `transcript.zig` and TS only. Go reads and writes the `.transcript` file.
- **Live Host Objects move into the Zig Session Host.** It gains live Object Kinds: Go declares them in `session-open`, and each property get or set, or Object Collection count, at or find, on such an object is a `need` that Go answers, and Restore resolves their identities through Go. Host actions on objects, recorded as `input`, are a separate step. Until now, Zig only replayed recorded crossings.
- **The drift closes in Zig, under the corpus.** Before the switch, the Zig Session Host gains `:grant <name> clock`, with a `corpus/sessions` case that TS and Zig must pass. Reading the file that `:library`, `:script`, `:fix` or `:store load` names isn't drift. It is Driver work, and the Transcript records only the file's lines ([#2275](https://github.com/odogono/odgn-talk/issues/2275)).
- **Session Stores are the guest's.** `:store` uses Zig's in-memory Session Stores, so replays stay deterministic. The Go `store` package no longer serves sessions and stays for ordinary Go Hosts.
- **The public Go API stays source-compatible.** `session.New(Environment)`, every `Environment` field and the `Host` methods keep their signatures. Each field becomes a `need` answer or part of `session-open`.
- **`go-core` still replays every `corpus/sessions` case,** now through the adapter. When Zig passes, Go can fail only because of an adapter bug.
- **Migration**, one PR per step:
  1. Close the drift in Zig.
  2. Add live Object Kinds to Zig.
  3. Add `session-v1` to the reactor.
  4. Switch the Go adapter in one PR, with no dual-run flag, once `go-core` passes the full corpus.
  5. Delete the Go command logic.
