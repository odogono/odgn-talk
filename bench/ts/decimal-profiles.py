"""Collect separate Bun CPU samples for the paired Decimal workload bundles."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('before', type=Path)
parser.add_argument('after', type=Path)
parser.add_argument('--measurements', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
measurements = json.loads(args.measurements.read_text())
cache = root / '.cache/ts-decimal'
cache.mkdir(parents=True, exist_ok=True)
fixture = cache / 'profiles-workloads.json'
fixture.write_text(json.dumps(measurements['workloads']))
raw_dir = args.out.with_suffix('')
raw_dir.mkdir(parents=True, exist_ok=True)
result = {'recordedAt': datetime.now(timezone.utc).isoformat(),
    'runtime': subprocess.check_output(['bun', '--version'], text=True).strip(),
    'intervalMicroseconds': 1000, 'warmupRuns': 20, 'profileMs': 3000,
    'attribution': 'Inclusive sampled stacks; includes startup, Load, warm-up and validation. Categories overlap; JIT inlining limits attribution. Separate from timing.',
    'captures': []}
for workload in ('numbers/divide', 'numbers/quantity', 'text/index', 'probe/nonterminating'):
    for label, bundle in (('before', args.before), ('after', args.after)):
        bundle_sha = hashlib.sha256(bundle.read_bytes()).hexdigest()
        assert bundle_sha == measurements['bundleSha256'][label], 'bundle changed since timing'
        name = label + '-' + workload.replace('/', '-') + '.cpuprofile'
        command = ['bun', '--cpu-prof', '--cpu-prof-interval=1000',
            '--cpu-prof-dir=' + str(cache.resolve()), '--cpu-prof-name=' + name,
            str(bundle.resolve()), str(fixture), 'profile', workload]
        checked = json.loads(subprocess.check_output(command))
        assert len(checked) == 1
        expected = next(b['checked'] for b in measurements['timings'][0][label] if b['name'] == workload)
        assert checked[0]['checked'] == expected
        raw = (cache / name).read_bytes()
        profile = json.loads(raw)
        nodes = {n['id']: n for n in profile['nodes']}
        parents = {child: n['id'] for n in profile['nodes'] for child in n.get('children', [])}
        lines = bundle.read_text().splitlines()
        start = lines.index('// impl/ts/src/decimal.ts')
        end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith('// impl/ts/src/'))
        decimal_node = lambda n: start <= n['callFrame']['lineNumber'] < end and Path(n['callFrame'].get('url', '')).name == bundle.name
        counts = Counter()
        exclusive = Counter()
        for sample in profile['samples']:
            exclusive[nodes[sample]['callFrame']['functionName']] += 1
            stack = []
            while sample in nodes:
                stack.append(nodes[sample])
                if sample not in parents:
                    break
                sample = parents[sample]
            if any(decimal_node(n) for n in stack):
                counts['decimal'] += 1
            for category, names in [('rounding', ('result', 'roundAt')), ('exactQuotient', ('exactQuotient',)), ('integer', ('div', 'mod'))]:
                if any(decimal_node(n) and n['callFrame']['functionName'] in names for n in stack):
                    counts[category] += 1
        destination = raw_dir / (name + '.gz')
        destination.write_bytes(gzip.compress(raw, mtime=0))
        result['captures'].append({'workload': workload, 'label': label,
            'command': command, 'checked': checked, 'bundleSha256': bundle_sha,
            'raw': str(destination.relative_to(root) if destination.is_absolute() else destination),
            'samples': len(profile['samples']), 'inclusive': dict(counts),
            'decimalBundledLinesZeroBased': [start, end], 'exclusiveTop': exclusive.most_common(20)})
        args.out.write_text(json.dumps(result, indent=2) + '\n')
        print(label, workload, counts, flush=True)
