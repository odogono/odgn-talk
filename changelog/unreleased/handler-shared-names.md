---
type: fix
---
Allow TS and Go Handlers to share Script Variable and Constant names, matching the Spec and Zig Core (#769). Value references still read the variable or Constant, and Command Calls still select the Handler.
