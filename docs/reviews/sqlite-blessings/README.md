# sqlite expectation review

Evidence for #467 on 2026-10-09. The normative rules are chapter 7's [`sqlite`](../../../spec/07-libraries-and-the-standard-library.md#sqlite), chapter 9's [factory](../../../spec/09-embedding.md#the-sqlite-factory) and chapter 11's [`sqlite` Stubs](../../../spec/11-the-trace-and-conformance.md#stubs).

## Proposed first expectations

**Approval is pending.** Every header below remains `Unblessed`. Agreement verifies execution; it does not replace the [required human first-blessing review](../../../corpus/README.md#checking).

| Case | Pins |
| --- | --- |
| [`standard-sqlite`](../../../corpus/capabilities/standard-sqlite/) | each SQL value's conversion out, rows in column order, `RETURNING` rows, a query that never enrolls, the binding's row cap as the default `max`, and `max` × `perRow` charges |
| [`standard-sqlite-transfer`](../../../corpus/capabilities/standard-sqlite-transfer/) | chapter 7's `transfer` example, committed, and abandoned by an ordinary error with the rest of the Segment committed |
| [`standard-sqlite-limit-fault`](../../../corpus/capabilities/standard-sqlite-limit-fault/) | a Limit Fault after an explicit `commit` rolling back the whole Segment, with no abandonment call |
| [`standard-sqlite-abandon`](../../../corpus/capabilities/standard-sqlite-abandon/) | abandonment at Run end by an automatic `rollback`, and an explicit `rollback` followed by a change that commits |
| [`standard-sqlite-suspension`](../../../corpus/capabilities/standard-sqlite-suspension/) | `scope open` at a `wait` inside the transaction, and a wait after `commit` that commits the Segment |
| [`standard-sqlite-databases`](../../../corpus/capabilities/standard-sqlite-databases/) | aliases of one database sharing its participant, a read of a second database, and a change there raising `segment participant conflict` |
| [`standard-sqlite-validation`](../../../corpus/capabilities/standard-sqlite-validation/) | the Core's `max` and `params` checks, in order, `not encodable` for a Function Value, and a whole `max` written with zeros |
| [`standard-sqlite-results`](../../../corpus/capabilities/standard-sqlite-results/) | the Core's result checks in order (form, column names, values), `unrepresentable` for NaN, infinities and 10^34, and Host failures passed through or refused |
| [`standard-sqlite-errors`](../../../corpus/capabilities/standard-sqlite-errors/) | caught `sqlite busy`, `constraint` and `too many rows` from `change` and `begin`, and `host error` for a bad constraint kind or a negative `changes` |
| [`standard-sqlite-charge`](../../../corpus/capabilities/standard-sqlite-charge/) | a row charge the Run can't cover faulting at the call, before its Stub, including the binding's cap past every Fuel limit |

Both Cores wrote these expectations through `bun run corpus:bless`: the TS runner wrote them, and TS and Go each replay them in ordinary and save/restore replay. The Go passing gate lists all ten.

## What a reviewer checks

- The `sqlite` Stubs stand for the implementation's answer, so each `call` record's `result` is the Core's conversion of its Stub. `{real: t}` names a `REAL` that no number can, such as NaN.
- Errors the Core raises while converting a result (`sql` for a duplicate column, and `unrepresentable`) are recorded as the call's failure, with no `message`.
- Argument-check errors (`out of range`, `wrong kind`, `not encodable`) come before the call is charged, so they have no `call` record.

## Outside these cases

- What the implementation sees, which no Trace shows (SQL values in `params`, `max`, the coordinator mapping and the factory's refusals), is pinned by `impl/ts/tests/sqlite-capability.test.ts` and `impl/go/sqlite_capability_test.go`.
- The [sqlite test kit](../../../corpus/sqlite-kit/) holds implementations to chapter 9's Host obligations against a real database. The TS runner landed with the TS Host (#468), and the Go Host (#469) adds one for Go. Its expectations are data for review alongside these cases.
- A Trace recorded from a live `sqlite` Host can't yet be replayed without Stubs, since its `call` records hold converted answers. The TS runner defers such a replay.
