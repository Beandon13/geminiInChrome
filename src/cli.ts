import * as readline from "readline";
import { resolve } from "path";
import { existsSync } from "fs";
import { ChromeClient } from "./chromeClient.js";
import { GeminiClient, type GeminiResponse } from "./geminiClient.js";
import { Session } from "./session.js";
import {
  allToolDeclarations,
  executeTool,
  setWorkingDir,
  getWorkingDir,
  onScreenshot,
} from "./tools.js";
import { Memory } from "./memory.js";
import type { ChatSession, Content } from "@google/generative-ai";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const GRAY = "\x1b[90m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\x1b[2K\r";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const BG_CYAN = "\x1b[46m";
const BG_DARK = "\x1b[48;5;236m";

// ─── Spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];

class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private message = "";

  start(msg: string): void {
    this.message = msg;
    this.frame = 0;
    process.stdout.write(HIDE_CURSOR);
    this.interval = setInterval(() => {
      const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
      process.stdout.write(
        `${CLEAR_LINE}${CYAN}│${RESET} ${spinner} ${DIM}${this.message}${RESET}`
      );
      this.frame++;
    }, 80);
  }

  update(msg: string): void {
    this.message = msg;
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  _label: string,
  maxRetries = 5
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err.message || "";
      const isRateLimit =
        msg.includes("429") ||
        msg.includes("quota") ||
        msg.includes("Resource exhausted");
      if (isRateLimit && attempt < maxRetries) {
        // Parse retry delay from error if available, otherwise use exponential backoff
        const retryMatch = msg.match(/retry.*?(\d+)\.?\d*s/i);
        const waitSec = retryMatch ? Math.ceil(Number(retryMatch[1])) + 2 : 10 * (attempt + 1);
        console.log(
          `\n${YELLOW}  ⏳ Rate limited. Retrying in ${waitSec}s (${attempt + 1}/${maxRetries})...${RESET}`
        );
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export class CLI {
  private chrome: ChromeClient;
  private gemini: GeminiClient;
  private session: Session;
  private chat: ChatSession | null = null;
  private rl: readline.Interface;
  private spinner = new Spinner();
  private interrupted = false;
  private processing = false;
  private toolCallCount = 0;
  private lastUserMessage = "";
  private completedActions: string[] = [];
  private lastResponseHadText = false;
  private static readonly COMPACT_THRESHOLD = 12;

  constructor(sessionId?: string, workingDir?: string) {
    this.chrome = new ChromeClient();
    this.gemini = new GeminiClient(allToolDeclarations);
    this.session = new Session(sessionId);

    if (workingDir) {
      setWorkingDir(workingDir);
    }

    // Register inline screenshot display
    onScreenshot((base64) => this.displayInlineImage(base64));

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // ── Ctrl+C handling ──
    // Use rl.on("SIGINT") instead of process.on("SIGINT") to prevent
    // Node.js readline from auto-closing on SIGINT (which causes ERR_USE_AFTER_CLOSE).
    // Use timestamp instead of counter because process.stdin "data" fires for
    // raw Ctrl+C (\x03) BEFORE the SIGINT handler, which would reset a counter.
    let lastCtrlCTime = 0;
    this.rl.on("SIGINT", () => {
      const now = Date.now();
      const isDouble = now - lastCtrlCTime < 2000;
      lastCtrlCTime = now;

      if (isDouble) {
        // Double Ctrl+C within 2s: always exit
        console.log(`\n${GRAY}Goodbye.${RESET}`);
        process.exit(0);
      } else if (this.processing && !this.interrupted) {
        // First Ctrl+C during processing: interrupt the task
        this.interrupted = true;
        this.spinner.stop();
        console.log(`\n${YELLOW}⏹  Interrupted.${RESET}\n`);
        this.session.append({
          role: "system",
          content: "User interrupted the current task.",
        });
      } else {
        console.log(
          `\n${GRAY}Press Ctrl+C again to exit, or type a message.${RESET}`
        );
        this.prompt();
      }
    });
  }

  async start(): Promise<void> {
    // Try to load existing session
    const resumed = this.session.load();

    this.printBanner();

    if (resumed && this.session.allEntries().length > 0) {
      console.log(
        `  ${GREEN}↻${RESET} ${WHITE}Resumed session${RESET} ${DIM}${this.session.id}${RESET}`
      );
      console.log(
        `    ${DIM}${this.session.allEntries().length} entries loaded${RESET}`
      );
    } else {
      console.log(
        `  ${GREEN}✦${RESET} ${WHITE}New session${RESET} ${DIM}${this.session.id}${RESET}`
      );
      this.session.append({
        role: "system",
        content: `Session started. Working directory: ${getWorkingDir()}`,
      });
    }

    // Load persistent memories from previous sessions
    const memoryContext = Memory.formatForContext();
    if (memoryContext) {
      const memCount = Memory.loadRecent().length;
      console.log(`    ${DIM}${memCount} memories loaded${RESET}`);
      this.session.append({
        role: "system",
        content: memoryContext,
      });
    }

    const cwd = getWorkingDir().replace(process.env.HOME || "/Users", "~");
    console.log(`    ${DIM}cwd: ${cwd}${RESET}`);
    console.log(
      `\n  ${DIM}Ctrl+C to interrupt ${GRAY}•${DIM} /help for commands ${GRAY}•${DIM} /exit to quit${RESET}\n`
    );
    console.log(`${GRAY}${"─".repeat(60)}${RESET}\n`);

    this.initChat();
    this.prompt();
  }

  private initChat(): void {
    const history = this.session.toGeminiHistory();
    this.chat = this.gemini.startChat(history as Content[]);
  }

  private printBanner(): void {
    console.log(`
${BOLD}${CYAN}  ╭─────────────────────────────────────╮
  │   Gemini in Chrome                  │
  │   ${RESET}${DIM}AI Coding Agent + Browser Control${RESET}${BOLD}${CYAN}  │
  │   ${RESET}${DIM}${ITALIC}made by Beandon${RESET}${BOLD}${CYAN}                    │
  ╰─────────────────────────────────────╯${RESET}
`);
  }

  private prompt(): void {
    this.processing = false;
    this.interrupted = false;
    this.rl.question(
      `${BOLD}${BLUE}> ${RESET}`,
      (input) => {
        this.handleInput(input.trim());
      }
    );
  }

  private async handleInput(input: string): Promise<void> {
    if (!input) {
      this.prompt();
      return;
    }

    if (input.startsWith("/")) {
      await this.handleSlashCommand(input);
      this.prompt();
      return;
    }

    // Send to Gemini
    this.processing = true;
    await this.sendToGemini(input);
    this.prompt();
  }

  private async handleSlashCommand(input: string): Promise<void> {
    const spaceIdx = input.indexOf(" ");
    const cmd = (
      spaceIdx === -1 ? input : input.slice(0, spaceIdx)
    ).toLowerCase();
    const arg = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case "/exit":
      case "/quit":
      case "/q":
        // Save session end memory
        if (this.lastUserMessage) {
          const actions = this.completedActions.slice(-20).join("; ");
          Memory.save({
            type: "session_end",
            task: this.lastUserMessage.slice(0, 200),
            summary: actions || "Session ended (no tracked actions)",
          });
        }
        console.log(`${GRAY}  Session saved: ${this.session.logPath}${RESET}`);
        console.log(`${GRAY}  Goodbye.${RESET}`);
        await this.chrome.detach();
        this.rl.close();
        process.exit(0);
        break;

      case "/chrome":
        if (arg) {
          this.processing = true;
          await this.sendToGemini(`[Browser task] ${arg}`);
        } else {
          console.log(
            `\n${CYAN}  Browser tools are always available.${RESET}\n` +
              `  Just describe what you want in plain English.\n` +
              `  Use ${YELLOW}/tabs${RESET} + ${YELLOW}/attach N${RESET} to connect first.\n`
          );
        }
        break;

      case "/tabs": {
        try {
          const tabs = await this.chrome.listTabs();
          if (tabs.length === 0) {
            console.log(
              `\n${YELLOW}  No tabs found.${RESET} Is Chrome running with remote debugging?\n`
            );
          } else {
            console.log("");
            tabs.forEach((t, i) => {
              console.log(
                `  ${BOLD}[${i}]${RESET} ${t.title}`
              );
              console.log(`      ${GRAY}${t.url}${RESET}`);
            });
            console.log(
              `\n${GRAY}  Use /attach <index> to connect.${RESET}\n`
            );
          }
        } catch (err: any) {
          console.log(`\n${RED}  ${err.message}${RESET}\n`);
        }
        break;
      }

      case "/attach": {
        const idx = parseInt(arg, 10);
        if (isNaN(idx)) {
          console.log(
            `\n${YELLOW}  Usage: /attach <tab-index>${RESET}\n`
          );
          break;
        }
        try {
          const msg = await this.chrome.attach(idx);
          console.log(`\n${GREEN}  ✓ ${msg}${RESET}\n`);
        } catch (err: any) {
          console.log(`\n${RED}  ${err.message}${RESET}\n`);
        }
        break;
      }

      case "/cd": {
        if (!arg) {
          console.log(`\n${YELLOW}  Usage: /cd <path>${RESET}\n`);
          break;
        }
        const newDir = resolve(getWorkingDir(), arg);
        if (!existsSync(newDir)) {
          console.log(`\n${RED}  Not found: ${newDir}${RESET}\n`);
          break;
        }
        setWorkingDir(newDir);
        console.log(
          `\n${GREEN}  ✓ ${getWorkingDir()}${RESET}\n`
        );
        this.session.append({
          role: "system",
          content: `Working directory changed to: ${getWorkingDir()}`,
        });
        break;
      }

      case "/pwd":
        console.log(`\n  ${getWorkingDir()}\n`);
        break;

      case "/status": {
        console.log("");
        console.log(`  ${CYAN}Session${RESET}    ${this.session.id}`);
        console.log(
          `  ${CYAN}Entries${RESET}    ${this.session.allEntries().length}`
        );
        console.log(`  ${CYAN}Dir${RESET}        ${getWorkingDir()}`);
        const tab = this.chrome.getTabInfo();
        console.log(
          `  ${CYAN}Chrome${RESET}     ${tab ? `${tab.title}` : "Not connected"}`
        );
        console.log(
          `  ${CYAN}Log${RESET}        ${this.session.logPath}`
        );
        console.log("");
        break;
      }

      case "/clear":
        console.clear();
        this.printBanner();
        break;

      case "/help":
        console.log(`
${CYAN}  Commands:${RESET}
    /tabs          List Chrome tabs
    /attach N      Attach to tab N
    /chrome <msg>  Send a browser task
    /cd <path>     Change working directory
    /pwd           Print working directory
    /clear         Clear screen
    /status        Session info
    /help          This help
    /exit          Quit

${CYAN}  Shortcuts:${RESET}
    Ctrl+C         Interrupt current task
    Ctrl+C ×2      Exit CLI
`);
        break;

      default:
        console.log(
          `\n${YELLOW}  Unknown: ${cmd}${RESET} — type /help\n`
        );
    }
  }

  // ─── Gemini interaction ──────────────────────────────────────────────────

  private async sendToGemini(userMessage: string): Promise<void> {
    this.session.append({ role: "user", content: userMessage });
    this.interrupted = false;
    this.toolCallCount = 0;
    this.lastUserMessage = userMessage;
    this.completedActions = [];
    this.lastResponseHadText = false;

    const contextPrefix = `[Working directory: ${getWorkingDir()}]\n\n`;
    const messageToSend = contextPrefix + userMessage;

    this.spinner.start("Thinking...");

    try {
      if (!this.chat) {
        this.initChat();
      }

      let response: GeminiResponse;
      try {
        response = await withRetry(
          () => this.gemini.sendMessage(this.chat!, messageToSend),
          "sendMessage"
        );
      } catch (err: any) {
        if (
          err.message?.includes("INVALID_ARGUMENT") ||
          err.message?.includes("history")
        ) {
          this.spinner.update("Reinitializing session...");
          this.initChat();
          response = await withRetry(
            () => this.gemini.sendMessage(this.chat!, messageToSend),
            "sendMessage retry"
          );
        } else {
          throw err;
        }
      }

      this.spinner.stop();

      // Process response (handles tool call loops)
      await this.processResponse(response);

      // If the model finished without a text message, show a summary
      if (!this.lastResponseHadText && !this.interrupted && this.completedActions.length > 0) {
        const summary = this.completedActions.slice(-5).join("\n  - ");
        this.printModelMessage(`Done. Here's what I did:\n  - ${summary}`);
      }
    } catch (err: any) {
      this.spinner.stop();

      if (this.interrupted) return; // User interrupted, don't show error

      const errMsg = err.message || String(err);
      console.log(`\n${RED}  Error: ${errMsg}${RESET}`);

      if (errMsg.includes("429") || errMsg.includes("quota")) {
        console.log(
          `${YELLOW}  Rate limited — compacting and retrying in 30s...${RESET}`
        );
        // Auto-recover: compact context and retry after a cooldown
        this.chat = this.gemini.startChat([]);
        this.toolCallCount = 0;
        await sleep(30000);
        const retryMsg =
          `[Working directory: ${getWorkingDir()}]\n\n` +
          `[Rate limit recovery — context was reset.]\n\n` +
          `Your original task: ${this.lastUserMessage}\n\n` +
          `Continue working on the task. Read the current page state and keep going.`;
        this.spinner.start("Retrying...");
        try {
          const retryResponse = await withRetry(
            () => this.gemini.sendMessage(this.chat!, retryMsg),
            "rate limit recovery"
          );
          this.spinner.stop();
          await this.processResponse(retryResponse);
        } catch (retryErr: any) {
          this.spinner.stop();
          console.log(`\n${RED}  Recovery failed: ${retryErr.message}${RESET}\n`);
        }
        return; // Return here so we go back to the prompt
      } else if (errMsg.includes("API_KEY") || errMsg.includes("403")) {
        console.log(
          `${YELLOW}  Check GEMINI_API_KEY in .env${RESET}`
        );
      }
      console.log("");

      this.session.append({
        role: "system",
        content: `Error: ${errMsg}`,
      });
    }
  }

  private async processResponse(response: GeminiResponse): Promise<void> {
    // Check for interrupt
    if (this.interrupted) return;

    if (response.type === "text") {
      this.printModelMessage(response.text);
      this.lastResponseHadText = true;
      this.session.append({ role: "model", content: response.text });
      return;
    }

    // Handle function calls
    if (response.text) {
      this.printModelMessage(response.text);
    }

    const functionResults: Array<{
      name: string;
      response: Record<string, any>;
    }> = [];

    for (const call of response.calls) {
      // Check for interrupt before each tool call
      if (this.interrupted) {
        console.log(`${GRAY}  (skipped remaining tool calls)${RESET}`);
        return;
      }

      // Log raw tool call to session
      this.session.append({
        role: "tool_call",
        content: JSON.stringify({ name: call.name, args: call.args }),
      });

      // Show friendly tool description
      const friendlyDesc = this.formatToolCall(call.name, call.args);
      this.spinner.start(friendlyDesc);
      const result = await executeTool(this.chrome, call.name, call.args);
      this.spinner.stop();

      // Show friendly result
      const friendlyResult = this.formatToolResult(call.name, call.args, result);
      console.log(friendlyResult);

      this.session.append({
        role: "tool_result",
        content: result,
        metadata: { tool: call.name },
      });

      functionResults.push({
        name: call.name,
        response: { result },
      });

      // Track significant actions for compaction summaries
      if (call.name === "chrome_navigate" && call.args.url) {
        this.completedActions.push(`Navigated to: ${call.args.url}`);
      } else if (call.name === "chrome_type" && result.startsWith("Typed")) {
        const snippet = (call.args.text || "").slice(0, 60);
        this.completedActions.push(`Typed comment: "${snippet}..."`);
      } else if (call.name === "chrome_click" && result.startsWith("Clicked")) {
        this.completedActions.push(`Clicked: ${call.args.target}`);
      }
    }

    // Check for interrupt before sending results back
    if (this.interrupted) return;

    // Track tool calls for compaction
    this.toolCallCount += response.calls.length;

    // ── Auto-compact: reset chat to prevent rate limits ──
    if (this.toolCallCount >= CLI.COMPACT_THRESHOLD) {
      console.log(
        `\n${YELLOW}  ♻  Compacting context (${this.toolCallCount} tool calls)...${RESET}`
      );
      this.toolCallCount = 0;

      // Send function results to current chat first (required by API)
      try {
        this.spinner.start("Thinking...");
        await withRetry(
          () => this.gemini.sendFunctionResults(this.chat!, functionResults),
          "sendFunctionResults (pre-compact)"
        );
        this.spinner.stop();
      } catch {
        this.spinner.stop();
        // Ignore errors here — we're about to reset anyway
      }

      // Create a fresh chat session with no history
      this.chat = this.gemini.startChat([]);

      // Send a continuation message so the model knows what it was doing
      const lastToolResult = functionResults[functionResults.length - 1];
      const lastResultSnippet = JSON.stringify(lastToolResult.response.result || "").slice(0, 500);

      // Build action summary so model doesn't repeat itself
      const recentActions = this.completedActions.slice(-20).join("\n- ");
      const actionSummary = recentActions
        ? `\n\nActions completed so far:\n- ${recentActions}\n\nDO NOT repeat actions on pages/posts you already visited. Move on to NEW posts.`
        : "";

      const memoryCtx = Memory.formatForContext();
      const continuationMsg =
        `[Working directory: ${getWorkingDir()}]\n\n` +
        `[CONTEXT COMPACTED — Previous conversation was reset to save tokens.]\n\n` +
        `Your original task: ${this.lastUserMessage}\n\n` +
        `The last tool you used was "${lastToolResult.name}" which returned: ${lastResultSnippet}` +
        `${actionSummary}` +
        `${memoryCtx}\n\n` +
        `Continue working on the task. Read the current page state if needed and keep going.`;

      this.session.append({
        role: "system",
        content: `Context compacted after ${CLI.COMPACT_THRESHOLD} tool calls.`,
      });

      // Save memory on compaction
      const actionList = this.completedActions.slice(-20).join("; ");
      Memory.save({
        type: "compaction",
        task: this.lastUserMessage.slice(0, 200),
        summary: actionList || "Context compacted (no tracked actions)",
      });

      try {
        this.spinner.start("Thinking...");
        const freshResponse = await withRetry(
          () => this.gemini.sendMessage(this.chat!, continuationMsg),
          "compact continuation"
        );
        this.spinner.stop();
        await this.processResponse(freshResponse);
      } catch (err: any) {
        this.spinner.stop();
        if (this.interrupted) return;
        console.log(`\n${RED}  Error after compact: ${err.message}${RESET}\n`);
        this.session.append({
          role: "system",
          content: `Error after compact: ${err.message}`,
        });
      }
      return;
    }

    // Send tool results back to model (normal path, no compaction needed)
    try {
      this.spinner.start("Thinking...");
      const nextResponse = await withRetry(
        () => this.gemini.sendFunctionResults(this.chat!, functionResults),
        "sendFunctionResults"
      );
      this.spinner.stop();

      // Recursively process (model might call more tools)
      await this.processResponse(nextResponse);
    } catch (err: any) {
      this.spinner.stop();
      if (this.interrupted) return;

      console.log(
        `\n${RED}  Error: ${err.message}${RESET}\n`
      );
      this.session.append({
        role: "system",
        content: `Tool result error: ${err.message}`,
      });
    }
  }

  // ─── Inline image display (iTerm2 / Kitty / WezTerm) ───────────────────

  private displayInlineImage(base64: string): void {
    // iTerm2 inline image protocol (also supported by WezTerm, Hyper, etc.)
    // OSC 1337 ; File=[args] : base64data ST
    const data = base64;
    process.stdout.write(
      `\x1b]1337;File=inline=1;width=80;preserveAspectRatio=1:${data}\x07\n`
    );
  }

  // ─── Chat-style output ─────────────────────────────────────────────────

  private printModelMessage(text: string): void {
    console.log(`\n${BOLD}${CYAN}Gemini${RESET}`);

    // Indent and style each line of the response
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) {
        console.log("");
      } else {
        console.log(`${WHITE}${line}${RESET}`);
      }
    }
    console.log("");
  }

  // ─── Friendly output formatting ─────────────────────────────────────────

  private formatToolCall(name: string, args: Record<string, any>): string {
    switch (name) {
      case "chrome_launch":
        return "Launching Chrome...";
      case "chrome_list_tabs":
        return "Listing browser tabs...";
      case "chrome_attach":
        return `Connecting to tab ${args.tabIndex ?? args.tabId}...`;
      case "chrome_navigate":
        return `Navigating to ${(args.url || "").slice(0, 60)}...`;
      case "chrome_get_page_text":
        return "Reading page...";
      case "chrome_screenshot":
        return "Taking screenshot...";
      case "chrome_click":
        return `Clicking "${(args.target || "").slice(0, 50)}"...`;
      case "chrome_type": {
        const snippet = (args.text || "").slice(0, 40);
        return `Typing "${snippet}..."`;
      }
      case "chrome_scroll":
        return `Scrolling ${args.direction || "down"}...`;
      case "chrome_press_key":
        return `Pressing ${args.key}...`;
      case "chrome_wait":
        return `Waiting ${args.ms}ms...`;
      case "read_file":
        return `Reading ${args.path || "file"}...`;
      case "write_file":
        return `Writing ${args.path || "file"}...`;
      case "edit_file":
        return `Editing ${args.path || "file"}...`;
      case "list_files":
        return `Listing ${args.path || "."}...`;
      case "search_files":
        return `Searching for "${args.pattern}"...`;
      case "run_command": {
        const cmd = (args.command || "").slice(0, 50);
        return `Running: ${cmd}...`;
      }
      default:
        return `Running ${name}...`;
    }
  }

  private formatToolResult(
    name: string,
    args: Record<string, any>,
    result: string
  ): string {
    const BAR = `${CYAN}│${RESET}`;
    const isError = result.startsWith("ERROR");

    if (isError) {
      return `${BAR} ${RED}✗ ${result.slice(0, 120)}${RESET}`;
    }

    switch (name) {
      case "chrome_launch":
        return `${BAR} ${GREEN}✓${RESET} ${DIM}${result.slice(0, 100)}${RESET}`;
      case "chrome_list_tabs": {
        const tabCount = (result.match(/\[\d+\]/g) || []).length;
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Found ${tabCount} tab(s)${RESET}`;
      }
      case "chrome_attach":
        return `${BAR} ${GREEN}✓${RESET} ${DIM}${result}${RESET}`;
      case "chrome_navigate": {
        const urlMatch = result.match(/Navigated to: (.+)/);
        const url = urlMatch ? urlMatch[1].slice(0, 70) : args.url;
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Opened ${url}${RESET}`;
      }
      case "chrome_get_page_text": {
        const titleMatch = result.match(/=== Page: (.+?) ===/);
        const title = titleMatch ? titleMatch[1].slice(0, 60) : "page";
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Read page: ${title}${RESET}`;
      }
      case "chrome_screenshot":
        return `${BAR} ${GREEN}✓${RESET} ${DIM}${result}${RESET}`;
      case "chrome_click": {
        const clickMatch = result.match(/Clicked: \w+ "(.+?)"/);
        const what = clickMatch ? clickMatch[1].slice(0, 50) : args.target;
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Clicked "${what}"${RESET}`;
      }
      case "chrome_type": {
        const snippet = (args.text || "").slice(0, 50);
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Typed: "${snippet}..."${RESET}`;
      }
      case "chrome_scroll":
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Scrolled ${args.direction || "down"}${RESET}`;
      case "chrome_press_key":
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Pressed ${args.key}${RESET}`;
      case "chrome_wait":
        return `${BAR} ${GREEN}✓${RESET} ${DIM}Waited ${args.ms}ms${RESET}`;
      case "run_command": {
        const truncated =
          result.length > 200 ? result.slice(0, 200) + "…" : result;
        return `${BAR} ${DIM}↳ ${truncated}${RESET}`;
      }
      default: {
        const truncated =
          result.length > 200 ? result.slice(0, 200) + "…" : result;
        return `${BAR} ${DIM}↳ ${truncated}${RESET}`;
      }
    }
  }
}
