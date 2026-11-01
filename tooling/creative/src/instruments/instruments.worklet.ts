// The AudioWorklet module that plays a Play Session's Instruments (#1894).
// The page builds it with the session's Instruments and decoded sounds, then
// hands it a port on which the Play worker posts each InstrumentMessage.
import {
  INSTRUMENT_PROCESSOR,
  type InstrumentChannel,
  InstrumentRack,
  type NoteOnset,
  type RackSetup,
} from './rack';
import type { InstrumentMessage } from './session';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(
  name: string,
  processor: new (options: {
    processorOptions: { report?: boolean; setup: RackSetup };
  }) => unknown,
): void;
declare class AudioWorkletProcessor {
  readonly port: {
    onmessage: ((event: { data: InstrumentChannel }) => void) | null;
    postMessage(message: NoteOnset): void;
  };
}

class InstrumentProcessor extends AudioWorkletProcessor {
  readonly #rack: InstrumentRack;

  /** With `report`, posts each note's onset back, for tests. */
  constructor(options: {
    processorOptions: { report?: boolean; setup: RackSetup };
  }) {
    super();
    const { report, setup } = options.processorOptions;
    this.#rack = new InstrumentRack(
      setup,
      sampleRate,
      report ? onset => this.port.postMessage(onset) : undefined,
    );
    // The page hands over the channel the Play worker sends commands on.
    this.port.onmessage = ({ data }) => {
      data.port.onmessage = (event: MessageEvent<InstrumentMessage>) =>
        this.#rack.receive(event.data);
    };
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
