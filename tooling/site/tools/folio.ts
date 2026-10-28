// Builds Folio and copies it into the site's dist/ at /folio/ (#1662).
// Every URL Folio uses is relative, so its service worker's scope and
// precache list follow it to the sub-path.

import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build, dist as folioDist } from '../../creative/tools/build.ts';

const target = join(import.meta.dirname, '../dist/folio');

await build();
rmSync(target, { force: true, recursive: true });
cpSync(folioDist, target, { recursive: true });
console.log(`site: copied Folio to ${target}`);
