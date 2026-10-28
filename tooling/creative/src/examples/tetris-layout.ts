// The shared System 7 layout for the Element and Canvas Tetris examples.
import {
  createElement,
  createPage,
  DEFAULT_DESIGN_WIDTH,
  type Element,
  type Page,
  type Paragraph,
  type TextElement,
} from '../model';
import { groupElement } from '../tree/rules';
import { COLUMNS, EMPTY_COLOUR, ROWS } from './tetris-rules';

// Laid out like a game window on a colour Macintosh running System 7: a
// menu bar, a platinum window with a pinstriped title bar, Chicago and
// Geneva type, and pieces in the classic 16-colour palette.
const DESKTOP = '#666699';
const PLATINUM = '#dddddd';
const SHADOW = '#777777';
const INK = '#000000';
const CHICAGO =
  '"ChicagoFLF", Chicago, Charcoal, Geneva, "Lucida Grande", sans-serif';
const GENEVA = 'Geneva, Verdana, "Lucida Grande", sans-serif';
export const CELL = 22;
export const PREVIEW_CELL = 18;
const WINDOW_LEFT = 145;
const WINDOW_TOP = 50;
const WINDOW_WIDTH = 430;
const TITLE_HEIGHT = 22;
const BOARD_LEFT = WINDOW_LEFT + 18;
const BOARD_TOP = WINDOW_TOP + TITLE_HEIGHT + 16;
const WINDOW_HEIGHT = TITLE_HEIGHT + 16 + ROWS * CELL + 18;
const SIDE_LEFT = BOARD_LEFT + COLUMNS * CELL + 22;
const SIDE_WIDTH = WINDOW_LEFT + WINDOW_WIDTH - 16 - SIDE_LEFT;

const place = <T extends Element>(
  element: T,
  at: Partial<Element> & Record<string, unknown>,
): T => Object.assign(element, at);

const box = (
  name: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fill: string,
  stroke = INK,
): Element =>
  place(createElement('rectangle', name), {
    left,
    top,
    width,
    height,
    fill,
    stroke,
  });

const rule = (
  name: string,
  left: number,
  top: number,
  width: number,
  stroke: string,
): Element =>
  place(createElement('line', name), {
    left,
    top,
    width,
    height: 0,
    stroke,
    thickness: 1,
  });

const label = (
  name: string,
  text: string,
  left: number,
  top: number,
  width: number,
  options: {
    align?: Paragraph['align'];
    bold?: boolean;
    font?: string;
    size?: number;
  } = {},
): TextElement => {
  const size = options.size ?? 12;
  return place(createElement('text', name) as TextElement, {
    left,
    top,
    width,
    height: Math.ceil(size * 1.5) * (text.split('\n').length || 1),
    textSize: size,
    textColor: INK,
    font: options.font ?? CHICAGO,
    richText: text.split('\n').map(line => ({
      ...(options.align ? { align: options.align } : {}),
      runs: [{ text: line, bold: options.bold ?? false }],
    })),
  });
};

const menuBar = (): Element[] => [
  box('menuBar', -2, -2, DEFAULT_DESIGN_WIDTH + 4, 24, '#ffffff'),
  label('menus', '🍎    File    Edit    Game', 14, 2, 400, { size: 13 }),
];

// A System 7 window: a drop shadow, a platinum frame, a title bar with
// pinstripes either side of the title and a close box on the left.
const windowFrame = (title: string): Element[] => {
  const right = WINDOW_LEFT + WINDOW_WIDTH;
  const elements: Element[] = [
    box(
      'windowShadow',
      WINDOW_LEFT + 3,
      WINDOW_TOP + 3,
      WINDOW_WIDTH,
      WINDOW_HEIGHT,
      INK,
    ),
    box(
      'window',
      WINDOW_LEFT,
      WINDOW_TOP,
      WINDOW_WIDTH,
      WINDOW_HEIGHT,
      PLATINUM,
    ),
  ];
  for (let i = 0; i < 6; i++) {
    elements.push(
      rule(
        `stripe${i + 1}`,
        WINDOW_LEFT + 6,
        WINDOW_TOP + 5 + i * 2,
        WINDOW_WIDTH - 12,
        SHADOW,
      ),
    );
  }
  const titleWidth = 58;
  elements.push(
    box(
      'closeBack',
      WINDOW_LEFT + 8,
      WINDOW_TOP + 3,
      19,
      16,
      PLATINUM,
      PLATINUM,
    ),
    box('closeBox', WINDOW_LEFT + 11, WINDOW_TOP + 4, 13, 13, PLATINUM),
    box(
      'titleBack',
      WINDOW_LEFT + (WINDOW_WIDTH - titleWidth) / 2,
      WINDOW_TOP + 3,
      titleWidth,
      16,
      PLATINUM,
      PLATINUM,
    ),
    label(
      'windowTitle',
      title,
      WINDOW_LEFT + (WINDOW_WIDTH - titleWidth) / 2,
      WINDOW_TOP + 1,
      titleWidth,
      { size: 13, bold: true, align: 'center' },
    ),
    rule(
      'titleRule',
      WINDOW_LEFT,
      WINDOW_TOP + TITLE_HEIGHT,
      right - WINDOW_LEFT,
      INK,
    ),
  );
  return elements;
};

// Both surfaces occupy the same frames; only their representation differs.
const surface = (
  rendering: 'elements' | 'canvas',
  name: string,
  prefix: string,
  left: number,
  top: number,
  rows: number,
  columns: number,
  size: number,
): Element[] => {
  if (rendering === 'canvas') {
    return [
      place(createElement('canvas', name), {
        left,
        top,
        width: columns * size,
        height: rows * size,
        fill: EMPTY_COLOUR,
      }),
    ];
  }
  const cells: Element[] = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= columns; c++) {
      cells.push(
        box(
          `${prefix}_${r}_${c}`,
          left + (c - 1) * size,
          top + (r - 1) * size,
          size,
          size,
          EMPTY_COLOUR,
          '#ffffff',
        ),
      );
    }
  }
  return cells;
};

export const createTetrisPage = (
  script: string,
  rendering: 'elements' | 'canvas',
): Page => {
  const page: Page = {
    ...createPage('tetris'),
    background: DESKTOP,
    height: WINDOW_TOP + WINDOW_HEIGHT + 40,
    script,
  };
  const elements: Element[] = [
    ...menuBar(),
    groupElement('windowFrame', windowFrame('Tetris')),
    // The well: a sunken white field with a black edge.
    box(
      'well',
      BOARD_LEFT - 3,
      BOARD_TOP - 3,
      COLUMNS * CELL + 6,
      ROWS * CELL + 6,
      '#ffffff',
    ),
  ];
  elements.push(
    ...surface(
      rendering,
      'boardCanvas',
      'cell',
      BOARD_LEFT,
      BOARD_TOP,
      ROWS,
      COLUMNS,
      CELL,
    ),
  );
  // The Next piece, in a white field like the board.
  const previewSize = 4 * PREVIEW_CELL;
  const previewLeft = SIDE_LEFT + (SIDE_WIDTH - previewSize) / 2;
  elements.push(
    label('nextText', 'Next', SIDE_LEFT, BOARD_TOP - 2, SIDE_WIDTH),
    box(
      'nextWell',
      previewLeft - 3,
      BOARD_TOP + 20,
      previewSize + 6,
      previewSize + 6,
      '#ffffff',
    ),
    ...surface(
      rendering,
      'previewCanvas',
      'next',
      previewLeft,
      BOARD_TOP + 23,
      4,
      4,
      PREVIEW_CELL,
    ),
  );
  const scoreTop = BOARD_TOP + 130;
  elements.push(
    box('scoreField', SIDE_LEFT, scoreTop, SIDE_WIDTH, 78, '#ffffff'),
    label(
      'scoreText',
      'Score: 0',
      SIDE_LEFT + 8,
      scoreTop + 6,
      SIDE_WIDTH - 16,
      {
        font: GENEVA,
      },
    ),
    label(
      'levelText',
      'Level: 1',
      SIDE_LEFT + 8,
      scoreTop + 28,
      SIDE_WIDTH - 16,
      {
        font: GENEVA,
      },
    ),
    label(
      'linesText',
      'Lines: 0',
      SIDE_LEFT + 8,
      scoreTop + 50,
      SIDE_WIDTH - 16,
      {
        font: GENEVA,
      },
    ),
    place(createElement('button', 'restartButton'), {
      left: SIDE_LEFT + (SIDE_WIDTH - 110) / 2,
      top: scoreTop + 96,
      width: 110,
      height: 30,
      label: 'New Game',
      fill: '#ffffff',
      textColor: INK,
      script: 'on click {button: 0}\n  send restart to thisPage\nend click\n',
    }),
    label(
      'help',
      '← →  move\n↑  rotate\nZ  rotate back\n↓  soft drop\nSpace  hard drop',
      SIDE_LEFT,
      scoreTop + 146,
      SIDE_WIDTH,
      { font: GENEVA, size: 11 },
    ),
  );
  // A System 7 alert for the end of the game, hidden until then.
  const alertWidth = 200;
  const alertHeight = 70;
  const alertLeft = BOARD_LEFT + (COLUMNS * CELL - alertWidth) / 2;
  const alertTop = BOARD_TOP + (ROWS * CELL - alertHeight) / 2;
  const alert = groupElement('gameOverAlert', [
    box(
      'alertShadow',
      alertLeft + 3,
      alertTop + 3,
      alertWidth,
      alertHeight,
      INK,
    ),
    box('alertBox', alertLeft, alertTop, alertWidth, alertHeight, '#ffffff'),
    box(
      'alertInner',
      alertLeft + 4,
      alertTop + 4,
      alertWidth - 8,
      alertHeight - 8,
      '#ffffff',
    ),
    label(
      'gameOver',
      '💣  Game Over',
      alertLeft + 10,
      alertTop + 22,
      alertWidth - 20,
      {
        size: 16,
        bold: true,
      },
    ),
  ]);
  alert.visible = false;
  elements.push(alert);
  page.elements = elements;
  return page;
};
