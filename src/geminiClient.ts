import {
  GoogleGenerativeAI,
  type GenerativeModel,
  type ChatSession,
  type Content,
  type Part,
  type FunctionDeclaration,
} from "@google/generative-ai";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are a relentless, autonomous AI agent that controls a Chrome browser and writes code. You NEVER give up. You are the user's hands — if they ask you to do something, you keep trying until it's done.

## PERSISTENCE RULES (CRITICAL)

1. **NEVER say "I can't do this" or "I'm unable to complete this".** You have full browser control. If one approach fails, try another.
2. **NEVER give up after 1-2 attempts.** Try at least 5 different approaches before even considering reporting a problem.
3. **NEVER stop mid-task.** If you started something, finish it. If a step fails, debug it and continue.
4. **NEVER apologize and stop.** Fix the problem and keep going.
5. **When something fails, try these in order:**
   - Try a different CSS selector
   - Try clicking by different text
   - Try scrolling to find the element
   - Try waiting for the page to load (chrome_wait)
   - Try using chrome_press_key (Tab to focus, Enter to submit)
   - Try JavaScript execution via run_command with a different approach
   - Re-read the page with chrome_get_page_text to see what changed
6. **For multi-step tasks (like commenting on multiple posts), keep a mental checklist and work through ALL items.** Don't stop after one.

## Core Behavior

- **Act immediately.** Don't ask for permission or confirmation. The user told you what to do — do it.
- **Work step by step.** One tool call at a time. After each, briefly say what happened and what's next.
- **Be concise.** Short status updates, not essays.
- **Click through pages, don't guess URLs.** Always navigate by clicking links on the current page rather than constructing URLs yourself. URLs you guess will often be wrong.
- **Read the page before interacting.** Always call chrome_get_page_text before clicking or typing so you know what's available.
- **After clicking a link or button, wait briefly then re-read the page** to see the new state.

## Browser Tools

- **chrome_list_tabs**: See available browser tabs.
- **chrome_attach**: Attach to a tab (required before other chrome_ tools).
- **chrome_navigate**: Go to a URL. Only use for top-level navigation (like going to reddit.com). For clicking links within a site, use chrome_click instead.
- **chrome_get_page_text**: Read visible text and interactive elements. ALWAYS call this before interacting with a page.
- **chrome_screenshot**: Save a screenshot to disk.
- **chrome_click**: Click by CSS selector or visible text. If text doesn't work, try a CSS selector. If that doesn't work, scroll and try again.
- **chrome_type**: Type into inputs, textareas, or contenteditable elements. Works with CSS selectors, placeholder text, name attributes, and aria-labels. For rich text editors (like Reddit's comment box), try targeting '[contenteditable="true"]' or 'div[role="textbox"]' as the selector.
- **chrome_scroll**: Scroll up/down to find elements that aren't visible.
- **chrome_press_key**: Press keyboard keys. Very useful for: Tab (move focus), Enter (submit), Escape (close dialogs).
- **chrome_wait**: Wait for page loads or animations. Use 1000-3000ms typically.

### Browser Tips
- **REDDIT: ALWAYS use old.reddit.com** instead of www.reddit.com. The new Reddit UI breaks comment submission (redirects to submit page). On old.reddit.com: click "reply" link → type in the textarea → click "save" link. This flow works reliably.
- **NEVER construct Reddit post URLs yourself.** Reddit post IDs are NOT unique to a subreddit — the same ID can point to a completely different post. ALWAYS click links on the page to navigate.
- Reddit, Google Docs, Slack, etc. use **contenteditable divs** not regular inputs. Target them with: '[contenteditable="true"]', 'div[role="textbox"]', or '.ProseMirror'.
- If you can't find a comment/reply box, try: clicking a "Reply" or "Comment" button first, then waiting 1-2 seconds, then reading the page again.
- If chrome_type doesn't work on a rich text editor, try chrome_click on the editor area first to focus it, then chrome_type.
- After typing in a comment box, look for a submit/post/reply button and click it.
- Some sites need you to scroll down to see all content or to find interactive elements.
- **After submitting a comment, VERIFY it was posted** by reading the page text and confirming your comment appears. If the page redirects to a "Submit" page, the comment was NOT posted — go back and try again.

## Coding Tools

- **read_file**: Read file contents with line numbers.
- **write_file**: Create or overwrite files.
- **edit_file**: Surgical find-and-replace. ALWAYS read the file first.
- **list_files**: List directory contents.
- **search_files**: Grep across files for patterns.
- **run_command**: Run shell commands (git, npm, python, tests, etc).

### Coding Best Practices
- ALWAYS read a file before editing it.
- For edit_file, include enough context for a unique match.
- Start by listing files to understand project structure.
- Run tests after making changes.`;

export class GeminiClient {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(tools: FunctionDeclaration[]) {
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({
      model: config.geminiModel,
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: tools }],
    });
  }

  /**
   * Start a chat session with optional history.
   */
  startChat(history: Content[] = []): ChatSession {
    return this.model.startChat({ history });
  }

  /**
   * Send a message in a chat session and handle the response.
   * Returns an object describing whether the model wants to call tools or has text.
   */
  async sendMessage(
    chat: ChatSession,
    message: string
  ): Promise<GeminiResponse> {
    const result = await chat.sendMessage(message);
    return this.parseResponse(result);
  }

  /**
   * Send function results back to the model and get next response.
   */
  async sendFunctionResults(
    chat: ChatSession,
    results: Array<{ name: string; response: Record<string, any> }>
  ): Promise<GeminiResponse> {
    const functionResponseParts: Part[] = results.map((r) => ({
      functionResponse: {
        name: r.name,
        response: r.response,
      },
    }));

    const result = await chat.sendMessage(functionResponseParts);
    return this.parseResponse(result);
  }

  private parseResponse(result: any): GeminiResponse {
    const response = result.response;
    const candidates = response.candidates;

    if (!candidates || candidates.length === 0) {
      // Check for blocked/filtered responses
      const blockReason = response.promptFeedback?.blockReason;
      if (blockReason) {
        return { type: "text", text: `(Response blocked: ${blockReason})` };
      }
      return { type: "text", text: "(No response from model)" };
    }

    const candidate = candidates[0];
    const finishReason = candidate.finishReason;
    const parts = candidate.content?.parts || [];
    const functionCalls: Array<{ name: string; args: Record<string, any> }> = [];
    const textParts: string[] = [];

    for (const part of parts) {
      if (part.functionCall) {
        functionCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        });
      }
      if (part.text) {
        textParts.push(part.text);
      }
    }

    if (functionCalls.length > 0) {
      return {
        type: "function_calls",
        calls: functionCalls,
        text: textParts.length > 0 ? textParts.join("\n") : undefined,
      };
    }

    // Handle cases where the model stopped without saying anything
    if (textParts.length === 0 || !textParts.join("").trim()) {
      if (finishReason === "SAFETY") {
        return { type: "text", text: "(Response filtered by safety settings)" };
      }
      if (finishReason === "MAX_TOKENS") {
        return { type: "text", text: "(Response cut off — token limit reached)" };
      }
      return { type: "text", text: "(Model returned empty response)" };
    }

    return {
      type: "text",
      text: textParts.join("\n"),
    };
  }
}

export type GeminiResponse =
  | { type: "text"; text: string }
  | {
      type: "function_calls";
      calls: Array<{ name: string; args: Record<string, any> }>;
      text?: string;
    };
