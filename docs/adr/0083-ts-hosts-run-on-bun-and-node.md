# TS Hosts run on Bun and Node

The TS packages that need a server runtime, such as `@northtalk/ts/sqlite`, `@northtalk/ts/http` and the Example Hosts, support Bun and Node only. Their runtime-neutral code stays on `node:*` modules and web-standard APIs, not `bun:*`, so it runs unchanged on both. With Deno discontinued, the maintainer decided on 2026-10-13 that it is no longer a supported runtime. The browser bundle, which runs without a server runtime, is unaffected.

The published `@northtalk/ts` package supports Node 24.10 or later across all entry points. One package-wide minimum aligns npm's engine declaration with the SQLite implementation's requirements, accepting the loss of declared support for older Node versions in Core-only applications. Browsers support every subpath except `/sqlite` and `/http`; `/notify` remains browser-compatible.

## Considered Options

- **Keep Deno as a third runtime:** it costs a CI job, a runtime probe in every runtime test, and workarounds such as the probe for Deno 2.9's `iterate`, which ended quietly on a failed step. A discontinued runtime gains no new users to justify that cost.
- **Per-entry-point Node minimums:** the Core can work on older Node versions, but npm declares engines for the package as a whole. A single minimum gives every Node consumer the same support promise.
- **Bun only:** Bun runs the repo's tools and tests, but Node is the runtime most Hosts embed in. `node:sqlite`'s `setAuthorizer` already sets Node 24.10 as the floor, and checking Node costs one test file per kit.

## Consequences

CI runs the sqlite and router kits under Bun and exact Node 24.10.0. The installed-tarball check also runs at that Node floor and exercises a SQLite query through the public Capability API. Code that worked around Deno is removed: `query` now always stops after `max + 1` rows with `iterate`. Code may still run under Deno, but nothing checks it, and a Deno-only failure is not a bug.

A Host on Deno must stay on an earlier release or test its own use. Other server runtimes need a new decision.
