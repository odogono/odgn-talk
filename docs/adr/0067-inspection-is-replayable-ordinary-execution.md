# Inspection is replayable ordinary execution

`:describe` reads declaration metadata without executing user code. `:inspect` evaluates its expression once, then, for a Host Object, requests a generated Handler to read its declared properties. The two Runs use ordinary instructions, getters, output, Fuel and limits; the scheduling boundary between them is observable. This avoids a hidden reflection Built-in or privileged execution path. Settled in [#370](https://github.com/odogono/odgn-talk/issues/370).

Getter values are not passive metadata: getters can fail, create objects and queue Host actions. Session Transcripts therefore carry object declarations and identities, property outcomes and the queued actions needed for replay. Returned values alone cannot reproduce the execution. Incremental rows remain visible if a later getter faults. Documentation follows defining code identity, so stale Function Values never acquire a replacement function's docs. [The Session contract](../../spec/session-observation.md) defines the commands and replay envelope.

## Considered Options

- Passive property declarations only: safe metadata, but does not meet the requested runtime inspection.
- One privileged inspection Run: would require new reflection or execution machinery.
- Re-evaluate the expression for each property: repeats effects and can inspect different objects.
- Record getter results alone: loses deliveries, disposal and other actions made by the getter.
