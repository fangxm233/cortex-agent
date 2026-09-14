export interface RecommendationSection {
  header: string;
  body: string;
  source_file: string;
}

export interface Recommendation {
  source_id: string;
  section_header: string;
  text: string;
  source_file: string;
}

export interface TaskCandidate {
  text: string;
  why: string;
  done_when: string;
  source_id?: string;
  source_type: string;
  pattern?: string;
  is_duplicate: boolean;
  duplicate_of?: string;
  source_file: string;
}

export interface ReflectionField {
  experiment_id: string;
  field_name: string;
  content: string;
  experiment_date: string;
  source_file: string;
}

export interface ImpliedTaskPattern {
  pattern: string;
  signals: RegExp[];
  suggested_task_type: string;
}

export interface ImpliedTaskMatch {
  pattern: string;
  finding_text: string;
  source_id: string;
  suggested_task_type: string;
  source_file: string;
}

export interface ScanSummary {
  files_scanned: number;
  recommendations_found: number;
  implied_tasks_found: number;
  reflection_fields_found: number;
  total_candidates: number;
  actionable: number;
  duplicates: number;
  new_candidates: number;
}

export interface ScanResult {
  candidates: TaskCandidate[];
  reflection_fields: ReflectionField[];
  scan_summary: ScanSummary;
}

export interface CliOptions {
  baseDir: string;
  project: string | null;
  days: number;
  json: boolean;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
