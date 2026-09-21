#!/usr/bin/env node
// Entry point: env parsing and stage orchestration. Everything pure lives in lib.mjs.

import { VERSION } from './lib.mjs';

async function main() {
  console.log(`ai-docs-sync ${VERSION}: not implemented yet.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
