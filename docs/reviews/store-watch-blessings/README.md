# Store watch expectation review

Proposed expectations for [#620](https://github.com/odogono/odgn-talk/issues/620),
on the checkout based on `1eb826ac` (2026-10-11). **Human approval is pending.**
The authority is [Store Notifications](../../../spec/proposals/store-notifications.md),
particularly Operations, Embedding declarations and Core scenarios. The
numbered chapters remain the active specification until #622 integrates the
complete contract.

## Proposed expectations

Each new `case.trace` retains its `Unblessed` marker. The scenario outcomes
below were derived from the staged contract before execution. The shared
Corpus writer then filled instruction positions, costs and hashes, keeping
its output only after both Cores reproduced it in ordinary and injected
save/restore replay. This agreement is execution evidence, not human approval.

All paths in this table are under `corpus/capabilities/` and link to the exact
expectation awaiting review.

| Expectation | Required behavior |
| --- | --- |
| [standard-store-watch/case.trace](../../../corpus/capabilities/standard-store-watch/case.trace) | Two and three supplied arguments, explicit Nothing, default and custom messages, missing-name and existing-name unwatch; all results Nothing and no participant |
| [standard-store-watch-validation/case.trace](../../../corpus/capabilities/standard-store-watch-validation/case.trace) | Empty name before invalid message; all seven specified invalid messages; dynamic wrong Shapes; watch/unwatch refused without a call; catch then a successful call starts at `.c1` |
| [standard-store-watch-counts/case.trace](../../../corpus/capabilities/standard-store-watch-counts/case.trace) | Watch with zero, one and four arguments and unwatch with zero and two rejected at Load as `wrong argument count`, at the Operation name |
| [standard-store-watch-errors/case.trace](../../../corpus/capabilities/standard-store-watch-errors/case.trace) | `watch limit` accepts only text `watches`, `size` and `pending`; absent, nontext or other words, undeclared codes, non-Nothing Stub results and any unwatch failure become `host error` |
| [standard-store-watch-segments/case.trace](../../../corpus/capabilities/standard-store-watch-segments/case.trace) | Read-only observer beside another Store's writes; only the writer enrolls; a successful watch stays recorded before a Limit Fault rollback and a refused commit with rollback |
| [standard-store-watch-grants/case.trace](../../../corpus/capabilities/standard-store-watch-grants/case.trace) | GrantsAsUsed retains only watch and unwatch, including an unused Function body, and discards an unused Grant; revoked watch refuses before its empty name and Reserved Word message |
| [standard-store-watch-disabled/case.trace](../../../corpus/capabilities/standard-store-watch-disabled/case.trace) | Failed automatic abandonment disables a Grant; watch/unwatch reject empty names and wrong Shapes before validation or unaffordable costs; disabled wins after revocation too |

The disablement case deliberately adds a synthetic scope to a Store-shaped
Capability. The fixed Standard Store has no Capability Scope whose automatic
abandonment could disable it. The fixture reaches that state through actual
Core abandonment, rather than changing a save. TS embedding tests reuse the
factory's actual watch declarations and argument checks with such a scope;
both Core replay paths cover the same disabled-first invocation gate.

## Independent checks

The basic case has five Nothing results: 40 allocated bytes and eight bytes
of retained Script Variable state. Its Fuel is 96: 11 constant instructions,
five local stores, one local load, one Script Variable store costing 2, return
costing 2 and clause selection costing 4 give 25; three watch calls at
`10 + 4 + ceil(8/32) = 15` and two unwatch calls at
`10 + 2 + ceil(8/32) = 13` give 71. These are Cost Model 0 rates, not a new
language or Cost Model version.

Native tests compare invalid calls with zero/ordinary costs against the same
calls with one million Fuel and allocation declared: the refusal, consumed
Fuel and allocation must match, no Host invocation occurs, and a recovered
call still takes `.c1`. Dynamic Shape mismatches precede domain validation;
name precedes effective message. Embedding tests check the effective message
separately from the Trace's supplied argument list.

Real Store tests register an observer after its own pending write and before
commit, verify the Notification, preserve the watch after a fault or failed
commit, keep the old registration after invalid replacement, and remove it
through unwatch and Stop. Existing release-hook tests cover the remaining
lifecycle reasons and identity exclusion. Session tests cover the new costs
and finite watch count. LSP, checker and Playground tests accept the new calls,
and LSP completion includes both names.

## Existing Group Fingerprints

The five existing Store case traces remain byte-for-byte unchanged. Their
`ops = "all"` Grants now include two more fixed Operation Declarations, so
the Group Fingerprints change even though source identities, calls, resource
figures and final variables do not. Their complete eight-cost maps are in
`case.toml`. The following final-state fingerprints were calculated on both
the original checkout and this implementation, using each checkout's own
factory and original/current case files.

| Case | Before at `1eb826ac` | After |
| --- | --- | --- |
| standard-store | `86fd5daea3b2aa89240eaf96759eac7605fd4989a112515d01aa969e7157867e` | `f295a1f0035ef699a56f91c97b3844584f6c375390cd9846126ee3f80caf08fb` |
| standard-store-errors | `60c364c97853d0c85716705eb49c3f6575d6ea1e1f44f2ac10a8a89b43a13efb` | `49bc8c435dc8128b69e93b3df125b1d45ade3efac153cd2fe0cc7859aa342cb6` |
| standard-store-validation | `3b957cdeaf16c5f344c27e9d686d6c8bdfd66a3ef6ebce0a7b0281284dfbaf92` | `3d83d9b5846043852c58706592e72e2c9f27c8e6714935adfdc55a0cdae73294` |
| standard-store-segments | `53db59034cd55f908a00c6b1a128b0361febf5ba5f287eef2f1d4bb590c48175` | `1e7a8144663c49a92a5bb3224f86ef4a02c3b2f0f8be43a5b868974175f9eabe` |
| standard-store-coordinator | `6d7c3bdba5aaceec7620213a4b182f474a94ae194b20c4f8c12d4c507d1b10af` | `454730b518dc54bb1d17f717345143c2237caa6898e10c8157750b2d2de914eb` |

The existing [sessions/store-bindings/case.trace](../../../corpus/sessions/store-bindings/case.trace)
changes only its restore Fingerprint, from
`338633553cce221fda923553ccc015abd0bcf3d9465f8a1edabe58101c4cdc1d` to
`b048ce2e6c1e3641ea58128cc96440ff3c4e4d006d4cc236b516a51b93b4e2de`.
Its Transcript, source identities, calls, costs and final variables are
unchanged. Its existing #538 first-blessing marker also names this #620
Fingerprint change.

## Remaining delivery

The implementation supplies both factories, bundled Store registration,
release and commit routing, all eight Session Store Operations and the
activated Data Files. No save format, syntax or instruction changes are
needed. Store implementations now require three new methods and factory
callers must supply two more costs; the changelog marks the embedding change
as breaking.

Human approval remains for the seven new Trace expectations, the five Group
Fingerprints above and the Session binding restore Fingerprint. Full Session
re-pumping at one Clock reading, background Notification output, retry/detach
and companion checkpoint save/restore remain #621. Its Session Transcripts
and the remaining `session.toml` wording belong to that issue. Full chapter
integration is #622. The Store/router API exposes `pumped`/`Pumped`,
`detach`/`Detach` and checkpoint operations for embedding Hosts to call now.

## Validation

Passed on this checkout:

- `bun run check` (388 Corpus cases), `bun run go:check` and `bun run unicode:check`.
- `bun run corpus:run` and `go -C impl/go run ./cmd/corpus --check-passing`, including ordinary and injected save/restore replay.
- `bun run test` across all workspaces; the TS Core reports 4,135 passed and two skipped. Deno is unavailable, so its SQLite and router runtime checks are skipped; the Node and Bun variants pass.
- `go -C impl/go test ./...` and `go -C impl/go test -race ./store ./notify ./session`.
- `bun run typecheck`, `bun run lint`, `bun run build` and `git diff --check`.

These checks verify the proposed implementation and expectations. They do not
remove the pending human first-blessing review described above.
