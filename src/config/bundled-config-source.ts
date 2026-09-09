import bundledConfig from './system-config.json';
import type { ConfigSource } from './config-source';

export class BundledConfigSource implements ConfigSource {
  readonly name = 'bundled' as const;

  async load(): Promise<unknown> {
    return structuredClone(bundledConfig);
  }
}