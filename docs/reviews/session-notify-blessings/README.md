# Session notification expectation review

Proposed expectations for [#621](https://github.com/odogono/odgn-talk/issues/621),
which also implements [#623](https://github.com/odogono/odgn-talk/issues/623),
on a checkout based on `b618244a` (2026-10-11). **Human approval is pending.**
The authority is [The Session Host](../../../spec/12-sessions-and-tooling.md#session-store-notifications)
in chapter 12, with its
[Queued Host Inputs](../../../spec/12-sessions-and-tooling.md#the-foreground) rule.
The contract was staged at that checkout and is now integrated into the numbered chapters (#622).

## The pumping rule

The staged proposal said the Session Host pumps again at the same Clock reading
until no Host Inputs are left queued. Chapter 12, settled by #494, says it pumps
once more, with its own reading, and never chains. The maintainer chose to split
the two, and the proposal now says so:

```text
after each Pump: router.pumped(group)
while the router admitted a Notification in the last Pump and inputs are queued:
  pump again at the same reading               # same Host call, no @ line
after the Host call's lines, if inputs are still queued:
  one more Pump, as its own Host call          # its own @ line; Notifications loop
                                               # within it, other inputs never chain
```

So a Handler's write-back converges before the prompt returns, while a getter
whose Handler reads the getter again still gets one Pump per Host call.

## Proposed expectations

Each new file keeps its `Unblessed` marker. Expected lines were derived from
the staged rules before blessing. The `store-notifications` output is the
proposal's example Transcript, line for line. `bun run corpus:bless` then
filled the Traces, keeping them only after both Cores reproduced the
Transcripts and replayed the Traces in both modes. Agreement is execution
evidence, not approval.

| Expectation | Required behavior |
| --- | --- |
| [store-notifications](../../../corpus/sessions/store-notifications/session.transcript) ([trace](../../../corpus/sessions/store-notifications/case.trace)) | The proposal's example: a background Run for an ordinary Notification; an unchanged `set` routes nothing; `:store clear` routes the cleared key; `:restore` after a change resyncs the watch with `keys: []` and the save's run counter |
| [store-notify-own-writes](../../../corpus/sessions/store-notify-own-writes/session.transcript) ([trace](../../../corpus/sessions/store-notify-own-writes/case.trace)) | A Handler rounding the score it hears about is told of its own write in another Pump at the same reading (`pump clock=` repeats with no new `@`), and stops when the write changes nothing |
| [store-notify-lifecycle](../../../corpus/sessions/store-notify-lifecycle/session.transcript) ([trace](../../../corpus/sessions/store-notify-lifecycle/case.trace)) | One commit reaches two watches; `unwatch` removes one, and again does nothing; Extend keeps the watch; redefining the Handler reloads and removes it; an Entry registers again |
| [store-notify-host-changes](../../../corpus/sessions/store-notify-host-changes/session.transcript) ([trace](../../../corpus/sessions/store-notify-host-changes/case.trace)) | `:store load` routes only changed keys under the prefix, and a load changing no watched key sends nothing; clearing an empty Store sends nothing; `:restore` with no change sends no marker and the watch still routes; `:restore` after another Store changed resyncs only that Store's watch |

## Changed expectations

| Expectation | Change |
| --- | --- |
| [object-inspection/session.transcript](../../../corpus/sessions/object-inspection/session.transcript) and [case.trace](../../../corpus/sessions/object-inspection/case.trace) | As #623 predicted: each getter-queued `deliver` (`d5`, `d9`) now runs in an extra Pump right after its `:inspect root`, with its own `@`, instead of in the next Pump. The external Function call `d6` moves to its own tick, and its Function exposure counter goes from 28 to 30 because the extra Pump's reports come first. Re-recorded from the native TS test; only the `é` line keeps its original bytes |
| [save-restore/case.trace](../../../corpus/sessions/save-restore/case.trace) | `:restore`'s adopt `settle` is a queued Host Input in both Cores, so a `pump`/`pumped state=idle fuel=0` pair now follows the restore. The Transcript doesn't change |

## Independent checks

- TS `tests/session-pumping.test.ts` and Go `session/pumping_test.go`: a getter's `deliver` gets one more Pump after the command's lines, with its own reading; a Handler that reads the getter again gets exactly one per Host call, even after a non-pumping command such as `:runs`; a self-advancing Notification Handler runs three times on one reading.
- TS `tests/notify.test.ts` and Go `notify/router_test.go`: `admitted` is told of each admission, not of a `MailboxFull` refusal, and again when `pumped` admits the held Notification.
- Transcript replay offers a deadline's `@` and any later readings before the next input to the Pump for queued inputs, in both drivers.

## Validation

See the PR for the commands run. These checks verify the implementation and the
expectations' agreement. They don't replace the human first-blessing review of
the six Transcript and Trace pairs above.
