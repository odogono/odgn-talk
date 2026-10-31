# units

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

The `units` Library is part of the Standard Library, so every Group holds it. A Script imports the names it uses, as in `use celsiusToFahrenheit from units`. Its normative source is [`spec/stdlib/units.talk`](../../../spec/stdlib/units.talk), and the full rules are in [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#units).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

### celsiusToFahrenheit

`celsiusToFahrenheit(c)`

`c * 9 / 5 + 32`.

### fahrenheitToCelsius

`fahrenheitToCelsius(f)`

`(f - 32) * 5 / 9`.

### celsiusToKelvin

`celsiusToKelvin(c)`

`c + 273.15`.

### kelvinToCelsius

`kelvinToCelsius(k)`

`k - 273.15`.

### fahrenheitToKelvin

`fahrenheitToKelvin(f)`

`(f - 32) * 5 / 9 + 273.15`.

### kelvinToFahrenheit

`kelvinToFahrenheit(k)`

`(k - 273.15) * 9 / 5 + 32`.
