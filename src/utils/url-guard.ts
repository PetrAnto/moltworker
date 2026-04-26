/**
 * URL guard — rejects URLs that point at private/internal addresses.
 *
 * Used at every boundary where a model-supplied or user-supplied URL is
 * about to be fetched. The Workers runtime blocks some loopback ranges
 * on its own, but it does not block all RFC1918 / link-local space, and
 * it does not block sibling *.workers.dev hosts. Doing an explicit
 * textual check here closes the most common SSRF vectors.
 *
 * Limitations: this cannot defeat DNS rebinding (we can't resolve names
 * inside a Worker before fetch). For high-trust contexts, callers should
 * additionally allowlist specific hostnames.
 */

export interface UrlGuardOptions {
  /** Permitted schemes. Default: ['https:', 'http:']. */
  allowedSchemes?: string[];
  /** Extra hostname allowlist (exact match, lowercased). */
  allowHosts?: string[];
  /** Extra hostname denylist (exact match, lowercased). Wins over allowHosts. */
  denyHosts?: string[];
}

/**
 * Parse and validate a URL. Throws on rejection.
 * Returns the parsed URL on success so callers can reuse it.
 */
export function assertPublicUrl(input: string, opts: UrlGuardOptions = {}): URL {
  const schemes = opts.allowedSchemes ?? ['https:', 'http:'];

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${truncate(input)}`);
  }

  if (!schemes.includes(url.protocol)) {
    throw new Error(`URL scheme not allowed: ${url.protocol} (allowed: ${schemes.join(', ')})`);
  }

  const host = url.hostname.toLowerCase();

  if (opts.denyHosts?.includes(host)) {
    throw new Error(`URL host is denied: ${host}`);
  }
  if (opts.allowHosts && !opts.allowHosts.includes(host)) {
    throw new Error(`URL host is not in allowlist: ${host}`);
  }

  if (isPrivateHost(host)) {
    throw new Error(`URL points at a private/internal address: ${host}`);
  }

  return url;
}

/** Returns true if the URL would be rejected by assertPublicUrl. */
export function isPublicUrl(input: string, opts?: UrlGuardOptions): boolean {
  try {
    assertPublicUrl(input, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure host check — exposed so callers can short-circuit before parsing.
 * Returns true for any host that should not be reachable from a tool
 * call: loopback, link-local, RFC1918, unique-local IPv6, the unspecified
 * address, *.internal / *.local DNS, and obvious metadata hostnames.
 */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;

  // IPv6 in URL form is bracketed. URL.hostname keeps the brackets in
  // some runtimes (V8/Cloudflare Workers) and strips them in others;
  // normalize either way before checking.
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // Detect IPv6 by the presence of a colon — IPv6 always has at least two.
  if (host.includes(':')) {
    return isPrivateIPv6(host);
  }

  // IPv4 dotted quad
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return isPrivateIPv4(host);
  }

  // Hostname (DNS name)
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  // Cloud metadata hosts that have shown up in real SSRF incidents.
  if (host === 'metadata.google.internal') return true;
  if (host === 'metadata.goog') return true;

  return false;
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    // Malformed — treat as private rather than risk a permissive bypass.
    return true;
  }
  const [a, b] = parts;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (cloud metadata, AWS/Azure/GCP)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  if (a !== undefined && a >= 224) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const lower = host.toLowerCase();
  // Loopback ::1 and unspecified ::
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped: ::ffff:127.0.0.1 and friends
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) {
      return isPrivateIPv4(v4);
    }
    return true;
  }
  // Link-local fe80::/10
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  )
    return true;
  // Unique-local fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return true;
  return false;
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
