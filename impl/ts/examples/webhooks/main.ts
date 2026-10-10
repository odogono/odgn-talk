// The Bun webhook rules Example Host (spec Appendix B, milestone 2): an HTTP
// server that answers each webhook through a Request to its rules Script.
// It is an embedding example, not a product.
//
//   bun impl/ts/examples/webhooks/main.ts serve [--port 8787] [--database rules.sqlite]
//   bun impl/ts/examples/webhooks/main.ts record [dir]
import { fileURLToPath } from 'node:url';
import { decodeJson, encodeJson, ScriptError } from '../../src/index';
import { createWebhookHost, type WebhookHost } from './host';
import { demoRules, record } from './scenario';

/** The webhook endpoint: `POST /hooks` with an `{type, data}` JSON body. */
export const handler =
  (host: WebhookHost) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/events') {
      return Response.json(
        host.db.prepare('SELECT * FROM events ORDER BY id').all(),
      );
    }
    if (request.method !== 'POST' || url.pathname !== '/hooks') {
      return new Response('not found', { status: 404 });
    }
    let event;
    try {
      event = decodeJson(await request.text());
    } catch (error) {
      return new Response(String(error), { status: 400 });
    }
    try {
      // A client that hangs up aborts request.signal, which cancels the Run.
      const result = await host.handle(event, request.signal);
      return new Response(encodeJson(result), {
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      if (error instanceof ScriptError) {
        return Response.json(
          { code: error.code, data: JSON.parse(encodeJson(error.data)) },
          { status: 422 },
        );
      }
      return new Response(String(error), { status: 500 });
    }
  };

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};

/**
 * Starts the server, with this process's own stand-in upstream under
 * `/sink/`, so it runs alone. A body with `"fail": true` gets a 500 from it,
 * and one with `"slow": true` waits 5 s first.
 */
export const startServer = (o: { database?: string; port?: number } = {}) => {
  // The handler needs the Host, and the Host needs the server's port.
  const hooks: { handle?: (request: Request) => Promise<Response> } = {};
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: o.port ?? 8787,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/sink/')) {
        const body = await request.text();
        console.log(`upstream ${url.pathname} <- ${body}`);
        if (body.includes('"fail":true')) {
          return new Response('no', { status: 500 });
        }
        if (body.includes('"slow":true')) {
          await Bun.sleep(5000);
        }
        return new Response(null, { status: 202 });
      }
      return hooks.handle!(request);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const host = createWebhookHost({
    database: o.database,
    rules: demoRules,
    targets: {
      fulfilment: `${base}/sink/fulfilment`,
      accounts: `${base}/sink/accounts`,
    },
  });
  hooks.handle = handler(host);
  return {
    base,
    host,
    stop: async () => {
      await server.stop(true);
      host.close();
    },
  };
};

if (import.meta.main) {
  const command = process.argv[2];
  if (command === 'serve') {
    const { base } = startServer({
      database: option('--database'),
      port: Number(option('--port') ?? 8787),
    });
    console.log(`webhooks listening on ${base}`);
  } else if (command === 'record') {
    const dir =
      process.argv[3] ??
      fileURLToPath(
        new URL('../../../../corpus/examples/webhooks', import.meta.url),
      );
    await record(dir);
  } else {
    console.error(
      'usage: main.ts serve [--port N] [--database PATH] | main.ts record [dir]',
    );
    process.exit(2);
  }
}
