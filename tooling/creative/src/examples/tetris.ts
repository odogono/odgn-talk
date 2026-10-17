// The Tetris Example Project (#1114): a game loop on Folio's `frame`
// message (ADR 0095), driven by arrow keys. The board is 200 rectangles
// drawn here in advance; the Page Script keeps the game in lists and only
// ever changes their fills, so nothing is created or deleted while playing.
import {
  createElement,
  createPage,
  createProject,
  DEFAULT_DESIGN_WIDTH,
  type Element,
  type Page,
  type Paragraph,
  type TextElement,
} from '../model';
import { type ExampleContent } from './index';

export const TETRIS_PROJECT_NAME = 'Tetris';

export const ROWS = 20;
export const COLUMNS = 10;
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
const CELL = 22;
const PREVIEW_CELL = 18;
const WINDOW_LEFT = 145;
const WINDOW_TOP = 50;
const WINDOW_WIDTH = 430;
const TITLE_HEIGHT = 22;
const BOARD_LEFT = WINDOW_LEFT + 18;
const BOARD_TOP = WINDOW_TOP + TITLE_HEIGHT + 16;
const WINDOW_HEIGHT = TITLE_HEIGHT + 16 + ROWS * CELL + 18;
const SIDE_LEFT = BOARD_LEFT + COLUMNS * CELL + 22;
const SIDE_WIDTH = WINDOW_LEFT + WINDOW_WIDTH - 16 - SIDE_LEFT;
export const EMPTY_COLOUR = '#ffffff';

const PAGE_SCRIPT = `-- Tetris. The board is a list of ${ROWS} rows, each a list of ${COLUMNS}
-- numbers: 0 for an empty square, or the number of the piece that filled
-- it. The falling piece is its kind, its squares inside a small box, and
-- where that box sits on the board.

constant rows = ${ROWS}
constant columns = ${COLUMNS}
constant emptyColour = "${EMPTY_COLOUR}"
-- I, O, T, S, Z, J and L, in that order.
-- The classic Macintosh 16-colour palette.
constant colours = ["#02abea", "#fcf305", "#f20884", "#1fb714", "#dd0806", "#0000d4", "#ff6403"]
-- Each piece's squares as [row, column] inside its box.
constant shapes = [[[2, 1], [2, 2], [2, 3], [2, 4]], [[1, 1], [1, 2], [2, 1], [2, 2]], [[1, 2], [2, 1], [2, 2], [2, 3]], [[1, 2], [1, 3], [2, 1], [2, 2]], [[1, 1], [1, 2], [2, 2], [2, 3]], [[1, 1], [2, 1], [2, 2], [2, 3]], [[1, 3], [2, 1], [2, 2], [2, 3]]]
-- How wide each piece's box is; a piece turns inside its box.
constant boxSizes = [4, 2, 3, 3, 3, 3, 3]
-- Points for clearing one, two, three or four lines, times the level.
constant linePoints = [100, 300, 500, 800]

script variable board = []
script variable cells = []
script variable shown = []
script variable previewCells = []
script variable kind = 0
script variable squares = []
script variable pieceTop = 0
script variable pieceLeft = 0
script variable nextKind = 0
script variable bag = []
script variable score = 0
script variable level = 1
script variable lines = 0
script variable sinceDrop = 0
script variable playing = false
script variable changed = false

on openPage
  findCells
  restart
end openPage

-- Look up every rectangle once, so painting can reach them by position.
on findCells
  put [] into cells
  repeat for each r in 1..rows
    put [] into row
    repeat for each c in 1..columns
      ask elements to find "cell_" & r & "_" & c, thisPage
      put it into item c of row
    end repeat
    put row into item r of cells
  end repeat
  put [] into previewCells
  repeat for each r in 1..4
    put [] into row
    repeat for each c in 1..4
      ask elements to find "next_" & r & "_" & c, thisPage
      put it into item c of row
    end repeat
    put row into item r of previewCells
  end repeat
end findCells

-- A list of lists, height rows by width columns, all holding value.
on grid height, width, value
  put [] into result
  repeat for each r in 1..height
    put [] into row
    repeat for each c in 1..width
      put value into item c of row
    end repeat
    put row into item r of result
  end repeat
  return result
end grid

on restart
  put grid(rows, columns, 0) into board
  put grid(rows, columns, "") into shown
  put [] into bag
  put 0 into score
  put 0 into lines
  put 1 into level
  put 0 into sinceDrop
  put takeFromBag() into nextKind
  hide alertShadow
  hide alertBox
  hide alertInner
  hide gameOver
  put true into playing
  spawnPiece
  showScore
  paint
end restart

-- A bag holds one of each piece; take them out in a random order, then
-- refill it, so every piece comes round once in each seven.
on takeFromBag
  if the length of bag = 0 then
    put [1, 2, 3, 4, 5, 6, 7] into bag
  end if
  put random(the length of bag) into k
  put item k of bag into piece
  delete item k of bag
  return piece
end takeFromBag

on spawnPiece
  put nextKind into kind
  put takeFromBag() into nextKind
  put item kind of shapes into squares
  -- Start in the middle of the top row.
  put 0 into pieceTop
  if kind = 1 then
    put -1 into pieceTop
  end if
  put (columns - item kind of boxSizes) div 2 into pieceLeft
  put 0 into sinceDrop
  put true into changed
  showPreview
  if not fits(squares, pieceTop, pieceLeft) then
    endGame
  end if
end spawnPiece

-- Whether these squares, with their box at atTop and atLeft, are all on
-- the board and on empty squares.
on fits shape, atTop, atLeft
  repeat for each [r, c] in shape
    put atTop + r into boardRow
    put atLeft + c into boardColumn
    if boardRow < 1 or boardRow > rows then
      return false
    end if
    if boardColumn < 1 or boardColumn > columns then
      return false
    end if
    if item boardColumn of item boardRow of board is not 0 then
      return false
    end if
  end repeat
  return true
end fits

on tryMove down, across
  if fits(squares, pieceTop + down, pieceLeft + across) then
    add down to pieceTop
    add across to pieceLeft
    put true into changed
    return true
  end if
  return false
end tryMove

-- Turning moves each square within its box: clockwise, row r and column c
-- go to row c and column size + 1 - r. A turn that is blocked doesn't
-- happen.
on rotate clockwise
  if kind = 2 then
    return false
  end if
  put item kind of boxSizes into size
  put [] into turned
  repeat for each [r, c] in squares
    if clockwise then
      put [c, size + 1 - r] into item (the length of turned + 1) of turned
    else
      put [size + 1 - c, r] into item (the length of turned + 1) of turned
    end if
  end repeat
  if fits(turned, pieceTop, pieceLeft) then
    put turned into squares
    put true into changed
    return true
  end if
  return false
end rotate

on lockPiece
  repeat for each [r, c] in squares
    put kind into item (pieceLeft + c) of item (pieceTop + r) of board
  end repeat
  clearLines
  spawnPiece
end lockPiece

on isFull row
  repeat for each square in row
    if square = 0 then
      return false
    end if
  end repeat
  return true
end isFull

-- Keep the rows that aren't full, and put empty rows on top for the rest.
on clearLines
  put 0 into cleared
  put [] into kept
  repeat for each row in board
    if isFull(row) then
      add 1 to cleared
    else
      put row into item (the length of kept + 1) of kept
    end if
  end repeat
  if cleared > 0 then
    put grid(cleared, columns, 0) into board
    repeat for each row in kept
      put row into item (the length of board + 1) of board
    end repeat
    add cleared to lines
    add item cleared of linePoints * level to score
    put lines div 10 + 1 into level
    showScore
  end if
end clearLines

on hardDrop
  repeat while tryMove(1, 0)
    add 2 to score
  end repeat
  lockPiece
  showScore
end hardDrop

on endGame
  put false into playing
  show alertShadow
  show alertBox
  show alertInner
  show gameOver
end endGame

-- Milliseconds between drops: a second at level 1, faster each level.
on dropInterval
  return max(100, 1000 - 75 * (level - 1))
end dropInterval

on frame elapsed
  if not playing then
    return
  end if
  add elapsed to sinceDrop
  if sinceDrop >= dropInterval() then
    put 0 into sinceDrop
    if not tryMove(1, 0) then
      lockPiece
    end if
  end if
  paint
end frame

on keyDown key
  if not playing then
    return
  end if
  if key = "ArrowLeft" then
    tryMove 0, -1
  else if key = "ArrowRight" then
    tryMove 0, 1
  else if key = "ArrowDown" then
    if tryMove(1, 0) then
      add 1 to score
      put 0 into sinceDrop
      showScore
    end if
  else if key = "ArrowUp" then
    rotate true
  else if key = "z" or key = "Z" then
    rotate false
  else if key = " " then
    hardDrop
  end if
  paint
end keyDown

on colourOf piece
  if piece = 0 then
    return emptyColour
  end if
  return item piece of colours
end colourOf

-- Lay the falling piece over the board, then change only the rectangles
-- whose colour differs from what they show.
on paint
  if not changed then
    return
  end if
  put false into changed
  put board into view
  if playing then
    repeat for each [r, c] in squares
      put kind into item (pieceLeft + c) of item (pieceTop + r) of view
    end repeat
  end if
  repeat for each r in 1..rows
    repeat for each c in 1..columns
      put colourOf(item c of item r of view) into colour
      if colour is not item c of item r of shown then
        set the fill of item c of item r of cells to colour
        put colour into item c of item r of shown
      end if
    end repeat
  end repeat
end paint

on showPreview
  repeat for each r in 1..4
    repeat for each c in 1..4
      set the fill of item c of item r of previewCells to emptyColour
    end repeat
  end repeat
  repeat for each [r, c] in item nextKind of shapes
    set the fill of item c of item r of previewCells to item nextKind of colours
  end repeat
end showPreview

on showScore
  set the text of scoreText to "Score: " & score
  set the text of levelText to "Level: " & level
  set the text of linesText to "Lines: " & lines
end showScore
`;

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

const cell = (name: string, left: number, top: number, size: number): Element =>
  box(name, left, top, size, size, EMPTY_COLOUR, '#ffffff');

const tetrisPage = (): Page => {
  const page: Page = {
    ...createPage('tetris'),
    background: DESKTOP,
    height: WINDOW_TOP + WINDOW_HEIGHT + 40,
    script: PAGE_SCRIPT,
  };
  const elements: Element[] = [
    ...menuBar(),
    ...windowFrame('Tetris'),
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
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLUMNS; c++) {
      elements.push(
        cell(
          `cell_${r}_${c}`,
          BOARD_LEFT + (c - 1) * CELL,
          BOARD_TOP + (r - 1) * CELL,
          CELL,
        ),
      );
    }
  }
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
  );
  for (let r = 1; r <= 4; r++) {
    for (let c = 1; c <= 4; c++) {
      elements.push(
        cell(
          `next_${r}_${c}`,
          previewLeft + (c - 1) * PREVIEW_CELL,
          BOARD_TOP + 23 + (r - 1) * PREVIEW_CELL,
          PREVIEW_CELL,
        ),
      );
    }
  }
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
      script: 'on click\n  send restart to thisPage\nend click\n',
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
  elements.push(
    place(
      box(
        'alertShadow',
        alertLeft + 3,
        alertTop + 3,
        alertWidth,
        alertHeight,
        INK,
      ),
      { visible: false },
    ),
    place(
      box('alertBox', alertLeft, alertTop, alertWidth, alertHeight, '#ffffff'),
      { visible: false },
    ),
    place(
      box(
        'alertInner',
        alertLeft + 4,
        alertTop + 4,
        alertWidth - 8,
        alertHeight - 8,
        '#ffffff',
      ),
      { visible: false },
    ),
    place(
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
      { visible: false },
    ),
  );
  page.elements = elements;
  return page;
};

/**
 * Builds the Tetris Example Project: one Page whose Page Script is the
 * whole game, written as readable Handlers split by concern.
 */
export const createTetrisProject = async (): Promise<ExampleContent> => {
  const project = createProject(TETRIS_PROJECT_NAME);
  project.pages = [tetrisPage()];
  return { project, assets: new Map() };
};
