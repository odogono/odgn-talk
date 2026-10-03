---
type: feat
---
Add single-Script Go Decisions, Verdict futures and reports, and `deciding`/`veto` execution with finally cleanup. Keep Verdicts open across preemption, seal at the first Segment boundary, and report failures before sealing as undecided. Reject late or locally called vetoes at load. In both Cores, ordinary dispatch allows only after its complete initial charge succeeds. Expand the Go corpus gate to 96 cases (#134).
