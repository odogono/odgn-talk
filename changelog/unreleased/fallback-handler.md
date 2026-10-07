---
type: feat
scope: spec
---
Add the Fallback Handler, `on any message m`, which takes the messages none of a Script's Handler Clauses matches before they climb the Message Path, and let a `send … with` list spread a list into its arguments, so a Fallback can forward any message (ADR 0064). Both Cores, the Lints and the editor grammar support them.
