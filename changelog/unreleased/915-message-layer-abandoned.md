---
type: feat
scope: spec
---
Define the Message Layer's `abandoned` field: a `pump`, `reload` or `replace-library` reply lists, once and in call id order, the started suspending calls the Core has abandoned since its previous such reply, standing in for an in-process Call's cancellation context or signal (#915).
