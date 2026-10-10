/** A dictionary of each Grant's Operations, read from a Host Manifest, for
 * LSP hover and completion and the Playground's Dictionary panel. Nothing it
 * produces is normative (ADR 0028). */
import type { Shape } from '@odgn/northtalk';
import {
  readManifest,
  type HostManifest,
  type ManifestOperation,
} from './lsp/manifest';

export type DictionaryFormat = 'markdown' | 'plaintext';
export type DictionaryOperation = {
  /** The one-line call its mode allows, with argument Shapes as placeholders. */
  call: string;
  /** Facts about the call: mode, result, cost, errors, scope, Segment binding. */
  facts: string[];
  mode: ManifestOperation['mode'];
  name: string;
};
export type DictionaryGrant = {
  capability: string;
  name: string;
  operations: DictionaryOperation[];
};

const grouped = (shape: Shape): string =>
  shape.k === 'oneOf' ? `(${shapeText(shape)})` : shapeText(shape);

/** A Shape as readable text, such as `list of text` or `{id: number, …}`. */
export const shapeText = (shape: Shape): string => {
  switch (shape.k) {
    case 'any':
    case 'value':
      return shape.k;
    case 'kind':
      return shape.kind;
    case 'object':
      return `${shape.kind} object`;
    case 'quantity':
      return `quantity in ${shape.unit}`;
    case 'unitKind':
      return `${shape.kind} quantity`;
    case 'list':
      return `list of ${grouped(shape.of)}`;
    case 'optional':
      return `optional ${grouped(shape.of)}`;
    case 'oneOf':
      return shape.of.map(grouped).join(' or ');
    case 'map':
      return `{${[
        ...shape.fields.map(
          f => `${f.key}${f.optional ? '?' : ''}: ${shapeText(f.shape)}`,
        ),
        ...(shape.open ? ['…'] : []),
      ].join(', ')}}`;
  }
};

/** `tell g to op …`, `ask g to op …` or `ask g to op … and wait`. */
export const callForm = (grant: string, op: ManifestOperation): string => {
  const args = op.args
    .map(a =>
      a.k === 'optional' ? `[‹${shapeText(a.of)}›]` : `‹${shapeText(a)}›`,
    )
    .join(', ');
  const verb = op.mode === 'fire-and-forget' ? 'tell' : 'ask';
  const wait = op.mode === 'suspending' ? ' and wait' : '';
  return `${verb} ${grant} to ${op.name}${args ? ` ${args}` : ''}${wait}`;
};

const errorText = (value: unknown): string => {
  const error = value as { code: string; fields?: { key: string }[] };
  const fields = (error.fields ?? []).map(f => f.key);
  return `${error.code}${fields.length ? ` (${fields.join(', ')})` : ''}`;
};

const facts = (op: ManifestOperation): string[] => {
  const out = [
    op.mode === 'suspending'
      ? `Suspending: a Suspension Point that waits at most ${op.maxPending === undefined ? "the Script's MaxWait" : `${op.maxPending} ms (maxPending)`}`
      : op.mode === 'immediate'
        ? 'Immediate: answers at the call'
        : 'Fire-and-forget: runs at the call, and its result is dropped',
  ];
  if (op.result && op.mode !== 'fire-and-forget') {
    out.push(`Result: ${shapeText(op.result)}`);
  }
  if (op.cost) {
    out.push(
      `Cost per call: ${op.cost.fuel} Fuel${op.cost.alloc ? `, ${op.cost.alloc} allocation` : ''}`,
    );
  }
  const errors = op.declaration.errors;
  if (Array.isArray(errors)) {
    out.push(
      `Errors: ${errors.length ? errors.map(errorText).join(', ') : 'none declared'}`,
    );
  }
  if (op.scope) {
    out.push(
      'closes' in op.scope
        ? `Scope: closes ${op.scope.closes}`
        : `Scope: opens ${op.scope.opens}, abandoned by ${op.scope.abandon}`,
    );
  }
  if (op.segmentBound) {
    out.push('Segment-bound: commits or rolls back with the Segment');
  }
  return out;
};

export const dictionaryOperation = (
  grant: string,
  op: ManifestOperation,
): DictionaryOperation => ({
  name: op.name,
  mode: op.mode,
  call: callForm(grant, op),
  facts: facts(op),
});

/** Each Grant with its Operations, in the manifest's order, which is by name. */
export const dictionaryOf = (manifest: HostManifest): DictionaryGrant[] =>
  [...manifest.grants].map(([name, operations]) => ({
    name,
    capability: manifest.capabilities.get(name) ?? name,
    operations: [...operations.values()].map(op =>
      dictionaryOperation(name, op),
    ),
  }));

/** Read a manifest's dictionary, or `[]` when there is no valid manifest. */
export const readDictionary = (manifest: unknown): DictionaryGrant[] => {
  try {
    return manifest == null ? [] : dictionaryOf(readManifest(manifest));
  } catch {
    return [];
  }
};

/** One Operation's entry, as LSP hover and completion documentation show it. */
export const operationText = (
  op: DictionaryOperation,
  format: DictionaryFormat,
): string =>
  format === 'markdown'
    ? `\`\`\`northtalk\n${op.call}\n\`\`\`\n\n${op.facts.map(f => `- ${f}`).join('\n')}`
    : [op.call, ...op.facts.map(f => `  ${f}`)].join('\n');

/** The whole dictionary, for the LSP's `northtalk/dictionary` request. */
export const dictionaryText = (
  grants: readonly DictionaryGrant[],
  format: DictionaryFormat,
): string => {
  if (!grants.length) {
    return format === 'markdown'
      ? '# Dictionary\n\nNo Host Manifest, so no Grants to show.\n'
      : 'No Host Manifest, so no Grants to show.\n';
  }
  const sections = grants.map(grant => {
    const title =
      grant.capability === grant.name
        ? grant.name
        : `${grant.name} (${grant.capability})`;
    const ops = grant.operations.map(op =>
      format === 'markdown'
        ? `### ${op.name}\n\n${operationText(op, format)}`
        : operationText(op, format),
    );
    return format === 'markdown'
      ? [`## ${title}`, ...ops].join('\n\n')
      : [title, ...ops.map(o => o.replaceAll(/^/gm, '  '))].join('\n');
  });
  return format === 'markdown'
    ? `# Dictionary\n\n${sections.join('\n\n')}\n`
    : `${sections.join('\n\n')}\n`;
};
