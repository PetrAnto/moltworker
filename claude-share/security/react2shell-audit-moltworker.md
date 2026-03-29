# React2Shell (CVE-2025-55182) Security Audit — Moltworker

**Date**: 2026-03-29
**Auditor**: Claude Opus 4.6 (automated)
**Scope**: Full dependency + architecture review for CVE-2025-55182 exposure

---

## Executive Summary

**VERDICT: NOT VULNERABLE**

Moltworker is **not affected** by CVE-2025-55182 (React2Shell). While React 19 is present as a dependency, the application architecture has **zero React Server Component (RSC) attack surface**.

---

## 1) Dependency Analysis

### Direct Dependencies

| Package | Declared | Installed | Vulnerable Range | Status |
|---------|----------|-----------|-----------------|--------|
| `react` | `^19.0.0` | `19.2.4` | 19.0.0-19.2.0 | **SAFE** (19.2.4 > 19.2.0) |
| `react-dom` | `^19.0.0` | `19.2.4` | 19.0.0-19.2.0 | **SAFE** |
| `next` | not present | N/A | 15.x-16.x with RSC | **N/A** |
| `react-server-dom-webpack` | not present | N/A | any | **N/A** |
| `react-server-dom-turbopack` | not present | N/A | any | **N/A** |
| `react-server-dom-parcel` | not present | N/A | any | **N/A** |

### Transitive Dependencies

```
grep -r "react-server" node_modules/.package-lock.json → No react-server packages found
```

No RSC Flight protocol packages exist anywhere in the dependency tree.

### Version Note

The installed React version (`19.2.4`) is **above the patched threshold** (`19.2.1`). Even if RSC were used, the installed version contains the CVE fix.

---

## 2) Architecture Assessment

### Frontend Type

**Vite React SPA (Single-Page Application)** — NOT Next.js, NOT RSC

| Property | Value |
|----------|-------|
| Bundler | Vite 6 (`@vitejs/plugin-react`) |
| Build output | Static JS/CSS/HTML to `dist/client/` |
| Entry point | `src/client/main.tsx` (client-side `createRoot().render()`) |
| Serving | Cloudflare Workers ASSETS binding at `/_admin/*` |
| Server rendering | **None** |
| RSC directives | **None** (`"use server"`, `"use client"` not found) |

### Server-Side React Usage

| Check | Result |
|-------|--------|
| `renderToString` in production code | Not found |
| `renderToPipeableStream` in production code | Not found |
| `react-dom/server` imports in routes | Not found (only in test files) |
| JSX/TSX in backend routes (`src/routes/*.ts`) | Not found |
| Dynamic HTML generation with React components | Not found |
| Server Actions (`"use server"`) | Not found |

### How the Admin Dashboard Works

1. Vite builds `src/client/` to static assets at build time
2. `wrangler.jsonc` maps ASSETS binding to `./dist/client`
3. `src/routes/admin-ui.ts` serves `index.html` for all `/_admin/*` paths (SPA fallback)
4. All data fetching is client-side via `fetch()` to `/api/admin/*` endpoints
5. **No server-side JSX compilation occurs at runtime**

---

## 3) Attack Surface Analysis

CVE-2025-55182 exploits insecure deserialization in the RSC Flight protocol. For exploitation, the target must:

1. Use React Server Components (server-side JSX rendering) -- **Moltworker: NO**
2. Process untrusted RSC Flight protocol payloads -- **Moltworker: NO**
3. Run `react-server-dom-*` packages on the server -- **Moltworker: NO**

**Moltworker has zero RSC attack surface.** React is used exclusively as a client-side library. The Hono server routes return JSON or serve static files — no React rendering occurs server-side.

---

## 4) npm audit Results (2026-03-29)

```
8 vulnerabilities (7 high, 1 critical)
```

| Package | Severity | Issue | Fix Available |
|---------|----------|-------|---------------|
| `basic-ftp` < 5.2.0 | **CRITICAL** | Path traversal in `downloadToDir()` | Yes (`npm audit fix`) |
| `hono` <= 4.12.6 | HIGH | 9 issues: XSS (ErrorBoundary), cache deception, IP spoofing, key read (serveStatic), timing comparison, cookie injection, SSE injection, serveStatic file access, prototype pollution | Yes (`npm audit fix`) |
| `picomatch` 4.0.0-4.0.3 | HIGH | Method injection in POSIX classes, ReDoS via extglob | Yes (`npm audit fix`) |
| `rollup` 4.0.0-4.58.0 | HIGH | Arbitrary file write via path traversal | Yes (`npm audit fix`) |
| `undici` 7.0.0-7.23.0 | HIGH | 6 issues: WebSocket overflow, HTTP smuggling, memory DoS, CRLF injection, response buffering DoS | Yes (`npm audit fix`) |

### Risk Assessment of npm audit Findings

| Package | Runtime Impact on Moltworker | Action |
|---------|------------------------------|--------|
| `basic-ftp` | Low — only used in sandbox containers, not user-facing | Update recommended |
| `hono` | **HIGH** — Hono is the core web framework. XSS in ErrorBoundary, IP spoofing, serveStatic vulnerabilities are all relevant | **Update urgently** |
| `picomatch` | Low — build-time dependency (via Vite) | Update recommended |
| `rollup` | Low — build-time dependency (via Vite) | Update recommended |
| `undici` | Medium — transitive via `miniflare`/`wrangler` (dev tools), not direct runtime | Update on next wrangler bump |

### Recommendation

Run `npm audit fix` to resolve all fixable vulnerabilities. The **Hono update is the highest priority** since it's the runtime web framework handling all HTTP requests.

---

## 5) Conclusion

| Category | Status |
|----------|--------|
| CVE-2025-55182 (React2Shell) | **NOT VULNERABLE** — no RSC surface, installed React 19.2.4 is patched |
| React dependency version | Safe (19.2.4, above patched 19.2.1) |
| RSC packages | Not present in dependency tree |
| Next.js | Not used |
| Server-side React rendering | Not used |
| npm audit critical/high | 8 vulnerabilities — `npm audit fix` recommended, Hono update highest priority |

---

*Audit performed against commit `d2591a2` (main branch, 2026-03-29)*
