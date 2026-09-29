# A Join starts several calls from one Run and suspends once

A Script waits on several requests at once with a Join: a `wait for all … end wait` block. Its body is ordinary code that can't suspend. Every `ask … and wait` and `send … and wait` the body reaches is a Join Member. Each member is started where it stands and not waited for, and `end wait` is the one Suspension Point. When every member has answered, `it` holds the answers as a list, in the order the members were started. The first failure to arrive is raised at the Join: the member's own error, with `index` (its 1-based start position) added. The members still pending are abandoned, just as if the waiting Run had been cancelled. A Host-set `MaxJoin` caps how many members one Join may start, and starting one more is a Limit Fault. Logic that belongs to one branch, such as paging through one station's readings, goes in a Handler that the Join reaches with `send … to me and wait`. That only runs concurrently if Handler Clauses do, so this ADR also settles the default: a Handler Clause with no queueing suffix runs concurrently, and `, every time` is removed. For example:

```
on compare stations
  wait for all
    repeat for each s in stations
      send allReadings with s to me and wait
    end repeat
  end wait
  put it into perStation
end compare
```

We chose this because a join can't be stdlib: Libraries can't `send` and Built-ins can't suspend (ADR 0021). Of the language forms, starting the calls from one Run keeps every invariant as it stands. One Run still makes one step at a time. Its Segments are still split only at Suspension Points written in the source (ADR 0004). Each member gets an ordinary call id in start order (ADR 0015), and no new value kind appears (ADR 0001). Keeping `and wait` on members leaves ADR 0019's both-ways check untouched, and `and wait` still means "a request that gets an answer". Failing fast with the member's own error keeps existing `catch` clauses matching (ADR 0017), and treating the losers as a cancelled wait adds no rule of its own. A concurrent default is ADR 0004's model: a new Run may start while another is suspended. A serial default would run a Join through `me` one member at a time, and a clause that sends its own message to `me` and waits would deadlock until `MaxWait`.

## Considered Options

- **Branch Runs:** each branch is a block that runs as its own Run of the Script, and the parent Run joins them. It is more expressive, but it needs a parent-child relationship between Runs, cancel propagation, and a budget rule, because ADR 0015 already rejected per-Run Fuel slices on the grounds that a Script can multiply its slice by starting more Runs. A send to `me` covers the same need with machinery that exists.
- **Futures:** `start ask …` returns a pending handle that a later statement waits on. A handle isn't plain data, so it breaks Value Semantics (ADR 0001) and Script Snapshots (ADR 0008).
- **A stdlib `all(fs)` over Function Values:** Library code can't suspend (ADR 0020), and a local Function Value runs in the caller's Run (ADR 0025), so it can't run concurrently.
- **Settle every member, then raise the first failure in start order:** which error you get no longer depends on timing, but a Join waits out its slowest member even after it has already failed. Arrival order is a Host Input, so fail-fast replays exactly anyway (ADR 0018).
- **Collected outcomes (`{ok: v}` / `{error: e}` per member):** tagged results as a language feature, which ADR 0017 rejected. A member that must never fail is a send to a Handler that catches.
- **Wrapping the failure as `{code: "join failed", index, error}`:** every existing `catch {code: "http", …}` would stop matching inside a Join.
- **Cancelling the receiver's Run when a send member is abandoned:** a sender would gain the power to cancel another Script's Run, and one Script's `finally` blocks would run on another's timing.
- **Ignoring abandoned Capability calls with no signal to the Host:** the Host keeps an HTTP request open that nobody will read.
- **A catchable width error:** the width is a resource limit, and ADR 0006 keeps resource limits uncatchable.
- **No width cap:** Persistent State bounds pending calls only indirectly, and a Host couldn't bound concurrent outbound calls per Script.
- **A deadline for the whole Join** (`wait for all … or 30 s`): each member already times out on its own `maxPending` or `MaxWait`, and with fail-fast one timeout ends the Join. It can be added later without breaking anything.
- **`together … end together`:** it doesn't say `wait` where the Run suspends, which ADR 0019 requires of every Suspension Point.
- **Members without `and wait`** (every `send` and suspending `ask` in the body is a member): it turns ADR 0019's both-ways check around inside the block, and a plain `send` quietly changes meaning there.
- **A queued default for Handler Clauses:** safer for Script Variables, but it brings back ADR 0004's rejected strict serial Script clause by clause, serialises Joins through `me` and makes a clause that sends its own message to `me` and waits deadlock.
- **A dropping default:** it silently loses messages.
- **Keeping `, every time` beside a concurrent default:** two spellings for one thing, which ADR 0019 rejects.

## Consequences

- **Syntax:** narrows ADR 0019.
  - A Join is `wait for all` at the end of a line, then statements, then `end wait`. There is no one-line form.
  - It is decided on the token after `wait for`, alongside a newline (the event block) and an event name, so it adds no second-token decision.
  - `all` is contextual. It can't name a Handler, message or event (`on all`, `send all to hub` and `when all then` are syntax errors at `all`), and it stays a variable name.
- **Members:**
  - A Join Member is an `ask … and wait` or `send … and wait` that the body reaches, inside `if`, `repeat` and `match` too. A call inside a Lambda in the body belongs to the Lambda.
  - A member leaves `it` unchanged inside the body. Plain `send`, `tell` and immediate `ask` run where they stand, as anywhere else.
  - A Join may sit in a block Lambda, which is then may-suspend (ADR 0025).
- **Load errors in a Join body:**
  - `wait`, `wait for` or a nested Join, because `end wait` is the Join's only Suspension Point.
  - A Command Call written `name … and wait`, or `f(x) and wait`. Both may run in this Run, so they can't run concurrently. The fix is `send name … to me and wait`.
  - `return`, `pass`, or an `exit repeat` or `next repeat` whose loop is outside the Join, since each would leave with members started and never waited for.
  - A member inside a `try` in the body. Its answer and its failure arrive at `end wait`, so that `catch` could only see a failure to start it. A `try` goes around the whole Join.
  - A Join with no member in its source.
- **Results:**
  - `it` is the list of answers in start order, and its length is the number of members started, which can vary at runtime.
  - A Join that starts no members sets `it` to `[]` with no suspension and no Segment boundary, like `f(x) and wait` on a value that can't suspend.
  - Every answer is converted and charged when the Run resumes, in start order (ADR 0015). Answers that arrive early count toward Persistent State while the Run waits.
- **Failure:** narrows ADR 0017.
  - The first failure to arrive resumes the Run and is raised at `end wait`, as the member's error map plus `index`. A failed send member raises `send failed` as usual.
  - `index` joins the keys a Host `Fail`'s `Data` may not use. The Core adds it only when it's missing, so a rethrow keeps it.
  - A failure to start a member (`mailbox full`, `capability revoked`), or a `throw` in the body, raises at that statement. Members already started are abandoned.
  - A Limit Fault, a cancellation (`, replacing`, `CancelRun`) or Stop Script while the Join waits abandons every pending member.
- **Abandoned members:** narrows ADR 0015.
  - A Capability call gets a cancellation signal on `Call` (a context in Go, an AbortSignal in TS), which the Host may honour. An answer that arrives later is ignored.
  - A send member's receiver keeps running, and its reply is dropped. The same holds for any `send … and wait` whose sender is cancelled: a sender's cancellation never cancels the receiver.
- **Limits:** narrows ADR 0006 and ADR 0015.
  - `MaxJoin` is a Host-set width per Script. Starting a member past it is a Limit Fault at that statement: the Segment rolls back, and the members already started are abandoned.
  - Each member is charged Fuel as the same call outside a Join would be, pending members count toward Persistent State, and each member's own `maxPending` or `MaxWait` applies.
- **Trace:** narrows ADR 0018.
  - Each member gets a `call` or `send` line as today, with call ids in start order (`pricing/r1.c1`, `…c2`, …), and the `seg` end reason names the Join and its width (`join n=3`).
  - On fail-fast, the `raise` carries `index`, and a new output record, `abandon <call-id>`, follows for each pending member, in start order.
  - An `answer` or `fail` for an abandoned call is still recorded as a Host Input, followed by a `note` that it was ignored.
- **Save and restore:** a Run suspended in a Join holds several pending calls, and each is settled on its own by call id (answer, re-issue, fail or adopt, ADR 0015). Answers already received are part of its frame.
- **Queueing default:** narrows ADR 0004 and ADR 0016.
  - A Handler Clause with no queueing suffix runs concurrently: a new Run starts while earlier Runs of the clause are suspended, and they interleave at Suspension Points.
  - `, every time` is removed. The suffixes `queued`, `dropping` and `replacing` only narrow the default, and `on tick, every time` is a syntax error.
  - A foreign call to a Function Value (ADR 0025), which has no Handler Clause to carry a suffix, runs concurrently too.
  - Sending to `me` from a Join runs concurrently unless the target clause opts out. With `, queued` the members run one at a time, and with `, dropping` or `, replacing` the Join fails fast with `send failed`. A lint flags a Join that sends to `me` for a message whose clauses all opt out.
- **Lints, not grammar:** a long Join body whose head scrolls out of view, a plain `send` inside a Join (most likely a forgotten `and wait`), and a member inside an `if`, which makes the length of `it` depend on the data.
- **Checked by the parser prototype** (#48): `wait for all`, the contextual `all` and the removal of `, every time` parse with no new second-token decision and no relexes, and all 13 sketch files parse and pass the Join checks. The load errors above come from its checker.
  - **Source:** the [prototype](https://github.com/odogono/odgn-talk/tree/prototype/joins-sketch/prototypes/parser-sketch) is the primary source: its `FINDINGS-48.md`, `check.ts`, `broken.talk` and `../syntax-sketch/13-joins.talk`.
- **Left for later:**
  - The Abstract Machine instructions that start a member and wait on the Join, and their Cost Model rates, written with the final spec (ADR 0010).
  - `MaxJoin`'s default, and the exact key names of the `abandon` record, settled with the embedding API and the final spec.
  - A deadline for the whole Join.
