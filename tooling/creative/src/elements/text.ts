// The text Element: rich text the reader may be allowed to edit.
import {
  alignParagraph,
  isTextAlign,
  richTextFromPlainText,
  setTextAlign,
  textAlignOf,
  textOf,
  type Paragraph,
  type RichText,
  type TextAlign,
  type TextElement,
  type TextRun,
} from '../model';
import type { DeepReadonly, Mutable } from '../readonly';
import { PROPERTY_FUEL } from '../tree/rules';
import { setDefined, type Checker } from './checker';
import { commonProperties, defineElementKind, property } from './definition';

const checkRichText = (c: Checker, value: unknown, path: string): RichText => {
  const paragraphs = c.arr(value, path) ?? [];
  return paragraphs.map((raw, i) => {
    const p = c.obj(raw, `${path}[${i}]`) ?? {};
    const runs = c.arr(p.runs, `${path}[${i}].runs`) ?? [];
    const align = c.optStr(p.align, `${path}[${i}].align`);
    if (align !== undefined && !isTextAlign(align)) {
      c.fail(`${path}[${i}].align`, 'expected left, center, right or justify');
    }
    const paragraph: Paragraph = {
      runs: runs.map((rawRun, j) => {
        const at = `${path}[${i}].runs[${j}]`;
        const r = c.obj(rawRun, at) ?? {};
        const run: TextRun = {
          text: c.str(r.text, `${at}.text`) ?? '',
        };
        for (const key of ['bold', 'italic', 'underline'] as const) {
          setDefined(run, key, c.optBool(r[key], `${at}.${key}`));
        }
        setDefined(run, 'color', c.optStr(r.color, `${at}.color`));
        return run;
      }),
    };
    alignParagraph(paragraph, isTextAlign(align) ? align : undefined);
    return paragraph;
  });
};

export const textKind = defineElementKind({
  kind: 'text',
  label: 'Text',
  icon: 'T',
  creatable: true,
  textProperty: 'text',
  properties: {
    ...commonProperties,
    text: {
      shape: 'text',
      setCost: { fuel: PROPERTY_FUEL },
      get: owner => textOf(owner as DeepReadonly<TextElement>),
      set: (_owner, value, writer) => writer.text(String(value)),
    },
    textColor: property('textColor', 'text'),
    textSize: property('textSize', 'number'),
    textAlign: {
      shape: 'text',
      setCost: { fuel: PROPERTY_FUEL },
      get: owner => textAlignOf(owner as DeepReadonly<TextElement>),
      validate: (_owner, value) =>
        isTextAlign(value)
          ? undefined
          : 'textAlign must be left, center, right or justify',
      set: (owner, value, writer) => {
        const staged = { ...(owner as Mutable<TextElement>) };
        setTextAlign(staged, value as TextAlign);
        writer.field('richText', staged.richText, true);
      },
    },
    font: property('font', 'text'),
    editable: property('editable', 'boolean'),
  },
  create: base => ({
    ...base,
    kind: 'text',
    richText: richTextFromPlainText('Text'),
    textColor: '#1d1d1f',
    textSize: 18,
    font: 'sans-serif',
    editable: false,
  }),
  check: (c, e, path, { base }) => ({
    ...base(),
    kind: 'text',
    richText: checkRichText(c, e.richText, `${path}.richText`),
    textColor: c.str(e.textColor, `${path}.textColor`) ?? '',
    textSize: c.num(e.textSize, `${path}.textSize`, 'positive') ?? 1,
    font: c.str(e.font, `${path}.font`) ?? '',
    editable: c.bool(e.editable, `${path}.editable`) ?? false,
  }),
  style: element => ({
    color: element.textColor,
    fontFamily: element.font,
    fontSize: `${element.textSize}px`,
  }),
  readerAttributes: (element, { takesInput, visible }) => ({
    contentEditable:
      element.editable && visible && takesInput ? 'true' : 'false',
  }),
});
