import { expect, test } from 'bun:test';
import { text } from '@northtalk/ts';
import {
  createLanguageServer,
  type RpcMessage,
  type LspDiagnostic,
} from '../../stack/src/lsp';
import { StackEditor } from '../src/editing';
import { createElement, createProject, projectWithoutIds } from '../src/model';
import { PlaySession } from '../src/play';
import { settle } from '../src/message';
import {
  migrateProjectJson,
  readProjectFile,
  serializeProject,
  validateProjectJson,
  writeProjectFile,
} from '../src/project-file';
import { scriptManifest } from '../src/script-manifest';
import { libraryNameProblem } from '../src/script-names';
import { openProjectStorage } from '../src/storage';
import { createFakeIdb } from './fake-indexeddb';

const drain = (play: PlaySession) => {
  for (let i = 0; i < 100; i++) {
    if (play.pump(0n).state !== 'sliced') {
      return;
    }
  }
  throw new Error('Did not become idle');
};
const fixture = () => {
  const project = createProject('Library test');
  project.libraries = [
    {
      name: 'helpers',
      source:
        'use base from numbers\nfunction doubled x\n return base(x) * 2\nend doubled',
    },
    { name: 'numbers', source: 'function base x\n return x + 1\nend base' },
  ];
  project.pages[0]!.script =
    'use doubled from helpers\non openPage\n set the label of button1 to doubled(3) as text\nend openPage';
  project.pages[0]!.elements = [createElement('button', 'button1')];
  return project;
};

test('Libraries register in dependency order and use the caller Grants', () => {
  const project = fixture();
  project.libraries.push({
    name: 'visibility',
    source: 'on conceal target\n hide target\nend conceal',
  });
  project.pages[0]!.elements[0]!.script =
    'use conceal from visibility\non click\n conceal me\nend click';
  const play = new PlaySession(project);
  drain(play);
  expect(play.page.elements[0]).toMatchObject({ label: '8' });
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.page.elements[0]!.visible).toBe(false);
  expect(play.problems).toEqual([]);
  play.stop(0n);
});

test('broken drafts, missing imports and cycles isolate their dependents', () => {
  const project = fixture();
  project.libraries.push(
    { name: 'broken', source: 'function' },
    { name: 'missingImport', source: 'use absent from missing' },
    { name: 'cycleA', source: 'use b from cycleB\nconstant a = 1' },
    { name: 'cycleB', source: 'use a from cycleA\nconstant b = 2' },
  );
  project.pages[0]!.elements[0]!.script =
    'use absent from broken\non click\nend click';
  const play = new PlaySession(project);
  drain(play);
  expect(play.page.elements[0]).toMatchObject({ label: '8' });
  expect(play.problems.filter(p => p.target?.kind === 'library')).toHaveLength(
    4,
  );
  expect(play.problems.some(p => p.message === 'import cycle')).toBe(true);
  expect(
    play.problems.some(p => p.owner === project.pages[0]!.elements[0]),
  ).toBe(true);
  play.stop(0n);
});

test('a runtime Library error targets its own source, including a Library named project', () => {
  const project = fixture();
  project.libraries = [
    {
      name: 'project',
      source: 'function failNow\n return 1 div 0\nend failNow',
    },
  ];
  project.script =
    'use failNow from project\non startPlay\n put failNow() into result\nend startPlay';
  project.pages[0]!.script = '';
  const play = new PlaySession(project);
  drain(play);
  expect(play.problems).toMatchObject([
    { line: 2, target: { kind: 'library', library: project.libraries[0] } },
  ]);
  play.stop(0n);
});

test('loaded Message Box contexts retain their Library source until the next session', async () => {
  const project = fixture();
  const play = new PlaySession(project);
  drain(play);
  const target = play.messageTargets.find(t => t.label === 'page:page1')!;
  expect(target.manifest.libraries).toEqual(project.libraries);
  project.libraries[1]!.source = 'function base x\n return 100\nend base';
  const command = play.runMessage('doubled(3)', target.id);
  expect(command.ok).toBe(true);
  if (command.ok) {
    expect(await settle(play, command.result, () => play.pump(0n))).toEqual({
      text: '8',
    });
  }
  play.stop(0n);
  const next = new PlaySession(project);
  drain(next);
  expect(next.page.elements[0]).toMatchObject({ label: '200' });
  next.stop(0n);
});

test('Library identities and source survive edits, history, files and browser versions', async () => {
  const editor = new StackEditor(fixture());
  let id = 0;
  editor.edit(({ tree }) => {
    id = tree.addLibrary('draft', 'function').id!;
  });
  editor.edit(({ tree }) => tree.renameLibrary(id, 'unfinished'));
  editor.edit(({ tree }) => tree.setLibrarySource(id, 'constant answer = 42'));
  editor.edit(({ tree }) => tree.removeLibrary(id));
  expect(editor.project.libraries.some(l => l.id === id)).toBe(false);
  editor.undo();
  expect(editor.project.libraries.at(-1)).toMatchObject({
    id,
    name: 'unfinished',
    source: 'constant answer = 42',
  });
  editor.undo();
  editor.undo();
  expect(editor.project.libraries.at(-1)).toMatchObject({
    id,
    name: 'draft',
    source: 'function',
  });
  const serialized = serializeProject(editor.project);
  expect(JSON.stringify(serialized)).not.toContain('"id"');
  expect(serialized.format).toBe(4);
  const saved = await readProjectFile(
    await writeProjectFile(editor.project, new Map()),
  );
  expect(saved.project).toEqual(projectWithoutIds(editor.project));
  const copy = projectWithoutIds(editor.project);
  copy.libraries[0]!.source = 'changed';
  expect(editor.project.libraries[0]!.source).not.toBe('changed');
  const storage = await openProjectStorage(createFakeIdb().factory);
  const record = await storage.saveProject(undefined, editor.project);
  expect((await storage.loadProject(record.id)).project).toEqual(
    projectWithoutIds(editor.project),
  );
  storage.close();
});

test('older Projects migrate with no Libraries and invalid collection names are rejected', () => {
  const old: Record<string, unknown> = {
    ...serializeProject(createProject('Old')),
    format: 2,
  };
  delete old.libraries;
  const result = validateProjectJson(migrateProjectJson(old));
  expect('project' in result && result.project.libraries).toEqual([]);
  for (const name of ['text', '_', 'if', 'not a name']) {
    expect(libraryNameProblem(name)).toBeDefined();
  }
  expect(libraryNameProblem('project')).toBeUndefined();
  expect(libraryNameProblem('sound')).toBeUndefined();
  const editor = new StackEditor(fixture());
  expect(() => editor.edit(({ tree }) => tree.addLibrary('helpers'))).toThrow();
  expect(() => editor.edit(({ tree }) => tree.addLibrary('text'))).toThrow();
  const data = serializeProject(fixture());
  data.libraries = [
    { name: 'same', source: '' },
    { name: 'same', source: '' },
  ];
  expect('issues' in validateProjectJson(data)).toBe(true);
});

test('Library waits observe the importing Script messages', () => {
  const project = fixture();
  project.libraries = [
    {
      name: 'waiting',
      source: 'on answer\n wait for keyDown key\n return key\nend answer',
    },
  ];
  project.pages[0]!.script =
    'use answer from waiting\non openPage\n answer and wait\n set the label of button1 to it\nend openPage';
  const play = new PlaySession(project);
  drain(play);
  play.send(play.page, 'keyDown', [text('Y')]);
  drain(play);
  expect(play.problems).toEqual([]);
  expect(play.page.elements[0]).toMatchObject({ label: 'Y' });
  play.stop(0n);
});

test('Library edits and renames refresh importer diagnostics without leaking another Page names', () => {
  const project = fixture();
  const sent: RpcMessage[] = [];
  const server = createLanguageServer(message => sent.push(message));
  const uri = 'creative:///page.talk';
  server.configure({ manifest: scriptManifest(project, project.pages[0]!) });
  server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { capabilities: {} },
  });
  server.handle({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri,
        languageId: 'northtalk',
        version: 1,
        text: project.pages[0]!.script,
      },
    },
  });
  const diagnostics = () =>
    (
      sent.filter(m => m.method === 'textDocument/publishDiagnostics').at(-1)!
        .params as { diagnostics: LspDiagnostic[] }
    ).diagnostics;
  expect(diagnostics().filter(d => d.severity === 1)).toEqual([]);
  project.libraries[0]!.name = 'renamed';
  server.configure({ manifest: scriptManifest(project, project.pages[0]!) });
  expect(diagnostics().some(d => d.code === 'unknown import')).toBe(true);
});

test('Edit Message Box commands import Libraries in their selected authored Script', async () => {
  const { runInEdit } = await import('../src/message');
  const editor = new StackEditor(fixture());
  const reply = await runInEdit(
    editor,
    'set the label of button1 to doubled(6) as text',
    editor.page.id!,
  );
  expect(reply).toEqual({ text: undefined });
  expect(editor.page.elements[0]).toMatchObject({ label: '14' });
  editor.undo();
  expect(editor.page.elements[0]).toMatchObject({ label: 'Button' });
});
