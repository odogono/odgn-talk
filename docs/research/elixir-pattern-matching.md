# Elixir pattern matching and multi-clause dispatch

Research for [#4](https://github.com/odogono/odgn-talk/issues/4). Question: how do Elixir's pattern matching and multi-clause dispatch work, in enough detail to borrow them for our Destructuring, Handler Clauses and Guards?

Sources are the Elixir v1.20.4 docs on hexdocs, the Erlang/OTP 29.1.1 system docs, and the Elixir and OTP compiler source pinned to specific commits. Reference-style links such as [PG] are listed at the bottom. Anything marked **(inference)** is my reasoning, not a claim from a source.

---

## 1. The match operator `=`, rebinding and the pin `^`

- **`=` is a match, not an assignment.** The left side is a pattern and the right side is an ordinary expression. When the sides don't match, `MatchError` is raised [PG §Patterns]. Matching is one-directional: `1 = y` with an unbound `y` is a compile error, because "patterns are allowed only on the left side of `=`" [PG]. This is not Prolog-style unification.
- **Variables in a pattern always bind.** Elixir allows rebinding: `x = 1; x = 2` is legal [PG §Variables]. Under the hood it is "static single assignment" [SF `^`].
- **The pin `^x` matches against x's current value instead of rebinding it.** `^x` "always refers to the value of x prior to the match", so `x = 0; {x, ^x} = {1, 0}` succeeds and leaves `x == 1` [SF `^`]. A pinned value is compared by equality as a value, not treated as a pattern. So `^x` with `x = %{}` does *not* match any map, even though a literal `%{}` pattern would [PG].
- **Patterns can repeat a variable.** `{x, x}` matches only when both positions are equal. Cyclic definitions such as `{:ok, x} = {x, :ok}` are rejected [PG].
- **`_` never binds**, and reading `_` is a compile error [PG].
- **Function calls are not allowed in patterns** [PM].

## 2. What patterns can match

| Shape | Semantics | Source |
|---|---|---|
| Atoms and numbers | Literal, **strict** equality: `1 = 1.0` fails | [PG §Literals] |
| Tuple `{a, b}` | Same size, and every element matches | [PG §Tuples] |
| List `[a, b]` | Same length, and every element matches | [PG §Lists] |
| `[h \| t]`, `[a, b \| t]` | Non-empty list, with head(s) and tail. Does **not** match `[]` | [PG §Lists] |
| Map `%{k: v}` | **Subset match**: matches any map that has *at least* the pattern's keys. `%{}` matches every map. A missing key means no match | [PG §Maps] |
| Map keys | Must be literals or pinned variables, so a key cannot be bound | [PG §Maps] |
| Struct `%User{name: n}` | A map with a `__struct__` tag. Unknown keys are a **compile error**. `%name{}` binds the struct's module and `%_{}` accepts any struct | [PG §Structs], [SF `%struct{}`] |
| Binary `<<v::size(16)>>` | Segments, each with its own type, size and unit | [PG §Binaries] |
| String `"prefix" <> rest` | **Prefix only.** The left operand must be a literal binary, and suffix matches are invalid | [PG §Binaries], [K `<>`] |

The match operator `=` itself cannot take a guard [PG §Where].

## 3. Multi-clause functions

- **Clauses are tried top to bottom.** "If a function has several clauses, Elixir will try each clause until it finds one that matches" [MF]. Arguments that match no clause raise `FunctionClauseError`, whose message reads "no function clause matching in M.f/n" [MF], [FCE].
- **A function's identity is name plus arity.** All clauses of `f/n` compile to a single Erlang `function` form that lists them as clauses [ElixirErl L264-265]. Clauses with the same name and arity have to be written together. Otherwise the compiler warns: "clauses with the same name and arity (number of arguments) should be grouped together" [ElixirDef L461-467].
- **Unreachable clauses are detected at compile time.** The Erlang compiler warns "this clause cannot match because a previous clause always matches" [B2S L189-194].
- **Default arguments `\\`** turn one definition into several arities, e.g. `multiply_by/1` and `multiply_by/2`. The default expression is evaluated on each call, not when the function is defined [K `def/2`], [MF]. When a function has both defaults and multiple clauses, the defaults must go in a separate bodiless *function head*, and "function heads cannot have patterns nor guards" [MF]. Anonymous functions can't have defaults because "they can only have a sole arity". Their clauses must all take the same number of arguments [K `def/2`], [SF `fn`].

## 4. Guards

**Allowed expressions:**
- comparisons, plus `max` and `min`
- the *strictly boolean* operators `and`, `or` and `not`
- arithmetic
- `in` / `not in` against a list or range
- `is_*` type tests
- a fixed set of built-in functions (`abs`, `hd`, `map_size`, `tuple_size`, …)
- `map.field`
- the `Bitwise` functions
- macros built only from these, via `defguard` [PG §List]

`&&`, `||` and `!` are banned because "they're not strictly boolean" [PG], [K `&&`]. The Erlang-level list gives the full set of guard BIFs [ErlExpr §Guard Sequences].

**Why the list is restricted.**
- Erlang: "evaluation of a guard expression must be guaranteed to be free of side effects" [ErlExpr].
- Elixir: "a deliberate choice… all guards are predictable (no mutations or other side-effects) and they can be optimized and performed efficiently" [PG].
- Totality **(inference)**: guards cannot call user-defined functions, only non-recursive built-ins, so evaluating a guard always terminates, and its cost is bounded by the size of the guard expression plus the built-ins' work on their arguments.
- Selective `receive` may evaluate a guard against many messages [ErlExpr §Receive], which is another reason guards must be pure **(inference)**.

**Semantics:**
- **Only the value `true` passes.** "Guards have no concept of 'truthy' or 'falsy'": `when head` fails for `head = "some_value"` [PG §Non-passing].
- **Errors fail the guard; they do not raise.** "In guards, when functions would normally raise exceptions, they cause the guard to fail instead." For example, `tuple_size("hello")` inside a guard just skips the clause [PG §Errors], [CASE]. So `tuple_size(x) == 2` works as a type check and a size check in one.
- **The pitfall: the whole guard fails, not just one operand.** `when map_size(v) == 0 or tuple_size(v) == 0` never matches `{}`, because `map_size` raises first and fails the entire guard. The fix is to write *multiple guards* (`when A when B`), each of which fails on its own, or to put type tests first [PG §Multiple guards]. Erlang's `;` guard sequences work the same way: if one guard fails, "the next guard in the sequence… is evaluated" [ErlExpr].

## 5. `case`, `cond`, `with`, `receive`

- **`case`** tries its clauses in order, and each clause can have a guard. If none matches, `CaseClauseError` is raised. Bindings made in a clause don't leak out, and a clause can't overwrite an outer variable. Matching against an existing value needs `^` [SF `case`], [CASE].
- **`cond`** has no patterns. It returns the first branch whose condition is *truthy* (anything except `nil` and `false`). If none is, `CondClauseError` is raised [SF `cond`]. Note that guards use strict `true` while `cond` uses truthiness.
- **`with`** chains `pattern <- expr` steps. A step that fails to match *stops the chain and returns the non-matching value*. A bare `=` step inside `with` still raises `MatchError`. An `else` block matches the failed value the way `case` does and raises `WithClauseError` if nothing matches. Variables bound in the chain are not visible in `else`. The docs warn that `else` "flattens" all failures into one place and suggest normalising what each step returns [SF `with`].
- **`receive`** takes the first message in the mailbox that matches any clause (pattern plus guard), leaves every other message in place, and blocks until a match arrives or the `after` timeout expires [SF `receive`], [ErlExpr §Receive]. Cost: "O(N) where N corresponds to the number of messages preceding the matching message", so a big mailbox of unmatched messages makes receive slow [ErlExpr §Receive].

## 6. How clauses compile, and what it costs

- Elixir hands function clauses to the Erlang compiler as-is [ElixirErl L264-265]. Pattern matching is compiled in `beam_core_to_ssa` (formerly `v3_kernel`), using "the algorithm for an optimizing compiler for pattern matching given [in] 'The Implementation of Functional Programming Languages' by Simon Peyton Jones" [B2S L1214-1238].
- **The algorithm**, from `match/4`, `partition/1`, `match_var/4` and `match_con/4` [B2S L1256-1345]:
  1. Split the clause list into *consecutive* groups by whether the first argument is a variable or a constructor.
  2. For a constructor group, build a `select` that switches on type (atom, integer, tuple, cons, map, binary…) and then on value, recursing into sub-patterns.
  3. For a variable group, rename and move on to the next argument.
  4. When the patterns run out, test the guards in order. Clauses after an always-true guard are dropped with a warning [B2S L1267-1291].

  The result is a decision tree that shares tests between clauses while keeping first-match order.
- **Performance** [ErlEff §Pattern Matching]:
  - Clause selection in function heads, `case` and `receive` is optimised, and "with a few exceptions, there is nothing to gain by rearranging clauses".
  - Literal choices are picked "using a single instruction that does a binary search".
  - The exception: a catch-all *variable* clause in the middle of literal clauses splits the tree. The compiler then has to test the clauses in the written order around it, so putting it first or last is faster.
  - Binary-matching clauses are never reordered.

## Implications for our language

Our setting: a dynamic, sandboxed, English-like interpreter written in Go and TS, where a Handler has Handler Clauses like `on handle {type: "invoice", amount: a} where a > 1000`.

1. **Adopt first-match, top-to-bottom clause order.** The user's sketch already relies on it: the guarded invoice clause comes before the catch-all invoice clause. Like Elixir, require a Handler's clauses to sit together in one Script, and flag a clause as unreachable when an earlier clause covers it, e.g. `on handle {type: "invoice"}` placed above the guarded one [B2S], [ElixirDef]. That check belongs in the LSP and linter.
2. **Maps use subset matching, keys are literal, and a missing key means no match.** This suits event payloads that grow new fields over time [PG §Maps]. Our values are dynamic, so we need an explicit rule that a missing key does *not* bind `empty`. HyperTalk habit would push the other way.
3. **Decide how literals compare. This is the biggest open question.** Elixir matches strictly: `1` does not match `1.0` [PG]. HyperTalk-family `is` is loose: case-insensitive, and it converts between numbers and strings. A literal in a pattern must compare the same way as some operator in the language. Otherwise `{type: "Invoice"}` would match differently from `if type is "Invoice"`. Units (`5 kg` vs `5000 g`) have the same problem.
4. **Names in a pattern bind fresh variables scoped to the clause, and nothing leaks** [SF `case`]. For beginners, leave out a pin operator: compare against an existing value in the Guard (`where kind is expectedKind`). An explicit pin could come later in the advanced layer. Probably reject a name that appears twice in one pattern (`{a: x, b: x}`) and point the user to a Guard instead. Elixir allows it [PG], but it surprises beginners.
5. **Lists: `[first, second, ...rest]` is exactly `[a, b | t]`**, with rest allowed only in last position and a pattern without rest requiring the exact length [PG §Lists]. For text, Elixir only supports literal *prefix* matching (`"ID-" <> rest`) [K `<>`]. Our Text Patterns go further, so keep them a separate feature that can appear in a pattern slot, as the map already intends. Because Text Patterns can backtrack, their matching needs step metering.
6. **Host-defined object types act as structs.** Elixir checks struct keys at compile time [PG §Structs]. If a Host registers schemas for its types, e.g. `an Invoice {amount: a}`, we can report unknown keys when the Script loads rather than failing silently at run time.
7. **Guards form a pure, synchronous, total sublanguage**, allowed to contain:
   - comparisons, strictly boolean `and`/`or`/`not`, and arithmetic
   - type tests (`a is a number`) and `is in`
   - size and length queries
   - probably read-only Chunk Expressions

   Guards must *not* call Handlers or functions, use Capabilities, `send`, `wait`, or mutate anything. This is the same bargain Erlang made [ErlExpr], and it matters more for us for two reasons:
   - Async transparency means any call could suspend, and a dispatch step that suspends midway is not acceptable **(inference)**.
   - With no user calls, guard cost is bounded by the guard's size, so it fits the step budget.
8. **Guard errors fail the clause and never escape dispatch.** This is Elixir's rule [PG §Errors], and it is sandbox-friendly because malformed input can't crash dispatch. We should improve on it in two ways:
   - evaluate each disjunct of `or` in isolation, so Elixir's `map_size … or tuple_size …` pitfall [PG §Multiple guards] can't happen
   - have the debugger and trace show *why* a clause was skipped

   A Guard passes only when it evaluates to boolean true [PG §Non-passing]. The linter should flag Guards that can't yield a boolean.
9. **Decide what happens when no Handler Clause matches.** Elixir raises `FunctionClauseError` [FCE]. HyperTalk passes an unhandled message along the message path. For events, "no clause matched" should most likely mean "not handled here, pass it on" rather than an error. That is a decision for the event-model ticket.
10. **Arity and defaults.** Elixir dispatches on name plus arity, and defaults create extra arities [K `def/2`]. HyperTalk-style Handlers take a variable number of parameters. The simpler choice is to dispatch on the message name only and treat the number of arguments as part of each clause's pattern. Leave defaults out of clause heads, the way Elixir forbids them in heads that have patterns [MF].
11. **Control forms map roughly as follows:**
    - The sketch's `match … when … then` is `case`.
    - `if / else if` covers `cond`.
    - `with`/`else` is worth an advanced-layer form for chaining fallible steps, with the same scoping rule: the chain's bindings are invisible in `else` [SF `with`].
    - A `wait for <event pattern>` modelled on `receive` has to avoid its O(N) mailbox scan and unbounded buffering [ErlExpr §Receive]. Buffering unmatched events would count against the Script's hard memory cap, so non-matching events should go to normal dispatch rather than wait in a queue **(inference)**.
12. **Compilation and metering.** Compile each Handler's clauses into a Peyton Jones–style decision tree when the Script loads [B2S]. The obvious fast path is to index clauses on a literal discriminator key such as `type`. However, the fuel charged must be **deterministic and identical in Go and TS** **(inference, from the map's sandbox constraint)**. So the spec should define fuel in terms of an abstract cost, e.g. per clause tried plus per pattern node tested in written order, and not in terms of whatever optimised tree an implementation builds. Otherwise the two implementations would diverge on out-of-fuel behaviour.

## Sources

- [PG]: Elixir guide, *Patterns and guards*: https://elixir.hexdocs.pm/patterns-and-guards.html (also served at hexdocs.pm/elixir/patterns-and-guards.html)
- [PM]: Elixir guide, *Pattern matching*: https://elixir.hexdocs.pm/pattern-matching.html
- [CASE]: Elixir guide, *case, cond, and if*: https://elixir.hexdocs.pm/case-cond-and-if.html
- [MF]: Elixir guide, *Modules and functions* (multiple clauses, default arguments, function heads): https://elixir.hexdocs.pm/modules-and-functions.html
- [SF]: `Kernel.SpecialForms` (`^`, `case/2`, `cond/1`, `with/1`, `receive/1`, `fn/1`, `%struct{}`): https://elixir.hexdocs.pm/Kernel.SpecialForms.html
- [K]: `Kernel` (`def/2` default arguments, `<>/2`, `&&/2`, guard list): https://elixir.hexdocs.pm/Kernel.html
- [FCE]: `FunctionClauseError`: https://elixir.hexdocs.pm/FunctionClauseError.html
- [ErlExpr]: Erlang Reference Manual, *Expressions* (§Guard Sequences, §Receive, match operator): https://www.erlang.org/doc/system/expressions.html
- [ErlEff]: Erlang Efficiency Guide, *Functions*, §Pattern Matching: https://www.erlang.org/doc/system/eff_guide_functions.html
- [B2S]: OTP compiler, `beam_core_to_ssa.erl` @ `de741b7`: https://github.com/erlang/otp/blob/de741b771b0018d395c7d99eb985e26b426dc650/lib/compiler/src/beam_core_to_ssa.erl (match compilation L1214-1345, shadow warnings L189-194)
- [ElixirDef]: Elixir compiler, `elixir_def.erl` @ `25fa668`: https://github.com/elixir-lang/elixir/blob/25fa6682cb0f2216cca133492b7e89aa499a44f2/lib/elixir/src/elixir_def.erl#L461-L467
- [ElixirErl]: Elixir compiler, `elixir_erl.erl` @ `25fa668`: https://github.com/elixir-lang/elixir/blob/25fa6682cb0f2216cca133492b7e89aa499a44f2/lib/elixir/src/elixir_erl.erl#L264-L265
