// The DOM boundary for rich text. Clipboard HTML is parsed in an inert template;
// only text and four supported marks cross into the authored model.
import { type RichText, type TextRun } from './model';
import {
  normalizeRichText,
  type TextSelection,
  type TextStyle,
} from './rich-text';

const BLOCKS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'TR',
]);
const OMIT = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'SVG',
  'MATH',
  'TEMPLATE',
  'HEAD',
]);

/** Read allowed semantic tags and inline styles, discarding links, assets and all other formatting. */
export const readRichText = (root: ParentNode): RichText => {
  const runs: TextRun[] = [];
  const newline = () => runs.push({ text: '\n' });
  const endsInBreak = () => runs.at(-1)?.text.endsWith('\n');
  const walk = (node: Node, inherited: TextStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const siblings = [...(node.parentNode?.childNodes ?? [])];
      if (
        /^\s+$/u.test(node.textContent ?? '') &&
        siblings.some(
          n =>
            n.nodeType === Node.ELEMENT_NODE &&
            BLOCKS.has((n as HTMLElement).tagName),
        )
      ) {
        return;
      }
      if (node.textContent) {
        runs.push({ ...inherited, text: node.textContent });
      }
      return;
    }
    if (
      node.nodeType !== Node.ELEMENT_NODE ||
      (node as globalThis.Element).namespaceURI !==
        'http://www.w3.org/1999/xhtml'
    ) {
      return;
    }
    const element = node as HTMLElement;
    if (OMIT.has(element.tagName)) {
      return;
    }
    const block = BLOCKS.has(element.tagName);
    if (block && runs.length && !endsInBreak()) {
      newline();
    }
    if (element.tagName === 'BR') {
      newline();
      return;
    }
    const style = { ...inherited };
    const css = element.style;
    if (['B', 'STRONG'].includes(element.tagName)) {
      style.bold = true;
    }
    if (['I', 'EM'].includes(element.tagName)) {
      style.italic = true;
    }
    if (element.tagName === 'U') {
      style.underline = true;
    }
    if (css.fontWeight) {
      style.bold = css.fontWeight === 'bold' || Number(css.fontWeight) >= 600;
    }
    if (css.fontStyle) {
      style.italic = ['italic', 'oblique'].includes(css.fontStyle);
    }
    const decoration = css.textDecorationLine || css.textDecoration;
    if (decoration) {
      style.underline = decoration.includes('underline');
    }
    const color =
      css.color ||
      (element.tagName === 'FONT' ? (element.getAttribute('color') ?? '') : '');
    // Ask the CSS parser to validate a color, not an arbitrary style fragment.
    const probe = document.createElement('span');
    probe.style.color = color;
    if (
      probe.style.color &&
      !['inherit', 'initial', 'unset', 'revert', 'currentcolor'].includes(
        probe.style.color.toLowerCase(),
      )
    ) {
      style.color = probe.style.color;
    }
    const children = [...node.childNodes];
    // Browsers use a lone BR as the caret placeholder in an empty paragraph.
    if (!(
      block &&
      !element.textContent &&
      children.filter(n => (n as HTMLElement).tagName === 'BR').length === 1 &&
      children.every(n => (n as HTMLElement).tagName === 'BR' || !n.textContent)
    )) {
      children.forEach(child => walk(child, style));
    }
    if (
      block &&
      (!children.some(n => BLOCKS.has((n as HTMLElement).tagName)) ||
        !endsInBreak())
    ) {
      newline();
    }
  };
  [...root.childNodes].forEach(child => walk(child, {}));
  // The last block's boundary is structural, not a further empty paragraph.
  if (runs.at(-1)?.text === '\n') {
    runs.pop();
  }
  return normalizeRichText(runs);
};

export const richTextFromHtml = (html: string): RichText => {
  const template = document.createElement('template');
  template.innerHTML = html;
  return readRichText(template.content);
};

/** Render from text nodes and allowed styles, never from authored HTML. */
export const renderRichText = (root: HTMLElement, text: RichText): void => {
  root.replaceChildren(
    ...text.map(paragraph => {
      const p = document.createElement('p');
      for (const run of paragraph.runs) {
        const span = document.createElement('span');
        span.textContent = run.text;
        Object.assign(span.style, {
          fontWeight: run.bold ? 'bold' : '',
          fontStyle: run.italic ? 'italic' : '',
          textDecoration: run.underline ? 'underline' : '',
          color: run.color ?? '',
        });
        p.append(span);
      }
      if (!p.textContent) {
        p.append(document.createElement('br'));
      }
      return p;
    }),
  );
};

/** Translate DOM points to the model's paragraph-and-text offsets. */
export const selectionInText = (
  root: HTMLElement,
): TextSelection | undefined => {
  const selection = window.getSelection();
  if (!selection?.rangeCount) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return undefined;
  }
  const offsetOf = (node: Node, offset: number) => {
    const children = [...root.childNodes];
    if (node === root) {
      return children
        .slice(0, offset)
        .reduce((n, p) => n + (p.textContent?.length ?? 0) + 1, 0);
    }
    let paragraph = node;
    while (paragraph.parentNode !== root) {
      paragraph = paragraph.parentNode!;
    }
    const index = children.indexOf(paragraph as ChildNode);
    const before = children
      .slice(0, index)
      .reduce((n, p) => n + (p.textContent?.length ?? 0) + 1, 0);
    const prefix = document.createRange();
    prefix.setStart(paragraph, 0);
    prefix.setEnd(node, offset);
    return before + prefix.toString().length;
  };
  return {
    start: offsetOf(range.startContainer, range.startOffset),
    end: offsetOf(range.endContainer, range.endOffset),
  };
};

export const selectTextRange = (
  root: HTMLElement,
  selection: TextSelection,
): void => {
  const point = (offset: number): [Node, number] => {
    let remaining = Math.max(0, offset);
    for (const p of root.children) {
      const length = p.textContent?.length ?? 0;
      if (remaining <= length) {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const size = node.textContent!.length;
          if (remaining <= size) {
            return [node, remaining];
          }
          remaining -= size;
        }
        return [p, 0];
      }
      remaining -= length + 1;
    }
    return [root, root.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...point(selection.start));
  range.setEnd(...point(selection.end));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
};
