# Creative Play runs in a worker and Stop freezes the session

The planned [creative tool](https://github.com/odogono/odgn-talk/issues/154) runs every Play Script in a dedicated worker so a runaway Script cannot occupy the page thread that handles Stop and Back to Edit. Stop or Esc stops every Script and sound, preserves the last displayed Play State, and offers Restart from the authored Project or Back to Edit, with no Resume in v1. This makes escaping broken Scripts independent of their cooperation while preserving the separation between authored content and temporary Play State in [ADR 0041](0041-authored-projects-are-separate-from-temporary-play-state.md); the agreed limits, responsiveness targets and error presentation are recorded in [#782](https://github.com/odogono/odgn-talk/issues/782).

## Considered Options

- **Run Scripts on the page thread with small Pump slices.** Slices help scheduling but cannot bound the elapsed time of a single instruction or synchronous Host work. A dedicated worker lets the page terminate execution when cooperative Stop cannot respond.
- **Cancel only active Runs and resume Play.** Core cancellation permits cleanup, and stopping current Runs alone does not prevent later messages from starting more work. A frozen session gives the author a stable view of what happened without re-entering the broken Script.
- **Give each Run an elapsed-time deadline.** An intentional wait can outlive that deadline. Per-Run Fuel limits computation, while the worker Stop acknowledgement deadline bounds the escape path rather than the age of a Run.

## Consequences

- The page owns the Stop controls and audio shutdown. It immediately disables Play input, freezes the displayed state and rejects late worker effects, then requests sticky Core Stop for every Script. Stop does not run Script cleanup; Host-owned cleanup must not depend on it.
- Stop acknowledgement targets 100 ms under normal foreground conditions. After 500 ms without acknowledgement, the page terminates the worker. Browser suspension can delay these timers; they are responsiveness targets, not real-time guarantees.
- Restart creates a new Group from the authored Project. Back to Edit discards Play State. Neither path requires a responsive worker, and autosave and export continue to preserve authored content only.
- All Runs, including Project handlers, receive the Core's default 10,000,000 Fuel budget across their lifetime, with no general elapsed-time timeout. Waiting alone spends no Fuel. Small Pump slices and a Group-wide Pump Fuel cap, with event-loop yields, allow cooperative Stop; the existing one-second `closePage` deadline remains.
- Load errors disable the affected Script; uncaught runtime errors and Fuel exhaustion end the affected Run while other Runs continue. Non-blocking diagnostics identify the owning object and source line. These failures do not invoke the session-wide Stop action.
- This records future Host policy for #154 and its Play Session implementation in #785. It changes neither the language Spec nor any Core, and does not claim the runtime is implemented.
- Superseded in part by [ADR 0093](0093-folio-browses-in-place.md): Folio runs Play Sessions by browsing in place or presenting, and Stop, Esc or choosing Edit returns to Edit in one step, with no frozen session, Restart or separate Back to Edit. The limits and escape path here stand.
- Narrowed by [ADR 0104](0104-folio-play-runs-on-the-page-thread-and-stop-is-cooperative.md): Folio runs Play on the page thread, with no worker, Stop acknowledgement deadline or termination. Stop is cooperative, bounded by Pump slices and Fuel-metered Host Crossings.
- [ADR 0107](0107-folio-play-runs-in-a-supervised-worker.md) supersedes ADR 0104: Folio runs Play in a supervised worker again, with the 500 ms Stop acknowledgement deadline and termination.
