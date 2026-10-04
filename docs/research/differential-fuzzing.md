# Differential fuzzing: generating Scripts and Host Inputs, and minimising divergences

Answers [#86](https://github.com/odogono/odgn-talk/issues/86), part of [#1](https://github.com/odogono/odgn-talk/issues/1). ADR 0009 and ADR 0018 make differential fuzzing a required practice, outside the spec: a nightly job generates Scripts, Host Inputs and limit sweeps, runs them on both Cores, compares the Traces, and commits every minimised divergence as a Trace Case. This note looks at how other language projects generate programs and schedules, how they shrink failures, and which oracles they use besides "the two implementations disagree". It then proposes a design for this language. Nothing here was built or run: it is a reading of papers, docs and tool sources, applied to the ADRs.

## Historical proposal

This research predates the implemented fuzzer and the scoped-effects contract. Use the [fuzzer guide](../../tooling/fuzz/README.md#oracle-contract) for current behavior, [chapter 10](../../spec/10-save-and-restore.md#saving) for Save eligibility, and [chapter 11](../../spec/11-the-trace-and-conformance.md#save-and-restore-replays) for replay parity. The proposal below is retained as rationale; these assumptions are superseded:

- **Save eligibility:** a Pump boundary permits an attempt, not necessarily a snapshot. Live Capability Scopes, Segment participants and fatal effect uncertainty require `effects pending` ([ADR 0049](../adr/0049-live-host-effects-prevent-saving.md)). Replay checks the refusal without advancing execution and continues the original Group.
- **Terminal outcomes:** a finite generated case may leave Runs suspended and Decisions open. Check for duplicate terminal outcomes within a restore epoch; do not require every started Run or Decision to finish before the case ends.
- **Trace comparison:** same-input cross-Core comparison remains exact. Renaming locals changes code identity, so the renaming metamorphic relation compares a defined projection rather than raw Traces. Save/restore replay uses chapter 11's specified projection and eligibility rules; a change in Fuel Slice is not generally equivalent to merely adding `preempt` lines.

## Summary

- **Generate valid Scripts by construction, not by filtering.** Csmith, YARPGen and `wasm-smith` all generate programs that are valid by construction, tracking the static facts that make a program legal as they generate it. For this language those facts are all known at load: Grants and each Operation's mode (for the both-ways `and wait` check, ADR 0019), which Handlers may suspend, whether a path in a `, deciding` Handler has crossed a possible Suspension Point (`veto` and `pass` placement, ADR 0031), and Guard purity. The language has no undefined behaviour to avoid (ADR 0003, ADR 0017), so the generator doesn't need Csmith's safe-math wrappers. It only needs to control how often Runs raise errors, as Fuzzilli does with its "correctness rate".
- **Generate invalid Scripts on purpose, with a known answer.** Load diagnostics are covered by parity (ADR 0009, ADR 0019). A catalogue of single "invalidating mutations" (drop an `and wait`, put `veto` after a `wait`, call a Script function in a Guard, `, queued, deciding`) gives cases where the fuzzer knows which diagnostic code both Cores must report. That is an oracle as well as a divergence check.
- **Host Inputs are a state machine over symbolic references.** Deliveries, answers, cancels, Pumps with Fuel Slices, saves and restores are generated like Jepsen operations or Hypothesis stateful rules. Each action names what it acts on symbolically ("the oldest pending call", "the second Run of `orders`"), and each Core's fuzz runner resolves the reference against its own state. An action that can't apply is a deterministic no-op. So every choice sequence is a valid input, and the Cores can be run separately, each in its own language, with only the resulting Traces compared.
- **Diversity comes from swarm testing and coverage counters, not from one tuned distribution.** Swarm testing (Groce et al.) and FoundationDB's simulator both turn features on and off at random per run. FoundationDB also counts how many runs reach each condition it cares about. The fuzzer should count Trace record kinds and `seg` end reasons (`preempt`, `abandon`, `veto`, `fault` per limit, restores with pending calls) and tune weights until each is common.
- **Shrink the choice sequence first (Hypothesis), then the concrete case (Perses, ddmin).** Reducing the generator's choices keeps every candidate loadable, because it could have been generated. That is MacIver and Donaldson's point about the Hypothesis reducer. Csmith's Seq-Reduce did this too, but early changes scrambled everything generated after them. Keeping the Script's choices and the Host Input choices in separate, block-structured streams avoids that. A second pass reduces the case directly: syntax-guided deletion over the TS Core's lossless tree (ADR 0028), and ddmin over the `>` lines. Both are gated by an interestingness test that requires a clean load on both Cores and the same first divergence.
- **Shrinking is reliable here because everything is deterministic.** QuickCheck's PULSE work found that shrinking concurrent tests stops early when a smaller test passes by chance. A Trace replays exactly (ADR 0018), so a candidate either still diverges or it doesn't.
- **Oracles beyond divergence**, most of which work before the Go Core exists:
  - **Save/restore:** a save and restore at any Pump boundary is unobservable (ADR 0008). ADR 0018 already inserts one between each pair of Pumps. The fuzzer adds random points, variables-only restores and random settlements.
  - **Limit Fault rollback:** a Script whose only Segment in a Pump faults has the same Script Variables after the Pump as before it (ADR 0006).
  - **Limit sweeps:** a Trace run with a lower Fuel limit matches the unlimited Trace up to the fault.
  - **Group Fingerprint:** both Cores compute the same Fingerprint for a setup, it changes when any fingerprinted field changes, and it never changes with state.
  - **Metamorphic relations:** inserting `> vars` changes nothing else, an extra `> pump` with nothing runnable produces no output, renaming locals leaves the Trace unchanged, and Fuel Slices only add `preempt` lines when a Group has a single Run.
  - **Trace invariants** that hold on any Core: every Run ends once, every call id is answered at most once, Fuel never exceeds the limit, and every `decide` gets one `decided`.

## Prior art: generating programs

### Csmith: expressive C without undefined behaviour

Csmith's design goals were, first, that a program "must not execute any of the 191 kinds of undefined behavior, nor depend on unspecified behavior", and second, to "maximize expressiveness subject to constraints imposed by the first goal". The authors report that "expressiveness is correlated with bug-finding power", and they reported more than 325 bugs ([Yang et al., PLDI 2011](https://users.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf)). The paper describes three techniques that matter here:

- **Static checks during generation.** Csmith keeps may-read and may-write sets per sequence point, and "if a conflict is detected, the new code is thrown away and the process restarts". Progress is guaranteed because "Csmith always has a non-zero chance of generating code that introduces no new conflicts, such as a constant expression".
- **Run-time wrappers.** "A family of wrapper functions for arithmetic operators whose (promoted) operands might overflow."
- **A checksum as the output.** A generated program's `main` "computes a checksum of the non-pointer global variables, prints the checksum, and exits". So every miscompilation that touches state becomes visible in one printed value.

The same paper names the reduction problem this note returns to: the delta-debugging reducers of the time "introduce undefined behavior. The resulting programs are small but useless."

**For this language:** the checksum's job is already done. A Trace ends with a `vars` block for every Script (ADR 0018), and it records Fuel, allocation and Persistent State per Segment. There is nothing like undefined behaviour to avoid: there is no implicit coercion (ADR 0003), errors are defined values with codes (ADR 0017), and limits end in defined Limit Faults (ADR 0006). What corresponds to Csmith's static checks is the loader's checks, which must hold by construction.

### YARPGen: avoiding UB without wrappers, and generation policies

YARPGen (220+ bugs in GCC, LLVM and ICC) avoids undefined behaviour "without using dynamic checks". It tracks values during generation, and when an operation would be undefined, "it performs a local fix, rewriting" it into a similar safe one. Its second idea is **generation policies**: "a mechanism for increasing diversity of generated code and for triggering more optimizations". They "systematically skew probability distributions" and are "applied in randomly chosen sub-regions of the generated code". The paper's motivation is that a generator saturates "because the generator contains biases that make it incapable of" reaching some bugs, not because the compiler has none left ([Livinskii, Babokin and Regehr, OOPSLA 2020](https://users.cs.utah.edu/~regehr/yarpgen-oopsla20.pdf)).

**For this language:** local rewriting is the right tool for the load rules. If the generator is about to emit `veto` on a path that has crossed a possible Suspension Point, it emits a different statement. Generation policies map onto regions of a Script. One Handler might be "suspension-heavy" (many `ask … and wait`, Joins), another "chunk-heavy", another "Destructuring-heavy" with many Handler Clauses and Guards.

### `wasm-smith`: valid by construction, driven by fuzzer bytes

`wasm-smith` generates WebAssembly modules from raw bytes through Rust's `Arbitrary` trait. Its author's write-up says generated inputs "are always within the test domain: no cycles are wasted on invalid inputs". The generator "mirrors a recursive descent parser but makes pseudo-random choices instead of parsing decisions". It models the operand stack and control stack, so "choosing which instruction to generate will consult the contents of these stacks, and, once a choice is made, generating a new instruction will update them" ([Fitzgerald, 2020](https://fitzgen.com/2020/08/24/writing-a-test-case-generator.html)). Because the bytes come from libFuzzer, coverage guidance steers generation. The crate also has:

- **A validity check of its own:** a fuzz target "checks that every module generated by `wasm-smith` validates successfully" ([crate docs](https://docs.rs/wasm-smith/latest/wasm_smith/)).
- **Swarm testing built in:** "You can use the `Arbitrary for Config` implementation for swarm testing", which chooses configuration "dynamically – but still deterministically" ([`Config`](https://docs.rs/wasm-smith/latest/wasm_smith/struct.Config.html)).
- **`disallow_traps`**, which avoids code "that will possibly trap", and **`ensure_termination`**, which adds a fuel global "decremented at the head of each loop and function" that traps at zero ([`Module`](https://docs.rs/wasm-smith/latest/wasm_smith/struct.Module.html)).

**For this language:** the generator should have the same shape: a recursive generator that mirrors the grammar, reads every choice from one byte or choice stream, and keeps a context of the static facts. It needs no termination pass, because Fuel is part of the language (ADR 0010). A generated loop that never ends is a Limit Fault, which is a valid and interesting outcome. It only needs to be kept to a controlled share of cases.

### Fuzzilli: mutation on an IR, and a corpus of valid samples

Fuzzilli mutates programs in its own IR, FuzzIL, rather than JavaScript source. Its mutators change data flow, operations and inserted code ([README](https://github.com/googleprojectzero/fuzzilli)). The NDSS paper names three measures for semantic validity ([Groß et al., NDSS 2023](https://www.ndss-symposium.org/wp-content/uploads/2023-290-paper.pdf)):

- **Only valid samples enter the corpus:** it records "whether the program terminated abnormally due to an uncaught runtime exception".
- **Small changes:** "each mutation only has a small probability of turning a valid (in the semantic sense) program into an invalid one".
- **A lightweight type system.** It is "merely a performance optimization": with it disabled, "the correctness rate varied between 50% and 75%".

Every sample that adds coverage is minimised before it enters the corpus, by "a fixpoint iteration that successively attempts to remove instructions while ensuring that the resulting program still exhibits the same coverage increase".

**For this language:** a type-directed generator (numbers into arithmetic, texts into chunks, Quantities of one Unit Kind into addition) keeps Runs going deep instead of stopping at the first `type mismatch` error. It should be conservative and optional, as Fuzzilli's is, with the error rate measured. A rate near zero means error paths (`try`/`catch`, `finally`, `raise` records, Unwind Tables per ADR 0017) go untested.

### Other generators

- **jsfunfuzz** (Mozilla) generates JavaScript for SpiderMonkey, and `compare_jit` "compares output from SpiderMonkey using different flags" ([funfuzz](https://github.com/MozillaSecurity/funfuzz)). This is differential testing inside one engine, the same shape as running the TS Core against itself until the Go Core exists.
- **Property-based testing libraries** give the harness for free in both Core languages. [fast-check](https://fast-check.dev/docs/advanced/model-based-testing/) (TS) has model-based `commands`. [rapid](https://github.com/flyingmutant/rapid) (Go) has "state machine ('stateful' or 'model-based') testing", "fully automatic minimization of failing test cases", and `MakeFuzz`, so that "any rapid test can be used as a fuzz target for the standard fuzzer". Go's native fuzzer is coverage-guided, stores its seed corpus in `testdata/fuzz/`, and minimises failing inputs ([Go fuzzing](https://go.dev/doc/security/fuzz/)).

## Generating Scripts that load

### The load rules the generator must track

The generator keeps a context as it descends the grammar. Each load rule becomes a fact in that context:

| Rule | Source | What the generator tracks |
|---|---|---|
| Every Capability call is to a granted Operation | ADR 0012, ADR 0015 | The setup's Grants and each Operation's mode, arity and argument shapes |
| `and wait` on a call exactly when it may suspend, checked both ways | ADR 0019, ADR 0020, ADR 0025 | The Operation's mode. Also a may-suspend flag per Handler (a fixpoint over the call graph) and per Function Value. |
| Functions, and Handlers called function-style, never suspend | ADR 0020 | Inside a function or Lambda body, no Suspension Point may be generated |
| `veto` only in a `, deciding` Handler, and `veto` and `pass` only on paths that cross no possible Suspension Point | ADR 0004, ADR 0031 | A "may have suspended" flag carried through control flow. After an `if` or `repeat` that may suspend on any path, it is set. |
| `, deciding` never with `, queued` | ADR 0031 | The choice of suffixes per clause |
| A Guard calls only Built-ins | ADR 0021 | A separate expression generator for Guards |
| `say` needs a `console` Grant | ADR 0019 | The Grants |
| Names avoid Reserved Words, a name isn't both a variable and a function, Handler names are one word | ADR 0019, ADR 0025 | A name pool drawn from `grammar.toml`'s reserved list |
| Join Members are `ask … and wait` or `send … and wait` | ADR 0026 | Inside `wait for all`, member statements are drawn from those forms |

The generator reads the lists that drift from the spec files, not from either Core: `grammar.toml` (reserved words, precedence, FOLLOW set, built-in properties), `units.toml`, and `machine.toml`'s error codes. That follows ADR 0009's "shared data, not shared logic".

The generator is not the checker. If a Script it produced fails to load on **both** Cores with the same diagnostics, that is a generator bug (or a checker bug on both sides), and the fuzzer reports it separately. If it fails on one Core only, it is a divergence like any other. The generator should never call a Core's checker to filter its own output, or a checker bug shared by the generator and that Core would go unseen.

### Near-misses: invalid Scripts with a known diagnostic

Load diagnostics are normative. That covers the first syntax error, then every checker diagnostic in source order (ADR 0019). The fuzzer tests them with a mutation pass over valid Scripts. Each mutation breaks one rule and expects one diagnostic:

- Delete an `and wait` from a call to a suspending Operation, or add one to an immediate Operation.
- Move a `veto` or `pass` below a `wait`, or into a function or Lambda.
- Replace a Built-in call in a Guard with a call to a Script function.
- Add `, queued` to a `, deciding` clause.
- Use a Reserved Word as a variable name, or a chunk word followed by `-` (`line - 1`, ADR 0019).
- Remove a Grant from the setup while the Script still calls it.
- Break a line inside an expression where no bracket, operator or comma continues it.

The expected diagnostic code comes from the mutation, so a case where both Cores agree on the wrong code is still caught. Near-misses also exercise error recovery in the TS Core's lossless parser (ADR 0028), which isn't normative but must not crash.

### Avoiding trivial Scripts

Trivial cases are the main risk: Scripts whose Handlers are never reached, Runs that raise on their first statement, or Groups that never suspend. What helps:

- **Draw Deliveries from the Script's own Handler names and argument shapes**, so that most Deliveries match a clause. A small share of unknown messages still exercises the Message Path and `unhandled`.
- **Generate Handler Clauses as families:** several clauses on one message with overlapping Destructuring patterns and Guards, so dispatch tests, `guard-skip` and fall-through all happen.
- **Keep loops small and bounded** by default. A per-case policy sometimes allows unbounded ones, to reach Fuel faults.
- **Measure, then tune.** FoundationDB uses "conditional coverage macros" to learn "how many distinct simulation runs achieved that condition", and adds fault injection where the number is too low ([Zhou et al., SIGMOD 2021](https://www.foundationdb.org/files/fdb-paper.pdf)). The fuzzer's equivalent is a nightly histogram over Trace records: `seg` end reasons, `preempt`, `abandon`, `guard-skip`, `fault` by limit, `decided` by Verdict, restores with pending calls, and `cleanup-failed`.
- **Swarm testing.** Each case turns a random subset of features off: no Joins, no Decisions, no Text Patterns, no Libraries, no Host Objects. Swarm testing "uses a diverse 'swarm' of test configurations, each of which deliberately omits" features. In a week of testing it "found 42% more distinct ways to crash a collection of C compilers" than a hand-tuned default configuration ([Groce et al., ISSTA 2012](https://users.cs.utah.edu/~regehr/papers/swarm12.pdf)). FoundationDB also uses it "extensively" ([Zhou et al.](https://www.foundationdb.org/files/fdb-paper.pdf)).

## Generating Host Inputs that exercise the scheduler

### Prior art: deterministic simulation and stateful testing

- **FoundationDB** runs the real database "in a deterministic discrete-event simulation", with "all sources of nondeterminism and communication … abstracted, including network, disk, time, and pseudo random number generator". It adds "buggification": at many points in the code, "the simulation is given the opportunity to inject some unusual (but not contract-breaking) behavior", such as returning an error from an operation that usually succeeds. Fault rates are "carefully tuned to avoid driving the system into a small state-space" ([Zhou et al., SIGMOD 2021](https://www.foundationdb.org/files/fdb-paper.pdf)).
- **TigerBeetle's VOPR** uses "a random seed to tune parameters for injecting different types of faults". It "may drop and reorder packets, partition the network, or corrupt reads and writes", and "the seed and Git commit hash can be used to replay back the exact simulation and bug" ([VOPR docs](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md)).
- **Antithesis** runs whole systems in a deterministic hypervisor, so "every bug we find [is] perfectly reproducible". It explores by branching from states it has already reached ([how Antithesis works](https://antithesis.com/docs/introduction/how_antithesis_works/)).
- **Jepsen generators** are "purely functional objects" with `op` and `update`. `op` returns the next operation, `:pending` or nothing, and `update` lets a generator react to invocations and completions. They use "an explicit, deterministic model of time". Combinators such as `mix` and `stagger` build workloads ([`jepsen.generator`](https://jepsen-io.github.io/jepsen/jepsen.generator.html)).
- **Stateful property testing:** Hypothesis's `RuleBasedStateMachine` has rules, `@precondition` (so "Hypothesis can filter the inapplicable rules before running them"), invariants checked after every step, and bundles that pass values produced by one rule to later ones ([Hypothesis stateful testing](https://hypothesis.readthedocs.io/en/latest/stateful.html)). QuickCheck with PULSE, a user-level scheduler, found race conditions in Erlang. PULSE takes a random seed, which "makes tests repeatable" ([Claessen et al., ICFP 2009](https://smallbone.se/papers/finding-race-conditions.pdf)).

This language gets most of what those projects built for free. A Script Group is already a deterministic discrete-event system: the Core owns no threads or timers, the Clock is one reading per Pump, and every source of nondeterminism is a Host Input in the Trace (ADR 0015, ADR 0018). What's left is to generate the Host Inputs well.

### The action set

A Host Input generator is a state machine with a model of the Group: pending call ids and their modes, Runs and their states, mailboxes, open Decisions, deadlines, Host Objects, the last Clock reading, and whether a save is held. Each step picks an action. Weights depend on the state, and a swarm configuration turns some actions off per case.

| Action | Trace record | What it's for |
|---|---|---|
| Deliver, request, broadcast | `deliver`, `request`, `broadcast` | Starting Runs, `, queued`/`, dropping`/`, replacing`, mailbox order, `mailbox full` |
| Decide, decide to all | `decide`, `decide-broadcast` | Verdict sealing, `pass`, undecided outcomes (ADR 0031) |
| Answer or fail a pending call | `answer`, `fail` | Resumes. Reverse order, late answers, answers to abandoned calls (noted as ignored, ADR 0026). |
| Stub the next immediate result | `stub` | Also leaving the queue empty on purpose, which gives a traced `host error` |
| Pump | `pump clock=… fuel-cap=…` | Clock unchanged, a small step, or a jump past several deadlines (overdue waits fire in deadline order, ADR 0005). Fuel Slices from 1 up to unlimited. |
| Cancel | `cancel-run`, `cancel-delivery` | Rollback plus `finally` on the Cleanup Budget (ADR 0017), cancelling before and after a Verdict is sealed |
| Stop, revoke, dispose, set parent | `stop`, `revoke`, `dispose`, `set-parent` | Stops mid-Segment, `capability revoked`, Message Path changes, Host Objects restored as disposed |
| Reload, extend, add or replace a Library | `reload`, `extend`, `add library`, `replace library` | ADR 0005 reload rules, and Decisions settled by a Reload |
| Save, restore, settle | `save`, `restore`, `settle` | Answer, reissue, fail or adopt. Leaving a call unsettled gives `call lost`. Variables-only restores (ADR 0008). |
| Print variables | `vars` | Mid-case state checks (see the oracles) |

Two parameters matter most for the scheduler, and both should be swarmed per case. **Fuel Slices** decide where Runs are preempted: small slices put preemptions mid-Segment, which is where saves of preempted Runs (ADR 0008), rollback bases (ADR 0010) and Decisions blocked by a preempted Run (ADR 0031) live. **Clock steps** decide which waits fire together and in what order. The limits themselves (Fuel, Allocation Budget, Persistent State cap, `maxPending`, `MaxJoin`) are part of the setup, and they are also swarmed, as FoundationDB randomises "tuning parameters".

### Symbolic references, resolved by each Core's runner

An answer must name a call id the Core assigned (`pricing/r1.c1`), and a `cancel-run` must name a Run. A generator that writes literal ids has two problems. It needs to see one Core's output before it can write the next input. And every id breaks as soon as the reducer deletes an earlier Delivery.

The fuzzer should therefore keep Host Inputs as **abstract actions with symbolic references**: "answer the k-th pending call, oldest first, modulo the number pending", "cancel the newest Run of Script s", "settle every pending call after the restore with choice c". Each Core's fuzz runner resolves them against its own state as it replays, then writes the concrete Trace, with real ids, as it does anyway (ADR 0015). An action with nothing to act on (no pending call to answer) resolves to a no-op by a fixed rule. This follows two pieces of prior art. Jepsen generators react to completions through `update`. Hypothesis bundles let a rule draw a value produced by an earlier rule, and the Hypothesis reducer depends on every choice sequence meaning something valid.

This gives:

- **No coupling between the Cores during a run.** Each Core runs the same abstract case in its own process and language. The harness compares the two Traces afterwards, and the first differing line is the divergence. There is no lockstep driver, and the Go Core isn't driven through the message layer, so a message-layer bug can't be mistaken for a Core divergence.
- **The resolution rule is harness data, not spec.** It is small ("pending calls ordered by call id") and must be the same in both runners. A divergence in call ids shows up in the Trace before a resolved reference could differ.
- **A committed case is concrete.** The minimised case is written with the concrete `>` lines of the agreed prefix (ADR 0018), and the ids an author may leave out stay out.

## Minimising a divergence

### Prior art

- **Delta debugging.** ddmin "generalizes and simplifies some failing test case to a minimal test case that still produces the failure". Its showcase cut 95 recorded Mozilla user actions to the 3 that mattered ([Zeller and Hildebrandt, TSE 2002](https://www.st.cs.uni-saarland.de/papers/tse2002/)). That is the same kind of input as a list of `>` lines.
- **Hierarchical and syntax-guided reduction.** HDD applies ddmin "to each level of a program's input, working from the coarsest to the finest levels" ([Misherghi and Su, ICSE 2006](https://dl.acm.org/citation.cfm?id=1134307)). Perses uses the formal grammar so that deletions keep the program syntactically valid, and took 38–60% of C-Reduce's time ([Sun et al., ICSE 2018](https://cs.uwaterloo.ca/~cnsun/public/publication/icse18/)). Vulcan adds auxiliary transformations for when the main reducer gets stuck at a local minimum, and gives results with 22–34% fewer tokens than Perses ([Xu et al., OOPSLA 2023](https://dl.acm.org/doi/10.1145/3586049)).
- **C-Reduce.** Delta debugging "typically yields test cases that are too large or even invalid (relying on undefined behavior)". C-Reduce's answer is "a generic fixpoint computation [that] invokes modular transformations", with outputs "more than 25 times smaller" than the alternatives. Validity is left to an interestingness test that runs compilers, Valgrind and checkers such as Frama-C over each variant. The same paper describes **Seq-Reduce**, which reduced Csmith's own choice sequence, so that the "result is guaranteed to be a valid C program". Its weakness was that "changes that appear near the start of a Csmith program specification tend to perturb Csmith's internal state in ways that prevent it from emitting desirable variants later on" ([Regehr et al., PLDI 2012](https://users.cs.utah.edu/~regehr/papers/pldi12-preprint.pdf)).
- **Hypothesis's internal reduction** fixes Seq-Reduce's weakness. A test case is "reduced by continually re-generating smaller and simpler test cases". This "significantly mitigates the impact of the test-case validity problem, by ensuring that any reduced test case is one that could in principle have been generated" ([MacIver and Donaldson, ECOOP 2020](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2020.13)). fast-check's `commands` shrinking "takes into account the commands that have really been executed" ([fast-check](https://fast-check.dev/docs/advanced/model-based-testing/)). rapid brings the same approach to Go ([rapid](https://github.com/flyingmutant/rapid)).
- **Nondeterminism spoils shrinking.** For parallel QuickCheck tests, "if the smaller test happens to succeed—by sheer chance, as a result of non-deterministic execution—then the shrinking process stops. This leads QuickCheck to report failed tests which are far from minimal" ([Claessen et al., ICFP 2009](https://smallbone.se/papers/finding-race-conditions.pdf)). The Cores are deterministic by spec, so this doesn't arise here.

### The proposed reducer

A divergence has two inputs, the Script (with its setup) and the Host Inputs, and each constrains the other: deleting a Handler leaves Deliveries that nothing handles, and deleting an answer leaves a Run suspended. The reducer works in two stages:

1. **Reduce the choices (primary).** The fuzz case is stored as two choice streams: one for the setup and Scripts, one for the abstract Host Inputs. Hypothesis-style passes delete and shrink blocks of choices, and the generator regenerates the case from them. Every candidate loads, because the generator only makes valid Scripts, and every Host Input still applies, because symbolic references resolve or become no-ops. The Seq-Reduce problem is avoided in three ways:
   - The two streams are separate, so shrinking the Script doesn't reshuffle the Host Inputs.
   - Choices are grouped into blocks per Handler, clause and statement, and a deleted block leaves its siblings' choices where they were.
   - Names are drawn from per-Script pools, so deleting one Handler doesn't rename the rest.
2. **Reduce the concrete case (secondary).** Some bugs need a shape the generator rarely makes. After stage 1, the reducer works on the case directory itself:
   - Syntax-guided deletion (Perses and HDD style) over the TS Core's lossless syntax tree (ADR 0028): Handler Clauses, statements, Guards, Script Variables, Libraries.
   - Language-specific transformations, as C-Reduce and Vulcan use: inline a local Handler, replace an expression with a literal of its value in the display form (ADR 0018), replace a Join by its first member, turn a `, deciding` clause into a plain one, drop a Grant that is no longer called.
   - ddmin over the `>` lines, in their symbolic form, then rendered.
   - Script passes and input passes alternate until neither makes progress, as in C-Reduce's fixpoint.

The **interestingness test** decides whether a candidate still counts:

- **Loads cleanly** on both Cores with no diagnostics. For a load-time divergence, it must diverge at load in the same way instead.
- **Diverges at the same place.** A signature is taken from the first differing line: its record kind, the differing field, and the Script and Handler it concerns. The candidate's signature must match. Otherwise the reducer can wander from one bug to a different, easier one.
- **Is smaller**, by a fixed order: first the number of `>` lines, then Script tokens, then Clock and Fuel magnitudes (simpler values sort first, as in Hypothesis).

Until the Go Core exists, "diverges" means that an oracle below fails on the TS Core, and the signature is the oracle plus the first line it names.

The result is written as the ready-to-commit case directory ADR 0018 describes. `bless` can't fill in its output lines, since the Cores disagree. A human decides which Core is right, or fixes the spec if it was ambiguous (ADR 0009). The expected Trace then comes from the corrected Core, and is blessed once both agree.

## Oracles beyond divergence

The divergence oracle needs two Cores. The rest also work with one, which matters until the Go Core exists (ADR 0018: "the TS Core runs against itself").

### Save and restore round trips (ADR 0008)

ADR 0018 already replays every corpus case with a save and restore between each pair of Pumps. The fuzzer extends it:

- **Random points:** save and restore at any Pump boundary, including one where a Run is preempted mid-Segment by a small Fuel Slice, and one where a Join is part-answered.
- **Random settlements:** a restore followed by random answer, reissue, fail and adopt choices for each pending call. The oracle compares against a run with no save, where the same answers arrive as ordinary `answer` and `fail` lines. Adopt and reissue must match an unsaved run exactly. Fail matches a run where the same call fails.
- **Into a fresh Group:** a restore into a newly created Group, not only the one saved from, so no state leaks through.
- **Variables-only restores:** the discarded mailbox and Runs are reported, and Decisions left open settle as undecided, `cancelled` (ADR 0031). A stale Function Value raises `function gone` (ADR 0025).
- **Twice:** save, restore, save again. The second save restores to the same behaviour. Save bytes aren't covered by parity (ADR 0009), so byte equality within one Core is a Core-internal property, not an oracle over the spec.

### Limit Fault rollback (ADR 0006)

A Segment that ends in a Limit Fault leaves the Script Variables as they were at its start. The fuzzer can check this from the Trace alone, with no hook into the Core. It inserts `> vars` before and after a Pump. If the Pump holds exactly one Segment of a Script, and that Segment ended in `fault`, then that Script's `vars` must be the same before and after. The generator makes these cases common by delivering one message per Pump under tight limits. In the general case the rollback base is mid-Pump, which the Trace doesn't show. A non-normative fuzz hook in each Core that reports `segmentBase` (ADR 0010) could cover it, but that is outside the spec.

### Limit sweeps (ADR 0018)

ADR 0018 already names limit sweeps. Their oracle is a prefix property. If a case uses Fuel F with no fault, then rerunning it with a Run Fuel limit L < F gives the same Trace up to the Segment that crosses L. That Segment ends in `fault limit=fuel`, and the fault instruction moves forward, never back, as L rises. The same holds for the Allocation Budget. The Persistent State cap is measured at Segment ends (ADR 0010), and it gives the same prefix property at Segment granularity. A bisection over L pins the exact fault instruction on both Cores, which is where Cost Model drift between the Cores shows up first.

### Group Fingerprint

The Group Fingerprint is SHA-256 over a canonical encoding of the versions, the code identities, the Operation Declarations and the limits, and never state (ADR 0009, #71). Three checks:

- Both Cores compute the same Fingerprint for every generated setup. This is a divergence check on the canonical encoding, which is easy to get subtly wrong (ordering, number formatting).
- Changing any single fingerprinted field changes it: a limit, an Operation's mode, a Script's source.
- Nothing a Group does changes it. The Fingerprint is the same before and after the case runs, and after a restore.

### Metamorphic relations

Metamorphic testing checks a relation between two runs when there is no expected output. GraphicsFuzz applied it to shader compilers, compiling semantics-preserving variants and minimising "a minimal change to an original shader that induces a compiler bug" ([Donaldson et al., OOPSLA 2017](https://dl.acm.org/doi/10.1145/3133917)). EMI profiles a program's run and "stochastically prune[s] its unexecuted code", which led to 147 confirmed GCC and LLVM bugs ([Le, Afshari and Su, PLDI 2014](https://web.cs.ucdavis.edu/~su/publications/emi.pdf)). Relations that hold here:

- **Observers change nothing.** Inserting `> vars` anywhere, or an extra `> pump` at the same Clock reading when nothing is runnable, adds only its own lines.
- **Renaming locals.** Renaming a local variable or Handler parameter consistently changes no line of the Trace. Names don't appear in Trace records, and slot assignment is normative (ADR 0010). The Disassembly is unchanged too.
- **Fuel Slices with one Run.** In a Group where only one Run is ever runnable, a smaller Fuel Slice adds `preempt` records and needs more Pumps, but leaves every other record unchanged, Fuel included. With several Runs, slicing legitimately changes the interleaving, so the relation doesn't apply.
- **EMI-style pruning.** Deleting a Handler Clause or branch that the Trace shows was never reached keeps sends, calls, outcomes and `vars` the same. It doesn't keep Fuel (dispatch is charged per clause tried, ADR 0006), code positions or frame sizes, so the comparison must be a projection of the Trace that leaves those out.
- **Display-form round trip.** Every value printed in a Trace reads back to an equal value (ADR 0018).

### Trace invariants

Some properties hold for any Trace on any Core. They are checked on every fuzz case, like FoundationDB's built-in assertions:

- Every Run ends exactly once, with one `run` record.
- A call id is answered, failed or abandoned at most once, and every `abandon` follows a Join failure or a `timeout` (ADR 0026, #79).
- Fuel and allocation never exceed their limits except at the faulting instruction, and Persistent State never exceeds its cap at a Segment end.
- Every `decide` gets exactly one `decided`. A Verdict never seals after its Run's first Segment (ADR 0031).
- No Run of a Script starts or resumes while another Run of the same Script is mid-Segment (ADR 0004).

## Recommendation

1. **One generator, in the TS tooling stack (ADR 0028), emitting abstract cases.** It reads `grammar.toml`, `units.toml` and `machine.toml`, and it never calls either Core's checker. Its output is a setup, the Scripts, and an abstract Host Input list with symbolic references. Each Core's corpus-runner Example Host (ADR 0018) gets a fuzz mode that resolves the references and writes the concrete Trace.
2. **Valid by construction**, with the context from the table above. It covers the both-ways `and wait` check (ADR 0019, ADR 0020, ADR 0025), `veto` and `pass` placement (ADR 0031), Guard purity (ADR 0021), Grants (ADR 0012) and Join Members (ADR 0026). Type-directed where it's cheap, with the Run error rate measured and kept well away from zero.
3. **A near-miss pass for load diagnostics** (ADR 0019), with the expected code from the mutation.
4. **Host Inputs as a stateful generator**, with every record in ADR 0018's list, and Fuel Slices, Clock steps and limits swarmed per case.
5. **Swarm testing over language features and Host Input kinds**, plus a nightly histogram of Trace record kinds, to find what the fuzzer never reaches.
6. **Minimise the choice streams first**, Hypothesis-style, with the Script and the Host Inputs in separate block-structured streams. Then reduce the concrete case syntax-guided, over the TS Core's lossless tree, with ddmin over the `>` lines. Every candidate must load on both Cores and keep the divergence signature.
7. **Run the oracles on the TS Core now:** save/restore round trips, the rollback check, limit sweeps, the Fingerprint checks, the metamorphic relations and the Trace invariants. Add Core-against-Core comparison when the Go Core exists.
8. **Build on property-testing libraries that already shrink:** fast-check on the TS side, and rapid (with `MakeFuzz`) in Go, if the Go Core wants coverage-guided fuzzing of its own parser and checker. The nightly differential job itself needs neither, since the generator and reducer are ours.

**Consequences for the ADRs (proposals, not edits):**

- **ADR 0018:** say that the fuzz harness uses symbolic references, resolved by each runner, and that a committed case keeps only the concrete `>` lines. Name the save/restore, rollback, limit-sweep and Fingerprint oracles as part of the nightly job. Say that a divergence case is committed without output lines until a human decides.
- **ADR 0009:** no change. Fuzzing stays outside the spec. The resolution rule and the oracles are harness data, and nothing the fuzzer adds is normative.
- **ADR 0010:** consider a non-normative fuzz hook that reports each Segment's `segmentBase`, so rollback can be checked when Segments share a Pump. It would be tooling-only, like the debugger hook (ADR 0028), and invisible to the Trace.

## Fog

- **Coverage guidance across two Cores.** The generator is in TS, and the Go Core's coverage lives in Go. A coverage-guided loop over both would need one to drive the other across processes. The nightly job can start blind and swarmed, as Csmith and FoundationDB did, and add coverage feedback on the TS Core first.
- **How much of the checker the generator duplicates.** The may-suspend fixpoint and the `veto` path rule are small. Destructuring shapes and Unit Kinds are larger. Fuzzilli keeps its type model optional for this reason. The generator should stay conservative, so that a gap costs diversity and never validity.
- **Which projection EMI-style pruning compares.** Fuel is charged per clause tried, and frame sizes count slots. The exact fields to leave out need the Cost Model.
- **Save bytes within one Core.** Whether a Core must produce identical save bytes for identical state isn't specified (ADR 0008 leaves the format to each Core). The fuzzer can check it only if the Core promises it.
- **Budget.** How many cases a night, how long a reduction may run, and whether finds are deduplicated by signature before reduction.
- **Libraries and Session Transcripts.** Generating Libraries (ADR 0020) and REPL Entries (ADR 0014) follows the same pattern, but hasn't been worked through. Session Transcripts have a readable form of their own.

## Sources

- Yang, Chen, Eide, Regehr. [Finding and Understanding Bugs in C Compilers](https://users.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf). PLDI 2011 (Csmith).
- Livinskii, Babokin, Regehr. [Random Testing for C and C++ Compilers with YARPGen](https://users.cs.utah.edu/~regehr/yarpgen-oopsla20.pdf). OOPSLA 2020.
- Fitzgerald. [Writing a Test Case Generator for a Programming Language](https://fitzgen.com/2020/08/24/writing-a-test-case-generator.html), 2020, and the [`wasm-smith` docs](https://docs.rs/wasm-smith/latest/wasm_smith/): [`Config`](https://docs.rs/wasm-smith/latest/wasm_smith/struct.Config.html), [`Module`](https://docs.rs/wasm-smith/latest/wasm_smith/struct.Module.html).
- Groß, Koch, Bernhard, Holz, Johns. [FUZZILLI: Fuzzing for JavaScript JIT Compiler Vulnerabilities](https://www.ndss-symposium.org/wp-content/uploads/2023-290-paper.pdf). NDSS 2023, and the [Fuzzilli README](https://github.com/googleprojectzero/fuzzilli).
- Mozilla. [funfuzz](https://github.com/MozillaSecurity/funfuzz) (jsfunfuzz, `compare_jit`).
- Groce, Zhang, Eide, Chen, Regehr. [Swarm Testing](https://users.cs.utah.edu/~regehr/papers/swarm12.pdf). ISSTA 2012.
- Zhou et al. [FoundationDB: A Distributed Unbundled Transactional Key Value Store](https://www.foundationdb.org/files/fdb-paper.pdf). SIGMOD 2021, section 4 (simulation testing).
- TigerBeetle. [VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md).
- Antithesis. [How Antithesis works](https://antithesis.com/docs/introduction/how_antithesis_works/).
- Jepsen. [`jepsen.generator`](https://jepsen-io.github.io/jepsen/jepsen.generator.html).
- Hypothesis. [Stateful testing](https://hypothesis.readthedocs.io/en/latest/stateful.html).
- Claessen, Pałka, Smallbone, Hughes, Svensson, Arts, Wiger. [Finding Race Conditions in Erlang with QuickCheck and PULSE](https://smallbone.se/papers/finding-race-conditions.pdf). ICFP 2009.
- fast-check. [Model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/). rapid: [README](https://github.com/flyingmutant/rapid). Go: [Go Fuzzing](https://go.dev/doc/security/fuzz/).
- Zeller, Hildebrandt. [Simplifying and Isolating Failure-Inducing Input](https://www.st.cs.uni-saarland.de/papers/tse2002/). IEEE TSE 2002.
- Misherghi, Su. [HDD: Hierarchical Delta Debugging](https://dl.acm.org/citation.cfm?id=1134307). ICSE 2006.
- Regehr, Chen, Cuoq, Eide, Ellison, Yang. [Test-Case Reduction for C Compiler Bugs](https://users.cs.utah.edu/~regehr/papers/pldi12-preprint.pdf). PLDI 2012 (C-Reduce, Seq-Reduce).
- Sun, Li, Zhang, Gu, Su. [Perses: Syntax-Guided Program Reduction](https://cs.uwaterloo.ca/~cnsun/public/publication/icse18/). ICSE 2018.
- Xu, Tian, Zhang, Zhao, Jiang, Sun. [Pushing the Limit of 1-Minimality of Language-Agnostic Program Reduction](https://dl.acm.org/doi/10.1145/3586049). OOPSLA 2023 (Vulcan).
- MacIver, Donaldson. [Test-Case Reduction via Test-Case Generation: Insights from the Hypothesis Reducer](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2020.13). ECOOP 2020.
- Le, Afshari, Su. [Compiler Validation via Equivalence Modulo Inputs](https://web.cs.ucdavis.edu/~su/publications/emi.pdf). PLDI 2014.
- Donaldson, Evrard, Lascu, Thomson. [Automated Testing of Graphics Shader Compilers](https://dl.acm.org/doi/10.1145/3133917). OOPSLA 2017.
