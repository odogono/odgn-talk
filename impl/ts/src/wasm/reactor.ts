// One instance of the Zig Core's `wasm32-wasi` reactor, with the two WASI
// imports it uses, and the Message Layer's framing over WASI: the Host writes
// a frame into the buffer `talk_buffer(n)` gives, and `talk_send(n)` returns
// the reply as `ptr << 32 | len` (chapter 9, The message layer).

type Exports = {
  _initialize(): void;
  memory: WebAssembly.Memory;
  talk_buffer(n: number): number;
  talk_send(n: number): bigint;
};

const EBADF = 8;
const ENOSYS = 52;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Text the reactor writes to stdout or stderr, such as a fatal error. */
export type Diagnostics = (line: string) => void;

/**
 * The WASI imports `talk.wasm` takes. The Core reads no clock, file or
 * environment of its own: its Clock comes with each Pump. The safe build's
 * panic handler links the rest of WASI, so each import the module names gets
 * a function, and those it never needs refuse with ENOSYS. `fd_read` is for
 * the inline transport, which this Host doesn't negotiate, so every read
 * finds the end of its input.
 */
const wasi = (
  module: WebAssembly.Module,
  memory: () => WebAssembly.Memory,
  diagnostics: Diagnostics,
) => {
  let pending = '';
  const stream = new TextDecoder();
  const view = () => new DataView(memory().buffer);
  const implemented: Record<string, (...args: never[]) => number> = {
    fd_write(fd: number, iovs: number, count: number, written: number) {
      if (fd !== 1 && fd !== 2) {
        return EBADF;
      }
      const v = view();
      let total = 0;
      for (let i = 0; i < count; i++) {
        const base = v.getUint32(iovs + i * 8, true);
        const length = v.getUint32(iovs + i * 8 + 4, true);
        pending += stream.decode(
          new Uint8Array(memory().buffer, base, length),
          { stream: true },
        );
        total += length;
      }
      let line;
      while ((line = pending.indexOf('\n')) >= 0) {
        diagnostics(pending.slice(0, line));
        pending = pending.slice(line + 1);
      }
      v.setUint32(written, total, true);
      return 0;
    },
    fd_read(fd: number, _iovs: number, _count: number, read: number) {
      if (fd !== 0) {
        return EBADF;
      }
      view().setUint32(read, 0, true);
      return 0;
    },
    random_get(at: number, length: number) {
      // getRandomValues fills at most 65536 bytes a call.
      for (let i = 0; i < length; i += 65_536) {
        crypto.getRandomValues(
          new Uint8Array(memory().buffer, at + i, Math.min(65_536, length - i)),
        );
      }
      return 0;
    },
    clock_time_get(_id: number, _precision: bigint, at: number) {
      const ns = BigInt(
        Math.round((performance.timeOrigin + performance.now()) * 1e6),
      );
      view().setBigUint64(at, ns, true);
      return 0;
    },
    clock_res_get(_id: number, at: number) {
      view().setBigUint64(at, 1000n, true);
      return 0;
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get: () => 0,
  };
  return Object.fromEntries(
    WebAssembly.Module.imports(module)
      .filter(
        i => i.module === 'wasi_snapshot_preview1' && i.kind === 'function',
      )
      .map(i => [i.name, implemented[i.name] ?? (() => ENOSYS)]),
  );
};

/** Thrown when the instance traps or replies with something unreadable: it is lost. */
export class InstanceLostError extends Error {
  override name = 'InstanceLostError';
}

/** A frame the reactor won't take, past its 64 MiB limit or its memory. */
export class FrameRefusedError extends Error {
  override name = 'FrameRefusedError';
  constructor(readonly bytes: number) {
    super(`talk.wasm refused a frame of ${bytes} bytes`);
  }
}

export class Reactor {
  readonly #exports: Exports;
  #lost: InstanceLostError | null = null;

  /** Synchronous: the module is compiled once, by createCore. */
  constructor(module: WebAssembly.Module, diagnostics: Diagnostics) {
    const instance: WebAssembly.Instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: wasi(module, () => exports.memory, diagnostics),
    });
    const exports = instance.exports as unknown as Exports;
    this.#exports = exports;
    this.#guard(() => exports._initialize());
  }

  /** One frame of JSON in, its reply out. */
  frame(json: string): string {
    const e = this.#exports;
    const bytes = encoder.encode(json);
    const pointer = this.#guard(() => e.talk_buffer(bytes.length));
    // The guest never saw the frame, so the instance carries on.
    if (pointer === 0) {
      throw new FrameRefusedError(bytes.length);
    }
    return this.#guard(() => {
      new Uint8Array(e.memory.buffer, pointer, bytes.length).set(bytes);
      const packed = BigInt.asUintN(64, e.talk_send(bytes.length));
      const at = Number(packed >> 32n);
      const length = Number(packed & 0xff_ff_ff_ffn);
      return decoder.decode(new Uint8Array(e.memory.buffer, at, length));
    });
  }

  /** The instance's linear memory, in bytes. */
  memoryBytes(): number {
    return this.#exports.memory.buffer.byteLength;
  }

  // A trap leaves the guest mid-call, so nothing more is sent to it.
  #guard<T>(f: () => T): T {
    if (this.#lost) {
      throw this.#lost;
    }
    try {
      return f();
    } catch (error) {
      this.#lost =
        error instanceof InstanceLostError
          ? error
          : new InstanceLostError(
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
      throw this.#lost;
    }
  }
}
