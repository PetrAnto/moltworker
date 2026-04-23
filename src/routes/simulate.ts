/**
 * Simulation Endpoint — Allows testing bot behavior via HTTP without Telegram.
 *
 * Two modes:
 *   POST /simulate/chat   — Send a prompt through the full DO pipeline, get structured result
 *   POST /simulate/command — Send a /command through the handler with a CapturingBot
 *
 * Authentication: Bearer token via DEBUG_API_KEY environment variable.
 *
 * Usage (from Claude Code or curl):
 *   curl -X POST https://worker-url/simulate/chat \
 *     -H "Authorization: Bearer $DEBUG_API_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"text": "What is 2+2?", "model": "flash"}'
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import type { TaskProcessor, TaskRequest } from '../durable-objects/task-processor';
import type { ChatMessage } from '../openrouter/client';
import { fetchDOWithRetry } from '../utils/do-retry';
import { createTelegramHandler } from '../telegram/handler';
import { CapturingBot } from '../telegram/capturing-bot';
import type { SandboxLike } from '../openrouter/tools';

const simulate = new Hono<AppEnv>();

// ---- Auth middleware ----

simulate.use('*', async (c, next) => {
  const apiKey = c.env.DEBUG_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'Simulation endpoint not configured. Set DEBUG_API_KEY secret.' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
    return c.json({ error: 'Invalid or missing Authorization header' }, 401);
  }

  return next();
});

// ---- Types ----

interface TaskStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'not_found';
  result?: string;
  error?: string;
  toolsUsed?: string[];
  iterations?: number;
  startTime?: number;
  lastUpdate?: number;
  modelAlias?: string;
  phase?: string;
}

// ---- Helpers ----

/** Strip any secret/key fields that may leak from the DO status response. */
function sanitizeStatus(raw: Record<string, unknown>): TaskStatus {
  const SAFE_FIELDS = new Set([
    'status', 'result', 'error', 'toolsUsed', 'iterations',
    'startTime', 'lastUpdate', 'modelAlias', 'phase',
    'taskId', 'chatId', 'userId', 'messages',
    'workPhaseContent', 'toolSignatures', 'phaseStartIteration',
    'autoResume', 'reasoningLevel', 'structuredPlan', 'reviewerAlias',
  ]);
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (SAFE_FIELDS.has(key)) {
      clean[key] = raw[key];
    }
  }
  return clean as unknown as TaskStatus;
}

/** Poll the DO /status endpoint until the task finishes or times out. */
async function waitForCompletion(
  stub: { fetch: (request: Request | string) => Promise<Response> },
  timeoutMs: number,
): Promise<TaskStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: TaskStatus = { status: 'not_found' };

  while (Date.now() < deadline) {
    const resp = await fetchDOWithRetry(stub, new Request('https://do/status', { method: 'GET' }));
    const raw = await resp.json() as Record<string, unknown>;
    lastStatus = sanitizeStatus(raw);

    if (lastStatus.status === 'completed' || lastStatus.status === 'failed' || lastStatus.status === 'cancelled') {
      return lastStatus;
    }

    // Poll every 2 seconds
    await new Promise(r => setTimeout(r, 2000));
  }

  return lastStatus; // Return whatever we have at timeout
}

// ---- Routes ----

/**
 * POST /simulate/chat
 *
 * Send a prompt through the full TaskProcessor DO pipeline.
 * Returns the structured result including response text, tools used, timing.
 *
 * Body: { text: string, model?: string, timeout?: number }
 */
simulate.post('/chat', async (c) => {
  const env = c.env;

  if (!env.OPENROUTER_API_KEY) {
    return c.json({ error: 'OPENROUTER_API_KEY not configured' }, 503);
  }
  if (!env.TASK_PROCESSOR) {
    return c.json({ error: 'TASK_PROCESSOR not configured' }, 503);
  }

  const body = await c.req.json() as {
    text?: string;
    model?: string;
    timeout?: number;
    systemPrompt?: string;
  };

  if (!body.text) {
    return c.json({ error: 'Missing required field: text' }, 400);
  }

  const text = body.text;
  const modelAlias = body.model || 'flash';
  const timeoutMs = Math.min(body.timeout || 60_000, 120_000); // Max 2 min
  const userId = '999999999'; // Numeric string — must match what handler extracts from from.id
  const chatId = 0; // Fake chat — Telegram messages will silently fail
  const taskId = `sim-${Date.now()}`;

  const messages: ChatMessage[] = [];
  if (body.systemPrompt) {
    messages.push({ role: 'system', content: body.systemPrompt });
  }
  messages.push({ role: 'user', content: text });

  const taskRequest: TaskRequest = {
    taskId,
    chatId,
    userId,
    modelAlias,
    messages,
    telegramToken: 'simulate-no-telegram', // Fake — all TG calls will silently fail
    openrouterKey: env.OPENROUTER_API_KEY,
    githubToken: env.GITHUB_TOKEN,
    braveSearchKey: env.BRAVE_SEARCH_KEY,
    tavilyKey: env.TAVILY_API_KEY,
    dashscopeKey: env.DASHSCOPE_API_KEY,
    moonshotKey: env.MOONSHOT_API_KEY,
    deepseekKey: env.DEEPSEEK_API_KEY,
    anthropicKey: env.ANTHROPIC_API_KEY,
    nvidiaKey: env.NVIDIA_NIM_API_KEY,
    autoResume: false, // Don't auto-resume simulated tasks
    prompt: `[simulate] ${text.slice(0, 100)}`,
    acontextKey: env.ACONTEXT_API_KEY,
    acontextBaseUrl: env.ACONTEXT_BASE_URL,
  };

  // Create a unique DO instance per simulation (so they don't conflict)
  const doName = `simulate-${taskId}`;
  const doId = env.TASK_PROCESSOR.idFromName(doName);
  const doStub = env.TASK_PROCESSOR.get(doId);

  const start = Date.now();

  try {
    // Submit task
    await fetchDOWithRetry(doStub, new Request('https://do/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskRequest),
    }));

    // Poll for completion
    const status = await waitForCompletion(doStub, timeoutMs);
    const durationMs = Date.now() - start;

    return c.json({
      taskId,
      status: status.status,
      result: status.result || null,
      error: status.error || null,
      toolsUsed: status.toolsUsed || [],
      iterations: status.iterations || 0,
      model: {
        requested: modelAlias,
        resolved: status.modelAlias || modelAlias,
      },
      phase: status.phase || null,
      durationMs,
      timedOut: status.status === 'processing', // Still processing = we timed out
    });
  } catch (err) {
    return c.json({
      taskId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    }, 500);
  }
});

/**
 * POST /simulate/command
 *
 * Send a /command through the TelegramHandler with a CapturingBot.
 * Returns all messages the bot would have sent to the user.
 *
 * Body: { command: string }
 * Example: { "command": "/models" }
 */
simulate.post('/command', async (c) => {
  const env = c.env;

  if (!env.OPENROUTER_API_KEY) {
    return c.json({ error: 'OPENROUTER_API_KEY not configured' }, 503);
  }
  if (!env.MOLTBOT_BUCKET) {
    return c.json({ error: 'MOLTBOT_BUCKET not configured' }, 503);
  }

  const body = await c.req.json() as { command?: string; timeout?: number };

  if (!body.command) {
    return c.json({ error: 'Missing required field: command' }, 400);
  }

  const command = body.command.startsWith('/') ? body.command : `/${body.command}`;
  const timeoutMs = body.timeout ? Math.min(body.timeout, 120_000) : 0;
  const userId = '999999999'; // Numeric string — must match what handler extracts from from.id
  const chatId = 0;

  // Create handler with all real bindings
  const sandbox = c.get('sandbox' as never) as SandboxLike | undefined;
  const handler = createTelegramHandler(
    'simulate-no-telegram',
    env.OPENROUTER_API_KEY,
    env.MOLTBOT_BUCKET,
    undefined,
    'storia-orchestrator',
    [userId], // Only allow our simulate user
    env.GITHUB_TOKEN,
    env.BRAVE_SEARCH_KEY,
    env.TASK_PROCESSOR,
    env.BROWSER,
    env.DASHSCOPE_API_KEY,
    env.MOONSHOT_API_KEY,
    env.DEEPSEEK_API_KEY,
    env.ANTHROPIC_API_KEY,
    env.NVIDIA_NIM_API_KEY,
    sandbox,
    env.ACONTEXT_API_KEY,
    env.ACONTEXT_BASE_URL,
    env.CLOUDFLARE_API_TOKEN,
    env.ARTIFICIAL_ANALYSIS_KEY,
    env.NEXUS_KV,
    env.TAVILY_API_KEY,
  );

  // Inject CapturingBot
  const bot = new CapturingBot();
  handler._setBot(bot);

  const start = Date.now();

  try {
    // Construct fake Telegram update
    const fakeUpdate = {
      update_id: Date.now(),
      message: {
        message_id: Date.now(),
        from: {
          id: Number(userId.replace(/\D/g, '')) || 0,
          is_bot: false,
          first_name: 'Simulate',
          username: 'simulate',
        },
        chat: {
          id: chatId,
          type: 'private' as const,
        },
        date: Math.floor(Date.now() / 1000),
        text: command,
      },
    };

    await handler.handleUpdate(fakeUpdate);

    // Filter out noise (typing actions, etc.)
    const messages = bot.captured.filter(m => m.type !== 'action');

    // If timeout is set and the command dispatched to a DO (orchestra commands),
    // poll the DO for the task result. The handler dispatches orch tasks to
    // a DO named after the userId.
    let doResult: TaskStatus | undefined;
    if (timeoutMs > 0 && env.TASK_PROCESSOR) {
      const dispatchedToDO = bot.captured.some(
        m => m.text?.includes('Orchestra') && m.text?.includes('started')
      );
      if (dispatchedToDO) {
        const doId = env.TASK_PROCESSOR.idFromName(userId);
        const doStub = env.TASK_PROCESSOR.get(doId);
        doResult = await waitForCompletion(doStub, timeoutMs);
      }
    }

    const durationMs = Date.now() - start;

    return c.json({
      command,
      messages,
      allCaptured: bot.captured,
      ...(doResult ? { doResult } : {}),
      durationMs,
    });
  } catch (err) {
    return c.json({
      command,
      error: err instanceof Error ? err.message : String(err),
      messages: bot.captured.filter(m => m.type !== 'action'),
      allCaptured: bot.captured,
      durationMs: Date.now() - start,
    }, 500);
  }
});

/**
 * GET /simulate/task
 *
 * Poll the simulate user's TaskProcessor DO.
 * This is the DO used by /simulate/command for orchestra tasks.
 * Use this to check on long-running /orch next tasks after the initial timeout.
 */
simulate.get('/task', async (c) => {
  const env = c.env;

  if (!env.TASK_PROCESSOR) {
    return c.json({ error: 'TASK_PROCESSOR not configured' }, 503);
  }

  const userId = '999999999';
  const doId = env.TASK_PROCESSOR.idFromName(userId);
  const doStub = env.TASK_PROCESSOR.get(doId);

  try {
    const resp = await fetchDOWithRetry(doStub, new Request('https://do/status', { method: 'GET' }));
    const raw = await resp.json() as Record<string, unknown>;
    return c.json(sanitizeStatus(raw));
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});

/**
 * GET /simulate/status/:taskId
 *
 * Check status of a previously submitted simulation task.
 * Useful when the initial /simulate/chat call timed out.
 */
simulate.get('/status/:taskId', async (c) => {
  const env = c.env;

  if (!env.TASK_PROCESSOR) {
    return c.json({ error: 'TASK_PROCESSOR not configured' }, 503);
  }

  const taskId = c.req.param('taskId');
  const doName = `simulate-${taskId}`;
  const doId = env.TASK_PROCESSOR.idFromName(doName);
  const doStub = env.TASK_PROCESSOR.get(doId);

  try {
    const resp = await fetchDOWithRetry(doStub, new Request('https://do/status', { method: 'GET' }));
    const raw = await resp.json() as Record<string, unknown>;
    return c.json(sanitizeStatus(raw));
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});

/**
 * GET /simulate/health
 *
 * Quick health check — verifies the endpoint is reachable and configured.
 */
simulate.get('/health', async (c) => {
  const env = c.env;
  return c.json({
    ok: true,
    configured: {
      openrouter: !!env.OPENROUTER_API_KEY,
      taskProcessor: !!env.TASK_PROCESSOR,
      r2: !!env.MOLTBOT_BUCKET,
      github: !!env.GITHUB_TOKEN,
      braveSearch: !!env.BRAVE_SEARCH_KEY,
      tavily: !!env.TAVILY_API_KEY,
      sandbox: !!env.Sandbox,
    },
  });
});

/**
 * GET /simulate/sandbox-test — Test DO→Sandbox connectivity.
 *
 * Creates a temporary TaskProcessor DO instance, which initializes
 * the Sandbox binding via getSandbox(). Then runs a trivial command
 * (`echo ok`) to verify the sandbox_exec tool works end-to-end from
 * within a Durable Object context.
 *
 * Use this after deploying to verify the Sandbox integration before
 * relying on it for real tasks.
 */
simulate.get('/sandbox-test', async (c) => {
  const env = c.env;
  const taskId = `sandbox-test-${Date.now()}`;

  // Step 1: Verify the binding exists
  if (!env.Sandbox) {
    return c.json({ ok: false, error: 'Sandbox binding not available in env' }, 500);
  }

  // Step 2: Test from Worker context (direct — this already works)
  let workerSandboxOk = false;
  let workerError: string | undefined;
  try {
    const sandbox = c.get('sandbox' as never) as SandboxLike | undefined;
    if (sandbox) {
      const proc = await sandbox.startProcess('echo sandbox-worker-ok');
      // Wait briefly for process
      await new Promise(r => setTimeout(r, 2000));
      const logs = await proc.getLogs();
      workerSandboxOk = !!(logs.stdout?.includes('sandbox-worker-ok'));
    } else {
      workerError = 'Sandbox middleware did not set sandbox on context';
    }
  } catch (err) {
    workerError = err instanceof Error ? err.message : String(err);
  }

  // Step 3: Test from DO context — send a prompt that triggers sandbox_exec
  // Use a prompt that explicitly requests code execution
  let doSandboxOk = false;
  let doError: string | undefined;
  let doResult: string | undefined;
  let doToolsUsed: string[] = [];
  try {
    const messages: import('../openrouter/client').ChatMessage[] = [
      { role: 'system', content: 'You have a sandbox_exec tool. Use it to run: echo sandbox-do-ok. Return only the output.' },
      { role: 'user', content: 'Run this shell command using sandbox_exec: echo sandbox-do-ok' },
    ];

    const taskRequest: import('../durable-objects/task-processor').TaskRequest = {
      taskId,
      chatId: 0,
      userId: '999999999',
      modelAlias: 'flash',
      messages,
      telegramToken: 'simulate-no-telegram',
      openrouterKey: env.OPENROUTER_API_KEY || '',
      githubToken: env.GITHUB_TOKEN,
      braveSearchKey: env.BRAVE_SEARCH_KEY,
      tavilyKey: env.TAVILY_API_KEY,
      autoResume: false,
      prompt: '[sandbox-test] echo sandbox-do-ok',
      acontextKey: env.ACONTEXT_API_KEY,
      acontextBaseUrl: env.ACONTEXT_BASE_URL,
    };

    const doName = `sandbox-test-${taskId}`;
    const doId = env.TASK_PROCESSOR!.idFromName(doName);
    const doStub = env.TASK_PROCESSOR!.get(doId);

    await fetchDOWithRetry(doStub, new Request('https://do/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskRequest),
    }));

    // Poll for up to 60s — sandbox cold start + model round-trip can take >30s
    const status = await waitForCompletion(doStub, 60_000);
    doResult = status.result || undefined;
    doToolsUsed = status.toolsUsed || [];
    doSandboxOk = doToolsUsed.includes('sandbox_exec');
    if (status.error) doError = status.error;
    if (status.status === 'processing') doError = 'Timed out after 60s';
  } catch (err) {
    doError = err instanceof Error ? err.message : String(err);
  }

  return c.json({
    ok: workerSandboxOk && doSandboxOk,
    worker: {
      sandboxAvailable: workerSandboxOk,
      error: workerError,
    },
    durableObject: {
      sandboxExecUsed: doSandboxOk,
      toolsUsed: doToolsUsed,
      result: doResult?.slice(0, 500),
      error: doError,
    },
    taskId,
  });
});

/**
 * GET /simulate/nim-tools-check?model=<alias-or-id>[&image=<url>]
 *
 * Validate NVIDIA NIM capabilities server-side using the Worker's
 * NVIDIA_NIM_API_KEY secret (no local env export needed).
 *
 * Default mode (no image): tool-calling check.
 *   - POSTs a synthetic get_weather tools array + "weather in Paris?"
 *   - Returns { toolsFired, toolName, toolArgs, content, httpStatus, error }
 *   - Promote `supportsTools: true` in the catalog when toolsFired === true.
 *
 * Vision mode (?image=<url>): native multimodality check.
 *   - POSTs an OpenAI-style content-block message with text + image_url
 *   - No tools array — isolates vision reasoning from tool-calling.
 *   - Returns { visionResponded, content, httpStatus, error }
 *     visionResponded is true when the model produces non-empty content
 *     that isn't a generic "I can't see images" disclaimer.
 *   - Promote `supportsVision: true` in the catalog when the content
 *     actually describes the image (eyeball check; the heuristic flag
 *     is a best-effort guide, not a guarantee).
 *
 * Usage:
 *   # Tools
 *   curl -s "…/nim-tools-check?model=kiminv" -H "Authorization: Bearer $KEY"
 *
 *   # Vision — pass any public image URL (Wikimedia test images work well)
 *   curl -s "…/nim-tools-check?model=kiminv&image=https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png" \
 *     -H "Authorization: Bearer $KEY"
 */
simulate.get('/nim-tools-check', async (c) => {
  const env = c.env;
  const nimKey = env.NVIDIA_NIM_API_KEY;
  if (!nimKey) {
    return c.json({ error: 'NVIDIA_NIM_API_KEY secret not configured on this Worker' }, 503);
  }

  const input = (c.req.query('model') || '').trim();
  if (!input) {
    return c.json({ error: 'Missing ?model=<alias-or-id> query parameter' }, 400);
  }

  // Resolve alias → raw NIM id. Accept raw ids too (must contain a slash).
  const { getModel } = await import('../openrouter/models');
  let alias: string | undefined;
  let modelId = input;
  const resolved = getModel(input);
  if (resolved) {
    alias = resolved.alias;
    modelId = resolved.id;
    if (resolved.provider !== 'nvidia') {
      return c.json({
        error: `Alias /${alias} is not an NVIDIA NIM model (provider=${resolved.provider ?? 'openrouter'})`,
        alias,
        modelId,
      }, 400);
    }
  }
  if (!modelId.includes('/')) {
    return c.json({
      error: `"${input}" doesn't look like a NIM model id (expected provider/name)`,
    }, 400);
  }

  // Vision mode is opt-in via ?image=<url>. When present, drop the tools
  // array and use an OpenAI-style content-block message so we isolate
  // native multimodality from tool-calling.
  const imageUrl = (c.req.query('image') || '').trim();
  const isVisionMode = imageUrl.length > 0;

  // Synthetic tools payload for the default (tool-check) mode. get_weather
  // is simple and unambiguous — a tool-capable model will call it, a
  // tool-blind one will reply with a disclaimer about real-time data.
  const body: Record<string, unknown> = isVisionMode
    ? {
        model: modelId,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image in one concise sentence.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        max_tokens: 200,
      }
    : {
        model: modelId,
        messages: [{ role: 'user', content: 'What is the current weather in Paris right now?' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather conditions for a city.',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: 'City name' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'auto',
        max_tokens: 200,
      };

  const mode = isVisionMode ? 'vision' : 'tools';

  let httpStatus = 0;
  let rawText = '';
  try {
    const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${nimKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    httpStatus = resp.status;
    rawText = await resp.text();
  } catch (err) {
    return c.json({
      mode, alias, modelId, toolsFired: false, visionResponded: false, httpStatus: 0,
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }, 200);
  }

  // Parse JSON; some error responses come back as HTML or plain text.
  let parsed: {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    error?: { message?: string };
  };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return c.json({
      mode, alias, modelId, toolsFired: false, visionResponded: false, httpStatus,
      error: `non-JSON response from NIM: ${rawText.slice(0, 200)}`,
    }, 200);
  }

  if (parsed.error) {
    return c.json({
      mode, alias, modelId, toolsFired: false, visionResponded: false, httpStatus,
      error: parsed.error.message || 'NIM returned an error',
    }, 200);
  }

  const msg = parsed.choices?.[0]?.message;
  const toolCalls = msg?.tool_calls ?? [];
  const firstCall = toolCalls[0]?.function;
  const content = typeof msg?.content === 'string' ? msg.content : null;

  // Heuristic: vision worked if the model produced non-empty content that
  // doesn't read as a canned "I can't see images" disclaimer. The final
  // promote decision still needs an eyeball check on the content field.
  const looksLikeDisclaimer = content
    ? /\b(can't|cannot|unable to)\s+(see|view|process|analyze)\s+(the\s+)?(image|photo|picture)\b/i.test(content)
      || /\bi\s+don't\s+(have\s+(the\s+)?ability|see)\b/i.test(content)
    : false;

  return c.json({
    mode,
    alias,
    modelId,
    httpStatus,
    toolsFired: toolCalls.length > 0,
    toolName: firstCall?.name,
    toolArgs: firstCall?.arguments,
    visionResponded: isVisionMode && !!content && !looksLikeDisclaimer,
    content: content ? content.slice(0, 400) : null,
  });
});

/**
 * GET /simulate/nim-models-list?filter=<substr>
 *
 * List the NIM catalog from the Worker side using its stored
 * NVIDIA_NIM_API_KEY. Useful for discovering the current id of a
 * model when /simulate/nim-tools-check returned HTTP 410/404 on a
 * stale alias (e.g. `deepseek-ai/deepseek-r1` was retired — the
 * current id might be `deepseek-ai/deepseek-r1-0528` or similar).
 *
 * The optional `filter` substring is matched case-insensitively
 * against each id; omit it to return every id in the catalog.
 *
 * Usage:
 *   curl -s "https://<worker>/simulate/nim-models-list?filter=deepseek" \
 *     -H "Authorization: Bearer $DEBUG_API_KEY" | jq '.ids'
 */
simulate.get('/nim-models-list', async (c) => {
  const env = c.env;
  const nimKey = env.NVIDIA_NIM_API_KEY;
  if (!nimKey) {
    return c.json({ error: 'NVIDIA_NIM_API_KEY secret not configured on this Worker' }, 503);
  }

  const filter = (c.req.query('filter') || '').toLowerCase().trim();

  let resp: Response;
  try {
    resp = await fetch('https://integrate.api.nvidia.com/v1/models', {
      headers: { 'Authorization': `Bearer ${nimKey}` },
    });
  } catch (err) {
    return c.json({
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }, 502);
  }
  const rawText = await resp.text();
  let parsed: { data?: Array<{ id: string }>; error?: { message?: string } };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return c.json({
      error: `non-JSON response from NIM (httpStatus=${resp.status}): ${rawText.slice(0, 200)}`,
      httpStatus: resp.status,
    }, 502);
  }
  if (parsed.error) {
    // Surface upstream errors as 502 Bad Gateway — actual NIM status is
    // kept in the body so callers can diagnose (e.g. 401 auth, 429 rate).
    return c.json({ error: parsed.error.message, httpStatus: resp.status }, 502);
  }

  const allIds = (parsed.data || []).map(m => m.id).sort();
  const ids = filter ? allIds.filter(id => id.toLowerCase().includes(filter)) : allIds;
  return c.json({ total: allIds.length, matched: ids.length, filter: filter || null, ids });
});

export { simulate };
