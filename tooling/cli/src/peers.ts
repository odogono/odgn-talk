// The Script Runner's `peer` transport (chapter 12, Runner peers; ADR 0163):
// Remote Sends between Runners over mutual TLS, each end pinned by its key's
// fingerprint, or over plain TCP on loopback, as length-prefixed frames in
// the Value Encoding.
// Runtime-neutral: node:* APIs only.
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Server,
  type Socket,
} from 'node:net';
import { connect, createServer, type TLSSocket } from 'node:tls';
import {
  decodeValue,
  encodeValue,
  list,
  map,
  nothing,
  num,
  peerKind,
  ScriptError,
  text,
  type Call,
  type HostObject,
  type PeerImpl,
  type TsGroup,
  type Value,
} from '@northtalk/ts';

/** The largest frame a Runner sends or reads. */
const MAX_FRAME = 16 * 1024 * 1024;

export type PeerOptions = {
  /** `--peer-key`: a PEM file with an ECDSA P-256 key and its certificate. */
  keyFile?: string;
  /** `--listen [tls://|tcp://]HOST:PORT`. */
  listen?: Address;
  log: (line: string) => void;
  /** `--peer NAME=tls://HOST:PORT#FINGERPRINT` or `NAME=tcp://HOST:PORT`. */
  remotes: ReadonlyMap<string, Remote>;
};

/** Where a Runner listens or dials: `plain` is TCP without TLS. */
export type Address = { host: string; plain: boolean; port: number };
/** A `--peer`: plain ones pin no key. */
export type Remote = Address & { fingerprint?: string };

// Plain TCP carries no key to check, so it stays on this machine.
const loopback = new Set(['127.0.0.1', '::1', 'localhost']);

const address = (scheme: string | undefined, host: string, port: string) => {
  const bare = host.replace(/^\[(.*)]$/, '$1');
  const plain = scheme === 'tcp';
  if (plain && !loopback.has(bare)) {
    throw new Error(`tcp:// is only for loopback, not ${host}`);
  }
  return { host: bare, plain, port: Number(port) };
};

/** Reads one `--peer` value. */
export const parsePeerFlag = (given: string): [string, Remote] => {
  const tls = /^([^=]+)=tls:\/\/(.+):(\d+)#([\da-f]{64})$/.exec(given);
  if (tls) {
    return [
      tls[1]!,
      { ...address('tls', tls[2]!, tls[3]!), fingerprint: tls[4]! },
    ];
  }
  const tcp = /^([^=]+)=tcp:\/\/(.+):(\d+)$/.exec(given);
  if (tcp) {
    return [tcp[1]!, address('tcp', tcp[2]!, tcp[3]!)];
  }
  throw new Error(
    `--peer wants NAME=tls://HOST:PORT#FINGERPRINT or NAME=tcp://HOST:PORT: ${given}`,
  );
};

/** Reads `--listen`: `HOST:PORT` or `tls://HOST:PORT` for TLS, `tcp://HOST:PORT` for plain. */
export const parseListen = (given: string): Address => {
  const m = /^(?:(tls|tcp):\/\/)?(.+):(\d+)$/.exec(given);
  if (!m) {
    throw new Error(`--listen wants [tls://|tcp://]HOST:PORT: ${given}`);
  }
  return address(m[1], m[2]!, m[3]!);
};

// ---------------------------------------------------------------- keys

type Identity = { cert: string; fingerprint: string; key: string };

const der = (tag: number, body: Uint8Array): Uint8Array => {
  const length =
    body.length < 0x80
      ? [body.length]
      : (() => {
          const bytes: number[] = [];
          for (let n = body.length; n > 0; n >>= 8) {
            bytes.unshift(n & 0xff);
          }
          return [0x80 | bytes.length, ...bytes];
        })();
  return Uint8Array.from([tag, ...length, ...body]);
};
const seq = (...parts: Uint8Array[]) => der(0x30, concat(parts));
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const ascii = (s: string) => new TextEncoder().encode(s);
// ecdsa-with-SHA256, 1.2.840.10045.4.3.2: every TLS 1.3 stack takes P-256.
const ECDSA_SHA256 = seq(
  der(0x06, Uint8Array.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])),
);
// CN=northtalk: the certificate only carries the key.
const NAME = seq(
  der(
    0x31,
    seq(
      der(0x06, Uint8Array.from([0x55, 0x04, 0x03])),
      der(0x0c, ascii('northtalk')),
    ),
  ),
);

// A self-signed certificate for the key, with no meaning beyond carrying it.
const certificate = (privateKey: KeyObject, publicKey: KeyObject): string => {
  const spki = new Uint8Array(
    publicKey.export({ format: 'der', type: 'spki' }),
  );
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const tbs = seq(
    der(0xa0, der(0x02, Uint8Array.of(2))),
    der(0x02, serial),
    ECDSA_SHA256,
    NAME,
    seq(der(0x17, ascii('250101000000Z')), der(0x18, ascii('99991231235959Z'))),
    NAME,
    spki,
  );
  const signature = new Uint8Array(sign('sha256', tbs, privateKey));
  const cert = seq(
    tbs,
    ECDSA_SHA256,
    der(0x03, concat([Uint8Array.of(0), signature])),
  );
  const body = Buffer.from(cert)
    .toString('base64')
    .replaceAll(/.{64}/g, '$&\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
};

/** A new key and its certificate, as the PEM `--peer-key` reads. */
export const newPeerKey = (): string => {
  const made = identity();
  return made.key + made.cert;
};

/** The key fingerprint: lowercase hex SHA-256 of the DER SubjectPublicKeyInfo. */
export const fingerprintOf = (cert: X509Certificate | string): string => {
  const x509 = typeof cert === 'string' ? new X509Certificate(cert) : cert;
  return createHash('sha256')
    .update(x509.publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex');
};

const identity = (keyFile?: string): Identity => {
  if (keyFile) {
    const pem = readFileSync(keyFile, 'utf8');
    const cert =
      /-{5}BEGIN CERTIFICATE-{5}[\S\s]+?-{5}END CERTIFICATE-{5}/.exec(pem)?.[0];
    if (!cert) {
      throw new Error(`${keyFile} has no certificate`);
    }
    const key = createPrivateKey(pem)
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    return { cert: `${cert}\n`, fingerprint: fingerprintOf(cert), key };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const cert = certificate(privateKey, publicKey);
  return {
    cert,
    fingerprint: fingerprintOf(cert),
    key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
};

// ---------------------------------------------------------------- frames

/** One connection to another Runner, either way round. */
class Link {
  private buffer = Buffer.alloc(0);
  private next = 1;
  private readonly asked = new Map<number, (frame: Value | null) => void>();
  closed = false;

  constructor(
    readonly socket: Socket,
    /** The other end's key: checked over TLS, as it claims over plain TCP. */
    public fingerprint: string,
    readonly plain: boolean,
    private readonly decode: (text: string) => Value,
    private readonly onFrame: (link: Link, frame: Value) => void,
    private readonly onClose: (link: Link) => void,
  ) {
    socket.on('data', chunk => this.read(Buffer.from(chunk)));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME) {
        return this.socket.destroy();
      }
      if (this.buffer.length < 4 + length) {
        return;
      }
      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      let frame: Value;
      try {
        frame = this.decode(body);
      } catch {
        return this.socket.destroy();
      }
      this.onFrame(this, frame);
    }
  }

  send(frame: Value): boolean {
    if (this.closed) {
      return false;
    }
    const body = Buffer.from(encodeValue(frame), 'utf8');
    if (body.length > MAX_FRAME) {
      return false;
    }
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    this.socket.write(Buffer.concat([head, body]));
    return true;
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

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    for (const answer of this.asked.values()) {
      answer(null);
    }
    this.asked.clear();
    this.onClose(this);
  }
}

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

// ---------------------------------------------------------------- the Host

type Exposure = { name?: string; script: string };

/** The Runner's side of `peer`: its exposures, its links and its key. */
export class RunnerPeers {
  readonly fingerprint: string;
  private readonly tls: Identity;
  private group!: TsGroup;
  private server: Server | undefined;
  private readonly exposures = new Map<string, Exposure>();
  private readonly names = new Map<string, string>();
  private readonly peers = new Map<string, HostObject>();
  private readonly links = new Map<string, Link>();
  private readonly dialling = new Map<string, Promise<Link | undefined>>();
  private readonly callers = new Map<string, Value>();
  private readonly byKey = new Map<string, string>();

  constructor(private readonly o: PeerOptions) {
    this.tls = identity(o.keyFile);
    this.fingerprint = this.tls.fingerprint;
    for (const [name, r] of o.remotes) {
      if (r.fingerprint) {
        this.byKey.set(r.fingerprint, name);
      }
    }
  }

  /** Whether the Runner listens, which keeps it running. */
  get listening(): boolean {
    return this.server !== undefined;
  }

  /** Starts listening, once the Group exists. */
  async start(group: TsGroup): Promise<void> {
    this.group = group;
    if (this.o.listen || this.o.remotes.size > 0 || this.o.keyFile) {
      this.o.log(`peer: key ${this.fingerprint}`);
    }
    const at = this.o.listen;
    if (!at) {
      return;
    }
    const server = at.plain
      ? createTcpServer(socket => void this.greet(socket))
      : createServer(
          {
            cert: this.tls.cert,
            key: this.tls.key,
            minVersion: 'TLSv1.3',
            rejectUnauthorized: false,
            requestCert: true,
          },
          socket => {
            const key = this.peerKey(socket);
            if (!key) {
              return socket.destroy();
            }
            this.adopt(socket, key, false);
          },
        );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(at.port, at.host, () => resolve());
    });
    this.server = server;
    const address = server.address();
    const port =
      typeof address === 'object' && address ? address.port : at.port;
    const host = at.host.includes(':') ? `[${at.host}]` : at.host;
    this.o.log(
      at.plain
        ? `peer: listening on tcp://${host}:${port}`
        : `peer: listening on tls://${host}:${port}#${this.fingerprint}`,
    );
  }

  /** Stops accepting connections. */
  stopListening(): void {
    this.server?.close();
    this.server = undefined;
  }

  /** Closes every link. */
  close(): void {
    this.stopListening();
    for (const link of this.links.values()) {
      link.close();
    }
  }

  private peerKey(socket: TLSSocket): string | undefined {
    const raw = socket.getPeerCertificate(true)?.raw;
    if (!raw) {
      return undefined;
    }
    try {
      return fingerprintOf(new X509Certificate(raw));
    } catch {
      return undefined;
    }
  }

  private adopt(socket: Socket, key: string, plain: boolean): Link {
    const link = new Link(
      socket,
      key,
      plain,
      body =>
        decodeValue(body, (kind, id) =>
          kind === 'peer' ? this.peerFor(id) : undefined,
        ),
      (l, frame) => this.arrive(l, frame),
      l => {
        if (this.links.get(l.fingerprint) === l) {
          this.links.delete(l.fingerprint);
        }
      },
    );
    // The newest link to a key carries what this Runner sends there.
    if (key) {
      this.links.set(key, link);
    }
    return link;
  }

  /**
   * A plain connection: each end first says which key it is, with nothing
   * to check it by. Resolves with the link once the other end has said.
   */
  private greet(socket: Socket): Promise<Link | undefined> {
    const link = this.adopt(socket, '', true);
    link.send(map([['hello', text(this.fingerprint)]]));
    return new Promise(resolve => {
      this.greeting.set(link, resolve);
      socket.once('close', () => resolve(undefined));
    });
  }
  private readonly greeting = new Map<Link, (link: Link) => void>();

  /** A link to the Host with this key, dialled if a `--peer` gives it. */
  private linkTo(key: string): Promise<Link | undefined> {
    const open = this.links.get(key);
    if (open && !open.closed) {
      return Promise.resolve(open);
    }
    const name = this.byKey.get(key);
    return name === undefined ? Promise.resolve(undefined) : this.dial(name);
  }

  /** A link to the Runner a `--peer` names, dialled the first time. */
  private dial(name: string): Promise<Link | undefined> {
    const remote = this.o.remotes.get(name)!;
    const open = remote.fingerprint && this.links.get(remote.fingerprint);
    if (open && !open.closed) {
      return Promise.resolve(open);
    }
    let dialled = this.dialling.get(name);
    if (!dialled) {
      dialled = (
        remote.plain ? this.dialPlain(name, remote) : this.dialTls(name, remote)
      ).finally(() => this.dialling.delete(name));
      this.dialling.set(name, dialled);
    }
    return dialled;
  }

  private dialPlain(name: string, remote: Remote): Promise<Link | undefined> {
    return new Promise<Socket | undefined>(resolve => {
      const socket = connectTcp({ host: remote.host, port: remote.port });
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => resolve(undefined));
    }).then(async socket => {
      const link = socket && (await this.greet(socket));
      if (link) {
        // What it claimed is all a plain link has to go on.
        this.byKey.set(link.fingerprint, name);
      }
      return link;
    });
  }

  private dialTls(name: string, remote: Remote): Promise<Link | undefined> {
    const key = remote.fingerprint!;
    return new Promise<Link | undefined>(resolve => {
      const socket = connect({
        cert: this.tls.cert,
        host: remote.host,
        key: this.tls.key,
        minVersion: 'TLSv1.3',
        port: remote.port,
        rejectUnauthorized: false,
        servername: undefined,
      });
      socket.once('secureConnect', () => {
        if (this.peerKey(socket) !== key) {
          this.o.log(`peer: ${name} has the wrong key`);
          socket.destroy();
          return resolve(undefined);
        }
        resolve(this.adopt(socket, key, false));
      });
      socket.once('error', error => {
        this.o.log(`peer: ${name}: ${error.message}`);
        resolve(undefined);
      });
    });
  }

  /** This Group's one Peer for an exposure id. */
  private peerFor(id: string): Value {
    let peer = this.peers.get(id);
    if (!peer) {
      peer = this.group.object(peerKind, id, null);
      this.peers.set(id, peer);
    }
    return peer.value;
  }

  private split(id: string): [string, string] | undefined {
    const m = /^([\da-f]{64})\/([\da-f]{32})$/.exec(id);
    return m ? [m[1]!, m[2]!] : undefined;
  }

  // A plain link authenticates nobody, so it vouches for nobody.
  private identityOf(link: Link | undefined, key: string): Value {
    if (link?.plain) {
      return nothing;
    }
    const name = this.byKey.get(key);
    return map([
      ['key', text(key)],
      ...(name === undefined ? [] : [['name', text(name)] as [string, Value]]),
    ]);
  }

  // A Remote Send arriving here: a Delivery or Request to the exposure's
  // Script, vouched for as the sending Runner's key.
  private local(
    link: Link | undefined,
    key: string,
    secret: string,
    message: string,
    args: Value[],
    waits: boolean,
  ): Promise<Value> | 'not exposed' | 'mailbox full' | undefined {
    const held = this.exposures.get(secret);
    const script = held && this.group.script(held.script);
    if (!script) {
      return waits ? 'not exposed' : undefined;
    }
    try {
      if (!waits) {
        this.callers.set(
          script.deliver({ name: message, args }),
          this.identityOf(link, key),
        );
        return undefined;
      }
      const requested = script.request({ name: message, args });
      this.callers.set(requested.id, this.identityOf(link, key));
      return requested.result;
    } catch (error) {
      if ((error as Error).name === 'MailboxFull') {
        return waits ? 'mailbox full' : undefined;
      }
      throw error;
    }
  }

  private arrive(link: Link, frame: Value) {
    const hello = field(frame, 'hello')?.asText();
    if (link.plain && !link.fingerprint) {
      // A plain link's first frame says which key the other end is.
      if (!hello || !/^[\da-f]{64}$/.test(hello)) {
        return link.close();
      }
      link.fingerprint = hello;
      this.links.set(hello, link);
      this.greeting.get(link)?.(link);
      this.greeting.delete(link);
      return;
    }
    const reach = whole(field(frame, 'reach'));
    const call = whole(field(frame, 'call'));
    const post = field(frame, 'post')?.asText();
    const answer = whole(field(frame, 'reached') ?? field(frame, 'replied'));
    if (answer !== undefined) {
      return link.answered(answer, frame);
    }
    if (reach !== undefined) {
      const key = this.names.get(field(frame, 'name')?.asText() ?? '');
      return void link.send(
        map([
          ['reached', num(reach)],
          key === undefined
            ? ['error', text('not exposed')]
            : ['peer', text(`${this.fingerprint}/${key}`)],
        ]),
      );
    }
    const to = post ?? field(frame, 'to')?.asText() ?? '';
    const parts = this.split(to);
    const message = field(frame, 'message')?.asText() ?? '';
    const args = items(field(frame, 'args'));
    const mine = parts && parts[0] === this.fingerprint ? parts[1] : undefined;
    if (post !== undefined) {
      if (mine) {
        this.local(link, link.fingerprint, mine, message, args, false);
      }
      return;
    }
    if (call === undefined) {
      return;
    }
    const reply = (rest: [string, Value]) =>
      link.send(map([['replied', num(call)], rest]));
    const failed = (reason: string, error?: Value) =>
      reply([
        'failed',
        map([
          ['reason', text(reason)],
          ...(error ? [['error', error] as [string, Value]] : []),
        ]),
      ]);
    const result = mine
      ? this.local(link, link.fingerprint, mine, message, args, true)
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
          : this.split(exposure.id)?.[1];
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
      return call.answer(this.peerFor(`${this.fingerprint}/${key}`));
    }
    const key = randomBytes(16).toString('hex');
    this.exposures.set(key, { name, script: call.scriptName });
    if (name !== undefined) {
      this.names.set(name, key);
    }
    call.answer(this.peerFor(`${this.fingerprint}/${key}`));
  }

  private reach(call: Call<unknown>, address: string) {
    const remote = this.o.remotes.get(address);
    if (!remote) {
      return call.fail(failure('bad address'));
    }
    void this.dial(address).then(link => {
      if (!link) {
        return call.fail(failure('bad address'));
      }
      link.ask('reach', [['name', text(address)]], frame => {
        const id = frame && field(frame, 'peer')?.asText();
        if (id && this.split(id)?.[0] === link.fingerprint) {
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
    const parts = this.split(peer.id);
    if (!parts) {
      return waits ? call.fail(sendFailed('unreachable')) : undefined;
    }
    const [key, secret] = parts;
    if (key === this.fingerprint) {
      // A Peer of this Runner's own exposure: still a Remote Send.
      const result = this.local(undefined, key, secret, message, args, waits);
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
    void this.linkTo(key).then(link => {
      const rest: [string, Value][] = [
        ['message', text(message)],
        ['args', list(...args)],
      ];
      if (!waits) {
        link?.send(map([['post', text(peer.id)], ...rest]));
        return;
      }
      if (!link) {
        return call.fail(sendFailed('unreachable'));
      }
      link.ask('call', [['to', text(peer.id)], ...rest], frame => {
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
