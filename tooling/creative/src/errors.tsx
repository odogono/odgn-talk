// The Errors window: Script problems from the last Play Session, kept after
// it ends, each linking to its authored Script and line.
import { signal, type Signal } from '@preact/signals';
import { type Immutable } from 'immer';
import { render } from 'preact';
import { byId } from './dom';
import { type Page, type Project } from './model';
import { ownerById, scriptPage, type ScriptOwner } from './script-manifest';
import { bringWindowForward } from './windows';
import { type StackShell } from './stack';

export type ScriptProblem = {
  line?: number;
  message: string;
  owner: ScriptOwner;
};

/** Where an owner was when its problem was reported, to find it after undo. */
type Location = { name: string; page?: string };

/** A problem as listed, labelled when it was reported. */
type ReportedProblem = ScriptProblem & {
  key: number;
  label: string;
  /** Set once opening it found its owner gone from the Project. */
  vanished: boolean;
  where: Location;
};

const isProject = (owner: ScriptOwner): owner is Immutable<Project> =>
  'pages' in owner;
const isPage = (owner: ScriptOwner): owner is Immutable<Page> =>
  'elements' in owner;

const ErrorsPanel = ({
  problems,
  onClear,
  onOpen,
}: {
  onClear: () => void;
  onOpen: (problem: ReportedProblem) => void;
  problems: Signal<readonly ReportedProblem[]>;
}) => {
  const list = problems.value;
  return (
    <>
      <p className="muted" hidden={list.length > 0} id="errors-empty">
        No errors. Script errors from browsing or presenting appear here.
      </p>
      <ol id="error-list">
        {list.map(problem => (
          <li key={problem.key}>
            <button
              disabled={problem.vanished}
              onClick={() => onOpen(problem)}
              title={
                problem.vanished
                  ? 'This is no longer in the Project'
                  : 'Open this Script'
              }
              type="button"
            >
              <span className="where">{problem.label}</span>
              <span>{problem.message}</span>
            </button>
          </li>
        ))}
      </ol>
      <button id="clear-errors" onClick={onClear} type="button">
        Clear
      </button>
    </>
  );
};

export class ErrorsWindow {
  readonly #window = byId('errors-window');
  readonly #problems = signal<readonly ReportedProblem[]>([]);
  #nextKey = 0;

  constructor(readonly shell: StackShell) {
    byId('close-errors').addEventListener('click', () => {
      this.#window.hidden = true;
    });
    render(
      <ErrorsPanel
        onClear={() => this.clear()}
        onOpen={problem => this.#open(problem)}
        problems={this.#problems}
      />,
      byId('errors-panel'),
    );
  }

  get count(): number {
    return this.#problems.value.length;
  }

  clear(): void {
    this.#problems.value = [];
  }

  /** Adds problems, showing the window when it was empty. */
  add(problems: readonly ScriptProblem[]): void {
    if (!problems.length) {
      return;
    }
    if (!this.count || this.#window.hidden) {
      this.#window.hidden = false;
      bringWindowForward(this.#window);
    }
    const project = this.shell.editor.project;
    this.#problems.value = [
      ...this.#problems.value,
      ...problems.map(problem => {
        const page = scriptPage(project, problem.owner);
        const where: Location = {
          name: problem.owner.name,
          page:
            isProject(problem.owner) || isPage(problem.owner)
              ? undefined
              : page?.name,
        };
        const label = [
          isProject(problem.owner)
            ? 'Project'
            : where.page
              ? `${where.page} › ${where.name}`
              : where.name,
          problem.line === undefined ? undefined : `line ${problem.line}`,
        ]
          .filter(Boolean)
          .join(', ');
        return {
          ...problem,
          key: this.#nextKey++,
          label,
          vanished: false,
          where,
        };
      }),
    ];
  }

  /** Opens the problem's Script, or disables it once its owner has gone. */
  #open(problem: ReportedProblem): void {
    const owner = this.#find(problem.owner, problem.where);
    if (owner) {
      this.shell.openScript(owner, problem.line);
      return;
    }
    this.#problems.value = this.#problems.value.map(p =>
      p.key === problem.key ? { ...p, vanished: true } : p,
    );
  }

  /** The owner itself, or the authored owner now at its name and Page. */
  #find(owner: ScriptOwner, where: Location): ScriptOwner | undefined {
    const project = this.shell.editor.project;
    if (isProject(owner)) {
      return project;
    }
    if (owner.id !== undefined) {
      return ownerById(project, owner.id);
    }
    if (scriptPage(project, owner)) {
      return owner;
    }
    if (isPage(owner)) {
      return project.pages.find(p => p.name === where.name);
    }
    return project.pages
      .find(p => p.name === where.page)
      ?.elements.find(e => e.name === where.name);
  }
}
