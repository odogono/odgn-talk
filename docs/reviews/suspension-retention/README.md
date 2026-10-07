# Suspension retention audit (#281)

Execution evidence recorded on 2026-10-06 against base `239ec12874194db24722b237e646d1241ae0eb12`
plus the #281 correction to `impl/ts/src/machine.ts`. This record covers
[#281](https://github.com/odogono/odgn-talk/issues/281); it does not approve the
first blessings. Current support is in the [TS verification guide](../../../impl/ts/README.md#verification-and-corpus-selection).

## Boundaries and evidence

Chapter 6 requires Persistent State to be checked after the suspension's
instruction and Host effect. Chapter 8 assigns 48 bytes to each pending call
and retains evaluated event `from` objects and captured Values. Shared Values
count each time they are retained. The correction passes the prospective
suspension to the existing size calculation without installing it as a
successful Segment boundary. Suspending Operation operands are consumed before
measurement; their arguments do not remain on the operand stack.

The unit reproductions failed before the correction for `ask`, foreign calls,
and one-line and block captures and object filters. Exact-limit and named
Script-filter controls passed. Argument-bearing `ask` also has an exact-limit
regression to protect operand consumption. Joins already counted their members
before closing and needed verification rather than a new size rule.

All eight cases below agree on actual Go and TS execution and both Cores'
save/restore replays. Candidate outputs were generated outside the Corpus and
compared with actual Go execution before writing the expectations. The Go
passing gate and each Core's acceptance tests now require these cases.

- `limits/ask-wait-retention`: 239 faults, 240 suspends (16-byte Script Variable,
  176-byte Run/frame and 48-byte pending call). The argument is consumed. A
  fault rolls back `stage`, preserves the started Operation, and writes its
  abandonment after the fault. Completion, Host failure, timeout, cancellation
  and late answers are exercised.
- `limits/foreign-call-retention`: 279 faults, 280 suspends (the same base plus
  a retained 32-byte Function Value and its 8-byte local slot). Receiver Runs
  finish after the caller faults or cancels, and their already-started work
  commits. Caller rollback and subsequent save/restore retain the right state.
- `limits/event-capture-wait-retention`: 215 faults, 216 suspends. The local
  number and its slot cost 24 bytes; the branch's second copy costs 16.
- `limits/event-capture-block-retention`: 231 faults, 232 suspends, including
  the block's additional 16-byte temporary local.
- `limits/event-object-wait-retention`: 191 faults, 192 suspends, including the
  evaluated 16-byte object filter.
- `limits/event-object-block-retention`: 207 faults, 208 suspends, including
  the object filter and the block temporary. Both event forms exercise timeout,
  cancellation, a later unobserved message, and successful matching after
  save/restore; object cases also reject a different Target. Unit controls
  verify that a named Script filter adds no Value size, that each of two
  branches counts repeated Values, and that captures and object filters add
  their sizes together.
- `limits/join-pending-retention`: 271 faults, 272 suspends (176-byte Run/frame
  plus two 48-byte pending calls). Fault abandonment follows member start order;
  cancellation abandons only the still-pending member after an early answer.
- `limits/join-early-answer-retention`: 319 faults, 320 suspends. An 80-byte
  text answer costs 96 bytes and replaces its original pending call while the
  Join body is preempted. The other member costs 48 bytes. Only that pending
  member is abandoned on the fault; exact-limit completion preserves the answer.

## Approval

Approved by the maintainer on 2026-10-07; see the
[approval record](../milestone-one-blessings/README.md). The original request follows.


The `case.trace` in each of the eight directories above awaits first human
review under [chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
Every header retains `# Unblessed: first human review required for #281.`
Execution agreement is separate from that approval. No previously reviewed
expectation was changed.

## Validation

- `bun test impl/ts/tests impl/ts/examples`: 2,858 pass, no failures.
- `bun test impl/ts/tests/suspension-retention.test.ts`: 30 pass, including
  ordinary and save/restore replay of every new case.
- `go -C impl/go test ./internal/corpus -run TestSuspensionRetentionAcceptance`: pass.
- `bun run corpus:run`: all selected existing expectations pass.
- `go -C impl/go run ./cmd/corpus --check-passing`: the passing gate, including
  all eight new cases, passes with ordinary and save/restore execution.
- `bun run check`, TS type checking, focused ESLint, Prettier and
  `git diff --check`: pass.

## PR #365 CI follow-up

The initial PR checks exposed two gaps in the local validation: the Go step-4
acceptance test still expected 32 cases after this audit added eight, and the
foreign-call fixture used one-space indentation for a Lambda whose source
position appears in its name. The formatter changed that name from `3:6` to
`3:7`, failing the Disassembly invariant.

Update the expected case count to 40 and format `foreign-call-retention/home.talk`
with the repository formatter. Its regenerated Trace changes only the source
identity and Function Value names. Before writing it, actual Go and TS ordinary
and save/restore executions agreed again. The first-human-review marker remains.

Follow-up validation passes: all 1,425 tooling tests, the full Go race suite
(`go -C impl/go test -race ./...`), Go vet and the corpus passing gate,
workspace type checking, lint/format/spec checks, and Node build/runtime checks.
The 30 focused retention tests also pass after regenerating the fixture Trace.
