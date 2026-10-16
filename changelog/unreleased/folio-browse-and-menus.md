---
type: feat
scope: tools
---
Folio now plays a Project in place, as HyperCard's browse tool did (ADR 0093). **Browse** and **Edit** head the Tools window: Browse runs the Page where it is edited, with the Tools, Script and Errors windows still open, and Edit, an Element tool or Escape returns to Edit on the Page reached. Scripts stay editable while browsing and apply from the next session. The header's **Play** becomes **Present**, which plays full-window and turns into a single **Stop** that returns to Edit; there is no separate Back to Edit or frozen stopped session. Script problems go to a new Errors window that links to each Script line and outlasts the session. The header gains a **Folio** menu with About Folio and a **File** menu holding New Project, Import Project…, Save and Save As…, and drops "made with NorthTalk".
