// The Tetris Example Project (#1114): a game loop on Folio's `frame`
// message (ADR 0095), driven by arrow keys. The board is 200 rectangles
// drawn here in advance; the Page Script keeps the game in lists and only
// ever changes their fills, so nothing is created or deleted while playing.
import {
  createElement,
  createPage,
  createProject,
  richTextFromPlainText,
  type Element,
  type Page,
  type TextElement,
} from '../model';
import { type ExampleContent } from './index';

export const TETRIS_PROJECT_NAME = 'Tetris';

export const ROWS = 20;
export const COLUMNS = 10;
const CELL = 24;
const BOARD_LEFT = 40;
const BOARD_TOP = 90;
const PREVIEW_CELL = 20;
const SIDE_LEFT = BOARD_LEFT + COLUMNS * CELL + 40;
export const EMPTY_COLOUR = '#1b1b2f';

const PAGE_SCRIPT = `-- Tetris. The board is a list of ${ROWS} rows, each a list of ${COLUMNS}
-- numbers: 0 for an empty square, or the number of the piece that filled
-- it. The falling piece is its kind, its squares inside a small box, and
-- where that box sits on the board.

constant rows = ${ROWS}
constant columns = ${COLUMNS}
constant emptyColour = "${EMPTY_COLOUR}"
-- I, O, T, S, Z, J and L, in that order.
constant colours = ["#2ec4d6", "#f2c12e", "#a45de2", "#4cbf4b", "#e0453a", "#3f6fe0", "#f08a2c"]
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
script variable seed = 1
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
  hide gameOver
  put true into playing
  spawnPiece
  showScore
  paint
end restart

-- Until random arrives (#1111), a simple generator stirred by frame times.
on pickNumber n
  put (seed * 1103515245 + 12345) mod 2147483648 into seed
  return seed mod n + 1
end pickNumber

-- A bag holds one of each piece; take them out in a random order, then
-- refill it, so every piece comes round once in each seven.
on takeFromBag
  if the length of bag = 0 then
    put [1, 2, 3, 4, 5, 6, 7] into bag
  end if
  put pickNumber(the length of bag) into k
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
  show gameOver
end endGame

-- Milliseconds between drops: a second at level 1, faster each level.
on dropInterval
  return max([100, 1000 - 75 * (level - 1)])
end dropInterval

on frame elapsed
  put (seed + elapsed) mod 2147483648 into seed
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

const square = (
  name: string,
  left: number,
  top: number,
  size: number,
): Element =>
  place(createElement('rectangle', name), {
    left,
    top,
    width: size,
    height: size,
    fill: EMPTY_COLOUR,
    stroke: '#2c2c48',
  });

const label = (
  name: string,
  text: string,
  top: number,
  textSize = 18,
  left = SIDE_LEFT,
  width = 200,
): TextElement =>
  place(createElement('text', name) as TextElement, {
    left,
    top,
    width,
    height: textSize * 1.6,
    textSize,
    textColor: '#f4f4f8',
    richText: richTextFromPlainText(text),
  });

const tetrisPage = (): Page => {
  const page: Page = {
    ...createPage('tetris'),
    background: '#10101c',
    height: BOARD_TOP + ROWS * CELL + 60,
    script: PAGE_SCRIPT,
  };
  const elements: Element[] = [
    label('title', 'Tetris', 24, 30, BOARD_LEFT, 300),
    place(createElement('rectangle', 'well'), {
      left: BOARD_LEFT - 4,
      top: BOARD_TOP - 4,
      width: COLUMNS * CELL + 8,
      height: ROWS * CELL + 8,
      fill: '#2c2c48',
      stroke: '#6a6a9a',
    }),
  ];
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLUMNS; c++) {
      elements.push(
        square(
          `cell_${r}_${c}`,
          BOARD_LEFT + (c - 1) * CELL,
          BOARD_TOP + (r - 1) * CELL,
          CELL,
        ),
      );
    }
  }
  elements.push(label('nextText', 'Next', BOARD_TOP));
  for (let r = 1; r <= 4; r++) {
    for (let c = 1; c <= 4; c++) {
      elements.push(
        square(
          `next_${r}_${c}`,
          SIDE_LEFT + (c - 1) * PREVIEW_CELL,
          BOARD_TOP + 36 + (r - 1) * PREVIEW_CELL,
          PREVIEW_CELL,
        ),
      );
    }
  }
  elements.push(
    label('scoreText', 'Score: 0', BOARD_TOP + 130),
    label('levelText', 'Level: 1', BOARD_TOP + 165),
    label('linesText', 'Lines: 0', BOARD_TOP + 200),
    place(createElement('button', 'restartButton'), {
      left: SIDE_LEFT,
      top: BOARD_TOP + 250,
      width: 140,
      height: 40,
      label: 'Restart',
      script: 'on click\n  send restart to thisPage\nend click\n',
    }),
    label(
      'help',
      '← → move\n↑ turn, Z turn back\n↓ drop faster\nSpace drop\nClick the board first, then use the keys.',
      BOARD_TOP + 310,
      14,
      SIDE_LEFT,
      220,
    ),
    place(
      label(
        'gameOver',
        'Game over',
        BOARD_TOP + (ROWS * CELL) / 2 - 30,
        30,
        BOARD_LEFT,
        COLUMNS * CELL,
      ),
      { visible: false, height: 60 },
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
