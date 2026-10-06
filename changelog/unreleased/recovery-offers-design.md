---
type: feat
scope: spec
---
Specify Recovery Offers (ADR 0060): a Library declares named `offer` blocks and a caller's `catch … before unwind` chooses one with `choose offer`, keeping the Library's accumulated work. Every catch now tests its pattern and Guard before unwinding, so a catch that rejects an Error no longer discards its callers' recovery options. Includes worked examples and a complete machine, cost, save and Trace contract; implementation in both Cores and tooling is a separate follow-up, and the active language version and executable catalogues are unchanged.
