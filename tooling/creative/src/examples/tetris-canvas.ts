import { createProject } from '../model';
import { type ExampleContent } from './index';
import { CELL, createTetrisPage, PREVIEW_CELL } from './tetris-layout';
import { TETRIS_LIBRARY, TETRIS_RULES } from './tetris-rules';

export const CANVAS_TETRIS_PROJECT_NAME = 'Canvas Tetris';

// Clear before each changed view and draw only filled cells over the
// surface's empty fill: the retained Drawing stays one frame of filled cells,
// including when Browse starts from the previous game's last frame.
const CANVAS_PAINTING = `
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

on beginPaint
  ask canvas to clear boardCanvas
end beginPaint

on paintCell r, c, colour
  drawCell boardCanvas, r, c, colour, ${CELL}
end paintCell

on beginPreview
  ask canvas to clear previewCanvas
end beginPreview

on previewCell r, c, colour
  drawCell previewCanvas, r, c, colour, ${PREVIEW_CELL}
end previewCell

on drawCell surface, r, c, colour, size
  if colour is emptyColour then
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
  project.pages = [createTetrisPage(TETRIS_RULES + CANVAS_PAINTING, 'canvas')];
  return { project, assets: new Map() };
};
