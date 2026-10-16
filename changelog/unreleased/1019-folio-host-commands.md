---
type: feat
scope: tools
---
Give Folio `hide` and `show` as Host Commands of a `folio` Grant that every Script and Message Box command gets (ADR 0094). A failing call, such as `hide` of a number, is now reported on its own line, in Errors or in the Message Box, and stops the calling Handler. The `folio` Library and the hidden object above the Project are gone, so `use hide from folio` no longer loads, and a Page or Project Script can no longer intercept an Element's `hide`; a Script's own `on hide` still takes its own calls.
