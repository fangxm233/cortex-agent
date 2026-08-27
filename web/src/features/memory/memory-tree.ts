// input:  MemoryTree DTOs with top-level files and directory entries
// output: Canonical file paths, directories, total count, and first file
// pos:    Shared hierarchical memory-tree facts for desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { MemoryFileEntry, MemoryTree } from '@cortex-agent/ui-contract';

export interface MemoryTreeFileFact extends MemoryFileEntry {
  /** Project-root-relative path accepted by memory.file. */
  path: string;
}

export interface MemoryTreeDirFact {
  name: string;
  /** Server-authoritative number of visible Markdown entries. */
  entryCount: number;
  entries: MemoryTreeFileFact[];
}

export interface MemoryTreeFacts {
  topLevelFiles: MemoryTreeFileFact[];
  dirs: MemoryTreeDirFact[];
  /** Top-level files plus every server-reported directory entry count. */
  fileCount: number;
  /** First top-level file, otherwise the first nested entry in directory order. */
  firstFile: MemoryTreeFileFact | null;
}

/**
 * Maps the transport DTO into the one locale- and layout-free hierarchy consumed by both UIs.
 * Path joining lives here so desktop selection and mobile drill-in cannot diverge.
 */
export function deriveMemoryTreeFacts(tree: MemoryTree | null | undefined): MemoryTreeFacts {
  if (!tree) return { topLevelFiles: [], dirs: [], fileCount: 0, firstFile: null };

  const topLevelFiles = tree.files.map((entry) => ({ ...entry, path: entry.name }));
  const dirs = tree.dirs.map((dir) => ({
    name: dir.name,
    entryCount: dir.entryCount,
    entries: (dir.entries ?? []).map((entry) => ({
      ...entry,
      path: `${dir.name}/${entry.name}`,
    })),
  }));
  const firstNestedFile = dirs.find((dir) => dir.entries.length > 0)?.entries[0] ?? null;

  return {
    topLevelFiles,
    dirs,
    fileCount: topLevelFiles.length + dirs.reduce((total, dir) => total + dir.entryCount, 0),
    firstFile: topLevelFiles[0] ?? firstNestedFile,
  };
}
