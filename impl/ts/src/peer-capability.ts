// Chapter 7's optional `peer` Standard Capability (ADRs 0153, 0154, 0155).
// The Core defines the `peer` Object Kind, checks every Operation's
// arguments and routes a `send` to a Peer through the sending Script's
// `peer` Grant (machine.ts); the Host holds exposures and carries Remote
// Sends.
import {
  defineValueCapability,
  shape,
  type Call,
  type CapabilityDef,
  type Shape,
  type ValueOperation,
} from './capabilities';
import { HostError } from './errors';
import { defineObjectKind, type HostObject } from './objects';
import { ScriptError } from './operations';
import { validComputedMessageName } from './selectors';
import { costOf, fixed, type Costs } from './standard-capabilities';
import { registerStandardChecks } from './standard-capability-checks';
import { dec, listValues, nothing, text, type Value } from './values';

/** The Core-fixed Object Kind of a Peer: no properties, no collection. */
export const PEER_KIND = 'peer';
export const peerKind = defineObjectKind<unknown>({
  name: PEER_KIND,
  props: {},
});

/**
 * The Host's side of `peer` (chapter 9, The `peer` factory). `expose`,
 * `reach` and `call` start suspending calls, answered through the Call;
 * `expose` hears `null` for an unnamed exposure. `unexpose` hears a name or
 * a Peer. `post` and `call` hear the Peer, the Selector and the arguments,
 * which may hold Peers. `caller` gives the Caller Identity recorded for
 * `call.delivery`, or Nothing.
 */
export type PeerImpl = {
  call(
    call: Call<unknown>,
    peer: HostObject,
    message: string,
    args: Value[],
  ): void;
  caller(call: Call<unknown>): Value;
  /** No name makes a new unnamed exposure. */
  expose(call: Call<unknown>, name?: string): void;
  post(
    call: Call<unknown>,
    peer: HostObject,
    message: string,
    args: Value[],
  ): void;
  reach(call: Call<unknown>, address: string): void;
  unexpose(call: Call<unknown>, exposure: string | HostObject): void;
};

const itemsOf = (list: Value): Value[] =>
  Array.from({ length: list.length }, (_, i) => list.index(i + 1));

const OPERATIONS = [
  'expose',
  'unexpose',
  'reach',
  'post',
  'call',
  'caller',
] as const;
/** The Operations `send` uses: `post` for a plain one, `call` with `and wait`. */
export const PEER_POST = 'post';
export const PEER_CALL = 'call';

const peerShape: Shape = { k: 'object', kind: PEER_KIND };
const argsShape = shape.listOf(shape.any);

const outOfDomain = (fn: string, value: Value) =>
  new ScriptError(
    'out of domain',
    [
      ['function', text(fn)],
      ['value', value],
    ],
    true,
  );

/** Whether a value is a Peer: a Host Object of the Core's kind `peer`. */
export const isPeer = (v: Value): boolean =>
  v.kind === 'object' && v.asObjectRef()?.kind === PEER_KIND;

// The first Host Object in `v` that isn't a Peer, with its path below `v`.
const strayObject = (
  v: Value,
  path: (string | number)[],
): (string | number)[] | null => {
  if (v.kind === 'object') {
    return isPeer(v) ? null : path;
  }
  if (v.kind === 'list') {
    for (let i = 1; i <= v.length; i++) {
      const found = strayObject(v.index(i), [...path, i]);
      if (found) {
        return found;
      }
    }
  }
  if (v.kind === 'map') {
    for (const [key, item] of v.entries()) {
      const found = strayObject(item, [...path, key]);
      if (found) {
        return found;
      }
    }
  }
  return null;
};

/**
 * A Remote Send's arguments, checked as the `post` and `call` Operations
 * check them, after their Shapes: a Selector a computed `send` could use,
 * then no Host Object other than a Peer at any depth (chapter 5, Remote
 * Sends). `path` counts from the Operation's arguments.
 */
const checkRemoteSend = (args: readonly Value[]) => {
  const message = args[1]!;
  const sent = args[2]!;
  if (!validComputedMessageName(message.asText()!, sent.length)) {
    throw new ScriptError(
      'bad message name',
      [
        ['name', message],
        ['arguments', dec(String(sent.length))],
      ],
      true,
    );
  }
  const path = strayObject(sent, [3]);
  if (path) {
    throw new ScriptError(
      'not encodable',
      [
        ['kind', text('object')],
        ['path', listValues(path.map(keyValue))],
      ],
      true,
    );
  }
};

// A path's step: a map key, or a 1-based list index.
const keyValue = (k: string | number): Value =>
  typeof k === 'number' ? dec(String(k)) : text(k);

const nonEmpty = (fn: string, v: Value | undefined) => {
  if (v?.kind === 'text' && v.asText() === '') {
    throw outOfDomain(fn, v);
  }
};

/**
 * Optional for Hosts. The binding is the Host's own description of the
 * names the Grant may `reach` and `expose`; the Core never reads it.
 */
export const peerCapability = (
  impl: PeerImpl,
  costs: Costs,
): CapabilityDef<unknown> => {
  for (const name of OPERATIONS) {
    if (!impl || typeof impl[name] !== 'function') {
      throw new HostError('invalid value', `Peer needs ${name}`);
    }
  }
  const operations: Record<string, ValueOperation<unknown>> = {
    expose: {
      mode: 'suspending',
      args: [shape.optional(shape.text)],
      result: peerShape,
      errors: [{ code: 'bad address' }, { code: 'name in use' }],
      cost: costOf(costs, 'expose'),
      start: (call, name) =>
        name?.kind === 'text'
          ? impl.expose(call, name.asText()!)
          : impl.expose(call),
    },
    unexpose: {
      mode: 'immediate',
      args: [shape.oneOf(shape.text, peerShape)],
      result: shape.nothing,
      errors: [],
      cost: costOf(costs, 'unexpose'),
      do: (call, exposure) => {
        impl.unexpose(
          call,
          exposure!.kind === 'text'
            ? exposure!.asText()!
            : exposure!.asObject()!,
        );
        return nothing;
      },
    },
    reach: {
      mode: 'suspending',
      args: [shape.text],
      result: peerShape,
      errors: [{ code: 'bad address' }, { code: 'not exposed' }],
      cost: costOf(costs, 'reach'),
      start: (call, address) => impl.reach(call, address!.asText()!),
    },
    post: {
      mode: 'fire-and-forget',
      args: [peerShape, shape.text, argsShape],
      errors: [],
      cost: costOf(costs, 'post'),
      fire: (call, peer, message, args) =>
        impl.post(call, peer!.asObject()!, message!.asText()!, itemsOf(args!)),
    },
    call: {
      mode: 'suspending',
      args: [peerShape, shape.text, argsShape],
      result: shape.any,
      errors: [
        {
          code: 'send failed',
          fields: {
            reason: shape.text,
            error: { optional: true, shape: shape.any },
          },
        },
      ],
      cost: costOf(costs, 'call'),
      start: (call, peer, message, args) =>
        impl.call(call, peer!.asObject()!, message!.asText()!, itemsOf(args!)),
    },
    caller: {
      mode: 'immediate',
      args: [],
      result: shape.any,
      errors: [],
      cost: costOf(costs, 'caller'),
      do: call => impl.caller(call),
    },
  };
  const hostErrors: Record<string, readonly string[]> = {
    expose: ['bad address', 'name in use'],
    reach: ['bad address', 'not exposed'],
    call: ['send failed'],
  };
  for (const [name, op] of Object.entries(operations)) {
    registerStandardChecks(op, {
      error: code => hostErrors[name]?.includes(code) ?? false,
      ...(name === 'expose' || name === 'reach' || name === 'unexpose'
        ? { arguments: args => nonEmpty(name, args[0]) }
        : name === 'post' || name === 'call'
          ? { arguments: checkRemoteSend }
          : {}),
    });
  }
  return fixed(defineValueCapability('peer', operations));
};
