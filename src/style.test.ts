// @ts-ignore: Node's types aren't installed; vitest runs this file in Node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A stray "}" in the stylesheet silently drops the rule after it (on 23 Nov 2026 that showed
// the "turn your phone upright" cover on every screen). Every brace must have its partner.
describe('style.css', () => {
  it('has balanced braces', () => {
    const raw: string = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
    expect(raw.length).toBeGreaterThan(1000);
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0, stray = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') { if (depth === 0) stray++; else depth--; }
    }
    expect(stray).toBe(0);
    expect(depth).toBe(0);
  });
});
