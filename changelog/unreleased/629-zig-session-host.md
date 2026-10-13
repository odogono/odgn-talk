---
type: feat
---
Add the Session Host to the Zig Core. It replays Session Transcripts with Entries, the session source, Reload on redefinition, foreground and background Runs, and the Session Commands but the Store and observation ones, so 14 `sessions/` cases now pass. A Script extension's Handler is now reused only by its full Selector, and `talk_compile_library` returns its diagnostics as a `talk_load_error` (#629).
