import { createProject } from '../model';
import { type ExampleContent } from './index';
import { createTetrisPage } from './tetris-layout';
import { TETRIS_RULES } from './tetris-rules';

export const TETRIS_PROJECT_NAME = 'Tetris';

// The Element renderer only changes cells whose colour differs from the
// last view. The rules call these same painting Handlers in both examples.
const ELEMENT_PAINTING = `
script variable shown = []

on resetPainting
  put grid(rows, columns, "") into shown
end resetPainting

on beginPaint
end beginPaint

on paintCell r, c, colour
  if colour is not item c of item r of shown then
    set the fill of element ("cell_" & r & "_" & c) of thisPage to colour
    put colour into item c of item r of shown
  end if
end paintCell

on beginPreview
  repeat for each r in 1..4
    repeat for each c in 1..4
      previewCell r, c, emptyColour
    end repeat
  end repeat
end beginPreview

on previewCell r, c, colour
  set the fill of element ("next_" & r & "_" & c) of thisPage to colour
end previewCell
`;

/** Builds Tetris with 200 pre-placed board cells and a 4x4 preview. */
export const createTetrisProject = async (): Promise<ExampleContent> => {
  const project = createProject(TETRIS_PROJECT_NAME);
  project.pages = [
    createTetrisPage(TETRIS_RULES + ELEMENT_PAINTING, 'elements'),
  ];
  return { project, assets: new Map() };
};
