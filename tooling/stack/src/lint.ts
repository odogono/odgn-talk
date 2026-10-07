// Chapter 12 / ADR 0027: advice over the lossless Core tree, never load errors.
import {
  canConvert,
  checkSyntax,
  exportsOf,
  parseSourceRecovering,
  text,
  type CheckOptions,
  type LibraryExport,
  type SemanticTree,
  type SourceSpan,
  type SyntaxNode,
  type Token,
} from '@odgn/northtalk';
import {
  advancedTags,
  lintCatalogue,
  longJoinBodyLines,
  properties,
} from './generated/lints';
import { lintBindings } from './lint-bindings';
import { grantDeclarations, type HostManifest } from './lsp/manifest';
export { lintCatalogue } from './generated/lints';
export { readManifest, type HostManifest } from './lsp/manifest';

export type LintProfile = 'beginner' | 'standard';
export type LintLevel = 'off' | 'hint' | 'warning';
export type LintId = (typeof lintCatalogue)[number]['id'];
export type Lint = {
  id: LintId;
  level: Exclude<LintLevel, 'off'>;
  message: string;
  span: SourceSpan;
};
export type LintOptions = {
  /** Bindings already checked from this syntax tree, for editor callers. */
  bindings?: SemanticTree;
  checkOptions?: CheckOptions;
  manifest?: HostManifest | null;
  profile?: LintProfile;
};

// Manifests carry Library source, not executable Host callbacks. Infer export
// kinds/contracts through the Core checker without loading or running it.
const bindingTree = (tree: SyntaxNode, options: LintOptions): SemanticTree => {
  if (options.bindings) {
    return options.bindings;
  }
  const manifest = options.manifest;
  let libraries: Record<string, Record<string, LibraryExport>> = {};
  const sources = (manifest?.libraries ?? []).map(library => ({
    ...library,
    tree: parseSourceRecovering(library.source).tree,
  }));
  for (let pass = 0; pass <= sources.length; pass++) {
    const next = Object.fromEntries(
      sources.map(library => [
        library.name,
        exportsOf(
          checkSyntax(library.tree, { unit: 'library', libraries }).tree,
        ),
      ]),
    );
    if (JSON.stringify(next) === JSON.stringify(libraries)) {
      break;
    }
    libraries = next;
  }
  return checkSyntax(tree, {
    ...(manifest
      ? {
          libraries,
          grants: grantDeclarations(manifest),
          objects: manifest.objects,
        }
      : {}),
    ...options.checkOptions,
  }).tree;
};

const nodes = (node: SyntaxNode) =>
  node.children.filter((child): child is SyntaxNode => child.kind === 'node');
const tokens = (node: SyntaxNode) =>
  node.children.filter(
    (child): child is Token =>
      child.kind === 'token' && child.t !== 'nl' && child.t !== 'eof',
  );
const tokensIn = (root: SyntaxNode, includeLineEndings = false): Token[] => {
  const out: Token[] = [];
  const work = [...root.children].reverse();
  while (work.length) {
    const child = work.pop()!;
    if (child.kind === 'node') {
      if (includeLineEndings || child.rule !== 'Error') {
        for (let i = child.children.length - 1; i >= 0; i--) {
          work.push(child.children[i]!);
        }
      }
    } else if (includeLineEndings || (child.t !== 'nl' && child.t !== 'eof')) {
      out.push(child);
    }
  }
  return out;
};

const literalText = (node: SyntaxNode): Token | undefined => {
  const content = tokensIn(node).filter(
    token => token.v !== '(' && token.v !== ')',
  );
  return content.length === 1 && content[0]!.t === 'str'
    ? content[0]
    : undefined;
};

// Postorder summaries keep deeply nested syntax off the native call stack.
// Malformed expressions are opaque, but their enclosing blocks retain siblings.
type Summary = { first?: Token; last?: Token; malformed: boolean };
const index = (root: SyntaxNode) => {
  const order: SyntaxNode[] = [];
  const work = [root];
  while (work.length) {
    const node = work.pop()!;
    order.push(node);
    if (node.rule !== 'Error') {
      for (const child of nodes(node)) {
        work.push(child);
      }
    }
  }
  const summaries = new Map<SyntaxNode, Summary>();
  for (const node of order.reverse()) {
    const summary: Summary = { malformed: node.rule === 'Error' };
    for (const child of node.children) {
      if (child.kind === 'node') {
        const inner = summaries.get(child);
        // A body owns statement recovery; errors there do not invalidate
        // the Lambda/Handler/expression that encloses the whole body.
        if (child.rule !== 'Block' && child.rule !== 'Body') {
          summary.malformed ||= inner?.malformed ?? true;
        }
        summary.first ??= inner?.first;
        summary.last = inner?.last ?? summary.last;
      } else if (child.t !== 'nl' && child.t !== 'eof') {
        summary.first ??= child;
        summary.last = child;
      }
    }
    summaries.set(node, summary);
  }
  return summaries;
};

const blockRules = new Set([
  'Source',
  'Entry',
  'Declaration',
  'Handler',
  'Function',
  'Lambda',
  'Block',
  'Body',
  'Statement',
  'If',
  'Repeat',
  'Match',
  'Try',
  'OfferClause',
  'Wait',
]);
const propertyNames = new Set<string>(properties);
const catalogue = new Map(lintCatalogue.map(entry => [entry.id, entry]));
type Context = {
  argument: boolean;
  binarySize: boolean;
  conditional: boolean;
  join: boolean;
  map: boolean;
};

/** Lint an existing lossless tree. Error regions remain opaque; positions are original source spans. */
export const lintSyntax = (
  tree: SyntaxNode,
  options: LintOptions = {},
): Lint[] => {
  const { profile = 'standard' } = options;
  const summaries = index(tree);
  const lints: Lint[] = [];
  const emitted = new Set<string>();
  const tokensInLine = new Set<number>();
  const suppressed = new Map<number, Set<string>>();
  for (const token of tokensIn(tree, true)) {
    for (const trivia of token.leadingTrivia) {
      const match =
        trivia.kind === 'comment' &&
        /^-- lint: ignore ([a-z]+(?:-[a-z]+)*)\s*$/.exec(trivia.raw);
      // Only a standalone directive counts. The lossless trivia has its column,
      // but indentation can precede it, so check earlier tokens on that line.
      if (match && !tokensInLine.has(trivia.line)) {
        const ids = suppressed.get(trivia.line + 1) ?? new Set<string>();
        ids.add(match[1]!);
        suppressed.set(trivia.line + 1, ids);
      }
    }
    if (token.t !== 'nl' && token.t !== 'eof') {
      tokensInLine.add(token.line);
    }
  }
  const emitAt = (
    id: LintId,
    span: SourceSpan,
    params: Record<string, string | number> = {},
  ) => {
    const entry = catalogue.get(id)!;
    const level = entry[profile];
    const key = `${id}:${span.start}`;
    if (
      level === 'off' ||
      suppressed.get(span.line)?.has(id) ||
      emitted.has(key)
    ) {
      return;
    }
    emitted.add(key);
    lints.push({
      id,
      level,
      message: entry.message.replaceAll(/{([a-z]+)}/g, (_, key: string) =>
        String(params[key] ?? `{${key}}`),
      ),
      span,
    });
  };
  const emit = (
    id: LintId,
    at: Token,
    params?: Record<string, string | number>,
  ) =>
    emitAt(
      id,
      { start: at.pos, end: at.end, line: at.line, col: at.col },
      params,
    );
  const advanced = (construct: string, at: Token) => {
    // This is a syntax-to-tag lookup, not a classification list. Only tags
    // generated from grammar.toml enable advice or supply its replacement.
    const tag = advancedTags.find(tag => tag.construct === construct);
    if (tag) {
      emit('advanced-construct', at, {
        construct: tag.construct,
        beginner: tag.beginner,
      });
    }
  };
  const work: { context: Context; node: SyntaxNode }[] = [
    {
      node: tree,
      context: {
        argument: false,
        binarySize: false,
        conditional: false,
        join: false,
        map: false,
      },
    },
  ];
  while (work.length) {
    const { node, context } = work.pop()!;
    const summary = summaries.get(node)!;
    if (
      node.rule === 'Error' ||
      (summary.malformed && !blockRules.has(node.rule))
    ) {
      continue;
    }
    const direct = tokens(node);
    const children = nodes(node);
    const first = summary.first;
    if (!first) {
      continue;
    }
    const endIndex = direct.findIndex(
      token => token.t === 'word' && token.v === 'end',
    );
    const ending = direct[endIndex];
    const isJoin =
      node.rule === 'Wait' &&
      direct
        .slice(0, 3)
        .map(token => token.v)
        .join(' ') === 'wait for all';

    if (
      ending &&
      [
        'Handler',
        'Function',
        'Lambda',
        'If',
        'Repeat',
        'Match',
        'Try',
        'Wait',
      ].includes(node.rule) &&
      (!direct[endIndex + 1] || direct[endIndex + 1]!.line !== ending.line)
    ) {
      let suffix = first.v;
      if (node.rule === 'Handler' || node.rule === 'Function') {
        const name = children.find(
          child => child.rule === 'MessageName' || child.rule === 'Name',
        );
        suffix = name ? summaries.get(name)!.first!.v : suffix;
        // A Fallback Handler closes with `end any message` (ADR 0064).
        if (!name && direct[1]?.v === 'any' && direct[2]?.v === 'message') {
          suffix = 'any message';
        }
      }
      emit('prefer-explicit-end', ending, { ending: suffix });
    }
    if (isJoin && ending) {
      const lines = ending.line - first.line - 1;
      if (lines > longJoinBodyLines) {
        emit('long-join-body', first, { lines, threshold: longJoinBodyLines });
      }
    }
    if (node.rule === 'Send' && context.join) {
      const waiting = children.some(
        child => child.rule === 'AndWait' && tokens(child).length > 0,
      );
      if (!waiting) {
        emit('plain-send-in-join', first);
      } else if (context.conditional) {
        emit('conditional-join-member', first);
      }
    }
    if (
      node.rule === 'AskTell' &&
      first.v === 'ask' &&
      context.join &&
      context.conditional &&
      children.some(
        child => child.rule === 'AndWait' && tokens(child).length > 0,
      )
    ) {
      emit('conditional-join-member', first);
    }
    if (
      node.rule === 'Lambda' &&
      children.some(child => child.rule === 'Block') &&
      context.argument
    ) {
      emit('inline-block-lambda', first);
    }
    if (
      node.rule === 'Comparison' &&
      direct.some(token =>
        [
          '=',
          '<>',
          '<',
          '>',
          '<=',
          '>=',
          'is',
          'contains',
          'begins',
          'ends',
        ].includes(token.v),
      ) &&
      !children.some(
        child => child.rule === 'IgnoringCase' && tokens(child).length > 0,
      )
    ) {
      // Two operands exclude emptiness/kind tests. Only a literal operand
      // establishes text intent; text nested within a call need not be text
      // that the comparison itself sees.
      const operands = children.filter(child => child.rule === 'Concat');
      if (
        operands.length === 2 &&
        operands.some(operand => {
          const literal = literalText(operand);
          return literal && /\p{L}/u.test(literal.v);
        })
      ) {
        emit('suggest-ignoring-case', direct[0]!);
      }
    }
    if (
      (node.rule === 'Or' || node.rule === 'And') &&
      direct.some(token => token.v === 'or' || token.v === 'and')
    ) {
      const lastChild = children.at(-1);
      const tail = lastChild && summaries.get(lastChild)!.last;
      // Parentheses end with ')', making the nearest comparison explicit.
      if (tail?.v === 'case') {
        const all = tokensIn(lastChild!);
        const modifier = all.at(-2);
        if (
          modifier?.v === 'ignoring' &&
          !lints.some(
            item =>
              item.id === 'ambiguous-ignoring-case' &&
              item.span.start === modifier.pos,
          )
        ) {
          emit('ambiguous-ignoring-case', modifier);
        }
      }
    }
    if (node.rule === 'Match') {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!;
        if (child.kind === 'token' && child.v === 'when') {
          const next = node.children[i + 1];
          if (
            next?.kind === 'node' &&
            next.rule === 'Pattern' &&
            !summaries.get(next)!.malformed
          ) {
            const pattern = tokensIn(next);
            // A lone text element has no whole-value anchors or captures to
            // communicate intent. Other Text Patterns remain unflagged.
            if (
              pattern.length === 3 &&
              pattern[0]!.t === 'patopen' &&
              pattern[1]!.t === 'str' &&
              pattern[2]!.t === 'patclose'
            ) {
              emit('whole-value-when', child);
            }
          }
        }
      }
    }
    if (node.rule === 'MapKey' && context.map && propertyNames.has(first.v)) {
      emit('key-shadows-property', first, { key: first.v });
    }
    if (node.rule === 'Conversion') {
      // Each direct `as` has its own Kind node. Only a literal first operand
      // is known; after any earlier conversion its value needs evaluation.
      const asIndex = node.children.findIndex(
        child => child.kind === 'token' && child.v === 'as',
      );
      if (asIndex >= 0) {
        const kind = node.children[asIndex + 1];
        const name =
          kind?.kind === 'node' && kind.rule === 'Kind'
            ? tokens(kind)
                .map(token => token.v)
                .join(' ')
            : '';
        const operand = node.children[0];
        const literal =
          operand?.kind === 'node' ? literalText(operand) : undefined;
        if (
          (name === 'civil date' || name === 'instant') &&
          literal &&
          !canConvert(text(literal.v), name).asBool()
        ) {
          emit('unconvertible-literal', literal, { kind: name });
        }
      }
    }
    if (node.rule === 'PatternPrimary' && first.v === '^') {
      advanced('The pin', first);
    }
    if (
      node.rule === 'FieldType' ||
      (context.binarySize && node.rule === 'Primary')
    ) {
      for (const token of direct) {
        if (token.t === 'op' && token.v === '^') {
          advanced('A pinned Binary Pattern size', token);
        }
      }
    }
    if (node.rule === 'Chunk' && first.v === 'code') {
      advanced('The `code point` chunk', first);
    }
    if (node.rule === 'The' && direct.some(token => token.v === 'point')) {
      advanced(
        'The `code point` chunk',
        direct.find(token => token.v === 'code')!,
      );
    }
    if (
      node.rule === 'Key' &&
      direct.map(token => token.v).join(' ') === 'code points'
    ) {
      advanced('The `code points` property', first);
    }
    if (node.rule === 'OfferClause') {
      advanced('A Recovery Offer', first);
    }
    if (node.rule === 'RecoveryMarker') {
      advanced('A Recovery Catch', first);
    }
    if (node.rule === 'ChooseOffer') {
      advanced('An offer choice', first);
    }
    if (node.rule === 'Send' && direct[1]?.v === '(') {
      advanced('A computed message name', direct[1]);
    }
    if (node.rule === 'Send') {
      const list = children.find(child => child.rule === 'ExpressionList');
      const spread = list && tokens(list).find(token => token.v === '...');
      if (spread) {
        advanced('A spread in `send … with`', spread);
      }
    }
    if (node.rule === 'Element') {
      for (const token of direct) {
        if (token.v === 'lazily') {
          advanced('`lazily`', token);
        }
      }
    }

    const boundary =
      node.rule === 'Lambda' ||
      node.rule === 'Handler' ||
      node.rule === 'Function';
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      const body =
        child.rule === 'Block' ||
        child.rule === 'Body' ||
        child.rule === 'SimpleStatement';
      work.push({
        node: child,
        context: {
          argument:
            node.rule === 'ExpressionList'
              ? true
              : boundary
                ? false
                : context.argument,
          binarySize: node.rule === 'FieldType' ? true : context.binarySize,
          conditional:
            boundary || isJoin
              ? false
              : context.conditional || (node.rule === 'If' && body),
          join: boundary ? false : isJoin && body ? true : context.join,
          map:
            node.rule === 'Map'
              ? true
              : node.rule === 'PatternPrimary'
                ? false
                : context.map,
        },
      });
    }
  }
  lintBindings(
    bindingTree(tree, options),
    options.manifest,
    emitAt,
    options.checkOptions?.unit,
  );
  return lints.sort(
    (a, b) => a.span.start - b.span.start || a.id.localeCompare(b.id),
  );
};

/** Parse an edited Script and return syntax diagnostics separately from advice. */
export const lint = (source: string, options: LintOptions = {}) => {
  const parsed = parseSourceRecovering(source);
  return {
    lints: lintSyntax(parsed.tree, options),
    diagnostics: parsed.diagnostics,
  };
};
