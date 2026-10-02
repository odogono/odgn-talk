# Commits and the changelog

PRs are squash-merged, so a PR's title becomes the commit on `main`. CI checks every PR title, and requires a changelog fragment for the changes a reader of the changelog would want to hear about. A `commit-msg` hook checks local commits' format; `bun install` turns it on.

## Subject format

```text
type(scope)!: Sentence-case imperative description (#issue)
```

- **type**, one of:
  - `feat`: a new or changed behavior, including a change to the language's semantics in the spec.
  - `fix`: a behavior that was wrong.
  - `perf`: the same behavior, faster or smaller.
  - `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`: no change a user would notice.
- **scope**, optional, one of `spec`, `ts`, `cli`, `tools`, `corpus`, `repo`.
- **!**, before the colon, marks a breaking change. A `BREAKING CHANGE: ...` line in the PR body does too.
- The description starts with a capital letter and doesn't end with a full stop. End it with the issue it closes, as `(#131)`.

Examples:

```text
feat(spec): Make the Store a Standard Capability (ADR 0050)
fix(ts): Keep a Timer's deadline across restore (#196)
refactor(ts)!: Rename the Host report fields
ci(repo): Enforce Conventional Commit titles and changelog fragments
```

The hook lets through `fixup!`, `squash!` and `amend!` commits, and the merge and revert commits git writes itself.

## When a changelog fragment is needed

A PR whose title is `feat`, `fix` or `perf`, or marks a breaking change, adds a fragment under `changelog/unreleased/` whose type and scope match the title. [The fragment format](../../changelog/README.md) describes the file. There is no way to skip this: a change with nothing worth recording has the wrong type, so retitle it.

To see the unreleased changelog, run `bun run changelog`.

To check a PR the way CI does, run:

```sh
PR_TITLE="feat(ts): Add x" BASE_REF=main bun tools/commits/check.ts pr
```
