// The Instruments window (#2049, #2079): every Project Instrument as a list
// with a `+ ▾` menu to add or duplicate one and `−` to remove it, then the
// selected one's name, voices and parameters in collapsible groups of
// compact rows. Edit only, and independent of the Page's selection.
import type { ReadonlySignal, Signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { DeepReadonly } from './readonly';
import type { StackEditor } from './editing';
import { field } from './elements/controls';
import type { Instrument } from './model';
import type { InstrumentChange } from './tree/project-tree';
import type { ParameterDefinition, ParameterValue } from './instruments/kind';
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
import { pageAddOns } from './add-ons/page';
import { offeredInstrumentKinds } from './add-ons/offered';

type InstrumentsProps = {
  /** Adds an Instrument of `kind`, loading its Add-on first. */
  add(kind: string): void;
  /** Applies one checked, undoable change; a refusal shows a notice. */
  change(id: number, change: InstrumentChange): void;
  duplicate(id: number): void;
  editor: StackEditor;
  /** Bumped by the shell's redraw, such as after undo or read-only. */
  redraw: ReadonlySignal<number>;
  remove(id: number): void;
  /** The selected Instrument's id; the first one when unset or gone. */
  selected: Signal<number | undefined>;
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
  definition: ParameterDefinition;
  disabled: boolean;
  name: string;
  /** Sets the parameter, or resets it to its default. */
  set(value: ParameterValue): void;
  value: ParameterValue;
};

/**
 * A number parameter's slider: a drag moves it from where it's pressed,
 * ⇧ makes a drag or arrow key ten times finer, and a double-click or
 * ⌥-click resets it. It commits once, when the drag ends.
 */
const Slider = ({ definition, disabled, name, set, value }: RowProps) => {
  const number = definition as NumberParameter;
  // The drag under way: where the slider is and the pointer's last x.
  const [drag, setDrag] = useState<{ position: number; x: number } | undefined>(
    undefined,
  );
  const shown =
    drag === undefined ? Number(value) : sliderValue(number, drag.position);
  const position = sliderPosition(number, shown);
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
      }}
      onPointerMove={event => {
        const { clientX, shiftKey } = event;
        const width = event.currentTarget.getBoundingClientRect().width || 1;
        setDrag(
          current =>
            current && {
              position: draggedPosition(
                current.position,
                clientX - current.x,
                width,
                shiftKey,
              ),
              x: clientX,
            },
        );
      }}
      onPointerUp={() => {
        if (drag) {
          setDrag(undefined);
          set(sliderValue(number, drag.position));
        }
      }}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      title={definition.description}
    >
      <span className="slider-fill" style={{ width: `${position * 100}%` }} />
    </div>
  );
};

/** The typed value beside a slider, which takes a Quantity such as `5 ms`. */
const ValueField = ({ definition, disabled, name, set, value }: RowProps) => {
  const number = definition as NumberParameter;
  const text = formatParameter(number, Number(value));
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
  const { definition, disabled, name, set, value } = props;
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
      </span>
      {control}
    </div>
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

const InstrumentsPanel = (props: InstrumentsProps) => {
  const { editor, redraw, selected } = props;
  void redraw.value;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const { project } = editor.state.value;
  const disabled = editor.readOnly;
  const { instruments } = project;
  const instrument =
    instruments.find(i => i.id === selected.value) ?? instruments[0];
  const kind = instrument && INSTRUMENT_KINDS.get(instrument.kind);
  useEffect(() => setHovered(undefined), [instrument?.id]);
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
          disabled={disabled}
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
          disabled={disabled || !instrument}
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
              !disabled &&
              (event.key === 'Delete' || event.key === 'Backspace')
            ) {
              // The page's own Delete and ⌘D act on Elements.
              event.preventDefault();
              event.stopPropagation();
              props.remove(instrument.id!);
            } else if (
              !disabled &&
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
                disabled={disabled}
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
                  disabled={disabled}
                  max={kind.maxVoices}
                  min={1}
                  step={1}
                  type="number"
                  value={instrument.voices}
                />,
              )}
          </div>
          {kind &&
            grouped(kind.parameters).map(([group, entries]) => {
              const rows = entries.map(([name, definition]) => (
                <ParameterRow
                  definition={definition}
                  disabled={disabled}
                  key={name}
                  name={name}
                  onHover={setHovered}
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
  render(<InstrumentsPanel {...props} />, container);
  return () => render(null, container);
};
