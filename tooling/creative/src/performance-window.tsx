import { signal, type Signal } from '@preact/signals';
import { render } from 'preact';
import { byId } from './dom';
import { type PerformanceRow, type PerformanceSnapshot } from './performance';
import { PerformanceResults } from './performance-results';
import { bringWindowForward, setWindowOpener } from './windows';

const number = (value: number | undefined) =>
  value === undefined
    ? '—'
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const Figures = ({ row }: { row: PerformanceRow }) => (
  <>
    <td>{number(row.fuel)}</td>
    <td>{number(row.rate)}</td>
    <td>{row.started}</td>
    <td>{row.completed}</td>
    <td>{row.failed}</td>
    <td>{row.discarded}</td>
    <td>{row.active}</td>
    <td>{number(row.last)}</td>
    <td>{number(row.samples ? row.sampleFuel / row.samples : undefined)}</td>
    <td>{number(row.peak)}</td>
  </>
);
const Chart = ({
  snapshot,
  pump,
}: {
  pump: boolean;
  snapshot: PerformanceSnapshot;
}) => {
  const values = snapshot.history.map(bucket =>
    pump
      ? bucket.pumpPeak
      : bucket.fuel /
        Math.max(0.001, Math.min(1, snapshot.elapsed - bucket.second)),
  );
  const ceiling = Math.max(1, pump ? snapshot.pumpCap : 0, ...values);
  const points = values
    .map((v, i) => `${(60 - values.length + i) * 5},${60 - (55 * v) / ceiling}`)
    .join(' ');
  return (
    <figure>
      <figcaption>
        {pump
          ? `Peak Pump Fuel in each second (cap ${number(snapshot.pumpCap)})`
          : 'Fuel / second'}{' '}
        · scale {number(ceiling)}
      </figcaption>
      <svg
        aria-label={pump ? 'Peak Pump Fuel history' : 'Fuel per second history'}
        role="img"
        viewBox="0 0 300 65"
      >
        {pump && (
          <line
            className="performance-cap"
            x1="0"
            x2="300"
            y1={60 - (55 * snapshot.pumpCap) / ceiling}
            y2={60 - (55 * snapshot.pumpCap) / ceiling}
          />
        )}
        <polyline
          fill="none"
          points={points}
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </figure>
  );
};

export class PerformanceWindow {
  readonly results = new PerformanceResults();
  readonly #snapshot = signal<PerformanceSnapshot | undefined>(undefined);
  readonly #incomplete = signal(false);
  readonly #window = byId('performance-window');
  constructor(
    private readonly capture: (epoch: number) => void,
    openSource: (owner: number) => void,
  ) {
    setWindowOpener('performance-window', () => this.open());
    render(
      <Panel
        clear={() => this.clear()}
        incomplete={this.#incomplete}
        openSource={openSource}
        snapshot={this.#snapshot}
      />,
      byId('performance-panel'),
    );
  }
  get visible(): boolean {
    return !this.#window.hidden;
  }
  open(): void {
    this.#window.hidden = false;
    bringWindowForward(this.#window);
    this.capture(this.results.epoch);
  }
  toggle(): void {
    if (this.visible) {
      this.#window.hidden = true;
    } else {
      this.open();
    }
  }
  reset(session: number): void {
    this.results.reset(session);
    this.#snapshot.value = undefined;
    this.#incomplete.value = false;
  }
  clear(): void {
    this.results.clear();
    this.#snapshot.value = undefined;
    this.#incomplete.value = false;
    this.capture(this.results.epoch);
  }
  receive(session: number, snapshot: PerformanceSnapshot): void {
    if (this.results.receive(session, snapshot)) {
      this.#snapshot.value = snapshot;
    }
  }
  interrupted(): void {
    this.results.interrupted();
    this.#incomplete.value = true;
    this.#snapshot.value = this.results.snapshot;
  }
}

const Panel = ({
  snapshot,
  clear,
  openSource,
  incomplete,
}: {
  clear: () => void;
  incomplete: Signal<boolean>;
  openSource: (owner: number) => void;
  snapshot: Signal<PerformanceSnapshot | undefined>;
}) => {
  const data = snapshot.value;
  return (
    <>
      <p id="performance-status" role="status">
        {data
          ? `${data.status === 'capturing' ? 'Capturing' : data.status === 'stopped' ? 'Stopped' : 'Incomplete — worker interrupted'} · ${number(data.elapsed)} seconds · ${number(data.fuel)} Fuel · peak Pump ${number(data.pumpPeak)}`
          : incomplete.value
            ? 'Incomplete — worker interrupted before a snapshot arrived.'
            : 'No capture. Open during Browse or Present to begin.'}
      </p>
      <button onClick={clear} type="button">
        Clear
      </button>
      <p className="muted">
        Fuel is work, not CPU time. Run origins include internal calls. Recent
        rates cover the current and previous second. Partial Runs are excluded
        from last/mean/peak costs.
      </p>
      {data && (
        <>
          <div className="performance-charts">
            <Chart pump={false} snapshot={data} />
            <Chart pump snapshot={data} />
          </div>
          <p className="muted">
            Last 60 seconds. Frame figures count Script message deliveries, not
            rendered FPS.
          </p>
          {!data.scripts.length && <p>No Script activity captured yet.</p>}
          {data.scripts.map(script => (
            <details className="performance-script" key={script.script}>
              <summary>
                {script.script} · {number(script.rate)} Fuel/s ·{' '}
                {number(script.fuel)} Fuel · {script.active} active
              </summary>
              {script.owner !== undefined && (
                <button onClick={() => openSource(script.owner!)} type="button">
                  Open source
                </button>
              )}
              <p>
                {script.frames
                  ? `Frame messages: ${script.frames.delivered} delivered · ${script.frames.skipped} busy-skipped · ${number(script.frames.rate)} deliveries/s`
                  : 'Frame messages: unavailable (no frame Handler)'}
              </p>
              <div className="performance-table">
                <table>
                  <thead>
                    <tr>
                      {[
                        'Run origin',
                        'Fuel',
                        'Fuel/s',
                        'Started',
                        'Completed',
                        'Failed',
                        'Discarded',
                        'Active',
                        'Last',
                        'Mean',
                        'Peak',
                      ].map(label => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {script.origins.map(row => (
                      <tr key={row.origin}>
                        <th scope="row">{row.origin}</th>
                        <Figures row={row} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </>
      )}
    </>
  );
};
