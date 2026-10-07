# A `tell` block calls several Operations of one Grant

`tell g` at the end of a line opens a block of Operation calls on the Grant `g`, closed by `end` or `end tell`. Each line is an Operation name and its arguments, as after `tell g to`, with `and wait` where the Operation suspends. So a drawing that today repeats `ask canvas to` on every line is written `tell canvas`, then `fill "#235f75"` and `rectangle 70, 70, 180, 180` on lines of their own, then `end tell`. Each line is exactly the one-line call it stands for. Its mode comes from the Operation's declaration: a fire-and-forget Operation is called as `tell` calls it, and any other as `ask` calls it, so an answer lands in `it`. We chose this because Host-heavy Scripts repeat one receiver on line after line: the playground's canvas example, `ask output to open`, `write` and `close`, and `ask http … and wait` calls, and the repeated receiver is noise for a beginner reading them. The block keeps what ADR 0012 asks of a Capability call. The Grant is named in the source, every Operation name is a literal word the loader checks against the Grant, and every Suspension Point still says `and wait` (ADR 0019). AppleScript's `tell application … end tell` gives `tell` the same reading for any call. This narrows ADR 0012, where `tell` was only fire-and-forget. Settled in #337.

- **Only Operation lines.** A block line's first word is always an Operation name, even a Reserved Word, so `put` and `delete` Operations work as they do after `to`. Nothing else goes in the block, so the parser never needs the grant list, and a Handler and an Operation of one name can't be confused. A loop that draws puts the block inside its `repeat`.
- **A Grant only.** The receiver is a Grant's name, as in the one-line forms. `send` and `set` keep their one-line forms.
- **No verb on the line.** The loader already checks each call's mode against the Operation Declaration (`wrong mode`). The verb in a one-line call repeats what the declaration says, and the block leaves it out.

## Considered Options

- **A `tell` block of fire-and-forget calls only,** as #337 first sketched it. No Script in the repo has three `tell log` lines in a row, but runs of `ask` calls to one Grant are common, so it would have saved little.
- **Any statement in the block, with a bare word that names one of the Grant's Operations calling it.** Whether `fill "#235f75"` were a Command Call or an Operation would depend on the grant list, which ADR 0012 keeps out of the parser. An Operation named `put` or `delete` would start a `put` or `delete` statement, and an Operation would shadow a Handler of the same name.
- **Any statement, with each Operation line marked,** as in `to fill "#235f75"`. One token decides, and loops could go inside the block, but every Operation line pays for the marker, which is most of what the block removes.
- **Keeping the verb on each line,** as in `ask to fill …`. It repeats what the declaration says, as the receiver did.
- **`with canvas` or `using canvas` as the head.** Each needs a new word, and `with` already follows a `send`'s message.
- **A block for `send` targets and Host Object properties too.** A `send` target is a value computed when it runs, its messages take Argument Labels and go through mailboxes, and `set` writes a property rather than calling anything. A block for all three would need three sets of rules.
- **A Smalltalk cascade on one line,** as in `tell log to write "a"; write "b"`. The language has no statement separator, and a long cascade wraps badly.
- **Leaving it to the Host,** with an Operation that takes a list of drawing commands, as in `ask canvas to draw [ … ]`. That suits canvas, but each Host would invent its own, and the loader couldn't check the commands against the grant.
- **Not adding it.** The one-line forms are already clear. The repetition is real in the Scripts beginners are first shown, though, and the block costs no new instruction or diagnostic.

## Consequences

- **Syntax:** after `tell`'s receiver, the end of the line opens a block and `to` gives the one-line form, so one token decides, and the predictive grammar keeps its two-token limit (ADR 0019).
  - A block line is `Word ExpressionList? AndWait?`, and a line starting `end` always closes the block. `end` joins `ask`, `tell`, `send` and `wait` among the names a Capability refuses for an Operation, so every Operation can be called from a block.
  - `end tell` joins the explicit endings (ADR 0042). The block is a full statement, so a one-line `if` or `when` can't hold it.
  - Blank lines and comments may go between lines, and an empty block is allowed, as an empty `repeat` is.
- **Meaning:** a block is exact shorthand for its lines' one-line calls, in order. It adds no instruction or cost, and no rule for `it`. A suspending line in a Join's body is a Join Member, as `ask … and wait` is.
- **Errors:** no new code. A line's `and wait` that doesn't match its Operation is `wrong mode`, and an Operation its Grant doesn't declare is `unknown operation`, both at the Operation name. At run time, a line's instructions, its errors' `at` and its breakpoints are at its Operation name too.
- **Surface:** Beginner Surface, with no `[[advanced]]` tag. The formatter keeps whichever form the author wrote, and `prefer-explicit-end` covers a bare `end` that closes a block.
