import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [entry, output] = process.argv.slice(2);
const result = await Bun.build({
  entrypoints: [entry!],
  target: 'node',
  plugins: [
    {
      name: 'suite-path',
      setup(build) {
        build.onLoad({ filter: /\/suite\.ts$/ }, args => ({
          contents: readFileSync(args.path, 'utf8').replaceAll(
            'import.meta.dir',
            JSON.stringify(dirname(args.path)),
          ),
          loader: 'ts',
        }));
      },
    },
  ],
});
if (!result.success) {
  throw new Error(result.logs.join('\n'));
}
await Bun.write(output!, result.outputs[0]!);
