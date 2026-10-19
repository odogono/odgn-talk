# Library code may wait for messages to the calling Run's Script

A Library Handler may use `wait for`, in its one-line and block forms, and a Join. Its `wait for` observes the messages dispatched to the Script whose Run is executing it, at any depth of Library calls, exactly as the same wait written in that Script would. Before this ([#1342](https://github.com/odogono/odgn-talk/issues/1342)), both were load errors in Library code (ADR 0020). So a Host's shared "prompt, then wait for an answer or a timeout" helper, such as Mercenary's purchase confirmation, could share its prompt but not its wait, and every Script repeated the event, its Guard, its timeout and the result.

ADR 0020 rejected letting `me`, `the target` and `wait for` take their caller's meaning in a Library, because the Library would depend on who called it through dynamic scope. That holds for names: `me` and `the target` would let Library code read and address the caller's objects, and they stay load errors. A `wait for` names nothing of its caller. It registers a Wait on the Run it is already part of, which is how a Library's `wait d` and `ask … and wait` already work, and a Capability's answer already depends on the calling Script's identity. Observation doesn't change: the wait doesn't consume or buffer a message, the Script's Handlers still receive it, and waits resume in the order they began across the Script's Runs. So a Library adds no mailbox, state or Run of its own.

A Library may not name a Script in `from`. A bare Name there would name a Script of the importer's Group, so a Library compiled once for every Group would depend on what its importers' Groups hold. A `from` whose operand resolves in the Library, such as a parameter, is evaluated in the caller's Run as usual. Since a Script isn't a value, that operand can only be a Host Object, so a Library wait can filter by Target but not by sender Script.

## Considered Options

- **Keep the ban and document a callback.** A Library Handler can already call a Script's Lambda with `waiter() and wait`, and the Lambda's `wait for` runs in its Home Script, the caller. But the event, Guard and timeout then live in every caller's Lambda, which is the part the helper exists to share, and a Timeout Block in the Library can't bound `waiter() and wait` (ADR 0073).
- **Pass the Script to wait on explicitly** (`wait for pressed key at s`). Only the calling Script would be a valid argument, so it adds an error case and a way to obtain the Script without adding any safety. It would also need `me` in the caller.
- **A Host Capability for each interaction.** It moves Script-level control flow into Host code, and each Host writes it again.
- **A helper Script with `send … and wait`.** It adds a Run and a Delivery, and the helper, not the caller, receives the messages it waits for.
- **Allow `wait for` but keep Joins banned.** A Join of `ask … and wait` uses nothing a Library can't already use one call at a time, and the spec never listed Joins as a Library load error. Only the Cores' checkers rejected them.

## Consequences

- **Spec:** chapter 7 moves `wait for` and Joins to what Library code may use, and adds `from` with a bare Name to its load errors. Chapter 5 says which Script a Library's `wait for` observes. The `not in a library` diagnostic loses `wait for` and gains a Script name in `from`.
- **Cores:**
  - Each Core's checker drops the rule.
  - The Go Core tests a waiting Run's Guards and `when` patterns from the waiting frame's code unit, not the Script's.
  - The TS Core runs those tests in that code unit too, so a Library's Constants and patterns resolve.
  - The Zig Core already recorded the code unit with the Wait.
  - Saves already record frames by code unit, so the save format doesn't change.
- **Corpus:** `libraries/wait-for` and `libraries/wait-for-lifecycle` cover:
  - a shared confirmation helper
  - concurrent Runs and Scripts
  - nesting through another Library
  - a Script's waiting Lambda called from Library code
  - a Library Join
  - cancellation and a Library Timeout Block
  - Library replacement discarding a waiting Run
  - save and restore at every Pump
- **Unchanged:** `me`, `the target`, `pass`, `veto`, `send`, well-known object names, `script variable` and Fallback Handlers stay load errors in Library code, and functions still never suspend.
- **Elixir** runs the Zig Core through its reactor, so it gains this when the reactor is next pinned.
- Narrows [ADR 0020](0020-scripts-share-code-through-stateless-libraries.md).
