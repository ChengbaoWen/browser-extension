export interface ConfigSource {
  readonly name: 'remote' | 'cache' | 'bundled';
  load(): Promise<unknown>;
}