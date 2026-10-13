// The authored Project model (#748): pure data, no UI and no Play State
// (ADR 0041). Element kinds and properties follow #735, decisions 2-5.

/** One run of uniformly styled text inside a paragraph. */
export type TextRun = {
  bold?: boolean;
  /** Run text color; absent means the Element's `textColor`. */
  color?: string;
  italic?: boolean;
  text: string;
  underline?: boolean;
};

export type Paragraph = { runs: TextRun[] };

/** Rich text: paragraphs of styled runs (bold, italic, underline, color). */
export type RichText = Paragraph[];

type ElementBase = {
  height: number;
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
};

export type EllipseElement = ElementBase & {
  fill: string;
  kind: 'ellipse';
  stroke: string;
};

export type LineElement = ElementBase & {
  kind: 'line';
  stroke: string;
  thickness: number;
};

export type Element =
  | TextElement
  | ImageElement
  | ButtonElement
  | RectangleElement
  | EllipseElement
  | LineElement;

export type ElementKind = Element['kind'];

export const ELEMENT_KINDS: readonly ElementKind[] = [
  'text',
  'image',
  'button',
  'rectangle',
  'ellipse',
  'line',
];

export type Page = {
  background: string;
  elements: Element[];
  height: number;
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
export const plainTextOf = (richText: RichText): string =>
  richText.map(p => p.runs.map(r => r.text).join('')).join('\n');

/** Rich text holding plain text with no mixed formatting. */
export const richTextFromPlainText = (text: string): RichText =>
  text.split('\n').map(line => ({ runs: [{ text: line }] }));

const base = (name: string): ElementBase => ({
  name,
  left: 40,
  top: 40,
  width: 200,
  height: 100,
  visible: true,
});

/** A new Element of `kind` with that kind's default properties. */
export const createElement = (kind: ElementKind, name: string): Element => {
  switch (kind) {
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
      return { ...base(name), kind, fill: '#f0a020', stroke: '#1d1d1f' };
    case 'ellipse':
      return { ...base(name), kind, fill: '#7ee08a', stroke: '#1d1d1f' };
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

/**
 * An independent copy of an Element with a fresh name. Changing the copy
 * never affects the original.
 */
export const duplicateElement = (
  element: Element,
  takenNames: ReadonlySet<string>,
): Element => {
  const copy = structuredClone(element);
  copy.name = freshName(element.name, takenNames);
  return copy;
};

/**
 * An independent copy of a Page with a fresh name. Its Elements keep their
 * names, which are unique within the new Page as they were in the old.
 */
export const duplicatePage = (
  page: Page,
  takenNames: ReadonlySet<string>,
): Page => {
  const copy = structuredClone(page);
  copy.name = freshName(page.name, takenNames);
  return copy;
};
