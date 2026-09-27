# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
- Read: `gh issue view <number> --comments`; fetch labels as needed.
- List: `gh issue list --state open --json number,title,body,labels,comments`, with appropriate filters.
- Comment: `gh issue comment <number> --body "..."`.
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Run commands from this clone so `gh` infers `odogono/odgn-talk`.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` if external PRs should enter the triage queue.

## Skill terminology

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": read it with `gh issue view <number> --comments`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog.
- Child: a GitHub sub-issue linked to the map, labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). If sub-issues are unavailable, link it from a task list in the map and add `Part of #<map>` to its body.
- Blocking: use GitHub issue dependencies. If unavailable, add `Blocked by: #<n>, #<n>` to the child body.
- Frontier: take the first open, unassigned child in map order with no open blocker.
- Claim: `gh issue edit <n> --add-assignee @me` before work.
- Resolve: comment with the answer, close the child, then add a context pointer and link to the map's Decisions-so-far.
