// The AudioWorklet module that plays a Play Session's Instruments (#1894).
// The page builds it with the session's Instruments and decoded sounds, then
// hands it a port on which the Play worker posts each InstrumentMessage.
import {
  INSTRUMENT_PROCESSOR,
  type InstrumentChannel,
  InstrumentRack,
  LEVEL_INTERVAL,
  type LevelReport,
  type NoteOnset,
  type RackSetup,
} from './rack';
import type { InstrumentMessage } from './session';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(
  name: string,
  processor: new (options: {
    processorOptions: {
      levels?: boolean;
      report?: boolean;
      setup: RackSetup;
    };
  }) => unknown,
): void;
declare class AudioWorkletProcessor {
  readonly port: {
    onmessage: ((event: { data: InstrumentChannel }) => void) | null;
    postMessage(message: LevelReport | NoteOnset): void;
  };
}

class InstrumentProcessor extends AudioWorkletProcessor {
  readonly #rack: InstrumentRack;
  /** Whether meters show the output, and when they last heard (#1904). */
  readonly #levels: boolean;
  #reported = 0;

  /**
   * With `report`, posts each note's onset back, for tests; with `levels`,
   * each Instrument's output level for meters.
   */
  constructor(options: {
    processorOptions: { levels?: boolean; report?: boolean; setup: RackSetup };
  }) {
    super();
    const { levels, report, setup } = options.processorOptions;
    this.#levels = levels === true;
    this.#rack = new InstrumentRack(
      setup,
      sampleRate,
      report ? onset => this.port.postMessage(onset) : undefined,
    );
    // The page hands over the channel the Play worker sends commands on,
    // and then sounds it decoded after start-up (#1958).
    this.port.onmessage = ({ data }) => {
      if ('sample' in data) {
        this.#rack.addSample(data.name, data.sample);
        return;
      }
      if ('message' in data) {
        this.#rack.receive(data.message);
        return;
      }
      data.port.onmessage = (event: MessageEvent<InstrumentMessage>) =>
        this.#rack.receive(event.data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? [];
    if (left && right) {
      this.#rack.process(left, right, currentTime);
    }
    if (this.#levels && currentTime - this.#reported >= LEVEL_INTERVAL) {
      this.#reported = currentTime;
      this.port.postMessage({ levels: this.#rack.levels() });
    }
    return true;
  }
}

registerProcessor(INSTRUMENT_PROCESSOR, InstrumentProcessor);
