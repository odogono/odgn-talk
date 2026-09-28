// PROTOTYPE: Example Host 2, a Bun server running the TS Core (throwaway;
// does not run). A webhook rules service plus the weather-report Script from
// the syntax sketch. One Script Group per team.
//
// Exercises: the TS API on a server, a real-time Clock, Suspending
// Operations backed by promises (fetch) with AbortSignal cancellation, an
// Immediate Operation backed by synchronous bun:sqlite, request/reply from
// outside (HTTP in → Handler return value out), autoDrive.
// `// ??` marks where the proposed API (../api/talk.ts) strains.

import { Database } from "bun:sqlite";
import * as talk from "../api/talk";

const core = talk.createCore();

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

type Team = { id: string; allowedOrigins: string[]; db: Database };

const http = talk.defineCapability<Team>("http", {
  get: {
    mode: "suspending",
    args: [talk.shape.text, talk.shape.optional(talk.shape.openMap({}))],
    cost: { fuel: 1000 },
    run: (call, url, opts) => fetchAsValue(call, "GET", url, opts),
  },
  post: {
    mode: "suspending",
    args: [talk.shape.text, talk.shape.openMap({ json: { shape: talk.shape.any, optional: true } })],
    cost: { fuel: 1000 },
    run: (call, url, opts) => fetchAsValue(call, "POST", url, opts),
  },
});

async function fetchAsValue(
  call: talk.Call<Team>, method: string, urlV: talk.Value, opts?: talk.Value,
): Promise<talk.Value> {
  const url = urlV.asText()!;
  if (!call.binding.allowedOrigins.includes(new URL(url).origin)) {
    throw new talk.ScriptError("forbidden", `origin not allowed: ${url}`);
  }
  const json = opts?.get("json");
  const res = await fetch(url, {
    method,
    signal: call.signal, // `, replacing` or Stop Script aborts the fetch
    headers: json && json.kind !== "nothing" ? { "content-type": "application/json" } : undefined,
    body: json && json.kind !== "nothing" ? valueToJSON(json) : undefined,
    // ?? valueToJSON: decimals → JSON numbers need a rule (34 digits don't
    //    fit a JS number). Same question as Go. talk should ship it.
  });
  const body = new Uint8Array(await res.arrayBuffer());
  call.charge(Math.ceil(body.length / 1024) * 10);
  // ?? Same as Go: charging after the await. The Run is suspended; a
  //    LimitReached thrown here rejects the promise and the Core must turn
  //    that rejection into a Limit Fault on resume, not an ordinary error.
  //    So `run` has to distinguish LimitReached from ScriptError from any
  //    other exception (a Host bug: fail as "host error"?).
  return talk.record({
    status: talk.int(res.status),
    headers: talk.map([...res.headers].map(([k, v]) => [k.toLowerCase(), talk.text(v)])),
    body: talk.bytes(body),
  });
}

const kv = talk.defineCapability<Team>("kv", {
  get: {
    mode: "immediate",
    args: [talk.shape.text],
    cost: { fuel: 50 },
    do(call, key) {
      const row = call.binding.db.query("select v from kv where k = ?").get(key.asText()!) as
        | { v: string } | null;
      return row ? talk.text(row.v) : talk.nothing;
      // ?? Stores text only. Storing any Value needs a Host-side
      //    serialisation of Values (the save format is Core-private and
      //    same-core only). A canonical value encoding for Hosts would help.
    },
  },
  put: {
    mode: "immediate",
    args: [talk.shape.text, talk.shape.text],
    cost: { fuel: 100 },
    do(call, key, val) {
      call.charge(val.length); // per Character stored
      call.binding.db.run("insert or replace into kv values (?, ?)", [key.asText()!, val.asText()!]);
      return talk.nothing;
    },
  },
});

const log = talk.defineCapability<Team>("log", {
  write: {
    mode: "fire-and-forget",
    args: [talk.shape.text],
    cost: { fuel: 20 },
    fire(call, line) { console.log(`[${call.binding.id}/${call.script.name}]`, line.asText()); },
  },
});

// Real-time Clock. Nanoseconds since the epoch.
// ?? Date.now() is ms; performance.timeOrigin + performance.now() is finer
//    but not monotonic across sleeps. The Clock must never go backwards
//    (ADR 0008), so the Host clamps. Should the Core clamp instead?
let lastNow = 0n;
const realClock: talk.Clock = {
  now() {
    const n = BigInt(Date.now()) * 1_000_000n;
    lastNow = n > lastNow ? n : lastNow;
    return lastNow;
  },
};

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function loadTeam(team: Team, sources: Record<string, string>) {
  const group = core.newGroup({
    name: `team:${team.id}`,
    clock: realClock,
    reports: {
      runEnd(r) {
        if (r.outcome !== "completed") console.warn(team.id, r.script.name, r.handler, r.outcome, r.error?.code ?? r.limit);
      },
      stop(r) { console.warn(team.id, r.script.name, "stopped:", r.reason, r.discardedRuns.length, "runs discarded"); },
    },
  });

  const grants = {
    http: http.grant(["get", "post"], team),
    kv: kv.grant("all", team),
    log: log.grant("all", team),
  };

  const scripts: Record<string, talk.Script> = {};
  for (const [name, source] of Object.entries(sources)) {
    scripts[name] = group.load({
      name, source, grants,
      limits: { maxWaitMs: 5 * 60_000 },
      messages: {
        webhook: { args: [talk.shape.any], defaultQueueing: "every time" },
        report: { args: [talk.shape.text, talk.shape.text] },
      },
    });
  }
  // autoDrive pumps on onReady (microtask) and at nextDeadline (setTimeout),
  // FuelCap per pump so one team can't hold the event loop.
  // ?? autoDrive needs onReady, but onReady was fixed at newGroup time.
  //    So autoDrive must be passed to newGroup, or Group needs
  //    `setOnReady`. Proposal: newGroup({ ..., drive: "auto" | "manual" }).
  const driver = talk.autoDrive(group, { fuelCap: 100_000 });
  return { group, scripts, driver };
}

const teams = new Map<string, ReturnType<typeof loadTeam>>();

// ---------------------------------------------------------------------------
// Inbound HTTP
// ---------------------------------------------------------------------------

Bun.serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);
    const [, , teamId] = url.pathname.split("/"); // /hooks/:team
    const team = teams.get(teamId!);
    if (!team) return new Response("no such team", { status: 404 });

    const event = jsonToValue(await req.text(), { event: req.headers.get("x-github-event") ?? "" });
    // ?? JSON → Value on the Host side again: key order, decimals, and the
    //    extra `event` key merged in front. talk.fromJSON(text) would give
    //    order and exact decimals for free.
    try {
      const reply = await withTimeout(
        team.scripts.rules!.request({ name: "webhook", args: [event] }),
        10_000,
      );
      // ?? On timeout the Run keeps going; we've just stopped waiting. There's
      //    no way to say "cancel the Run this request started" because
      //    request() never told us its Run id. Proposal: request() returns
      //    { runId, reply } or accepts an AbortSignal.
      return toResponse(reply);
    } catch (e) {
      if (e instanceof talk.MailboxFull) return new Response("busy", { status: 429 });
      if (e instanceof talk.RunEnded && e.report.outcome === "cancelled") {
        return new Response("superseded", { status: 202 }); // the debounce case in rules.talk
      }
      if (e instanceof talk.RunEnded && e.report.outcome === "limit fault") {
        return new Response("rule ran out of " + e.report.limit, { status: 503 });
      }
      if (e instanceof talk.ScriptError) return new Response(e.code, { status: 500 });
      throw e;
    }
  },
});

function toResponse(v: talk.Value): Response {
  const status = Number(v.get("status").asDecimal()?.toBigInt() ?? 200n);
  const body = v.get("body").asText();
  return new Response(body ?? null, { status });
}

// Placeholders.
declare function jsonToValue(text: string, extra: Record<string, string>): talk.Value;
declare function valueToJSON(v: talk.Value): string;
declare function withTimeout<T>(p: Promise<T>, ms: number): Promise<T>;
