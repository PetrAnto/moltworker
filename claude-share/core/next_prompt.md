# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-16 (Phase 5 COMPLETE, F.2 ready for Claude, F.5 ready for Codex)

---

## Current Task: F.2 — Browser Tool Enhancement (CDP a11y + interactions)

### Context

The `browse_url` tool already uses Cloudflare Browser Rendering via HTTP endpoints (`POST https://browser/{sessionId}/*`). A full CDP WebSocket server exists in `src/routes/cdp.ts` (1,856 lines) with DOM, Runtime, Input, Network, Emulation domains. However, **the AI tool only exposes 3 actions**: `extract_text`, `screenshot`, `pdf`. Users can't interact with pages or get structured content.

### What Exists

| Component | File | Status |
|-----------|------|--------|
| `browse_url` tool | `src/openrouter/tools.ts:3717-3864` | 3 actions: extract_text, screenshot, pdf |
| BROWSER binding | `wrangler.jsonc:80-82` | Configured, `Fetcher` type |
| CDP WebSocket server | `src/routes/cdp.ts` | Full CDP: DOM, Runtime, Input, Network (1,856 lines) |
| ToolContext.browser | `src/openrouter/tools.ts:85` | `browser?: Fetcher` — passed to browseUrl() |
| Tool definition | `src/openrouter/tools.ts:379-404` | `url`, `action` (enum), `wait_for` params |
| Content extraction | `src/openrouter/tools.ts:3788-3840` | JS eval: removes scripts/styles, extracts body.innerText, 50KB limit |

### What's Missing

1. **a11y tree extraction** — Get structured page content (roles, names, values) instead of raw innerText. Much better for AI to understand interactive elements (buttons, links, forms, inputs).

2. **Click action** — Click a button/link by CSS selector or a11y role+name. Essential for multi-step workflows (login, navigation, form submission).

3. **Fill action** — Type text into an input by selector. Needed for search, login, forms.

4. **Scroll action** — Scroll to see more content (infinite scroll pages, below-fold content).

### Implementation Plan

#### Step 1: Add `get_accessibility_tree` action to browse_url

The a11y tree is the highest-value addition. It gives the AI a structured view of the page: what's clickable, what's fillable, what text is where.

**Approach:** Use the existing `POST https://browser/{sessionId}/evaluate` endpoint to run a JS function that builds an a11y-like tree from the DOM:

```typescript
// Pseudo-code for the JS to evaluate in browser context
function getA11yTree() {
  const walk = (el, depth = 0) => {
    const role = el.getAttribute('role') || inferRole(el.tagName);
    const name = el.getAttribute('aria-label') || el.textContent?.trim().substring(0, 80);
    const value = (el as HTMLInputElement).value;
    const isInteractive = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
    // Build compact representation: "  [button] Submit" or "  [link] Homepage (href=/)"
    // Assign numeric IDs for click/fill references
  };
  return walk(document.body);
}
```

Return format should be compact text (not JSON) for token efficiency:
```
[1] heading "Welcome to Example"
[2] link "Sign In" href="/login"
[3] textbox "Email" placeholder="you@example.com"
[4] textbox "Password" type=password
[5] button "Log In"
[6] link "Forgot password?" href="/forgot"
```

Each element gets a numeric ID that can be referenced in click/fill actions.

#### Step 2: Add `click` action

```typescript
case 'click':
  // Navigate to URL, wait for load
  // Find element by selector (or by a11y ID from previous get_accessibility_tree)
  // Dispatch click event
  // Wait for navigation/network settle
  // Return new page content or a11y tree
```

#### Step 3: Add `fill` action

```typescript
case 'fill':
  // Find input by selector
  // Focus, clear existing value, type new value
  // Return confirmation
```

#### Step 4: Add `scroll` action

```typescript
case 'scroll':
  // Scroll by specified amount or to element
  // Return new visible content
```

### Tool Definition Changes

Update the `browse_url` tool definition to add new actions and params:

```typescript
{
  name: 'browse_url',
  parameters: {
    properties: {
      url: { type: 'string' },
      action: {
        type: 'string',
        enum: ['extract_text', 'screenshot', 'pdf', 'accessibility_tree', 'click', 'fill', 'scroll'],
      },
      selector: {
        type: 'string',
        description: 'CSS selector for click/fill/scroll target',
      },
      text: {
        type: 'string',
        description: 'Text to type for fill action',
      },
      wait_for: { type: 'string' },
    },
    required: ['url'],
  },
}
```

### Session Persistence (Important Design Decision)

Currently each `browse_url` call creates a new browser session. For click/fill/scroll to work across multiple tool calls, we need **session persistence**:

- Option A: Store `sessionId` in ToolContext, reuse across calls within same task
- Option B: Return `sessionId` in tool response, let AI pass it back in next call
- Option C: Auto-create session on first call, reuse for same URL domain

**Recommended:** Option A — store in ToolContext. Simplest for the AI, and the session lifetime matches the task lifetime. Add `browserSessionId?: string` to ToolContext.

### Key Files to Modify

| File | Change |
|------|--------|
| `src/openrouter/tools.ts` | Add actions to `browseUrl()`, update tool definition |
| `src/openrouter/tools.ts` | Add a11y tree JS extraction function |
| `src/openrouter/tools.test.ts` | Add tests (mock browser Fetcher) |
| `src/types.ts` | No change needed (ToolContext already has `browser`) |

### Testing

```bash
npm test -- src/openrouter/tools.test.ts --reporter=verbose
npm run typecheck
```

Mock the browser `Fetcher` in tests — return fake HTML for extract, fake a11y tree for accessibility_tree, etc.

### Definition of Done

- [ ] `accessibility_tree` action returns numbered, structured page elements
- [ ] `click` action dispatches click on element by selector
- [ ] `fill` action types text into input by selector
- [ ] `scroll` action scrolls page or to element
- [ ] Session persistence across multiple browse_url calls in same task
- [ ] At least 8 new tests (2 per action)
- [ ] All existing tests pass, typecheck clean
- [ ] Tool definition updated with new actions + params

---

## Parallel: F.5 — Observability Dashboard (Codex)

**Prompt file:** `claude-share/core/codex-prompts/codex-prompt-F5-dashboard.md`

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-16 | Phase 5.6 — Orchestra polish (durationMs, parsing, stale cleanup) | Codex+Claude | PRs 337-339 → compromise |
| 2026-03-16 | Phase 5.4 — Acontext Disk file management (4 tools + hardening) | Codex+Claude | PRs 328-330, 332-334 → compromise |
| 2026-03-16 | Phase 5.3 — Acontext Sandbox `run_code` tool | Codex+Claude | PR 323 → compromise |
| 2026-03-14 | Orchestra gating fix | Claude Opus 4.6 | Commit d28fcb1 |
