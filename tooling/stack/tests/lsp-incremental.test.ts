import { expect, test } from 'bun:test';
import { readManifest } from '../src/lsp/manifest';
import {
  analyzeWorkspace,
  createWorkspace,
  type Analysis,
  type Document,
} from '../src/lsp/workspace';

const manifestData = {
  kind: 'demo',
  version: '1',
  language: '1.0-rc.3',
  grants: [],
  libraries: [
    {
      name: 'maths',
      version: '1',
      source: 'function twice x\n return x * 2\nend twice\n',
    },
  ],
  objects: [],
  messages: [{ name: 'tick', args: [] }],
};
const base = {
  uri: 'file:///base.talk',
  library: 'base',
  text: 'function double x\n return x * 2\nend double\n',
};
const mid = {
  uri: 'file:///mid.talk',
  library: 'mid',
  text: 'use double from base\nfunction quad x\n return double(double(x))\nend quad\n',
};
const app = {
  uri: 'file:///app.talk',
  text: 'use quad from mid\non run n\n put quad(n) into total\n return total\nend run\n',
};
const other = {
  uri: 'file:///other.talk',
  text: 'use twice from maths\non run n\n return twice(n)\nend run\n',
};

/** What an editor sees of an Analysis, without object identity. */
const view = (all: Map<string, Analysis>) =>
  Object.fromEntries(
    [...all].map(([uri, a]) => [
      uri,
      {
        ok: a.checked.ok,
        diagnostics: a.diagnostics,
        lints: a.lints,
        names: a.names.map(n => [n.text, n.role, n.span]),
        nodes: a.nodes.length,
        loaded: a.loaded !== undefined,
      },
    ]),
  );

test('incremental reanalysis matches a fresh analysis through a series of edits', () => {
  const workspace = createWorkspace();
  const manifest = readManifest(manifestData);
  let version = 0;
  const step = (
    docs: { library?: string; text: string; uri: string }[],
    m: typeof manifest | null = manifest,
    profile: 'standard' | 'beginner' = 'standard',
  ) => {
    const documents: Document[] = docs.map(d => ({ ...d, version: ++version }));
    const incremental = workspace.analyze(documents, m, profile);
    expect(view(incremental)).toEqual(
      view(analyzeWorkspace(documents, m, profile)),
    );
    return incremental;
  };
  const first = step([base, mid, app, other]);
  expect(first.get(app.uri)!.loaded).toBeDefined();

  // A body edit leaves base's export summary unchanged: importers keep their
  // check, and only the loaded units are rebuilt against the new code.
  const body = { ...base, text: base.text.replace('x * 2', 'x + x') };
  const edited = step([body, mid, app, other]);
  expect(edited.get(mid.uri)!.checked).toBe(first.get(mid.uri)!.checked);
  expect(edited.get(app.uri)!.checked).toBe(first.get(app.uri)!.checked);
  expect(edited.get(other.uri)!.checked).toBe(first.get(other.uri)!.checked);
  expect(edited.get(base.uri)!.loaded).not.toBe(first.get(base.uri)!.loaded);
  expect(edited.get(app.uri)!.loaded).not.toBe(first.get(app.uri)!.loaded);
  expect(edited.get(other.uri)!.loaded).toBe(first.get(other.uri)!.loaded);

  // An edit to an unrelated Script reuses every Library as it was.
  const tweak = {
    ...app,
    text: app.text.replace('total\nend', 'total + 0\nend'),
  };
  const again = step([body, mid, tweak, other]);
  expect(again.get(mid.uri)!.loaded).toBe(edited.get(mid.uri)!.loaded);
  expect(again.get(app.uri)!.checked).not.toBe(edited.get(app.uri)!.checked);

  // Exported signature changes reach importers transitively.
  const signature = {
    ...base,
    text: 'function double x, y\n return x * y\nend double\n',
  };
  const changed = step([signature, mid, tweak, other]);
  expect(changed.get(mid.uri)!.checked).not.toBe(again.get(mid.uri)!.checked);
  step([base, mid, tweak, other]);

  // Imports added, broken and removed; a Library cycle; a closed document.
  step([base, mid, { ...app, text: `use double from base\n${app.text}` }]);
  step([base, mid, { ...app, text: app.text.replace('mid', 'nowhere') }]);
  const cycle = {
    ...base,
    text: `use quad from mid\n${base.text}`,
  };
  step([cycle, mid, app]);
  step([cycle, mid, app]);
  step([base, app]);
  step([base, mid, app, other]);

  // A workspace Library overriding the manifest's copy, then closed again.
  const maths = {
    uri: 'file:///maths.talk',
    library: 'maths',
    text: 'function twice x\n return x + x\nend twice\n',
  };
  step([maths, other]);
  step([other]);

  // Manifest and Lint profile changes.
  step([base, mid, app, other], null);
  step([base, mid, app, other], readManifest(manifestData));
  step([base, mid, app, other], manifest, 'beginner');
  step([base, mid, { ...app, text: 'on run\n  return 1 +\nend run\n' }]);
});
