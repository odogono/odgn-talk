// The `talk` tag: NorthTalk source written inline in TypeScript. It reads the
// raw template, so NorthTalk escapes reach the lexer unchanged, and strips the
// common indentation so source can follow the surrounding code.

const blank = /^[\t ]*$/;

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return a.slice(0, i);
};

/**
 * Dedents NorthTalk source; rejects JS interpolation.
 *
 * Write NorthTalk's own interpolation as `\${…}` and its backticks as `` \` ``.
 * Pass values as Request arguments instead of splicing them into source. The
 * longest whitespace prefix shared by every non-blank line is removed, compared
 * exactly, so tabs and spaces never match each other.
 */
export const talk = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): string => {
  if (values.length > 0) {
    throw new TypeError(
      'talk source cannot interpolate JS values; write NorthTalk interpolation as \\${…} or pass the value as a Request argument',
    );
  }
  const source = strings.raw[0]!.replaceAll(
    /\\([\S\s])/g,
    (escape, c: string) => (c === '`' || c === '$' ? c : escape),
  );
  const lines = source.split('\n');
  if (lines.length > 1 && blank.test(lines[0]!)) {
    lines.shift();
  }
  if (lines.length > 1 && blank.test(lines.at(-1)!)) {
    lines.pop();
  }
  let margin: string | undefined;
  for (const line of lines) {
    if (blank.test(line)) {
      continue;
    }
    const indent = /^[\t ]*/.exec(line)![0];
    margin = margin === undefined ? indent : commonPrefix(margin, indent);
  }
  return lines
    .map(line => (blank.test(line) ? '' : line.slice(margin!.length)))
    .join('\n');
};
