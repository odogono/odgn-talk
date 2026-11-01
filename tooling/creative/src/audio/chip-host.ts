// Adapted from odogono/mercenary web/src/sound/workletHost.ts at
// a04a7a9f2b7b4097d223c0f1c11cd963019f7e32 (#1889). Changed: Mercenary's
// `Chip` and `ChipProgram` are one `Chip`, which takes timed commands and
// may render stereo; `SoundBatch` moved here from presenter.ts; the AudioWorklet registration is
// left out, so this file needs no DOM or Web Audio types.

/// Commands for one chip, all to be applied on the sample that `at` (in
/// seconds on the host's clock) falls on.
export type SoundBatch<Command> = {
  readonly at: number;
  readonly commands: readonly Command[];
  /// Drops every batch still waiting before this one is queued.
  readonly replacePending?: boolean;
};

type Reset<Command> = Extract<Command, { readonly kind: 'reset' }>;

/// A headless sound chip: samples rendered on demand, and commands applied
/// at the sample their batch lands on.
export type Chip<Command extends { readonly kind: string }> = {
  /// Plays one command at the sample its batch lands on.
  readonly apply: (command: Command) => void;
  /// 1 for mono, 2 for stereo with the channels interleaved.
  readonly channels: 1 | 2;
  /// The next `count` frames: `count × channels` samples in [-1, 1].
  readonly render: (count: number) => Float32Array;
  /// Silences the chip, applied as the command arrives rather than at its time.
  readonly reset: (command: Reset<Command>) => void;
  /// A driver the chip runs on its own clock, as the ST's VBL runs a programme.
  readonly tick?: { readonly hertz: number; readonly run: () => void };
};

const QUEUE_LIMIT = 2048;

const isReset = <Command extends { readonly kind: string }>(
  command: Command,
): command is Reset<Command> => command.kind === 'reset';

/// Plays an chip's timed commands into render quanta.
///
/// Batches wait in a queue ordered by time; each render quantum is split at every batch and
/// driver tick that falls inside it, so a command lands on its own sample. A batch that asks to
/// replace what is pending clears the queue, which is how a transport discards the previous
/// clock origin on resume. A reset is applied the moment it arrives: sent while the audio is
/// suspended, it must not wait in a queue the resume then replaces, or the old tone plays on.
export class ChipHost<Command extends { readonly kind: string }> {
  private queue: SoundBatch<Command>[] = [];
  private readonly samplesPerTick: number;
  private untilTick: number;

  constructor(
    private readonly chip: Chip<Command>,
    private readonly sampleRate: number,
    private readonly label: string,
  ) {
    this.samplesPerTick =
      chip.tick === undefined ? Infinity : sampleRate / chip.tick.hertz;
    this.untilTick = this.samplesPerTick;
  }

  receive(batch: SoundBatch<Command>): void {
    const resets = batch.commands.filter(isReset);
    if (batch.replacePending || resets.length > 0) {
      this.queue = [];
    }
    for (const reset of resets) {
      this.chip.reset(reset);
    }
    const commands = batch.commands.filter(command => !isReset(command));
    if (commands.length === 0) {
      return;
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      throw new Error(`${this.label} command queue overflow`);
    }
    this.queue.push({ at: batch.at, commands });
    this.queue.sort((left, right) => left.at - right.at);
  }

  /// Fills one render quantum starting at `currentTime`. `output` holds
  /// `frames × channels` samples, interleaved.
  process(output: Float32Array, currentTime: number): void {
    const { channels, render, tick } = this.chip;
    const frames = Math.floor(output.length / channels);
    let position = 0;
    while (position < frames) {
      const batch = this.queue[0];
      const batchAt =
        batch === undefined
          ? Infinity
          : Math.max(
              position,
              Math.ceil((batch.at - currentTime) * this.sampleRate),
            );
      const tickAt = position + Math.ceil(this.untilTick - 1e-9);
      const next = Math.min(frames, batchAt, tickAt);
      output.set(render(next - position), position * channels);
      this.untilTick -= next - position;
      position = next;
      if (next === batchAt) {
        this.queue.shift();
        for (const command of batch!.commands) {
          this.chip.apply(command);
        }
      } else if (next === tickAt) {
        tick!.run();
        this.untilTick += this.samplesPerTick;
      }
    }
  }
}

/// Renders `seconds` of an chip offline, from time 0, with the batches given.
export const renderOffline = <Command extends { readonly kind: string }>(
  chip: Chip<Command>,
  sampleRate: number,
  seconds: number,
  batches: readonly SoundBatch<Command>[] = [],
  quantum = 128,
): Float32Array => {
  const host = new ChipHost(chip, sampleRate, 'offline');
  for (const batch of batches) {
    host.receive(batch);
  }
  const frames = Math.round(seconds * sampleRate);
  const output = new Float32Array(frames * chip.channels);
  for (let frame = 0; frame < frames; frame += quantum) {
    const end = Math.min(frames, frame + quantum);
    host.process(
      output.subarray(frame * chip.channels, end * chip.channels),
      frame / sampleRate,
    );
  }
  return output;
};
