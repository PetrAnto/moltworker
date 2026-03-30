/**
 * Integration tests — Lyra media briefs through the skill runtime.
 *
 * Verifies that /image and /video commands produce correct SkillResult shapes
 * when routed through parseCommandMessage → runSkill → handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLyra } from '../../skills/lyra/lyra';
import { parseCommandMessage } from '../../skills/command-map';
import { renderForTelegram } from '../../skills/renderers/telegram';
import { renderForWeb } from '../../skills/renderers/web';
import { isImageBrief, isVideoBrief, type ImageBrief, type VideoBrief } from '../../skills/lyra/media-types';
import type { SkillRequest } from '../../skills/types';
import type { MoltbotEnv } from '../../types';

// Mock the LLM helper
vi.mock('../../skills/llm', () => ({
  callSkillLLM: vi.fn(),
  selectSkillModel: vi.fn((_req: unknown, def: string) => def),
}));

// Mock storage
vi.mock('../../storage/lyra', () => ({
  saveDraft: vi.fn(),
  loadDraft: vi.fn(),
}));

// Mock skill-tools
vi.mock('../../skills/skill-tools', () => ({
  executeSkillTool: vi.fn(),
  buildSkillToolContext: vi.fn(() => ({})),
}));

import { callSkillLLM } from '../../skills/llm';

const mockCallLLM = vi.mocked(callSkillLLM);

const MOCK_IMAGE_RESPONSE: ImageBrief = {
  title: 'Corsican Sunset',
  description: 'A golden sunset over the cliffs of Bonifacio',
  style: 'photorealistic',
  platform: 'instagram-post',
  dimensions: { width: 1080, height: 1080, aspectRatio: '1:1' },
  prompt: 'golden sunset, Corsica, Mediterranean, photorealistic, warm tones',
  negativePrompt: 'blurry, watermark, low quality',
  referenceNotes: 'Landscape photography reference',
  tags: ['sunset', 'corsica'],
};

const MOCK_VIDEO_RESPONSE: VideoBrief = {
  title: 'Product Launch Teaser',
  concept: 'Quick product reveal',
  platform: 'instagram-reel',
  specs: { width: 1080, height: 1920, fps: 30, maxDuration: 90 },
  script: {
    scenes: [
      {
        sceneNumber: 1,
        title: 'Opening',
        description: 'Product reveal',
        duration: 15,
        shots: [
          { shotType: 'close-up', description: 'Product detail', duration: 8 },
          { shotType: 'wide', description: 'Full product', duration: 7 },
        ],
      },
    ],
    totalDuration: 15,
  },
  musicDirection: 'Upbeat electronic, 120bpm',
  tags: ['product', 'launch'],
};

const mockEnv = {
  MOLTBOT_BUCKET: {} as R2Bucket,
  OPENROUTER_API_KEY: 'test-key',
} as unknown as MoltbotEnv;

function buildRequest(parsed: NonNullable<ReturnType<typeof parseCommandMessage>>): SkillRequest {
  return {
    skillId: parsed.mapping.skillId,
    subcommand: parsed.subcommand,
    text: parsed.text,
    flags: parsed.flags,
    transport: 'simulate',
    userId: '999999999',
    env: mockEnv,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// /image end-to-end
// ---------------------------------------------------------------------------

describe('/image end-to-end', () => {
  it('parses command and produces image_brief SkillResult', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_IMAGE_RESPONSE),
      tokens: { prompt: 200, completion: 400 },
    });

    const parsed = parseCommandMessage('/image --for instagram-post create a sunset in Corsica');
    expect(parsed).not.toBeNull();
    expect(parsed!.subcommand).toBe('image');
    expect(parsed!.flags.for).toBe('instagram-post');

    const result = await handleLyra(buildRequest(parsed!));
    expect(result.kind).toBe('image_brief');
    expect(result.skillId).toBe('lyra');
    expect(isImageBrief(result.data)).toBe(true);

    const data = result.data as ImageBrief;
    expect(data.title).toBe('Corsican Sunset');
    expect(data.dimensions.width).toBe(1080);
  });

  it('/imagine alias routes to image subcommand', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_IMAGE_RESPONSE),
    });

    const parsed = parseCommandMessage('/imagine a futuristic city');
    expect(parsed).not.toBeNull();
    expect(parsed!.subcommand).toBe('image');

    const result = await handleLyra(buildRequest(parsed!));
    expect(result.kind).toBe('image_brief');
  });

  it('passes --style flag through to LLM prompt', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_IMAGE_RESPONSE),
    });

    const parsed = parseCommandMessage('/image --style watercolor a dreamy landscape');
    expect(parsed).not.toBeNull();

    await handleLyra(buildRequest(parsed!));
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('watercolor'),
      }),
    );
  });

  it('renders through Telegram renderer without error', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_IMAGE_RESPONSE),
      tokens: { prompt: 200, completion: 400 },
    });

    const parsed = parseCommandMessage('/image sunset');
    const result = await handleLyra(buildRequest(parsed!));
    const chunks = renderForTelegram(result);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].parseMode).toBe('HTML');
    expect(chunks[0].text).toContain('Corsican Sunset');
  });

  it('renders through web renderer with correct shape', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_IMAGE_RESPONSE),
      tokens: { prompt: 200, completion: 400 },
    });

    const parsed = parseCommandMessage('/image sunset');
    const result = await handleLyra(buildRequest(parsed!));
    const response = renderForWeb(result);

    expect(response.ok).toBe(true);
    expect(response.kind).toBe('image_brief');
    expect(response.skillId).toBe('lyra');
    expect(response.data).toBeDefined();
    expect((response.data as ImageBrief).title).toBe('Corsican Sunset');
  });
});

// ---------------------------------------------------------------------------
// /video end-to-end
// ---------------------------------------------------------------------------

describe('/video end-to-end', () => {
  it('parses command and produces video_brief SkillResult', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_VIDEO_RESPONSE),
      tokens: { prompt: 200, completion: 500 },
    });

    const parsed = parseCommandMessage('/video --for instagram-reel --duration 15 product launch teaser');
    expect(parsed).not.toBeNull();
    expect(parsed!.subcommand).toBe('video');
    expect(parsed!.flags.for).toBe('instagram-reel');
    expect(parsed!.flags.duration).toBe('15');

    const result = await handleLyra(buildRequest(parsed!));
    expect(result.kind).toBe('video_brief');
    expect(result.skillId).toBe('lyra');
    expect(isVideoBrief(result.data)).toBe(true);

    const data = result.data as VideoBrief;
    expect(data.title).toBe('Product Launch Teaser');
    expect(data.script.totalDuration).toBe(15);
    expect(data.script.scenes.length).toBeGreaterThan(0);
  });

  it('/storyboard alias routes to video subcommand', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_VIDEO_RESPONSE),
    });

    const parsed = parseCommandMessage('/storyboard a product reveal');
    expect(parsed).not.toBeNull();
    expect(parsed!.subcommand).toBe('video');

    const result = await handleLyra(buildRequest(parsed!));
    expect(result.kind).toBe('video_brief');
  });

  it('renders through Telegram renderer with scene breakdown', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_VIDEO_RESPONSE),
      tokens: { prompt: 200, completion: 500 },
    });

    const parsed = parseCommandMessage('/video product launch');
    const result = await handleLyra(buildRequest(parsed!));
    const chunks = renderForTelegram(result);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].parseMode).toBe('HTML');
    expect(chunks[0].text).toContain('Product Launch Teaser');
    expect(chunks[0].text).toContain('Opening');
    expect(chunks[0].text).toContain('close-up');
  });

  it('renders through web renderer with correct shape', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_VIDEO_RESPONSE),
      tokens: { prompt: 200, completion: 500 },
    });

    const parsed = parseCommandMessage('/video product launch');
    const result = await handleLyra(buildRequest(parsed!));
    const response = renderForWeb(result);

    expect(response.ok).toBe(true);
    expect(response.kind).toBe('video_brief');
    expect(response.data).toBeDefined();
    expect((response.data as VideoBrief).script.scenes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('Error handling', () => {
  it('/image with empty text returns error', async () => {
    const parsed = parseCommandMessage('/image');
    expect(parsed).not.toBeNull();

    const result = await handleLyra(buildRequest(parsed!));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please describe the image');
  });

  it('/video with empty text returns error', async () => {
    const parsed = parseCommandMessage('/video');
    expect(parsed).not.toBeNull();

    const result = await handleLyra(buildRequest(parsed!));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please describe the video');
  });

  it('non-JSON LLM response falls back to text kind', async () => {
    mockCallLLM.mockResolvedValue({
      text: 'Sorry, I could not generate a structured brief.',
    });

    const parsed = parseCommandMessage('/image sunset');
    const result = await handleLyra(buildRequest(parsed!));
    expect(result.kind).toBe('text');
    expect(result.body).toContain('could not generate');
  });

  it('web renderer returns ok: false for error results', async () => {
    const parsed = parseCommandMessage('/image');
    const result = await handleLyra(buildRequest(parsed!));
    const response = renderForWeb(result);
    expect(response.ok).toBe(false);
    expect(response.kind).toBe('error');
  });
});
