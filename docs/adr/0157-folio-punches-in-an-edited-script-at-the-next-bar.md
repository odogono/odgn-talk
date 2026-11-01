---
status: accepted
---

# Folio Punches In an edited Script at the next bar

Live-coding music ([#1887](https://github.com/odogono/odgn-talk/issues/1887)) means changing a Script while it plays, without stopping the music. Today a running Play Session never picks up an edit, though the Core's Reload can carry Script Variables and the mailbox ([ADR 0143](0143-a-restore-may-reload-only-the-scripts-whose-code-changed.md)). So Folio gains **Punch In**: ⌘↩ in the Code Browser, or a menu command, loads the edited Script into the running Play Session.

```talk
on openScript
  loop "bd [hh hh] sd hh"     -- edit this line, press ⌘↩, and the new groove starts on the next bar
end openScript
```

- **Where:** in Browse, for every Script. Present-mode performance comes later.
- **When:** at the next bar of the Transport if the Script keeps musical time, meaning it declares an `on beat` Handler or owns a Sound Pattern. Any other Script is Punched In straight away.
- **What it keeps:** a Reload that carries the Script Variables and keeps the mailbox. The Script's Runs are discarded and its Sound Patterns released. Folio then sends the Script `openScript`, which it also sends when a Script first loads. The Sound Patterns its new code starts begin on the same bar, so the music doesn't skip.
- **The edit is an ordinary authored edit:** it is saved and undoable like any other, and Punch In only also applies it to the session.
- **Failure keeps the music:** if the new code fails to load, the old code keeps running and the failure shows in Errors. A bad edit never stops the music.
- **Libraries:** Punching In a Library reloads every loaded Script that imports it, on one bar. If any of them fails to load, none changes.
- **A Script that isn't loaded,** such as one on another Page, only has its edit saved, and Folio says so.
- **While Paused,** it waits for the next bar after Resume. **While the Script has a Stopped Run,** it's refused with "Resume first", since a Reload would discard the Run being debugged.

## Considered Options

- **Reload on every save, as Strudel does on evaluate:** a half-typed line would reload a Script mid-thought. An explicit command lets an author choose the moment.
- **Fix and Continue ([ADR 0072](0072-fix-and-continue-is-a-session-command.md)):** it rewinds a paused Run, which suits debugging. A Script playing music has no paused Run, and rewinding a beat Run would replay notes.
- **Keep Runs across the Reload:** their frames point into the old code.
- **Always apply at once:** a groove swapped mid-bar lands out of phase.
- **Apply at the next beat rather than bar:** a Sound Pattern's cycle is a bar, so a beat boundary would start new patterns partway through their cycle.

## Consequences

- A Script that wants its music to survive Punch In starts its Sound Patterns in `openScript`.
- Discarding Runs ends any `wait` in progress. A Script that counts bars in a Variable keeps counting.
- Punch In's Reload goes through the same Grant release as Stop, which is how the old Sound Patterns are released.
