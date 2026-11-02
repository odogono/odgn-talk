// Gives a test Project the sound names the Music Base Project brings
// (ADR 0161), so its patterns can name `bd`, `hh` and the rest. The bytes
// are never read: tests check names and scheduling, not audio.
import { KIT_SOUND_KEYS } from '../src/kits/kits';
import type { Project } from '../src/model';

export const withMusicSounds = <P extends Project>(project: P): P => {
  for (const key of KIT_SOUND_KEYS) {
    project.assets.push({
      name: key,
      fileName: `${key.replace(':', '-')}.wav`,
      hash: key.replace(':', '-').padEnd(64, '0'),
      mediaType: 'audio/wav',
      size: 3,
    });
  }
  return project;
};
