// Copied from odogono/wime web/src/audio/sonix/mixer.ts at
// 86110d6517e9ff323b5e520db5f44dba2d81af25 (#1889), changed only by this repo's formatter.

// Ported from nuade's Sonix player (players/sonix in
// https://github.com/emoon/nuade), itself a port of the Aegis Sonix Music
// Driver's 68000 code, under nuade's licence:
//
// MIT License
//
// Copyright (c) 2026 Daniel Collin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

// A Paula-like voice mixer in place of nuade's NuadeVoices (src/nuade_mixer.c
// and include/nuade/voice.h): four voices of signed 8-bit samples, each with
// a loop and a sample queued to take over at its end, played at a pitch in
// source frames a second, nearest sample, no filter. Voices 0 and 3 are hard
// left and 1 and 2 hard right, the Amiga's stereo (nuade's snx_set_pans).

export type Sample = {
  data: Int8Array;
  length: number;
  // 0 is a one-shot.
  loopLength: number;
  loopStart: number;
};

export type VoiceState = {
  playing: boolean;
  // Source frames into the sample.
  position: number;
  sample: Sample | null;
};

type Voice = {
  current: Sample | null;
  pan: number;
  playing: boolean;
  position: number;
  queued: Sample | null;
  step: number;
  volume: number;
};

// Each voice is scaled by this so that four full-scale voices stay in range
// (NUADE_HEADROOM).
const HEADROOM = 0.5;

const PANS: readonly number[] = [-1, 1, 1, -1];

// A loop that does not fit in the sample is clipped to it; one that starts
// past the end is no loop.
const normalised = (sample: Sample): Sample => {
  const length = Math.min(sample.length, sample.data.length);
  if (sample.loopLength === 0 || sample.loopStart >= length) {
    return { ...sample, length, loopLength: 0 };
  }
  return {
    ...sample,
    length,
    loopLength: Math.min(sample.loopLength, length - sample.loopStart),
  };
};

const sampleEnd = (sample: Sample): number =>
  sample.loopLength === 0
    ? sample.length
    : sample.loopStart + sample.loopLength;

export type Mixer = {
  mix(
    left: Float32Array,
    right: Float32Array,
    start: number,
    end: number,
  ): void;
  // Start a sample, replacing the current one and anything queued.
  play(voice: number, sample: Sample): void;
  // Take over when the current sample ends (at its loop end if it loops); on
  // an idle voice, start now. A second call replaces the queued sample.
  queue(voice: number, sample: Sample): void;
  // Source frames a second; 0 holds the position.
  setPitch(voice: number, hz: number): void;
  // Linear, 0 to 1.
  setVolume(voice: number, volume: number): void;
  state(voice: number): VoiceState;
  stop(voice: number): void;
};

export const createMixer = (sampleRate: number): Mixer => {
  const voices: Voice[] = PANS.map(pan => ({
    current: null,
    pan,
    playing: false,
    position: 0,
    queued: null,
    step: 0,
    volume: 1,
  }));
  const voiceAt = (index: number): Voice => voices[index]!;

  const start = (voice: Voice, sample: Sample) => {
    voice.current = normalised(sample);
    voice.queued = null;
    voice.playing = true;
    voice.position = 0;
  };

  // Bring the position back inside the sample: wrap a loop, move on to the
  // queued sample or end. False when the voice is idle afterwards.
  const settle = (voice: Voice): boolean => {
    let current = voice.current!;
    while (voice.position >= sampleEnd(current)) {
      const end = sampleEnd(current);
      if (voice.queued) {
        current = voice.current = voice.queued;
        voice.queued = null;
        voice.position -= end;
      } else if (current.loopLength !== 0) {
        while (voice.position >= end) {
          voice.position -= current.loopLength;
        }
      } else {
        voice.playing = false;
        return false;
      }
    }
    return true;
  };

  return {
    mix(left, right, from, to) {
      for (let frame = from; frame < to; frame++) {
        let l = 0;
        let r = 0;
        for (const voice of voices) {
          if (voice.playing && settle(voice)) {
            const sample = voice.current!;
            const value =
              (sample.data[Math.floor(voice.position)]! / 128) * voice.volume;
            l += value * HEADROOM * 0.5 * (1 - voice.pan);
            r += value * HEADROOM * 0.5 * (1 + voice.pan);
            voice.position += voice.step;
          }
        }
        left[frame] = l;
        right[frame] = r;
      }
    },
    play(index, sample) {
      start(voiceAt(index), sample);
    },
    queue(index, sample) {
      const voice = voiceAt(index);
      if (voice.playing) {
        voice.queued = normalised(sample);
      } else {
        start(voice, sample);
      }
    },
    setPitch(index, hz) {
      voiceAt(index).step = hz > 0 ? hz / sampleRate : 0;
    },
    setVolume(index, volume) {
      voiceAt(index).volume = volume;
    },
    state(index) {
      const voice = voiceAt(index);
      return {
        playing: voice.playing,
        position: voice.playing ? voice.position : 0,
        sample: voice.playing ? voice.current : null,
      };
    },
    stop(index) {
      const voice = voiceAt(index);
      voice.playing = false;
      voice.queued = null;
    },
  };
};
