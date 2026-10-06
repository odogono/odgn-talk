# Structured Error restarts

**Status: accepted design; implementation pending.** This is the specification handoff for [#367](https://github.com/odogono/odgn-talk/issues/367) and [ADR 0060](../../docs/adr/0060-errors-may-transfer-to-named-restarts-chosen-before-unwinding.md), proposed in [design PR #382](https://github.com/odogono/odgn-talk/pull/382). [Implementation issue #383](https://github.com/odogono/odgn-talk/issues/383) tracks the deferred work and required specification base. Neither Core nor the reference tools currently accepts the new forms. The numbered chapters and executable Data Files remain the active specification.

Language **1.0-rc.2** and provisional **Cost Model 0** stay unchanged. On implementation, move these rules into the affected chapters and Data Files, replace their pending-support notices, and retire this staged document in favor of those rules. New-syntax examples use `text` fences because documentation `talk` fences are parsed and lowered by the current checks. Their results are specified behavior, not execution evidence.

## Purpose and examples

An Error Restart (called a Restart in this proposal) lets the code doing work declare a named recovery block. A Recovery Catch lets an outer caller choose that block before failed frames are discarded. This moves policy across calls without passing a policy argument through every intermediate API. It never supplies the result of an arbitrary failed instruction or resumes at a `throw`.

Ordinary Errors do not roll back Script Variable writes. The lost work in the motivating example is the Library frame's local accumulator when that frame is unwound, not transactional rollback. A local catch with an explicit callback already preserves that accumulator; [the supported alternative below](#supported-callback-alternative) remains sufficient when passing a policy is convenient.

### A Library offers recovery; the caller chooses

The Host registers this Library as `rows`. **Implementation-pending syntax:**

```text
function parseRows lines
  put [] into rows
  repeat for each line in lines
    try
      put line as number after rows
    restart skip []
      next repeat
    restart useValue [value]
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
    invoke restart skip []
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
    invoke restart useValue [0]
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
  if restartAvailable("skip") then
    invoke restart skip []
  end if
  -- Falling through declines; the next catch is tried.
catch {code: "can't convert"}
  put [] into parsed
end try
```

For this Library the first catch chooses `skip`. For a failing call that offers no `skip`, the ordinary catch is tried next and handles the Error after unwinding. A Recovery Catch may have `where Guard` after `before unwind`; an availability query is permitted in that Guard under the ordinary Guard restrictions.

### Ordinary catches are unwind barriers

```text
try
  try
    put parseRows(["5", "bad", "7"]) into parsed
  catch "unrelated error"
    put [] into parsed
  end try
catch {code: "can't convert"} before unwind
  -- The inner ordinary catch already discarded the Library frame.
  -- restartAvailable("skip") is false; falling through propagates the Error.
end try
```

The inner catch unwinds before testing its pattern. Its failure to match does not restore discarded offers. Recovery selection is not a separate pass that bypasses ordinary catches.

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
    restart skip []
      -- Action: the deeper cleanup has finished.
      next repeat
    restart useValue [value]
      put value after rows
    finally
      -- Owning cleanup: runs after the action, including next repeat.
    end try
  end repeat
  return rows
end parseRows
```

For a failed conversion with `skip` selected, the order is selection, `parseOne`'s finally, `skip`, the offering try's finally, then the next iteration. An Error escaping deeper cleanup cancels the selected action; an Error caught locally inside that cleanup does not. Offers remain eligible until action entry, including during cleanup.

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

The future productions are:

```text
Try            ::= 'try' NL Block RestartClause* CatchClause* FinallyClause? 'end' 'try'?
RestartClause  ::= 'restart' Name '[' RestartParams? ']' NL Block
RestartParams  ::= Name ( ',' Name )*
CatchClause    ::= 'catch' Pattern RecoveryMarker? Guard? NL Block
RecoveryMarker ::= 'before' 'unwind'
FinallyClause  ::= 'finally' NL Block
InvokeRestart  ::= 'invoke' 'restart' Name '[' ExpressionList? ']'
```

`InvokeRestart` joins simple statements. The brackets are literal: `[]` is zero arguments, `[0]` is one, and `[[1, 2]]` is one list argument. Declarations precede all catches; finally remains last. A try may offer restarts without a local catch. Parameters have fixed exact arity, with no defaults, patterns or Argument Labels, and use ordinary local binding rules. Duplicate parameters use `duplicate name`; duplicate restart names in the same try use `duplicate restart` at the second name. Nested tries may shadow names.

Only `restart` becomes globally reserved. `invoke` is contextual before reserved `restart`, a two-token decision; `unwind` is contextual after `before` in a catch head. Existing identifiers named `restart` must be renamed, and bare map keys with that spelling quoted. Other uses of `invoke` and `unwind` remain ordinary Names.

Invocation is permitted lexically within a Recovery Catch, including its nested blocks. Entering a function or Lambda resets permission; its own Recovery Catch can grant permission for its own failure. Helpers can compute values but cannot inherit the calling catch's invocation permission. An invocation outside permission reports `not in recovery` at `invoke`; dynamic target availability is not a load requirement.

A Recovery Catch has no possible Suspension Point. Use `can't suspend here`, including for statically suspending calls, and existing runtime `would suspend` checks for Function Values. Immediate Operations remain permitted. Return, veto, pass, and loop jumps leaving the Recovery Catch report `leaves recovery catch`; internal loops retain their normal exits. Invocation is its designated transfer. Existing finally restrictions still apply to nested finally blocks.

Restart declarations, Recovery Catches and invocations are Advanced Constructs. Tooling warns in the beginner profile with the callback/local-catch alternative; Core loading does not reject a profile.

## Selection and transfer

### Catch dispatch

Search the failing execution chain from inner to outer, respecting the existing Unwind Table priority for Guards and cleanup. Within each try, test catches in source order. Before testing an ordinary catch, perform its existing unwind to the owning frame; discarded offers stay discarded even if its pattern or Guard fails. Before testing a Recovery Catch, retain deeper failed continuations and execute its tests and body through a selector activation sharing the actual owning locals.

Pattern and Guard behavior stays unchanged: tests use temporary bindings, accepted clauses move bindings to local slots, and an Error or non-boolean Guard result skips the clause with `guard-skip`, without an ordinary `raise`. A successful Recovery Catch still needs an invocation to recover. Fallthrough declines, preserving local writes, then tries later catches in the same try before going outward. Selection never rolls back writes.

`restartAvailable(textName)` is a Built-in returning a boolean. During selection, including synchronous helpers, Guards and pending transfer cleanup before action entry, it tests the nearest eligible declaration. Outside selection it returns false. A nested recovery uses its own bounded failure chain, as below. Wrong kind uses ordinary argument validation; malformed or unknown text returns false. Names are case-sensitive under the existing Name rules. The query returns no inventory or handle, and does not check arity.

### Eligible offers and nested failures

Offers are the declarations in protected try scopes still active in this Run's failing chain. Look up active scopes innermost first and declarations in source order. The nearest same-name offer wins; recursion and shadowing work naturally. Wrong arity never selects an outer same-name offer.

Local calls, Library frames and same-Run callbacks participate. A foreign Function Value's receiver is a different Run; neither side searches the other's offers. An `on error` backstop is a fresh Run and cannot restart the failed Run. No restart is a Script Value, ambient Library binding or durable callable handle.

Recovery contexts form a stack. If selection code or its helper raises a new Error, nested selection searches that new local failure chain only up to the existing selection boundary. It does not expose the original parked failure's offers. Local handling can finish and continue the outer policy. If the new Error escapes the selection boundary, it aborts that selection, attaches the original as `during` only if absent, cleans up retained exited scopes, and propagates outside the current catch from the policy fault site. It does not decline to a sibling catch.

### Choosing and entering

An invocation evaluates arguments left to right, performs complete nearest-name lookup, and checks exact arity. Missing selection raises `restart unavailable`, with `name` as text; wrong count uses `wrong arity` with no new fields. Broaden that catalogue entry's wording to cover restart calls. Both use normal Error positions and key ordering. An argument-evaluation Error follows the policy's ordinary local handling.

A valid choice retains its evaluated arguments and starts transfer. Run finally scopes exited in selector control first, then exited original failed scopes innermost first. The selected try's own finally is not exited yet: it protects the action, as it protects an ordinary catch body. Preserve original owner locals and the iterator prefix at the selected try's outer depth.

An Error escaping transfer cleanup cancels the pending transfer, adds the original Error as `during` if absent, and uses ordinary Error handling from that cleanup site. Remaining enclosing catches may handle it; it is not forced outside the offering try. A locally caught cleanup Error leaves the transfer pending.

After cleanup, atomically bind all action parameters, set the action-entry PC and expire the selected try's sibling offers. Emit action entry before its first instruction charge. The action is outside that try's catch/restart protected ranges but inside its own finally protection. Normal fallthrough, returns and loop exits execute that finally according to existing lowering. Its Error is handled outside its own offers and catches. It may suspend only where its surrounding Handler/body already permits it; functions remain non-suspending.

No failed expression resumes. Completed caller work is retained until normal control leaves its frame. Recovery itself creates no Segment boundary, effect rollback or automatic abandonment. Existing scope restrictions govern any later suspension.

## Abstract Machine and lowering

### Recovery metadata

Only tries using restart declarations or Recovery Catches get new metadata. Ordinary-only tries retain their old instructions, slots, tables and Error Fuel. Recovery bodies remain in their existing code unit and body; there is no new body kind or function frame, and no enter/leave registration instruction on the normal path.

Add Unwind kind `recovery`, pointing to an ordered recovery record. Each record holds its owning body, outer iterator stack depth and after-try PC; restart names, parameter slot lists and action-entry PCs; and ordinary/before-unwind catch test-entry PCs. Keep existing finally and Guard entries rather than copying their rule data into this record. Parameter Names take slots by the existing first-binding order; binding an existing local uses its existing slot.

Canonical disassembly adds `recoveries` between `unwind` and `events`, omitted when absent:

```text
unwind
  <first>..<last> recovery -> entry <index> depth <n>
recoveries
  <index> body <body> depth <n> end <pc>
    restart <Name> -> <pc> binds [<slots>]
    catch ordinary|before-unwind -> <pc>
```

Indices are assigned in body order, nested records before enclosing records and siblings in source order. Each descriptor group preserves source order. Use two-space record indentation, four-space descriptor indentation, single field spaces, existing zero-padded PC formatting, plain Name operands and comma-separated integer slots; print `binds []` when empty. The record and its Unwind entry have the same depth.

### Instructions

| Instruction | Operands | Pops | Pushes | Behavior | Errors |
| --- | --- | --- | --- | --- | --- |
| `catch-accept` | none | 0 | 0 | Marks successful pattern/Guard acceptance; ordinary catches end pending dispatch, Recovery Catches retain selection | none |
| `catch-next` | none | 0 | 0 | Terminal dispatch continuation: preserve local writes, discard the declining selector control and continue at the next catch/search cursor | none |
| `invoke-restart` | `name`, `count` | count | 0 | Terminal selection transfer, with atomic lookup and exact arity | `restart unavailable`, `wrong arity` |

Both control instructions and invocation are non-suspending. `restartAvailable` uses ordinary `call-builtin restartAvailable 1`, not a new query opcode. Extend `end-cleanup` with pending-transfer cleanup alongside its Error and cancellation modes; it remains 0 → 0 with the existing return cost.

Each new-form catch descriptor starts with `store t` of the context's Error, then pattern and Guard tests in an ordinary guard region. Failure reaches `catch-next`. Acceptance executes `catch-accept`, then the normal temporary-binding moves and body. A Recovery Catch's fallthrough reaches `catch-next`; an ordinary catch's fallthrough takes its finally copy and after-try jump. A transfer binds action slots without generated `store` instructions; action exits use ordinary finally-copy lowering. There is no normal-path action execution: normal try completion jumps past the clauses.

Catch bookkeeping maps to the catch head; invocation maps to `invoke`. Argument expressions retain their own positions. Generated action-exit bookkeeping maps to the restart declaration; action instructions retain their own construct positions. The action-entry PC is its first instruction, including generated exit bookkeeping for an empty action.

### Execution contexts

A recovery context holds the original Error and fault position, retained continuation references, search/clause cursor, owner-local reference, selector activation, pending target/arguments/attempt and cleanup progress. A selector has its own PC and operand stack, initialized with the owner's outer iterator prefix and dispatched Error, while reading and writing the actual owner's locals. Original failed PCs and operand stacks stay retained, not overwritten with selector control.

Helpers use ordinary frames, the current Run and its Grants/budgets. Count every retained real frame once for call depth; a selector creates no call-depth frame or synthetic call charge. A nested context can refer to an earlier selector's continuation; the ultimate locals remain those of a real owning frame. Continuation/ownership references are acyclic abstract machine references, not Script Values or Trace IDs.

Decline restores the retained dispatch cursor without restoring locals. Transfer removes exited control, preserves the selected owner's locals and iterator depth, then enters its action. Free completed contexts promptly. Never charge a frame twice merely because both retained and active control reference it.

Limit Fault and Stop enter no Recovery Catch and run no finally. Cancellation retains existing Segment rollback and Cleanup Budget behavior, but enumerates both selection-local and retained finally scopes exactly once. Scope identity is the control activation plus its cleanup entry, not just a shared-local frame: one frame can hold several legitimate finally scopes. A selector inherits its owner's already active scope identities instead of creating duplicate instances of those scopes. Cancellation charges no unwind. No new Host Input or normative embedding interface is introduced.

## Fuel and Persistent State

All rates below add to provisional Cost Model 0 without changing its version:

| Key | Fuel | Allocation |
| --- | --- | --- |
| `catch-accept` | `1` | 0 |
| `catch-next` | `1` | 0 |
| `invoke-restart` | `8 + count` | 0 |
| `builtin.restartAvailable` | `3 + utf8(x1) / 16` | 0 |
| `recovery-search` | `4 * searchframes + searchentries` | 0 |

Use existing rounding of divided terms. `searchframes` is the number of execution-frame contexts visited by this search; `searchentries` counts logically inspected active Unwind/recovery rows and descriptors. Do not redefine `frames`, which counts actual popped frames. Traverse applicable scopes innermost first in existing Unwind priority; catch search examines catch descriptors in source order, and name search examines restart descriptors in source order. Count each applicable row or descriptor once per visit, including unsuccessful tests, but not statically inactive ranges. Indexing is allowed only if the same normative counts result. A declining catch resumes its saved cursor rather than rescanning previous clauses.

Charge complete search atomically before acting on its result, including missing-name and wrong-arity choices. Charge the existing 4-Fuel `clause` rate at the first instruction of every new-form catch descriptor attempted, together with that instruction. Availability outside selection still validates text and pays its base/text rate but performs no search; malformed names likewise need no search. Wrong-kind arguments follow existing Built-in validation ordering.

Search is indivisible. It may produce Fuel Slice debt under existing rules, and the Run can be preempted at the following instruction boundary; there is no mid-scan saved cursor. Ordinary clause instructions, helpers and finally instructions retain their costs. Charge `unwind` before each batch of real frames actually popped, not for selector disposal or for future batches a cleanup Error may prevent. Attribute that work to the driving raise, `catch-next`, invocation or `end-cleanup` instruction. Transfer's `end-cleanup` costs the existing 2 Fuel and does not raise the original Error again.

The new search surcharge applies when recovery metadata participates or a new query/invocation performs lookup; ordinary-only Error processing retains its previous Fuel. Metadata incurs no normal-path instruction or Fuel.

Control bookkeeping counts only toward Persistent State:

| Record | Logical bytes |
| --- | --- |
| Recovery context | `96 + 8 * argumentCount + contents(original Error and pending arguments)` |
| Selector activation | `48 + contents(operand stack)` |

Here `contents` sums held Script Values as the existing size rules do, and `argumentCount` counts pending chosen arguments. Real frames, owner locals and existing cleanup records retain their usual sizes and count once. A value held separately in multiple slots/stacks/contexts counts each time under the existing no-sharing size rule; sharing owner-local storage does not duplicate that storage. Control references and the per-Run attempt counter are included in the fixed bookkeeping sizes (the Run base remains 96). Constructed Error maps, lists, texts and other Script Values retain their normal allocation charges.

## Save and restore

Save the context stack, activation PCs/stacks, original continuations, local-owner references, search cursor, pending choice and arguments, attempt counter and cleanup progress. Retain existing Fuel/debt, counters, Segment base/ordinal and scope state. Restoring must reproduce execution, charges and Trace exactly, including preemption in policy, after choice and during cleanup.

Each Core uses its own private snapshot format; no common binary format or automatic migration is added. Validate code identities, body/table/PC references, cursor bounds, phase consistency, owner-local slot layouts, target argument counts, cleanup references and acyclic ownership before accepting a snapshot. Maintain existing exact-version compatibility checks and `effects pending` save refusal. New language-version numbering is not required; private save-format versions can change where necessary.

## Trace

Add these non-input records, with keys in the shown order and the existing Trace value/CodePosition display forms:

```text
restart-chosen <run> attempt=<int> name=<text> at=<CodePosition> target=<CodePosition> args=<list>
restart-entered <run> attempt=<int> target=<CodePosition>
```

`at` is the invocation instruction and `target` the action-entry instruction, using the existing `at` field type (code unit and PC). Omit empty `args` under the optional-arguments convention. The per-Run counter starts at zero; each valid, successfully charged choice increments it and records the resulting number, starting at 1. Missing names, wrong arity and faults before selection charging completes consume no attempt and emit neither record.

Emit choice before transfer cleanup; emit entry after atomic parameter binding and PC transfer, before charging the first action instruction. A first-instruction fault therefore has an entry record. A choice whose cleanup fails or is cancelled has no entry. Nested choices share the Run's monotonically increasing sequence. Save the counter so restoration never reuses numbers.

Decline, lookup and successful transfer cleanup emit no additional `raise`. Ordinary new Errors, throw/rethrow and Error-mode cleanup keep their existing records. No abort record is needed: subsequent Error/fault/Run outcome records explain a choice without entry.

## Tooling

Update the shared formatter, highlighting, checker/LSP diagnostics, lint engine, CLI/session and Playground syntax support with implementation. Dynamic availability does not require a statically known offer, so do not diagnose an invocation solely because no lexical declaration is visible. Cover every new Advanced tag with its beginner wording and fixture.

Debug stepping and replay follow the active execution cursor, not the retained failed stack's deepest PC. Extend tooling-only debug frame views with optional `role` (`retained` or `recovery`) and an owning-frame reference for recovery activations, while preserving ordinary frame views and displaying the actual shared owner locals. These views do not affect chapter 9's Inspect schema, Trace or costs, and debugger callbacks remain outside saves.

## Acceptance and delivery handoff

The implementation must include both Cores and reference/tooling support before activating these rules in the Data Files. No parser, opcode, Built-in, cost, diagnostic, Error, Trace or Advanced catalogue is activated by this design PR. Deferred source files are `grammar.ebnf`, `grammar.toml`, `diagnostics.toml`, `machine.toml`, `costs.toml`, `errors.toml`, `stdlib.toml` and `corpus.toml` under `spec/data/`, plus their schemas and generated consumers as needed. Reconcile display/Trace grammar where needed. Move examples to checked `talk` blocks only once reference parsing/lowering supports them.

Required acceptance cases:

- Literal bracket syntax, optional Guard placement, reserved-word migration, formatting round trips, duplicate names, illegal parameters, lexical permission reset, forbidden exits and static/dynamic suspension restrictions.
- The two row policies above, proving retained accumulation without repeated earlier conversion; Library nesting, recursion, shadowing, arity, availability and same-Run boundaries.
- Decline to later catches, ordinary barriers even on failed patterns, Guard skips, owner-local writes and isolated nested policy failures.
- Deeper finally before action, offering finally after action, action failures outside sibling offers, multiple finally scopes in one frame, local versus escaping cleanup Errors, and cancellation during policy/transfer.
- Exact lookup/clause/invocation costs, failed-choice charging, Fuel Slice debt, retained-frame/helper depth, control-record sizing and constructed-value allocation.
- Preemption before and within policy, after choice, during cleanup and at action entry; injected save/restore reproducing complete Trace, counters, locals and outcomes; malformed recovery snapshots.
- Ordinary Error writes/effects, Limit Fault/Stop/cancellation boundaries, normal action suspension, complete opcode/metadata disassembly coverage, unchanged ordinary-only lowering/Fuel, and debugger/replay parity.

Run every new corpus case explicitly while unblessed, in both Cores and available injected save/restore modes. Execution agreement is not first-blessing approval: present independently derived expected-cost figures and the exact expectation diffs for human review before blessing. Leave unrelated pending approvals untouched.
