// Where a Project's Scripts and Libraries name a sound, for renaming and
// removing it in the Sounds window (#2050). Only names written as literal
// pattern texts are seen: a name built at run time fails only when it plays.
import { parseMiniNotation } from './mini-notation';
import type { DeepReadonly } from './readonly';
import type { Project } from './model';
import { patternTexts } from './pattern-checks';
import { scriptOwners } from './script-manifest';
import { isSoundAsset, soundKey } from './sounds';

/** One literal use of a sound, where the reader can find it. */
export type SoundUse = {
  /** 1-based. */
  line: number;
  /** The Script's owner or the Library, as the reader knows it. */
  where: string;
};

/** `whole` when the literal is just the sound's name, not a pattern word. */
type Span = { from: number; to: number; whole: boolean };

/** The character ranges in `source` that name `sound`, in order. */
const spans = (
  source: string,
  sound: string,
  samplers: ReadonlySet<string>,
): Span[] =>
  patternTexts(source).flatMap(({ offset, on, text }): Span[] => {
    // A Project sound's own name plays the whole sound, spaces and all.
    if (on === undefined && text === sound) {
      return [{ from: offset, to: offset + text.length, whole: true }];
    }
    if (on !== undefined && !samplers.has(on)) {
      return [];
    }
    const parsed = parseMiniNotation(text);
    return parsed.ok
      ? parsed.pattern
          .words()
          .filter(
            word =>
              soundKey(word.value) === sound &&
              text.slice(word.from, word.to) === sound,
          )
          .map(word => ({
            from: offset + word.from,
            to: offset + word.to,
            whole: false,
          }))
      : [];
  });

const samplersOf = (project: DeepReadonly<Project>) =>
  new Set(
    project.instruments.filter(i => i.kind === 'sampler').map(i => i.name),
  );

type Source = { kind: 'library' | 'script'; source: string; where: string };

const sources = (project: DeepReadonly<Project>): Source[] => [
  ...scriptOwners(project).map(owner => ({
    kind: 'script' as const,
    source: owner.script ?? '',
    where:
      owner === project ? 'Project Script' : (owner as { name: string }).name,
  })),
  ...project.libraries.map(library => ({
    kind: 'library' as const,
    source: library.source,
    where: `Library ${library.name}`,
  })),
];

const lineAt = (source: string, offset: number) =>
  source.slice(0, offset).split('\n').length;

/** Every literal use of `sound` in the Project's Scripts and Libraries. */
export const soundUses = (
  project: DeepReadonly<Project>,
  sound: string,
): SoundUse[] => {
  const samplers = samplersOf(project);
  return sources(project).flatMap(({ source, where }) =>
    spans(source, sound, samplers).map(span => ({
      where,
      line: lineAt(source, span.from),
    })),
  );
};

/** `source` with each literal use of `from` naming `to` instead. */
export const renameSoundIn = (
  source: string,
  from: string,
  to: string,
  samplers: ReadonlySet<string>,
): string =>
  spans(source, from, samplers)
    .reverse()
    .reduce(
      (text, span) => text.slice(0, span.from) + to + text.slice(span.to),
      source,
    );

/** Whether `name` reads as one pattern word, as `bd` and `bd:1` do. */
const isPatternWord = (name: string): boolean => {
  const parsed = parseMiniNotation(name);
  if (!parsed.ok) {
    return false;
  }
  const words = parsed.pattern.words();
  return (
    words.length === 1 &&
    words[0]!.from === 0 &&
    words[0]!.to === name.length &&
    soundKey(words[0]!.value) === name
  );
};

/** Why a sound can't be renamed to `name`, or undefined when it can. */
export const soundNameProblem = (
  project: DeepReadonly<Project>,
  current: string,
  name: string,
): string | undefined => {
  if (!name.trim() || name !== name.trim()) {
    return 'A sound’s name can’t be empty or start or end with a space.';
  }
  if (/["\\\n]/u.test(name)) {
    return 'A sound’s name can’t hold quotes, backslashes or line breaks.';
  }
  if (name !== current && project.assets.some(a => a.name === name)) {
    return `The Project already has an asset named “${name}”.`;
  }
  const samplers = samplersOf(project);
  const inPatterns = sources(project).some(({ source }) =>
    spans(source, current, samplers).some(span => !span.whole),
  );
  if (inPatterns && !isPatternWord(name)) {
    return `Patterns play “${current}” among other steps, so its new name must be one word, like bd or bd:1.`;
  }
  return undefined;
};

/** The Project's sound named `name`, if it has one. */
export const soundNamed = (project: DeepReadonly<Project>, name: string) =>
  project.assets.find(a => a.name === name && isSoundAsset(a));
