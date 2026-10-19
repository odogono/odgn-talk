# Woodpecker CI

The initial Woodpecker workflows supplement GitHub Actions:

- `.woodpecker/linux.yaml` runs TS core tests, its build and Corpus, and Go vet,
  tests, race tests and Corpus in Linux containers.
- `.woodpecker/macos.yaml` builds and checks the Zig sidecar on native Apple
  Silicon macOS.

These workflows do not yet cover the complete Actions matrix, including the
package/browser checks, tooling checks, Go SQLite module, fuzz campaigns,
Elixir, WASI, generated-file gates and Linux ARM runtime checks. Keep the Actions
requirements until equivalent coverage is available.

## Linux worker image

Build this image on each Linux Docker worker before enabling the workflow:

```sh
docker build -t odgn-talk-ci:2026-10-19 tools/ci
```

The image contains Bun 1.4.2, Node 22, Go 1.27.2 and the C compiler needed for
Go race tests. Change its tag in both the build command and workflow whenever
the image changes. Woodpecker uses the existing local image by default.

The TS suite has a 30-second per-test timeout to accommodate the slower shared
VPS CPUs; its assertions are unchanged.

The workflow selects an agent with `platform=linux/amd64` and `backend=docker`.

## Native Mac worker

Use Woodpecker's `local` backend with native `darwin/arm64` binaries. Its `PATH`
must contain Bash, Git, Git LFS, `plugin-git` 2.10.1, Bun, Go, Zig 0.17.0 and Python 3.
Bun and Go are needed for the repository's Unicode bootstrap check.

Configure the Mac agent with a mandatory `!backend=local` label so only workflows
explicitly requesting the native backend can run there. Restrict both agents
to this repository with `repo=odogono/odgn-talk`.

The installed Mac LaunchAgent runs while its user is logged in and the machine
is awake.

The native backend executes code directly as its OS user. Keep approval required
for fork pipelines, and review their code and workflow before approving them.
These workflows do not need trusted volume, network or privileged capabilities.

## Connecting GitHub

Configure a GitHub OAuth App with the server's public HTTPS URL as its homepage
and that URL followed by `/authorize` as its callback. Store credentials on the
server, outside this repository. Activate `odogono/odgn-talk` in Woodpecker and
enable pull-request events.

Workflows run for pull requests, pushes to `main`, and manual runs. They must be
present in the revision being built. For a PR opened before activation, trigger
a new event or start a manual pipeline after the workflow files are available.

Only make Woodpecker checks required after a GitHub-triggered pipeline has
reported the expected statuses. Existing Actions requirements remain separate.
