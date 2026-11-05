# Library exports carry Documentation Examples that `northtalk test` replays

A Library export's Declaration Documentation may hold **Documentation Examples**. Each is a Session Transcript written inside the `--|` block: a line starting `> ` begins one, `| ` lines continue an Entry, the lines after it are its expected output, and a blank documentation line ends it. `northtalk test` replays every Documentation Example of every Library in the Host Manifest it is given, alongside Test Scripts and `*.transcript` files. Each example runs in a fresh session under a virtual Clock, as one test, and passes only if it reproduces its written output exactly, as `northtalk replay` requires. It is Tooling (ADR 0028), so nothing about extracting the examples is normative, though the replay itself is the normative Session Host's. We chose this because documentation examples drift unless something runs them, and NorthTalk already has both halves of Elixir's doctests: Declaration Documentation keeps its text verbatim, and a Session Transcript is a readable prompt-and-output format that replays the same on every Core. Joining them adds no syntax to the language and no message to the Cores. Implementation is tracked in #2111.

For example, a Library `strings` might document:

```
--| `t` with `fill` added at the start until it is `width` Characters long
--|
--| > use padLeft from strings
--| > padLeft("7", 3, "0")
--| "007"
function padLeft t, width, fill = " "
```

## Considered Options

- **A Script's Handlers too, reached by message** from a Group the runner builds beside the session: black-box as ADR 0056 requires, but it needs a new Group shape. Left as the next step.
- **Every documented declaration, including a Script's functions and Constants:** they'd need the Script's source loaded into the Session Script, which is the white-box testing ADR 0056 rejected.
- **An explicit fence** around tested examples: prose examples outside it could drift, which is the problem this solves. Every `>` example is tested, as Elixir tests every `iex>` line.
- **Normative extraction, with Corpus cases:** every Core's tooling would have to agree on a convention only one runner uses. The replay is already normative.
- **Examples sharing a session,** per declaration or per file: an example would break when another is edited, and couldn't be read alone in hover.
- **Wildcards in expected output,** as Python's doctest ELLIPSIS: syntax the Session Transcript format doesn't have, for output a Library export makes deterministically.
- **The runner importing the export or granting the manifest's Grants as mocks:** hidden setup would make the transcript differ from what runs. An example writes its own `use` and `:mock`, so hover shows a reader how to import and call the export.
- **The session's default real Clock:** a transcript under a real Clock records an `@` reading after every Entry, so each example would need one per line, or a `:clock virtual` line at its top.
- **Stdlib examples in `stdlib.toml`,** so editing them leaves code identity alone: the stdlib's documentation would live in two places.
- **Taking comments out of code identity:** a separate, larger spec change, which editing any `--|` block would already justify on its own.

## Consequences

- **Scope:** user Libraries named in the Host Manifest. The stdlib's `spec/stdlib/*.talk` waits for a language-version change of its own, since its code identity is fixed by the language version and any text added there changes it.
- **Identity:** a Library's code identity covers its source exactly, comments included, so editing a Documentation Example changes the Library's identity and the Group Fingerprint, as editing any `--|` block does. Operation `examples` (ADR 0076) are unaffected, since they stay out of the Fingerprint.
- **Session Commands:** an example may use any a Session Transcript allows except those that name files or outlive the example: `:library`, `:fix`, `:export`, `:store load`, `:store save`, `:save`, `:restore` and `:quit`. Using one fails the example.
- **Session defaults:** an example's session has what any session has, `console`, plus whatever its own `:grant` and `:mock` lines add. The one exception is the Clock: the runner starts it virtual at a fixed instant, as ADR 0056's runner does, which adds no line to the transcript. An example may write `:clock virtual <instant>` to choose another.
- **Blank output:** since `--|` and `--| ` both read as a blank line, an example can't show output containing an empty line. Such an export is tested in a Test Script or a `*.transcript` instead.
- **Reporting:** each example is one test, named `<library>.<export> example <n>`, with n counting from 1 in source order. A manifest Library's source is inline, so a failure names the manifest path, the example, and the line within the Library's source, followed by the diff `northtalk replay` prints.
- **Editors:** the LSP changes nothing yet. Hover shows the block verbatim, and only `northtalk test` checks examples.
- Narrows ADR 0056: `northtalk test` replays a third kind of test.
