# Session extension Lambda display evidence

Implementation for #424, checked on 2026-10-08 against the specification at
`0d6fda8` (chapter 11, Function Values).

The Go printer repeated the Home Script in an extension Lambda's display:
`<function session:session+1:3:5>`. The corrected display is
`<function session+1:3:5>`, matching TS and chapter 11. The stored Home Script
and code location remain unchanged, preserving ownership and equality.

The new [Session Transcript](../../../corpus/sessions/extension-lambdas/session.transcript)
and [Trace](../../../corpus/sessions/extension-lambdas/case.trace) agree on both
Cores, including independent ordinary and save/restore Trace replay. They pin
an uncaptured Lambda in extension 1 and a nested Lambda in extension 4 capturing
`k: 3`. Both values retain their display and callable behavior after explicit
`:save` and `:restore`.

The two source lines become line 3 in their extension units because the Session
Host prepends a Script Variable declaration and an Entry Handler head. The
inner `given` is at column 14. The Trace also pins the Function Values in `vars`.

The Go passing gate and the TS corpus tests require the new case. Current Go
support is described in the [Go guide](../../../impl/go/README.md#console-standard-capability).

First-blessing approval is separate from execution agreement. Both expectation
files retain their `Unblessed` markers pending maintainer review. No existing
expectation was changed.
