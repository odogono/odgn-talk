# Canvas is a deterministic Host capability

The Playground and TS CLI share a typed, immediate `canvas` capability whose validation and limits run without browser APIs. The browser draws from successful Trace calls; the CLI validates the same operations headlessly. We chose this over mock-backed drawing because completion, argument errors and replay need the same contract, and over direct browser side effects because reverse replay must reconstruct the drawing at its current position.

Each Session Host creates fresh extension state. Transcript replay executes the same deterministic extension; Trace replay carries its declarations and recorded outcomes. Extensions cannot use external I/O, lifecycle hooks, scopes or suspending operations through this registration seam. Canvas uses `ask`, so argument errors are ordinary catchable capability errors. Graphics are not Segment-bound: accepted commands remain visible even when later script work fails.

The canvas uses explicit logical dimensions, independent of pane size. Live evaluation keeps pixels and drawing styles; fresh execution resets both. Browser font rasterization is not part of replay parity: tests compare drawing commands and Trace records. Go Session Host support remains dependent on #137; it does not block browser/TS delivery. This workbench does not adopt the Project/Page/Element model of #154.
