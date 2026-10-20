# Woodpecker CI

Woodpecker runs pull-request checks. GitHub Actions runs the broader matrix on
`main` or manually, without adding duplicate checks to PRs:

- `.woodpecker/linux.yaml` runs TS core tests, its build and Corpus, and Go vet,
  tests, race tests and Corpus in Linux containers. After the shared workspace
  bootstrap succeeds, affected TS and Go steps run in parallel.
- `.woodpecker/macos.yaml` builds and checks the Zig sidecar on native Apple
  Silicon macOS.
- `.woodpecker/spec.yaml` runs the Spec workflow's lint, formatting and complete
  `bun run check` gates, including generated tables and documentation checks.
- `.woodpecker/tooling.yaml` runs the TS workflow's stack and tooling jobs:
  workspace typechecking, generated Lints, CLI/editor/Folio/extension tests,
  builds and Node runtime checks.
- `.woodpecker/conventions.yaml` runs the existing PR title and changelog
  checker on PR code updates and metadata edits, with full Git history.
- `.woodpecker/sqlite.yaml` runs vet, tests and race tests for the separate Go
  SQLite module, reusing the Go build and module caches.
- `.woodpecker/package.yaml` builds and packs the TS package, installs it outside
  the workspace, and checks Node 22, Bun, unbundled Chromium and declarations
  under TypeScript 5.9 and the latest TypeScript.

These workflows do not yet cover the complete Actions matrix, including fuzz
campaigns, Elixir, WASI, the remaining Go/Zig formatting and generated-file gates,
and the broader Zig and platform matrix. GitHub Actions keeps that coverage on
`main` and through manual runs. Go/Zig timing measurements run only on demand.

Use **Actions → workflow → Run workflow** to run a retained Actions workflow on
a selected branch before merging when its additional coverage is needed. Release,
deployment, issue-graph and nightly-fuzz triggers remain separate. The redundant
Actions Conventions workflow is removed; Woodpecker supplies the required check.

## Selecting checks

PRs use their complete changed-file list; pushes to `main` use the files changed
by that push. The expensive workflows filter those paths before taking a worker
slot. The Linux core workflow also filters its TS and Go steps independently.

| Change | Selected checks, in addition to Conventions and Spec |
| --- | --- |
| Root README, `docs/` or changelog only | None |
| Go embedding | Go core step and Go SQLite |
| Go SQLite module only | Go SQLite |
| TS Core | TS core step, package and tooling |
| `tooling/` or `bench/ts/` only | Tooling |
| Zig Core or native sidecar checks | macOS sidecar |
| Spec, dependency lock or shared bootstrap inputs | All consumers |
| Workflow or worker image | Affected workflows |

Keep Spec on every PR and push to `main`: its lint, generated-file and Markdown
link checks span the repository. Keep Conventions unfiltered on PR code and
metadata updates. Spec Markdown remains a Core trigger because tests read prose
examples directly. Shared Corpus, fixture and reference-tool inputs also select
their consumers; filters intentionally prefer an extra check over missing one.
Each workflow includes its own configuration, and Docker consumers include their
worker image inputs. Tooling includes the whole TS workspace typecheck, including
`tools/` and `bench/ts/`.

Manual pipelines run every optional workflow and both core steps regardless of
changed paths. Conventions requires PR metadata and remains a PR-only check.
Empty or unavailable changed-file lists also run all optional checks
(`on_empty: true`). Path filters do not remove jobs already queued from older
revisions: PR branches must include these workflow changes to benefit.

## Linux worker image

Build this image on each Linux Docker worker before enabling the workflow:

```sh
docker build -t odgn-talk-ci:2026-10-19-2 tools/ci
docker build --build-arg NODE_VERSION=24 -t odgn-talk-ci:2026-10-19-2-node24 tools/ci
```

Both images contain Bun 1.4.2 with its `bunx` entry point, Go 1.27.2 and the C
compiler needed for Go race tests. The default image uses Node 22 for parity with
the Actions stack and CLI jobs. The `node24` image is used only for the required
SQLite and notification
runtime tests; SQLite's authorizer requires Node 24.10 or later. Change a tag in
both the build command and workflows whenever its image changes. Woodpecker
uses existing local images by default.

The TS and tooling suites have a 30-second default per-test timeout to
accommodate the slower shared VPS CPUs; their assertions are unchanged.

The Go core step runs test packages one at a time (`-p 1`) and sets
`GOMEMLIMIT=1GiB` so the Zig Corpus's large Trace and Save/Restore buffers are
collected earlier. This is a soft Go memory target, not a process memory cap;
the complete replay can still use several GiB. The default Zig, retiring
native Go and race suites, and the complete Corpus all remain covered.

The Spec and tooling workflows each report a separate status, and can run
alongside the core workflow as agent capacity permits. Tooling steps run
sequentially in their shared workspace to keep their generated builds ordered.
The shared core, tooling and package bootstraps limit Bun to 16 concurrent
downloads; the default concurrency stalled cold installs in the M4's CI VM.

The core, tooling and package workflows select `backend=docker` so they can run
on either general Linux worker: taito (`linux/amd64`) or almere-linux
(`linux/arm64`). Both hosts keep locally built versions of the same image tags
for their CPU architecture. Woodpecker assigns each workflow to an available
matching agent; taito remains eligible when almere is offline. Spec and Go
SQLite remain on taito. Conventions additionally requires `role=conventions`
and keeps its reserved taito worker.

### M4 Linux worker

Almere has a separate Colima profile for CI, using Apple's virtualization with
6 CPUs, 10 GiB RAM and a 60 GiB disk. Its native macOS agent continues running
the Zig sidecar. The Docker agent adds two Linux workflow slots without adding
PR checks. It requires an explicit `backend: docker` workflow label, and serves
all activated repositories that match its labels.

```sh
colima start woodpecker --cpus 6 --memory 10 --disk 60 --arch aarch64 \
  --vm-type vz --runtime docker --activate=false
```

Use `docker --context colima-woodpecker` for CI administration. The profile does
not select itself as the active Docker context. Build all three Linux worker
images in this context before enabling jobs. Copy `compose.almere.yaml` to
`~/woodpecker/compose.linux.yaml`, beside the existing private `agent-secret`
file, then start it:

```sh
cd ~/woodpecker
docker --context colima-woodpecker volume create woodpecker-go-cache
docker --context colima-woodpecker compose -f compose.linux.yaml config --quiet
docker --context colima-woodpecker compose -f compose.linux.yaml up -d
```

The agent config volume is separate from the native macOS agent. Its containers,
workspaces and Go cache live in the Linux VM. `start-almere-linux.sh` is installed
as `~/woodpecker/start-linux-worker.sh`; the `dev.woodpecker.colima` LaunchAgent
runs it at login and every five minutes to start the CI VM when needed. Docker
restarts the agent with the VM. This worker is available while alex is logged in
and the Mac is awake. Check it with:

```sh
colima status woodpecker
docker --context colima-woodpecker compose -f ~/woodpecker/compose.linux.yaml ps
```

To disable this capacity, unload the VM starter before stopping the agent and
profile, so the five-minute check does not restart it. Taito stays eligible for
the same workflows:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.woodpecker.colima.plist
docker --context colima-woodpecker compose -f ~/woodpecker/compose.linux.yaml stop
colima stop woodpecker
```

### Browser worker image

After building the default Linux image, build the browser variant on each
general Linux Docker worker before enabling the package workflow:

```sh
docker build -f tools/ci/Dockerfile.browser -t odgn-talk-ci:2026-10-19-2-browser tools/ci
```

It adds Playwright's Chromium headless shell and system dependencies to the
Node 22 image. `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` makes the installed
browser available to the workspace's Playwright package. The workflow's install
command ensures that the browser revision matches the locked workspace version;
with the matching image, it reuses the installed browser without downloading it.
Keep `PLAYWRIGHT_VERSION` in `Dockerfile.browser` aligned with `bun.lock`, and
use a new browser image tag in the workflow and build command when rebuilding.

Package and SQLite checks report separate optional statuses. Package can use
either general Docker worker; SQLite uses taito. Neither requests the Conventions
role.

### Dedicated Conventions worker

Reserve one agent for Conventions so the required merge check does not queue
behind core, Spec or tooling workflows. Add this service to the server's existing
Compose file, reusing its `agent_secret` secret and server network:

```yaml
services:
  conventions-agent:
    image: woodpeckerci/woodpecker-agent:v3.19.0
    command: agent
    restart: unless-stopped
    depends_on:
      - server
    labels:
      com.centurylinklabs.watchtower.enable: "false"
    volumes:
      - conventions-agent-config:/etc/woodpecker
      - /var/run/docker.sock:/var/run/docker.sock
    secrets:
      - agent_secret
    environment:
      WOODPECKER_SERVER: server:9000
      WOODPECKER_AGENT_SECRET_FILE: /run/secrets/agent_secret
      WOODPECKER_HOSTNAME: taito-conventions
      WOODPECKER_BACKEND: docker
      WOODPECKER_MAX_WORKFLOWS: "1"
      WOODPECKER_AGENT_LABELS: platform=linux/amd64,backend=docker,!role=conventions,repo=*

volumes:
  conventions-agent-config:
```

The mandatory `!role=conventions` agent label accepts only workflows explicitly
requesting `role: conventions`. General agents omit that role, so they cannot
take Conventions jobs. Keep the dedicated agent's config volume separate from
other agents so it receives its own agent ID. It serves Conventions workflows
from all activated repositories that request this role.

Build the Linux worker image on that host, then start the agent **before**
deploying the workflow label:

```sh
docker compose config --quiet
docker compose up -d --no-deps conventions-agent
```

The general Linux agent can keep its existing two-workflow capacity. This
reserves queue capacity, while CPU, memory and disk remain shared on the host.
Verify Conventions runs on `taito-conventions` while general workflows are
busy. To roll back, remove the workflow's `role` label first; stop the dedicated
agent only after those labelled workflows have finished or been cancelled.

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
reported the expected statuses. Only `ci/woodpecker/pr/conventions` is currently
required; the other Woodpecker checks remain optional. Actions workflows do not
automatically run on PRs.

### Required Conventions check

The Conventions adapter reads the current PR title, body, base branch and head
from GitHub's public API, then invokes `tools/commits/check.ts pr` with metadata
in environment variables. It rejects stale revisions and API failures. It
requires a public GitHub repository and uses one unauthenticated API request
per run, subject to GitHub's public API rate limit.

Woodpecker normally gives `pull_request` and `pull_request_metadata` events
different status names. Configure this on the **server** to keep Conventions
edits on the same required status while preserving other workflow names and
matrix suffixes:

```yaml
WOODPECKER_STATUS_CONTEXT_FORMAT: '{{ .context }}/{{ if and (eq .event "pull_request_metadata") (eq .workflow "conventions") }}pr{{ else }}{{ .event }}{{ end }}/{{ .workflow }}{{if not (eq .axis_id 0)}}/{{.axis_id}}{{end}}'
```

Recreate the server after changing its environment. Verify an invalid title and
a body requiring a missing changelog fragment both fail the existing
`ci/woodpecker/pr/conventions` status, and restoring valid metadata makes that
same status pass. Only then replace the Actions-bound `conventions` requirement
with `ci/woodpecker/pr/conventions`. Select **Any source**, since Woodpecker
posts OAuth commit statuses rather than GitHub Actions checks. Keep any other
required checks and branch protection settings intact.

PR branches must contain the Conventions workflow and adapter. Update existing
branches from `main` before requiring the check for them. Existing PR branches
also need the updated Actions workflow files to stop the old PR-triggered jobs.
