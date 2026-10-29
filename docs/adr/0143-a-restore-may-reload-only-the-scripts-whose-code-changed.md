# A restore may reload only the Scripts whose code changed

[ADR 0111](0111-snapshot-sources-may-come-from-the-host.md) lets a Host keep only its current sources, but a restore against changed code then discards every Script's continuations, even those whose code matched ([#1701](https://github.com/odogono/odgn-talk/issues/1701)). We add an opt-in `onMismatch: 'reload changed'` policy for a Partial Restore: when the only mismatch is Script code identity (base source, ordered extensions or an imported Library), the Scripts whose code matches exactly continue, and each changed Script is rebuilt from its new code as a Reload with `CarryVariables` would leave it. Its saved Runs, mailbox and pending calls are listed as discarded, dropped and abandoned, as a variables-only restore lists them, and no Host lifecycle hook runs, since that state never came live in the new Group. Matched Scripts see exactly what a Reload of the changed Scripts would give them: `send failed` for waits on them, stale Function Values homed in them, and cancelled Decision recipients. Any other mismatch, or a Grant mismatch, falls back to a whole-Group variables-only restore, and a changed Script that fails to load or exceeds its cap fails the whole Restore. The result keeps `variablesOnly` and adds `reloaded`, so the change is additive.

## Keeping the mailbox

Added for [#1709](https://github.com/odogono/odgn-talk/issues/1709): a `keepMailbox` restore option, meaningful only with `'reload changed'`, keeps every changed Script's saved mailbox, as Reload's `keepMailbox` does. Its messages go to the new code in order ([ADR 0068](0068-a-run-in-its-first-segment-can-be-rewound-to-its-delivery.md)), their senders go on waiting, a queued Decision or Broadcast recipient stays open, and none is listed as dropped. Runs and pending calls are still discarded, and a recipient whose Run had begun is still cancelled. The kept messages count toward the Persistent State cap. It is one flag for the whole restore, since the Host doesn't know which Scripts changed until the restore returns, and it is ignored, not refused, under any other policy or a variables-only fallback; the Trace's `restore` record has `mailbox=keep` when it was asked for. The save format and the fingerprint don't change.

## Considered Options

- **Keep old sources in every save, or in a Host catalogue, and restore-then-Reload.** It needs no new rule, but it brings back the storage cost ADR 0111 removed, or moves it onto every Host.
- **Restore fully, then run a live Reload.** The changed Script's frames point into code the Host no longer has, so they can't be restored, and a live Reload would call Grant release and Segment rollback hooks for state that was never live.
- **Change `'variables only'` itself.** That would silently change what restore keeps for existing Hosts.

## Consequences

The rule is part of parity for both snapshot modes: an Embedded-source Snapshot reaches it through a changed Library, so every Core implements it, and the corpus tests it that way.
