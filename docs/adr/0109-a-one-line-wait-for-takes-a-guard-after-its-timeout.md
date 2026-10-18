# A one-line `wait for` takes a Guard after its timeout

A one-line `wait for` may end with a Guard, after any timeout: `wait for pressed key where key = "Y"`, or `wait for pressed key or 30 s where key = "Y"`. Before this ([#1247](https://github.com/odogono/odgn-talk/issues/1247)), only a `when` branch of the block form took a Guard, and the one-line form failed at `where` with a bare `unexpected token`. A Handler head takes a Guard, and so does a `when` branch, so the one-line form looked as if it should too. Waiting for one particular key or reply is the commonest wait in a game Host's Scripts.

`or` both starts the timeout and is boolean-or, and only one token of lookahead decides it. A Guard placed before the timeout couldn't tell the two apart without a precedence rule. Placed after the timeout, it needs none. The timeout's expression ends at `where`, a Reserved Word that isn't an operator, and the Guard runs to the end of the line as a full expression, so `wait for pressed key where key = "Y" or key = "N"` means what it says.

The Guard means what a `when` branch's Guard means. It is tested when a matching message is dispatched, with the event's bindings in scope, and its Fuel counts as observation does. An error in it means the wait doesn't match. A one-line `wait for m or d where g` behaves as the block with one `when m where g` branch and one `after d` branch, except that it ends with the message, or Nothing, in `it` and runs no branch body.

## Considered Options

- **Guard, then timeout, with `or` ending the Guard.** `wait for m where g or d` reads in the more natural order and follows the precedent that `from` takes a postfix-level operand so the `or` after it is the timeout. An `or` inside the Guard would need brackets, and the usual mistake, `where key = "Y" or key = "N"`, would read `key = "N"` as the timeout.
- **A Guard or a timeout on one line, not both.** It is the simplest grammar, but `wait for m where g or d` would load and read `or d` into the Guard, failing only when a message is tested.
- **Keep the Guard to the block form and improve the error.** A syntax error's message isn't normative, so this needs no Spec change, but it leaves the commonest wait taking four lines.

## Consequences

- `Inline` and `Wait` in `grammar.ebnf` take `Event Timeout? Guard?`. A one-line `wait for` with a Guard is still an `Inline`, so a one-line `if` can hold one.
- Every Core's parser and lowering, the reference parser and the reference lowering take the Guard. The lowering already tested a `when` branch's Guard in the event body, and now does so for the one-line form.
- An `or` written after the Guard is boolean-or. A timeout after a Guard is written before it instead.
