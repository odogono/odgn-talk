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

## Lints

`@odgn/northtalk-tooling/lint` is the browser-safe Lint engine over the TS Core's lossless recovering parser. It imports only `@odgn/northtalk`. It runs under Bun, Node, and browser workers; file and process handling belongs to [`tooling/cli`](../cli/). Tooling advice is outside parity and never changes loading, Trace lines or Fuel ([chapter 12](../../spec/12-sessions-and-tooling.md#layers-and-lints), [ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

```ts
import { lint, lintSyntax } from '@odgn/northtalk-tooling/lint';
import { parseSourceRecovering } from '@odgn/northtalk';

const { lints, diagnostics } = lint(source, { profile: 'beginner' });
const advice = lintSyntax(parseSourceRecovering(source).tree, {
  profile: 'standard',
});
```

`lint` returns advice and syntax recovery diagnostics separately. `lintSyntax` reuses an existing lossless tree. Each Lint has `id`, `level`, `message` and a `span` (`start`, `end`, `line`, `col`). Offsets index the original TS string, and line/column positions are one-based Unicode scalar counts. Advice is sorted by source offset and then id. Error regions and malformed expressions are opaque, while enclosing blocks keep their valid siblings. The caller selects `beginner` or `standard`; the default is `standard`.

The [catalogue](lints.toml) ships all eighteen ids, levels and wording templates. Eleven syntax-based Lints are implemented; seven binding/Host Manifest entries have `status = "planned"` and emit no advice (follow-up scope on [#241](https://github.com/odogono/odgn-talk/issues/241)). This engine does not perform binding, Grant or manifest checks.

- `advanced-construct` reads generated `grammar.toml` tags and their Beginner Surface replacements. Syntax recognition maps pins, pinned Binary Pattern sizes, code point chunks/properties and lazy Text Pattern elements to those tags; the tags decide whether each is advanced.
- `prefer-explicit-end` flags a bare ending at its `end` token, suggesting the matching name or keyword.
- `suggest-ignoring-case` uses a syntax-only heuristic: a case-sensitive comparison with a word-bearing literal text operand. Variables alone, kind tests and emptiness tests do not establish intent.
- `whole-value-when` flags a whole-value Match branch with a lone literal Text Pattern, such as `when <"WARN">`. Anchored patterns, captures and `when contains` communicate different intent and are left alone.
- `inline-block-lambda` flags a block Lambda within an argument expression; a named Lambda or expression Lambda is left alone.
- `long-join-body` counts physical source lines between the `wait for all` head and its ending, excluding both, including blank/comment lines. More than 20 is long; the threshold lives in the catalogue.
- `plain-send-in-join` and `conditional-join-member` track the nearest Join and `if` bodies within it. Lambda bodies start their own context; an `if` outside a Join does not make its members conditional.
- `ambiguous-ignoring-case` flags a trailing modifier on an `and`/`or` chain, with parentheses marking an explicitly grouped comparison.
- `key-shadows-property` checks map literal keys against the generated Built-in property list, including quoted keys. Destructuring keys are not map literal keys.
- `unconvertible-literal` delegates literal Civil Date/Instant conversion to the Core's pure `canConvert` helper. It does not evaluate arbitrary expressions or earlier conversions.

A standalone `-- lint: ignore <id>` comment on the preceding physical line suppresses that id there, without changing parsing. It suppresses neither other ids nor later lines. Suppression uses lossless comment trivia, so directive-looking text literals do not count.

From a clean checkout:

```sh
bun install
bun run northtalk lint --profile beginner example.talk
bun run lints:generate  # after editing the catalogue or grammar tags/properties
bun run lints:check    # detects stale generated tables, also run in CI
bun run --cwd tooling/stack test
bun run --cwd tooling/stack test:node
bun run --cwd tooling/stack build  # browser-target bundle
bun run --cwd tooling/stack test:browser  # open the printed local URL
```

The same positive/negative fixtures run under Bun, Node and the browser smoke page. Lint fixtures are tooling tests, separate from the Conformance Corpus.
