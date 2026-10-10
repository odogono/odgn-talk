# Operation Declarations carry documentation that only tooling reads

An Operation Declaration may carry a `description` and `examples`, which the Host writes for people reading its Operations. The description is plain text. Each example is NorthTalk source that calls the Operation. The Cores accept them through `DefineCapability` and the message layer's `define-capability`, `ExportManifest` writes them to the Host Manifest, and nothing else reads them. The Group Fingerprint, saves, restore's declaration matching and the Trace all leave them out, so editing them never changes what a Script does or whether two Groups run in lockstep.

For example, a Host might declare:

```json
{
  "name": "fetch",
  "mode": "suspending",
  "args": ["text"],
  "result": {"map": [{"key": "status", "shape": "number"}, {"key": "body", "shape": "text"}]},
  "cost": {"fuel": 50, "alloc": 0},
  "maxPending": 30000,
  "description": "Fetches a URL with GET and answers with its status and body.\nRedirects are followed.",
  "examples": ["ask http to fetch \"https://example.com\" and wait"]
}
```

We chose this because the dictionary that tooling shows for each Grant (#526) shows a call's Shapes, cost and mode, but not what the Operation is for. Script Editor's dictionary is useful because it says that. The Host is the only party that knows, and the Operation Declaration is already where its knowledge reaches tooling (ADR 0015, ADR 0028). Keeping the text out of everything the Cores compare follows the rule that tooling output is never normative. A Host that fixes a typo in a description shouldn't get a new Fingerprint, refuse a restore or break lockstep with a peer still on the old wording. Settled in #526.

## Considered Options

- **Fields the Group Fingerprint covers:** a description change would split two Groups that run identical code, and a restore would treat reworded documentation as a changed declaration.
- **A separate documentation file next to the Host Manifest:** a second file that can go stale independently, keyed by Capability and Operation names that the Host already gives once in `DefineCapability`.
- **Documentation only in the Host's own manifest-writing code, outside the Cores:** each Host would need its own way to add it, and `ExportManifest` would no longer be the one writer of a manifest.
- **Declaration Documentation comments in a Host-written source file:** Operations have no NorthTalk source, so there is nothing for a `--|` block to attach to.
- **One `example`, as #526 first proposed:** an Operation with Optional arguments, or both `ask` and `ask … and wait` uses in a `tell` block, is better shown by several. A list of one costs nothing.
- **Markdown descriptions:** every renderer would need a Markdown dialect, and a plain-text reader such as a terminal REPL or the `northtalk/dictionary` request's plain form would show the markup. Plain text matches Declaration Documentation.
- **Examples the Core parses or checks at definition:** that would make a tooling-only field able to refuse `DefineCapability`, and an example may name Script variables that don't exist. Tooling may check them itself.
- **Normative descriptions for the Standard Capabilities:** each one's text would become a Spec change, and the Cores would need to match each other byte for byte for no behavioral gain. Tooling supplies its own text for them.

## Consequences

- **Declarations:** narrows ADR 0015.
  - An Operation Declaration may carry an optional `description`, which is text, and optional `examples`, which is a list of text. An empty description and an empty list are the same as none.
  - `DefineCapability` and `define-capability` refuse a `description` that isn't text, or `examples` that isn't a list of text, as they refuse other malformed declarations. Neither Core parses, checks or interprets the text.
  - The Standard Capabilities' declarations carry neither.
- **What leaves them out:** the Group Fingerprint, saves, restore's comparison of a Grant's saved declarations, the Trace, and `case.toml`. The Fingerprint's meaning doesn't change, since its key list in chapter 9 stays the same.
- **The Host Manifest:** narrows ADR 0028. Each Operation writes `description`, then `examples`, after its other keys, each only when present. A manifest's bytes therefore change with its documentation, while the Fingerprint doesn't.
- **Tooling:** the dictionary, LSP hover and completion documentation, and the Playground's Dictionary show the description and examples when a declaration has them. How they show them is tooling freedom (ADR 0028).
