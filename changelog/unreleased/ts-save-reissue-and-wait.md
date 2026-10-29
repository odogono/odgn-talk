---
type: fix
scope: ts
---
Save the same bytes as the Zig Core after a restore. A reissued call records its reissue's Clock reading and Charge, and a Run that waited on a restored call keeps that call's id as its last wait (#1746, #1781).
