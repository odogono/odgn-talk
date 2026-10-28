---
type: feat
scope: tools
breaking: true
---
Tell clicks apart in Folio: `click` now carries `{button, x, y}`, so `on click {button: 2}` handles a right-click and `x` and `y` say where the Element was clicked. A new `pointerHeld {held, x, y}` reports a press each frame while it lasts, for long presses on touch screens. The Folio Harness gains `click "name", {button: 2}` and `hold "name", 500 ms`. Projects saved earlier open with each `on click` rewritten as `on click {button: 0}`, and the Code Browser warns about an `on click` without a parameter, which no click reaches.
