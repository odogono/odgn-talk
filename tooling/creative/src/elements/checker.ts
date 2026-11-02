// Reads untrusted Project JSON, collecting every problem rather than
// stopping at the first, so one read reports them all. Shared by the
// Project file and each Element kind's `check`.
import { isIdentifierName } from '../model';

export type ValidationIssue = { message: string; path: string };

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copies an optional field onto `target` only when it is present. */
export const setDefined = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void => {
  if (value !== undefined) {
    target[key] = value;
  }
};

export class Checker {
  /** The URLs of the Add-ons the Project lists, read before its Pages. */
  readonly addOns = new Set<string>();
  readonly elements = new Set<object>();
  readonly names = new Set<string>();
  readonly issues: ValidationIssue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  obj(value: unknown, path: string): Obj | undefined {
    if (!isObj(value)) {
      this.fail(path, 'expected an object');
      return undefined;
    }
    return value;
  }

  arr(value: unknown, path: string): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.fail(path, 'expected a list');
      return undefined;
    }
    return value;
  }

  str(value: unknown, path: string): string | undefined {
    if (typeof value !== 'string') {
      this.fail(path, 'expected text');
      return undefined;
    }
    return value;
  }

  optStr(value: unknown, path: string): string | undefined {
    return value === undefined ? undefined : this.str(value, path);
  }

  bool(value: unknown, path: string): boolean | undefined {
    if (typeof value !== 'boolean') {
      this.fail(path, 'expected true or false');
      return undefined;
    }
    return value;
  }

  optBool(value: unknown, path: string): boolean | undefined {
    return value === undefined ? undefined : this.bool(value, path);
  }

  num(
    value: unknown,
    path: string,
    rule: 'finite' | 'nonNegative' | 'positive',
  ): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, 'expected a number');
      return undefined;
    }
    if (rule === 'positive' && value <= 0) {
      this.fail(path, 'expected a number above zero');
      return undefined;
    }
    if (rule === 'nonNegative' && value < 0) {
      this.fail(path, 'expected zero or above');
      return undefined;
    }
    return value;
  }

  /** Reports every item whose `name` repeats an earlier one in its list. */
  unique(
    items: readonly { name: string }[],
    pathOf: (i: number) => string,
    noun: string,
  ): void {
    const seen = new Set<string>();
    items.forEach(({ name }, i) => {
      if (seen.has(name)) {
        this.fail(
          `${pathOf(i)}.name`,
          `another ${noun} is also named "${name}"`,
        );
      }
      seen.add(name);
    });
  }

  name(value: unknown, path: string): string | undefined {
    const name = this.str(value, path);
    if (name !== undefined && !isIdentifierName(name)) {
      this.fail(path, `"${name}" is not an identifier name`);
      return undefined;
    }
    return name;
  }
}
