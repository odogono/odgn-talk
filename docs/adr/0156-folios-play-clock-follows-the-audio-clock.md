---
status: accepted
---

# Folio's Play clock follows the audio clock

Folio is to live-code music ([#1887](https://github.com/odogono/odgn-talk/issues/1887)). A note must sound on its exact sample, but a Play Session's events land wherever the Pump that runs them does. `wait` fires at the next Pump and `frame` follows `requestAnimationFrame`. A timing prototype ([#1888](https://github.com/odogono/odgn-talk/issues/1888)) measured a Play worker that pumps against an `AudioContext` and posts timestamped commands to an AudioWorklet. The worklet placed every command on its sample. The Pump woke 5–6 ms late at the median and 10–13 ms late at p99, so the sound is exact only if its time doesn't come from when the Pump ran.

So in every Play Session, the Play clock is the session's audio clock (`AudioContext.currentTime`) plus a **safety margin**. `frame`, `wait`, `beat` and every sound share this one timeline.

- **Pumping:** Folio's Play worker pumps at each Pump's `nextDeadline` and at each `beat`'s delivery time, whichever is earlier. The page sends the worker the audio clock paired with `performance.now()`, and the worker extrapolates between those readings. Sound commands go from the worker to the worklet over a `MessageChannel`, never through the main thread.
- **A sound's time is in Play-clock seconds.** The worklet plays it at that audio time. A command that arrives late plays at once.
- **`beat` arrives one lead ahead.** The Transport ([#1892](https://github.com/odogono/odgn-talk/issues/1892)) delivers each `beat` one **lead** before its musical time. A sound played by a Run that a `beat` started sounds at that beat's musical time plus any offset the Script asks for. Folio finds that beat from the call's Delivery ([ADR 0125](0125-a-host-functions-call-names-the-delivery-that-started-its-run.md)). This is the beat's scheduled delivery time plus the lead, never `Call.Now()` plus the lead. `Call.Now()` is the time the Pump ran, which is late by however late the worker woke. The prototype measured up to 13.6 ms of error that way, against at most one sample when timed from the Delivery.
- **Runs started by `send`** have no beat Delivery. They give an explicit `at` when the timing matters.
- **Input sounds now plus margin.** A sound from a Run started by reader input, or from any Run without a beat or an `at`, plays at `Call.Now()`, which is already the audio clock plus the margin.
- **Musical waits go through the Transport.** `wait` restarts from a late `Call.Now()`, so chained `wait`s drift. The prototype measured about 6 ms per `wait`. Beat-length waits are a Transport Operation, as #1887 decided.
- **Pause** suspends the `AudioContext`. The audio clock stops, so the Play clock stops with it, and commands already queued in the worklet keep their times. On Resume, beats continue on the same grid. A Step stays a silent frame Step: Folio adds one frame interval to a step offset without starting the audio. The Play clock is the audio clock plus the margin plus that offset, and Folio subtracts the offset when it hands a sound's time to the worklet, so the clock never goes backwards. Beat Step comes later.

**The values:** a margin of **15 ms** and a lead of **100 ms**.

| Margin                           | 0 ms | 2 ms | 5 ms | 10 ms | 15 ms | 20 ms |
| -------------------------------- | ---- | ---- | ---- | ----- | ----- | ----- |
| Late "sound now" commands, of 40 | 23   | 15   | 1    | 0     | 0     | 0     |

With a 15 ms margin, a 50 ms lead lost one beat once a Pump took 30 ms, and almost every beat once Pumps took 60 ms. A 100 ms lead stayed clean with 30 ms Pumps. The lead only moves when a `beat` Run happens, not when its sound plays, so a long lead costs only how soon a change made in that Run can take effect. These are Chromium figures on macOS (48 kHz, 24 ms output latency). The worker kept time with its tab hidden for 29 s.

This amends [ADR 0128](0128-folio-pauses-a-play-session-on-a-virtual-host-clock.md). The Play clock is no longer Host time minus paused time. Pausing still stops it and it still never goes backwards, but the audio clock does both. A Step still moves it one frame interval.

## Considered Options

- **Keep the virtual Host clock and convert at the worklet:** two clocks drift apart, and every Pause, Resume and Step would have to keep the conversion in step.
- **Time `beat` sounds from `Call.Now()` plus the lead:** simplest for the Host, but sounds then jitter by the Pump's wake lateness, which was up to 13.6 ms in the prototype.
- **Schedule from the main thread:** a hidden tab throttles main-thread timers. The worker's timers kept time while the tab was hidden.
- **A shorter lead (50 ms):** it lets a `beat` Run's changes take effect sooner, but a 30 ms Pump already loses a beat.

## Consequences

- A Pump may take up to about `lead + margin − 15 ms` before a beat sounds late. That is roughly 100 ms with these values.
- Click-to-sound latency is about the margin plus the device's output latency.
- The Performance window can count late sound commands, which shows when a Project's Pumps outgrow the lead.
- Untested: Firefox, Safari, slower machines, and tabs hidden past Chrome's five-minute intensive throttling.
