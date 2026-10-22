// Drives the HTTP router, `@northtalk/ts/http`, through the http test kit,
// `corpus/http-kit/`: a Script served through real sockets on 127.0.0.1,
// with the answers chapter 7 and chapter 9's HTTP router require. Each case
// gets a fresh router and Group. Runs under Bun and, bundled, under Node.
import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import { newDrivenGroup } from '../src/driver';
import { createHttpHost } from '../src/http/index';
import { httpCapability } from '../src/http-capability';
import { newGroup } from '../src/index';

export type HttpKitStep = {
  /** Sends the request, then goes before any answer. */
  abort?: string;
  body?: string;
  /** Text the response body mustn't contain. */
  excludes?: string;
  headers?: Record<string, string | string[]>;
  /** "<METHOD> <target>" */
  refused?: string;
  request?: string;
  response?: string;
  responseHeaders?: Record<string, string>;
  responseHex?: string;
  /** Requests this message of the Script and waits for its Run. */
  send?: string;
  sleep?: number;
  status?: number;
  /** The content-type answered; "" for none. */
  type?: string;
};

export type HttpKitCase = {
  file: string;
  grants: string[];
  maxBodyBytes?: number;
  name: string;
  script: string;
  steps: HttpKitStep[];
};

type KitFile = {
  case: (Omit<HttpKitCase, 'file' | 'grants'> & { grants?: string[] })[];
};

/** Every case in the kit, file by file. Needs Bun to read TOML. */
export const httpKitCases = async (root?: string): Promise<HttpKitCase[]> => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const dir = root ?? resolve(import.meta.dir, '../../../corpus/http-kit');
  return readdirSync(dir)
    .filter(f => f.endsWith('.toml'))
    .sort()
    .flatMap(file => {
      const kit = Bun.TOML.parse(
        readFileSync(resolve(dir, file), 'utf8'),
      ) as KitFile;
      return kit.case.map(c => ({ ...c, file, grants: c.grants ?? ['http'] }));
    });
};

const costs = {
  serve: { fuel: 10 },
  unserve: { fuel: 5 },
  respond: { fuel: 10 },
};

type Answer = {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  status: number;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const send = (
  port: number,
  line: string,
  step: HttpKitStep,
  abortAfterMs?: number,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const [method, target] = line.split(' ') as [string, string];
    const body = step.body === undefined ? undefined : Buffer.from(step.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: target,
        agent: false,
        headers: {
          connection: 'close',
          ...step.headers,
          ...(body ? { 'content-length': body.length } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
    if (abortAfterMs !== undefined) {
      setTimeout(() => {
        req.destroy();
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0) });
      }, abortAfterMs);
    }
  });

const check = (step: HttpKitStep, a: Answer): string | undefined => {
  const text = a.body.toString('utf8');
  if (step.status !== undefined && a.status !== step.status) {
    return `status ${a.status}, wanted ${step.status} (body ${JSON.stringify(text)})`;
  }
  if (step.response !== undefined && text !== step.response) {
    return `body ${JSON.stringify(text)}, wanted ${JSON.stringify(step.response)}`;
  }
  if (
    step.responseHex !== undefined &&
    a.body.toString('hex') !== step.responseHex
  ) {
    return `body ${a.body.toString('hex')}, wanted ${step.responseHex}`;
  }
  if (step.excludes !== undefined && text.includes(step.excludes)) {
    return `body ${JSON.stringify(text)} gives away ${step.excludes}`;
  }
  if (
    step.type !== undefined &&
    (a.headers['content-type'] ?? '') !== step.type
  ) {
    return `content-type ${JSON.stringify(a.headers['content-type'])}, wanted ${JSON.stringify(step.type)}`;
  }
  for (const [k, v] of Object.entries(step.responseHeaders ?? {})) {
    const got = a.headers[k.toLowerCase()];
    const joined = Array.isArray(got) ? got.join(', ') : got;
    if (joined !== v) {
      return `header ${k} ${JSON.stringify(joined)}, wanted ${JSON.stringify(v)}`;
    }
  }
  return undefined;
};

/** Runs one case; gives the first failure, or undefined when it passes. */
export const runHttpKitCase = async (
  c: HttpKitCase,
): Promise<{ error: string; step: number } | undefined> => {
  const logs: string[] = [];
  const host = createHttpHost({
    log: m => logs.push(m),
    ...(c.maxBodyBytes === undefined ? {} : { maxBodyBytes: c.maxBodyBytes }),
  });
  const capability = httpCapability(host.impl, costs);
  const driven = newDrivenGroup(
    { newGroup },
    { name: 'kit', onPump: r => host.pumped(driven.group, r) },
  );
  const { group, drive } = driven;
  let at = -1;
  try {
    const script = group.load({
      name: 'main',
      source: c.script,
      grants: Object.fromEntries(
        c.grants.map(g => [g, capability.grant('all', undefined)]),
      ),
    });
    const port = Number(
      (await script.request({ name: 'start' }).result).toString(),
    );
    for (const [i, step] of c.steps.entries()) {
      at = i;
      if (step.sleep !== undefined) {
        await sleep(step.sleep);
      } else if (step.send !== undefined) {
        await script.request({ name: step.send }).result;
        await drive.idle();
      } else if (step.abort !== undefined) {
        await send(port, step.abort, step, 100);
      } else if (step.refused !== undefined) {
        try {
          const a = await send(port, step.refused, step);
          return { step: i, error: `answered ${a.status}, wanted refused` };
        } catch (error) {
          if ((error as { code?: string }).code !== 'ECONNREFUSED') {
            return { step: i, error: `failed with ${String(error)}` };
          }
        }
      } else if (step.request !== undefined) {
        const failure = check(step, await send(port, step.request, step));
        if (failure) {
          return { step: i, error: failure };
        }
      }
    }
    return undefined;
  } catch (error) {
    return { step: at, error: String(error) };
  } finally {
    await host.close();
    await drive.close();
  }
};
