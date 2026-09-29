
- Settled by #69: "`exit` for the enclosing Handler" above doesn't exist. A Handler leaves early with a bare `return` (ADR 0019), and inside a Lambda `return` returns from the Lambda.
