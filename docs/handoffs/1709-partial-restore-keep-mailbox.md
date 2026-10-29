# Kept-mailbox Partial Restore: specification handoff for #1709

## Required base and delivery boundary

- **Required base:** the PR for [#1821](https://github.com/odogono/odgn-talk/issues/1821), or its merged successor. Relevant sections: [chapter 10, Partial Restore](../../spec/10-save-and-restore.md#partial-restore) (Keeping the mailbox, The cap with a kept mailbox, Across Scripts, Reported), the `restore` request in [chapter 9](../../spec/09-embedding.md), `RestoreOptions` in [`talk.ts`](../../spec/embedding/talk.ts) and [`talk.go`](../../spec/embedding/talk.go), the `restore` record's `mailbox` key in [`corpus.toml`](../../spec/data/corpus.toml), and [ADR 0143](../adr/0143-a-restore-may-reload-only-the-scripts-whose-code-changed.md#keeping-the-mailbox).
- **Implemented in:** the specification, the TS embedding declaration, the ADR amendment and the Trace key ([#1821](https://github.com/odogono/odgn-talk/issues/1821)); TS ([#1823](https://github.com/odogono/odgn-talk/issues/1823)); Zig and Go ([#1822](https://github.com/odogono/odgn-talk/issues/1822)), which moved the staged cases into `corpus/save-restore/`.
- **Remaining work:** Elixir ([#1824](https://github.com/odogono/odgn-talk/issues/1824)).
- **Approval still needed:** none for the three cases below; the maintainer approved their first blessing on 2026-10-29 for #1821. Re-blessing after an implementation changes them needs review again.

## Staged Go declaration

The Go API test requires [`talk.go`](../../spec/embedding/talk.go) to match `impl/go` exactly, so `KeepMailbox` is added there in [#1822](https://github.com/odogono/odgn-talk/issues/1822), together with the field on `impl/go`'s `RestoreOptions`:

```go
	Mismatch MismatchPolicy
	// KeepMailbox keeps each changed Script's mailbox in a Partial Restore,
	// as Reload's keepMailbox does. Ignored unless Mismatch is ReloadChanged
	// and the restore is partial.
	KeepMailbox bool
```

## Corpus cases

Both the TS and Zig corpus jobs run every case under `corpus/`, so these cases were staged here until both passed them; they now live in [`corpus/save-restore/`](../../corpus/save-restore/), unchanged.

| Case | Pins |
| --- | --- |
| `partial-restore-keep-mailbox` | a kept message goes to the new code; no `dropped` |
| `partial-restore-keep-mailbox-request` | a matched Script's Request in the kept mailbox goes on waiting and gets the new code's reply, not `send failed` |
| `partial-restore-keep-mailbox-no-handler` | a kept message no clause of the new code takes ends `unhandled` |

The expectations came from a throwaway TS Core prototype (keep the queue in `reloadRestored`, count it in the cap check, write `mailbox=keep`), and the maintainer approved them as first blessings. A state-cap refusal case is left out: a Restore refused with `state too large` writes no Trace record on any Core today, so the case would pin unspecified output. Cover the cap with unit tests instead, and file a Trace issue if a record is wanted.
