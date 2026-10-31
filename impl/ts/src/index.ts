// The `@northtalk/ts` entry: everything in the lean entry, with all seven stdlib
// Libraries registered. Importing it registers them, so it has side effects.
import { allStdlib } from './generated/stdlib';
import { registerStdlib } from './stdlib-registry';

registerStdlib(...allStdlib);

export * from './lean';
export { allStdlib, stdlibSources } from './generated/stdlib';
