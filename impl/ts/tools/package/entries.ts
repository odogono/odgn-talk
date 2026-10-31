// The subpaths @northtalk/ts publishes, and the source each one builds from.
// `./replay` stays out: it is Corpus machinery that reads the Spec's
// corpus.toml, and only the workspace's tools use it. `./sqlite` and `./http`
// are server-only: node:sqlite and node:http.
export const entries = {
  '.': 'src/index.ts',
  './lean': 'src/lean.ts',
  './stdlib/bytes': 'src/generated/stdlib/bytes.ts',
  './stdlib/date': 'src/generated/stdlib/date.ts',
  './stdlib/json': 'src/generated/stdlib/json.ts',
  './stdlib/list': 'src/generated/stdlib/list.ts',
  './stdlib/map': 'src/generated/stdlib/map.ts',
  './stdlib/text': 'src/generated/stdlib/text.ts',
  './stdlib/units': 'src/generated/stdlib/units.ts',
  './message-layer': 'src/message-layer.ts',
  './session': 'src/session/index.ts',
  './store': 'src/store/index.ts',
  './notify': 'src/notify/index.ts',
  './sqlite': 'src/sqlite/index.ts',
  './http': 'src/http/index.ts',
  './setup': 'src/setup.ts',
  './debug': 'src/debug-api.ts',
  './driver': 'src/driver.ts',
  './wasm': 'src/wasm/index.ts',
} as const;

export type Subpath = keyof typeof entries;

/** The built file's name, without extension: `index` for `.`, else the subpath's name. */
export const outputName = (subpath: Subpath) =>
  subpath === '.' ? 'index' : subpath.slice(2);
