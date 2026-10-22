---
type: feat
---
Add the Zig Core's REPL, the native `northtalk` command without a file: the Session Host at a terminal under a real Clock, run with `zig build repl`. An Entry may span lines, since the REPL waits until it is complete. The REPL answers `read` and `user` prompts from standard input, pumps at deadlines while it waits, and can write the session's Transcript and Trace (#629).
