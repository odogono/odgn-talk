# Authored Projects are separate from temporary Play State

The planned [browser creative tool](https://github.com/odogono/odgn-talk/issues/154) saves the authored Project, while each Play Session starts from that Project and keeps its changes in temporary Play State. Returning to Edit discards Play State, so trying a Script, entering rich text or deleting an Element during Play cannot silently rewrite the author's work. We chose this boundary over always-live document mutation or an offer to adopt Play changes because predictable experimentation matters more for the initial audience than saving reader progress or turning execution results into authored content.

## Consequences

- Autosave and portable Project export preserve authored content and assets, independently of reader input, Script Variables and dynamically created or deleted Elements.
- Navigating within one Play Session preserves Page visuals but stops outgoing Page/Element Scripts and owned audio; revisiting restarts those Scripts. Project Scripts continue and hold shared story state. Leaving Play discards both kinds of state.
- A Project file is not a Script Snapshot. The Core's [same-Core save/restore feature](0008-same-core-save-restore.md) remains unchanged; this Host does not offer saved reader sessions in its first version.
- The product specification and delivery gate live in #154, blocked by [both-Core conformance](https://github.com/odogono/odgn-talk/issues/141). This decision records future Host policy, not implemented behavior or a change to the language Spec.
