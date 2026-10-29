---
type: feat
scope: tools
---

Add Pause on errors to Folio's Errors window, off by default: while browsing, a Run stops at the statement raising an error no `try` catches, before it unwinds, as at a Breakpoint. The TS Core's debug controller gains `pauseOn({ uncaughtError })` for it (#1770).
