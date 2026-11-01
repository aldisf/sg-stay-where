// One unattended poll (docs/polling.md): two coding agents, each with its own tab,
// lock and log. `sites` reads the listing sites (new listings, page details);
// `maps` takes Google Maps checks from GET /api/queue/maps as details finish, so
// Maps never falls behind. `ssw poll [sites|maps]`, Poll now and the scheduled
// jobs all run this.
//   SSW_AGENT        claude (default) or codex
//   SSW_DATA_DIR     where the locks and poll-logs/ go (default data)
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const POLL_GAP_MIN = 20;

// Each agent's non-interactive mode with its closest tool restriction. Only Claude
// can limit shell commands to the tracker's CLI; see docs/polling.md. The prompt
// goes in on stdin: Windows starts npm's .cmd shims through cmd.exe, which can't
// carry a multi-line argument.
export const AGENTS = {
  claude: ["claude", "-p", "--chrome", "--allowedTools", "mcp__claude-in-chrome", "Read", "Bash(node src/cli.js api:*)", "Bash(node src/cli.js attach:*)"],
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

export const cmdQuote = (arg) => (/[\s"&|<>^()*%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export async function poll({ root, env = process.env, agents = AGENTS, jobs = JOBS, only = null, out = console.log, err = console.error } = {}) {
  const data = path.resolve(root, env.SSW_DATA_DIR || "data");
  const logs = path.join(data, "poll-logs");
  mkdirSync(logs, { recursive: true });
  const lockOf = (name) => path.join(data, jobs[name].lock);
  // Locks this run holds; each is released when its job ends, so the server sees the sites agent finish.
  const held = [];
  const release = (name) => { rmSync(lockOf(name), { force: true }); held.splice(held.indexOf(name), 1); };
  const unlock = () => [...held].forEach(release);
  process.on("exit", unlock);
  try {
    for (const name of only ? [only] : Object.keys(jobs)) {
      const holder = existsSync(lockOf(name)) ? Number(readFileSync(lockOf(name), "utf8")) : 0;
      if (holder && holder !== process.pid && alive(holder)) out(`${name}: already running (pid ${holder})`);
      else {
        writeFileSync(lockOf(name), String(process.pid));
        held.push(name);
      }
    }
    if (held.includes("sites")) {
      // Back-to-back polls look like a burst to the sites (Cloudflare checks follow).
      // Google Maps checks don't touch them, so they go ahead.
      const lastFile = path.join(data, "poll.last");
      const now = Math.floor(Date.now() / 1000);
      const mins = !env.SSW_POLL_GAP_CHECKED && existsSync(lastFile) ? Math.floor((now - Number(readFileSync(lastFile, "utf8"))) / 60) : Infinity;
      if (mins < POLL_GAP_MIN) {
        out(`sites: skipped, last poll started ${mins} min ago; polls start at least ${POLL_GAP_MIN} minutes apart`);
        release("sites");
      } else writeFileSync(lastFile, String(now));
    }
    const run = [...held];
    if (!run.length) return 0;
    const agent = env.SSW_AGENT || "claude";
    if (!agents[agent]) {
      err(`SSW_AGENT must be claude or codex (got '${agent}')`);
      return 2;
    }

    const stamp = new Date().toLocaleString("sv-SE").replace(/-/g, "").replace(" ", "-").replace(/:/g, "").slice(0, 13);
    const job = async (name) => {
      const log = path.join(logs, `${stamp}${jobs[name].log}.log`);
      const errLog = log.replace(/\.log$/, ".err.log");
      const prompt = readFileSync(path.resolve(root, jobs[name].prompt), "utf8");
      const code = await spawnAgent(agents[agent], { root, env, prompt, log, errLog });
      release(name);
      if (statSync(errLog).size === 0) rmSync(errLog);
      out(`${name}: exit ${code}, log ${path.relative(root, log)}`);
      return { name, code, log, errLog };
    };
    const results = [];
    if (SIDE_BY_SIDE.has(agent)) results.push(...(await Promise.all(run.map(job))));
    else for (const name of run) results.push(await job(name));

    const { log, errLog } = results[0];
    const text = [log, errLog].filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
    const headline = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("Warning:"))?.slice(0, 180) ?? "";
    notify(`sg-stay-where poll (${agent})`, headline);
    return results.find((r) => r.code !== 0)?.code ?? 0;
  } finally {
    unlock();
  }
}

// stdout is the agent's final report; progress and errors go to the .err log.
function spawnAgent([cmd, ...args], { root, env, prompt, log, errLog }) {
  const win = process.platform === "win32";
  const home = os.homedir();
  // Scheduled jobs start with a bare PATH; these are where the agent CLIs install.
  const extra = win ? [path.join(home, ".local", "bin")] : [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const PATH = [...extra, env.PATH ?? env.Path ?? ""].join(path.delimiter);
  const outFd = openSync(log, "w");
  const errFd = openSync(errLog, "w");
  return new Promise((resolve) => {
    const child = win
      ? spawn([cmd, ...args].map(cmdQuote).join(" "), { cwd: root, env: { ...env, PATH }, stdio: ["pipe", outFd, errFd], shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: root, env: { ...env, PATH }, stdio: ["pipe", outFd, errFd] });
    child.on("error", (e) => { writeFileSync(errLog, `could not start ${cmd}: ${e.message}\n`, { flag: "a" }); });
    child.on("close", (code) => { closeSync(outFd); closeSync(errFd); resolve(code ?? 1); });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function notify(title, text) {
  if (process.platform !== "darwin") return;
  const q = (s) => s.replace(/["\\]/g, "'");
  execFile("osascript", ["-e", `display notification "${q(text)}" with title "${q(title)}"`], () => {});
}
