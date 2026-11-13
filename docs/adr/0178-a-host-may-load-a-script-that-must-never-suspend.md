---
status: accepted
---

# A Host may load a Script that must never suspend

Some Hosts run Scripts as pure predicates. They call a Handler, read its answer, and keep every wait in their own durable storage, never in a suspended Run. Such a Host needs any source that could park a Run in memory to be refused when the Script is checked, so that its editor can show the problem and publishing can refuse it. The loader already knows every possible Suspension Point ([ADR 0004](0004-scripts-are-actors.md)), but it refuses them only in `finally` blocks, Recovery Catches and functions ([#2237](https://github.com/odogono/odgn-talk/issues/2237)).

`Load` now takes `forbidSuspension`, off by default. A Script loaded with it is refused if it contains any possible Suspension Point.

- **Every Suspension Point, not only `wait`.** The option refuses `wait d`, `wait for`, `wait` in Musical Units, `ask … and wait`, `send … and wait`, `f(x) and wait`, Joins, and Command Calls to Handlers that may suspend, including those reached through a Library. Forbidding only the `wait` statement would leave `send … and wait` parking a Run in memory, which is the thing such a Host has to rule out. Every Suspension Point is already marked by `wait` in the source, so "no `wait`" and "no Suspension Point" read the same to a Script's author.
- **The existing `can't suspend here`.** That code already means a possible Suspension Point where none is allowed, and it is reported at the Suspension Point or at the call through which one is reached. The Host knows it set the option, so a new code would tell it nothing new.
- **Per Script, at Load.** A Group may hold both Scripts that must not suspend and Scripts that may. Reload, Extend, Library replacement and Partial Restore keep the option, so a later change can't add a Suspension Point. A Library replacement that would break such a Script is refused as a whole, like any other failed recheck.
- **Saved and fingerprinted.** Unlike `grantsAsUsed`, which is applied once at Load, this option has to still hold after Load. So a save lists the Scripts that have it, the Group Fingerprint includes it, and the Inspection shows it. The list is an optional save section, and the Fingerprint names the option only when it is set. That way a save from before the option reads as having none, and existing Fingerprints don't change. A Core that predates the option skips the section, computes a Fingerprint without the option, and so treats the save as a mismatch that the Host's restore policy decides. Under `RejectMismatch` that is `save mismatch`, never a full restore that quietly drops the option.

**Considered**

- *Forbidding only the `wait` statement.* Rejected, because it lets a Run suspend through `send … and wait` or a Join.
- *A Group option*, like the musical clock. Rejected, because it is coarser than Hosts need, and nothing about the option belongs to the Group as a whole.
- *A new diagnostic code.* Rejected, because the rule that is broken is the one `can't suspend here` already names.
- *A new required field on each saved Script.* Rejected: it would need a save-format version bump, and every Core refuses a save of another version, so every existing save would stop restoring.
- *A Host Manifest field*, so that tooling flags a Suspension Point while the author types. Left for later: the Core's refusal at Load is the guarantee, and a manifest field can follow when a Host's editor needs one.
