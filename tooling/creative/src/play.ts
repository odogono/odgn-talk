// A Play Session owns its Group and a disposable copy of the authored Project.
import { elementNamesTaken, scriptNameProblems } from './script-names';
import {
  bool,
  defineObjectKind,
  defineCapability,
  LoadError,
  MailboxFull,
  newGroup,
  num,
  ScriptError,
  shape,
  text,
  type HostObject,
  type ReleaseHook,
  type ObjectKind,
  type PropDef,
  type Value,
} from '@odgn/northtalk';
import {
  createElement,
  duplicateElement,
  ELEMENT_KINDS,
  freshName,
  isIdentifierName,
  replacePlainText,
  textOf,
  type Element,
  type ElementKind,
  type Page,
  type Project,
} from './model';
import {
  scriptManifest,
  scriptPage,
  type ScriptOwner,
} from './script-manifest';
import { isSoundAsset, SoundBoard, type SoundBackend } from './sounds';

export type PlayProblem = { line: number; message: string; owner: ScriptOwner };
export type PlayMessage =
  | 'startPlay'
  | 'openPage'
  | 'closePage'
  | 'click'
  | 'pointerEnter'
  | 'pointerLeave'
  | 'keyDown'
  | 'textChanged';

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
  readonly group = newGroup({ name: 'play', trace: line => this.#trace(line) });
  #pendingWarnings: string[] = [];
  #senders = new Map<string, string>();
  #unhandledSender: string | undefined;
  readonly problems: PlayProblem[] = [];
  readonly objects = new Map<ScriptOwner, HostObject<ScriptOwner>>();
  readonly authored = new Map<ScriptOwner, ScriptOwner>();
  readonly owners = new Map<string, ScriptOwner>();
  #kinds = new Map<string, ObjectKind<ScriptOwner>>();
  #nextObject = 0;
  #pendingClones: Element[] = [];
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
      do: (_call, kindValue, pageValue, nameValue) => {
        const kind = kindValue!.asText()! as ElementKind;
        if (!ELEMENT_KINDS.includes(kind)) {
          throw new ScriptError('out of domain', 'Unknown Element kind');
        }
        const page = this.#elementPage(pageValue!);
        const taken = elementNamesTaken(this.project, page);
        const name = nameValue?.asText() ?? freshName(`${kind}1`, taken);
        if (!isIdentifierName(name) || taken.has(name)) {
          throw new ScriptError('out of domain', 'Element name is unavailable');
        }
        return this.#addElement(page, createElement(kind, name)).value;
      },
    },
    clone: {
      mode: 'immediate',
      args: [elementShape],
      result: elementShape,
      cost: { fuel: PUMP_FUEL },
      do: (_call, value) => {
        const { page, element } = this.#element(value!);
        const copy = duplicateElement(
          element,
          elementNamesTaken(this.project, page),
        );
        copy.left += 20;
        copy.top += 20;
        const object = this.#addElement(page, copy);
        this.authored.set(copy, this.authored.get(element)!);
        this.#pendingClones.push(copy);
        return object.value;
      },
    },
    delete: {
      mode: 'fire-and-forget',
      args: [elementShape],
      cost: { fuel: PUMP_FUEL },
      fire: (_call, value) => {
        const { page, element } = this.#element(value!);
        page.elements.splice(page.elements.indexOf(element), 1);
        for (const [name, owner] of this.owners) {
          if (owner === element) {
            this.sounds.stopOwner(name);
            this.group.script(name)?.stop('Element deleted');
          }
        }
        this.group.dispose(this.objects.get(element)!);
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
        const element = page.elements.find(e => e.name === name!.asText());
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
    for (const page of this.project.pages) {
      const element = page.elements.find(
        e => this.objects.get(e) === value.asObject(),
      );
      if (element) {
        return { page, element };
      }
    }
    throw new ScriptError('out of domain', 'Unknown Element');
  }

  #addElement(page: Page, element: Element): HostObject<ScriptOwner> {
    const object = this.group.object(
      this.#kinds.get(element.kind)!,
      `dynamic:${this.#nextObject++}`,
      element,
    );
    this.objects.set(element, object);
    this.authored.set(element, this.authored.get(page)!);
    page.elements.push(element);
    this.group.setParent(object, this.objects.get(page)!);
    this.changed = true;
    return object;
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
    project: Project,
    public pageIndex = 0,
    options: { soundBackend?: SoundBackend } = {},
  ) {
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
    const names = scriptNameProblems(project);
    if (names.length) {
      throw new Error(names.map(p => p.message).join('\n'));
    }
    this.project = structuredClone(project);
    const originals = [
      project,
      ...project.pages.flatMap(p => [p, ...p.elements]),
    ];
    const copies = [
      this.project,
      ...this.project.pages.flatMap(p => [p, ...p.elements]),
    ];
    this.#kinds = new Map(
      scriptManifest(project, project).objectKinds.map(def => {
        const props: Record<string, PropDef<ScriptOwner>> = {};
        for (const prop of def.props) {
          const key = prop.name;
          props[key] = {
            shape:
              prop.shape === 'number'
                ? shape.number
                : prop.shape === 'boolean'
                  ? shape.bool
                  : shape.text,
            get: ({ native }) => {
              const value =
                key === 'text' && 'kind' in native && native.kind === 'text'
                  ? textOf(native)
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
                      key === 'text' &&
                      'kind' in native &&
                      native.kind === 'text'
                    ) {
                      replacePlainText(native, String(next));
                    } else {
                      (native as Record<string, unknown>)[key] = next;
                    }
                    this.changed = true;
                  },
                }
              : {}),
          };
        }
        return [
          def.name,
          defineObjectKind<ScriptOwner>({ name: def.name, props }),
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
      this.group.setParent(
        this.objects.get(page)!,
        this.objects.get(this.project)!,
      );
      for (const element of page.elements) {
        this.group.setParent(
          this.objects.get(element)!,
          this.objects.get(page)!,
        );
      }
    }
    this.#load([this.project, this.page, ...this.page.elements]);
    this.send(this.project, 'startPlay');
    this.send(this.page, 'openPage');
  }

  #load(owners: ScriptOwner[]): void {
    const pages = Object.fromEntries(
      this.project.pages.map(p => [p.name, this.objects.get(p)!]),
    );
    const pageObjects = {
      ...pages,
      ...Object.fromEntries(
        this.page.elements.map(e => [e.name, this.objects.get(e)!]),
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
      const objects = owner === this.project ? pages : pageObjects;
      try {
        const existing = this.group.script(name);
        if (existing) {
          existing.reload(owner.script, 'reset variables');
          continue;
        }
        this.group.load({
          name,
          source: owner.script,
          owner: this.objects.get(owner),
          objects,
          grants: {
            pages: this.#pages.grant(['show'], undefined),
            elements: this.#elements.grant('all', undefined),
            sound: this.#sound.grant('all', this.sounds),
          },
        });
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
        this.group.script(name)?.stop('Left Page');
      }
    }
    this.pageIndex = closing.target;
    this.#closing = undefined;
    this.#load([this.page, ...this.page.elements]);
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
        clones.filter(element => this.page.elements.includes(element)),
      );
    }
    for (const report of result.reports) {
      if (
        report.kind === 'run end' &&
        (report.outcome === 'errored' || report.outcome === 'limit fault')
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
    // (ADR 0086); Back to Edit reaches here through the Play view's leave.
    this.sounds.stopAll();
    this.#closing?.cancel.abort();
    this.#closing = undefined;
    this.#requestedPage = undefined;
    for (const name of this.group.scriptNames()) {
      this.group.script(name)!.stop('Stopped by reader');
    }
    this.pump(now);
  }
}
