# A `send` may compute its message name

A `send` may give its message name as a bracketed expression: `send (next) with order to me`. The expression must give text: a Name, or a Selector such as `"move:to:"` with one argument for each part. Every other place a message is named stays static: a Handler head, `pass`, a Command Call and `wait for`. We chose this because Scripts could already dispatch on a computed name, but only through `timer`'s `schedule`, which takes the message name as text and goes through a durable Host timer. Data-driven routing and state machines that keep the next message in a map need it directly. HyperTalk's `send` took an expression for the same reason. Only `send` gets a computed name because a `send` never runs in the sender's Run, and `send … and wait` always suspends, so ADR 0004's Suspension Points are still known at load. A Command Call runs in the caller's Run, and the loader must know whether its Handler can suspend, so a computed Command Call would break that. Settled in #178.

- **The name is checked at the `send`.** Text that isn't a Name or a Selector raises `bad message name`, with `name` and `arguments`, the argument count. So does `all`, a Reserved Word, or a Selector whose part count doesn't match the arguments. Anything but text raises `wrong kind`, with `expected` `"text"`. A static `send` could never name these, so the check keeps both forms naming the same messages.
- **A well-formed name that no Handler takes** climbs the Message Path and ends `unhandled`, as a static name with no Handler does. A computed name gets no load check, because there isn't one for a static `send` either.
- **Labels go in the text.** `send (e)` exists only in the target-last form, `send (e) with a, b to t`. The Selector already names its labels, and the target-first form's phrase spells them as words, which a computed name can't do.
- **It round-trips.** A computed name is spelled as a Host delivers it and as `wait for`'s `it` reports it, so `send (the name of it) with x to t` forwards a message with one argument.

## Considered Options

- **Computed Command Calls:** the loader couldn't tell whether the call may suspend, so it couldn't check `and wait` or know the Run's Suspension Points (ADR 0004).
- **A computed `pass`, Handler head or `wait for` event:** each is checked or matched at load, and none was asked for.
- **A Built-in function such as `sendNamed(name, args, to)`:** Built-ins don't send. It would also need a waiting form and a Join form, which `send` already has.
- **Using `timer` with an Instant that has already passed:** it already works, but the message goes through the Host, can't be awaited, and is ordered by the Host, not the Script's mailbox.
- **An unbracketed expression, `send name with …`:** this can't be told apart from a static message name.
- **A keyword before the expression, such as `send message n with …`:** `message` would have to be reserved, or decided on a second token. Brackets need neither, because `(` can't start a Name.
- **The name as a list of parts, such as `["move", "to"]`:** the Selector text is already what the Host, the Trace and `wait for`'s `it` use. A second spelling would need converting both ways.
- **Checking only what the Host boundary checks, a `:` in the name (chapter 9):** a name with a space or a Reserved Word could never reach a Handler. A Script's mistake should fail at its `send`, not climb unnoticed to `unhandled`.
- **Letting a computed `"all"` go `unhandled`:** `all` can't name a message anywhere else, so it raises as other names that can't be written statically do.

## Consequences

- **Syntax:** `Send` takes `'(' Expression ')'` where it takes a `MessageName` today, only in the target-last form. `send` is reserved and `(` can't start a Name, so one token decides it. No new two-token decision is needed, and every source that parsed before parses the same way.
- **Advanced Construct:** `grammar.toml` tags it `advanced`. Its Beginner Surface form is a `match` or `if` that picks between static `send`s, and the `advanced-construct` Lint flags it in the `beginner` profile (ADR 0027).
- **Lowering:** three new instructions, `send-named`, `send-named-wait` and `join-send-named`. They take only a `count`, pop the name text below the arguments, and are charged and fail as `send`, `send-wait` and `join-send` do, plus `bad message name`. The source order stays name, arguments, receiver. In the Disassembly, a computed `send` has no `message` operand.
- **Errors:** `bad message name` joins the error catalogue (ADR 0033).
- **Tooling:** the LSP can't complete or follow a computed name. `serialised-self-join` stays silent for one, since it can't tell which message it sends. `unknown-message` is unaffected, since it checks Handlers and not sends.
- **Unchanged:** the Trace, which already records the message a `send` delivers; Save and Restore; the Host boundary; and Command Calls, `pass`, `on` and `wait for`.
- **Not covered:** the argument count is still written in the source. Forwarding a message whose argument count isn't known needs a spread in `with`, which is a separate question.
- **Delivery:** the spec's rules land with this ADR (ADR 0032): the grammar in chapter 2 and `grammar.ebnf`, chapters 4 and 5, and `bad message name` in `errors.toml`. Both Cores' coverage tests require every instruction in `machine.toml` to be emitted and every Advanced tag to have a Lint fixture. So the three instructions, chapter 8's lowering row and the `grammar.toml` tag land with the Cores' implementation, together with the corpus cases, the Lints and the LSP.
- **The language stays `1.0-rc.2`,** as ADR 0055 recorded, because the change only adds syntax.
