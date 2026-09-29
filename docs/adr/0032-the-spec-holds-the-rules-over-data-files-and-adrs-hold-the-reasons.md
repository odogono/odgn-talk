# The spec holds the rules, over data files, and the ADRs hold the reasons

The final spec is a `spec/` directory of Markdown chapters, one per area, that states every rule once and in its final form. It cites ADRs only for why a rule is the way it is. Every table both Cores must agree on lives in a data file under `spec/data/`, which is the truth: the instruction set, the Cost Model, the error codes, the Host error catalogue, the Unit Catalogue, limits, the grammar and the pinned Unicode version. The chapters show those tables through generated regions. A Bun script fills the regions from the data files, and CI fails any change where they differ. From now on, a decision gets an ADR and the same change edits the spec, and old ADRs stop getting "Narrowed by" notes. We chose this because a rule is currently spread over an ADR and up to five narrowing notes, which an implementer shouldn't have to piece together. ADR 0009 also needs both Cores to generate code from the same tables. If the prose and a data file could each be edited on their own, a mismatch between them would look like a divergence between the Cores. Settled in #83.

## Considered Options

- **One large spec file:** long diffs and reviews, and no stable per-chapter paths for data files and corpus cases to cite.
- **A docs-site generator as the source:** it ties the source of truth to a tool. A site can still be built over the chapters later.
- **Hand-written tables in the prose:** two copies of every table, and the Cores would generate from one of them while the reader reads the other.
- **Data files generated from the prose:** parsing tables out of Markdown is fragile, and reviewers would edit formatting to change semantics.
- **A spec that points into the ADRs for its rules:** that is today's piecing-together, made permanent.
- **Folding the ADRs into the spec as rationale:** rationale would swamp the rules, and the record of what was rejected would be lost.
- **RFC 2119 keywords:** almost every sentence would be a MUST. Instead, the spec is normative by default, and informative parts are labelled.
- **Checked-in Unicode tables:** megabytes nobody reviews, when a pinned version and file hashes are just as deterministic.
- **Keeping narrowing notes after the spec exists:** there would then be two places to update for each change, and they would drift apart.

## Consequences

- **Chapters:**
  - 0 introduction and conventions
  - 1 lexical structure
  - 2 grammar
  - 3 values
  - 4 expressions and statements
  - 5 Handlers, messages and scheduling
  - 6 errors and limits
  - 7 Libraries and the Standard Library
  - 8 the Abstract Machine and the Cost Model
  - 9 embedding
  - 10 save and restore
  - 11 the Trace and conformance, with the display form
  - 12 sessions and tooling
  - Appendix A, the glossary
  - Appendix B, the implementation order, with the corpus each milestone must pass
  - Appendix C, what's handed off open
- **Normative marking:** chapters are normative by default. Note, Example and Rationale blocks are informative. Each chapter ends with an "Outside parity" list for the freedoms that apply to it (ADR 0028).
- **Data files:**
  - `grammar.ebnf`, in W3C-style EBNF, and `grammar.toml`, which holds the reserved words, the contextual positions and the FOLLOW set
  - `machine.toml`, `costs.toml`, `errors.toml`, `host-errors.toml`, `units.toml` and `limits.toml`
  - `unicode.toml`, which holds the Unicode version and the SHA-256 hash of each Unicode Character Database file used. Each Core generates its tables from those files at build time.
- **Glossary:** `CONTEXT.md` stays the source, and Appendix A is a generated region.
- **Moves:** `docs/embedding/` moves to `spec/embedding/`, and its README becomes chapter 9. `corpus/` stays at the root, and chapters cite cases by path.
- **The tour** stays in `docs/tour.md` as an informative introduction, and its header will say the spec wins.
- **Versions:** narrows ADR 0018. The spec's version is the language version, and `costs.toml` carries the Cost Model version. The handoff is language 1.0-rc with a provisional Cost Model 0. Language 1.0 is declared once both Cores pass the seed corpus and Cost Model 1 has been calibrated against them.
- **Written before handoff:** everything the map still lists, except the Cost Model's rates.
- **Handed off open** (Appendix C): Cost Model 1 calibration, the TS Core's debug-pause hook and an optional tree-sitter grammar (ADR 0028).
- **Changing the spec:**
  - A decision gets a new ADR, and the same change edits the spec.
  - A narrowing is a new ADR that cites the one it narrows.
  - Small fixes can be spec-only changes.
  - ADRs 0001–0032 are left as they are.
