# Scripts check Shapes through Built-ins

The design for [#579](https://github.com/odogono/odgn-talk/issues/579) exposes `conforms`, `check` and `explain` as Built-ins using the existing Shape data model and acceptance rules. Guard availability and access to Quantity representation justify native checking under [ADR 0021](0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md); speed alone does not. Keeping one model avoids a second meaning of conformance, while first-failure checks and comprehensive diagnostics serve different callers without changing acceptance.

This records an agreed design, not implemented support. The [design handoff](../research/script-shapes-and-mappings.md) defines definition validation, diagnostics and resource obligations; exact Cost Model rates and the catalogue/Core changes remain outstanding. A Library-only checker was rejected because Libraries cannot run in Guards and lack direct Quantity representation access.
