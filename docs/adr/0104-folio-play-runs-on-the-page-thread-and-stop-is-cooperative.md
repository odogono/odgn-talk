# Folio Play runs on the page thread and Stop is cooperative

Folio runs every Play Session on the page thread, in the same task loop as the editor. [ADR 0086](0086-creative-play-runs-in-a-worker-and-stop-freezes-the-session.md) recorded a dedicated worker that the page would terminate after 500 ms without a Stop acknowledgement. That worker was never built ([#1207](https://github.com/odogono/odgn-talk/issues/1207)). Folio keeps the page-thread design, and this record states what it guarantees.

`PlaySession` and the page are tightly coupled. The page draws from the session's live Pages and Elements. Reader edits reach the session synchronously. Sounds play through page-only audio. In Edit, the Message Box runs its command and writes the session back as one synchronous step. Moving the session into a worker would need a state mirror or per-Element diffs, relays for audio and prompts, and an asynchronous Message Box. Every drawn change would also lag by about one frame.

The page thread keeps Stop responsive through metering:

- Each Pump runs at most 5,000 Fuel, in 1,000-Fuel slices, and then yields to the event loop. Stop, Esc and choosing Edit run between Pumps.
- Every Host Crossing a Script can make charges Fuel for its own work. Creating, cloning and deleting Elements charge for the size of what they copy or index. Element collections charge per access.
- Each Run has the Core's default lifetime budget of 10,000,000 Fuel.

What that does not cover is one instruction or Host Crossing whose elapsed time its Fuel cost does not bound. That would come from a Core defect or an unmetered Host operation. Such a Script freezes the editor until the browser offers to stop the page. An unmetered Host operation is a Folio defect to fix where it is found.

## Considered Options

- **Build the worker ADR 0086 recorded.** It would make escape independent of metering. It costs the refactor above, and so far no freeze has been seen that metering didn't bound.
- **Put a worker runner in the TS Core.** Only the Host can run in the worker, and every app's Host is different, so the Core could ship only an empty shell. A Group behind `postMessage` is also an asynchronous embedding API, which [ADR 0097](0097-browser-hosts-may-run-the-zig-reactor-through-the-ts-embedding-api.md) rejected because Hosts would have to change their code to switch Cores.

## Consequences

- Narrows ADR 0086: Play runs on the page thread, and there is no Stop acknowledgement deadline or worker termination. Its other Consequences stand, as [ADR 0093](0093-folio-browses-in-place.md) narrows them: Stop silences audio first, disables Play input, requests sticky Core Stop for every Script and drops late effects with the session. The Fuel limits and the one-second `closePage` deadline also stand.
- Narrows ADR 0093: leaving Play does not wait for a Script to cooperate, but it relies on Pump slices and Fuel-metered Host Crossings to yield the page thread.
- The Variables window ([#1141](https://github.com/odogono/odgn-talk/issues/1141)) reads the Group with `inspect()` in-process.
- A shared worker supervisor for browser Hosts in `@northtalk/tooling` is tracked in [#1216](https://github.com/odogono/odgn-talk/issues/1216). The Playground, which already runs its Session Host in a worker, adopts it for Cancel, Restart and Run fresh. Folio's adoption is tracked in [#1225](https://github.com/odogono/odgn-talk/issues/1225); if Folio adopts it, a new record supersedes this one.
