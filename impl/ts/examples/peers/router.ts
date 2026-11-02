// An in-process peer router (chapter 9, The peer router): it holds the
// exposures of Groups on this Host and carries Remote Sends between them,
// as `post` Deliveries and `call` Requests, at most once.
import {
  list,
  map,
  nothing,
  peerKind,
  ScriptError,
  text,
  type Call,
  type HostObject,
  type PeerImpl,
  type TsGroup,
  type Value,
} from '@northtalk/ts';

/**
 * A Grant's binding: the names it may `expose` and `reach`. A list leaves
 * the others refused with `bad address`; an absent one allows any name.
 */
export type PeerBinding = { expose?: string[]; reach?: string[] };

type Exposure = { group: TsGroup; name?: string; script: string };
type Member = {
  /** Each Remote Send's sender, by the delivery id it was given here. */
  callers: Map<string, Value>;
  /** What this Host vouches for about a sender in this Group. */
  identity: Value;
  /** This Group's one Peer for each exposure, by its secret. */
  peers: Map<string, HostObject>;
};

// 128 random bits, so no one guesses an exposure into existence.
const secret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');

const failure = (code: string, data: [string, Value][] = []) =>
  new ScriptError(code, code, map(data));
const mailboxFull = (error: unknown) =>
  (error as Error | undefined)?.name === 'MailboxFull';
const sendFailed = (reason: string) =>
  failure('send failed', [['reason', text(reason)]]);

export class PeerRouter {
  private readonly exposures = new Map<string, Exposure>();
  private readonly names = new Map<string, string>();
  private readonly members = new Map<TsGroup, Member>();

  /**
   * Lets `group`'s Scripts use the router, as senders vouched for by
   * `identity`, such as `{group: "shop"}`.
   */
  attach(group: TsGroup, identity: Value): void {
    this.members.set(group, { identity, callers: new Map(), peers: new Map() });
  }

  /** The `peerCapability` implementation every attached Group shares. */
  readonly impl: PeerImpl = {
    expose: (call, name) => this.expose(call, name),
    unexpose: (call, exposure) => this.unexpose(call, exposure),
    reach: (call, address) => this.reach(call, address),
    post: (call, peer, message, args) => this.post(call, peer, message, args),
    call: (call, peer, message, args) => this.call(call, peer, message, args),
    caller: call =>
      (call.delivery === undefined
        ? undefined
        : this.member(call.group).callers.get(call.delivery)) ?? nothing,
  };

  private member(group: unknown): Member {
    const m = this.members.get(group as TsGroup);
    if (!m) {
      throw new Error('The Group is not attached to this router');
    }
    return m;
  }

  /** The Group's one Peer for an exposure, made the first time it's needed. */
  private peerIn(group: TsGroup, key: string): HostObject {
    const peers = this.member(group).peers;
    let peer = peers.get(key);
    if (!peer) {
      peer = group.object(peerKind, key, null);
      peers.set(key, peer);
    }
    return peer;
  }

  private allows(call: Call<unknown>, kind: keyof PeerBinding, name: string) {
    const names = (call.binding as PeerBinding | undefined)?.[kind];
    return names === undefined || names.includes(name);
  }

  private expose(call: Call<unknown>, name?: string) {
    const group = call.group as unknown as TsGroup;
    if (name !== undefined && !this.allows(call, 'expose', name)) {
      return call.fail(failure('bad address'));
    }
    if (name !== undefined && this.names.has(name)) {
      const key = this.names.get(name)!;
      const held = this.exposures.get(key)!;
      if (held.group !== group || held.script !== call.scriptName) {
        return call.fail(failure('name in use'));
      }
      return call.answer(this.peerIn(group, key).value);
    }
    const key = secret();
    this.exposures.set(key, { group, script: call.scriptName, name });
    if (name !== undefined) {
      this.names.set(name, key);
    }
    call.answer(this.peerIn(group, key).value);
  }

  private unexpose(call: Call<unknown>, exposure: string | HostObject) {
    const key =
      typeof exposure === 'string' ? this.names.get(exposure) : exposure.id;
    const held = key === undefined ? undefined : this.exposures.get(key);
    if (
      !held ||
      held.group !== (call.group as unknown as TsGroup) ||
      held.script !== call.scriptName
    ) {
      return;
    }
    this.exposures.delete(key!);
    if (held.name !== undefined) {
      this.names.delete(held.name);
    }
  }

  private reach(call: Call<unknown>, address: string) {
    if (!this.allows(call, 'reach', address)) {
      return call.fail(failure('bad address'));
    }
    const key = this.names.get(address);
    if (key === undefined) {
      return call.fail(failure('not exposed'));
    }
    call.answer(this.peerIn(call.group as unknown as TsGroup, key).value);
  }

  /**
   * A value as the receiving Group reads it: each Peer becomes that Group's
   * Peer for the same exposure. The Core refuses other Host Objects and
   * Function Values at the `send`, but a reply may still hold one, which
   * gives undefined.
   */
  private cross(v: Value, to: TsGroup): Value | undefined {
    switch (v.kind) {
      case 'list': {
        const items = Array.from({ length: v.length }, (_, i) =>
          this.cross(v.index(i + 1), to),
        );
        return items.every(x => x !== undefined)
          ? list(...(items as Value[]))
          : undefined;
      }
      case 'map': {
        const entries = v.entries().map(([k, x]) => [k, this.cross(x, to)]);
        return entries.every(([, x]) => x !== undefined)
          ? map(entries as [string, Value][])
          : undefined;
      }
      case 'object': {
        const ref = v.asObjectRef()!;
        return ref.kind === peerKind.name && this.exposures.has(ref.id)
          ? this.peerIn(to, ref.id).value
          : undefined;
      }
      case 'function':
        return undefined;
      default:
        return v;
    }
  }

  private crossAll(args: Value[], to: TsGroup): Value[] | undefined {
    const sent = args.map(a => this.cross(a, to));
    return sent.every(x => x !== undefined) ? (sent as Value[]) : undefined;
  }

  /** Where a Remote Send to `peer` goes, if its exposure still stands. */
  private target(peer: HostObject) {
    const held = this.exposures.get(peer.id);
    const script = held?.group.script(held.script);
    return held && script ? { group: held.group, script } : undefined;
  }

  private post(
    call: Call<unknown>,
    peer: HostObject,
    message: string,
    args: Value[],
  ) {
    // A `post` never fails in the Script: one that can't go is dropped.
    const to = this.target(peer);
    const sent = to && this.crossAll(args, to.group);
    if (!to || !sent) {
      return;
    }
    try {
      this.vouch(
        call,
        to.group,
        to.script.deliver({ name: message, args: sent }),
      );
    } catch (error) {
      if (!mailboxFull(error)) {
        throw error;
      }
    }
  }

  private call(
    call: Call<unknown>,
    peer: HostObject,
    message: string,
    args: Value[],
  ) {
    const to = this.target(peer);
    if (!to) {
      return call.fail(sendFailed('not exposed'));
    }
    const sent = this.crossAll(args, to.group);
    if (!sent) {
      return call.fail(sendFailed('unreachable'));
    }
    let requested;
    try {
      requested = to.script.request({ name: message, args: sent });
    } catch (error) {
      if (mailboxFull(error)) {
        return call.fail(sendFailed('mailbox full'));
      }
      throw error;
    }
    this.vouch(call, to.group, requested.id);
    const from = call.group as unknown as TsGroup;
    // Delivered once; an abandoned call's reply is dropped when it comes.
    requested.result.then(
      reply => {
        const back = this.cross(reply, from);
        if (back) {
          call.answer(back);
        } else {
          call.fail(sendFailed('unreachable'));
        }
      },
      (error: unknown) => {
        const given = error as Partial<ScriptError>;
        call.fail(
          given.name === 'ScriptError' && given.code === 'send failed'
            ? failure(
                'send failed',
                given.data?.kind === 'map' ? [...given.data.entries()] : [],
              )
            : sendFailed('unreachable'),
        );
      },
    );
  }

  // The receiving Host vouches for the sender: its Group's identity, never
  // a claim in the arguments.
  private vouch(call: Call<unknown>, to: TsGroup, id: string) {
    this.member(to).callers.set(id, this.member(call.group).identity);
  }
}
