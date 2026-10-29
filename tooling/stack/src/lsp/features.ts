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
} from '@northtalk/ts';
import { builtinDocs } from '@northtalk/ts/session';
import { formatSource } from '../format';
import { idiomEdit } from '../lint';
import {
  boundFuel,
  defaultFuelCaps,
  estimateFuel,
  fuelBoundText,
  fuelText,
  type FuelBound,
  type FuelCaps,
  type FuelEstimate,
} from '../fuel';

/** The caps a hover's Fuel Bound assumes, and a Host's Fuel per frame. */
export type FuelSettings = { caps: FuelCaps; frame?: number };
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
import {
  commandSelectors,
  type HostManifest,
  type ManifestOperation,
} from './manifest';
import { collectionHover, objectProperties, propertyHover } from './objects';
import {
  argumentPhrase,
  callSignature,
  dictionaryOf,
  dictionaryOperation,
  messageCall,
  shapeSlots,
  type CallSignature,
  grantText,
  messageText,
  operationText,
} from '../dictionary';

/** What the client said it can show, from its `initialize` capabilities. */
export type ClientFeatures = { markdown: boolean; snippets: boolean };

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
// A Handler's head in source, up to its line end or `where`, with its syntax.
const handlerHeadSpan = (analysis: Analysis, selector: string) => {
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
  return {
    start: node.span.start,
    end: boundary?.pos ?? node.span.end,
    syntax,
  };
};
const handlerHead = (
  analysis: Analysis,
  selector: string,
): string | undefined => {
  const head = handlerHeadSpan(analysis, selector);
  return head && analysis.document.text.slice(head.start, head.end).trim();
};
// A Handler's head without `on`, as a signature whose slots are its
// Parameter Patterns, each after its label: `move piece to square`.
const handlerSignature = (
  analysis: Analysis,
  selector: string,
): CallSignature | undefined => {
  const head = handlerHeadSpan(analysis, selector);
  if (!head?.syntax) {
    return undefined;
  }
  const raw = analysis.document.text.slice(head.start, head.end);
  const text = raw.trim().replace(/^on\s+/i, '');
  const base = head.start + raw.trimEnd().length - text.length;
  const children = head.syntax.children;
  const params = children.flatMap((child, i): [number, number][] => {
    if (child.kind !== 'node' || child.rule !== 'Pattern') {
      return [];
    }
    const tokens = elements<SyntaxElement>(child).filter(
      (e): e is Token => e.kind === 'token',
    );
    const label = children[i - 1];
    const first =
      label?.kind === 'node' && label.rule === 'Label'
        ? (label.children[0] as Token)
        : tokens[0];
    const last = tokens.at(-1);
    return first && last && last.end <= head.end
      ? [[first.pos - base, last.end - base]]
      : [];
  });
  return { text, params };
};

// The Operation an `ask`, a one-line `tell` or a `tell` block's line calls,
// by its Grant's and Operation's name tokens, in the syntax tree of `source`.
const operationCall = (
  syntax: SyntaxElement[],
  node: SyntaxNode,
  source: string,
): { grant: string; op: Token } | undefined => {
  let receiver: SyntaxElement | undefined;
  let op: SyntaxElement | undefined;
  if (node.rule === 'AskTell') {
    const to = node.children.findIndex(e => e.kind === 'token' && e.v === 'to');
    receiver = node.children[to - 1];
    op = node.children[to + 1];
  } else {
    // A `tell` block's line calls an Operation of the block's receiver.
    receiver = syntax.find(
      (e): e is SyntaxNode =>
        e.kind === 'node' &&
        e.rule === 'TellBlock' &&
        e.children.includes(node),
    )?.children[1];
    op = node.children[0];
  }
  const grant =
    receiver?.kind === 'node'
      ? source.slice(receiver.start, receiver.end).trim()
      : '';
  return op?.kind === 'token' &&
    op.t === 'word' &&
    /^[\p{L}\p{N}_]+$/u.test(grant)
    ? { grant, op }
    : undefined;
};

const labelCompletion = (
  before: string,
  selectors: string[],
  operationLabels: (grant: string, op: string) => readonly string[] | undefined,
) => {
  const syntax = elements<SyntaxElement>(parseSourceRecovering(before).tree);
  const offset = before.length;
  for (const node of syntax
    .filter((e): e is SyntaxNode => e.kind === 'node')
    .reverse()) {
    const operation = ['AskTell', 'OperationLine'].includes(node.rule);
    if (
      !operation &&
      !['Handler', 'Send', 'SimpleStatement'].includes(node.rule)
    ) {
      continue;
    }
    const list = node.children.find(
      (e): e is SyntaxNode => e.kind === 'node' && e.rule === 'ExpressionList',
    );
    // An Operation call's receiver is not one of its arguments.
    const children = list?.children ?? (operation ? [] : node.children);
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
    if (operation) {
      // The next label the Operation declares, after those already written
      // (ADR 0115).
      const call = operationCall(syntax, node, before);
      const declared = call && operationLabels(call.grant, call.op.v);
      const next = declared?.[prior.length];
      if (
        next?.startsWith(active?.v ?? '') &&
        prior.every((t, i) => declared![i] === t.v)
      ) {
        return [item(next, 14)];
      }
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
              next?.startsWith(active?.v ?? '') &&
              !grammar.labels.excluded.includes(next)
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
// A manifest message, with its documentation when the Host wrote any.
const messageItem = (
  manifest: HostManifest,
  name: string,
  client: ClientFeatures,
) => {
  const message = manifest.messageDecls.get(name);
  const documented = message?.description || message?.examples?.length;
  return {
    ...item(messagePhrase(name), 3),
    ...(message && documented
      ? {
          documentation: client.markdown
            ? { kind: 'markdown', value: messageText(message, 'markdown') }
            : messageText(message, 'plaintext'),
        }
      : {}),
  };
};
// An Operation's completion inserts `and wait` exactly when its mode needs it,
// unless the line already has it after the cursor.
const operationItem = (
  grant: string,
  op: ManifestOperation,
  rest: string,
  client: ClientFeatures,
) => {
  const entry = dictionaryOperation(grant, op);
  const wait = op.mode === 'suspending' && !/\band\s+wait\b/.test(rest);
  const insert =
    !wait || !op.args.length
      ? { insertText: wait ? `${op.name} and wait` : op.name }
      : client.snippets
        ? { insertText: `${op.name} \${1} and wait`, insertTextFormat: 2 }
        : {};
  return {
    ...item(op.name, 2, entry.call),
    ...insert,
    documentation: client.markdown
      ? { kind: 'markdown', value: operationText(entry, 'markdown') }
      : operationText(entry, 'plaintext'),
  };
};
export const completion = (
  analysis: Analysis,
  offset: number,
  manifest: HostManifest | null,
  all: Map<string, Analysis>,
  client: ClientFeatures = { markdown: false, snippets: false },
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

  const rest = source.slice(offset).split(/\r\n|\r|\n/)[0]!;
  if (manifest) {
    const properties = objectProperties(analysis, offset, manifest, all);
    if (properties) {
      return properties;
    }
  }
  // `tell g to` calls only fire-and-forget Operations, and `ask g to` only the
  // others; a `tell` block line calls any, in its own mode (ADR 0063).
  const operations = (
    grant: string,
    prefix: string,
    verb: 'ask' | 'tell' | 'block',
  ) =>
    [...(manifest?.grants.get(grant)?.values() ?? [])]
      .filter(
        op =>
          op.name.startsWith(prefix) &&
          (verb === 'block' ||
            (verb === 'tell') === (op.mode === 'fire-and-forget')),
      )
      .map(op => operationItem(grant, op, rest, client));
  const operation =
    /\b(ask|tell)\s+([\p{L}\p{N}_]+)\s+to\s+([\p{L}\p{N}_]*)$/u.exec(line);
  if (operation) {
    return operations(
      operation[2]!,
      operation[3]!,
      operation[1] as 'ask' | 'tell',
    );
  }
  // A `tell` block's line starts with an Operation of its receiver (ADR 0063).
  const lineStart = /^\s*([\p{L}\p{N}_]*)$/u.exec(line);
  if (lineStart) {
    const block = elements<SyntaxElement>(analysis.syntax).find(
      (e): e is SyntaxNode =>
        e.kind === 'node' &&
        e.rule === 'TellBlock' &&
        e.start < offset &&
        offset <= e.end,
    );
    const receiver = block?.children[1];
    const head = receiver?.kind === 'node' ? receiver : undefined;
    const grant = head && source.slice(head.start, head.end).trim();
    if (head && head.end < offset && grant && /^[\p{L}\p{N}_]+$/u.test(grant)) {
      return operations(grant, lineStart[1]!, 'block');
    }
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
      .map(name => messageItem(manifest!, name, client));
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
  const labels = labelCompletion(
    before,
    [
      ...(manifest?.messages ?? []),
      ...(analysis.checked.tree.scopes[0]?.bindings
        .filter(b => b.kind === 'handler')
        .map(b => b.name) ?? []),
      // A labelled Host Command's labelled spelling (ADR 0115).
      ...[...(manifest?.grants.values() ?? [])].flatMap(ops =>
        [...ops.values()].flatMap(op =>
          op.command ? commandSelectors(op) : [],
        ),
      ),
    ],
    (grant, op) => manifest?.grants.get(grant)?.get(op)?.labels,
  );
  if (labels.length) {
    return labels;
  }
  if (/[0-9](?:\.[0-9]*)?[\p{L}]*$/u.test(line)) {
    return units.map(unit => item(unit.name, 11, unit.kind));
  }
  if (/\bthe\s+opt[a-z]*$/.test(line)) {
    return [
      item('optional', 14, 'Read a map key, accepting a Nothing receiver'),
    ];
  }
  if (/\S\s+other[a-z]*$/.test(line)) {
    return [item('otherwise', 14, 'Evaluate the fallback only for Nothing')];
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
        .map(name => messageItem(manifest!, name, client))
    : [];
  // A Host Command starts a statement as a Command Call (ADR 0094).
  const commands = commandPosition
    ? [...(manifest?.grants ?? [])].flatMap(([grant, operations]) =>
        [...operations.values()]
          .filter(op => op.command && op.name.startsWith(partial))
          .map(op => operationItem(grant, op, rest, client)),
      )
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
  // A Script's own Handler takes the call, so its item wins.
  const shadowed = (label: string) => bindings.some(b => b.label === label);
  return [
    ...bindings,
    ...commands.filter(c => !shadowed(c.label)),
    ...messages.filter(
      m => !shadowed(m.label) && !commands.some(c => c.label === m.label),
    ),
  ];
};

// Inside a Whose Clause's condition, `it` and the Whose Key read the chunk
// being tested, not a local (ADR 0074).
const whoseHover = (analysis: Analysis, offset: number) => {
  const within = (n: { span: { end: number; start: number } }) =>
    n.span.start <= offset && offset < n.span.end;
  const key = analysis.nodes.find(n => n.rule === 'WhoseKey' && within(n));
  const it = key ? undefined : nameAt(analysis, offset);
  const condition =
    it?.text === 'it' &&
    analysis.nodes.some(n => {
      const c = n.rule === 'Whose' ? n.children[2] : undefined;
      return c?.kind === 'node' && within(c);
    });
  const word = key ? leaf(key) : condition ? it : undefined;
  if (!word) {
    return null;
  }
  const property = grammar.properties.includes(word.text);
  return {
    contents: {
      kind: 'plaintext',
      value: key
        ? `Whose Key: the ${property ? 'property' : 'key'} \`${word.text}\` of the chunk being tested, as \`the ${word.text} of it\``
        : 'it: the chunk this Whose Clause is testing',
    },
    range: rangeAt(analysis.document.text, word.span.start, word.span.end),
  };
};

const fuelEstimates = new WeakMap<
  object,
  {
    bounds: FuelBound[];
    caps: FuelCaps;
    estimates: FuelEstimate[];
    manifest: HostManifest | null;
  }
>();
/**
 * The Fuel Estimate (#1606) and Fuel Bound (#1610) of the Handler Clause or
 * function whose head declares `name`, from the analysis's loaded unit.
 */
const fuelAt = (
  analysis: Analysis,
  name: SemanticName,
  manifest: HostManifest | null,
  { caps, frame }: FuelSettings,
): string | undefined => {
  const loaded = analysis.loaded;
  if (name.role !== 'declaration' || !loaded) {
    return undefined;
  }
  const node = analysis.nodes.find(
    n =>
      (n.rule === 'Handler' || n.rule === 'Function') &&
      semanticElements(n).find(
        (e): e is SemanticName => e.kind === 'name' && e.role === 'declaration',
      ) === name,
  );
  if (!node) {
    return undefined;
  }
  let cached = fuelEstimates.get(loaded);
  if (cached?.manifest !== manifest || cached.caps !== caps) {
    const declared = (grant: string, op: string) =>
      manifest?.grants.get(grant)?.get(op)?.cost?.fuel;
    cached = {
      bounds: boundFuel(loaded, caps, declared, (grant, op) => {
        const operation = manifest?.grants.get(grant)?.get(op);
        return operation && (operation.result ?? null);
      }),
      caps,
      estimates: estimateFuel(loaded, declared),
      manifest,
    };
    fuelEstimates.set(loaded, cached);
  }
  const { bounds, estimates } = cached;
  const text = analysis.document.text;
  const last = rangeAt(text, node.span.end, node.span.end).start.line + 1;
  const at = estimates.findIndex(
    e =>
      e.name === name.text && e.at.line >= node.span.line && e.at.line <= last,
  );
  return at === -1
    ? undefined
    : `${fuelText(estimates[at]!)}\n${fuelBoundText(bounds[at]!, estimates[at]!.at.unit, caps, frame)}`;
};
export const hover = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
  manifest: HostManifest | null,
  client: ClientFeatures = { markdown: false, snippets: false },
  fuelSettings: FuelSettings = { caps: defaultFuelCaps },
) => {
  const whose = whoseHover(analysis, offset);
  if (whose) {
    return whose;
  }
  const objectCollection =
    manifest && collectionHover(analysis, offset, manifest);
  if (objectCollection) {
    return objectCollection;
  }
  const property = manifest && propertyHover(analysis, offset, manifest);
  if (property) {
    return property;
  }
  const within = (n: SemanticNode) =>
    n.span.start <= offset && offset < n.span.end;
  type Leaf = Exclude<ReturnType<typeof leaf>, undefined>;
  const onLeaf = (l: Leaf | undefined): l is Leaf =>
    l !== undefined && l.span.start <= offset && offset < l.span.end;
  const receiverOf = (block: SemanticNode | undefined) => {
    const receiver = block?.children.find(
      (e): e is SemanticNode => e.kind === 'node' && e.rule === 'Expression',
    );
    return receiver && leaf(receiver);
  };
  let grant: Leaf | undefined;
  let op: Leaf | undefined;
  const node = analysis.nodes.find(
    n => (n.rule === 'AskTell' || n.rule === 'OperationLine') && within(n),
  );
  if (node?.rule === 'AskTell') {
    const leaves = semanticElements(node).filter(e => e.kind !== 'node');
    const to = leaves.findIndex(e => e.text === 'to');
    grant = leaves[to - 1];
    op = leaves[to + 1];
  } else if (node) {
    // A `tell` block's line calls an Operation of the block's receiver.
    grant = receiverOf(
      analysis.nodes.find(
        n => n.rule === 'TellBlock' && n.children.includes(node),
      ),
    );
    const first = node.children[0];
    op = first?.kind === 'node' ? undefined : first;
  } else {
    // The receiver heading a `tell` block stands outside its OperationLines.
    grant = receiverOf(
      analysis.nodes.find(n => n.rule === 'TellBlock' && within(n)),
    );
  }
  if (
    grant?.kind === 'name' &&
    grant.role === 'grant' &&
    (onLeaf(grant) || onLeaf(op))
  ) {
    const format = client.markdown ? 'markdown' : 'plaintext';
    const at = (l: Leaf, value: string) => ({
      contents: { kind: format, value },
      range: rangeAt(analysis.document.text, l.span.start, l.span.end),
    });
    const declared = op && manifest?.grants.get(grant.text)?.get(op.text);
    if (declared && op && onLeaf(op)) {
      return at(
        op,
        operationText(dictionaryOperation(grant.text, declared), format),
      );
    }
    const entry = manifest
      ? dictionaryOf(manifest).find(g => g.name === grant.text)
      : undefined;
    if (entry && onLeaf(grant)) {
      return at(grant, grantText(entry, format));
    }
    // A bare receiver name may instead name a well-known Object, whose
    // Operations are its Kind's, not a Grant's.
    if (!manifest?.objectsKinds.has(grant.text)) {
      // Say why the Grant's Operations are unknown rather than show nothing.
      const hovered = onLeaf(grant) ? grant : op!;
      if (!manifest) {
        return at(
          hovered,
          `No Host Manifest is loaded, so the Operations ${grant.text} offers are unknown. Export one from the Host (exportManifest) and set northtalk.manifest, or put a single *.talk-manifest.json in a workspace root.`,
        );
      }
      if (!entry) {
        return at(
          hovered,
          `The loaded Host Manifest has no Grant named ${grant.text}, so its Operations are unknown.`,
        );
      }
      if (op) {
        return at(
          op,
          `Grant ${grant.text} in the loaded Host Manifest has no Operation named ${op.text}.`,
        );
      }
    }
  }
  const name = nameAt(analysis, offset);
  // A command no Handler in reach answers may be a Host Command, an
  // Operation one of the Script's Grants declares `command` (ADR 0094).
  const command =
    name?.role === 'command' && !resolvedBinding(analysis, name)
      ? [...(manifest?.grants ?? [])].flatMap(([grant, operations]) =>
          // A labelled call names it by its Selector (ADR 0115).
          [...operations.values()]
            .filter(
              op => op.command && commandSelectors(op).includes(name.text),
            )
            .map(op => ({ grant, op })),
        )
      : [];
  if (name && command.length === 1) {
    const format = client.markdown ? 'markdown' : 'plaintext';
    return {
      contents: {
        kind: format,
        value: operationText(
          dictionaryOperation(command[0]!.grant, command[0]!.op),
          format,
        ),
      },
      range: rangeAt(analysis.document.text, name.span.start, name.span.end),
    };
  }
  // Otherwise it may be one the Host answers at the end of the Message
  // Path; a Script's own Handler takes precedence.
  const message =
    name?.role === 'command' && !resolvedBinding(analysis, name)
      ? manifest?.messageDecls.get(name.text)
      : undefined;
  if (name && message) {
    const format = client.markdown ? 'markdown' : 'plaintext';
    return {
      contents: { kind: format, value: messageText(message, format) },
      range: rangeAt(analysis.document.text, name.span.start, name.span.end),
    };
  }
  const target = definition(all, analysis, offset);
  const home = target ? all.get(target.uri) : analysis;
  let binding = name ? resolvedBinding(analysis, name) : null;
  if (!name || !home) {
    return null;
  }
  const key = targetKey(analysis, name);
  // The defining export owns the documentation, including when hovering the
  // remote name of an aliased Import (which has no local binding).
  const defining = home.checked.tree.scopes[0]?.bindings.find(
    b => key !== null && bindingKey(home, b) === key && !b.importedFrom,
  );
  binding ??= defining ?? null;
  const definitionName = binding?.importedFrom?.name ?? binding?.name;
  const loaded = home.loaded;
  const index =
    binding?.scope === 0
      ? (loaded?.unit.definitions.indexOf(definitionName ?? '') ?? -1)
      : -1;
  const value = index >= 0 ? loaded?.definitions[index] : undefined;
  let display = value?.toString();
  if (value?.kind === 'function') {
    display = `${display}\nHome Script: ${analysis.document.library ?? analysis.document.uri}`;
  } else if (binding?.kind === 'function' || binding?.kind === 'handler') {
    // A Function Value in Library code acquires the importing Script's Home.
    display = `Home Script: ${analysis.document.library ?? analysis.document.uri}\n${binding.kind === 'handler' ? (handlerHead(home, definitionName ?? '') ?? messagePhrase(definitionName ?? '')) : `function ${definitionName}`}`;
  }
  let docs: string[] = [];
  if (
    binding?.kind === 'builtin function' ||
    binding?.kind === 'builtin constant'
  ) {
    const builtin = Object.hasOwn(builtinDocs, binding.name)
      ? builtinDocs[binding.name]
      : undefined;
    display ??= `${binding.kind} ${binding.name}`;
    docs = builtin ? [builtin.gives] : [];
  } else if (defining) {
    // SemanticTree.docs is the Core's extraction, in declaration order.
    // Match binding identity rather than spelling so locals and parameters
    // cannot inherit a top-level declaration's documentation.
    const declarations = home.checked.tree.root.children.filter(
      (c): c is SemanticNode => c.kind === 'node' && c.rule === 'Declaration',
    );
    docs = declarations.flatMap((d, i) =>
      semanticElements(d).some(
        e =>
          e.kind === 'name' &&
          e.role === 'declaration' &&
          e.binding === defining,
      )
        ? [home.checked.tree.docs?.[i] ?? '']
        : [],
    );
    display ??= `${defining.kind} ${defining.name}`;
  }
  const documented = docs.filter(doc => doc.length > 0);
  if (documented.length) {
    const documentation =
      binding?.kind === 'handler' && docs.length > 1
        ? docs.map((doc, i) => `Clause ${i + 1}:\n${doc}`).join('\n\n')
        : docs.join('\n\n');
    display = `${display ?? ''}\n\n${documentation}`;
  }
  const fuel = fuelAt(analysis, name, manifest, fuelSettings);
  if (fuel) {
    display = display ? `${display}\n\n${fuel}` : fuel;
  }
  return display
    ? {
        contents: { kind: 'plaintext', value: display },
        range: rangeAt(analysis.document.text, name.span.start, name.span.end),
      }
    : null;
};
type Signature = {
  documentation?: string;
  label: string;
  parameters: { label: [number, number] }[];
};
const signature = (call: CallSignature, documentation?: string): Signature => ({
  label: call.text,
  parameters: call.params.map(label => ({ label })),
  ...(documentation ? { documentation } : {}),
});
/** Signature help for the call whose arguments the cursor is in: an
 * Operation's `ask`, `tell` or `tell` block line, labelled when it declares
 * labels (ADR 0115), or a Command Call to a Handler, a Host Command or a
 * message the Host answers. The active parameter counts the commas and
 * labels before the cursor. */
export const signatureHelp = (
  analysis: Analysis,
  offset: number,
  manifest: HostManifest | null,
) => {
  const before = analysis.document.text.slice(0, offset);
  const syntax = elements<SyntaxElement>(parseSourceRecovering(before).tree);
  // The innermost call that runs up to the cursor on its line.
  const node = syntax
    .filter(
      (e): e is SyntaxNode =>
        e.kind === 'node' &&
        ['AskTell', 'OperationLine', 'SimpleStatement'].includes(e.rule),
    )
    .reverse()
    .find(
      n => !before.slice(n.end).trim() && !/[\n\r]/.test(before.slice(n.end)),
    );
  if (!node) {
    return null;
  }
  // Past a Result Target or `and wait`, the arguments are over.
  if (
    node.children.some(
      e =>
        e.kind === 'node' &&
        ['ResultTarget', 'AndWait'].includes(e.rule) &&
        elements<SyntaxElement>(e).some(t => t.kind === 'token'),
    )
  ) {
    return null;
  }
  const list = node.children.find(
    (e): e is SyntaxNode => e.kind === 'node' && e.rule === 'ExpressionList',
  );
  const separators = (list?.children ?? []).flatMap(e =>
    e.kind === 'token' && e.v === ','
      ? [{ comma: true, token: e }]
      : e.kind === 'node' && e.rule === 'Label'
        ? [{ comma: false, token: e.children[0] as Token }]
        : [],
  );
  const help = (signatures: Signature[]) =>
    signatures.length
      ? {
          signatures,
          activeSignature: 0,
          activeParameter: separators.filter(s => s.token.pos < offset).length,
        }
      : null;
  if (node.rule !== 'SimpleStatement') {
    const call = operationCall(syntax, node, before);
    const op = call && manifest?.grants.get(call.grant)?.get(call.op.v);
    if (!call || !op || offset <= call.op.end) {
      return null;
    }
    return help([
      signature(
        node.rule === 'AskTell'
          ? callSignature(call.grant, op)
          : argumentPhrase(op.name, shapeSlots(op.args), op.labels),
        op.description,
      ),
    ]);
  }
  const head = node.children[0];
  if (
    head?.kind !== 'token' ||
    head.t !== 'word' ||
    grammar.reserved.includes(head.v) ||
    offset <= head.end
  ) {
    return null;
  }
  // The Selectors the call may still be spelling, from its labels so far.
  const labels = separators.filter(s => !s.comma).map(s => s.token);
  const commas = separators.some(s => s.comma);
  const spells = (selector: string) => {
    const parts = selector.includes(':')
      ? selector.slice(0, -1).split(':')
      : [selector];
    return (
      parts[0] === head.v &&
      (!commas || parts.length === 1) &&
      parts.length > labels.length &&
      labels.every((t, i) =>
        t.end >= offset ? parts[i + 1]!.startsWith(t.v) : parts[i + 1] === t.v,
      )
    );
  };
  // A Script's own Handler takes the call, then a Host Command, and only
  // then does it climb to a message the Host answers (ADR 0094).
  const handlers = (
    analysis.checked.tree.scopes[0]?.bindings.filter(
      b => b.kind === 'handler',
    ) ?? []
  )
    .map(b => b.name)
    .filter(spells);
  const commands = [...(manifest?.grants.values() ?? [])].flatMap(ops =>
    [...ops.values()].flatMap(op =>
      op.command
        ? commandSelectors(op)
            .filter(s => spells(s) && !handlers.includes(s))
            .map(selector => ({ op, selector }))
        : [],
    ),
  );
  const messages = [...(manifest?.messageDecls.values() ?? [])].filter(
    m =>
      spells(m.name) &&
      !handlers.includes(m.name) &&
      !commands.some(c => c.selector === m.name),
  );
  return help([
    ...handlers.map(selector =>
      signature(
        handlerSignature(analysis, selector) ?? {
          text: messagePhrase(selector),
          params: [],
        },
      ),
    ),
    ...commands.map(({ op, selector }) => {
      const parts = selector.includes(':')
        ? selector.slice(0, -1).split(':')
        : [selector];
      const args = parts.length > 1 ? op.args.slice(0, parts.length) : op.args;
      return signature(
        argumentPhrase(op.name, shapeSlots(args), parts.slice(1)),
        op.description,
      );
    }),
    ...messages.map(m => signature(messageCall(m), m.description)),
  ]);
};
export const suspensionHints = (analysis: Analysis, requested: Range) => {
  const points = analysis.nodes.filter(
    n =>
      n.rule === 'Wait' ||
      (['Send', 'AskTell', 'OperationLine', 'SimpleStatement'].includes(
        n.rule,
      ) &&
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
const idiomTitles = {
  'if-then-return-bool': 'Return the condition',
  'kindof-comparison': 'Rewrite as is a',
  'suggest-arithmetic-command': 'Rewrite as a command',
  'suggest-is-in': 'Rewrite as is in',
  'suggest-match': 'Rewrite as match',
  'suggest-otherwise': 'Rewrite with otherwise',
} as const;
const idiomActions = (analysis: Analysis, requested: Range) =>
  analysis.lints
    .filter(
      l =>
        l.id in idiomTitles &&
        overlaps(
          rangeAt(analysis.document.text, l.span.start, l.span.end),
          requested,
        ),
    )
    .flatMap(l => {
      const edit = idiomEdit(
        analysis.syntax,
        analysis.document.text,
        l.id,
        l.span.start,
      );
      return edit
        ? [
            {
              title: idiomTitles[l.id as keyof typeof idiomTitles],
              kind: 'quickfix',
              isPreferred: true,
              diagnostics: analysis.diagnostics.filter(
                d => d.code === l.id && d.range.start.line === l.span.line - 1,
              ),
              edit: {
                changes: {
                  [analysis.document.uri]: [
                    {
                      range: rangeAt(
                        analysis.document.text,
                        edit.start,
                        edit.end,
                      ),
                      newText: edit.newText,
                    },
                  ],
                },
              },
            },
          ]
        : [];
    });
const explicitEndActions = (analysis: Analysis, requested: Range) =>
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

export const codeActions = (analysis: Analysis, requested: Range) => [
  ...explicitEndActions(analysis, requested),
  ...idiomActions(analysis, requested),
];

/**
 * The Grant, and the Operation if any, that the code at `offset` calls: an
 * `ask` or `tell`, a `tell` block's receiver or line, or a Host Command by
 * name. Syntactic only, for "Show in Dictionary"; absent when the Manifest
 * declares neither.
 */
export const operationAt = (
  source: string,
  offset: number,
  manifest: HostManifest,
): { grant: string; operation?: string } | undefined => {
  const syntax = elements<SyntaxElement>(parseSourceRecovering(source).tree);
  const within = (e: SyntaxElement) =>
    e.kind === 'node'
      ? e.start <= offset && offset <= e.end
      : e.pos <= offset && offset <= e.end;
  const nodes = syntax.filter(
    (e): e is SyntaxNode => e.kind === 'node' && within(e),
  );
  // The innermost call wins, so a call in another's argument is its own.
  const node = nodes
    .filter(n =>
      ['AskTell', 'OperationLine', 'SimpleStatement', 'TellBlock'].includes(
        n.rule,
      ),
    )
    .at(-1);
  if (!node) {
    return undefined;
  }
  if (node.rule === 'SimpleStatement') {
    const head = node.children[0];
    if (head?.kind !== 'token' || head.t !== 'word' || !within(head)) {
      return undefined;
    }
    const commands = [...manifest.grants].flatMap(([grant, operations]) =>
      [...operations.values()]
        .filter(op => op.command && commandSelectors(op).includes(head.v))
        .map(op => ({ grant, operation: op.name })),
    );
    return commands.length === 1 ? commands[0] : undefined;
  }
  if (node.rule === 'TellBlock') {
    const receiver = node.children[1];
    const grant =
      receiver?.kind === 'node'
        ? source.slice(receiver.start, receiver.end).trim()
        : '';
    return receiver && within(receiver) && manifest.grants.has(grant)
      ? { grant }
      : undefined;
  }
  const call = operationCall(syntax, node, source);
  const operations = call && manifest.grants.get(call.grant);
  if (!call || !operations) {
    return undefined;
  }
  return operations.has(call.op.v)
    ? { grant: call.grant, operation: call.op.v }
    : { grant: call.grant };
};
