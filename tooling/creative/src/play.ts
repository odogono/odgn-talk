import type { CanvasCommand } from '@northtalk/tooling/canvas';
import { Drawing, type DrawingChange, type DrawingMark } from './drawing';
import { grantDeclarations, grantsFor, type GrantStates } from './grants';
import { PUMP_FUEL } from './grants/elements';
import { elementShape } from './grants/grant';
import type { UserPrompt } from './grants/user';
import { compileProjectLibraries } from './libraries';
import { FuelMeasurements } from './fuel';
import { PerformanceCapture } from './performance';
import type { DeepReadonly } from './readonly';
import { allElements } from './tree/rules';
import { ProjectTree, TreeError, type TreeParent } from './tree/project-tree';
import { propertiesForKind } from './tree/properties';
// A Play Session owns its Group and a disposable copy of the authored Project.
import { scriptNameProblems } from './script-names';
import {
  bool,
  defineObjectKind,
  list,
  LoadError,
  MailboxFull,
  newGroup,
  parseSource,
  nothing,
  num,
  ScriptError,
  shape,
  text,
  type Call,
  type HostObject,
  type ObjectElements,
  type ObjectKind,
  type PropDef,
  type PumpResult,
  type TsGroup,
  type Value,
} from '@northtalk/ts';
import type { DebugController } from '@northtalk/ts/debug';
import {
  type CanvasElement,
  type Element,
  type Page,
  type Project,
  type ProjectLibrary,
  type RichText,
  type TextElement,
} from './model';
import {
  ownerId,
  scriptManifest,
  scriptOwners,
  scriptPage,
  type ScriptOwner as AuthoredOwner,
} from './script-manifest';
import {
  MESSAGE_FIRST_LINE,
  MESSAGE_HANDLER_LIMIT,
  messageHandler,
  messageSource,
  type LoadedMessageTarget,
} from './message-script';
import { isSoundAsset, SoundBoard, type SoundBackend } from './sounds';

type ScriptOwner = DeepReadonly<Project | Page | Element>;

// The Project Script's unit name; prefixed so it cannot collide with a
// Library name.
const PROJECT_UNIT = 'script:project';

// The author-facing name for a Script unit.
export const unitLabel = (name: string): string =>
  name === PROJECT_UNIT ? 'project' : name;

export type SourceTarget =
  | { kind: 'script'; owner: AuthoredOwner }
  | { kind: 'library'; library: DeepReadonly<ProjectLibrary> };

export type PlayProblem = {
  line: number;
  message: string;
  owner: AuthoredOwner;
  /** Absent for legacy Script-only callers. */
  target?: SourceTarget;
};
export type PlayMessage =
  | 'startPlay'
  | 'openPage'
  | 'closePage'
  | 'click'
  | 'pointerEnter'
  | 'pointerLeave'
  | 'pointerHeld'
  | 'keyDown'
  | 'keyUp'
  | 'textChanged'
  | 'frame';

type CstNode = {
  children?: CstNode[];
  kind: string;
  rule?: string;
  v?: string;
};

// Sources by the messages they handle; `pointerHeld` asks every frame.
const handlerCache = new Map<string, Map<string, boolean>>();
const HANDLER_CACHE_LIMIT = 256;

/** Whether a Script's source declares a Handler for `message`. */
export const definesHandler = (source: string, message: string): boolean => {
  let known = handlerCache.get(source);
  if (!known) {
    if (handlerCache.size >= HANDLER_CACHE_LIMIT) {
      handlerCache.clear();
    }
    known = new Map();
    handlerCache.set(source, known);
  }
  let defines = known.get(message);
  if (defines === undefined) {
    defines = declaresHandler(source, message);
    known.set(message, defines);
  }
  return defines;
};

const declaresHandler = (source: string, message: string): boolean => {
  let tree: CstNode | null;
  try {
    tree = parseSource(source).tree as CstNode | null;
  } catch {
    return false;
  }
  const first = (node: CstNode | undefined, rule: string) =>
    node?.children?.find(child => child.rule === rule);
  return (tree?.children ?? []).some(declaration => {
    const name = first(
      first(first(declaration, 'Handler'), 'MessageName'),
      'Name',
    );
    return name?.children?.[0]?.v === message;
  });
};

// Each Message Box command loads as a fresh ownerless Script under this
// prefix: the Core cannot unload Scripts, and the names change by Page.
const MESSAGE_SCRIPT = 'message:';

/** A `user` prompt the reader hasn't answered yet (chapter 7). */
export type { UserPrompt };
/** A shown prompt; its answer is ignored once the prompt is taken down. */
export type PendingPrompt = UserPrompt & {
  answer(value: boolean | string | readonly string[] | undefined): void;
  readonly script: string;
};
export type UserNotice = { message: string; title: string };

/** A Message Box command: its result, or why it could not run. */
/** `delivery` is the Request's, which the Runs it causes carry as their root. */
export type MessageOutcome =
  | { delivery: string; ok: true; result: Promise<Value> }
  | { error: string; ok: false };

export { PUMP_FUEL };

export class PlaySession {
  readonly #tree: ProjectTree;
  get project(): DeepReadonly<Project> {
    return this.#tree.project;
  }
  get objects(): ReadonlyMap<ScriptOwner, HostObject<ScriptOwner>> {
    return this.#objects;
  }
  get authored(): ReadonlyMap<ScriptOwner, ScriptOwner> {
    return this.#authored;
  }
  get owners(): ReadonlyMap<string, ScriptOwner> {
    return this.#owners;
  }
  /** The Library a loaded code unit was compiled from, if it was one. */
  libraryOf(unit: string): DeepReadonly<ProjectLibrary> | undefined {
    return this.#librarySources.get(unit);
  }

  #debug: DebugController | undefined;
  /**
   * The Group's debug controller, made on first use: once made, the Group
   * steps every instruction through it, so a session without Breakpoints
   * never asks (ADR 0147).
   */
  get debug(): DebugController {
    return (this.#debug ??= this.group.debug());
  }
  /** Whether the debug controller has been made. */
  get debugging(): boolean {
    return this.#debug !== undefined;
  }
  /** The Group's state, read without a Host Input while a Run is stopped. */
  inspection() {
    return this.debugPaused ? this.debug.snapshot() : this.group.inspect();
  }
  /** Whether a Run is stopped at a Breakpoint or Statement Step. */
  get debugPaused(): boolean {
    return this.#debug?.isPaused ?? false;
  }
  /** This session's playing sounds, owned by the Scripts that started them. */
  readonly sounds: SoundBoard;
  readonly group: TsGroup;
  readonly performance: PerformanceCapture;
  #pendingWarnings: string[] = [];
  #senders = new Map<string, string>();
  #unhandledSender: string | undefined;
  readonly problems: PlayProblem[] = [];
  readonly #objects = new Map<ScriptOwner, HostObject<ScriptOwner>>();
  readonly #authored = new Map<ScriptOwner, DeepReadonly<ScriptOwner>>();
  readonly #owners = new Map<string, ScriptOwner>();
  #scripts = new Map<ScriptOwner, string>();
  #kinds = new Map<string, ObjectKind<ScriptOwner>>();
  #nextObject = 0;
  // Each `frame` Script's last delivery time, and whether its Run is pending.
  #frames = new Map<string, { busy: boolean; last: bigint | undefined }>();
  #pendingClones: DeepReadonly<Element>[] = [];
  // Drawings this session has drawn on, and those changed since last taken.
  #drawings = new Map<DeepReadonly<CanvasElement>, Drawing>();
  #changedDrawings = new Set<DeepReadonly<CanvasElement>>();
  // Canvases reset by a Run that a Pump cut off, by that Run's id. Their
  // changes wait until the Run ends or nothing is left to run, so the page
  // never draws a Drawing cleared but not yet redrawn (ADR 0116).
  #heldDrawings = new Map<DeepReadonly<CanvasElement>, string>();
  // Each authored Canvas's place in `scriptOwners(project)`.
  #authoredCanvases = new Map<DeepReadonly<Element>, number>();
  #pageElements: ObjectElements<ScriptOwner> = {
    shape: elementShape,
    count: ({ native }) =>
      num(this.#tree.membersOf(native as TreeParent).length),
    at: ({ native }, index) => {
      const members = this.#tree.membersOf(native as TreeParent);
      const member = members[index > 0 ? index - 1 : members.length + index];
      return member ? this.#objects.get(member)!.value : nothing;
    },
    find: ({ native }, name) => {
      const member = this.#tree.find(native as TreeParent, name);
      return member ? this.#objects.get(member)!.value : nothing;
    },
    countCost: { fuel: 1, alloc: 0 },
    atCost: { fuel: 1, alloc: 0 },
    findCost: { fuel: 1, alloc: 0 },
  };
  #treeOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof TreeError) {
        throw new ScriptError('out of domain', error.message);
      }
      throw error;
    }
  }
  isVisible(element: DeepReadonly<Element>): boolean {
    return this.#tree.isVisible(element);
  }
  elementsOf(
    page: DeepReadonly<Page> = this.page,
  ): readonly DeepReadonly<Element>[] {
    return this.#tree.elementsOf(page);
  }
  replaceRichText(
    element: DeepReadonly<TextElement>,
    value: DeepReadonly<RichText>,
  ): void {
    this.#tree.replaceRichText(element, value);
  }
  /** A reader's edit to editable text: the new text, then `textChanged`. */
  editText(
    element: DeepReadonly<TextElement>,
    next: DeepReadonly<RichText>,
  ): void {
    this.replaceRichText(element, next);
    this.send(element, 'textChanged');
  }
  reorder(parent: TreeParent, order: readonly DeepReadonly<Element>[]): void {
    this.#tree.reorder(parent, order);
  }

  #drawing(element: DeepReadonly<CanvasElement>): Drawing {
    let drawing = this.#drawings.get(element);
    if (!drawing) {
      drawing = new Drawing(element.drawing);
      this.#drawings.set(element, drawing);
    }
    return drawing;
  }

  /** A Canvas's Drawing as this session has it. */
  drawingOf(
    element: DeepReadonly<CanvasElement>,
  ): DeepReadonly<CanvasCommand[]> {
    return this.#drawing(element).commands;
  }

  /** What changed in a Canvas's Drawing since `mark`, if anything. */
  drawingChangesSince(
    element: DeepReadonly<CanvasElement>,
    mark?: DrawingMark,
  ): DrawingChange | undefined {
    return this.#drawing(element).changesSince(mark);
  }

  /**
   * The Canvases drawn on, created or cloned since this was last called,
   * leaving out those held back until the Run that reset them ends.
   */
  takeDrawingChanges(): DeepReadonly<CanvasElement>[] {
    const changed: DeepReadonly<CanvasElement>[] = [];
    for (const element of this.#changedDrawings) {
      if (!this.#tree.contains(element)) {
        this.#changedDrawings.delete(element);
      } else if (!this.#heldDrawings.has(element)) {
        this.#changedDrawings.delete(element);
        changed.push(element);
      }
    }
    return changed;
  }

  /** The index of the Page holding an Element, or -1 once it has gone. */
  pageIndexOf(element: DeepReadonly<Element>): number {
    const page = this.#tree.pageOf(element);
    return page ? this.project.pages.indexOf(page) : -1;
  }

  /** An authored Canvas's place in `scriptOwners(project)`, if it is one. */
  authoredCanvas(element: DeepReadonly<CanvasElement>): number | undefined {
    return this.#authoredCanvases.get(element);
  }

  /** Writes each Drawing into this session's Project, for the Message Box in Edit. */
  commitDrawings(): void {
    this.#tree.transaction(() => {
      for (const [element, drawing] of this.#drawings) {
        if (this.#tree.contains(element)) {
          this.#tree.setDrawing(element, drawing.commands);
        }
      }
    });
  }

  #elementPage(value: Value): DeepReadonly<Page> {
    const page = this.project.pages.find(
      p => this.#objects.get(p) === value.asObject(),
    );
    if (!page) {
      throw new ScriptError('out of domain', 'Unknown Page');
    }
    return page;
  }

  #element(value: Value): {
    element: DeepReadonly<Element>;
    page: DeepReadonly<Page>;
  } {
    const object = value.asObject();
    const element = object?.native as DeepReadonly<Element> | undefined;
    const page = element && this.#tree.pageOf(element);
    if (element && page && this.#objects.get(element) === object) {
      return { page, element };
    }
    throw new ScriptError('out of domain', 'Unknown Element');
  }

  #install(root: DeepReadonly<Element>, parent: TreeParent): void {
    const page = 'kind' in parent ? this.#tree.pageOf(parent)! : parent;
    const install = (
      member: DeepReadonly<Element>,
      owner: TreeParent,
    ): void => {
      const object = this.group.object(
        this.#kinds.get(member.kind)!,
        `dynamic:${this.#nextObject++}`,
        member,
      );
      this.#objects.set(member, object);
      this.#authored.set(member, this.#authored.get(page)!);
      this.group.setParent(object, this.#objects.get(owner)!);
      if (member.kind === 'group') {
        for (const child of member.members) {
          install(child, member);
        }
      }
    };
    install(root, parent);
  }

  #setVisible(value: Value, visible: boolean): void {
    const { element } = this.#element(value);
    this.#tree.setProperty(element, 'visible', visible);
  }

  // The state each Grant reads (#1453); the Grants are built once a session's
  // SoundBoard exists and are shared by every Script it loads.
  #grants!: ReturnType<typeof grantsFor>;
  #grantStates(): GrantStates {
    return {
      pages: {
        pageIndex: page =>
          this.project.pages.findIndex(
            p => this.#objects.get(p) === page.value.asObject(),
          ),
        requestPage: index => this.goTo(index),
      },
      elements: {
        create: (kind, pageObject, name, charge) => {
          const page = this.#elementPage(pageObject.value);
          return this.#treeOperation(() => {
            const element = this.#tree.create(kind, page, name, {
              authorize: charge,
              install: (root, parent) => this.#install(root, parent),
            });
            if (element.kind === 'canvas') {
              this.#changedDrawings.add(element);
            }
            return this.#objects.get(element)!.value;
          });
        },
        clone: (object, charge) => {
          const { element } = this.#element(object);
          return this.#treeOperation(() => {
            const cloned = this.#tree.clone(element, {
              authorize: charge,
              install: (root, parent) => this.#install(root, parent),
            });
            for (const [original, copy] of cloned.pairs) {
              this.#authored.set(copy, this.#authored.get(original)!);
              if (original.kind === 'canvas' && copy.kind === 'canvas') {
                const drawing = this.#drawings.get(original);
                if (drawing) {
                  this.#drawings.set(copy, new Drawing(drawing.commands));
                }
                this.#changedDrawings.add(copy);
              }
            }
            this.#pendingClones.push(...cloned.pairs.map(([, copy]) => copy));
            return this.#objects.get(cloned.root)!.value;
          });
        },
        remove: (object, charge) => {
          const { element } = this.#element(object);
          const removed = this.#treeOperation(() =>
            this.#tree.remove(element, { authorize: charge }),
          );
          for (const member of removed) {
            const name = this.#scripts.get(member);
            if (name) {
              this.sounds.stopOwner(name);
              this.#frames.delete(name);
              this.group.script(name)?.stop('Element deleted');
              this.#scripts.delete(member);
              this.#targets.delete(name);
            }
            this.group.dispose(this.#objects.get(member)!);
          }
        },
        find: (pageObject, name) => {
          const element = this.#tree.find(
            this.#elementPage(pageObject.value),
            name,
          );
          return element && this.#objects.get(element)!.value;
        },
      },
      sound: {
        sounds: this.sounds,
        play: (owner, name, loop) => this.#playSound(owner, name, loop),
      },
      user: {
        ask: (call, prompt) => this.#ask(call, prompt),
        notify: (message, title) => {
          if (!this.ended) {
            this.notices.push({ message, title });
            this.changed = true;
          }
        },
      },
      folio: {
        setVisible: (element, visible) => this.#setVisible(element, visible),
      },
      canvas: {
        drawingOf: (object, runId) => {
          const { element } = this.#element(object.value);
          if (element.kind !== 'canvas') {
            throw new ScriptError('out of domain', 'Not a Canvas Element');
          }
          return command => {
            this.#drawing(element).add(command);
            this.#changedDrawings.add(element);
            if (command.op === 'clear' || command.op === 'background') {
              this.#heldDrawings.set(element, runId);
            }
          };
        },
      },
    };
  }

  #requestedPage: number | undefined;
  #closing:
    | {
        cancel: AbortController;
        deadline: bigint;
        done: boolean;
        id: string;
        target: number;
      }
    | undefined;
  /** Unanswered prompts, oldest first; the Play view shows the first. */
  readonly prompts: PendingPrompt[] = [];
  /** Notices not yet shown; the Play view takes them. */
  readonly notices: UserNotice[] = [];
  // One prompt per Script at a time; prompts from different Scripts queue.
  // An abandoned call (Stop, leaving the Page, a timeout) takes its prompt
  // down.
  #ask(call: Call<unknown>, prompt: UserPrompt): void {
    if (this.prompts.some(p => p.script === call.scriptName)) {
      throw new ScriptError(
        'user busy',
        'Another prompt is waiting for an answer',
      );
    }
    const remove = () => {
      const at = this.prompts.indexOf(pending);
      if (at >= 0) {
        this.prompts.splice(at, 1);
        this.changed = true;
      }
    };
    const pending: PendingPrompt = {
      ...prompt,
      script: call.scriptName,
      answer: value => {
        if (!this.prompts.includes(pending)) {
          return;
        }
        remove();
        call.answer(
          value === undefined
            ? nothing
            : typeof value === 'boolean'
              ? bool(value)
              : typeof value === 'string'
                ? text(value)
                : list(...value.map(item => text(item))),
        );
      },
    };
    this.prompts.push(pending);
    this.changed = true;
    call.signal.addEventListener('abort', remove);
  }

  #playSound(owner: string, name: string, loop: boolean): void {
    const asset = this.project.assets.find(a => a.name === name);
    if (!asset || !isSoundAsset(asset)) {
      throw new ScriptError('out of domain', `No sound named “${name}”`);
    }
    try {
      this.sounds.play(owner, asset, loop);
    } catch (error) {
      if (error instanceof ScriptError) {
        throw error;
      }
      throw new ScriptError(
        'out of domain',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  ended = false;
  changed = false;

  constructor(
    project: DeepReadonly<Project>,
    public pageIndex = 0,
    options: {
      events?: boolean;
      performanceNow?: () => number;
      /**
       * Seeds the generator `random` draws from, so a test can repeat a
       * game; 0 when absent. Browse and Present pass the clock.
       */
      seed?: bigint;
      soundBackend?: SoundBackend;
    } = {},
  ) {
    this.performance = new PerformanceCapture(options.performanceNow);
    this.group = newGroup({
      name: 'play',
      trace: line => this.#trace(line),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    this.sounds = new SoundBoard(options.soundBackend, (sound, message) => {
      const owner = this.#owners.get(sound.owner);
      if (owner) {
        this.problems.push({
          owner: this.#authored.get(owner)!,
          line: 1,
          message: `Sound “${sound.name}” could not play: ${message}`,
        });
      }
    });
    this.#grants = grantsFor(this.#grantStates());
    const names = scriptNameProblems(project);
    if (names.length) {
      throw new Error(names.map(p => p.message).join('\n'));
    }
    this.#tree = new ProjectTree(project, undefined, { trackWork: true });
    this.#tree.subscribe(() => {
      this.changed = true;
    });
    const originals = scriptOwners(project);
    const copies = scriptOwners(this.project);
    this.#kinds = new Map(
      scriptManifest(project, project).objectKinds.map(def => {
        const props: Record<string, PropDef<ScriptOwner>> = {};
        const descriptors = propertiesForKind(def.name);
        for (const prop of def.props) {
          const key = prop.name;
          const descriptor = descriptors.get(key)!;
          props[key] = {
            ...(prop.setCost ? { setCost: prop.setCost } : {}),
            shape:
              prop.shape === 'number'
                ? shape.number
                : prop.shape === 'boolean'
                  ? shape.bool
                  : shape.text,
            get: ({ native }) => {
              const value = descriptor.get(native);
              return typeof value === 'number'
                ? num(value)
                : typeof value === 'boolean'
                  ? bool(value)
                  : text(String(value));
            },
            ...(!prop.readOnly
              ? {
                  set: ({ native }: HostObject<ScriptOwner>, value: Value) => {
                    const next =
                      value.kind === 'number'
                        ? value.asDecimal()!.toNumberLossy()
                        : value.kind === 'boolean'
                          ? value.asBool()!
                          : value.asText()!;
                    this.#treeOperation(() =>
                      this.#tree.setProperty(native, key, next),
                    );
                  },
                }
              : {}),
          };
        }
        return [
          def.name,
          defineObjectKind<ScriptOwner>({
            name: def.name,
            props,
            ...(['page', 'group'].includes(def.name)
              ? { elements: this.#pageElements }
              : {}),
          }),
        ];
      }),
    );
    for (const [i, owner] of copies.entries()) {
      this.#authored.set(owner, originals[i]!);
      if ('kind' in owner && owner.kind === 'canvas') {
        this.#authoredCanvases.set(owner, i);
      }
      const kind =
        'kind' in owner
          ? owner.kind
          : owner === this.project
            ? 'project'
            : 'page';
      this.#objects.set(
        owner,
        this.group.object(this.#kinds.get(kind)!, String(i), owner),
      );
    }
    for (const page of this.project.pages) {
      this.group.setParent(
        this.#objects.get(page)!,
        this.#objects.get(this.project)!,
      );
      for (const element of allElements(page.elements)) {
        this.group.setParent(
          this.#objects.get(element)!,
          this.#objects.get(this.#tree.parentOf(element)!)!,
        );
      }
    }
    const compiled = compileProjectLibraries(
      project.libraries,
      grantDeclarations(),
    );
    for (const library of compiled.libraries) {
      this.group.addLibrary(library);
    }
    for (const problem of compiled.problems) {
      this.problems.push({
        owner: project,
        line: problem.line,
        message: problem.message,
        target: { kind: 'library', library: problem.library },
      });
    }
    this.#librarySources = new Map(
      project.libraries.map(library => [library.name, library]),
    );
    this.#load([this.project, this.page, ...allElements(this.page.elements)]);
    // A session that only runs Message Box commands sends no events.
    if (options.events !== false) {
      this.send(this.project, 'startPlay');
      this.send(this.page, 'openPage');
    }
  }

  /**
   * Runs in a selected loaded Script, or in the ownerless showing-Page
   * context by default. Targeted expressions are tried first so a bare
   * Script Variable reads its value instead of sending a message.
   */
  runMessage(command: string, target?: number): MessageOutcome {
    return this.#run(command, target, false);
  }

  /** Runs a Watch: one expression, never a statement (ADR 0129). */
  runWatch(expression: string, target?: number): MessageOutcome {
    return this.#run(expression, target, true);
  }

  #run(
    command: string,
    target: number | undefined,
    expression: boolean,
  ): MessageOutcome {
    if (this.ended || this.navigating) {
      return { ok: false, error: 'The Page is changing; try again.' };
    }
    if (target !== undefined) {
      return this.#runTargetedMessage(command, target, expression);
    }
    // A Watch reruns often, so it keeps its Script while the Page stays.
    if (expression && this.#watchPage !== this.page) {
      this.#watchPage = this.page;
      this.#watchScripts.clear();
    }
    let first: string | undefined;
    for (const source of expression
      ? [messageSource(`return ${command}`)]
      : [messageSource(command), messageSource(`return ${command}`)]) {
      try {
        let name = expression ? this.#watchScripts.get(command) : undefined;
        if (!name) {
          name = this.#loadMessage(source);
          if (expression) {
            this.#watchScripts.set(command, name);
          }
        }
        const request = this.group.script(name)!.request({
          name: 'runMessage',
        });
        return {
          ok: true,
          delivery: request.id,
          result: request.result.catch((error: unknown) => {
            throw new Error(
              this.#messageErrors.get(name) ??
                (error instanceof Error ? error.message : String(error)),
            );
          }),
        };
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        first ??= error.diagnostics
          .map(d => `line ${d.line - MESSAGE_FIRST_LINE + 1}: ${d.code}`)
          .join('; ');
      }
    }
    return { ok: false, error: first ?? 'Could not run' };
  }

  #loadMessage(source: string): string {
    const objects = {
      ...Object.fromEntries(
        this.project.pages.map(p => [p.name, this.#objects.get(p)!]),
      ),
      ...Object.fromEntries(
        allElements(this.page.elements).map(e => [
          e.name,
          this.#objects.get(e)!,
        ]),
      ),
      thisPage: this.#objects.get(this.page)!,
      project: this.#objects.get(this.project)!,
    };
    const name = `${MESSAGE_SCRIPT}${++this.#messages}`;
    this.group.load({
      name,
      source,
      objects,
      grants: this.#grants,
    });
    return name;
  }
  #targets = new Map<
    string,
    LoadedMessageTarget & { commands: Map<string, string>; next: number }
  >();
  #nextTarget = 0;
  #commandUnits = new Set<string>();
  #commandRequests = new Map<string, { error?: string }>();

  get messageTargets(): LoadedMessageTarget[] {
    return this.ended
      ? []
      : [...this.#targets.values()].map(({ id, label, source, manifest }) => ({
          id,
          label,
          source,
          manifest,
        }));
  }

  /** The loaded instance corresponding to one authored editor identity. */
  messageTargetForOwner(id: number): number | undefined {
    for (const [name, target] of this.#targets) {
      const owner = this.#owners.get(name);
      if (owner && ownerId(this.#authored.get(owner) ?? owner) === id) {
        return target.id;
      }
    }
    return undefined;
  }

  #runTargetedMessage(
    command: string,
    id: number,
    expression: boolean,
  ): MessageOutcome {
    const entry = [...this.#targets.entries()].find(
      ([, target]) => target.id === id,
    );
    if (!entry) {
      return {
        ok: false,
        error: 'The selected Script is unavailable. Choose a context.',
      };
    }
    const [name, target] = entry;
    const script = this.group.script(name)!;
    let handler = target.commands.get(command);
    if (!handler) {
      if (target.commands.size >= MESSAGE_HANDLER_LIMIT) {
        return {
          ok: false,
          error:
            'This Script has reached 1,000 distinct commands. Restart Play to run a new command.',
        };
      }
      handler = messageHandler(
        target.source + JSON.stringify(target.manifest.objects),
        target.next,
      );
      let first: string | undefined;
      let extended = false;
      for (const body of expression
        ? [`return ${command}`]
        : [`return ${command}`, command]) {
        const source = `on ${handler}\n${body}\nend ${handler}`;
        try {
          // A command cannot escape its wrapper to add Script declarations.
          const tree = parseSource(source).tree as CstNode | null;
          if (
            tree &&
            tree.children?.filter(child => child.rule === 'Declaration')
              .length !== 1
          ) {
            first ??= 'Only statements and expressions are allowed.';
            continue;
          }
          script.extend(source);
          extended = true;
          break;
        } catch (error) {
          if (!(error instanceof LoadError)) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          first ??= error.diagnostics
            .map(d => `line ${d.line - MESSAGE_FIRST_LINE + 1}: ${d.code}`)
            .join('; ');
        }
      }
      if (!extended) {
        return { ok: false, error: first ?? 'Could not run' };
      }
      target.commands.set(command, handler);
      target.next = Number(handler.slice('folioMessage'.length)) + 1;
      this.#commandUnits.add(`${name}+${target.commands.size}`);
    }
    try {
      const request = script.request({ name: handler });
      const outcome: { error?: string } = {};
      this.#commandRequests.set(request.id, outcome);
      return {
        ok: true,
        delivery: request.id,
        result: request.result
          .catch((error: unknown) => {
            throw new Error(
              outcome.error ??
                (error instanceof Error ? error.message : String(error)),
            );
          })
          .finally(() => this.#commandRequests.delete(request.id)),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  #messages = 0;
  #watchPage: PlaySession['page'] | undefined;
  #watchScripts = new Map<string, string>();
  #librarySources = new Map<string, DeepReadonly<ProjectLibrary>>();
  #messageErrors = new Map<string, string>();

  #load(owners: ScriptOwner[]): void {
    const pages = Object.fromEntries(
      this.project.pages.map(p => [p.name, this.#objects.get(p)!]),
    );
    const pageObjects = {
      ...pages,
      ...Object.fromEntries(
        allElements(this.page.elements).map(e => [
          e.name,
          this.#objects.get(e)!,
        ]),
      ),
      thisPage: this.#objects.get(this.page)!,
      project: this.#objects.get(this.project)!,
    };
    for (const owner of owners) {
      if (!owner.script?.trim()) {
        continue;
      }
      const id = this.#objects.get(owner)!.id;
      const suffix = id.startsWith('dynamic:') ? `:${id}` : '';
      const name =
        owner === this.project
          ? PROJECT_UNIT
          : owner === this.page
            ? `page:${this.page.name}`
            : `element:${this.page.name}/${owner.name}${suffix}`;
      this.#owners.set(name, owner);
      this.#scripts.set(owner, name);
      const objects = owner === this.project ? pages : pageObjects;
      try {
        this.#frames.delete(name);
        this.#targets.delete(name);
        for (const unit of this.#commandUnits) {
          if (unit.startsWith(`${name}+`)) {
            this.#commandUnits.delete(unit);
          }
        }
        const existing = this.group.script(name);
        if (existing) {
          const reports = existing.reload(owner.script, 'reset variables');
          this.fuel.observe(reports);
          this.performance.reports(reports);
        } else {
          this.group.load({
            name,
            source: owner.script,
            owner: this.#objects.get(owner),
            objects,
            grants: this.#grants,
          });
        }
        this.#targets.set(name, {
          id: ++this.#nextTarget,
          label: unitLabel(name),
          source: owner.script,
          manifest: scriptManifest(this.project, owner),
          commands: new Map(),
          next: 1,
        });
        if (definesHandler(owner.script, 'frame')) {
          this.#frames.set(name, { busy: false, last: undefined });
          this.performance.frameScript(name);
        }
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        for (const diagnostic of error.diagnostics) {
          this.problems.push({
            owner: this.#authored.get(owner)!,
            line: diagnostic.line,
            message: diagnostic.code,
          });
        }
      }
    }
  }

  /** Changes Page as a Script's `go to` does, by closing this one first. */
  goTo(index: number): void {
    if (!this.ended && !this.#closing) {
      this.#requestedPage = index;
    }
  }

  get navigating(): boolean {
    return this.#closing !== undefined || this.#requestedPage !== undefined;
  }

  #finishNavigation(): void {
    const closing = this.#closing!;
    closing.cancel.abort();
    for (const [name, owner] of this.#owners) {
      if (scriptPage(this.project, owner) === this.page) {
        this.sounds.stopOwner(name);
        this.#frames.delete(name);
        this.group.script(name)?.stop('Left Page');
        this.#targets.delete(name);
      }
    }
    this.pageIndex = closing.target;
    this.#closing = undefined;
    this.#load([this.page, ...allElements(this.page.elements)]);
    this.changed = true;
    this.send(this.page, 'openPage');
  }

  // Reports omit Script-sent unhandled messages. The public Trace carries
  // those messages and the Segment's sender; collect immediate records until
  // their enclosing Segment record identifies the executing Script.
  #trace(line: string): void {
    const segment = /^seg (\S+) (?:start|resume|continue)\b/u.exec(line);
    if (segment) {
      const run = segment[1]!;
      const sender = / from=(\S+)/u.exec(line)?.[1];
      if (sender) {
        this.#senders.set(run, sender);
      }
      for (const message of this.#pendingWarnings) {
        this.#warn(run, message);
      }
      this.#pendingWarnings = [];
      this.#unhandledSender = undefined;
    }
    const ended = /^run (\S+) outcome=(\S+)/u.exec(line);
    if (ended) {
      this.#unhandledSender =
        ended[2] === 'unhandled' ? this.#senders.get(ended[1]!) : undefined;
      this.#senders.delete(ended[1]!);
    }
    const unhandled = /^unhandled message=(\S+)/u.exec(line);
    if (unhandled) {
      if (this.#unhandledSender) {
        this.#warn(this.#unhandledSender, unhandled[1]!);
      } else {
        this.#pendingWarnings.push(unhandled[1]!);
      }
      this.#unhandledSender = undefined;
    }
  }

  #warn(run: string, message: string): void {
    const owner = this.#owners.get(run.replace(/\/r\d+.*$/u, ''));
    if (owner) {
      this.problems.push({
        owner: this.#authored.get(owner)!,
        line: 1,
        message: `Unhandled message: ${message}`,
      });
    }
  }

  get page() {
    return this.project.pages[this.pageIndex]!;
  }

  /** The Object Kind this session declared under `name`. */
  objectKind(name: string): ObjectKind<ScriptOwner> | undefined {
    return this.#kinds.get(name);
  }

  /** Whether a message sent to `owner` meets a Handler on its Message Path. */
  handles(owner: ScriptOwner, message: PlayMessage): boolean {
    const path: ScriptOwner[] = [owner];
    let current = owner;
    while ('kind' in current) {
      current = this.#tree.parentOf(current)!;
      path.push(current);
    }
    if (current !== this.project) {
      path.push(this.project);
    }
    return path.some(o => !!o.script && definesHandler(o.script, message));
  }

  send(owner: ScriptOwner, name: PlayMessage, args: Value[] = []): void {
    if (this.ended || this.navigating) {
      return;
    }
    try {
      this.group.deliver(this.#objects.get(owner)!, { name, args });
    } catch (error) {
      // MailboxFull is the Core's load-shedding exception.
      // eslint-disable-next-line @nkzw/no-instanceof
      if (!(error instanceof MailboxFull)) {
        throw error;
      }
      this.problems.push({
        owner: this.#authored.get(owner)!,
        line: 1,
        message: 'Too many pending messages',
      });
    }
  }

  /** Whether any Script handles `frame`, so the browser should ask for frames. */
  get wantsFrames(): boolean {
    return !this.ended && this.#frames.size > 0;
  }

  /**
   * Sends `frame` straight to each Script that handles it, never up the
   * Message Path. A Script whose last `frame` Run hasn't ended skips this
   * one; its next `elapsed` covers the time since the one it last got.
   */
  frame(now: bigint): void {
    if (this.ended || this.navigating) {
      return;
    }
    for (const [name, state] of this.#frames) {
      this.performance.frame(name, state.busy);
      if (state.busy) {
        continue;
      }
      const elapsed =
        state.last === undefined
          ? 0
          : Math.round(Number(now - state.last) / 1000);
      state.last = now;
      state.busy = true;
      const done = () => {
        state.busy = false;
      };
      void this.group
        .script(name)!
        .request({ name: 'frame', args: [num(elapsed)] })
        .result.then(done, done);
    }
  }

  /** `:fuel` commands' Fuel Measurements (ADR 0141). */
  readonly fuel = new FuelMeasurements();

  /** How many turns have run, so readers of Script state can skip a repeat. */
  pumps = 0;

  /** One bounded turn; the browser schedules another turn only after yielding. */
  /**
   * `outOfBand` Pumps, run while paused, stay out of the Pump peaks.
   * `advance`, given, continues a Pump the debugger stopped instead of
   * starting one. A Pump that stops returns at once, its result provisional:
   * it finishes, and is accounted, when a later `advance` completes it.
   */
  pump(now: bigint, outOfBand = false, advance?: () => PumpResult) {
    this.pumps++;
    if (
      this.#closing &&
      (this.#closing.done || now >= this.#closing.deadline)
    ) {
      this.#finishNavigation();
    }
    const result =
      advance?.() ??
      this.group.pump(now, {
        fuelSlice: 1000,
        fuelCap: PUMP_FUEL,
      });
    if (this.debugPaused) {
      return result;
    }
    this.fuel.observe(result.reports);
    this.performance.reports(
      result.reports,
      outOfBand ? undefined : result.fuelUsed,
    );
    this.#releaseDrawings(result);
    const clones = this.#pendingClones;
    this.#pendingClones = [];
    if (!this.ended) {
      this.#load(
        clones.filter(element => this.#tree.pageOf(element) === this.page),
      );
    }
    for (const report of result.reports) {
      if (
        report.kind !== 'run end' ||
        (report.outcome !== 'errored' && report.outcome !== 'limit fault')
      ) {
        continue;
      }
      const error = report.error?.message ?? `${report.limit} limit reached`;
      const command = report.delivery
        ? this.#commandRequests.get(report.delivery)
        : undefined;
      const generated = report.at
        ? this.#commandUnits.has(report.at.unit)
        : command !== undefined;
      const ownerless = report.script.startsWith(MESSAGE_SCRIPT);
      const line = Math.max(
        1,
        (report.at?.line ?? MESSAGE_FIRST_LINE) -
          (generated || ownerless ? MESSAGE_FIRST_LINE - 1 : 0),
      );
      if (command) {
        command.error = `${generated ? '' : `${report.script}: `}line ${line}: ${error}`;
      }
      if (ownerless) {
        this.#messageErrors.set(report.script, `line ${line}: ${error}`);
      }
      if (!ownerless && !generated) {
        const owner = this.#owners.get(report.script);
        if (owner) {
          const library = report.at
            ? this.#librarySources.get(report.at.unit)
            : undefined;
          this.problems.push({
            owner: this.#authored.get(owner) ?? owner,
            line,
            message: error,
            ...(library
              ? { target: { kind: 'library' as const, library } }
              : {}),
          });
        }
      }
    }
    const target = this.#requestedPage;
    this.#requestedPage = undefined;
    if (!this.ended && target !== undefined && target !== this.pageIndex) {
      const cancel = new AbortController();
      const request = this.group.request(
        this.#objects.get(this.page)!,
        { name: 'closePage' },
        { signal: cancel.signal },
      );
      const closing = {
        target,
        deadline: now + 1_000_000n,
        id: request.id,
        cancel,
        done: false,
      };
      this.#closing = closing;
      const complete = () => {
        closing.done = true;
      };
      void request.result.then(complete, complete);
      return { ...result, state: 'sliced' as const };
    }
    if (
      this.#closing &&
      result.reports.some(
        report =>
          (report.kind === 'run end' || report.kind === 'unhandled') &&
          report.delivery === this.#closing!.id,
      )
    ) {
      return { ...result, state: 'sliced' as const };
    }
    if (this.#closing) {
      return {
        ...result,
        nextDeadline:
          result.nextDeadline !== undefined &&
          result.nextDeadline < this.#closing.deadline
            ? result.nextDeadline
            : this.#closing.deadline,
      };
    }
    return result;
  }

  /**
   * Releases held Drawings whose Run has ended, or all of them once the Pump
   * ran out of work rather than Fuel: a Run waiting on time or an answer
   * shows what it drew so far.
   */
  #releaseDrawings(result: Pick<PumpResult, 'reports' | 'state'>): void {
    if (!this.#heldDrawings.size) {
      return;
    }
    if (result.state !== 'sliced') {
      this.#heldDrawings.clear();
      return;
    }
    const ended = new Set<string>();
    for (const report of result.reports) {
      if (report.kind === 'run accounting' && report.state !== 'live') {
        ended.add(report.run);
      }
    }
    for (const [element, run] of this.#heldDrawings) {
      if (ended.has(run)) {
        this.#heldDrawings.delete(element);
      }
    }
  }

  stop(now: bigint): void {
    if (this.ended) {
      return;
    }
    if (this.debugPaused) {
      // The Group refuses every call while a Run is stopped, so the stopped
      // Run is abandoned with the session rather than asked to stop.
      this.ended = true;
      this.sounds.stopAll();
      this.notices.length = 0;
      return;
    }
    this.ended = true;
    // Stop silences every sound at once, before Scripts are asked to stop
    // (ADR 0086); the Play view's Stop and Escape reach here as they leave.
    this.sounds.stopAll();
    this.notices.length = 0;
    this.#closing?.cancel.abort();
    this.#closing = undefined;
    this.#requestedPage = undefined;
    for (const name of this.group.scriptNames()) {
      this.group.script(name)!.stop('Stopped by reader');
    }
    this.pump(now);
    this.performance.stop();
  }
}
