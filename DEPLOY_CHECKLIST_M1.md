# Lyra Media Briefs — Deploy Checklist (Sprint M1-M3)

## Pre-deploy Verification (Automated)

- [x] `npm test` — All 2677 tests pass
- [x] `npx tsc --noEmit` — Clean typecheck
- [x] No new environment variables or secrets required
- [x] No new Cloudflare bindings required

## Wrangler Bindings Verified

| Binding | Type | Status |
|---------|------|--------|
| `MOLTBOT_BUCKET` | R2 | Configured (moltbot-data) |
| `OPENROUTER_API_KEY` | Secret | Required (existing) |
| `TASK_PROCESSOR` | Durable Object | Configured |
| `NEXUS_KV` | KV Namespace | Configured |
| `BROWSER` | Browser Rendering | Configured |
| `Sandbox` | Container / DO | Configured |

**No new bindings needed** — Lyra media briefs use only the existing
`callSkillLLM()` pipeline which routes through `OPENROUTER_API_KEY`.

## What Changed

### New Files
- `src/skills/lyra/media-types.ts` — ImageBrief, VideoBrief types + platform dimension maps + type guards
- `src/skills/lyra/media-prompts.ts` — System prompts + prompt builders for image/video briefs
- `src/skills/lyra/__tests__/media.test.ts` — 56 unit tests for media types, guards, handlers
- `src/skills/renderers/__tests__/media-renderers.test.ts` — 35 renderer integration tests
- `src/routes/__tests__/lyra-media.test.ts` — 13 end-to-end integration tests

### Modified Files
- `src/skills/types.ts` — Added `image_brief` and `video_brief` to `SkillResultKind`
- `src/skills/command-map.ts` — Added `/image`, `/imagine`, `/video`, `/storyboard` mappings
- `src/skills/lyra/lyra.ts` — Added `executeImage()` and `executeVideo()` submodes
- `src/skills/renderers/telegram.ts` — Added `renderImageBrief()` and `renderVideoBrief()`
- `src/skills/command-map.test.ts` — Updated command count 14 → 18

## PetrAnto Manual Actions Before Deploy

1. **Optional:** Upload Lyra media R2 prompts to `moltbot-data/skills/lyra/`
   - `prompts/lyra/image-system.md` (optional hot-prompt override)
   - `prompts/lyra/video-system.md` (optional hot-prompt override)
   - If not uploaded, the bundled `LYRA_IMAGE_SYSTEM_PROMPT` / `LYRA_VIDEO_SYSTEM_PROMPT` are used

2. **Deploy:**
   ```bash
   wrangler deploy
   ```

## Post-deploy Telegram Tests

```
/image --for instagram-post create a sunset in Corsica
/imagine a futuristic city at night --style digital-art
/video --for instagram-reel --duration 15 product launch teaser
/storyboard --for youtube-short a cooking tutorial montage
```

Expected: Each command returns a structured brief with title, description/concept,
platform specs, and detailed creative direction. No actual images/videos are generated.

## Simulate Endpoint Tests

```bash
# Image brief
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/chat \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "/image --for instagram-post a sunset in Corsica", "model": "flash", "timeout": 60000}'

# Video brief
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/chat \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "/video --for instagram-reel --duration 15 product launch teaser", "model": "flash", "timeout": 60000}'
```

## API Contract

After this deploy, `SkillResultKind` includes:
```typescript
'image_brief' | 'video_brief'
```

The web renderer produces:
```json
{
  "ok": true,
  "skillId": "lyra",
  "kind": "image_brief",
  "body": "<brief title>",
  "data": { ...ImageBrief },
  "telemetry": { ... }
}
```
