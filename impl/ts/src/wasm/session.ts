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
import { standardChecks } from '../standard-capability-checks';
import { InstanceLostError, Reactor, type Diagnostics } from './reactor';
import {
  field,
  frameJSON,
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

  constructor(
    module: WebAssembly.Module,
    diagnostics: Diagnostics,
    private readonly registry: Registry,
  ) {
    this.reactor = new Reactor(module, diagnostics);
    const hello = this.exchange('hello', {
      protocol: 1,
      features: [...features],
    });
    const offered = new Set(textsOf(field(hello, 'features')));
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
    for (;;) {
      const packet = readReply(this.reactor.frame(frameJSON(frame)));
      if (intOf(field(packet, 'ref')) !== ref) {
        throw new InstanceLostError(`The reply to ${m} has another ref`);
      }
      observe?.(packet, m);
      const err = field(packet, 'err');
      if (err !== undefined) {
        throw failure(err);
      }
      const need = field(packet, 'need');
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
      this.exchange('define-object-kind', {
        name: kind.name,
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
