import {
  checkSyntax,
  exportsOf,
  parseSourceRecovering,
  type SemanticNode,
} from '@northtalk/ts';
import { shapeText } from '../dictionary';
import { grantDeclarations, type HostManifest } from './manifest';
import {
  expression,
  namedKind,
  propertyRead,
  receiverKinds,
  word,
} from './properties';
import { rangeAt } from './protocol';
import { semanticElements, type Analysis } from './workspace';

const collectionRead = (node: SemanticNode) => {
  const [first, second, third, fourth] = node.children;
  const count =
    node.rule === 'The' &&
    second?.kind === 'node' &&
    second.rule === 'Key' &&
    word(second.children[0], 'number') &&
    word(fourth, 'elements');
  const element =
    (node.rule === 'Chunk' &&
      (word(first, 'element') || word(first, 'elements'))) ||
    (node.rule === 'The' && word(third, 'element'));
  const receiver = node.children.at(-1);
  return (element || count) && receiver?.kind === 'node'
    ? { receiver, count }
    : undefined;
};

const collection = (node: SemanticNode, manifest: HostManifest) => {
  const read = collectionRead(node);
  const kind = read && namedKind(read.receiver, manifest);
  const elements = kind && manifest.objectKinds.get(kind)?.elements;
  return elements ? { ...read, kind, elements } : undefined;
};

export const propertyHover = (
  analysis: Analysis,
  offset: number,
  manifest: HostManifest,
) => {
  for (const node of analysis.nodes) {
    const read = propertyRead(node, manifest, analysis.nodes);
    if (
      !read?.found.length ||
      offset < read.key.span.start ||
      read.key.span.end <= offset
    ) {
      continue;
    }
    return {
      contents: {
        kind: 'plaintext',
        value: read.found
          .map(
            ({ kind, prop }) =>
              `${kind.name} property ${read.name}${prop.readOnly ? ' (read-only)' : ''}${read.kinds.length > 1 ? ' (possible member)' : ''}\nShape: ${shapeText(prop.shape)}`,
          )
          .join('\n\n'),
      },
      range: rangeAt(
        analysis.document.text,
        read.key.span.start,
        read.key.span.end,
      ),
    };
  }
  return null;
};

export const collectionHover = (
  analysis: Analysis,
  offset: number,
  manifest: HostManifest,
) => {
  for (const node of analysis.nodes) {
    if (offset < node.span.start || node.span.end <= offset) {
      continue;
    }
    const read = collection(node, manifest);
    if (!read) {
      continue;
    }
    // Hover the reference's spelling, leaving selector/receiver names to their
    // own documentation. The count's `number` is held in a Key node.
    const head = node.children.find(
      c =>
        c.kind !== 'name' &&
        c !== read.receiver &&
        (c.kind !== 'node' || c.rule === 'Key') &&
        c.span.start <= offset &&
        offset < c.span.end,
    );
    if (head) {
      return {
        contents: {
          kind: 'plaintext',
          value: `${read.kind} Object Collection\nMembers: ${shapeText(read.elements.shape)}\nResult: ${read.count ? 'number' : shapeText({ k: 'optional', of: read.elements.shape })}`,
        },
        range: rangeAt(analysis.document.text, node.span.start, node.span.end),
      };
    }
  }
  return null;
};

/** Complete a property's receiver, including an empty or partial Key slot. */
export const objectProperties = (
  analysis: Analysis,
  offset: number,
  manifest: HostManifest,
  all: Map<string, Analysis>,
) => {
  const source = analysis.document.text;
  const before = source.slice(0, offset);
  const slot = /\bthe\s+([\p{L}\p{N}_]*)$/u.exec(before);
  const after = /^[\p{L}\p{N}_]*(\s+of\s+)/u.exec(source.slice(offset));
  if (!slot || !after) {
    return undefined;
  }
  // Repair just the Key so the shared parser, not a receiver regex, handles
  // parentheses, selectors and nested expression boundaries while editing.
  const start = offset - slot[1]!.length;
  const end = offset + after[0].length - after[1]!.length;
  const repaired = source.slice(0, start) + 'propertySlot' + source.slice(end);
  const checked = checkSyntax(parseSourceRecovering(repaired).tree, {
    libraries: Object.fromEntries(
      [...all.values()].flatMap(a =>
        a.document.library
          ? [[a.document.library, exportsOf(a.checked.tree)]]
          : [],
      ),
    ),
    ...(analysis.document.library
      ? {}
      : { grants: grantDeclarations(manifest), objects: manifest.objects }),
    unit: analysis.document.library ? 'library' : 'script',
  });
  const elements = semanticElements(checked.tree.root);
  const property = elements.find(
    (n): n is SemanticNode =>
      n.kind === 'node' && n.rule === 'The' && n.span.start === slot.index,
  );
  const receiver = property?.children.at(-1);
  if (receiver?.kind !== 'node') {
    return undefined;
  }
  const direct = receiverKinds(receiver, manifest, elements);
  const value = expression(receiver);
  const read = value.kind === 'node' ? collection(value, manifest) : undefined;
  const possible = read !== undefined || direct.length > 1;
  const kinds = direct.length
    ? direct
    : read && !read.count
      ? read.elements.kinds
      : [];
  if (!kinds.length) {
    return undefined;
  }
  // These are possible members, not a definite inferred result kind: even a
  // homogeneous collection can return Nothing. Never carry this into locals.
  const properties = new Map<string, string[]>();
  for (const kind of kinds) {
    for (const [name, prop] of manifest.objectKinds.get(kind)?.props ?? []) {
      if (name.startsWith(slot[1]!)) {
        const details = properties.get(name) ?? [];
        details.push(
          `${kind} property${prop.readOnly ? ' (read-only)' : ''}${possible ? ' (possible member)' : ''}`,
        );
        properties.set(name, details);
      }
    }
  }
  return [...properties].map(([label, details]) => ({
    label,
    kind: 10,
    detail: details.join('; '),
  }));
};
