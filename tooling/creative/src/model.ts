// The authored Project model (#748): pure data, no UI and no Play State
// (ADR 0041). Element kinds and properties follow #735, decisions 2-5.
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

type ElementBase = {
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

export type ButtonElement = ElementBase & {
  fill: string;
  kind: 'button';
  /** What the reader sees; separate from the identifier `name`. */
  label: string;
  textColor: string;
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

export type GroupElement = ElementBase & { kind: 'group'; members: Element[] };

export type Element =
  | TextElement
  | ImageElement
  | ButtonElement
  | RectangleElement
  | EllipseElement
  | LineElement
  | GroupElement;

export type ElementKind = Element['kind'];

export const ELEMENT_KINDS: readonly ElementKind[] = [
  'text',
  'image',
  'button',
  'rectangle',
  'ellipse',
  'line',
  'group',
];

export type Page = {
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

export type Project = {
  assets: Asset[];
  /** The Project-wide width every Page is laid out against, in pixels. */
  designWidth: number;
  name: string;
  pages: Page[];
  /** The Project Script source. */
  script: string;
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

const base = (name: string): ElementBase => ({
  name,
  left: 40,
  top: 40,
  width: 200,
  height: 100,
  visible: true,
});

/** A new Element of `kind` with that kind's default properties. */
/** True for shapes whose border has a writable `thickness`. */
export const hasBorder = (element: {
  kind: string;
}): element is RectangleElement | EllipseElement =>
  element.kind === 'rectangle' || element.kind === 'ellipse';

export const createElement = (kind: ElementKind, name: string): Element => {
  switch (kind) {
    case 'group':
      return { ...base(name), kind, members: [], width: 0, height: 0 };
    case 'text':
      return {
        ...base(name),
        kind,
        richText: richTextFromPlainText('Text'),
        textColor: '#1d1d1f',
        textSize: 18,
        font: 'sans-serif',
        editable: false,
      };
    case 'image':
      return { ...base(name), kind, image: '' };
    case 'button':
      return {
        ...base(name),
        kind,
        height: 44,
        label: 'Button',
        fill: '#2f6fed',
        textColor: '#ffffff',
      };
    case 'rectangle':
      return {
        ...base(name),
        kind,
        fill: '#f0a020',
        stroke: '#1d1d1f',
        thickness: 2,
      };
    case 'ellipse':
      return {
        ...base(name),
        kind,
        fill: '#7ee08a',
        stroke: '#1d1d1f',
        thickness: 2,
      };
    case 'line':
      return {
        ...base(name),
        kind,
        height: 0,
        stroke: '#1d1d1f',
        thickness: 2,
      };
  }
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
