import path from 'node:path';
import { pathToFileURL } from 'node:url';

function resolveAliasTarget(specifier) {
  if (!specifier.startsWith('@/')) {
    return null;
  }

  const relativePath = specifier.slice(2);
  const absolutePath = path.resolve(process.cwd(), relativePath);

  if (path.extname(absolutePath)) {
    return pathToFileURL(absolutePath).href;
  }

  return pathToFileURL(`${absolutePath}.ts`).href;
}

export async function resolve(specifier, context, defaultResolve) {
  const resolved = resolveAliasTarget(specifier);
  if (resolved) {
    return {
      url: resolved,
      shortCircuit: true
    };
  }

  return defaultResolve(specifier, context, defaultResolve);
}