# Folio Play runs in a supervised worker

Folio runs every Play Session in a dedicated Play worker, behind the shared worker supervisor in `@northtalk/tooling` ([#1216](https://github.com/odogono/odgn-talk/issues/1216)). This supersedes [ADR 0104](0104-folio-play-runs-on-the-page-thread-and-stop-is-cooperative.md) and brings back the worker and Stop deadline of [ADR 0086](0086-creative-play-runs-in-a-worker-and-stop-freezes-the-session.md). On the page thread, Pump slices and Fuel-metered Host Crossings bounded Stop only as far as each Fuel cost bounded its work. One instruction or Host Crossing that ran longer than that froze the editor until the browser offered to stop the page. A worker makes Stop independent of metering. It also lets a future rendering-loop Host keep its clock beside the Group ([#1225](https://github.com/odogono/odgn-talk/issues/1225)).

The worker owns the Play Session and the clock that pumps it. The page keeps the DOM, audio and the editor:

- The worker sends the page a full view of the showing Page when Play opens and after each navigation. After each Pump that changed something, it sends only the Elements whose state changed. The page draws from its mirror of that state.
- The mirror carries whether the Page's Message Path handles `keyDown` and `keyUp`, so the page decides at once whether a key belongs to the Project.
- A reader's text edit shows in the mirror at once and is posted to the worker, which applies it and sends `textChanged`. The worker's state is authoritative.
- The page's `requestAnimationFrame` posts a tick to the worker only while a Script handles `frame` ([ADR 0095](0095-folio-delivers-a-frame-message-to-scripts-that-handle-it.md)).
- Sounds, prompts, notices and Script problems cross as messages. Sounds play through the page's audio.
- While browsing, the Message Box sends its command to the worker and answers when the command's Run ends. In Edit it still runs on the page as one undoable edit.

Stop, Esc and choosing Edit silence the page's audio, disable Play input and return to Edit at once. They then send Stop to the worker as a supervised request. The worker requests sticky Core Stop for every Script and runs one final Pump. Its reply is the acknowledgement. Without a reply in 500 ms the supervisor ends the worker. The page then reports that a Script did not respond, and a fresh worker waits for the next session. Nothing restarts Play.

## Considered Options

- **Keep Play on the page thread (ADR 0104).** It needs no relays and draws with no added latency. The editor still freezes if one instruction or Host Crossing runs longer than its Fuel cost bounds.
- **Send a full snapshot after every change.** This is simpler than per-Element diffs. It copies every Element of the Page on every changed Pump, and loses the identity the page's reader history and drawn nodes are keyed by.
- **Let the worker own the frame clock.** A worker's timers are not synced to the display. The page's `requestAnimationFrame` is, and `frame` already skips a Script whose last `frame` is still running.

## Consequences

- Supersedes ADR 0104. Narrows ADR 0086 as ADR 0093 left it: Play runs in a worker again, with the 500 ms Stop acknowledgement deadline and termination. There is still no frozen session or Restart.
- Every drawn change reaches the page about one task after the Pump that made it.
- The Fuel limits, the 1,000-Fuel slices, the 5,000-Fuel Pump cap and the one-second `closePage` deadline stand. Slices now only bound how long the worker takes to read its next message, and retuning them is separate work.
- The Variables window ([#1141](https://github.com/odogono/odgn-talk/issues/1141)) asks the worker for the Group's `inspect()` and gets plain data back.
- An unmetered Host operation no longer freezes the editor, but it is still a Folio defect to fix where it is found.
- Narrows [ADR 0106](0106-folio-edit-and-play-share-a-mutable-project-tree.md): the Play Session and its Project tree live in the Play worker, not on the page thread. The page's mirror is plain data that the worker's views replace, and it is not a Project tree.
