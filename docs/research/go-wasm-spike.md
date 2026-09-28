# Spike: Go→WASM size, speed and memory cap in Bun and browsers

Answers [#17](https://github.com/odogono/odgn-talk/issues/17), part of [#1](https://github.com/odogono/odgn-talk/issues/1). It measures the facts behind the "one Go core, native plus WASM" option from [#5](https://github.com/odogono/odgn-talk/issues/5). This is throwaway code. The spike lives in [`spikes/go-wasm/`](../../spikes/go-wasm/) and the raw numbers are in [`spikes/go-wasm/results/`](../../spikes/go-wasm/results/).

## Summary

- **Size.** TinyGo is 2–4× smaller than standard Go. The whole Starlark interpreter is **239 KiB brotli** under TinyGo (202 KiB with `-panic=trap`) and 945 KiB under standard Go. A toy VM is 26 KiB with TinyGo and 445 KiB with standard Go, because the Go runtime alone costs about 400 KiB compressed. `wasm-opt -Oz` saves less than 1% on standard Go output.
- **Speed.** A tight fuel-metered VM loop runs at **2–4× native** time with TinyGo and **3.5–7×** with standard Go. Allocation-heavy interpreter work (Starlark) runs at **5–15×** under TinyGo and **5–9×** under standard Go. TinyGo's GC is the weak spot, worst in Bun (JSC). TinyGo `-opt=2` is the fastest build in V8 and SpiderMonkey. No build is consistently fastest on every host.
- **Panics.**
  - **TinyGo:** `recover()` never works on WASM. Every panic, including runtime errors like divide-by-zero and nil-map writes, traps.
  - **Standard Go:** `recover()` works. An unrecovered panic crashes the Go runtime, and the instance is dead from then on.
  - **Both:** an instance that has trapped is **not safe to reuse**. It keeps working for a while, then corrupts: after ~600 TinyGo panic traps, 4 TinyGo stack-overflow traps, or ~130 standard-Go stack-overflow traps.
- **Memory cap.** A Host **can** impose a hard maximum on any Go-WASM module in Bun, Chromium and Firefox. It rewrites the module at load time to import its memory (≈60 lines of JS) and supplies a `WebAssembly.Memory` with a `maximum`. TinyGo can also import its memory at link time; standard Go has no option for it. Hitting the cap is always a **fatal Go OOM that kills the instance**. TinyGo gets only ~⅓ of the cap as usable heap; standard Go gets ~92%.
- **Instances are not free.** Each one costs 0.4–4 MiB of linear memory and 0.4–12 ms to instantiate. **Chromium allows only 125 live WASM memories per page, and Firefox 999**, whatever their size. Bun handled 3,000.

**What this means for the architecture:**

- A Go core in WASM must treat any trap as the loss of the whole instance.
- The core cannot use Go `panic`/`recover` to contain Script failures. TinyGo can't recover at all, and in both toolchains a trap poisons the instance.
- The per-instance memory cap is only a coarse backstop for the core's own Allocation Budget ([ADR 0006](../adr/0006-limit-faults-roll-back-the-segment.md)). It is not the budget.
- Isolating Scripts from each other by giving each its own instance works in Bun. In Chromium it tops out at about a hundred Scripts per page.

## Setup

| | |
|---|---|
| Machine | Apple M1 Pro, 32 GiB, macOS (Darwin 25.6) |
| Go | 1.27.1 (standard builds, `GOOS=wasip1`, `-buildmode=c-shared`, `-ldflags=-s`) |
| TinyGo | 0.42.0, LLVM 22.1.4, built against **Go 1.26.6** (see below), `-target=wasip1 -buildmode=c-shared -no-debug -stack-size=1MB` |
| Bun | 1.4.2 (JavaScriptCore) |
| Browsers | Headless Chromium 135 (V8), headless Firefox 136 (SpiderMonkey). Safari was not run; Bun stands in for JSC, but its JSC build and flags differ from Safari's. |

**Workloads.** There are two interpreters, and each exports the same entry points through `//go:wasmexport`:

- **Toy VM:** [`vm/`](../../spikes/go-wasm/vm/vm.go) is a stack bytecode VM with a tagged-struct Value, a Fuel check per instruction and heap-allocated frames. It is the shape [#6](https://github.com/odogono/odgn-talk/issues/6) calls for.
- **starlark-go:** used as a real, interpreter-sized Go program.

Four programs run on each interpreter:

- `fib`: recursive calls.
- `loop`: integer loop, no allocation.
- `strings`: builds strings into lists and drops them, which stresses the GC.
- `maps`: string keys and map churn.

**Harness.**

- The same JS harness ([`host/suite.js`](../../spikes/go-wasm/host/suite.js)) runs in Bun and in the browsers, with a 60-line WASI shim ([`host/wasi.js`](../../spikes/go-wasm/host/wasi.js)) that has no files, env or args.
- Each run is one warm-up, then the best of 5.
- Native timings come from the same `core` package run natively.

**TinyGo needs an older Go.** TinyGo 0.42 cannot compile Go 1.27's `hash/maphash` (`undefined: abi.MapType`), which starlark-go imports. The toy VM compiles with Go 1.27; Starlark needs `GOROOT` pointed at Go 1.26.6. So TinyGo always lags the newest Go release, and a Go core built with TinyGo is pinned to whatever Go version TinyGo supports.

## Size

KiB. The `-trap` build is `-panic=trap`, which drops the panic-message printing.

| Module | raw | gzip -9 | brotli -11 |
|---|---:|---:|---:|
| TinyGo toy VM (`-opt=z`, default) | 84.5 | 31.8 | **26.3** |
| TinyGo toy VM (`-opt=2`) | 103.7 | 37.7 | 30.1 |
| TinyGo Starlark (`-opt=z`) | 905.5 | 309.2 | **238.8** |
| TinyGo Starlark (`-opt=2`) | 1061.4 | 368.7 | 279.3 |
| TinyGo Starlark (`-panic=trap`) | 651.7 | 250.4 | 201.6 |
| Go toy VM | 1957.4 | 576.3 | **445.2** |
| Go toy VM + `wasm-opt -Oz` | 1853.5 | 571.5 | 444.1 |
| Go Starlark | 4776.6 | 1281.1 | **944.6** |
| Go Starlark + `wasm-opt -Oz` | 4440.3 | 1274.6 | 953.5 |
| Go Starlark, `GOOS=js` (reference) | 4809.9 | 1290.3 | 950.6 |

## Speed

Best-of-5 wall time in ms. Brackets show the ratio to native Go on the same machine.

| Workload | native | Bun tiny-z | Bun tiny-O2 | Bun go | Chromium tiny-z | Chromium tiny-O2 | Chromium go | Firefox tiny-z | Firefox tiny-O2 | Firefox go |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| VM fib(30) | 97 | 341 (3.5×) | 326 (3.4×) | 341 (3.5×) | 353 (3.6×) | 197 (2.0×) | 715 (7.3×) | 418 (4.3×) | 240 (2.5×) | 364 (3.7×) |
| VM loop 3M | 115 | 377 (3.3×) | 450 (3.9×) | 411 (3.6×) | 389 (3.4×) | 246 (2.1×) | 846 (7.4×) | 472 (4.1×) | 311 (2.7×) | 425 (3.7×) |
| VM strings 1M | 124 | 402 (3.2×) | 530 (4.3×) | 508 (4.1×) | 486 (3.9×) | 323 (2.6×) | 848 (6.8×) | 515 (4.2×) | 415 (3.4×) | 560 (4.5×) |
| VM maps 1M | 158 | 443 (2.8×) | 536 (3.4×) | 603 (3.8×) | 595 (3.8×) | 426 (2.7×) | 1124 (7.1×) | 589 (3.7×) | 406 (2.6×) | 693 (4.4×) |
| Starlark fib(27) | 74 | 495 (6.7×) | 521 (7.0×) | 475 (6.4×) | 572 (7.7×) | 435 (5.9×) | 641 (8.6×) | 521 (7.0×) | 443 (6.0×) | 713 (9.6×)\* |
| Starlark loop 1M | 99 | 1479 (15.0×) | 1224 (12.4×) | 484 (4.9×) | 657 (6.7×) | 498 (5.1×) | 646 (6.5×) | 589 (6.0×) | 523 (5.3×) | 763 (7.7×)\* |
| Starlark strings 300k | 99 | 940 (9.5×) | 789 (8.0×) | 520 (5.3×) | 663 (6.7×) | 491 (5.0×) | 698 (7.1×) | 555 (5.6×) | 483 (4.9×) | 760 (7.7×)\* |
| Starlark maps 300k | 108 | 1156 (10.7×) | 995 (9.2×) | 691 (6.4×) | 745 (6.9×) | 603 (5.6×) | 934 (8.7×) | 652 (6.1×) | 621 (5.8×) | 962 (8.9×)\* |

\* Standard-Go Starlark in Firefox measured **24–32×** when it ran last in the full batch, after five other modules had run in the same page. Run alone ([`firefox-bench-go-star.json`](../../spikes/go-wasm/results/firefox-bench-go-star.json)), it measured the figures shown. So its speed depends on what ran before it in the page (tiering or GC pressure). The cause was not investigated.

Chromium's ~7× for the standard-Go toy VM reproduced when run alone ([`chromium-bench-go-star.json`](../../spikes/go-wasm/results/chromium-bench-go-star.json)). The same module's Starlark workloads run at a normal ratio there, and the cause was not investigated either.

Compile and instantiate times, in ms:

| Module | Bun compile | Bun instantiate + `_initialize` | Chromium compile | Chromium inst. | Firefox compile | Firefox inst. |
|---|---:|---:|---:|---:|---:|---:|
| TinyGo toy VM | 0.7 | 1.8 | 0.4 | 1.5 | 3 | <1 |
| TinyGo Starlark | 1.8 | 1.9 | 1.0 | 1.9 | 6 | <1 |
| Go toy VM | 3.4 | 5.5 | 1.7 | 11.3 | 12 | <1 |
| Go Starlark | 6.6 | 6.0 | 3.6 | 14.2 | 52 | 29 |

Firefox rounds `performance.now()` to 1 ms without cross-origin isolation. Compilation is lazy or tiered in all three engines, so these are times to first call, not to peak speed.

## Panics

Each panic kind ran on a fresh instance, once with a deferred `recover()` and once without. The results were the same in Bun, Chromium and Firefox; only the error message text differs.

| Panic | TinyGo, with `recover` | TinyGo, without | Go, with `recover` | Go, without |
|---|---|---|---|---|
| `panic("boom")` | trap (`unreachable`) | trap | **recovered** | trap; runtime dead |
| VM divide by zero | trap | trap | **recovered** | trap; runtime dead |
| VM index out of range | trap | trap | **recovered** | trap; runtime dead |
| nil map write | trap | trap | **recovered** | trap; runtime dead |
| nil pointer deref | trap | trap | **recovered** | trap; runtime dead |
| Go recursion 10M deep | engine `RangeError` / `InternalError: too much recursion` | same | same (not recoverable) | same |

- **TinyGo cannot recover on WASM** in any configuration tried: `-panic=print` (default), `-panic=trap`, `-scheduler=none`, `+exception-handling`, and `-target=wasm-unknown`. The runtime's `supportsRecover()` is false on WASM. TinyGo prints `panic: …` to fd 1, then executes `unreachable`.
- **Standard Go, unrecovered:** it prints the usual trace, then `runtime.crash` traps. Simple calls still seemed to work afterwards. The next panic fails with `fatal error: panic during malloc`, then `proc_exit(4)`, because the runtime still thinks it is mid-panic. So the instance is effectively dead.
- **Trapped instances decay** (measured in Bun only). [`host/trap-reuse.js`](../../spikes/go-wasm/host/trap-reuse.js) trapped repeatedly and ran a health check between traps. A trap unwinds the engine's call stack but not the module's own state (TinyGo's shadow-stack pointer, the heap, runtime flags). The health check then failed:
  - TinyGo, panic trap: after **605** traps (`unreachable`).
  - TinyGo, stack-overflow trap: after **4** traps (`Out of bounds memory access`).
  - Standard Go, stack-overflow trap: after **130** traps.

**Stack depth.** Plain Go recursion hits two limits: the Go stack, and the engine's native stack, which WASM frames also consume. Maximum depth of a small recursive Go function:

| | Bun | Chromium | Firefox |
|---|---:|---:|---:|
| TinyGo, `-stack-size=1MB` | 32,512 (then TinyGo `fatal error: stack overflow`) | 12,224 (engine) | 14,720 (engine) |
| Standard Go | 93,184 (engine) | 36,096 (engine) | 38,400 (engine) |

TinyGo's default 64 KiB stack overflows at **Starlark call depth ~15** (`fatal error: stack overflow`), so Starlark's `fib(20)` fails. Every other TinyGo build here uses `-stack-size=1MB`. The larger stack costs baseline memory per instance (next section). Engine limits vary by 2.5× between hosts, so any recursion in the core is a cross-host divergence. This supports [#6](https://github.com/odogono/odgn-talk/issues/6): the core should use heap-allocated frames with a depth limit set in the spec, and no Go recursion per Script call.

## Memory cap

**Can the Host impose a maximum?**

- **TinyGo:** yes, at link time. A target JSON that inherits `wasip1` and adds the `ldflags` `--import-memory --max-memory=N` ([`tiny-importmem.json`](../../spikes/go-wasm/tiny-importmem.json)) makes the module import `env.memory` with a declared maximum. The Host can pass a memory with a *lower* maximum. A higher one is rejected at instantiate with a `LinkError` in all three hosts.
- **Standard Go:** it always defines and exports its own memory, with no maximum and no toolchain option to change that.
- **Any module, at load time:** [`host/memory.js`](../../spikes/go-wasm/host/memory.js) removes the memory section and adds an `env.memory` import with the module's original minimum. The export still points at memory index 0, so no other index shifts. The Host then instantiates with `new WebAssembly.Memory({ initial, maximum })`. This worked for both toolchains in Bun, Chromium and Firefox, and costs one pass over the bytes before compiling.

**What happens at the cap?** `memory.grow` returns −1, the Go allocator treats that as fatal, and the instance traps:

| Build, cap | Heap held at failure | Linear memory at failure | Message | Afterwards |
|---|---:|---:|---|---|
| TinyGo, 64 MiB (rewritten) | 22 MiB | 48 MiB | `fatal error: out of memory` → `unreachable` | dead |
| TinyGo, 32 MiB (link-time import) | 10 MiB | 24 MiB | same | dead |
| Go, 64 MiB (rewritten) | 59 MiB | 63.5 MiB | `runtime: out of memory: cannot allocate 1048576-byte block` → `fatal error: out of memory` | dead (`proc_exit(4)`) |
| TinyGo, no cap | 1500 MiB (stopped) | **3072 MiB** | – | ok; 1.9–2.7 s to grow |
| Go, no cap | 1500 MiB (stopped) | 1506 MiB | – | ok; 0.15–0.3 s |

The results were identical in all three hosts. TinyGo grows its heap in large steps and keeps GC headroom, so only about a third of the cap is usable heap. Without a cap, it took twice the memory it held. Neither toolchain gives the Host a recoverable "allocation failed" signal. So the cap stops a runaway from taking the whole process, but it cannot produce a Limit Fault with rollback. That has to come from the core's own Allocation Budget and Persistent State accounting ([ADR 0006](../adr/0006-limit-faults-roll-back-the-segment.md)), set well below the instance cap.

## Instances

The bytes are compiled once, and every instance after that is instantiated from the same compiled module. The table gives linear memory per instance, and the time and count to create up to 3,000 live instances.

| Build | Memory after `_initialize` | After first Starlark call | Bun | Chromium | Firefox |
|---|---:|---:|---|---|---|
| TinyGo Starlark, 64 KiB stack | 0.375 MiB | 0.75 MiB | 3,000 ok, 3.9 ms each | **125**, then `RangeError: Out of memory: Cannot allocate Wasm memory for new instance` | **999**, then `"out of memory"` (a thrown string) |
| TinyGo Starlark, 1 MiB stack | 3 MiB | 6 MiB | 3,000 ok, 5.7 ms each | 125 | 999 |
| Go Starlark | 3.8 MiB | 4.5 MiB | 3,000 ok, 12 ms each | 125 | 999 |

The browser limits are **counts, not bytes**. The count is the same whether each memory is 0.375 MiB or 3.8 MiB, which fits each engine reserving a fixed address-space region and guard pages per WASM memory. Bun's per-instance time went up as live instances accumulated: 2.5 ms (TinyGo) and 6.7 ms (Go) on average over the first 1,000, compared with the 3,000-instance averages above. RSS grows more slowly than linear memory, because untouched pages are never committed.

## Consequences for the runtime decision

- **No shared fate if an instance can trap.** A panic, stack overflow or OOM trap anywhere in the core makes its instance untrustworthy. If many Scripts share one instance, one core bug or one missed limit kills all of them. That is the "affecting the others" failure the sandbox bar forbids. The core has to stay trap-free by design: explicit error returns, no reliance on `recover`, heap frames, and its own depth limit. The Host still needs to plan for replacing the instance.
- **Pick a toolchain.** TinyGo gives small downloads, fast instantiation and the fastest tight loops. The costs are no `recover`, a Go-version lag, a weak GC in JSC, tiny default stacks and a poor usable-heap ratio under a cap. Standard Go gives full Go semantics, the newest Go and a better GC. The costs are 4× the download and 2–7× slower instantiation.
- **Instance-per-Script isolation depends on the host.** In Bun, thousands of instances are fine, at 0.4–4 MiB each. In a Chromium page, the limit is 125 live instances across *everything* on the page. A browser Host would run many Scripts per instance and rely on the core's metering.
- **The memory cap is a backstop, not the budget.** Hosts can impose it on any module with a load-time rewrite, but hitting it can't be recovered, so the core's Allocation Budget has to trip first.

## Not measured (fog)

- The cost of crossing the JS↔WASM boundary for Capability calls and value conversion. Every Script effect goes through it, so it may matter more than raw interpreter speed.
- Suspending Capabilities in WASM. Standard-Go `wasmexport` functions cannot block waiting on the Host. TinyGo's asyncify scheduler adds exports for this but costs size and speed. This spike did not try either, so it is still open whether a Go core can suspend a Run across a Host promise without keeping all interpreter state explicit.
- Safari, and Chrome stable. Only Chromium 135 was run.
- Worker-based isolation in browsers, which would lift the per-page instance count but add messaging cost.
- The Go fuel counter's overhead. The toy VM charges Fuel on every instruction, in every build.

## Reproducing

```sh
cd spikes/go-wasm
go install golang.org/dl/go1.26.6@latest && go1.26.6 download   # GOROOT for TinyGo
brew install tinygo-org/tools/tinygo wabt                       # binaryen comes with tinygo
./build.sh                                                      # all variants into out/
./out/native > results/native-bench.jsonl
bun host/run-bun.js sizes bench panics recursion memcap instances
bun host/trap-reuse.js && bun host/baseline.js
for b in chromium firefox; do for p in bench panics memcap instances; do bun host/run-browser.js $b $p; done; done
bun host/summarize.js                                           # speed tables above
```
