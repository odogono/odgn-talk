import { checkConstructs } from './constructs';
import { checkDecisions } from './decisions';
import { declarationDocs } from './documentation';
import { checkControl } from './control';
import { checkEffects, type GrantDecls } from './effects';
import { checkSuspension } from './suspension';
import { builtins, diagnosticCodes, libraryExports } from './generated/syntax';
import { RESERVED, type Token } from './lexer';
import { parseSource, type ParseError } from './parser';
import type {
  Binding,
  BindingKind,
  ExportKind,
  FunctionContract,
  LibraryExport,
  NameRole,
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticScope,
  SemanticToken,
  SemanticTree,
  SourceSpan,
} from './semantic';
import { syntaxSelector, type SyntaxElement, type SyntaxNode } from './syntax';

export type DiagnosticCode = (typeof diagnosticCodes)[number];
export type Diagnostic = {
  code: DiagnosticCode;
  message: string;
  span: SourceSpan;
};
export type ExistingName = Pick<
  Binding,
  'kind' | 'contract' | 'importedFrom'
> & { maySuspend?: boolean };
export type CheckOptions = {
  /** Names in older code units when checking a Script extension. */
  existing?: Readonly<Record<string, ExistingName>>;
  /** A Script's Grants, to check its Capability calls against; none checks none. */
  grants?: GrantDecls;
  /** Exports supplied by the Library loader; kind-only entries defer call-count checks. */
  libraries?: Readonly<Record<string, Readonly<Record<string, LibraryExport>>>>;
  /** Literal property names mapped to setter availability, by bound Object name. */
  objectProperties?: Readonly<
    Record<string, Readonly<Record<string, boolean>>>
  >;
  /** Well-known Host Object names bound at load. */
  objects?: readonly string[];
  /** Setter availability for an Owning Script's me. */
  ownerProperties?: Readonly<Record<string, boolean>>;
  /** Whether the source is a Script (the default) or a Library. */
  unit?: 'script' | 'library';
};
export type SemanticResult = {
  diagnostics: readonly Diagnostic[];
  ok: boolean;
  tree: SemanticTree;
};
export type CheckResult =
  | (SemanticResult & { error: null })
  | {
      diagnostics: readonly Diagnostic[];
      error: ParseError;
      ok: false;
      tree: null;
    };

type Scope = {
  bindings: Map<string, Binding>;
  captures: Set<Binding>;
  id: number;
  kind: SemanticScope['kind'];
  parent: Scope | null;
};
type Site = {
  binary: SyntaxNode | null;
  binds: boolean;
  group: SyntaxNode | null;
  name: SemanticName;
  parameter: boolean;
  scope: Scope;
  token: Token;
};
const span = (token: Token): SourceSpan => ({
  start: token.pos,
  end: token.end,
  line: token.line,
  col: token.col,
});
const nodes = (node: SyntaxNode) =>
  node.children.filter((child): child is SyntaxNode => child.kind === 'node');
const tokens = (node: SyntaxNode) =>
  node.children.filter((child): child is Token => child.kind === 'token');
const isName = (token: Token) =>
  token.t === 'word' && token.v !== '_' && !RESERVED.has(token.v);
const bodyRules = new Set(['Handler', 'Function', 'Lambda']);
// Only these productions introduce or classify name sites.
const siteRules = new Set<SyntaxNode['rule']>([
  'Declaration',
  'Handler',
  'Function',
  'Use',
  'Name',
  'PatternPrimary',
  'Field',
  'Atom',
  'Primary',
  'Call',
  'FieldType',
  'SimpleStatement',
  'Send',
  'Event',
  'AskTell',
  'TellBlock',
]);

// Error regions are opaque to semantic passes. A malformed operand makes its
// enclosing construct unusable, but a block retains its other statements.
const parsedSyntax = (root: SyntaxNode): SyntaxNode => {
  const ordered: SyntaxNode[] = [];
  const work = [root];
  let recovered = false;
  while (work.length) {
    const node = work.pop()!;
    ordered.push(node);
    if (node.rule !== 'Error') {
      for (const child of node.children) {
        if (child.kind === 'node') {
          work.push(child);
        }
      }
    } else {
      recovered = true;
    }
  }
  if (!recovered) {
    return root;
  }
  const parsed = new Map<SyntaxNode, SyntaxNode | null>();
  for (const node of ordered.reverse()) {
    if (node.rule === 'Error') {
      parsed.set(node, null);
      continue;
    }
    const children: SyntaxElement[] = [];
    let malformed = false;
    let changed = false;
    for (const child of node.children) {
      const result = child.kind === 'node' ? parsed.get(child)! : child;
      changed ||= result !== child;
      if (result) {
        children.push(result);
      } else {
        malformed = true;
      }
    }
    const container = ['Source', 'Block', 'Body'].includes(node.rule);
    parsed.set(
      node,
      malformed && !container ? null : changed ? { ...node, children } : node,
    );
  }
  return parsed.get(root) ?? { ...root, children: [] };
};

/**
 * Resolve bindings and check writes, named calls, constants and control flow.
 * On recovered syntax, omit malformed constructs and check retained code.
 */
export const checkSyntax = (
  syntax: SyntaxNode,
  options: CheckOptions = {},
): SemanticResult => {
  syntax = parsedSyntax(syntax);
  const scopes: Scope[] = [];
  const newScope = (kind: Scope['kind'], parent: Scope | null): Scope => {
    const scope: Scope = {
      id: scopes.length,
      kind,
      parent,
      bindings: new Map(),
      captures: new Set(),
    };
    scopes.push(scope);
    return scope;
  };
  const unit = newScope('unit', null);
  // One record per element carries traversal context, token bounds and the
  // semantic result. Keep it local: the same syntax can be checked again with
  // different imports, Grants or existing bindings.
  type Context = {
    binary: SyntaxNode | null;
    converted: SemanticElement | null;
    element: SyntaxElement;
    first: Token | undefined;
    group: SyntaxNode | null;
    last: Token | undefined;
    parameter: boolean;
    parent: SyntaxNode | null;
    pattern: boolean;
    scope: Scope;
  };
  const context = new Map<SyntaxElement, Context>();
  const ordered: Context[] = [];
  const work: Context[] = [
    {
      element: syntax,
      scope: unit,
      group: null,
      binary: null,
      pattern: false,
      parameter: false,
      parent: null,
      first: undefined,
      last: undefined,
      converted: null,
    },
  ];
  while (work.length) {
    const current = work.pop()!;
    const { element } = current;
    let { scope, group, binary, pattern, parameter } = current;
    const parent = current.parent;
    if (element.kind === 'node') {
      if (bodyRules.has(element.rule)) {
        scope = newScope(
          element.rule === 'Handler'
            ? 'handler'
            : element.rule === 'Function'
              ? 'function'
              : 'lambda',
          scope,
        );
        group = null;
        binary = null;
        pattern = parameter = false;
      }
      if (element.rule === 'Pattern') {
        parameter =
          parent?.rule === 'Handler' || parent?.rule === 'Lambda' || parameter;
        group ??= parameter ? parent! : element;
        pattern = true;
      }
      if (element.rule === 'OfferParameter') {
        group = parent!;
      }
      if (element.rule === 'Parameter') {
        group = parent!;
        parameter = true;
      }
      if (element.rule === 'TextPattern') {
        group ??= element;
      }
      if (element.rule === 'BinaryPattern') {
        binary = element;
      }
      // Expressions in splices/defaults are values, not further pattern bindings.
      if (element.rule === 'Expression') {
        pattern = parameter = false;
        group = null;
      }
      for (let i = element.children.length - 1; i >= 0; i--) {
        work.push({
          element: element.children[i]!,
          scope,
          group,
          binary,
          pattern,
          parameter,
          parent: element,
          first: undefined,
          last: undefined,
          converted: null,
        });
      }
    }
    ordered.push(current);
    current.scope = scope;
    current.group = group;
    current.binary = binary;
    current.pattern = pattern;
    current.parameter = parameter;
    context.set(element, current);
  }
  // Cache token bounds bottom-up; no recursive walk or repeated subtree scans.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const info = ordered[i]!;
    const { element } = info;
    if (element.kind === 'token') {
      if (element.t !== 'nl' && element.t !== 'eof') {
        info.first = info.last = element;
      }
    } else {
      for (const child of element.children) {
        const bounds = context.get(child)!;
        info.first ??= bounds.first;
        if (bounds.last) {
          info.last = bounds.last;
        }
      }
    }
  }
  const sites = new Map<Token, Site>();
  const mark = (
    token: Token,
    role: NameRole,
    binds = false,
    at: SyntaxElement = token,
  ): Site => {
    const info = context.get(at)!;
    const site: Site = {
      name: {
        kind: 'name',
        text: token.v,
        role,
        span: span(token),
        binding: null,
      },
      token,
      scope: info.scope,
      group: info.group,
      binary: info.binary,
      parameter: info.parameter,
      binds,
    };
    sites.set(token, site);
    return site;
  };
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const report = (
    code: DiagnosticCode,
    token: Token,
    message = `${code}: ${token.v}`,
  ) => {
    const key = `${code}:${token.pos}`;
    if (!reported.has(key)) {
      reported.add(key);
      diagnostics.push({ code, span: span(token), message });
    }
  };
  let nextBinding = 0;
  const makeBinding = (
    name: string,
    kind: BindingKind,
    scope: Scope,
    token: Token | null,
  ): Binding => ({
    id: nextBinding++,
    name,
    kind,
    scope: scope.id,
    span: token ? span(token) : null,
    initial:
      kind === 'local'
        ? 'nothing'
        : kind === 'parameter'
          ? 'parameter'
          : 'declaration',
  });
  const native = new Map<string, Binding>();
  for (const builtin of builtins) {
    const binding = makeBinding(
      builtin.name,
      builtin.kind === 'function' ? 'builtin function' : 'builtin constant',
      unit,
      null,
    );
    if ('contract' in builtin) {
      binding.contract = builtin.contract;
    }
    native.set(builtin.name, binding);
  }
  for (const [name, previous] of Object.entries(options.existing ?? {})) {
    unit.bindings.set(name, {
      ...makeBinding(name, previous.kind, unit, null),
      contract: previous.contract,
      importedFrom: previous.importedFrom,
    });
  }
  for (const name of options.objects ?? []) {
    unit.bindings.set(name, makeBinding(name, 'object', unit, null));
  }
  for (const scope of scopes.slice(1)) {
    scope.bindings.set('it', makeBinding('it', 'local', scope, null));
  }

  const declarationSites: {
    contract?: FunctionContract;
    importedFrom?: Binding['importedFrom'];
    kind: BindingKind;
    site: Site;
  }[] = [];
  const declaration = (
    token: Token,
    kind: BindingKind,
    importedFrom?: Binding['importedFrom'],
    contract?: FunctionContract,
  ) => {
    const site = mark(token, importedFrom ? 'import' : 'declaration');
    site.scope = unit;
    declarationSites.push({ site, kind, importedFrom, contract });
  };
  const importInfo = (
    library: string,
    name: string,
  ): { contract?: FunctionContract; kind: ExportKind } | undefined => {
    const supplied =
      options.libraries && Object.hasOwn(options.libraries, library)
        ? options.libraries[library]
        : undefined;
    if (supplied) {
      const entry = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
      return typeof entry === 'string' ? { kind: entry } : entry;
    }
    return libraryExports.find(
      entry => entry.library === library && entry.name === name,
    );
  };

  for (const { element } of ordered) {
    if (element.kind !== 'node' || !siteRules.has(element.rule)) {
      continue;
    }
    const ts = tokens(element);
    const ns = nodes(element);
    const head = context.get(element)?.first;
    if (!head) {
      continue;
    }
    switch (element.rule) {
      case 'Declaration': {
        if (head.v === 'constant' || head.v === 'script') {
          const name = context.get(
            ns.find(node => node.rule === 'Name')!,
          )?.first;
          if (name) {
            declaration(
              name,
              head.v === 'constant' ? 'constant' : 'script variable',
            );
          }
        }
        break;
      }
      case 'Handler':
      case 'Function': {
        const name = context.get(
          ns.find(
            node =>
              node.rule ===
              (element.rule === 'Handler' ? 'MessageName' : 'Name'),
          )!,
        )?.first;
        if (name) {
          const parameters = ns.filter(node => node.rule === 'Parameter');
          declaration(
            name,
            element.rule === 'Handler' ? 'handler' : 'function',
            undefined,
            element.rule === 'Function'
              ? {
                  required: parameters.filter(
                    parameter =>
                      !nodes(parameter).some(
                        node => node.rule === 'Expression',
                      ),
                  ).length,
                  total: parameters.length,
                }
              : undefined,
          );
          if (element.rule === 'Handler') {
            sites.get(name)!.name.text = syntaxSelector(element, name.v);
          }
        }
        if (element.rule === 'Handler') {
          const during = ts.findIndex(t => t.v === 'during');
          if (during >= 0 && ts[during + 1]) {
            mark(ts[during + 1]!, 'binding', true);
          }
        }
        break;
      }
      case 'Use': {
        const from = element.children.findIndex(
          child => child.kind === 'token' && child.v === 'from',
        );
        const imported = element.children
          .slice(0, from)
          .filter((child): child is SyntaxNode => child.kind === 'node');
        const after = element.children
          .slice(from + 1)
          .filter((child): child is SyntaxNode => child.kind === 'node');
        const library = context.get(after[0]!)!.first!;
        mark(library, 'library');
        const rename = after[1] ? context.get(after[1])?.first : undefined;
        for (const node of imported) {
          const name = context.get(node)!.first!;
          if (rename) {
            mark(name, 'import');
          }
          const info = importInfo(library.v, name.v);
          if (info) {
            declaration(
              rename ?? name,
              info.kind,
              { library: library.v, name: name.v },
              info.contract,
            );
          } else {
            mark(rename ?? name, 'import');
            const knownLibrary =
              (options.libraries &&
                Object.hasOwn(options.libraries, library.v)) ||
              libraryExports.some(entry => entry.library === library.v);
            report('unknown import', knownLibrary ? name : library);
          }
        }
        break;
      }
      case 'Name': {
        if (sites.has(head)) {
          break;
        }
        const parent = context.get(element)!.parent!;
        const prefix = tokens(parent)[0];
        if (parent.rule === 'OfferClause' || parent.rule === 'ChooseOffer') {
          mark(head, 'offer');
        } else if (parent.rule === 'MessageName') {
          mark(head, 'message').name.text = syntaxSelector(
            context.get(parent)!.parent!,
            head.v,
          );
        } else if (
          parent.rule === 'Parameter' ||
          parent.rule === 'OfferParameter' ||
          parent.rule === 'Collecting'
        ) {
          mark(head, 'binding', true);
        } else if (
          parent.rule === 'Pattern' ||
          parent.rule === 'PatternPrimary'
        ) {
          mark(
            head,
            prefix?.v === '^' ? 'value' : 'binding',
            prefix?.v !== '^',
          );
        } else if (parent.rule === 'FieldType' || parent.rule === 'Primary') {
          mark(head, 'value');
        }
        break;
      }
      case 'PatternPrimary': {
        if (isName(head) && !ns.length) {
          mark(head, 'binding', true);
        }
        for (let index = 1; index < ts.length; index++) {
          if (ts[index - 1]!.v === '...' && isName(ts[index]!)) {
            mark(ts[index]!, 'binding', true);
          }
        }
        break;
      }
      case 'Field': {
        if (ts[1]?.v === ':' && isName(head)) {
          mark(head, 'binding', true);
        }
        if (head.v === '...') {
          const rest = ts.find(isName);
          if (rest) {
            mark(rest, 'binding', true);
          }
        }
        break;
      }
      case 'Atom': {
        if (ts[1]?.v === ':') {
          mark(
            head,
            'capture',
            context.get(element)?.pattern ||
              context.get(element)?.parent?.rule === 'Replace',
          );
        }
        break;
      }
      case 'Primary': {
        if (!sites.has(head) && isName(head) && ts[0] === head && !ns.length) {
          mark(head, context.get(element)?.binary ? 'binary size' : 'value');
        }
        if (head.t === 'word' && head.v === 'it') {
          mark(head, 'value');
        }
        break;
      }
      case 'Call':
        mark(head, 'call');
        break;
      case 'FieldType': {
        if (['byte', 'bytes', 'bit', 'bits'].includes(ts[1]?.v ?? '')) {
          if (isName(head)) {
            mark(head, 'binary size');
          }
        }
        break;
      }
      case 'SimpleStatement': {
        if (ts[0] === head && isName(head) && head.v !== 'next') {
          mark(head, 'command').name.text = syntaxSelector(element, head.v);
        }
        break;
      }
      case 'Send':
      case 'Event': {
        // A bare receiver, or a `wait for`'s `from`, may name a Script of
        // the Group, even a later one.
        const to = element.children.findIndex(
          child =>
            child.kind === 'token' &&
            child.v === (element.rule === 'Send' ? 'to' : 'from'),
        );
        if (to < 0) {
          break;
        }
        let base = element.children[to + 1];
        while (
          base?.kind === 'node' &&
          nodes(base).length === 1 &&
          tokens(base).length === 0
        ) {
          base = nodes(base)[0]!;
        }
        const name =
          base?.kind === 'node' ? context.get(base)?.first : undefined;
        if (
          base?.kind === 'node' &&
          base.rule === 'Primary' &&
          name &&
          isName(name) &&
          !nodes(base).length
        ) {
          mark(name, 'receiver');
        }
        break;
      }
      case 'AskTell':
      case 'TellBlock': {
        // A bare Grant name is checked against Grants by the later effect pass.
        const target = ns.find(node => node.rule === 'Expression');
        if (target) {
          let base = target;
          while (nodes(base).length === 1 && tokens(base).length === 0) {
            base = nodes(base)[0]!;
          }
          const grant = context.get(base)?.first;
          if (
            base.rule === 'Primary' &&
            grant &&
            isName(grant) &&
            !nodes(base).length
          ) {
            mark(grant, 'grant');
          }
        }
        break;
      }
    }
  }
  // A Replace expression/statement binds the captures written in its first operand.
  for (const { element } of ordered) {
    if (element.kind !== 'node' || element.rule !== 'Replace') {
      continue;
    }
    const operand = nodes(element)[0];
    if (!operand) {
      continue;
    }
    const pending: SyntaxElement[] = [operand];
    while (pending.length) {
      const child = pending.pop()!;
      if (child.kind === 'node') {
        // The only expression embedded in an Atom is a pattern splice.
        if (child.rule !== 'Atom' || tokens(child)[0]?.v !== '(') {
          pending.push(...child.children);
        }
      } else {
        const site = sites.get(child);
        if (site?.name.role === 'capture') {
          site.binds = true;
        }
      }
    }
  }
  // Container grammar always follows its base operand down to a bare Primary.
  const containers: { node: SyntaxNode; root: Site }[] = [];
  for (const { element } of ordered) {
    if (element.kind !== 'node' || element.rule !== 'Container') {
      continue;
    }
    let base: SyntaxNode = element;
    for (;;) {
      const children = nodes(base);
      if (base.rule === 'Primary' && !children.length) {
        const root = context.get(base)!.first!;
        containers.push({ node: element, root: mark(root, 'write', true) });
        break;
      }
      const next =
        base.rule === 'The' || base.rule === 'Chunk'
          ? children.at(-1)
          : children[0];
      if (!next) {
        break;
      }
      base = next;
    }
  }
  const clash = (site: Site, binding: Binding) => {
    // Imports always report their local name in the use line, regardless of order.
    const imported =
      site.name.role === 'import'
        ? site
        : binding.importedFrom && binding.span
          ? sites.get(firstTokenAt.get(binding.span.start)!)
          : undefined;
    const previous = binding.span;
    report(
      'name clash',
      imported?.token ??
        (previous && previous.start > site.token.pos
          ? firstTokenAt.get(previous.start)!
          : site.token),
    );
  };
  const firstTokenAt = new Map(
    ordered
      .map(info => info.element)
      .filter((element): element is Token => element.kind === 'token')
      .map(token => [token.pos, token]),
  );
  for (const { site, kind, importedFrom, contract } of declarationSites) {
    const old = unit.bindings.get(site.name.text);
    if (
      old &&
      !(
        old.kind === 'handler' &&
        kind === 'handler' &&
        !old.importedFrom &&
        !importedFrom
      )
    ) {
      clash(site, old);
    }
    const binding = old ?? makeBinding(site.name.text, kind, unit, site.token);
    if (importedFrom && !old) {
      binding.importedFrom = importedFrom;
    }
    if (contract && !old) {
      binding.contract = contract;
    }
    unit.bindings.set(site.name.text, binding);
    site.name.binding = binding;
  }
  const duplicates = new Map<SyntaxNode, Set<string>>();
  const bindingSites = [...sites.values()]
    .filter(site => site.binds || site.name.role === 'capture')
    .sort((a, b) => a.token.pos - b.token.pos);
  for (const site of bindingSites) {
    if (site.group) {
      const seen = duplicates.get(site.group) ?? new Set<string>();
      if (seen.has(site.name.text)) {
        report('duplicate name', site.token);
      }
      seen.add(site.name.text);
      duplicates.set(site.group, seen);
    }
  }
  // Explicit bindings introduce Lambda locals. Collect them before write roots,
  // and finish each enclosing scope before deciding what a Lambda captures.
  const localSites = bindingSites
    .filter(site => site.binds)
    .sort(
      (a, b) =>
        a.scope.id - b.scope.id ||
        Number(a.name.role === 'write') - Number(b.name.role === 'write') ||
        a.token.pos - b.token.pos,
    );
  for (const site of localSites) {
    const global = unit.bindings.get(site.name.text);
    if (
      global &&
      (global.kind !== 'handler' || global.importedFrom) &&
      (site.name.role !== 'write' ||
        global.kind === 'function' ||
        (global.importedFrom && global.kind !== 'constant'))
    ) {
      clash(site, global);
    }
    if (
      site.name.role === 'write' &&
      global &&
      global.kind !== 'function' &&
      global.kind !== 'handler' &&
      (!global.importedFrom || global.kind === 'constant')
    ) {
      site.name.binding = global;
      continue;
    }
    let binding = site.scope.bindings.get(site.name.text);
    if (
      !binding &&
      site.name.role === 'write' &&
      site.scope.kind === 'lambda'
    ) {
      for (
        let scope = site.scope.parent;
        scope && scope !== unit;
        scope = scope.parent
      ) {
        binding = scope.bindings.get(site.name.text);
        if (binding) {
          break;
        }
      }
    }
    if (!binding) {
      binding = makeBinding(
        site.name.text,
        site.parameter ? 'parameter' : 'local',
        site.scope,
        site.token,
      );
      site.scope.bindings.set(site.name.text, binding);
    }
    if (
      binding.kind === 'local' &&
      binding.scope === site.scope.id &&
      binding.span &&
      site.token.pos < binding.span.start
    ) {
      binding.span = span(site.token);
    }
    site.name.binding = binding;
  }
  // Collection owns writes to its target within its body. Compare resolved
  // bindings so a Lambda's own local with the same spelling may shadow it.
  const collectingBodies = new Map<SyntaxNode, Site>();
  const collectingPatterns = new Map<SyntaxNode, Site>();
  for (const { element } of ordered) {
    if (element.kind !== 'node' || element.rule !== 'Repeat') {
      continue;
    }
    const clause = nodes(element).find(node => node.rule === 'Collecting');
    const targetNode =
      clause && nodes(clause).find(node => node.rule === 'Name');
    const target = targetNode && sites.get(context.get(targetNode)!.first!);
    if (!target) {
      continue;
    }
    const body = nodes(element).find(node => node.rule === 'Block');
    const pattern = nodes(element).find(node => node.rule === 'Pattern');
    if (body) {
      collectingBodies.set(body, target);
    }
    if (pattern) {
      collectingPatterns.set(pattern, target);
    }
  }
  if (collectingBodies.size || collectingPatterns.size) {
    for (const site of bindingSites) {
      if (!site.binds) {
        continue;
      }
      for (
        let parent = context.get(site.token)?.parent;
        parent;
        parent = context.get(parent)?.parent
      ) {
        const patternTarget = collectingPatterns.get(parent);
        const bodyTarget = collectingBodies.get(parent);
        if (patternTarget && site.name.text === patternTarget.name.text) {
          report('name clash', patternTarget.token);
        }
        if (bodyTarget && site.name.binding === bodyTarget.name.binding) {
          report("can't write", site.token);
        }
      }
    }
  }
  // Only a Whose Clause condition's first token is a Whose Key, so a later
  // unknown name there is probably a key spelt without `it's` (ADR 0074).
  const inWhoseCondition = (token: Token) => {
    for (
      let node = context.get(token)?.parent;
      node;
      node = context.get(node)?.parent
    ) {
      if (
        node.rule === 'Expression' &&
        context.get(node)?.parent?.rule === 'Whose'
      ) {
        return true;
      }
    }
    return false;
  };
  const lookup = (site: Site): Binding | undefined => {
    for (let scope: Scope | null = site.scope; scope; scope = scope.parent) {
      const binding = scope.bindings.get(site.name.text);
      if (binding) {
        return binding;
      }
    }
    return native.get(site.name.text);
  };
  const binaryBindings = new Map<SyntaxNode, Map<string, Site[]>>();
  for (const site of bindingSites) {
    if (!site.binds || !site.binary) {
      continue;
    }
    const fields = binaryBindings.get(site.binary) ?? new Map<string, Site[]>();
    const matches = fields.get(site.name.text) ?? [];
    matches.push(site);
    fields.set(site.name.text, matches);
    binaryBindings.set(site.binary, fields);
  }
  const receivers = new Map<string, Binding>();
  for (const site of sites.values()) {
    if (
      site.name.binding ||
      !['value', 'call', 'binary size', 'command', 'receiver'].includes(
        site.name.role,
      )
    ) {
      continue;
    }
    if (site.name.role === 'receiver') {
      // Otherwise unbound, it names a Script, looked up when sent (chapter 5).
      site.name.binding =
        lookup(site) ??
        receivers.get(site.name.text) ??
        receivers
          .set(
            site.name.text,
            makeBinding(site.name.text, 'object', unit, null),
          )
          .get(site.name.text)!;
      continue;
    }
    if (site.name.role === 'command') {
      const binding = unit.bindings.get(site.name.text);
      if (binding?.kind === 'handler') {
        site.name.binding = binding;
      }
      // A missing local Handler continues up the Message Path at run time.
      continue;
    }
    const binding = lookup(site);
    if (site.name.role === 'binary size') {
      // A bare size can only name a field already bound in this Binary Pattern.
      const earlier = (
        site.binary
          ? binaryBindings.get(site.binary)?.get(site.name.text)
          : undefined
      )?.find(
        candidate =>
          (context.get(candidate.token)?.parent?.end ?? candidate.token.end) <=
          site.token.pos,
      );
      site.name.binding = earlier?.name.binding ?? null;
      if (!site.name.binding) {
        report('unknown name', site.token);
      }
    } else if (!binding) {
      report(
        'unknown name',
        site.token,
        inWhoseCondition(site.token)
          ? `unknown name: ${site.token.v}; a key of the chunk is \`it's ${site.token.v}\``
          : undefined,
      );
    } else {
      site.name.binding = binding;
      if (
        site.name.role === 'value' &&
        (binding.kind === 'handler' || binding.kind === 'builtin function')
      ) {
        report('not a value', site.token);
      }
    }
  }
  const firstCapture = new Map<Scope, Token>();
  for (const site of [...sites.values()].sort(
    (a, b) => a.token.pos - b.token.pos,
  )) {
    const binding = site.name.binding;
    if (binding?.kind !== 'local' && binding?.kind !== 'parameter') {
      continue;
    }
    for (
      let scope: Scope | null = site.scope;
      scope && scope.id !== binding.scope;
      scope = scope.parent
    ) {
      if (scope.kind === 'lambda') {
        scope.captures.add(binding);
        if (!firstCapture.has(scope)) {
          firstCapture.set(scope, site.token);
        }
      }
    }
  }

  for (const { node, root } of containers) {
    const binding = root.name.binding;
    if (
      binding?.kind === 'constant' ||
      (binding && root.scope.captures.has(binding))
    ) {
      report("can't write", root.token);
    }
    const statement = context.get(node)?.parent;
    const head = statement && context.get(statement)?.first;
    if (
      head?.v === 'set' &&
      context.get(node)?.first === root.token &&
      context.get(node)?.last === root.token
    ) {
      report('not a property', head);
    }
  }

  const checkConstant = (expression: SyntaxNode, before: number) => {
    const pending: SyntaxElement[] = [expression];
    while (pending.length) {
      const element = pending.pop()!;
      if (element.kind === 'node') {
        // Creation reads captures now; the Lambda body only runs when called.
        if (element.rule === 'Lambda') {
          const capture = firstCapture.get(context.get(element)!.scope!);
          if (capture) {
            report('not constant', capture);
            return;
          }
          continue;
        }
        if (element.rule === 'The' && !nodes(element).length) {
          report('not constant', context.get(element)!.first!);
          return;
        }
        pending.push(...[...element.children].reverse());
        continue;
      }
      const site = sites.get(element);
      if (
        context.get(element)?.parent?.rule === 'Primary' &&
        element.t === 'word' &&
        (element.v === 'me' || element.v === 'it')
      ) {
        report('not constant', element);
        return;
      }
      if (!site || !['value', 'call', 'binary size'].includes(site.name.role)) {
        continue;
      }
      const binding = site.name.binding;
      const allowed =
        site.name.role === 'call'
          ? binding?.kind === 'builtin function'
          : binding?.kind === 'builtin constant' ||
            (binding?.kind === 'constant' &&
              (binding.span === null
                ? Object.hasOwn(options.existing ?? {}, binding.name)
                : binding.span.start < before));
      if (!allowed) {
        report('not constant', element);
        return;
      }
    }
  };
  for (const { element } of ordered) {
    if (
      element.kind !== 'node' ||
      (element.rule !== 'Call' &&
        element.rule !== 'Function' &&
        element.rule !== 'Declaration')
    ) {
      continue;
    }
    const head = context.get(element)?.first;
    if (!head) {
      continue;
    }
    const children = nodes(element);
    if (element.rule === 'Call') {
      const binding = sites.get(head)?.name.binding;
      const contract =
        binding?.kind === 'function' || binding?.kind === 'builtin function'
          ? binding.contract
          : undefined;
      const args = children.find(child => child.rule === 'ExpressionList');
      const count = args ? nodes(args).length : 0;
      if (contract && (count < contract.required || count > contract.total)) {
        report('wrong argument count', head);
      }
    } else if (element.rule === 'Function') {
      let defaultSeen = false;
      for (const parameter of children.filter(
        child => child.rule === 'Parameter',
      )) {
        const expression = nodes(parameter).find(
          child => child.rule === 'Expression',
        );
        if (expression) {
          defaultSeen = true;
          checkConstant(expression, head.pos);
        } else if (defaultSeen) {
          report('default order', context.get(parameter)!.first!);
        }
      }
    } else if (
      element.rule === 'Declaration' &&
      (head.v === 'constant' || head.v === 'script')
    ) {
      const expression = children.find(child => child.rule === 'Expression');
      if (expression) {
        checkConstant(expression, head.pos);
      }
    }
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const info = ordered[i]!;
    const { element } = info;
    if (element.kind === 'token') {
      if (element.t === 'nl' || element.t === 'eof' || element.t === 'error') {
        continue;
      }
      info.converted = sites.get(element)?.name ?? {
        kind: 'token',
        type: element.t,
        text: element.v,
        raw: element.raw,
        span: span(element),
      };
    } else {
      const { first: start, last: end } = info;
      if (!start && element !== syntax) {
        continue;
      }
      const children: SemanticElement[] = [];
      for (const child of element.children) {
        const result = context.get(child)!.converted;
        if (result) {
          children.push(result);
        }
      }
      info.converted = {
        kind: 'node',
        rule: element.rule,
        scope: info.scope.id,
        children,
        span: start
          ? {
              start: start.pos,
              end: end!.end,
              line: start.line,
              col: start.col,
            }
          : { start: element.start, end: element.end, line: 1, col: 1 },
      };
    }
  }
  const root = context.get(syntax)!.converted as SemanticNode;
  const reportAt = (code: DiagnosticCode, at: SemanticName | SemanticToken) =>
    diagnostics.push({ code, span: at.span, message: `${code}: ${at.text}` });
  checkControl(
    root,
    options.unit ?? 'script',
    reportAt,
    options.objectProperties,
    options.ownerProperties,
  );
  checkConstructs(root, reportAt);
  if (options.grants) {
    checkEffects(root, options.grants, reportAt);
  }
  const importedSuspension = (binding: Binding) => {
    const from = binding.importedFrom!;
    const exp = options.libraries?.[from.library]?.[from.name];
    return (
      options.existing?.[binding.name]?.maySuspend === true ||
      (typeof exp === 'object' && exp.maySuspend === true)
    );
  };
  const may = checkSuspension(root, importedSuspension, reportAt);
  checkDecisions(
    root,
    binding =>
      binding.importedFrom
        ? importedSuspension(binding)
        : (may.get(binding.name) ?? false),
    reportAt,
  );
  diagnostics.sort(
    (a, b) =>
      a.span.start - b.span.start ||
      diagnosticCodes.indexOf(a.code) - diagnosticCodes.indexOf(b.code),
  );
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    tree: {
      docs: [...declarationDocs(syntax).values()],
      maySuspend: [...may].filter(([, m]) => m).map(([name]) => name),
      root,
      scopes: scopes.map(scope => ({
        id: scope.id,
        kind: scope.kind,
        parent: scope.parent?.id ?? null,
        bindings: [...scope.bindings.values()].sort(
          (a, b) => (a.span?.start ?? -1) - (b.span?.start ?? -1),
        ),
        captures: [...scope.captures],
      })),
    },
  };
};

export const checkSource = (
  source: string,
  options: CheckOptions = {},
): CheckResult => {
  const parsed = parseSource(source);
  return parsed.error
    ? { error: parsed.error, tree: null, ok: false, diagnostics: [] }
    : { error: null, ...checkSyntax(parsed.tree, options) };
};
