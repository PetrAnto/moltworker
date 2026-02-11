# R2 Bucket Contents

Copy each subfolder to the R2 bucket root. The bucket structure should be:

```
R2 bucket root/
├── skills/
│   └── storia-orchestrator/
│       └── prompt.md          ← Bot system prompt (loaded on every message)
│
│   (Other directories are created automatically by the bot at runtime)
│
├── telegram-users/{userId}/   ← Auto-created: preferences, conversation history
├── checkpoints/{userId}/      ← Auto-created: task checkpoints
├── learnings/{userId}/        ← Auto-created: task learnings + last-task summary
├── sync/                      ← Auto-created: dynamic models from /syncmodels
```

## What to Upload Manually

Only `skills/storia-orchestrator/prompt.md` needs to be uploaded manually.
Everything else is created automatically by the bot at runtime.

## How to Upload

Using wrangler:
```bash
wrangler r2 object put moltbot-bucket/skills/storia-orchestrator/prompt.md --file claude-share/R2/skills/storia-orchestrator/prompt.md
```

Or copy via the Cloudflare dashboard R2 UI.

## Verifying

In Telegram, run `/skill` to check if the skill is loaded, or `/skill reload` to force reload.
