---
type: feat
scope: ts
---
`@northtalk/ts` saves are no longer JSON: `save()` writes the binary save format both Cores share (chapter 10, ADR 0144), so a TS save restores on the Zig Core and a Zig save on the TS Core. Saves written by earlier versions are refused as `invalid save`. A stale Function Value's documentation now survives a restore only in a Session, which keeps it by code unit (#1722).
