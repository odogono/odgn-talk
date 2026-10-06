// The Peer Language runners on Bun: Lua through wasmoon, JavaScript through
// QuickJS, and native TS as the ceiling for the TS Core. Each runs the ports
// in bench/peers/<language>/; bench/README.md describes them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
import { LuaFactory } from 'wasmoon';
import { type Benchmark, scriptsDir, sizeOf } from './suite';

export const peersDir = join(scriptsDir, '..', 'peers');

/** A Benchmark's port, loaded and ready to Run. It returns what `run n` returns. */
export type Port = (n: number) => unknown;

/** A Peer Language runner on Bun. */
export type Peer = {
  /** Starts the interpreter and compiles the port, so neither is part of a Run. */
  load: (b: Benchmark) => Promise<Port>;
  name: string;
};

const portSource = (language: string, b: Benchmark, extension: string) =>
  readFileSync(join(peersDir, language, `${b.name}${extension}`), 'utf8');

export const peers: readonly Peer[] = [
  {
    load: async b => {
      const vm = (await getQuickJS()).newContext();
      vm.unwrapResult(vm.evalCode(portSource('js', b, '.js'))).dispose();
      const run = vm.getProp(vm.global, 'run');
      return n => {
        const argument = vm.newNumber(n);
        const result = vm.unwrapResult(
          vm.callFunction(run, vm.undefined, argument),
        );
        argument.dispose();
        const value: unknown = vm.dump(result);
        result.dispose();
        return value;
      };
    },
    name: 'quickjs',
  },
  {
    load: async b => {
      const module = (await import(join(peersDir, 'ts', `${b.name}.ts`))) as {
        run: Port;
      };
      return module.run;
    },
    name: 'ts-native',
  },
  {
    load: async b => {
      const lua = await new LuaFactory().createEngine();
      lua.doStringSync(portSource('lua', b, '.lua'));
      const run: unknown = lua.global.get('run');
      if (typeof run !== 'function') {
        throw new TypeError(`${b.name}: the Lua port defines no run`);
      }
      return run as Port;
    },
    name: 'wasmoon',
  },
];

/** Load a Benchmark's port and confirm one Run produces the Script's expected output. */
export const loadPeer = async (
  peer: Peer,
  b: Benchmark,
  smoke: boolean,
): Promise<Port> => {
  const port = await peer.load(b);
  const size = sizeOf(b, smoke);
  const output = String(port(size.n));
  if (output !== size.expect) {
    throw new Error(
      `${b.name} on ${peer.name}: output ${output}, expected ${size.expect}`,
    );
  }
  return port;
};
