# Binary frames

The optional `binary-frames-v1` Message Layer feature carries every frame after
`hello` in a binary form of the same data, so a Host can read a reply without
parsing JSON or decoding Value Encoding text a second time
([#1103](https://github.com/odogono/odgn-talk/issues/1103)). It doesn't change
protocol version 1, the messages, their fields or their order, the Trace
catalogue, Fuel, Clock readings, or how needs and results are exchanged. A Host
requests it in `hello.features` and checks the reply before using it
([ADR 0098](../../docs/adr/0098-the-message-layer-may-carry-binary-frames.md)).

## Switching

`hello` and its reply are always JSON. If the reply's `features` lists
`binary-frames-v1`, every later frame in either direction is binary: requests,
replies, interim needs, their `…-result` answers and the
[inline transport's](inline-inputs.md) events and acknowledgements. A Session
never switches back. A later `hello` is binary too, and can't withdraw the
feature. Framing is unchanged: over WASI the frame goes through `talk_buffer`
and `talk_send`, and a sidecar or inline frame keeps its 4-byte big-endian
length.

## Items

A binary frame is one item. An item is a tag byte and its payload. A count or
length is an unsigned LEB128 in its fewest bytes. Text is a length and that many
bytes of UTF-8 in NFC.

| Tag | Item | Payload |
| --- | --- | --- |
| `0x00` | Nothing | – |
| `0x01`, `0x02` | `false`, `true` | – |
| `0x03` | integer | an unsigned LEB128 of a value from 0 to 2⁶⁴ − 1 |
| `0x04` | decimal | the number's canonical text |
| `0x05` | text | text |
| `0x06` | list | a count, then that many items |
| `0x07` | map | a count, then that many pairs of a text key and an item, in order |
| `0x08` | bytes | a length, then the bytes |
| `0x09` | quantity | a number item, then the Unit in normal form as text |
| `0x0A` | range | the `from` item, then the `to` item |
| `0x0B` | instant | a zigzag LEB128 count of microseconds since 1970-01-01T00:00:00Z |
| `0x0C` | date | the as civil date form as text |
| `0x0D` | pattern | the canonical source as text |
| `0x0E` | object | the kind item, then the id item |
| `0x0F` | function | the `$function` payload's three items |
| `0x10` | negative integer | an unsigned LEB128 of the value's magnitude, from 1 to 2⁶⁴ |

The items map onto [the Value Encoding](../09-embedding.md#json-and-the-value-encoding)
one for one. A number whose canonical text has no fraction digits is an integer
or negative integer item when its magnitude fits, and every other number is a
decimal item. Zero is always an integer item. A map needs no `$map` form,
because a key can't read as a tag. Every other tag byte is refused.

**Same value, same bytes.** As with the Value Encoding, decoding accepts only
the form the encoder writes, and refuses anything else as `invalid value`: a
decimal item for a number that fits an integer item, a LEB128 longer than it
needs, text that isn't UTF-8 or isn't in NFC, a quantity's Unit not in normal
form, a date or pattern not in canonical form, a map with a repeated key, or
bytes left over after the frame's item. A decoder has no fixed nesting-depth
limit ([ADR 0088](../../docs/adr/0088-the-message-layer-accepts-deep-values.md)).

## Messages

A message or reply is a map item with the JSON form's field names, in any order,
and its other fields are encoded as the JSON form's data model is. A JSON number
is an integer or decimal item, a string a text item, an array a list item and an
object a map item. The [encodings](../09-embedding.md#messages) the JSON form
gives fields change as follows:

- `now`, `nextDeadline` and every other `$instant` field is an instant item.
- Saves, identities, fingerprints, manifests and every other byte string is a
  bytes item, with no Base64.
- Every integer is an integer or negative integer item, never decimal text. The
  `seed` of `new-group` always fits.

A malformed binary frame is a protocol error, as a malformed JSON frame is: it
leaves the Session and any open exchange available for a corrected frame. Its
error reply is binary.
