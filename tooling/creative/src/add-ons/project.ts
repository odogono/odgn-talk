// Brings a Project's Add-on kinds to life once their Add-ons load (#1901).
// A Project is read before its Add-ons load, so their Elements start as
// placeholders; reading its saved form again turns each one whose Add-on
// has since loaded into its kind, migrated by the kind's own checks.
import type { DeepReadonly } from '../readonly';
import type { Project } from '../model';
import {
  ProjectFileError,
  serializeProject,
  validateProjectJson,
} from '../project-file';
import type { AddOnLoader, AddOnProblem } from './loader';

export const projectWithAddOns = async (
  project: DeepReadonly<Project>,
  loader: AddOnLoader,
): Promise<{ problems: AddOnProblem[]; project: Project }> => {
  const refs = project.addOns ?? [];
  const problems = await loader.load(refs);
  const json = serializeProject(project);
  if (refs.length) {
    // A loaded Add-on is saved at the version that read its Elements.
    json.addOns = refs.map(ref => {
      const entry = loader.entry(ref.id);
      return entry && !problems.some(p => p.id === ref.id)
        ? { ...ref, version: entry.version }
        : ref;
    });
  }
  const result = validateProjectJson(json);
  if ('issues' in result) {
    const [first] = result.issues;
    throw new ProjectFileError(
      `The Project is damaged at ${first!.path}: ${first!.message}.`,
      result.issues,
    );
  }
  return { problems, project: result.project };
};
