# NorthTalk

A HyperTalk-descended scripting language for running untrusted end-user Scripts in a sandbox. New here? Take the [language tour](docs/tour.md). The rules are in [the spec](spec/).

NorthTalk originates with ODGN (Open Door Go North). Scripts use `.talk` files; the repository remains `odogono/odgn-talk`. The [naming decision](docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md) records the package and tooling names and preliminary clash checks.

The TS Core implements pinned Unicode, immutable text/value foundations and a lossless lexer/parser for [#126](https://github.com/odogono/odgn-talk/issues/126). See [the implementation guide](docs/implementation.md) for the supported API, checks, corpus selection and remaining work. Scripts do not execute yet.

Notable implementation changes are recorded in the [changelog](CHANGELOG.md).
