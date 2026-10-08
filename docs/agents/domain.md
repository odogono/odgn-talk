# Domain docs

This repo uses a single-context layout: root `CONTEXT.md` and `docs/adr/`.

Before exploring, look up the relevant terms with `rg -n -A4 '^\*\*Term' CONTEXT.md`; list term names with `rg -n '^\*\*' CONTEXT.md` when needed. Read the matching definitions and their surrounding qualifications.

Find decisions in the [ADR index](../adr/README.md), then read the relevant ADRs and follow their supersession links. Add new decisions to that index when recording an ADR.

Use terms defined in `CONTEXT.md` when naming domain concepts. `bun run spec:gen` generates [Appendix A](../../spec/appendix-a-glossary.md) from `CONTEXT.md`; run it after editing a definition. If an output would contradict an ADR, call out that conflict explicitly.
