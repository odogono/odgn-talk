## Agent skills

### Issue tracker

For issue work, start with [repository identity and issue conventions](docs/agents/issue-tracker.md).

### Commits

PR titles follow Conventional Commits, and `feat`, `fix`, `perf` and breaking changes add a changelog fragment. See `docs/agents/commits.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout with root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Implementation navigation

On a fresh worktree, run `bun install --frozen-lockfile && bun run unicode:check` before any test, lint or push.

For implementation work, start with [the layout](README.md#layout), then the task map: [Go](impl/go/NAVIGATION.md), [Zig](impl/zig/NAVIGATION.md), [TS and tooling](impl/ts/NAVIGATION.md), [Elixir](impl/elixir/NAVIGATION.md) or [Folio](tooling/creative/NAVIGATION.md).

### Review

When reviewing behavior changes, apply [the documentation standard](CODING_STANDARDS.md).
