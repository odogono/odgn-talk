// PROTOTYPE: parity runner for the TS Core (throwaway; does not run). The
// same module runs under Bun (bun.ts) and in a browser page (browser.ts).
// It replays case.json on a virtual Clock and returns the Trace lines.
// `// ??` marks where the proposed API (../api/talk.ts) strains.

import * as talk from "../api/talk";

export interface Case {
  versions: { language: string; costModel: string; machine: string };
  limits: Partial<talk.Limits>;
  capabilities: Record<string, Record<string, OpDecl>>;
  scripts: { name: string; source: string; grants: Record<string, string[]> }[];
  steps: Step[];
}
type OpDecl = { mode: "immediate" | "suspending" | "fire-and-forget"; args: string[]; cost: talk.Cost };
type Step = {
  clock: string;
  deliver?: { to: string; name: string; args?: unknown[] };
  answer?: { call: string; value: unknown };
};

export function runCase(c: Case, readSource: (path: string) => string): string[] {
  // 1. Versions: parity is only promised between equal versions (ADR 0009).
  if (!talk.parityCompatible({ ...talk.coreVersions, ...c.versions }, talk.coreVersions)) {
    return [`# skipped: case wants ${JSON.stringify(c.versions)}`];
  }

  // 2. Capabilities from the case file, not Host code: their costs and modes
  //    must be identical on every Core, so they are data.
  //    ?? This is the only Host where Operations are declared as data. The
  //       API takes functions. A data form of Operation declarations (names,
  //       shapes, costs, modes) would serve the corpus, the LSP (completion
  //       from grants) and the Elixir message layer at once.
  const inFlight = new Map<string, talk.Call<void>>(); // "pricing/r1.c1" → Call
  const caps = Object.fromEntries(
    Object.entries(c.capabilities).map(([capName, ops]) => [
      capName,
      talk.defineCapability(capName, Object.fromEntries(
        Object.entries(ops).map(([opName, d]) => [opName, mockOp(d, (call) => {
          inFlight.set(`${call.script.name}/${call.id}`, call);
          // ?? Call ids are per Script ("r1.c1"), so the case has to qualify
          //    them with the Script name. Should the Core's CallID already be
          //    Group-unique ("pricing/r1.c1")?
        })]),
      ) as Record<string, talk.Operation<void>>),
    ]),
  );

  // 3. Group on a virtual Clock the steps set.
  let now = 0n;
  const trace: string[] = [];
  const group = talk.createCore().newGroup({
    name: "parity",
    clock: { now: () => now },
    trace: (line) => trace.push(line),
  });
  const scripts = new Map<string, talk.Script>();
  for (const s of c.scripts) {
    const grants = Object.fromEntries(
      Object.entries(s.grants).map(([cap, ops]) => [cap, caps[cap]!.grant(ops, undefined)]),
    );
    scripts.set(s.name, group.load({ name: s.name, source: readSource(s.source), grants, limits: c.limits }));
  }

  // 4. Replay. After each step, pump until idle.
  for (const [i, step] of c.steps.entries()) {
    now = parseInstant(step.clock);
    trace.push(`step ${i + 1} clock=${step.clock}`);
    // ?? The Host writes the `step` line itself, so its wording is not spec.
    //    Should the Trace record Host inputs (deliveries, answers, Clock
    //    readings) itself? Then the Trace alone is a replayable case.
    if (step.deliver) {
      scripts.get(step.deliver.to)!.deliver({
        name: step.deliver.name,
        args: (step.deliver.args ?? []).map(caseValue),
      });
    }
    if (step.answer) {
      inFlight.get(step.answer.call)!.answer(caseValue(step.answer.value));
    }
    let r: talk.PumpResult;
    do r = group.pump(); while (r.state === "sliced");
    // With no slice this loop runs once. It's here because a case may set
    // fuelSlicePerScript, and slices must appear in the Trace (ADR 0010).
  }
  return trace;
}

function mockOp(d: OpDecl, onStart: (c: talk.Call<void>) => void): talk.Operation<void> {
  switch (d.mode) {
    case "suspending": return { mode: "suspending", cost: d.cost, start: (call) => onStart(call) };
    case "immediate": return { mode: "immediate", cost: d.cost, do: () => talk.nothing };
    case "fire-and-forget": return { mode: "fire-and-forget", cost: d.cost, fire: () => {} };
  }
}

// Case values: JSON plus tagged forms for kinds JSON lacks.
//   {"$quantity": ["2.50", "GBP"]}, {"$dec": "0.1"}, {"$bytes": "0d0a"}, {"$instant": "…"}
// Plain JSON numbers must be integers; anything else must use $dec.
// ?? Every Core's runner needs this exact decoder, and a bug in one runner
//    looks like a Core divergence. It should be spec'd with the corpus and
//    shipped in both Cores (talk.corpus.decode), not written per Host.
declare function caseValue(v: unknown): talk.Value;
declare function parseInstant(s: string): bigint;

// ---------------------------------------------------------------------------
// Lockstep (Damocles: TS browser client + future Go server). Before
// exchanging anything, both sides compare versions; then each tick they
// compare a hash of that tick's Trace lines.
// ---------------------------------------------------------------------------

export function handshake(remote: talk.Versions): "ok" | "refuse" {
  return talk.parityCompatible(remote, talk.coreVersions) ? "ok" : "refuse";
  // ?? Unicode is pinned by Language (ADR 0011), so it isn't compared. The
  //    Unit catalogue and error-code catalogue: are they pinned by Language
  //    too, or do they need their own version fields?
}

export function tickDigest(lines: string[]): string {
  return sha256(lines.join("\n"));
  // ?? A desync is detected one tick late at best, and says nothing about
  //    why. Sending the full Trace on mismatch only (not every tick) keeps
  //    bandwidth down.
}
declare function sha256(s: string): string;
