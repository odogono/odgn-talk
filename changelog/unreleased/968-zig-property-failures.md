---
type: fix
---
Report Zig Host property failures to the embedding Host with an empty Call id, and retain the assigned value in failed-setter Trace records. Interrupted callbacks still land Stop/cancellation before reporting failures (#968).
