---
type: feat
---
Apply `queued`, `dropping` and `replacing` to selected Go Handler Clauses after matching and Guards. Resume parked Runs FIFO, settle dropped Requests, and run replacement cleanup with committed Segment state preserved. In both Cores, leave earlier Runs intact when a replacement cannot pay its combined initial dispatch charge. Expand the Go corpus gate to 92 cases (#134).
