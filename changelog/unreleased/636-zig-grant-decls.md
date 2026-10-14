---
type: feat
---
The Zig Core's `talk_compile_library` now takes `talk_grant_decls`, each Grant's `talk_operation_check` modes and argument Shapes, instead of Grants, and `talk_capability_def_checks` gives them for a definition. A release hook is now a `talk_capability_option` from `talk_with_release_hook`, which `talk_define_capability`, `talk_define_segment_capability` and `talk_define_coordinated_capability` take beside their Operations (#636).
