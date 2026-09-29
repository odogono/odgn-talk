# Errors are plain maps, raised with `throw` and caught by Destructuring

A Script handles ordinary errors with `try … catch … finally … end try`. An error is a plain map with a required text `code`, e.g. `{code: "can't convert", to: "number", value: "lots", message: "…", at: {…}}`. `throw <map>` raises one, and `catch` clauses are Destructuring heads with optional Guards, tried top to bottom like Handler Clauses (`catch {code: "http", status: s} where s >= 500`). A bare `catch e` catches everything, and if no clause matches, the error keeps unwinding. An uncaught error ends the Run as `errored`. The Core then puts an ordinary `error` message in the Script's own mailbox, which an `on error e, during msg` Handler can pick up as a new Run. Built-ins, Capabilities and `send … and wait` all fail the same way, by raising. Tagged results (`{ok: v}` / `{error: e}`) are not a language feature. We chose this because built-ins like `+`, `as number` and chunk writes can't return tagged results, so one raising mechanism has to exist anyway, and a second, parallel one would split every API. Catch clauses reuse the Destructuring and Guard machinery that dispatch already has (issue #4, ADR 0010). Plain maps follow Value Semantics (ADR 0001), save in a Script Snapshot as they are (ADR 0008), and need no new value kind. And a backstop sent as a message keeps the actor model (ADR 0004): it never runs inside the failed Run, and it can't resume it.

## Considered Options

- **Tagged results as the main style** (Elixir `{:ok, v}`): honest and composable, but built-in operations can't use them, so they would need a raising mechanism underneath anyway. Every caller also needs its own `match`, or a `with` form. Scripts may still return such maps by convention; the language and Operation Declarations know nothing about it.
- **Let it crash only, with no `try`:** fine for Erlang with supervisors, but a beginner can't skip one bad line of a CSV without writing a helper Script.
- **Both forms offered by Capabilities, plus `with` in the advanced layer:** two ways to fail through every API. Deferred along with `with`.
- **A distinct Error value kind:** errors could be told apart from data, but that needs its own Destructuring rules, display form and Snapshot encoding.
- **Identifier-style codes** (`not_a_number`): the language has no symbol kind, so they would be text anyway, and ADR 0015 already writes codes as words.
- **A staging rule for `try`** (undo Script Variable writes when an error is caught): costs memory on every `try` and surprises in the other direction (a log counter that resets). Rollback stays reserved for Limit Faults and cancellation, where the Script can't react.
- **The receiver's failure returned in `it`, or ending the sender's Run outright:** the first lets a failure pass for a reply. The second takes the choice away from the sender. Throwing at the sender gives the let-it-crash cascade by default and lets the sender catch it.
- **A `finally` that also runs on a Limit Fault or Stop Script:** recovery code after running out of budget is what ADR 0006 rejected, and Stop means no more Script code.
- **`try-enter`/`try-leave` instructions:** they would charge Fuel for entering a `try`, and put `try` depth into every frame.
- **`fail "…" with {…}` as the raise keyword:** reads well, but clashes with the Host's `Fail` and pairs less clearly with `catch`.

## Consequences

- **Error values:**
  - `throw` takes only a map with a text `code`. Anything else raises `bad throw`.
  - The Core adds `at` (Handler and source position) only when it is missing, so `throw e` rethrows with the original position.
  - `message` is optional on `throw`. Core-raised errors always carry one, and code-specific fields sit next to it.
- **Error Codes and the catalogue:**
  - Codes are lowercase text in words (`"capability revoked"`).
  - Every code the Core raises is in the error-code catalogue (ADR 0009), a generated spec file alongside `machine.toml` (ADR 0010), with its required fields and a template message.
  - Parity covers the code and the catalogue fields exactly, not the `message` wording.
  - Codes a Script throws are free-form.
  - A family is named after what went wrong, not after the operator: `wrong kind`, `can't convert` and so on. The full catalogue is written with the final spec.
- **Named errors:**
  - A failed `send … and wait`: `{code: "send failed", reason, error}`, where `reason` is the receiver's Run outcome (`errored`, `limit fault`, `cancelled`, `unhandled`, `dropped`) or `stopped`, and `error` is the receiver's error map, present only for `errored`.
  - A `send` to a full mailbox, raised at the `send` even though it doesn't wait: `{code: "mailbox full", to}`.
  - A call through a revoked Grant: `{code: "capability revoked", capability, operation}`.
  - A Text Pattern search on a value that isn't text: `{code: "wrong kind", expected: "text", got: <kind name>, value}`.
  - A conversion failure such as `"lots" as number`: `{code: "can't convert", to: "number", value}`.
  - `{code: "host error", capability, operation}` carries no Host detail, since a panic's text could leak Host internals. That detail goes only in the Host's report.
  - `{code: "timeout", capability, operation, after: <duration>}`, for `maxPending` or `MaxWait` running out (ADR 0015).
- **Capability errors:**
  - A Host `Fail(Error{Code, Data})` raises the Host's code as is. `Data` entries become top-level fields, converted and charged to the calling Run (ADR 0006), and the Core adds `capability`, `operation` and `at`.
  - Catalogue codes are reserved for the Core. A `Fail` using one, or `Data` keys clashing with `code`, `message`, `at`, `capability` or `operation`, becomes `host error`.
  - An Operation Declaration may list its error codes. When it does, the list is enforced (any other code → `host error`), and tooling can offer `catch` completions from it.
- **Across Scripts:**
  - A receiver's failure is thrown at the `send … and wait` sender as `send failed`. Uncaught, the sender's Run ends `errored` too.
  - The receiver's Run still reports `errored`, and its own `on error` still fires.
  - A Host `Request` rejects with the same map: a rejected Promise in TS, an error value in Go.
  - Calling a Handler of your own Script by name is a plain call, so its errors unwind straight into the caller.
- **`on error`:**
  - The `error` message is sent only for the `errored` outcome. There is none for a Limit Fault, `cancelled`, `unhandled` or `dropped`.
  - A Run started by `error` that errors itself produces no further `error` message.
  - With no `on error` Handler, the message is dropped. It never climbs the Message Path.
  - If the mailbox is full, it is dropped with a note in the Trace.
  - `on error` can have clauses (`on error {code: "timeout"}`).
- **Rollback:** a caught error rolls nothing back. A beginner-layer lint may flag a Script Variable written inside `try` before a statement that can fail.
- **`finally`:**
  - `finally` is a clause of `try`. A Handler may also end in `finally`, which is sugar for wrapping its whole body.
  - It may contain no Suspension Points, checked at load.
  - It runs on completion and on errors, on the Run's own budgets. An error inside it replaces the error in flight, and the old error goes in the new map's `during` field.
  - It runs on cancellation (`, replacing`, `CancelRun`, a cancelled `Request`) after the current Segment is rolled back (ADR 0006), innermost first, all under one Cleanup Budget. An error or an exhausted Cleanup Budget ends the remaining cleanup, outer blocks included, and the Run still reports `cancelled`, with `cleanup failed` and the code in the report and Trace.
  - It never runs on a Limit Fault or Stop Script.
- **What `catch` never sees:** cancellation, Limit Faults and Stop Script. A `catch e` in a loop can't soak up any of them.
- **Guards:** an error in a Guard skips the clause and is invisible to `try`, `on error` and reports. The same applies to Guards on `catch` clauses. The Trace records the skip with the code. A failed test in `let` stays an ordinary `no match` error (ADR 0010).
- **Abstract Machine:**
  - Each code unit has a normative Unwind Table. An entry gives an instruction range, a kind (`catch`, `finally` or `guard`) and a target, so entering a `try` costs no instruction and no Fuel.
  - The new instructions are `throw`, `rethrow` and `end-cleanup`.
  - Catch clause tests lower to the same per-node Destructuring tests as dispatch. When none matches, the code ends in `rethrow`.
  - ADR 0010's Guard regions become `guard` entries whose target is the next clause.
  - `finally` is inlined on the normal path and reached through its entry on the error and cancellation paths.
  - Unwinding walks frames, including own-Script Handler calls, and is charged per frame popped under a Cost Model formula. A Run that can't pay faults at the `throw`.
  - The order and layout of the Unwind Table are part of the normative lowering and the canonical disassembly.
- **Reports and Trace:**
  - An `errored` Run report carries the error map as a Host value, plus the delivery id.
  - The Trace records the outcome and fault instruction, and the error map without `message` for Core-raised errors. Messages a Script throws are data, so they stay.
  - The Trace also records every raise, caught or not, as a code plus instruction index.
- **Left for later:**
  - `with`, a `throw "code"` shorthand, and the rollback lint go to the grammar and layering fog.
  - The full error-code catalogue goes with the final spec.
- **Narrowed by ADR 0020:**
  - A call into a Library is a plain call like a local one, and errors unwind through Library frames using each Library's own Unwind Table.
  - A Command Call to a Handler that may suspend is written `… and wait`, and a Handler called function-style may never suspend.
- Narrowed by ADR 0025: the catalogue gains `would suspend`, `function gone`, `wrong arity` and `not encodable`. A call to a Function Value from outside its Home Script fails as `send … and wait` does, with `send failed` and the home Run's outcome as `reason`.
