// The Dictionary window lists the Grants of the Script the Code Browser has
// selected, from the Host Manifest its completion reads: Grants, then their
// Operations, over the chosen Operation's entry (#1683). Read-only.
import { render } from 'preact';
import type {
  DictionaryGrant,
  DictionaryOperation,
} from '@northtalk/tooling/dictionary';
import { codeWindow, showCodeWindow, type CodeWindow } from './code-window';
import { h } from './dom';
import { bringWindowForward, setWindowOpener } from './windows';

/** A Grant, and optionally one of its Operations. */
export type DictionaryTarget = { grant: string; operation?: string };

type Props = {
  dictionary: DictionaryGrant[];
  onSelect(target: DictionaryTarget): void;
  scriptLabel: string;
  selected: DictionaryTarget | undefined;
};

const Entry = ({ op }: { op: DictionaryOperation }) => (
  <article aria-label={op.name} className="dictionary-op">
    <code>{op.call}</code>
    {op.description && <p>{op.description}</p>}
    <ul>
      {op.facts.map(fact => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
    {op.examples?.length ? (
      <>
        <h4>Examples</h4>
        {op.examples.map(example => (
          <pre key={example}>
            <code>{example}</code>
          </pre>
        ))}
      </>
    ) : null}
  </article>
);

const Dictionary = ({ dictionary, onSelect, scriptLabel, selected }: Props) => {
  const grant =
    dictionary.find(g => g.name === selected?.grant) ?? dictionary[0];
  const op =
    grant?.operations.find(o => o.name === selected?.operation) ??
    grant?.operations[0];
  return (
    <>
      <p className="dictionary-scope">{scriptLabel}</p>
      {grant ? (
        <>
          <div className="browser-columns">
            <section aria-label="Grants" className="browser-column">
              <h3>Grants</h3>
              <ul>
                {dictionary.map(g => (
                  <li key={g.name}>
                    <button
                      aria-current={g === grant ? 'true' : undefined}
                      onClick={() => onSelect({ grant: g.name })}
                      type="button"
                    >
                      {g.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-label="Operations" className="browser-column">
              <h3>Operations</h3>
              <ul>
                {grant.operations.map(o => (
                  <li key={o.name}>
                    <button
                      aria-current={o === op ? 'true' : undefined}
                      onClick={() =>
                        onSelect({ grant: grant.name, operation: o.name })
                      }
                      type="button"
                    >
                      {o.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div className="dictionary-entry">
            {grant.capability !== grant.name && (
              <p>Capability {grant.capability}</p>
            )}
            {op && <Entry key={`${grant.name}.${op.name}`} op={op} />}
          </div>
        </>
      ) : (
        <p className="dictionary-entry">This Script holds no Grants.</p>
      )}
    </>
  );
};

export class DictionaryWindow {
  #dictionary: DictionaryGrant[] = [];
  #scriptLabel = '';
  #selected: DictionaryTarget | undefined;
  #window: CodeWindow | undefined;
  #body: HTMLElement | undefined;

  constructor() {
    setWindowOpener('dictionary-window', () => this.open());
  }

  /** The selected Script's Grants; redraws when the window exists. */
  update(dictionary: DictionaryGrant[], scriptLabel: string): void {
    this.#dictionary = dictionary;
    this.#scriptLabel = scriptLabel;
    this.#draw();
  }

  /** Shows the window, at `target` when given. */
  open(target?: DictionaryTarget): void {
    if (target) {
      this.#selected = target;
    }
    if (!this.#window) {
      this.#window = codeWindow({
        id: 'dictionary-window',
        className: 'dictionary-window',
        closeLabel: 'Close Dictionary',
        label: 'Dictionary',
        left: 520,
        top: 160,
      });
      this.#body = h('div', { class: 'dictionary-content' });
      this.#window.node.append(this.#body);
      showCodeWindow(this.#window);
    }
    this.#window.node.hidden = false;
    bringWindowForward(this.#window.node);
    this.#draw();
    this.#body!.querySelector('[aria-current="true"]')?.scrollIntoView?.({
      block: 'nearest',
    });
  }

  #draw(): void {
    if (!this.#body) {
      return;
    }
    render(
      <Dictionary
        dictionary={this.#dictionary}
        onSelect={target => {
          this.#selected = target;
          this.#draw();
        }}
        scriptLabel={this.#scriptLabel}
        selected={this.#selected}
      />,
      this.#body,
    );
  }
}
