// The published package.json, derived from the workspace's. The workspace's
// stays private and exports source, so Folio never needs a build.

type Source = {
  dependencies: Record<string, string>;
  license: string;
  name: string;
  type: string;
  version: string;
};

/** The CodeMirror packages the Host shares with the editor (ADR 0182). */
const codemirrorPeers = [
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/state',
  '@codemirror/view',
] as const;

/** The Core range the editor's highlighting supports. */
export const corePeer = '>=0.9.0 <1.0.0';

export const manifest = (source: Source) => ({
  name: source.name,
  version: source.version,
  description:
    'CodeMirror 6 extensions for a NorthTalk code field: highlighting, a theme and diagnostics a Host sets from outside.',
  license: source.license,
  type: source.type,
  homepage:
    'https://github.com/odogono/odgn-talk/tree/main/tooling/editor#readme',
  repository: {
    type: 'git',
    url: 'git+https://github.com/odogono/odgn-talk.git',
    directory: 'tooling/editor',
  },
  bugs: 'https://github.com/odogono/odgn-talk/issues',
  keywords: ['northtalk', 'codemirror', 'editor', 'syntax-highlighting'],
  sideEffects: false,
  exports: {
    '.': { types: './index.d.ts', default: './index.js' },
    './package.json': './package.json',
  },
  dependencies: {
    '@lezer/highlight': source.dependencies['@lezer/highlight'],
  },
  peerDependencies: {
    '@northtalk/ts': corePeer,
    ...Object.fromEntries(codemirrorPeers.map(name => [name, '^6.0.0'])),
  },
});
