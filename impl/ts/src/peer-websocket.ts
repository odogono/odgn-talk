// A peer router link over a WebSocket (ADR 0165): one text message per
// frame. Before any frame, each end proves its key. Its first message is
// `{"hello": fingerprint, "key": base64 SPKI, "nonce": 32 hex digits}`, the
// browser's with `"token"` too, and its second `{"proof": base64 signature}`,
// its key's ECDSA P-256 SHA-256 signature over the UTF-8 text
// `northtalk peer ws`, then the other end's nonce, then its own fingerprint.
// Web-standard APIs only, so it runs on any WHATWG `WebSocket`.
import { fromBase64, toBase64 } from './base64';
import {
  fingerprintOf,
  type HostSigner,
  type PeerLink,
  type PeerLinkEvents,
} from './peer';
import { map, text, type Value } from './values';

/** What the link needs of a WHATWG `WebSocket`, or of a server's socket adapted to one. */
export type WebSocketEndpoint = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(code?: number, reason?: string): void;
  /** 0 while connecting, 1 when open, 2 closing, 3 closed. */
  readonly readyState: number;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  send(data: string): void;
  /** The address dialled, whose origin joins the Caller Identity. */
  readonly url?: string;
};

export type WebSocketLinkOptions = {
  /** The name `reach` finds this link by, as for a MessagePort link. */
  name?: string;
  /**
   * The server's key fingerprint, checked against the key it proves. An
   * address `wss://HOST/PATH#FINGERPRINT` pins it too.
   */
  pin?: string;
  /** Sent in the `hello` for the server's `authenticate`. */
  token?: string;
};

/** Caller Identity data, merged into `{key, via: "ws"}`. */
export type WebSocketCaller = Readonly<Record<string, Value | string>>;

export type AcceptWebSocketOptions = {
  /**
   * Checks the `hello`'s token, undefined when it has none: the data it gives
   * joins the Caller Identity, and undefined or a throw refuses the
   * connection, which closes before any Remote Send.
   */
  authenticate?: (
    token: string | undefined,
  ) => WebSocketCaller | undefined | Promise<WebSocketCaller | undefined>;
  /** The name `reach` finds this link by. */
  name?: string;
};

/** The largest frame a link sends or reads, in UTF-8 bytes. */
const MAX_FRAME = 16 * 1024 * 1024;
const PROOF = 'northtalk peer ws';
// A policy violation, as WebSocket close codes go.
const REFUSED = 1008;

const tooLarge = (frame: string) =>
  frame.length * 3 > MAX_FRAME &&
  new TextEncoder().encode(frame).length > MAX_FRAME;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const fingerprint = /^[\da-f]{64}$/;

const proved = (nonce: string, key: string) =>
  new TextEncoder().encode(PROOF + nonce + key);

type Hello = { key: CryptoKey; nonce: string; print: string; token?: string };

class WebSocketLink implements PeerLink {
  key = '';
  closed = false;
  readonly address: string | undefined;
  private events: PeerLinkEvents | undefined;
  private own = '';
  private signer: HostSigner | undefined;
  private readonly nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  private theirs: Hello | undefined;
  private caller: [string, Value][] = [];
  // What arrives before `open`, then each step in order.
  private readonly early: string[] = [];
  private work: Promise<void> = Promise.resolve();
  // Frames the router sends before both keys are proved, and messages
  // before the socket opens.
  private readonly outbox: string[] = [];
  private readonly unsent: string[] = [];

  constructor(
    private readonly socket: WebSocketEndpoint,
    private readonly server: AcceptWebSocketOptions | undefined,
    private readonly client: WebSocketLinkOptions | undefined,
  ) {
    this.address = (server ?? client)?.name;
    socket.addEventListener('message', this.message);
    socket.addEventListener('open', this.opened);
    socket.addEventListener('close', this.ended);
    socket.addEventListener('error', this.ended);
  }

  get identity(): Value {
    const entries: [string, Value][] = [
      ['key', text(this.key)],
      ['via', text('ws')],
    ];
    if (this.client) {
      const origin = this.origin();
      if (origin) {
        entries.push(['origin', text(origin)]);
      }
    }
    return map([...entries, ...this.caller]);
  }

  private origin(): string | undefined {
    try {
      const origin = new URL(this.socket.url ?? '').origin;
      return origin === 'null' ? undefined : origin;
    } catch {
      return undefined;
    }
  }

  private get pin(): string | undefined {
    return (
      this.client?.pin ?? /#([\da-f]{64})$/.exec(this.socket.url ?? '')?.[1]
    );
  }

  private readonly message = (event: Event) => {
    const body: unknown = (event as MessageEvent).data;
    if (this.closed) {
      return;
    }
    // One text message per frame: anything else breaks the link.
    if (typeof body !== 'string' || tooLarge(body)) {
      return this.close();
    }
    if (!this.events) {
      this.early.push(body);
      return;
    }
    this.step(body);
  };

  private readonly opened = () => {
    for (const body of this.unsent.splice(0)) {
      this.socket.send(body);
    }
  };

  private readonly ended = () => this.close();

  private step(body: string) {
    this.work = this.work
      .then(() => (this.closed ? undefined : this.read(body)))
      .catch(() => this.close());
  }

  private async read(body: string) {
    if (this.key) {
      return this.events!.frame(body);
    }
    const said = JSON.parse(body) as Record<string, unknown>;
    if (!this.theirs) {
      return this.hello(said);
    }
    const proof =
      typeof said['proof'] === 'string' ? fromBase64(said['proof']) : undefined;
    const ok =
      proof !== undefined &&
      (await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.theirs.key,
        proof as Uint8Array<ArrayBuffer>,
        proved(this.nonce, this.theirs.print),
      ));
    if (!ok) {
      return this.close();
    }
    if (this.server?.authenticate) {
      const data = await this.server.authenticate(this.theirs.token);
      if (data === undefined) {
        return this.close(REFUSED);
      }
      this.caller = Object.entries(data)
        .filter(([k]) => k !== 'key' && k !== 'via')
        .map(([k, v]) => [k, typeof v === 'string' ? text(v) : v]);
    }
    if (this.closed) {
      return;
    }
    this.key = this.theirs.print;
    for (const frame of this.outbox.splice(0)) {
      this.raw(frame);
    }
    this.events!.keyed();
  }

  // The other end's key, checked against its fingerprint and any pin; then
  // this end's proof, over its nonce.
  private async hello(said: Record<string, unknown>) {
    const { hello, key, nonce, token } = said;
    const spki = typeof key === 'string' ? fromBase64(key) : undefined;
    if (
      typeof hello !== 'string' ||
      !fingerprint.test(hello) ||
      typeof nonce !== 'string' ||
      !/^[\da-f]{32}$/.test(nonce) ||
      !spki ||
      (await fingerprintOf(spki as Uint8Array<ArrayBuffer>)) !== hello ||
      (this.client && this.pin !== undefined && this.pin !== hello)
    ) {
      return this.close();
    }
    this.theirs = {
      key: await crypto.subtle.importKey(
        'spki',
        spki as Uint8Array<ArrayBuffer>,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      ),
      nonce,
      print: hello,
      ...(typeof token === 'string' ? { token } : {}),
    };
    const signature = await this.signer!.sign(proved(nonce, this.own));
    this.raw(JSON.stringify({ proof: toBase64(signature) }));
  }

  open(events: PeerLinkEvents, own: string, signer?: HostSigner) {
    this.events = events;
    if (this.closed) {
      return events.close();
    }
    if (!signer) {
      // A Host that can't prove its key can't use a WebSocket.
      return this.close();
    }
    this.own = own;
    this.signer = signer;
    const token = this.client?.token;
    this.raw(
      JSON.stringify({
        hello: own,
        key: toBase64(signer.spki),
        nonce: this.nonce,
        ...(token === undefined ? {} : { token }),
      }),
    );
    for (const body of this.early.splice(0)) {
      this.step(body);
    }
  }

  private raw(body: string) {
    if (this.socket.readyState === 0) {
      this.unsent.push(body);
    } else if (this.socket.readyState === 1) {
      this.socket.send(body);
    }
  }

  send(frame: string): boolean {
    if (this.closed || tooLarge(frame)) {
      return false;
    }
    if (this.key) {
      this.raw(frame);
    } else {
      this.outbox.push(frame);
    }
    return true;
  }

  close(code?: number) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.removeEventListener('message', this.message);
    this.socket.removeEventListener('open', this.opened);
    this.socket.removeEventListener('close', this.ended);
    this.socket.removeEventListener('error', this.ended);
    if (this.socket.readyState < 2) {
      this.socket.close(code ?? 1000);
    }
    this.events?.close();
  }
}

/**
 * A link to the server at the other end of a WebSocket the caller opened,
 * as a browser does. The server's key is proved, and checked against the
 * pin when one is given.
 */
export const webSocketLink = (
  socket: WebSocketEndpoint,
  options: WebSocketLinkOptions = {},
): PeerLink => new WebSocketLink(socket, undefined, options);

/**
 * A link to the Host that opened a WebSocket to this server, from the
 * server's socket adapted to a `WebSocketEndpoint`. The other key is proved,
 * and `authenticate` checks the token before any Remote Send arrives.
 */
export const acceptWebSocket = (
  socket: WebSocketEndpoint,
  options: AcceptWebSocketOptions = {},
): PeerLink => new WebSocketLink(socket, options, undefined);
