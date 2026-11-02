---
type: feat
scope: tools
---
Folio runs Project Add-ons signed with the NorthTalk key without the trust prompt. The deploy build signs every Project Add-on in the published Base and Example Projects and fails on one that doesn't verify. A missing, tampered or foreign signature still asks (#1967).
