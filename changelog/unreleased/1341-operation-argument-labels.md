---
type: feat
scope: repo
---

Let an Operation Declaration declare Argument Labels, so a call may write them between its arguments, as in `ask world to move "pass" to "red hangar"`, in every Core, the Elixir Host and the language server. The comma-separated call stays valid, labels are checked at load as `wrong labels`, and a labelled `command` Operation also has a labelled Host Command spelling (ADR 0115, #1341).
