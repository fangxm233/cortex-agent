/** The slice of the D1 binding this Worker uses, so tests can back it with node:sqlite. */
export type Row = Record<string, unknown>;

export interface D1Result<T = Row> {
  results: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  all<T = Row>(): Promise<D1Result<T>>;
  first<T = Row>(): Promise<T | null>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Row>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface Env {
  DB: D1Database;
  /** Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** AUD tag of the Access application that guards /dashboard. */
  ACCESS_AUD?: string;
  /** Local development only (`.dev.vars`): `1` opens /dashboard on localhost without Access. */
  DASHBOARD_LOCAL_BYPASS?: string;
}

