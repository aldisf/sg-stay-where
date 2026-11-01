// One unattended poll (docs/polling.md): a coding agent runs scripts/poll-prompt.md
// with its browser tool. `ssw poll`, Poll now and the scheduled jobs all run this.
//   SSW_AGENT        claude (default) or codex
//   SSW_POLL_PROMPT  prompt file (default scripts/poll-prompt.md)
//   SSW_DATA_DIR     where the lock and poll-logs/ go (default data)
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

export const cmdQuote = (arg) => (/[\s"&|<>^()*%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export async function poll({ root, env = process.env, agents = AGENTS, out = console.log, err = console.error } = {}) {
  const data = path.resolve(root, env.SSW_DATA_DIR || "data");
  const logs = path.join(data, "poll-logs");
  mkdirSync(logs, { recursive: true });

  const lock = path.join(data, "poll.lock");
  const holder = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0;
  if (holder && holder !== process.pid && alive(holder)) {
    out(`poll already running (pid ${holder})`);
    return 0;
  }
  writeFileSync(lock, String(process.pid));
  const unlock = () => rmSync(lock, { force: true });
  process.on("exit", unlock);
  try {
    // Back-to-back polls look like a burst to the sites (Cloudflare checks follow).
    const lastFile = path.join(data, "poll.last");
    const now = Math.floor(Date.now() / 1000);
    if (!env.SSW_POLL_GAP_CHECKED && existsSync(lastFile)) {
      const mins = Math.floor((now - Number(readFileSync(lastFile, "utf8"))) / 60);
      if (mins < POLL_GAP_MIN) {
        out(`skipped: last poll started ${mins} min ago; polls start at least ${POLL_GAP_MIN} minutes apart`);
        return 0;
      }
    }
    writeFileSync(lastFile, String(now));

    const agent = env.SSW_AGENT || "claude";
    if (!agents[agent]) {
      err(`SSW_AGENT must be claude or codex (got '${agent}')`);
      return 2;
    }
    const prompt = readFileSync(path.resolve(root, env.SSW_POLL_PROMPT || "scripts/poll-prompt.md"), "utf8");
    const stamp = new Date().toLocaleString("sv-SE").replace(/-/g, "").replace(" ", "-").replace(/:/g, "").slice(0, 13);
    const log = path.join(logs, `${stamp}.log`);
    const errLog = log.replace(/\.log$/, ".err.log");
    const code = await run(agents[agent], { root, env, prompt, log, errLog });
    if (statSync(errLog).size === 0) rmSync(errLog);

    const text = [log, errLog].filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
    const headline = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("Warning:"))?.slice(0, 180) ?? "";
    notify(`sg-stay-where poll (${agent})`, headline);
    out(`exit ${code}, log ${path.relative(root, log)}`);
    return code;
  } finally {
    unlock();
  }
}

// stdout is the agent's final report; progress and errors go to the .err log.
function run([cmd, ...args], { root, env, prompt, log, errLog }) {
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
