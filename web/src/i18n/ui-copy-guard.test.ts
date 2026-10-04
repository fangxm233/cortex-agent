// Keeps every user-visible string in the shared vocab under src/i18n. Outside this directory it
// rejects local { en, zh } copy tables, language branches that pick strings, CJK literals, and
// English JSX text / visible attribute literals that are not in the short allowlist below.
// UI_COPY_SCOPE=features/foo,mobile/screens narrows the scan to path prefixes under src/.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '..');
const SKIP = /(\.test\.|\.d\.ts$|(^|\/)__fixtures__\/|^dev\/|^i18n\/|\.browser\.tsx$)/;
// CJK ideographs plus CJK / full-width punctuation; the full-width plus used as an icon is excluded.
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff01-\uff0a\uff0c-\uffef]/;
const LETTER = /[A-Za-z\u3400-\u9fff]/;
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;
// Brand / product names, literal technical values, key hints and single-glyph icons.
const ALLOWED = new Set([
  'Cortex', 'Claude Code', 'PI', 'Slack', 'Lark', 'Feishu', 'EN', '中', '飞', 'P', 'Q',
  'esc', '⌘N', 'print', 'tui', 'stdout', 'stderr',
]);
const VISIBLE_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'aria-description']);
// `label` on these frames is a design-spec screen id rendered only as data-screen-label.
const SCREEN_FRAMES = new Set(['MScreen', 'MSettingsFrame']);
const UI_SINKS = new Set(['toast', 'addToast', 'notify', 'confirm', 'alert', 'prompt']);

interface Hit { file: string; line: number; kind: string; text: string }

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function stringParts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
  return [];
}

function isCopy(text: string): boolean {
  const trimmed = text.replace(/&\w+;/g, '').trim();
  return LETTER.test(trimmed) && !ALLOWED.has(trimmed) && !LOCALE.test(trimmed);
}

function isLangCompare(node: ts.Node): boolean {
  if (!ts.isBinaryExpression(node)) return false;
  const op = node.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return false;
  return [node.left, node.right].some((side) => ts.isStringLiteral(side) && (side.text === 'zh' || side.text === 'en'));
}

function containsCopyLiteral(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (stringParts(n).some(isCopy)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

function calleeName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function scanFile(file: string): Hit[] {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const add = (node: ts.Node, kind: string, text: string) => hits.push({
    file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind, text: text.trim().slice(0, 70),
  });
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map((p) => (p.name ? p.name.getText(sf).replace(/['"]/g, '') : ''));
      if (names.includes('en') && names.includes('zh')) { add(node, 'local en/zh table', names.join(',')); return; }
    }
    if (isLangCompare(node)) {
      const parent = node.parent;
      if (ts.isConditionalExpression(parent) && parent.condition === node
        && (containsCopyLiteral(parent.whenTrue) || containsCopyLiteral(parent.whenFalse))) {
        add(node, 'language branch', parent.getText(sf));
      } else if (ts.isIfStatement(parent) && parent.expression === node && containsCopyLiteral(parent)) {
        add(node, 'language branch', parent.getText(sf));
      }
    }
    for (const part of stringParts(node)) {
      if (CJK.test(part) && !ALLOWED.has(part.trim())) add(node, 'CJK literal', part);
    }
    if (ts.isJsxText(node) && isCopy(node.text)) add(node, 'JSX text', node.text);
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)
      && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))
      && isCopy(node.expression.text)) add(node, 'JSX string child', node.expression.text);
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      const tag = (node.parent.parent as ts.JsxOpeningLikeElement).tagName.getText(sf);
      const screenId = name === 'label' && SCREEN_FRAMES.has(tag);
      if (VISIBLE_ATTRS.has(name) && !screenId && isCopy(node.initializer.text)) add(node, `attr ${name}`, node.initializer.text);
    }
    if (ts.isCallExpression(node) && UI_SINKS.has(calleeName(node) ?? '')
      && node.arguments.some((arg) => stringParts(arg).some(isCopy))) add(node, 'UI message literal', node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function scan(): Hit[] {
  const scope = (process.env.UI_COPY_SCOPE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return listFiles(SRC)
    .filter((file) => {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      return !SKIP.test(rel) && (scope.length === 0 || scope.some((prefix) => rel.startsWith(prefix)));
    })
    .flatMap(scanFile);
}

describe('UI copy lives in the shared vocab', () => {
  it('has no local copy tables, language branches or hard-coded visible text outside src/i18n', () => {
    const hits = scan();
    const report = hits.map((h) => `${h.file}:${h.line} [${h.kind}] ${h.text.replace(/\s+/g, ' ')}`);
    expect(report).toEqual([]);
  });
});
