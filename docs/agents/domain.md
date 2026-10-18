# Domain docs

This repo uses a single-context layout: root `GLOSSARY.md` and `docs/adr/`.

Before exploring, look up the relevant terms with `rg -n -A4 '^\*\*Term' GLOSSARY.md`; list term names with `rg -n '^\*\*' GLOSSARY.md` when needed. Read the matching definitions and their surrounding qualifications.

Find decisions in the [ADR index](../adr/README.md), then read the relevant ADRs and follow their supersession links. Add new decisions to that index when recording an ADR. Take the next number from `git fetch origin main && git ls-tree --name-only origin/main docs/adr/`, not from your branch, and take it when you commit the ADR, not when you start drafting it: parallel worktrees claim numbers too. The pre-push hook and `bun run check` refuse a number another ADR already has; renumber yours, its index line and every reference to it.

Use terms defined in `GLOSSARY.md` when naming domain concepts. `bun run spec:gen` generates [Appendix A](../../spec/appendix-a-glossary.md) from `GLOSSARY.md`; run it after editing a definition. If an output would contradict an ADR, call out that conflict explicitly.
