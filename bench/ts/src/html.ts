// The benchmark page of a saved run: as one self-contained HTML file with no
// external resources, or as sections northtalk.org/benchmarks/ embeds. See
// bench/README.md.
import {
  bytes,
  cores,
  count,
  isPeer,
  type Measurement,
  ms,
  nsPerFuel,
  type Payload,
  payloadRows,
  type Results,
  type Sizes,
  us,
  zigPayload,
} from './report';

const esc = (s: unknown) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** A Benchmark's category is its script directory, the first part of its name. */
export const category = (benchmark: string) =>
  benchmark.includes('/') ? benchmark.slice(0, benchmark.indexOf('/')) : '';

const entries = (o: Record<string, string | number | boolean>) =>
  Object.entries(o)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${esc(k)} ${esc(v)}`)
    .join(', ');

const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const sizeCell = (n: number) =>
  `<td title="${n} B" data-v="${n}">${kib(n)}</td>`;

// A duration in the unit that suits it.
const duration = (ns: number) =>
  ns >= 1e9
    ? `${(ns / 1e9).toPrecision(3)} s`
    : ns >= 1e6
      ? `${(ns / 1e6).toPrecision(3)} ms`
      : ns >= 1e3
        ? `${(ns / 1e3).toPrecision(3)} µs`
        : `${ns.toPrecision(3)} ns`;

// Every rule is scoped to .bench, so the sections can sit inside another page,
// such as northtalk.org/benchmarks/, which sets the same custom properties.
export const style = `
.bench {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --surface-2: #f0efec;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --grid: #dcdbd6;
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  .bench {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --surface-2: #2a2a28;
    --text-primary: #f0efec;
    --text-secondary: #c3c2b7;
    --grid: #3a3a37;
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --critical: #e66767;
  }
}
.bench * { box-sizing: border-box; }
body.bench {
  margin: 0;
  background: var(--surface-1);
  color: var(--text-primary);
  font: 14px/1.45 system-ui, sans-serif;
}
body.bench main { padding: 24px; max-width: 1200px; margin: 0 auto; }
.bench figure { margin: 0; }
body.bench h1 { font-size: 22px; margin: 0 0 8px; }
body.bench h2 { font-size: 17px; margin: 32px 0 8px; }
.bench h3 { font-size: 14px; margin: 20px 0 6px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: .04em; }
body.bench p, body.bench li { color: var(--text-secondary); }
body.bench a { color: var(--series-1); }
.bench .note { border-left: 3px solid var(--grid); padding: 4px 12px; background: var(--surface-2); }
.bench table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
.bench th, .bench td { padding: 4px 8px; border-bottom: 1px solid var(--grid); text-align: right; white-space: nowrap; }
.bench th:first-child, .bench td:first-child, .bench th.l, .bench td.l { text-align: left; }
.bench thead th { position: sticky; top: 0; background: var(--surface-1); cursor: pointer; user-select: none; color: var(--text-secondary); font-weight: 600; }
.bench thead th[aria-sort="ascending"]::after { content: " ▲"; }
.bench thead th[aria-sort="descending"]::after { content: " ▼"; }
.bench .payload { max-width: 760px; }
.bench .payload th { cursor: default; position: static; }
.bench .controls { display: flex; gap: 12px; align-items: center; margin: 8px 0; }
.bench .legend { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; color: var(--text-secondary); }
.bench .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.bench .charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr)); gap: 16px 24px; }
.bench .chart figcaption { font-weight: 600; margin-bottom: 2px; }
.bench .chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.bench .chart text { fill: var(--text-secondary); font-size: 12px; }
.bench .chart .value { fill: var(--text-primary); }
.bench .chart .whisker { stroke: var(--text-secondary); stroke-width: 1.5; }
.bench .chart .baseline { stroke: var(--grid); stroke-width: 1; }
.bench .chart .hit { fill: transparent; }
.bench .chart .hit:hover { fill: var(--surface-2); }
.bench .core { fill: var(--series-1); background: var(--series-1); }
.bench .peer { fill: var(--series-2); background: var(--series-2); }
.bench .reactor { fill: var(--series-3); background: var(--series-3); }
.bench .bad { color: var(--critical); }
.bench .scroll { overflow-x: auto; }
.bench [hidden] { display: none !important; }
`;

// Sorts the table by a clicked header, and filters the table and charts by category.
export const script = `
const table = document.querySelector('#measurements');
if (table) {
const body = table.tBodies[0];
table.querySelectorAll('thead th').forEach((th, column) => {
  th.addEventListener('click', () => {
    const ascending = th.getAttribute('aria-sort') !== 'ascending';
    table.querySelectorAll('thead th').forEach(h => h.removeAttribute('aria-sort'));
    th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
    const key = row => {
      const cell = row.cells[column];
      const v = cell.dataset.v;
      return v === undefined ? cell.textContent : v === '' ? NaN : Number(v);
    };
    const rows = [...body.rows].sort((a, b) => {
      const x = key(a), y = key(b);
      if (typeof x === 'number' && typeof y === 'number') {
        if (Number.isNaN(x)) return 1;
        if (Number.isNaN(y)) return -1;
        return ascending ? x - y : y - x;
      }
      return ascending ? String(x).localeCompare(String(y)) : String(y).localeCompare(String(x));
    });
    body.append(...rows);
  });
});
document.querySelector('#category').addEventListener('change', event => {
  const chosen = event.target.value;
  document.querySelectorAll('[data-category]').forEach(el => {
    el.hidden = chosen !== '' && el.dataset.category !== chosen;
  });
});
}
`;

// The page is read from a clone or on northtalk.org, so repo links go to GitHub.
const repo = (path: string) =>
  `https://github.com/odogono/odgn-talk/blob/main/${path}`;

const payloadPanel = (p: Payload) => {
  const zig = zigPayload(p);
  const rows = payloadRows(p).map(
    ({ label, sizes }) =>
      `<tr><td>${esc(label)}</td>${sizeCell(sizes.brotli)}${sizeCell(sizes.gzip)}${sizeCell(sizes.raw)}</tr>`,
  );
  const ratio = (k: keyof Sizes) =>
    zig ? `<td>${(zig[k] / p.tsHost[k]).toFixed(1)}×</td>` : '';
  if (zig) {
    rows.push(
      `<tr><td>Zig ÷ TS Example Host</td>${ratio('brotli')}${ratio('gzip')}${ratio('raw')}</tr>`,
    );
  }
  return `
<h2 id="payload">Payload</h2>
<p>What a browser Host ships to embed each Core. The TS Core's figure is the core-switch Example Host, bundled${zig ? "; the Zig Core's is the same Host over <code>@northtalk/ts/wasm</code> plus the <code>talk.wasm</code> reactor it loads" : ''}.</p>
<div class="scroll"><table class="payload">
<thead><tr><th>Payload</th><th>Brotli</th><th>gzip -9</th><th>Raw</th></tr></thead>
<tbody>${rows.join('')}</tbody>
</table></div>
${zig ? payloadBars(p, zig) : ''}
<p>Bundled with <code>Bun.build({ target: 'browser', minify: true })</code>; compressed with <code>node:zlib</code> at Brotli quality 11 and gzip level 9, as in <a href="${repo('docs/research/zig-browser-figures.md')}">the #1121 browser figures</a>.</p>`;
};

// Each Core's Brotli Payload as one bar, the Zig Core's split into its Host and reactor.
const payloadBars = (p: Payload, zig: Sizes) => {
  const width = 600;
  const left = 70;
  const plot = width - left - 90;
  const scale = (n: number) => (n / zig.brotli) * plot;
  const host = scale(p.wasmHost!.brotli);
  const reactor = scale(p.talkWasm!.brotli);
  const ts = scale(p.tsHost.brotli);
  return `
<figure class="chart" style="max-width:${width}px;margin:16px 0">
<figcaption>Brotli Payload</figcaption>
<div class="legend"><span><span class="swatch core"></span>JS bundle</span><span><span class="swatch reactor"></span>talk.wasm</span></div>
<svg viewBox="0 0 ${width} 64" role="img" aria-label="Brotli Payload: TS Core ${kib(p.tsHost.brotli)}, Zig Core ${kib(zig.brotli)}">
<text x="0" y="20">TS Core</text>
<rect class="core" x="${left}" y="8" width="${ts.toFixed(1)}" height="16" rx="4"><title>TS Core: ${kib(p.tsHost.brotli)}</title></rect>
<text class="value" x="${(left + ts + 6).toFixed(1)}" y="20">${kib(p.tsHost.brotli)}</text>
<text x="0" y="48">Zig Core</text>
<rect class="core" x="${left}" y="36" width="${host.toFixed(1)}" height="16" rx="4"><title>@northtalk/ts/wasm Host: ${kib(p.wasmHost!.brotli)}</title></rect>
<rect class="reactor" x="${(left + host + 2).toFixed(1)}" y="36" width="${Math.max(reactor - 2, 0).toFixed(1)}" height="16" rx="4"><title>talk.wasm: ${kib(p.talkWasm!.brotli)}</title></rect>
<text class="value" x="${(left + host + reactor + 6).toFixed(1)}" y="48">${kib(zig.brotli)}</text>
</svg>
</figure>`;
};

const order = (a: Measurement, b: Measurement) =>
  a.benchmark.localeCompare(b.benchmark) ||
  isPeer(a) - isPeer(b) ||
  a.runner.localeCompare(b.runner);

const num = (n: number | undefined, text: string) =>
  `<td data-v="${n ?? ''}">${esc(text)}</td>`;

const table = (measurements: readonly Measurement[]) => {
  const rows = [...measurements].sort(order).map(m => {
    const perFuel = nsPerFuel(m);
    return `<tr data-category="${esc(category(m.benchmark))}"><td class="l">${esc(category(m.benchmark))}</td><td class="l">${esc(m.benchmark)}</td><td class="l">${esc(m.runner)}</td>${num(m.load?.medianNs, us(m.load?.medianNs))}${num(m.run.medianNs, ms(m.run.medianNs))}${num(m.run.minNs, ms(m.run.minNs))}${num(m.run.maxNs, m.run.maxNs === undefined ? '' : ms(m.run.maxNs))}${num(m.fuel, m.fuel === undefined ? '' : String(m.fuel))}${num(perFuel, perFuel?.toFixed(1) ?? '')}${num(m.logicalAlloc, bytes(m.logicalAlloc))}${num(m.hostBytes, bytes(m.hostBytes))}${num(m.hostAllocs, count(m.hostAllocs))}</tr>`;
  });
  return `
<div class="scroll"><table id="measurements">
<thead><tr><th class="l">Category</th><th class="l">Benchmark</th><th class="l">Runner</th><th>Load median (µs)</th><th>Run median (ms)</th><th>Run min (ms)</th><th>Run max (ms)</th><th>Fuel</th><th>ns/Fuel</th><th>Logical alloc</th><th>Host bytes</th><th>Host allocs</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table></div>`;
};

// One Benchmark's run median on each runner, with its min–max range as a whisker.
const chart = (benchmark: string, measurements: readonly Measurement[]) => {
  const rows = [...measurements].sort(order);
  const width = 360;
  const left = 96;
  const right = 64;
  const plot = width - left - right;
  const band = 20;
  const height = rows.length * band + 4;
  const top = Math.max(...rows.map(m => m.run.maxNs ?? m.run.medianNs));
  const x = (ns: number) => left + (top > 0 ? (ns / top) * plot : 0);
  const marks = rows.map((m, i) => {
    const y = i * band + 2;
    const kind = cores.includes(m.runner) ? 'core' : 'peer';
    const end = x(m.run.medianNs);
    const range =
      m.run.maxNs === undefined
        ? ''
        : `<line class="whisker" x1="${x(m.run.minNs).toFixed(1)}" x2="${x(m.run.maxNs).toFixed(1)}" y1="${y + band / 2 - 2}" y2="${y + band / 2 - 2}"/>`;
    const tip = `${m.runner}: median ${duration(m.run.medianNs)}, min ${duration(m.run.minNs)}${m.run.maxNs === undefined ? '' : `, max ${duration(m.run.maxNs)}`}, ${m.run.samples} samples`;
    return `<g><title>${esc(tip)}</title><rect class="hit" x="0" y="${y - 2}" width="${width}" height="${band}"/><text x="0" y="${y + band / 2 + 2}">${esc(m.runner)}</text><rect class="${kind}" x="${left}" y="${y + 2}" width="${Math.max(end - left, 1).toFixed(1)}" height="${band - 8}" rx="4"/>${range}<text class="value" x="${(Math.max(end, x(m.run.maxNs ?? 0)) + 6).toFixed(1)}" y="${y + band / 2 + 2}">${esc(duration(m.run.medianNs))}</text></g>`;
  });
  return `<figure class="chart" data-category="${esc(category(benchmark))}">
<figcaption>${esc(benchmark)}</figcaption>
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`${benchmark}: run median by runner`)}"><line class="baseline" x1="${left}" x2="${left}" y1="0" y2="${height}"/>${marks.join('')}</svg>
</figure>`;
};

const groupBy = <T>(items: readonly T[], key: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
};

const charts = (measurements: readonly Measurement[]) => {
  const byBenchmark = groupBy(measurements, m => m.benchmark);
  const byCategory = groupBy([...byBenchmark.keys()].sort(), category);
  return [...byCategory]
    .map(
      ([name, benchmarks]) =>
        `<h3 data-category="${esc(name)}">${esc(name || 'other')}</h3>
<div class="charts" data-category="${esc(name)}">${benchmarks.map(b => chart(b, byBenchmark.get(b) ?? [])).join('\n')}</div>`,
    )
    .join('\n');
};

const list = (items: string[], none: string) =>
  items.length
    ? `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`
    : `<p>${none}</p>`;

/** Where and when a run happened, as one line of HTML. */
export const provenance = (r: Results) =>
  `Commit <code>${esc(r.commit)}</code> on ${esc(r.machine.cpu)} (${esc(r.machine.cores)} cores, ${esc(r.machine.memory)}), ${esc(r.machine.os)} ${esc(r.machine.arch)}${r.machine.runUrl ? `, in <a href="${esc(r.machine.runUrl)}">a CI run</a>` : ''}.`;

/**
 * Everything on the page below its title, for this file's own page and for
 * northtalk.org/benchmarks/ (ADR 0173). The sections need `style` and `script`.
 */
export const sections = (r: Results): string => {
  const categories = [
    ...new Set(r.measurements.map(m => category(m.benchmark))),
  ].sort();
  const parity = r.parity.map(
    p =>
      `<span class="bad">${esc(p.benchmark)}</span>: ${Object.entries(p.fuel)
        .map(([k, v]) => `${esc(k)} ${esc(v)}`)
        .join(', ')}`,
  );
  const found = r.outliers.map(
    o =>
      `${esc(o.benchmark)} on ${esc(o.runner)}: ${o.nsPerFuel.toFixed(1)} ns/Fuel, ${o.factor.toFixed(1)}× the median`,
  );
  const skipped = r.skipped.map(
    s => `${esc(s.benchmark)} on ${esc(s.runner)}: ${esc(s.reason)}`,
  );
  return `<p>${provenance(r)}</p>
<p>Versions: ${entries(r.versions)}.</p>
<p>Settings: ${entries(r.settings)}.</p>
<p class="note">These timings are advisory. They come from one run on one machine, often a noisy shared runner, so they inform the Cost Model and find slow paths but are never a gate, a promise or a ranking (<a href="${repo('docs/adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md')}">ADR 0054</a>). Fuel is exact.</p>
<h2 id="fuel-parity">Fuel parity</h2>
${list(parity, 'Every Benchmark used the same Fuel on each Core.')}
${r.payload ? payloadPanel(r.payload) : ''}
<h2 id="outliers">Cost Model outliers</h2>
<p>Benchmarks whose ns/Fuel is more than ${esc(r.outlierFactor)}× their runner's median. These are advisory: any reweighting goes through the Spec.</p>
${list(found, 'None.')}
<h2 id="charts">Run median by runner</h2>
<div class="controls">
<label>Category <select id="category"><option value="">All</option>${categories.map(c => `<option value="${esc(c)}">${esc(c || 'other')}</option>`).join('')}</select></label>
</div>
<div class="legend"><span><span class="swatch core"></span>Core</span><span><span class="swatch peer"></span>Peer Language</span><span>Whisker: min to max over the samples</span></div>
${charts(r.measurements)}
<h2 id="table">Measurements</h2>
<p>Click a heading to sort.</p>
${table(r.measurements)}
${skipped.length ? `<h2 id="skipped">Skipped</h2>${list(skipped, '')}` : ''}`;
};

/** The whole run as one self-contained HTML file, for viewing offline. */
export const html = (r: Results): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmark results, ${esc(r.date)}</title>
<style>${style}</style>
</head>
<body class="bench">
<main>
<h1>Benchmark results, ${esc(r.date)}</h1>
${sections(r)}
</main>
<script>${script}</script>
</body>
</html>
`;
