// The northtalk.org Worker (ADR 0140). Static assets answer every path for
// now. #1513 adds the `/go*` import handler here and lists `/go*` under
// `assets.run_worker_first` in wrangler.jsonc, since assets otherwise answer first.

type Env = { ASSETS: Fetcher };

export default {
  fetch: (request, env) => env.ASSETS.fetch(request),
} satisfies ExportedHandler<Env>;
