import dns from 'dns/promises';
import net from 'net';

/**
 * SSRF guard for agent-chosen URLs (fetch_page, browse_web). The agent's
 * targets are influenced by untrusted content (web pages, inbound messages),
 * so block anything that resolves to loopback, link-local (cloud metadata),
 * or private ranges before we fetch or navigate.
 */

function isBlockedIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // Normalize IPv4-mapped (::ffff:10.0.0.1)
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return (
      lower === '::1' || // loopback
      lower === '::' ||
      lower.startsWith('fe80:') || // link-local
      lower.startsWith('fc') || // unique local fc00::/7
      lower.startsWith('fd')
    );
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast/reserved
  );
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'metadata.google.internal'
  );
}

/** Fast, non-resolving check — used where DNS lookups aren't practical
 *  (e.g. per-request interception in the browser agent). */
export function isForbiddenUrlSync(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) return true;
  if (net.isIP(host) && isBlockedIp(host)) return true;
  return false;
}

/** Full check including DNS resolution. Throws with a readable reason. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) {
    throw new Error(`Blocked host: ${host} (internal/private addresses are not allowed)`);
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error(`Blocked IP: ${host} (internal/private addresses are not allowed)`);
    }
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`Blocked host: ${host} resolves to a private address`);
    }
  }
  return url;
}
