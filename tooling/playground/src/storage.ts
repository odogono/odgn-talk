// Autosave: the tab buffers and preferences, never the session itself.
import type { Library } from './session';

export type Saved = {
  launch?: string;
  libraries: Library[];
  profile: 'beginner' | 'standard';
  script: string;
  setup?: string[];
  showReadings: boolean;
};

const KEY = 'northtalk-playground';

export const loadSaved = (): Saved | null => {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) {
      return null;
    }
    const data = JSON.parse(text) as Partial<Saved>;
    return {
      launch: typeof data.launch === 'string' ? data.launch : '',
      setup: Array.isArray(data.setup)
        ? data.setup.filter(
            (v): v is string =>
              typeof v === 'string' && /^:(grant|mock) [^\r\n]+$/u.test(v),
          )
        : [],
      script: typeof data.script === 'string' ? data.script : '',
      libraries: Array.isArray(data.libraries)
        ? data.libraries.filter(
            (l): l is Library =>
              typeof l?.name === 'string' && typeof l.source === 'string',
          )
        : [],
      profile: data.profile === 'standard' ? 'standard' : 'beginner',
      showReadings: data.showReadings === true,
    };
  } catch {
    return null;
  }
};

export const save = (saved: Saved) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Storage may be full or disabled; autosave is best effort.
  }
};
