import {
  CANVAS_SIGNATURES,
  canvasArgumentValues,
  validateCanvasArguments,
  type CanvasCommand,
} from '@northtalk/tooling/canvas';
import { Drawing, DRAWING_OPERATIONS } from './drawing';
import { compileProjectLibraries } from './libraries';
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
  defineCapability,
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
  userCapability,
  type Call,
  type Group,
  type HostObject,
  type ReleaseHook,
  type ObjectElements,
  type ObjectKind,
  type PropDef,
  type Value,
} from '@northtalk/ts';
import {
  ELEMENT_KINDS,
  type CanvasElement,
  type Element,
  type ElementKind,
  type Page,
  type Project,
  type ProjectLibrary,
  type RichText,
  type TextElement,
} from './model';
import {
  FOLIO_COMMANDS,
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

/** Whether a Script's source declares a Handler for `message`. */
export const definesHandler = (source: string, message: string): boolean => {
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
export type UserPrompt =
  | { kind: 'confirm'; message: string }
  | {
      items: readonly string[];
      kind: 'choose';
      multiple: boolean;
      prompt: string;
    }
  | { fallback: string; kind: 'enter'; message: string };
/** A shown prompt; its answer is ignored once the prompt is taken down. */
export type PendingPrompt = UserPrompt & {
  answer(value: boolean | string | readonly string[] | undefined): void;
  readonly script: string;
};
export type UserNotice = { message: string; title: string };

/** A Message Box command: its result, or why it could not run. */
export type MessageOutcome =
  { ok: true; result: Promise<Value> } | { error: string; ok: false };

// Construction/disposal consumes a Pump's budget so queued Core parent and
// disposal inputs land before a Script can use the changed object graph.
export const PUMP_FUEL = 5000;
const elementShape = shape.oneOf(
  ...ELEMENT_KINDS.map(kind => ({ k: 'object' as const, kind })),
);
const canvasShape = { k: 'object' as const, kind: 'canvas' };
// Releasing a Script's sound Grant stops the sounds it started (#735); the
// board travels as the Grant's binding so this stays a plain function.
const releaseSounds: ReleaseHook<SoundBoard> = context =>
  context.binding.stopOwner(context.scriptName);

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
  /** This session's playing sounds, owned by the Scripts that started them. */
  readonly sounds: SoundBoard;
  readonly group: Group;
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

  #elements = defineCapability('elements', {
    create: {
      mode: 'immediate',
      args: [
        shape.text,
        { k: 'object', kind: 'page' },
        shape.optional(shape.text),
      ],
      result: elementShape,
      cost: { fuel: PUMP_FUEL },
      do: (call, kindValue, pageValue, nameValue) => {
        const kind = kindValue as ElementKind;
        if (!ELEMENT_KINDS.includes(kind) || kind === 'group') {
          throw new ScriptError('out of domain', 'Unknown Element kind');
        }
        const page = this.#elementPage((pageValue as HostObject).value);
        return this.#treeOperation(() => {
          const element = this.#tree.create(
            kind,
            page,
            nameValue ?? undefined,
            {
              authorize: fuel => call.charge(fuel),
              install: (root, parent) => this.#install(root, parent),
            },
          );
          if (element.kind === 'canvas') {
            this.#changedDrawings.add(element);
          }
          return this.#objects.get(element)!.value;
        });
      },
    },
    clone: {
      mode: 'immediate',
      args: [elementShape],
      result: elementShape,
      cost: { fuel: PUMP_FUEL },
      do: (call, value) => {
        const { element } = this.#element(value!);
        return this.#treeOperation(() => {
          const cloned = this.#tree.clone(element, {
            authorize: fuel => call.charge(fuel),
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
    },
    delete: {
      mode: 'fire-and-forget',
      args: [elementShape],
      cost: { fuel: PUMP_FUEL },
      fire: (call, value) => {
        const { element } = this.#element(value!);
        const removed = this.#treeOperation(() =>
          this.#tree.remove(element, { authorize: fuel => call.charge(fuel) }),
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
    },
    find: {
      mode: 'immediate',
      args: [shape.text, { k: 'object', kind: 'page' }],
      result: elementShape,
      cost: { fuel: 1 },
      do: (_call, name, value) => {
        const page = this.#elementPage((value as HostObject).value);
        const element = this.#tree.find(page, name);
        if (!element) {
          throw new ScriptError('out of domain', 'Element not found');
        }
        return this.#objects.get(element)!.value;
      },
    },
  });

  // Each Operation takes its Canvas Element first (ADR 0116).
  #canvas = defineCapability(
    'canvas',
    Object.fromEntries(
      DRAWING_OPERATIONS.map(op => [
        op,
        {
          mode: 'immediate' as const,
          args: [canvasShape, ...CANVAS_SIGNATURES[op]!],
          result: shape.nothing,
          cost: { fuel: 1 },
          errors: [
            { code: 'invalid canvas argument' },
            { code: 'canvas limit' },
          ],
          do: (_call: Call<unknown>, target: unknown, ...args: unknown[]) => {
            const { element } = this.#element((target as HostObject).value);
            const values = canvasArgumentValues(args);
            if (element.kind !== 'canvas') {
              throw new ScriptError('out of domain', 'Not a Canvas Element');
            }
            validateCanvasArguments(op, values);
            this.#drawing(element).add({
              op,
              args: values.map(value => value.toString()),
            });
            this.#changedDrawings.add(element);
            return nothing;
          },
        },
      ]),
    ),
  );

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

  /** The Canvases drawn on, created or cloned since this was last called. */
  takeDrawingChanges(): DeepReadonly<CanvasElement>[] {
    const changed = [...this.#changedDrawings].filter(element =>
      this.#tree.contains(element),
    );
    this.#changedDrawings.clear();
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

  // Folio's Host Commands (ADR 0094): `hide x` is an Operation call in the
  // caller's Run, so a bad argument fails at the calling line.
  #folio = defineCapability('folio', {
    hide: {
      mode: 'fire-and-forget',
      command: true,
      args: [elementShape],
      cost: { fuel: 1 },
      ...FOLIO_COMMANDS.hide,
      examples: [...FOLIO_COMMANDS.hide.examples],
      fire: (_call, value) => this.#setVisible(value!, false),
    },
    show: {
      mode: 'fire-and-forget',
      command: true,
      args: [elementShape],
      cost: { fuel: 1 },
      ...FOLIO_COMMANDS.show,
      examples: [...FOLIO_COMMANDS.show.examples],
      fire: (_call, value) => this.#setVisible(value!, true),
    },
  });

  #setVisible(value: Value, visible: boolean): void {
    const { element } = this.#element(value);
    this.#tree.setProperty(element, 'visible', visible);
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
  #pages = defineCapability('pages', {
    show: {
      mode: 'fire-and-forget',
      args: [{ k: 'object', kind: 'page' }],
      cost: { fuel: 1 },
      fire: (_call, value) => {
        const index = this.project.pages.findIndex(
          p => this.#objects.get(p) === (value as HostObject).value.asObject(),
        );
        if (index < 0) {
          throw new ScriptError('out of domain', 'Unknown Page');
        }
        if (!this.stopped && !this.#closing) {
          this.#requestedPage = index;
        }
      },
    },
  });
  // The release hook stops a Script's sounds whenever the Core stops,
  // reloads or revokes it, so no lifecycle path can leak a voice (#735).
  #sound = defineCapability<SoundBoard>()(
    'sound',
    {
      play: {
        mode: 'fire-and-forget',
        args: [shape.text],
        cost: { fuel: 1 },
        fire: (call, value) => this.#playSound(call.scriptName, value!, false),
      },
      loop: {
        mode: 'fire-and-forget',
        args: [shape.text],
        cost: { fuel: 1 },
        fire: (call, value) => this.#playSound(call.scriptName, value!, true),
      },
      stop: {
        mode: 'fire-and-forget',
        args: [shape.optional(shape.text)],
        cost: { fuel: 1 },
        fire: (call, value) =>
          this.sounds.stop(call.scriptName, value ?? undefined),
      },
    },
    undefined,
    releaseSounds,
  );

  /** Unanswered prompts, oldest first; the Play view shows the first. */
  readonly prompts: PendingPrompt[] = [];
  /** Notices not yet shown; the Play view takes them. */
  readonly notices: UserNotice[] = [];
  #user = userCapability(
    {
      confirm: (call, message) => this.#ask(call, { kind: 'confirm', message }),
      choose: (call, items, prompt, multiple) =>
        this.#ask(call, { kind: 'choose', items, prompt, multiple }),
      enter: (call, message, fallback) =>
        this.#ask(call, { kind: 'enter', message, fallback }),
      notify: (_call, message, title) => {
        if (!this.stopped) {
          this.notices.push({ message, title });
          this.changed = true;
        }
      },
    },
    Object.fromEntries(
      ['confirm', 'choose', 'enter', 'notify'].map(name => [name, { fuel: 1 }]),
    ),
  );

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

  #grants() {
    return {
      pages: this.#pages.grant(['show'], undefined),
      elements: this.#elements.grant('all', undefined),
      sound: this.#sound.grant('all', this.sounds),
      user: this.#user.grant('all', undefined),
      folio: this.#folio.grant('all', undefined),
      canvas: this.#canvas.grant('all', undefined),
    };
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

  stopped = false;
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
    const declarations = Object.fromEntries(
      Object.entries(this.#grants()).map(([name, grant]) => [
        name,
        Object.fromEntries(
          [...grant.ops].map(op => {
            const declaration = grant.capability.operations.get(op)!;
            return [
              op,
              {
                mode: declaration.mode,
                args: declaration.args ?? [],
                ...(declaration.labels ? { labels: declaration.labels } : {}),
                ...(declaration.command ? { command: true } : {}),
              },
            ];
          }),
        ),
      ]),
    );
    const compiled = compileProjectLibraries(project.libraries, declarations);
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
    if (this.stopped || this.navigating) {
      return { ok: false, error: 'The Page is changing; try again.' };
    }
    if (target !== undefined) {
      return this.#runTargetedMessage(command, target);
    }
    let first: string | undefined;
    for (const source of [
      messageSource(command),
      messageSource(`return ${command}`),
    ]) {
      try {
        const name = this.#loadMessage(source);
        const request = this.group.script(name)!.request({
          name: 'runMessage',
        });
        return {
          ok: true,
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
      grants: this.#grants(),
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
    return this.stopped
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

  #runTargetedMessage(command: string, id: number): MessageOutcome {
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
      for (const body of [`return ${command}`, command]) {
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
          this.performance.reports(
            existing.reload(owner.script, 'reset variables'),
          );
        } else {
          this.group.load({
            name,
            source: owner.script,
            owner: this.#objects.get(owner),
            objects,
            grants: this.#grants(),
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
    if (this.stopped || this.navigating) {
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
    return !this.stopped && this.#frames.size > 0;
  }

  /**
   * Sends `frame` straight to each Script that handles it, never up the
   * Message Path. A Script whose last `frame` Run hasn't ended skips this
   * one; its next `elapsed` covers the time since the one it last got.
   */
  frame(now: bigint): void {
    if (this.stopped || this.navigating) {
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

  /** One bounded turn; the browser schedules another turn only after yielding. */
  pump(now: bigint) {
    if (
      this.#closing &&
      (this.#closing.done || now >= this.#closing.deadline)
    ) {
      this.#finishNavigation();
    }
    const result = this.group.pump(now, {
      fuelSlice: 1000,
      fuelCap: PUMP_FUEL,
    });
    this.performance.reports(result.reports, result.fuelUsed);
    const clones = this.#pendingClones;
    this.#pendingClones = [];
    if (!this.stopped) {
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
    if (!this.stopped && target !== undefined && target !== this.pageIndex) {
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

  stop(now: bigint): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
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
