// PROTOTYPE: run the parity case in a browser page (bundled with the scripts
// and case inlined). Same runner, same TS Core as Bun. The browser run is
// still worth having: it's the only place a Core accident that depends on the
// JS engine (V8 in Bun vs SpiderMonkey/JSC in browsers) would show up, e.g.
// string or sort behaviour leaking through from host libraries (ADR 0009).
import { runCase, type Case } from "./runner";
import caseJson from "./case.json";
import orders from "./scripts/orders.talk" with { type: "text" };
import pricing from "./scripts/pricing.talk" with { type: "text" };
import expected from "./expected.trace" with { type: "text" };

const sources: Record<string, string> = { "scripts/orders.talk": orders, "scripts/pricing.talk": pricing };
const got = runCase(caseJson as Case, (p) => sources[p]!);
const want = expected.split("\n").filter((l) => l && !l.startsWith("#"));
const ok = want.length === got.length && want.every((w, i) => w === got[i]);
document.body.textContent = ok ? "ok" : `DIVERGENCE (ts core, ${navigator.userAgent})\n${got.join("\n")}`;
