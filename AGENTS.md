## Agent skills

### Issue tracker

For issue work, start with [repository identity and issue conventions](docs/agents/issue-tracker.md). Read an issue with `gh issue view <number> --json number,title,body,state,labels,comments`; `--comments` alone prints nothing for an issue without comments.

### Commits

PR titles follow Conventional Commits, and `feat`, `fix`, `perf` and breaking changes add a changelog fragment at `changelog/unreleased/<slug>.md` whose `type` and `scope` front matter copy the title. See `docs/agents/commits.md`, which also covers the git hooks and reading a failed CI check with `bun run ci:log <pr>`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout with root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Implementation navigation

On a fresh worktree, run `bun install --frozen-lockfile && bun run unicode:check` before any test, lint or push.

For implementation work, open the area's task map: [Go](impl/go/NAVIGATION.md), [Zig](impl/zig/NAVIGATION.md), [TS and tooling](impl/ts/NAVIGATION.md), [Elixir](impl/elixir/NAVIGATION.md) or [Folio](tooling/creative/NAVIGATION.md). These and this file are the only agent guides; [the layout](README.md#layout) covers the other directories. A language change (Data Files, grammar, lowering) also touches [the consumers in spec-changes.md](docs/agents/spec-changes.md).

### Review

When reviewing, apply [the coding standards](CODING_STANDARDS.md), which index every rule a review checks.
