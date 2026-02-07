import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { config } from "./config.js";

export interface MemoryEntry {
  timestamp: string;
  type: "compaction" | "session_end" | "task_complete";
  task: string;
  summary: string;
}

const MEMORY_FILE = resolve(config.sessionsDir, "memory.jsonl");
const MAX_RECENT = 10; // Load last 10 memories into context

export class Memory {
  /** Save a memory entry */
  static save(entry: Omit<MemoryEntry, "timestamp">): void {
    mkdirSync(dirname(MEMORY_FILE), { recursive: true });
    const full: MemoryEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(MEMORY_FILE, JSON.stringify(full) + "\n");
  }

  /** Load recent memories */
  static loadRecent(count: number = MAX_RECENT): MemoryEntry[] {
    if (!existsSync(MEMORY_FILE)) return [];

    const lines = readFileSync(MEMORY_FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim());

    const entries: MemoryEntry[] = [];
    // Take last N lines
    const start = Math.max(0, lines.length - count);
    for (let i = start; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  }

  /** Format memories into a context string for the model */
  static formatForContext(): string {
    const memories = Memory.loadRecent();
    if (memories.length === 0) return "";

    const lines = memories.map((m) => {
      const date = new Date(m.timestamp);
      const ago = Memory.timeAgo(date);
      return `- [${ago}] ${m.task}: ${m.summary}`;
    });

    return (
      `\n\n## Recent Memory (${memories.length} entries)\n` +
      `These are summaries of your previous sessions and tasks:\n` +
      lines.join("\n") +
      `\n\nUse this context to avoid repeating work and to understand what has been done before.`
    );
  }

  private static timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
