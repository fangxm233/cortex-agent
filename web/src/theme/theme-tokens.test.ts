// input:  shared palette CSS, runtime UI source, native shell HTML
// output: token, variant, accent-alias, no-flash, and raw-color regressions
// pos:    Guards appearance coverage across web, mobile, and shell
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SRC_ROOT = join(WEB_ROOT, 'src');
const THEME_PATH = join(WEB_ROOT, 'public', 'theme.css');
const RAW_COLOR = /#[\da-f]{3,8}\b|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
const THEME_CONSTANT_TOKENS = new Set([
  '--accent-hue',
  '--accent-chroma',
  '--bg-hue',
  '--bg-chroma',
  '--bg-light',
  '--ink-hue',
  '--ink-chroma',
  '--ink-contrast',
  '--preset-swatch',
  '--bg-chroma-track',
  '--bg-light-track',
  '--ink-chroma-track',
  '--ink-contrast-track',
  '--accent-default-swatch',
  '--accent-swatch-blue',
  '--accent-swatch-teal',
  '--accent-swatch-violet',
  '--accent-swatch-rose',
  '--accent-swatch-orange',
  '--accent-spectrum',
  '--media-stage-bg',
  '--media-paper-bg',
  '--media-backdrop',
  '--media-backdrop-soft',
  '--media-control-bg',
  '--media-timestamp-bg',
  '--media-control-bg-dark',
  '--media-control-bg-strong',
  '--media-caption-fg',
  '--media-overlay-fg',
  '--media-paper-shadow',
  '--media-panel-shadow',
  '--media-glyph-shadow',
  '--log-border',
]);

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`Unclosed CSS block: ${selector}`);
}

function cssValue(block: string, token: string): string | null {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`${escaped}\\s*:\\s*([^;]+)`))?.[1].trim() ?? null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const sourceExt = ['.js', '.jsx', '.ts', '.tsx'].includes(extname(path));
    const testFile = entry.name.includes('.test.') || entry.name.includes('.spec.');
    if (!sourceExt || testFile) return [];
    return [path];
  });
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return null;
}

function rawLiteralFailures(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    const text = literalText(node);
    if (text && (RAW_COLOR.test(text) || /^(white|black)$/i.test(text.trim()))) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      failures.push(`${relative(REPO_ROOT, path)}:${line} ${text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return failures;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--([\s\S]*?)-->/g, '');
}

describe('shared theme tokens', () => {
  it('defines every light token once and overrides all theme-sensitive tokens in dark mode', () => {
    const css = readFileSync(THEME_PATH, 'utf8');
    const light = cssBlock(css, ':root');
    const dark = cssBlock(css, "[data-theme='dark']");
    const lightTokens = [...light.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
    const darkTokenList = [...dark.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
    const darkTokens = new Set(darkTokenList);
    const missingDark = lightTokens.filter((token) => !THEME_CONSTANT_TOKENS.has(token) && !darkTokens.has(token));
    const unknownDark = darkTokenList.filter((token) => !lightTokens.includes(token));
    const unknownConstants = [...THEME_CONSTANT_TOKENS].filter((token) => !lightTokens.includes(token));

    expect(new Set(lightTokens).size).toBe(lightTokens.length);
    expect(darkTokens.size).toBe(darkTokenList.length);
    expect(missingDark).toEqual([]);
    expect(unknownDark).toEqual([]);
    expect(unknownConstants).toEqual([]);
  });

  // A typo in a variant block is silent — the declaration just never reaches anything — so every
  // token an appearance variant overrides must already exist in the base palette.
  it('only overrides tokens the base palette defines from the appearance variant blocks', () => {
    const css = readFileSync(THEME_PATH, 'utf8');
    const base = new Set([...cssBlock(css, ':root').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const variants = [
      ":root[data-accent-intensity='soft']",
      ":root[data-accent-intensity='vivid']",
    ];

    for (const selector of variants) {
      const tokens = [...cssBlock(css, selector).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.filter((token) => !base.has(token))).toEqual([]);
    }
  });

  it('routes shared accent semantics through palette primitives', () => {
    const css = readFileSync(THEME_PATH, 'utf8');
    const blocks = [cssBlock(css, ':root'), cssBlock(css, "[data-theme='dark']")];
    const aliases = {
      '--proto-accent': '--accent-main',
      '--proto-accent-bg': '--accent-soft',
      '--proto-accent-border': '--accent-border',
      '--state-run': '--accent-main',
      '--pill-running-fg': '--accent-main',
      '--pill-running-bg': '--accent-soft',
      '--m-run': '--accent-main',
      '--m-run-bg': '--accent-soft',
      '--m-run-border': '--accent-border',
    };

    for (const block of blocks) {
      for (const [semantic, primitive] of Object.entries(aliases)) {
        expect(cssValue(block, semantic)).toBe(`var(${primitive})`);
      }
    }
  });

  it('loads the same palette from the SPA and both embedded shell pages', () => {
    for (const path of [
      join(WEB_ROOT, 'index.html'),
      join(REPO_ROOT, 'desktop', 'ui', 'connect.html'),
      join(REPO_ROOT, 'desktop', 'ui', 'setup.html'),
    ]) {
      const html = readFileSync(path, 'utf8');
      expect(html).toContain('href="/theme.css"');
      expect(html).toContain("localStorage.getItem('cortex.accent-hue')");
      expect(html).toContain("setAttribute('data-accent', 'custom')");
      expect(html).not.toMatch(/:root\s*\{/);
      expect(withoutComments(html)).not.toMatch(RAW_COLOR);
    }
  });

  it('keeps runtime UI color literals out of TypeScript and structural CSS', () => {
    const files = [
      ...sourceFiles(SRC_ROOT),
      join(WEB_ROOT, 'tailwind.config.ts'),
    ];
    const failures = files.flatMap(rawLiteralFailures);
    const structuralCss = withoutComments(readFileSync(join(SRC_ROOT, 'index.css'), 'utf8'));

    expect(failures).toEqual([]);
    expect(structuralCss).not.toMatch(RAW_COLOR);
  });
});
