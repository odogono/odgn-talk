---
status: accepted
---

# The Trace explains why no Handler Clause matched

Clause Shapes ([ADR 0171](0171-a-handler-clause-may-require-a-shape-of-a-parameter.md)) make a Script's Handler heads its message interface. When a message matches none of them, though, the Trace only says the Run ended `unhandled`, or that the Fallback Handler took it. Every tool that shows a Run, such as Folio, `northtalk test` and Trace replay, would have to guess why. It could re-run patterns and Guards to find out, but a Guard may read state that has since changed, and running one just to display it is what [#861](https://github.com/odogono/odgn-talk/issues/861) (point 8) rules out ([#2059](https://github.com/odogono/odgn-talk/issues/2059)).

The `run` record of a Run no named clause matched now carries `mismatches`:

```
run s/r6 outcome=unhandled delivery=d6 handler=move:to: mismatches=[{clause: 1, reason: "shape", argument: 2, mismatches: [{code: "wrong kind", expected: "number", got: "text", value: "e4"}]}] fuel=33 alloc=24
```

**What it holds**

- One map per named clause dispatch tried, in clause order: `clause`, and `reason`, the first test that failed: `arity`, `pattern`, `shape` or `guard`. This follows dispatch's own order: arguments, patterns, Clause Shapes, Guard.
- A `shape` entry adds the first failing argument, left to right, and exactly what `explain` gives for it. Dispatch stops at that Shape, so later ones are never tested.
- A `guard` entry never says why. Dispatch already ran the Guard and found `false` (or a `guard-skip`), so recording that costs nothing, but explaining it would mean evaluating parts of it again.

**Where and when**

- On the `run` record, not the `unhandled` record. A message climbing the Message Path ends a Run `unhandled` in each Script it reaches, and each Script's clauses explain their own Run, while the one `unhandled` record at the end of the path can't say whose clauses were tried. A Run the Fallback Handler took gets the same field, since its message matched no named clause either.
- Only when a named clause was tried. The Fallback's own clauses aren't listed.

**Cost: only while tracing, and free**

A Core keeps each clause's reason as it dispatches, and builds the `explain` report only when it writes the `run` record to a Trace. Nothing is charged, so Fuel, allocation and every outcome are the same with or without a Trace. Reports to the Host don't carry the field. A Host that wants it reads the Trace.

**Considered**

- A new `mismatch` record per clause is easier to grep, but adds a record kind for data that belongs to one Run.
- Explaining only Clause Shapes leaves a reader unsure whether an unlisted clause failed its arity, a pattern or its Guard. The reason word answers that for free.
- Charging for the report, so Reports could carry it, would change the Fuel of every existing unhandled case.

**Consequences**

- Chapter 11 gains the `mismatches` key and its section; chapter 5 points to it from dispatch.
- Existing Trace cases whose Runs end `unhandled` after trying a named clause, or start in the Fallback Handler, gain the field when the Cores implement it: TS [#2149](https://github.com/odogono/odgn-talk/issues/2149), Zig [#2150](https://github.com/odogono/odgn-talk/issues/2150). Their Fuel doesn't change.
- Tooling shows it in Folio and `northtalk test` ([#2059](https://github.com/odogono/odgn-talk/issues/2059)).
