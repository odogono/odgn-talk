// Tooling fixtures, outside the Conformance Corpus (ADR 0028).
const script = (body: string) => `on demo\n${body}\nend demo`;
const join = (lines: number) =>
  script(`wait for all\n${'say 1\n'.repeat(lines)}end wait`);
export const fixtures = [
  {
    id: 'advanced-construct',
    positive: 'on demo {order: ^orderId}\nend demo',
    negative: 'on demo {order: o} where o = orderId\nend demo',
  },
  {
    id: 'advanced-construct',
    positive: 'on demo <<data: ^n bytes>>\nend demo',
    negative: 'on demo <<data: 4 bytes>>\nend demo',
  },
  {
    id: 'advanced-construct',
    positive: 'on demo <<data: (^n + 1) bytes>>\nend demo',
    negative: 'on demo <<data: (n + 1) bytes>>\nend demo',
  },
  {
    id: 'advanced-construct',
    positive: script('put code point 1 of s into x'),
    negative: script('put character 1 of s into x'),
  },
  {
    id: 'advanced-construct',
    positive: script('put the first code point of s into x'),
    negative: script('put the first character of s into x'),
  },
  {
    id: 'advanced-construct',
    positive: script("put s's code points into x"),
    negative: script('put the characters of s into x'),
  },
  {
    id: 'advanced-construct',
    positive: script('put the code points of s into x'),
    negative: script('put the "code points" of s into x'),
  },
  {
    id: 'advanced-construct',
    positive: 'on demo <text lazily>\nend demo',
    negative: 'on demo <text>\nend demo',
  },
  {
    id: 'prefer-explicit-end',
    positive: 'on demo\nif true then\nsay 1\nend\nend',
    negative: 'on demo\nif true then\nsay 1\nend if\nend demo',
  },
  {
    id: 'suggest-ignoring-case',
    positive: script('if name = "Ann" then say 1'),
    negative: script('if name = "Ann" ignoring case then say 1'),
  },
  {
    id: 'whole-value-when',
    positive: script('match s\nwhen <"WARN"> then say 1\nend match'),
    negative: script('match s\nwhen contains <"WARN"> then say 1\nend match'),
  },
  {
    id: 'inline-block-lambda',
    positive: script('put f(given x\nreturn x\nend given) into y'),
    negative: script(
      'put given x\nreturn x\nend given into fn\nput f(fn) into y',
    ),
  },
  {
    id: 'inline-block-lambda',
    positive: script('apply given x\nreturn x\nend given'),
    negative: script('apply given x: x'),
  },
  { id: 'long-join-body', positive: join(21), negative: join(20) },
  {
    id: 'plain-send-in-join',
    positive: script('wait for all\nsend ping to me\nend wait'),
    negative: script('wait for all\nsend ping to me and wait\nend wait'),
  },
  {
    id: 'conditional-join-member',
    positive: script(
      'wait for all\nif true then send ping to me and wait\nend wait',
    ),
    negative: script('wait for all\nsend ping to me and wait\nend wait'),
  },
  {
    id: 'conditional-join-member',
    positive: script(
      'wait for all\nif true then ask http to get and wait\nend wait',
    ),
    negative: script(
      'if true then\nwait for all\nask http to get and wait\nend wait\nend if',
    ),
  },
  {
    id: 'ambiguous-ignoring-case',
    positive: script('if a = "x" or b = "y" ignoring case then say 1'),
    negative: script('if a = "x" or (b = "y" ignoring case) then say 1'),
  },
  {
    id: 'key-shadows-property',
    positive: script('put {length: 3} into x'),
    negative: script('put {size: 3} into x'),
  },
  {
    id: 'key-shadows-property',
    positive: script('put {"code points": 3} into x'),
    negative: 'on demo {length: n}\nend demo',
  },
  {
    id: 'unconvertible-literal',
    positive: script('put "2025-02-29" as civil date into x'),
    negative: script('put "2024-02-29" as civil date into x'),
  },
  {
    id: 'unconvertible-literal',
    positive: script('put "2024-02-29" as instant into x'),
    negative: script('put "2024-02-29T00:00:00+01:00" as instant into x'),
  },
  {
    id: 'unconvertible-literal',
    positive: script('put "0000-01-01T00:00:00Z" as instant into x'),
    negative: script('put " 2024-02-29T00:00:00Z " as instant into x'),
  },
] as const;
