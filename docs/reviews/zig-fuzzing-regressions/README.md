# Zig fuzzing regression Trace approval

On 2026-10-14, the maintainer approved
[`cancellation/replaced-wait-state/case.trace`](../../../corpus/cancellation/replaced-wait-state/case.trace)
and
[`suspension/join-member-deadline/case.trace`](../../../corpus/suspension/join-member-deadline/case.trace)
in the issue-636 conversation: “i have looked at the reviews and they are both
ok”.

The first differential fuzzing with the Zig Core found both divergences
([#636](https://github.com/odogono/odgn-talk/issues/636)).

The `cancellation` Trace pins the Persistent State of a Run that a `replacing`
Handler cancels, while its cancellation waits to run. With no `finally`, the
replaced Run keeps no frame. With one, it keeps the Handler frame its cleanup
needs. The Zig Core had counted every frame; #849 fixed it.

The `suspension` Trace pins a Join Member's `maxPending` counting from the Pump
that started its call. A Fuel Slice preempts the Join before its `end`, and the
member times out in the Pump at its call's start plus 1000 ms, not its
suspension's. The Go and TS Cores had counted from the Join's `end`; #855 fixed
it for [#854](https://github.com/odogono/odgn-talk/issues/854).

Only the approval comments change in the Traces. TS, Go and Zig agreed on both
when blessed.

The first-blessing workflow is defined in
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
