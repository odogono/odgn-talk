---
type: feat
scope: tools
---

Add the creative tool's Project model and file format in `tooling/creative`. A Project holds Pages of named Elements (rich text, image, button, rectangle, ellipse and line), its Scripts and its assets. It saves as one zip file that ordinary unzip tools open. Opening a damaged file reports where the damage is, and a file from a newer version of the tool is refused rather than half-read (#748).
