// Object Kinds of property receivers, from the Host Manifest. Shared by the
// LSP and the Lints, so it reads the semantic tree alone.
import type { SemanticElement, SemanticNode } from '@northtalk/ts';
import type { HostManifest } from './manifest';

/** Strip only expression wrappers and parentheses, never a call or lookup. */
export const expression = (node: SemanticNode): SemanticElement => {
  let current: SemanticElement = node;
  while (current.kind === 'node') {
    const children: SemanticElement[] = current.children.filter(
      c => c.kind !== 'token' || (c.text !== '(' && c.text !== ')'),
    );
    if (children.length !== 1) {
      break;
    }
    current = children[0]!;
  }
  return current;
};

export const namedKind = (node: SemanticNode, manifest: HostManifest) => {
  const name = expression(node);
  if (name.kind === 'token' && name.text === 'me') {
    return manifest.ownerKind;
  }
  // Binding identity matters: a same-spelled parameter/local is not the Host
  // Object. Do not propagate kinds through assignments, calls or properties.
  return name.kind === 'name' && name.binding?.kind === 'object'
    ? manifest.objectsKinds.get(name.text)
    : undefined;
};

export const word = (e: SemanticElement | undefined, text: string) =>
  e?.kind === 'token' && e.text === text;
/** The message a Handler handles, or undefined for a Fallback Handler. */
const handled = (handler: SemanticNode) => {
  const name = handler.children.find(
    (c): c is SemanticNode => c.kind === 'node' && c.rule === 'MessageName',
  );
  let e: SemanticElement | undefined = name;
  while (e?.kind === 'node') {
    e = e.children[0];
  }
  return e?.text;
};

/**
 * The possible kinds of `the target` at a span: the kinds its Handler's
 * message is delivered to, or the Owner Kind for a Script-addressed
 * message. Unknown (empty) in a Fallback Handler, a Handler for an
 * undeclared message, and outside a Handler.
 */
export const targetKinds = (
  nodes: readonly SemanticElement[],
  at: SemanticNode,
  manifest: HostManifest,
): string[] => {
  const handler = nodes.find(
    (n): n is SemanticNode =>
      n.kind === 'node' &&
      n.rule === 'Handler' &&
      n.span.start <= at.span.start &&
      at.span.end <= n.span.end,
  );
  const name = handler && handled(handler);
  const message =
    name === undefined ? undefined : manifest.messageDecls.get(name);
  if (!message) {
    return [];
  }
  if (message.receivers?.length) {
    return message.receivers;
  }
  return manifest.ownerKind === undefined ? [] : [manifest.ownerKind];
};

/** The possible kinds of a property's receiver: `the target`, `me` or a well-known object. */
export const receiverKinds = (
  receiver: SemanticNode,
  manifest: HostManifest,
  nodes: readonly SemanticElement[],
): string[] => {
  const value = expression(receiver);
  if (
    value.kind === 'node' &&
    value.rule === 'The' &&
    value.children.length === 2 &&
    word(value.children[0], 'the') &&
    word(value.children[1], 'target')
  ) {
    return targetKinds(nodes, value, manifest);
  }
  const kind = namedKind(receiver, manifest);
  return kind === undefined ? [] : [kind];
};

/**
 * A `the <word> of <receiver>` read whose receiver has known Object Kinds:
 * `the target`, a well-known object, or `me` under an Owner Kind. Computed
 * keys and collection reads are left out. `nodes` is every element of the
 * tree, to find the Handler around `the target`.
 */
export const propertyRead = (
  node: SemanticNode,
  manifest: HostManifest,
  nodes: readonly SemanticElement[],
) => {
  const [head, key, of, receiver] = node.children;
  if (
    node.rule !== 'The' ||
    node.children.length !== 4 ||
    !word(head, 'the') ||
    !word(of, 'of') ||
    key?.kind !== 'node' ||
    key.rule !== 'Key' ||
    key.children.length !== 1 ||
    key.children[0]!.kind !== 'token' ||
    receiver?.kind !== 'node'
  ) {
    return undefined;
  }
  const kinds = receiverKinds(receiver, manifest, nodes).flatMap(k => {
    const kind = manifest.objectKinds.get(k);
    return kind ? [kind] : [];
  });
  const name = key.children[0]!;
  if (!kinds.length || !/^[\p{L}_]/u.test(name.text)) {
    return undefined;
  }
  return {
    /** Each possible kind that declares the property, with its declaration. */
    found: kinds.flatMap(kind => {
      const prop = kind.props.get(name.text);
      return prop ? [{ kind, prop }] : [];
    }),
    kinds,
    name: name.text,
    key: name,
  };
};
