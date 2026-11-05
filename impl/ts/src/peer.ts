// The peer router (chapter 9, The peer router; ADR 0165): a Host's
// exposures, Peer ids and Caller Identities, the `reach`, `post` and `call`
// frames of chapter 12, and the `peer` implementation. Links move the frames
// to other Hosts; the router knows nothing of sockets, ports or TLS.
// Web-standard APIs only, so it runs in a browser, a worker, Bun and Node.
import { decodeValue } from './readers';
import { encodeValue } from './encoding';
import type { Call } from './capabilities';
import type { HostObject } from './objects';
import { ScriptError } from './errors';
import { peerKind, type PeerImpl } from './peer-capability';
import type { TsGroup } from './group';
import { list, map, nothing, num, text, type Value } from './values';

/**
 * What a link tells the router: each whole frame it receives, its close, and
 * when it has learned the other Host's key, for a link that starts without it.
 */
export type PeerLinkEvents = {
  close(): void;
  frame(text: string): void;
  keyed(): void;
};

/**
 * One connection to another Host. It moves whole frames, each the Value
 * Encoding's JSON text, and says who the other Host is. A link hands the
 * router frames only once `open` gives it somewhere to put them.
 */
export type PeerLink = {
  /** The address `reach` names this link by, such as a port's name. */
  readonly address?: string;
  close(): void;
  /** Whether the link has closed: it sends nothing more. */
  readonly closed: boolean;
  /**
   * The Caller Identity data for what arrives on this link: what this Host
   * vouches for about the other one, or Nothing when it vouches for nobody.
   */
  readonly identity: Value;
  /**
   * The other Host's key fingerprint, or empty until the link learns it and
   * calls `keyed`. It hands the router no frame before then.
   */
  readonly key: string;
  /** Starts the link; `own` is this Host's key, for a link that sends it. */
  open(events: PeerLinkEvents, own: string): void;
  /** Sends one frame; false when it can't, as when closed or too large. */
  send(frame: string): boolean;
};

export type PeerRouterOptions = {
  /** For a Peer naming a key with no open link: the address that dials it. */
  addressOf?: (key: string) => string | undefined;
  /** A link to the Host an address names, for `reach`; undefined when none. */
  dial?: (address: string) => Promise<PeerLink | undefined>;
  /** This Host's key fingerprint. */
  key: string;
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** A key fingerprint: lowercase hex SHA-256 of the DER SubjectPublicKeyInfo. */
export const fingerprintOf = async (spki: BufferSource): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)));

/** A new ECDSA P-256 Host key and its fingerprint. */
export const newHostKey = async (): Promise<{
  fingerprint: string;
  keys: CryptoKeyPair;
}> => {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
  return { fingerprint: await fingerprintOf(spki), keys };
};

const secret = () => hex(crypto.getRandomValues(new Uint8Array(16)));

const field = (frame: Value, key: string): Value | undefined => {
  const v = frame.kind === 'map' ? frame.get(key) : undefined;
  return v && v.kind !== 'nothing' ? v : undefined;
};
const has = (frame: Value, key: string): boolean =>
  frame.kind === 'map' && frame.entries().some(([k]) => k === key);
const whole = (v: Value | undefined): number | undefined => {
  const n =
    v?.kind === 'number' ? Number(v.asDecimal()!.toString()) : Number.NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};
const items = (v: Value | undefined): Value[] =>
  v?.kind === 'list'
    ? Array.from({ length: v.length }, (_, i) => v.index(i + 1))
    : [];

const failure = (code: string, data: [string, Value][] = []) =>
  new ScriptError(code, code, map(data));
const sendFailed = (reason: string, error?: Value) =>
  failure('send failed', [
    ['reason', text(reason)],
    ...(error ? [['error', error] as [string, Value]] : []),
  ]);

const split = (id: string): [string, string] | undefined => {
  const m = /^([\da-f]{64})\/([\da-f]{32})$/.exec(id);
  return m ? [m[1]!, m[2]!] : undefined;
};

/** A link the router has opened, with the questions it waits on. */
class Wire {
  private next = 1;
  private readonly asked = new Map<number, (frame: Value | null) => void>();

  constructor(readonly link: PeerLink) {}

  send(frame: Value): boolean {
    let body: string;
    try {
      body = encodeValue(frame);
    } catch {
      return false;
    }
    return !this.link.closed && this.link.send(body);
  }

  /** Sends a question; `answer` hears its answer, or null when the link closes. */
  ask(
    kind: string,
    rest: [string, Value][],
    answer: (frame: Value | null) => void,
  ) {
    const n = this.next++;
    this.asked.set(n, answer);
    if (!this.send(map([[kind, num(n)], ...rest]))) {
      this.asked.delete(n);
      answer(null);
    }
  }

  answered(n: number, frame: Value) {
    const answer = this.asked.get(n);
    this.asked.delete(n);
    answer?.(frame);
  }

  closed() {
    const waiting = [...this.asked.values()];
    this.asked.clear();
    for (const answer of waiting) {
      answer(null);
    }
  }
}

type Exposure = { name?: string; script: string };

/** A Host's side of `peer`: its exposures and the links to other Hosts. */
export class PeerRouter {
  readonly key: string;
  private group: TsGroup | undefined;
  private readonly exposures = new Map<string, Exposure>();
  private readonly names = new Map<string, string>();
  private readonly peers = new Map<string, HostObject>();
  private readonly wires = new Map<PeerLink, Wire>();
  private readonly byKey = new Map<string, Wire>();
  private readonly callers = new Map<string, Value>();

  constructor(private readonly o: PeerRouterOptions) {
    this.key = o.key;
  }

  /** A router for the Group, with a new Host key unless the options give one. */
  static async create(
    group: TsGroup,
    options: Partial<PeerRouterOptions> = {},
  ): Promise<PeerRouter> {
    const key = options.key ?? (await newHostKey()).fingerprint;
    const router = new PeerRouter({ ...options, key });
    router.bind(group);
    return router;
  }

  /** Gives the router its Group, whose Scripts its exposures name. */
  bind(group: TsGroup): void {
    this.group = group;
  }

  /** Carries Remote Sends over a link. The newest link to a key carries what this Host sends there. */
  connect(link: PeerLink): void {
    if (this.wires.has(link)) {
      return;
    }
    const wire = new Wire(link);
    this.wires.set(link, wire);
    if (link.key) {
      this.byKey.set(link.key, wire);
    }
    link.open(
      {
        keyed: () => {
          if (this.wires.get(link) === wire) {
            this.byKey.set(link.key, wire);
          }
        },
        frame: body => {
          let frame: Value;
          try {
            frame = decodeValue(body, (kind, id) =>
              kind === 'peer' ? this.peerFor(id) : undefined,
            );
          } catch {
            return link.close();
          }
          this.arrive(wire, frame);
        },
        close: () => {
          this.wires.delete(link);
          if (this.byKey.get(link.key) === wire) {
            this.byKey.delete(link.key);
          }
          wire.closed();
        },
      },
      this.key,
    );
  }

  /** Closes every link. */
  close(): void {
    for (const link of this.wires.keys()) {
      link.close();
    }
  }

  private async wireFor(
    link: Promise<PeerLink | undefined>,
  ): Promise<Wire | undefined> {
    const got = await link;
    if (!got || got.closed) {
      return undefined;
    }
    this.connect(got);
    return this.wires.get(got);
  }

  /** A link to the Host with this key, dialled if the Host knows its address. */
  private wireTo(key: string): Promise<Wire | undefined> {
    const open = this.byKey.get(key);
    if (open && !open.link.closed) {
      return Promise.resolve(open);
    }
    const address = this.o.addressOf?.(key);
    return address === undefined || !this.o.dial
      ? Promise.resolve(undefined)
      : this.wireFor(this.o.dial(address));
  }

  /** This Group's one Peer for an exposure id. */
  private peerFor(id: string): Value {
    let peer = this.peers.get(id);
    if (!peer) {
      peer = this.group!.object(peerKind, id, null);
      this.peers.set(id, peer);
    }
    return peer.value;
  }

  // A Remote Send arriving here: a Delivery or Request to the exposure's
  // Script, vouched for as the link says.
  private local(
    identity: Value,
    secret: string,
    message: string,
    args: Value[],
    waits: boolean,
  ): Promise<Value> | 'not exposed' | 'mailbox full' | undefined {
    const held = this.exposures.get(secret);
    const script = held && this.group!.script(held.script);
    if (!script) {
      return waits ? 'not exposed' : undefined;
    }
    try {
      if (!waits) {
        this.callers.set(script.deliver({ name: message, args }), identity);
        return undefined;
      }
      const requested = script.request({ name: message, args });
      this.callers.set(requested.id, identity);
      return requested.result;
    } catch (error) {
      if ((error as Error).name === 'MailboxFull') {
        return waits ? 'mailbox full' : undefined;
      }
      throw error;
    }
  }

  private arrive(wire: Wire, frame: Value) {
    const reach = whole(field(frame, 'reach'));
    const call = whole(field(frame, 'call'));
    const post = field(frame, 'post')?.asText();
    const answer = whole(field(frame, 'reached') ?? field(frame, 'replied'));
    if (answer !== undefined) {
      return wire.answered(answer, frame);
    }
    if (reach !== undefined) {
      const key = this.names.get(field(frame, 'name')?.asText() ?? '');
      return void wire.send(
        map([
          ['reached', num(reach)],
          key === undefined
            ? ['error', text('not exposed')]
            : ['peer', text(`${this.key}/${key}`)],
        ]),
      );
    }
    const to = post ?? field(frame, 'to')?.asText() ?? '';
    const parts = split(to);
    const message = field(frame, 'message')?.asText() ?? '';
    const args = items(field(frame, 'args'));
    const mine = parts && parts[0] === this.key ? parts[1] : undefined;
    const identity = wire.link.identity;
    if (post !== undefined) {
      if (mine) {
        this.local(identity, mine, message, args, false);
      }
      return;
    }
    if (call === undefined) {
      return;
    }
    const reply = (rest: [string, Value]) =>
      wire.send(map([['replied', num(call)], rest]));
    const failed = (reason: string, error?: Value) =>
      reply([
        'failed',
        map([
          ['reason', text(reason)],
          ...(error ? [['error', error] as [string, Value]] : []),
        ]),
      ]);
    const result = mine
      ? this.local(identity, mine, message, args, true)
      : 'not exposed';
    if (typeof result === 'string' || result === undefined) {
      return void failed(result ?? 'not exposed');
    }
    result
      .then(
        value => {
          // A reply that can't be encoded, as one holding a Function
          // Value, can't come back.
          if (!reply(['value', value])) {
            failed('unreachable');
          }
        },
        (error: unknown) => {
          const e = error as Partial<ScriptError>;
          if (e.name === 'ScriptError' && e.code === 'send failed') {
            const data = e.data;
            failed(
              data?.get('reason').asText() ?? 'errored',
              data?.kind === 'map' && data.get('error').kind !== 'nothing'
                ? data.get('error')
                : undefined,
            );
          } else {
            failed('unreachable');
          }
        },
      )
      .catch(() => failed('unreachable'));
  }

  /** The `peerCapability` implementation. */
  readonly impl: PeerImpl = {
    expose: (call, name) => this.expose(call, name),
    unexpose: (call, exposure) => {
      const key =
        typeof exposure === 'string'
          ? this.names.get(exposure)
          : split(exposure.id)?.[1];
      const held = key === undefined ? undefined : this.exposures.get(key);
      if (held && held.script === call.scriptName) {
        this.exposures.delete(key!);
        if (held.name !== undefined) {
          this.names.delete(held.name);
        }
      }
    },
    reach: (call, address) => this.reach(call, address),
    post: (call, peer, message, args) =>
      this.send(call, peer, message, args, false),
    call: (call, peer, message, args) =>
      this.send(call, peer, message, args, true),
    caller: call =>
      (call.delivery === undefined
        ? undefined
        : this.callers.get(call.delivery)) ?? nothing,
  };

  private expose(call: Call<unknown>, name?: string) {
    if (name !== undefined && this.names.has(name)) {
      const key = this.names.get(name)!;
      if (this.exposures.get(key)!.script !== call.scriptName) {
        return call.fail(failure('name in use'));
      }
      return call.answer(this.peerFor(`${this.key}/${key}`));
    }
    const key = secret();
    this.exposures.set(key, { name, script: call.scriptName });
    if (name !== undefined) {
      this.names.set(name, key);
    }
    call.answer(this.peerFor(`${this.key}/${key}`));
  }

  private reach(call: Call<unknown>, address: string) {
    let named: PeerLink | undefined;
    for (const link of this.wires.keys()) {
      if (link.address === address && !link.closed) {
        named = link;
      }
    }
    const dialled = named ? Promise.resolve(named) : this.o.dial?.(address);
    if (!dialled) {
      return call.fail(failure('bad address'));
    }
    void this.wireFor(dialled).then(wire => {
      if (!wire) {
        return call.fail(failure('bad address'));
      }
      wire.ask('reach', [['name', text(address)]], frame => {
        const id = frame && field(frame, 'peer')?.asText();
        if (id && wire.link.key && split(id)?.[0] === wire.link.key) {
          call.answer(this.peerFor(id));
        } else {
          call.fail(failure(frame ? 'not exposed' : 'bad address'));
        }
      });
    });
  }

  private send(
    call: Call<unknown>,
    peer: HostObject,
    message: string,
    args: Value[],
    waits: boolean,
  ) {
    const parts = split(peer.id);
    if (!parts) {
      return waits ? call.fail(sendFailed('unreachable')) : undefined;
    }
    const [key, secret] = parts;
    if (key === this.key) {
      // A Peer of this Host's own exposure: still a Remote Send.
      const identity = map([['key', text(key)]]);
      const result = this.local(identity, secret, message, args, waits);
      if (!waits) {
        return;
      }
      if (typeof result === 'string' || result === undefined) {
        return call.fail(sendFailed(result ?? 'not exposed'));
      }
      return void result.then(
        value => call.answer(value),
        (error: unknown) => {
          const e = error as Partial<ScriptError>;
          call.fail(
            e.name === 'ScriptError' && e.code === 'send failed'
              ? failure(
                  'send failed',
                  e.data?.kind === 'map' ? [...e.data.entries()] : [],
                )
              : sendFailed('unreachable'),
          );
        },
      );
    }
    void this.wireTo(key).then(wire => {
      const rest: [string, Value][] = [
        ['message', text(message)],
        ['args', list(...args)],
      ];
      if (!waits) {
        wire?.send(map([['post', text(peer.id)], ...rest]));
        return;
      }
      if (!wire) {
        return call.fail(sendFailed('unreachable'));
      }
      wire.ask('call', [['to', text(peer.id)], ...rest], frame => {
        const failed = frame && field(frame, 'failed');
        if (frame && has(frame, 'value')) {
          call.answer(frame.get('value'));
        } else if (failed) {
          const reason = failed.get('reason').asText() ?? 'unreachable';
          const error = failed.get('error');
          call.fail(
            sendFailed(reason, error.kind === 'nothing' ? undefined : error),
          );
        } else {
          call.fail(sendFailed('unreachable'));
        }
      });
    });
  }
}

export {
  messagePortLink,
  type MessagePortLinkOptions,
  type PortEndpoint,
} from './peer-message-port';
