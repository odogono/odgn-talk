import argparse
import os
import pathlib
import re
import statistics
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('output', type=pathlib.Path)
parser.add_argument('--repo', type=pathlib.Path, default=pathlib.Path.cwd())
parser.add_argument('--bin-dir', type=pathlib.Path, default=pathlib.Path(__file__).parent)
parser.add_argument('--rounds', type=int, default=8)
parser.add_argument('--procs', default='3')
parser.add_argument('--host-iterations', default='100x')
parser.add_argument('--backend-iterations', default='10000x')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
root = args.bin_dir.resolve()
env = dict(os.environ, GOMAXPROCS=args.procs, CGO_ENABLED='0', NORTHTALK_ZIG_CACHE_DIR=str(root / 'cache'))
backends = ['native', 'before', 'after']
samples = {backend: {} for backend in backends}
for backend in backends:
    (out / (backend + '.txt')).write_text('')
for round in range(args.rounds):
    start = round % len(backends)
    for backend in backends[start:] + backends[:start]:
        for area, pattern, iterations, cwd in [
            ('host', '^BenchmarkRun$/^host$/^(immediate|properties|conversion|pump)$', args.host_iterations, args.repo / 'bench/go'),
            ('backend', '^BenchmarkBackendRequest$', args.backend_iterations, args.repo / 'impl/go'),
            ('backend', '^BenchmarkBackend(Request|DeferredCall|MultiGroup)$/^(history=0|groups=16)$', args.backend_iterations, args.repo / 'impl/go'),
        ]:
            result = subprocess.run([str(root / (backend + '-' + area + '.test')), '-test.run=^$', '-test.bench=' + pattern, '-test.benchtime=' + iterations, '-test.count=1', '-test.benchmem'], cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
            with (out / (backend + '.txt')).open('a') as f:
                f.write(result.stdout)
            for line in result.stdout.splitlines():
                columns = line.split()
                if not columns or not columns[0].startswith('Benchmark'):
                    continue
                name = re.sub(r'-\d+$', '', columns[0])
                for i in range(2, len(columns) - 1, 2):
                    metric = columns[i + 1]
                    if metric in ['ns/op', 'B/op', 'allocs/op', 'req/s']:
                        samples[backend].setdefault((name, metric), []).append(float(columns[i]))
    print('round', round + 1, 'complete', flush=True)
report = []
assert samples['native'] and samples['native'].keys() == samples['before'].keys() == samples['after'].keys()
for (name, metric), native in samples['native'].items():
    before, after = samples['before'][name, metric], samples['after'][name, metric]
    assert len(native) == len(before) == len(after) == args.rounds
    line = f'{name} {metric}: native={statistics.median(native):.1f} before={statistics.median(before):.1f} after={statistics.median(after):.1f}'
    if all(n > 0 and b > 0 for n, b in zip(native, before)):
        ratios = [a / b for a, b in zip(after, before)]
        line += f'; after/before={statistics.median(ratios):.4f} [{min(ratios):.4f}, {max(ratios):.4f}]'
        line += f'; before/native={statistics.median(b / n for b, n in zip(before, native)):.3f}; after/native={statistics.median(a / n for a, n in zip(after, native)):.3f}'
    report.append(line)
text = '\n'.join(report) + '\n'
(out / 'paired.txt').write_text(text)
print(text)
