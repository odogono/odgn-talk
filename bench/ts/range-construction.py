#!/usr/bin/env python3
"""Alternating TS #943 timings, followed by separate heap/GC and CPU probes.

Copy src/range-construction.ts into the baseline checkout first. Both checkouts
need bun install --frozen-lockfile. No other benchmarks should run concurrently.
"""
import argparse
import gzip
import hashlib
import json
import os
import time
import platform
import statistics
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('before', type=Path)
parser.add_argument('after', type=Path)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--before-revision', required=True)
args = parser.parse_args()
roots = {name: getattr(args, name).resolve() for name in ['before', 'after']}
probe = Path('bench/ts/src/range-construction.ts')
assert (roots['before'] / probe).read_bytes() == (roots['after'] / probe).read_bytes()
args.out.parent.mkdir(parents=True, exist_ok=True)
result = {
    'machine': platform.platform(),
    'beforeRevision': args.before_revision,
    'afterBaseRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=roots['after'], text=True).strip(),
    'probeSha256': hashlib.sha256((roots['after'] / probe).read_bytes()).hexdigest(),
    'settings': {'pairs': 3, 'warmupRuns': 20, 'samples': 9,
                 'sampleMs': 50, 'memoryRuns': 20, 'profileMs': 3000},
    'sourceSha256': {name: hashlib.sha256((root / 'impl/ts/src/machine.ts').read_bytes()).hexdigest()
                     for name, root in roots.items()},
    'pairs': [], 'memory': {}, 'profiles': {},
}

def save():
    args.out.write_text(json.dumps(result, indent=2) + '\n')

def run(name, mode, benchmark='', flags=()):
    print(f'{name}: {mode} {benchmark}', flush=True)
    started = {'unixTime': time.time(), 'loadAverage': os.getloadavg()}
    raw = subprocess.check_output(['bun', *flags, str(probe), mode, benchmark], cwd=roots[name])
    value = json.loads(raw)
    value['hostStart'] = started
    value['hostEnd'] = {'unixTime': time.time(), 'loadAverage': os.getloadavg()}
    return value

for pair in range(3):
    order = ['before', 'after'] if pair % 2 == 0 else ['after', 'before']
    values = {name: {'mode': 'timing', 'runtime': None, 'output': [], 'processes': []} for name in roots}
    for benchmark in ['core/calls', 'collections/list-update', 'collections/list-build',
                      'macro/transform', 'numbers/add', 'numbers/multiply',
                      'numbers/divide', 'numbers/quantity', 'core/fib',
                      'text/graphemes', 'lifecycle/restore']:
        for name in order:
            measured = run(name, 'timing', benchmark)
            values[name]['runtime'] = measured['runtime']
            values[name]['output'].extend(measured['output'])
            values[name]['processes'].append({k: v for k, v in measured.items() if k != 'output'})
    assert values['before']['runtime'] == values['after']['runtime']
    assert [(b['benchmark'], b['expected']) for b in values['before']['output']] == [
        (b['benchmark'], b['expected']) for b in values['after']['output']]
    result['pairs'].append({'order': order, **values})
    save()

# These operations never contribute to the timing samples above.
for name in roots:
    result['memory'][name] = run(name, 'memory')
    save()

profile_dir = args.out.resolve().parent / (args.out.stem + '-profiles')
profile_dir.mkdir(exist_ok=True)
for benchmark in ['core/calls', 'collections/list-update']:
    for name in roots:
        stem = f'{name}-{benchmark.replace("/", "-")}'
        filename = stem + '.cpuprofile'
        report = run(name, 'profile', benchmark, [
            '--cpu-prof', f'--cpu-prof-dir={profile_dir}', f'--cpu-prof-name={filename}'])
        raw_path = profile_dir / filename
        raw = raw_path.read_bytes()
        profile = json.loads(raw)
        nodes = {node['id']: node for node in profile['nodes']}
        parents = {child: node['id'] for node in profile['nodes'] for child in node.get('children', [])}
        categories = {'iteratorItem': {'iteratorItem'},
                      'numericConstruction': {'dec', 'canonicalNumber', 'numberValue', 'integerValue'},
                      'characterBoundaries': {'characterBoundaries'},
                      'gc': {'(garbage collector)', 'GC'}}
        counts = dict.fromkeys(categories, 0)
        for sample in profile['samples']:
            names = set()
            while sample in nodes:
                names.add(nodes[sample]['callFrame']['functionName'])
                sample = parents.get(sample)
            for category, functions in categories.items():
                counts[category] += bool(names & functions)
        gzip_path = raw_path.with_suffix('.cpuprofile.gz')
        with gzip.open(gzip_path, 'wb') as compressed:
            compressed.write(raw)
        raw_path.unlink()
        result['profiles'][stem] = {
            'report': report, 'samples': len(profile['samples']), 'inclusiveSamples': counts,
            'sha256': hashlib.sha256(raw).hexdigest(), 'file': gzip_path.name,
        }
        save()

for before in result['pairs'][0]['before']['output']:
    benchmark = before['benchmark']
    medians = {name: [statistics.median(next(b for b in pair[name]['output']
               if b['benchmark'] == benchmark)['runMs']) for pair in result['pairs']]
               for name in roots}
    change = (statistics.median(medians['after']) / statistics.median(medians['before']) - 1) * 100
    print(f'{benchmark}: {change:+.1f}% {medians}', flush=True)
