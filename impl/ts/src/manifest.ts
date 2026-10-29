// Operation Declarations in the Host Manifest's data model, shared by saves
// and Group Fingerprints. Bindings and executable Host functions stay out.
import type { Grant, ValueOperation, Shape } from './capabilities';
import { quoteJSON } from './encoding';
import { HostError } from './errors';
import type { Library, OperationRef } from './library';
import type { ObjectKind } from './objects';
import { languageVersion } from './generated/machine';
import { compareText } from './text';

export type MessageDecl = {
  args?: readonly Shape[];
  description?: string;
  /** NorthTalk source, each sending this message. */
  examples?: readonly string[];
  name: string;
  receivers?: readonly ObjectKind[];
};
export type ManifestSpec = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Grants may carry any Host binding, as in talk.ts.
  grants: Readonly<Record<string, Grant<any>>>;
  kind: string;
  libraries?: readonly Library[];
  messages?: readonly MessageDecl[];
  objectKinds?: readonly ObjectKind[];
  objects?: Readonly<Record<string, ObjectKind>>;
  /** The Owner Kind: one of objectKinds, the kind of `me` for tooling. */
  ownerKind?: ObjectKind;
  version: string;
};

export const shapeData = (shape: Shape): unknown => {
  switch (shape.k) {
    case 'any':
      return 'any';
    case 'value':
      return 'value';
    case 'kind':
      return shape.kind;
    case 'object':
      return { object: shape.kind };
    case 'quantity':
      return { quantity: shape.unit };
    case 'unitKind':
      return { unitKind: shape.kind };
    case 'list':
      return { list: shapeData(shape.of) };
    case 'oneOf':
      return { oneOf: shape.of.map(shapeData) };
    case 'optional':
      return { optional: shapeData(shape.of) };
    case 'map':
      return {
        map: shape.fields.map(f => ({
          key: f.key,
          shape: shapeData(f.shape),
          ...(f.optional ? { optional: true } : {}),
        })),
        ...(shape.open ? { open: true } : {}),
      };
  }
};
export const operationData = (name: string, op: ValueOperation<unknown>) => ({
  name,
  mode: op.mode,
  args: (op.args ?? []).map(shapeData),
  ...(op.labels?.length ? { labels: [...op.labels] } : {}),
  ...(op.result ? { result: shapeData(op.result) } : {}),
  cost: { fuel: op.cost.fuel, alloc: op.cost.alloc ?? 0 },
  ...(op.mode === 'suspending' && op.maxPendingMs !== undefined
    ? { maxPending: op.maxPendingMs }
    : {}),
  ...(op.errors === undefined
    ? {}
    : {
        errors: [...op.errors]
          .sort((a, b) => compareText(a.code, b.code))
          .map(e => ({
            code: e.code,
            fields: Object.entries(e.fields ?? {}).map(([key, f]) => ({
              key,
              shape: shapeData('shape' in f ? f.shape : f),
              ...('shape' in f ? { optional: true } : {}),
            })),
          })),
      }),
  ...(op.mode === 'immediate' && op.scope
    ? {
        scope:
          'opens' in op.scope
            ? { opens: op.scope.opens, abandon: op.scope.abandon }
            : { closes: op.scope.closes },
      }
    : {}),
  ...(op.mode === 'immediate' && op.segmentBound ? { segmentBound: true } : {}),
  ...(op.command ? { command: true } : {}),
});
export const grantData = (
  grant: Grant<unknown>,
  operation: (
    name: string,
    op: ValueOperation<unknown>,
  ) => object = operationData,
) => ({
  capability: grant.capability.name,
  operations: [...grant.ops]
    .sort(compareText)
    .map(name => operation(name, grant.capability.operations.get(name)!)),
});
/** Operation Data plus the manifest-only documentation fields. */
const documentedOperation = (name: string, op: ValueOperation<unknown>) => ({
  ...operationData(name, op),
  ...(op.description ? { description: op.description } : {}),
  ...(op.examples?.length ? { examples: op.examples } : {}),
});
export const canonicalJSON = (value: unknown): string => {
  if (typeof value === 'string') {
    return quoteJSON(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${quoteJSON(k)}:${canonicalJSON(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const byName = <T extends { name: string }>(values: readonly T[]): T[] =>
  [...values].sort((a, b) => compareText(a.name, b.name));
const costData = (cost?: { alloc?: number; fuel: number }) => ({
  fuel: cost?.fuel ?? 0,
  alloc: cost?.alloc ?? 0,
});
const needsData = (needs: readonly OperationRef[]) =>
  [...needs]
    .sort(
      (a, b) =>
        compareText(a.capability, b.capability) ||
        compareText(a.operation, b.operation),
    )
    .map(({ capability, operation }) => ({ capability, operation }));

/** Chapter 9's deterministic JSON file, ending in LF; never calls the Host. */
export const exportManifest = (m: ManifestSpec): string => {
  if (m.ownerKind && !(m.objectKinds ?? []).includes(m.ownerKind)) {
    throw new HostError('invalid value', 'ownerKind is not in objectKinds');
  }
  return `${canonicalJSON({
    kind: m.kind,
    version: m.version,
    language: languageVersion,
    grants: Object.entries(m.grants)
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, grant]) => ({
        name,
        ...grantData(grant, documentedOperation),
      })),
    libraries: byName(m.libraries ?? []).map(l => ({
      name: l.name,
      version: l.version,
      source: l.source,
      needs: needsData(l.needs),
    })),
    messages: byName(m.messages ?? []).map(message => ({
      name: message.name,
      args: (message.args ?? []).map(shapeData),
      receivers: byName(message.receivers ?? []).map(kind => kind.name),
      ...(message.description ? { description: message.description } : {}),
      ...(message.examples?.length ? { examples: message.examples } : {}),
    })),
    objectKinds: byName(m.objectKinds ?? []).map(kind => ({
      name: kind.name,
      props: [...kind.props]
        .sort(([a], [b]) => compareText(a, b))
        .map(([name, prop]) => ({
          name,
          shape: prop.shape ? shapeData(prop.shape) : 'value',
          readOnly: !prop.set,
          getCost: costData(prop.getCost),
          setCost: costData(prop.setCost),
        })),
      parentKinds: [...kind.parentKinds].sort(compareText),
      ...(kind.elements
        ? {
            elements: {
              shape: shapeData(kind.elements.shape),
              countCost: costData(kind.elements.countCost),
              atCost: costData(kind.elements.atCost),
              findCost: costData(kind.elements.findCost),
            },
          }
        : {}),
    })),
    objects: Object.entries(m.objects ?? {})
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, kind]) => ({ name, kind: kind.name })),
    ...(m.ownerKind ? { ownerKind: m.ownerKind.name } : {}),
  })}\n`;
};

/** A Shape from its Host Manifest data, as `shapeData` writes it. */
export const shapeOf = (data: unknown): Shape => {
  if (typeof data === 'string') {
    return data === 'any'
      ? { k: 'any' }
      : data === 'value'
        ? { k: 'value' }
        : { k: 'kind', kind: data };
  }
  const d = data as Record<string, unknown>;
  if (typeof d.object === 'string') {
    return { k: 'object', kind: d.object };
  }
  if (typeof d.quantity === 'string') {
    return { k: 'quantity', unit: d.quantity };
  }
  if (typeof d.unitKind === 'string') {
    return { k: 'unitKind', kind: d.unitKind };
  }
  if ('list' in d) {
    return { k: 'list', of: shapeOf(d.list) };
  }
  if (Array.isArray(d.oneOf)) {
    return { k: 'oneOf', of: d.oneOf.map(shapeOf) };
  }
  if ('optional' in d) {
    return { k: 'optional', of: shapeOf(d.optional) };
  }
  if (Array.isArray(d.map)) {
    return {
      k: 'map',
      fields: (
        d.map as { key: string; optional?: boolean; shape: unknown }[]
      ).map(f => ({
        key: f.key,
        optional: f.optional === true,
        shape: shapeOf(f.shape),
      })),
      open: d.open === true,
    };
  }
  throw new HostError('invalid save');
};

/**
 * A Grant's Operations from their Host Manifest data, as a save keeps them:
 * their shapes and declared costs, with no Host functions.
 */
export const operationsOf = (
  json: string,
): { capability: string; operations: Map<string, ValueOperation<unknown>> } => {
  let data: { capability: string; operations: Record<string, unknown>[] };
  try {
    data = JSON.parse(json);
  } catch {
    throw new HostError('invalid save');
  }
  if (
    !data ||
    typeof data.capability !== 'string' ||
    !Array.isArray(data.operations)
  ) {
    throw new HostError('invalid save');
  }
  return {
    capability: data.capability,
    operations: new Map(
      data.operations.map(op => {
        const cost = op.cost as { alloc: number; fuel: number };
        const errors = op.errors as
          | {
              code: string;
              fields: { key: string; optional?: boolean; shape: unknown }[];
            }[]
          | undefined;
        const scope = op.scope as
          { abandon: string; opens: string } | { closes: string } | undefined;
        const decl = {
          mode: op.mode,
          args: (op.args as unknown[]).map(shapeOf),
          ...(Array.isArray(op.labels) ? { labels: op.labels } : {}),
          ...(op.result === undefined ? {} : { result: shapeOf(op.result) }),
          cost: { fuel: cost.fuel, alloc: cost.alloc },
          ...(typeof op.maxPending === 'number'
            ? { maxPendingMs: op.maxPending }
            : {}),
          ...(errors
            ? {
                errors: errors.map(e => ({
                  code: e.code,
                  fields: Object.fromEntries(
                    e.fields.map(f => [
                      f.key,
                      f.optional
                        ? { optional: true, shape: shapeOf(f.shape) }
                        : shapeOf(f.shape),
                    ]),
                  ),
                })),
              }
            : {}),
          ...(scope ? { scope } : {}),
          ...(op.segmentBound ? { segmentBound: true } : {}),
          ...(op.command ? { command: true } : {}),
        } as unknown as ValueOperation<unknown>;
        return [op.name as string, decl];
      }),
    ),
  };
};
