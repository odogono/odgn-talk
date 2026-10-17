---
type: feat
scope: repo
---
Add opt-in `analysis-v1` to the Message Layer: `analyze-entry`, `analyze-source`, `analysis-catalogue` and `message-name` give a Session Host outside the Core an Entry's kind, completeness, leading documentation, declarations and implicit Script Variables, the `:describe`/`:apropos`/`:inspect` catalogue, and computed-message-name validity, without loading anything. The Zig Core serves them; the Zig Session Host now uses the same analysis (#1090).
