---
type: feat
scope: repo
---
Call an Operation declared `command` as a Host Command: `hide welcomeText` calls a granted `hide` as `tell folio to hide welcomeText` would, in the caller's Run, after the Script's own and imported Handlers and before the Message Path. It is checked against the Grant at load, charged, traced and raised at the calling line like any Operation call, joins a Library's `needs` and counts towards `GrantsAsUsed`. The Host Manifest, Group Fingerprint and saves carry the flag, and tooling hovers Host Commands and Lints a Handler that shadows one (ADR 0094).
