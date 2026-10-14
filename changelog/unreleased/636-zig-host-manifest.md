---
type: feat
---
The Zig Core exports the Host Manifest: `talk_export_manifest` writes a `talk_manifest_spec`'s Grants, Libraries with their `needs`, `talk_message_decl` messages, Object Kinds and well-known objects as deterministic JSON, ordered by name. A `talk_operation` may now carry a `description` and `examples`, which only the manifest writes (#636).
