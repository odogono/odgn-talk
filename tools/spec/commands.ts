// Documentation commands run from the repository root; workspace commands
// select their package explicitly with --cwd. This checks names, not shell code.
export const checkCommands = (
  text: string,
  scriptsAt: (directory: string) => ReadonlySet<string> | undefined,
): string[] => {
  const problems: string[] = [];
  const command =
    /\bbun[\t ]+run[\t ]+(?:--cwd[\t ]+([\w./-]+)[\t ]+)?(\w[\w./:-]*)/g;
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(command)) {
      const directory = match[1] ?? '.';
      const script = match[2]!;
      if (script.includes('/') || /\.[cm]?[jt]sx?$/.test(script)) {
        continue;
      }
      const scripts = scriptsAt(directory);
      const where = `line ${index + 1}: ${match[0]}`;
      if (!scripts) {
        problems.push(`${where}: no package.json in ${directory}`);
      } else if (!scripts.has(script)) {
        problems.push(
          `${where}: no script "${script}" in ${directory}/package.json`,
        );
      }
    }
  }
  return problems;
};
