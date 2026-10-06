import type { SemanticNode } from './semantic';

/** A catch body follows its pattern, optional recovery marker and optional Guard. */
export const recoveryBody = (parent: SemanticNode, index: number): boolean => {
  if (
    parent.rule !== 'Try' ||
    parent.children[index]?.kind !== 'node' ||
    (parent.children[index] as SemanticNode).rule !== 'Block'
  ) {
    return false;
  }
  for (let i = index - 1; i >= 0; i--) {
    const child = parent.children[i]!;
    if (child.kind === 'node' && child.rule === 'RecoveryMarker') {
      return true;
    }
    if (
      child.kind === 'token' &&
      ['catch', 'finally', 'try'].includes(child.text)
    ) {
      return false;
    }
    if (child.kind === 'node' && child.rule === 'Block') {
      return false;
    }
  }
  return false;
};
