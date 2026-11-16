---
status: accepted
---

# Go sessions run the Zig Session Host through the reactor

For [#2271](https://github.com/odogono/odgn-talk/issues/2271), the Go `session` package becomes an adapter over the Zig Session Host, which the embedded reactor serves under a new `session-v1` feature. ADR 0117 retired the Go Core but kept a Go Session Host, so Session Commands still existed three times: TS, Zig and Go. `:script add` (ADR 0170) landed three times, and `go-core` failed on every PR from #2130 until the Go copy caught up in #2141. With this change, Session Commands, observation, `:describe`, inspection and Transcript replay live once per Core, in TS and Zig. Go keeps its terminal, filesystem, Clock and Host Objects. ADR 0014 is unchanged: the Go session is still an ordinary Host, and only where its command logic runs moves.

The boundary sits at whole inputs. Go sends one Entry or Session Command at a time, and keeps the Session Driver: multiline collection, queueing input while the session sleeps, waking at deadlines and turning an interrupt into `:cancel`. The Driver is not normative and is specific to each terminal, so it belongs to each Host. Everything the Zig Session Host asks its embedder for becomes a `need` that Go answers under the same `ref`, the way Capability calls already work. That includes Clock readings, console lines, Capability answers, file reads and writes, sleeping and live Host Object crossings. Output, Trace lines and Transcript Items come back as reply records.

## Considered Options

- **Keep the Go copy and enforce parity in CI:** CI already enforced it. That is how `go-core` went red, and every Session Command change still lands three times.
- **Drop the Go Session Host and ship the Zig REPL as `northtalk repl`:** this loses Go-defined Host Objects and Go I/O in sessions.
- **Send raw lines and move the Session Driver into Zig:** this puts terminal behaviour that is not normative behind the boundary, so every Host would get Zig's Driver.
- **Let Go keep the session's Group and call Zig for command logic only:** `session.zig` drives its Group in-process over `talk.h`. Splitting it across the boundary would mean rewriting it and adding a crossing on every Group call.
- **A separate session-only `.wasm`:** this is one more artifact to keep version-matched, to save roughly 4k lines of Zig in each Go binary.

## Consequences

- **Supersedes in part [ADR 0117](0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md):** the Go Session Host and REPL keep working, but their command logic is the Zig Session Host's, not Go's.
- **`session-v1`** adds `session-open`, `session-input`, `session-pump`, `session-describe-prompt` and `session-close` to the existing reactor. `session-open` takes the Clock mode, limits, a recorded Transcript to replay and any Host Object Kinds. `:cancel`, `:save` and every other Session Command arrive as `session-input`.
- **One guest per session, which owns its Group.** Go holds no `talk.Group` for a session, and reaches it only through session messages.
- **The guest records the Transcript.** It produces the Transcript Items, so the format and the replay rules live in `transcript.zig` and TS only. Go reads and writes the `.transcript` file.
- **Live Host Objects move into the Zig Session Host.** It gains live Object Kinds: Go declares them in `session-open`, and each get, set or call on such an object is a `need` that Go answers. Until now, Zig only replayed recorded crossings.
- **The drift closes in Zig, under the corpus.** Before the switch, the Zig Session Host gains `:grant <name> clock`, and file reads for `:library add <name> <file>` and `:store load <file>`. Each comes with a `corpus/sessions` case that TS and Zig must pass.
- **Session Stores are the guest's.** `:store` uses Zig's in-memory Session Stores, so replays stay deterministic. The Go `store` package no longer serves sessions and stays for ordinary Go Hosts.
- **The public Go API stays source-compatible.** `session.New(Environment)`, every `Environment` field and the `Host` methods keep their signatures. Each field becomes a `need` answer or part of `session-open`.
- **`go-core` still replays every `corpus/sessions` case,** now through the adapter. When Zig passes, Go can fail only because of an adapter bug.
- **Migration**, one PR per step:
  1. Close the drift in Zig.
  2. Add live Object Kinds to Zig.
  3. Add `session-v1` to the reactor.
  4. Switch the Go adapter in one PR, with no dual-run flag, once `go-core` passes the full corpus.
  5. Delete the Go command logic.
