// Operation Declarations in the Host Manifest's data model, shared by saves
// and Group Fingerprints. Bindings and executable Host functions stay out.
import type { Grant, Operation, Shape } from './capabilities';
import { quoteJSON } from './encoding';
import type { Library, OperationRef } from './library';
import type { ObjectKind } from './objects';
import { languageVersion } from './generated/machine';
import { compareText } from './text';

export type MessageDecl = {
  args?: readonly Shape[];
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
export const operationData = (name: string, op: Operation<unknown>) => ({
  name,
  mode: op.mode,
  args: (op.args ?? []).map(shapeData),
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
});
export const grantData = (grant: Grant<unknown>) => ({
  capability: grant.capability.name,
  operations: [...grant.ops]
    .sort(compareText)
    .map(name => operationData(name, grant.capability.operations.get(name)!)),
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
export const exportManifest = (m: ManifestSpec): string =>
  `${canonicalJSON({
    kind: m.kind,
    version: m.version,
    language: languageVersion,
    grants: Object.entries(m.grants)
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, grant]) => ({ name, ...grantData(grant) })),
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
    })),
    objects: Object.entries(m.objects ?? {})
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, kind]) => ({ name, kind: kind.name })),
  })}\n`;
