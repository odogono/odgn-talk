---
status: accepted
---

# Hosts check values against Shapes with the Core's acceptance

A Host can build Shapes, but until now it couldn't check a value against one. A Host that wanted to check what it delivers or relays had to re-implement chapter 7's acceptance rules. The research for [#2057](https://github.com/odogono/odgn-talk/issues/2057) turned down Core-enforced message Shapes ([note](../research/host-enforced-message-shapes.md)). A check run by the Host gives most of that guarantee without adding Core state or changing the Group Fingerprint or the Trace ([#2195](https://github.com/odogono/odgn-talk/issues/2195)).

The embedding interface now offers `conforms(value, shape)` and `explain(value, shape)`. Both take a Shape the Host built with the Shape constructors.

- **Same acceptance, no Group.** They accept exactly what a Capability argument check accepts, which is also what the `conforms` and `explain` Built-ins accept. They are pure functions and need no Group, Script or budget, so nothing is charged and nothing is recorded in the Trace.
- **`explain` returns the Built-in's report as a Value.** That is a list of the same mismatch maps (`code`, `expected`, `got`, `value`, `path`, `alternatives`) a Script receives. Hosts already read Values, so one definition serves Scripts, Trace `mismatches` and Hosts. A Host-native structure for each embedding would add a second surface to specify and keep aligned in every language.
- **No `invalid shape`.** A Host's Shape constructors already refuse a bad Shape when it is built, so a check can't meet one. Only the Built-ins decode Shape data.
- **Elixir follows.** The Elixir embedding reaches the Zig Core only through the pinned reactor, so it gets the functions after a reactor release.

**Considered**

- *A Host-native report*, such as TS objects or Go structs. Rejected for now: it is more convenient to use, but it adds a second definition of the report.
- *A `check` that throws.* Left out: `explain(v, s)` returning an empty list covers it, and Hosts have their own error types.
