import * as fs from 'fs';
import * as path from 'path';
import { STORE_DIR } from '../../core/utils.js';

export interface UpdateState {
  skippedVersion?: string;
  lastCheckedAt?: string;
  lastPromptedVersion?: string;
}

// Mutable for test isolation — tests override this via _testSetStateFile
let stateFilePath: string = path.join(STORE_DIR, 'update-state.json');

export function loadUpdateState(): UpdateState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveUpdateState(state: UpdateState): void {
  const dir = path.dirname(stateFilePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

/** Test-only: redirect file path to an isolated temp location. */
export function _testSetStateFile(p: string): void {
  stateFilePath = p;
}
