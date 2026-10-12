---
type: fix
scope: tools
---
Ignore late output from stopped fuzz workers so a search deadline or worker restart cannot misread an old response as the replacement worker's capabilities (#672).
