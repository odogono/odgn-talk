---
type: feat
scope: repo
---
Let Elixir Host Grants share a Segment Coordinator. A Capability may define
`coordinator/1`, or pass `coordinator:` to `Capability.from_functions/3`, to map
each Grant's binding to a shared hook, so Grants from one or several
Capabilities join one Segment participant, as TS and Go allow (#1990).
