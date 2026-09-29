# Findings: does the Join hold up in the grammar and on the page? (issue #48)

**Verdict: yes, with narrowing.** `wait for all ⏎ … ⏎ end wait` is decided on the one token after `wait for`. It adds no second-token decision and no relexes, and all 13 sketch files parse (the 12 from #54 plus the new `13-joins.talk`). The member rule from grilling (members keep `and wait`) needed no parser change at all. A Join needs seven load-time rules, four of them new since grilling ([§2](#2-the-load-time-rules)). Readability is good for the short Joins a Script actually writes. `… and wait` inside a block that doesn't wait on each call reads oddly in principle, but the head stays in view in every sketch Join ([§3](#3-readability-before-and-after)). One trap turned up: sending to `me`, the escape hatch for per-branch logic, depends on the target clause's queueing policy, and no ADR says what the default policy is ([§4](#4-a-trap-the-escape-hatch-and-queueing-policies)). Nothing here sends the design back to grilling.

How this was checked: the #54 parser, extended on this branch. `peek(2)` still throws, and every second-token decision is still counted. The parse sketch now also runs a small checker, `check.ts`, for the Join's load errors. Run from the repo root:

```sh
bun prototypes/parser-sketch/run.ts            # 13/13 files, LL(2) report, Join checks
bun prototypes/parser-sketch/run.ts --broken   # the #48 cases are at the end
bun prototypes/parser-sketch/run.ts --check-table
```

## 1. Lookahead

- **`wait for all` is decided on one token.** After `wait for`, the parser already chose between a newline (the event block) and an event name. `all` is a third case, decided at `peek(0)`. The report has no new site.
- **`all` is contextual, not reserved.** It means "Join" only right after `wait for`. So it can't name a Handler, a message or an event: `on all`, `send all to hub` and `when all then` in a `wait for` block are syntax errors at `all`. It stays a fine variable name (`put [] into all`). `13-joins.talk` uses it as one.
- **The body is an ordinary block** ending at `end wait`, so `if`, `repeat`, `match` and `try` nest as usual. A Join inside a block Lambda parses too, and a Join may sit in a Lambda's body (the Lambda is then may-suspend, ADR 0025).
- **Members parse as they did.** `send … and wait` and `ask … and wait` are the same statements inside a Join. The `and-wait` site count rose from 61 to 82, all from the new file.

**Relexes: 0. Lookahead beyond two tokens: none. New LL(2) sites: none.**

## 2. The load-time rules

`check.ts` runs on a tree that parsed. Without Operation Declarations it trusts `and wait` to mark a suspending call, which ADR 0019's both-ways check would already have verified.

- **Members:** every `send … and wait` and `ask … and wait` the Join body reaches, including inside `if`, `repeat` and `match`. Calls inside a Lambda in the body belong to the Lambda, not the Join. Plain `send`, `tell` and immediate `ask` run where they are, as ordinary statements.
- **Load errors inside a Join body.** The first three were settled in grilling:
  1. `wait`, `wait for` or a nested Join. "The Join's `end wait` is its only Suspension Point."
  2. A Command Call `name … and wait`. It runs in this Run, so it can't run concurrently. The message suggests `send name … to me and wait`.
  3. `f(x) and wait` on a Function Value. A local one runs in this Run.
  The next four are **new**:
  4. **`return` and `pass`** would leave the Join with calls started and never waited for.
  5. **`exit repeat` and `next repeat`** may only reach a `repeat` inside the same Join, for the same reason.
  6. **A member inside a `try` in the body.** Its answer, or its failure, arrives at `end wait`, so that `catch` would only see failures to *start* the call (a full mailbox, a revoked Grant). A `try` with no member in it is fine, and a `try` around the whole Join is the way to catch.
  7. **A Join with no members** in its source. A Join whose members sit in an `if` or a loop that never runs is still fine, and gives `[]` at runtime (grilling Q9).
- **`throw` inside the body is allowed.** Like a failure to start a member, it abandons the members already started, exactly as fail-fast does. The parser can't test this. It is for the ADR to state.
- A Command Call without `and wait` is assumed not to suspend. The real loader knows, and ADR 0020 already makes a Handler that may suspend a load error there.

## 3. Readability, before and after

From `13-joins.talk`:

| Task | Before | After | Verdict |
| --- | --- | --- | --- |
| fetch N stations, continue when all are in | `send fetchOne with s to me` in a loop, a second Handler, a Script Variable and a count check (09) | one `wait for all` around the loop, and the answers are in `it`, in order | much better: one Handler, one Suspension Point, and nothing to count |
| per-station logic (paging) | the same, with the paging in `fetchOne` | `send allReadings with s, day to me and wait` as the member | good, but see §4 |
| different calls at once (a quote and a stock check) | not possible without a helper Handler per call | two `ask … and wait` lines in one Join | good. A conditional member makes `it`'s length depend on the data, so the result needs `let [a, b, ...rest] be it` |
| catch the first failure | n/a | `try` around the Join, and `catch {code: "timeout", index: i}` | good. `index` finds the failed input with `item i of stations` |
| every outcome, not just the first failure | n/a | each member is a send to a Handler that catches | heavier than `Promise.allSettled`. That's the cost of fail-fast plus rule 6, and it keeps tagged results out of the language (ADR 0017) |
| a Join in a stored callback | n/a | a block Lambda holding a Join, called with `refresh() and wait` | reads well |

On the open question from grilling:
- **`… and wait` inside a block that doesn't wait on each call.** In principle each line claims to wait on its own. In practice every Join in the sketch is 3 to 9 lines, so `wait for all` stays in view, and `and wait` keeps meaning "a request with an answer". Mixed bodies (§3 of the sketch) still read clearly, because the non-members (`tell`) look different. This doesn't reopen grilling Q6.

What this suggests (lints, not grammar):
- A long Join body, where the head scrolls away, could be flagged, or a lint could suggest moving the calls into a loop.
- A plain `send` inside a Join is most likely a forgotten `and wait`, so it's worth a lint.
- A member inside an `if`, where the result's length depends on the data, could get a hint to Destructure with a rest.

## 4. A trap: the escape hatch and queueing policies

Per-branch logic goes in a Handler reached by `send … to me and wait` (grilling Q1). Those sends start Runs of the same clause, so **the clause's queueing policy (ADR 0016) decides whether the members actually run concurrently:**

- `, every time`: they run concurrently. `13-joins.talk` writes it on `allReadings` and `latestOf`.
- `, queued`: they run one at a time. The Join still works, but serially, and each member's `MaxWait` includes its time spent queued.
- `, dropping`: every member after the first ends `dropped`, so the Join fails fast with `send failed`, reason `dropped`.
- `, replacing`: each new member cancels the one before, so the Join fails fast with `send failed`, reason `cancelled`.

**No ADR says what a clause with no suffix does.** The syntax sketch asks "default for ticks?" and never answers it. The Join ADR should either settle that default or state the rule above, and a lint should flag a Join that sends to `me` for a message whose clauses are all `queued`, `dropping` or `replacing`.

## 5. Proposed narrowing notes for the Join ADR

1. **Lookahead:** `wait for all` is decided on the token after `wait for`. `all` is contextual. It can't name a Handler, message or event, and stays a variable name.
2. **Members:** `send … and wait` and `ask … and wait` reached in the body, including inside `if`, `repeat` and `match`, but not inside a Lambda. Everything else runs where it is.
3. **Load errors in a body:** `wait`, `wait for`, a nested Join, `name … and wait`, `f(x) and wait`, `return`, `pass`, `exit repeat` or `next repeat` to a loop outside the Join, a member inside a `try`, and a Join with no members in its source.
4. **`throw` and failures to start a member** inside the body abandon the members already started, as fail-fast does.
5. **The escape hatch depends on queueing policy** (§4). State the default for a clause with no suffix, or say that concurrency needs `, every time`.

## 6. Left open

- **Runtime:** `MaxJoin`, abandonment, the `Call` cancellation signal and the `abandon` Trace record are Core behaviour, which a parser can't exercise.
- **Operation modes:** the checker trusts `and wait`. Checking members against Operation Declarations is the ordinary ADR 0019 check.
- **The default queueing policy** for a clause with no suffix (§4).
- **Line-level Joins**, e.g. a one-line `wait for all ask …, ask …`. Not needed by any sketch, and a syntax error for now.
