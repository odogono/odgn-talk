// Serves the Go module paths under northtalk.org (#1512). `go get` asks
// `<path>?go-get=1` and reads a `go-import` meta tag naming the repo and,
// since Go 1.25, the module's subdirectory. `go-source` lets pkg.go.dev
// link to the source on GitHub. Browsers go to the docs on pkg.go.dev.

const repo = 'https://github.com/odogono/odgn-talk';

type Module = {
  // Directory of the module in the repo.
  directory: string;
  // Path below northtalk.org, without a leading slash.
  path: string;
};

// Longest prefix first, so `go/sqlite` wins over `go`.
export const modules: readonly Module[] = [
  { path: 'go/sqlite', directory: 'impl/go/sqlite' },
  { path: 'go', directory: 'impl/go' },
];

const moduleFor = (pathname: string): Module | undefined => {
  const path = pathname.replaceAll(/^\/+|\/+$/g, '');
  return modules.find(
    module => path === module.path || path.startsWith(`${module.path}/`),
  );
};

const importPage = (module: Module): string => {
  const name = `northtalk.org/${module.path}`;
  const tree = `${repo}/tree/main/${module.directory}`;
  const blob = `${repo}/blob/main/${module.directory}`;
  return `<!doctype html>
<html>
<head>
<meta name="go-import" content="${name} git ${repo} ${module.directory}">
<meta name="go-source" content="${name} ${repo} ${tree}{/dir} ${blob}{/dir}/{file}#L{line}">
<meta http-equiv="refresh" content="0; url=https://pkg.go.dev/${name}">
</head>
<body><a href="https://pkg.go.dev/${name}">${name}</a></body>
</html>
`;
};

// Answers a request for a Go module path, or returns undefined when the
// path is not one, so the caller can serve it some other way.
export const goImport = (request: Request): Response | undefined => {
  const url = new URL(request.url);
  const module = moduleFor(url.pathname);
  if (module === undefined) {
    return undefined;
  }
  if (url.searchParams.get('go-get') === '1') {
    return new Response(importPage(module), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  const path = url.pathname.replaceAll(/^\/+|\/+$/g, '');
  return Response.redirect(`https://pkg.go.dev/northtalk.org/${path}`, 302);
};
