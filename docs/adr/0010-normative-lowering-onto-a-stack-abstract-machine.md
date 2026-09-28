# Scripts lower normatively onto a stack Abstract Machine, charged per language-level instruction

This refines ADR 0009's "normative abstract instruction set". The spec defines a stack Abstract Machine with numbered local slots, **and** the exact instruction sequence every construct lowers to, including local-slot assignment and constant-pool order. No optimisation happens at the abstract level. Each Core is free below it. An instruction is one language-level operation: one operator, one chunk level, one Destructuring test, one built-in, one Capability call. Its Fuel and allocation come from Cost Model formulas: a static base plus per-unit terms over measures of its operands and result. The whole charge applies at that instruction, so a Run that can't cover it faults at that instruction. The Abstract Machine is versioned together with the Cost Model, because a change to the lowering changes Fuel. We chose this because bit-for-bit Fuel, code positions and diffable instruction streams only hold if both compilers produce the same instructions. A stack machine keeps that lowering a plain post-order walk, whereas a register machine would put register allocation into the spec. Language-level granularity keeps the instruction set small enough to write down, and Cost Model formulas keep bulk work honest.

## Considered Options

- **Normative instruction set, free lowering:** Fuel and positions would differ between Cores, which breaks ADR 0009.
- **Register machine:** fewer instructions, but register allocation becomes normative and every Core must reproduce it exactly.
- **Micro-op instructions:** far more spec surface and far more instructions to charge. **Statement-level instructions:** too coarse to charge honestly or to preempt usefully.
- **Built-ins that call back into Script code:** they need nested native frames, which can't be saved as plain data (ADR 0004, ADR 0008).
- **Stepped Text Pattern matching** (one instruction per character): gives precise mid-match preemption, but the matcher's thread list becomes part of the spec and of every save. The ADR 0007 limits already bound one match.
- **A single `destructure` instruction per pattern:** fewer instructions, but a coarser cost that hides how many clause tests dispatch ran.
- **Executable semantics or a reference interpreter in the spec:** rejected in spirit by ADR 0009. Semantics stay prose plus the Conformance Corpus.

## Consequences

- **Charging:**
  - Only the formula and the fault instruction are normative.
  - A Core may pre-check a cheap bound or poll internally, but its real work must stay proportional to the Fuel remaining.
- **Built-ins:** built-ins are leaves. They never run Script code and never suspend. Higher-order forms (`sort … by`, `where` filters, `every match`) lower to instruction loops.
- **Suspension Points:** they are dedicated instructions (`wait`, `wait-for`, `send-wait`, and `call-cap` for Suspending Capabilities). Grants are fixed at load, so the compiler knows which calls suspend.
- **Text Patterns:** matching is one instruction, charged Σ live Pike-VM threads per input character. The spec pins how the thread list evolves.
- **Fuel Slices:**
  - A Run is preempted before an instruction once its Fuel Slice is used up. Overrun carries as debt into the next slice.
  - Slice preemptions appear in the Trace.
  - The TS Core's wall-clock yields are a Core freedom, invisible and untraced.
- **Persistent State:** it is measured at each Segment end, i.e. at a suspend or at the Run's end. A breach faults at that instruction. Transient growth within a Segment is the Allocation Budget's job.
- **Rollback base:** a Run's `segmentBase` holds its Script's Script Variable bindings, captured at Run start and at every resume. It counts toward no budget, and it is saved for preempted Runs.
- **Dispatch:**
  - A Run starts when its message leaves the mailbox, and dispatch is its first code.
  - Clauses lower to per-pattern-node test instructions with fail targets, followed by the Guard and then the body.
  - Guard code runs in a region where any error skips the clause. The checker enforces Guard purity at load time.
  - If no clause matches, the Run ends as `unhandled` and the message moves along the Message Path.
  - `match` and `let` use the same tests. In `let`, a failed test is an ordinary error.
- **Chunks and Containers:**
  - Each chunk level is its own `chunk-get` or `chunk-set` instruction, and a write is read-modify-write with a single store to the root variable.
  - Reads charge Fuel per character up to the end offset of the chunk. Writes charge Fuel on the full rebuilt length, so a copying Core stays compliant.
  - A write's allocation counts only the new material. Plain expressions still count their whole result.
- **Abstract state:**
  - The spec defines Group, Script, Run and Frame state abstractly. A Frame is its code unit, a pc (instruction index), a fixed number of locals and an operand stack.
  - A frame's size for Persistent State is a base, plus a cost per slot, plus the values it holds.
  - `call` checks the depth limit, and `make-closure` copies the captured values.
- **Core freedom:**
  - Each Core may choose its own byte encoding, dispatch technique, value representation (e.g. ropes) and JIT.
  - Fusion is allowed only when Fuel, the fault instruction and a preemption opportunity at every constituent boundary all stay identical.
  - Each Core must emit a canonical text disassembly and a normative source map from instructions to source locations.
- **Spec files:**
  - `machine.toml` holds opcodes, operand kinds, stack effects, Suspension-Point flags, Cost Model keys and error codes.
  - `cost-model.toml` holds costs as formulas in a small arithmetic language.
  - One TS/Bun generator emits the tables, cost functions, disassembler and assembler into both Cores, and the instruction tables into the spec.
- Narrowed by ADR 0015: a Fuel Slice belongs to a Script, per Pump, and overrun debt is carried per Script.
