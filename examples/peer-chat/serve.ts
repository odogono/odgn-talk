#!/usr/bin/env bun
// Serves the chat page: `bun examples/peer-chat/serve.ts [port]`, then open
// http://127.0.0.1:7400 once `northtalk --listen ws://127.0.0.1:7401
// examples/peer-chat/chat.talk` runs.
import { resolve } from 'node:path';

const page = `<!doctype html>
<meta charset="utf-8">
<title>Northtalk chat</title>
<ol id="log"></ol>
<form><input placeholder="Say something" autofocus><button>Send</button></form>
<script type="module" src="/page.js"></script>`;

/** Bundles the page and serves it until stopped. */
export const serveChat = async (port: number) => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'page.ts')],
    target: 'browser',
  });
  if (!build.success) {
    throw new AggregateError(build.logs, 'Chat page bundle failed');
  }
  const script = build.outputs[0]!;
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: request =>
      new URL(request.url).pathname === '/page.js'
        ? new Response(script, {
            headers: { 'content-type': 'text/javascript' },
          })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
};

if (import.meta.main) {
  const server = await serveChat(Number(process.argv[2] ?? 7400));
  process.stdout.write(`chat page on ${server.url}\n`);
}
