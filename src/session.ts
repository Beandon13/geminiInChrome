import { mkdirSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

export interface LogEntry {
  timestamp: string;
  role: "user" | "model" | "tool_call" | "tool_result" | "system";
  content: string;
  metadata?: Record<string, unknown>;
}

export class Session {
  public readonly id: string;
  public readonly logPath: string;
  private entries: LogEntry[] = [];

  constructor(sessionId?: string) {
    this.id = sessionId || this.generateId();
    mkdirSync(config.sessionsDir, { recursive: true });
    this.logPath = join(config.sessionsDir, `${this.id}.jsonl`);
  }

  private generateId(): string {
    const now = new Date();
    return (
      now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)
    );
  }

  /** Load an existing session from disk */
  load(): boolean {
    if (!existsSync(this.logPath)) {
      return false;
    }
    const raw = readFileSync(this.logPath, "utf-8").trim();
    if (!raw) return true;

    this.entries = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    return true;
  }

  /** Append a log entry to memory and disk */
  append(entry: Omit<LogEntry, "timestamp">): void {
    const full: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    appendFileSync(this.logPath, JSON.stringify(full) + "\n", "utf-8");
  }

  /** Get all entries */
  allEntries(): LogEntry[] {
    return this.entries;
  }

  /**
   * Get the most recent entries for sending to the model.
   * Returns at most `config.contextTurns * 2` entries (user + model pairs)
   * plus any system entries.
   */
  recentEntries(): LogEntry[] {
    const maxEntries = config.contextTurns * 2;
    if (this.entries.length <= maxEntries) {
      return [...this.entries];
    }
    // Always include the very first system entry if present
    const first =
      this.entries[0]?.role === "system" ? [this.entries[0]] : [];
    const recent = this.entries.slice(-maxEntries);
    return [...first, ...recent];
  }

  /**
   * Build a Gemini-compatible conversation history from recent entries.
   * Returns array of {role, parts} objects.
   */
  toGeminiHistory(): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
    const recent = this.recentEntries();
    const history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

    for (const entry of recent) {
      if (entry.role === "user") {
        history.push({ role: "user", parts: [{ text: entry.content }] });
      } else if (entry.role === "model") {
        history.push({ role: "model", parts: [{ text: entry.content }] });
      } else if (entry.role === "tool_call") {
        // Tool calls are part of model output
        history.push({
          role: "model",
          parts: [{ text: `[Tool Call] ${entry.content}` }],
        });
      } else if (entry.role === "tool_result") {
        // Tool results fed back as user context
        history.push({
          role: "user",
          parts: [{ text: `[Tool Result] ${entry.content}` }],
        });
      }
      // system entries are handled via system instruction, not history
    }

    // Gemini requires history to start with 'user' and alternate roles
    // Clean up any leading model messages
    while (history.length > 0 && history[0].role === "model") {
      history.shift();
    }

    // Merge consecutive same-role entries
    const merged: typeof history = [];
    for (const entry of history) {
      if (merged.length > 0 && merged[merged.length - 1].role === entry.role) {
        merged[merged.length - 1].parts.push(...entry.parts);
      } else {
        merged.push(entry);
      }
    }

    // Gemini's startChat expects history to end with a 'model' message.
    // If history ends with 'user', trim it — the CLI will re-send it as a new message.
    while (merged.length > 0 && merged[merged.length - 1].role === "user") {
      merged.pop();
    }

    return merged;
  }
}
