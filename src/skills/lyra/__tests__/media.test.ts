/**
 * Tests for Lyra media briefs — image and video
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLyra } from '../lyra';
import type { SkillRequest } from '../../types';
import type { MoltbotEnv } from '../../../types';
import {
  isImageBrief,
  isVideoBrief,
  PLATFORM_DIMENSIONS,
  VIDEO_PLATFORM_SPECS,
  type ImageBrief,
  type ImagePlatform,
  type VideoBrief,
  type VideoPlatform,
} from '../media-types';
import { buildImagePrompt, buildVideoPrompt } from '../media-prompts';
import { lookupCommand } from '../../command-map';
import { renderForTelegram } from '../../renderers/telegram';
import { renderForWeb } from '../../renderers/web';

// Mock the LLM helper
vi.mock('../../llm', () => ({
  callSkillLLM: vi.fn(),
  selectSkillModel: vi.fn((_req: unknown, def: string) => def),
}));

// Mock storage
vi.mock('../../../storage/lyra', () => ({
  saveDraft: vi.fn(),
  loadDraft: vi.fn(),
}));

// Mock skill-tools
vi.mock('../../skill-tools', () => ({
  executeSkillTool: vi.fn(),
  buildSkillToolContext: vi.fn(() => ({})),
}));

import { callSkillLLM } from '../../llm';

const mockCallLLM = vi.mocked(callSkillLLM);

function makeRequest(overrides?: Partial<SkillRequest>): SkillRequest {
  return {
    skillId: 'lyra',
    subcommand: 'image',
    text: 'a sunset over Corsica',
    flags: {},
    transport: 'telegram',
    userId: '123',
    env: {
      MOLTBOT_BUCKET: {} as R2Bucket,
      OPENROUTER_API_KEY: 'test-key',
    } as unknown as MoltbotEnv,
    ...overrides,
  };
}

const MOCK_IMAGE_BRIEF: ImageBrief = {
  title: 'Corsican Sunset',
  description: 'A golden sunset over the Mediterranean',
  style: 'photorealistic',
  platform: 'instagram-post',
  dimensions: { width: 1080, height: 1080, aspectRatio: '1:1' },
  prompt: 'golden sunset, Mediterranean sea, Corsica, photorealistic, warm tones',
  negativePrompt: 'blurry, watermark, low quality',
  referenceNotes: 'Warm golden hour lighting',
  tags: ['sunset', 'corsica', 'mediterranean'],
};

const MOCK_VIDEO_BRIEF: VideoBrief = {
  title: 'Product Launch Teaser',
  concept: 'A fast-paced teaser for a new product launch',
  platform: 'instagram-reel',
  specs: { width: 1080, height: 1920, fps: 30, maxDuration: 90 },
  script: {
    scenes: [
      {
        sceneNumber: 1,
        title: 'Opening Hook',
        description: 'Quick flash of the product',
        duration: 5,
        shots: [
          { shotType: 'close-up', description: 'Product detail', duration: 3 },
          { shotType: 'wide', description: 'Brand logo reveal', duration: 2 },
        ],
      },
    ],
    totalDuration: 5,
  },
  musicDirection: 'Upbeat electronic, 120bpm',
  tags: ['product', 'launch', 'teaser'],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('isImageBrief', () => {
  it('returns true for valid ImageBrief', () => {
    expect(isImageBrief(MOCK_IMAGE_BRIEF)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isImageBrief(null)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isImageBrief('not an object')).toBe(false);
  });

  it('returns false for missing required fields', () => {
    expect(isImageBrief({ title: 'x' })).toBe(false);
  });

  it('returns false for array', () => {
    expect(isImageBrief([1, 2, 3])).toBe(false);
  });

  it('returns false when dimensions are missing', () => {
    const { dimensions: _, ...noDims } = MOCK_IMAGE_BRIEF;
    expect(isImageBrief(noDims)).toBe(false);
  });

  it('returns false when negativePrompt is missing', () => {
    const { negativePrompt: _, ...noNeg } = MOCK_IMAGE_BRIEF;
    expect(isImageBrief(noNeg)).toBe(false);
  });

  it('returns false when dimensions.width is not a number', () => {
    const bad = { ...MOCK_IMAGE_BRIEF, dimensions: { width: 'big', height: 1080, aspectRatio: '1:1' } };
    expect(isImageBrief(bad)).toBe(false);
  });
});

describe('isVideoBrief', () => {
  it('returns true for valid VideoBrief', () => {
    expect(isVideoBrief(MOCK_VIDEO_BRIEF)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isVideoBrief(null)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isVideoBrief('not an object')).toBe(false);
  });

  it('returns false for missing script', () => {
    expect(isVideoBrief({ title: 'x', concept: 'y', musicDirection: 'z', tags: [] })).toBe(false);
  });

  it('returns false when specs are missing', () => {
    const { specs: _, ...noSpecs } = MOCK_VIDEO_BRIEF;
    expect(isVideoBrief(noSpecs)).toBe(false);
  });

  it('returns false when script.totalDuration is missing', () => {
    const bad = { ...MOCK_VIDEO_BRIEF, script: { scenes: [] } };
    expect(isVideoBrief(bad)).toBe(false);
  });

  it('returns false when specs.fps is not a number', () => {
    const bad = { ...MOCK_VIDEO_BRIEF, specs: { ...MOCK_VIDEO_BRIEF.specs, fps: 'fast' } };
    expect(isVideoBrief(bad)).toBe(false);
  });

  it('returns false when scenes contain empty objects', () => {
    const bad = {
      ...MOCK_VIDEO_BRIEF,
      script: { scenes: [{}], totalDuration: 15 },
    };
    expect(isVideoBrief(bad)).toBe(false);
  });

  it('returns false when a scene is missing shots array', () => {
    const bad = {
      ...MOCK_VIDEO_BRIEF,
      script: {
        scenes: [{ sceneNumber: 1, title: 'x', description: 'y', duration: 5 }],
        totalDuration: 5,
      },
    };
    expect(isVideoBrief(bad)).toBe(false);
  });

  it('returns false when a shot is missing shotType', () => {
    const bad = {
      ...MOCK_VIDEO_BRIEF,
      script: {
        scenes: [{
          sceneNumber: 1, title: 'x', description: 'y', duration: 5,
          shots: [{ description: 'detail', duration: 5 }],
        }],
        totalDuration: 5,
      },
    };
    expect(isVideoBrief(bad)).toBe(false);
  });

  it('accepts valid scenes with valid shots', () => {
    expect(isVideoBrief(MOCK_VIDEO_BRIEF)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Platform dimension maps completeness
// ---------------------------------------------------------------------------

describe('PLATFORM_DIMENSIONS', () => {
  const allImagePlatforms: ImagePlatform[] = [
    'instagram-post', 'instagram-story', 'twitter', 'facebook', 'linkedin',
    'youtube-thumbnail', 'tiktok', 'pinterest', 'website-hero', 'blog-header',
    'email-header', 'presentation', 'mobile-app', 'print',
  ];

  it('has entries for all 14 image platforms', () => {
    expect(Object.keys(PLATFORM_DIMENSIONS)).toHaveLength(14);
  });

  it.each(allImagePlatforms)('has dimensions for %s', (platform) => {
    const dims = PLATFORM_DIMENSIONS[platform];
    expect(dims).toBeDefined();
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
    expect(dims.aspectRatio).toBeTruthy();
  });
});

describe('VIDEO_PLATFORM_SPECS', () => {
  const allVideoPlatforms: VideoPlatform[] = [
    'instagram-reel', 'tiktok', 'youtube-short', 'youtube-video',
    'twitter-video', 'facebook-video', 'linkedin-video', 'website-video',
  ];

  it('has entries for all 8 video platforms', () => {
    expect(Object.keys(VIDEO_PLATFORM_SPECS)).toHaveLength(8);
  });

  it.each(allVideoPlatforms)('has specs for %s', (platform) => {
    const spec = VIDEO_PLATFORM_SPECS[platform];
    expect(spec).toBeDefined();
    expect(spec.width).toBeGreaterThan(0);
    expect(spec.height).toBeGreaterThan(0);
    expect(spec.fps).toBeGreaterThan(0);
    expect(spec.maxDuration).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Command map routing
// ---------------------------------------------------------------------------

describe('command map routing', () => {
  it('/image routes to lyra:image', () => {
    const m = lookupCommand('/image');
    expect(m).toEqual({ skillId: 'lyra', defaultSubcommand: 'image' });
  });

  it('/imagine routes to lyra:image', () => {
    const m = lookupCommand('/imagine');
    expect(m).toEqual({ skillId: 'lyra', defaultSubcommand: 'image' });
  });

  it('/video routes to lyra:video', () => {
    const m = lookupCommand('/video');
    expect(m).toEqual({ skillId: 'lyra', defaultSubcommand: 'video' });
  });

  it('/storyboard routes to lyra:video', () => {
    const m = lookupCommand('/storyboard');
    expect(m).toEqual({ skillId: 'lyra', defaultSubcommand: 'video' });
  });
});

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

describe('buildImagePrompt', () => {
  it('includes user input', () => {
    const p = buildImagePrompt('sunset in Corsica');
    expect(p).toContain('sunset in Corsica');
  });

  it('includes platform dimensions when specified', () => {
    const p = buildImagePrompt('sunset', 'instagram-post');
    expect(p).toContain('instagram-post');
    expect(p).toContain('1080x1080');
  });

  it('includes style when specified', () => {
    const p = buildImagePrompt('sunset', undefined, 'watercolor');
    expect(p).toContain('watercolor');
  });
});

describe('buildVideoPrompt', () => {
  it('includes user input', () => {
    const p = buildVideoPrompt('product launch teaser');
    expect(p).toContain('product launch teaser');
  });

  it('includes platform specs when specified', () => {
    const p = buildVideoPrompt('teaser', 'instagram-reel');
    expect(p).toContain('instagram-reel');
    expect(p).toContain('1080x1920');
  });

  it('includes duration when specified', () => {
    const p = buildVideoPrompt('teaser', undefined, 15);
    expect(p).toContain('15 seconds');
  });
});

// ---------------------------------------------------------------------------
// Handler integration — /image
// ---------------------------------------------------------------------------

describe('/image handler', () => {
  it('returns image_brief for valid LLM response', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_IMAGE_BRIEF),
      tokens: { prompt: 100, completion: 200 },
    });

    const result = await handleLyra(makeRequest());
    expect(result.kind).toBe('image_brief');
    expect(result.body).toBe('Corsican Sunset');
    expect(result.data).toBeDefined();
    expect(isImageBrief(result.data)).toBe(true);
  });

  it('returns error when text is empty', async () => {
    const result = await handleLyra(makeRequest({ text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please describe the image');
  });

  it('passes --for flag as platform to prompt builder', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_IMAGE_BRIEF),
    });

    await handleLyra(makeRequest({ flags: { for: 'instagram-post' } }));
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('instagram-post'),
      }),
    );
  });

  it('falls back to text kind for non-JSON LLM response', async () => {
    mockCallLLM.mockResolvedValue({ text: 'Just some text' });

    const result = await handleLyra(makeRequest());
    expect(result.kind).toBe('text');
    expect(result.body).toBe('Just some text');
  });

  it('injects canonical platform dimensions', async () => {
    const briefWithoutDims = { ...MOCK_IMAGE_BRIEF, dimensions: { width: 1, height: 1, aspectRatio: '1:1' } };
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(briefWithoutDims),
    });

    const result = await handleLyra(makeRequest({ flags: { for: 'twitter' } }));
    const data = result.data as ImageBrief;
    expect(data.dimensions.width).toBe(1200);
    expect(data.dimensions.height).toBe(675);
  });
});

// ---------------------------------------------------------------------------
// Handler integration — /video
// ---------------------------------------------------------------------------

describe('/video handler', () => {
  it('returns video_brief for valid LLM response', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_VIDEO_BRIEF),
      tokens: { prompt: 100, completion: 300 },
    });

    const result = await handleLyra(makeRequest({ subcommand: 'video', text: 'product launch teaser' }));
    expect(result.kind).toBe('video_brief');
    expect(result.body).toBe('Product Launch Teaser');
    expect(isVideoBrief(result.data)).toBe(true);
  });

  it('returns error when text is empty', async () => {
    const result = await handleLyra(makeRequest({ subcommand: 'video', text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please describe the video');
  });

  it('passes --duration flag to prompt builder', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify(MOCK_VIDEO_BRIEF),
    });

    await handleLyra(makeRequest({ subcommand: 'video', text: 'teaser', flags: { duration: '15' } }));
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('15 seconds'),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

describe('Telegram renderer', () => {
  it('renders image_brief without throwing', () => {
    const chunks = renderForTelegram({
      skillId: 'lyra',
      kind: 'image_brief',
      body: MOCK_IMAGE_BRIEF.title,
      data: MOCK_IMAGE_BRIEF,
      telemetry: { durationMs: 1000, model: 'flash', llmCalls: 1, toolCalls: 0 },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].parseMode).toBe('HTML');
    expect(chunks[0].text).toContain('Corsican Sunset');
    expect(chunks[0].text).toContain('photorealistic');
  });

  it('renders video_brief without throwing', () => {
    const chunks = renderForTelegram({
      skillId: 'lyra',
      kind: 'video_brief',
      body: MOCK_VIDEO_BRIEF.title,
      data: MOCK_VIDEO_BRIEF,
      telemetry: { durationMs: 2000, model: 'flash', llmCalls: 1, toolCalls: 0 },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].parseMode).toBe('HTML');
    expect(chunks[0].text).toContain('Product Launch Teaser');
    expect(chunks[0].text).toContain('Opening Hook');
  });

  it('falls back to plain text if data is not a valid brief', () => {
    const chunks = renderForTelegram({
      skillId: 'lyra',
      kind: 'image_brief',
      body: 'fallback text',
      data: null,
      telemetry: { durationMs: 500, model: 'flash', llmCalls: 1, toolCalls: 0 },
    });
    expect(chunks[0].text).toBe('fallback text');
  });
});

describe('Web renderer', () => {
  it('renders image_brief as JSON envelope', () => {
    const response = renderForWeb({
      skillId: 'lyra',
      kind: 'image_brief',
      body: MOCK_IMAGE_BRIEF.title,
      data: MOCK_IMAGE_BRIEF,
      telemetry: { durationMs: 1000, model: 'flash', llmCalls: 1, toolCalls: 0 },
    });
    expect(response.ok).toBe(true);
    expect(response.kind).toBe('image_brief');
    expect(response.data).toEqual(MOCK_IMAGE_BRIEF);
  });

  it('renders video_brief as JSON envelope', () => {
    const response = renderForWeb({
      skillId: 'lyra',
      kind: 'video_brief',
      body: MOCK_VIDEO_BRIEF.title,
      data: MOCK_VIDEO_BRIEF,
      telemetry: { durationMs: 2000, model: 'flash', llmCalls: 1, toolCalls: 0 },
    });
    expect(response.ok).toBe(true);
    expect(response.kind).toBe('video_brief');
    expect(response.data).toEqual(MOCK_VIDEO_BRIEF);
  });
});
