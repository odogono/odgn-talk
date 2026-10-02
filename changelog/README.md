# Changelog fragments

Each PR whose title is `feat`, `fix` or `perf`, or marks a breaking change, adds one fragment to `unreleased/`. The file name is any slug, such as `store-capability.md`:

```md
---
type: feat
scope: ts
---
Add the Store Standard Capability with segment-bound writes (ADR 0050).
```

- `type` is `feat`, `fix` or `perf`, the same as the PR title's.
- `scope` is the PR title's scope. Leave it out when the title has none.
- `breaking: true` marks a breaking change. A breaking `refactor!` or similar uses the closest of the three types.

The text after the frontmatter is the entry, written for someone reading the changelog. `bun run changelog` prints every fragment as one `## Unreleased` section. [The commit conventions](../docs/agents/commits.md) describe when a fragment is needed.
