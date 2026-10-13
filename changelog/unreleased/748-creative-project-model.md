---
type: feat
scope: tools
---
Add the creative tool's authored Project model and its portable file format in `tooling/creative`: Pages of positioned Elements (rich text, image, button, rectangle, ellipse and line) with identifier names, Scripts and SHA-256-keyed assets, written as a zip of a versioned `project.json` plus one file per asset through a small zip reader and writer of our own, with path-reporting validation and stepwise format migrations (#748).
