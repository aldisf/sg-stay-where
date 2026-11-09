import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { PollRuns } from "./poll-runs.js";
import { ProjectFiles } from "./projects.js";
import path from "node:path";

export const POLL_GAP_MIN = 20;
export { lockHolder, STALE_LOCK_MIN } from "./poll-runs.js";

// Back-to-back polls look like a burst to the sites (Cloudflare checks follow), so
// listing-site polls start at least POLL_GAP_MIN apart. Google Maps checks don't wait.
export function sitesGap(dataDir, now = Date.now()) {
  const file = path.join(dataDir, "poll.last");
  const minutes = existsSync(file) ? Math.floor((now / 1000 - Number(readFileSync(file, "utf8"))) / 60) : Infinity;
  return { open: minutes >= POLL_GAP_MIN, minutes };
}
export const markPollStart = (dataDir, now = Date.now()) => writeFileSync(path.join(dataDir, "poll.last"), String(Math.floor(now / 1000)));

// Each agent's non-interactive mode with its closest tool restriction. Only Claude
// can limit shell commands to the tracker's CLI; see docs/polling.md. The prompt
// goes in on stdin: Windows starts npm's .cmd shims through cmd.exe, which can't
// carry a multi-line argument.
export const AGENTS = {
  // The deny keeps the WhatsApp session keys out of reach even if the user's own
  // settings allow reading anywhere.
  claude: ["claude", "-p", "--chrome", "--allowedTools", "mcp__claude-in-chrome", "Read(./**)", "Bash(node src/cli.js api:*)", "Bash(node src/cli.js attach:*)",
    "--disallowedTools", "Read(~/.config/sg-stay-where/**)", "Read(./data/whatsapp-auth/**)"],
  // The sandbox blocks 127.0.0.1 unless network access is on; --approve-for-me lets
  // Codex's own reviewer approve its Chrome tool.
  codex: ["codex", "exec", "--approve-for-me", "-c", "sandbox_workspace_write.network_access=true", "-"],
};

export const JOBS = {
  sites: { prompt: "scripts/poll-prompt.md", lock: "poll.lock", log: "" },
  maps: { prompt: "scripts/maps-prompt.md", lock: "maps.lock", log: "-maps" },
};
// Two Claude in Chrome sessions work side by side; Codex's Chrome tool is untested
// that way, so its maps agent starts after the sites agent ends.
const SIDE_BY_SIDE = new Set(["claude"]);

const headlineOf = (...files) => files.filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n")
  .split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("Warning:"))?.slice(0, 180) ?? null;

export const cmdQuote = (arg) => (/[\s"&|<>^()*%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

export async function poll({ root, env = process.env, agents = AGENTS, jobs = JOBS, only = null, out = console.log, err = console.error, notifyUser = notify } = {}) {
  const data = path.resolve(root, env.SSW_DATA_DIR || "data");
  const logs = path.join(data, "poll-logs");
  mkdirSync(logs, { recursive: true });
  const lockOf = (name) => path.join(data, jobs[name].lock);
  // Locks this run holds; each is released when its job ends, so the server sees the sites agent finish.
  const held = [];
  const ledger = new PollRuns(path.join(data, "sg-stay-where.sqlite"));
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const release = (name) => {
    ledger.releaseLock(lockOf(name), token);
    const index = held.indexOf(name);
    if (index >= 0) held.splice(index, 1);
  };
  const unlock = () => [...held].forEach(release);
  process.on("exit", unlock);
  try {
    for (const name of only ? [only] : Object.keys(jobs)) {
      const claim = ledger.claimLock(lockOf(name), token);
      if (claim.acquired) held.push(name);
      else out(`${name}: already running${claim.holder ? ` (pid ${claim.holder})` : ""}`);
    }
    if (held.includes("sites")) {
      const gap = sitesGap(data);
      if (!gap.open) {
        out(`sites: skipped, last poll started ${gap.minutes} min ago; polls start at least ${POLL_GAP_MIN} minutes apart`);
        release("sites");
      }
    }
    const run = [...held];
    if (!run.length) return 0;
    const agent = env.SSW_AGENT || "claude";
    if (!agents[agent]) {
      const reason = `SSW_AGENT must be claude or codex (got '${agent}')`;
      err(reason);
      for (const job of run) ledger.finish(ledger.start({ job, agent }), { code: 2, reason });
      return 2;
    }

    const searches = new ProjectFiles(path.join(data, "projects")).list().filter(p => !p.archived)
      .flatMap(p => (p.searches ?? []).filter(s => s.active !== false).map(s => ({ projectId: p.id, id: s.id, title: s.title })));
    ledger.reconcile();
    const stamp = new Date().toLocaleString("sv-SE").replace(/-/g, "").replace(" ", "-").replace(/:/g, "").slice(0, 13);
    const activeRuns = new Set();
    const interrupt = () => { for (const id of activeRuns) ledger.interrupt(id, "Poll runner stopped"); };
    process.on("exit", interrupt);
    const logId = randomUUID().slice(0, 8);
    const job = async (name) => {
      const log = path.join(logs, `${stamp}-${logId}${jobs[name].log}.log`);
      const errLog = log.replace(/\.log$/, ".err.log");
      // A stale predecessor may still be alive; its eventual finish must not
      // overwrite the replacement run or keep the header stuck on running.
      for (const old of ledger.recent(name)) if (["starting", "running"].includes(old.state)) ledger.interrupt(old.id, "Superseded after its lock expired");
      const id = ledger.start({ job: name, agent, log: path.relative(root, log), searches: name === "sites" ? searches : [] });
      activeRuns.add(id);
      let code = 1, reason = null;
      try {
        const prompt = readFileSync(path.resolve(root, jobs[name].prompt), "utf8");
        ({ code, reason } = await spawnAgent(agents[agent], { root, env: { ...env, SSW_POLL_RUN_ID: id }, prompt, log, errLog,
          onStart: () => { ledger.running(id); if (name === "sites") markPollStart(data); } }));
      } catch (error) { reason = error.message; err(`${name}: ${reason}`); }
      // The agent's own words ("You've hit your 5-hour limit") say more than its exit code.
      if (code !== 0) reason ??= headlineOf(log, errLog);
      const result = ledger.finish(id, { code, reason });
      activeRuns.delete(id);
      release(name);
      if (existsSync(errLog) && statSync(errLog).size === 0) rmSync(errLog);
      out(`${name}: exit ${result.exit_code}, log ${path.relative(root, log)}`);
      return { name, code: result.exit_code, log, errLog, result };
    };
    try {
      const results = [];
      if (SIDE_BY_SIDE.has(agent)) {
        const settled = await Promise.allSettled(run.map(job));
        const failure = settled.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
        results.push(...settled.map(result => result.value));
      }
      else for (const name of run) results.push(await job(name));
      const sites = results.find(r => r.name === "sites");
      if (sites?.result.state === "blocked" && ledger.blockedStreak() >= 2) {
        notifyUser("sg-stay-where: searches blocked again", sites.result.reason.slice(0, 500));
      } else {
        const { log, errLog, result } = results[0];
        notifyUser(`sg-stay-where poll (${agent})`, result.reason ?? headlineOf(log, errLog) ?? "");
      }
      return results.find(r => r.code !== 0)?.code ?? 0;
    } finally {
      interrupt();
      process.removeListener("exit", interrupt);
    }
  } finally {
    unlock();
    process.removeListener("exit", unlock);
    ledger.close();
  }
}

// stdout is the agent's final report; progress and errors go to the .err log.
function spawnAgent([cmd, ...args], { root, env, prompt, log, errLog, onStart }) {
  const win = process.platform === "win32";
  const home = os.homedir();
  // Scheduled jobs start with a bare PATH; these are where the agent CLIs install.
  const extra = win ? [path.join(home, ".local", "bin")] : [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const PATH = [...extra, env.PATH ?? env.Path ?? ""].join(path.delimiter);
  const childEnv = { ...env, PATH };
  let executable = cmd;
  if (win) {
    if (path.win32.dirname(cmd) !== ".") executable = path.resolve(root, cmd);
    else {
      const located = spawnSync("where.exe", [cmd], { cwd: root, env: childEnv, windowsHide: true, encoding: "utf8" });
      executable = located.status === 0 ? located.stdout.trim().split(/\r?\n/)[0] : "";
    }
  }
  if (win && (!executable || !existsSync(executable) || !statSync(executable).isFile())) {
    const reason = `could not start ${cmd}: executable not found on PATH`;
    writeFileSync(errLog, `${reason}\n`);
    return Promise.resolve({ code: 1, reason });
  }
  const outFd = openSync(log, "w");
  const errFd = openSync(errLog, "w");
  return new Promise((resolve) => {
    const batch = win && /\.(cmd|bat)$/i.test(executable);
    const options = { cwd: root, env: childEnv, stdio: ["pipe", outFd, errFd], windowsHide: true };
    const child = batch
      ? spawn([executable, ...args].map(cmdQuote).join(" "), { ...options, shell: true })
      : spawn(executable, args, options);
    child.once("spawn", onStart);
    let reason = null;
    child.on("error", (e) => { reason = `could not start ${cmd}: ${e.message}`; writeFileSync(errLog, `${reason}\n`, { flag: "a" }); });
    child.on("close", (code, signal) => { closeSync(outFd); closeSync(errFd); resolve({ code: code ?? 1, reason: reason ?? (signal ? `Agent stopped by ${signal}` : null) }); });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function notify(title, text) {
  if (process.platform !== "darwin") return;
  const q = (s) => s.replace(/["\\\r\n]/g, "'");
  execFile("osascript", ["-e", `display notification "${q(text)}" with title "${q(title)}"`], () => {});
}
