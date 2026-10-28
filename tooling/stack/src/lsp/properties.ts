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
/**
 * A `the <word> of <receiver>` read whose receiver has a known Object Kind:
 * a well-known object, or `me` under an Owner Kind. Computed keys and
 * collection reads are left out.
 */
export const propertyRead = (node: SemanticNode, manifest: HostManifest) => {
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
  const kind = namedKind(receiver, manifest);
  const objectKind =
    kind === undefined ? undefined : manifest.objectKinds.get(kind);
  const name = key.children[0]!;
  return objectKind && /^[\p{L}_]/u.test(name.text)
    ? {
        kind: objectKind,
        name: name.text,
        key: name,
        prop: objectKind.props.get(name.text),
      }
    : undefined;
};
