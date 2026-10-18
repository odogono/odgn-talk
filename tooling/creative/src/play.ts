import {
  allElements,
  checkHierarchy,
  findElement,
  refreshBounds,
  refreshBox,
  updateGeometry,
  MAX_GROUP_ELEMENTS,
} from './hierarchy';
// A Play Session owns its Group and a disposable copy of the authored Project.
import { castDraft, type Immutable } from 'immer';
import { elementNamesTaken, scriptNameProblems } from './script-names';
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
  createElement,
  duplicateElement,
  ELEMENT_KINDS,
  freshName,
  hasBorder,
  isIdentifierName,
  isTextAlign,
  replacePlainText,
  setTextAlign,
  textAlignOf,
  textOf,
  type Element,
  type ElementKind,
  type GroupElement,
  type Page,
  type Project,
} from './model';
import {
  FOLIO_COMMANDS,
  scriptManifest,
  scriptOwners,
  scriptPage,
  type ScriptOwner as AuthoredOwner,
} from './script-manifest';
import { MESSAGE_FIRST_LINE, messageSource } from './message-script';
import { isSoundAsset, SoundBoard, type SoundBackend } from './sounds';

type ScriptOwner = Project | Page | Element;

export type PlayProblem = {
  line: number;
  message: string;
  owner: AuthoredOwner;
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
const PUMP_FUEL = 5000;
const elementShape = shape.oneOf(
  ...ELEMENT_KINDS.map(kind => ({ k: 'object' as const, kind })),
);
// Releasing a Script's sound Grant stops the sounds it started (#735); the
// board travels as the Grant's binding so this stays a plain function.
const releaseSounds: ReleaseHook<SoundBoard> = context =>
  context.binding.stopOwner(context.scriptName);

export class PlaySession {
  readonly project: Project;
  /** This session's playing sounds, owned by the Scripts that started them. */
  readonly sounds: SoundBoard;
  readonly group: Group;
  #pendingWarnings: string[] = [];
  #senders = new Map<string, string>();
  #unhandledSender: string | undefined;
  readonly problems: PlayProblem[] = [];
  readonly objects = new Map<ScriptOwner, HostObject<ScriptOwner>>();
  readonly authored = new Map<ScriptOwner, Immutable<ScriptOwner>>();
  readonly owners = new Map<string, ScriptOwner>();
  #scripts = new Map<ScriptOwner, string>();
  #kinds = new Map<string, ObjectKind<ScriptOwner>>();
  #nextObject = 0;
  // Each `frame` Script's last delivery time, and whether its Run is pending.
  #frames = new Map<string, { busy: boolean; last: bigint | undefined }>();
  #pendingClones: Element[] = [];
  // Each Page's Elements by name, for `element "x" of aPage` and the
  // `elements` Grant's `find`; kept in step with create, clone and delete.
  #names = new Map<Page, Map<string, Element>>();
  #ordered = new Map<Page, Element[]>();
  #parents = new Map<Immutable<Element>, Page | GroupElement>();
  #outer = new Map<Element, Element>();
  #pagesOf = new Map<Immutable<Element>, Page>();
  #memberNames = new Map<GroupElement, Map<string, Element>>();
  #copyWork = new Map<Element, number>();
  #ownWork = new Map<Element, number>();
  #fieldWork = new Map<Element, Map<string, number>>();
  // Both collection shapes use maintained views, never a per-read traversal.
  #pageElements: ObjectElements<ScriptOwner> = {
    shape: elementShape,
    count: ({ native }) => num(this.#members(native).length),
    at: ({ native }, index) => {
      const members = this.#members(native);
      const member = members[index > 0 ? index - 1 : members.length + index];
      return member ? this.objects.get(member)!.value : nothing;
    },
    find: ({ native }, name) => {
      const member =
        'kind' in native && native.kind === 'group'
          ? this.#memberNames.get(native)?.get(name)
          : this.#names.get(native as Page)?.get(name);
      return member ? this.objects.get(member)!.value : nothing;
    },
    countCost: { fuel: 1, alloc: 0 },
    atCost: { fuel: 1, alloc: 0 },
    findCost: { fuel: 1, alloc: 0 },
  };
  #members(owner: ScriptOwner): Element[] {
    return 'kind' in owner && owner.kind === 'group'
      ? owner.members
      : this.#ordered.get(owner as Page)!;
  }
  #indexPage(page: Page): void {
    // A flat Page's collection is its element list itself, so direct layer
    // changes stay visible; nested content needs a postorder view.
    const ordered = page.elements.some(
      e => e.kind === 'group' && e.members.length > 0,
    )
      ? allElements(page.elements)
      : page.elements;
    this.#ordered.set(page, ordered);
    this.#names.set(page, new Map(ordered.map(e => [e.name, e])));
    for (const e of page.elements) {
      this.#indexSubtree(e, page, e, page);
    }
  }
  /** Index one subtree's own maps; the Page-wide views are the caller's. */
  #indexSubtree(
    root: Element,
    rootParent: Page | GroupElement,
    outer: Element,
    page: Page,
  ): void {
    const visit = (e: Element, parent: Page | GroupElement) => {
      this.#parents.set(e, parent);
      this.#outer.set(e, outer);
      this.#pagesOf.set(e, page);
      if (!this.#ownWork.has(e)) {
        const fields = new Map(
          Object.entries(e)
            .filter(([key]) => key !== 'members')
            .map(([key, value]) => [key, this.#fieldSize(value)]),
        );
        this.#fieldWork.set(e, fields);
        this.#ownWork.set(
          e,
          128 + [...fields.values()].reduce((n, size) => n + size, 0),
        );
      }
      if (e.kind === 'group') {
        this.#memberNames.set(e, new Map(e.members.map(m => [m.name, m])));
        for (const member of e.members) {
          visit(member, e);
        }
      }
      this.#copyWork.set(
        e,
        this.#ownWork.get(e)! +
          (e.kind === 'group'
            ? e.members.reduce((n, m) => n + this.#copyWork.get(m)!, 0)
            : 0),
      );
    };
    visit(root, rootParent);
  }
  /** Containing groups, innermost first. */
  #groupsAbove(element: Element): GroupElement[] {
    const groups: GroupElement[] = [];
    let parent = this.#parents.get(element);
    while (parent && 'kind' in parent) {
      groups.push(parent);
      parent = this.#parents.get(parent);
    }
    return groups;
  }
  #fieldSize(value: unknown): number {
    // Numeric coordinates and booleans have fixed copy work, independent of
    // their display spelling. Content sizes include JSON escaping overhead.
    return typeof value === 'number' || typeof value === 'boolean'
      ? 64
      : (JSON.stringify(value)?.length ?? 0);
  }
  /** Reader editing and Script content writes keep clone authorization current. */
  contentChanged(element: Element, key = 'richText'): void {
    const fields = this.#fieldWork.get(element)!;
    const size = this.#fieldSize((element as Record<string, unknown>)[key]);
    const delta = size - (fields.get(key) ?? 0);
    fields.set(key, size);
    this.#ownWork.set(element, this.#ownWork.get(element)! + delta);
    let member = element;
    // No sibling scans or serialization of unchanged content on scalar writes.
    while (true) {
      this.#copyWork.set(member, this.#copyWork.get(member)! + delta);
      const parent = this.#parents.get(member);
      if (!parent || !('kind' in parent)) {
        break;
      }
      member = parent;
    }
    this.changed = true;
  }
  /** Effective reader visibility; each Element's own visible stays separate. */
  isVisible(element: Immutable<Element>): boolean {
    if (!this.#pagesOf.has(element)) {
      return false;
    }
    let owner: Immutable<Element | Page> = element;
    while ('kind' in owner) {
      if (!owner.visible) {
        return false;
      }
      owner = this.#parents.get(owner)!;
    }
    return true;
  }
  elementsOf(page: Page = this.page): readonly Element[] {
    return this.#ordered.get(page)!;
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
        const kind = kindValue!.asText()! as ElementKind;
        if (!ELEMENT_KINDS.includes(kind) || kind === 'group') {
          throw new ScriptError('out of domain', 'Unknown Element kind');
        }
        const page = this.#elementPage(pageValue!);
        const taken = elementNamesTaken(this.project, page);
        const name = nameValue?.asText() ?? freshName(`${kind}1`, taken);
        if (!isIdentifierName(name) || taken.has(name)) {
          throw new ScriptError('out of domain', 'Element name is unavailable');
        }
        call.charge(this.#ordered.get(page)!.length * 8);
        return this.#addElement(page, createElement(kind, name)).value;
      },
    },
    clone: {
      mode: 'immediate',
      args: [elementShape],
      result: elementShape,
      cost: { fuel: PUMP_FUEL },
      do: (call, value) => {
        const { page, element } = this.#element(value!);
        const parent = this.#parents.get(element)!;
        const outer = this.#outer.get(element)!;
        const count = allElements([element]).length;
        if (
          'kind' in parent &&
          allElements([outer]).length + count > MAX_GROUP_ELEMENTS
        ) {
          throw new ScriptError(
            'out of domain',
            'Cloning would exceed the group Element limit',
          );
        }
        call.charge(
          this.#copyWork.get(element)! +
            this.#copyWork.get(outer)! +
            this.#ordered.get(page)!.length * 8,
        );
        const copy = duplicateElement(
          element,
          elementNamesTaken(this.project, page),
        );
        try {
          updateGeometry(copy, copy, {
            left: copy.left + 20,
            top: copy.top + 20,
          });
        } catch (error) {
          throw new ScriptError('out of domain', String(error));
        }
        // Check ancestor bounds before publishing any new member or handle.
        const staged = structuredClone(outer);
        if ('kind' in parent) {
          const stagedParent = findElement([staged], parent.name)!;
          if (stagedParent.kind === 'group') {
            stagedParent.members.push(copy);
          }
          try {
            refreshBounds([staged]);
          } catch (error) {
            throw new ScriptError('out of domain', String(error));
          }
        }
        const object = this.#addElement(page, copy, parent);
        const originals = allElements([element]);
        const copies = allElements([copy]);
        copies.forEach((member, i) =>
          this.authored.set(member, this.authored.get(originals[i]!)!),
        );
        this.#pendingClones.push(...copies);
        return object.value;
      },
    },
    delete: {
      mode: 'fire-and-forget',
      args: [elementShape],
      cost: { fuel: PUMP_FUEL },
      fire: (call, value) => {
        const { page, element } = this.#element(value!);
        const removed = allElements([element]);
        call.charge(this.#ordered.get(page)!.length * 8 + removed.length * 8);
        const parent = this.#parents.get(element)!;
        const groups = this.#groupsAbove(element);
        const siblings = 'kind' in parent ? parent.members : parent.elements;
        siblings.splice(siblings.indexOf(element), 1);
        // A subtree is contiguous in postorder, ending at its root. A flat
        // Page's collection is `siblings` itself, already updated.
        const ordered = this.#ordered.get(page)!;
        if (ordered !== siblings) {
          ordered.splice(
            ordered.indexOf(element) - removed.length + 1,
            removed.length,
          );
        }
        const names = this.#names.get(page)!;
        if ('kind' in parent) {
          this.#memberNames.get(parent)!.delete(element.name);
        }
        const work = this.#copyWork.get(element)!;
        for (const group of groups) {
          this.#copyWork.set(group, this.#copyWork.get(group)! - work);
        }
        for (const member of removed) {
          const name = this.#scripts.get(member);
          if (name) {
            this.sounds.stopOwner(name);
            this.#frames.delete(name);
            this.group.script(name)?.stop('Element deleted');
            this.#scripts.delete(member);
          }
          this.group.dispose(this.objects.get(member)!);
          names.delete(member.name);
          this.#parents.delete(member);
          this.#pagesOf.delete(member);
          this.#outer.delete(member);
          this.#memberNames.delete(member as GroupElement);
          this.#copyWork.delete(member);
          this.#ownWork.delete(member);
          this.#fieldWork.delete(member);
        }
        // Removing members can only shrink finite bounds. Empty groups keep
        // their previous left/top and their own Script and identity.
        groups.forEach(refreshBox);
        this.changed = true;
      },
    },
    find: {
      mode: 'immediate',
      args: [shape.text, { k: 'object', kind: 'page' }],
      result: elementShape,
      cost: { fuel: 1 },
      do: (_call, name, value) => {
        const page = this.#elementPage(value!);
        const element = this.#names.get(page)!.get(name!.asText()!);
        if (!element) {
          throw new ScriptError('out of domain', 'Element not found');
        }
        return this.objects.get(element)!.value;
      },
    },
  });

  #elementPage(value: Value): Page {
    const page = this.project.pages.find(
      p => this.objects.get(p) === value.asObject(),
    );
    if (!page) {
      throw new ScriptError('out of domain', 'Unknown Page');
    }
    return page;
  }

  #element(value: Value): { element: Element; page: Page } {
    const object = value.asObject();
    const element = object?.native as Element | undefined;
    const page = element && this.#pagesOf.get(element);
    if (element && page && this.objects.get(element) === object) {
      return { page, element };
    }
    throw new ScriptError('out of domain', 'Unknown Element');
  }

  #addElement(
    page: Page,
    element: Element,
    parent: Page | GroupElement = page,
  ): HostObject<ScriptOwner> {
    const install = (member: Element, owner: Page | GroupElement): void => {
      const object = this.group.object(
        this.#kinds.get(member.kind)!,
        `dynamic:${this.#nextObject++}`,
        member,
      );
      this.objects.set(member, object);
      this.authored.set(member, this.authored.get(page)!);
      this.group.setParent(object, this.objects.get(owner)!);
      if (member.kind === 'group') {
        for (const child of member.members) {
          install(child, member);
        }
      }
    };
    install(element, parent);
    const added = allElements([element]);
    const ordered = this.#ordered.get(page)!;
    const flat = ordered === page.elements;
    const names = this.#names.get(page)!;
    if ('kind' in parent) {
      parent.members.push(element);
      if (flat) {
        // The Page's first nested member: its collection becomes a view.
        this.#ordered.set(page, allElements(page.elements));
      } else {
        // The new last member sits just before its group in postorder.
        ordered.splice(ordered.indexOf(parent), 0, ...added);
      }
      this.#memberNames.get(parent)!.set(element.name, element);
      this.#indexSubtree(element, parent, this.#outer.get(parent)!, page);
    } else {
      page.elements.push(element);
      if (!flat) {
        ordered.push(...added);
      } else if (added.length > 1) {
        this.#ordered.set(page, allElements(page.elements));
      }
      this.#indexSubtree(element, page, element, page);
    }
    for (const member of added) {
      names.set(member.name, member);
    }
    const work = this.#copyWork.get(element)!;
    for (const group of this.#groupsAbove(element)) {
      this.#copyWork.set(group, this.#copyWork.get(group)! + work);
      refreshBox(group);
    }
    this.changed = true;
    return this.objects.get(element)!;
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
    if (element.visible !== visible) {
      element.visible = visible;
      this.changed = true;
    }
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
          p => this.objects.get(p) === value.asObject(),
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
  #sound = defineCapability<SoundBoard>(
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
          this.sounds.stop(call.scriptName, value?.asText() ?? undefined),
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
    };
  }

  #playSound(owner: string, value: Value, loop: boolean): void {
    const name = value.asText()!;
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
    project: Immutable<Project>,
    public pageIndex = 0,
    options: {
      events?: boolean;
      /**
       * Seeds the generator `random` draws from, so a test can repeat a
       * game; 0 when absent. Browse and Present pass the clock.
       */
      seed?: bigint;
      soundBackend?: SoundBackend;
    } = {},
  ) {
    this.group = newGroup({
      name: 'play',
      trace: line => this.#trace(line),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    this.sounds = new SoundBoard(options.soundBackend, (sound, message) => {
      const owner = this.owners.get(sound.owner);
      if (owner) {
        this.problems.push({
          owner: this.authored.get(owner)!,
          line: 1,
          message: `Sound “${sound.name}” could not play: ${message}`,
        });
      }
    });
    checkHierarchy(project.pages.flatMap(page => page.elements));
    const names = scriptNameProblems(project);
    if (names.length) {
      throw new Error(names.map(p => p.message).join('\n'));
    }
    this.project = castDraft(structuredClone(project));
    for (const page of this.project.pages) {
      refreshBounds(page.elements);
    }
    const originals = scriptOwners(project);
    const copies = scriptOwners(this.project);
    this.#kinds = new Map(
      scriptManifest(project, project).objectKinds.map(def => {
        const props: Record<string, PropDef<ScriptOwner>> = {};
        for (const prop of def.props) {
          const key = prop.name;
          props[key] = {
            ...(prop.setCost ? { setCost: prop.setCost } : {}),
            shape:
              prop.shape === 'number'
                ? shape.number
                : prop.shape === 'boolean'
                  ? shape.bool
                  : shape.text,
            get: ({ native }) => {
              const value =
                'kind' in native && native.kind === 'text' && key === 'text'
                  ? textOf(native)
                  : 'kind' in native &&
                      native.kind === 'text' &&
                      key === 'textAlign'
                    ? textAlignOf(native)
                    : (native as Record<string, unknown>)[key];
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
                    if (typeof next === 'number' && !Number.isFinite(next)) {
                      throw new ScriptError(
                        'out of domain',
                        'Property must be finite',
                      );
                    }
                    if (
                      key === 'thickness' &&
                      'kind' in native &&
                      hasBorder(native) &&
                      typeof next === 'number' &&
                      next < 0
                    ) {
                      throw new ScriptError(
                        'out of domain',
                        'thickness must be zero or above',
                      );
                    }
                    if (
                      'kind' in native &&
                      ['left', 'top', 'width', 'height'].includes(key)
                    ) {
                      try {
                        updateGeometry(this.#outer.get(native)!, native, {
                          [key]: Number(next),
                        });
                      } catch (error) {
                        throw new ScriptError('out of domain', String(error));
                      }
                    } else if (
                      key === 'text' &&
                      'kind' in native &&
                      native.kind === 'text'
                    ) {
                      replacePlainText(native, String(next));
                    } else if (
                      key === 'textAlign' &&
                      'kind' in native &&
                      native.kind === 'text'
                    ) {
                      if (!isTextAlign(next)) {
                        throw new ScriptError(
                          'out of domain',
                          'textAlign must be left, center, right or justify',
                        );
                      }
                      setTextAlign(native, next);
                    } else {
                      (native as Record<string, unknown>)[key] = next;
                    }
                    if (
                      'kind' in native &&
                      !['left', 'top', 'width', 'height', 'visible'].includes(
                        key,
                      )
                    ) {
                      this.contentChanged(
                        native,
                        key === 'text' || key === 'textAlign'
                          ? 'richText'
                          : key,
                      );
                    }
                    this.changed = true;
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
      this.authored.set(owner, originals[i]!);
      const kind =
        'kind' in owner
          ? owner.kind
          : owner === this.project
            ? 'project'
            : 'page';
      this.objects.set(
        owner,
        this.group.object(this.#kinds.get(kind)!, String(i), owner),
      );
    }
    for (const page of this.project.pages) {
      this.#indexPage(page);
      this.group.setParent(
        this.objects.get(page)!,
        this.objects.get(this.project)!,
      );
      for (const element of allElements(page.elements)) {
        this.group.setParent(
          this.objects.get(element)!,
          this.objects.get(this.#parents.get(element)!)!,
        );
      }
    }
    this.#load([this.project, this.page, ...allElements(this.page.elements)]);
    // A session that only runs Message Box commands sends no events.
    if (options.events !== false) {
      this.send(this.project, 'startPlay');
      this.send(this.page, 'openPage');
    }
  }

  /**
   * Runs a Message Box command against the showing Page, as an
   * ownerless Script with the Page's names and every Grant. A line that is
   * not a statement is tried as an expression, whose value is the result.
   */
  runMessage(command: string): MessageOutcome {
    if (this.stopped || this.navigating) {
      return { ok: false, error: 'The Page is changing; try again.' };
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
        this.project.pages.map(p => [p.name, this.objects.get(p)!]),
      ),
      ...Object.fromEntries(
        allElements(this.page.elements).map(e => [
          e.name,
          this.objects.get(e)!,
        ]),
      ),
      thisPage: this.objects.get(this.page)!,
      project: this.objects.get(this.project)!,
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
  #messages = 0;
  #messageErrors = new Map<string, string>();

  #load(owners: ScriptOwner[]): void {
    const pages = Object.fromEntries(
      this.project.pages.map(p => [p.name, this.objects.get(p)!]),
    );
    const pageObjects = {
      ...pages,
      ...Object.fromEntries(
        allElements(this.page.elements).map(e => [
          e.name,
          this.objects.get(e)!,
        ]),
      ),
      thisPage: this.objects.get(this.page)!,
      project: this.objects.get(this.project)!,
    };
    for (const owner of owners) {
      if (!owner.script?.trim()) {
        continue;
      }
      const id = this.objects.get(owner)!.id;
      const suffix = id.startsWith('dynamic:') ? `:${id}` : '';
      const name =
        owner === this.project
          ? 'project'
          : owner === this.page
            ? `page:${this.page.name}`
            : `element:${this.page.name}/${owner.name}${suffix}`;
      this.owners.set(name, owner);
      this.#scripts.set(owner, name);
      const objects = owner === this.project ? pages : pageObjects;
      try {
        this.#frames.delete(name);
        const existing = this.group.script(name);
        if (existing) {
          existing.reload(owner.script, 'reset variables');
        } else {
          this.group.load({
            name,
            source: owner.script,
            owner: this.objects.get(owner),
            objects,
            grants: this.#grants(),
          });
        }
        if (definesHandler(owner.script, 'frame')) {
          this.#frames.set(name, { busy: false, last: undefined });
        }
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        for (const diagnostic of error.diagnostics) {
          this.problems.push({
            owner: this.authored.get(owner)!,
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
    for (const [name, owner] of this.owners) {
      if (scriptPage(this.project, owner) === this.page) {
        this.sounds.stopOwner(name);
        this.#frames.delete(name);
        this.group.script(name)?.stop('Left Page');
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
    const owner = this.owners.get(run.replace(/\/r\d+.*$/u, ''));
    if (owner) {
      this.problems.push({
        owner: this.authored.get(owner)!,
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
      current = this.#parents.get(current)!;
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
      this.group.deliver(this.objects.get(owner)!, { name, args });
    } catch (error) {
      // MailboxFull is the Core's load-shedding exception.
      // eslint-disable-next-line @nkzw/no-instanceof
      if (!(error instanceof MailboxFull)) {
        throw error;
      }
      this.problems.push({
        owner: this.authored.get(owner)!,
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
    const clones = this.#pendingClones;
    this.#pendingClones = [];
    if (!this.stopped) {
      this.#load(
        clones.filter(element => this.#pagesOf.get(element) === this.page),
      );
    }
    for (const report of result.reports) {
      if (
        report.kind === 'run end' &&
        report.script.startsWith(MESSAGE_SCRIPT) &&
        (report.outcome === 'errored' || report.outcome === 'limit fault')
      ) {
        // The command sits below its wrapping Handler's first line.
        const line =
          (report.at?.line ?? MESSAGE_FIRST_LINE) - MESSAGE_FIRST_LINE + 1;
        this.#messageErrors.set(
          report.script,
          `line ${line}: ${report.error?.message ?? `${report.limit} limit reached`}`,
        );
      }
      if (
        report.kind === 'run end' &&
        (report.outcome === 'errored' || report.outcome === 'limit fault') &&
        // A command's errors go back to the Message Box.
        !report.script.startsWith(MESSAGE_SCRIPT)
      ) {
        const owner = this.owners.get(report.script)!;
        this.problems.push({
          owner: this.authored.get(owner)!,
          line: report.at?.line ?? 1,
          message: report.error?.message ?? `${report.limit} limit reached`,
        });
      }
    }
    const target = this.#requestedPage;
    this.#requestedPage = undefined;
    if (!this.stopped && target !== undefined && target !== this.pageIndex) {
      const cancel = new AbortController();
      const request = this.group.request(
        this.objects.get(this.page)!,
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
  }
}
