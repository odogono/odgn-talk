"""Interleaved A/B for #1311: python3 measure.py REPO OUT ROUNDS BIN_DIR.

BIN_DIR holds native-, before- and after-{host,backend}.test, built with
`go test -c` (before and after with -tags talk_zig_experimental) from
bench/go and impl/go. `json` runs the after binaries with TALK_ZIG_CALLBACKS=.
"""
import os, re, statistics, subprocess, sys, pathlib
B = pathlib.Path(sys.argv[4]); R = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2]); rounds = int(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
base = dict(os.environ, GOMAXPROCS='3', CGO_ENABLED='0', NORTHTALK_ZIG_CACHE_DIR=str(B / 'cache'))
backends = {'native': ('native', {}), 'before': ('before', {}), 'json': ('after', {'TALK_ZIG_CALLBACKS': ''}), 'after': ('after', {})}
samples = {k: {} for k in backends}
for k in backends: (out / (k + '.txt')).write_text('')
names = list(backends)
for rnd in range(rounds):
    s = rnd % len(names)
    for k in names[s:] + names[:s]:
        binary, extra = backends[k]
        for area, pattern, it, cwd in [
            ('host', '^BenchmarkRun$/^host$/^(immediate|properties|conversion|pump)$', '100x', R / 'bench/go'),
            ('backend', '^BenchmarkBackend(Request|DeferredCall)$/^(history=0)?$', '10000x', R / 'impl/go'),
        ]:
            res = subprocess.run([str(B / f'{binary}-{area}.test'), '-test.run=^$', '-test.bench=' + pattern, '-test.benchtime=' + it, '-test.count=1', '-test.benchmem'], cwd=cwd, env=dict(base, **extra), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
            with (out / (k + '.txt')).open('a') as f: f.write(res.stdout)
            for line in res.stdout.splitlines():
                c = line.split()
                if not c or not c[0].startswith('Benchmark'): continue
                name = re.sub(r'-\d+$', '', c[0])
                for i in range(2, len(c) - 1, 2):
                    if c[i + 1] in ('ns/op', 'B/op', 'allocs/op'):
                        samples[k].setdefault((name, c[i + 1]), []).append(float(c[i]))
    print('round', rnd + 1, flush=True)
lines = []
for key, nat in samples['native'].items():
    b, j, a = samples['before'][key], samples['json'][key], samples['after'][key]
    med = statistics.median
    r = [x / y for x, y in zip(a, b)]; rj = [x / y for x, y in zip(j, b)]
    lines.append(f"{key[0]} {key[1]}: native={med(nat):.0f} before={med(b):.0f} json={med(j):.0f} after={med(a):.0f}; after/before={med(r):.3f} [{min(r):.3f}, {max(r):.3f}]; json/before={med(rj):.3f}; before/native={med(x/y for x,y in zip(b,nat)):.2f}; after/native={med(x/y for x,y in zip(a,nat)):.2f}")
(out / 'paired.txt').write_text('\n'.join(lines) + '\n'); print('\n'.join(lines))
