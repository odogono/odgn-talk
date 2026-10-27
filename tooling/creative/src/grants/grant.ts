// A Folio Grant written once (#1453): its Operations as data, from which the
// Script Manifest and the Library declarations are derived, and the
// Capability a Play Session builds from them over the state it passes in.
import {
  shape,
  type CapabilityDef,
  type Grant,
  type Shape,
} from '@northtalk/ts';
import { ELEMENT_KINDS } from '../model';

/** One Operation's declaration, without its Host function. */
export type OperationDeclaration = {
  readonly args?: readonly Shape[];
  readonly command?: boolean;
  readonly cost: { readonly alloc?: number; readonly fuel: number };
  readonly description?: string;
  readonly errors?: { readonly code: string }[];
  readonly examples?: readonly string[];
  readonly maxPendingMs?: number;
  readonly mode: 'fire-and-forget' | 'immediate' | 'suspending';
  readonly result?: Shape;
};

export type GrantDefinition<S> = {
  /** The Grant over one Play Session's state, offering every Operation. */
  grant(state: S): Grant<unknown>;
  /** The Grant's name, which is also its Capability's. */
  readonly name: string;
  readonly operations: Readonly<Record<string, OperationDeclaration>>;
};

/** A Grant offering all of a Capability's Operations. */
export const grantAll = <B>(
  capability: CapabilityDef<B>,
  binding: B,
): Grant<unknown> => capability.grant('all', binding) as Grant<unknown>;

/** Any Element, as the `elements` and `folio` Operations take one. */
export const elementShape = shape.oneOf(
  ...ELEMENT_KINDS.map(kind => ({ k: 'object' as const, kind })),
);
export const pageShape = { k: 'object' as const, kind: 'page' };
export const canvasShape = { k: 'object' as const, kind: 'canvas' };

// The Host Manifest's Shape data (chapter 9).
const shapeData = (s: Shape): unknown => {
  switch (s.k) {
    case 'any':
    case 'value':
      return s.k;
    case 'kind':
      return s.kind;
    case 'object':
      return { object: s.kind };
    case 'quantity':
      return { quantity: s.unit };
    case 'unitKind':
      return { unitKind: s.kind };
    case 'list':
      return { list: shapeData(s.of) };
    case 'oneOf':
      return { oneOf: s.of.map(shapeData) };
    case 'optional':
      return { optional: shapeData(s.of) };
    case 'map':
      return {
        map: s.fields.map(f => ({
          key: f.key,
          shape: shapeData(f.shape),
          ...(f.optional ? { optional: true } : {}),
        })),
        ...(s.open ? { open: true } : {}),
      };
  }
};

/** The Grant's entry in a Script's Host Manifest. */
export const manifestGrant = (definition: GrantDefinition<never>) => ({
  name: definition.name,
  capability: definition.name,
  operations: Object.entries(definition.operations).map(([name, op]) => ({
    name,
    args: (op.args ?? []).map(shapeData),
    mode: op.mode,
    ...(op.cost
      ? { cost: { fuel: op.cost.fuel, alloc: op.cost.alloc ?? 0 } }
      : {}),
    ...(op.result ? { result: shapeData(op.result) } : {}),
    ...(op.maxPendingMs === undefined ? {} : { maxPending: op.maxPendingMs }),
    ...(op.errors?.length
      ? { errors: op.errors.map(({ code }) => ({ code, fields: [] })) }
      : {}),
    ...(op.command ? { command: true } : {}),
    ...(op.description ? { description: op.description } : {}),
    ...(op.examples ? { examples: [...op.examples] } : {}),
  })),
});

/** What Library compilation needs of each Operation. */
export const libraryDeclarations = (definition: GrantDefinition<never>) =>
  Object.fromEntries(
    Object.entries(definition.operations).map(([name, op]) => [
      name,
      {
        mode: op.mode,
        args: op.args ?? [],
        ...(op.command ? { command: true } : {}),
      },
    ]),
  );
