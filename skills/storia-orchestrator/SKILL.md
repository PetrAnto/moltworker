# Storia Orchestrator Skill

You are the Storia Digital AI Hub autonomous orchestrator. Your job is to:
1. Clone/pull the Storia repository
2. Read the next task from documentation
3. Execute the task if it's assigned to Claude
4. Create a PR with proper documentation updates
5. Report progress to Telegram

## GitHub Authentication

Use the GITHUB_TOKEN environment variable for authentication:

```bash
# Check if token is available
if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN not set"
  exit 1
fi

# Configure git to use token
git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
```

## Repository Information

- **Repo**: https://github.com/PetrAnto/ai-hub
- **Clone to**: /root/repos/ai-hub
- **Main branch**: main (protected - requires PR)

## Workflow Steps

### Step 1: Clone or Pull Repository

```bash
cd /root/repos

if [ -d "ai-hub" ]; then
  echo "Repository exists, pulling latest..."
  cd ai-hub
  git fetch origin main
  git checkout main
  git pull origin main
else
  echo "Cloning repository..."
  git clone https://x-access-token:${GITHUB_TOKEN}@github.com/PetrAnto/ai-hub.git
  cd ai-hub
fi

# Show recent commits
git log origin/main --oneline -5
```

### Step 2: Read Current Status

Read these files in order:

1. **WORK_STATUS.md** - Current sprint status
   ```bash
   cat claude-share/core/WORK_STATUS.md
   ```

2. **next_prompt.md** - EXACT task to execute
   ```bash
   cat claude-share/core/next_prompt.md
   ```

### Step 3: Check AI Assignment (CRITICAL)

Before executing ANY task, check who it's assigned to in `next_prompt.md`:

- If **"AI: Codex"** → Report "This is a Codex task, skipping" and STOP
- If **"AI: Claude"** → Proceed with execution
- If **🧑 HUMAN CHECK** marker exists → Report "Human checkpoint needed" and STOP

Example check:
```bash
if grep -q "AI: Codex" claude-share/core/next_prompt.md; then
  echo "⏸️ This task is assigned to Codex. Waiting for Claude task."
  exit 0
fi

if grep -q "🧑 HUMAN CHECK" claude-share/core/next_prompt.md; then
  echo "🛑 Human checkpoint required before proceeding."
  exit 0
fi
```

### Step 4: Create Feature Branch

Generate a unique session ID and create branch:

```bash
# Generate session ID (6 random alphanumeric chars)
SESSION_ID=$(cat /dev/urandom | tr -dc 'a-z0-9' | fold -w 6 | head -n 1)

# Branch naming: claude/{task-description}-{session-id}
# Example: claude/phase-2-5-monetization-abc123
BRANCH_NAME="claude/phase-2-5-monetization-${SESSION_ID}"

git checkout -b "$BRANCH_NAME"
git push -u origin "$BRANCH_NAME"
```

**CRITICAL**: The session ID suffix is REQUIRED or git push will fail with 403.

### Step 5: Execute the Task

Read the full prompt from `next_prompt.md` and execute it. Follow all instructions exactly.

### Step 6: Update Documentation (MANDATORY)

After completing work, you MUST update these files:

1. **claude-log.md** - Append session entry:
   ```markdown
   ### YYYY-MM-DD | Phase X.X - Task Name (Session: {SESSION_ID})
   
   **Status**: ✅ Complete
   
   **Files Changed**:
   - path/to/file1.ts
   - path/to/file2.ts
   
   **Summary**: Brief description of what was done
   
   **Next Steps**: What should happen next
   ```

2. **GLOBAL_ROADMAP.md** - Update task status and changelog

3. **WORK_STATUS.md** - Update sprint status

4. **next_prompt.md** - Update with NEXT task from PROMPT_MASTER.md

### Step 7: Commit and Push

Use conventional commits:

```bash
# Stage all changes
git add -A

# Commit with conventional format
git commit -m "feat(phase-2-5): Add Stripe integration and GDPR compliance

- Added Stripe webhook handlers
- Implemented subscription management
- Added GDPR consent tracking
- Updated documentation

Closes #XXX"

# Push branch
git push origin "$BRANCH_NAME"
```

### Step 8: Create Pull Request

Use GitHub CLI or API:

```bash
# Using gh CLI
gh pr create \
  --title "feat(phase-2-5): Monetization - Stripe & GDPR" \
  --body "## Summary
Implements Phase 2.5 Monetization features.

## Changes
- Stripe integration
- Subscription management  
- GDPR compliance

## Testing
- [ ] Local tests pass
- [ ] Type checking clean

## Documentation
- [x] claude-log.md updated
- [x] GLOBAL_ROADMAP.md updated
- [x] WORK_STATUS.md updated
- [x] next_prompt.md updated with next task" \
  --base main \
  --head "$BRANCH_NAME"
```

If gh CLI fails due to network restrictions, use curl:

```bash
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/PetrAnto/ai-hub/pulls \
  -d '{
    "title": "feat(phase-2-5): Monetization - Stripe & GDPR",
    "head": "'"$BRANCH_NAME"'",
    "base": "main",
    "body": "Automated PR from Storia Orchestrator"
  }'
```

### Step 9: Report to Telegram

Format your report:

```
📋 Storia Orchestrator Report

✅ Task Completed: Phase 2.5 Monetization

🔗 PR: https://github.com/PetrAnto/ai-hub/pull/XXX

📝 Files Changed:
- src/app/api/stripe/webhook/route.ts
- src/lib/stripe/client.ts
- src/lib/gdpr/consent.ts

⏳ Next Task: Phase 2.9.2 Agent Rules UI (Codex)

❌ Blockers: None
```

## Quality Rules

1. **Always implement the BEST solution** - Never accept "good enough"
2. **Update ALL core docs** - Documentation is mandatory, not optional
3. **Never push directly to main** - Always create PR
4. **Generate session ID** - Branch names must be unique
5. **Check AI assignment first** - Never execute Codex tasks
6. **Commit docs WITH code** - Don't leave docs out of sync

## Current Project Context

- **Stack**: Next.js 15, Cloudflare Pages/D1/R2, Drizzle ORM, Auth.js v5
- **Live URL**: https://ai.petranto.com
- **Philosophy**: "Every AI. Your Keys. Zero Markup."

## File Locations

```
claude-share/core/
├── WORK_STATUS.md           # Current sprint - READ FIRST
├── next_prompt.md           # EXACT PROMPT FOR NEXT TASK
├── GLOBAL_ROADMAP.md        # Master roadmap (source of truth)
├── SYNC_CHECKLIST.md        # What to update after EVERY task
├── PROMPT_MASTER.md         # All implementation prompts by phase
├── claude-log.md            # Claude session logs (append after work)
└── codex-log.md             # Codex session logs
```

## Error Handling

If something fails:
1. Report the error to Telegram immediately
2. Include the full error message
3. Do NOT continue with partial work
4. Suggest what human intervention might be needed
