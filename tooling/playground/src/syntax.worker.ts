import { inspectSyntax } from './syntax';
import type { SyntaxRequest, SyntaxResponse } from './protocol';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SyntaxRequest>) => void) | null;
  postMessage(message: SyntaxResponse): void;
};
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({
      revision: data.revision,
      tree: inspectSyntax(data.source),
    });
  } catch (error) {
    scope.postMessage({ revision: data.revision, error: String(error) });
  }
};
