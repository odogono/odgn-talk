# Commits and the changelog

PRs are squash-merged, so a PR's title becomes the commit on `main`. CI checks every PR title, and requires a changelog fragment for the changes a reader of the changelog would want to hear about. A `commit-msg` hook checks local commits' format. A `pre-push` hook checks that a fragment matches the branch's `feat`, `fix` or `perf` commits and that new ADR numbers are free on `origin/main`, then runs the lint, format and Spec checks CI runs. A `pre-commit` hook runs `bun run spec:check` when `GLOSSARY.md` or `spec/` is staged, so a stale generated file, such as Appendix A after a glossary edit, fails at commit rather than push; run `bun run spec:gen` and stage what it writes. After a pull, rebase or branch switch that changes `bun.lock`, the `post-merge`, `post-rewrite` and `post-checkout` hooks rerun `bun install --frozen-lockfile`. All of them live in [`.githooks/`](../../.githooks/), and `bun install` turns them on.

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

Then bump `core` in `impl/ts/src/versions.ts` to `ts/0.1.1`, merge both, and push the `ts-v0.1.1` tag from `main`. The `TS publish` workflow (`.github/workflows/ts-publish.yml`) checks the tag matches the built version, runs the tarball checks and publishes with npm trusted publishing. It then runs the tests of [`odogono/northtalk-ts-example`](https://github.com/odogono/northtalk-ts-example) against the published version under Node 24.10, the latest Node and Bun; a failed `verify` job means the release is broken.

To check a PR the way CI does, run:

```sh
PR_TITLE="feat(ts): Add x" BASE_REF=main bun tools/commits/check.ts pr
```

`BASE_REF` is the branch name (`main`), without `origin/`; the checker adds the remote prefix.

## Failed CI checks

Checks named `ci/woodpecker/...` run on Woodpecker, whose logs `gh` cannot show. `bun run ci:log <pr>` prints the failed steps' logs of a PR's failing Woodpecker checks; it also takes a check's link, `--step <name>` and `--tail <lines>` ([`tools/ci/log.ts`](../../tools/ci/log.ts)). For a GitHub Actions check, use `gh run view <run-id> --log-failed`. [The CI guide](../../tools/ci/README.md) lists which workflow runs where.
