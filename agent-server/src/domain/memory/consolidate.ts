import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from '@core/paths.js';
import { listMemoryProjects, loadRefStats, scanAtomicFiles, stringList, type RefStats } from './index-regen.js';

// --- Types ---

interface ConsolidationCandidate {
  type: 'tag-cluster' | 'link-cluster' | 'supersede-chain';
  project: string;
  tags?: string[];
  experiments: string[];
  existingPatterns: string[];
  reason: string;
}

interface ContradictionCandidate {
  /** The K/PAT entry whose evidence is compromised */
  entryId: string;
  entryFile: string;
  entryType: 'knowledge' | 'pattern';
  project: string;
  /** Source experiments that are invalidated/superseded */
  compromisedSources: { id: string; status: string }[];
  /** Source experiments still active */
  remainingSources: string[];
  /** How severe: 'all-compromised' (no remaining evidence) | 'partial' (some evidence remains) */
  severity: 'all-compromised' | 'partial';
  reason: string;
}

interface StaleCandidate {
  entryId: string;
  entryFile: string;
  entryType: 'experiment' | 'knowledge' | 'pattern';
  project: string;
  ageDays: number;
  refs: number;
  reason: string;
}

interface AntiPatternCandidate {
  project: string;
  /** The recurring deficiency description (approximate) */
  pattern: string;
  /** Experiments that share this deficiency */
  experiments: string[];
  reason: string;
}

export interface ProjectReport {
  project: string;
  experimentCount: number;
  knowledgeCount: number;
  patternCount: number;
  consolidation: ConsolidationCandidate[];
  contradictions: ContradictionCandidate[];
  stale: StaleCandidate[];
  antiPatterns: AntiPatternCandidate[];
}

// --- Helpers ---

const INACTIVE_STATUSES = ['superseded', 'deprecated', 'invalidated'];

function isInactiveStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return INACTIVE_STATUSES.some(prefix => s.startsWith(prefix));
}

function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(String(dateStr));
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 86400000;
}

// --- Detector 1: Tag co-occurrence (unchanged logic) ---

function detectTagClusters(projectName: string, experiments: ReturnType<typeof scanAtomicFiles>, patterns: ReturnType<typeof scanAtomicFiles>): ConsolidationCandidate[] {
  const candidates: ConsolidationCandidate[] = [];
  const activeExps = experiments.filter(e => !isInactiveStatus(e.meta.status as string));

  const tagToExps = new Map<string, string[]>();
  for (const exp of activeExps) {
    for (const tag of stringList(exp.meta.tags)) {
      const normalized = tag.toLowerCase().trim();
      if (!normalized) continue;
      if (!tagToExps.has(normalized)) tagToExps.set(normalized, []);
      tagToExps.get(normalized)!.push(exp.id);
    }
  }

  const patternTagSets = patterns.map(pat => ({
    id: pat.id,
    tags: new Set(stringList(pat.meta.tags).map(t => t.toLowerCase())),
  }));

  const tagList = [...tagToExps.keys()].filter(t => (tagToExps.get(t)?.length ?? 0) >= 2);
  const seenClusters = new Set<string>();

  for (let i = 0; i < tagList.length; i++) {
    for (let j = i + 1; j < tagList.length; j++) {
      const tagA = tagList[i];
      const tagB = tagList[j];
      const expsA = new Set(tagToExps.get(tagA)!);
      const shared = tagToExps.get(tagB)!.filter(id => expsA.has(id));
      if (shared.length < 3) continue;

      const clusterKey = [...shared].sort().join(',');
      if (seenClusters.has(clusterKey)) continue;
      seenClusters.add(clusterKey);

      const existingPats = patternTagSets
        .filter(p => p.tags.has(tagA) && p.tags.has(tagB))
        .map(p => p.id);

      candidates.push({
        type: 'tag-cluster', project: projectName,
        tags: [tagA, tagB], experiments: shared,
        existingPatterns: existingPats,
        reason: `${shared.length} experiments share tags [${tagA}, ${tagB}]`,
      });
    }
  }

  return candidates;
}

// --- Detector 2: Link graph connected components ---

function detectLinkClusters(projectName: string, experiments: ReturnType<typeof scanAtomicFiles>): ConsolidationCandidate[] {
  const candidates: ConsolidationCandidate[] = [];
  const activeExps = experiments.filter(e => !isInactiveStatus(e.meta.status as string));

  const linkGraph = new Map<string, Set<string>>();
  for (const exp of activeExps) {
    const links = stringList(exp.meta.links);
    if (links.length === 0) continue;
    if (!linkGraph.has(exp.id)) linkGraph.set(exp.id, new Set());
    for (const link of links) {
      linkGraph.get(exp.id)!.add(link.toUpperCase().trim());
    }
  }

  const visited = new Set<string>();
  for (const [startId] of linkGraph) {
    if (visited.has(startId)) continue;
    const component: string[] = [];
    const queue = [startId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      const neighbors = linkGraph.get(current);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n) && linkGraph.has(n)) queue.push(n);
        }
      }
    }
    if (component.length >= 3) {
      candidates.push({
        type: 'link-cluster', project: projectName,
        experiments: component, existingPatterns: [],
        reason: `${component.length} experiments form a connected link cluster`,
      });
    }
  }

  return candidates;
}

// --- Detector 3: Supersession chains ---

function detectSupersedeChains(projectName: string, experiments: ReturnType<typeof scanAtomicFiles>): ConsolidationCandidate[] {
  const candidates: ConsolidationCandidate[] = [];
  const supersedeNext = new Map<string, string>();

  for (const exp of experiments) {
    const status = String(exp.meta.status || '');
    const match = status.match(/^(?:superseded|refined):(.+)/i);
    if (match) {
      supersedeNext.set(exp.id.toUpperCase(), match[1].toUpperCase().trim());
    }
  }

  const allNewIds = new Set(supersedeNext.values());
  const roots = [...supersedeNext.keys()].filter(id => !allNewIds.has(id));

  for (const root of roots) {
    const chain: string[] = [root];
    let current = root;
    while (supersedeNext.has(current)) {
      current = supersedeNext.get(current)!;
      chain.push(current);
      if (chain.length > 20) break;
    }
    if (chain.length >= 3) {
      candidates.push({
        type: 'supersede-chain', project: projectName,
        experiments: chain, existingPatterns: [],
        reason: `Supersession chain of length ${chain.length}: ${chain.join(' → ')}`,
      });
    }
  }

  return candidates;
}

// --- Detector 4: Contradiction — K/PAT entries whose evidence experiments are invalidated ---

function detectContradictions(
  projectName: string,
  experiments: ReturnType<typeof scanAtomicFiles>,
  knowledge: ReturnType<typeof scanAtomicFiles>,
  patterns: ReturnType<typeof scanAtomicFiles>,
): ContradictionCandidate[] {
  const candidates: ContradictionCandidate[] = [];

  // Build experiment status lookup
  const expStatus = new Map<string, string>();
  for (const exp of experiments) {
    expStatus.set(exp.id.toUpperCase(), String(exp.meta.status || 'active').toLowerCase());
  }

  // Check K and PAT entries that have evidence/source-experiments fields
  const derivedEntries = [
    ...knowledge.map(k => ({ ...k, entryType: 'knowledge' as const, dir: 'knowledge' })),
    ...patterns.map(p => ({ ...p, entryType: 'pattern' as const, dir: 'patterns' })),
  ];

  for (const entry of derivedEntries) {
    // Collect source experiment IDs from evidence, source-experiments, or source fields
    const sourceIds: string[] = [];
    for (const field of ['evidence', 'source-experiments', 'source']) {
      const val = entry.meta[field];
      if (Array.isArray(val)) {
        sourceIds.push(...stringList(val).map(s => s.toUpperCase().trim()));
      } else if (typeof val === 'string') {
        // Parse "EXP-001, EXP-003" format
        const matches = String(val).matchAll(/EXP-\d+/gi);
        for (const m of matches) sourceIds.push(m[0].toUpperCase());
      }
    }

    if (sourceIds.length === 0) continue;

    const compromised: { id: string; status: string }[] = [];
    const remaining: string[] = [];

    for (const srcId of sourceIds) {
      const status = expStatus.get(srcId);
      if (!status) continue; // experiment not found, might be cross-project ref
      if (isInactiveStatus(status)) {
        compromised.push({ id: srcId, status });
      } else {
        remaining.push(srcId);
      }
    }

    if (compromised.length === 0) continue;

    const severity = remaining.length === 0 ? 'all-compromised' : 'partial';
    candidates.push({
      entryId: entry.id,
      entryFile: `${entry.dir}/${entry.filename}`,
      entryType: entry.entryType,
      project: projectName,
      compromisedSources: compromised,
      remainingSources: remaining,
      severity,
      reason: severity === 'all-compromised'
        ? `${entry.id} has NO remaining valid evidence (all sources invalidated/superseded)`
        : `${entry.id} has ${compromised.length}/${sourceIds.length} sources compromised`,
    });
  }

  return candidates;
}

// --- Detector 5: Staleness — entries with refs=0 and age > threshold ---
// Refs come from the access log (the index generator reads the same source); the `refs:` field some
// older atomic files still carry is no longer maintained.

function detectStale(
  projectName: string,
  experiments: ReturnType<typeof scanAtomicFiles>,
  knowledge: ReturnType<typeof scanAtomicFiles>,
  patterns: ReturnType<typeof scanAtomicFiles>,
  refStats: Map<string, RefStats>,
  thresholdDays: number = 30,
): StaleCandidate[] {
  const candidates: StaleCandidate[] = [];

  const allEntries = [
    ...experiments.map(e => ({ ...e, entryType: 'experiment' as const })),
    ...knowledge.map(k => ({ ...k, entryType: 'knowledge' as const })),
    ...patterns.map(p => ({ ...p, entryType: 'pattern' as const })),
  ];

  for (const entry of allEntries) {
    // Skip already inactive
    if (isInactiveStatus(entry.meta.status as string)) continue;
    // Skip already marked stale or challenged
    const status = String(entry.meta.status || '').toLowerCase();
    if (status === 'stale' || status.startsWith('challenged')) continue;

    const refs = refStats.get(entry.filename)?.refs ?? 0;
    if (refs > 0) continue;

    const age = daysSince(entry.meta.date as string);
    if (age === null || age <= thresholdDays) continue;

    candidates.push({
      entryId: entry.id,
      entryFile: entry.filename,
      entryType: entry.entryType,
      project: projectName,
      ageDays: Math.floor(age),
      refs,
      reason: `${entry.id} has 0 refs and is ${Math.floor(age)} days old (threshold: ${thresholdDays}d)`,
    });
  }

  return candidates;
}

// --- Detector 6: Anti-pattern candidates — recurring process deficiencies across experiments ---

function detectAntiPatterns(projectName: string, experiments: ReturnType<typeof scanAtomicFiles>): AntiPatternCandidate[] {
  const candidates: AntiPatternCandidate[] = [];
  const activeExps = experiments.filter(e => !isInactiveStatus(e.meta.status as string));

  // Read experiment bodies and extract process deficiency content
  const projectDir = path.join(PROJECTS_DIR, projectName);
  const expDir = path.join(projectDir, 'experiments');
  if (!fs.existsSync(expDir)) return [];

  // Extract deficiency text from each experiment
  const deficiencies: { id: string; text: string }[] = [];

  for (const exp of activeExps) {
    const filePath = path.join(expDir, exp.filename);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch { continue; }

    // Extract process deficiency section
    const defMatch = content.match(/\*\*过程缺陷\*\*[：:]\s*(.+?)(?=\n\*\*|\n####|\n##|$)/s);
    if (defMatch && defMatch[1].trim() && defMatch[1].trim() !== '无' && defMatch[1].trim() !== 'None') {
      deficiencies.push({ id: exp.id, text: defMatch[1].trim() });
    }
  }

  if (deficiencies.length < 2) return [];

  // Keyword-based clustering with noise filtering
  const keywordMap = new Map<string, string[]>(); // keyword → [exp IDs]

  // Stop words and noise patterns to filter out
  const stopWords = new Set(['的', '了', '在', '是', '和', '与', '或', '但', '因为', '所以',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'and', 'or', 'but', 'for', 'to', 'in', 'on',
    '没有', '不', '无', '需要', '应该', '可以', 'with', 'from', 'that', 'this', 'have', 'been']);

  // Filter out markdown formatting and numbered list artifacts
  const noisePatterns = /^[\*\#\(\)\d\.\-\+\>\`]+$|^\*\*.*\*\*:?$|^\(\d+\)$/;

  for (const { id, text } of deficiencies) {
    // Strip markdown formatting before tokenizing
    const cleaned = text
      .replace(/\*\*[^*]+\*\*/g, '') // remove bold markers and their content
      .replace(/\([^)]*\)/g, '')      // remove parenthetical refs
      .replace(/`[^`]+`/g, '')        // remove inline code
      .replace(/[，。；：、！？\n\r\-\*\#\>\+]/g, ' ');

    const tokens = cleaned
      .split(/\s+/)
      .filter(t => t.length >= 3 && !stopWords.has(t.toLowerCase()) && !noisePatterns.test(t))
      .map(t => t.toLowerCase());

    for (const token of tokens) {
      if (!keywordMap.has(token)) keywordMap.set(token, []);
      const list = keywordMap.get(token)!;
      if (!list.includes(id)) list.push(id);
    }
  }

  // Find keywords appearing in 3+ experiments (raised threshold for better signal)
  const seenClusters = new Set<string>();
  for (const [keyword, expIds] of keywordMap) {
    if (expIds.length < 3) continue;

    const clusterKey = [...expIds].sort().join(',');
    if (seenClusters.has(clusterKey)) continue;
    seenClusters.add(clusterKey);

    // Reconstruct the deficiency texts for these experiments
    const relevantTexts = deficiencies
      .filter(d => expIds.includes(d.id))
      .map(d => `${d.id}: ${d.text.slice(0, 80)}`)
      .join('; ');

    candidates.push({
      project: projectName,
      pattern: keyword,
      experiments: expIds,
      reason: `Keyword "${keyword}" appears in ${expIds.length} experiments' deficiency sections: ${relevantTexts.slice(0, 200)}`,
    });
  }

  // Sort by cluster size desc
  candidates.sort((a, b) => b.experiments.length - a.experiments.length);

  // Return top 10 to avoid noise
  return candidates.slice(0, 10);
}

// --- Core analysis ---

export function analyzeProject(projectName: string): ProjectReport {
  const projectDir = path.join(PROJECTS_DIR, projectName);
  const expDir = path.join(projectDir, 'experiments');
  const knDir = path.join(projectDir, 'knowledge');
  const patDir = path.join(projectDir, 'patterns');

  const experiments = scanAtomicFiles(expDir);
  const knowledge = scanAtomicFiles(knDir);
  const patterns = scanAtomicFiles(patDir);

  // Run all detectors
  const tagClusters = detectTagClusters(projectName, experiments, patterns);
  const linkClusters = detectLinkClusters(projectName, experiments);
  const supersedeChains = detectSupersedeChains(projectName, experiments);

  const consolidation = [...tagClusters, ...linkClusters, ...supersedeChains];
  consolidation.sort((a, b) => {
    const typeOrder = { 'tag-cluster': 0, 'link-cluster': 1, 'supersede-chain': 2 };
    const typeDiff = (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    if (typeDiff !== 0) return typeDiff;
    return b.experiments.length - a.experiments.length;
  });

  const contradictions = detectContradictions(projectName, experiments, knowledge, patterns);
  const stale = detectStale(projectName, experiments, knowledge, patterns, loadRefStats(projectDir));
  const antiPatterns = detectAntiPatterns(projectName, experiments);

  return {
    project: projectName,
    experimentCount: experiments.length,
    knowledgeCount: knowledge.length,
    patternCount: patterns.length,
    consolidation,
    contradictions,
    stale,
    antiPatterns,
  };
}

// --- Public API ---

export function consolidateAll(): ProjectReport[] {
  return listMemoryProjects().map(p => analyzeProject(p));
}

// --- Human-readable report ---

export function formatReport(reports: ProjectReport[]): string {
  const out: string[] = [];
  const reportsWithFindings = reports.filter(r =>
    r.consolidation.length > 0 || r.contradictions.length > 0 ||
    r.stale.length > 0 || r.antiPatterns.length > 0);

  if (reportsWithFindings.length === 0) return 'No findings across all projects.';

  for (const r of reportsWithFindings) {
    out.push(`\n=== ${r.project} (${r.experimentCount} exp, ${r.knowledgeCount} K, ${r.patternCount} PAT) ===`);

    if (r.contradictions.length > 0) {
      out.push(`\n  ⚠ CONTRADICTIONS (${r.contradictions.length}):`);
      for (const c of r.contradictions) {
        const sev = c.severity === 'all-compromised' ? '🔴' : '🟡';
        out.push(`    ${sev} ${c.reason}`);
        out.push(`      Compromised: ${c.compromisedSources.map(s => `${s.id}(${s.status})`).join(', ')}`);
        if (c.remainingSources.length > 0) {
          out.push(`      Remaining: ${c.remainingSources.join(', ')}`);
        }
      }
    }

    if (r.stale.length > 0) {
      out.push(`\n  ⏳ STALE (${r.stale.length}):`);
      for (const s of r.stale.slice(0, 10)) {
        out.push(`    ${s.entryId} (${s.entryType}, ${s.ageDays}d old, ${s.refs} refs)`);
      }
      if (r.stale.length > 10) out.push(`    ... and ${r.stale.length - 10} more`);
    }

    if (r.antiPatterns.length > 0) {
      out.push(`\n  🔁 ANTI-PATTERNS (${r.antiPatterns.length}):`);
      for (const a of r.antiPatterns.slice(0, 5)) {
        out.push(`    "${a.pattern}" in ${a.experiments.join(', ')}`);
      }
    }

    if (r.consolidation.length > 0) {
      const uncovered = r.consolidation.filter(c => c.existingPatterns.length === 0);
      out.push(`\n  📦 CONSOLIDATION (${r.consolidation.length} total, ${uncovered.length} uncovered):`);
      for (const c of uncovered.slice(0, 5)) {
        out.push(`    [${c.type}] ${c.reason}`);
      }
      if (uncovered.length > 5) out.push(`    ... and ${uncovered.length - 5} more`);
    }
  }

  const totals = {
    contradictions: reports.reduce((s, r) => s + r.contradictions.length, 0),
    allCompromised: reports.reduce((s, r) => s + r.contradictions.filter(c => c.severity === 'all-compromised').length, 0),
    stale: reports.reduce((s, r) => s + r.stale.length, 0),
    antiPatterns: reports.reduce((s, r) => s + r.antiPatterns.length, 0),
    consolidation: reports.reduce((s, r) => s + r.consolidation.length, 0),
    uncovered: reports.reduce((s, r) => s + r.consolidation.filter(c => c.existingPatterns.length === 0).length, 0),
  };

  out.push(`\n--- Summary ---`);
  out.push(`Contradictions: ${totals.contradictions} (${totals.allCompromised} fully compromised)`);
  out.push(`Stale entries: ${totals.stale}`);
  out.push(`Anti-pattern signals: ${totals.antiPatterns}`);
  out.push(`Consolidation candidates: ${totals.consolidation} (${totals.uncovered} uncovered)`);
  return out.join('\n');
}
