import path from 'node:path';
import fs from 'node:fs';
import { build } from 'esbuild';

const rootDir = process.cwd();
const entryFile = path.join(rootDir, 'mcp-stdio.ts');
const outputFile = path.join(rootDir, 'dist', 'mcp-stdio.mjs');

function resolveSourceFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.mjs`,
    `${basePath}.js`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.mts'),
    path.join(basePath, 'index.mjs'),
    path.join(basePath, 'index.js')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return basePath;
}

const aliasPlugin = {
  name: 'alias-at-root',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveSourceFile(path.join(rootDir, args.path.slice(2)))
    }));

    buildContext.onResolve({ filter: /^[^./]/ }, (args) => ({
      path: args.path,
      external: !path.isAbsolute(args.path) && !/^[A-Za-z]:[\\/]/.test(args.path)
    }));
  }
};

await build({
  entryPoints: [entryFile],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
  plugins: [aliasPlugin]
});
