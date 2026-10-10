---
type: feat
scope: tools
---
Add the `interpolated-sql` Lint. It flags Interpolated Text, or text built with `&` from a non-Constant, passed as the SQL of `sqlite`'s `query` or `change`, and points to bound parameters. It's a warning in both Profiles (ADR 0070, #470).
