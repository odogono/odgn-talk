---
type: feat
scope: ts
---
Add `@northtalk/ts/http`, a server-only HTTP router on `node:http` that serves the `http` Standard Capability under Bun and Node: shared listeners, longest-prefix matching, Deliveries per request, answers settled from the Pump's reports, a 1 MiB default body limit answered 413, and graceful drain, with the language-neutral http test kit (ADR 0124).
