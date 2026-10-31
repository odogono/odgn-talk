# The TS package has a lean entry without the stdlib Libraries

`@northtalk/ts` keeps registering all seven stdlib Libraries, so every Host already using it behaves the same. A second entry, **`@northtalk/ts/lean`**, exports the same API but registers none of them. A Host on it calls `registerStdlib` with the Libraries its Scripts `use`, imported from `@northtalk/ts/stdlib/<name>`, and a bundler drops the others. Each of those modules imports the stdlib Libraries its source `use`s, so registering `json` brings `text`. This amends [ADR 0021](0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md) for the TS Core only. A Core on the main entry still carries every stdlib Library. On the lean entry it carries only the ones its Host registered. We chose this because the stdlib sources were about 9% of a browser bundle (gzipped: 206,643 bytes on the main entry, 188,172 on the lean one), and a Host whose Scripts use none of the Libraries paid for all of them ([#1856](https://github.com/odogono/odgn-talk/issues/1856)).

- **Registration is per process,** like the compiled stdlib it feeds, rather than per Group. A process that imports the main entry anywhere has all seven registered.
- **A Script that `use`s a Library that isn't registered** fails to load with `unknown import`, which is the diagnostic for a Library that doesn't exist. Loading checks only what is registered, so Scripts read the same on every Core that has the Library.
- **Names stay reserved.** A Host still can't register its own Library under a stdlib name, whether or not that stdlib Library is registered.
- **Built-ins stay on every Core.** Scripts dispatch them by name, so they aren't optional.
- **The Spec is unchanged.** The language, the stdlib sources and their Fuel are the same. Only what the TS package bundles changes.

## Considered Options

- **Opt-in on the main entry:** `createGroup` would register nothing unless told to. That breaks every existing Host and the Corpus harness, and Scripts would stop being portable between Hosts on the same Core.
- **A registry per Group:** this ties registration to a Group rather than a process, but every compile, check, describe and restore path would need the Group's set, while the compiled stdlib is already cached per process.

## Consequences

- **The published manifest** marks `index.js` as having side effects, since importing it registers the Libraries. Every other module stays side-effect free.
- **`tests/lean-entry.test.ts`** bundles a lean Host and fails if it holds any stdlib source, or if its gzipped size grows past a budget.
- **Tools that import Core modules directly,** instead of an entry, must call `registerStdlib(...allStdlib)` before compiling a Script that `use`s a Library.
