# 0. Introduction and conventions

_Draws on:_ [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md), [ADR 0039](../docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md).

This is the Spec of NorthTalk, a HyperTalk-descended scripting language for running untrusted end-user Scripts in a sandbox inside Go servers, Bun servers and browsers. It states every rule of the language once, in its final form. Together with the Conformance Corpus, it is the authority on what the language does. There are two Cores, one in Go and one in TS. Neither is the reference, and both answer to the Spec and the corpus, bit for bit ([ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

The ADRs in [`docs/adr/`](../docs/adr/) record why each rule is the way it is, and what was rejected. The Spec cites them only for reasons. Where the Spec and an ADR disagree, the Spec wins. The [tour](../docs/tour.md) is an informative introduction.

## Name and source files

The language's public name is **NorthTalk**. Script and Library source files use the `.talk` extension ([ADR 0039](../docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md)).

## Versions

<!-- generated: version -->

This is language **1.0-rc.2**, with Cost Model **0**.

<!-- end -->

The language version is the Spec's version. It pins the grammar, the Unicode version, the Unit Catalogue and the other catalogues, the display form and the Trace grammar ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)). The Cost Model has a version of its own, which also covers the Abstract Machine, since a change to the lowering changes Fuel.

The Spec is handed off as language 1.0-rc.2 with a provisional Cost Model 0. Language 1.0 is declared once both Cores pass the seed corpus and Cost Model 1 has been calibrated against them ([ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md)).

Language `1.0-rc.2` breaks compatibility with earlier prereleases: reusable text/date Format Templates require `${…}` and use `$$` for a literal dollar; bare braces are ordinary text. Update templates and regenerate pinned Library identities, saved-state compatibility keys and corpus expectations. Ordinary quoted text is unchanged. Before language 1.0, lowering changes may accompany a language prerelease while provisional Cost Model 0 stays at 0; Cost Model 1 remains reserved for calibration ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#prerelease-cost-model-exception)).

## What is normative

- **Normative by default:** every sentence in a chapter is a rule both Cores must follow, unless it is marked informative.
- **Informative blocks:** a blockquote that starts with a bold label is informative. There are three labels:
  - `> **Note.**` for a remark that helps a reader and adds no rule.
  - `> **Example.**` for an example. The rule it illustrates is stated elsewhere.
  - `> **Rationale.**` for a short reason, where citing an ADR isn't enough.
- **Also informative:** the "Draws on" line under each chapter's title, and Appendices A to C.
- **Outside parity:** each chapter ends with an "Outside parity" list of the freedoms that apply to it, where the Cores or the tooling may differ ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)). Everything not on such a list is covered by parity.
- **Data Files:** a table both Cores must agree on lives in a Data File under [`spec/data/`](data/), and the Data File is the truth. A chapter shows it through a generated region (below). The two are kept identical, and a change where they differ fails CI.

## Citing ADRs

- **A rule is stated in full here.** An ADR is cited only for why, never for what. A citation is a link, as in [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md).
- **Draws on:** a chapter's "Draws on" line lists every ADR its rules come from.
- **Issues** are cited by number, as in [#72](https://github.com/odogono/odgn-talk/issues/72).
- **Changing the Spec:** a decision gets a new ADR, and the same change edits the Spec. A narrowing is a new ADR that cites the one it narrows. A small fix can be a Spec-only change. ADRs 0001 to 0032 are left as they are ([ADR 0032](../docs/adr/0032-the-spec-holds-the-rules-over-data-files-and-adrs-hold-the-reasons.md)).

## Notations

- **Terms:** a capitalised term, such as Script, Handler or Run, has the meaning [Appendix A](appendix-a-glossary.md) gives it.
- **Source code** is written in `talk` code blocks. A comment after an expression shows the value it gives, in the display form:

  ```talk
  put 0.1 + 0.2 into x              -- 0.3
  ```

- **Values in prose** are written in their display form ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)), such as `2.50 GBP`, `2026-09-27` or `"text"`.
- **Error Codes** are written in code font, such as `can't convert`.
- **Grammar productions** are written in the EBNF notation of [the W3C XML Recommendation](https://www.w3.org/TR/xml/#sec-notation), and live in [`grammar.ebnf`](data/grammar.ebnf), or in [`trace.ebnf`](data/trace.ebnf) for the display form, Traces and Session Transcripts.
- **Data Files** are cited by path, such as `spec/data/errors.toml`.
- **Corpus cases** are cited by path, such as [`corpus/examples/orders-pricing/`](../corpus/examples/orders-pricing/).

## Generated regions

A region written as `<!-- generated: name -->` … `<!-- end -->` is filled from the Data Files, or from [`CONTEXT.md`](../CONTEXT.md) for Appendix A, so it is never edited by hand. The generator lives in [`tools/spec/`](../tools/spec/generate.ts).

- `bun run spec:gen` validates each Data File against its schema in [`spec/data/schema/`](data/schema/), runs the checks between Data Files, checks every relative link and literal `bun run` script reference in the repo's Markdown files, and rewrites every region.
- `bun run spec:check` runs the same checks, and fails if any region is out of date instead of rewriting it. CI runs it on every pull request.

Documentation commands run from the repository root. For a workspace-only script, use `bun run --cwd path/to/workspace <script>`. Script-reference validation checks literal names against that directory's `package.json`; it does not execute examples or interpret shell state such as `cd`, variables or pipelines.

## Outside parity

_None._
