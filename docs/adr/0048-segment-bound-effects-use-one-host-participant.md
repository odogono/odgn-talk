# Segment-bound effects use one Host participant

A Segment may enlist one named Grant through synchronous Host begin, commit and rollback hooks. Its provisional effects follow the Segment's Script Variables, including preservation on ordinary errors. This extends [ADR 0006](0006-limit-faults-roll-back-the-segment.md): ordinary immediate effects remain final, while an explicitly Segment-bound Operation can coordinate its effects with Script rollback. Capability Scopes remain independent and can close resources inside that provisional participant ([#218](https://github.com/odogono/odgn-talk/issues/218), [#219](https://github.com/odogono/odgn-talk/issues/219)). The [Spec](../../spec/embedding/scoped-effects.md) holds the rules.

## Considered Options

- Scope abandonment alone cannot undo an explicit commit followed by a Limit Fault in the same Segment.
- Making every scope transactional imposes transaction semantics on locks and ordinary file handles.
- Multiple independent participants can partially commit. A distributed prepare/commit and recovery protocol is outside v1; two Grant aliases count as different participants even if their Host bindings happen to match.

## Consequences

- An uncaught ordinary error commits provisional effects when it preserves Script Variables. Cancellation rolls back the original Segment, then may commit a distinct cleanup Segment.
- Commit must have a definite outcome. Definite non-commit ends the Run as `effect failed`; ambiguous commit or failed rollback stops the Group because the Core cannot establish consistency.
- Staging a single file for publication is a valid participant; ordinary append and overwrite are not automatically reversible. This is execution atomicity, not crash recovery or atomicity with sends and unrelated immediate effects.
