#!/usr/bin/env python3
"""Alternate isolated TS timing processes; collect profiles/heap separately."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('before', type=Path)
parser.add_argument('--before-revision', required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
before = args.before.resolve()
harness = Path('bench/ts/src/measure-unit-paths.ts')
if (before / harness).read_bytes() != (root / harness).read_bytes():
    raise SystemExit('Copy the unchanged measurement harness into the baseline first')
result = {
    'platform': platform.platform(),
    'cpu': subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip(),
    'before': args.before_revision,
    'coreDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--', 'impl/ts/src'], cwd=root)).hexdigest(),
    'harnessSha256': hashlib.sha256((root / harness).read_bytes()).hexdigest(),
    'pairs': [], 'heap': [], 'profiles': [], 'contendedTrials': [],
}
args.out.parent.mkdir(parents=True, exist_ok=True)

def save():
    args.out.write_text(json.dumps(result, indent=2) + '\n')

def host_cpu(exclude_pid=0):
    snapshot = subprocess.Popen(['ps', '-Ao', 'pid=,pcpu='], stdout=subprocess.PIPE, text=True)
    cpu = snapshot.communicate()[0]
    rows = [line.split() for line in cpu.splitlines()]
    excluded = {exclude_pid, snapshot.pid, os.getpid()}
    return sum(float(percent) for pid, percent in rows if int(pid) not in excluded)

def contended(samples):
    # Brief app activity and process-start accounting spikes are ordinary
    # host noise; reject sustained competing CPU jobs, retaining all samples.
    return any(all(value > 120 for value in samples[i:i+3])
               for i in range(len(samples)-2))

def run(label, mode, extra=()):
    cwd = before if label == 'before' else root
    command = ['bun', *extra, str(harness), mode]
    print(f'{label} {mode}', flush=True)
    load_before = os.getloadavg()
    cpu_samples = []
    external_cpu_samples = []
    with tempfile.TemporaryFile(mode='w+') as stdout:
        process = subprocess.Popen(command, cwd=cwd, stdout=stdout)
        while process.poll() is None:
            cpu_samples.append(host_cpu())
            external_cpu_samples.append(host_cpu(process.pid))
            time.sleep(1)
        if process.returncode != 0:
            raise SystemExit(f'{label} {mode} failed: {process.returncode}')
        stdout.seek(0)
        output = stdout.read()
    return {'label': label, 'command': command,
            'aggregateCpuSamples': cpu_samples,
            'externalCpuSamples': external_cpu_samples,
            'loadAverageBefore': load_before, 'loadAverageAfter': os.getloadavg(),
            **json.loads(output)}

def wait_for_quiet():
    # Never stop other worktrees' jobs. Bound the wait and record host load.
    consecutive = 0
    for attempt in range(60):
        busy = host_cpu()
        if busy < 80:
            consecutive += 1
            if consecutive == 3:
                return
        else:
            consecutive = 0
        print(f'Host CPU {busy:.0f}%; quiet checks {consecutive}/3; waiting 5s', flush=True)
        time.sleep(5)
    raise SystemExit('Host remained busy; rerun when other CPU jobs finish')

attempt = 0
while len(result['pairs']) < 3:
    attempt += 1
    if attempt > 6:
        raise SystemExit('Repeated timing contention; retry later')
    wait_for_quiet()
    order = ['before', 'after'] if len(result['pairs']) % 2 == 0 else ['after', 'before']
    runs = [run(label, 'timing') for label in order]
    if any(contended(r['externalCpuSamples']) for r in runs):
        result['contendedTrials'].append(runs)
        print('Discarding pair: external CPU exceeded 120% for 3 samples', flush=True)
        save()
        continue
    reference = {row['name']: {k: row[k] for k in ['alloc', 'fuel', 'outcome', 'result']}
                 for row in runs[0]['output']}
    for row in runs[1]['output']:
        if {k: row[k] for k in ['alloc', 'fuel', 'outcome', 'result']} != reference[row['name']]:
            raise SystemExit(f"Changed output or accounting: {row['name']}")
    result['pairs'].append(runs)
    save()
semantic = [subprocess.check_output(['bun', 'bench/ts/src/check-unit-paths.ts'], cwd=cwd)
            for cwd in [before, root]]
if semantic[0] != semantic[1]:
    raise SystemExit('Changed lifecycle semantics or canonical saved state')
result['semantics'] = json.loads(semantic[0])
save()
for label in ['before', 'after']:
    result['heap'].append(run(label, 'heap'))
    save()
    directory = args.out.parent.resolve() / (args.out.stem + '-profiles')
    directory.mkdir(exist_ok=True)
    result['profiles'].append(run(label, 'profile', [
        '--cpu-prof', f'--cpu-prof-dir={directory}', f'--cpu-prof-name={label}.cpuprofile']))
    save()
print(args.out, flush=True)
