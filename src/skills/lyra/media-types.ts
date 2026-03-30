/**
 * Lyra (Crex) — Media Brief Types
 *
 * Interfaces, platform maps, and type guards for image and video briefs.
 * Lyra produces structured briefs — NOT rendered media.
 */

// ---------------------------------------------------------------------------
// Image types
// ---------------------------------------------------------------------------

/** Visual style for image generation. */
export type ImageStyle =
  | 'photorealistic'
  | 'illustration'
  | 'watercolor'
  | 'oil-painting'
  | 'digital-art'
  | '3d-render'
  | 'pixel-art'
  | 'anime'
  | 'sketch'
  | 'flat-design'
  | 'isometric'
  | 'collage';

/** Target platform for image output. */
export type ImagePlatform =
  | 'instagram-post'
  | 'instagram-story'
  | 'twitter'
  | 'facebook'
  | 'linkedin'
  | 'youtube-thumbnail'
  | 'tiktok'
  | 'pinterest'
  | 'website-hero'
  | 'blog-header'
  | 'email-header'
  | 'presentation'
  | 'mobile-app'
  | 'print';

/** Dimensions for a platform. */
export interface PlatformDimensions {
  width: number;
  height: number;
  aspectRatio: string;
}

/** Recommended dimensions per image platform. */
export const PLATFORM_DIMENSIONS: Record<ImagePlatform, PlatformDimensions> = {
  'instagram-post':    { width: 1080, height: 1080, aspectRatio: '1:1' },
  'instagram-story':   { width: 1080, height: 1920, aspectRatio: '9:16' },
  'twitter':           { width: 1200, height: 675,  aspectRatio: '16:9' },
  'facebook':          { width: 1200, height: 630,  aspectRatio: '1.91:1' },
  'linkedin':          { width: 1200, height: 627,  aspectRatio: '1.91:1' },
  'youtube-thumbnail': { width: 1280, height: 720,  aspectRatio: '16:9' },
  'tiktok':            { width: 1080, height: 1920, aspectRatio: '9:16' },
  'pinterest':         { width: 1000, height: 1500, aspectRatio: '2:3' },
  'website-hero':      { width: 1920, height: 1080, aspectRatio: '16:9' },
  'blog-header':       { width: 1200, height: 600,  aspectRatio: '2:1' },
  'email-header':      { width: 600,  height: 200,  aspectRatio: '3:1' },
  'presentation':      { width: 1920, height: 1080, aspectRatio: '16:9' },
  'mobile-app':        { width: 1242, height: 2688, aspectRatio: '9:19.5' },
  'print':             { width: 2480, height: 3508, aspectRatio: '1:1.41' },
};

/** Structured image brief produced by Lyra. */
export interface ImageBrief {
  title: string;
  description: string;
  style: ImageStyle;
  platform: ImagePlatform;
  dimensions: PlatformDimensions;
  prompt: string;
  negativePrompt: string;
  referenceNotes: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Video types
// ---------------------------------------------------------------------------

/** Target platform for video output. */
export type VideoPlatform =
  | 'instagram-reel'
  | 'tiktok'
  | 'youtube-short'
  | 'youtube-video'
  | 'twitter-video'
  | 'facebook-video'
  | 'linkedin-video'
  | 'website-video';

/** Technical specs for a video platform. */
export interface VideoPlatformSpec {
  width: number;
  height: number;
  fps: number;
  maxDuration: number;
}

/** Recommended specs per video platform. */
export const VIDEO_PLATFORM_SPECS: Record<VideoPlatform, VideoPlatformSpec> = {
  'instagram-reel': { width: 1080, height: 1920, fps: 30, maxDuration: 90 },
  'tiktok':         { width: 1080, height: 1920, fps: 30, maxDuration: 180 },
  'youtube-short':  { width: 1080, height: 1920, fps: 30, maxDuration: 60 },
  'youtube-video':  { width: 1920, height: 1080, fps: 30, maxDuration: 600 },
  'twitter-video':  { width: 1280, height: 720,  fps: 30, maxDuration: 140 },
  'facebook-video': { width: 1280, height: 720,  fps: 30, maxDuration: 240 },
  'linkedin-video': { width: 1920, height: 1080, fps: 30, maxDuration: 600 },
  'website-video':  { width: 1920, height: 1080, fps: 30, maxDuration: 300 },
};

/** A single shot within a scene. */
export interface ShotDescription {
  shotType: string;
  description: string;
  duration: number;
  cameraMovement?: string;
  notes?: string;
}

/** A scene within a video script. */
export interface VideoScene {
  sceneNumber: number;
  title: string;
  description: string;
  duration: number;
  shots: ShotDescription[];
  voiceover?: string;
  textOverlay?: string;
}

/** Full video script. */
export interface VideoScript {
  scenes: VideoScene[];
  totalDuration: number;
}

/** Structured video brief produced by Lyra. */
export interface VideoBrief {
  title: string;
  concept: string;
  platform: VideoPlatform;
  specs: VideoPlatformSpec;
  script: VideoScript;
  musicDirection: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard for ImageBrief parsed from JSON. */
export function isImageBrief(v: unknown): v is ImageBrief {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (
    typeof obj.title !== 'string' ||
    typeof obj.description !== 'string' ||
    typeof obj.style !== 'string' ||
    typeof obj.platform !== 'string' ||
    typeof obj.prompt !== 'string' ||
    typeof obj.negativePrompt !== 'string' ||
    typeof obj.referenceNotes !== 'string' ||
    !Array.isArray(obj.tags)
  ) return false;

  // Validate dimensions (must have width, height, aspectRatio)
  if (typeof obj.dimensions !== 'object' || obj.dimensions === null) return false;
  const dims = obj.dimensions as Record<string, unknown>;
  if (
    typeof dims.width !== 'number' ||
    typeof dims.height !== 'number' ||
    typeof dims.aspectRatio !== 'string'
  ) return false;

  return true;
}

/** Type guard for a single ShotDescription parsed from JSON. */
function isValidShot(v: unknown): v is ShotDescription {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.shotType === 'string' &&
    typeof s.description === 'string' &&
    typeof s.duration === 'number'
  );
}

/** Type guard for a single VideoScene parsed from JSON. */
function isValidScene(v: unknown): v is VideoScene {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (
    typeof s.sceneNumber !== 'number' ||
    typeof s.title !== 'string' ||
    typeof s.description !== 'string' ||
    typeof s.duration !== 'number' ||
    !Array.isArray(s.shots)
  ) return false;
  return s.shots.every(isValidShot);
}

/** Type guard for VideoBrief parsed from JSON. */
export function isVideoBrief(v: unknown): v is VideoBrief {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (
    typeof obj.title !== 'string' ||
    typeof obj.concept !== 'string' ||
    typeof obj.platform !== 'string' ||
    typeof obj.musicDirection !== 'string' ||
    !Array.isArray(obj.tags)
  ) return false;

  // Validate script structure including scenes and shots
  if (typeof obj.script !== 'object' || obj.script === null) return false;
  const script = obj.script as Record<string, unknown>;
  if (!Array.isArray(script.scenes) || typeof script.totalDuration !== 'number') return false;
  if (!script.scenes.every(isValidScene)) return false;

  // Validate specs (must have width, height, fps, maxDuration)
  if (typeof obj.specs !== 'object' || obj.specs === null) return false;
  const specs = obj.specs as Record<string, unknown>;
  if (
    typeof specs.width !== 'number' ||
    typeof specs.height !== 'number' ||
    typeof specs.fps !== 'number' ||
    typeof specs.maxDuration !== 'number'
  ) return false;

  return true;
}
