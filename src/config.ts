import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const GLOBAL_CONFIG = resolve(homedir(), ".gemini-chrome", "config.env");
const LOCAL_ENV = resolve(process.cwd(), ".env");

// Load an env file: set process.env for any key not already set
function loadEnvFrom(path: string): void {
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// Priority: env vars (already set) > global config > local .env > defaults
loadEnvFrom(GLOBAL_CONFIG);
loadEnvFrom(LOCAL_ENV);

export function buildConfig() {
  return {
    /** Gemini API key — required */
    geminiApiKey: process.env.GEMINI_API_KEY || "",

    /** Gemini model name */
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",

    /** Chrome DevTools Protocol host */
    cdpHost: process.env.CDP_HOST || "localhost",

    /** Chrome DevTools Protocol port */
    cdpPort: parseInt(process.env.CDP_PORT || "9222", 10),

    /**
     * Number of recent conversation turns to include in context.
     * Each "turn" is one user message + one assistant response.
     */
    contextTurns: parseInt(process.env.CONTEXT_TURNS || "50", 10),

    /** Directory for session logs */
    sessionsDir: resolve(process.env.SESSIONS_DIR || "./sessions"),
  } as const;
}

export let config = buildConfig();

/** Reload config after setup writes a new config file */
export function reloadConfig(): void {
  loadEnvFrom(GLOBAL_CONFIG);
  loadEnvFrom(LOCAL_ENV);
  config = buildConfig();
}

export function validateConfig(): void {
  if (!config.geminiApiKey || config.geminiApiKey === "your_api_key_here") {
    console.error(
      "ERROR: GEMINI_API_KEY is not set.\n" +
        "  1. Get a key at https://aistudio.google.com/apikey\n" +
        "  2. Run `gemini` again to go through setup\n"
    );
    process.exit(1);
  }
}
