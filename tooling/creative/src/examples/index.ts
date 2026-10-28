// Example Projects: Projects that ship with Folio for an author to open as
// an editable copy and learn from. Each is built in code with its assets,
// so it needs no files and reopens offline exactly as exported.
import { type Project } from '../model';
import { createLighthouseProject, LIGHTHOUSE_PROJECT_NAME } from './lighthouse';
import { createSonarProject, SONAR_PROJECT_NAME } from './sonar';
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
  /**
   * The Example Project's path under Folio, as in `/folio/tetris`. Docs
   * link to it, so it never changes once published (ADR 0141).
   */
  slug: string;
};

export const EXAMPLE_PROJECTS: readonly ExampleProject[] = [
  {
    name: LIGHTHOUSE_PROJECT_NAME,
    slug: 'lighthouse',
    description:
      'A short illustrated mystery: navigation, show and hide, sounds, a wait and a reader journal.',
    create: createLighthouseProject,
  },
  {
    name: TETRIS_PROJECT_NAME,
    slug: 'tetris',
    description:
      'The falling-blocks game: a frame loop, arrow keys and a board of 200 rectangles repainted by one Page Script.',
    create: createTetrisProject,
  },
  {
    name: CANVAS_TETRIS_PROJECT_NAME,
    slug: 'canvas-tetris',
    description:
      'The same falling-blocks game drawn with canvas commands, instead of the Element version’s 200 pre-placed board rectangles.',
    create: createCanvasTetrisProject,
  },
  {
    name: SONAR_PROJECT_NAME,
    slug: 'sonar',
    description:
      'Sweep a sea for mines on one canvas: a sonar sweep on `frame`, pings that ripple from where you click, right-click or a long press for buoys.',
    create: createSonarProject,
  },
];

/** The `.folio` file the build writes for an Example Project, under Folio. */
export const exampleFilePath = (slug: string): string =>
  `projects/${slug}.folio`;

/**
 * The page meta tag naming the Example Project a `/folio/<slug>/` page
 * opens. The build writes one copy of Folio's page per Example Project.
 */
export const EXAMPLE_META = 'folio-example';
