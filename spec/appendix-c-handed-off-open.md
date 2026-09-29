# Appendix C: Handed off open

_Draws on:_ [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md).

These are left open at handoff, on purpose. Everything else is written before it.

- **Cost Model 1:** its rates are calibrated against both Cores once they pass the seed corpus. Until then, `costs.toml` holds the provisional Cost Model 0. Language 1.0 is declared once Cost Model 1 exists.
- **The TS Core's debug-pause hook:** the debugger pauses a whole Script Group at an instruction boundary ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)). The hook it pauses through is left to the TS Core.
- **A tree-sitter grammar:** optional, for editors that want one. Like all tooling, it is not normative.
