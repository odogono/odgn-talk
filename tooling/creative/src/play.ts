// A Play Session owns its Group and a disposable copy of the authored Project.
import {
  bool,
  defineObjectKind,
  LoadError,
  MailboxFull,
  newGroup,
  num,
  ScriptError,
  shape,
  text,
  type HostObject,
  type PropDef,
  type Value,
} from '@odgn/northtalk';
import { replacePlainText, textOf, type Project } from './model';
import { scriptManifest, type ScriptOwner } from './script-manifest';

export type PlayProblem = { line: number; message: string; owner: ScriptOwner };
export type PlayMessage =
  | 'startPlay'
  | 'openPage'
  | 'click'
  | 'pointerEnter'
  | 'pointerLeave'
  | 'keyDown'
  | 'textChanged';

export class PlaySession {
  readonly project: Project;
  readonly group = newGroup({ name: 'play', trace: line => this.#trace(line) });
  #pendingWarnings: string[] = [];
  #senders = new Map<string, string>();
  #unhandledSender: string | undefined;
  readonly problems: PlayProblem[] = [];
  readonly objects = new Map<ScriptOwner, HostObject<ScriptOwner>>();
  readonly authored = new Map<ScriptOwner, ScriptOwner>();
  readonly owners = new Map<string, ScriptOwner>();
  stopped = false;
  changed = false;

  constructor(
    project: Project,
    readonly pageIndex = 0,
  ) {
    this.project = structuredClone(project);
    const originals = [
      project,
      ...project.pages.flatMap(p => [p, ...p.elements]),
    ];
    const copies = [
      this.project,
      ...this.project.pages.flatMap(p => [p, ...p.elements]),
    ];
    const kinds = new Map(
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
        this.group.object(kinds.get(kind)!, String(i), owner),
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
    for (const owner of [this.project, this.page, ...this.page.elements]) {
      if (!owner.script?.trim()) {
        continue;
      }
      const name =
        owner === this.project
          ? 'project'
          : owner === this.page
            ? `page:${this.page.name}`
            : `element:${this.page.name}/${owner.name}`;
      this.owners.set(name, owner);
      const objects =
        owner === this.project
          ? Object.fromEntries(
              this.project.pages.map(p => [p.name, this.objects.get(p)!]),
            )
          : {
              ...Object.fromEntries(
                this.page.elements.map(e => [e.name, this.objects.get(e)!]),
              ),
              thisPage: this.objects.get(this.page)!,
              project: this.objects.get(this.project)!,
            };
      try {
        this.group.load({
          name,
          source: owner.script,
          owner: this.objects.get(owner),
          objects,
        });
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        for (const diagnostic of error.diagnostics) {
          this.problems.push({
            owner: originals[copies.indexOf(owner)]!,
            line: diagnostic.line,
            message: diagnostic.code,
          });
        }
      }
    }
    this.send(this.project, 'startPlay');
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
    if (this.stopped) {
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
    const result = this.group.pump(now, { fuelSlice: 1000, fuelCap: 5000 });
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
    return result;
  }

  stop(now: bigint): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const name of this.group.scriptNames()) {
      this.group.script(name)!.stop('Stopped by reader');
    }
    this.pump(now);
  }
}
