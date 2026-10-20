# Folio Projects own their Libraries as independent source copies

Folio stores authored Libraries inside each Project, alongside its Scripts, and registers them with that Project’s Play Session. A Project file carries every Library’s source; reusing code in another Project means copying it, and later changes stay local. We chose this over a shared mutable collection or external dependencies because a saved Project must remain portable and editing one creation must not change another. Authors give Libraries names, without managing versions. The language’s stateless Library model and explicit Imports remain unchanged ([ADR 0020](0020-scripts-share-code-through-stateless-libraries.md), narrowed by [ADR 0113](0113-library-code-may-wait-for-messages-to-the-calling-runs-script.md)).

## Consequences

- One Code Browser selects Project, Page and Element Scripts or Libraries; Libraries never become Script owners or Message Path nodes. Code selection is independent of canvas navigation.
- Library creation, source changes, rename and deletion are authored edits with history. Rename/delete leaves importing source untouched, so diagnostics guide manual repair. Invalid source drafts remain saveable; failed Libraries and their dependents do not prevent independent Scripts from playing.
- Browse keeps its loaded Library source until the next Play Session. Present is read-only. Library error locations retain their source identity through authoring renames and deletion.
- Project files use format 3. Older Projects migrate with an empty Library collection; older Folio readers refuse the newer format instead of silently dropping Library source.
- The two Tetris Example Projects embed identical stateless helpers as independent Libraries; mutable game state and events remain in Scripts.
- Copy/paste is the initial reuse workflow. A shared catalogue, external resolution, source-file import/export, automatic import refactoring and author-managed versions are deferred.

This ADR records the agreed design from [#1380](https://github.com/odogono/odgn-talk/issues/1380).
