# Elixir callback codec, 2026-10-19 (#1316)

This re-measures [the #1315 comparison](../2026-10-19-darwin-arm64/README.md)
after the codec changes for #1316. The fields envelope's immediate-call
regression shrinks from 15–18% to 1.5–2.6%. That is close to JSON, but it is
**not** shown to be no slower. Property refusals are about 2% faster in fields
mode.

## Cause

The guest was not the cause. Replaying the recorded frames into a bare
reactor, with no owner, took about 46 µs per exchange in either mode, and
fields mode was slightly faster. The regression came from garbage collection
in the owner process:

- Binary needs allocated 1,319 words per decode, against 362 for JSON. An
  answer allocated 249 words, against 131 for JSON.
- The owner therefore ran 4.6× as many collections, including 32 major ones
  per 2,000 crossings.
- Those collections cost far more wall time than their own traced duration.
- Raising the owner's minimum heap closed most of the gap. Field-by-field
  CPU, which #1316 originally suspected, was a small part.

The changes:

- Every frame field declares its item kind in the codec's schema. This
  removes the per-tag `object`/`selector` overrides and the global `value`
  key rule.
- A need decodes straight into the plain maps the owner answers from, with
  no `OrderedObject` and no `plain/1` pass.
- The field reader matches short text, small integers and booleans in
  place, keeping the binary match context. `bin_opt_info` reports it
  reused.
- The owner encodes its answer directly with `Binary.encode_answer/3`,
  rather than through a sorted map.
- `NorthTalk.Instant.format/1` writes four-digit years without `DateTime`.
  It was checked against the previous formatter at the range's edges and on
  200,000 random instants.

Allocation per crossing, with JSON including the owner's `plain/1` pass:

| | Need decode, words | Answer encode, words |
| --- | ---: | ---: |
| JSON | 462 | 154 |
| Fields, before | 1,319 | 249 |
| Fields, after | 487 | 158 |

A fixed 224 KiB minimum heap for the owner was tried and rejected. Short
runs showed parity, but some full runs became bimodal, at about 94 µs per
crossing in both modes.

## Method

The environment and the [measure.exs](../2026-10-19-darwin-arm64/measure.exs)
harness are unchanged from #1315: the same reactor, built from `f8644caf`
(`reactor-v0.8.0`), and Apple M5 with OTP 29.

- `main` at `6d6ece60` and this branch ran from separate checkouts against
  the same `talk.wasm`.
- There were three repetitions of each, alternating `main` and the branch,
  with default schedulers and with `+S 2:2`.
- Each repetition is the harness's eight interleaved rounds of 40 measured
  Requests of 100 crossings.
- The workstation was not isolated. Load averages were about 3.5–4.3, and
  an occasional repetition is visibly perturbed.

## Results

Each cell is the median of 24 per-round medians, in µs per crossing. "Paired"
is the median of the 24 same-round fields/JSON changes. Lower is better.

| Revision, schedulers | Workload | JSON | Fields | Paired |
| --- | --- | ---: | ---: | ---: |
| main, default | immediate | 58.17 | 69.58 | +18.2% |
| this branch, default | immediate | 59.32 | 61.00 | +1.5% |
| main, `+S 2:2` | immediate | 58.81 | 68.08 | +14.8% |
| this branch, `+S 2:2` | immediate | 59.65 | 61.97 | +2.6% |
| main, default | property refusal | 54.18 | 53.92 | −0.0% |
| this branch, default | property refusal | 54.83 | 53.93 | −1.7% |
| main, `+S 2:2` | property refusal | 55.21 | 54.74 | −0.7% |
| this branch, `+S 2:2` | property refusal | 54.87 | 53.38 | −2.0% |

[samples.jsonl](samples.jsonl) holds all 384 Request-sample records. Each is
tagged with its revision (`rev`) and repetition (`rep`), and its timings are
normalised to nanoseconds per crossing.

## Verification

- `mix test` and `NORTH_TALK_CALLBACKS=fields mix test` each pass all 102
  tests.
- `mix format --check-formatted` and `mix compile --warnings-as-errors`
  pass.
- The shop example's 5 tests pass.
