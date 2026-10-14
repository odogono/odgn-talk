// Recipes produce ordinary source. Placement is derived from the Core's lossless
// parse, never from a textual search for a handler or its closing `end`.
import {
  parseSource,
  type SyntaxElement,
  type SyntaxNode,
  type Token,
} from '@odgn/northtalk';
import type { Element, Project } from './model';
import { scriptPage, type ScriptOwner } from './script-manifest';
import { isSoundAsset } from './sounds';

export type RecipeKind =
  | 'navigate'
  | 'show'
  | 'hide'
  | 'text'
  | 'playSound'
  | 'loopSound'
  | 'stopSound';
export const SOUND_RECIPE_KINDS: readonly RecipeKind[] = [
  'playSound',
  'loopSound',
  'stopSound',
];
export type RecipeTarget = {
  name: string;
  property?: 'label' | 'text';
  reference: string;
};
export const recipeTargets = (
  project: Project,
  owner: ScriptOwner,
  kind: RecipeKind,
): RecipeTarget[] => {
  if (kind === 'navigate') {
    return project.pages.map(page => ({
      name: page.name,
      reference: page.name,
    }));
  }
  if (SOUND_RECIPE_KINDS.includes(kind)) {
    const sounds = project.assets
      .filter(isSoundAsset)
      .map(asset => ({ name: asset.name, reference: asset.name }));
    // The empty reference is `tell sound to stop`: all the owner's sounds.
    return kind === 'stopSound'
      ? [{ name: 'All sounds this Script started', reference: '' }, ...sounds]
      : sounds;
  }
  return (scriptPage(project, owner)?.elements ?? [])
    .filter(
      element =>
        kind !== 'text' || element.kind === 'button' || element.kind === 'text',
    )
    .map((element: Element) => ({
      name: element.name,
      reference: element === owner ? 'me' : element.name,
      ...(element.kind === 'button'
        ? { property: 'label' as const }
        : element.kind === 'text'
          ? { property: 'text' as const }
          : {}),
    }));
};

/** Ordinary literals have no escapes. Backticks safely encode every special character. */
export const recipeText = (value: string): string => {
  if (!/["\r\n]/u.test(value)) {
    return `"${value}"`;
  }
  return (
    '`' +
    value.replaceAll(
      /\\|`|\$|\r|\n|\t/gu,
      char =>
        ({
          '\\': '\\\\',
          '`': '\\`',
          $: String.raw`\$`,
          '\r': String.raw`\r`,
          '\n': String.raw`\n`,
          '\t': String.raw`\t`,
        })[char]!,
    ) +
    '`'
  );
};
export const recipeSource = (
  kind: RecipeKind,
  target: RecipeTarget,
  value = '',
): string => {
  if (kind === 'navigate') {
    return `tell pages to show ${target.reference}`;
  }
  if (kind === 'playSound' || kind === 'loopSound') {
    return `tell sound to ${kind === 'playSound' ? 'play' : 'loop'} ${recipeText(target.reference)}`;
  }
  if (kind === 'stopSound') {
    return target.reference
      ? `tell sound to stop ${recipeText(target.reference)}`
      : 'tell sound to stop';
  }
  if (kind === 'text') {
    if (!target.property) {
      throw new Error('Choose a button or text Element.');
    }
    return `set the ${target.property} of ${target.reference} to ${recipeText(value)}`;
  }
  return `set the visible of ${target.reference} to ${kind === 'show' ? 'true' : 'false'}`;
};
const nodes = (node: SyntaxNode, rule: string): SyntaxNode[] =>
  node.children.flatMap(child =>
    child.kind === 'node'
      ? child.rule === rule
        ? [child]
        : nodes(child, rule)
      : [],
  );
const tokens = (node: SyntaxElement): Token[] =>
  node.kind === 'node' ? node.children.flatMap(tokens) : [node];
export type RecipePlacement =
  | { kind: 'new' }
  | { kind: 'cursor' }
  | { end: number; kind: 'simple'; start: number };
const simpleStatements = new Set([
  'set',
  'put',
  'tell',
  'ask',
  'wait',
  'add',
  'subtract',
  'multiply',
  'divide',
]);
export const recipePlacement = (source: string): RecipePlacement => {
  const parsed = parseSource(source);
  if (parsed.error) {
    return { kind: 'cursor' };
  }
  const handlers = nodes(parsed.tree, 'Handler').filter(handler => {
    const name = handler.children.find(
      child => child.kind === 'node' && child.rule === 'MessageName',
    );
    return name && tokens(name)[0]?.v === 'click';
  });
  if (!handlers.length) {
    return { kind: 'new' };
  }
  const handler = handlers[0]!;
  const block = handler.children.find(
    (child): child is SyntaxNode =>
      child.kind === 'node' && child.rule === 'Block',
  );
  const head = tokens(handler).filter(
    token => !block || token.pos < block.start,
  );
  // Restrict automatic positions to plain, zero-argument click handlers. Any
  // control flow (including nested returns) is deliberately left to the author.
  const complex =
    !block ||
    handlers.length !== 1 ||
    head
      .filter(token => token.t !== 'nl')
      .map(token => token.v)
      .join(' ') !== 'on click' ||
    handler.children.some(
      child => child.kind === 'token' && child.v === 'finally',
    ) ||
    nodes(block, 'Statement').some(statement => {
      const first = tokens(statement)[0];
      return !first || !simpleStatements.has(first.v);
    }) ||
    nodes(block, 'TellBlock').length > 0 ||
    nodes(block, 'TimeoutBlock').length > 0;
  if (complex || !block) {
    return { kind: 'cursor' };
  }
  // Block.end precedes the end token's leading trivia, keeping end comments intact.
  return { kind: 'simple', start: block.start, end: block.end };
};
export type RecipeEdit = { from: number; insert: string };
export const recipeEdit = (
  source: string,
  action: string,
  position: 'new' | 'start' | 'end' | 'cursor',
  cursor = 0,
): RecipeEdit => {
  const placement = recipePlacement(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  if (position === 'new' && placement.kind === 'new') {
    return {
      from: source.length,
      insert: `${source ? newline : ''}on click${newline}  ${action}${newline}end click${newline}`,
    };
  }
  if (
    (position === 'start' || position === 'end') &&
    placement.kind === 'simple'
  ) {
    return { from: placement[position], insert: `  ${action}${newline}` };
  }
  if (position !== 'cursor' || cursor < 0 || cursor > source.length) {
    throw new Error('Choose an insertion position again.');
  }
  return {
    from: cursor,
    insert: `${cursor && !/[\r\n]/u.test(source[cursor - 1]!) ? newline : ''}  ${action}${newline}`,
  };
};
