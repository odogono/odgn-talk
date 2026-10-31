# Bit operations are Built-ins on whole numbers below 2^64

Talk's bit operations are ten Built-ins, `bitAnd`, `bitOr`, `bitXor`, `bitNot`, `bitShiftLeft`, `bitShiftRight`, `bitRotateLeft`, `bitRotateRight`, `bitCount` and `bitTest`, acting on whole numbers from 0 to 2^64 − 1, not operators. Libraries written in the language ([ADR 0021](0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md)), such as encoders, checksums and hashes, need bit operations, and Scripts need flags and masks. Numbers are decimal, but every whole number below 2^64 is exact in 34 digits, so the Cores agree without a new value kind. Functions leave the grammar alone and keep `<<` and `>>` as Binary Pattern brackets ([ADR 0013](0013-binary-patterns-are-sequential-destructuring.md), [ADR 0019](0019-one-predictive-grammar-with-contextual-keywords.md)).

- **Unsigned only:** there are no negative bit patterns, so `bitNot` and the rotations take a `width` from 1 to 64.
- **No silent wrap:** a left shift past 2^64 raises `overflow`, as arithmetic does, unless the call gives a `width`, which keeps the low bits.
- **Flat cost:** each call has a fixed rate, since no argument exceeds 64 bits.

## Considered Options

- **Keyword operators** (`a bitAnd b`, `a shl 3`): read like `mod` and `div`, but need new contextual keywords, precedence levels and lowering in every Core, and a shift operator can't be `<<`.
- **Bytes operands:** byte-wise operations suit buffers but not flags or arithmetic state; left open in Appendix C.
- **Signed 64-bit numbers:** match C, but bring two's-complement rules and sign extension that Talk's decimal numbers otherwise never need.

## Consequences

- **The PCG32 definition** in chapter 7 is written with the Built-ins, so the Spec no longer uses notation a Script can't write.
- **Each Core** implements the ten Built-ins, with Corpus cases for their errors and examples.
