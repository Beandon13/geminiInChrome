import { ChromeClient } from "./chromeClient.js";
import { resolve, join } from "path";
import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
} from "fs";
import { execSync } from "child_process";

// ─── Chrome Tool Declarations ────────────────────────────────────────────────

export const chromeToolDeclarations: FunctionDeclaration[] = [
  {
    name: "chrome_list_tabs",
    description:
      "List all open tabs in the Chrome browser. Returns tab index, title, and URL for each.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: "chrome_attach",
    description:
      "Attach to a specific Chrome tab by its index number (from chrome_list_tabs). You must attach before using other chrome_ tools.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        tabIndex: {
          type: SchemaType.NUMBER,
          description: "The tab index from chrome_list_tabs",
        },
      },
      required: ["tabIndex"],
    },
  },
  {
    name: "chrome_navigate",
    description:
      "Navigate the current tab to a URL. Waits for the page to load.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: {
          type: SchemaType.STRING,
          description:
            "The URL to navigate to (e.g. 'https://google.com' or 'google.com')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_get_page_text",
    description:
      "Get the visible text content and interactive elements of the current page. Use this to understand what's on a page.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: "chrome_screenshot",
    description:
      "Take a screenshot of the current page and save to disk.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        filename: {
          type: SchemaType.STRING,
          description:
            "Optional filename (e.g. 'inbox.png'). Saved to ./screenshots/.",
        },
      },
    },
  },
  {
    name: "chrome_click",
    description:
      "Click an element by CSS selector or by its visible text.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        target: {
          type: SchemaType.STRING,
          description: "CSS selector or visible text of the element to click",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "chrome_type",
    description:
      "Type text into an input field. Find input by CSS selector, placeholder, name, or aria-label.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        target: {
          type: SchemaType.STRING,
          description: "CSS selector, placeholder, name, or aria-label of the input",
        },
        text: {
          type: SchemaType.STRING,
          description: "The text to type",
        },
      },
      required: ["target", "text"],
    },
  },
  {
    name: "chrome_scroll",
    description: "Scroll the page up or down.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        direction: {
          type: SchemaType.STRING,
          description: "'up' or 'down'",
        },
        amount: {
          type: SchemaType.NUMBER,
          description: "Pixels to scroll (default: 500)",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "chrome_press_key",
    description: "Press a keyboard key (Enter, Tab, Escape, arrow keys, etc).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        key: {
          type: SchemaType.STRING,
          description: "Key name: 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', etc.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "chrome_wait",
    description: "Wait for a specified duration (ms). Max 30000.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        ms: {
          type: SchemaType.NUMBER,
          description: "Milliseconds to wait",
        },
      },
      required: ["ms"],
    },
  },
];

// ─── Coding Tool Declarations ────────────────────────────────────────────────

export const codingToolDeclarations: FunctionDeclaration[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the file text with line numbers. For large files, use offset and limit to read portions.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: {
          type: SchemaType.STRING,
          description: "File path (relative to working directory or absolute)",
        },
        offset: {
          type: SchemaType.NUMBER,
          description: "Line number to start from (1-based). Optional.",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: "Max number of lines to read. Optional, default reads all.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Creates parent directories if needed.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: {
          type: SchemaType.STRING,
          description: "File path (relative to working directory or absolute)",
        },
        content: {
          type: SchemaType.STRING,
          description: "The full content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace a specific string in a file with new content. The old_string must appear exactly once in the file (be specific enough to match uniquely). Use this for surgical edits.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: {
          type: SchemaType.STRING,
          description: "File path",
        },
        old_string: {
          type: SchemaType.STRING,
          description: "The exact string to find and replace (must be unique in the file)",
        },
        new_string: {
          type: SchemaType.STRING,
          description: "The replacement string",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories at a path. Returns names with [dir] or [file] markers. Optionally recursive.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: {
          type: SchemaType.STRING,
          description: "Directory path (default: working directory)",
        },
        recursive: {
          type: SchemaType.BOOLEAN,
          description: "If true, list recursively (max 3 levels deep). Default: false.",
        },
      },
    },
  },
  {
    name: "search_files",
    description:
      "Search for a text pattern (regex supported) across files in a directory. Returns matching file paths and line contents. Like grep -rn.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        pattern: {
          type: SchemaType.STRING,
          description: "Text or regex pattern to search for",
        },
        path: {
          type: SchemaType.STRING,
          description: "Directory to search in (default: working directory)",
        },
        file_pattern: {
          type: SchemaType.STRING,
          description:
            "Glob to filter files, e.g. '*.ts' or '*.py'. Default: all files.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Execute a shell command and return its stdout and stderr. Runs in the working directory. Timeout: 60s. Use for git, npm, python, make, tests, etc.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        command: {
          type: SchemaType.STRING,
          description: "The shell command to execute",
        },
        cwd: {
          type: SchemaType.STRING,
          description:
            "Working directory for the command. Default: current project directory.",
        },
      },
      required: ["command"],
    },
  },
];

// ─── All tool declarations combined ──────────────────────────────────────────

export const allToolDeclarations: FunctionDeclaration[] = [
  ...chromeToolDeclarations,
  ...codingToolDeclarations,
];

// ─── Working directory state ─────────────────────────────────────────────────

let _workingDir = process.cwd();

export function setWorkingDir(dir: string): void {
  _workingDir = resolve(dir);
}

export function getWorkingDir(): string {
  return _workingDir;
}

function resolvePath(p: string): string {
  if (!p) return _workingDir;
  return resolve(_workingDir, p);
}

// ─── Coding tool implementations ─────────────────────────────────────────────

function readFileTool(
  filePath: string,
  offset?: number,
  limit?: number
): string {
  const resolved = resolvePath(filePath);
  if (!existsSync(resolved)) {
    return `ERROR: File not found: ${resolved}`;
  }
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return `ERROR: ${resolved} is a directory, not a file. Use list_files instead.`;
  }
  if (stat.size > 2 * 1024 * 1024) {
    return `ERROR: File is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use offset/limit to read portions.`;
  }

  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const start = Math.max(0, (offset || 1) - 1);
  const end = limit ? start + limit : lines.length;
  const slice = lines.slice(start, end);

  const numbered = slice
    .map((line, i) => `${String(start + i + 1).padStart(5)} │ ${line}`)
    .join("\n");

  const header = `File: ${resolved} (${lines.length} lines total)`;
  if (start > 0 || end < lines.length) {
    return `${header}\nShowing lines ${start + 1}-${Math.min(end, lines.length)}:\n\n${numbered}`;
  }
  return `${header}\n\n${numbered}`;
}

function writeFileTool(filePath: string, content: string): string {
  const resolved = resolvePath(filePath);
  mkdirSync(resolve(resolved, ".."), { recursive: true });
  writeFileSync(resolved, content, "utf-8");
  const lines = content.split("\n").length;
  return `Written ${lines} lines to ${resolved}`;
}

function editFileTool(
  filePath: string,
  oldString: string,
  newString: string
): string {
  const resolved = resolvePath(filePath);
  if (!existsSync(resolved)) {
    return `ERROR: File not found: ${resolved}`;
  }

  const content = readFileSync(resolved, "utf-8");
  const count = content.split(oldString).length - 1;

  if (count === 0) {
    return `ERROR: old_string not found in ${resolved}. Make sure it matches exactly (including whitespace/indentation).`;
  }
  if (count > 1) {
    return `ERROR: old_string found ${count} times in ${resolved}. It must be unique. Include more surrounding context to narrow it down.`;
  }

  const newContent = content.replace(oldString, newString);
  writeFileSync(resolved, newContent, "utf-8");

  const oldLines = oldString.split("\n").length;
  const newLines = newString.split("\n").length;
  return `Edited ${resolved}: replaced ${oldLines} line(s) with ${newLines} line(s).`;
}

function listFilesTool(dirPath?: string, recursive?: boolean): string {
  const resolved = resolvePath(dirPath || ".");
  if (!existsSync(resolved)) {
    return `ERROR: Directory not found: ${resolved}`;
  }

  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip common noise
      if (
        entry === "node_modules" ||
        entry === ".git" ||
        entry === "dist" ||
        entry === ".DS_Store"
      ) {
        if (depth === 0) results.push(`  [dir]  ${entry}/ (skipped)`);
        continue;
      }
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        const rel = full.slice(resolved.length + 1) || entry;
        if (st.isDirectory()) {
          results.push(`  [dir]  ${rel}/`);
          if (recursive) walk(full, depth + 1);
        } else {
          const size = st.size < 1024 ? `${st.size}B` : `${(st.size / 1024).toFixed(1)}KB`;
          results.push(`  [file] ${rel} (${size})`);
        }
      } catch {
        // Skip inaccessible
      }
    }
  }

  walk(resolved, 0);

  if (results.length === 0) {
    return `Directory is empty: ${resolved}`;
  }
  return `Contents of ${resolved}:\n\n${results.join("\n")}`;
}

function searchFilesTool(
  pattern: string,
  dirPath?: string,
  filePattern?: string
): string {
  const resolved = resolvePath(dirPath || ".");

  // Sanitize filePattern to prevent shell injection
  const safeFilePattern = (filePattern || "*").replace(/[^a-zA-Z0-9.*?_\-\/]/g, "");
  // Use grep -rn for search, it's universal on macOS
  // Exclude common heavy directories
  const excludeDirs = "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next --exclude-dir=__pycache__";
  const cmd = `grep -rn ${excludeDirs} --include='${safeFilePattern}' -E ${JSON.stringify(pattern)} ${JSON.stringify(resolved)} 2>/dev/null | head -100`;

  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 15000,
      maxBuffer: 512 * 1024,
    });
    if (!output.trim()) {
      return `No matches found for "${pattern}" in ${resolved}`;
    }
    const lines = output.trim().split("\n");
    const header = `Found ${lines.length}${lines.length >= 100 ? "+" : ""} matches for "${pattern}":`;
    // Make paths relative to working dir for readability
    const relative = lines.map((l) =>
      l.startsWith(resolved) ? l.slice(resolved.length + 1) : l
    );
    return `${header}\n\n${relative.join("\n")}`;
  } catch (err: any) {
    if (err.status === 1) {
      return `No matches found for "${pattern}" in ${resolved}`;
    }
    return `Search error: ${err.message}`;
  }
}

function runCommandTool(command: string, cwd?: string): string {
  const resolved = cwd ? resolvePath(cwd) : _workingDir;
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      cwd: resolved,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const trimmed = output.trim();
    if (!trimmed) return "(command completed with no output)";
    // Truncate very long output
    if (trimmed.length > 10000) {
      return trimmed.slice(0, 10000) + "\n\n... (output truncated at 10000 chars)";
    }
    return trimmed;
  } catch (err: any) {
    const stderr = err.stderr?.trim() || "";
    const stdout = err.stdout?.trim() || "";
    let result = `Command failed (exit code ${err.status || "unknown"})`;
    if (stdout) result += `\n\nstdout:\n${stdout.slice(0, 5000)}`;
    if (stderr) result += `\n\nstderr:\n${stderr.slice(0, 5000)}`;
    return result;
  }
}

// ─── Unified tool executor ───────────────────────────────────────────────────

export async function executeTool(
  chrome: ChromeClient,
  functionName: string,
  args: Record<string, any>
): Promise<string> {
  try {
    // Chrome tools
    switch (functionName) {
      case "chrome_list_tabs": {
        const tabs = await chrome.listTabs();
        if (tabs.length === 0) return "No tabs found.";
        return tabs
          .map((t, i) => `[${i}] ${t.title}\n    ${t.url}`)
          .join("\n\n");
      }
      case "chrome_attach":
        return await chrome.attach(args.tabIndex as number);
      case "chrome_navigate":
        return await chrome.navigate(args.url as string);
      case "chrome_get_page_text":
        return await chrome.getPageText();
      case "chrome_screenshot": {
        const filename =
          args.filename ||
          `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        const filePath = resolve("./screenshots", filename);
        return await chrome.screenshot(filePath);
      }
      case "chrome_click":
        return await chrome.click(args.target as string);
      case "chrome_type":
        return await chrome.type(args.target as string, args.text as string);
      case "chrome_scroll":
        return await chrome.scroll(
          args.direction as "up" | "down",
          args.amount as number | undefined
        );
      case "chrome_press_key":
        return await chrome.pressKey(args.key as string);
      case "chrome_wait": {
        const ms = Math.min(args.ms as number, 30000);
        return await chrome.wait(ms);
      }

      // Coding tools
      case "read_file":
        return readFileTool(
          args.path as string,
          args.offset as number | undefined,
          args.limit as number | undefined
        );
      case "write_file":
        return writeFileTool(args.path as string, args.content as string);
      case "edit_file":
        return editFileTool(
          args.path as string,
          args.old_string as string,
          args.new_string as string
        );
      case "list_files":
        return listFilesTool(
          args.path as string | undefined,
          args.recursive as boolean | undefined
        );
      case "search_files":
        return searchFilesTool(
          args.pattern as string,
          args.path as string | undefined,
          args.file_pattern as string | undefined
        );
      case "run_command":
        return runCommandTool(
          args.command as string,
          args.cwd as string | undefined
        );

      default:
        return `Unknown tool: ${functionName}`;
    }
  } catch (err: any) {
    return `Tool error (${functionName}): ${err.message}`;
  }
}
