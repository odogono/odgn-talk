# Recovery Offers

**Status: accepted design; syntax, nested recovery and cancellation implemented; snapshot validation/debugger integration pending.** This is the specification handoff for [#367](https://github.com/odogono/odgn-talk/issues/367) and [ADR 0060](../../docs/adr/0060-errors-may-transfer-to-named-recovery-offers-chosen-before-unwinding.md), proposed in [design PR #382](https://github.com/odogono/odgn-talk/pull/382) and revised before implementation. [Implementation issue #383](https://github.com/odogono/odgn-talk/issues/383) tracks the deferred work and required specification base. Both Cores and the reference parser accept the forms and check their load-time rules; the formatter, LSP diagnostics, highlighting and beginner Lints support the syntax. Chapter 2 and the grammar/diagnostic Data Files now contain those rules. Reference lowering and both Cores now implement two-phase catch search, nested offer execution, transfer cleanup, cancellation, availability, accounting and Trace records. Complete snapshot validation (#390) and debugger/session integration (#391) remain pending; see the [TS](../../impl/ts/README.md#task-navigation), [Go](../../impl/go/README.md) and [tooling](../../tooling/stack/README.md) support guides. The numbered chapters and executable Data Files remain the active specification.

Language **1.0-rc.2** and provisional **Cost Model 0** stay unchanged. On implementation, move these rules into the affected chapters and Data Files, replace their pending-support notices, and retire this staged document in favor of those rules. New-syntax examples use `text` fences because documentation `talk` fences are parsed and lowered by the current checks. Their results are specified behavior, not execution evidence.

## Purpose and examples

A Recovery Offer lets the code doing work declare a named recovery block. A Recovery Catch lets an outer caller choose that block before failed frames are discarded. This moves policy across calls without passing a policy argument through every intermediate API. It never supplies the result of an arbitrary failed instruction or resumes at a `throw`.

Ordinary Errors do not roll back Script Variable writes. The lost work in the motivating example is the Library frame's local accumulator when that frame is unwound, not transactional rollback. A local catch with an explicit callback already preserves that accumulator; [the supported alternative below](#supported-callback-alternative) remains sufficient when passing a policy is convenient.

### A Library offers recovery; the caller chooses

The Host registers this Library as `rows`. **Implemented basic syntax/runtime:**

```text
function parseRows lines
  put [] into rows
  repeat for each line in lines
    try
      put line as number after rows
    offer skip
      next repeat
    offer useValue value
      put value after rows
    end try
  end repeat
  return rows
end parseRows
```

`skip` continues the Library's own loop. `useValue` appends exactly one supplied value, then continues normally after the try. The `rows` local belongs to the original Library frame throughout selection and transfer.

A caller skips bad input:

```text
use parseRows from rows

on parseInput
  try
    put parseRows(["5", "bad", "7"]) into parsed
  catch {code: "can't convert"} before unwind
    choose offer skip
  end try
  -- parsed is [5, 7]
end parseInput
```

Another caller supplies a replacement:

```text
use parseRows from rows

on parseInput
  try
    put parseRows(["5", "bad", "7"]) into parsed
  catch {code: "can't convert"} before unwind
    choose offer useValue(0)
  end try
  -- parsed is [5, 0, 7]
end parseInput
```

Neither policy repeats the conversion of `"5"`. After choosing, control enters the named Library block, later parses `"7"`, and eventually returns from the original `parseRows` call. The failed conversion itself never resumes.

### Availability and decline

```text
try
  put parseRows(["5", "bad", "7"]) into parsed
catch {code: "can't convert"} before unwind
  if offerAvailable("skip") then
    choose offer skip
  end if
  -- Falling through declines; the next catch is tried.
catch {code: "can't convert"}
  put [] into parsed
end try
```

For this Library the first catch chooses `skip`. For a failing call that offers no `skip`, the ordinary catch is tried next and handles the Error after unwinding. A Recovery Catch may have `where Guard` after `before unwind`; an availability query is permitted in that Guard under the ordinary Guard restrictions.

### Only an accepting catch unwinds

Every catch is tested before anything unwinds. A catch whose pattern or Guard rejects the Error is transparent, so an intermediate Library's unrelated catches do not hide offers from its callers:

```text
function loadRows lines
  try
    return parseRows(lines)
  catch "timeout"
    return []
  end try
end loadRows

on parseInput
  try
    put loadRows(["5", "bad", "7"]) into parsed
  catch {code: "can't convert"} before unwind
    choose offer skip
  end try
  -- parsed is [5, 7]: `catch "timeout"` rejected the Error without unwinding.
end parseInput
```

A catch that accepts is a barrier. A catch-all, including the log-and-rethrow idiom, accepts every Error, so it unwinds the failed frames before an outer Recovery Catch is tested:

```text
function loadRows lines
  try
    return parseRows(lines)
  catch e
    log(e)
    throw e
  end try
end loadRows
```

Callers of this `loadRows` see the rethrown Error with no offers active. A Library that intends to pass offers through must catch only the Errors it handles.

### Cleanup precedes action; the offering finally follows it

```text
function parseOne text
  try
    return text as number
  finally
    -- Deeper cleanup: runs before a selected action.
  end try
end parseOne

function parseRows lines
  put [] into rows
  repeat for each line in lines
    try
      put parseOne(line) after rows
    offer skip
      -- Action: the deeper cleanup has finished.
      next repeat
    offer useValue value
      put value after rows
    finally
      -- Owning cleanup: runs after the action, including next repeat.
    end try
  end repeat
  return rows
end parseRows
```

For a failed conversion with `skip` chosen, the order is selection, `parseOne`'s finally, `skip`, the offering try's finally, then the next iteration. An Error escaping deeper cleanup cancels the chosen action; an Error caught locally inside that cleanup does not. Offers remain eligible until action entry, including during cleanup.

### Supported callback alternative

This uses current syntax and is checked by the documentation parser and lowerer. The Library catches locally and asks an explicitly supplied policy for a decision:

```talk
function parseRowsWithPolicy lines, policy
  put [] into rows
  repeat for each line in lines
    try
      put line as number into value
    catch {code: "can't convert"}
      put policy(line) into decision
      if the action of decision = "skip" then next repeat
      put the value of decision into value
    end try
    put value after rows
  end repeat
  return rows
end parseRowsWithPolicy

function chooseSkip line
  return {action: "skip"}
end chooseSkip

function chooseZero line
  return {action: "use value", value: 0}
end chooseZero

on parseInput
  put parseRowsWithPolicy(["5", "bad", "7"], chooseSkip) into skipped
  put parseRowsWithPolicy(["5", "bad", "7"], chooseZero) into replaced
  -- skipped is [5, 7]; replaced is [5, 0, 7].
end parseInput
```

The function may live in a Library while the policies live in the calling Script and are passed as Function Values. Each policy must be non-suspending and callable in this Run, with its Home Script the caller's Script. This is a useful beginner alternative, but every API between caller and parser must explicitly forward the policy when the parser is deeper in the call chain.

## Grammar and load-time rules

The productions, now active in chapter 2, are:

```text
Try            ::= 'try' NL Block OfferClause* CatchClause* FinallyClause? 'end' 'try'?
OfferClause    ::= 'offer' Name ( Name ( ',' Name )* )? NL Block
CatchClause    ::= 'catch' Pattern RecoveryMarker? Guard? NL Block
RecoveryMarker ::= 'before' 'unwind'
FinallyClause  ::= 'finally' NL Block
ChooseOffer    ::= 'choose' 'offer' Name ( CallOpen ExpressionList? ')' )?
```

An offer's parameters follow a function's: plain Names separated by commas, with no defaults, patterns or Argument Labels, and fixed exact arity. They use ordinary local binding rules. `ChooseOffer` joins simple statements and its arguments follow a Call: `choose offer skip` and `choose offer skip()` both pass none, `choose offer useValue(0)` passes one, and `choose offer useValue([1, 2])` passes one list. The formatter prints the bare form for zero arguments. Offers precede all catches; finally remains last. A try may make offers without a local catch. Duplicate parameters use `duplicate name`; duplicate offer names in the same try use `duplicate offer` at the second name. Nested tries may shadow names.

`offer` becomes a Reserved Word, listed with the other block-structure words: a Command Call `offer x` at the start of a statement would otherwise be indistinguishable from a clause. Existing identifiers named `offer` must be renamed, and bare map keys with that spelling quoted. `choose` is contextual at the start of a statement before reserved `offer`, a two-token decision, so a Handler or Command Call named `choose` keeps working. `unwind` is contextual after `before` in a catch head. Other uses of `choose` and `unwind` remain ordinary Names.

Choosing is permitted lexically within a Recovery Catch, including its nested blocks. Entering a function or Lambda resets permission; its own Recovery Catch can grant permission for its own failure. Helpers can compute values but cannot inherit the calling catch's permission. A choice outside permission reports `not in recovery` at `choose`; dynamic offer availability is not a load requirement.

A Recovery Catch has no possible Suspension Point. Use `can't suspend here`, including for statically suspending calls, and existing runtime `would suspend` checks for Function Values. Immediate Operations remain permitted. Return, veto, pass, and loop jumps leaving the Recovery Catch report `leaves recovery catch`; internal loops retain their normal exits. Choosing is its designated transfer. Existing finally restrictions still apply to nested finally blocks.

Offer declarations, Recovery Catches and choices are Advanced Constructs. Tooling warns in the beginner profile with the callback/local-catch alternative; Core loading does not reject a profile.

## Selection and transfer

### Two-phase catch search

This changes every catch, not just Recovery Catches. When an Error is raised outside a guard region, the Core searches for an accepting catch **before unwinding anything**:

1. Find the innermost `catch` Unwind entry covering the failing instruction, in the failing frame and then outward through its callers, in existing Unwind Table priority. A `finally` entry passed on the way is not run yet.
2. Run that try's catch handler in a **dispatch activation**: its own PC and operand stack, sharing the catching frame's actual locals, while the deeper failed frames stay retained. The handler tests its catches in source order. Pattern and Guard behavior is unchanged: tests use temporary bindings in a guard region, and an Error or non-boolean Guard result skips the clause with `guard-skip`, without an ordinary `raise`.
3. An **ordinary catch** that accepts executes `catch-accept`. That instruction performs the unwind phase. It runs every exited `finally` scope innermost first, pops the failed frames and disposes the activation. Then it continues the real frame at the clause's binding moves and body.
4. A **Recovery Catch** that accepts runs its moves and body in the dispatch activation, with the failed frames still retained. A choice transfers to an offer (below). Fallthrough declines: it preserves local writes and continues at the next clause's test in the same activation. Selection never rolls back writes.
5. When no clause in the try accepts, `catch-next` disposes the activation and continues the search outward from that try. When the search finds no accepting catch, the Core unwinds every frame as it does today, running `finally` scopes, and the Run ends `errored`.

Because Guards never run Script code, call the Host or suspend, tests have no effects beyond their charges and Trace records. They see the state before any deeper `finally` runs, so a Guard reading a Script Variable that a deeper `finally` writes sees the earlier value.

An Error escaping a `finally` scope during an ordinary catch's unwind phase replaces the original, as today: the pending acceptance is cancelled, the original is attached as `during` if absent, and a new two-phase search starts from that cleanup site.

### Offer availability

`offerAvailable(textName)` is a Built-in returning a boolean. During recovery, including synchronous helpers, Guards and pending transfer cleanup before action entry, it tests the nearest eligible declaration. Outside recovery it returns false. A nested recovery uses its own bounded failure chain, as below. Wrong kind uses ordinary argument validation; malformed or unknown text returns false. Names are case-sensitive under the existing Name rules. The query returns no inventory or handle, and does not check arity.

### Eligible offers and nested failures

Offers are the declarations in protected try scopes still active in this Run's retained failing chain. Look up active scopes innermost first and declarations in source order. The nearest same-name offer wins; recursion and shadowing work naturally. Wrong arity never selects an outer same-name offer.

Local calls, Library frames and same-Run callbacks participate. A foreign Function Value's receiver is a different Run; neither side searches the other's offers. An `on error` backstop is a fresh Run and cannot recover the failed Run. No offer is a Script Value, ambient Library binding or durable callable handle.

Dispatch contexts form a stack. If Recovery Catch code or its helper raises a new Error, the nested two-phase search covers that new local failure chain only up to the existing selection boundary. It does not expose the original retained failure's offers. Local handling can finish and continue the outer policy. If the new Error escapes the selection boundary, it aborts that recovery, attaches the original as `during` only if absent, cleans up retained exited scopes, and continues the search outward from the catching try. It does not decline to a sibling catch.

### Choosing and entering

A choice evaluates arguments left to right, performs complete nearest-name lookup, and checks exact arity. A missing offer raises `offer unavailable`, with `name` as text; wrong count uses `wrong arity` with no new fields. Broaden that catalogue entry's wording to cover offer choices. Both use normal Error positions and key ordering. An argument-evaluation Error follows the policy's ordinary local handling.

A valid choice retains its evaluated arguments and starts transfer. Run finally scopes exited in dispatch control first, then exited original failed scopes innermost first. The offering try's own finally is not exited yet: it protects the action, as it protects an ordinary catch body. Preserve original owner locals and the iterator prefix at the offering try's outer depth.

An Error escaping transfer cleanup cancels the pending transfer, adds the original Error as `during` if absent, and starts a new two-phase search from that cleanup site. Remaining enclosing catches may handle it; it is not forced outside the offering try. A locally caught cleanup Error leaves the transfer pending.

After cleanup, atomically bind all action parameters, set the action-entry PC and expire the offering try's sibling offers. Emit action entry before its first instruction charge. The action is outside that try's catch and offer protected ranges but inside its own finally protection. Normal fallthrough, returns and loop exits execute that finally according to existing lowering. Its Error is handled outside its own offers and catches. It may suspend only where its surrounding Handler/body already permits it; functions remain non-suspending.

No failed expression resumes. Completed caller work is retained until normal control leaves its frame. Recovery itself creates no Segment boundary, effect rollback or automatic abandonment. Existing scope restrictions govern any later suspension.

## Abstract Machine and lowering

### Catch handler lowering

Every catch handler, ordinary or not, lowers to: `store t` of the Error, then for each clause, with F its own label, a guard region of its pattern's test of `t` with temp bindings and its Guard, then:

- **Ordinary catch:** `catch-accept`, the `move`s, its body, a copy of the `finally` block and `jump L`.
- **Recovery Catch:** the `move`s and its body, which falls through to F.

Then F:. After the last clause, `catch-next` replaces today's `load t` `rethrow`. `rethrow` has no other use and is retired from the instruction catalogue. The `catch` Unwind entry, guard entries and `finally` lowering are otherwise unchanged. The catch handler is outside its own try's protected ranges, as now.

### Offer metadata

Only tries with offer declarations get new metadata, and there is no enter/leave registration instruction on the normal path. Normal try completion jumps past the offer actions.

Add Unwind kind `offer`, pointing to an ordered offer record. Each record holds its owning body, outer iterator stack depth and after-try PC, then one descriptor per offer: its name, its parameter slot list and its action-entry PC. Parameter Names take slots by the existing first-binding order; binding an existing local uses its existing slot.

Canonical disassembly adds `offers` between `unwind` and `events`, omitted when absent:

```text
unwind
  <first>..<last> offer -> entry <index> depth <n>
offers
  <index> body <body> depth <n> end <pc>
    offer <Name> -> <pc> binds [<slots>]
```

Indices are assigned in body order, nested records before enclosing records and siblings in source order. Descriptors preserve source order. Use two-space record indentation, four-space descriptor indentation, single field spaces, existing zero-padded PC formatting, plain Name operands and comma-separated integer slots; print `binds []` when empty. The record and its Unwind entry have the same depth.

### Instructions

| Instruction | Operands | Pops | Pushes | Behavior | Errors |
| --- | --- | --- | --- | --- | --- |
| `catch-accept` | none | 0 | 0 | An ordinary catch accepted: run exited finally scopes, pop the failed frames, dispose the dispatch activation and continue in the real frame | none |
| `catch-next` | none | 0 | 0 | No clause in this try accepted: dispose the dispatch activation and continue the search outward | none |
| `choose-offer` | `name`, `count` | count | 0 | Terminal recovery transfer, with atomic lookup and exact arity | `offer unavailable`, `wrong arity` |

All three are non-suspending. `offerAvailable` uses ordinary `call-builtin offerAvailable 1`, not a new query opcode. Extend `end-cleanup` with a pending-transfer mode beside its Error and cancellation modes, used by both `catch-accept`'s unwind phase and a chosen offer's transfer. It remains 0 → 0 with the existing return cost.

A transfer binds action slots without generated `store` instructions; action exits use ordinary finally-copy lowering.

Catch bookkeeping maps to the catch head; a choice maps to `choose`. Argument expressions retain their own positions. Generated action-exit bookkeeping maps to the offer declaration; action instructions retain their own construct positions. The action-entry PC is its first instruction, including generated exit bookkeeping for an empty action.

### Execution contexts

A dispatch context holds the original Error and fault position, retained continuation references, the try being dispatched, the owner-local reference, its dispatch activation, any pending transfer target and arguments, the attempt number and cleanup progress. A dispatch activation has its own PC and operand stack, initialized with the owner's outer iterator prefix and the dispatched Error, while reading and writing the actual owner's locals. Original failed PCs and operand stacks stay retained, not overwritten with dispatch control.

Helpers use ordinary frames, the current Run and its Grants/budgets. Count every retained real frame once for call depth; a dispatch activation creates no call-depth frame or synthetic call charge. A nested context can refer to an earlier activation's continuation; the ultimate locals remain those of a real owning frame. Continuation/ownership references are acyclic abstract machine references, not Script Values or Trace IDs.

Decline continues in the same activation without restoring locals. Transfer removes exited control, preserves the owner's locals and iterator depth, then enters its target. Free completed contexts promptly. Never charge a frame twice merely because both retained and active control reference it.

Limit Fault and Stop enter no catch and run no finally. Cancellation retains existing Segment rollback and Cleanup Budget behavior, but enumerates both dispatch-local and retained finally scopes exactly once. Scope identity is the control activation plus its cleanup entry, not just a shared-local frame: one frame can hold several legitimate finally scopes. A dispatch activation inherits its owner's already active scope identities instead of creating duplicate instances of those scopes. Cancellation charges no unwind. No new Host Input or normative embedding interface is introduced.

## Fuel and Persistent State

All rates below add to provisional Cost Model 0 without changing its version:

| Key | Fuel | Allocation |
| --- | --- | --- |
| `catch-accept` | `1` | 0 |
| `catch-next` | `1` | 0 |
| `choose-offer` | `8 + count` | 0 |
| `builtin.offerAvailable` | `3 + utf8(x1) / 16` | 0 |
| `offer-lookup` | `4 * frames` | 0 |

The existing `unwind` rate (`4 * frames`) moves from frames popped to frames the catch search **leaves**. Charge it at the instruction driving each search step (the raise, `catch-next` or `end-cleanup`) for the frames that step leaves, before testing in the next frame. Popping frames later, in `catch-accept`'s unwind phase or a transfer, is free. An Error accepted by an ordinary catch therefore pays `unwind` for exactly the frames it would have popped, and an uncaught Error pays for every frame.

`offer-lookup` charges for each frame whose active offer entries a `choose offer` or `offerAvailable` lookup examines. Descriptors within a frame are not counted separately. Use existing rounding of divided terms. Charge complete lookup atomically before acting on its result, including missing-name and wrong-arity choices. Availability outside recovery still validates text and pays its base/text rate but performs no lookup; malformed names likewise need no lookup. Wrong-kind arguments follow existing Built-in validation ordering.

Search and lookup are indivisible. They may produce Fuel Slice debt under existing rules, and the Run can be preempted at the following instruction boundary; there is no mid-scan saved cursor. Test instructions, helpers and finally instructions retain their costs, and `rethrow`'s charge goes with it. Transfer's `end-cleanup` costs the existing 2 Fuel and does not raise the original Error again.

Error Fuel for code with only ordinary catches changes: charges are ordered by search rather than by popping, `catch-accept` is added, and `catch-next` replaces `rethrow`. Existing corpus expectations are re-derived and reviewed with this change. Offer metadata incurs no normal-path instruction or Fuel.

Control bookkeeping counts only toward Persistent State, for every dispatch:

| Record | Logical bytes |
| --- | --- |
| Dispatch context | `96 + 8 * argumentCount + contents(original Error and pending arguments)` |
| Dispatch activation | `48 + contents(operand stack)` |

Here `contents` sums held Script Values as the existing size rules do, and `argumentCount` counts pending chosen arguments. Real frames, owner locals and existing cleanup records retain their usual sizes and count once. A value held separately in multiple slots/stacks/contexts counts each time under the existing no-sharing size rule; sharing owner-local storage does not duplicate that storage. Control references and the per-Run attempt counter are included in the fixed bookkeeping sizes (the Run base remains 96). Constructed Error maps, lists, texts and other Script Values retain their normal allocation charges.

## Save and restore

A Run can be preempted during any dispatch, including ordinary catch tests. Save the context stack, activation PCs/stacks, original continuations, local-owner references, the try being dispatched, pending transfer and arguments, attempt counter and cleanup progress. Retain existing Fuel/debt, counters, Segment base/ordinal and scope state. Restoring must reproduce execution, charges and Trace exactly, including preemption during tests, in policy, after choice and during cleanup.

Each Core uses its own private snapshot format; no common binary format or automatic migration is added. Validate code identities, body/table/PC references, phase consistency, owner-local slot layouts, target argument counts, cleanup references and acyclic ownership before accepting a snapshot. Maintain existing exact-version compatibility checks and `effects pending` save refusal. New language-version numbering is not required; private save-format versions can change where necessary.

## Trace

Add these non-input records, with keys in the shown order and the existing Trace value/CodePosition display forms:

```text
offer-chosen <run> attempt=<int> name=<text> at=<CodePosition> target=<CodePosition> args=<list>
offer-entered <run> attempt=<int> target=<CodePosition>
```

`at` is the choice instruction and `target` the action-entry instruction, using the existing `at` field type (code unit and PC). Omit empty `args` under the optional-arguments convention. The per-Run counter starts at zero; each valid, successfully charged choice increments it and records the resulting number, starting at 1. Missing names, wrong arity and faults before lookup charging completes consume no attempt and emit neither record.

Emit choice before transfer cleanup; emit entry after atomic parameter binding and PC transfer, before charging the first action instruction. A first-instruction fault therefore has an entry record. A choice whose cleanup fails or is cancelled has no entry. Nested choices share the Run's monotonically increasing sequence. Save the counter so restoration never reuses numbers.

Two-phase search reorders existing records: a catch test's `guard-skip` now precedes records made by deeper `finally` blocks. Decline, lookup and successful transfer cleanup emit no additional `raise`. Ordinary new Errors, throw/rethrow and Error-mode cleanup keep their existing records. No abort record is needed: subsequent Error/fault/Run outcome records explain a choice without entry.

## Tooling

Update the shared formatter, highlighting, checker/LSP diagnostics, lint engine, CLI/session and Playground syntax support with implementation. Dynamic availability does not require a statically known offer, so do not diagnose a choice solely because no lexical declaration is visible. Cover every new Advanced tag with its beginner wording and fixture.

Debug stepping and replay follow the active execution cursor, not the retained failed stack's deepest PC. Extend tooling-only debug frame views with optional `role` (`retained` or `dispatch`) and an owning-frame reference for dispatch activations, while preserving ordinary frame views and displaying the actual shared owner locals. These views do not affect chapter 9's Inspect schema, Trace or costs, and debugger callbacks remain outside saves.

## Acceptance and delivery handoff

The implementation must include both Cores and reference/tooling support before activating these rules in the Data Files. The parser, grammar, load diagnostics and Advanced tags are active with syntax support. Opcodes, the Built-in, costs, Errors and Trace catalogues remain deferred until their execution consumers land. The grammar and load diagnostics are integrated into `grammar.ebnf`, `grammar.toml` and `diagnostics.toml`. Deferred source files are `machine.toml`, `costs.toml`, `errors.toml`, `stdlib.toml` and `corpus.toml` under `spec/data/`, plus their schemas and generated consumers as needed. Reconcile display/Trace grammar where needed. Move examples to checked `talk` blocks only once reference parsing/lowering supports them.

Required acceptance cases:

- Optional-parenthesis choice syntax, offer parameter lists, optional Guard placement, the `offer` reservation and its migration, `choose` remaining usable as a Handler and Command Call name, formatting round trips, duplicate names, illegal parameters, lexical permission reset, forbidden exits and static/dynamic suspension restrictions.
- The two row policies above, proving retained accumulation without repeated earlier conversion; Library nesting, recursion, shadowing, arity, availability and same-Run boundaries.
- Two-phase search: rejecting ordinary catches stay transparent to an outer Recovery Catch, catch-alls are barriers, tests see pre-cleanup state, and a cleanup Error during an ordinary catch's unwind phase starts a new search.
- Decline to later catches, Guard skips, owner-local writes and isolated nested policy failures.
- Deeper finally before action, offering finally after action, action failures outside sibling offers, multiple finally scopes in one frame, local versus escaping cleanup Errors, and cancellation during tests, policy and transfer.
- Exact search/lookup/accept/choice costs, failed-choice charging, Fuel Slice debt, retained-frame/helper depth, dispatch-record sizing and constructed-value allocation.
- Re-derived expectations for every existing corpus case whose ordinary Error Fuel, Trace order or disassembly changes, with the diffs presented for review.
- Preemption during tests, in policy, after choice, during cleanup and at action entry; injected save/restore reproducing complete Trace, counters, locals and outcomes; malformed dispatch snapshots.
- Ordinary Error writes/effects, Limit Fault/Stop/cancellation boundaries, normal action suspension, complete opcode/metadata disassembly coverage including `rethrow`'s retirement, and debugger/replay parity.

Run every new corpus case explicitly while unblessed, in both Cores and available injected save/restore modes. Execution agreement is not first-blessing approval: present independently derived expected-cost figures and the exact expectation diffs for human review before blessing. Leave unrelated pending approvals untouched.
