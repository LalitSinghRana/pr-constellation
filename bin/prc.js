#!/usr/bin/env node

import { runCli } from "../cli/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
