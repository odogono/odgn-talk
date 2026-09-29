# 3. Values

_Draws on:_ [ADR 0001](../docs/adr/0001-value-semantics.md), [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md).

> **Note.** Not yet written. The chapter 3 task writes this chapter.

## Unit Kinds

<!-- generated: units.kinds -->

| Unit Kind | Base Unit | Dimension |
| --- | --- | --- |
| mass | `kg` | mass |
| length | `m` | length |
| volume | `L` | length^3, with `L` = 0.001 |
| exact duration | `s` | time |
| calendar duration | `month` | none (Calendar Units) |
| temperature difference | `degC` | temperature |
| USD | `USD` | USD |
| EUR | `EUR` | EUR |
| GBP | `GBP` | GBP |
| JPY | `JPY` | JPY |
| CHF | `CHF` | CHF |
| CNY | `CNY` | CNY |
| CAD | `CAD` | CAD |
| AUD | `AUD` | AUD |
| INR | `INR` | INR |
| SEK | `SEK` | SEK |

<!-- end -->

## The Unit Catalogue

<!-- generated: units.units -->

| Unit | Plural | Unit Kind | Factor to the Base Unit |
| --- | --- | --- | --- |
| `mg` |  | mass | 0.000001 |
| `g` |  | mass | 0.001 |
| `kg` |  | mass | 1 |
| `lb` |  | mass | 0.45359237 |
| `oz` |  | mass | 0.028349523125 |
| `mm` |  | length | 0.001 |
| `cm` |  | length | 0.01 |
| `m` |  | length | 1 |
| `km` |  | length | 1000 |
| `inch` | `inches` | length | 0.0254 |
| `ft` |  | length | 0.3048 |
| `yd` |  | length | 0.9144 |
| `mi` |  | length | 1609.344 |
| `mL` |  | volume | 0.001 |
| `L` |  | volume | 1 |
| `ms` |  | exact duration | 0.001 |
| `s` |  | exact duration | 1 |
| `min` |  | exact duration | 60 |
| `hr` |  | exact duration | 3600 |
| `day` | `days` | exact duration | 86400 |
| `week` | `weeks` | exact duration | 604800 |
| `month` | `months` | calendar duration | 1 |
| `year` | `years` | calendar duration | 12 |
| `degC` |  | temperature difference | 1 |
| `degF` |  | temperature difference | 5/9 |
| `USD` |  | USD | 1 |
| `EUR` |  | EUR | 1 |
| `GBP` |  | GBP | 1 |
| `JPY` |  | JPY | 1 |
| `CHF` |  | CHF | 1 |
| `CNY` |  | CNY | 1 |
| `CAD` |  | CAD | 1 |
| `AUD` |  | AUD | 1 |
| `INR` |  | INR | 1 |
| `SEK` |  | SEK | 1 |

<!-- end -->

## Outside parity

_None yet._
