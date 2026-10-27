// Reproduce the paired workers for the compact-frontend measurements.
// Run from the repository root; output stays beside the normal benchmark entry.
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? '01864c1f';
const baseline = new Map(
  ['parser', 'checker', 'library', 'lowering'].map(name => [
    `impl/ts/src/${name}.ts`,
    execFileSync('git', ['show', `${base}:impl/ts/src/${name}.ts`], {
      encoding: 'utf8',
    }),
  ]),
);
const builds: { entry: string; target: 'bun' | 'node' }[] = [
  { entry: 'measure-ts', target: 'bun' },
  { entry: 'measure-load', target: 'node' },
];
for (const { entry, target } of builds) {
  for (const variant of ['before', 'after']) {
    const result = await Bun.build({
      entrypoints: [`bench/ts/src/${entry}.ts`],
      plugins:
        variant === 'before'
          ? [
              {
                name: 'compact-frontend-baseline',
                setup(build) {
                  build.onLoad(
                    {
                      filter:
                        /\/impl\/ts\/src\/(parser|checker|library|lowering)\.ts$/,
                    },
                    args => ({
                      contents: [...baseline].find(([path]) =>
                        args.path.endsWith(`/${path}`),
                      )![1],
                      loader: 'ts',
                    }),
                  );
                },
              },
            ]
          : [],
      target,
    });
    if (!result.success) {
      throw new Error(result.logs.join('\n'));
    }
    await Bun.write(
      `bench/ts/dist/compact-${target}-${variant}.js`,
      result.outputs[0]!,
    );
  }
}
