# A `northtalk` command given a file runs it as a Script Runner

`node server.js` runs a file. Until now none of the `northtalk` commands (TS, Go or native Zig) could run a Script file: they offered a REPL and tools. Now `northtalk app.talk [args…]` runs the file on every one of them. All three binaries are called `northtalk`, so whichever one is installed behaves the same. The Zig `talk-repl` is renamed.

A Script has no top-level statements, so something must send it its first message. The Script Runner:

- loads the file as one Script in one Group, with the stdlib Libraries;
- grants every Standard Capability it offers, trimmed to what the Script uses (GrantsAsUsed);
- Delivers `start args`, where `args` is a list of the remaining command-line arguments as texts;
- runs until nothing can happen again.

## Considered Options

- **A `run` subcommand, or a separate server binary:** an extra word for the commonest case, and a special binary for servers. A first argument that names a file (it ends in `.talk`, or it exists and isn't a subcommand) runs it. With no arguments the command still opens the REPL.
- **A `Request` to `main`, exiting when it returns:** a server's `main` would have to never return. With a `start` Delivery, a Script that only sets up timers or Serve Registrations simply ends its Run.
- **Running until Ctrl-C, or until an explicit `exit`:** Node's rule is more familiar, since a process with nothing left to do ends by itself.
- **Multi-file programs, resolving `use … from name` to a sibling `name.talk`:** deferred. v1 runs a single file with the stdlib.

## Consequences

- **Exit:** the Runner exits when it has no live Runs, no pending timers, no Serve Registrations and no open HTTP Exchanges. It exits with 0, or with 1 if any Run ended with an uncaught error. Uncaught errors are written to standard error.
- **Signals:** a first SIGINT or SIGTERM stops accepting connections and Delivers `stop` if the Script handles it. It then waits up to 5 seconds for open HTTP Exchanges, answers the rest with 503, and Stops the Group, exiting 130 or 143. A second signal exits at once.
- **Addresses:** `serve` may name any host and port. `--port` or the `PORT` environment variable overrides the port.
- **Capabilities:** `console`, `clock`, `timer`, `calendar`, `locale`, an in-memory `store`, `sqlite` where the runtime has it, `http`, and `user` when standard input is a terminal. The native Zig Runner has no time-zone or Locale data, so it offers no `calendar` or `locale` yet.
