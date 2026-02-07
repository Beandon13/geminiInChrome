# Gemini in Chrome

A CLI coding agent powered by the Gemini API with full Chrome browser automation via the Chrome DevTools Protocol.

## Install

```bash
git clone https://github.com/Beandon13/geminiInChrome.git
cd geminiInChrome
npm install
npm run build
npm link
```

This installs the global `gemini` command.

## Setup

Run `gemini` for the first time and the setup wizard will walk you through:

1. **API Key** — Get one free at [Google AI Studio](https://aistudio.google.com/apikey)
2. **Model** — Pick from gemini-2.5-flash, gemini-2.5-pro, or gemini-2.0-flash
3. **Chrome port** — Port for Chrome remote debugging (default: 9222)

Config is saved to `~/.gemini-chrome/config.env`. Run `gemini --setup` to change settings later.

## Chrome Setup

To use browser automation features, launch Chrome with remote debugging:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

On Linux:
```bash
google-chrome --remote-debugging-port=9222
```

## Usage

```bash
gemini                              # Start a new session
gemini --dir ~/projects/my-app      # Work in a specific directory
gemini --resume 2025-01-15_14-30    # Resume a previous session
gemini --setup                      # Re-run setup wizard
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `/tabs` | List Chrome tabs |
| `/attach N` | Attach to tab N |
| `/cd <path>` | Change working directory |
| `/clear` | Clear screen |
| `/status` | Session info |
| `/exit` | Quit |
| `Ctrl+C` | Interrupt current task |
| `Ctrl+C x2` | Exit |

### What It Can Do

**Coding** — Read, write, edit, and search files. Run shell commands.

**Browser** — Navigate pages, click elements, type text, take screenshots, scroll, read page content.

Just describe what you want in plain English:

```
> Fix the bug in src/utils.ts where date parsing fails
> Go to github.com and star the repo
> Read the error on the page and suggest a fix
```

## Requirements

- Node.js 18+
- Google Chrome (for browser features)
- Gemini API key
