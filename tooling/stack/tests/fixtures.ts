// Tooling fixtures, outside the Conformance Corpus (ADR 0028).
import type { LintId, LintOptions } from '../src/lint';
export const fixtureManifest = {
  capabilities: new Map(),
  grants: new Map(),
  libraries: [],
  messages: ['demo'],
  objectKinds: new Map(),
  objects: [],
  objectsKinds: new Map(),
};
const script = (body: string) => `on demo\n${body}\nend demo`;
const join = (lines: number) =>
  script(`wait for all\n${'say 1\n'.repeat(lines)}end wait`);
export const fixtures: readonly {
  id: LintId;
  negative: string;
  options?: LintOptions;
  positive: string;
}[] = [
  {
    id: 'suggest-list-splice',
    positive: script('put [] into acc\nput [1, 2] after acc'),
    negative: script('put [] into acc\nput ...[1, 2] after acc'),
  },
  {
    id: 'suggest-collecting',
    positive: script(
      'put [] into acc\nrepeat for each n in [1, 2]\nput n * 2 after acc\nend repeat',
    ),
    negative: script(
      'put [] into acc\nsay 1\nrepeat for each n in [1, 2]\nput n * 2 after acc\nend repeat',
    ),
  },
  {
    id: 'suggest-whose',
    positive: `use filter from list\n${script('put filter([1, 5], given n: n > 2) into big')}`,
    negative: `use filter from list\n${script('put filter([1, 5], given n: n > it) into big')}`,
  },
  {
    id: 'store-race',
    positive: script(
      'ask scores to get "best", 0\nput it + 1 into best\nask scores to set "best", best',
    ),
    negative: script('ask scores to increment "best"'),
  },
  {
    id: 'unreachable-clause',
    positive: 'on demo x\nend demo\non demo 1\nend demo',
    negative: 'on demo x where x > 1\nend demo\non demo 1\nend demo',
  },
  {
    id: 'pin-trap',
    positive: 'script variable orderId = 1\non demo {order: orderId}\nend demo',
    negative:
      'script variable orderId = 1\non demo {order: ^orderId}\nend demo',
  },
  {
    id: 'is-empty-on-missing-key',
    positive: script('put {} into m\nif the "title" of m is empty then say 1'),
    negative: script('if the "title" of {title: ""} is empty then say 1'),
  },
  {
    id: 'try-write-before-fail',
    positive:
      'script variable count = 0\n' +
      script(
        'try\nput 1 into count\nthrow {code: "oops"}\ncatch e\nsay e\nend try',
      ),
    negative:
      'script variable count = 0\n' +
      script('try\nput 1 / 0 into count\ncatch e\nsay e\nend try'),
  },
  {
    id: 'serialised-self-join',
    positive:
      'on ping, queued\nend ping\n' +
      script('wait for all\nsend ping to me and wait\nend wait'),
    negative:
      'on ping\nend ping\n' +
      script('wait for all\nsend ping to me and wait\nend wait'),
  },
  {
    id: 'shadows-builtin',
    positive: 'constant min = 1\n' + script('say min'),
    negative: 'constant minimum = 1\n' + script('say minimum'),
  },
  {
    id: 'unknown-message',
    positive: 'on other\nend other',
    negative: 'on demo\nend demo',
    options: { manifest: fixtureManifest },
  },
  {
    id: 'advanced-construct',
    positive: script('try\noffer skip\nend try'),
    negative: script('try\ncatch e\nend try'),
  },
  {
    id: 'advanced-construct',
    positive: script('try\ncatch e before unwind\nend try'),
    negative: script('try\ncatch e\nend try'),
  },
  {
    id: 'advanced-construct',
    positive: script('choose offer skip'),
    negative: script('choose 1'),
  },
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
    id: 'advanced-construct',
    positive: script('send ("ping") to me'),
    negative: script('send ping to me'),
  },
  {
    id: 'advanced-construct',
    positive: script('send ping with ...[1] to me'),
    negative: script('send ping with 1 to me'),
  },
  {
    id: 'fallback-routes-known',
    positive:
      'on ping\nend ping\non any message m where the name of m is "ping"\nend any message',
    negative:
      'on ping\nend ping\non any message m where the name of m is "pong"\nend any message',
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
];
