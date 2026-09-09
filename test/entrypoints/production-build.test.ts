import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production build UI', () => {
  it('includes the Side Panel used to inspect captures', () => {
    execSync('npm run build', { cwd: resolve('.'), stdio: 'pipe' });
    const output = resolve('.output/chrome-mv3');
    const manifest = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toHaveProperty('side_panel.default_path');
    expect(manifest.permissions).toContain('sidePanel');
    const files = walk(output);
    expect(files.some((file) => /sidepanel/i.test(file))).toBe(true);
    const scripts = files.filter((file) => file.endsWith('.js')).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(scripts).toMatch(/createRoot/);
  }, 30_000);
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}