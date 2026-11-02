/** @jsxImportSource preact */
// The pragma lets code run outside Folio's tsconfig, such as `bun test`
// from the repo root, compile this file: model.ts reaches every kind.
// The button Element: a labelled control the reader clicks.
import {
  BUTTON_DEFAULTS,
  BUTTON_STYLES,
  BUTTON_STYLES_PROSE,
  isButtonStyle,
  type ButtonStyle,
} from '../model';
import { commonProperties, defineElementKind, property } from './definition';

const STYLE_LABELS: Record<ButtonStyle, string> = {
  rounded: 'Rounded',
  rectangle: 'Rectangle',
  shadowed: 'Shadowed',
  transparent: 'Transparent (invisible)',
};

export const buttonKind = defineElementKind({
  kind: 'button',
  label: 'Button',
  icon: '▭',
  creatable: true,
  textProperty: 'label',
  properties: {
    ...commonProperties,
    label: property('label', 'text'),
    fill: property('fill', 'text'),
    textColor: property('textColor', 'text'),
    font: property('font', 'text'),
    textSize: {
      ...property('textSize', 'number'),
      infoMin: 1,
      validate: (_owner, value) =>
        Number(value) > 0 ? undefined : 'textSize must be above zero',
    },
    style: {
      ...property('style', 'text'),
      validate: (_owner, value) =>
        isButtonStyle(value)
          ? undefined
          : `style must be ${BUTTON_STYLES_PROSE}`,
    },
  },
  create: base => ({
    ...base,
    kind: 'button',
    height: 44,
    label: 'Button',
    fill: '#2f6fed',
    ...BUTTON_DEFAULTS,
    textColor: '#ffffff',
  }),
  check: (c, e, path, { base }) => {
    const style = e.style === undefined ? BUTTON_DEFAULTS.style : e.style;
    const validStyle = isButtonStyle(style);
    if (!validStyle) {
      c.fail(`${path}.style`, `expected ${BUTTON_STYLES_PROSE}`);
    }
    return {
      ...base(),
      kind: 'button',
      label: c.str(e.label, `${path}.label`) ?? '',
      fill: c.str(e.fill, `${path}.fill`) ?? '',
      textColor: c.str(e.textColor, `${path}.textColor`) ?? '',
      // Projects authored before button typography and styles keep their look.
      font:
        c.str(
          e.font === undefined ? BUTTON_DEFAULTS.font : e.font,
          `${path}.font`,
        ) ?? '',
      textSize:
        c.num(
          e.textSize === undefined ? BUTTON_DEFAULTS.textSize : e.textSize,
          `${path}.textSize`,
          'positive',
        ) ?? BUTTON_DEFAULTS.textSize,
      style: validStyle ? style : BUTTON_DEFAULTS.style,
    };
  },
  style: element => ({
    background: element.style === 'transparent' ? 'transparent' : element.fill,
    color: element.textColor,
    fontFamily: element.font,
    fontSize: `${element.textSize}px`,
  }),
  className: element => ` button-${element.style}`,
  Contents: ({ element }) => (
    <span className="button-label">{element.label}</span>
  ),
  readerAttributes: (element, { visible }) => ({
    tabIndex: visible ? 0 : -1,
    role: 'button',
    'aria-label': element.label || element.name,
  }),
  info: (
    element,
    { controls: { field, fontField, input, color, select }, disabled },
  ) => (
    <>
      {field('Label', input('label', element.label, disabled))}
      {field(
        'Style',
        select('style', element.style, disabled, BUTTON_STYLES, STYLE_LABELS),
      )}
      {fontField(element.font, disabled)}
      {field(
        'Size',
        input('textSize', element.textSize, disabled, 'number', { min: 1 }),
      )}
      <div className="row">
        {field('Fill', color('fill', element.fill, disabled))}
        {field('Text', color('textColor', element.textColor, disabled))}
      </div>
    </>
  ),
});
