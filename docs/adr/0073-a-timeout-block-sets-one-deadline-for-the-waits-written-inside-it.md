# A Timeout Block sets one deadline for the waits written inside it

A Script bounds a whole Join, or any run of waits, with a Timeout Block: `with timeout of d … end timeout`. Entering the block sets one deadline: the Clock reading of the Pump in which it is entered, plus the exact duration `d`. Every Suspension Point written inside the block waits at most until that deadline, as well as within its own limit, and the earlier of the two wins. When the block's deadline runs out first, what the Run waits on is abandoned, as when a call's own limit runs out, and the Run raises `timeout` with `deadline: true`. For example:

```
on compare stations
  try
    with timeout of 5 s
      wait for all
        repeat for each s in stations
          send allReadings with s to me and wait
        end repeat
      end wait
    end timeout
    put it into perStation
  catch {code: "timeout", deadline: true}
    put nothing into perStation
  end try
end compare
```

We chose this because ADR 0026 left a deadline for a whole Join open, and a block also covers a run of separate waits that should share one time limit, such as a request followed by its confirmation. The block reuses machinery that already exists. Its deadline is one more timer on the Pump's Clock, fired in deadline order like `maxPending` and `MaxWait`, so it stays deterministic and replays exactly (ADR 0015, ADR 0018). What it abandons is abandoned by today's rules (ADR 0026, #79), and it raises the existing `timeout` code, so every `catch "timeout"` still matches. The scope is lexical. A Suspension Point is bounded only if it is written inside the block, so the loader can see each one (ADR 0004), and the block never reaches into another Handler's waits through dynamic scope, which ADR 0020 also avoids. A Command Call that may suspend is a load error inside the block, as it is in a Join body. Its waits run in this Run but are written elsewhere, so the block couldn't bound them. `send name … to me and wait` is one bounded wait, and is the fix.

## Considered Options

- **`within 5 s … end within`:** shorter, but `within` would be a new contextual word at the start of a statement, and `end within` reads poorly. `with timeout of` is AppleScript's spelling, which many of the language's readers know, and `end timeout` names what closes.
- **`wait for all … or 30 s`:** ADR 0026 considered it. It bounds only a Join, and a Join can't bound a sequence of waits.
- **Dynamic scope** (the deadline follows the Run into the Handlers it calls): AppleScript's behaviour. A Handler's waits would then depend on its caller, and a Library's would depend on who imported it (ADR 0020).
- **Allowing suspending Command Calls, unbounded:** the block would look as if it bounded `blink and wait` while not bounding it.
- **A new error code, `deadline`:** easier to match, but every existing `catch "timeout"` would stop catching a wait that ran out of time.
- **`timeout` with no new key:** a block's deadline could then be told from a call's own limit only by `after`, or by an `index` or `capability` that is missing, which no `catch` should depend on.
- **Keeping `index` when a block's deadline ends a Join:** no member failed. The Join as a whole ran out of time, so the error carries no `index`, and `catch {code: "timeout", index: i}` keeps meaning that one member timed out.
- **An inner block that may outlast its outer one:** the outer deadline would no longer bound everything written inside it.

## Consequences

- **Syntax:** narrows ADR 0019.
  - A Timeout Block is `with timeout of` and an expression at the end of a line, then statements, then `end` or `end timeout` (ADR 0042). There is no one-line form, and it is a full statement, not an `Inline`.
  - At the start of a statement, `with` followed by `timeout` opens the block, and otherwise `with` starts a Command Call, as `choose` does before `offer`. This is one new second-token decision, `with-timeout`.
  - `timeout` is contextual: a keyword only after that `with`, and in the `end timeout` suffix. It stays a Name everywhere else.
- **The deadline:**
  - `d` is evaluated once, when the block is entered. Anything that isn't an exact duration Quantity raises `wrong kind`, as for `wait d`. Entering the block isn't a Suspension Point.
  - The deadline is the Clock reading of the Pump in which the block is entered, plus `d`. It fires at the first Pump whose Clock reading is at or past it, in deadline order with the other timers.
  - Blocks nest. An inner block whose deadline is later than an enclosing block's gets the enclosing one, so the earliest deadline in force always wins.
- **What it bounds:** every Suspension Point in the block's source, outside the Lambdas written there: `wait d`, `wait for` in all its forms, `send … and wait`, `ask … and wait`, and a Join's closing `end`. Each waits until the earlier of its own deadline and the block's. Of equal deadlines, the block's wins, and of nested blocks with equal deadlines, the outermost wins.
  - `wait for`, which `MaxWait` never bounds, is bounded by the block. `wait for m or d` whose block runs out first raises `timeout` rather than leaving Nothing in `it`.
  - A Suspension Point reached after the deadline has passed raises `timeout` at once. It starts nothing and doesn't suspend, so it ends no Segment. This is how a `catch` inside the block that keeps going meets the deadline again at its next wait.
  - After the block ends, its deadline no longer applies.
- **When the deadline runs out:** narrows ADR 0017 and ADR 0026.
  - What the Run waits on is abandoned as a call that times out is: an abandoned Capability call gets the cancellation signal on its `Call`, a `send … and wait`'s receiver keeps running and its reply is dropped, a `wait` or `wait for` stops waiting, and a Join abandons every member still pending, in start order.
  - The Run raises `{code: "timeout", after, deadline: true}` at that Suspension Point. `after` is the `d` of the block whose deadline ran out, in `ms`. A Capability call adds `capability` and `operation`, as its own timeout does. A Join's error has no `index`, because no member failed.
  - `deadline` joins the reserved keys that a Host `Fail`'s `Data` may not use.
- **Load errors:**
  - `not in a timeout`: a Command Call written `name … and wait`, or `f(x) and wait`, in the block's source outside a Lambda. The fix is `send name … to me and wait`.
  - `empty timeout`: a block with no Suspension Point in its source. A Join Member isn't a Suspension Point, so a Timeout Block in a Join's body is always this error, since the Join's closing `end` is outside it.
- **Allowed:** a Timeout Block may sit in a Handler, a function's or Lambda's block, or Library code, where only `wait d` can suspend (ADR 0020). It may hold a `try`, and may sit in one.
- **Trace:** narrows ADR 0018. No record is new. A `seg` record's `until` and a `pumped` record's `next` give the earliest deadline, a block's included. The `raise` carries `deadline: true`, and an `abandon` record follows for each call abandoned, as for any `timeout`.
- **Save and restore:** narrows ADR 0008. A Run's frame holds each open block's deadline as an absolute Instant. After a restore, an overdue deadline fires at the first Pump with the other overdue timers, in deadline order.
- **Delivery:** the spec's rules land with this ADR (ADR 0032): the grammar in chapter 2, `grammar.ebnf` and `grammar.toml`, chapters 5, 6, 10 and 11, `errors.toml` and `diagnostics.toml`, and the reference parser with its sketch and broken cases under `tools/grammar/timeout-block/`. Both Cores' coverage tests require every instruction in `machine.toml` to be emitted, so the instructions that enter and leave the block, chapter 8's lowering and their Cost Model rates land with the Cores' implementation, together with the Trace Cases. Those cases cover a deadline that fires inside a Join, one that doesn't, and nesting.
- **Settles** the item "a deadline for a whole Join" in Appendix C, left for later by ADR 0026.
