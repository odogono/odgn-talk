// The Lighthouse Mystery Example Project (#824): #154's acceptance example, a three-Page
// illustrated mystery built the way a non-programmer would — navigation,
// show/hide, text and sound actions are the exact source Script Recipes
// insert (`recipes.ts`), and only the parts Recipes do not offer (clue
// messages to the Project Script, `wait`, creating an Element) are written
// out by hand, as an author would after inserting a Recipe. Illustrations
// are SVG and sounds are generated WAV, so the Example Project needs no files and
// reopens offline exactly as exported.
import {
  createElement,
  createPage,
  createProject,
  richTextFromPlainText,
  type Asset,
  type Element,
  type Page,
  type TextElement,
} from '../model';
import { sha256Hex } from '../project-file';
import { recipeSource, type RecipeTarget } from '../recipes';

import { type ExampleContent } from './index';

export const LIGHTHOUSE_PROJECT_NAME = 'The Lighthouse Mystery';

const SVG = (scene: string): Uint8Array =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 250">${scene}</svg>`,
  );

const HARBOUR_ART = SVG(`
<rect width="640" height="250" fill="#bfe0ef"/>
<circle cx="560" cy="45" r="26" fill="#ffd94d"/>
<rect y="150" width="640" height="100" fill="#2f6f9f"/>
<path d="M0 170 Q 80 158 160 170 T 320 170 T 480 170 T 640 170" stroke="#ffffff" stroke-width="4" fill="none" opacity=".7"/>
<path d="M0 205 Q 80 193 160 205 T 320 205 T 480 205 T 640 205" stroke="#ffffff" stroke-width="4" fill="none" opacity=".5"/>
<polygon points="230,150 410,150 380,185 260,185" fill="#8a5a2b"/>
<rect x="312" y="70" width="8" height="82" fill="#5d3d1e"/>
<polygon points="320,74 320,146 378,146" fill="#ffffff"/>
<polygon points="312,84 312,146 268,146" fill="#f2e6c9"/>
<rect x="40" y="118" width="90" height="32" fill="#e8e3d5"/>
<rect x="52" y="98" width="12" height="22" fill="#c0392b"/>
<rect x="76" y="98" width="12" height="22" fill="#ffffff"/>
<rect x="100" y="98" width="12" height="22" fill="#c0392b"/>
<path d="M470 60 q10 -10 20 0 q10 -10 20 0" stroke="#33566e" stroke-width="3" fill="none"/>
<path d="M120 45 q8 -8 16 0 q8 -8 16 0" stroke="#33566e" stroke-width="3" fill="none"/>`);

const LIGHTHOUSE_ART = SVG(`
<rect width="640" height="250" fill="#f7d9a8"/>
<circle cx="90" cy="50" r="28" fill="#ff9f43"/>
<rect y="190" width="640" height="60" fill="#7a8b5a"/>
<polygon points="280,230 360,230 348,80 292,80" fill="#ffffff"/>
<polygon points="288,150 352,150 348,118 292,118" fill="#c0392b"/>
<polygon points="294,86 346,86 344,104 296,104" fill="#c0392b"/>
<rect x="292" y="52" width="56" height="28" fill="#2d3436"/>
<rect x="306" y="58" width="28" height="16" fill="#ffe66d"/>
<polygon points="320,38 356,54 284,54" fill="#2d3436"/>
<polygon points="348,60 620,20 620,110 348,74" fill="#ffe66d" opacity=".45"/>
<rect x="308" y="196" width="24" height="34" fill="#5d3d1e"/>
<path d="M0 230 Q 160 218 320 230 T 640 230" stroke="#5c7042" stroke-width="5" fill="none"/>`);

const CELLAR_ART = SVG(`
<rect width="640" height="250" fill="#4a4238"/>
<rect x="230" y="30" width="180" height="220" fill="#6e4f2a"/>
<rect x="230" y="30" width="180" height="220" fill="none" stroke="#2d2013" stroke-width="8"/>
<line x1="275" y1="30" x2="275" y2="250" stroke="#2d2013" stroke-width="4"/>
<line x1="320" y1="30" x2="320" y2="250" stroke="#2d2013" stroke-width="4"/>
<line x1="365" y1="30" x2="365" y2="250" stroke="#2d2013" stroke-width="4"/>
<circle cx="386" cy="145" r="10" fill="#d9a441"/>
<circle cx="386" cy="145" r="4" fill="#2d2013"/>
<rect x="80" y="180" width="70" height="46" fill="#8a5a2b"/>
<rect x="490" y="180" width="70" height="46" fill="#8a5a2b"/>
<ellipse cx="115" cy="180" rx="35" ry="10" fill="#a97c43"/>
<ellipse cx="525" cy="180" rx="35" ry="10" fill="#a97c43"/>
<path d="M60 40 q30 26 60 0 M90 40 v38" stroke="#cfd4d8" stroke-width="3" fill="none" opacity=".7"/>
<circle cx="540" cy="60" r="16" fill="#ffe66d" opacity=".85"/>
<rect x="536" y="72" width="8" height="18" fill="#d9a441"/>`);

/** One second or so of 16-bit PCM WAV from mono samples in [-1, 1]. */
const wav = (samples: Float32Array, rate = 22_050): Uint8Array => {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(
      44 + i * 2,
      Math.max(-1, Math.min(1, samples[i]!)) * 32_767,
      true,
    );
  }
  return bytes;
};

/** A short decaying bell: the sound of finding a clue. */
const bellWav = (): Uint8Array => {
  const rate = 22_050;
  const samples = new Float32Array(Math.round(rate * 0.7));
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const decay = Math.exp(-4 * t);
    samples[i] =
      decay *
      (0.5 * Math.sin(2 * Math.PI * 660 * t) +
        0.3 * Math.sin(2 * Math.PI * 990 * t));
  }
  return wav(samples, rate);
};

/** Three seconds of smoothed noise swelling once, loopable as waves. */
const wavesWav = (): Uint8Array => {
  const rate = 22_050;
  const samples = new Float32Array(rate * 3);
  let seed = 123_456_789;
  let smooth = 0;
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    smooth += 0.03 * (seed / 0x3f_ff_ff_ff - 1 - smooth);
    const swell = 0.35 + 0.3 * Math.sin((2 * Math.PI * i) / samples.length);
    samples[i] = smooth * swell * 2.4;
  }
  return wav(samples, rate);
};

const target = (
  name: string,
  property?: 'label' | 'text',
  reference = name,
): RecipeTarget => ({ name, reference, ...(property ? { property } : {}) });

/** An `on click {button: 0}` handler around Recipe lines and hand-written ones alike. */
const onClick = (...lines: string[]): string =>
  `on click {button: 0}\n${lines.map(line => `  ${line}`).join('\n')}\nend click\n`;

const place = <T extends Element>(
  element: T,
  at: Partial<Element> & Record<string, unknown>,
): T => Object.assign(element, at);

const heading = (name: string, text: string): TextElement =>
  place(createElement('text', name) as TextElement, {
    left: 40,
    top: 26,
    width: 640,
    height: 46,
    textSize: 30,
    richText: [{ runs: [{ text, bold: true }] }],
  });

const story = (
  name: string,
  text: string,
  top: number,
  height = 100,
): TextElement =>
  place(createElement('text', name) as TextElement, {
    left: 40,
    top,
    width: 640,
    height,
    textSize: 18,
    richText: richTextFromPlainText(text),
  });

const art = (name: string, image: string): Element =>
  place(createElement('image', name), {
    left: 40,
    top: 84,
    width: 640,
    height: 250,
    image,
  });

const button = (
  name: string,
  label: string,
  left: number,
  top: number,
  script?: string,
): Element =>
  place(createElement('button', name), {
    left,
    top,
    width: 300,
    height: 48,
    label,
    ...(script ? { script } : {}),
  });

const PAGE_HEIGHT = 840;

const page = (name: string, background: string): Page => ({
  ...createPage(name),
  background,
  height: PAGE_HEIGHT,
});

/**
 * Builds the sample Project and its asset bytes. The story is #154's
 * acceptance example: a Project Script remembers the clues, a Page Script
 * creates a button whose click reaches the Page handler through the
 * Message Path, a reader-editable journal keeps the reader's notes for
 * the Play Session, and timers and Page-owned sounds stop when their
 * Page is left while the Project's clues carry on.
 */
export const createLighthouseProject = async (): Promise<ExampleContent> => {
  const files: { bytes: Uint8Array; fileName: string; mediaType: string }[] = [
    { bytes: HARBOUR_ART, fileName: 'harbour.svg', mediaType: 'image/svg+xml' },
    {
      bytes: LIGHTHOUSE_ART,
      fileName: 'lighthouse.svg',
      mediaType: 'image/svg+xml',
    },
    { bytes: CELLAR_ART, fileName: 'cellar.svg', mediaType: 'image/svg+xml' },
    { bytes: bellWav(), fileName: 'bell.wav', mediaType: 'audio/wav' },
    { bytes: wavesWav(), fileName: 'waves.wav', mediaType: 'audio/wav' },
  ];
  const assets = new Map<string, Uint8Array>();
  const table: Asset[] = [];
  for (const file of files) {
    const hash = await sha256Hex(file.bytes);
    assets.set(hash, file.bytes);
    table.push({
      // Scripts name sounds without their extension; images keep theirs.
      name: file.mediaType.startsWith('audio/')
        ? file.fileName.replace(/\.[^.]+$/u, '')
        : file.fileName,
      fileName: file.fileName,
      hash,
      mediaType: file.mediaType,
      size: file.bytes.length,
    });
  }

  const project = createProject(LIGHTHOUSE_PROJECT_NAME);
  project.assets = table;
  // The Project Script remembers the clues across Pages (by hand: no
  // Recipe sends a message), and settles the ending when asked.
  project.script = `script variable chart = false
script variable key = false
on foundChart
  put true into chart
end foundChart
on foundKey
  put true into key
end foundKey
on solveMystery
  ask elements to find "verdict", ending
  if chart and key then
    set the text of it to "The door swings open! Behind it, the keeper's cat blinks in the light, quite safe — and wearing the spare key on its collar. Mystery solved."
  else
    set the text of it to "Still locked. You need both clues: the tide chart at the harbour, and whatever is hidden in the lamp room. Your journal may help."
  end if
end solveMystery
`;

  const harbour = page('harbour', '#fdfcf8');
  const journal = story(
    'journal',
    'My journal — tap or click here during Play and write what you find.',
    648,
    96,
  );
  journal.editable = true;
  const clueText = story(
    'clueText',
    'Clue — the tide chart: "Lamp trimmed at six. Cat fed. Mind the trapdoor — it sticks." Nobody has trimmed the lamp since.',
    540,
    88,
  );
  clueText.visible = false;
  harbour.elements.push(
    heading('harbourTitle', 'The Lighthouse Mystery'),
    art('harbourArt', 'harbour.svg'),
    story(
      'harbourStory',
      'The lighthouse keeper has vanished, and the lamp has gone dark for two nights. The harbourmaster hands you the tide chart and shrugs: "You were always the curious one."',
      352,
      104,
    ),
    button(
      'examineButton',
      'Examine the tide chart',
      40,
      472,
      onClick(
        recipeSource('show', target('clueText')),
        recipeSource(
          'text',
          target('examineButton', 'label', 'me'),
          'Tide chart examined',
        ),
        recipeSource('playSound', target('bell')),
        'send foundChart to project',
      ),
    ),
    button(
      'listenButton',
      'Listen to the waves',
      380,
      472,
      onClick(
        recipeSource('loopSound', target('waves')),
        recipeSource(
          'text',
          target('listenButton', 'label', 'me'),
          'Waves (they stop when you leave)',
        ),
      ),
    ),
    clueText,
    story('journalHeading', 'Your journal', 616, 28),
    journal,
    button(
      'toLighthouse',
      'Go to the lighthouse',
      40,
      764,
      onClick(recipeSource('navigate', target('lighthouse'))),
    ),
  );

  const lighthouse = page('lighthouse', '#fdf6e8');
  const keyText = story(
    'keyText',
    'Clue — under the trapdoor: a saucer of milk, still fresh, and small paw prints in the dust leading down to the cellar.',
    592,
    88,
  );
  keyText.visible = false;
  // The Page Script (below) creates the trapdoor button during Play; it
  // is deliberately not authored here.
  lighthouse.elements.push(
    heading('lighthouseTitle', 'The Lamp Room'),
    art('lighthouseArt', 'lighthouse.svg'),
    story('lampNote', 'The lamp is dark and cold.', 352, 36),
    story(
      'lighthouseStory',
      'Dust everywhere — except a clean square in the middle of the floor, as if something there is opened often. Search the room.',
      396,
      88,
    ),
    button(
      'searchButton',
      'Search the lamp room',
      40,
      500,
      onClick(
        recipeSource('hide', target('searchButton', undefined, 'me')),
        'send searchLampRoom to thisPage',
      ),
    ),
    keyText,
    button(
      'backToHarbour',
      'Back to the harbour',
      40,
      764,
      onClick(recipeSource('navigate', target('harbour'))),
    ),
    button(
      'toEnding',
      'Down to the cellar door',
      380,
      764,
      onClick(recipeSource('navigate', target('ending'))),
    ),
  );
  // Written by hand where Recipes stop: a `wait` (leaving cancels it),
  // creating an Element, and answering the created button's click here
  // on the Page, through the Message Path. The trapdoor removes itself,
  // so it can only be opened once per Play Session.
  lighthouse.script = `on openPage
  wait 2 s
  ${recipeSource('text', target('lampNote', 'text'), 'For a moment the lamp swings in a draught — from somewhere below.')}
end openPage
on searchLampRoom
  ask elements to create "button", thisPage, "trapdoor"
  set the label of it to "Open the trapdoor"
  set the left of it to 40
  set the top of it to 500
  set the width of it to 300
  set the height of it to 48
end searchLampRoom
on click {button: 0}
  if the name of the target = "trapdoor" then
    ${recipeSource('show', target('keyText'))}
    ${recipeSource('playSound', target('bell'))}
    send foundKey to project
    tell elements to delete the target
  end if
end click
`;

  const ending = page('ending', '#f3efe6');
  ending.elements.push(
    heading('endingTitle', 'The Cellar Door'),
    art('cellarArt', 'cellar.svg'),
    story(
      'endingStory',
      'Behind this door, something small is scratching, patiently. If you have found both clues, you know exactly who it is — and why the keeper never really vanished at all. (He is visiting his sister. The cat was in charge.)',
      352,
      124,
    ),
    story(
      'verdict',
      'The cellar door is locked. Try it when you think you know the story.',
      492,
      112,
    ),
    button(
      'solveButton',
      'Try the cellar door',
      40,
      620,
      onClick('send solveMystery to project'),
    ),
    button(
      'backToLighthouse',
      'Back to the lamp room',
      40,
      764,
      onClick(recipeSource('navigate', target('lighthouse'))),
    ),
    button(
      'endingToHarbour',
      'Back to the harbour',
      380,
      764,
      onClick(recipeSource('navigate', target('harbour'))),
    ),
  );

  project.pages = [harbour, lighthouse, ending];
  return { project, assets };
};
