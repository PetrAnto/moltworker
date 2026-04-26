import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isPrivateHost, isPublicUrl } from './url-guard';

describe('isPrivateHost', () => {
  it('rejects loopback', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.255.255.254')).toBe(true);
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('foo.localhost')).toBe(true);
  });

  it('rejects RFC1918 / CGNAT space', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('172.16.5.5')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('100.64.0.1')).toBe(true);
  });

  it('accepts public-space neighbours of RFC1918', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('192.169.1.1')).toBe(false);
    expect(isPrivateHost('11.0.0.1')).toBe(false);
  });

  it('rejects link-local + cloud metadata', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('metadata.google.internal')).toBe(true);
    expect(isPrivateHost('foo.internal')).toBe(true);
    expect(isPrivateHost('printer.local')).toBe(true);
  });

  it('rejects IPv6 loopback / link-local / ULA / multicast', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('::')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12:3456::1')).toBe(true);
    expect(isPrivateHost('ff02::1')).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 loopback', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
  });

  it('accepts public hostnames and IPs', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('api.openrouter.ai')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });

  it('rejects malformed IPv4 conservatively', () => {
    expect(isPrivateHost('999.999.999.999')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('accepts https URLs to public hosts', () => {
    expect(() => assertPublicUrl('https://example.com/path')).not.toThrow();
    expect(() => assertPublicUrl('http://api.openrouter.ai/v1')).not.toThrow();
  });

  it('rejects non-http schemes', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(/scheme not allowed/);
    expect(() => assertPublicUrl('ftp://example.com/x')).toThrow(/scheme not allowed/);
    expect(() => assertPublicUrl('gopher://example.com/x')).toThrow(/scheme not allowed/);
    expect(() => assertPublicUrl('javascript:alert(1)')).toThrow(/scheme not allowed/);
  });

  it('rejects malformed URLs', () => {
    expect(() => assertPublicUrl('not a url')).toThrow(/Invalid URL/);
    expect(() => assertPublicUrl('')).toThrow(/Invalid URL/);
  });

  it('rejects private addresses regardless of scheme', () => {
    expect(() => assertPublicUrl('http://127.0.0.1/admin')).toThrow(/private\/internal/);
    expect(() => assertPublicUrl('http://localhost:8080/x')).toThrow(/private\/internal/);
    expect(() => assertPublicUrl('http://169.254.169.254/latest/meta-data')).toThrow(
      /private\/internal/,
    );
    expect(() => assertPublicUrl('http://[::1]/x')).toThrow(/private\/internal/);
  });

  it('honours denyHosts over allowHosts', () => {
    expect(() =>
      assertPublicUrl('https://blocked.example.com/x', {
        allowHosts: ['blocked.example.com'],
        denyHosts: ['blocked.example.com'],
      }),
    ).toThrow(/denied/);
  });

  it('honours allowHosts when provided', () => {
    expect(() =>
      assertPublicUrl('https://other.example.com/x', {
        allowHosts: ['ok.example.com'],
      }),
    ).toThrow(/not in allowlist/);
    expect(() =>
      assertPublicUrl('https://ok.example.com/x', {
        allowHosts: ['ok.example.com'],
      }),
    ).not.toThrow();
  });
});

describe('isPublicUrl', () => {
  it('returns boolean instead of throwing', () => {
    expect(isPublicUrl('https://example.com')).toBe(true);
    expect(isPublicUrl('http://10.0.0.1')).toBe(false);
    expect(isPublicUrl('not a url')).toBe(false);
  });
});

// V8 (and the WHATWG URL spec it implements) canonicalizes alternative
// IPv4 forms — decimal-as-integer, hex, octal, short-form — to dotted
// quad before exposing url.hostname. So `assertPublicUrl` already catches
// `http://2130706433/` etc. via its existing dotted-quad check. These
// regressions lock that behavior in: if a future runtime ever stops
// canonicalizing, we want the test suite to scream rather than silently
// open a bypass.
describe('non-canonical IPv4 forms (regression)', () => {
  const bypassAttempts = [
    'http://2130706433/admin', // 127.0.0.1 as 32-bit decimal
    'http://0x7f000001/admin', // 127.0.0.1 as hex int
    'http://017700000001/admin', // 127.0.0.1 as octal int
    'http://127.1/admin', // dotted-octet short form
    'http://0x7f.0.0.1/admin', // mixed hex octet
    'http://0177.0.0.1/admin', // mixed octal octet
  ];

  for (const url of bypassAttempts) {
    it(`rejects ${url}`, () => {
      expect(() => assertPublicUrl(url)).toThrow(/private\/internal/);
    });
  }
});
