# Text literals have no escapes, and line breaks and quotes are Built-in Constants

A text literal is exactly the Characters between its quotes. It has no escapes, so a `\` is just a backslash, and it never spans a line. A line break, a tab or a double quote goes into text through one of three Built-in Constants, `newline` (LF), `tab` and `quote`, joined with `&`: `put "a" & newline & "b" into s`. `return` is a Reserved Word that starts a statement and never an operand, so HyperTalk's `put a & return & b` is a syntax error. A Script may give one of its own names (a variable, parameter, Capture or Constant) the name of a Built-in Constant. The Script's name wins inside that Script, and a Lint flags it. We chose this because the audience is beginners reading English-shaped source. `"C:\new"` and `<"\d">` mean what they show, and nothing in a literal needs decoding before it can be read. HyperTalk's `return` constant parses by position, but `return return` reads as a trap. Constants named after what they are read as words. Escapes can't be added later without changing the meaning of literals that already contain a backslash, so the choice is made now. Built-in Constants need no grammar: they are names like `pi` (ADR 0021), so the reserved core and `grammar.toml` don't grow.

## Considered Options

- **Keep `return` as the line-break constant** (HyperTalk, SenseTalk): familiar to that family, but it overloads a Reserved Word by position, and `return return` or `put return into x` reads as a trap.
- **Backslash escapes** (`"a\nb"`, `"\""`), as in C, JS and Go: familiar to programmers, but it adds a second syntax inside text, it is hostile to Windows paths and to backslashes in data, and beginners' literals would silently change meaning.
- **Both constants and escapes:** two spellings for one Character, and still the backslash trap.
- **Doubled quotes** (`"say ""hi"""`, as in SQL and Pascal): it needs no constant for `"`, but it reads badly, and line breaks and tabs would still need constants.
- **Multi-line text literals:** an unterminated quote would swallow the rest of the Script, and the first-error position would move far from the mistake.
- **More constants** (`space`, `crlf`, `empty`): `" "` is already readable, CRLF is Bytes work (`<<0x0D, 0x0A>>`, ADR 0013), and the language has no `empty` value, only the `is empty` test.
- **A load error for a Script name that matches a Built-in Constant**, as for import clashes (ADR 0020): every Script with a `quote` variable would break, and so would every Script whose name matches a Built-in Constant added in a later language version.

## Consequences

- **Text literals:**
  - A literal holds exactly its Characters, backslashes included, and is normalised to NFC like all text (ADR 0011).
  - A literal can't contain a raw line break. Unterminated text is a lexer error at the opening quote, and the scan ends at the line break.
- **Built-in Constants:** narrows ADR 0021.
  - `newline` is LF, `tab` is U+0009 and `quote` is `"`. They join `pi` as the Built-in Constants, and a Guard may use them.
  - `line` still breaks at LF, CRLF or CR (ADR 0011). `newline` is only what a Script writes.
  - There are no `space`, `crlf` or `empty` constants. `empty` stays contextual after `is`.
- **Names:**
  - A Script's own variable, parameter, Capture or Constant may shadow a Built-in Constant within that Script. The `shadows-builtin` Lint flags it (warning / hint).
  - Built-in functions keep ADR 0020's and ADR 0025's clash rules.
- **`return`:** narrows ADR 0019. `return` in operand position is a syntax error. It is only the statement.
- **Reversibility:** adding escapes later would change the meaning of every existing literal that contains a backslash, so it would need a new language version.

- Narrowed by ADR 0053: backticks interpolate expressions and raw fences hold multiline text. Reusable text/date templates now use `${…}` and `$$`, replacing the earlier bare-brace syntax. Ordinary quoted text is unchanged.
