// The Instruments window (#2049): every Project Instrument as a list, with
// the selected one's name, voices and parameters below it, and the ways to
// add and remove one. Edit only, and independent of the Page's selection.
import type { ReadonlySignal, Signal } from '@preact/signals';
import { Fragment, render } from 'preact';
import type { StackEditor } from './editing';
import { field } from './elements/controls';
import type { ParameterDefinition } from './instruments/kind';
import { INSTRUMENT_KINDS, instrumentKindNames } from './instruments/registry';
import { pageAddOns } from './add-ons/page';
import { offeredInstrumentKinds } from './add-ons/offered';

type InstrumentsProps = {
  editor: StackEditor;
  /** Bumped by the shell's redraw, such as after undo or read-only. */
  redraw: ReadonlySignal<number>;
  /** The selected Instrument's id; the first one when unset or gone. */
  selected: Signal<number | undefined>;
};

/** `envelopePeriod` as `Envelope period`. */
const parameterLabel = (name: string): string => {
  const words = name.replaceAll(/([A-Z])/gu, ' $1').toLowerCase();
  return words[0]!.toUpperCase() + words.slice(1);
};

const parameterControl = (
  name: string,
  definition: ParameterDefinition,
  value: number | string | boolean | undefined,
  disabled: boolean,
) => {
  const common = {
    'data-parameter': name,
    disabled,
    title: definition.description,
  };
  switch (definition.shape) {
    case 'number':
      return field(
        parameterLabel(name),
        <input
          {...common}
          max={definition.max}
          min={definition.min}
          step={definition.whole ? 1 : 'any'}
          type="number"
          value={Number(value ?? definition.default)}
        />,
      );
    case 'text':
      return field(
        parameterLabel(name),
        <select {...common} value={String(value ?? definition.default)}>
          {definition.choices.map(choice => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>,
      );
    case 'boolean':
      return (
        <label className="check" title={definition.description}>
          <input
            {...common}
            checked={Boolean(value ?? definition.default)}
            type="checkbox"
          />
          {parameterLabel(name)}
        </label>
      );
  }
};

const InstrumentsPanel = ({ editor, redraw, selected }: InstrumentsProps) => {
  void redraw.value;
  const { project } = editor.state.value;
  const disabled = editor.readOnly;
  const { instruments } = project;
  const instrument =
    instruments.find(i => i.id === selected.value) ?? instruments[0];
  const kind = instrument && INSTRUMENT_KINDS.get(instrument.kind);
  return (
    <>
      {instruments.length ? (
        <ul aria-label="Instruments" className="instrument-list" role="listbox">
          {instruments.map(each => (
            <li
              aria-selected={each === instrument}
              className={each === instrument ? 'selected' : undefined}
              data-select-instrument={each.id}
              key={each.id}
              role="option"
            >
              <span className="instrument-name">{each.name}</span>
              <span className="muted">
                {instrumentKindNames(each.kind).label}
                {INSTRUMENT_KINDS.has(each.kind) ? '' : ' (not loaded)'}
              </span>
              <span className="muted">{each.voices}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          No Instruments yet. The sampler plays the Project’s sounds in any
          Project.
        </p>
      )}
      <div className="row">
        <select
          aria-label="Instrument kind"
          data-new-instrument=""
          disabled={disabled}
        >
          {/* A listed Add-on's kinds load when one is added (#1901). */}
          {offeredInstrumentKinds(project.addOns, pageAddOns.catalogue).map(
            ({ kind, label }) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ),
          )}
        </select>
        <button data-add-instrument="" disabled={disabled} type="button">
          Add Instrument
        </button>
        {instrument && (
          <button
            data-remove-instrument={instrument.id}
            disabled={disabled}
            type="button"
          >
            Remove
          </button>
        )}
      </div>
      {instrument && (
        <fieldset
          className="instrument"
          data-instrument={instrument.id}
          key={instrument.id}
        >
          <legend>
            {instrumentKindNames(instrument.kind).label}
            {kind ? '' : ' (Add-on not loaded)'} “{instrument.name}”
          </legend>
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
          {kind && (
            <>
              {field(
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
              {Object.entries(kind.parameters).map(([name, definition]) => (
                <Fragment key={name}>
                  {parameterControl(
                    name,
                    definition,
                    instrument.parameters[name],
                    disabled,
                  )}
                </Fragment>
              ))}
            </>
          )}
        </fieldset>
      )}
      <p className="muted">
        Scripts play an Instrument by its name, like tell drums to play
        &quot;kick&quot;, and set its parameters, like set the cutoff of synth
        to 800.
      </p>
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
