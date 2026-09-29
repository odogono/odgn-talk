# Values cross the Host boundary as tagged Values, converted by spec rules

Each Core gives the Host one opaque, tagged `Value` type. A Host builds values only through named constructors (`talk.Text`, `talk.Dec`, `talk.Map(pairs…)`) and reads them only through accessors (`AsText`, `AsDec`, `Entries`). There is no conversion from `any` or `unknown`, so every conversion is a constructor whose rule the spec states. A Host float becomes a decimal through its shortest round-trip text, the digits ECMAScript's `Number::toString` and Go's `strconv.FormatFloat(f, 'g', -1, 64)` both produce, so `0.1` stays `0.1`. Input the value model can't hold is refused at the Host API, as a Go `error` or a TS throw, and never reaches a Script. That covers NaN and ±Infinity, more than 34 significant digits, text that isn't valid UTF-8, a lone surrogate, and a duplicate map key. Nothing is clamped, rounded or replaced. Text is normalised to NFC when the Host builds the `Value`. For anything that has to cross a process or be stored, one spec-defined, lossless **Value Encoding** (JSON with `$` tags) carries every kind that can be encoded. It is separate from ADR 0021's plain JSON mapping, and from the display form the Corpus uses. We chose this because native types each bring their own ambiguity: Go map order, JS integer-like key order, `Date`'s milliseconds and invalid dates, `null` versus `undefined`, and `float64` hiding which conversion applies. Any one of these would make the two Cores disagree about a value before a Script ever saw it. Shortest round-trip gives the Host programmer the number they wrote: exact binary expansion would turn every JSON price into `0.1000000000000000055511151231257827`. The digits are fully defined by both host specs, and always fit in 17 digits, so no rounding is needed. Refusing at the API puts a Host bug at the Host's own call, where its stack trace is, rather than in a tenant's Script. A number or text conversion can't be changed later without changing values that Scripts already store, so it is fixed now.

## Considered Options

- **Native types across the boundary** (`string`, `float64`, `map[string]any`, `Date`, `time.Time`): lighter to call, but each native carries one of the ambiguities above, and `any` hides which rule applies.
- **Exact binary value for floats**, as ADR 0021 first said for `fromFloat64`: it has one right answer, but every float from a Host or a sensor prints as its binary expansion, which beginners read as a bug.
- **Clamping or rounding out-of-range input**, or raising it inside the Script: the Script can't fix a Host's bad input, and a silently rounded `bigint` is a wrong value that nobody sees.
- **Replacing invalid text with U+FFFD:** it hides Host bugs. A Host that wants replacement calls `strings.ToValidUTF8` or `String.prototype.toWellFormed()` first.
- **Lazy NFC inside the Core:** every comparison, key lookup and length would first have to ask whether the text is normalised.
- **Charging NFC to Fuel:** it happens when the Host builds a value, outside any Run, so there is no Run to charge. The Host bounds it with its own input limits.
- **Plain JSON only** for the Corpus, the message layer and storage: Quantities, dates, Bytes and Text Patterns can't survive it (ADR 0021 refuses them).
- **`$` tags inside plain JSON:** `decodeJson` in a Script would turn a user's `"$bytes"` key into Bytes.
- **The Value Encoding in the Corpus, in place of the display form:** ADR 0018 rejected this, because a decoder bug would look like a Core divergence. That reasoning still holds.
- **Display-form text inside JSON strings for the message layer:** every Host that isn't a Core, such as an Elixir Host, would need a display-form parser.

## Consequences

- **Numbers in:** narrows ADR 0002.
  - Go: `Int(int64)`, `Uint(uint64)` (both always fit), `FromFloat(float64)` and `Dec(string)`. TS: `num(number)`, `num(bigint)` and `dec(string)`. The prototype's safe-integer-only `int(number)` goes, since `num(1e21)` is already exact.
  - `Dec` accepts only the `as number` grammar.
  - NaN, ±Infinity, and a `bigint` or decimal string with more than 34 significant digits are refused.
  - `-0.0` enters as `0` (see the ADR 0002 note).
- **Numbers out:**
  - A number reads as an opaque `Decimal`. `String()` gives the canonical form, with trailing zeros kept.
  - `Int64()`/`Uint64()` in Go, and `toBigInt()` in TS, fail unless the value is an integer that fits.
  - `Float64Lossy()` / `toNumberLossy()` round to the nearest float, ties to even, as `toFloat64` does. A value too large for a float fails rather than becoming ±Infinity. Underflow rounds normally.
  - There is no coefficient/exponent API. A Host that wants a decimal library passes it `String()`.
- **Text:** narrows ADR 0011.
  - NFC is applied when the Host builds the `Value`, uncharged.
  - Text that isn't valid UTF-8 (Go), or a lone surrogate (TS), is refused.
  - Text going out is always NFC: UTF-8 in Go, UTF-16 in TS.
- **Maps:**
  - Keys are text only. Order is the order the Host gives, and `Entries()` returns insertion order.
  - A duplicate key, compared after NFC, is refused.
  - Go builds maps from pairs only. TS accepts `Map<string, Value>`, where integer-like keys are fine, and `record(obj)`, which refuses integer-like keys because JS reorders them.
- **The other kinds:**
  - **Nothing:** `talk.Nothing` in Go, a `nothing` constant in TS. `null` and `undefined` are never accepted for it.
  - **Quantity:** built from a `Decimal` and a unit text spelled as a Unit suffix in a Script (`"kg"`, `"GBP"`), normalised by ADR 0022. An unknown Unit is refused. It reads as `Number()` and `Unit()` (canonical).
  - **Civil Date:** built from fields (year, month, day, and optionally hour, minute, second and nanosecond), or from text in the `as civil date` grammar. An invalid date is refused. Neither Core uses a native type.
  - **Instant:** Go builds it from `(seconds int64, nanos)`, with `InstantFromTime(time.Time)` as a convenience that drops the monotonic reading and the zone. TS builds it from `instant(epochNanos: bigint)`. JS `Date` is never accepted.
  - **Bytes:** `[]byte` / `Uint8Array`, copied both ways.
  - **Text Pattern:** there is no constructor, and Hosts can't compile patterns. A Host passes one back unchanged, and `Source()` gives its canonical source for display.
  - **Function Value:** opaque, with no Host-side reads. The handle is left to the Function Value follow-up (ADR 0025).
  - **Host Object:** its own handle type, with a Host-supplied `ID()`.
- **Shapes:** narrows ADR 0015.
  - At load time, the loader checks arity, literal map keys against closed map Shapes, and the kind of every literal argument (`fetch(5)` where text is expected). There is no inference beyond literals.
  - At run time, the Core checks arguments before calling the Host function. A mismatch raises an ordinary `wrong kind` in the Script with `{operation, argument, expected}`, the Host function never runs, and nothing is charged.
  - A result that breaks its Shape is the Host's fault. The call ends as `host error`, and the detail goes in the Host's report. A Script never sees a value that breaks its declared Shape.
  - Message Shapes in the Host Manifest stay tooling-only (ADR 0028). The Core doesn't check Deliveries against them.
- **JSON:** narrows ADR 0021.
  - ADR 0021's plain JSON ↔ Value rule is the one rule for `json` and the Host-side codec.
  - The Host codec reads numbers from their text through `as number`, never through `float64` or `JSON.parse`, so each Core ships its own JSON reader.
- **The Value Encoding:**
  - Every value is written as JSON, deterministically: the same value always gives the same bytes.
  - An integer with |n| < 2⁵³ is a plain JSON number. Every other number is `{"$dec": "2.50"}`, so JS, Go and Elixir readers all stay exact.
  - Booleans are JSON booleans, text is a JSON string, Nothing is `null`, and lists are arrays.
  - Maps are JSON objects, in order. A map with any key starting with `$` is written `{"$map": [[k, v], …]}`, so a key can never read as a tag.
  - The tags are:
    - `{"$quantity": ["2.50", "GBP"]}`
    - `{"$bytes": "<base64>"}` (RFC 4648, padded)
    - `{"$instant": "2026-09-29T12:00:00.5Z"}` (RFC 3339, in UTC, with the shortest fraction up to 9 digits)
    - `{"$date": "2026-09-29"}` (the `as civil date` form)
    - `{"$pattern": "<source>"}` (re-parsed under the language version when decoded)
    - `{"$object": ["kind", "id"]}` (decoding asks a Host-supplied resolver)
  - A Function Value can't be encoded until its follow-up, so encoding one fails.
  - The language-neutral message layer (for an Elixir Host) and Host storage of values use it. Scripts can't reach it.
  - The Corpus keeps the display form (ADR 0018). A small **Value Encoding case** pairs a value in the display form with its expected encoding bytes, so encoder parity is checked without putting the Corpus through a decoder.
- **Host conventions** (in the embedding guide, not normative): HTTP header names are lowercase. A repeated header's values are joined with `, `, except `set-cookie`, which is a list of text.
- **Source:** the [Example Hosts sketch](https://github.com/odogono/odgn-talk/tree/prototype/example-hosts/prototypes/example-hosts) (`api/talk.go`, `api/talk.ts`, NOTES questions 25–27 and 35) and [#65](https://github.com/odogono/odgn-talk/issues/65).
- Settled by #72: the Function Value follow-up (ADR 0025) keeps it out of the Value Encoding. #73 may add a reference form if the message layer needs one. In TS, `num(number | bigint)` and `civilDate(fields | text)` are the constructors. See [`talk.go`](../../spec/embedding/talk.go) and [`talk.ts`](../../spec/embedding/talk.ts).
- Settled by #79: `{"$function": [home, display, token]}` is a message-layer-only tag (ADR 0025), and `EncodeValue` for Host storage still refuses a Function Value. `{"$object": [kind, id]}` is read against the message's Group, and the Host's glue code checks `wrong group`.
