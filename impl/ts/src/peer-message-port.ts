// A peer router link over a MessagePort, a Worker or a worker's `self`
// (ADR 0165). Each frame is posted as its JSON text. Only whoever holds the
// port can use it, so each end's first frame claims its key with no proof,
// as on loopback `tcp://`.
import { map, text, type Value } from './values';
import type { PeerLink, PeerLinkEvents } from './peer';

/** What the link needs of a `MessagePort`, a `Worker` or a worker's `self`. */
export type PortEndpoint = {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void;
};

export type MessagePortLinkOptions = {
  /**
   * The other end's name: `reach` uses it as the address, and it joins the
   * Caller Identity.
   */
  name?: string;
};

/** The largest frame a link sends or reads, in UTF-8 bytes. */
const MAX_FRAME = 16 * 1024 * 1024;

const tooLarge = (frame: string) =>
  frame.length * 3 > MAX_FRAME &&
  new TextEncoder().encode(frame).length > MAX_FRAME;

class MessagePortLink implements PeerLink {
  key = '';
  closed = false;
  readonly address: string | undefined;
  private events: PeerLinkEvents | undefined;
  private readonly held: string[] = [];

  constructor(
    private readonly port: PortEndpoint,
    private readonly name: string | undefined,
  ) {
    this.address = name;
    port.addEventListener('message', this.message);
    port.addEventListener('close', this.ended);
    // A MessagePort holds its messages until it starts; a Worker doesn't.
    (port as Partial<MessagePort>).start?.();
  }

  get identity(): Value {
    return map([
      ['key', text(this.key)],
      ['via', text('port')],
      ...(this.name === undefined
        ? []
        : [['name', text(this.name)] as [string, Value]]),
    ]);
  }

  private readonly message = (event: MessageEvent) => {
    const body: unknown = event.data;
    if (this.closed) {
      return;
    }
    // A Worker or `self` may carry the app's own messages too: frames are
    // the strings.
    if (typeof body !== 'string') {
      return;
    }
    if (tooLarge(body)) {
      return this.close();
    }
    if (!this.key) {
      return this.hello(body);
    }
    if (this.events) {
      this.events.frame(body);
    } else {
      this.held.push(body);
    }
  };

  private readonly ended = () => this.close();

  // The other end's first frame says which key it is.
  private hello(body: string) {
    let claim: unknown;
    try {
      claim = (JSON.parse(body) as { hello?: unknown }).hello;
    } catch {
      claim = undefined;
    }
    if (typeof claim !== 'string' || !/^[\da-f]{64}$/.test(claim)) {
      return this.close();
    }
    this.key = claim;
    this.events?.keyed();
  }

  open(events: PeerLinkEvents, own: string) {
    this.events = events;
    if (this.closed) {
      return events.close();
    }
    this.send(JSON.stringify({ hello: own }));
    if (this.key) {
      events.keyed();
    }
    for (const body of this.held.splice(0)) {
      events.frame(body);
    }
  }

  send(frame: string): boolean {
    if (this.closed || tooLarge(frame)) {
      return false;
    }
    this.port.postMessage(frame);
    return true;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.port.removeEventListener('message', this.message);
    this.port.removeEventListener('close', this.ended);
    // Only a MessagePort is closed: closing a worker's `self` would end it.
    const port = this.port as Partial<MessagePort>;
    if (typeof port.start === 'function') {
      port.close?.();
    }
    this.events?.close();
  }
}

/**
 * A link to the Host at the other end of a `MessagePort`, or of a `Worker`
 * from the page, or of the page from a worker's `self`. Closing a port ends
 * the link at both ends. A worker that is terminated sends no word, so the
 * page closes the link itself, as `WorkerSupervisor.closeOnTerminate` does.
 */
export const messagePortLink = (
  port: PortEndpoint,
  options: MessagePortLinkOptions = {},
): PeerLink => new MessagePortLink(port, options.name);
