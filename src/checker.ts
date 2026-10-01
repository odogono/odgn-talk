import { builtins, diagnosticCodes, libraryExports } from './generated/syntax';
import { RESERVED, type Token } from './lexer';
import { parseSource, type ParseError } from './parser';
import type {
  Binding,
  BindingKind,
  ExportKind,
  NameRole,
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticScope,
  SemanticTree,
  SourceSpan,
} from './semantic';
import type { SyntaxElement, SyntaxNode } from './syntax';

export type DiagnosticCode = (typeof diagnosticCodes)[number];
export type Diagnostic = {
  code: DiagnosticCode;
  message: string;
  span: SourceSpan;
};
export type CheckOptions = {
  /** Export kinds supplied by the Library loader; standard exports are known by default. */
  libraries?: Readonly<Record<string, Readonly<Record<string, ExportKind>>>>;
  /** Well-known Host Object names bound at load. */
  objects?: readonly string[];
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

/** Name/binding checks only: effect, kind, constant and control-flow checks follow later. */
export const checkSyntax = (
  syntax: SyntaxNode,
  options: CheckOptions = {},
): SemanticResult => {
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
  const parents = new Map<SyntaxElement, SyntaxNode>();
  const scopeOf = new Map<SyntaxElement, Scope>();
  const groupOf = new Map<SyntaxElement, SyntaxNode | null>();
  const binaryOf = new Map<SyntaxElement, SyntaxNode | null>();
  const patternOf = new Map<SyntaxElement, boolean>();
  const parameterOf = new Map<SyntaxElement, boolean>();
  const ordered: SyntaxElement[] = [];
  const first = new Map<SyntaxElement, Token>();
  const last = new Map<SyntaxElement, Token>();
  type Work = {
    binary: SyntaxNode | null;
    element: SyntaxElement;
    group: SyntaxNode | null;
    parameter: boolean;
    pattern: boolean;
    scope: Scope;
  };
  const work: Work[] = [
    {
      element: syntax,
      scope: unit,
      group: null,
      binary: null,
      pattern: false,
      parameter: false,
    },
  ];
  while (work.length) {
    const current = work.pop()!;
    const { element } = current;
    let { scope, group, binary, pattern, parameter } = current;
    const parent = parents.get(element);
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
      for (const child of [...element.children].reverse()) {
        parents.set(child, element);
        work.push({ element: child, scope, group, binary, pattern, parameter });
      }
    }
    ordered.push(element);
    scopeOf.set(element, scope);
    groupOf.set(element, group);
    binaryOf.set(element, binary);
    patternOf.set(element, pattern);
    parameterOf.set(element, parameter);
  }
  // Cache token bounds bottom-up; no recursive walk or repeated subtree scans.
  for (const element of [...ordered].reverse()) {
    if (element.kind === 'token') {
      if (element.t !== 'nl' && element.t !== 'eof') {
        first.set(element, element);
        last.set(element, element);
      }
    } else {
      for (const child of element.children) {
        const start = first.get(child);
        const end = last.get(child);
        if (start && !first.has(element)) {
          first.set(element, start);
        }
        if (end) {
          last.set(element, end);
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
    const site: Site = {
      name: {
        kind: 'name',
        text: token.v,
        role,
        span: span(token),
        binding: null,
      },
      token,
      scope: scopeOf.get(at)!,
      group: groupOf.get(at) ?? null,
      binary: binaryOf.get(at) ?? null,
      parameter: parameterOf.get(at) ?? false,
      binds,
    };
    sites.set(token, site);
    return site;
  };
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const report = (code: DiagnosticCode, token: Token) => {
    const key = `${code}:${token.pos}`;
    if (!reported.has(key)) {
      reported.add(key);
      diagnostics.push({
        code,
        span: span(token),
        message: `${code}: ${token.v}`,
      });
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
    native.set(
      builtin.name,
      makeBinding(
        builtin.name,
        builtin.kind === 'function' ? 'builtin function' : 'builtin constant',
        unit,
        null,
      ),
    );
  }
  for (const name of options.objects ?? []) {
    unit.bindings.set(name, makeBinding(name, 'object', unit, null));
  }
  for (const scope of scopes.slice(1)) {
    scope.bindings.set('it', makeBinding('it', 'local', scope, null));
  }

  const declarationSites: {
    importedFrom?: Binding['importedFrom'];
    kind: BindingKind;
    site: Site;
  }[] = [];
  const declaration = (
    token: Token,
    kind: BindingKind,
    importedFrom?: Binding['importedFrom'],
  ) => {
    const site = mark(token, importedFrom ? 'import' : 'declaration');
    site.scope = unit;
    declarationSites.push({ site, kind, importedFrom });
  };
  const importKind = (
    library: string,
    name: string,
  ): ExportKind | undefined => {
    const supplied =
      options.libraries && Object.hasOwn(options.libraries, library)
        ? options.libraries[library]
        : undefined;
    if (supplied) {
      return Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    }
    return libraryExports.find(
      entry => entry.library === library && entry.name === name,
    )?.kind;
  };

  for (const element of ordered) {
    if (element.kind !== 'node') {
      continue;
    }
    const ts = tokens(element);
    const ns = nodes(element);
    const head = first.get(element);
    if (!head) {
      continue;
    }
    switch (element.rule) {
      case 'Declaration': {
        if (head.v === 'constant' || head.v === 'script') {
          const name = first.get(ns.find(node => node.rule === 'Name')!);
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
        const name = first.get(
          ns.find(
            node =>
              node.rule ===
              (element.rule === 'Handler' ? 'MessageName' : 'Name'),
          )!,
        );
        if (name) {
          declaration(
            name,
            element.rule === 'Handler' ? 'handler' : 'function',
          );
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
        const library = first.get(after[0]!)!;
        mark(library, 'library');
        const rename = after[1] ? first.get(after[1]) : undefined;
        for (const node of imported) {
          const name = first.get(node)!;
          if (rename) {
            mark(name, 'import');
          }
          const kind = importKind(library.v, name.v);
          if (kind) {
            declaration(rename ?? name, kind, {
              library: library.v,
              name: name.v,
            });
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
        const parent = parents.get(element)!;
        const prefix = tokens(parent)[0];
        if (parent.rule === 'MessageName') {
          mark(head, 'message');
        } else if (parent.rule === 'Parameter') {
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
            patternOf.get(element) || parents.get(element)?.rule === 'Replace',
          );
        }
        break;
      }
      case 'Primary': {
        if (!sites.has(head) && isName(head) && ts[0] === head && !ns.length) {
          mark(head, binaryOf.get(element) ? 'binary size' : 'value');
        }
        if (head.v === 'it') {
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
          mark(head, 'command');
        }
        break;
      }
      case 'AskTell': {
        // A bare Grant name is checked against Grants by the later effect pass.
        const target = ns.find(node => node.rule === 'Expression');
        if (target) {
          let base = target;
          while (nodes(base).length === 1 && tokens(base).length === 0) {
            base = nodes(base)[0]!;
          }
          const grant = first.get(base);
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
  for (const element of ordered) {
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
  for (const element of ordered) {
    if (element.kind !== 'node' || element.rule !== 'Container') {
      continue;
    }
    let base: SyntaxNode = element;
    for (;;) {
      const children = nodes(base);
      if (base.rule === 'Primary' && !children.length) {
        const root = first.get(base)!;
        mark(root, 'write', true);
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
      .filter((element): element is Token => element.kind === 'token')
      .map(token => [token.pos, token]),
  );
  for (const { site, kind, importedFrom } of declarationSites) {
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
        global.importedFrom)
    ) {
      clash(site, global);
    }
    if (
      site.name.role === 'write' &&
      global &&
      global.kind !== 'function' &&
      global.kind !== 'handler' &&
      !global.importedFrom
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
  for (const site of sites.values()) {
    if (
      site.name.binding ||
      !['value', 'call', 'binary size', 'command'].includes(site.name.role)
    ) {
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
          (parents.get(candidate.token)?.end ?? candidate.token.end) <=
          site.token.pos,
      );
      site.name.binding = earlier?.name.binding ?? null;
      if (!site.name.binding) {
        report('unknown name', site.token);
      }
    } else if (!binding) {
      report('unknown name', site.token);
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
      }
    }
  }
  const converted = new Map<SyntaxElement, SemanticElement>();
  for (const element of [...ordered].reverse()) {
    if (element.kind === 'token') {
      if (element.t === 'nl' || element.t === 'eof' || element.t === 'error') {
        continue;
      }
      converted.set(
        element,
        sites.get(element)?.name ?? {
          kind: 'token',
          type: element.t,
          text: element.v,
          raw: element.raw,
          span: span(element),
        },
      );
    } else {
      const start = first.get(element);
      const end = last.get(element);
      if (!start && element !== syntax) {
        continue;
      }
      converted.set(element, {
        kind: 'node',
        rule: element.rule,
        scope: scopeOf.get(element)!.id,
        children: element.children.flatMap(child => {
          const result = converted.get(child);
          return result ? [result] : [];
        }),
        span: start
          ? { ...span(start), end: end!.end }
          : { start: element.start, end: element.end, line: 1, col: 1 },
      });
    }
  }
  diagnostics.sort(
    (a, b) =>
      a.span.start - b.span.start ||
      diagnosticCodes.indexOf(a.code) - diagnosticCodes.indexOf(b.code),
  );
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    tree: {
      root: converted.get(syntax) as SemanticNode,
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
