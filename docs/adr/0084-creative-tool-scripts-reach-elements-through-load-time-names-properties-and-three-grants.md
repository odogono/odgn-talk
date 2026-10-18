# Creative tool Scripts reach Elements through load-time names, properties and three Grants

Extended by [ADR 0100](0100-object-element-references-use-a-fixed-spelling-and-a-host-collection.md)
(computed and numbered Element references).

Extended by [ADR 0103](0103-folio-groups-are-nested-elements-with-page-wide-names.md)
(Group Elements, nested message parents and unchanged Page-wide names).

The planned [browser creative tool](https://github.com/odogono/odgn-talk/issues/154) maps Projects, Pages and Elements to Host Objects within the existing language, with no syntax of its own. Each Element type is its own Object Kind: `text`, `image`, `button`, `rectangle`, `ellipse` and `line`, besides `project` and `page`. Pages have identifier names unique across the Project; Element names are unique within their Page, cannot collide with Page names, and object names avoid reserved bindings, as revised by [#783](https://github.com/odogono/odgn-talk/issues/783). These are the names which the Host binds as well-known names when Play loads each Script. Every Script gets every Page name. A Page or Element Script also gets its own Page's Elements, plus `thisPage` and `project`. Scripts change what the reader sees through properties, such as `set the label of climbButton to "…"`. Everything else goes through three Grants, which every Script receives: `pages` to navigate, `elements` to create, clone, delete and find Elements, and `sound` to play and stop audio. We chose this because the language has no lookup by name, and because names bound at load turn a misspelt Element into a load error that points at the Script and line. The full set of decisions is in [#735](https://github.com/odogono/odgn-talk/issues/735).

## Considered Options

- **Look Elements up by name at run time,** with an Operation such as `ask elements to find "Climb the stairs"`. It keeps free-form names with spaces, as in HyperCard, but every reference costs a line and an `ask`, and a typo fails only when the line runs. It remains available for Elements on another Page.
- **One `element` Object Kind with a type property.** It is simpler for the Host, but the Host Manifest could no longer list which properties a button has, so tooling would suggest a line's `thickness` on a button.
- **One Grant for every effect,** such as `tell story to show cellar`. It is one less name to learn, but three Grants named for what they act on read as English: `tell pages to show cellar`, `tell sound to play "waves"`.
- **Different Grants for Project, Page and Element Scripts.** A non-programmer wouldn't understand why a button can't do what its Page can, and the Page lifecycle already limits what a local Script can affect.

## Consequences

- A button's visible `label` is separate from its `name`, so readers still see free text. The editor checks names and suggests one from the label.
- Each Script binds different names, so the editor generates a Host Manifest for each Script rather than one per kind of Script. The Host Manifest can't yet say what kind `me` is; that is a tooling follow-up in #154.
- Renaming an Element breaks the Scripts that use it, and the next Play reports the break as a load error. The editor may later offer to rename the references too.
- Properties can be added to a kind later without breaking Scripts. Removing or renaming one, or a Grant or Operation, breaks saved Projects, which is why this is recorded here.
- This records future Host policy for #154, like [ADR 0041](0041-authored-projects-are-separate-from-temporary-play-state.md). It changes neither the language Spec nor any Core.
