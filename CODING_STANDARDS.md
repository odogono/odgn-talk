# Coding standards

These rules, and the documents below, are the standards a review applies:

- [Commit and PR titles, changelog fragments](docs/agents/commits.md), with the [fragment format](changelog/README.md)
- [Domain terms and ADRs](docs/agents/domain.md)
- [Spec changes and their impact on each Core](docs/agents/spec-changes.md)
- [TS Hosts run on Bun and Node](docs/adr/0083-ts-hosts-run-on-bun-and-node.md): runtime-neutral TS uses `node:*` modules and web-standard APIs, not `bun:*`
- Each task map's per-area rules: [Go](impl/go/NAVIGATION.md), [Zig](impl/zig/NAVIGATION.md), [TS and tooling](impl/ts/NAVIGATION.md), [Elixir](impl/elixir/NAVIGATION.md), [Folio](tooling/creative/NAVIGATION.md)

## Documentation consistency

When reviewing a behavior change, reconcile existing descriptions of that behavior, including claims that it is missing or unsupported, and ADRs that describe it: amend the ADR, or supersede it with a new one. When one Core gains a feature, check the other Core's guide and `GLOSSARY.md` too: each tends to say what its peer lacks. Keep limitations beside the affected API or feature. When a PR adds a feature with its own ADR, or moves a feature's entry point, check that each affected Core's task map names the feature and its entry functions, not just its files. Track outstanding work in GitHub Issues; guides describe supported behavior rather than duplicating issue progress.

Keep current implementation support and limitations in the affected Core or tooling guide; link there from corpus and review notes. Review records describe evidence at a named commit/PR or date, with first-blessing approval separate from execution agreement. When work lands, reconcile pending-support claims and expectation headers with their approval records, and update the implementation issue’s remaining-work block.
