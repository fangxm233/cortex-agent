// input:  NOTES.md path, atomicWrite, AsyncMutex, clock/id factories
// output: ProjectNote Markdown parser and serialized CRUD repository
// pos:    Persistence for user-private per-project notes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AsyncMutex } from '@core/async-mutex.js';
import { atomicWrite } from '@core/atomic-write.js';

export interface ProjectNote {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectNotesRepositoryOptions {
  now?: () => string;
  id?: () => string;
}

const FORMAT_MARKER = '<!-- cortex-project-notes:v1 -->';
const PRIVACY_MARKER = '<!-- Private user notes: excluded from automatic agent context. -->';
const META_PREFIX = '<!-- cortex-note ';
const META_SUFFIX = ' -->';
const CHECKBOX_RE = /^- \[([ x])\] (.+)$/;
const locks = new Map<string, AsyncMutex>();

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function invalidFile(message: string): Error {
  return codedError('invalid-notes-file', message);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function nullableIso(value: unknown): string | null {
  if (value === null) return null;
  if (validIso(value)) return value;
  throw invalidFile('Invalid completion timestamp');
}

function parseMetadata(line: string): Omit<ProjectNote, 'text' | 'completed'> {
  if (!line.startsWith(META_PREFIX) || !line.endsWith(META_SUFFIX)) throw invalidFile('Invalid note metadata');
  let value: unknown;
  try {
    value = JSON.parse(line.slice(META_PREFIX.length, -META_SUFFIX.length));
  } catch {
    throw invalidFile('Invalid note metadata JSON');
  }
  if (!value || typeof value !== 'object') throw invalidFile('Invalid note metadata object');
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id || !validIso(item.createdAt) || !validIso(item.updatedAt)) {
    throw invalidFile('Invalid note identity or timestamp');
  }
  return {
    id: item.id,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: nullableIso(item.completedAt),
  };
}

function parseEntry(lines: string[], index: number): ProjectNote {
  const metadata = parseMetadata(lines[index]);
  const match = lines[index + 1]?.match(CHECKBOX_RE);
  if (!match) throw invalidFile('Note metadata must be followed by one checkbox line');
  const completed = match[1] === 'x';
  if (completed !== (metadata.completedAt !== null)) throw invalidFile('Note checkbox and completion timestamp disagree');
  return { ...metadata, text: match[2], completed };
}

function isChromeLine(line: string): boolean {
  return line === '' || line === '# Notes' || line === FORMAT_MARKER || line === PRIVACY_MARKER
    || line === '## Active' || line === '## Completed';
}

export function parseNotesMarkdown(md: string): ProjectNote[] {
  if (!md.includes(FORMAT_MARKER)) throw invalidFile('Unsupported NOTES.md format');
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const notes: ProjectNote[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isChromeLine(line)) continue;
    if (!line.startsWith(META_PREFIX)) throw invalidFile(`Unexpected NOTES.md content at line ${index + 1}`);
    notes.push(parseEntry(lines, index));
    index += 1;
  }
  if (new Set(notes.map((note) => note.id)).size !== notes.length) throw invalidFile('Duplicate note id');
  return notes;
}

function serializeMetadata(note: ProjectNote): string {
  const metadata = {
    id: note.id,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    completedAt: note.completedAt,
  };
  return `${META_PREFIX}${JSON.stringify(metadata)}${META_SUFFIX}`;
}

function serializeSection(title: string, notes: ProjectNote[]): string[] {
  const lines = [`## ${title}`];
  for (const note of notes) {
    lines.push(serializeMetadata(note), `- [${note.completed ? 'x' : ' '}] ${note.text}`, '');
  }
  return lines;
}

export function serializeNotesMarkdown(notes: ProjectNote[]): string {
  const active = notes.filter((note) => !note.completed);
  const completed = notes.filter((note) => note.completed);
  return [
    '# Notes',
    '',
    FORMAT_MARKER,
    PRIVACY_MARKER,
    '',
    ...serializeSection('Active', active),
    ...serializeSection('Completed', completed),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function normalizeText(text: string): string {
  const normalized = text.trim();
  if (!normalized || /[\r\n]/.test(normalized) || normalized.length > 1000) {
    throw codedError('invalid-args', 'Note text must be 1-1000 characters on one line');
  }
  return normalized;
}

async function assertSafeFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalidFile('NOTES.md must be a regular file');
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function mutexFor(filePath: string): AsyncMutex {
  const key = path.resolve(filePath);
  let mutex = locks.get(key);
  if (!mutex) {
    mutex = new AsyncMutex();
    locks.set(key, mutex);
  }
  return mutex;
}

function findNote(notes: ProjectNote[], id: string): { note: ProjectNote; index: number } {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) throw codedError('not-found', `Note not found: ${id}`);
  return { note: notes[index], index };
}

export class ProjectNotesRepository {
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(options: ProjectNotesRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  async list(filePath: string): Promise<ProjectNote[]> {
    if (!(await assertSafeFile(filePath))) return [];
    return parseNotesMarkdown(await fs.readFile(filePath, 'utf8'));
  }

  async add(filePath: string, text: string): Promise<ProjectNote> {
    return this.mutate(filePath, (notes) => {
      const now = this.now();
      const note = { id: this.id(), text: normalizeText(text), completed: false, createdAt: now, updatedAt: now, completedAt: null };
      notes.unshift(note);
      return note;
    });
  }

  async update(filePath: string, id: string, text: string): Promise<ProjectNote> {
    return this.mutate(filePath, (notes) => {
      const found = findNote(notes, id);
      const note = { ...found.note, text: normalizeText(text), updatedAt: this.now() };
      notes[found.index] = note;
      return note;
    });
  }

  async setCompleted(filePath: string, id: string, completed: boolean): Promise<ProjectNote> {
    return this.mutate(filePath, (notes) => {
      const found = findNote(notes, id);
      if (found.note.completed === completed) return found.note;
      const now = this.now();
      const note = { ...found.note, completed, updatedAt: now, completedAt: completed ? now : null };
      notes[found.index] = note;
      return note;
    });
  }

  async delete(filePath: string, id: string): Promise<true> {
    return this.mutate(filePath, (notes) => {
      const found = findNote(notes, id);
      notes.splice(found.index, 1);
      return true;
    });
  }

  async clearCompleted(filePath: string): Promise<number> {
    return this.mutate(filePath, (notes) => {
      const kept = notes.filter((note) => !note.completed);
      const cleared = notes.length - kept.length;
      notes.splice(0, notes.length, ...kept);
      return cleared;
    });
  }

  private async mutate<T>(filePath: string, operation: (notes: ProjectNote[]) => T): Promise<T> {
    return mutexFor(filePath).run(async () => {
      const notes = await this.list(filePath);
      const result = operation(notes);
      await atomicWrite(filePath, serializeNotesMarkdown(notes));
      return result;
    });
  }
}

export const projectNotesRepository = new ProjectNotesRepository();
