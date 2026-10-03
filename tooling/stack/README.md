# NorthTalk tooling

`@odgn/northtalk-tooling` is the browser-safe TypeScript tooling stack over
`@odgn/northtalk`. It imports only the Core; file, stdio and process handling
belong to [`tooling/cli`](../cli/). Tooling output is outside conformance parity
([ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Formatter

```ts
import { formatSource } from '@odgn/northtalk-tooling/format';

const { source, error } = formatSource('on greet\nsay "hello"\nend greet\n');
```

`formatSource` returns `{ source, error }`. A syntax error returns the original
source and the Core's `ParseError`; it never formats a partial tree. Invalid
Unicode scalar text throws the Core's `HostError`, as `parseSource` does.
Checking bindings or supplying a Host Manifest is unnecessary for formatting.

There are no layout options. The formatter uses two spaces per block and one
extra level for continuation lines and `match` / block `wait for` branch heads.
It normalises spacing within each line, preserves token spelling and comment
text, and keeps at most one consecutive blank line. It preserves all other
line breaks, including their LF, CRLF or CR spelling, the BOM, and whether
the source ends in a newline. Comments are only re-indented; trailing comments
have one space before them. Spacing that distinguishes syntax, such as
`say (x)` versus `say(x)` and `< <` versus `<<`, is retained.

From a clean checkout, with Bun 1.4.2, run these commands at the repository root:

```sh
bun install
bun run northtalk fmt script.talk another.talk
bun run northtalk fmt --check script.talk
printf 'on greet\nsay "hello"\nend greet\n' | bun run northtalk fmt -
```

For Node 22 or later, build the CLI with Bun and run the resulting JavaScript:

```sh
bun run --cwd tooling/cli build
node tooling/cli/dist/main.js fmt script.talk
node tooling/cli/dist/main.js fmt --check script.talk
```

`fmt` writes files in place; `-` reads stdin and writes formatted source to
stdout. `--check` writes nothing and exits with 1 if any file needs formatting.
Syntax errors and file errors also exit with 1, are reported on stderr, and do
not prevent the remaining files from being processed. Broken stdin source is
returned unchanged on stdout unless `--check` is set. Invalid arguments exit
with 2.

`bun run --cwd tooling/stack test` checks idempotence, tokens, comments, line
endings and canonical Disassembly (ignoring instruction source positions) over
every `.talk` file in `corpus/` and `spec/`, including the Standard Libraries,
and every `talk` example in the Spec. Snippets that demonstrate load-time errors
or omit their Host declarations have no Disassembly; their diagnostics are
compared instead. CI also executes the browser bundle with standard Web APIs
and no Bun or Node globals, and tests the CLI under both Bun and Node.
