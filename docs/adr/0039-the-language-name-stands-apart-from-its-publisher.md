# NorthTalk is the standalone language name

The working public name is **NorthTalk**: it suggests readable, conversational scripting, retains the HyperTalk lineage and echoes the direction in ODGN (Open Door Go North) without requiring Hosts to explain that origin. We chose a standalone name so Hosts can adopt the language without presenting it as ODGN-specific. The complete naming contract for [#87](https://github.com/odogono/odgn-talk/issues/87) was confirmed on 1 October 2026 and applied to the Spec and public documentation.

Source files retain `.talk`, and Host Manifests retain `.talk-manifest.json`: these short, readable conventions preserve the lineage without depending on the full public name. Package names follow the language name, using `@odgn/northtalk` in TS and package `northtalk` in Go; ODGN remains the publisher.

The future Go module is `github.com/odogono/odgn-talk/impl/go`, with the public `northtalk` package at the module root and its driver at `github.com/odogono/odgn-talk/impl/go/driver`. The import path follows the retained repository while the package identifier follows the language name. The TS driver path is `@odgn/northtalk/driver`.

The repository stays `odogono/odgn-talk`, so repository links and schema identity URLs remain stable. The literal `odgn-talk code identity 1` stays in the code identity recipe: changing branding should not change Script and Library identities, Group Fingerprints or save compatibility. The command and editor language ID are `northtalk`, and the language server launches as `northtalk lsp`.

## Preliminary clash checks

Checked on 1 October 2026. Searches found no exact programming-language match, and no indexed matching Go module. The exact npm package endpoints for [`northtalk`](https://registry.npmjs.org/northtalk) and [`@odgn/northtalk`](https://registry.npmjs.org/%40odgn%2Fnorthtalk) returned 404; this establishes neither reservation nor publish permission. There are unrelated existing uses, including a Freemasons [NORTHTALK newsletter](https://themasons.org.nz/ndiv/docs/northtalkmarch2018.pdf).

| Official register | Query | Observed result |
| --- | --- | --- |
| [UK IPO](https://trademarks.ipo.gov.uk/ipo-tmtext) | Exact `NorthTalk`, all statuses, no class restriction | No matching marks |
| [USPTO](https://tmsearch.uspto.gov/) | `NorthTalk` Wordmark, live and dead; separately `CM:"North Talk"` | No results for either query |
| [EUIPO eSearch](https://euipo.europa.eu/eSearch/#basic/1+1+1+1/100+100+100+100/NorthTalk) | Basic `NorthTalk` | Zero trade marks |
| [WIPO Global Brand Database](https://branddb.wipo.int/) | `NorthTalk`, exact expression, no country or class restriction | Historical New Zealand `NORTHTALK` registration 639220, North Shore Bays Community Fitness Centre Trust, class 41; shown as expired on 7 June 2008 |

These are preliminary searches, not trademark clearance. The spaced form `North Talk` was not verified in the UK, EU or WIPO searches after the browser connection failed; confusingly similar marks and unregistered rights were not assessed. NorthTalk is adopted as a working name with those limits recorded.

## Consequences

- Amended by [ADR 0046](0046-each-core-lives-under-impl-beside-a-shared-spec.md): the Go module moved from the repository root to `impl/go/`, so its path is `github.com/odogono/odgn-talk/impl/go` and its driver's is `github.com/odogono/odgn-talk/impl/go/driver`. The package identifier is still `northtalk`.
