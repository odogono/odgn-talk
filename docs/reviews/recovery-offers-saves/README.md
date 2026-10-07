# Recovery Offers Save/Restore evidence (#390)

This slice starts at `548afc41` (PR #400 merged into `feat/recovery-offers`).
Language remains 1.0-rc.2 and provisional Cost Model 0. No Data File or Corpus
expectation changes are made. Existing first-blessing approval remains pending
in #392; execution agreement does not grant that approval.

Both Cores save retained continuations, dispatch activations and their shared
owner locals, selection boundaries, pending catch/offer/error transfers, chosen
arguments, cleanup queues and entered-scope history, and the per-Run attempt
counter alongside the existing Segment base, counters and Fuel Slice debt.
Search and lookup retain their indivisible charging and preempt only at the
following instruction boundary; no saved scan cursor is introduced.

Restore validates identity-checked code and body references and every active,
retained, activation and cleanup PC/local layout. It checks catch and cleanup
entries against the owning code's tables, phase consistency, selection
boundaries, target action PCs/parameter slots/exact arity, cleanup indices and
scope duplication, attempt counters, and acyclic ownership before resuming.
The Go codec rebuilds local aliases and canonical dispatch pointers only after
validation; TS retains graph aliases and validates them after decoding completes.
The [Core guides](../../../impl/ts/README.md) describe support, with the
[Go format and compatibility rules](../../../impl/go/README.md#save-restore-and-code-updates)
beside that API.

Go now discards obsolete transfer pointers when policy or cleanup escape aborts
recovery, and when cancellation takes ownership of finally scopes. A retained
cleanup cursor still owns its locals/scopes but cannot retain a canceled target.
The private Go format is `go/2`; `go/1` is refused. TS retains private format 2.
These changes add no Trace record, instruction charge or Host Input.

## Boundary evidence

[TS tests](../../../impl/ts/tests/recovery-snapshot.test.ts) and
[Go tests](../../../impl/go/recovery_snapshot_test.go) run all 39 shared
single-level/nested scenarios with Fuel Slice 1 and with Slice 7 / Pump cap 3.
Each Pump is compared against execution with the same Pumps and no injected saves, then a
Save/Restore is injected before the next Pump. The comparison covers complete
Trace and Pump reports, Fuel/allocation, inspection, and the complete saved
control, locals, Segment state, counters and debt. Go compares canonical save
bytes; TS compares decoded state because immutable Value identity sharing need
not survive its codec. Owner-local storage aliasing is validated separately.

This covers ordinary catch tests and Guard skips, decline and owner-local writes,
helper calls, nested selection boundaries, choice before cleanup, every cleanup
instruction, and the action-entry boundary. Four additional cancellation tests
save/restore at every remaining finally instruction, starting from selection,
pending offer, pending ordinary catch and nested recovery.

The existing `recovery-offers/basic` Library/callback case also runs with Slice
1 and Save/Restore at every boundary in both native suites. It keeps the rows
accumulator and callback identity across two Libraries, including cleanup-local
catches, unavailable/wrong-arity choices and Guard errors. It asserts the exact
four chosen-attempt records: Run 1 attempt 1, Run 2 attempt 1, Run 3 attempts 1
and 2, plus the final Script Variables. Restoring never reuses an attempt.

Checksummed malformed-save tests cover forged code/body/PC references, retained
local layouts, split/inconsistent owner locals, owner/control cycles, missing
owners, search indices and try tables, illegal phases, targets, argument counts
and slots, rewound counters, cleanup references/indices/duplicates, catch targets,
selection-boundary cycles and search bookkeeping. These test public Restore
refusal rather than relying on checksum corruption or private validator calls.

## Corpus and validation

Both explicit Corpus runners verify all seven existing Recovery Offers Trace
candidates (`basic`, `boundaries`, `costs`, `cleanup-restore`, `nested`,
`cancellation`, `action-suspend`), including their transparent Save/Restore mode.
The existing effect-boundary tests continue to require `effects pending` Save
refusal without changing execution or counters. The action-suspension case also
verifies ordinary suspension/resumption after action entry.

Required checks: Spec and generator checks, focused and full workspace tests,
Go full race tests and vet, typecheck, lint/format, both explicitly named Corpus
runners and dual-Core seed-1 fuzz smoke. Results are recorded in the PR.
