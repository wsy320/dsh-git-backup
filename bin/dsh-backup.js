#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((err) => {
  const message = err?.message ?? String(err);
  console.error(`错误: ${message}`);
  process.exitCode = 1;
});
