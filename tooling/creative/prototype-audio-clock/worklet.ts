// PROTOTYPE (#1888), throwaway. A ChipHost-style worklet (after odogono/mercenary
// web/src/sound/workletHost.ts): batches wait in a time-ordered queue and each
// render quantum is split so a command lands on its own sample. It plays a
// click and reports where each one landed.
declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, p: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

type Command = {
  at: number; // audio seconds
  extra?: Record<string, number>;
  id: number;
  ideal?: number; // musical time it should sound at, if it has one
  kind: string;
};

class ClickProcessor extends AudioWorkletProcessor {
  queue: (Command & { headroom: number })[] = [];
  env = 0;
  phase = 0;
  constructor() {
    super();
    this.port.onmessage = e => {
      if (e.data.port) {
        (e.data.port as MessagePort).onmessage = m => this.receive(m.data);
      } else if (e.data.clear) {
        this.queue = [];
      }
    };
  }
  receive(c: Command) {
    this.queue.push({ ...c, headroom: c.at - currentTime });
    this.queue.sort((a, b) => a.at - b.at);
  }
  process(_i: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]![0]!;
    let pos = 0;
    while (pos < out.length) {
      const c = this.queue[0];
      const at =
        c === undefined
          ? Infinity
          : Math.max(pos, Math.ceil((c.at - currentTime) * sampleRate));
      const next = Math.min(out.length, at);
      for (; pos < next; pos++) {
        out[pos] = Math.sin(this.phase) * this.env;
        this.phase += (2 * Math.PI * 1500) / sampleRate;
        this.env *= 0.995;
      }
      if (next === at && c) {
        this.queue.shift();
        this.env = 0.6;
        const frame = currentFrame + pos;
        this.port.postMessage({
          ...c,
          frame,
          late: frame / sampleRate - c.at > 1.5 / sampleRate,
          lateBy: frame / sampleRate - c.at,
          sampleRate,
        });
      }
    }
    return true;
  }
}
registerProcessor('proto-click', ClickProcessor);
