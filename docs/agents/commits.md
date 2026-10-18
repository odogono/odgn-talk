# Commits and the changelog

PRs are squash-merged, so a PR's title becomes the commit on `main`. CI checks every PR title, and requires a changelog fragment for the changes a reader of the changelog would want to hear about. A `commit-msg` hook checks local commits' format. A `pre-push` hook checks that a fragment matches the branch's `feat`, `fix` or `perf` commits and that new ADR numbers are free on `origin/main`, then runs the lint, format and Spec checks CI runs. Both live in [`.githooks/`](../../.githooks/), and `bun install` turns them on.

## Subject format

```text
type(scope)!: Sentence-case imperative description (#issue)
```

- **type**, one of:
  - `feat`: a new or changed behavior, including a change to the language's semantics in the spec.
  - `fix`: a behavior that was wrong.
  - `perf`: the same behavior, faster or smaller.
  - `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`: no change a user would notice.
- **scope**, optional, one of `spec`, `ts`, `cli`, `tools`, `corpus`, `repo`. There is no scope per Core or app:
  - `repo` covers the Go, Zig and Elixir Cores and embeddings, CI and workspace changes.
  - `tools` covers `tooling/` (Folio, the Playground, the LSP, the formatter and Lints) and `tools/`.
  - `ts` covers the TS Core in `impl/ts/`.
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

To release `@northtalk/ts`, run `bun run release-notes:ts 0.1.1` before tagging `ts-v0.1.1`. It writes a dated `## [0.1.1]` section into `impl/ts/CHANGELOG.md`, after `## [Unreleased]`, from the fragments added since the latest `ts-v*` tag whose scope is `ts` or `spec`, or that are breaking. `--dry-run` prints the section instead. Fragments stay where they are, since other packages read them too. With no `ts-v*` tag yet, it fails, and the first section is written by hand.

Then bump `core` in `impl/ts/src/versions.ts` to `ts/0.1.1`, merge both, and push the `ts-v0.1.1` tag from `main`. The `TS publish` workflow (`.github/workflows/ts-publish.yml`) checks the tag matches the built version, runs the tarball checks and publishes with npm trusted publishing.

To check a PR the way CI does, run:

```sh
PR_TITLE="feat(ts): Add x" BASE_REF=main bun tools/commits/check.ts pr
```

`BASE_REF` is the branch name (`main`), without `origin/`; the checker adds the remote prefix.
