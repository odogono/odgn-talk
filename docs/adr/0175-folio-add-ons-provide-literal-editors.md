# Folio Add-ons provide Literal Editors, starting with the Piano Roll

A Folio Add-on can now provide Literal Editors as well as Element kinds and Instrument kinds. A Literal Editor is another way to view one kind of source literal from the Code Browser. It opens in its own window, pinned to one literal, and it changes that literal only by rewriting its text. The first one is the Piano Roll for Mini-Notation. It is built with Folio and referenced by version, and the Music Base Project lists it.

The Mini-Notation text stays the only source of truth. The Piano Roll gets the literal's text, the parsed step tree with source spans, the Playing Highlight events and a callback to replace the text. It gets nothing else from the Script, the Project or the Code Browser. Edits that would change the source's bracket structure are refused rather than rewritten. Open windows are not saved with the Project.

We chose an Add-on contribution over an Element kind because an Element is runtime content placed on Pages and Palettes. Binding one to the text of a Script would blur running a Project with authoring its source. We kept it out of the core so Folio does not take on a music-specific editor, and so carried Add-ons can later provide Literal Editors under ADR 0162's trust rules. The narrow contract is what makes that later trust decision tractable.

This extends ADR 0162.
