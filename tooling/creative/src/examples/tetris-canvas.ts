import { createProject } from '../model';
import { type ExampleContent } from './index';
import { CELL, createTetrisPage, PREVIEW_CELL } from './tetris-layout';
import { TETRIS_LIBRARY, TETRIS_RULES, TETRIS_TESTS } from './tetris-rules';

export const CANVAS_TETRIS_PROJECT_NAME = 'Canvas Tetris';

// A whole paint clears the board and draws only filled cells over the
// surface's empty fill. A patch draws over the cells it changes, empty ones
// included, so the retained Drawing grows until the next whole paint.
const CANVAS_PAINTING = `
script variable fresh = false

on resetPainting
  tell canvas
    clear boardCanvas
    stroke boardCanvas, emptyColour
    strokeWidth boardCanvas, 1
    clear previewCanvas
    stroke previewCanvas, emptyColour
    strokeWidth previewCanvas, 1
  end tell
end resetPainting

on beginPaint everyCell
  if everyCell then
    ask canvas to clear boardCanvas
  end if
  put everyCell into fresh
end beginPaint

on paintCell r, c, colour
  drawCell boardCanvas, r, c, colour, ${CELL}
end paintCell

on beginPreview
  ask canvas to clear previewCanvas
  put true into fresh
end beginPreview

on previewCell r, c, colour
  drawCell previewCanvas, r, c, colour, ${PREVIEW_CELL}
end previewCell

on drawCell surface, r, c, colour, size
  if fresh and colour is emptyColour then
    return
  end if
  tell canvas
    fill surface, colour
    rectangle surface, (c - 1) * size, (r - 1) * size, size, size
  end tell
end drawCell
`;

/** Builds the same game with empty Canvas surfaces instead of cell Elements. */
export const createCanvasTetrisProject = async (): Promise<ExampleContent> => {
  const project = createProject(CANVAS_TETRIS_PROJECT_NAME);
  project.libraries = [{ name: 'tetrisRules', source: TETRIS_LIBRARY }];
  project.testScripts = [{ ...TETRIS_TESTS }];
  project.pages = [createTetrisPage(TETRIS_RULES + CANVAS_PAINTING, 'canvas')];
  return { project, assets: new Map() };
};
