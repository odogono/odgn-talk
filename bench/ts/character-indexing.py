"""Alternate bundled TS revisions; time Runs separately from heap/CPU probes.

Before editing the Core, bundle character-indexing-worker.ts with --target=bun
into before.js. Bundle the same worker after editing into after.js. No runtime
imports from either checkout are used by these bundles.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('before', type=Path)
parser.add_argument('after', type=Path)
parser.add_argument('--before-revision', required=True)
parser.add_argument('--pairs', type=int, default=3)
parser.add_argument('--filter', action='append')
parser.add_argument('--workloads', type=Path, help='Use a JSON workload array instead of the chunk-read suite')
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
if args.pairs < 1:
    parser.error('pairs must be positive')
root = Path(__file__).resolve().parents[2]
workloads = []
manifest = json.loads((root / 'bench/scripts/benchmarks.json').read_text())['benchmarks']
for b in manifest:
    if b['name'].startswith('text/') or b['name'] in ('core/loop', 'core/fib', 'collections/list-build', 'macro/report', 'macro/transform', 'lifecycle/restore', 'host/pump'):
        workloads.append({**b, 'source': (root / 'bench/scripts' / (b['name'] + '.talk')).read_text()})
for size in (16, 256, 4096):
    for label, index in (('early', 8), ('late', size), ('last', -1)):
        workloads.append({'name': f'probe/ascii-{size}-{label}', 'n': 1000, 'expect': '"x"',
            'source': f'on run n\n  put "" into selected\n  repeat n times\n    put character {index} of "' + 'x' * size + '" into selected\n  end repeat\n  return selected\nend run\n'})
for kind, source, index, expected in (
    ('character', 'éq́👨‍👩‍👧🇬🇧', 3, '👨‍👩‍👧'),
    ('word', 'é q́ 👨‍👩‍👧 🇬🇧', 3, '👨‍👩‍👧'),
    ('line', 'é\r\nq́\r\n👨‍👩‍👧\r\n🇬🇧', 3, '👨‍👩‍👧'),
    ('item', 'é,q́,👨‍👩‍👧,🇬🇧', 3, '👨‍👩‍👧'),
    ('code point', 'éq́👨‍👩‍👧🇬🇧', 4, '👨'),
):
    # Language literals spell embedded CR/LF using concatenation.
    literal = source.replace('\r', '" & fromCodePoint(13) & "').replace('\n', '" & newline & "')
    workloads.append({'name': f'probe/unicode-{kind}', 'n': 1000, 'expect': f'"{expected}"',
        'source': f'on run n\n  put "{literal}" into source\n  put "" into selected\n  repeat n times\n    put {kind} {index} of source into selected\n  end repeat\n  return selected\nend run\n'})
if args.workloads:
    workloads = json.loads(args.workloads.read_text())
if args.filter:
    workloads = [b for b in workloads if any(f in b['name'] for f in args.filter)]
    if not workloads:
        parser.error('filter selects no workloads')
cache = root / '.cache/ts-paired'
cache.mkdir(parents=True, exist_ok=True)
fixture = cache / 'workloads.json'
fixture.write_text(json.dumps(workloads, ensure_ascii=False))
sha = lambda b: hashlib.sha256(b).hexdigest()
result = {'recordedAt': datetime.now(timezone.utc).isoformat(), 'baselineRevision': args.before_revision,
    'checkoutRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'platform': platform.platform(), 'cpu': subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip() if platform.system() == 'Darwin' else platform.processor(),
    'bun': subprocess.check_output(['bun', '--version'], text=True).strip(), 'pairs': args.pairs,
    'settings': {'warmupRuns': 5, 'samples': 5, 'minimumSampleMs': 50, 'heapProbeRuns': 20, 'profileMs': 3000},
    'bundleSha256': {label: sha(bundle.read_bytes()) for label, bundle in [('before', args.before), ('after', args.after)]},
    'sourceSha256': {p: sha((root / p).read_bytes()) for p in ['impl/ts/src/operations.ts', 'impl/ts/src/decimal.ts', 'bench/ts/src/character-indexing-worker.ts']},
    'workloads': [{**b, 'sourceSha256': sha(b['source'].encode())} for b in workloads], 'timings': [], 'heap': {}}
args.out.parent.mkdir(parents=True, exist_ok=True)
def save():
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
for bundle in (args.before, args.after):
    subprocess.check_output(['bun', str(bundle.resolve()), str(fixture), 'validate'])
for pair in range(args.pairs):
    bundles = [('before', args.before), ('after', args.after)]
    if pair % 2:
        bundles.reverse()
    measured = {'before': [], 'after': []}
    for workload in workloads:
        print(f"pair {pair + 1}: {workload['name']}", flush=True)
        for label, bundle in bundles:
            sample = json.loads(subprocess.check_output(['bun', str(bundle.resolve()), str(fixture), 'timing', workload['name']]))
            assert len(sample) == 1, workload['name']
            measured[label].extend(sample)
        before, after = measured['before'][-1], measured['after'][-1]
        assert before['name'] == after['name']
        assert before['checked'] == after['checked'], (before, after)
        print(f"  {before['name']}: {statistics.median(x['ns'] for x in before['run']) / 1e6:.3f} -> {statistics.median(x['ns'] for x in after['run']) / 1e6:.3f} ms", flush=True)
    result['timings'].append({'pair': pair + 1, 'order': [label for label, _ in bundles], **measured})
    save()
for label, bundle in [('before', args.before), ('after', args.after)]:
    result['heap'][label] = json.loads(subprocess.check_output(['bun', str(bundle.resolve()), str(fixture), 'heap']))
    save()
for before, after in zip(result['heap']['before'], result['heap']['after'], strict=True):
    assert before['checked'] == after['checked']
    assert before['checked'] == next(x['checked'] for x in result['timings'][0]['before'] if x['name'] == before['name'])

# Retain the relevant heap/allocator counters without hundreds of repetitive
# allocator bin tables. These snapshots are evidence, not timed measurements.
for probes in result['heap'].values():
    for probe in probes:
        for phase in ('before', 'uncollected', 'collected'):
            heap = probe[phase]['heap']
            summary = {key: heap[key] for key in ('heapSize', 'heapCapacity', 'extraMemorySize', 'objectCount')}
            summary['objectTypeCounts'] = {key: heap['objectTypeCounts'].get(key, 0) for key in ('Array', 'string', 'Object', 'BigInt')}
            if 'mimalloc' in heap:
                summary['mimalloc'] = {key: heap['mimalloc'][key] for key in ('malloc_requested', 'malloc_normal_count', 'malloc_huge_count')}
            probe[phase]['heap'] = summary
result['heapSnapshotFields'] = 'JSC sizes, object counts, selected object types and aggregate mimalloc request counters'
save()
