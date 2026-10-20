// Example Projects: Projects that ship with Folio for an author to open as
// an editable copy and learn from. Each is built in code with its assets,
// so it needs no files and reopens offline exactly as exported.
import { type Project } from '../model';
import { createLighthouseProject, LIGHTHOUSE_PROJECT_NAME } from './lighthouse';
import { createTetrisProject, TETRIS_PROJECT_NAME } from './tetris';
import {
  CANVAS_TETRIS_PROJECT_NAME,
  createCanvasTetrisProject,
} from './tetris-canvas';

export type ExampleContent = {
  /** Asset bytes by SHA-256 hash, for storage and portable export. */
  assets: Map<string, Uint8Array>;
  project: Project;
};

export type ExampleProject = {
  create(): Promise<ExampleContent>;
  description: string;
  name: string;
};

export const EXAMPLE_PROJECTS: readonly ExampleProject[] = [
  {
    name: LIGHTHOUSE_PROJECT_NAME,
    description:
      'A short illustrated mystery: navigation, show and hide, sounds, a wait and a reader journal.',
    create: createLighthouseProject,
  },
  {
    name: TETRIS_PROJECT_NAME,
    description:
      'The falling-blocks game: a frame loop, arrow keys and a board of 200 rectangles repainted by one Page Script.',
    create: createTetrisProject,
  },
  {
    name: CANVAS_TETRIS_PROJECT_NAME,
    description:
      'The same falling-blocks game drawn with canvas commands, instead of the Element version’s 200 pre-placed board rectangles.',
    create: createCanvasTetrisProject,
  },
];
