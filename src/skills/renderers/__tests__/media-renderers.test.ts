/**
 * Integration tests for Lyra media brief renderers.
 *
 * Verifies Telegram HTML output structure and web JSON envelope shape
 * for image_brief and video_brief result kinds.
 */

import { describe, it, expect } from 'vitest';
import { renderForTelegram, splitHtmlMessage, type TelegramChunk } from '../telegram';
import { renderForWeb, type SkillApiResponse } from '../web';
import type { SkillResult, SkillTelemetry } from '../../types';
import type { ImageBrief, VideoBrief } from '../../lyra/media-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseTelemetry: SkillTelemetry = {
  durationMs: 1500,
  model: 'flash',
  llmCalls: 1,
  toolCalls: 0,
  tokens: { prompt: 200, completion: 400 },
};

const sampleImageBrief: ImageBrief = {
  title: 'Corsican Sunset',
  description: 'A breathtaking golden hour sunset over the turquoise Mediterranean, viewed from the cliffs of Bonifacio',
  style: 'photorealistic',
  platform: 'instagram-post',
  dimensions: { width: 1080, height: 1080, aspectRatio: '1:1' },
  prompt: 'golden sunset, Mediterranean sea, Corsica cliffs, Bonifacio, photorealistic, warm orange tones, dramatic clouds, golden hour',
  negativePrompt: 'blurry, watermark, text, low quality, cartoon, oversaturated',
  referenceNotes: 'Reference: National Geographic landscape photography, warm golden hour palette',
  tags: ['sunset', 'corsica', 'mediterranean', 'landscape', 'golden-hour'],
};

const sampleVideoBrief: VideoBrief = {
  title: 'StoriaDigital Product Launch',
  concept: 'A fast-paced teaser revealing the new AI assistant platform with quick cuts and dynamic text overlays',
  platform: 'instagram-reel',
  specs: { width: 1080, height: 1920, fps: 30, maxDuration: 90 },
  script: {
    scenes: [
      {
        sceneNumber: 1,
        title: 'Hook',
        description: 'Quick flash of a glowing AI interface',
        duration: 3,
        shots: [
          { shotType: 'close-up', description: 'Glowing neural network graphic', duration: 1.5 },
          { shotType: 'wide', description: 'Full interface reveal on dark background', duration: 1.5, cameraMovement: 'dolly' },
        ],
        textOverlay: 'The future is here.',
      },
      {
        sceneNumber: 2,
        title: 'Feature Showcase',
        description: 'Split-screen showing multiple AI capabilities',
        duration: 7,
        shots: [
          { shotType: 'medium', description: 'Chat interface in action', duration: 3, cameraMovement: 'static' },
          { shotType: 'detail', description: 'Code completion close-up', duration: 2 },
          { shotType: 'wide', description: 'Dashboard overview', duration: 2, cameraMovement: 'pan' },
        ],
        voiceover: 'One platform. Every AI capability you need.',
      },
      {
        sceneNumber: 3,
        title: 'CTA',
        description: 'Brand logo and call-to-action',
        duration: 5,
        shots: [
          { shotType: 'wide', description: 'Logo animation on brand colors', duration: 5, cameraMovement: 'static' },
        ],
        textOverlay: 'Try it free at storia.digital',
      },
    ],
    totalDuration: 15,
  },
  musicDirection: 'Electronic, upbeat, 128bpm, builds to crescendo at scene 3. Reference: Tycho, ODESZA',
  tags: ['product-launch', 'ai', 'saas', 'teaser'],
};

function makeResult(kind: 'image_brief' | 'video_brief', data: unknown): SkillResult {
  return {
    skillId: 'lyra',
    kind,
    body: kind === 'image_brief' ? (data as ImageBrief).title : (data as VideoBrief).title,
    data,
    telemetry: baseTelemetry,
  };
}

// ---------------------------------------------------------------------------
// Telegram renderer — image_brief
// ---------------------------------------------------------------------------

describe('Telegram renderer — image_brief', () => {
  const result = makeResult('image_brief', sampleImageBrief);
  let chunks: TelegramChunk[];

  it('renders without throwing', () => {
    chunks = renderForTelegram(result);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('uses HTML parse mode', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].parseMode).toBe('HTML');
  });

  it('includes the brief title', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('Corsican Sunset');
  });

  it('includes the style', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('photorealistic');
  });

  it('includes platform and dimensions', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('instagram-post');
    expect(chunks[0].text).toContain('1080x1080');
  });

  it('includes the generation prompt in <code> block', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('<code>');
    expect(chunks[0].text).toContain('golden sunset');
  });

  it('includes negative prompt', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('blurry');
  });

  it('includes reference notes', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('National Geographic');
  });

  it('includes tags as hashtags', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('#sunset');
    expect(chunks[0].text).toContain('#corsica');
  });

  it('includes telemetry line', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('flash');
    expect(chunks[0].text).toContain('1.5s');
  });

  it('produces valid HTML (no unescaped <> in content)', () => {
    const briefWithAngles: ImageBrief = {
      ...sampleImageBrief,
      description: 'A <bold> image with "quotes" & ampersands',
    };
    const res = makeResult('image_brief', briefWithAngles);
    const c = renderForTelegram(res);
    // Check that literal < in user content is escaped
    expect(c[0].text).toContain('&lt;bold&gt;');
    expect(c[0].text).toContain('&amp;');
  });

  it('falls back to body text when data is null', () => {
    const res: SkillResult = { ...result, data: null };
    const c = renderForTelegram(res);
    expect(c[0].text).toBe(result.body);
  });
});

// ---------------------------------------------------------------------------
// Telegram renderer — video_brief
// ---------------------------------------------------------------------------

describe('Telegram renderer — video_brief', () => {
  const result = makeResult('video_brief', sampleVideoBrief);
  let chunks: TelegramChunk[];

  it('renders without throwing', () => {
    chunks = renderForTelegram(result);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('uses HTML parse mode', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].parseMode).toBe('HTML');
  });

  it('includes the video title', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('StoriaDigital Product Launch');
  });

  it('includes the concept', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('fast-paced teaser');
  });

  it('includes platform and specs', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('instagram-reel');
    expect(chunks[0].text).toContain('1080x1920');
    expect(chunks[0].text).toContain('30fps');
  });

  it('includes total duration', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('15s');
  });

  it('includes all scene titles', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('Hook');
    expect(chunks[0].text).toContain('Feature Showcase');
    expect(chunks[0].text).toContain('CTA');
  });

  it('includes shot descriptions', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('close-up');
    expect(chunks[0].text).toContain('Glowing neural network');
  });

  it('includes voiceover text', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('One platform');
  });

  it('includes music direction', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('Electronic');
    expect(chunks[0].text).toContain('128bpm');
  });

  it('includes tags', () => {
    chunks = renderForTelegram(result);
    expect(chunks[0].text).toContain('#product-launch');
    expect(chunks[0].text).toContain('#ai');
  });

  it('falls back to body text when data is invalid', () => {
    const res: SkillResult = { ...result, data: { title: 'x' } }; // Missing required fields
    const c = renderForTelegram(res);
    expect(c[0].text).toBe(result.body);
  });
});

// ---------------------------------------------------------------------------
// Web renderer — image_brief
// ---------------------------------------------------------------------------

describe('Web renderer — image_brief', () => {
  const result = makeResult('image_brief', sampleImageBrief);

  it('returns ok: true', () => {
    const resp = renderForWeb(result);
    expect(resp.ok).toBe(true);
  });

  it('preserves kind as image_brief', () => {
    const resp = renderForWeb(result);
    expect(resp.kind).toBe('image_brief');
  });

  it('preserves skillId', () => {
    const resp = renderForWeb(result);
    expect(resp.skillId).toBe('lyra');
  });

  it('preserves full ImageBrief in data field', () => {
    const resp = renderForWeb(result);
    const data = resp.data as ImageBrief;
    expect(data.title).toBe('Corsican Sunset');
    expect(data.style).toBe('photorealistic');
    expect(data.platform).toBe('instagram-post');
    expect(data.dimensions.width).toBe(1080);
    expect(data.prompt).toContain('golden sunset');
    expect(data.tags).toContain('sunset');
  });

  it('preserves telemetry', () => {
    const resp = renderForWeb(result);
    expect(resp.telemetry.durationMs).toBe(1500);
    expect(resp.telemetry.model).toBe('flash');
    expect(resp.telemetry.tokens?.prompt).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Web renderer — video_brief
// ---------------------------------------------------------------------------

describe('Web renderer — video_brief', () => {
  const result = makeResult('video_brief', sampleVideoBrief);

  it('returns ok: true', () => {
    const resp = renderForWeb(result);
    expect(resp.ok).toBe(true);
  });

  it('preserves kind as video_brief', () => {
    const resp = renderForWeb(result);
    expect(resp.kind).toBe('video_brief');
  });

  it('preserves full VideoBrief in data field', () => {
    const resp = renderForWeb(result);
    const data = resp.data as VideoBrief;
    expect(data.title).toBe('StoriaDigital Product Launch');
    expect(data.concept).toContain('fast-paced');
    expect(data.platform).toBe('instagram-reel');
    expect(data.specs.width).toBe(1080);
    expect(data.script.scenes).toHaveLength(3);
    expect(data.script.totalDuration).toBe(15);
    expect(data.musicDirection).toContain('Electronic');
    expect(data.tags).toContain('ai');
  });

  it('preserves scene shot structure', () => {
    const resp = renderForWeb(result);
    const data = resp.data as VideoBrief;
    const scene1 = data.script.scenes[0];
    expect(scene1.shots).toHaveLength(2);
    expect(scene1.shots[0].shotType).toBe('close-up');
    expect(scene1.shots[1].cameraMovement).toBe('dolly');
  });
});

// ---------------------------------------------------------------------------
// Cross-kind consistency
// ---------------------------------------------------------------------------

describe('Cross-kind consistency', () => {
  it('error kind returns ok: false in web renderer', () => {
    const errResult: SkillResult = {
      skillId: 'lyra',
      kind: 'error',
      body: 'Something went wrong',
      telemetry: baseTelemetry,
    };
    const resp = renderForWeb(errResult);
    expect(resp.ok).toBe(false);
  });

  it('image_brief and video_brief both return ok: true', () => {
    const img = renderForWeb(makeResult('image_brief', sampleImageBrief));
    const vid = renderForWeb(makeResult('video_brief', sampleVideoBrief));
    expect(img.ok).toBe(true);
    expect(vid.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// splitHtmlMessage — tag-aware chunker
// ---------------------------------------------------------------------------

describe('splitHtmlMessage', () => {
  it('returns single chunk when text fits', () => {
    const result = splitHtmlMessage('short text', 100);
    expect(result).toEqual(['short text']);
  });

  it('closes and re-opens <b> tags across chunks', () => {
    // Create text with a bold tag that spans across the split boundary
    const text = '<b>' + 'A'.repeat(50) + '</b>';
    const chunks = splitHtmlMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should close the <b> tag
    expect(chunks[0]).toContain('</b>');
    // Second chunk should re-open the <b> tag
    expect(chunks[1]).toMatch('<b>');
  });

  it('handles <code> blocks across chunks', () => {
    const text = '<code>' + 'X'.repeat(60) + '</code>';
    const chunks = splitHtmlMessage(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('</code>');
    expect(chunks[1]).toMatch('<code>');
  });

  it('handles nested tags', () => {
    const text = '<b><i>' + 'Y'.repeat(50) + '</i></b>';
    const chunks = splitHtmlMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk closes in reverse order
    expect(chunks[0]).toMatch(/<\/i><\/b>$/);
    // Second chunk re-opens in original order
    expect(chunks[1]).toMatch('<b><i>');
  });

  it('does not add extra tags when all tags are properly closed', () => {
    const text = '<b>hello</b> ' + 'Z'.repeat(50);
    const chunks = splitHtmlMessage(text, 30);
    // The <b> is already closed before the split, so no tag repair needed
    expect(chunks[1]).not.toContain('<b>');
  });

  it('does not double-count tags when next chunk starts with a closing tag', () => {
    // Regression: previous chunk ends inside <b>..., next chunk starts with </b> tail
    // The chunker should NOT produce duplicate </b> or carry a phantom open tag
    const part1 = '<b>' + 'A'.repeat(30);
    const part2 = '</b> ' + 'B'.repeat(30);
    const text = part1 + part2;
    const chunks = splitHtmlMessage(text, 40);

    // Count total </b> across all chunks — should equal total <b>
    const allText = chunks.join('');
    const openCount = (allText.match(/<b>/g) || []).length;
    const closeCount = (allText.match(/<\/b>/g) || []).length;
    expect(openCount).toBe(closeCount);
  });

  it('does not produce chunks exceeding the limit', () => {
    const text = '<b><i><code>' + 'W'.repeat(200) + '</code></i></b>';
    const limit = 80;
    const chunks = splitHtmlMessage(text, limit);
    // Every chunk should be within limit (the inner split leaves headroom for tag repair)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
  });
});
