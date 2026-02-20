# Moltworker — Sprint 48h (19-21 fév 2026)
**Pour**: Claude Code Opus 4.6  
**Contexte**: Feedback consolidé de Grok + Opus 4.6 + Sonnet 4.6, corrigé sur code réel (commit 17-18 fév)  
**Branche**: `claude/sprint-phase-budgets-parallel`

---

## Contexte critique à lire avant de toucher au code

`task-processor.ts` fait actuellement **1 248 lignes** (pas 650 — données obsolètes dans les feedbacks antérieurs).  
`Promise.all` est **déjà implémenté** pour les tool calls parallèles (confirmé commit récent).  
Cloudflare DO : single-threaded, CPU hard limit 30s, alarm toutes les 90s.  
Le watchdog actuel est **réactif** (détecte les stalls après coup). Il n'y a **aucun circuit breaker proactif par phase**.

---

## Tâche 1 — Phase Budget Circuit Breakers (priorité absolue)
**Effort estimé** : 2h  
**Risque mitigé** : CPU 30s hard kill Cloudflare (Risque 9×10)

### Problème
Si une phase `work` enchaîne 3 tools lents + retry OpenRouter timeout (20s) → tu hits le hard limit 30s CPU et perds toute la progression. Le watchdog ne peut rien faire après un kill.

### Implémentation

Ajouter dans `task-processor.ts` (ou extraire dans `task-phases.ts` si tu juges la taille critique) :

```typescript
const PHASE_BUDGETS_MS = {
  plan:   8_000,   // 8s max
  work:   18_000,  // 18s max (tools lourds)
  review: 3_000    // 3s max
} as const;

type TaskPhase = keyof typeof PHASE_BUDGETS_MS;

async function executePhaseWithBudget(
  phase: TaskPhase,
  fn: () => Promise<void>,
  state: TaskState,
  saveCheckpoint: () => Promise<void>
): Promise<void> {
  const budget = PHASE_BUDGETS_MS[phase];
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Phase ${phase} timeout after ${budget}ms`)),
      budget
    )
  );

  try {
    await Promise.race([fn(), timeout]);
    state.phaseStartTime = Date.now(); // reset pour watchdog
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('timeout');
    if (isTimeout) {
      state.autoResumeCount++;
      state.lastError = `Phase timeout → auto-resume #${state.autoResumeCount}`;
      await saveCheckpoint(); // sauvegarder avant propagation
    }
    throw err;
  }
}
```

### Intégration dans runTaskLoop()

Wrapper chaque phase existante :

```typescript
// Avant (exemple phase work) :
await this.runWorkPhase();

// Après :
await executePhaseWithBudget('work', () => this.runWorkPhase(), this.state, () => this.saveCheckpoint());
```

### Tests à ajouter (minimum)
- Phase timeout déclenche `autoResumeCount++`
- `saveCheckpoint()` est appelé avant le throw sur timeout
- Phase qui finit dans le budget ne modifie pas `autoResumeCount`
- Budget `plan` (8s) < budget `work` (18s) — vérifier que les constantes sont respectées

---

## Tâche 2 — Parallel Tools Upgrade
**Effort estimé** : 45min  
**Contexte** : `Promise.all` est déjà en prod. Ce sont deux upgrades ciblés, pas une nouvelle implémentation.

### Upgrade 1 — Passer à Promise.allSettled

`Promise.all` fait échouer tous les tools si un seul fail. `Promise.allSettled` isole les échecs :

```typescript
// Localiser handleToolCalls() dans task-processor.ts
// Remplacer Promise.all par Promise.allSettled + mapper les résultats

const settled = await Promise.allSettled(
  toolCalls.map(tc => executeToolWithTimeout(tc))
);

const results = settled.map((result, i) => {
  if (result.status === 'fulfilled') {
    return { toolCallId: toolCalls[i].id, content: result.value };
  } else {
    return {
      toolCallId: toolCalls[i].id,
      content: `Tool error: ${result.reason?.message ?? 'unknown'}`,
      isError: true
    };
  }
});
```

### Upgrade 2 — Side-effects whitelist

Certains tools ont des side-effects (writes GitHub, mutations) et ne doivent pas être parallélisés :

```typescript
// Ajouter près de la définition des tools existants
const PARALLEL_SAFE_TOOLS = new Set([
  'fetch_url',
  'browse_url',
  'fetch_weather',
  'get_crypto',
  'github_read_file',
  'github_list_files',
  // NE PAS inclure : 'github_api' (peut faire des writes)
]);

// Dans handleToolCalls(), avant Promise.allSettled :
const allSafe = toolCalls.every(tc => PARALLEL_SAFE_TOOLS.has(tc.function.name));
const useParallel = allSafe && (this.currentModel.parallelCalls === true);

if (toolCalls.length > 1 && useParallel) {
  // Promise.allSettled path
} else {
  // Sequential fallback (legacy models ou tools avec side-effects)
}
```

**Note** : `parallelCalls` flag existe déjà dans `models.ts` — utiliser celui-là, ne pas en créer un nouveau.

### Tests à ajouter
- Un tool qui fail n'annule pas les autres (allSettled isolation)
- `github_api` → sequential même si model supporte parallel
- `fetch_weather` + `get_crypto` → parallel si model le supporte
- Résultats d'erreur contiennent `isError: true`

---

## Ce qu'il ne faut PAS faire dans ce sprint

- Ne pas splitter `task-processor.ts` en 5 fichiers — décision Acontext non encore prise
- Ne pas refactoriser `task-phases.ts` en profondeur — Acontext la remplace potentiellement
- Ne pas intégrer Acontext — c'est Phase 4, gate séparé
- Ne pas toucher à `compressContext()` — tiktoken-lite est la prochaine étape, pas ce sprint

---

## Après ce sprint (Semaine suivante)

Ces items sont hors scope du sprint 48h mais documentés pour la session suivante :

1. **Extract guardrails** → `task-guardrails.ts` (constantes uniquement, pas de refacto structurelle)
2. **tiktoken-lite** → remplacer `estimateTokens()` (chars/4 trop approximatif pour cost tracking)
3. **Pre-warm cron** → toutes les 7 minutes (keep-alive DO)

---

## Human Checkpoint (toi, après deploy)

Lancer `/briefing` (weather + news + crypto) — c'est le test multi-tools idéal.  
Mesurer :
- Latency avant/après `allSettled`
- Auto-resume rate sur tâches longues (objectif < 5%, actuel ~12%)
- Aucun kill CPU 30s Cloudflare sur tâches complexes

---

## Mise à jour roadmap attendue après le sprint

```markdown
## Changelog — 19-21 fév 2026
- ✅ Phase budget circuit breakers (PHASE_BUDGETS_MS + executePhaseWithBudget)
- ✅ Parallel tools → Promise.allSettled + PARALLEL_SAFE_TOOLS whitelist
- Risque "No phase timeouts (9×10)" → mitigé
- OKR latency multi-tools : mesure post-deploy en attente
```

---

## Règles de base pour cette session

- Branche : `claude/sprint-phase-budgets-parallel`
- `test-results-summary.json` : toujours résoudre avec `--theirs`
- Tests : +1 couverture minimum sur chaque fichier touché
- Commit unique par tâche avec message clair : `feat: phase budget circuit breakers (Sprint 48h)`
- Mettre à jour `GLOBAL_ROADMAP.md` + `claude-log.md` après chaque tâche
