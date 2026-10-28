// Turns a listed repo Markdown file into a Starlight page: the first heading
// becomes the title, and relative links point at site pages or GitHub.

import { dirname, posix } from 'node:path';

export const githubBlob = 'https://github.com/odogono/odgn-talk/blob/main/';

export type Page = { body: string; title: string };

const external = /^(?:[a-z][\d+.a-z-]*:|#|\/\/)/i;

export const rewriteTarget = (
  target: string,
  from: string,
  slugs: ReadonlyMap<string, string>,
): string => {
  if (external.test(target)) {
    return target;
  }
  const hash = target.indexOf('#');
  const path = hash === -1 ? target : target.slice(0, hash);
  const fragment = hash === -1 ? '' : target.slice(hash);
  const resolved = posix
    .normalize(posix.join(dirname(from), decodeURI(path)))
    .replace(/\/$/, '');
  const slug = slugs.get(resolved);
  if (slug !== undefined) {
    return `/${slug}/${fragment}`;
  }
  return `${githubBlob}${resolved === '.' ? '' : encodeURI(resolved)}${fragment}`;
};

const inlineLink = /(]\()(<[^>]*>|[^\s)]+)/g;
const definition = /^(\s{0,3}\[[^\]]+]:\s*)(\S+)/;

// CommonMark allows a link target in angle brackets, e.g. `<a b.md>`.
const rewriteBracketed = (
  target: string,
  from: string,
  slugs: ReadonlyMap<string, string>,
) =>
  target.startsWith('<')
    ? `<${rewriteTarget(target.slice(1, -1), from, slugs)}>`
    : rewriteTarget(target, from, slugs);

export const rewritePage = (
  source: string,
  from: string,
  slugs: ReadonlyMap<string, string>,
  title?: string,
): Page => {
  let heading: string | undefined;
  let fence: string | undefined;
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length
      ) {
        fence = undefined;
      }
      out.push(line);
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      out.push(line);
      continue;
    }
    if (heading === undefined && /^# /.test(line)) {
      heading = line.slice(2).trim();
      continue;
    }
    out.push(
      line
        .replaceAll(
          inlineLink,
          (_, open: string, target: string) =>
            open + rewriteBracketed(target, from, slugs),
        )
        .replace(
          definition,
          (_, open: string, target: string) =>
            open + rewriteBracketed(target, from, slugs),
        ),
    );
  }
  return {
    body: out.join('\n').replace(/^\n+/, ''),
    title: title ?? heading ?? from,
  };
};
