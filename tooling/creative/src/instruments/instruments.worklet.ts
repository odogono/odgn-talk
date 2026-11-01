// The AudioWorklet module that plays a Play Session's Instruments (#1894).
// The page builds it with the session's Instruments and decoded sounds, then
// posts each InstrumentMessage the Play worker sends.
import { INSTRUMENT_PROCESSOR, InstrumentRack, type RackSetup } from './rack';
import type { InstrumentMessage } from './session';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(
  name: string,
  processor: new (options: {
    processorOptions: { setup: RackSetup };
  }) => unknown,
): void;
declare class AudioWorkletProcessor {
  readonly port: {
    onmessage: ((event: { data: InstrumentMessage }) => void) | null;
  };
}

class InstrumentProcessor extends AudioWorkletProcessor {
  readonly #rack: InstrumentRack;

  constructor(options: { processorOptions: { setup: RackSetup } }) {
    super();
    this.#rack = new InstrumentRack(options.processorOptions.setup, sampleRate);
    this.port.onmessage = event => this.#rack.receive(event.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? [];
    if (left && right) {
      this.#rack.process(left, right, currentTime);
    }
    return true;
  }
}

registerProcessor(INSTRUMENT_PROCESSOR, InstrumentProcessor);
