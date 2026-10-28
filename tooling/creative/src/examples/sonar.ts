// Sonar: a Minesweeper for the sea, drawn on one Canvas from Folio's
// `frame` message (ADR 0095). `click` says where the reader pinged and with
// which button, and `pointerHeld` makes a long press plant a buoy on touch
// screens (ADR 0145).
import {
  createElement,
  createProject,
  DEFAULT_DESIGN_WIDTH,
  type Page,
  type TextElement,
} from '../model';
import { type ExampleContent } from './index';

export const SONAR_PROJECT_NAME = 'Sonar';
export const ROWS = 9;
export const COLUMNS = 9;
export const MINES = 10;
export const CELL = 40;
export const MARGIN = 20;
/** How long a press must last to plant a buoy, in ms. */
export const HOLD_MS = 450;
const SEA_SIZE = MARGIN * 2 + COLUMNS * CELL;
const DEEP = '#03111c';

export const SONAR_LIBRARY = `-- Stateless Sonar calculations: the sea's geometry, counting and flooding.
constant rows = ${ROWS}
constant columns = ${COLUMNS}
constant mineCount = ${MINES}
constant cell = ${CELL}
constant margin = ${MARGIN}
constant hexDigits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]
-- The colour of each count, 1 to 8.
constant countColours = ["#4fd1c5", "#7ee787", "#f9e26b", "#ffa657", "#ff7b72", "#d2a8ff", "#ff9bce", "#ffffff"]

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

-- The [row, column] under a point on the sea, or nothing off the grid.
on cellAt x, y
  if x < margin or y < margin then
    return nothing
  end if
  put (x - margin) div cell + 1 into c
  put (y - margin) div cell + 1 into r
  if r > rows or c > columns then
    return nothing
  end if
  return [r, c]
end cellAt

-- The middle of row or column i, in canvas units.
on centre i
  return margin + (i - 1) * cell + cell / 2
end centre

on neighbours r, c
  put [] into found
  repeat for each dr in -1..1
    repeat for each dc in -1..1
      put r + dr into nr
      put c + dc into nc
      if (dr is not 0 or dc is not 0) and nr >= 1 and nr <= rows and nc >= 1 and nc <= columns then
        put [nr, nc] into item (the length of found + 1) of found
      end if
    end repeat
  end repeat
  return found
end neighbours

on countAround mines, r, c
  put 0 into n
  repeat for each [nr, nc] in neighbours(r, c)
    if item nc of item nr of mines then
      add 1 to n
    end if
  end repeat
  return n
end countAround

-- The cells a ping at [r, c] uncovers, each with its step outwards: the
-- cell itself, and past every cell with no mine around it, its neighbours.
on flood counts, shown, buoys, r, c
  put grid(rows, columns, false) into seen
  put true into item c of item r of seen
  put [[r, c, 0]] into queue
  put 1 into next
  put [] into found
  repeat while next <= the length of queue
    let [qr, qc, step] be item next of queue
    add 1 to next
    put [qr, qc, step] into item (the length of found + 1) of found
    if item qc of item qr of counts = 0 then
      repeat for each [nr, nc] in neighbours(qr, qc)
        if not item nc of item nr of seen and item nc of item nr of shown = 0 and not item nc of item nr of buoys then
          put true into item nc of item nr of seen
          put [nr, nc, step + 1] into item (the length of queue + 1) of queue
        end if
      end repeat
    end if
  end repeat
  return found
end flood

-- A #RRGGBB colour with an opacity from 0 to 1, as #RRGGBBAA.
on alpha colour, amount
  put round(max(0, min(1, amount)) * 255) into n
  return colour & item (n div 16 + 1) of hexDigits & item (n mod 16 + 1) of hexDigits
end alpha

on countColour n
  return item n of countColours
end countColour
`;

export const SONAR_SCRIPT = `use rows, columns, mineCount, cell, margin, grid, cellAt, centre, neighbours, countAround, flood, alpha, countColour from sonarRules

constant holdMs = ${HOLD_MS}
constant pi = 3.14159265
constant sweepRadius = ${SEA_SIZE / 2 - 4}

script variable mines = []
script variable counts = []
-- When each cell was uncovered, on the sonar clock; 0 while hidden.
script variable shown = []
script variable buoys = []
script variable laid = false
-- "diving", "lost" or "won".
script variable state = "diving"
script variable hidden = 0
script variable clock = 0
-- Rings spreading from each ping and buoy: [x, y, start, colour].
script variable rings = []
script variable blast = []
script variable wonAt = 0
-- A long press planted a buoy, so its release isn't also a ping.
script variable planted = false
-- The press being held: [x, y, held, when last heard].
script variable charging = []

on restart
  put grid(rows, columns, false) into mines
  put grid(rows, columns, 0) into counts
  put grid(rows, columns, 0) into shown
  put grid(rows, columns, false) into buoys
  put false into laid
  put "diving" into state
  put rows * columns - mineCount into hidden
  put [] into rings
  put [] into blast
  put false into planted
  put [] into charging
  showStatus
end restart

-- Mines are laid after the first ping, never on or beside it.
on layMines safeRow, safeColumn
  put 0 into placed
  repeat while placed < mineCount
    put random(rows) into r
    put random(columns) into c
    if not item c of item r of mines and (abs(r - safeRow) > 1 or abs(c - safeColumn) > 1) then
      put true into item c of item r of mines
      add 1 to placed
    end if
  end repeat
  repeat for each r in 1..rows
    repeat for each c in 1..columns
      put countAround(mines, r, c) into item c of item r of counts
    end repeat
  end repeat
  put true into laid
end layMines

on click {button: 2, x, y}
  plantAt x, y
end click

on click {button: 0, x, y}
  if planted then
    put false into planted
  else
    pingAt x, y
  end if
end click

on pointerHeld {held, x, y} where held >= holdMs and not planted
  put true into planted
  put [] into charging
  plantAt x, y
end pointerHeld

on pointerHeld {held, x, y}
  if not planted then
    put [x, y, held, clock] into charging
  end if
end pointerHeld

on pingAt x, y
  put cellAt(x, y) into spot
  if state is not "diving" or spot is nothing then
    return
  end if
  let [r, c] be spot
  if item c of item r of buoys or item c of item r of shown > 0 then
    return
  end if
  if not laid then
    layMines r, c
  end if
  put [x, y, clock, "#4fd1c5"] into item (the length of rings + 1) of rings
  if item c of item r of mines then
    sink r, c
    return
  end if
  repeat for each [fr, fc, step] in flood(counts, shown, buoys, r, c)
    put clock + step * 45 + 1 into item fc of item fr of shown
    subtract 1 from hidden
  end repeat
  if hidden = 0 then
    surface
  end if
  showStatus
end pingAt

on plantAt x, y
  put cellAt(x, y) into spot
  if state is not "diving" or spot is nothing then
    return
  end if
  let [r, c] be spot
  if item c of item r of shown > 0 then
    return
  end if
  put not item c of item r of buoys into item c of item r of buoys
  put [centre(c), centre(r), clock, "#ffb347"] into item (the length of rings + 1) of rings
  showStatus
end plantAt

-- A mine: a shockwave from it, then every mine shows, nearest first.
on sink r, c
  put "lost" into state
  put [r, c, clock] into blast
  repeat for each mr in 1..rows
    repeat for each mc in 1..columns
      if item mc of item mr of mines then
        put clock + 1 + 90 * max(abs(mr - r), abs(mc - c)) into item mc of item mr of shown
      end if
    end repeat
  end repeat
  showStatus
end sink

-- Every safe cell is uncovered: buoys mark the mines and light sweeps out.
on surface
  put "won" into state
  put clock into wonAt
  repeat for each r in 1..rows
    repeat for each c in 1..columns
      if item c of item r of mines then
        put true into item c of item r of buoys
      end if
    end repeat
  end repeat
end surface

on showStatus
  if state is "lost" then
    set the text of statusText to "Hull breached. Try a new dive."
  else if state is "won" then
    set the text of statusText to "Sea cleared. Every mine is marked."
  else
    put 0 into marked
    repeat for each row in buoys
      repeat for each buoy in row
        if buoy then
          add 1 to marked
        end if
      end repeat
    end repeat
    set the text of statusText to (mineCount - marked) & " mines left"
  end if
end showStatus

on frame elapsed
  if the length of mines = 0 then
    restart
  end if
  add elapsed to clock
  draw
end frame

on draw
  put margin + columns * cell / 2 into mid
  ask canvas to background sea, "${DEEP}"
  drawScope mid
  repeat for each r in 1..rows
    repeat for each c in 1..columns
      drawCell r, c
    end repeat
  end repeat
  drawRings
  drawCharge
  if state is "lost" then
    drawBlast
  else if state is "won" then
    drawWin mid
  end if
end draw

-- Range rings and a sweep turning once every five seconds.
on drawScope mid
  tell canvas
    noFill sea
    stroke sea, "#0e3a52"
    strokeWidth sea, 1
    circle sea, mid, mid, sweepRadius * 2
    circle sea, mid, mid, sweepRadius * 4 / 3
    circle sea, mid, mid, sweepRadius * 2 / 3
  end tell
  put clock / 5000 * 2 * pi into angle
  tell canvas
    noStroke sea
    fill sea, alpha("#4fd1c5", 0.12)
    arc sea, mid, mid, sweepRadius * 2, sweepRadius * 2, angle - 0.7, angle
    stroke sea, alpha("#4fd1c5", 0.5)
    strokeWidth sea, 2
    line sea, mid, mid, mid + sweepRadius * cos(angle), mid + sweepRadius * sin(angle)
  end tell
end drawScope

on drawCell r, c
  put margin + (c - 1) * cell + 2 into x
  put margin + (r - 1) * cell + 2 into y
  put centre(c) into cx
  put centre(r) into cy
  put item c of item r of shown into at
  if at = 0 or at > clock then
    tell canvas
      noStroke sea
      fill sea, alpha("#155079", 0.9)
      roundedRectangle sea, x, y, cell - 4, cell - 4, 6
    end tell
    if item c of item r of buoys then
      drawBuoy cx, cy
    end if
    return
  end if
  put clock - at into age
  if state is "won" then
    ask canvas to fill sea, "#0a3b2a"
  else
    ask canvas to fill sea, "#061a28"
  end if
  tell canvas
    noStroke sea
    roundedRectangle sea, x, y, cell - 4, cell - 4, 6
  end tell
  if item c of item r of mines then
    drawMine cx, cy
  else if item c of item r of buoys then
    drawBuoy cx, cy
  else if item c of item r of counts > 0 then
    tell canvas
      fill sea, countColour(item c of item r of counts)
      textSize sea, 20
      text sea, item c of item r of counts & "", cx - 6, cy + 7
    end tell
  end if
  -- A ripple as the cell comes up.
  if age < 320 then
    tell canvas
      noFill sea
      stroke sea, alpha("#4fd1c5", 1 - age / 320)
      strokeWidth sea, 2
      circle sea, cx, cy, 8 + age / 320 * 44
    end tell
  end if
end drawCell

on drawBuoy cx, cy
  tell canvas
    stroke sea, "#ffe6c2"
    strokeWidth sea, 2
    line sea, cx, cy - 4, cx, cy - 14
    noStroke sea
    fill sea, "#ffb347"
    circle sea, cx, cy + 2, 16
    fill sea, alpha("#ffb347", 0.25 + 0.2 * sin(clock / 300))
    circle sea, cx, cy + 2, 28
  end tell
end drawBuoy

on drawMine cx, cy
  tell canvas
    stroke sea, "#ff5d5d"
    strokeWidth sea, 3
    line sea, cx - 11, cy, cx + 11, cy
    line sea, cx, cy - 11, cx, cy + 11
    line sea, cx - 8, cy - 8, cx + 8, cy + 8
    line sea, cx - 8, cy + 8, cx + 8, cy - 8
    noStroke sea
    fill sea, "#ff5d5d"
    circle sea, cx, cy, 16
  end tell
end drawMine

on drawRings
  put [] into kept
  repeat for each [x, y, start, colour] in rings
    put clock - start into age
    if age < 900 then
      put [x, y, start, colour] into item (the length of kept + 1) of kept
      tell canvas
        noFill sea
        stroke sea, alpha(colour, 1 - age / 900)
        strokeWidth sea, 3
        circle sea, x, y, 10 + age / 900 * 280
      end tell
    end if
  end repeat
  put kept into rings
end drawRings

-- A ring fills while a press is held, and plants a buoy when it closes.
on drawCharge
  if the length of charging = 0 then
    return
  end if
  let [x, y, held, heard] be charging
  if clock - heard > 100 then
    put [] into charging
    return
  end if
  tell canvas
    noFill sea
    stroke sea, "#ffb347"
    strokeWidth sea, 4
    arc sea, x, y, 52, 52, 0 - pi / 2, 0 - pi / 2 + 2 * pi * min(1, held / holdMs)
  end tell
end drawCharge

on drawBlast
  let [r, c, start] be blast
  put clock - start into age
  if age < 600 then
    tell canvas
      noStroke sea
      fill sea, alpha("#ff2e2e", 0.4 * (1 - age / 600))
      rectangle sea, 0, 0, ${SEA_SIZE}, ${SEA_SIZE}
    end tell
  end if
  if age < 1600 then
    tell canvas
      noFill sea
      stroke sea, alpha("#ff5d5d", 1 - age / 1600)
      strokeWidth sea, 6
      circle sea, centre(c), centre(r), age * 0.7
      strokeWidth sea, 2
      circle sea, centre(c), centre(r), age * 0.45
    end tell
  end if
end drawBlast

on drawWin mid
  put clock - wonAt into age
  if age < 2000 then
    tell canvas
      noFill sea
      stroke sea, alpha("#7ee787", 1 - age / 2000)
      strokeWidth sea, 8
      circle sea, mid, mid, age * 0.5
    end tell
  end if
end drawWin
`;

/**
 * The Test Script Sonar ships (ADR 0133). The seed is fixed, so where the
 * mines go is the same in every run; the tests read only what a reader
 * sees in the status line.
 */
export const SONAR_TESTS = {
  name: 'sonar.test',
  source: `use assert, assertEqual from test

-- The first ping is never a mine, and opens the sea around it.
on testFirstPingIsSafe
  ask harness to click "sea", {x: ${MARGIN + CELL * 4 + 20}, y: ${MARGIN + CELL * 4 + 20}} and wait
  ask harness to frame 16 ms and wait
  ask harness to property "text", "statusText"
  assertEqual(it, "${MINES} mines left")
end testFirstPingIsSafe

on testRightClickPlantsABuoy
  ask harness to click "sea", {button: 2, x: ${MARGIN + 20}, y: ${MARGIN + 20}} and wait
  ask harness to property "text", "statusText"
  assertEqual(it, "${MINES - 1} mines left")
  ask harness to click "sea", {button: 2, x: ${MARGIN + 20}, y: ${MARGIN + 20}} and wait
  ask harness to property "text", "statusText"
  assertEqual(it, "${MINES} mines left")
end testRightClickPlantsABuoy

-- Holding plants a buoy, and letting go doesn't also ping.
on testHoldPlantsABuoy
  ask harness to hold "sea", ${HOLD_MS + 50} ms and wait
  ask harness to property "text", "statusText"
  assertEqual(it, "${MINES - 1} mines left")
end testHoldPlantsABuoy

on testPingsOffTheGridDoNothing
  ask harness to click "sea", {x: 2, y: 2} and wait
  ask harness to property "text", "statusText"
  assertEqual(it, "${MINES} mines left")
end testPingsOffTheGridDoNothing

on testNewDiveStartsAgain
  ask harness to click "sea", {button: 2, x: ${MARGIN + 20}, y: ${MARGIN + 20}} and wait
  ask harness to click "newDive" and wait
  ask harness to property "text", "statusText"
  assertEqual(it, "${MINES} mines left")
end testNewDiveStartsAgain
`,
};

const SANS = 'system-ui, sans-serif';

// A line of centred text across the Page.
const line = (
  name: string,
  value: string,
  top: number,
  size: number,
  colour: string,
  bold = false,
): TextElement =>
  Object.assign(createElement('text', name) as TextElement, {
    left: 0,
    top,
    width: DEFAULT_DESIGN_WIDTH,
    height: Math.ceil(size * 1.5),
    textSize: size,
    textColor: colour,
    font: SANS,
    richText: [{ align: 'center' as const, runs: [{ text: value, bold }] }],
  });

const createSonarPage = (): Page => {
  const left = (DEFAULT_DESIGN_WIDTH - SEA_SIZE) / 2;
  const top = 96;
  const sea = createElement('canvas', 'sea');
  Object.assign(sea, {
    left,
    top,
    width: SEA_SIZE,
    height: SEA_SIZE,
    fill: DEEP,
    script: SONAR_SCRIPT,
  });
  const newDive = createElement('button', 'newDive');
  Object.assign(newDive, {
    left: (DEFAULT_DESIGN_WIDTH - 140) / 2,
    top: top + SEA_SIZE + 52,
    width: 140,
    height: 36,
    label: 'New dive',
    fill: '#0b2e45',
    textColor: '#4fd1c5',
    script: 'on click {button: 0}\n  send restart to sea\nend click\n',
  });
  return {
    name: 'sonar',
    background: '#010a12',
    height: top + SEA_SIZE + 120,
    elements: [
      line('title', 'S O N A R', 22, 30, '#4fd1c5', true),
      line(
        'help',
        `Click to ping. Right-click, or hold for a moment, to plant a buoy on a mine.`,
        66,
        13,
        '#7fa7bf',
      ),
      sea,
      line(
        'statusText',
        `${MINES} mines left`,
        top + SEA_SIZE + 14,
        16,
        '#ffb347',
      ),
      newDive,
    ],
  };
};

/** Builds Sonar: one Canvas, its rules in a Library, and its tests. */
export const createSonarProject = async (): Promise<ExampleContent> => {
  const project = createProject(SONAR_PROJECT_NAME);
  project.libraries = [{ name: 'sonarRules', source: SONAR_LIBRARY }];
  project.testScripts = [{ ...SONAR_TESTS }];
  project.pages = [createSonarPage()];
  return { project, assets: new Map() };
};
