---
status: proposed
---

# Folio's Instruments window edits authored parameters live during Play

The Instruments window was Edit only, so an author had to stop Play to change a sound and then start again to hear it. It now stays open during Play and docks in Perform. A change made there is an authored edit of the Instrument Parameter. It is kept with the Project and can be undone, with one undo step per drag, and the running Instrument hears it straight away, the same way a bound control's value reaches it ([#1904](https://github.com/odogono/odgn-talk/issues/1904)). A Script's `set` is unchanged: it changes the parameter only for that Play Session, so the window shows the playing value and marks the saved one.

This matches how Folio already treats editing during Play, where an edited Script is punched in at the next bar ([ADR 0157](0157-folio-punches-in-an-edited-script-at-the-next-bar.md)). Browse and Present still hide the window, because readers never change a Project's Instruments.

## Considered Options

- **Every change during Play is Play State.** This is simpler, and the window and Scripts would agree. It was rejected because a sound found by ear while the music plays would be lost when Play stops.
- **A "Keep" button that copies the playing values into the Project.** This was rejected because it would also keep values that Scripts set, which the author never chose.
