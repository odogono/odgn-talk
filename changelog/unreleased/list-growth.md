---
type: perf
---
Make sequential List appends, prepends, spreading and `collecting` use linear
host work on both Cores, while preserving value semantics, Fuel and logical
allocation (#503).
