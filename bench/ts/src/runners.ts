// Public --only names are the report's runner names; `peers` expands to all
// Peer Languages. Host groups select which measurement processes to start.
export const coreRunners = ['go', 'ts', 'zig'];
export const bunPeers = ['quickjs', 'ts-native', 'wasmoon'];
export const goPeers = ['go-native', 'gopher-lua', 'starlark-go'];
export const peerRunners = [...bunPeers, ...goPeers, 'cpython', 'applescript'];

/** Select a comma-separated set, preserving order and removing duplicates. */
export const selectRunners = (only?: string): string[] => {
  const names =
    only === undefined ? [...coreRunners, 'peers'] : only.split(',');
  const selected: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === 'peers') {
      selected.push(...peerRunners);
    } else if ([...coreRunners, ...peerRunners].includes(name)) {
      selected.push(name);
    } else {
      throw new Error(
        `--only takes comma-separated runner names: ${[...coreRunners, 'peers', ...peerRunners].join(', ')}; got ${JSON.stringify(name)}`,
      );
    }
  }
  return [...new Set(selected)];
};
