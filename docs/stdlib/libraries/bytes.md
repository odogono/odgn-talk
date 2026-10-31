# bytes

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

The `bytes` Library is part of the Standard Library, so every Group holds it. A Script imports the names it uses, as in `use toHex from bytes`. Its normative source is [`spec/stdlib/bytes.talk`](../../../spec/stdlib/bytes.talk), and the full rules are in [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#bytes).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

### toHex

`toHex(b)`

The Bytes `b` as lowercase hexadecimal text, two digits per byte.

### fromHex

`fromHex(t)`

The Bytes the hexadecimal text `t` writes.

Also raises: [`can't convert`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### toBase64

`toBase64(b)`

The Bytes `b` in the base64 alphabet of RFC 4648, padded.

### fromBase64

`fromBase64(t)`

The Bytes the padded base64 text `t` writes.

Also raises: [`can't convert`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### toBase64Url

`toBase64Url(b)`

The Bytes `b` in the base64url alphabet of RFC 4648, unpadded.

### fromBase64Url

`fromBase64Url(t)`

The Bytes the unpadded base64url text `t` writes.

Also raises: [`can't convert`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### decodeText

`decodeText(b, encoding = "utf-8", mode = "strict")`

The text the Bytes `b` hold in `encoding`, normalised to NFC.

Also raises: [`can't convert`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### encodeText

`encodeText(t, encoding = "utf-8")`

The Bytes of the text `t` in `encoding`.

Also raises: [`can't convert`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

## Text encodings

The encodings `decodeText` and `encodeText` name. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#text-encodings).

- `"utf-8"`: UTF-8, as the Unicode Standard defines it; a leading U+FEFF is dropped when decoding.
- `"utf-16le"`: UTF-16, each code unit little-endian, with surrogate pairs; a leading U+FEFF is dropped when decoding.
- `"utf-16be"`: UTF-16, each code unit big-endian, with surrogate pairs; a leading U+FEFF is dropped when decoding.
- `"latin-1"`: ISO/IEC 8859-1: each byte is the code point of the same value, from U+0000 to U+00FF.
- `"windows-1252"`: The windows-1252 index of the WHATWG Encoding Standard: bytes 0x80 to 0x9F map as that index says, and every other byte as in latin-1.
