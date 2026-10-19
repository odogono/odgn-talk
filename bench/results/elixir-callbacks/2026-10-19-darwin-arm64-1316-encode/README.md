# Elixir callback answer encoding, 2026-10-19 (#1316)

This follows [the first #1316 report](../2026-10-19-darwin-arm64-1316/README.md),
which left immediate callbacks in fields mode 1.5–2.6% slower than JSON. After
this change the gap is 0.2% with default schedulers and 0.6% with `+S 2:2`.
That is within this workstation's run-to-run noise, but it is still not shown
to be no slower. Property refusals are 3.0–3.3% faster in fields mode.

## Cause

Need decoding was already faster than JSON. Encoding the answer was not.
Measured in a compiled loop over recorded frames:

| | JSON, ns | Fields before, ns | Fields after, ns |
| --- | ---: | ---: | ---: |
| Need decode (JSON includes `plain/1`) | 1,480–1,830 | 1,110–1,420 | 1,110 |
| Answer encode | 345–400 | 930–1,010 | 460–510 |

`Binary.encode_answer/3` turned the answer map into a list, looked for the
outcome with `Enum.find`/`Enum.filter`, checked every field with
`List.keymember?`, read each schema field with `List.keyfind`, and typed every
protocol item by comparing its key against the Value key list. It now reshapes
the answer map once, reads fields from that map in schema order, and writes
text, integer and boolean protocol items without consulting key names.

The owner process also spends fewer reductions per crossing in fields mode
(about 670, against 840 for JSON). What is left of the gap is in the
transport and guest exchange, and it is smaller than the run-to-run spread.

## Method

The environment and the [measure.exs](../2026-10-19-darwin-arm64/measure.exs)
harness are unchanged: Apple M5, OTP 29, and the reactor built from `9ff3ca0d`
(the last Zig change before `main` at `7baedc84`).

- `main` and this branch ran from the same checkout, swapping only
  `lib/north_talk/binary.ex` and recompiling, against the same `talk.wasm`.
- There were three repetitions of each, alternating `main` and the branch,
  with default schedulers and with `+S 2:2`.
- Each repetition is the harness's eight interleaved rounds of 40 measured
  Requests of 100 crossings.
- The workstation was not isolated. Load averages were about 2.7–3.7, and
  some rounds jump from about 56 µs to about 70 µs in both modes.

## Results

Each cell is the median of 24 per-round medians, in µs per crossing. "Paired"
is the median of the 24 same-round fields/JSON changes. Lower is better.

| Revision, schedulers | Workload | JSON | Fields | Paired |
| --- | --- | ---: | ---: | ---: |
| main, default | immediate | 56.46 | 57.19 | +1.5% |
| this branch, default | immediate | 57.03 | 57.16 | +0.2% |
| main, `+S 2:2` | immediate | 56.92 | 57.96 | +1.9% |
| this branch, `+S 2:2` | immediate | 56.91 | 57.25 | +0.6% |
| main, default | property refusal | 53.61 | 52.57 | −2.1% |
| this branch, default | property refusal | 54.54 | 53.00 | −3.0% |
| main, `+S 2:2` | property refusal | 54.58 | 53.69 | −2.1% |
| this branch, `+S 2:2` | property refusal | 54.86 | 53.13 | −3.3% |

[samples.jsonl](samples.jsonl) holds all 384 Request-sample records. Each is
tagged with its revision (`rev`), repetition (`rep`) and schedulers (`sched`),
and its timings are nanoseconds per crossing.

## Verification

- `mix test` and `NORTH_TALK_CALLBACKS=fields mix test` each pass all 103
  tests.
- `mix format --check-formatted` and `mix compile --warnings-as-errors`
  pass.
- The shop example's 5 tests pass.
