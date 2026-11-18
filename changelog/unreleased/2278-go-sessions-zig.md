---
type: feat
scope: go
breaking: true
---
Go sessions run the Zig Session Host through the embedded reactor's `session-v1`, so `session.Host` behaves as the Zig REPL does; `Host.Grants`, `MockOperations`, `UserLibraries`, `AddedScripts`, `GrantBinding`, `ObjectTranscript`, `Source`, the `Documentation` methods, `Record`, `Write`, `ReadCall`, `NewObjectReplay` and the replay-only `Objects` methods are gone, and `Host.Close` ends a session's guest (#2278).
