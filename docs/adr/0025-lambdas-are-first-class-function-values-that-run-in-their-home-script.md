# Lambdas are first-class Function Values that always run in their Home Script

The language has Function Values. A Lambda (`given r: the wind of r > 10`, or a `given r … end given` block) makes one, and so does a Script or Library function's bare name. A Function Value is plain data: its Home Script, the code unit and literal it was made from, and the values it captured. It can go anywhere a value can: into locals, Script Variables, lists and maps, return values, a `send` to another Script, and the Host. A call from the Home Script runs the value in the caller's Run, like any function call. A call from any other Script, or from the Host, is a message: the value runs as a Run of its Home Script, on that Script's Fuel and Grants, and the caller waits for the reply. A Lambda body may suspend. The loader records whether it can, the flag travels with the value, and a call that may suspend is written `f(x) and wait`. Comprehensions are removed: filter, map, sort, fold and group are `list` Library functions that take Function Values, and only `every match of` stays as syntax. This supersedes ADR 0019's rejection of lambdas and its Collections section, and it reverses ADR 0021's "no function values". We chose this because stored callbacks, folds, grouping by computed keys and comparators each needed new syntax or were impossible, and one value kind covers them all with ordinary Library code, written once and charged honestly (ADR 0021). Running a foreign call in its Home Script is the only choice that keeps each tenant's Fuel, Grants and Persistent State its own. It also reuses the actor model as it is: a foreign call is `send … and wait` (ADR 0004), and a Host call is a Delivery (ADR 0015). Making the value plain data keeps Script Snapshots plain data (ADR 0008), gives `=` a structural answer (ADR 0001), and gives Traces a display form that round-trips (ADR 0018).

## Considered Options

- **Keeping Comprehensions only** (ADR 0019): each new need (`grouped by`, #47; comparators; folds) would be new syntax, and stored callbacks would stay impossible.
- **Lambdas beside Comprehensions, or Comprehensions as sugar over the Library calls:** two spellings for one operation, which ADR 0019 already rejects for `replace`.
- **Downward-only lambdas** (arguments only, never stored, returned or sent): they avoid every Snapshot, equality and boundary question, but rule out stored callbacks.
- **Function Values that never leave their Script:** simpler Grant reasoning, but a Host that wants a callback would still need a Handler and a message protocol for each use.
- **Running a foreign call in the caller's Run with the caller's Grants,** as a Library function runs (ADR 0020): a confused deputy. A tenant without `http` could send a Lambda to a Script with it and use that Script's authority and Grant bindings.
- **Running it in the caller's Run with the Home Script's Grants** (an object-capability closure): the caller pays the Fuel, so one tenant can drain another's budget with a runaway Lambda.
- **Lambdas that never suspend:** matches "functions never suspend" (ADR 0020), but a stored callback often needs to `ask … and wait`.
- **Two literal kinds, one suspending and one not,** or **static function types** that let the loader check every call: the first adds a second spelling for the same thing, and the second is a new type system.
- **A stale value that rebinds to the new code** when a literal with the same name and position survives a reload: it silently changes what a stored callback does.
- **Dropping Function Values to Nothing** on carry-over and variables-only restores: a stale value should fail loudly where it's called, not turn into Nothing somewhere else.
- **Function Values that are never equal,** or equal only by identity: the first breaks reflexivity of `=`, and the second brings identity into Script values, against ADR 0001.
- **`(r) => …`:** after `(` the parser can't tell a Lambda from grouping within two tokens (ADR 0019). **`fn(r) => …`** and **`function (r) return …`** read less like English than `given`.
- **An implicit parameter** (`filter(readings, the wind of it > 10)`): the second implicit name that ADR 0019 rejects, with no mark of where the Lambda starts.
- **Multi-clause Lambdas with Guards:** they duplicate Handler Clauses.
- **Mutable captures, or captured Script Variables:** the first makes a `put` that is silently forgotten, and the second stops a stored callback from acting on its Script's state.
- **Guards that call Function Values:** ADR 0021's argument stands. Script code can't be proven to terminate, and a Limit Fault in clause selection has no Run to fault.
- **A comparator-only sort:** each comparison would be a call whose count and order depend on the algorithm, and Collation would put n·log n `locale` calls in the Trace. `sortBy` takes a key, and `sortWith` is there when a key won't do.

## Consequences

- **Syntax:** supersedes ADR 0019's Collections section.
  - The expression form is `given p1, p2: expr`. The body extends with the lowest precedence, as `for every` did, so a Lambda in an argument list ends at the next top-level comma or `)`.
  - The block form is `given p1, p2` at the end of a line, then statements, then `end given`. Parameters run up to the `:` or the end of the line, so a Lambda inside an argument list uses the `:` form.
  - `given` is a Reserved Word, so a Lambda is decided on its first token.
  - Each parameter is a Destructuring pattern (`given {wind: w}: w > 10`), with one clause only. A failed test raises `no match`, as in `let`, and a wrong number of arguments raises `wrong arity`.
  - A Script or Library function's bare name is a Function Value (`map(xs, double)`). A Function Value held in a variable is called as `f(x)`. A name that is both a variable and a function is a load error, like an import clash (ADR 0020). Handlers are never values: they are message entry points with Handler Clauses.
  - `x is a function` is a Built-in kind test, so Guards can use it.
- **Capture:** narrows ADR 0001.
  - A Lambda captures the locals it uses, by value, when it is made. Inside the Lambda they are read-only, and putting into one is a load error.
  - Script Variables are not captured. A Lambda reads and writes its Home Script's Script Variables live, as a Handler does. A Lambda written in a Library can't name any, since a Library has none.
- **Control flow:**
  - `return` returns from the Lambda. There is no non-local return, since the Handler that made a stored Lambda may be long gone.
  - `pass`, `exit` for the enclosing Handler and `the target` are load errors inside a Lambda. `it` is the Lambda's own, and `try`, `catch` and `finally` work as anywhere else.
- **Suspension:** narrows ADR 0004 and ADR 0020.
  - The loader flags a Lambda as may-suspend when its body contains a Suspension Point, and the flag is part of the value. Named functions still never suspend.
  - `f(x) and wait` is a possible Suspension Point. Calling a may-suspend value without `and wait` raises `would suspend`. `and wait` on a value that can't suspend is allowed, since the loader can't know which value a variable holds.
  - So ADR 0004's rule becomes "every *possible* Suspension Point is written in the source and known at load". A call without `and wait` never suspends.
  - Library functions never suspend, so handing a may-suspend value, or a foreign one, to `map` or `filter` raises `would suspend` inside it. A Script that waits per element writes a `repeat for each` loop, or uses a Join (ADR 0026) around sends.
- **Home Script execution:**
  - A call from the Home Script is an ordinary call in the caller's Run.
  - A call from another Script is a message to the Home Script. It goes into the Home Script's mailbox in FIFO order, and it runs there as a Run on the Home Script's Fuel, Segment and Grants. It is always a possible Suspension Point, so without `and wait` it raises `would suspend`.
  - A foreign call fails as `send … and wait` does (ADR 0017): the caller gets `send failed`, with the home Run's outcome (errored, cancelled or a Limit Fault) as `reason`.
  - The Host sees a Function Value as an opaque handle. Calling it is a Delivery to the Home Script, and the Run it starts reports its result like any other (ADR 0015).
- **Staleness:**
  - A Function Value is stale once its Home Script stops or is reloaded, or its code is replaced: a stop-and-reload (ADR 0014), a Library replacement (ADR 0020), or a variables-only restore (ADR 0008).
  - Calling a stale value raises `function gone`, before anything is sent. Carry-over and variables-only restores keep stale values as they are.
- **Values:** narrows ADR 0001, ADR 0008 and ADR 0018.
  - Two Function Values are equal when they have the same Home Script, the same literal (or named function) and equal captured values. So `=` still never errors, and no Script value gains identity.
  - Its display form names the Home Script, the literal's position and the captures, e.g. `<function weather:12:3 {n: 3}>`, and it round-trips in a Trace.
  - A Script Snapshot saves a Function Value as its data. `json` and any Capability argument whose Shape is data raise `not encodable`.
  - Its size for the Allocation Budget and Persistent State is a base plus its captured values.
- **Collections:** narrows ADR 0021.
  - `every … where`, `… for every` and `sorted by` are removed.
  - The `list` Library gains `filter`, `map`, `reduce`, `group`, `sortBy` and `sortWith`. `sortBy(xs, key)` is stable, has a `descending` option, and calls `key` once per element in order. `sortWith(xs, compare)` takes a two-argument comparator. `group(xs, key)` gives a map of lists, keyed in first-seen order.
  - They are written in the language, because Built-ins can't run Script code (ADR 0010). So the order of `sortWith`'s comparator calls is fixed by the `list` Library's source, and parity covers it.
  - `every match of <p> in s` stays as a plain expression giving the list of matches, the Match Search.
  - The `grouped by` clause (#47) is superseded by `group`.
- **Collation:** narrows ADR 0024. `rank` stays, and sorting records by Collation becomes `sortBy(rs, given r: the (the name of r) of ranks)`.
- **Abstract Machine:** narrows ADR 0010.
  - `make-closure` copies the captured values and the may-suspend flag.
  - `call-value` calls a Function Value that can't suspend, and raises `would suspend` otherwise. `call-value-wait` is a Suspension Point instruction that makes a local call, or sends a foreign call and waits.
  - A call into Library code for each element is charged per call, so `filter` costs more Fuel than a Comprehension's inline loop did.
- **Errors:** narrows ADR 0017. The error-code catalogue gains `would suspend`, `function gone`, `wrong arity` and `not encodable`.
- **Left for later:**
  - The Host API's handle for a Function Value: its lifetime, and the exact Delivery shape of a Host call.
  - Whether Destructuring parameters belong to the advanced layer only.
  - Queueing policy for foreign calls, which have no Handler Clause to carry a suffix. Resolved by ADR 0026: they run concurrently, the default for a clause with no suffix.
- **Checked by the parser prototype** (#54): a reserved `given`, its parameter list and both forms parse with no second-token decision, no backtracking and no relexes. All 12 sketch files parse with Comprehensions removed. The rules it needs:
  - **Newlines:** a Lambda head and a block Lambda body make newlines significant again at the bracket depth where they start. So a block Lambda can be a call argument, a list item or a map value, and brackets opened inside its body still continue lines as usual.
  - **Expression bodies never suspend:** `wait`, `ask … and wait` and `f(x) and wait` are statements, so a Lambda that may suspend is always the block form.
  - **`and wait` is statement-only:** a call that may suspend is the statement `f(x) and wait`, and its result is left in `it`, as with `ask`. `put f(x) and wait into y` is a syntax error at `and`.
  - **Calls need a name:** `name(` is the only call form, so `times(3)(14)` is a syntax error at the second `(`. A Function Value held in a key, or returned by a call, goes into a variable first.
  - **Small rules:** `given` in Container position is a syntax error at `given`. Zero parameters are written `given: e`, or `given` alone at the end of a line.
  - **Readability:** single-line filters, maps and folds read about as well as the Comprehensions did. `sortBy`'s `{descending: true}` reads worse than `descending`, and so does a block Lambda written inline as an argument (`end given) into gusty`). The first is a Library-shape question and the second a lint (name the Lambda first), and neither is grammar.
  - **Source:** the [prototype](https://github.com/odogono/odgn-talk/tree/prototype/lambdas-sketch/prototypes/parser-sketch) is the primary source: its `FINDINGS-54.md`, the updated `grammar.toml`, `broken.talk`, and `../syntax-sketch/12-lambdas.talk`.
- Narrowed by ADR 0026: a local `f(x) and wait` can't be a Join Member, because it runs in the caller's Run. A foreign call runs concurrently, as a Handler Clause with no suffix does. A Join may sit in a block Lambda, which is then may-suspend.
- Narrowed by ADR 0027: Destructuring Lambda parameters are Beginner Surface, since they use the same Destructuring as Handler Clauses.
- Settled by #66: `sortBy`'s `descending` option is a trailing text argument, `sortBy(xs, key, "descending")`, in the style of `round`'s mode, and `sortWith(xs, compare, "descending")` takes it too. Any other text raises `out of domain`. Both directions are stable, so tied elements keep their input order. A multi-key sort uses a list key, since lists are ordered lexicographically (narrowing ADR 0003). Keys in mixed directions chain stable sorts (`sortBy(sortBy(rs, temp, "descending"), city)`) or use `sortWith`.
- Settled by #69: "`exit` for the enclosing Handler" above doesn't exist. A Handler leaves early with a bare `return` (ADR 0019), and inside a Lambda `return` returns from the Lambda.
- Settled by #72: the Host API's handle is an ordinary `Value` of kind `function`, readable only for its Home Script and display form. It is bound to its Group (`wrong group` elsewhere), and it lives as long as the Host holds it. `group.Call` has the shape of `Request` and is a Delivery to the Home Script. Staleness is checked when the input queue is drained, and a stale value rejects with `send failed`, reason `function gone`. A `function` Shape lets an Operation take one as an argument. A Host-held handle doesn't survive save and restore. See [the embedding interface](../embedding/README.md).
