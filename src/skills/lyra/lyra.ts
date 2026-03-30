/**
 * Lyra (Crex) — Content Creator Skill Handler
 *
 * 4 submodes: write, rewrite, headline, repurpose
 * Uses callSkillLLM() for generation, executeSkillTool() for URL fetching.
 */

import type { SkillRequest, SkillResult, SkillMeta } from '../types';
import { callSkillLLM } from '../llm';
import { selectSkillModel } from '../llm';
import { executeSkillTool, buildSkillToolContext } from '../skill-tools';
import { saveDraft, loadDraft } from '../../storage/lyra';
import { isLyraArtifact, isHeadlineResult, type LyraArtifact, type StoredDraft } from './types';
import {
  LYRA_SYSTEM_PROMPT,
  LYRA_WRITE_PROMPT,
  LYRA_REWRITE_PROMPT,
  LYRA_HEADLINE_PROMPT,
  LYRA_REPURPOSE_PROMPT,
} from './prompts';
import { LYRA_IMAGE_SYSTEM_PROMPT, LYRA_VIDEO_SYSTEM_PROMPT, buildImagePrompt, buildVideoPrompt } from './media-prompts';
import {
  isImageBrief, isVideoBrief,
  PLATFORM_DIMENSIONS, VIDEO_PLATFORM_SPECS,
  type ImageBrief, type VideoBrief,
  type ImagePlatform, type ImageStyle, type VideoPlatform,
} from './media-types';
import { safeJsonParse } from '../validators';
import type { ToolCall } from '../../openrouter/tools';

/** Quality threshold — below this triggers an automatic revision pass. */
const QUALITY_THRESHOLD = 3;

/** Metadata for the Lyra skill. */
export const LYRA_META: SkillMeta = {
  id: 'lyra',
  name: 'Lyra',
  description: 'Content creator — drafts, headlines, rewrites, platform adaptations, and media briefs',
  defaultModel: 'flash',
  subcommands: ['write', 'rewrite', 'headline', 'repurpose', 'image', 'video'],
};

/**
 * Lyra skill handler — routes to the appropriate submode.
 */
export async function handleLyra(request: SkillRequest): Promise<SkillResult> {
  switch (request.subcommand) {
    case 'write':
      return executeWrite(request);
    case 'rewrite':
      return executeRewrite(request);
    case 'headline':
      return executeHeadline(request);
    case 'repurpose':
      return executeRepurpose(request);
    case 'image':
      return executeImage(request);
    case 'video':
      return executeVideo(request);
    default:
      return makeError(request, `Unknown Lyra subcommand: ${request.subcommand}`);
  }
}

// ---------------------------------------------------------------------------
// /write — generate a draft
// ---------------------------------------------------------------------------

async function executeWrite(request: SkillRequest): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, 'Please provide a topic. Usage: /write <topic>');
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, LYRA_META.defaultModel);
  const systemPrompt = request.context?.hotPrompt ?? LYRA_SYSTEM_PROMPT;
  let llmCalls = 0;

  // Build user prompt with flags
  const platform = request.flags.for ?? request.flags.platform;
  const audience = request.flags.audience;
  const tone = request.flags.tone;
  let userPrompt = `Topic: ${request.text}`;
  if (platform) userPrompt += `\nTarget platform: ${platform}`;
  if (audience) userPrompt += `\nTarget audience: ${audience}`;
  if (tone) userPrompt += `\nTone: ${tone}`;

  // First LLM call
  const result = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${LYRA_WRITE_PROMPT}`,
    userPrompt,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });
  llmCalls++;

  let artifact = safeJsonParse<LyraArtifact>(result.text);

  // Fallback: if JSON parsing failed, wrap raw text as artifact
  if (!artifact || !isLyraArtifact(artifact)) {
    artifact = { content: result.text, quality: 3 };
  }

  // Self-review: if quality < threshold, do a revision pass
  if (artifact.quality < QUALITY_THRESHOLD) {
    const revised = await callSkillLLM({
      systemPrompt: `${systemPrompt}\n\n${LYRA_REWRITE_PROMPT}`,
      userPrompt: `Original draft:\n${artifact.content}\n\nInstruction: Improve this draft. The self-assessment was ${artifact.quality}/5: "${artifact.qualityNote ?? 'needs improvement'}". Make it stronger.`,
      modelAlias: model,
      responseFormat: { type: 'json_object' },
      env: request.env,
    });
    llmCalls++;

    const revisedArtifact = safeJsonParse<LyraArtifact>(revised.text);
    if (revisedArtifact && isLyraArtifact(revisedArtifact)) {
      artifact = revisedArtifact;
    }
  }

  // Save draft for /rewrite
  await saveDraftFromArtifact(request, artifact, 'write');

  return {
    skillId: 'lyra',
    kind: 'draft',
    body: artifact.content,
    data: artifact,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls,
      toolCalls: 0,
      tokens: result.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /rewrite — revise the last draft
// ---------------------------------------------------------------------------

async function executeRewrite(request: SkillRequest): Promise<SkillResult> {
  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, LYRA_META.defaultModel);
  const systemPrompt = request.context?.hotPrompt ?? LYRA_SYSTEM_PROMPT;

  // Load last draft from R2
  const lastDraft = await loadDraft(request.env.MOLTBOT_BUCKET, request.userId);
  if (!lastDraft) {
    return makeError(request, 'No previous draft found. Use /write first to create a draft.');
  }

  // Build instruction from flags + text
  const instructions: string[] = [];
  if (request.text.trim()) instructions.push(request.text.trim());
  if (request.flags.shorter) instructions.push('Make it shorter and more concise');
  if (request.flags.longer) instructions.push('Expand with more detail');
  if (request.flags.formal) instructions.push('Use a more formal tone');
  if (request.flags.casual) instructions.push('Use a more casual tone');
  if (request.flags.for) instructions.push(`Adapt for ${request.flags.for}`);
  const instruction = instructions.length > 0
    ? instructions.join('. ')
    : 'Improve the overall quality';

  const result = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${LYRA_REWRITE_PROMPT}`,
    userPrompt: `Previous draft:\n${lastDraft.content}\n\nInstruction: ${instruction}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });

  let artifact = safeJsonParse<LyraArtifact>(result.text);
  if (!artifact || !isLyraArtifact(artifact)) {
    artifact = { content: result.text, quality: 3 };
  }

  // Save updated draft
  await saveDraftFromArtifact(request, artifact, 'rewrite');

  return {
    skillId: 'lyra',
    kind: 'draft',
    body: artifact.content,
    data: artifact,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: result.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /headline — generate 5 headline variants
// ---------------------------------------------------------------------------

async function executeHeadline(request: SkillRequest): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, 'Please provide a topic. Usage: /headline <topic>');
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, LYRA_META.defaultModel);
  const systemPrompt = request.context?.hotPrompt ?? LYRA_SYSTEM_PROMPT;

  const result = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${LYRA_HEADLINE_PROMPT}`,
    userPrompt: `Topic: ${request.text}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });

  const parsed = safeJsonParse(result.text);
  let body: string;

  if (parsed && isHeadlineResult(parsed)) {
    body = parsed.variants
      .map((v, i) => `${i + 1}. ${v.headline}\n   ${v.commentary}`)
      .join('\n\n');
  } else {
    // Fallback: return raw text
    body = result.text;
  }

  return {
    skillId: 'lyra',
    kind: 'headlines',
    body,
    data: parsed,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: result.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /repurpose — fetch URL + adapt for platform
// ---------------------------------------------------------------------------

async function executeRepurpose(request: SkillRequest): Promise<SkillResult> {
  const platform = request.flags.for ?? request.flags.platform;
  if (!platform) {
    return makeError(request, 'Please specify a target platform. Usage: /repurpose <url> --for twitter');
  }
  if (!request.text.trim()) {
    return makeError(request, 'Please provide a URL or content. Usage: /repurpose <url> --for twitter');
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, LYRA_META.defaultModel);
  const systemPrompt = request.context?.hotPrompt ?? LYRA_SYSTEM_PROMPT;
  let toolCalls = 0;

  // Check if the text looks like a URL — if so, fetch it
  let sourceContent = request.text.trim();
  if (looksLikeUrl(sourceContent)) {
    const fetchResult = await executeSkillTool('lyra', {
      id: `lyra-fetch-${Date.now()}`,
      type: 'function',
      function: {
        name: 'fetch_url',
        arguments: JSON.stringify({ url: sourceContent }),
      },
    } as ToolCall, buildSkillToolContext(request.env, request.userId));
    toolCalls++;

    if (!fetchResult.content.startsWith('Error:')) {
      sourceContent = fetchResult.content;
    }
    // If fetch failed, use the URL as-is (the LLM will work with what it has)
  }

  const result = await callSkillLLM({
    systemPrompt: `${systemPrompt}\n\n${LYRA_REPURPOSE_PROMPT}`,
    userPrompt: `Target platform: ${platform}\n\nSource content:\n${sourceContent}`,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });

  let artifact = safeJsonParse<LyraArtifact>(result.text);
  if (!artifact || !isLyraArtifact(artifact)) {
    artifact = { content: result.text, quality: 3, platform };
  }

  // Save draft for /rewrite
  await saveDraftFromArtifact(request, artifact, 'repurpose');

  return {
    skillId: 'lyra',
    kind: 'repurpose',
    body: artifact.content,
    data: artifact,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls,
      tokens: result.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /image — generate an image brief
// ---------------------------------------------------------------------------

async function executeImage(request: SkillRequest): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, 'Please describe the image. Usage: /image <description> [--for <platform>] [--style <style>]');
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, LYRA_META.defaultModel);
  const systemPrompt = request.context?.hotPrompt ?? LYRA_IMAGE_SYSTEM_PROMPT;

  const platformStr = request.flags.for ?? request.flags.platform;
  const styleStr = request.flags.style;

  // Validate platform if provided
  const platform = platformStr && platformStr in PLATFORM_DIMENSIONS
    ? platformStr as ImagePlatform
    : undefined;
  const style = styleStr as ImageStyle | undefined;

  const userPrompt = buildImagePrompt(request.text, platform, style);

  const result = await callSkillLLM({
    systemPrompt,
    userPrompt,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });

  const parsed = safeJsonParse<Record<string, unknown>>(result.text);

  if (!parsed || typeof parsed !== 'object') {
    return makeTextFallback('lyra', result, start, model);
  }

  // Normalize platform and inject canonical dimensions
  const resolvedPlatform = (platform ?? parsed.platform) as ImagePlatform | undefined;
  if (typeof resolvedPlatform === 'string' && resolvedPlatform in PLATFORM_DIMENSIONS) {
    parsed.platform = resolvedPlatform;
    parsed.dimensions = PLATFORM_DIMENSIONS[resolvedPlatform];
  } else if (typeof parsed.platform !== 'string') {
    // Default platform when LLM omits it entirely
    parsed.platform = 'instagram-post';
    parsed.dimensions = PLATFORM_DIMENSIONS['instagram-post'];
  }

  // Ensure string defaults for optional fields the LLM may omit
  if (typeof parsed.negativePrompt !== 'string') parsed.negativePrompt = '';
  if (typeof parsed.referenceNotes !== 'string') parsed.referenceNotes = '';

  if (!isImageBrief(parsed)) {
    return makeTextFallback('lyra', result, start, model);
  }

  const brief = parsed;

  return {
    skillId: 'lyra',
    kind: 'image_brief',
    body: brief.title,
    data: brief,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: result.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// /video — generate a video brief
// ---------------------------------------------------------------------------

async function executeVideo(request: SkillRequest): Promise<SkillResult> {
  if (!request.text.trim()) {
    return makeError(request, 'Please describe the video. Usage: /video <description> [--for <platform>] [--duration <seconds>]');
  }

  const start = Date.now();
  const model = selectSkillModel(request.modelAlias, LYRA_META.defaultModel);
  const systemPrompt = request.context?.hotPrompt ?? LYRA_VIDEO_SYSTEM_PROMPT;

  const platformStr = request.flags.for ?? request.flags.platform;
  const durationStr = request.flags.duration;

  // Validate platform if provided
  const platform = platformStr && platformStr in VIDEO_PLATFORM_SPECS
    ? platformStr as VideoPlatform
    : undefined;
  const duration = durationStr ? parseInt(durationStr, 10) : undefined;

  const userPrompt = buildVideoPrompt(request.text, platform, duration && !isNaN(duration) ? duration : undefined);

  const result = await callSkillLLM({
    systemPrompt,
    userPrompt,
    modelAlias: model,
    responseFormat: { type: 'json_object' },
    env: request.env,
  });

  const parsed = safeJsonParse<Record<string, unknown>>(result.text);

  if (!parsed || typeof parsed !== 'object') {
    return makeTextFallback('lyra', result, start, model);
  }

  // Normalize platform and inject canonical specs
  const resolvedPlatform = (platform ?? parsed.platform) as VideoPlatform | undefined;
  if (typeof resolvedPlatform === 'string' && resolvedPlatform in VIDEO_PLATFORM_SPECS) {
    parsed.platform = resolvedPlatform;
    parsed.specs = VIDEO_PLATFORM_SPECS[resolvedPlatform];
  } else if (typeof parsed.platform !== 'string') {
    // Default platform when LLM omits it entirely
    parsed.platform = 'instagram-reel';
    parsed.specs = VIDEO_PLATFORM_SPECS['instagram-reel'];
  }

  // Normalize script structure
  if (typeof parsed.script === 'object' && parsed.script !== null) {
    const script = parsed.script as Record<string, unknown>;
    if (!Array.isArray(script.scenes)) script.scenes = [];
    if (typeof script.totalDuration !== 'number') script.totalDuration = 0;

    // Normalize each scene — ensure shots is always an array
    for (const scene of script.scenes as Record<string, unknown>[]) {
      if (typeof scene === 'object' && scene !== null && !Array.isArray(scene)) {
        if (!Array.isArray(scene.shots)) scene.shots = [];
      }
    }
  }

  if (!isVideoBrief(parsed)) {
    return makeTextFallback('lyra', result, start, model);
  }

  const brief = parsed;

  return {
    skillId: 'lyra',
    kind: 'video_brief',
    body: brief.title,
    data: brief,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: result.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fallback when LLM returns text that isn't a valid brief. */
function makeTextFallback(
  skillId: 'lyra',
  result: { text: string; tokens?: { prompt: number; completion: number } },
  start: number,
  model: string,
): SkillResult {
  return {
    skillId,
    kind: 'text',
    body: result.text,
    telemetry: {
      durationMs: Date.now() - start,
      model,
      llmCalls: 1,
      toolCalls: 0,
      tokens: result.tokens,
    },
  };
}

function makeError(request: SkillRequest, message: string): SkillResult {
  return {
    skillId: 'lyra',
    kind: 'error',
    body: message,
    telemetry: {
      durationMs: 0,
      model: request.modelAlias ?? LYRA_META.defaultModel,
      llmCalls: 0,
      toolCalls: 0,
    },
  };
}

async function saveDraftFromArtifact(
  request: SkillRequest,
  artifact: LyraArtifact,
  command: string,
): Promise<void> {
  try {
    const draft: StoredDraft = {
      content: artifact.content,
      quality: artifact.quality,
      platform: artifact.platform,
      tone: artifact.tone,
      createdAt: new Date().toISOString(),
      command,
    };
    await saveDraft(request.env.MOLTBOT_BUCKET, request.userId, draft);
  } catch (err) {
    console.error('[Lyra] Failed to save draft:', err instanceof Error ? err.message : err);
  }
}

function looksLikeUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
