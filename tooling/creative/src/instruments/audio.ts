// The page's side of a Play Session's Instruments (#1894): an AudioContext
// running the Instrument worklet, built from the session's Project. The
// Play worker has no audio, so it sends each InstrumentMessage, timed on
// this context's clock, straight to the worklet over a port this hands it,
// and its Play clock follows the readings this sends it (ADR 0156). The
// built-in kits (#1895) are fetched from the app, which the service worker
// keeps for offline use, and a sampler for the default kit always plays.
import type { AudioReading } from '../audio-clock';
import type { Asset, Project } from '../model';
import type { DeepReadonly } from '../readonly';
import { DEFAULT_KIT_INSTRUMENT, KIT_FILES } from '../kits/kits';
import { isSoundAsset } from '../sounds';
import type { SampleBuffer } from './kind';
import { samplerEngine } from './sampler';
import {
  INSTRUMENT_PROCESSOR,
  type InstrumentChannel,
  type NoteOnset,
  type RackSetup,
} from './rack';

const WORKLET_URL = './instruments.worklet.js';

/** How often the Play worker hears the audio clock while it runs. */
const READING_MS = 250;

/** A built-in kit's sound, from the app (offline, from the service worker). */
const kitBytes = async (path: string): Promise<ArrayBuffer> => {
  const response = await fetch(`./${path}`);
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}`);
  }
  return response.arrayBuffer();
};

export type InstrumentAudio = {
  /** Stops the audio for good. */
  close(): void;
  /**
   * Hands the worklet the port its InstrumentMessages arrive on. Messages
   * posted before the worklet is ready wait in the port.
   */
  listen(port: MessagePort): void;
  /** The audio clock now, paired with the absolute time. */
  reading(): AudioReading;
  /** Suspends or resumes the audio, as the Play Session pauses. */
  setPaused(paused: boolean): void;
};

export type InstrumentAudioOptions = {
  onError(message: string): void;
  /** Each note as it starts, for tests. */
  onNote?(onset: NoteOnset): void;
  /** A fresh audio-clock reading for the Play worker. */
  onReading(reading: AudioReading): void;
};

/**
 * Starts the Instruments' audio. A sound that fails to decode is left out of the samplers and
 * reported through `onError`, as is a failure to start at all.
 */
export const startInstrumentAudio = (
  project: DeepReadonly<Project>,
  soundBytes: (asset: DeepReadonly<Asset>) => Promise<ArrayBuffer>,
  { onError, onNote, onReading }: InstrumentAudioOptions,
): InstrumentAudio => {
  const context = new AudioContext({ latencyHint: 'interactive' });
  let node: AudioWorkletNode | undefined;
  let listening: MessagePort | undefined;
  const handOver = () => {
    if (node && listening) {
      node.port.postMessage({ port: listening } satisfies InstrumentChannel, [
        listening,
      ]);
      listening = undefined;
    }
  };
  let closed = false;
  let paused = false;
  const reading = (): AudioReading => ({
    audio: context.currentTime,
    epoch: performance.timeOrigin + performance.now(),
    running: context.state === 'running',
  });
  const timer = setInterval(() => {
    if (!paused && context.state === 'running') {
      onReading(reading());
    }
  }, READING_MS);
  // The clock starts with the audio; the worker hears it at once.
  context.addEventListener('statechange', () => {
    if (!closed && context.state === 'running') {
      onReading(reading());
    }
  });

  const decode = async (
    name: string,
    bytes: () => Promise<ArrayBuffer>,
  ): Promise<[string, SampleBuffer] | undefined> => {
    try {
      const audio = await context.decodeAudioData(await bytes());
      const channels = Array.from(
        { length: Math.min(2, audio.numberOfChannels) },
        (_, i) => audio.getChannelData(i),
      );
      return [name, { channels, sampleRate: audio.sampleRate }];
    } catch (error) {
      onError(
        `Sound “${name}” could not be decoded for the sampler: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  void (async () => {
    try {
      // Kits come first, so a Project sound with a kit sample's name wins.
      const decoding = Promise.all([
        ...KIT_FILES.map(file => decode(file.key, () => kitBytes(file.path))),
        ...project.assets
          .filter(isSoundAsset)
          .map(asset => decode(asset.name, () => soundBytes(asset))),
      ]);
      const [samples] = await Promise.all([
        decoding,
        context.audioWorklet.addModule(WORKLET_URL),
      ]);
      if (closed) {
        return;
      }
      const setup: RackSetup = {
        instruments: [
          ...project.instruments.map(({ kind, name, parameters, voices }) => ({
            kind,
            name,
            parameters: { ...parameters },
            voices,
          })),
          {
            kind: samplerEngine.name,
            name: DEFAULT_KIT_INSTRUMENT,
            parameters: {},
            voices: samplerEngine.voices,
          },
        ],
        samples: samples.filter(
          (entry): entry is [string, SampleBuffer] => entry !== undefined,
        ),
      };
      node = new AudioWorkletNode(context, INSTRUMENT_PROCESSOR, {
        numberOfInputs: 0,
        outputChannelCount: [2],
        processorOptions: { setup, report: onNote !== undefined },
      });
      if (onNote) {
        node.port.addEventListener('message', (event: MessageEvent) =>
          onNote(event.data as NoteOnset),
        );
        node.port.start();
      }
      node.connect(context.destination);
      handOver();
      if (!paused) {
        await context.resume();
      }
    } catch (error) {
      onError(
        `The Instruments could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  return {
    close() {
      closed = true;
      clearInterval(timer);
      listening?.close();
      listening = undefined;
      void context.close();
    },
    listen(port) {
      if (closed) {
        port.close();
        return;
      }
      listening?.close();
      listening = port;
      handOver();
    },
    reading,
    setPaused(next) {
      if (closed || next === paused) {
        return;
      }
      paused = next;
      void (paused ? context.suspend() : context.resume());
    },
  };
};
