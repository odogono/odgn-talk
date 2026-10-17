---
type: fix
scope: tools
---
In Folio's Play, Enter or Space on a focused button now only clicks it, without also sending `keyDown` to the Page, and a pointer click on a button returns focus to the Page, so a game's Space key no longer re-presses the last button clicked.
