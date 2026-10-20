// Folio's Library graph uses the Core's compiler and diagnostics. Registration
// order belongs to the Host; one bad draft must not hide independent code.
import {
  checkSource,
  compileLibrary,
  LoadError,
  type GrantDecls,
  type Library,
  type SemanticElement,
} from '@northtalk/ts';
import type { ProjectLibrary } from './model';
import type { DeepReadonly } from './readonly';
import { libraryNameProblem } from './script-names';

export type LibraryProblem = {
  library: DeepReadonly<ProjectLibrary>;
  line: number;
  message: string;
};

export const compileProjectLibraries = (
  sources: readonly DeepReadonly<ProjectLibrary>[],
  declarations: GrantDecls,
): { libraries: Library[]; problems: LibraryProblem[] } => {
  const libraries: Library[] = [];
  const problems: LibraryProblem[] = [];
  const byName = new Map(sources.map(source => [source.name, source]));
  const duplicates = new Set(
    sources
      .filter(
        (source, i) => sources.findIndex(l => l.name === source.name) !== i,
      )
      .map(l => l.name),
  );
  const state = new Map<string, 'visiting' | 'done' | 'failed'>();
  const visit = (source: DeepReadonly<ProjectLibrary>): boolean => {
    const previous = state.get(source.name);
    if (previous) {
      return previous === 'done';
    }
    state.set(source.name, 'visiting');
    const nameProblem = libraryNameProblem(source.name);
    if (nameProblem || duplicates.has(source.name)) {
      problems.push({
        library: source,
        line: 1,
        message: nameProblem ?? 'Duplicate Library name.',
      });
      state.set(source.name, 'failed');
      return false;
    }
    const tree = checkSource(source.source, { unit: 'library' }).tree;
    const imports: { line: number; name: string }[] = [];
    const collect = (node: SemanticElement): void => {
      if (node.kind === 'name' && node.role === 'library') {
        imports.push({ name: node.text, line: node.span.line });
      } else if (node.kind === 'node') {
        node.children.forEach(collect);
      }
    };
    if (tree) {
      collect(tree.root);
    }
    let blocked = false;
    for (const dependency of imports) {
      const imported = byName.get(dependency.name);
      if (!imported) {
        continue; // The compiler handles stdlib and missing imports.
      }
      const cycle = state.get(imported.name) === 'visiting';
      if (cycle || !visit(imported)) {
        problems.push({
          library: source,
          line: dependency.line,
          message: cycle
            ? 'import cycle'
            : `Library “${dependency.name}” could not load.`,
        });
        blocked = true;
      }
    }
    if (!blocked) {
      try {
        libraries.push(
          compileLibrary(
            { name: source.name, source: source.source, version: '1' },
            libraries,
            declarations,
          ),
        );
        state.set(source.name, 'done');
        return true;
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        problems.push(
          ...error.diagnostics.map(d => ({
            library: source,
            line: d.line,
            message: d.message,
          })),
        );
      }
    }
    state.set(source.name, 'failed');
    return false;
  };
  sources.forEach(visit);
  return { libraries, problems };
};
