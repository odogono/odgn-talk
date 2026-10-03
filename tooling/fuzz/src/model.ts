import type { Setup } from '@odgn/northtalk/replay';

export const features = [
  'compute',
  'dispatch',
  'suspend',
  'join',
  'decision',
  'error',
  'scope',
  'effect',
  'loop',
  'send',
  'timer',
] as const;
export type Feature = (typeof features)[number];
export type Mutation =
  | 'wrong-mode'
  | 'after-suspension'
  | 'bad-suffixes'
  | 'missing-grant'
  | 'impure-guard';
export type HandlerChoice = {
  kind: Feature;
  name: string;
  policy: '' | 'queued' | 'dropping' | 'replacing';
  repetitions: number;
  status: 'ok' | 'failed' | 'unknown';
  value: number;
};
export type ScriptChoice = { handlers: HandlerChoice[]; name: string };
export type Action =
  | { kind: 'input'; line: string }
  | { kind: 'answer' | 'fail'; nth: number; value: string }
  | { kind: 'cancel-run'; nth: number; script: string }
  | { kind: 'cancel-delivery'; nth: number }
  | { kind: 'restore'; nth: number; variablesOnly?: boolean }
  | {
      how: 'adopt' | 'reissue' | 'answer' | 'fail';
      kind: 'settle';
      nth: number;
      value?: string;
    };
export type FuzzCase = {
  choices: { inputs: Action[]; scripts: ScriptChoice[] };
  commit: string;
  expectedDiagnostic?: string;
  generator: 'scheduler-1';
  inputs: Action[];
  mutation?: Mutation;
  profile: Feature[];
  seed: string;
  setup: Setup;
  version: 1;
};
export type Execution = {
  counts: {
    actions: Record<string, number>;
    applied: number;
    noops: number;
    records: Record<string, number>;
  };
  fingerprints: { action: string; after: string; before: string }[];
  trace: string[];
};
export type Signature = {
  field: string;
  oracle: string;
  owner: string;
  record: string;
};
export type Finding = {
  actual?: string;
  classification: 'semantic' | 'generator' | 'execution';
  expected?: string;
  index?: number;
  message: string;
  signature: Signature;
};
export type Result = {
  checks?: string[];
  execution?: Execution;
  findings: Finding[];
};
export const signatureKey = (s: Signature) => JSON.stringify(s);
export const schemaVersion = 1;

/** Saved sources and inputs are authoritative; choices only enable generation-aware reduction. */
export const readCase = (value: unknown): FuzzCase => {
  const c = value as FuzzCase;
  if (
    !c ||
    c.version !== schemaVersion ||
    !Array.isArray(c.inputs) ||
    !Array.isArray(c.setup?.scripts) ||
    !Array.isArray(c.profile) ||
    typeof c.seed !== 'string' ||
    typeof c.generator !== 'string'
  ) {
    throw new Error('Unsupported or malformed Fuzz Case');
  }
  return c;
};
