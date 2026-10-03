import { verifyLintFixtures } from './verify';
process.stdout.write(
  `Lint fixtures: ${verifyLintFixtures()} passed under Node\n`,
);

import { verifyLspFeatures } from './verify-lsp';
process.stdout.write(
  `LSP features: ${verifyLspFeatures()} passed under Node\n`,
);
