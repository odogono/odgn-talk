import { expect, test } from 'bun:test';
import {
  createLanguageServer,
  type LspDiagnostic,
  type RpcMessage,
} from '../../stack/src/lsp';
import { readManifest } from '../../stack/src/lsp/manifest';
import { StackEditor } from '../src/editing';
import {
  createElement,
  createPage,
  createProject,
  ELEMENT_KINDS,
} from '../src/model';
import { scriptManifest } from '../src/script-manifest';
import { createSampleProject } from '../src/sample';

const fixture = () => {
  const project = createProject('Story');
  const page = project.pages[0]!;
  page.elements = ELEMENT_KINDS.map(kind => createElement(kind, `${kind}1`));
  const other = createPage('otherPage');
  other.elements.push(createElement('button', 'otherButton'));
  project.pages.push(other);
  return { project, page, other };
};

test('each owner gets its scoped names, typed properties and three Grants', () => {
  const { project, page } = fixture();
  for (const owner of [project, page, ...page.elements]) {
    const manifest = readManifest(scriptManifest(project, owner));
    expect(manifest.objects).toEqual(
      owner === project
        ? project.pages.map(p => p.name)
        : [
            ...project.pages.map(p => p.name),
            ...page.elements.map(e => e.name),
            'thisPage',
            'project',
          ],
    );
    expect([...manifest.grants.keys()]).toEqual(['pages', 'elements', 'sound']);
    expect([...manifest.grants.get('elements')!.keys()]).toEqual([
      'create',
      'clone',
      'delete',
      'find',
    ]);
    expect(manifest.objects).not.toContain('otherButton');
    expect(
      manifest.objectKinds.get('button')!.props.get('label')!.shape,
    ).toEqual({ k: 'kind', kind: 'text' });
    expect(manifest.objectKinds.get('page')!.props.get('name')!.readOnly).toBe(
      true,
    );
    expect(manifest.objectKinds.get('text')!.props.has('editable')).toBe(true);
  }
});

const language = (manifest: unknown, text: string) => {
  const sent: RpcMessage[] = [];
  const server = createLanguageServer(message => sent.push(message));
  server.configure({ manifest });
  server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { capabilities: {} },
  });
  const uri = 'creative:///test.talk';
  server.handle({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri, languageId: 'northtalk', version: 1, text },
    },
  });
  const diagnostics = () =>
    (
      sent.filter(m => m.method === 'textDocument/publishDiagnostics').at(-1)!
        .params as { diagnostics: LspDiagnostic[] }
    ).diagnostics;
  return { server, diagnostics, sent, uri };
};

test('sample Project custom messages have no unknown-message hints', async () => {
  const { project } = await createSampleProject();
  for (const owner of [
    project,
    ...project.pages.flatMap(p => [p, ...p.elements]),
  ]) {
    const { diagnostics } = language(
      scriptManifest(project, owner),
      owner.script ?? '',
    );
    expect(diagnostics().filter(d => d.code === 'unknown-message')).toEqual([]);
  }
});

test('custom messages retain selectors and arity without declaring strings or fallback handlers', () => {
  const { project, page } = fixture();
  for (const owner of [project, page, page.elements[0]!]) {
    owner.script = `on found clue
end found
on move piece to square
end move
on found clue where clue is nothing
end found
on any message m
end any message
on keyDown key
end keyDown
constant example = "on fake"
`;
    const data = scriptManifest(project, owner);
    const manifest = readManifest(data);
    expect(data.messages.filter(m => m.name === 'found')).toEqual([
      { name: 'found', args: ['value'] },
    ]);
    expect(data.messages.find(m => m.name === 'move:to:')!.args).toEqual([
      'value',
      'value',
    ]);
    expect(data.messages.find(m => m.name === 'keyDown')!.args).toEqual([
      'text',
    ]);
    expect(manifest.messages).not.toContain('fake');
    expect(manifest.messages).not.toContain('any');
    expect(
      language(data, owner.script)
        .diagnostics()
        .filter(d => d.code === 'unknown-message'),
    ).toEqual([]);
  }
});

test('built-in hide and show are completed, documented and checked, unless the Script answers them', () => {
  const { project, page } = fixture();
  const owner = page.elements.find(e => e.kind === 'button')!;
  const request = (
    server: ReturnType<typeof language>['server'],
    sent: RpcMessage[],
    uri: string,
    method: string,
    line: number,
    character: number,
  ) => {
    server.handle({
      jsonrpc: '2.0',
      id: 2,
      method,
      params: { textDocument: { uri }, position: { line, character } },
    });
    return sent.at(-1)!.result as never;
  };
  const source = 'on click\n  hi\n  hide\n  show text1\nend click\n';
  const { server, sent, uri, diagnostics } = language(
    scriptManifest(project, owner),
    source,
  );
  const items: { label: string }[] = request(
    server,
    sent,
    uri,
    'textDocument/completion',
    1,
    4,
  );
  expect(items.map(i => i.label)).toContain('hide');
  const hover: { contents: { value: string } } = request(
    server,
    sent,
    uri,
    'textDocument/hover',
    2,
    3,
  );
  expect(hover.contents.value).toContain('Hides an Element');
  expect(
    diagnostics()
      .filter(d => d.code === 'message-argument-count')
      .map(d => d.range.start.line),
  ).toEqual([2]);
  expect(diagnostics().filter(d => d.code === 'unknown-message')).toEqual([]);

  // A Script's own `on hide` answers first, in hover and argument checks.
  owner.script = 'on hide\nend hide\non click\n  hide\nend click\n';
  const own = language(scriptManifest(project, owner), owner.script);
  const ownHover: { contents: { value: string } } = request(
    own.server,
    own.sent,
    own.uri,
    'textDocument/hover',
    3,
    3,
  );
  expect(ownHover.contents.value).not.toContain('Hides an Element');
  expect(
    own.diagnostics().filter(d => d.code === 'message-argument-count'),
  ).toEqual([]);
});

test('LSP diagnoses misspelt names and refreshes after renames on each Page', () => {
  const { project, page, other } = fixture();
  const source =
    'on click\n  put the label of button1 into message\nend click\n';
  const local = language(scriptManifest(project, page), source);
  const remote = language(scriptManifest(project, other), source);
  expect(local.diagnostics().filter(d => d.severity === 1)).toEqual([]);
  expect(remote.diagnostics().some(d => d.code === 'unknown name')).toBe(true);
  const editor = new StackEditor(project);
  editor.renameElement('button1', 'renamedButton');
  local.server.configure({ manifest: scriptManifest(project, page) });
  expect(local.diagnostics().some(d => d.code === 'unknown name')).toBe(true);
  editor.undo();
  local.server.configure({ manifest: scriptManifest(project, editor.page) });
  expect(local.diagnostics().filter(d => d.severity === 1)).toEqual([]);
});

test('LSP offers kind-specific properties for bound names', () => {
  const { project, page } = fixture();
  const { server, sent, uri } = language(
    scriptManifest(project, page),
    'on click\n  put the label of button1 into x\nend click\n',
  );
  server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'textDocument/completion',
    params: {
      textDocument: { uri },
      position: { line: 1, character: 12 },
    },
  });
  const items = sent.at(-1)!.result as { label: string }[];
  expect(items.some(item => item.label === 'label')).toBe(true);
});

test('window identities follow owners through rename, reorder and history without entering authored data', () => {
  const { project, page } = fixture();
  const editor = new StackEditor(project);
  const button = page.elements.find(e => e.kind === 'button')!;
  const id = editor.identity(button);
  editor.renameElement(button.name, 'newButton');
  editor.movePage(0, 1);
  expect(
    editor.identity(
      project.pages[1]!.elements.find(e => e.name === 'newButton')!,
    ),
  ).toBe(id);
  editor.undo();
  editor.undo();
  expect(editor.identity(editor.element('button1')!)).toBe(id);
  editor.redo();
  expect(editor.identity(editor.element('newButton')!)).toBe(id);
  expect(JSON.stringify(project)).not.toContain('identities');
});

test('the declared Grants accept the settled call forms', () => {
  const { project, page } = fixture();
  const calls = [
    'tell pages to show thisPage',
    'ask elements to create "button", thisPage',
    'ask elements to create "button", thisPage, "newButton"',
    'ask elements to clone button1',
    'tell elements to delete button1',
    'ask elements to find "button1", thisPage',
    'tell sound to play "waves"',
    'tell sound to loop "rain"',
    'tell sound to stop "rain"',
    'tell sound to stop',
  ];
  for (const call of calls) {
    const { diagnostics } = language(
      scriptManifest(project, page),
      `on click\n  ${call}\nend click\n`,
    );
    expect(diagnostics().filter(d => d.severity === 1)).toEqual([]);
  }
});
