# `random` draws from a seeded generator the Script Group holds

`random(n)` is a Built-in that gives a whole number from 1 to `n`. It draws from one PCG32 generator per Script Group, which the Host seeds when it makes the Group and which a save carries. The Spec fixes the generator, its seeding and how a draw maps onto 1 to `n`, so the same seed gives the same draws on every Core and a Trace replays exactly ([ADR 0009](0009-twin-cores-held-to-bit-for-bit-parity.md)). We chose this because games such as the Tetris Example Project need chance, and a source of chance that left a Trace unrepeatable, or let two Cores disagree, would break both replay and parity.

It is a Built-in, not a Capability, although it changes state. Unlike `now`, which the `clock` Capability answers ([ADR 0023](0023-named-time-zones-come-from-a-standard-capability.md)), it reads nothing outside the Core: the only input is the seed, which the Host gives once, as it gives the Group's name. A Capability would make every game ask for a Grant and cross the Host boundary per draw, and the Trace would have to record each answer. As a Built-in a draw is one instruction, and the Trace needs only the setup's seed. This stretches [ADR 0021](0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md)'s test for what is built in: `random` can be written in the language only with a Script Variable, which a Library can't have and which would give each Script its own sequence.

## Considered Options

- **A `random` Standard Capability:** the Host answers each draw, which the Trace records. Replay works, but each draw costs a crossing and a Grant, and Cores and Hosts would still need to agree on a generator to give the same game the same draws.
- **A generator per Script:** isolates Scripts, but a Script added or reloaded would change nothing else's draws only by accident, and Libraries would need their own. One per Group matches the Group's other counters.
- **Leaving the algorithm to each Core:** simpler to write, but breaks bit-for-bit parity and the Corpus.
- **A larger generator (xoshiro256, PCG64):** better statistics than games need, at the cost of 128-bit or wider state in TS's and Elixir's arithmetic. PCG32 fits in one 64-bit word.

## Consequences

- **The algorithm:** PCG32 (XSH RR) with the default increment, the reference seeding `step(step(0) + seed)`, and rejection of outputs below `(2^32 − n) mod n`, so `n` runs from 1 to 2^32 and no result is favoured. [Chapter 7](../../spec/07-libraries-and-the-standard-library.md#random-numbers) gives it in full with examples.
- **The seed:** `NewGroup` takes an optional seed, 0 to 2^64 − 1, and 0 without one. The Message Layer's `new-group` carries it, and a Trace Case's `case.toml` gives it as `seed`. A Host that wants different games each time seeds from its clock: Folio's Browse and Present do, and its `PlaySession` takes a fixed seed for tests.
- **Saves:** the generator state is part of the Group's state in both restore policies, so a restored Group draws on where the saved one left off. Both save formats change version.
- **Not rolled back:** a draw is final once charged, like an id. Rollback, Rewind and discarded Runs don't rewind the generator, and a call that faults on its own charge doesn't draw.
- **Effects:** because a call changes the Group, `random` is not constant, so it can't initialise a Constant or Script Variable or be a default, and a restricted callback can't call it. A Guard may, so a dispatch that tests a Guard calling `random` draws even when the clause doesn't run.
