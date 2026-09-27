# Cross-host runtime options in Go and TypeScript

Research for [#5](https://github.com/odogono/odgn-talk/issues/5), part of the map in [#1](https://github.com/odogono/odgn-talk/issues/1). Researched 2026-09-27. Vocabulary follows [`CONTEXT.md`](../../CONTEXT.md).

**Question.** With implementation languages limited to Go and/or TypeScript, how can one language run in a Go server, a Bun server and the browser? How does each option do against the hard multi-tenant sandbox bar, async-transparent suspension, cross-host parity, browser payload, performance and upkeep for a small team?

**Short answer.** No host engine gives us a *deterministic* CPU budget. On every option, fuel metering and Handler suspension have to be built into our own interpreter. Given that, the choice comes down to three things: where the hard memory cap comes from, what the browser pays in bytes, and how many implementations we keep. Two options lead. The first is **twin native cores (Go + TS) with spec-defined fuel and memory accounting, held together by a shared conformance corpus** (the CEL model). The second is **a single Go core, run natively in Go and compiled to standard-Go WASM for Bun and the browser** (the Jsonnet model). A TS core embedded in Go through a JS engine comes out weakest on a Go server: in our microbenchmark it was about 40–50× slower than native Go, and its engines are either immature or need cgo.

---

## 1. Three facts that frame every option

### 1.1 Fuel is always the interpreter's job

None of the engines surveyed offers deterministic instruction or fuel metering. What they offer is an asynchronous *interrupt*, driven by wall-clock time or a context:

- goja: `vm.Interrupt()` from another goroutine ([goja README](https://github.com/dop251/goja)).
- wazero: `WithCloseOnContextDone` inserts "periodical checks" at "a bit of extra cost". It has no documented fuel or gas feature ([wazero docs](https://pkg.go.dev/github.com/tetratelabs/wazero)).
- v8go: `TerminateExecution()` ([v8go](https://github.com/tommie/v8go)).
- qjs: `MaxExecutionTime` and `CloseOnContextDone`, the latter documented as "significantly increases evaluation time because every operation must check the done context" ([qjs options.go](https://github.com/fastschema/qjs/blob/master/options.go)).
- Bun `Worker.terminate()` and `node:vm` `timeout` are also wall-clock ([Bun workers](https://bun.com/docs/runtime/workers), [Bun Node compat](https://bun.com/docs/runtime/nodejs-compat)).

The deterministic budgets that do exist all live *inside the language interpreter*:

- Starlark-go: `Thread.SetMaxExecutionSteps` counts "Starlark computation steps" and cancels with "too many steps" ([starlark eval.go](https://github.com/google/starlark-go/blob/master/starlark/eval.go)).
- CEL: `CostLimit`, `CostTracking` and static `EstimateCost` ([cel-go](https://pkg.go.dev/github.com/google/cel-go/cel)).
- Expr: `MaxNodes` (default `1e4`) ([expr conf](https://github.com/expr-lang/expr/blob/master/conf/config.go)).

**Consequence:** whichever option we pick, the interpreter counts steps itself, and the spec has to define what a step costs. Only then will a Script burn the same fuel on every Host. In our throwaway benchmark (section 6), the same interpreter reported an identical step count (2,185,063) natively in Go, as Go-WASM in Node/Bun/wazero, and as JS in Bun, Node, goja and QuickJS.

### 1.2 A *hard* memory cap only comes from WASM linear memory or a V8 isolate

- **Native Go** has no per-goroutine memory limit. `debug.SetMemoryLimit` is a process-wide *soft* limit ([runtime/debug](https://pkg.go.dev/runtime/debug#SetMemoryLimit)). Canonical's hardened Starlark fork says it outright: "the Go interpreter doesn't offer a good basis for such hard enforcement of constraints, so what is implemented is a best effort system via a contract". It counts estimated bytes with `thread.AddAllocs` and ignores frees ([canonical/starlark safety.md](https://github.com/canonical/starlark/blob/main/doc/safety.md)). Expr does the same with an abstract `MemoryBudget` (default `1e6`) that panics with "memory budget exceeded" ([expr vm.go](https://github.com/expr-lang/expr/blob/master/vm/vm.go)).
- **Bun** ignores `Worker` `resourceLimits` ([Bun Node compat](https://bun.com/docs/runtime/nodejs-compat)). `node:vm` has no memory limit. `isolated-vm` is a Node/V8 addon and does not run on Bun's JavaScriptCore. Even on Node it calls `memoryLimit` "more of a guideline instead of a strict limit", with attackers able to reach "2-3 times the specified amount" ([isolated-vm](https://github.com/laverdet/isolated-vm)).
- **WASM** gives a real ceiling. wazero's `WithMemoryLimitPages` caps each instance (default 65536 pages = 4 GB) when the binary does not encode a maximum ([wazero docs](https://pkg.go.dev/github.com/tetratelabs/wazero)). QuickJS adds `JS_SetMemoryLimit` inside that: qjs `MemoryLimit` ([qjs](https://github.com/fastschema/qjs)) and quickjs-emscripten `runtime.setMemoryLimit` ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)).
- **V8 via v8go**: `WithResourceConstraints` is described as "a hard limit on Javascript memory usage", and exceeding it triggers `TerminateExecution` ([tommie/v8go](https://github.com/tommie/v8go)).

**Consequence:** if "hard memory cap" means *enforced by the runtime*, then every native-Go or native-TS option needs a WASM or V8 layer under it. If it can mean *a deterministic, spec-defined allocation budget counted by the interpreter* (the Expr and Canonical-Starlark approach), every option qualifies, and the budget is identical across Hosts. That approach needs a coarse process-level limit behind it as defence in depth. The map needs to settle which meaning applies (see Open questions).

### 1.3 Async transparency should be reified in the interpreter, not borrowed from the host

_hyperscript's runtime is a trampoline. Each command returns the *next* command. If that return value is a Promise, `unifiedExec` attaches `.then(resolvedNext => this.unifiedExec(resolvedNext, ctx))` and returns. Handler state lives in `ctx`, not on the host call stack ([_hyperscript runtime.js](https://github.com/bigskysoftware/_hyperscript/blob/master/src/core/runtime/runtime.js), [async docs](https://hyperscript.org/docs/async/)). This design ports directly to Go (a next-pointer or explicit frame stack, with no Promises involved) and needs no stack switching from the host. The host-native alternatives each have catches:

- **Go goroutines (native)** are cheap and let a suspended Handler simply block. Under `js/wasm`, though, "if one wrapped function blocks, JavaScript's event loop is blocked … calling any async JavaScript API … will cause an immediate deadlock. Therefore a blocking function should explicitly start a new goroutine" ([syscall/js](https://pkg.go.dev/syscall/js)). `js/wasm` also has "no preemption of goroutines and no sysmon goroutine" ([Go CL adding js/wasm](https://groups.google.com/g/golang-codereviews/c/E2ZMXn8I0m0)). Under `wasip1` reactors, background goroutines "will not continue executing when the `go:wasmexport` function returns" ([Go blog: wasmexport](https://go.dev/blog/wasmexport)).
- **TinyGo** implements goroutines on WASM with the `asyncify` scheduler, which is the default in `targets/wasm.json` and `wasip1.json` ([tinygo targets](https://github.com/tinygo-org/tinygo/blob/dev/targets/wasm.json)). It notes WASM "doesn't have native support for stack switching (yet)" ([TinyGo optimizing](https://tinygo.org/docs/guides/optimizing-binaries/)).
- **Asyncify in general** costs size and speed: the asyncified quickjs-emscripten build is "1M, 2x larger than the 500K of the default version", and it "can only suspend to wait for a single asynchronous call at a time" ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)).
- **JSPI** (WASM stack switching on Promises) reached Phase 4 in April 2025 ([interop #1093](https://github.com/web-platform-tests/interop/issues/1093)). It shipped in Chrome 137 ([chromestatus](https://chromestatus.com/feature/5674874568704000)) and Firefox 153 ([bug 2044809](https://bugzilla.mozilla.org/show_bug.cgi?id=2044809)). WebKit only "withdrawn our objections" in Sept 2025 and has no ship commitment ([WebKit position #422](https://github.com/WebKit/standards-positions/issues/422)). Designs should not depend on it.

**Consequence:** an interpreter with explicit, heap-allocated Handler frames (a bytecode VM or CPS) makes suspension identical on every Host. It also makes a suspended Handler serialisable data we can account for in memory. Engine-level coroutines become irrelevant.

---

## 2. Option (a): a Go core compiled to WASM for Bun and the browser

### Standard Go (`GOOS=js` / `GOOS=wasip1`)

- **Size.** The Go wiki gives "~2MB" as the minimum, says "10MB+ is common", and cites Brotli taking 16 MB down to 2.4 MB ([Go wiki: WebAssembly](https://go.dev/wiki/WebAssembly)). Our measurements (Go 1.27.1, `-ldflags='-s -w'`):
  - hello world: **2.46 MB raw / 708 KB gzip-9 / 543 KB brotli-11**
  - a realistic interpreter, starlark-go behind a `syscall/js` export: **4.87 MB / 1.30 MB / 958 KB**
  - Google's production go-jsonnet `libjsonnet.wasm` served by jsonnet.org: **8.10 MB raw / 1.95 MB gzip-9**
- **Speed.** On our tree-walker the Go-WASM build ran **~3.3× slower in Bun and ~4× slower in Node** than native Go. On starlark-go it was **~6.7× (Bun) and ~8× (Node)** slower (section 6).
- **Interop.** `syscall/js` "is EXPERIMENTAL … exempt from the Go compatibility promise" ([syscall/js](https://pkg.go.dev/syscall/js)). `go:wasmexport` (Go 1.24) cannot pass pointers because of the "mismatch between the 64-bit architecture of the client and the 32-bit architecture of the host" ([Go blog: wasmexport](https://go.dev/blog/wasmexport)). Values have to be marshalled across the boundary.
- **Goroutines / event loop.** See 1.3. Goroutines work, but JS→Go callbacks must not block, and there is no preemption.
- **Memory caps.** The Go runtime inside one instance uses a single GC heap, so per-tenant caps have to be interpreter-level accounting. The only alternative is one instance per tenant. In wazero, one Go-WASM instance of our interpreter used **~3.0 MB of linear memory** after a run, and `WithMemoryLimitPages` can cap it. In Bun and the browser, Go's module defines its own memory, so a host-imposed maximum would need the binary to encode one. *Unverified; needs a prototype.*
- **Upkeep.** A single codebase with a first-party toolchain.

### TinyGo

- **Size.** The Go wiki says "10kB typical vs 2MB+" ([Go wiki](https://go.dev/wiki/WebAssembly)). TinyGo's docs show one binary going "from 93K to just 1.6K" with `-no-debug -panic=trap -scheduler=none -gc=leaking` ([TinyGo optimizing](https://tinygo.org/docs/guides/optimizing-binaries/)). *We did not measure an interpreter-sized TinyGo build* (no toolchain locally), so a prototype is needed.
- **Risks that bear on the sandbox bar:**
  - "The `recover` builtin is supported on most architectures, with the notable exception of WebAssembly", and "Runtime panics can currently not be recovered from" ([TinyGo lang support](https://tinygo.org/docs/reference/lang-support/)). One interpreter bug could take down every tenant sharing the instance.
  - The GC "may work not as well … on WebAssembly" and is slower than Go's.
  - `reflect` is only partly supported, and maps "may be slower than you expect".
  - Goroutines rely on asyncify, which carries a size and speed cost.
- **Parity.** A second Go compiler with its own runtime, so subtle behavioural drift from standard Go is possible.

## 3. Option (b): a TS core, native in Bun and the browser, embedded in Go through a JS engine

- **Bun and browser.** Runs natively on a JIT. Our tree-walker ran in **~14 ms in Bun and ~20 ms in Node**, on par with native Go (~15 ms). Payload is small: comparable TS interpreters minify to **84 KB / 24 KB gzip** (`@marcbachmann/cel-js`) and **280 KB / 67 KB gzip** (`@bufbuild/cel`, which includes a protobuf runtime), measured with `bun build --minify`. There is no hard memory cap in Bun (1.2), so accounting has to be interpreter-level.
- **goja** (pure Go, 7.1k★, active). Supports "Full ECMAScript 5.1" and "Most of ES6". It is "6-7 times faster than otto" but "not a replacement for V8". A Runtime "can only be used by a single goroutine at a time", and there is no event loop or job queue built in ([goja](https://github.com/dop251/goja)). It has **no memory limit API**. Our JS tree-walker ran **~640 ms, ~43× native Go**.
- **qjs: QuickJS-ng on wazero** (CGO-free, ES2023). Offers `MemoryLimit`, `MaxStackSize`, `MaxExecutionTime`, a runtime `Pool` and Promise/await support ([qjs](https://github.com/fastschema/qjs)). The embedded `qjs.wasm` is **1.04 MB**. qjs's own benchmark gives factorial ×1M at **746 ms vs goja 1.127 s** and a V8-v7 score of **498 vs goja 442**. On our tree-walker it ran **~730 ms (~50× native Go)**. Maturity is a concern: v0.0.6 (Oct 2025), 610★, last push Dec 2025 (GitHub API, 2026-09-27).
- **v8go.** Needs cgo. Upstream `rogchap/v8go` last released v0.9.0 in Mar 2023 and pins "V8 version 9.0.257.18 (April 2021)" ([rogchap/v8go](https://github.com/rogchap/v8go)). The maintained fork `tommie/v8go` (v0.34.0, Oct 2025, 150★) tracks stable V8 and has hard heap limits. Neither ships Windows binaries ([tommie/v8go](https://github.com/tommie/v8go)). It is the fastest engine, but brings cgo, large static libraries and a single-maintainer fork.
- **Async.** A TS core in Go inherits whatever suspension design the interpreter has. With a reified design (1.3) it needs no engine Promise support.
- **Parity.** One codebase, but three JS engines, each with its own ES-conformance gaps (goja is partial ES6).

## 4. Option (c): twin native implementations kept in step by a conformance suite

Prior art:

| Project | Implementations | How parity is kept | Lessons |
|---|---|---|---|
| **Starlark** | Java (Bazel), Go, Rust and others ([bazelbuild/starlark](https://github.com/bazelbuild/starlark), [awesome-starlark](https://github.com/laurentlb/awesome-starlark)) | Shared spec and `test_suite/` in the spec repo. Go "strives to match the behavior of the Java implementation … Despite some differences" ([starlark-go README](https://github.com/google/starlark-go)) | Language changes go through the spec repo before any implementation. Design goals are "Deterministic", "Hermetic" and "safe to execute untrusted code". |
| **CEL** | cel-go, cel-cpp, cel-java, plus JS: `@bufbuild/cel` and `@marcbachmann/cel-js` | Shared **textproto conformance corpus** (`tests/simple/testdata/*.textproto`, ~30 files: `basic`, `macros`, `timestamps`…) in [cel-spec](https://github.com/cel-expr/cel-spec). `@bufbuild/cel-spec` repackages the test data for JS ([cel-es](https://github.com/bufbuild/cel-es)) | Linear time and "not Turing-complete" by design. It has a cost model (`CostLimit`), which shows a spec-level cost model can be shared. |
| **Jsonnet** | C++ (original), Go | go-jsonnet's `tests.sh` runs the C++ repo's test suite (git submodule), with **25 override files** where outputs differ ([go-jsonnet](https://github.com/google/go-jsonnet)) | The twins drifted and consolidated. The C++ README now says go-jsonnet "is recommended in preference", and the C++ build is "not hardened" for untrusted code ([google/jsonnet](https://github.com/google/jsonnet)). The browser playground runs **Go compiled to WASM** (8.1 MB). |
| **OPA/Rego** | Go evaluator, plus Rego *compiled* to WASM | Compiles each *policy* to a WASM module: "not running the OPA server in Wasm, nor is this just cross-compiled Go code" ([OPA Wasm](https://www.openpolicyagent.org/docs/wasm)) | Some builtins "probably won't be natively supported in Wasm (e.g., `http.send`)" and must come from the host SDK. Parity is partial by construction. |
| **Expr** | Go only | n/a | Shows the Go-side safety toolkit: "Always Terminating", `MaxNodes`, abstract `MemoryBudget` ([expr](https://github.com/expr-lang/expr)). |

Measured against our criteria:
- **Sandbox.** Fuel and memory accounting are spec-defined and implemented twice, deterministically. Hard runtime caps would still need a WASM or process layer.
- **Async.** Implemented twice, but in one shared design (1.3).
- **Parity.** Only as good as the corpus. Jsonnet's 25 overrides and Starlark's "some differences" show residual drift even at Google's scale.
- **Payload and speed.** Best on every Host.
- **Upkeep.** Roughly double: the parser, evaluator, stdlib (chunks, Units, Text Patterns, date/time) and tooling hooks all exist twice.

## 5. Other credible options within the Go/TS constraint

- **(d) One WASM artifact everywhere.** Build the Go core for `wasip1` and run it in **wazero inside the Go server** as well as natively in Bun and the browser. You get identical bytes and semantics on every Host, and a wazero-enforced hard memory cap per instance. Costs:
  - Go-server speed: our tree-walker took **~131 ms in wazero (~9× native)**, rising to **~605 ms with `WithCloseOnContextDone` enabled (4.6× worse again)**. If the interpreter meters its own fuel, that option can stay off.
  - Compile time: ~560 ms per 2.4 MB module, amortised with `WithCompilationCache`.
  - Memory: ~3 MB of linear memory per tenant instance.
- **(e) Shared front end + twin small VMs.** Write the parser, checker and compiler once, emitting a portable bytecode or IR, and implement only a small VM (fuel, accounting, suspension, value model) in both Go and TS. The front end runs server-side or as WASM, or is itself a TS/Go twin. Prior art for portable intermediate forms: OPA's planned IR ([OPA Wasm](https://www.openpolicyagent.org/docs/wasm)) and CEL's protobuf-defined parsed/checked AST in [cel-spec](https://github.com/cel-expr/cel-spec). This shrinks the twin surface, but the stdlib is still double.
- **(f) GopherJS (Go→JS transpiler).** Supports goroutines by unwinding and restoring the whole stack ([GopherJS](https://github.com/gopherjs/gopherjs)). It lags badly: the latest line is a Go 1.19 beta and it needs a Go 1.21 GOROOT, against current Go 1.27. Not viable long term.
- **(g) Out-of-process.** The Go server drives a Bun sidecar running the TS core. This keeps a single TS codebase and gives process-level isolation, but it is no longer "embedded" and adds IPC and operations cost. Listed for completeness.

## 6. Throwaway measurements

Machine: Apple M1 Pro, macOS. Go 1.27.1, Bun 1.4.2, Node 26.10.0, wazero 1.12.0, goja @2026-09-26, qjs v0.0.6. Workload: naive `fib(25)` through a ~50-line AST tree-walker with a per-node step counter, written identically in Go and in JS (2,185,063 steps everywhere). Also `fib(27)` in starlark-go (7,945,265 steps). These are single-machine microbenchmarks, best of 3. Treat them as orders of magnitude, not rankings.

| Runtime | Tree-walker `fib(25)` | vs native Go | starlark-go `fib(27)` |
|---|---|---|---|
| Go native | ~15 ms | 1× | ~77 ms |
| TS/JS core in Bun (JSC JIT) | ~14 ms | ~1× | — |
| TS/JS core in Node (V8 JIT) | ~20 ms | ~1.3× | — |
| Go core → WASM in Bun | ~48 ms | ~3.3× | ~520 ms (~6.7×) |
| Go core → WASM in Node | ~60 ms | ~4× | ~615 ms (~8×) |
| Go core → WASM in wazero (Go server) | ~131 ms | ~9× | — |
| … with `WithCloseOnContextDone` | ~605 ms | ~40× | — |
| TS/JS core in goja (Go server) | ~640 ms | ~43× | — |
| TS/JS core in qjs / QuickJS-on-wazero (Go server) | ~730 ms | ~50× | — |

Browser payload (compressed transfer is what matters):

| Artifact | Raw | gzip-9 | brotli-11 |
|---|---|---|---|
| Go hello world (`js/wasm`) | 2.46 MB | 708 KB | 543 KB |
| starlark-go interpreter (`js/wasm`) | 4.87 MB | 1.30 MB | 958 KB |
| go-jsonnet `libjsonnet.wasm` (jsonnet.org) | 8.10 MB | 1.95 MB | — |
| TinyGo | ~10 KB typical per the Go wiki; interpreter-sized build not measured | | |
| quickjs-emscripten (if a JS engine were shipped to the browser) | ~500 KB (sync) / ~1 MB (asyncify) per README | | |
| `@marcbachmann/cel-js` (TS interpreter, minified) | 84 KB | 24 KB | 21 KB |
| `@bufbuild/cel` (TS interpreter + protobuf runtime, minified) | 280 KB | 67 KB | 58 KB |

## 7. Comparison

Legend: ✅ strong, ◐ workable with caveats, ✗ weak.

| Option | Sandbox: deterministic fuel | Sandbox: hard memory cap | Sandbox: clean stop / isolation | Async-transparent suspension | Cross-host parity | Browser payload | Performance | Upkeep (small team) |
|---|---|---|---|---|---|---|---|---|
| **(a) std Go core, native in Go + WASM in Bun/browser** | ✅ interpreter-level, one impl | ◐ accounting only in Go and Bun. Per-tenant WASM instance possible (~3 MB each; host cap unverified in JS) | ✅ Go: interpreter checks. JS: whole instance shared by tenants unless one per tenant | ◐ goroutines natively. In `js/wasm` callbacks must not block, so a reified design is needed anyway | ✅ one codebase (one compiler, two targets) | ✗ ~1 MB brotli for an interpreter | Go ✅ / Bun ◐ 3–8× slower | ✅ one codebase; `syscall/js` is experimental |
| **(a') TinyGo core for WASM hosts** | ✅ | ◐ same as (a) | ✗ no `recover` on WASM: a panic kills the instance | ◐ asyncify-based goroutines | ◐ second compiler/runtime vs std Go on the server | ◐ likely much smaller (unmeasured for an interpreter) | ◐ slower GC; asyncify overhead | ◐ two Go toolchains; reflect gaps |
| **(b1) TS core; goja in Go** | ✅ interpreter-level | ✗ none in goja or Bun, accounting only | ◐ `Interrupt()`; one Runtime per goroutine | ✅ reified design works in all JS engines | ◐ one codebase, engine ES gaps | ✅ tens of KB | Bun/browser ✅, Go ✗ ~43× | ✅ one codebase + goja glue |
| **(b2) TS core; qjs (QuickJS-on-wazero) in Go** | ✅ | ✅ in Go (QuickJS limit + WASM). ✗ in Bun | ✅ per-runtime WASM instance | ✅ | ◐ QuickJS vs JSC/V8 differences | ✅ | Go ✗ ~50× | ◐ young dependency (v0.0.6), CGO-free |
| **(b3) TS core; v8go in Go** | ✅ | ✅ in Go (V8 heap limit). ✗ in Bun | ✅ isolates | ✅ | ✅ V8 ≈ browser engines | ✅ | Go ✅ (JIT) | ✗ cgo, no Windows, single-maintainer fork |
| **(c) Twin native Go + TS** | ✅ if the spec defines step costs | ◐ spec-defined abstract budget in both. Runtime-hard only with an extra layer | ✅ interpreter-level in both | ✅ one design, two impls | ◐ only as good as the corpus (Jsonnet: 25 overrides) | ✅ tens to ~100 KB | ✅ native everywhere | ✗ ~2× code: parser, stdlib, Units, Patterns |
| **(d) One Go→WASM artifact, wazero in Go** | ✅ | ✅ wazero page cap per instance (Go). ◐ in JS hosts | ✅ per-instance | ◐ as (a) | ✅ identical bytes | ✗ as (a) | ◐ Go ~9×, Bun 3–8× | ✅ one codebase |
| **(e) Shared front end + twin VMs** | ✅ | ◐ as (c) | ✅ | ✅ | ◐ smaller surface than (c) | ✅ | ✅ | ◐ VM + stdlib twice, front end once |

## Implications

**Front-runners (decision deferred to the "Runtime architecture decision" ticket):**

1. **Twin native cores (c), ideally in the (e) shape.** This is the only option that is fast and small on all three Hosts. CEL shows that a shared textproto-style conformance corpus plus a spec-level cost model can keep independent Go and JS implementations aligned. Pick it if browser payload and Bun performance matter as much as the Go server.
2. **Single standard-Go core (a), optionally with (d) for per-tenant hard caps on the Go server.** One codebase and bit-identical semantics. Jsonnet ended up here after running twins. Pick it if a ~1 MB (brotli) browser download and a 3–8× slowdown in Bun are acceptable.

TS-core-in-Go (b) only makes sense if the Go server is a secondary Host. goja is ~43× slower than native Go and has no memory cap. qjs is ~50× slower and immature. v8go brings cgo and a single-maintainer fork.

**Key risks:**

- **Meaning of "hard memory cap".** If it has to be runtime-enforced, only WASM instances or V8 isolates qualify. Native Go and Bun then need one WASM instance per tenant (~3 MB baseline each for a Go core), which limits tenant density. If a deterministic, spec-defined allocation budget is enough (the Expr and Canonical-Starlark model), every option qualifies.
- **Twin drift and cost.** Even Google-maintained twins diverge (Jsonnet overrides, Starlark "some differences"). The corpus has to cover fuel counts and budget exhaustion points, not just values, or deterministic budgets will differ between Hosts.
- **Go-WASM payload and `syscall/js` status.** ~1 MB brotli is a floor for a realistic interpreter, and `syscall/js` sits outside the Go compatibility promise.
- **TinyGo's missing `recover` on WASM** conflicts with "stop a runaway Script without affecting the others" when tenants share an instance.
- **Async must be designed into the interpreter** (reified frames or a trampoline like _hyperscript's `unifiedExec`). Relying on goroutines, asyncify or JSPI (no Safari commitment) would break parity.
- **Interrupt-based cancellation is expensive.** wazero's context-done checks cost ~4.6× in our test. Stops should come from the interpreter's own fuel check.

## Open questions for the map

- Does "hard memory cap" mean runtime-enforced, or is a deterministic, spec-defined allocation budget acceptable (with a coarse process or instance limit behind it)?
- What tenant density per process is targeted? It decides whether one WASM instance per tenant (~3 MB+ each) is affordable.
- Is the browser a multi-tenant Host or a single-user one, and what is the browser payload budget?
- Which server Host is primary for performance: Go or Bun?
- Should the spec define a normative step-cost table and allocation-unit table, so the conformance corpus can assert exact fuel use and budget exhaustion across Hosts?
- Prototype candidates: an interpreter-sized TinyGo build (size, speed, panic behaviour), and whether a Go-WASM module's memory maximum can be imposed in Bun and browsers.
