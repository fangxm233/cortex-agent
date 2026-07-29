// input:  project markdown files + CLI args
// output: recommendation scan excluding private project notes
// pos:    recommendation/implied task extraction CLI
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as yamlParse } from 'yaml';
import { isMainModule, PROJECTS_DIR } from '@core/utils.js';
import { formatHelp } from '@core/cli-utils.js';
import type {
  RecommendationSection, Recommendation, TaskCandidate, ReflectionField,
  ImpliedTaskMatch, ScanSummary, ScanResult, CliOptions, CliResult,
} from './types.js';
import {
  RECOMMENDATION_HEADER_RE, ANTI_RECOMMENDATION_HEADERS, IMPLIED_TASK_PATTERNS,
  ACTION_VERBS, NEGATIVE_PATTERNS, STOP_WORDS,
  EXP_HEADER_RE, DATE_RE, REFLECTION_FIELDS_RE, FINDINGS_HEADER_RE,
} from './patterns.js';

function daysAgoIso(days: number): string {
  const value = new Date();
  value.setDate(value.getDate() - days);
  return value.toISOString().slice(0, 10);
}

function extractRecommendationSections(content: string, sourceFile: string): RecommendationSection[] {
  const lines = content.split('\n');
  const sections: RecommendationSection[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(RECOMMENDATION_HEADER_RE);
    if (!match) continue;

    const headerLevel = match[1].length;
    const header = match[2].trim();
    const bodyLines = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextMatch = lines[j].match(/^(#{2,4})\s+/);
      if (nextMatch && nextMatch[1].length <= headerLevel) break;
      bodyLines.push(lines[j]);
    }

    const body = bodyLines.join('\n').trim();
    if (body) {
      sections.push({ header, body, source_file: sourceFile });
    }
  }

  return sections;
}

const LIST_ITEM_RE = /^(?:\d+\.\s+|- \[[ x]\]\s+|- )/;

function makeRecommendation(text: string, sourceId: string, sectionHeader: string, sourceFile: string): Recommendation {
  return { source_id: sourceId, section_header: sectionHeader, text: text.trim(), source_file: sourceFile };
}

function parseRecommendations(body: string, sourceId: string, sectionHeader: string, sourceFile: string): Recommendation[] {
  if (!body.trim()) return [];
  const recommendations: Recommendation[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current != null) recommendations.push(makeRecommendation(current, sourceId, sectionHeader, sourceFile));
    current = null;
  };
  for (const line of body.split('\n')) {
    if (LIST_ITEM_RE.test(line)) {
      flush();
      current = line.replace(LIST_ITEM_RE, '').trim();
      continue;
    }
    if (current != null && /^\s+\S/.test(line)) { current += ` ${line.trim()}`; continue; }
    if (current != null && line.trim() === '') continue;
    if (current != null) flush();
  }
  flush();
  return recommendations;
}

const REFLECTION_SKIP_EXACT = new Set(['无', 'N/A', '无需调整', '已对齐', '无特别调整']);

function matchReflectionField(line: string, currentExpId: string, currentDate: string | null, sourceFile: string): ReflectionField | null {
  const trimmed = line.trim();
  for (const [fieldName, pattern] of Object.entries(REFLECTION_FIELDS_RE)) {
    const m = trimmed.match(pattern);
    if (!m) continue;
    let text = m[1].trim();
    if (REFLECTION_SKIP_EXACT.has(text)) return null;
    if (text.startsWith('无。') || text.startsWith('无，') || text.startsWith('无需')) return null;
    text = text.replace(/\s*---\s*$/, '');
    return { experiment_id: currentExpId, field_name: fieldName, content: text, experiment_date: currentDate, source_file: sourceFile };
  }
  return null;
}

function extractReflectionFields(content: string, sourceFile: string, days: number = 7): ReflectionField[] {
  const cutoff = daysAgoIso(days);
  const results: ReflectionField[] = [];
  let currentExpId: string | null = null;
  let currentDate: string | null = null;
  for (const line of content.split('\n')) {
    const expMatch = line.match(EXP_HEADER_RE);
    if (expMatch) { currentExpId = expMatch[1]; currentDate = null; continue; }
    const dateMatch = line.match(DATE_RE);
    if (dateMatch && currentExpId) { currentDate = dateMatch[1]; continue; }
    if (currentDate && currentDate < cutoff) continue;
    if (!currentExpId) continue;
    const field = matchReflectionField(line, currentExpId, currentDate, sourceFile);
    if (field) results.push(field);
  }
  return results;
}

function detectImpliedTaskPatterns(findingText: string, sourceId: string, sourceFile: string): ImpliedTaskMatch[] {
  const results: ImpliedTaskMatch[] = [];
  for (const entry of IMPLIED_TASK_PATTERNS) {
    for (const signal of entry.signals) {
      if (signal.test(findingText)) {
        results.push({
          pattern: entry.pattern,
          finding_text: findingText.slice(0, 200),
          source_id: sourceId,
          suggested_task_type: entry.suggested_task_type,
          source_file: sourceFile,
        });
        break;
      }
    }
  }
  return results;
}

function flushConclusion(results: ImpliedTaskMatch[], currentDate: string | null, cutoff: string, currentExpId: string | null, conclusionLines: string[], sourceFile: string): void {
  if (!currentExpId || conclusionLines.length === 0) return;
  if (currentDate && currentDate < cutoff) return;
  const text = conclusionLines.join('\n').trim();
  if (!text) return;
  results.push(...detectImpliedTaskPatterns(text, currentExpId, sourceFile));
}

interface ImpliedScanState {
  currentExpId: string | null;
  currentDate: string | null;
  inConclusion: boolean;
  conclusionLevel: number;
  conclusionLines: string[];
}

function processExperimentLine(line: string, state: ImpliedScanState, results: ImpliedTaskMatch[], cutoff: string, sourceFile: string): void {
  const expMatch = line.match(EXP_HEADER_RE);
  if (expMatch) {
    flushConclusion(results, state.currentDate, cutoff, state.currentExpId, state.conclusionLines, sourceFile);
    state.currentExpId = expMatch[1]; state.currentDate = null; state.inConclusion = false; state.conclusionLines = [];
    return;
  }
  const dateMatch = line.match(DATE_RE);
  if (dateMatch && state.currentExpId) { state.currentDate = dateMatch[1]; return; }
  const conclusionMatch = line.match(FINDINGS_HEADER_RE);
  if (conclusionMatch) {
    flushConclusion(results, state.currentDate, cutoff, state.currentExpId, state.conclusionLines, sourceFile);
    state.inConclusion = true; state.conclusionLevel = conclusionMatch[1].length; state.conclusionLines = [];
    return;
  }
  if (!state.inConclusion) return;
  const headerMatch = line.match(/^(#{2,4})\s+/);
  if (headerMatch && headerMatch[1].length <= state.conclusionLevel) {
    flushConclusion(results, state.currentDate, cutoff, state.currentExpId, state.conclusionLines, sourceFile);
    state.inConclusion = false; state.conclusionLines = [];
    return;
  }
  state.conclusionLines.push(line);
}

function extractImpliedTasksFromExperiments(content: string, sourceFile: string, days: number = 7): ImpliedTaskMatch[] {
  const cutoff = daysAgoIso(days);
  const results: ImpliedTaskMatch[] = [];
  const state: ImpliedScanState = { currentExpId: null, currentDate: null, inConclusion: false, conclusionLevel: 0, conclusionLines: [] };
  for (const line of content.split('\n')) {
    processExperimentLine(line, state, results, cutoff, sourceFile);
  }
  flushConclusion(results, state.currentDate, cutoff, state.currentExpId, state.conclusionLines, sourceFile);
  return results;
}

function isActionable(text: string): boolean {
  for (const pattern of NEGATIVE_PATTERNS) {
    if (pattern.test(text)) return false;
  }

  const firstWord = (text.split(/\s+/)[0] || '').toLowerCase().replace(/[.,;:]+$/, '').replace(/[^a-z]/g, '');
  if (ACTION_VERBS.has(firstWord)) return true;

  for (const sentence of text.split(/[.;]\s+/)) {
    const word = (sentence.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[.,;:]+$/, '').replace(/[^a-z]/g, '');
    if (ACTION_VERBS.has(word)) return true;
  }

  return false;
}

function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  );
}

function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((value) => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function deduplicateCandidates(candidates: TaskCandidate[], existingTasksContent: string): TaskCandidate[] {
  let existingTasks: { text: string; why: string; textKeywords: Set<string> }[] = [];
  try {
    const parsed = yamlParse(existingTasksContent);
    if (parsed && Array.isArray(parsed.tasks)) {
      existingTasks = parsed.tasks.map((t: any) => ({
        text: String(t.text ?? ''),
        why: String(t.why ?? ''),
        textKeywords: extractKeywords(String(t.text ?? '')),
      }));
    }
  } catch {
    // If YAML parsing fails, fall back to no dedup (content is corrupt/missing)
  }

  for (const candidate of candidates) {
    if (candidate.source_id && existingTasksContent.includes(candidate.source_id)) {
      candidate.is_duplicate = true;
      candidate.duplicate_of = `source-id match: ${candidate.source_id}`;
      continue;
    }

    if (candidate.is_duplicate) continue;

    const candidateKeywords = extractKeywords(candidate.text);
    for (const existing of existingTasks) {
      if (keywordOverlap(candidateKeywords, existing.textKeywords) > 0.5) {
        candidate.is_duplicate = true;
        candidate.duplicate_of = `keyword overlap: ${existing.text.slice(0, 80)}`;
        break;
      }
    }
  }

  return candidates;
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

function truncate(text: string, maxLen: number = 120): string {
  const cleaned = cleanMarkdown(text);
  const first = cleaned.match(/^[^.]+(?:\.|$)/);
  let summary = (first ? first[0] : cleaned).trim();
  if (summary) {
    summary = summary[0].toUpperCase() + summary.slice(1);
  }
  summary = summary.replace(/\.$/, '');
  return summary.length > maxLen ? `${summary.slice(0, maxLen - 3)}...` : summary;
}

function summarize(text: string, maxLen: number = 80): string {
  const cleaned = cleanMarkdown(text);
  const first = cleaned.match(/^[^.]+(?:\.|$)/);
  const summary = (first ? first[0] : cleaned).replace(/\.$/, '');
  return summary.length > maxLen ? `${summary.slice(0, maxLen - 3)}...` : summary;
}

function recommendationToCandidate(recommendation: Recommendation): TaskCandidate | null {
  if (ANTI_RECOMMENDATION_HEADERS.has(recommendation.section_header.toLowerCase())) return null;
  if (!isActionable(recommendation.text)) return null;
  return {
    text: truncate(recommendation.text),
    why: `From ${recommendation.source_id} — ${summarize(recommendation.text)}`,
    done_when: `${truncate(recommendation.text, 100)} is complete and verified`,
    source_id: recommendation.source_id,
    source_type: 'recommendation',
    pattern: undefined,
    is_duplicate: false,
    duplicate_of: undefined,
    source_file: recommendation.source_file,
  };
}

function impliedTaskToCandidate(task: ImpliedTaskMatch): TaskCandidate {
  const descriptions: Record<string, string> = {
    'failed-success-criterion': 'Investigate failed success criterion and redesign experiment protocol',
    'insufficient-sample': 'Run larger-scale replication with sufficient sample size',
    'identified-confound': 'Design controlled follow-up experiment to isolate confound',
    'partial-confirmation': 'Refine hypothesis and run targeted investigation',
    'unexplained-result': 'Investigate unexplained result and diagnose root cause',
    'multi-phase-plan': 'Verify all phases have corresponding TASKS.yaml entries',
  };
  const description = descriptions[task.pattern] || task.suggested_task_type;
  const preview = task.finding_text.slice(0, 80).replace(/\n/g, ' ');
  return {
    text: `${description} (${task.source_id})`,
    why: `From ${task.source_id} — "${preview}..."`,
    done_when: `${task.suggested_task_type} is complete and verified`,
    source_id: task.source_id,
    source_type: 'implied-task',
    pattern: task.pattern,
    is_duplicate: false,
    duplicate_of: undefined,
    source_file: task.source_file,
  };
}

function reflectionToCandidate(field: ReflectionField): TaskCandidate {
  if (field.field_name === '行为调整') {
    return {
      text: `Apply behavior adjustment from ${field.experiment_id}: ${truncate(field.content, 80)}`,
      why: `From ${field.experiment_id} Reflection.行为调整`,
      done_when: 'Adjustment applied or integrated into convention/skill',
      source_id: field.experiment_id,
      source_type: 'reflection',
      pattern: 'behavior-adjustment',
      is_duplicate: false,
      duplicate_of: undefined,
      source_file: field.source_file,
    };
  }

  return {
    text: `Address process defect from ${field.experiment_id}: ${truncate(field.content, 80)}`,
    why: `From ${field.experiment_id} Reflection.过程缺陷`,
    done_when: 'Defect addressed or mitigation documented',
    source_id: field.experiment_id,
    source_type: 'reflection',
    pattern: 'process-defect',
    is_duplicate: false,
    duplicate_of: undefined,
    source_file: field.source_file,
  };
}

function extractSourceId(filePath: string): string {
  const parts = filePath.split(path.sep);
  const name = path.parse(filePath).name;
  if (name === 'EXPERIMENTS') {
    const projectIndex = parts.indexOf('projects');
    if (projectIndex !== -1 && projectIndex + 1 < parts.length) {
      return `${parts[projectIndex + 1]}/EXPERIMENTS`;
    }
  }
  return name;
}

function emptyResult(): ScanResult {
  return {
    candidates: [],
    reflection_fields: [],
    scan_summary: {
      files_scanned: 0,
      recommendations_found: 0,
      implied_tasks_found: 0,
      reflection_fields_found: 0,
      total_candidates: 0,
      actionable: 0,
      duplicates: 0,
      new_candidates: 0,
    },
  };
}

interface ScanAccumulator {
  candidates: TaskCandidate[];
  reflections: ReflectionField[];
  implied: ImpliedTaskMatch[];
  recommendations: Recommendation[];
  filesScanned: number;
}

const SKIP_PROJECT_MD_FILES = new Set(['TASKS.yaml', 'EXPERIMENTS.md', 'STATUS.md', 'KNOWLEDGE.md', 'experiments-archive.md', 'mission.md', 'roadmap.md', 'CLAUDE.md', 'NOTES.md']);

function collectProjectDirs(projectsDir: string, project: string | null): [string, string][] {
  const dirs: [string, string][] = [];
  const names = project ? [project] : fs.readdirSync(projectsDir).sort();
  for (const name of names) {
    const projectPath = path.join(projectsDir, name);
    if (fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()) dirs.push([name, projectPath]);
  }
  return dirs;
}

function collectRecommendationsFromSections(content: string, filePath: string, sourceId: string, acc: ScanAccumulator): void {
  for (const section of extractRecommendationSections(content, filePath)) {
    const recs = parseRecommendations(section.body, sourceId, section.header, filePath);
    acc.recommendations.push(...recs);
    for (const rec of recs) {
      const candidate = recommendationToCandidate(rec);
      if (candidate) acc.candidates.push(candidate);
    }
  }
}

function scanExperimentsFile(projectName: string, projectPath: string, acc: ScanAccumulator, days: number): void {
  const experimentsPath = path.join(projectPath, 'EXPERIMENTS.md');
  if (!fs.existsSync(experimentsPath) || !fs.statSync(experimentsPath).isFile()) return;
  acc.filesScanned += 1;
  const content = fs.readFileSync(experimentsPath, 'utf8');
  acc.reflections.push(...extractReflectionFields(content, experimentsPath, days));
  const implied = extractImpliedTasksFromExperiments(content, experimentsPath, days);
  acc.implied.push(...implied);
  acc.candidates.push(...implied.map(impliedTaskToCandidate));
  collectRecommendationsFromSections(content, experimentsPath, `${projectName}/EXPERIMENTS`, acc);
}

function scanMiscProjectFiles(projectPath: string, acc: ScanAccumulator): void {
  for (const fileName of fs.readdirSync(projectPath).sort()) {
    if (!fileName.endsWith('.md') || SKIP_PROJECT_MD_FILES.has(fileName)) continue;
    const filePath = path.join(projectPath, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    acc.filesScanned += 1;
    const content = fs.readFileSync(filePath, 'utf8');
    collectRecommendationsFromSections(content, filePath, extractSourceId(filePath), acc);
  }
}

function applyProjectsDeduplication(projectDirs: [string, string][], candidates: TaskCandidate[]): void {
  for (const [, projectPath] of projectDirs) {
    const tasksPath = path.join(projectPath, 'TASKS.yaml');
    if (!fs.existsSync(tasksPath) || !fs.statSync(tasksPath).isFile()) continue;
    deduplicateCandidates(candidates, fs.readFileSync(tasksPath, 'utf8'));
  }
}

function buildScanResult(acc: ScanAccumulator): ScanResult {
  const actionableCount = acc.candidates.filter((c) => !c.is_duplicate).length;
  const duplicateCount = acc.candidates.filter((c) => c.is_duplicate).length;
  return {
    candidates: acc.candidates,
    reflection_fields: acc.reflections,
    scan_summary: {
      files_scanned: acc.filesScanned,
      recommendations_found: acc.recommendations.length,
      implied_tasks_found: acc.implied.length,
      reflection_fields_found: acc.reflections.length,
      total_candidates: acc.candidates.length,
      actionable: actionableCount,
      duplicates: duplicateCount,
      new_candidates: actionableCount,
    },
  };
}

function scanProjectRecommendations(_baseDir: string, project: string | null = null, days: number = 7): ScanResult {
  const projectsDir = PROJECTS_DIR;
  if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) return emptyResult();
  const projectDirs = collectProjectDirs(projectsDir, project);
  const acc: ScanAccumulator = { candidates: [], reflections: [], implied: [], recommendations: [], filesScanned: 0 };
  for (const [projectName, projectPath] of projectDirs) {
    scanExperimentsFile(projectName, projectPath, acc, days);
    scanMiscProjectFiles(projectPath, acc);
  }
  applyProjectsDeduplication(projectDirs, acc.candidates);
  return buildScanResult(acc);
}

function formatScanSummary(summary: ScanSummary): string[] {
  return [
    'Recommendation Extractor Scan',
    '='.repeat(50),
    `Files scanned:      ${summary.files_scanned}`,
    `Recommendations:    ${summary.recommendations_found}`,
    `Implied tasks:      ${summary.implied_tasks_found}`,
    `Reflection fields:  ${summary.reflection_fields_found}`,
    `Total candidates:   ${summary.total_candidates}`,
    `  New (actionable): ${summary.new_candidates}`,
    `  Duplicates:       ${summary.duplicates}`,
  ];
}

function formatReflectionSection(fields: ReflectionField[]): string[] {
  if (fields.length === 0) return [];
  const lines = [`\n${'─'.repeat(50)}`, 'Reflection Fields', '─'.repeat(50)];
  for (const field of fields) {
    lines.push(`\n  [${field.experiment_id}] ${field.field_name}:`);
    lines.push(`    ${field.content.slice(0, 120)}`);
  }
  return lines;
}

function formatCandidatesSection(candidates: TaskCandidate[]): string[] {
  const fresh = candidates.filter((c) => !c.is_duplicate);
  if (fresh.length === 0) return [];
  const lines = [`\n${'─'.repeat(50)}`, 'New Task Candidates', '─'.repeat(50)];
  fresh.forEach((candidate, index) => {
    lines.push(`\n  ${index + 1}. - [ ] ${candidate.text}`.trimEnd());
    lines.push(`     Why: ${candidate.why}`);
    lines.push(`     Done when: ${candidate.done_when}`);
  });
  return lines;
}

function formatHumanReadable(result: ScanResult): string {
  return [
    ...formatScanSummary(result.scan_summary),
    ...formatReflectionSection(result.reflection_fields),
    ...formatCandidatesSection(result.candidates),
  ].join('\n');
}

function parseCli(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'base-dir': { type: 'string', default: path.join(os.homedir(), 'Cortex') },
      project: { type: 'string' },
      days: { type: 'string', default: '7' },
      json: { type: 'boolean', default: false },
    },
  });
  const values = parsed.values;
  return {
    baseDir: values['base-dir'] as string,
    project: (values.project as string) || null,
    days: Number(values.days || '7'),
    json: values.json as boolean,
  };
}

function getExtractorHelp(): string {
  return formatHelp({
    name: 'recommendation-extractor',
    description: 'Scan project markdown for unactioned recommendations and implied tasks',
    usage: 'recommendation-extractor [options]',
    options: [
      { flag: '--project <name>', description: 'Filter by project name (scans all if omitted)' },
      { flag: '--days <n>', description: 'Look back N days', default: '7' },
      { flag: '--json', description: 'Output as JSON instead of human-readable', default: 'false' },
      { flag: '--base-dir <path>', description: 'Cortex root directory', default: '~/Cortex' },
      { flag: '--help', description: 'Show this help message' },
    ],
    examples: [
      { description: 'Scan all projects for recommendations', command: 'recommendation-extractor --json' },
      { description: 'Scan a specific project, last 14 days', command: 'recommendation-extractor --project example-project --days 14 --json' },
      { description: 'Human-readable report for all projects', command: 'recommendation-extractor' },
    ],
  });
}

function runCli(argv: string[]): CliResult {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { exitCode: 0, stdout: getExtractorHelp(), stderr: '' };
  }
  try {
    const options = parseCli(argv);
    if (!Number.isFinite(options.days) || options.days < 0) {
      return { exitCode: 1, stdout: '', stderr: 'Invalid --days value\n' };
    }
    const result = scanProjectRecommendations(options.baseDir, options.project, options.days);
    const stdout = options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatHumanReadable(result)}\n`;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${(error as Error).message}\n` };
  }
}

function main(): void {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}

export {
  extractRecommendationSections,
  parseRecommendations,
  extractReflectionFields,
  extractImpliedTasksFromExperiments,
  recommendationToCandidate,
  impliedTaskToCandidate,
  reflectionToCandidate,
  deduplicateCandidates,
  scanProjectRecommendations,
  runCli,
};
