// The HTTP router (spec chapter 9, The HTTP router; ADR 0124): the Host side
// of the optional `http` Standard Capability. It holds Serve Registrations,
// listens on `node:http`, turns each HTTP request into a `Script.deliver`
// and answers the HTTP Exchange from `respond` or, failing that, from the
// Pump's reports. It is built only on the embedding interface, so it serves
// either Core's Groups, and on `node:http`, so it runs under Node and Bun.
import { Buffer } from 'node:buffer';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { shape, type Call } from '../capabilities';
import type { Group } from '../embedding';
import { HostError, ScriptError } from '../errors';
import type { PumpResult, Report } from '../group';
import type { HttpImpl, HttpServerImpl } from '../http-capability';
import { createHttpFetch, type HttpFetchOptions } from './fetch';
import {
  defineObjectKind as defineTsObjectKind,
  type HostObject,
  type ObjectKind,
  type ObjectKindDef,
} from '../objects';
import { bool, bytes, listValues, map, num, text, type Value } from '../values';

/** The largest request body the router reads by default: 1 MiB. */
export const HTTP_DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type HttpHostOptions = {
  /**
   * Whether a Grant may listen on this address, from its binding. The
   * default allows any; a refusal fails `serve` with `bad address`.
   */
  allow?: (host: string, port: number, binding: unknown) => boolean;
  /** The host a `serve` without `host` listens on: `127.0.0.1` by default. */
  defaultHost?: string;
  /** The port a `serve` without `port` listens on: 0, any free port, by default. */
  defaultPort?: number;
  /** Defines the `httpExchange` Object Kind; the TS Core's by default. Pass the Core's own for the Zig Host Adapter. */
  defineObjectKind?: <N>(k: ObjectKindDef<N>) => ObjectKind<N>;
  /**
   * Offers `fetch` beside the server Operations, with these origins and
   * bounds. Without it the Host only serves; `createHttpFetch` alone only
   * fetches.
   */
  fetch?: HttpFetchOptions;
  /** Told of each 500's cause and each refused Delivery. Never sent to the client. */
  log?: (message: string) => void;
  /** A larger request body is answered 413 without a Delivery. */
  maxBodyBytes?: number;
  /** When set, every `serve` listens on this port, whatever it asked for. */
  portOverride?: number;
};

export type HttpAddress = { host: string; port: number };

export type HttpHost = {
  /** Every address listening now, in the order the listeners bound. */
  addresses(): HttpAddress[];
  /** Stops accepting, answers every open exchange 503 and closes every listener. */
  close(): Promise<void>;
  /** A Group the Host discards: removes its registrations and answers its open exchanges 503. */
  detach(group: Group): void;
  /**
   * Waits up to `ms` for the open exchanges to be answered, then answers the
   * rest 503. Call `stopAccepting` first so no new ones arrive.
   */
  drain(ms: number): Promise<void>;
  /** The `HttpImpl` to give `httpCapability`. */
  readonly impl: HttpImpl;
  /** `onPump` for a Group's driver: `pumped(group, result)` bound to it. */
  onPump(group: Group): (result: PumpResult) => void;
  /** The exchanges delivered and not yet answered. */
  readonly openExchanges: number;
  /** After each Pump of the Group returns: settles exchanges from its reports, in order. */
  pumped(group: Group, result: Pick<PumpResult, 'reports'>): void;
  /** The Serve Registrations held. */
  readonly registrations: number;
  /** Stops accepting connections. New requests on open connections are answered 503. */
  stopAccepting(): void;
};

type Owner = { grant: string; group: Group; script: string };

type Registration = {
  /** The address the `serve` asked for, before the port was chosen. */
  asked: HttpAddress;
  key: string;
  listener: Listener;
  message: string;
  name: string;
  owner: Owner;
  ownerKey: string;
  prefix: string;
};

type Listener = {
  /** The bound address; undefined while binding. */
  address?: HttpAddress;
  host: string;
  /** Serves waiting for the bind. */
  pending: { call: Call<unknown>; registration: Registration }[];
  registrations: Set<Registration>;
  server: Server;
};

type Exchange = {
  answered: boolean;
  closed: boolean;
  delivery?: string;
  group: Group;
  object?: HostObject<Exchange>;
  res: ServerResponse;
  run?: string;
};

const hostErrorOf = (code: string, message: string) =>
  new ScriptError(code, message);

// Reads a Value's whole number, or undefined.
const wholeOf = (v: Value): number | undefined => {
  if (v.kind !== 'number') {
    return undefined;
  }
  const n = Number(v.toString());
  return Number.isSafeInteger(n) ? n : undefined;
};

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The one argument chapter 7 gives an HTTP Exchange's Delivery, without `exchange`. */
export const requestFields = (
  method: string,
  target: string,
  rawHeaders: readonly string[],
  body: Uint8Array,
): [string, Value][] => {
  const q = target.indexOf('?');
  const path = q < 0 ? target : target.slice(0, q);
  const query = new Map<string, string[]>();
  for (const [k, v] of new URLSearchParams(q < 0 ? '' : target.slice(q + 1))) {
    query.set(k, [...(query.get(k) ?? []), v]);
  }
  const headers = new Map<string, string[]>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), rawHeaders[i + 1]!]);
  }
  return [
    ['method', text(method.toUpperCase())],
    ['path', text(path)],
    [
      'segments',
      listValues(
        path
          .split('/')
          .filter(Boolean)
          .map(part => text(decode(part))),
      ),
    ],
    [
      'query',
      map(
        [...query]
          .sort(([a], [b]) => byCodePoint(a, b))
          .map(([k, vs]) => [
            k,
            vs.length === 1 ? text(vs[0]!) : listValues(vs.map(v => text(v))),
          ]),
      ),
    ],
    [
      'headers',
      map(
        [...headers]
          .sort(([a], [b]) => byCodePoint(a, b))
          .map(([k, vs]) => [
            k,
            k === 'set-cookie'
              ? listValues(vs.map(v => text(v)))
              : text(vs.join(', ')),
          ]),
      ),
    ],
    ['body', bytes(body)],
  ];
};

const plainAnswer = (res: ServerResponse, status: number) => {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return;
  }
  const body = `${status === 404 ? 'Not Found' : status === 413 ? 'Payload Too Large' : status === 503 ? 'Service Unavailable' : 'Internal Server Error'}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const addressKey = (host: string, port: number) => `${host} ${port}`;

const failed = (outcome: string) =>
  outcome === 'unhandled'
    ? 404
    : outcome === 'cancelled' || outcome === 'dropped'
      ? 503
      : 500;

const addressValue = (a: HttpAddress) =>
  map([
    ['host', text(a.host)],
    ['port', num(a.port)],
  ]);

/** Creates the HTTP router. Give `impl` to `httpCapability`, and call `pumped` after each Pump. */
export const createHttpHost = (o: HttpHostOptions = {}): HttpHost => {
  const log = o.log ?? (() => {});
  const maxBody = o.maxBodyBytes ?? HTTP_DEFAULT_MAX_BODY_BYTES;
  const exchangeKind = (o.defineObjectKind ?? defineTsObjectKind)<Exchange>({
    name: 'httpExchange',
    props: {
      closed: {
        get: x => bool(x.native.closed),
        getCost: { fuel: 1 },
        shape: shape.bool,
      },
    },
  });
  const groupIds = new WeakMap<Group, number>();
  let nextGroup = 0;
  let nextExchange = 0;
  const groupId = (g: Group) => {
    let id = groupIds.get(g);
    if (id === undefined) {
      id = ++nextGroup;
      groupIds.set(g, id);
    }
    return id;
  };
  const ownerKeyOf = (g: Group, script: string, grant: string) =>
    JSON.stringify([groupId(g), script, grant]);

  const registrations = new Map<string, Registration>();
  // Listeners by "host port"; a port-0 listener joins once it binds.
  const byAddress = new Map<string, Listener>();
  const listeners = new Set<Listener>();
  // Open exchanges, by Group and delivery id.
  const exchanges = new Map<Group, Map<string, Exchange>>();
  const runs = new Map<Group, Map<string, string>>();
  let stopping = false;
  let open = 0;

  const closeListener = (l: Listener) => {
    if (!listeners.delete(l)) {
      return;
    }
    if (l.address) {
      byAddress.delete(addressKey(l.address.host, l.address.port));
    }
    if (l.server.listening) {
      l.server.close();
      l.server.closeIdleConnections();
    }
  };

  const remove = (r: Registration) => {
    if (registrations.get(r.key) !== r) {
      return;
    }
    registrations.delete(r.key);
    r.listener.registrations.delete(r);
    if (r.listener.registrations.size === 0 && r.listener.address) {
      closeListener(r.listener);
    }
  };

  // Answers an exchange the Script didn't, once.
  const answer = (x: Exchange, status: number) => {
    if (x.answered) {
      return;
    }
    x.answered = true;
    open--;
    plainAnswer(x.res, status);
  };

  // Forgets a settled exchange: its Run has ended, or its work is done.
  const finish = (x: Exchange) => {
    const byDelivery = exchanges.get(x.group);
    if (x.delivery) {
      byDelivery?.delete(x.delivery);
    }
    if (x.run) {
      runs.get(x.group)?.delete(x.run);
    }
    if (x.object) {
      try {
        x.group.dispose(x.object);
      } catch {
        // A discarded Group has nothing left to dispose.
      }
    }
  };

  const settle = (x: Exchange, status: number, why?: string) => {
    if (!x.answered && status === 500 && why !== undefined) {
      log(`http: ${status} for delivery ${x.delivery}: ${why}`);
    }
    answer(x, status);
    finish(x);
  };

  const deliver = (r: Registration, x: Exchange, fields: [string, Value][]) => {
    const { group, script: name } = r.owner;
    const id = `x${++nextExchange}`;
    try {
      x.object = group.object(exchangeKind, id, x);
      const script = group.script(name);
      if (!script) {
        throw new HostError('invalid value', `no Script ${name}`);
      }
      x.delivery = script.deliver({
        name: r.message,
        args: [map([...fields, ['exchange', x.object.value]])],
      });
    } catch (error) {
      if ((error as Error)?.name === 'MailboxFull') {
        answer(x, 503);
      } else {
        log(`http: delivery to ${name} refused: ${String(error)}`);
        remove(r);
        answer(x, 500);
      }
      if (x.object) {
        try {
          group.dispose(x.object);
        } catch {
          // The Group may be gone.
        }
      }
      return;
    }
    let byDelivery = exchanges.get(group);
    if (!byDelivery) {
      byDelivery = new Map();
      exchanges.set(group, byDelivery);
    }
    byDelivery.set(x.delivery, x);
  };

  const match = (l: Listener, path: string): Registration | undefined => {
    let best: Registration | undefined;
    for (const r of l.registrations) {
      if (
        path.startsWith(r.prefix) &&
        (!best || r.prefix.length > best.prefix.length)
      ) {
        best = r;
      }
    }
    return best;
  };

  const handle = (l: Listener, req: IncomingMessage, res: ServerResponse) => {
    if (stopping) {
      res.setHeader('connection', 'close');
      plainAnswer(res, 503);
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBody) {
      res.setHeader('connection', 'close');
      plainAnswer(res, 413);
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        if (!tooLarge) {
          tooLarge = true;
          res.setHeader('connection', 'close');
          plainAnswer(res, 413);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (tooLarge || res.destroyed) {
        return;
      }
      const target = req.url ?? '/';
      const path = target.split('?', 1)[0]!;
      const r = match(l, path);
      if (!r) {
        plainAnswer(res, 404);
        return;
      }
      if (stopping) {
        plainAnswer(res, 503);
        return;
      }
      const x: Exchange = {
        answered: false,
        closed: false,
        group: r.owner.group,
        res,
      };
      open++;
      res.on('close', () => {
        if (!x.answered) {
          x.closed = true;
        }
      });
      deliver(
        r,
        x,
        requestFields(
          req.method ?? 'GET',
          target,
          req.rawHeaders,
          new Uint8Array(Buffer.concat(chunks)),
        ),
      );
    });
  };

  const bind = (l: Listener, port: number) => {
    l.server.on('error', (error: NodeJS.ErrnoException) => {
      if (l.address) {
        log(`http: listener error: ${String(error)}`);
        return;
      }
      const code =
        error.code === 'EADDRINUSE' ? 'address in use' : 'bad address';
      for (const { call, registration } of l.pending) {
        remove(registration);
        call.fail(hostErrorOf(code, `${l.host}:${port}: ${error.message}`));
      }
      l.pending = [];
      for (const r of l.registrations) {
        remove(r);
      }
      listeners.delete(l);
      if (port !== 0) {
        byAddress.delete(addressKey(l.host, port));
      }
    });
    l.server.listen(port, l.host, () => {
      const bound = l.server.address();
      const actual =
        bound && typeof bound === 'object' ? bound.port : (port as number);
      l.address = { host: l.host, port: actual };
      byAddress.set(addressKey(l.host, actual), l);
      for (const { call } of l.pending) {
        call.answer(
          map([
            ['host', text(l.host)],
            ['port', num(actual)],
          ]),
        );
      }
      l.pending = [];
      if (l.registrations.size === 0 || stopping) {
        closeListener(l);
      }
    });
  };

  const serve: HttpServerImpl['serve'] = (
    call,
    name,
    prefix,
    message,
    options,
  ) => {
    const host = options.get('host').asText() ?? o.defaultHost ?? '127.0.0.1';
    const portValue = options.get('port');
    const asked =
      o.portOverride ??
      (portValue.kind === 'nothing'
        ? (o.defaultPort ?? 0)
        : wholeOf(portValue));
    if (
      asked === undefined ||
      asked < 0 ||
      asked > 65_535 ||
      host === '' ||
      stopping ||
      !(o.allow?.(host, asked, call.binding) ?? true)
    ) {
      call.fail(hostErrorOf('bad address', `${host}:${String(asked)}`));
      return;
    }
    const ownerKey = ownerKeyOf(call.group, call.scriptName, call.grantName);
    const key = JSON.stringify([ownerKey, name]);
    const existing = registrations.get(key);
    if (
      existing &&
      existing.prefix === prefix &&
      existing.message === message &&
      existing.asked.host === host &&
      existing.asked.port === asked
    ) {
      if (existing.listener.address) {
        call.answer(addressValue(existing.listener.address));
      } else {
        existing.listener.pending.push({ call, registration: existing });
      }
      return;
    }
    let l = asked === 0 ? undefined : byAddress.get(addressKey(host, asked));
    if (l) {
      for (const r of l.registrations) {
        if (r.prefix === prefix && r.ownerKey !== ownerKey) {
          call.fail(
            hostErrorOf(
              'address in use',
              `${host}:${asked}${prefix} is served by another owner`,
            ),
          );
          return;
        }
      }
    }
    const fresh = !l;
    if (!l) {
      const server = createServer();
      l = { host, pending: [], registrations: new Set(), server };
      const listener = l;
      server.on('request', (req, res) => handle(listener, req, res));
      listeners.add(l);
      if (asked !== 0) {
        byAddress.set(addressKey(host, asked), l);
      }
    }
    const registration: Registration = {
      asked: { host, port: asked },
      key,
      listener: l,
      message,
      name,
      owner: {
        group: call.group,
        script: call.scriptName,
        grant: call.grantName,
      },
      ownerKey,
      prefix,
    };
    l.registrations.add(registration);
    registrations.set(key, registration);
    if (existing) {
      existing.listener.registrations.delete(existing);
      if (
        existing.listener !== l &&
        existing.listener.registrations.size === 0 &&
        existing.listener.address
      ) {
        closeListener(existing.listener);
      }
    }
    if (l.address) {
      call.answer(addressValue(l.address));
    } else {
      l.pending.push({ call, registration });
      if (fresh) {
        bind(l, asked);
      }
    }
  };

  const unserve: HttpServerImpl['unserve'] = (call, name) => {
    const ownerKey = ownerKeyOf(call.group, call.scriptName, call.grantName);
    const r = registrations.get(JSON.stringify([ownerKey, name]));
    if (r) {
      remove(r);
    }
  };

  const respond: HttpServerImpl['respond'] = (call, exchange, response) => {
    const x = (exchange as HostObject<Exchange>).native;
    if (
      exchange.kind.name !== 'httpExchange' ||
      !x ||
      x.group !== call.group ||
      call.delivery === undefined ||
      call.delivery !== x.delivery
    ) {
      throw hostErrorOf('not owner', 'this Run did not receive the exchange');
    }
    if (x.answered) {
      throw hostErrorOf('already responded', 'the exchange is answered');
    }
    if (x.closed || x.res.destroyed) {
      x.closed = true;
      throw hostErrorOf('exchange closed', 'the client has gone');
    }
    const headers: [string, string | string[]][] = [];
    const given = response.get('headers');
    for (const [k, v] of given.kind === 'map' ? given.entries() : []) {
      headers.push([
        k,
        v.kind === 'list'
          ? Array.from({ length: v.length }, (_, i) => v.index(i + 1).asText()!)
          : v.asText()!,
      ]);
    }
    const has = (name: string) =>
      headers.some(([k]) => k.toLowerCase() === name);
    const body = response.get('body');
    const json = response.get('json');
    let payload: Uint8Array = new Uint8Array();
    if (json.kind === 'text') {
      payload = Buffer.from(json.asText()!, 'utf8');
      if (!has('content-type')) {
        headers.push(['content-type', 'application/json']);
      }
    } else if (body.kind === 'text') {
      payload = Buffer.from(body.asText()!, 'utf8');
      if (!has('content-type')) {
        headers.push(['content-type', 'text/plain; charset=utf-8']);
      }
    } else if (body.kind === 'bytes') {
      payload = body.asBytes()!;
    }
    const status = wholeOf(response.get('status')) ?? 200;
    try {
      for (const [k, v] of headers) {
        x.res.setHeader(k, v);
      }
      x.res.statusCode = status;
      x.res.setHeader('content-length', payload.byteLength);
    } catch (error) {
      for (const name of x.res.getHeaderNames()) {
        x.res.removeHeader(name);
      }
      throw new HostError(
        'invalid value',
        `http: unusable response headers: ${String(error)}`,
      );
    }
    x.answered = true;
    open--;
    x.res.end(payload);
  };

  const pumped = (group: Group, result: Pick<PumpResult, 'reports'>) => {
    const byDelivery = exchanges.get(group);
    let byRun = runs.get(group);
    const ofRun = (run: string | undefined) => {
      const d = run === undefined ? undefined : byRun?.get(run);
      return d === undefined ? undefined : byDelivery?.get(d);
    };
    for (const report of result.reports as Report[]) {
      switch (report.kind) {
        case 'stop':
          for (const r of registrations.values()) {
            if (r.owner.group === group && r.owner.script === report.script) {
              remove(r);
            }
          }
          break;
        case 'run started': {
          const x = report.delivery && byDelivery?.get(report.delivery);
          if (x) {
            x.run = report.run;
            if (!byRun) {
              byRun = new Map();
              runs.set(group, byRun);
            }
            byRun.set(report.run, report.delivery!);
          }
          break;
        }
        case 'run end': {
          const x =
            (report.delivery && byDelivery?.get(report.delivery)) ||
            ofRun(report.run);
          if (x && (x.run === undefined || x.run === report.run)) {
            const why =
              report.outcome === 'completed'
                ? 'the Run ended without responding'
                : report.error
                  ? `${report.outcome}: ${report.error.code}: ${report.error.message}`
                  : `${report.outcome}${report.limit ? ` (${report.limit})` : ''}`;
            settle(x, failed(report.outcome), why);
          }
          break;
        }
        case 'unhandled': {
          const x = report.delivery && byDelivery?.get(report.delivery);
          if (x) {
            settle(x, 404);
          }
          break;
        }
        case 'run discarded': {
          const x = ofRun(report.run);
          if (x) {
            settle(x, stopping ? 503 : 500, `run discarded: ${report.reason}`);
          }
          break;
        }
        case 'causal work': {
          const x = byDelivery?.get(report.rootDelivery);
          if (x && report.liveRuns === 0 && report.queuedMessages === 0) {
            settle(x, stopping ? 503 : 500, 'its work ended without a Run');
          }
          break;
        }
        default:
          break;
      }
    }
  };

  const detach = (group: Group) => {
    for (const r of registrations.values()) {
      if (r.owner.group === group) {
        remove(r);
      }
    }
    for (const x of exchanges.get(group)?.values() ?? []) {
      answer(x, 503);
    }
    exchanges.delete(group);
    runs.delete(group);
  };

  const stopAccepting = () => {
    stopping = true;
    for (const l of listeners) {
      if (l.server.listening) {
        l.server.close();
        l.server.closeIdleConnections();
      }
    }
  };

  const answerAll = (status: number) => {
    for (const byDelivery of exchanges.values()) {
      for (const x of byDelivery.values()) {
        answer(x, status);
      }
    }
  };

  const drain = async (ms: number) => {
    const until = Date.now() + ms;
    while (open > 0 && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    answerAll(503);
  };

  const close = async () => {
    stopAccepting();
    answerAll(503);
    const closing = [...listeners].map(
      l =>
        new Promise<void>(resolve => {
          if (!l.server.listening) {
            resolve();
            return;
          }
          l.server.close(() => resolve());
          l.server.closeAllConnections();
        }),
    );
    for (const l of listeners) {
      for (const { call } of l.pending) {
        call.fail(hostErrorOf('bad address', 'the Host is closing'));
      }
      l.pending = [];
    }
    listeners.clear();
    byAddress.clear();
    registrations.clear();
    await Promise.all(closing);
  };

  return {
    impl: o.fetch
      ? { serve, unserve, respond, ...createHttpFetch(o.fetch) }
      : { serve, unserve, respond },
    addresses: () =>
      [...listeners].flatMap(l => (l.address ? [{ ...l.address }] : [])),
    close,
    detach,
    drain,
    onPump: group => result => pumped(group, result),
    get openExchanges() {
      return open;
    },
    pumped,
    get registrations() {
      return registrations.size;
    },
    stopAccepting,
  };
};
