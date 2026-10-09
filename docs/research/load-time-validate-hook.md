# A load-time Validate hook for literal Operation arguments

Answers [#471](https://github.com/odogono/odgn-talk/issues/471), part of [#475](https://github.com/odogono/odgn-talk/issues/475). [ADR 0070](../adr/0070-sqlite-is-an-optional-standard-capability-with-segment-bound-writes.md) lists, as a follow-up, an optional hook on an Operation Declaration that the loader calls for each literal argument, so that literal SQL becomes a load diagnostic. This note settles the hook's contract, how it behaves on Reload, Extend and Library replacement, and what the Host Manifest carries for it. It also checks how much `sqlite` would gain. The throwaway check is in [`spikes/validate-hook/`](../../spikes/validate-hook/), and its output is in [`results.txt`](../../spikes/validate-hook/results.txt).

## Summary

- **The hook sees only the literal Value and its position:** the Capability, the Operation and the argument index. It never sees the Grant name, the binding, the database, the clock or the other arguments. The same input always gives the same verdict. That one rule answers all three questions:
  - Both Cores can call the hook in any order, batch the calls and memoize them.
  - Restore, Reload and Library replacement give the same verdicts as the original Load.
  - A Trace Case can describe the hook as a finite table.
  - Tooling can run a validator without the Host.
- **The Cores agree on when the hook is called and what a verdict becomes, and not on how the hook decides.** The hook is called for each literal argument that passes its Shape check. A rejection becomes one new load diagnostic, proposed as `rejected argument`, at the argument's first token, with the Host's message. Message wording is already outside parity.
- **Reload, Extend and Library replacement need no new rules.** The hook runs wherever the Operation checks already run:
  - Load, Reload and Extend check the Script's own calls.
  - A Library is compiled without Host functions, so its literals are validated when a Script that imports it loads. This is the existing import recheck, reported at the `use` line.
  - Restore re-runs Load, so the hook runs again, with the same verdicts.
  - A revoked Grant has no hook, so its calls are not validated.
- **The Host Manifest carries a validator label, not verdicts.** Verdicts are about literals in Scripts that don't exist when the manifest is written. The label also goes into the Group Fingerprint and `case.toml`. Tooling runs a validator it knows by label, such as a sqlite-wasm validator for the Standard `sqlite`, and skips any other.
- **For `sqlite`, a pure hook catches less than ADR 0070 hoped.** Without the schema, compiling SQL catches syntax errors, trailing statements, and denied statement kinds such as `ATTACH` and `PRAGMA`. It can't catch a `query` that writes, or a table outside the binding's limits:
  - `delete from t` fails as `no such table` before the authorizer sees the `DELETE`.
  - `sqlite3_stmt_readonly` needs a prepared statement, which needs the schema.
  - The schema is mutable database state, and the table limits are binding data. Both are outside what the hook may read.

  Named-statement catalogues ([#473](https://github.com/odogono/odgn-talk/issues/473)) remain the way to check `sqlite` calls fully at load.
- **Recommendation:** add the hook as a small, generic Spec change with the contract below. Scope `sqlite`'s validator to the checks that don't need the schema. Sequence the work after #473 settles how catalogues declare Operations, because both change the Operation Declaration and the Fingerprint.

## What Load checks today

- The loader checks each call's argument count, the keys of a literal closed map, and the kind of every literal argument. "There is no inference beyond literals" ([`09-embedding.md`](../../spec/09-embedding.md#shapes), the "At load" rule).
- The checks run in this order: unknown Grant, then `unknown operation`, then `wrong mode`, then `wrong argument count`, then `wrong argument` once per literal. They are in Go's `checkOperation` ([`operations.go`](../../impl/go/internal/check/operations.go)) and TS's `checkEffectCall` ([`effects.ts`](../../impl/ts/src/effects.ts)).
- Declarations reach the checker as only a mode and argument Shapes: Go's `check.OperationCheck{Mode, Args}`, TS's `GrantDecls`.
- Diagnostics are normative, with their code and position. There is one per construct, ordered by position ([`02-grammar.md`](../../spec/02-grammar.md), the diagnostic table). A diagnostic code is never shared with a Host error.
- No Host code runs during Load, Reload, Extend or Library compilation today. On the message layer, `load`, `extend` and `compile-library` have no interim `need` replies.

## Parity, and what the hook may depend on

### The contract

- **Declared on the Operation:** an optional `validate` function, beside `do`, `start` and `fire`, and a `validator` label naming its rules. A label is required whenever a function is set. The Host changes the label whenever verdicts may change, for example on a new SQLite version.
- **Inputs:** the argument's Value, and its position as Capability, Operation and argument index. No binding, Grant name, external state, time, randomness or other argument. Even when the other arguments are literals, a check across arguments would need the hook to see a whole call. That is a different hook, and nothing asks for it yet.
- **Output:** pass, or reject with a message. The hook doesn't return a code, because the diagnostic catalogue is closed (`02-grammar.md`).
- **Called for:**
  - each argument that is a literal in the sense the "At load" rule already uses;
  - after the existing checks for its call pass, so a call has at most one diagnostic;
  - never for `it`, `me`, Interpolated Text or any other computed argument.

  Whether a Constant reference counts as a literal is the existing loader's question. The hook inherits the answer.
- **The diagnostic:** a new code, proposed as `rejected argument` ("a literal argument of a Capability call is refused by its Operation's validator"), at the argument's first token. Its message is the Host's. A position inside the literal, such as `sqlite3_error_offset`, is deferred, because mapping it back through escapes, NFC normalisation and raw fences is its own rule.
- **A hook that fails:** if a Go hook panics or a TS hook throws, Load fails with `rejected argument` and a message naming the failure. A Host bug therefore can't crash the Group, and Load stays total. This mirrors how a result that breaks its Shape becomes `host error` at run time.
- **Cost:** none. Load has no Fuel and runs outside any Run. Keeping the hook bounded is the Host's obligation, like `DefineCapability`'s other functions.

### Why purity

- **Parity:** the Cores differ only in when they call the hook. Because the hook is pure, call order, batching and memoization don't change any diagnostic. So the Spec fixes only the set of arguments validated, which follows from the existing literal rule, and how a verdict becomes a diagnostic.
- **Restore and Reload:** these re-run Load. A hook that read the database or the clock could reject a Snapshot that loaded fine when it was saved.
- **Conformance:** a pure hook is fully described by a table of verdicts. `case.toml`'s `[operations]` gains a `validate` key, for example `{validator = "…", reject = [{arg = 0, value = "selec 1", message = "…"}]}`, in which every unlisted literal passes. The Trace records the result as an ordinary `diag` record. No stub mechanism is needed, so the Trace Cases can't tell a real hook from its table.
- **Grants share the hook:** different bindings of one Capability share one function. Since the hook can't see the binding, the verdict is per Operation, and that is what lets tooling reproduce it.

### Embedding surface

- **Go** gains `Operation.Validate func(arg Value, index int) error` and `Operation.Validator string`. **TS** adds the same pair to `OpBase`.
- **`CompileLibrary` declarations** carry only the label, as `OperationCheck{Mode, Args, Validator}`, never the function. This keeps "a Library never captures Host functions" (chapter 7).
- **Message layer:** `load`, `extend`, `reload`, `restore` and `replace-library` gain one interim reply. It is proposed as `need validate`, carrying `[{capability, operation, index, value}]`. The Host answers with a verdict for each item. Purity is what makes one batched round trip valid. `reload`, `restore` and `replace-library` already have interim replies. `load` and `extend` gain their first.

## Reload, Extend and Library replacement

| Input | What the hook validates | On rejection |
|---|---|---|
| Load | the Script's direct calls, then each imported Library's call sites | LoadError, nothing loaded |
| Reload | the new source, against Grants with revoked ones removed | LoadError before any Run stops, Script unchanged |
| Extend | the new Entry only | LoadError, Script unchanged |
| CompileLibrary / AddLibrary | nothing: no Host functions | n/a |
| Library replacement | each dependent Script, as it reloads | nothing changes, as for any failed check |
| Restore | the saved source, as Load does | Restore fails |

- **Libraries:** a Library's literal call sites are validated by the Script's Grants at the import recheck that chapter 7 already describes. The rejection is reported at the `use` line, and its message names the original call site, like `missing grant`. Each importing Script repeats the check. Memoization keyed by validator label, Operation, index and Value makes the repeats cheap.
- **Revoked Grants:** after a revocation, Reload, replacement and Extend check against the remaining Grants, so a call through a revoked Grant is already `unknown operation`. A Grant that Restore brings back as revoked keeps its saved declaration but has no function, so its literals aren't validated. Its calls fail at run time as they do now.
- **A validator that changes:** a Host that upgrades its validator, for example by linking a newer SQLite, can make a saved Script fail Restore. The same happens today when a Host changes an argument Shape. The label makes the change visible in the Fingerprint before a lockstep pair starts.

## The Host Manifest and tooling

- **Verdicts can't go in the manifest.** It is written per kind of Script, before any Script exists. A cache of past verdicts would only be stale data that tooling has to distrust.
- **What it carries:** the `validator` label on each Operation Declaration. The Fingerprint includes the label. The functions stay excluded, like the other hooks.
- **Tooling:** the LSP and Lint engine already run every Operation check from the manifest without the Host. With a label, they can run a validator they ship by name, which is non-normative under ADR 0028. A label they don't know is skipped silently. As ADR 0028 says of a stale manifest, missing tooling only lets an error reach Load.
  - For the Standard `sqlite`, the tooling stack can ship a sqlite-wasm validator. It is the same check as the Host's, up to SQLite version drift.
  - A Host-defined Capability gets tooling validation only if someone writes a matching tooling validator. The Spec need not provide a plugin mechanism yet.

## What `sqlite` gains

The spike compiles statements with `EXPLAIN` on an empty in-memory database, with an authorizer that denies `ATTACH` and `PRAGMA`. It uses Python's `sqlite3` on SQLite 3.53.4. A pure hook can't see the database's schema, which changes under `change`, so only the "no schema" column below is available to it.

| Statement | No schema | With schema |
|---|---|---|
| `selec 1` | syntax error | syntax error |
| `select 1; select 2` | trailing statement | trailing statement |
| `attach 'x' as y` | not authorized | not authorized |
| `pragma table_info(t)` | not authorized | not authorized |
| `delete from t` | `no such table`, authorizer not reached | compiles, authorizer sees `DELETE` |
| `select nosuch from t` | `no such table` | `no such column` |

- **Catchable at load:**
  - syntax errors;
  - trailing statements (`sql`);
  - the statement kinds the authorizer always denies: `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension` and non-allowlisted `PRAGMA`. The spike observed `ATTACH` and `PRAGMA`. The transaction statements are authorized as their own action, `SQLITE_TRANSACTION`, and need no schema either.
- **Not catchable:**
  - a `query` that writes. `sqlite3_stmt_readonly` needs a prepared statement. A guess from the leading keyword would fail on `WITH … DELETE` and isn't worth specifying.
  - table limits, which are binding data.
  - unknown tables and columns, which belong to the schema.
- **How the validator must treat name errors:** it must let `no such table`, `no such column` and `no such function` pass, because the table may exist at run time. SQLite reports these and syntax errors with the same result code, `SQLITE_ERROR`, so it has to tell them apart by message prefix. That is fragile across versions, but it is confined to the label's implementation.
- **Version drift:** a newer SQLite accepts syntax that 3.45 refuses. A Script can then load on one Host and be refused on another, the load-time counterpart of the result drift ADR 0070 already accepts. The label should include the SQLite version.
- **Wiring:** the Core declares `sqlite`'s Operations through [the factory](../../spec/09-embedding.md#the-sqlite-factory). So the implementation would supply an optional `validate(sql)` for the `sql` argument of `query` and `change`, and the factory would set the label from the implementation's SQLite version. The parameter-count obligation compares two arguments, so it stays at run time even when `params` is literal.

So the hook turns typos and forbidden statement kinds into load diagnostics. The two checks ADR 0070 cared most about, a non-read-only `query` and the table limits, stay run-time errors unless the Script uses a catalogue (#473).

## Open questions

- Whether a Constant reference counts as a literal for the hook. This is decided by the existing loader rule, which the Spec should state explicitly.
- Whether `rejected argument` should support a position inside the literal later, for SQLite's error offset.
- Whether catalogues (#473) make a generic hook unnecessary for `sqlite`. If they do, the hook needs a second motivating Capability, such as patterns, URLs or units, before it is worth both Cores' time.
