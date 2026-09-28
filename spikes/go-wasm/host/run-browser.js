// bun host/run-browser.js <chromium|firefox> <bench|panics|memcap>
// Serves the spike, opens the page headless, waits for the posted results.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const [browser, part, modules] = process.argv.slice(2);
const root = new URL("../", import.meta.url).pathname;
let done;
const finished = new Promise((r) => (done = r));
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/progress") { console.log(await req.text()); return new Response("ok"); }
    if (url.pathname === "/result") {
      const body = await req.text();
      writeFileSync(`${root}results/${browser}-${part}${modules ? "-" + modules.replaceAll(",", "-") : ""}.json`, JSON.stringify(JSON.parse(body), null, 2));
      done(JSON.parse(body));
      return new Response("ok");
    }
    const path = url.pathname === "/" ? "host/index.html" : url.pathname.slice(1);
    const file = Bun.file(root + path);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const url = `http://localhost:${server.port}/host/index.html?part=${part}&browser=${browser}${modules ? `&modules=${modules}` : ""}`;
const profile = mkdtempSync(`${tmpdir()}/spike-${browser}-`);
const cmd = browser === "chromium"
  ? ["chromium", ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url]]
  : ["/Applications/Firefox.app/Contents/MacOS/firefox", ["--headless", "--no-remote", "--profile", profile, url]];
const proc = spawn(cmd[0], cmd[1], { stdio: "ignore" });
const results = await finished;
proc.kill();
server.stop(true);
for (const [k, v] of Object.entries(results)) if (Array.isArray(v)) console.table(v); else console.log(k, v);
process.exit(0);
