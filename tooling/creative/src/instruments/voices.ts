// Voice allocation shared by the polyphonic kinds.

export type Voice = {
  active: boolean;
  /** When the voice started, in notes started, for stealing the oldest. */
  age: number;
  note: number;
};

/** A free voice, else the oldest, which the new note steals. */
export const allocate = <V extends Voice>(voices: readonly V[]): V => {
  let pick = voices[0]!;
  for (const voice of voices) {
    if (!voice.active) {
      return voice;
    }
    if (voice.age < pick.age) {
      pick = voice;
    }
  }
  return pick;
};
