// The Tetris game (#1114): a game loop on Folio's `frame` message (ADR 0095),
// driven by arrow keys. NorthTalk source shared by both Tetris Example Projects. Only the painting
// Handlers differ; movement, scoring, timing and input stay here.
export const ROWS = 20;
export const COLUMNS = 10;
export const EMPTY_COLOUR = '#ffffff';

export const TETRIS_LIBRARY = `-- Stateless Tetris calculations shared by both Example Projects.
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

on fits board, shape, atTop, atLeft
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

on isFull row
  repeat for each square in row
    if square = 0 then
      return false
    end if
  end repeat
  return true
end isFull

on dropInterval level
  return max(100, 1000 - 75 * (level - 1))
end dropInterval

on colourOf piece
  if piece = 0 then
    return emptyColour
  end if
  return item piece of colours
end colourOf

on turnedSquares squares, size, clockwise
  put [] into turned
  repeat for each [r, c] in squares
    if clockwise then
      put [c, size + 1 - r] into item (the length of turned + 1) of turned
    else
      put [size + 1 - c, r] into item (the length of turned + 1) of turned
    end if
  end repeat
  return turned
end turnedSquares
`;

export const TETRIS_RULES = `use rows, columns, emptyColour, colours, shapes, boxSizes, linePoints, grid, fits, isFull, dropInterval, colourOf, turnedSquares from tetrisRules

script variable board = []
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
  restart
end openPage

on restart
  put grid(rows, columns, 0) into board
  resetPainting
  put [] into bag
  put 0 into score
  put 0 into lines
  put 1 into level
  put 0 into sinceDrop
  put takeFromBag() into nextKind
  hide gameOverAlert
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
  if not fits(board, squares, pieceTop, pieceLeft) then
    endGame
  end if
end spawnPiece

on tryMove down, across
  if fits(board, squares, pieceTop + down, pieceLeft + across) then
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
  put turnedSquares(squares, size, clockwise) into turned
  if fits(board, turned, pieceTop, pieceLeft) then
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
  show gameOverAlert
end endGame

on frame elapsed
  if not playing then
    return
  end if
  add elapsed to sinceDrop
  if sinceDrop >= dropInterval(level) then
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



-- Lay the falling piece over the board. The renderer paints that view.
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
  beginPaint
  repeat for each r in 1..rows
    repeat for each c in 1..columns
      paintCell r, c, colourOf(item c of item r of view)
    end repeat
  end repeat
end paint

on showPreview
  beginPreview
  repeat for each [r, c] in item nextKind of shapes
    previewCell r, c, item nextKind of colours
  end repeat
end showPreview

on showScore
  set the text of scoreText to "Score: " & score
  set the text of levelText to "Level: " & level
  set the text of linesText to "Lines: " & lines
end showScore
`;
