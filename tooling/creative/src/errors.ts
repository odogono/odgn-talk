// The Errors window: Script problems from the last Play Session, kept after
// it ends, each linking to its authored Script and line.
import { byId, h } from './dom';
import { type Page, type Project } from './model';
import { scriptPage, type ScriptOwner } from './script-manifest';
import { bringWindowForward } from './scripts';
import { type StackShell } from './stack';

export type ScriptProblem = {
  line?: number;
  message: string;
  owner: ScriptOwner;
};

/** Where an owner was when its problem was reported, to find it after undo. */
type Location = { name: string; page?: string };

const isProject = (owner: ScriptOwner): owner is Project => 'pages' in owner;
const isPage = (owner: ScriptOwner): owner is Page => 'elements' in owner;

export class ErrorsWindow {
  readonly #list = byId('error-list');
  readonly #window = byId('errors-window');
  #count = 0;

  constructor(readonly shell: StackShell) {
    byId('close-errors').addEventListener('click', () => {
      this.#window.hidden = true;
    });
    byId('clear-errors').addEventListener('click', () => this.clear());
    this.clear();
  }

  get count(): number {
    return this.#count;
  }

  clear(): void {
    this.#count = 0;
    this.#list.replaceChildren();
    byId('errors-empty').hidden = false;
  }

  /** Adds problems, showing the window when it was empty. */
  add(problems: readonly ScriptProblem[]): void {
    if (!problems.length) {
      return;
    }
    if (!this.#count || this.#window.hidden) {
      this.#window.hidden = false;
      bringWindowForward(this.#window);
    }
    this.#count += problems.length;
    byId('errors-empty').hidden = true;
    const project = this.shell.editor.project;
    this.#list.append(
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
        const button = h(
          'button',
          { type: 'button', title: 'Open this Script' },
          h('span', { class: 'where' }, label),
          h('span', {}, problem.message),
        );
        button.addEventListener('click', () => {
          const owner = this.#find(problem.owner, where);
          if (owner) {
            this.shell.openScript(owner, problem.line);
          } else {
            button.disabled = true;
            button.title = 'This is no longer in the Project';
          }
        });
        return h('li', {}, button);
      }),
    );
  }

  /** The owner itself, or the authored owner now at its name and Page. */
  #find(owner: ScriptOwner, where: Location): ScriptOwner | undefined {
    const project = this.shell.editor.project;
    if (isProject(owner)) {
      return project;
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
