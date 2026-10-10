# `user` is an optional Standard Capability that asks the person running a Script

A Script that asks the person running it a question shouldn't need a Host-defined shape for every Host. `user` becomes a Standard Capability that a Host may choose not to offer, like `sqlite` (ADR 0070). The Spec fixes its Operation Declarations, and each Host supplies the UI: a dialog in the Playground, a terminal prompt in the REPL, a form in a server Host's client. For example:

```
ask user to confirm "Delete 12 files?" and wait
if it then deleteAll

ask user to choose ["Small", "Medium", "Large"], {prompt: "Pick a size"} and wait
put it into size        -- the chosen item, or Nothing if cancelled

ask user to enter "Your name?", {default: "Ann"} and wait

tell user to notify "Backup finished"
```

`confirm`, `choose` and `enter` are suspending, so a person can take their time, and their answers are recorded like any other Capability answer. Traces and Session Transcripts therefore replay with nobody there (ADR 0015, ADR 0018). Cancelling isn't an error. `confirm` answers `false`, and `choose` and `enter` answer Nothing, so `if it then …` and `if it is nothing then …` read the way a beginner expects. A Host shows one prompt per Script at a time, and refuses another from the same Script with `user busy`, so an untrusted Script can't flood a person with dialogs. Settled in [#527](https://github.com/odogono/odgn-talk/issues/527). Until the Spec holds the rules, the Consequences below record them.

## Considered Options

- **A Host-defined Capability per Host:** what Scripts have today. Every Host invents its own Operation names and cancel behaviour, so a Script written in the Playground doesn't run in the REPL.
- **An error, `cancelled`, for every cancel:** AppleScript raises error -128 when a person presses Cancel, and Scripts often forget to catch it. Then an ordinary "no" ends the Run. Cancelling is an answer the Script expected, not a failure.
- **Nothing for a cancelled `confirm` too:** three answers would make `if it then` treat a cancel like a "no" by accident, while a plain `false` does the same thing on purpose.
- **Prompts as ordinary output and input lines, through `console`:** `read` already waits for a line. But a choice from a list, a default and a yes-or-no question become parsing in every Script, and a graphical Host can't show a dialog for a line it can't tell from other input.
- **A Grant quota, such as `maxPrompts` per Run:** it limits the total, but not a Script that opens prompts in a Join or across Runs, and every Host would have to pick a number. One prompt per Script at a time bounds what a person sees with no number to tune.
- **The Core refusing a second prompt itself:** deterministic without the Host. But the Core would track pending calls per Capability across a Script's Runs and Joins, which no other Capability needs. The Host already sees every prompt it shows, and the Trace records its `user busy`, so replay stays exact.
- **A shorter default `maxPending`:** people are slow, so `user` takes `console` `read`'s 2,147,483,647 ms, the largest `MaxWait` every Core honours. A Script that wants a deadline writes a Timeout Block (ADR 0073).
- **Converting `enter`'s text to a number or date:** Scripts convert explicitly (ADR 0003). A failed conversion is the Script's error to report, not the dialog's.
- **Granting `user` to every session, as `console` is:** every existing Session Transcript's `case.trace` would change, since its load lists the Grants, and a session that never prompts would carry a Grant it doesn't use. `:grant user user` adds it, as `:grant store store` adds the Store.
- **Names:** `dialog` names a UI that a terminal or notification isn't, and `prompt` is also an option key. `ask user to confirm …` reads as English.

## Consequences

- **Optional:** a Host need not offer `user`, and many server Hosts have no person to ask. A Host that offers it follows every rule here. The Session Hosts (both REPLs and the Playground) build it in.
- **Binding:** none. The Host knows who it asks.
- **Operations:**
  - `confirm message` is suspending. It gives `true` when the person accepts, and `false` when they decline or dismiss the prompt.
  - `choose items [, options]` is suspending. `items` is a list of texts, and an empty one raises `out of domain`. `options` is a closed map with optional `prompt` (text) and `multiple` (boolean). It gives the chosen item, or with `multiple: true` a list of the chosen items in the order they appear in `items`, which may be empty. A cancel gives Nothing.
  - `enter message [, options]` is suspending. `options` is a closed map with an optional `default` (text), which the Host offers as the starting answer. It gives the text the person entered, or Nothing on a cancel.
  - `notify message [, options]` is fire-and-forget. `options` is a closed map with an optional `title` (text). The Host shows it without waiting for anyone.
- **Answers checked by the Core:** a `choose` answer must be Nothing, or, without `multiple`, one of `items`, or, with `multiple: true`, a list that is a subsequence of `items`. Anything else is the Host's fault and becomes `host error`, as a result that breaks its Shape does.
- **One prompt at a time:** while a Script has a `confirm`, `choose` or `enter` the Host hasn't answered, the Host fails that Script's next one with `user busy`, before showing anything. Prompts from different Scripts may queue. An abandoned prompt, by a timeout, cancellation or Stop, is no longer pending, and the Host takes it down.
- **Waiting:** each suspending Operation's `maxPending` is 2,147,483,647 ms. A Timeout Block bounds it, and a deadline that runs out raises `timeout` as for any call.
- **Cost:** per call, set by each Host. Session Hosts charge nothing, as for `console`.
- **Errors:** `user busy`, which the Host fails with, and `out of domain`, which the Core raises for an empty `items`.
- **Sessions:** `:grant user user` adds it, with no binding. The Session Host shows the foreground Run's prompt as it answers `read`, and a Transcript records each answer as a `~` line, so a corpus Transcript may grant `user`. `notify` prints its message after `* `, with the title and `: ` before it when given, as `console` `write` prints. How a REPL or the Playground shows a prompt isn't output, so it's each frontend's own.
- **Trace and conformance:** every answer is in the Trace, so a Trace Case replays without a person. Trace Cases cover an answer, a cancel, a timeout, `user busy` and a bad `choose` answer, and a Session Transcript covers an answer, a cancel and a timeout.
- **Snapshots:** a pending prompt is a pending call, saved and restored like any other (chapter 10).
- **Follow-ups:**
  - Background Runs' prompts in the Session Hosts, which wait until they time out, as a background `read` does.
  - A `secret` option for `enter`, once Transcripts can leave an answer out.
  - Button labels for `confirm`.
