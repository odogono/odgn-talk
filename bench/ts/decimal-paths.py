"""Measure Decimal paths using the existing paired TS worker and driver.

Bundle bench/ts/src/character-indexing-worker.ts against each Core revision,
then pass the two standalone Bun bundles to this script. All other Core sources
and the harness must match; timing, heap probes and CPU profiling stay separate.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('before', type=Path)
parser.add_argument('after', type=Path)
parser.add_argument('--before-revision', required=True)
parser.add_argument('--pairs', type=int, default=3)
parser.add_argument('--filter', action='append', default=[])
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
manifest = json.loads((root / 'bench/scripts/benchmarks.json').read_text())['benchmarks']
controls = ('core/loop', 'core/fib', 'collections/list-build', 'macro/transform', 'lifecycle/restore', 'host/pump', 'text/index')
workloads = [{**b, 'source': (root / 'bench/scripts' / (b['name'] + '.talk')).read_text()}
             for b in manifest if b['name'].startswith('numbers/') or b['name'] in controls]

def probe(name, expression, expected, n=1000):
    workloads.append({'name': f'probe/{name}', 'n': n, 'expect': expected,
        'source': f'on run n\n  put 0 into selected\n  repeat for each i in 1..n\n    put {expression} into selected\n  end repeat\n  return selected\nend run\n'})

probe('terminating', 'i / 8', '125')
probe('nonterminating', 'i / 3', '333.' + '3' * 31)
probe('rounded-thirds', '1 / (i - i + 3)', '0.' + '3' * 34)
probe('signed-div', '-i div 16', '-62')
probe('signed-mod', '-i mod 16', '-8')
probe('cohort', '(i * 1.0000) / 8', '125.0000')
probe('precision-boundary', '9999999999999999999999999999999999 / (i - i + 2)', '5' + '0' * 33)
probe('long-terminating', '1 / (i - i + 281474976710656)', '0.000000000000003552713678800500929355621337890625')
probe('over-precision', '1 / (i - i + 562949953421312)', '0.000000000000001776356839400250464677810668945312')
tiny = lambda c: '0.' + '0' * (6176 - len(c)) + c
probe('subnormal', f'{tiny("3")} / (i - i + 2)', tiny('2'), n=100)
probe('underflow', f'{tiny("1")} / (i - i + 2)', tiny('0'), n=100)
for b in list(workloads):
    if b['name'] in ('probe/terminating', 'probe/signed-mod'):
        workloads.append({**b, 'name': b['name'].replace('probe/', 'probe/sliced-'), 'slice': 10})
cache = root / '.cache/ts-decimal'
cache.mkdir(parents=True, exist_ok=True)
fixture = cache / 'workloads.json'
fixture.write_text(json.dumps(workloads))
subprocess.run([sys.executable, str(root / 'bench/ts/character-indexing.py'),
    str(args.before), str(args.after), '--before-revision', args.before_revision,
    '--pairs', str(args.pairs), '--out', str(args.out), '--workloads', str(fixture),
    *[part for f in args.filter for part in ('--filter', f)]], check=True)
