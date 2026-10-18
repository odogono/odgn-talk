// One guest instance and its Message Layer conversation: refs, the
// negotiated features, and the declarations mirrored into it. Each Group has
// its own guest, as the Go adapter does, so a callback in one Group never
// holds up another, and a guest that traps loses only its Group.
import type { CapabilityDef, Grant, SegmentCoordinator } from '../capabilities';
import {
  HostError,
  LoadError,
  MailboxFull,
  type HostErrorCode,
  type LoadDiagnostic,
} from '../errors';
import { operationData, shapeData } from '../manifest';
import type { ObjectKind } from '../objects';
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  isRequestPumpBinary,
  requestPumpFeature,
} from '../request-pump-binary';
import { standardChecks } from '../standard-capability-checks';
import { guestPayload } from './codec';
import { InstanceLostError, Reactor, type Diagnostics } from './reactor';
import {
  Raw,
  field,
  frameJSON,
  frameTree,
  intOf,
  plain,
  readReply,
  textOf,
  textsOf,
  type Frame,
  type Json,
} from './wire';

/** The features this Host relies on; a guest without one is refused. */
export const features = [
  'paused-inputs-v1',
  'abandoned-before-needs-v1',
  'crossing-trace-v1',
  'climb-v1',
  'function-gone-v1',
  'standard-refinements-v1',
  'restore-bindings-v1',
] as const;

/** Features this Host uses when the guest offers them (#1143). */
export const optionalFeatures = [
  'object-elements-v1',
  requestPumpFeature,
] as const;

export type Versions = {
  core: string;
  costModel: string;
  language: string;
  saveFormat: string;
  unicode: string;
};

/** Answers one interim need with its `…-result` fields. */
export type NeedHandler = (need: Json, packet: Json) => Record<string, Frame>;
/** Sees every reply of an exchange, interim ones included. */
export type Observer = (packet: Json, m: string) => void;

/** The Core's names for its definitions, shared by every guest it makes. */
export type Registry = {
  handleOf(def: CapabilityDef<unknown>): string;
  readonly kinds: readonly ObjectKind[];
};

// Methods whose first frame goes binary once Request/Pump binary is negotiated.
const binaryMethods = new Set([
  'request',
  'call',
  'pump',
  'request-pump',
  'call-pump',
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const failure = (err: Json): Error => {
  const kind = textOf(field(err, 'kind'));
  if (kind === 'host error') {
    return new HostError(
      textOf(field(err, 'code')) as HostErrorCode,
      textOf(field(err, 'detail')) || textOf(field(err, 'code')),
    );
  }
  if (kind === 'load error') {
    return new LoadError(plain(field(err, 'diagnostics')) as LoadDiagnostic[]);
  }
  if (kind === 'mailbox full') {
    return new MailboxFull('mailbox full');
  }
  return new Error(
    `Message Layer ${kind ?? 'error'}: ${textOf(field(err, 'detail')) ?? ''}`,
  );
};

const costFrame = (c: { alloc?: number; fuel: number }) => ({
  fuel: c.fuel,
  alloc: c.alloc ?? 0,
});

const isStandard = (def: CapabilityDef<unknown>) =>
  [...def.operations.values()].some(op => standardChecks(op));
const segmentBound = (def: CapabilityDef<unknown>) =>
  [...def.operations.values()].some(
    op => op.mode === 'immediate' && op.segmentBound,
  );

export class Session {
  readonly reactor: Reactor;
  readonly versions: Versions;
  #ref = 0;
  readonly #definitions = new Map<CapabilityDef<unknown>, string>();
  readonly #grants = new Map<Grant<unknown>, number>();
  readonly #coordinators = new Map<SegmentCoordinator, string>();
  readonly #kinds = new Set<string>();
  readonly #libraries = new Set<string>();
  /** Whether the guest accepts Object Collection declarations. */
  readonly elements: boolean;
  readonly requestPump: boolean;
  #token = 0n;

  nextToken(): Raw {
    if (this.#token === 2n ** 64n - 1n) {
      throw new HostError('invalid value', 'Correlation tokens exhausted');
    }
    return new Raw((++this.#token).toString());
  }

  constructor(
    module: WebAssembly.Module,
    diagnostics: Diagnostics,
    private readonly registry: Registry,
  ) {
    this.reactor = new Reactor(module, diagnostics);
    const hello = this.exchange('hello', {
      protocol: 1,
      features: [...features, ...optionalFeatures],
    });
    const offered = new Set(textsOf(field(hello, 'features')));
    this.elements = offered.has('object-elements-v1');
    this.requestPump = offered.has(requestPumpFeature);
    const missing = features.filter(f => !offered.has(f));
    if (missing.length) {
      throw new InstanceLostError(`talk.wasm lacks ${missing.join(', ')}`);
    }
    this.versions = {
      language: textOf(field(hello, 'language'))!,
      costModel: textOf(field(hello, 'costModel'))!,
      unicode: textOf(field(hello, 'unicode'))!,
      core: textOf(field(hello, 'core'))!,
      saveFormat: textOf(field(hello, 'saveFormat'))!,
    };
  }

  /**
   * One complete exchange: the message, then every need answered under its
   * ref, until the final reply. Returns its `ok`, or throws its `err`.
   * A callback may start other exchanges meanwhile, under their own refs.
   */
  exchange(
    m: string,
    fields: Record<string, Frame | undefined>,
    answer?: NeedHandler,
    observe?: Observer,
  ): Json {
    const ref = ++this.#ref;
    let frame: Record<string, Frame | undefined> = { m, ref, ...fields };
    const binaryExchange = this.requestPump && binaryMethods.has(m);
    let initial = true;
    for (;;) {
      const binary = binaryExchange && initial;
      const input = binary
        ? new Uint8Array(
            encodeBinaryFrame(frameTree(frame), {
              encodeFunction: guestPayload,
            }),
          )
        : encoder.encode(frameJSON(frame));
      const output = this.reactor.frameBytes(input);
      const binaryReply = isRequestPumpBinary(new Uint8Array(output));
      if (binaryReply && !binaryExchange) {
        throw new InstanceLostError('Unnegotiated binary reply');
      }
      const packet = binaryReply
        ? decodeBinaryFrame(output)
        : readReply(decoder.decode(output));
      initial = false;
      if (intOf(field(packet, 'ref')) !== ref) {
        throw new InstanceLostError(`The reply to ${m} has another ref`);
      }
      observe?.(packet, m);
      const err = field(packet, 'err');
      if (err !== undefined) {
        throw failure(err);
      }
      const need = field(packet, 'need');
      if (binaryExchange && !binaryReply && need === undefined) {
        throw new InstanceLostError(
          'The binary exchange ended with a JSON success',
        );
      }
      if (need === undefined) {
        return field(packet, 'ok') ?? null;
      }
      if (!answer) {
        throw new InstanceLostError(`${m} asked for an unexpected need`);
      }
      frame = {
        ...answer(need, packet),
        m: `${textOf(field(need, 'm'))}-result`,
        ref,
        group: fields.group,
      };
    }
  }

  /** The guest's handle for a Capability, declared on first use. */
  define(def: CapabilityDef<unknown>): string {
    let handle = this.#definitions.get(def);
    if (handle !== undefined) {
      return handle;
    }
    handle = this.registry.handleOf(def);
    this.exchange('define-capability', {
      name: def.name,
      handle,
      ops: [...def.operations].map(([name, op]) => ({
        ...operationData(name, op),
        description: op.description,
        examples: op.examples ? [...op.examples] : undefined,
      })) as Frame,
      segmentLifecycle: segmentBound(def) || undefined,
      release: def.release ? true : undefined,
      standard: isStandard(def) ? def.name : undefined,
    });
    this.#definitions.set(def, handle);
    return handle;
  }

  /** The guest's handle for a Grant, made on first use. */
  grant(grant: Grant<unknown>): number {
    let handle = this.#grants.get(grant);
    if (handle !== undefined) {
      return handle;
    }
    const def = grant.capability;
    const capability = this.define(def);
    let coordinator: string | undefined;
    if (segmentBound(def) && grant.coordinator) {
      coordinator = this.#coordinators.get(grant.coordinator);
      if (coordinator === undefined) {
        coordinator = `coordinator-${this.#coordinators.size + 1}`;
        this.#coordinators.set(grant.coordinator, coordinator);
      }
    }
    const standard = isStandard(def);
    const binding = grant.binding as { maxRows?: number } | string | undefined;
    const ok = this.exchange('grant', {
      capability,
      ops: [...grant.ops].sort(),
      coordinator,
      locale:
        standard && def.name === 'locale'
          ? typeof binding === 'string'
            ? binding
            : 'und'
          : undefined,
      maxRows:
        standard && def.name === 'sqlite' && typeof binding === 'object'
          ? binding.maxRows
          : undefined,
    });
    handle = intOf(field(ok, 'grant'))!;
    this.#grants.set(grant, handle);
    return handle;
  }

  /** A declared Capability's name, from the handle the guest reports. */
  capabilityName(handle: string): string | undefined {
    for (const [def, h] of this.#definitions) {
      if (h === handle) {
        return def.name;
      }
    }
    return undefined;
  }

  /** The coordinator a Grant's effect need names, by the name given it here. */
  coordinator(name: string): SegmentCoordinator | undefined {
    for (const [c, n] of this.#coordinators) {
      if (n === name) {
        return c;
      }
    }
    return undefined;
  }

  /** Declares every Object Kind the Core knows that this guest doesn't yet. */
  syncKinds(): void {
    for (const kind of this.registry.kinds) {
      if (this.#kinds.has(kind.name)) {
        continue;
      }
      if (kind.elements && !this.elements) {
        throw new HostError(
          'invalid value',
          `talk.wasm lacks object-elements-v1 for ${kind.name}'s collection`,
        );
      }
      this.exchange('define-object-kind', {
        name: kind.name,
        ...(kind.elements
          ? {
              elements: {
                shape: shapeData(kind.elements.shape) as Frame,
                countCost: costFrame(kind.elements.countCost),
                atCost: costFrame(kind.elements.atCost),
                findCost: costFrame(kind.elements.findCost),
              },
            }
          : {}),
        props: [...kind.props].map(([name, p]) => ({
          name,
          shape: (p.shape ? shapeData(p.shape) : 'value') as Frame,
          readOnly: !p.set,
          getCost: { fuel: p.getCost?.fuel ?? 0, alloc: p.getCost?.alloc ?? 0 },
          setCost: { fuel: p.setCost?.fuel ?? 0, alloc: p.setCost?.alloc ?? 0 },
        })),
        parentKinds: [...kind.parentKinds],
      });
      this.#kinds.add(kind.name);
    }
  }

  /** Whether this guest has compiled a Library, by its identity. */
  hasLibrary(identity: string): boolean {
    return this.#libraries.has(identity);
  }
  addedLibrary(identity: string): void {
    this.#libraries.add(identity);
  }
}
