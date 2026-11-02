// First Sounds (#1898): Folio's take on Strudel's First Sounds workshop. Each
// Page teaches one idea of Sound Patterns and Mini-Notation (ADR 0159) with
// the Music sounds it carries (ADR 0161): a sound, sequences and rests, subdivision,
// alternation, parallel layers, then tempo and Instruments.
//
// Every Page Script is built the same way, so a reader can compare them. The
// Page loops each layer when it opens, with the source the Loop a pattern
// Recipe inserts. Its `on click` answers the Page's buttons through the
// Message Path: a Mute button per layer stops or restarts that layer, and
// each groove button changes a layer on the next bar, with that Recipe's
// source again.
import {
  createElement,
  createPage,
  createProject,
  richTextFromPlainText,
  type Element,
  type Page,
  type TextElement,
} from '../model';
import { createInstrument } from '../instruments/registry';
import { INSTRUMENTS_REF, synthInstrument } from '../add-ons/instruments/ids';
import { kitSoundAsset } from '../base-projects';
import { projectMusicSounds } from '../pattern-checks';
import { recipeSource, recipeText, type RecipeTarget } from '../recipes';
import { type ExampleContent } from './index';

export const FIRST_SOUNDS_PROJECT_NAME = 'First Sounds';
/** The tempo every Play Session starts at, in beats a minute. */
export const START_TEMPO = 120;
export const TEMPOS = [90, 120, 150] as const;

/** One loop on a Page: on the default sampler, or on a named Instrument. */
export type Layer = {
  /** The Instrument it plays on; the default sampler when absent. */
  instrument?: string;
  /** Names its Script variables and its Mute button, as `kick`. */
  name: string;
  /** The pattern the Page loops when it opens. */
  pattern: string;
};

/** A button that loops another pattern on one layer when clicked. */
export type Groove = { layer: string; pattern: string };

export type Lesson = {
  grooves: readonly Groove[];
  layers: readonly Layer[];
  /** What the Page teaches, shown above its buttons. */
  lesson: string;
  name: string;
  title: string;
};

export const LESSONS: readonly Lesson[] = [
  {
    name: 'aSound',
    title: '1. A sound',
    lesson:
      'This Page loops one sound with loop "bd": a bass drum, once every bar. "bd" names one of this Project’s sounds, which came with it. Others are sd (snare), hh (closed hi-hat), oh (open hi-hat), cp (clap), rim, lt, mt and ht (toms), cb (cowbell) and cr (crash). A number picks a variant: "bd:1" is a punchier kick. Click a pattern to hear it from the next bar.',
    layers: [{ name: 'beat', pattern: 'bd' }],
    grooves: [
      { layer: 'beat', pattern: 'sd' },
      { layer: 'beat', pattern: 'bd:1' },
    ],
  },
  {
    name: 'sequences',
    title: '2. Sequences and rests',
    lesson:
      'Write several sounds and they share the bar equally: "bd hh sd hh" is four steps, a quarter of a bar each. A dash is a rest, a step where nothing plays. The more steps, the faster they go, since the bar stays the same length.',
    layers: [{ name: 'beat', pattern: 'bd hh sd hh' }],
    grooves: [
      { layer: 'beat', pattern: 'bd - sd -' },
      { layer: 'beat', pattern: 'bd hh - hh sd hh - oh' },
    ],
  },
  {
    name: 'subdivision',
    title: '3. Subdivision',
    lesson:
      'Square brackets fit several sounds into one step: in "bd [hh hh] sd [hh hh hh]" the second step plays two hi-hats and the last plays three. A star repeats a step faster, so "hh*2" is the same as "[hh hh]".',
    layers: [{ name: 'beat', pattern: 'bd [hh hh] sd [hh hh hh]' }],
    grooves: [
      { layer: 'beat', pattern: 'bd hh*4 sd [hh oh]' },
      { layer: 'beat', pattern: '[bd bd] - sd [- bd] hh*4' },
    ],
  },
  {
    name: 'alternation',
    title: '4. Alternation',
    lesson:
      'Angle brackets take turns, one choice each bar: "bd <hh oh> sd <hh cp>" plays hh then oh in its second step, a bar each. Alternation and subdivision nest, so a pattern can change from bar to bar without getting longer.',
    layers: [{ name: 'beat', pattern: 'bd <hh oh> sd <hh cp>' }],
    grooves: [
      { layer: 'beat', pattern: '<bd bd:1> hh sd <hh oh cp>' },
      { layer: 'beat', pattern: 'bd*2 <sd cp> [- bd] <sd [sd sd]>' },
    ],
  },
  {
    name: 'layers',
    title: '5. Parallel layers',
    lesson:
      'A comma plays patterns together: loop "bd*2, hh*4, - cp" is a whole beat in one line. A Script loops one pattern per Instrument, so to mute a layer on its own this Page gives each layer its own sampler Instrument and loops it with "on": loop "hh*4" on hats.',
    layers: [
      { name: 'kick', instrument: 'kick', pattern: 'bd*2' },
      { name: 'hats', instrument: 'hats', pattern: 'hh*4' },
      { name: 'claps', instrument: 'claps', pattern: '- cp' },
    ],
    grooves: [
      { layer: 'hats', pattern: 'hh*8' },
      { layer: 'kick', pattern: 'bd [- bd] - bd' },
    ],
  },
  {
    name: 'tempo',
    title: '6. Tempo and Instruments',
    lesson:
      'One cycle is one bar, so the tempo sets how fast every pattern plays: tell transport to setTempo 90. A synth Instrument plays notes, not samples: loop "c2 e2 g2 e2" on bass. Notes are letter names with an octave; "<c2 a1>" alternates them a bar each.',
    layers: [
      { name: 'kick', instrument: 'kick', pattern: 'bd*4' },
      { name: 'bass', instrument: 'bass', pattern: 'c2 e2 g2 e2' },
    ],
    grooves: [
      { layer: 'bass', pattern: '<c2 a1> [- c3] <g2 e2> c2' },
      { layer: 'kick', pattern: 'bd*4, - oh - oh' },
    ],
  },
];

/** The Recipe target for a layer: its Instrument, or the default sampler. */
const instrumentTarget = (layer: Layer): RecipeTarget => ({
  name: layer.instrument ?? 'Default sampler',
  reference: layer.instrument ?? '',
});

const capitalised = (name: string) => name[0]!.toUpperCase() + name.slice(1);
export const muteButtonName = (layer: string) => `mute${capitalised(layer)}`;
export const grooveButtonName = (index: number) => `groove${index + 1}`;
export const tempoButtonName = (tempo: number) => `tempo${tempo}`;
const muteLabel = (layer: Layer, muted: boolean) =>
  `${muted ? 'Unmute' : 'Mute'} ${layer.name}`;

/**
 * The loop a groove button starts, as its label shows it: `loop "…"` with
 * `on` for a named Instrument.
 */
export const grooveSource = (layer: Layer, pattern: string): string =>
  recipeSource('loopPattern', instrumentTarget(layer), pattern);

const indent = (lines: readonly string[], by: string) =>
  lines.map(line => `${by}${line}`);

/** Restores a layer's Mute button once it loops again. */
const unmute = (l: Layer) => [
  `put false into ${l.name}Muted`,
  `set the label of ${muteButtonName(l.name)} to ${recipeText(muteLabel(l, false))}`,
];

/** The Page Script that loops a Lesson's layers and answers its buttons. */
export const lessonScript = (lesson: Lesson): string => {
  const layer = (name: string) => lesson.layers.find(l => l.name === name)!;
  // Stopping the default sampler means `stop` without a target, which ends every
  // pattern the Script started, so it may only be a Page's one layer.
  if (lesson.layers.length > 1 && lesson.layers.some(l => !l.instrument)) {
    throw new Error(
      `${lesson.name}: a layer on the default sampler plays alone`,
    );
  }
  const muteClicks = lesson.layers.map(l => [
    `if the name of the target = ${recipeText(muteButtonName(l.name))} then`,
    `  if ${l.name}Muted then`,
    `    loop ${l.name}Pattern${l.instrument ? ` on ${l.instrument}` : ''}`,
    ...indent(unmute(l), '    '),
    '  else',
    `    stop${l.instrument ? ` ${l.instrument}` : ''}`,
    `    put true into ${l.name}Muted`,
    `    set the label of the target to ${recipeText(muteLabel(l, true))}`,
    '  end if',
    'end if',
  ]);
  // A groove also unmutes its layer, since it loops again.
  const grooveClicks = lesson.grooves.map((g, i) => [
    `if the name of the target = ${recipeText(grooveButtonName(i))} then`,
    `  ${grooveSource(layer(g.layer), g.pattern)}`,
    `  put ${recipeText(g.pattern)} into ${g.layer}Pattern`,
    ...indent(unmute(layer(g.layer)), '  '),
    'end if',
  ]);
  const tempoClicks =
    lesson.name === 'tempo'
      ? TEMPOS.map(tempo => [
          `if the name of the target = ${recipeText(tempoButtonName(tempo))} then`,
          `  tell transport to setTempo ${tempo}`,
          `  set the text of tempoText to "${tempo} beats a minute"`,
          'end if',
        ])
      : [];
  return [
    "-- Each layer's pattern, kept so Unmute can loop it again.",
    ...lesson.layers.flatMap(l => [
      `script variable ${l.name}Pattern = ${recipeText(l.pattern)}`,
      `script variable ${l.name}Muted = false`,
    ]),
    '',
    'on openPage',
    ...indent(
      lesson.layers.map(l => grooveSource(l, l.pattern)),
      '  ',
    ),
    ...(lesson.name === 'tempo'
      ? [
          '  ask transport to tempo',
          '  set the text of tempoText to it & " beats a minute"',
        ]
      : []),
    'end openPage',
    '',
    '-- The buttons have no Scripts: their clicks reach this Page.',
    'on click {button: 0}',
    ...indent([...muteClicks, ...grooveClicks, ...tempoClicks].flat(), '  '),
    'end click',
    '',
  ].join('\n');
};

const place = <T extends Element>(
  element: T,
  at: Partial<Element> & Record<string, unknown>,
): T => Object.assign(element, at);

const text = (
  name: string,
  value: string,
  top: number,
  height: number,
  textSize = 18,
  bold = false,
): TextElement =>
  place(createElement('text', name) as TextElement, {
    left: 40,
    top,
    width: 640,
    height,
    textSize,
    richText: bold
      ? [{ runs: [{ text: value, bold: true }] }]
      : richTextFromPlainText(value),
  });

const button = (
  name: string,
  label: string,
  left: number,
  top: number,
  width = 300,
  script?: string,
): Element =>
  place(createElement('button', name), {
    left,
    top,
    width,
    height: 44,
    label,
    ...(script ? { script } : {}),
  });

const PAGE_HEIGHT = 640;

/** A button's Script that goes to the named Page. */
const navigate = (name: string) =>
  `on click {button: 0}\n  ${recipeSource('navigate', { name, reference: name })}\nend click\n`;

const lessonPage = (lesson: Lesson, index: number): Page => {
  const page: Page = {
    ...createPage(lesson.name),
    background: '#f4f1ea',
    height: PAGE_HEIGHT,
  };
  const layer = (name: string) => lesson.layers.find(l => l.name === name)!;
  const elements: Element[] = [
    text('title', lesson.title, 26, 46, 30, true),
    text('lesson', lesson.lesson, 84, 168),
    text('mutes', 'Layers', 264, 28, 18, true),
    ...lesson.layers.map((l, i) =>
      button(
        muteButtonName(l.name),
        muteLabel(l, false),
        40 + i * 216,
        296,
        200,
      ),
    ),
    text('groovesHeading', 'Change the groove', 356, 28, 18, true),
    ...lesson.grooves.map((g, i) =>
      button(
        grooveButtonName(i),
        grooveSource(layer(g.layer), g.pattern),
        40,
        388 + i * 52,
        640,
      ),
    ),
  ];
  if (lesson.name === 'tempo') {
    elements.push(
      text('tempoText', `${START_TEMPO} beats a minute`, 496, 28),
      ...TEMPOS.map((tempo, i) =>
        button(tempoButtonName(tempo), `${tempo} bpm`, 40 + i * 216, 528, 200),
      ),
    );
  }
  const previous = LESSONS[index - 1];
  const next = LESSONS[index + 1];
  if (previous) {
    elements.push(
      button(
        'back',
        `Back: ${previous.title}`,
        40,
        580,
        300,
        navigate(previous.name),
      ),
    );
  }
  if (next) {
    elements.push(
      button('next', `Next: ${next.title}`, 380, 580, 300, navigate(next.name)),
    );
  }
  page.elements = elements;
  page.script = lessonScript(lesson);
  return page;
};

/**
 * Builds First Sounds. It carries, as its own sounds, every kit sound its
 * patterns play, so the file needs nothing else to play (ADR 0161).
 */
export const createFirstSoundsProject = async (): Promise<ExampleContent> => {
  const project = createProject(FIRST_SOUNDS_PROJECT_NAME);
  project.addOns = [INSTRUMENTS_REF];
  project.instruments.push(
    createInstrument('sampler', 'kick'),
    createInstrument('sampler', 'hats'),
    createInstrument('sampler', 'claps'),
    synthInstrument('bass'),
  );
  // Every Session starts at the same tempo; the last Page changes it.
  project.script = `on startPlay\n  tell transport to setTempo ${START_TEMPO}\nend startPlay\n`;
  project.pages = LESSONS.map(lessonPage);
  const assets = new Map<string, Uint8Array>();
  for (const key of [...projectMusicSounds(project)].sort()) {
    const { asset, bytes } = await kitSoundAsset(key);
    assets.set(asset.hash, bytes);
    project.assets.push(asset);
  }
  return { project, assets };
};
