// The published package.json, derived from the workspace's. The workspace's
// stays private and exports source, so the tools in tooling/ never need a build.
import { coreVersions } from '../../src/versions';
import { outputName, type Subpath } from './entries';

/** The published version: the `ts/x.y.z` that coreVersions reports. A release bumps it there. */
export const version = coreVersions.core.replace(/^ts\//, '');

type Source = { license: string; name: string; type: string };

export const manifest = (source: Source, subpaths: readonly Subpath[]) => ({
  name: source.name,
  version,
  description:
    'NorthTalk, a readable scripting language for embedding: the TS Core, its Session Host and Standard Capabilities.',
  license: source.license,
  type: source.type,
  homepage: 'https://github.com/odogono/odgn-talk/tree/main/impl/ts#readme',
  repository: {
    type: 'git',
    url: 'git+https://github.com/odogono/odgn-talk.git',
    directory: 'impl/ts',
  },
  bugs: 'https://github.com/odogono/odgn-talk/issues',
  keywords: ['northtalk', 'scripting', 'language', 'interpreter', 'embedding'],
  engines: { node: '>=24.10' },
  sideEffects: false,
  exports: Object.fromEntries([
    ...subpaths.map(subpath => {
      const file = `./${outputName(subpath)}`;
      return [subpath, { types: `${file}.d.ts`, default: `${file}.js` }];
    }),
    ['./package.json', './package.json'],
  ]),
});
