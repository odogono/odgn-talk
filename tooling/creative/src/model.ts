// The authored Project model (#748): pure data, no UI and no Play State
// (ADR 0041). Element kinds and properties follow #735, decisions 2-5.
import type { CanvasCommand } from '@northtalk/tooling/canvas';
import { type DeepReadonly, thaw } from './readonly';
import { allElements } from './tree/rules';

/** One run of uniformly styled text inside a paragraph. */
export type TextRun = {
  bold?: boolean;
  /** Run text color; absent means the Element's `textColor`. */
  color?: string;
  italic?: boolean;
  text: string;
  underline?: boolean;
};

export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export const isTextAlign = (value: unknown): value is TextAlign =>
  TEXT_ALIGNS.includes(value as TextAlign);

/** A paragraph's runs and alignment; absent `align` means left. */
export type Paragraph = { align?: Exclude<TextAlign, 'left'>; runs: TextRun[] };

/**
 * Rich text: paragraphs of styled runs (bold, italic, underline, color),
 * each with its own alignment.
 */
export type RichText = Paragraph[];

export type ElementBase = {
  height: number;
  /** Session-local editor identity; omitted from files and storage. */
  id?: number;
  left: number;
  name: string;
  /** The Element's Owning Script source, when it has one. */
  script?: string;
  top: number;
  visible: boolean;
  width: number;
};

export type TextElement = ElementBase & {
  /** Whether the reader may edit this text during a Play Session. */
  editable: boolean;
  font: string;
  kind: 'text';
  richText: RichText;
  textColor: string;
  textSize: number;
};

export type ImageElement = ElementBase & {
  /** The name of an asset in the Project's asset table. */
  image: string;
  kind: 'image';
};

export const BUTTON_STYLES = [
  'rounded',
  'rectangle',
  'shadowed',
  'transparent',
] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];
export const isButtonStyle = (value: unknown): value is ButtonStyle =>
  BUTTON_STYLES.includes(value as ButtonStyle);
export const BUTTON_STYLES_PROSE = `${BUTTON_STYLES.slice(0, -1).join(', ')} or ${BUTTON_STYLES.at(-1)}`;
/** Button typography and style, also applied to buttons in older Projects. */
export const BUTTON_DEFAULTS = {
  font: 'system-ui, sans-serif',
  textSize: 18,
  style: 'rounded',
} as const satisfies { font: string; style: ButtonStyle; textSize: number };

export type ButtonElement = ElementBase & {
  fill: string;
  font: string;
  kind: 'button';
  /** Visible label, or accessible name when the button is transparent. */
  label: string;
  style: ButtonStyle;
  textColor: string;
  textSize: number;
};

export type RectangleElement = ElementBase & {
  fill: string;
  kind: 'rectangle';
  stroke: string;
  /** Border width in pixels; zero hides the border. */
  thickness: number;
};

export type EllipseElement = ElementBase & {
  fill: string;
  kind: 'ellipse';
  stroke: string;
  /** Border width in pixels; zero hides the border. */
  thickness: number;
};

export type LineElement = ElementBase & {
  kind: 'line';
  stroke: string;
  thickness: number;
};

export type CanvasElement = ElementBase & {
  /** Commands since the last `clear` or `background` (ADR 0116). */
  drawing: CanvasCommand[];
  fill: string;
  kind: 'canvas';
};

export type GroupElement = ElementBase & { kind: 'group'; members: Element[] };

/**
 * An Element kind an Add-on provides (ADR 0162): the Add-on's URL, then
 * `#` and the kind's name, such as
 * `https://northtalk.org/add-ons/music-controls#knob`.
 */
export type AddOnKind = `${string}#${string}`;

/**
 * An Element whose kind comes from an Add-on Folio has not loaded: a
 * placeholder. `saved` is its file form, written back unchanged apart from
 * the common properties, so no data is lost (ADR 0162).
 */
export type AddOnElement = ElementBase & {
  kind: AddOnKind;
  saved: Readonly<Record<string, unknown>>;
};

export type Element =
  | TextElement
  | ImageElement
  | ButtonElement
  | RectangleElement
  | EllipseElement
  | LineElement
  | CanvasElement
  | GroupElement
  | AddOnElement;

export type ElementKind = Element['kind'];
/** The kinds built into Folio. */
export type BuiltInKind = Exclude<ElementKind, AddOnKind>;

// Each kind's defaults, drawing and checks live in its definition (#1900).
export { createElement, ELEMENT_KINDS } from './elements/registry';

/** Where Present places a Page narrower or shorter than the window. */
export const PAGE_ALIGNS_X = ['left', 'center', 'right'] as const;
export const PAGE_ALIGNS_Y = ['top', 'center', 'bottom'] as const;
export type PageAlignX = (typeof PAGE_ALIGNS_X)[number];
export type PageAlignY = (typeof PAGE_ALIGNS_Y)[number];
export const isPageAlignX = (value: unknown): value is PageAlignX =>
  PAGE_ALIGNS_X.includes(value as PageAlignX);
export const isPageAlignY = (value: unknown): value is PageAlignY =>
  PAGE_ALIGNS_Y.includes(value as PageAlignY);

export type Page = {
  /** Horizontal placement when presented; absent means center. */
  alignX?: PageAlignX;
  /** Vertical placement when presented; absent means center. */
  alignY?: PageAlignY;
  background: string;
  elements: Element[];
  height: number;
  /** Session-local editor identity; omitted from files and storage. */
  id?: number;
  name: string;
  script?: string;
};

/** One row of the asset table: a Script-facing name for stored bytes. */
export type Asset = {
  /** The file name the asset was imported from. */
  fileName: string;
  /** Lowercase hex SHA-256 of the asset's bytes. */
  hash: string;
  mediaType: string;
  /** The name Scripts use, in an image Element's `image` or in `sound`. */
  name: string;
  /** Byte size of the asset. */
  size: number;
};

/** Authored stateless code, imported by name within its Project. */
export type ProjectLibrary = {
  /** Session-local editor identity; omitted from files and storage. */
  id?: number;
  name: string;
  source: string;
};

/**
 * A Test Script (ADR 0133): saved with the Project, hidden from Play, and
 * run by Run Tests against a fresh Play Session for each Test Handler.
 */
export type ProjectTestScript = {
  /** Session-local editor identity; omitted from files and storage. */
  id?: number;
  /** An identifier and then `.test`, such as `rules.test`. */
  name: string;
  source: string;
};

/** A parameter's value: a number, a choice or a switch. */
export type InstrumentParameterValue = number | string | boolean;

/**
 * An Instrument (ADR 0158): a named sound source Scripts play notes on,
 * whose kind (`sampler`, `ym2149`, `synth`) is in the Instrument kind
 * registry. Parameters a kind gains later take their defaults when absent.
 */
export type Instrument = {
  /** Session-local editor identity; omitted from files and storage. */
  id?: number;
  kind: string;
  name: string;
  parameters: Record<string, InstrumentParameterValue>;
  /** How many notes it can play at once. */
  voices: number;
};

/** The Base Projects a new Project can start as a copy of (ADR 0161). */
export const BASE_PROJECT_NAMES = ['blank', 'music'] as const;
export type BaseProjectName = (typeof BASE_PROJECT_NAMES)[number];

/** Which Base Project, and which version of it, a Project was copied from. */
export type BaseProjectRef = { name: BaseProjectName; version: number };

/**
 * An Add-on a Project uses (ADR 0162), named by its URL. A built-in one
 * comes with Folio; a Project Add-on carries its code, and the code's
 * SHA-256, in the file.
 */
export type AddOnRef = {
  /** A Project Add-on's code. */
  code?: string;
  /** The lowercase hex SHA-256 of `code`'s UTF-8 bytes. */
  hash?: string;
  id: string;
  version: string;
};

export type Project = {
  /** The Add-ons it uses; absent when none. */
  addOns?: AddOnRef[];
  assets: Asset[];
  /** The Base Project it was copied from; for attribution and updates only. */
  base?: BaseProjectRef;
  /** The Project-wide width every Page is laid out against, in pixels. */
  designWidth: number;
  instruments: Instrument[];
  libraries: ProjectLibrary[];
  name: string;
  pages: Page[];
  /** The Project Script source. */
  script: string;
  testScripts: ProjectTestScript[];
};

export const DEFAULT_DESIGN_WIDTH = 720;
export const DEFAULT_PAGE_HEIGHT = 540;

/** Page and Element names are identifiers, bound in Scripts during a Play Session (#735). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const isIdentifierName = (name: string): boolean =>
  IDENTIFIER.test(name);

/**
 * The first name based on `base` that is not taken: `base` itself, else
 * its trailing number counted up, so `door` gives `door2` and `page1`
 * gives `page2`.
 */
export const freshName = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) {
    return base;
  }
  const [, stem, digits] = /^(.*?)(\d*)$/u.exec(base)!;
  for (let n = digits ? Number(digits) + 1 : 2; ; n++) {
    const candidate = `${stem}${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
};

/** Suggests an identifier name from free text such as a button's label. */
export const suggestName = (text: string): string => {
  const words = text.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const [first, ...rest] = words;
  if (!first) {
    return 'element';
  }
  const joined =
    first[0]!.toLowerCase() +
    first.slice(1) +
    rest.map(w => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^[0-9]/u.test(joined) ? `element${joined}` : joined;
};

/** The plain text of rich text: paragraphs joined by newlines. */
export const plainTextOf = (richText: DeepReadonly<RichText>): string =>
  richText.map(p => p.runs.map(r => r.text).join('')).join('\n');

/** Rich text holding plain text with no mixed formatting. */
export const richTextFromPlainText = (text: string): RichText =>
  text
    .replaceAll(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => ({ runs: [{ text: line }] }));

/** Sets a paragraph's alignment, storing left as absent. */
export const alignParagraph = (
  paragraph: Paragraph,
  align?: TextAlign,
): void => {
  if (align && align !== 'left') {
    paragraph.align = align;
  } else {
    delete paragraph.align;
  }
};

/**
 * Script-facing plain text. Replacing it clears every run's formatting but
 * keeps each paragraph's alignment; added paragraphs take the last one's.
 */
export const textOf = (element: DeepReadonly<TextElement>): string =>
  plainTextOf(element.richText);
export const replacePlainText = (element: TextElement, text: string): void => {
  const previous = element.richText;
  element.richText = richTextFromPlainText(text);
  element.richText.forEach((p, i) =>
    alignParagraph(p, (previous[i] ?? previous.at(-1))?.align),
  );
};

/** Script-facing alignment: the first paragraph's. */
export const textAlignOf = (element: DeepReadonly<TextElement>): TextAlign =>
  element.richText[0]?.align ?? 'left';
/** Aligns every paragraph of the Element's text. */
export const setTextAlign = (element: TextElement, align: TextAlign): void => {
  element.richText = element.richText.map(p => {
    const next = { ...p };
    alignParagraph(next, align);
    return next;
  });
};

export const createPage = (name: string): Page => ({
  name,
  height: DEFAULT_PAGE_HEIGHT,
  background: '#fdfcf8',
  elements: [],
});

export const createProject = (name: string): Project => ({
  name,
  designWidth: DEFAULT_DESIGN_WIDTH,
  script: '',
  pages: [createPage('page1')],
  assets: [],
  instruments: [],
  libraries: [],
  testScripts: [],
});

/** A detached copy of a Page or Element without session ids. */
const withoutIds = <T extends Page | Element>(owner: DeepReadonly<T>): T => {
  const copy = thaw<T>(owner);
  delete copy.id;
  if ('elements' in copy) {
    for (const element of allElements(copy.elements)) {
      delete element.id;
    }
  }
  if ('kind' in copy && copy.kind === 'group') {
    for (const member of allElements(copy.members)) {
      delete member.id;
    }
  }
  return copy;
};

/** An independent copy of a Project without the editor's session ids. */
export const projectWithoutIds = (project: DeepReadonly<Project>): Project => {
  const copy = thaw<Project>(project);
  for (const owner of [
    ...copy.instruments,
    ...copy.libraries,
    ...copy.testScripts,
  ]) {
    delete owner.id;
  }
  for (const page of copy.pages) {
    delete page.id;
    for (const element of allElements(page.elements)) {
      delete element.id;
    }
  }
  return copy;
};

/**
 * An independent copy of an Element with a fresh name. Changing the copy
 * never affects the original.
 */
export const duplicateElement = (
  element: DeepReadonly<Element>,
  takenNames: ReadonlySet<string>,
): Element => {
  const copy = withoutIds<Element>(element);
  const taken = new Set(takenNames);
  for (const member of allElements([copy])) {
    member.name = freshName(member.name, taken);
    taken.add(member.name);
  }
  return copy;
};

/**
 * An independent copy of a Page with a fresh name. Its Elements keep their
 * names, which are unique within the new Page as they were in the old.
 */
export const duplicatePage = (
  page: DeepReadonly<Page>,
  takenNames: ReadonlySet<string>,
): Page => {
  const copy = withoutIds<Page>(page);
  copy.name = freshName(page.name, takenNames);
  return copy;
};
