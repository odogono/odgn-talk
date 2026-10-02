// Operation Declarations in the Host Manifest's data model, shared by saves
// and Group Fingerprints. Bindings and executable Host functions stay out.
import type { Grant, Operation, Shape } from './capabilities';
import { quoteJSON } from './encoding';

export const shapeData = (shape: Shape): unknown => {
  switch (shape.k) {
    case 'any':
      return 'any';
    case 'kind':
      return shape.kind;
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
          .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
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
    .sort()
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
