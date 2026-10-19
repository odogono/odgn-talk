# Woodpecker CI

The initial Woodpecker workflows supplement GitHub Actions:

- `.woodpecker/linux.yaml` runs TS core tests, its build and Corpus, and Go vet,
  tests, race tests and Corpus in Linux containers. After the shared workspace
  bootstrap succeeds, TS and Go run in parallel.
- `.woodpecker/macos.yaml` builds and checks the Zig sidecar on native Apple
  Silicon macOS.
- `.woodpecker/spec.yaml` runs the Spec workflow's lint, formatting and complete
  `bun run check` gates, including generated tables and documentation checks.
- `.woodpecker/tooling.yaml` runs the TS workflow's stack and tooling jobs:
  workspace typechecking, generated Lints, CLI/editor/Folio/extension tests,
  builds and Node runtime checks.

These workflows do not yet cover the complete Actions matrix, including the
Conventions, package/browser checks, Go SQLite module, fuzz campaigns,
Elixir, WASI, the remaining Go/Zig formatting and generated-file gates, and the
broader Zig and platform matrix. Keep the Actions requirements until equivalent
coverage is available.

## Linux worker image

Build this image on each Linux Docker worker before enabling the workflow:

```sh
docker build -t odgn-talk-ci:2026-10-19-2 tools/ci
docker build --build-arg NODE_VERSION=24 -t odgn-talk-ci:2026-10-19-2-node24 tools/ci
```

Both images contain Bun 1.4.2 with its `bunx` entry point, Go 1.27.2 and the C
compiler needed for Go race tests. The default image uses Node 22 for parity with
the Actions stack and CLI
jobs. The `node24` image is used only for the required SQLite and notification
runtime tests; SQLite's authorizer requires Node 24.10 or later. Change a tag in
both the build command and workflows whenever its image changes. Woodpecker
uses existing local images by default.

The TS and tooling suites have a 30-second default per-test timeout to
accommodate the slower shared VPS CPUs; their assertions are unchanged.

The Spec and tooling workflows each report a separate status, and can run
alongside the core workflow as agent capacity permits. Tooling steps run
sequentially in their shared workspace to keep their generated builds ordered.

The workflow selects an agent with `platform=linux/amd64` and `backend=docker`.

### Persistent Go caches

Create a Docker volume on each Linux worker:

```sh
docker volume create woodpecker-go-cache
```

Add this environment variable to the Docker agent and recreate the agent:

```yaml
WOODPECKER_BACKEND_DOCKER_VOLUMES: woodpecker-go-cache:/woodpecker-go-cache
```

The Go step stores its build and module caches under repository-specific
directories in that volume. `-count=1` keeps both ordinary and race tests running
on every pipeline; compilation and downloads can be reused. Go's Unicode
bootstrap remains uncached. Without the agent mount the workflow still runs,
but its caches disappear with the step container.

This agent-managed volume is mounted in every Docker step. Repository
directories prevent accidental collisions, but do not isolate caches from
other jobs on the worker. Use it only for repositories and approved contributions
that share the worker's trust boundary. Repository trusted-volume, network and
privileged capabilities are not required.

## Native Mac worker

Use Woodpecker's `local` backend with native `darwin/arm64` binaries. Its `PATH`
must contain Bash, Git, Git LFS, `plugin-git` 2.10.1, Bun, Go, Zig 0.17.0 and Python 3.
Bun and Go are needed for the repository's Unicode bootstrap check.

Configure the Mac agent with a mandatory `!backend=local` label so only workflows
explicitly requesting the native backend can run there. The shared workers use
`repo=*` and serve activated repositories; the server restricts repository
owners to `odogono` and sign-in to the configured administrator. For a worker
dedicated to this repository, use `repo=odogono/odgn-talk` instead.

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
