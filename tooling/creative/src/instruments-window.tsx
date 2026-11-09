// The Instruments window (#2049, #2079): every Project Instrument as a list
// with a `+ ▾` menu to add or duplicate one and `−` to remove it, then the
// selected one's name, voices and parameters in collapsible groups of
// compact rows, with ▶ and the computer keyboard to audition it (#2080).
// Independent of the Page's selection. It stays open while browsing (ADR 0174):
// a change there is still an authored edit, which the running Instrument
// hears straight away, and each row shows the playing value a Script's `set`
// gave it, with a tick at the saved one.
import type { ReadonlySignal, Signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { isTyping } from './dom';
import type { DeepReadonly } from './readonly';
import type { StackEditor } from './editing';
import { field } from './elements/controls';
import type { Instrument, Project } from './model';
import type { InstrumentChange } from './tree/project-tree';
import {
  parameterProblem,
  type GroupView,
  type ParameterDefinition,
  type ParameterValue,
} from './instruments/kind';
import { draggedHandle, viewPicture } from './instruments/group-views';
import {
  draggedPosition,
  formatParameter,
  sliderPosition,
  sliderValue,
  steppedValue,
  type NumberParameter,
} from './instruments/parameter-sliders';
import { parameterTextNumber } from './instruments/parameter-units';
import { INSTRUMENT_KINDS, instrumentKindNames } from './instruments/registry';
import { samplerEngine } from './instruments/sampler';
import {
  auditionMessages,
  auditionSound,
  canAudition,
  isSampler,
  KEYBOARD_OCTAVE,
  keyboardNote,
  keyboardOctave,
  noteOff,
  noteOn,
  projectSounds,
} from './instruments/audition';
import {
  holdInstruments,
  previewInstruments,
  type HeldPreview,
  type SoundBytes,
} from './instruments/preview';
import type { PlayingParameters } from './instruments/live';
import { boundControls } from './bindings';
import type { PlayMode } from './stack';
import { pageAddOns } from './add-ons/page';
import { offeredInstrumentKinds } from './add-ons/offered';

type InstrumentsProps = {
  /** Adds an Instrument of `kind`, loading its Add-on first. */
  add(kind: string): void;
  /**
   * Applies checked changes as one undoable step; a refusal shows a notice
   * and applies none.
   */
  change(
    id: number,
    change: InstrumentChange | readonly InstrumentChange[],
  ): void;
  duplicate(id: number): void;
  editor: StackEditor;
  /**
   * Sends a parameter to the running Instrument while it is dragged, before
   * the drag commits it (#2081).
   */
  live(id: number, parameter: string, value: ParameterValue): void;
  /** An audition that can't sound, such as a sound that won't decode. */
  onError(message: string): void;
  /** How Play runs, if it does; the window stays live while browsing. */
  playing: ReadonlySignal<PlayMode | undefined>;
  /** The parameters as they play while browsing. */
  playingParameters: ReadonlySignal<PlayingParameters | undefined>;
  redo(): void;
  /** Bumped by the shell's redraw, such as after undo or read-only. */
  redraw: ReadonlySignal<number>;
  remove(id: number): void;
  /** The selected Instrument's id; the first one when unset or gone. */
  selected: Signal<number | undefined>;
  /** A sound asset's bytes, for a sampler's audition. */
  soundBytes: SoundBytes;
  undo(): void;
};

/** `envelopePeriod` as `Envelope period`. */
const parameterLabel = (name: string): string => {
  const words = name.replaceAll(/([A-Z])/gu, ' $1').toLowerCase();
  return words[0]!.toUpperCase() + words.slice(1);
};

/** A parameter's label with its Unit, such as `Cutoff (Hz)`. */
const accessibleLabel = (name: string, definition: ParameterDefinition) =>
  definition.shape === 'number' && definition.unit
    ? `${parameterLabel(name)} (${definition.unit})`
    : parameterLabel(name);

// Which groups are collapsed, remembered per browser.
const COLLAPSED_KEY = 'northtalk-creative-collapsed-instrument-groups';
const readCollapsed = (): Set<string> => {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[],
    );
  } catch {
    return new Set();
  }
};
const writeCollapsed = (collapsed: ReadonlySet<string>) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage may be unavailable; groups then open each time.
  }
};

/** A parameter's value as a Script writes it, such as `5 ms` or `"saw"`. */
const scriptValue = (definition: ParameterDefinition, value: ParameterValue) =>
  definition.shape === 'number'
    ? formatParameter(definition, Number(value))
    : definition.shape === 'text'
      ? `"${String(value)}"`
      : String(value);

const setLine = (
  instrument: string,
  name: string,
  definition: ParameterDefinition,
  value: ParameterValue,
) => `set the ${name} of ${instrument} to ${scriptValue(definition, value)}`;

type RowProps = {
  /** The controls bound to this parameter, which a 🔗 names. */
  bound?: readonly string[];
  definition: ParameterDefinition;
  disabled: boolean;
  /** Sends a dragged value to the running Instrument, during Play. */
  live?(value: ParameterValue): void;
  name: string;
  /** The value as it plays, during Play; the thumb shows it. */
  playing?: ParameterValue;
  /** After a slider is let go or a typed value committed. */
  released(): void;
  /** Sets the parameter, or resets it to its default. */
  set(value: ParameterValue): void;
  value: ParameterValue;
};

/**
 * A number parameter's slider: a drag moves it from where it's pressed,
 * ⇧ makes a drag or arrow key ten times finer, and a double-click or
 * ⌥-click resets it. It commits once, when the drag ends.
 */
const Slider = ({
  definition,
  disabled,
  live,
  name,
  playing,
  released,
  set,
  value,
}: RowProps) => {
  const number = definition as NumberParameter;
  // The drag under way: where the slider is and the pointer's last x.
  const [drag, setDragState] = useState<
    { position: number; x: number } | undefined
  >(undefined);
  // Pointer moves can outrun a redraw, so each reads the drag from here.
  const dragRef = useRef(drag);
  const setDrag = (next: typeof drag) => {
    dragRef.current = next;
    setDragState(next);
  };
  const shown =
    drag === undefined
      ? Number(playing ?? value)
      : sliderValue(number, drag.position);
  const position = sliderPosition(number, shown);
  // A Script's set moved the playing value away from the saved one.
  const saved =
    drag === undefined && playing !== undefined && playing !== value
      ? sliderPosition(number, Number(value))
      : undefined;
  const reset = () => set(number.default);
  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={accessibleLabel(name, definition)}
      aria-valuemax={number.max}
      aria-valuemin={number.min}
      aria-valuenow={shown}
      aria-valuetext={formatParameter(number, shown)}
      className="slider"
      data-parameter={name}
      onClick={event => {
        if (!disabled && event.detail === 2) {
          reset();
        }
      }}
      onKeyDown={event => {
        if (disabled) {
          return;
        }
        const steps = {
          ArrowRight: 1,
          ArrowUp: 1,
          ArrowLeft: -1,
          ArrowDown: -1,
          PageUp: 10,
          PageDown: -10,
        }[event.key];
        const next =
          event.key === 'Home'
            ? number.min
            : event.key === 'End'
              ? number.max
              : steps === undefined
                ? undefined
                : steppedValue(number, shown, steps, event.shiftKey);
        if (next !== undefined) {
          event.preventDefault();
          set(next);
        }
      }}
      onPointerDown={event => {
        if (disabled || event.button !== 0) {
          return;
        }
        if (event.altKey) {
          reset();
          return;
        }
        const track = event.currentTarget;
        const rect = track.getBoundingClientRect();
        // A press jumps to where it lands; ⇧ keeps the value and only drags.
        const start = event.shiftKey
          ? position
          : draggedPosition(
              0,
              event.clientX - rect.left,
              rect.width || 1,
              false,
            );
        try {
          track.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser doesn't know, such as a synthetic one.
        }
        setDrag({ position: start, x: event.clientX });
        live?.(sliderValue(number, start));
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        const { clientX, shiftKey } = event;
        const width = event.currentTarget.getBoundingClientRect().width || 1;
        const next = {
          position: draggedPosition(
            drag.position,
            clientX - drag.x,
            width,
            shiftKey,
          ),
          x: clientX,
        };
        setDrag(next);
        if (next.position !== drag.position) {
          live?.(sliderValue(number, next.position));
        }
      }}
      onPointerUp={() => {
        const drag = dragRef.current;
        if (drag) {
          setDrag(undefined);
          set(sliderValue(number, drag.position));
          released();
        }
      }}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      title={definition.description}
    >
      <span className="slider-fill" style={{ width: `${position * 100}%` }} />
      {saved !== undefined && (
        <span
          className="slider-saved"
          data-saved-value={String(value)}
          style={{ left: `${saved * 100}%` }}
          title={`Saved: ${formatParameter(number, Number(value))}`}
        />
      )}
    </div>
  );
};

/** The typed value beside a slider, which takes a Quantity such as `5 ms`. */
const ValueField = ({
  definition,
  disabled,
  name,
  playing,
  released,
  set,
  value,
}: RowProps) => {
  const number = definition as NumberParameter;
  const text = formatParameter(number, Number(playing ?? value));
  return (
    <input
      aria-label={`${accessibleLabel(name, definition)} value`}
      autoComplete="off"
      className="slider-value"
      data-parameter-value={name}
      disabled={disabled}
      onChange={event => {
        const input = event.currentTarget;
        const typed = parameterTextNumber(number, input.value);
        if (typed !== undefined) {
          set(typed);
          released();
        }
        // A refused or unreadable value goes back to what's stored.
        input.value = text;
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
      }}
      spellcheck={false}
      type="text"
      value={text}
    />
  );
};

const ParameterRow = (props: RowProps & { onHover(line?: string): void }) => {
  const { definition, disabled, name, set } = props;
  const value = props.playing ?? props.value;
  const label = parameterLabel(name);
  const control = (() => {
    switch (definition.shape) {
      case 'number':
        return (
          <>
            <Slider {...props} />
            <ValueField {...props} />
          </>
        );
      case 'text':
        if (!definition.choices) {
          return (
            <input
              aria-label={label}
              autoComplete="off"
              className="parameter-text"
              data-parameter={name}
              disabled={disabled}
              onChange={event => {
                const input = event.currentTarget;
                if (parameterProblem(definition, input.value) === undefined) {
                  set(input.value.trim());
                } else {
                  // A refused text goes back to what's stored.
                  input.value = String(value);
                }
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
              spellcheck={false}
              title={definition.description}
              type="text"
              value={String(value)}
            />
          );
        }
        return (
          <div
            aria-label={label}
            className="segmented"
            data-parameter={name}
            role="radiogroup"
            title={definition.description}
          >
            {definition.choices.map(choice => (
              <button
                aria-checked={choice === value}
                data-choice={choice}
                disabled={disabled}
                key={choice}
                onClick={() => set(choice)}
                role="radio"
                type="button"
              >
                {choice}
              </button>
            ))}
          </div>
        );
      case 'boolean':
        return (
          <input
            aria-label={label}
            checked={Boolean(value)}
            className="toggle"
            data-parameter={name}
            disabled={disabled}
            onChange={event => set(event.currentTarget.checked)}
            role="switch"
            title={definition.description}
            type="checkbox"
          />
        );
    }
  })();
  return (
    <div
      className={`parameter-row ${definition.shape}`}
      data-parameter-row={name}
      onMouseEnter={() => props.onHover(name)}
      onMouseLeave={() => props.onHover(undefined)}
    >
      <span className="parameter-label" title={definition.description}>
        {label}
        {props.bound?.length ? (
          <span
            aria-label={`Bound to ${props.bound.join(', ')}`}
            className="parameter-bound"
            data-parameter-bound={props.bound.join(',')}
            title={`Bound to ${props.bound.join(', ')}`}
          >
            🔗
          </span>
        ) : null}
      </span>
      {control}
    </div>
  );
};

type GroupPictureProps = {
  disabled: boolean;
  group: string;
  /** Sends dragged values to the running Instrument, during Play. */
  live?(values: Record<string, number>): void;
  parameters: Readonly<Record<string, ParameterDefinition>>;
  /** After a drag is let go. */
  released(): void;
  /** Sets the dragged parameters together, as one change. */
  set(values: Record<string, number>): void;
  values: Readonly<Record<string, ParameterValue>>;
  view: GroupView;
};

const PICTURE_WIDTH = 200;
const PICTURE_HEIGHT = 56;
const PICTURE_PAD = 5;

/**
 * A group's picture (#2084), such as an envelope's shape, whose handles
 * drag the same parameters as its sliders. It commits once, when a drag
 * ends; the sliders stay the way to set them by keyboard.
 */
const GroupPicture = (props: GroupPictureProps) => {
  const { view, parameters } = props;
  const [drag, setDrag] = useState<
    { handle: string; values: Record<string, number> } | undefined
  >(undefined);
  const values = drag ? { ...props.values, ...drag.values } : props.values;
  const picture = viewPicture(view, parameters, values);
  const w = PICTURE_WIDTH - 2 * PICTURE_PAD;
  const h = PICTURE_HEIGHT - 2 * PICTURE_PAD;
  const px = (x: number) => PICTURE_PAD + x * w;
  const py = (y: number) => PICTURE_PAD + (1 - y) * h;
  const unit = (event: PointerEvent, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    return {
      x:
        ((event.clientX - rect.left) * (PICTURE_WIDTH / (rect.width || 1)) -
          PICTURE_PAD) /
        w,
      y:
        1 -
        ((event.clientY - rect.top) * (PICTURE_HEIGHT / (rect.height || 1)) -
          PICTURE_PAD) /
          h,
    };
  };
  const path = picture.line
    .map(
      (p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)} ${py(p.y).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      aria-disabled={props.disabled || undefined}
      aria-label={`${props.group} ${view.view}`}
      className="group-picture"
      data-view={view.view}
      onPointerMove={event => {
        if (!drag) {
          return;
        }
        const point = unit(event, event.currentTarget);
        const values = draggedHandle(
          view,
          parameters,
          props.values,
          drag.handle,
          point,
        );
        setDrag({ handle: drag.handle, values });
        props.live?.(values);
      }}
      onPointerUp={() => {
        if (drag) {
          setDrag(undefined);
          props.set(drag.values);
          props.released();
        }
      }}
      role="img"
      viewBox={`0 0 ${PICTURE_WIDTH} ${PICTURE_HEIGHT}`}
    >
      <path className="group-picture-line" d={path} />
      {picture.handles.map(handle => (
        <circle
          className="group-picture-handle"
          cx={px(handle.x)}
          cy={py(handle.y)}
          data-handle={handle.id}
          key={handle.id}
          onPointerDown={event => {
            if (props.disabled || event.button !== 0) {
              return;
            }
            event.preventDefault();
            const svg = event.currentTarget.ownerSVGElement!;
            try {
              svg.setPointerCapture(event.pointerId);
            } catch {
              // A pointer the browser doesn't know, such as a synthetic one.
            }
            setDrag({ handle: handle.id, values: {} });
          }}
          r={4}
        />
      ))}
    </svg>
  );
};

/** Parameters by group, ungrouped ones first under no title. */
const grouped = (parameters: Readonly<Record<string, ParameterDefinition>>) => {
  const groups = new Map<string, [string, ParameterDefinition][]>([['', []]]);
  for (const entry of Object.entries(parameters)) {
    const group = entry[1].group ?? '';
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  return [...groups].filter(([, entries]) => entries.length);
};

/** The `+ ▾` menu: every offered kind, then Duplicate. */
const AddMenu = ({
  add,
  disabled,
  duplicate,
  kinds,
}: {
  add(kind: string): void;
  disabled: boolean;
  duplicate?: () => void;
  kinds: readonly { kind: string; label: string }[];
}) => {
  const [open, setOpen] = useState(false);
  const choose = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div className="add-menu">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Add Instrument"
        data-add-menu=""
        disabled={disabled}
        onClick={() => setOpen(!open)}
        type="button"
      >
        + ▾
      </button>
      {open && (
        <div
          className="menu"
          onKeyDown={event => event.key === 'Escape' && setOpen(false)}
          role="menu"
        >
          {/* A listed Add-on's kinds load when one is added (#1901). */}
          {kinds.map(({ kind, label }) => (
            <button
              data-add-instrument={kind}
              key={kind}
              onClick={choose(() => add(kind))}
              role="menuitem"
              type="button"
            >
              {label}
            </button>
          ))}
          <hr />
          <button
            data-duplicate-instrument=""
            disabled={!duplicate}
            onClick={choose(() => duplicate?.())}
            role="menuitem"
            type="button"
          >
            Duplicate <kbd>⌘D</kbd>
          </button>
        </div>
      )}
    </div>
  );
};

/** The Script lines the hint shows for `instrument`. */
const hintLines = (
  instrument: DeepReadonly<Instrument>,
  hovered: string | undefined,
): string[] => {
  const kind = INSTRUMENT_KINDS.get(instrument.kind);
  const play =
    instrument.kind === samplerEngine.name
      ? `tell ${instrument.name} to play "kick"`
      : `tell ${instrument.name} to play 60`;
  if (!kind) {
    return [play];
  }
  const parameters = Object.entries(kind.parameters);
  const [name, definition] =
    parameters.find(([each]) => each === hovered) ??
    parameters.find(([each]) => each === 'cutoff') ??
    parameters.find(([, each]) => each.shape === 'number') ??
    parameters[0] ??
    [];
  return name && definition
    ? [
        play,
        setLine(
          instrument.name,
          name,
          definition,
          instrument.parameters[name] ?? definition.default,
        ),
      ]
    : [play];
};

const Hint = ({ lines }: { lines: string[] }) => (
  <div className="instrument-hint">
    <code data-instrument-hint="">{lines.join('\n')}</code>
    <button
      aria-label="Copy the example"
      onClick={() => void navigator.clipboard?.writeText(lines.join('\n'))}
      title="Copy"
      type="button"
    >
      ⧉
    </button>
  </div>
);

/** Selects the Instrument `id` in the window. */
const selectInstrument = (
  selected: Signal<number | undefined>,
  id: number | undefined,
) => {
  selected.value = id;
};

type AuditionProps = {
  /** The sound chosen for each sampler, by Instrument id. */
  choose(sound: string): void;
  chosen: ReadonlyMap<number, string>;
  instrument: DeepReadonly<Instrument>;
  keyboard: boolean;
  play(): void;
  project: DeepReadonly<Project>;
  replay: boolean;
  setKeyboard(on: boolean): void;
  setReplay(on: boolean): void;
};

const NO_SOUNDS = 'The Project has no sounds for the sampler to play';

/** ▶, a sampler's sound, the keyboard button and the replay toggle. */
const Audition = (props: AuditionProps) => {
  const { instrument, project } = props;
  const sampler = isSampler(instrument);
  const sounds = sampler ? projectSounds(project) : [];
  const sound = auditionSound(project, props.chosen.get(instrument.id!));
  const silent = sampler && sound === undefined;
  return (
    <div className="audition">
      <button
        aria-label="Play a test note"
        data-audition=""
        disabled={silent}
        onClick={props.play}
        title={silent ? NO_SOUNDS : 'Play a test note'}
        type="button"
      >
        ▶
      </button>
      {sampler && sounds.length > 0 && (
        <select
          aria-label="Sound to play"
          data-audition-sound=""
          onChange={event => props.choose(event.currentTarget.value)}
          value={sound}
        >
          {sounds.map(each => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      )}
      <button
        aria-label="Play from the computer keyboard"
        aria-pressed={props.keyboard}
        data-audition-keyboard=""
        disabled={silent}
        onClick={() => props.setKeyboard(!props.keyboard)}
        title={
          silent
            ? NO_SOUNDS
            : 'Play from the computer keyboard: A–K white keys, W E T Y U black keys, Z and X an octave down or up'
        }
        type="button"
      >
        ⌨
      </button>
      <label
        className="check"
        title="Play the note again when a slider is let go or a value typed"
      >
        <input
          checked={props.replay}
          data-audition-replay=""
          onChange={event => props.setReplay(event.currentTarget.checked)}
          type="checkbox"
        />
        Replay
      </label>
    </div>
  );
};

/**
 * While `on`, keys pressed in `root` play the Instrument `id` through audio
 * held open for them. It turns off when `root` or the page loses focus.
 */
const usePianoKeyboard = (
  on: boolean,
  id: number | undefined,
  options: {
    chosen: ReadonlyMap<number, string>;
    editor: StackEditor;
    off(): void;
    onError(message: string): void;
    root: HTMLElement;
    soundBytes: SoundBytes;
  },
) => {
  // Keys read the latestRef options without starting over.
  const latestRef = useRef(options);
  useEffect(() => {
    latestRef.current = options;
  });
  useEffect(() => {
    if (!on || id === undefined) {
      return;
    }
    const { editor, off, root } = latestRef.current;
    let held: HeldPreview | undefined;
    let heldProject: unknown;
    let octave = KEYBOARD_OCTAVE;
    // The note each key down is playing, by key code.
    const down = new Map<string, number>();
    const target = () => {
      const { project } = editor;
      const instrument = project.instruments.find(i => i.id === id);
      return instrument && { instrument, project };
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target)
      ) {
        return;
      }
      const nextOctave = keyboardOctave(event.code, octave);
      const note = keyboardNote(event.code, octave);
      if (nextOctave === undefined && note === undefined) {
        return;
      }
      // The page's own shortcuts don't see a played key.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) {
        return;
      }
      if (nextOctave !== undefined) {
        octave = nextOctave;
        return;
      }
      const now = target();
      if (note === undefined || !now || down.has(event.code)) {
        return;
      }
      const { chosen, onError, soundBytes } = latestRef.current;
      const sound = auditionSound(now.project, chosen.get(id));
      if (isSampler(now.instrument) && sound === undefined) {
        return;
      }
      // An edit since the audio opened needs audio with its parameters.
      if (!held?.open() || heldProject !== now.project) {
        held?.close();
        held = holdInstruments(
          now.project,
          soundBytes,
          onError,
          sound === undefined ? [] : [sound],
        );
        heldProject = now.project;
      }
      down.set(event.code, note);
      held.send(noteOn(now.instrument, note, sound));
    };
    const keyup = (event: KeyboardEvent) => {
      const note = down.get(event.code);
      if (note === undefined) {
        return;
      }
      down.delete(event.code);
      event.stopPropagation();
      const now = target();
      if (now && held?.open()) {
        held.send(noteOff(now.instrument, note));
      }
    };
    const focusout = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) {
        off();
      }
    };
    root.addEventListener('keydown', keydown);
    root.addEventListener('keyup', keyup);
    root.addEventListener('focusout', focusout);
    window.addEventListener('blur', off);
    return () => {
      root.removeEventListener('keydown', keydown);
      root.removeEventListener('keyup', keyup);
      root.removeEventListener('focusout', focusout);
      window.removeEventListener('blur', off);
      held?.close();
    };
  }, [on, id]);
};

/**
 * While browsing, ⌘Z and ⇧⌘Z in the window undo and redo, which the
 * running Instruments hear too (#2081); Edit's own shortcuts are off in Play.
 */
const useBrowseUndo = (
  on: boolean,
  props: { redo(): void; root: HTMLElement; undo(): void },
) => {
  const latestRef = useRef(props);
  useEffect(() => {
    latestRef.current = props;
  });
  useEffect(() => {
    if (!on) {
      return;
    }
    const { root } = latestRef.current;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'z' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        isTyping(event.target)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        latestRef.current.redo();
      } else {
        latestRef.current.undo();
      }
    };
    root.addEventListener('keydown', keydown);
    return () => root.removeEventListener('keydown', keydown);
  }, [on]);
};

const InstrumentsPanel = (props: InstrumentsProps & { root: HTMLElement }) => {
  const { editor, redraw, selected } = props;
  void redraw.value;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const { project } = editor.state.value;
  const disabled = editor.readOnly;
  // Scripts reach Instruments by name at load, so Play keeps the list.
  const browsing = props.playing.value === 'browse';
  const listFixed = disabled || browsing;
  const { instruments } = project;
  const instrument =
    instruments.find(i => i.id === selected.value) ?? instruments[0];
  const kind = instrument && INSTRUMENT_KINDS.get(instrument.kind);
  const playingNow =
    browsing && instrument
      ? props.playingParameters.value?.[instrument.name]
      : undefined;
  const bound = instrument
    ? boundControls(project, instrument.name)
    : new Map<string, string[]>();
  useBrowseUndo(browsing && !disabled, props);
  useEffect(() => setHovered(undefined), [instrument?.id]);
  // The audition's own state, which the Project doesn't keep.
  const [chosen, setChosen] = useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );
  const [auditioned, setAuditioned] = useState(false);
  const [replay, setReplay] = useState(true);
  const [keyboard, setKeyboard] = useState(false);
  usePianoKeyboard(keyboard && canAudition(kind), instrument?.id, {
    chosen,
    editor,
    off: () => setKeyboard(false),
    onError: props.onError,
    root: props.root,
    soundBytes: props.soundBytes,
  });
  /** Plays the selected Instrument as the Project now has it. */
  const audition = () => {
    const now = editor.project;
    const current = now.instruments.find(i => i.id === instrument?.id);
    if (!current) {
      return;
    }
    const sound = auditionSound(now, chosen.get(current.id!));
    const messages = auditionMessages(current, sound);
    if (messages.length) {
      setAuditioned(true);
      previewInstruments(
        now,
        props.soundBytes,
        messages,
        props.onError,
        sound === undefined ? [] : [sound],
      );
    }
  };
  const toggleGroup = (group: string, open: boolean) => {
    const next = new Set(collapsed);
    if (open) {
      next.delete(group);
    } else {
      next.add(group);
    }
    writeCollapsed(next);
    setCollapsed(next);
  };
  return (
    <>
      <div className="instrument-tools">
        <AddMenu
          add={props.add}
          disabled={listFixed}
          duplicate={
            instrument && kind
              ? () => props.duplicate(instrument.id!)
              : undefined
          }
          kinds={offeredInstrumentKinds(project.addOns, pageAddOns.catalogue)}
        />
        <button
          aria-label="Remove Instrument"
          data-remove-instrument={instrument?.id}
          disabled={listFixed || !instrument}
          onClick={() => instrument && props.remove(instrument.id!)}
          type="button"
        >
          −
        </button>
      </div>
      {instruments.length ? (
        <ul
          aria-label="Instruments"
          className="instrument-list"
          onKeyDown={event => {
            if (!instrument) {
              return;
            }
            if (
              !listFixed &&
              (event.key === 'Delete' || event.key === 'Backspace')
            ) {
              // The page's own Delete and ⌘D act on Elements.
              event.preventDefault();
              event.stopPropagation();
              props.remove(instrument.id!);
            } else if (
              !listFixed &&
              kind &&
              event.key === 'd' &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              event.stopPropagation();
              props.duplicate(instrument.id!);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const index =
                instruments.indexOf(instrument) +
                (event.key === 'ArrowDown' ? 1 : -1);
              selectInstrument(
                selected,
                instruments[
                  Math.max(0, Math.min(instruments.length - 1, index))
                ]?.id,
              );
            }
          }}
          role="listbox"
          tabIndex={0}
        >
          {instruments.map(each => (
            <li
              aria-selected={each === instrument}
              className={each === instrument ? 'selected' : undefined}
              data-select-instrument={each.id}
              key={each.id}
              onClick={() => selectInstrument(selected, each.id)}
              role="option"
            >
              <span className="instrument-name">{each.name}</span>
              <span className="muted">
                {instrumentKindNames(each.kind).label}
                {INSTRUMENT_KINDS.has(each.kind) ? '' : ' (not loaded)'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          No Instruments yet. The sampler plays the Project’s sounds in any
          Project.
        </p>
      )}
      {instrument && (
        <div
          className="instrument"
          data-instrument={instrument.id}
          key={instrument.id}
        >
          <div className="row">
            {field(
              'Name',
              <input
                autoComplete="off"
                data-instrument-field="name"
                disabled={listFixed}
                spellcheck={false}
                type="text"
                value={instrument.name}
              />,
            )}
            {kind &&
              field(
                'Voices',
                <input
                  data-instrument-field="voices"
                  disabled={listFixed}
                  max={kind.maxVoices}
                  min={1}
                  step={1}
                  type="number"
                  value={instrument.voices}
                />,
              )}
          </div>
          {canAudition(kind) && (
            <Audition
              choose={sound =>
                setChosen(new Map(chosen).set(instrument.id!, sound))
              }
              chosen={chosen}
              instrument={instrument}
              keyboard={keyboard}
              play={audition}
              project={project}
              replay={replay}
              setKeyboard={setKeyboard}
              setReplay={setReplay}
            />
          )}
          {kind &&
            grouped(kind.parameters).map(([group, entries]) => {
              const rows = entries.map(([name, definition]) => (
                <ParameterRow
                  bound={bound.get(name)}
                  definition={definition}
                  disabled={disabled}
                  key={name}
                  live={
                    browsing
                      ? value => props.live(instrument.id!, name, value)
                      : undefined
                  }
                  name={name}
                  onHover={setHovered}
                  playing={playingNow?.[name]}
                  released={() => auditioned && replay && audition()}
                  set={value =>
                    props.change(instrument.id!, { parameter: name, value })
                  }
                  value={instrument.parameters[name] ?? definition.default}
                />
              ));
              return group ? (
                <details
                  className="parameter-group"
                  data-group={group}
                  key={group}
                  onToggle={event =>
                    toggleGroup(group, event.currentTarget.open)
                  }
                  open={!collapsed.has(group)}
                >
                  <summary>{group}</summary>
                  {kind.views?.[group] && (
                    <GroupPicture
                      disabled={disabled}
                      group={group}
                      live={
                        browsing
                          ? values => {
                              for (const [name, value] of Object.entries(
                                values,
                              )) {
                                props.live(instrument.id!, name, value);
                              }
                            }
                          : undefined
                      }
                      parameters={kind.parameters}
                      released={() => auditioned && replay && audition()}
                      set={values =>
                        props.change(
                          instrument.id!,
                          Object.entries(values).map(([parameter, value]) => ({
                            parameter,
                            value,
                          })),
                        )
                      }
                      values={{ ...instrument.parameters, ...playingNow }}
                      view={kind.views[group]}
                    />
                  )}
                  {rows}
                </details>
              ) : (
                <div className="parameter-group" key="">
                  {rows}
                </div>
              );
            })}
        </div>
      )}
      {instrument && <Hint lines={hintLines(instrument, hovered)} />}
    </>
  );
};

/** Mount once; Preact redraws as the Project and the selection change. */
export const mountInstrumentsWindow = (
  container: HTMLElement,
  props: InstrumentsProps,
): (() => void) => {
  // Keys anywhere in the window play the computer keyboard.
  const root = container.closest<HTMLElement>('.window') ?? container;
  render(<InstrumentsPanel {...props} root={root} />, container);
  return () => render(null, container);
};
