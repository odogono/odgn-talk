import {
  grammar,
  units,
  Lexer,
  parseSource,
  parseSourceRecovering,
  exportsOf,
  type Binding,
  type SemanticName,
  type SemanticNode,
  type SyntaxElement,
  type SyntaxNode,
  type Token,
} from '@odgn/northtalk';
import { formatSource } from '../format';
import {
  bindingKey,
  elements,
  semanticElements,
  type Analysis,
} from './workspace';
import {
  overlaps,
  rangeAt,
  RpcError,
  type Range,
  type Location,
  type TextEdit,
} from './protocol';
import type { HostManifest } from './manifest';

const leaf = (node: SemanticNode) =>
  semanticElements(node).find(e => e.kind !== 'node');
export const nameAt = (analysis: Analysis, offset: number) =>
  analysis.names.find(n => n.span.start <= offset && offset < n.span.end);
const location = (
  analysis: Analysis,
  start: number,
  end: number,
): Location => ({
  uri: analysis.document.uri,
  range: rangeAt(analysis.document.text, start, end),
});
const resolvedBinding = (
  analysis: Analysis,
  name: SemanticName,
): Binding | null => {
  if (name.binding) {
    return name.binding;
  }
  if (name.role !== 'message') {
    return null;
  }
  const send = analysis.nodes.find(
    n =>
      n.rule === 'Send' &&
      n.span.start <= name.span.start &&
      name.span.end <= n.span.end,
  );
  if (send) {
    const to = send.children.findIndex(
      c => c.kind === 'token' && c.text === 'to',
    );
    const receiver = send.children[to + 1];
    // A different Script or Object has its own Message Path. Only an explicit
    // self receiver can resolve to a Handler in this document.
    if (receiver?.kind !== 'node') {
      return null;
    }
    const leaves = semanticElements(receiver).filter(c => c.kind !== 'node');
    if (leaves.length !== 1 || leaves[0]?.text !== 'me') {
      return null;
    }
  }
  return (
    analysis.checked.tree.scopes[0]?.bindings.find(
      b => b.kind === 'handler' && b.name === name.text,
    ) ?? null
  );
};
const targetKey = (analysis: Analysis, name: SemanticName): string | null => {
  const binding = resolvedBinding(analysis, name);
  if (binding) {
    return bindingKey(analysis, binding);
  }
  if (name.role !== 'import') {
    return null;
  }
  // In an aliased Import the remote name has no local binding.
  const use = analysis.nodes.find(
    n =>
      n.rule === 'Use' &&
      n.span.start <= name.span.start &&
      n.span.end >= name.span.end,
  );
  const imported =
    use &&
    semanticElements(use).find(
      (n): n is SemanticName => n.kind === 'name' && !!n.binding?.importedFrom,
    );
  return imported?.binding ? bindingKey(analysis, imported.binding) : null;
};
export const definition = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
): Location | null => {
  const name = nameAt(analysis, offset);
  if (!name) {
    return null;
  }
  if (name.role === 'library') {
    const library = [...all.values()].find(
      a => a.document.library === name.text,
    );
    return library ? location(library, 0, 0) : null;
  }
  const key = targetKey(analysis, name);
  for (const doc of all.values()) {
    const declaration = doc.names.find(
      n =>
        n.binding &&
        !n.binding.importedFrom &&
        n.binding.span &&
        bindingKey(doc, n.binding) === key,
    );
    if (declaration?.binding?.span) {
      return location(
        doc,
        declaration.binding.span.start,
        declaration.binding.span.end,
      );
    }
  }
  return null;
};
type Occurrence = {
  alias: Binding | null;
  analysis: Analysis;
  declaration: boolean;
  end: number;
  start: number;
};
const occurrences = (all: Map<string, Analysis>, key: string): Occurrence[] => {
  const out: Occurrence[] = [];
  for (const analysis of all.values()) {
    for (const name of analysis.names) {
      if (targetKey(analysis, name) === key) {
        out.push({
          analysis,
          start: name.span.start,
          end: name.span.end,
          declaration: name.role === 'declaration' || name.role === 'binding',
          alias:
            name.binding?.importedFrom &&
            name.binding.name !== name.binding.importedFrom.name
              ? name.binding
              : null,
        });
      }
    }
    // End suffixes are grammar tokens, but rename must keep them in step with
    // the declaration or it would turn valid source into a syntax error.
    for (const node of analysis.nodes.filter(
      n => n.rule === 'Handler' || n.rule === 'Function',
    )) {
      const direct = node.children.filter(e => e.kind !== 'node');
      const end = direct.findIndex(e => e.text === 'end');
      const suffix = direct[end + 1];
      const declared = semanticElements(node).find(
        (e): e is SemanticName => e.kind === 'name' && e.role === 'declaration',
      );
      if (
        end >= 0 &&
        suffix &&
        declared?.binding &&
        bindingKey(analysis, declared.binding) === key
      ) {
        out.push({
          analysis,
          start: suffix.span.start,
          end: suffix.span.end,
          declaration: false,
          alias: null,
        });
      }
    }
  }
  return out;
};
export const references = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
  includeDeclaration: boolean,
): Location[] => {
  const name = nameAt(analysis, offset);
  const key = name && targetKey(analysis, name);
  return key
    ? occurrences(all, key)
        .filter(o => includeDeclaration || !o.declaration)
        .map(o => location(o.analysis, o.start, o.end))
    : [];
};
export const rename = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
  newName: string,
) => {
  // Let the Core lexer define valid names (including Unicode), rather than
  // accepting a JS identifier that NorthTalk cannot parse.
  const lexer = new Lexer(newName);
  const token = lexer.lex(0, 'operand');
  if (
    token.t !== 'word' ||
    token.raw !== newName ||
    grammar.reserved.includes(token.v) ||
    lexer.lex(token.end, 'operand').t !== 'eof'
  ) {
    throw new RpcError(
      -32_602,
      'The new name must be one non-reserved NorthTalk name',
    );
  }
  const name = nameAt(analysis, offset);
  const key = name && targetKey(analysis, name);
  if (!key || !name || (name.binding && !name.binding.span)) {
    throw new RpcError(-32_602, 'No renameable binding at this position');
  }
  const alias =
    name.binding?.importedFrom &&
    name.binding.name !== name.binding.importedFrom.name
      ? name.binding
      : null;
  const selected = occurrences(all, key).filter(o =>
    alias ? o.analysis === analysis && o.alias === alias : !o.alias,
  );
  const renamedBindings = new Map<Analysis, Set<Binding>>();
  for (const occurrence of selected) {
    const binding = occurrence.analysis.names.find(
      n => n.span.start === occurrence.start && n.span.end === occurrence.end,
    )?.binding;
    if (binding) {
      const bindings =
        renamedBindings.get(occurrence.analysis) ?? new Set<Binding>();
      bindings.add(binding);
      renamedBindings.set(occurrence.analysis, bindings);
    }
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const occurrence of selected) {
    const doc = occurrence.analysis;
    const scopes = new Set<number>();
    let scope = doc.nodes
      .filter(
        n => n.span.start <= occurrence.start && occurrence.end <= n.span.end,
      )
      .at(-1)?.scope;
    while (scope !== undefined) {
      scopes.add(scope);
      scope = doc.checked.tree.scopes[scope]?.parent ?? undefined;
    }
    const unitBinding = doc.names.some(
      n =>
        n.binding?.scope === 0 &&
        targetKey(doc, n) === key &&
        (!alias || n.binding === alias),
    );
    const bindings = doc.checked.tree.scopes
      .filter(s => unitBinding || scopes.has(s.id))
      .flatMap(s => s.bindings);
    if (
      bindings.some(
        b =>
          b.name === token.v &&
          b.span &&
          renamedBindings.has(doc) &&
          !renamedBindings.get(doc)!.has(b),
      )
    ) {
      throw new RpcError(-32_602, `The name ${newName} is already bound`);
    }
    const edits = (changes[doc.document.uri] ??= []);
    if (
      !edits.some(
        e =>
          e.range.start.line ===
            rangeAt(doc.document.text, occurrence.start).start.line &&
          e.range.start.character ===
            rangeAt(doc.document.text, occurrence.start).start.character,
      )
    ) {
      edits.push({
        range: rangeAt(doc.document.text, occurrence.start, occurrence.end),
        newText: newName,
      });
    }
  }
  return { changes };
};

// Selector parts are wire names; source-facing signatures keep labels between arguments.
const messagePhrase = (selector: string): string => {
  if (!selector.includes(':')) {
    return selector;
  }
  const parts = selector.slice(0, -1).split(':');
  return parts.map((part, i) => `${part} arg${i + 1}`).join(' ');
};
const handlerHead = (
  analysis: Analysis,
  selector: string,
): string | undefined => {
  const declaration = analysis.names.find(
    n => n.role === 'declaration' && n.text === selector,
  );
  const node =
    declaration &&
    analysis.nodes.find(
      n =>
        n.rule === 'Handler' &&
        n.span.start <= declaration.span.start &&
        declaration.span.end <= n.span.end,
    );
  if (!node) {
    return undefined;
  }
  const syntax = elements<SyntaxElement>(analysis.syntax).find(
    (e): e is SyntaxNode =>
      e.kind === 'node' &&
      e.rule === 'Handler' &&
      e.start <= declaration!.span.start &&
      declaration!.span.end <= e.end,
  );
  const boundary = syntax?.children.find(
    (e): e is Token =>
      e.kind === 'token' && (e.t === 'nl' || ['where', ','].includes(e.v)),
  );
  return analysis.document.text
    .slice(node.span.start, boundary?.pos ?? node.span.end)
    .trim();
};

const labelCompletion = (before: string, selectors: string[]) => {
  const syntax = elements<SyntaxElement>(parseSourceRecovering(before).tree);
  const offset = before.length;
  for (const node of syntax
    .filter((e): e is SyntaxNode => e.kind === 'node')
    .reverse()) {
    if (!['Handler', 'Send', 'SimpleStatement'].includes(node.rule)) {
      continue;
    }
    const list = node.children.find(
      (e): e is SyntaxNode => e.kind === 'node' && e.rule === 'ExpressionList',
    );
    const children = list?.children ?? node.children;
    const labels = children
      .filter((e): e is SyntaxNode => e.kind === 'node' && e.rule === 'Label')
      .map(e => e.children[0] as Token);
    const active = labels.find(t => t.pos <= offset && offset <= t.end);
    const prior = labels.filter(t => t.end < (active?.pos ?? offset));
    const args = children
      .filter(
        (e): e is SyntaxNode =>
          e.kind === 'node' && ['Expression', 'Pattern'].includes(e.rule),
      )
      .filter(e =>
        elements<SyntaxElement>(e).some(
          t => t.kind === 'token' && t.t !== 'eof',
        ),
      );
    const last = args.at(-1);
    if (
      !last ||
      args.length !== prior.length + 1 ||
      (!active && (last.end >= offset || before.slice(last.end).trim()))
    ) {
      continue;
    }
    const message = node.children.find(
      (e): e is SyntaxNode => e.kind === 'node' && e.rule === 'MessageName',
    );
    const head = message
      ? elements<SyntaxElement>(message).find(
          (e): e is Token => e.kind === 'token',
        )
      : node.children[0];
    if (head?.kind !== 'token') {
      continue;
    }
    const result = [
      ...new Set(
        selectors
          .filter(name => name.includes(':'))
          .flatMap(name => {
            const parts = name.slice(0, -1).split(':');
            const next = parts[prior.length + 1];
            return parts[0] === head.v &&
              prior.every((t, i) => parts[i + 1] === t.v) &&
              next?.startsWith(active?.v ?? '')
              ? [next]
              : [];
          }),
      ),
    ];
    if (result.length) {
      return result.map(label => item(label, 14));
    }
  }
  return [];
};

// Only the parser's original incomplete diagnostic is authoritative. Resuming
// a lexer after an invalid escape would re-read a closer as a new opener and
// incorrectly suppress completion in subsequent code.
const unfinishedLiteral = (source: string): boolean => {
  const { error } = parseSource(source);
  return error?.tok.incomplete === true && error.code === 'unterminated text';
};
const item = (label: string, kind: number, detail?: string) => ({
  label,
  kind,
  ...(detail ? { detail } : {}),
});
export const completion = (
  analysis: Analysis,
  offset: number,
  manifest: HostManifest | null,
  all: Map<string, Analysis>,
) => {
  const source = analysis.document.text;
  const before = source.slice(0, offset);
  const line = before.split(/\r\n|\r|\n/).at(-1)!;
  // String and comment tokens are authoritative even in otherwise broken code.
  const tokens = elements<SyntaxElement>(analysis.syntax).filter(
    (e): e is Token => e.kind === 'token',
  );
  if (
    unfinishedLiteral(before) ||
    tokens.some(
      t =>
        (t.t === 'str' && t.pos < offset && offset < t.end) ||
        t.leadingTrivia.some(
          tr => tr.kind === 'comment' && tr.pos < offset && offset <= tr.end,
        ),
    )
  ) {
    return [];
  }

  const operation =
    /\b(?:ask|tell)\s+([\p{L}\p{N}_]+)\s+to\s+([\p{L}\p{N}_]*)$/u.exec(line);
  if (operation) {
    return [...(manifest?.grants.get(operation[1]!)?.values() ?? [])]
      .filter(op => op.name.startsWith(operation[2]!))
      .map(op => item(op.name, 2, JSON.stringify(op.declaration)));
  }
  if (/^\s*catch\s+[^\n]*$/.test(line)) {
    return [
      ...new Set(
        [...(manifest?.grants.values() ?? [])].flatMap(ops =>
          [...ops.values()].flatMap(op => op.errors),
        ),
      ),
    ].map(code => item(`{code: ${JSON.stringify(code)}}`, 15));
  }
  if (
    /^\s*on\s+[\p{L}\p{N}_]*$/u.test(line) ||
    /\bsend\s+[\p{L}\p{N}_]*$/u.test(line) ||
    /\bsend\s+to\s+.+:\s*[\p{L}\p{N}_]*$/u.test(line)
  ) {
    const legacySend = /\bsend\s+[\p{L}\p{N}_]*$/u.test(line);
    return (manifest?.messages ?? [])
      .filter(name => !legacySend || !name.includes(':'))
      .map(name => item(messagePhrase(name), 3));
  }
  const use = /^\s*use\s+[^\n]*$/.test(line);
  if (use) {
    if (/\bfrom\s+[\p{L}\p{N}_]*$/u.test(line)) {
      return [
        ...new Set(
          [...all.values()].flatMap(a =>
            a.document.library ? [a.document.library] : [],
          ),
        ),
      ].map(name => item(name, 9));
    }
    const library = /\bfrom\s+([\p{L}\p{N}_]+)/u.exec(
      source.slice(before.lastIndexOf('\n') + 1).split(/\r|\n/)[0] ?? '',
    )?.[1];
    const docs = [...all.values()].filter(
      a => a.document.library && (!library || a.document.library === library),
    );
    return docs.flatMap(doc =>
      Object.keys(exportsOf(doc.checked.tree)).map(name =>
        item(name, 6, doc.document.library),
      ),
    );
  }
  const labels = labelCompletion(before, [
    ...(manifest?.messages ?? []),
    ...(analysis.checked.tree.scopes[0]?.bindings
      .filter(b => b.kind === 'handler')
      .map(b => b.name) ?? []),
  ]);
  if (labels.length) {
    return labels;
  }
  if (/[0-9](?:\.[0-9]*)?[\p{L}]*$/u.test(line)) {
    return units.map(unit => item(unit.name, 11, unit.kind));
  }
  const ordinals = grammar.ordinals.join('|');
  if (
    new RegExp(String.raw`\b(?:the\s+)?(?:${ordinals}|[0-9]+)\s+[a-z]*$`).test(
      line,
    )
  ) {
    return grammar.chunk.map(chunk => item(chunk.singular, 14));
  }
  if (/\bnumber\s+of\s+[a-z]*$/.test(line)) {
    return grammar.chunk.map(chunk => item(chunk.plural, 14));
  }
  // Imported names and lexical bindings are available in expression/command
  // positions; the semantic scope excludes locals from unrelated Handlers.
  const node = analysis.nodes
    .filter(n => n.span.start <= offset && offset <= n.span.end)
    .at(-1);
  const scopes = new Set<number>([0]);
  let scope = node?.scope;
  // Recovery can retain a Handler's syntax and parameter bindings while its
  // semantic span ends at the last well-formed token before the broken body.
  // Use that enclosing declaration for completion in an unfinished hole.
  if (scope === undefined) {
    const enclosing = elements<SyntaxElement>(analysis.syntax)
      .filter(
        (e): e is SyntaxNode =>
          e.kind === 'node' &&
          ['Handler', 'Function', 'Lambda'].includes(e.rule) &&
          e.start <= offset &&
          offset <= e.end,
      )
      .reverse();
    for (const syntax of enclosing) {
      const first = elements<SyntaxElement>(syntax).find(
        (e): e is Token => e.kind === 'token',
      );
      scope = analysis.nodes.find(
        n => n.rule === syntax.rule && n.span.start === first?.pos,
      )?.scope;
      if (scope !== undefined) {
        break;
      }
    }
  }
  while (scope !== undefined && scope !== null) {
    scopes.add(scope);
    scope = analysis.checked.tree.scopes[scope]?.parent ?? undefined;
  }
  const partial = /[\p{L}\p{N}_]*$/u.exec(line)![0];
  const commandPosition = /^\s*[\p{L}\p{N}_]*$/u.test(line);
  const messages = commandPosition
    ? (manifest?.messages ?? [])
        .filter(name => name.startsWith(partial))
        .map(name => item(messagePhrase(name), 3))
    : [];
  const bindings = analysis.checked.tree.scopes
    .filter(s => scopes.has(s.id))
    .flatMap(s =>
      s.bindings
        .filter(
          b =>
            b.name.startsWith(partial) &&
            (commandPosition || !b.name.includes(':')),
        )
        .map(b =>
          item(
            b.kind === 'handler' && b.name.includes(':')
              ? (handlerHead(analysis, b.name)?.replace(/^on\s+/i, '') ??
                  messagePhrase(b.name))
              : b.name,
            b.kind === 'function' || (commandPosition && b.kind === 'handler')
              ? 3
              : 6,
          ),
        ),
    );
  return [
    ...bindings,
    ...messages.filter(m => !bindings.some(b => b.label === m.label)),
  ];
};

export const hover = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
  manifest: HostManifest | null,
) => {
  const node = analysis.nodes.find(
    n => n.rule === 'AskTell' && n.span.start <= offset && offset < n.span.end,
  );
  if (node) {
    const leaves = semanticElements(node).filter(e => e.kind !== 'node');
    const to = leaves.findIndex(e => e.text === 'to');
    const grant = leaves[to - 1];
    const op = leaves[to + 1];
    const declaration =
      grant &&
      op &&
      manifest?.grants.get(grant.text)?.get(op.text)?.declaration;
    if (declaration && op.span.start <= offset && offset < op.span.end) {
      return {
        contents: {
          kind: 'plaintext',
          value: JSON.stringify(declaration, null, 2),
        },
        range: rangeAt(analysis.document.text, op.span.start, op.span.end),
      };
    }
  }
  const name = nameAt(analysis, offset);
  const target = definition(all, analysis, offset);
  const home = target ? all.get(target.uri) : analysis;
  const binding = name ? resolvedBinding(analysis, name) : null;
  if (!name || !home) {
    return null;
  }
  const definitionName = binding?.importedFrom?.name ?? binding?.name;
  const loaded = home.loaded;
  const index = loaded?.unit.definitions.indexOf(definitionName ?? '') ?? -1;
  const value = index >= 0 ? loaded?.definitions[index] : undefined;
  let display = value?.toString();
  if (value?.kind === 'function') {
    display = `${display}\nHome Script: ${analysis.document.library ?? analysis.document.uri}`;
  } else if (binding?.kind === 'function' || binding?.kind === 'handler') {
    // A Function Value in Library code acquires the importing Script's Home.
    display = `Home Script: ${analysis.document.library ?? analysis.document.uri}\n${binding.kind === 'handler' ? (handlerHead(home, definitionName ?? '') ?? messagePhrase(definitionName ?? '')) : `function ${definitionName}`}`;
  }
  return display
    ? {
        contents: { kind: 'plaintext', value: display },
        range: rangeAt(analysis.document.text, name.span.start, name.span.end),
      }
    : null;
};
export const suspensionHints = (analysis: Analysis, requested: Range) => {
  const points = analysis.nodes.filter(
    n =>
      n.rule === 'Wait' ||
      (['Send', 'AskTell', 'SimpleStatement'].includes(n.rule) &&
        n.children.some(c => c.kind === 'node' && c.rule === 'AndWait')),
  );
  const marks = [...points];
  for (const node of analysis.nodes) {
    if (node.rule === 'Handler') {
      const name = semanticElements(node).find(
        e => e.kind === 'name' && e.role === 'declaration',
      );
      if (
        name?.kind === 'name' &&
        analysis.checked.tree.maySuspend?.includes(name.text)
      ) {
        marks.push(node);
      }
    } else if (node.rule === 'Lambda') {
      // Only this Lambda's points, excluding any Lambda nested inside it.
      const work = node.children.filter(
        (e): e is SemanticNode => e.kind === 'node',
      );
      let suspends = false;
      while (work.length) {
        const child = work.pop()!;
        if (child.rule === 'Lambda') {
          continue;
        }
        suspends ||= points.includes(child);
        work.push(
          ...child.children.filter((e): e is SemanticNode => e.kind === 'node'),
        );
      }
      if (suspends) {
        marks.push(node);
      }
    }
  }
  return marks
    .sort((a, b) => a.span.start - b.span.start)
    .filter(n =>
      overlaps(rangeAt(analysis.document.text, n.span.start), requested),
    )
    .map(n => ({
      position: rangeAt(
        analysis.document.text,
        leaf(n)?.span.start ?? n.span.start,
      ).start,
      label: '⏸',
      paddingRight: true,
      tooltip:
        n.rule === 'Handler' || n.rule === 'Lambda'
          ? `${n.rule} may suspend`
          : 'Suspension Point',
    }));
};
export const formatting = (analysis: Analysis): TextEdit[] => {
  const result = formatSource(analysis.document.text);
  return result.error
    ? []
    : [
        {
          range: rangeAt(
            analysis.document.text,
            0,
            analysis.document.text.length,
          ),
          newText: result.source,
        },
      ];
};
export const codeActions = (analysis: Analysis, requested: Range) =>
  analysis.lints
    .filter(
      l =>
        l.id === 'prefer-explicit-end' &&
        overlaps(
          rangeAt(analysis.document.text, l.span.start, l.span.end),
          requested,
        ),
    )
    .flatMap(l => {
      const node = elements<SyntaxElement>(analysis.syntax).find(
        e =>
          e.kind === 'node' &&
          e.children.some(c => c.kind === 'token' && c.pos === l.span.start),
      );
      if (!node || node.kind !== 'node') {
        return [];
      }
      const tokens = elements<SyntaxElement>(node).filter(
        (e): e is Token => e.kind === 'token',
      );
      const head = tokens.find(t => t.t === 'word');
      if (!head) {
        return [];
      }
      const suffix =
        head.v === 'on' || head.v === 'function'
          ? tokens[tokens.indexOf(head) + 1]?.raw
          : head.v;
      return suffix
        ? [
            {
              title: `Write end ${suffix}`,
              kind: 'quickfix',
              isPreferred: true,
              diagnostics: analysis.diagnostics.filter(
                d => d.code === l.id && d.range.start.line === l.span.line - 1,
              ),
              edit: {
                changes: {
                  [analysis.document.uri]: [
                    {
                      range: rangeAt(analysis.document.text, l.span.end),
                      newText: ` ${suffix}`,
                    },
                  ],
                },
              },
            },
          ]
        : [];
    });
