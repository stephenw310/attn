#!/usr/bin/env node
// Runner for scripts/triageEval.ts, the smart-splits dogfood eval. The eval is
// TypeScript because it imports the shipped state and question builders, so
// this file bundles it with esbuild (vite's bundler, already installed) into
// the ignored e2e/.generated/ directory and runs the result. See the header
// of triageEval.ts for usage.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, 'e2e', '.generated', 'triageEval.bundle.mjs')
mkdirSync(dirname(outfile), { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'triageEval.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3'],
  outfile,
  logLevel: 'warning'
})
const { main } = await import(pathToFileURL(outfile).href)
process.exitCode = await main(process.argv.slice(2))
