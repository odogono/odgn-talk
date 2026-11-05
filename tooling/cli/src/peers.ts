// The Script Runner's `peer` transport (chapter 12, Runner peers; ADR 0163):
// Remote Sends between Runners over mutual TLS, each end pinned by its key's
// fingerprint, or over plain TCP on loopback, as length-prefixed frames in
// the Value Encoding. The peer router (ADR 0165) carries the frames; this is
// its link.
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
  map,
  nothing,
  text,
  type PeerImpl,
  type TsGroup,
  type Value,
} from '@northtalk/ts';
import {
  PeerRouter,
  type PeerLink,
  type PeerLinkEvents,
} from '@northtalk/ts/peer';

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
  // Positive, with a nonzero first byte, so the DER INTEGER is minimal:
  // a leading 0x00 before a byte under 0x80 is illegal padding.
  serial[0] = (serial[0]! & 0x7f) | 0x40;
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

// ---------------------------------------------------------------- the link

/**
 * One TLS or loopback TCP connection to another Runner, either way round,
 * as a peer router link: 4-byte big-endian lengths before each frame.
 */
class SocketLink implements PeerLink {
  private buffer = Buffer.alloc(0);
  private events: PeerLinkEvents | undefined;
  private readonly held: string[] = [];
  private greeted: ((link: SocketLink | undefined) => void) | undefined;
  closed = false;

  constructor(
    readonly socket: Socket,
    /** The other end's key: checked over TLS, as it claims over plain TCP. */
    public key: string,
    readonly plain: boolean,
    private readonly nameOf: (key: string) => string | undefined,
  ) {
    socket.on('data', chunk => this.read(Buffer.from(chunk)));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }

  // A plain link authenticates nobody, so it vouches for nobody.
  get identity(): Value {
    if (this.plain) {
      return nothing;
    }
    const name = this.nameOf(this.key);
    return map([
      ['key', text(this.key)],
      ...(name === undefined ? [] : [['name', text(name)] as [string, Value]]),
    ]);
  }

  /**
   * A plain connection: each end first says which key it is, with nothing
   * to check it by. Resolves with the link once the other end has said.
   */
  greet(own: string): Promise<SocketLink | undefined> {
    this.send(encodeValue(map([['hello', text(own)]])));
    return new Promise(resolve => {
      this.greeted = resolve;
    });
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
      if (this.plain && !this.key) {
        this.hello(body);
      } else if (this.events) {
        this.events.frame(body);
      } else {
        this.held.push(body);
      }
    }
  }

  // A plain link's first frame says which key the other end is.
  private hello(body: string) {
    let claim: string | undefined;
    try {
      const frame = decodeValue(body);
      const v = frame.kind === 'map' ? frame.get('hello') : undefined;
      claim = v?.kind === 'text' ? v.asText() : undefined;
    } catch {
      claim = undefined;
    }
    if (!claim || !/^[\da-f]{64}$/.test(claim)) {
      return this.close();
    }
    this.key = claim;
    this.greeted?.(this);
    this.greeted = undefined;
  }

  open(events: PeerLinkEvents) {
    this.events = events;
    if (this.closed) {
      return events.close();
    }
    for (const body of this.held.splice(0)) {
      events.frame(body);
    }
  }

  send(frame: string): boolean {
    if (this.closed) {
      return false;
    }
    const body = Buffer.from(frame, 'utf8');
    if (body.length > MAX_FRAME) {
      return false;
    }
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    this.socket.write(Buffer.concat([head, body]));
    return true;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.greeted?.(undefined);
    this.greeted = undefined;
    this.events?.close();
  }
}

// ---------------------------------------------------------------- the Host

/** The Runner's side of `peer`: its key, its listener and its dialling. */
export class RunnerPeers {
  readonly fingerprint: string;
  private readonly tls: Identity;
  private readonly router: PeerRouter;
  private server: Server | undefined;
  private readonly links = new Set<SocketLink>();
  private readonly dialling = new Map<
    string,
    Promise<SocketLink | undefined>
  >();
  private readonly byKey = new Map<string, string>();

  constructor(private readonly o: PeerOptions) {
    this.tls = identity(o.keyFile);
    this.fingerprint = this.tls.fingerprint;
    for (const [name, r] of o.remotes) {
      if (r.fingerprint) {
        this.byKey.set(r.fingerprint, name);
      }
    }
    this.router = new PeerRouter({
      key: this.fingerprint,
      addressOf: key => this.byKey.get(key),
      dial: name =>
        this.o.remotes.has(name) ? this.dial(name) : Promise.resolve(undefined),
    });
  }

  /** The `peerCapability` implementation. */
  get impl(): PeerImpl {
    return this.router.impl;
  }

  /** Whether the Runner listens, which keeps it running. */
  get listening(): boolean {
    return this.server !== undefined;
  }

  /** Starts listening, once the Group exists. */
  async start(group: TsGroup): Promise<void> {
    this.router.bind(group);
    if (this.o.listen || this.o.remotes.size > 0 || this.o.keyFile) {
      this.o.log(`peer: key ${this.fingerprint}`);
    }
    const at = this.o.listen;
    if (!at) {
      return;
    }
    const server = at.plain
      ? createTcpServer(socket => {
          void this.adopt(socket, '', true)
            .greet(this.fingerprint)
            .then(link => link && this.router.connect(link));
        })
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
            this.router.connect(this.adopt(socket, key, false));
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
    for (const link of this.links) {
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

  private adopt(socket: Socket, key: string, plain: boolean): SocketLink {
    const link = new SocketLink(socket, key, plain, k => this.byKey.get(k));
    this.links.add(link);
    socket.once('close', () => this.links.delete(link));
    return link;
  }

  /** A link to the Runner a `--peer` names, dialled the first time. */
  private dial(name: string): Promise<SocketLink | undefined> {
    const remote = this.o.remotes.get(name)!;
    let open: SocketLink | undefined;
    for (const link of this.links) {
      if (
        remote.fingerprint &&
        link.key === remote.fingerprint &&
        !link.closed
      ) {
        open = link;
      }
    }
    if (open) {
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

  private dialPlain(
    name: string,
    remote: Remote,
  ): Promise<SocketLink | undefined> {
    return new Promise<Socket | undefined>(resolve => {
      const socket = connectTcp({ host: remote.host, port: remote.port });
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => resolve(undefined));
    }).then(async socket => {
      const link =
        socket && (await this.adopt(socket, '', true).greet(this.fingerprint));
      if (link) {
        // What it claimed is all a plain link has to go on.
        this.byKey.set(link.key, name);
      }
      return link;
    });
  }

  private dialTls(
    name: string,
    remote: Remote,
  ): Promise<SocketLink | undefined> {
    const key = remote.fingerprint!;
    return new Promise<SocketLink | undefined>(resolve => {
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
}
