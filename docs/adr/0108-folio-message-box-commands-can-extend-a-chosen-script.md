---
status: accepted
---

# Folio Message Box commands can extend a chosen Script

For [#1208](https://github.com/odogono/odgn-talk/issues/1208), the Message Box lets an author inspect and deliberately change a loaded Script's live state while browsing. Its own target selector offers the existing ownerless context as the default and the currently loaded Scripts; it does not depend on the Variables window. A targeted command uses the Script's variables, Grants and object bindings, so its effects have the same authority and ownership as that Script's code.

This amends [ADR 0093](0093-folio-browses-in-place.md)'s rule that every browsing command runs as a fresh ownerless Script. A targeted command instead uses Extend to add a generated Handler to the chosen Script and requests that Handler. This reuses the Core's existing scope and execution rules rather than adding a separate evaluation mechanism. The extension changes the Script's code identity and remains until that loaded Script is replaced or unloaded; it does not change authored source. Page and Element Scripts unload on navigation, while the Project Script survives it. Execution remains in the Play worker under [ADR 0107](0107-folio-play-runs-in-a-supervised-worker.md).

Commands can change existing Script Variables, but do not implicitly add persistent Script Variables as a chapter 12 Session Host does. New command-local variables belong to that command. Persistent declarations remain in authored source and take effect in the next Play Session.

The input accepts statements and expressions, not Handler definitions or other Script-level declarations. Ordinary local-variable rules apply, including an unknown assignment root becoming a temporary local: assigning to `scor` does not change a Script Variable named `score`. There is no special assignment syntax for this feature.

The selected target identifies a particular loaded Script in a particular Play Session. If it unloads, submission is disabled until the author explicitly selects another context. Returning to the same Page does not silently select its newly loaded Script. Each submitted command retains its target and session identity, and its results and errors stay attached to that command. Recalling a command restores its text and target; an unavailable target requires explicit reselection.

Targeted commands execute as ordinary Runs, including waits and normal interleaving with other work. Selecting a Script does not pause it or freeze its state. Ordinary execution and rollback rules apply: an error does not promise whole-command rollback or undo, and effects from completed Segments can survive a later failure.

The author can submit another command while an earlier one waits. This feature adds no per-command cancellation. Closing the Message Box only hides it; stopping Play ends its commands with the session. When Play ends, a selected Script becomes unavailable. The author must explicitly select the default context before running an Edit-mode command, so a command intended for temporary Play State cannot silently become an authored edit.

History keeps up to 50 commands across Play Sessions within the same Project and is cleared when switching Projects. Commands from previous sessions retain their unavailable targets and require explicit reselection. History is temporary and disappears on application reload.

Completion and diagnostics use the selected loaded Script's scope, even when its authored source has since changed. Submitted-code errors point into the command; errors inside authored Handlers identify their actual source. This keeps generated extension positions from becoming misleading links into authored code.

Identical command text reuses its generated Handler within the same loaded Script. Folio allows at most 1,000 distinct generated command Handlers per loaded Script: at the cap, existing commands can still run, but submitting a new command requires restarting Play. Extend retains code and makes subsequent compilation examine accumulated units, so this bounds command accumulation without automatically reloading a Script and disturbing its live state.

These decisions define the design for #1208; they do not claim that the feature is implemented.
