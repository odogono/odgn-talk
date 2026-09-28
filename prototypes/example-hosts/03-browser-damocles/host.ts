// PROTOTYPE: Example Host 3, the browser Damocles slice (throwaway; does not
// run). The TS Core replaces the port's Host Callout seam: native game code
// (take/drop, boarding, Damocles Lifts, the Impact Clock) stays native and
// fires events; the Damocles Scripts become talk Scripts.
//
// Grounded in the mercenary repo (web/src/damocles/*, docs/research/damocles-*).
// Vocabulary follows its CONTEXT.md: Body, Damocles Display, Carried Stack,
// Object Residence, Impact Clock, Gameplay Session, Save Snapshot.
//
// Exercises: game and tick events, per-tick Fuel Slices, game time as the
// Clock, pause, save anywhere (ADR 0008) with stable Host Object ids, and a
// Message Path through game objects.
// `// ??` marks where the proposed API (../api/talk.ts) strains.

import * as talk from "../api/talk";
import type { DamoclesSession, Residence, Instance, Body } from "mercenary/web/src/damocles/session";

const VBL_HZ = 50;
const NS_PER_VBL = 1_000_000_000n / BigInt(VBL_HZ); // 20 ms, exact

// ---------------------------------------------------------------------------
// Game Clock: game time, advanced only by ticks. Paused game → frozen Clock.
// ---------------------------------------------------------------------------

let gameNs = 0n;
const gameClock: talk.Clock = { now: () => gameNs };

// ---------------------------------------------------------------------------
// Host Objects. Ids are the catalogue ids, stable across saves.
// ---------------------------------------------------------------------------

declare const game: DamoclesSession;

const sessionKind = talk.defineObjectKind<DamoclesSession>({
  name: "session",
  props: {
    proposedReward: { get: (s) => talk.int(s.records.proposedReward), set: (s, v) => { s.records.proposedReward = toInt(v); } },
    reward:         { get: (s) => talk.int(s.records.reward),         set: (s, v) => { s.records.reward = toInt(v); } },
    assignmentAccepted: { get: (s) => talk.bool(s.flags.accepted), set: (s, v) => { s.flags.accepted = toBool(v); } },
    encounterGate:  { get: (s) => talk.int(s.bank.encounterGate),     set: (s, v) => { s.bank.encounterGate = toInt(v); } },
  },
  // Top of every Message Path.
  endOfPath: () => {}, // a game message nobody handled is normal, not an error
});

const playerKind = talk.defineObjectKind<DamoclesSession>({
  name: "player",
  props: {
    cash: { get: (s) => talk.int(s.records.cash), set: (s, v) => { s.records.cash = toInt(v); } },
    // ?? BCD money in the original, decimal in talk: a clean fit (ADR 0002).
  },
  parent: () => sessionObj,
});

const bodyKind = talk.defineObjectKind<Body>({
  name: "body",
  props: {
    name: { get: (b) => talk.text(b.name) },
    landingLines: { get: (b) => talk.list(...b.landingStrings.map(talk.text)) },
  },
  parent: () => sessionObj,
});

const instanceKind = talk.defineObjectKind<Instance>({
  name: "instance",
  props: {
    name: { get: (i) => talk.text(i.modelName) },
    // No `set` on anything native owns (residence, pose): Scripts in the
    // original couldn't move objects, and neither can these.
  },
  // Message Path by Object Residence: carried → player; on a surface → its
  // Body; inside a structure → its Body (Places don't nest, so no deeper chain).
  parent: (i) => parentByResidence(game.residenceOf(i.slot)),
  // ?? Residence changes when the object is taken. `taken` is fired AFTER the
  //    take, so the path runs through the player, not the Body it lay on.
  //    Fine here, but it shows the path is read at dispatch time from live
  //    game state. For lockstep that's OK only if both Hosts dispatch at the
  //    same point in the tick. The spec should say when Parent is read.
});

function parentByResidence(r: Residence): talk.HostObject | undefined {
  switch (r.kind) {
    case "carried":   return playerObj;
    case "occupied":  return playerObj;
    case "surface":   return bodies[r.body];
    case "structure": return bodies[r.body];
  }
}

const sessionObj = sessionKind.object("session", game);
const playerObj = playerKind.object("player", game);
const bodies: talk.HostObject[] = game.bodies.map((b) => bodyKind.object(`body-${b.index}`, b));
const instances = new Map<number, talk.HostObject>(); // created lazily, id object-slot-N
function instanceObj(slot: number) {
  let o = instances.get(slot);
  if (!o) instances.set(slot, (o = instanceKind.object(`object-slot-${slot}`, game.instance(slot))));
  return o;
  // ?? Lazily created objects: "a duplicate id is a Host error" (ADR 0008),
  //    and on restore every id in the save must resolve. So `resolve` below
  //    must be able to create on demand, too. It can, because ids are
  //    catalogue ids. A Host without such ids would need an id registry.
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

// The Damocles Display: one 48-cell row. `say` scrolls a string in from the
// right (8 px/frame, 36 frames) then holds for the current duration (200
// frames by default). The Host serialises lines FIFO across all Scripts.
type Line = { callId: string; stringId: string; frames: number; call: talk.Call<void> };
const displayQueue: Line[] = [];
let showing: (Line & { elapsed: number }) | undefined;

const display = talk.defineCapability("display", {
  say: {
    mode: "suspending",
    args: [talk.shape.text, talk.shape.optional(talk.shape.map({ for: { shape: talk.shape.any, optional: true } }))],
    cost: { fuel: 10 },
    start(call, id) {
      displayQueue.push({ callId: call.id, stringId: id.asText()!, frames: 200, call });
    },
  },
  clear: {
    mode: "suspending",
    args: [talk.shape.optional(talk.shape.map({ for: { shape: talk.shape.any, optional: true } }))],
    cost: { fuel: 10 },
    start(call, opts) {
      displayQueue.push({ callId: call.id, stringId: "system-string-50", frames: framesOf(opts?.get("for")) ?? 50, call });
    },
  },
});

function advanceDisplay() {
  if (!showing && displayQueue.length) showing = { ...displayQueue.shift()!, elapsed: 0 };
  if (!showing) return;
  game.display.render(showing.stringId, showing.elapsed);
  if (++showing.elapsed >= showing.frames) {
    showing.call.answer(talk.nothing);
    showing = undefined;
  }
}

// The original's noise table: 2,048 words, pointer at $7E18. Deterministic;
// the pointer goes in the Host's Save Snapshot (the original didn't save it;
// the research recommends the port should).
const dice = talk.defineCapability("dice", {
  draw: { mode: "immediate", cost: { fuel: 5 }, do: () => talk.int(game.noise.next()) },
});

const keys = talk.defineCapability("keys", {
  latched: { mode: "immediate", cost: { fuel: 2 }, do: () => (game.keys.latched ? talk.text(game.keys.latched) : talk.nothing) },
  forget: { mode: "fire-and-forget", cost: { fuel: 2 }, fire: () => { game.keys.latched = undefined; } },
  // ?? `forget` is fire-and-forget but must take effect BEFORE the next
  //    statement (the offer's `ask keys to latched`). Fire-and-forget says
  //    nothing about ordering. Here it's synchronous, so it works; the spec
  //    should say fire-and-forget Operations run at the call, in order.
});

// ---------------------------------------------------------------------------
// Group and Scripts: one Group for the whole game (ADR 0009).
// ---------------------------------------------------------------------------

const core = talk.createCore();
const reports: talk.Reports = {
  runEnd(r) { if (r.outcome !== "completed" && r.outcome !== "cancelled") console.error("script", r.script.name, r.handler, r.outcome, r.at); },
};

let group = core.newGroup({ name: "damocles", clock: gameClock, reports });
// No onReady: the game pumps once per VBL, whatever happened.

const grants = {
  display: display.grant("all", undefined),
  dice: dice.grant("all", undefined),
  keys: keys.grant("all", undefined),
};

const messages: Record<string, talk.MessageDecl> = {
  taken:     { args: [talk.shape.object(instanceKind)] },
  landed:    { args: [talk.shape.object(bodyKind)] },
  offer:     {},
  deflected: {},
  keypress:  { args: [talk.shape.text] },
  epilogue:  {},
};

const sessionScript = group.load({ name: "session", source: SESSION_TALK, grants, owner: sessionObj, messages });
const tolosaScript = group.load({ name: "tolosa", source: TOLOSA_TALK, grants, owner: bodies[25], messages });
// ?? Both Scripts use `session` and `player` by name. There's no LoadOptions
//    field to bind well-known Host Objects to names. Proposal:
//    `objects: { session: sessionObj, player: playerObj }`, checked at load
//    like grants.

// ---------------------------------------------------------------------------
// Host Callouts → messages. Native code calls these mid-frame; we queue and
// deliver at a fixed point in the tick so the order is the same every run.
// ---------------------------------------------------------------------------

const pending: talk.Message[] = [];
game.callouts = {
  took: (slot) => pending.push({ name: "taken", args: [instanceObj(slot).value], to: instanceObj(slot) }),
  landed: (body) => pending.push({ name: "landed", args: [bodies[body]!.value], to: bodies[body] }),
  deflected: () => pending.push({ name: "deflected", to: sessionObj }),
  locationTrigger: (t) => { if (t === 0x04) pending.push({ name: "offer", to: sessionObj }); },
  key: (k) => pending.push({ name: "keypress", args: [talk.text(k)], to: sessionObj }),
  // ?? `keypress` goes to the session Script only. A `wait for keypress` in
  //    tolosa.talk would never see it. The Host can't know who's waiting.
  //    Proposal: group.broadcast(m): every Script's mailbox, silently
  //    dropped where no Handler and no `wait for` wants it.
};

function deliver(m: talk.Message) {
  // `to` names the object; the Core finds the Script that owns it or climbs.
  // ?? So which Script's `deliver` do we call? The API has Script.deliver,
  //    but here the target is an object. Proposal: group.deliver(m) routes by
  //    m.to along the Message Path; Script.deliver is the no-object case.
  (group as any).deliver(m);
}

// ---------------------------------------------------------------------------
// The tick. One VBL = one substep (mercenary ADR 0049).
// ---------------------------------------------------------------------------

let paused = false;

function vbl() {
  if (paused) return;                     // Return key in the original: the whole interrupt body skips
  gameNs += NS_PER_VBL;                   // Clock first: waits due this frame fire in this pump
  game.stepNative();                      // runFrame, tickCraft, stepRide, moveAttachments; may fire callouts
  for (const m of pending.splice(0)) deliver(m);
  advanceDisplay();                       // may answer a `say`, making a Run runnable
  const r = group.pump({ fuelSlicePerScript: 5_000 });
  // Scripts are trusted, but a slice keeps a frame bounded. A Run cut by the
  // slice resumes next VBL with its debt carried (ADR 0010).
  if (r.state === "sliced") game.metrics.slicedFrames++;
}
// ?? Order inside the tick is Host policy, but for lockstep with a future Go
//    server it's part of the contract: Clock, native step, deliver, display,
//    pump. The Go Host must copy it exactly. A "tick protocol" doc belongs
//    with the parity example, not in the Core.

setInterval(vbl, 1000 / VBL_HZ); // really: a rAF accumulator, like DamoclesSession.advance()

function pause() { paused = true; }     // no Core call: an unpumped Group is paused
function resume() { paused = false; }

// ---------------------------------------------------------------------------
// Save anywhere. Between VBLs the Group is Quiescent (pump returned), even if
// a Run was cut mid-Segment by its Fuel Slice (ADR 0008).
// ---------------------------------------------------------------------------

type SaveSnapshot = ReturnType<DamoclesSession["snapshot"]> & {
  talk: { versions: talk.Versions; group: string /* base64 */ };
  displayState: { queue: { callId: string; stringId: string; frames: number }[]; showing?: { callId: string; elapsed: number } };
  gameNs: string;
};

function save(): SaveSnapshot {
  return {
    ...game.snapshot(),            // mercenary's bounded JSON (schema 13)
    gameNs: gameNs.toString(),
    displayState: {
      queue: displayQueue.map(({ callId, stringId, frames }) => ({ callId, stringId, frames })),
      showing: showing && { callId: showing.callId, elapsed: showing.elapsed },
    },
    talk: { versions: talk.coreVersions, group: base64(group.save()) },
  };
  // ?? Two save formats nested: the port's strict JSON (ADR 0026 there) and
  //    talk's opaque bytes. The port can't validate inside the bytes, so its
  //    "strictly decoded, refuse on mismatch" rule stops at the talk blob.
}

function restore(s: SaveSnapshot) {
  if (!talk.parityCompatible(s.talk.versions, talk.coreVersions) ||
      s.talk.versions.saveFormat !== talk.coreVersions.saveFormat) {
    throw new Error("save from another build"); // the port refuses; no variables-only restore
  }
  game.restore(s);
  gameNs = BigInt(s.gameNs);

  const savedLines = new Map(s.displayState.queue.map((l) => [l.callId, l]));
  const r = core.restore(unbase64(s.talk.group), {
    clock: gameClock,
    reports,
    grants: (_script, name) => (grants as Record<string, talk.Grant<any>>)[name],
    resolve: (kind, id) => {
      if (id === "session") return sessionObj;
      if (id === "player") return playerObj;
      if (kind === "body") return bodies[Number(id.slice("body-".length))];
      if (kind === "instance") return instanceObj(Number(id.slice("object-slot-".length)));
    },
    settle: (p) => {
      // A `say` in flight: the display's own state (queue position, scroll
      // offset) came back in displayState. Re-issuing would restart the
      // scroll, which is observable. So we "reissue" and make start()
      // idempotent by call id: it re-binds to the saved line instead of
      // queueing a new one.
      // ?? That's a trick. The honest option is a fourth Settlement,
      //    { adopt: true }: "the Host still has this call in progress and will
      //    answer it", which ADR 0008 doesn't list.
      if (p.capability === "display" && (savedLines.has(p.id) || s.displayState.showing?.callId === p.id)) {
        return { reissue: true };
      }
      return { fail: new talk.ScriptError("lost", "call not restorable") };
    },
    onMismatch: "reject",
  });
  group = r.group;
}

// Placeholders.
declare const SESSION_TALK: string, TOLOSA_TALK: string;
declare function toInt(v: talk.Value): number;
declare function toBool(v: talk.Value): boolean;
declare function framesOf(v: talk.Value | undefined): number | undefined;
declare function base64(b: Uint8Array): string;
declare function unbase64(s: string): Uint8Array;
