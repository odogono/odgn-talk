# text

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

The `text` Library is part of the Standard Library, so every Group holds it. A Script imports the names it uses, as in `use pad from text`. Its normative source is [`spec/stdlib/text.talk`](../../../spec/stdlib/text.talk), and the full rules are in [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#text).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

### pad

`pad(t, width, fill = " ")`

`t` with `fill` added at the end until it is `width` Characters long.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### padLeft

`padLeft(t, width, fill = " ")`

`t` with `fill` added at the start until it is `width` Characters long.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### trim

`trim(t)`

`t` without the white space at its start and end.

### trimStart

`trimStart(t)`

`t` without the white space at its start.

### trimEnd

`trimEnd(t)`

`t` without the white space at its end.

### split

`split(t, separator)`

The list of the texts between the matches of `separator`, a text or a Text Pattern, in `t`.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### join

`join(xs, separator = "")`

The items of `xs`, each shown as `&` shows it, with `separator` between each pair.

### repeated

`repeated(t, n)`

`n` copies of `t`, joined.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### lastOffset

`lastOffset(needle, t)`

The Character position where the last match of `needle`, a text or a Text Pattern, starts in `t`, or 0 if there is none.

### format

`format(template, values)`

`template` with each `${name}` replaced by the value of that key of `values`, shown as `&` shows it.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### formatNumber

`formatNumber(n, symbols, places = nothing)`

The number `n` written with a Locale's `numberSymbols`, rounded to `places` digits after the point if `places` is given.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### parseNumber

`parseNumber(t, symbols)`

The number `t` writes with a Locale's `numberSymbols`.

Also raises: [`can't convert`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
