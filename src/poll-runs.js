import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const TERMINAL = ["ok", "blocked", "failed", "interrupted"];
export const BLOCKED_EXIT = 4;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };

export const STALE_LOCK_MIN = 120;
export function lockHolder(file, now = Date.now()) {
  try {
    const lock = JSON.parse(readFileSync(file, "utf8"));
    const pid = typeof lock === "number" ? lock : lock.pid;
    if (!Number.isInteger(pid) || pid <= 0 || now - statSync(file).mtimeMs > STALE_LOCK_MIN * 60_000) return 0;
    return alive(pid) ? pid : 0;
  } catch { return 0; }
}

export class PollRuns {
  constructor(fileOrDb) {
    this.owned = typeof fileOrDb === "string";
    this.db = this.owned ? new DatabaseSync(fileOrDb) : fileOrDb;
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS poll_runs (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, agent TEXT NOT NULL, pid INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, state TEXT NOT NULL CHECK (state IN ('starting','running','ok','blocked','failed','interrupted')),
        exit_code INTEGER, agent_exit_code INTEGER, reason TEXT, log TEXT
      );
      CREATE TABLE IF NOT EXISTS poll_run_searches (
        run_id TEXT NOT NULL REFERENCES poll_runs(id), project_id TEXT NOT NULL, search_id TEXT NOT NULL,
        title TEXT NOT NULL, outcome TEXT CHECK (outcome IN ('read','skipped')), note TEXT,
        PRIMARY KEY (run_id, project_id, search_id)
      );`);
  }

  close() { if (this.owned) this.db.close(); }

  // SQLite serializes stale-file replacement with other runners' claims and
  // releases; exclusive file creation alone cannot make stale reclamation safe.
  claimLock(file, token) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const holder = lockHolder(file);
      if (holder) return { acquired: false, holder };
      if (existsSync(file)) rmSync(file, { force: true });
      try { writeFileSync(file, token, { flag: "wx" }); }
      catch (error) { if (error.code === "EEXIST") return { acquired: false, holder: lockHolder(file) }; throw error; }
      return { acquired: true };
    } finally { this.db.exec("COMMIT"); }
  }

  releaseLock(file, token) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (existsSync(file) && readFileSync(file, "utf8") === token) rmSync(file, { force: true });
    } finally { this.db.exec("COMMIT"); }
  }

  start({ job, agent, pid = process.pid, searches = [], log = null }) {
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO poll_runs (id, job, agent, pid, started_at, state, log) VALUES (?, ?, ?, ?, ?, 'starting', ?)")
        .run(id, job, agent, pid, new Date().toISOString(), log);
      const insert = this.db.prepare("INSERT INTO poll_run_searches (run_id, project_id, search_id, title) VALUES (?, ?, ?, ?)");
      for (const search of searches) insert.run(id, search.projectId, search.id, search.title);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return id;
  }

  running(id) {
    this.db.prepare("UPDATE poll_runs SET state = 'running' WHERE id = ? AND state = 'starting'").run(id);
  }

  get(id) {
    const run = this.db.prepare("SELECT * FROM poll_runs WHERE id = ?").get(id);
    if (!run) return null;
    return { ...run, searches: this.db.prepare("SELECT project_id, search_id, title, outcome, note FROM poll_run_searches WHERE run_id = ?").all(id) };
  }

  recent(job, limit = 10) {
    const rows = this.db.prepare("SELECT id FROM poll_runs WHERE job = ? ORDER BY rowid DESC LIMIT ?").all(job, limit);
    return rows.map(({ id }) => this.get(id));
  }

  // A browser import cannot inherit the worker's environment. Its project and
  // search title must match exactly one active sites run's snapshot instead.
  match({ search, projectId = null, runId = null }) {
    const matches = this.db.prepare(`SELECT s.* FROM poll_run_searches s JOIN poll_runs r ON r.id = s.run_id
      WHERE r.job = 'sites' AND r.state IN ('starting','running') AND s.title = ?
      AND (? IS NULL OR s.project_id = ?) AND (? IS NULL OR s.run_id = ?)`)
      .all(search, projectId, projectId, runId, runId);
    if (matches.length !== 1) {
      if (runId) throw Object.assign(new Error("Poll result does not match an active sites run and search."), { status: 409 });
      return null;
    }
    return matches[0];
  }

  record({ note = null, ...identity }) {
    const match = this.match(identity);
    if (!match) return false;
    const skipped = /^skipped\s*:/i.test(note ?? "");
    // A later blocked page cannot erase the pages this search already imported.
    if (match.outcome !== "read") this.db.prepare("UPDATE poll_run_searches SET outcome = ?, note = ? WHERE run_id = ? AND project_id = ? AND search_id = ?")
      .run(skipped ? "skipped" : "read", skipped ? note : null, match.run_id, match.project_id, match.search_id);
    return true;
  }

  finish(id, { code = 1, reason = null } = {}) {
    const run = this.get(id);
    if (!run) throw new Error("No such poll run");
    if (TERMINAL.includes(run.state)) return run;
    const missing = run.searches.filter(s => !s.outcome);
    const blocked = run.job === "sites" && run.searches.length > 0 && run.searches.every(s => s.outcome === "skipped");
    const state = code !== 0 ? "failed" : blocked ? "blocked" : missing.length ? "failed" : "ok";
    const exit = code || (blocked ? BLOCKED_EXIT : missing.length ? 1 : 0);
    reason ??= code !== 0 ? `Agent exited ${code}`
      : blocked ? run.searches.map(s => `${s.title}: ${s.note}`).join("; ")
        : missing.length ? `No search report: ${missing.map(s => s.title).join(", ")}` : null;
    this.db.prepare("UPDATE poll_runs SET state = ?, finished_at = ?, exit_code = ?, agent_exit_code = ?, reason = ? WHERE id = ? AND state IN ('starting','running')")
      .run(state, new Date().toISOString(), exit, code, reason, id);
    return this.get(id);
  }

  reconcile() {
    for (const run of this.db.prepare("SELECT id, pid FROM poll_runs WHERE state IN ('starting','running')").all()) {
      if (!alive(run.pid)) this.interrupt(run.id, "Poll runner stopped before recording its outcome");
    }
  }

  interrupt(id, reason) {
    this.db.prepare("UPDATE poll_runs SET state = 'interrupted', finished_at = ?, exit_code = 1, reason = ? WHERE id = ? AND state IN ('starting','running')")
      .run(new Date().toISOString(), reason, id);
  }

  blockedStreak() {
    let count = 0;
    for (const { state } of this.db.prepare("SELECT state FROM poll_runs WHERE job = 'sites' ORDER BY rowid DESC").iterate()) {
      if (state !== "blocked") break;
      count++;
    }
    return count;
  }
}
