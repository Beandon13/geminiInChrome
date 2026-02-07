#!/usr/bin/env node

import { config, validateConfig, reloadConfig } from "./config.js";
import { isFirstRun, runSetup } from "./setup.js";
import { CLI } from "./cli.js";

// Parse CLI arguments
const args = process.argv.slice(2);
let sessionId: string | undefined;
let workingDir: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--resume" && args[i + 1]) {
    sessionId = args[i + 1];
    i++;
  } else if ((args[i] === "--dir" || args[i] === "-d") && args[i + 1]) {
    workingDir = args[i + 1];
    i++;
  } else if (args[i] === "--setup") {
    // Force re-run setup
    await runSetup();
    reloadConfig();
  } else if (args[i] === "--help" || args[i] === "-h") {
    printUsage();
    process.exit(0);
  }
}

function printUsage(): void {
  console.log(`
Gemini in Chrome — AI coding agent + browser automation

Usage:
  gemini                              Start a new session
  gemini --dir /path/to/project       Work on a specific project
  gemini --resume <session-id>        Resume a previous session
  gemini --setup                      Re-run setup wizard

Options:
  --dir, -d <path>        Set working directory for coding tools
                          (default: current directory)
  --resume <session-id>   Resume a previous session by ID
                          (e.g., --resume 2025-01-15_14-30-00)
  --setup                 Re-run the setup wizard (change API key, model, etc.)
  --help, -h              Show this help

Chrome (for browser features):
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222

Examples:
  gemini --dir ~/projects/my-app
  gemini --resume 2025-01-15_14-30-00
`);
}

// First-run setup
if (isFirstRun()) {
  await runSetup();
  reloadConfig();
}

// Validate config
validateConfig();

console.log(
  `\x1b[90mModel: ${config.geminiModel} | Chrome: ${config.cdpHost}:${config.cdpPort}\x1b[0m`
);

// Start CLI
const cli = new CLI(sessionId, workingDir);
cli.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
