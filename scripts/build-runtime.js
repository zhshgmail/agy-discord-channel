'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const moduleBuiltin = require('node:module');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repoRoot, 'plugins', 'agy-discord-channel');
const checkOnly = process.argv.includes('--check');
const builtins = new Set(moduleBuiltin.builtinModules.map((name) => name.replace(/^node:/, '')));

const bundles = [
  {
    entryPoint: path.join(pluginRoot, 'src', 'mcp-server.js'),
    label: 'MCP server',
    outputPath: path.join(pluginRoot, 'runtime', 'mcp-server.cjs'),
  },
  {
    entryPoint: path.join(pluginRoot, 'src', 'cli.js'),
    label: 'CLI & hook',
    outputPath: path.join(pluginRoot, 'runtime', 'cli.cjs'),
  },
];

const nodeExternals = {
  name: 'node-externals',
  setup(build) {
    build.onResolve({ filter: /^(?:node:)?[A-Za-z0-9_][A-Za-z0-9_./-]*$/ }, (args) => {
      const bare = args.path.replace(/^node:/, '');
      if (builtins.has(bare)) return { external: true, path: `node:${bare}` };
      return null;
    });
  },
};

const optionalNativeFallbacks = {
  name: 'optional-native-fallbacks',
  setup(build) {
    build.onResolve({ filter: /^zlib-sync$/ }, () => ({
      namespace: 'optional-native-fallback',
      path: 'zlib-sync',
    }));
    build.onLoad({ filter: /.*/, namespace: 'optional-native-fallback' }, () => ({
      contents: 'throw new Error("Optional native compression is not bundled.");',
      loader: 'js',
    }));
  },
};

async function buildBundle({ entryPoint, label, outputPath }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-discord-build-'));
  const tempOut = path.join(tempDir, path.basename(outputPath));
  try {
    const result = await esbuild.build({
      absWorkingDir: repoRoot,
      bundle: true,
      define: {
        'process.env.WS_NO_BUFFER_UTIL': '"1"',
        'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
      },
      entryPoints: [entryPoint],
      format: 'cjs',
      legalComments: 'none',
      metafile: true,
      minifySyntax: true,
      outfile: tempOut,
      packages: 'bundle',
      platform: 'node',
      plugins: [optionalNativeFallbacks, nodeExternals],
      sourcemap: false,
      target: ['node22'],
      write: true,
    });

    const externals = Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports || [])
      .filter((imp) => imp.external)
      .map((imp) => imp.path)
      .filter((spec) => !spec.startsWith('node:'));

    assert.deepEqual(externals, [], `${label} bundle has unexpected external deps: ${externals.join(', ')}`);
    return fs.readFileSync(tempOut);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  for (const def of bundles) {
    const bytes = await buildBundle(def);
    const rel = path.relative(repoRoot, def.outputPath);
    if (checkOnly) {
      assert(fs.existsSync(def.outputPath), `${rel} is missing`);
      assert(fs.readFileSync(def.outputPath).equals(bytes), `${rel} is out of date`);
      continue;
    }
    fs.mkdirSync(path.dirname(def.outputPath), { recursive: true });
    fs.writeFileSync(def.outputPath, bytes);
    process.stdout.write(`Built ${rel} (${(bytes.length / 1024).toFixed(1)} KiB)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
