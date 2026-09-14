import { readFileSync } from 'fs';
import * as path from 'path';
import { createLogger } from '@core/log.js';

const log = createLogger('template-resolver');

interface Frontmatter {
  extends?: string;
  vars: Record<string, string>;
}

interface FillBlock {
  name: string;
  content: string;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter | null; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return { frontmatter: null, body: content };

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: null, body: content };

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).replace(/^\n/, '');

  const vars: Record<string, string> = {};
  let extendsValue: string | undefined;

  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^["'](.*)["']$/, '$1');
    if (key === 'extends') {
      extendsValue = value;
    } else {
      vars[key] = value;
    }
  }

  return {
    frontmatter: { extends: extendsValue, vars },
    body,
  };
}

function parseFillBlocks(body: string): FillBlock[] {
  const fills: FillBlock[] = [];
  const re = /^@fill\((\w[\w-]*)\)\s*\n([\s\S]*?)^@endfill\s*$/gm;
  let match;
  while ((match = re.exec(body)) !== null) {
    fills.push({ name: match[1], content: match[2].replace(/\n$/, '') });
  }
  return fills;
}

function resolveBlocks(template: string, fills: FillBlock[]): string {
  const fillMap = new Map(fills.map(f => [f.name, f.content]));
  return template.replace(
    /^@block\((\w[\w-]*)\)\s*\n([\s\S]*?)^@endblock\s*$/gm,
    (_match, name: string, defaultContent: string) => {
      const fill = fillMap.get(name);
      return fill !== undefined ? fill : defaultContent.replace(/\n$/, '');
    },
  );
}

function resolveVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{(\w[\w-]*)(?::-([^}]*))?\}/g, (_match, name: string, defaultVal?: string) => {
    if (name in vars) return vars[name];
    if (defaultVal !== undefined) return defaultVal;
    return '';
  });
}

function resolveConditionals(text: string, vars: Record<string, string>): string {
  // @if(!var)...@endif
  text = text.replace(/^@if\(!(\w[\w-]*)\)\s*\n([\s\S]*?)^@endif\s*\n?/gm, (_match, name: string, content: string) => {
    const hasValue = name in vars && vars[name] !== '';
    return hasValue ? '' : content;
  });
  // @if(var)...@endif
  text = text.replace(/^@if\((\w[\w-]*)\)\s*\n([\s\S]*?)^@endif\s*\n?/gm, (_match, name: string, content: string) => {
    const hasValue = name in vars && vars[name] !== '';
    return hasValue ? content : '';
  });
  return text;
}

export function resolveTemplate(content: string, templateDir: string): string {
  const { frontmatter, body } = parseFrontmatter(content);

  if (!frontmatter || !frontmatter.extends) {
    return frontmatter ? body : content;
  }

  const templatePath = path.join(templateDir, frontmatter.extends);
  let template: string;
  try {
    template = readFileSync(templatePath, 'utf8');
  } catch (e: any) {
    log.error(`Failed to read template "${frontmatter.extends}": ${e.message}`);
    return body;
  }

  const fills = parseFillBlocks(body);
  let result = resolveBlocks(template, fills);
  result = resolveConditionals(result, frontmatter.vars);
  result = resolveVariables(result, frontmatter.vars);

  return result;
}
