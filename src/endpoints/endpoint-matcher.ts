import type { EndpointPath, EndpointRule } from '../config/system-config';

export type EndpointMatch =
  | { matched: true; ruleId: string; configRevision: string }
  | { matched: false };

export interface EndpointMatcherConfig {
  revision: string;
  endpoints: EndpointRule[];
}

export interface EndpointMatcher {
  match(url: string, protocol: 'http' | 'websocket'): EndpointMatch;
}

interface CompiledRule {
  id: string;
  scheme: string;
  host: string;
  port: string;
  matchesPath(pathname: string): boolean;
}

export function createEndpointMatcher(config: EndpointMatcherConfig): EndpointMatcher {
  const revision = config.revision;
  const rules: CompiledRule[] = config.endpoints.flatMap((rule) =>
    rule.hosts.flatMap((host) =>
      host.schemes.flatMap((scheme) =>
        host.paths.map((path) => ({
          id: rule.id,
          scheme,
          host: host.host.toLowerCase(),
          port: normalizePort(scheme, host.port),
          matchesPath: compilePathMatcher(path),
        })),
      ),
    ),
  );

  return {
    match(rawUrl, protocol) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { matched: false };
      }
      const scheme = url.protocol.slice(0, -1);
      const accepted = protocol === 'http' ? ['http', 'https'] : ['ws', 'wss'];
      if (!accepted.includes(scheme)) return { matched: false };
      for (const rule of rules) {
        if (
          rule.scheme === scheme &&
          rule.host === url.hostname.toLowerCase() &&
          rule.port === normalizeUrlPort(url) &&
          rule.matchesPath(url.pathname)
        ) {
          return { matched: true, ruleId: rule.id, configRevision: revision };
        }
      }
      return { matched: false };
    },
  };
}

function normalizePort(scheme: string, port: number | undefined): string {
  if (port === undefined) return '';
  if ((scheme === 'http' || scheme === 'ws') && port === 80) return '';
  if ((scheme === 'https' || scheme === 'wss') && port === 443) return '';
  return String(port);
}

function normalizeUrlPort(url: URL): string {
  if (!url.port) return '';
  return normalizePort(url.protocol.slice(0, -1), Number(url.port));
}

function compilePathMatcher(path: EndpointPath): (pathname: string) => boolean {
  switch (path.match) {
    case 'exact':
      return (pathname) => pathname === path.value;
    case 'prefix':
      return (pathname) => pathname.startsWith(path.value);
    case 'suffix':
      return (pathname) => pathname.endsWith(path.value);
    case 'contains':
      return (pathname) => pathname.includes(path.value);
    case 'glob': {
      const expression = path.value
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const pattern = new RegExp(`^${expression}$`);
      return (pathname) => pattern.test(pathname);
    }
  }
}