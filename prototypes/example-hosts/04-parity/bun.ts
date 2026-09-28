// PROTOTYPE: run the parity case under Bun. `bun 04-parity/bun.ts` (once a TS Core exists).
import { runCase, type Case } from "./runner";

const dir = import.meta.dir;
const c = (await Bun.file(`${dir}/case.json`).json()) as Case;
const got = runCase(c, (p) => require("fs").readFileSync(`${dir}/${p}`, "utf8"));
const want = (await Bun.file(`${dir}/expected.trace`).text()).split("\n").filter((l) => l && !l.startsWith("#"));

const diff = want.flatMap((w, i) => (w === got[i] ? [] : [`- ${w}`, `+ ${got[i] ?? "<missing>"}`]));
console.log(diff.length ? `DIVERGENCE (ts core, bun)\n${diff.join("\n")}` : "ok");
process.exit(diff.length ? 1 : 0);
