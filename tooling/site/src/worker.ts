// The northtalk.org Worker (ADR 0140). Static assets answer every path
// except the Go module paths, which wrangler.jsonc lists under
// `assets.run_worker_first` so they reach this code.

import { goImport } from './go-import.ts';

type Env = { ASSETS: Fetcher };

export default {
  fetch: (request, env) => goImport(request) ?? env.ASSETS.fetch(request),
} satisfies ExportedHandler<Env>;
