import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "./config.js";

interface TabInfo {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class ChromeClient {
  private client: CDP.Client | null = null;
  private currentTab: TabInfo | null = null;

  /** List all available tabs from the Chrome instance */
  async listTabs(): Promise<TabInfo[]> {
    try {
      const targets = await CDP.List({
        host: config.cdpHost,
        port: config.cdpPort,
      });
      return targets
        .filter((t: any) => t.type === "page")
        .map((t: any) => ({
          id: t.id,
          title: t.title || "(untitled)",
          url: t.url,
          webSocketDebuggerUrl: t.webSocketDebuggerUrl,
        }));
    } catch (err: any) {
      throw new Error(
        `Cannot connect to Chrome on ${config.cdpHost}:${config.cdpPort}.\n` +
          `Make sure Chrome is running with --remote-debugging-port=${config.cdpPort}\n` +
          `Error: ${err.message}`
      );
    }
  }

  /** Attach to a specific tab by index or ID */
  async attach(tabIdOrIndex: string | number): Promise<string> {
    const tabs = await this.listTabs();
    if (tabs.length === 0) {
      throw new Error("No tabs found in Chrome.");
    }

    let tab: TabInfo | undefined;
    if (typeof tabIdOrIndex === "number") {
      tab = tabs[tabIdOrIndex];
    } else {
      tab = tabs.find((t) => t.id === tabIdOrIndex);
    }

    if (!tab) {
      throw new Error(
        `Tab not found. Available tabs:\n` +
          tabs.map((t, i) => `  [${i}] ${t.title} — ${t.url}`).join("\n")
      );
    }

    // Disconnect existing client if any
    await this.detach();

    this.client = await CDP({
      host: config.cdpHost,
      port: config.cdpPort,
      target: tab.id,
    });

    // Enable required domains
    await this.client.Page.enable();
    await this.client.Runtime.enable();
    await this.client.DOM.enable();

    // Auto-dismiss "Leave site?" / beforeunload dialogs
    this.setupDialogHandler(this.client);

    this.currentTab = tab;
    return `Attached to: "${tab.title}" (${tab.url})`;
  }

  /** Detach from the current tab */
  async detach(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
      this.currentTab = null;
    }
  }

  /** Check if we're connected to a tab */
  isConnected(): boolean {
    return this.client !== null;
  }

  /** Get info about the currently attached tab */
  getTabInfo(): TabInfo | null {
    return this.currentTab;
  }

  /** Auto-dismiss "Leave site?" / beforeunload dialogs */
  private setupDialogHandler(client: CDP.Client): void {
    client.Page.javascriptDialogOpening(({ type }: { type: string }) => {
      // Auto-accept beforeunload ("Leave site?") and alert/confirm dialogs
      client.Page.handleJavaScriptDialog({ accept: true }).catch(() => {
        // Ignore errors if dialog already dismissed
      });
    });
  }

  /**
   * Ensure we have a live CDP connection. If the WebSocket died
   * (e.g. after a navigation), automatically reconnect to the same tab.
   */
  private async ensureConnected(): Promise<CDP.Client> {
    if (!this.client) {
      throw new Error(
        "Not connected to any Chrome tab. Use chrome_list_tabs and chrome_attach first."
      );
    }

    // Test if the connection is still alive by checking the WebSocket
    try {
      await this.client.Runtime.evaluate({ expression: "1" });
      return this.client;
    } catch {
      // Connection died — try to reconnect to the same tab
      if (this.currentTab) {
        const tabId = this.currentTab.id;
        console.log(
          "\x1b[90m  (reconnecting to tab...)\x1b[0m"
        );
        try {
          // Look up the tab again — its ID may have changed after navigation
          const tabs = await this.listTabs();
          // Try to find the same tab by ID first
          let tab = tabs.find((t) => t.id === tabId);
          // If not found by ID, find by URL prefix or just use the first tab
          if (!tab && tabs.length > 0) {
            tab = tabs[0];
          }
          if (!tab) {
            throw new Error("Tab no longer exists");
          }

          this.client = await CDP({
            host: config.cdpHost,
            port: config.cdpPort,
            target: tab.id,
          });
          await this.client.Page.enable();
          await this.client.Runtime.enable();
          await this.client.DOM.enable();
          this.setupDialogHandler(this.client);
          this.currentTab = tab;
          return this.client;
        } catch (reconnectErr: any) {
          this.client = null;
          this.currentTab = null;
          throw new Error(
            `Lost connection to Chrome tab and could not reconnect: ${reconnectErr.message}`
          );
        }
      }
      throw new Error(
        "Lost connection to Chrome tab. Use /tabs and /attach to reconnect."
      );
    }
  }

  /** Navigate the current tab to a URL */
  async navigate(url: string): Promise<string> {
    const client = await this.ensureConnected();
    // Add https:// if no protocol specified
    if (!url.match(/^https?:\/\//)) {
      url = "https://" + url;
    }
    await client.Page.navigate({ url });
    // Wait for load with a timeout so we don't hang forever
    try {
      await Promise.race([
        client.Page.loadEventFired(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 15000)
        ),
      ]);
    } catch {
      // Timeout or error is OK, page might be slow — we proceed anyway
    }
    // Update tab info
    const result = await client.Runtime.evaluate({
      expression: "JSON.stringify({ title: document.title, url: window.location.href })",
    });
    if (result.result.value) {
      const info = JSON.parse(result.result.value);
      this.currentTab = { ...this.currentTab!, title: info.title, url: info.url };
    }
    return `Navigated to: ${url}`;
  }

  /** Get visible text content of the page */
  async getPageText(): Promise<string> {
    const client = await this.ensureConnected();
    const result = await client.Runtime.evaluate({
      expression: `
        (function() {
          // Get page metadata
          const title = document.title;
          const url = window.location.href;

          // Get all visible text, skip scripts/styles
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: function(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                const tag = parent.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
                  return NodeFilter.FILTER_REJECT;
                }
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') {
                  return NodeFilter.FILTER_REJECT;
                }
                const text = node.textContent.trim();
                if (!text) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );

          const texts = [];
          let node;
          while (node = walker.nextNode()) {
            texts.push(node.textContent.trim());
          }

          // Also get interactive elements for the model to know about
          const interactiveElements = [];
          const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
          buttons.forEach((b, i) => {
            const text = b.textContent?.trim() || b.getAttribute('aria-label') || '';
            if (text) interactiveElements.push('Button: ' + text);
          });
          const links = document.querySelectorAll('a[href]');
          links.forEach((a, i) => {
            if (i < 15) { // Limit links
              const text = a.textContent?.trim() || '';
              const href = a.getAttribute('href') || '';
              if (text) interactiveElements.push('Link: ' + text + ' -> ' + href);
            }
          });
          const inputs = document.querySelectorAll('input, textarea, select');
          inputs.forEach((inp) => {
            const label = inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || inp.getAttribute('name') || inp.getAttribute('type') || 'input';
            interactiveElements.push('Input: ' + label);
          });

          let output = '=== Page: ' + title + ' ===\\n';
          output += 'URL: ' + url + '\\n\\n';
          output += '--- Page Text ---\\n';
          output += texts.join('\\n');
          if (interactiveElements.length > 0) {
            output += '\\n\\n--- Interactive Elements ---\\n';
            output += interactiveElements.join('\\n');
          }

          // Truncate if too long (keep it reasonable for the model to save tokens)
          if (output.length > 5000) {
            output = output.slice(0, 5000) + '\\n\\n[... truncated, page has more content]';
          }

          return output;
        })()
      `,
    });
    return result.result.value as string || "Could not extract page text.";
  }

  /** Take a screenshot and save to disk */
  async screenshot(filePath: string): Promise<string> {
    const client = await this.ensureConnected();
    const { data } = await client.Page.captureScreenshot({ format: "png" });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(data, "base64"));
    return `Screenshot saved to: ${filePath}`;
  }

  /** Click an element by CSS selector or by visible text */
  async click(selectorOrText: string): Promise<string> {
    const client = await this.ensureConnected();

    // Try CSS selector first
    const clickResult = await client.Runtime.evaluate({
      expression: `
        (function() {
          // Try CSS selector
          let el = null;
          try {
            el = document.querySelector(${JSON.stringify(selectorOrText)});
          } catch(e) { /* not a valid selector */ }

          if (!el) {
            // Try finding by visible text (buttons, links, etc.)
            const candidates = [
              ...document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]')
            ];
            const searchText = ${JSON.stringify(selectorOrText)}.toLowerCase().trim();
            el = candidates.find(c => {
              const t = (c.textContent || c.getAttribute('aria-label') || c.getAttribute('value') || '').toLowerCase().trim();
              return t === searchText || t.includes(searchText);
            });
          }

          if (!el) {
            // Broader search: any clickable-ish element with matching text
            const all = document.querySelectorAll('*');
            const searchText = ${JSON.stringify(selectorOrText)}.toLowerCase().trim();
            for (const candidate of all) {
              const t = (candidate.textContent || '').toLowerCase().trim();
              if (t === searchText && candidate.offsetParent !== null) {
                el = candidate;
                break;
              }
            }
          }

          if (!el) return 'ERROR: Could not find element matching: ' + ${JSON.stringify(selectorOrText)};

          // Scroll into view and click
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.click();
          return 'Clicked: ' + (el.tagName || '') + ' "' + (el.textContent || '').trim().slice(0, 80) + '"';
        })()
      `,
    });
    return clickResult.result.value as string || "Click failed.";
  }

  /** Focus an input/textarea/contenteditable and type text */
  async type(selectorOrText: string, text: string): Promise<string> {
    const client = await this.ensureConnected();

    // Find and focus the element — handles regular inputs AND contenteditable divs
    const focusResult = await client.Runtime.evaluate({
      expression: `
        (function() {
          let el = null;

          // 1. Try CSS selector first
          try {
            el = document.querySelector(${JSON.stringify(selectorOrText)});
          } catch(e) {}

          // 2. Try by placeholder, name, aria-label, role
          if (!el) {
            const inputs = document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"]');
            const search = ${JSON.stringify(selectorOrText)}.toLowerCase();
            el = [...inputs].find(inp => {
              const placeholder = (inp.getAttribute('placeholder') || '').toLowerCase();
              const name = (inp.getAttribute('name') || '').toLowerCase();
              const label = (inp.getAttribute('aria-label') || '').toLowerCase();
              const type = (inp.getAttribute('type') || '').toLowerCase();
              const role = (inp.getAttribute('role') || '').toLowerCase();
              return placeholder.includes(search) || name.includes(search) || label.includes(search) || type.includes(search) || role.includes(search);
            });
          }

          // 3. Try finding any contenteditable or textbox on the page
          if (!el) {
            el = document.querySelector('[contenteditable="true"]:not([aria-hidden="true"])') ||
                 document.querySelector('[role="textbox"]') ||
                 document.querySelector('.ProseMirror') ||
                 document.querySelector('.public-DraftEditor-content') ||
                 document.querySelector('.ql-editor');
          }

          if (!el) return 'ERROR: Could not find input matching: ' + ${JSON.stringify(selectorOrText)};

          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.focus();
          el.click(); // Some editors need a click to activate

          // Determine if it's a contenteditable or regular input
          const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';

          // Clear existing content
          if (isContentEditable) {
            el.innerHTML = '';
          } else if ('value' in el) {
            el.value = '';
          }

          return (isContentEditable ? 'FOCUSED_CE: ' : 'FOCUSED: ') + el.tagName + '[' + (el.getAttribute('name') || el.getAttribute('role') || el.getAttribute('type') || el.className.split(' ')[0] || 'input') + ']';
        })()
      `,
    });

    const focusMsg = focusResult.result.value as string;
    if (focusMsg?.startsWith("ERROR:")) {
      return focusMsg;
    }

    const isContentEditable = focusMsg?.startsWith("FOCUSED_CE:");

    // Type each character using Input.dispatchKeyEvent for realistic typing
    for (const char of text) {
      await client.Input.dispatchKeyEvent({
        type: "keyDown",
        text: char,
        key: char,
        unmodifiedText: char,
      });
      await client.Input.dispatchKeyEvent({
        type: "keyUp",
        key: char,
      });
    }

    // For regular inputs, also set value via JS (some frameworks need this)
    if (!isContentEditable) {
      await client.Runtime.evaluate({
        expression: `
          (function() {
            const el = document.activeElement;
            if (el && 'value' in el) {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set || Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
              )?.set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, ${JSON.stringify(text)});
              } else {
                el.value = ${JSON.stringify(text)};
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()
        `,
      });
    } else {
      // For contenteditable, also set via insertText for frameworks that listen to input events
      await client.Runtime.evaluate({
        expression: `
          (function() {
            const el = document.activeElement;
            if (el && el.isContentEditable) {
              // If the key events didn't work, force set the text
              if (!el.textContent || el.textContent.trim() === '') {
                el.textContent = ${JSON.stringify(text)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          })()
        `,
      });
    }

    const label = focusMsg.replace("FOCUSED_CE: ", "").replace("FOCUSED: ", "");
    return `Typed "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" into ${label}`;
  }

  /** Scroll the page */
  async scroll(direction: "up" | "down", amount?: number): Promise<string> {
    const client = await this.ensureConnected();
    const pixels = amount || 500;
    const delta = direction === "down" ? pixels : -pixels;

    await client.Runtime.evaluate({
      expression: `window.scrollBy(0, ${delta})`,
    });

    return `Scrolled ${direction} by ${pixels}px`;
  }

  /** Press a keyboard key */
  async pressKey(key: string): Promise<string> {
    const client = await this.ensureConnected();

    // Map common key names to CDP key identifiers
    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      enter: { key: "Enter", code: "Enter", keyCode: 13 },
      tab: { key: "Tab", code: "Tab", keyCode: 9 },
      escape: { key: "Escape", code: "Escape", keyCode: 27 },
      backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    };

    const mapped = keyMap[key.toLowerCase()] || { key, code: key, keyCode: 0 };

    await client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
    });
    await client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
    });

    return `Pressed key: ${key}`;
  }

  /** Wait for a specified number of milliseconds */
  async wait(ms: number): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `Waited ${ms}ms`;
  }
}
