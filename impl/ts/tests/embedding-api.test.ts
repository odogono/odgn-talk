// Holds the embedding interface both Cores implement (ADR 0121) to the spec's
// declarations, as impl/go/internal/apicheck holds the Go API to talk.go, and
// the two entry points' exports to each other.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const parse = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.ESNext,
  );

// Each member's parameter names, or null for a property.
type Members = Record<string, string[] | null>;

const membersOf = (file: ts.SourceFile, name: string): Members => {
  let members: ts.NodeArray<ts.TypeElement> | undefined;
  file.forEachChild(node => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      members = node.members;
    } else if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === name &&
      ts.isTypeLiteralNode(node.type)
    ) {
      members = node.type.members;
    }
  });
  if (!members) {
    throw new Error(`${file.fileName} declares no ${name}`);
  }
  const out: Members = {};
  for (const m of members) {
    const key = m.name?.getText(file) ?? '';
    // An overload keeps its first signature's parameters.
    if (key in out) {
      continue;
    }
    out[key] = ts.isMethodSignature(m)
      ? m.parameters.map(p => p.name.getText(file))
      : null;
  }
  return out;
};

const parametersOf = (file: ts.SourceFile, name: string): string[] => {
  let found: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node.parameters.map(p => p.name.getText(file));
    } else if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === name &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      found = node.initializer.parameters.map(p => p.name.getText(file));
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (!found) {
    throw new Error(`${file.fileName} declares no ${name}`);
  }
  return found;
};

// A property in one file may be a method in the other, as the TS Core's
// constructors are `typeof` its free functions; only names are compared then.
const comparable = (a: Members, b: Members) => {
  const names = (m: Members) => Object.keys(m).sort();
  const params = (m: Members, other: Members) =>
    Object.fromEntries(Object.entries(m).filter(([k, v]) => v && other[k]));
  return [
    { names: names(a), params: params(a, b) },
    { names: names(b), params: params(b, a) },
  ];
};

describe('the embedding interface matches spec/embedding/talk.ts', () => {
  const spec = parse('../../spec/embedding/talk.ts');
  const embedding = parse('src/embedding.ts');
  const driver = parse('src/driver.ts');

  for (const name of ['Core', 'Group', 'Script']) {
    test(name, () => {
      const [actual, expected] = comparable(
        membersOf(embedding, name),
        membersOf(spec, name),
      );
      expect(actual).toEqual(expected);
    });
  }

  for (const name of ['Drive', 'AutoDriveOptions']) {
    test(`driver ${name}`, () => {
      const [actual, expected] = comparable(
        membersOf(driver, name),
        membersOf(spec, name),
      );
      expect(actual).toEqual(expected);
    });
  }

  for (const name of ['newDrivenGroup', 'autoDrive']) {
    test(`driver ${name}`, () => {
      expect(parametersOf(driver, name)).toEqual(parametersOf(spec, name));
    });
  }

  test('createGroup Helper', () => {
    for (const file of ['src/create-group.ts', 'src/group-helper.ts']) {
      expect(parametersOf(parse(file), 'createGroup')).toEqual(
        parametersOf(spec, 'createGroup'),
      );
    }
  });

  test('handlersOf Helper', () => {
    expect(parametersOf(parse('src/handlers.ts'), 'handlersOf')).toEqual(
      parametersOf(spec, 'handlersOf'),
    );
  });

  test('inlineGrants Helper', () => {
    expect(parametersOf(parse('src/inline-grants.ts'), 'inlineGrants')).toEqual(
      parametersOf(spec, 'inlineGrants'),
    );
  });
});

// Exports of @northtalk/ts that @northtalk/ts/wasm leaves out on purpose: the
// TS Core's own classes and free functions (the adapter's are on its Core),
// its save extras, and the parsing, lowering and machine tooling. Anything
// else the root gains, the adapter must export too.
const tsOnly = new Set([
  // The TS Core's classes, free Core functions and save extras.
  'TsCore',
  'TsGroup',
  'TsScript',
  'coreVersions',
  'calendarCapability',
  'clockCapability',
  'compileLibrary',
  'consoleCapability',
  'defineCapability',
  'defineObjectKind',
  'httpCapability',
  'localeCapability',
  'newGroup',
  'restore',
  'sqliteCapability',
  'storeCapability',
  'timerCapability',
  'userCapability',
  'LibraryOptions',
  'SaveOptions',
  'ScriptCodeRequest',
  'ScriptSources',
  // Parsing, checking, lowering and the Abstract Machine.
  'Binding',
  'BindingKind',
  'Body',
  'BodyKind',
  'CheckOptions',
  'CheckResult',
  'CodeUnit',
  'CompileOptions',
  'CompileResult',
  'CompiledScript',
  'Diagnostic',
  'DiagnosticCode',
  'EntryKind',
  'EntryResult',
  'EventBranch',
  'EventEntry',
  'ExportKind',
  'FunctionContract',
  'FunctionResolver',
  'Instruction',
  'Lexer',
  'LibraryExport',
  'LoweringError',
  'Mode',
  'NameRole',
  'NotImplementedError',
  'Operand',
  'ParseError',
  'ParseResult',
  'RecoveringParseResult',
  'RecoveryDiagnostic',
  'Run',
  'RunRecord',
  'SemanticElement',
  'SemanticName',
  'SemanticNode',
  'SemanticResult',
  'SemanticScope',
  'SemanticToken',
  'SemanticTree',
  'SourceSpan',
  'SyntaxElement',
  'SyntaxErrorCode',
  'SyntaxNode',
  'SyntaxRule',
  'TokType',
  'Token',
  'Trivia',
  'UnitLoadError',
  'UnwindEntry',
  'builtins',
  'callFunction',
  'canConvert',
  'checkSource',
  'checkSyntax',
  'codeIdentity',
  'compileSource',
  'declarationStart',
  'deliver',
  'disassemble',
  'exportsOf',
  'grammar',
  'kindNames',
  'loadScript',
  'lowerTree',
  'parseEntry',
  'parseSource',
  'parseSourceRecovering',
  'stdlibSources',
  'syntaxSelector',
  'syntaxText',
  'units',
  'validMessageSelector',
  'waitUs',
]);

test('@northtalk/ts/wasm exports all of @northtalk/ts but its TS-only names', () => {
  const entries = ['src/index.ts', 'src/wasm/index.ts'].map(p =>
    resolve(root, p),
  );
  const program = ts.createProgram(entries, {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
  });
  const checker = program.getTypeChecker();
  const [core, adapter] = entries.map(
    p =>
      new Set(
        checker
          .getExportsOfModule(
            checker.getSymbolAtLocation(program.getSourceFile(p)!)!,
          )
          .map(s => s.name),
      ),
  );
  const missing = [...core!].filter(n => !adapter!.has(n) && !tsOnly.has(n));
  const stale = [...tsOnly].filter(n => !core!.has(n) || adapter!.has(n));
  expect({ missing, stale }).toEqual({ missing: [], stale: [] });
});
