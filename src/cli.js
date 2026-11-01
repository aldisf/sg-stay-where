#!/usr/bin/env node
// ssw serve [--log <file>]  web app (+ WhatsApp when data/whatsapp.json says enabled)
// ssw whatsapp              link WhatsApp: QR in the terminal (and Preview on macOS)
// ssw project list|check|new
// ssw attach <id> listing|maps:<key> <image>
// ssw api <METHOD> /api/... [json]   the scheduled poll's only way in
// ssw privacy               what the WhatsApp filter stored, ignored and dropped (counts only)
// ssw demo                  fictional demo data in data-demo/ (screenshots, trying it out)
// ssw serve --demo          serve that data on port 7432
// ssw poll                  one unattended poll with SSW_AGENT (claude or codex)
import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./db.js";
import { checkProject, ProjectFiles } from "./projects.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[2] === "serve" && process.argv.includes("--demo")) {
  process.env.SSW_DATA_DIR ||= path.join(ROOT, "data-demo");
  process.env.SSW_PORT ||= "7432";
}
const DATA = path.resolve(process.env.SSW_DATA_DIR || path.join(ROOT, "data"));
const PORT = process.env.SSW_PORT || 7431;
const log = (level, msg) => console.log(`${new Date().toISOString()} ${level.padEnd(5)} ${msg}`);
const args = process.argv.slice(3);

const openStore = () => new Store(path.join(DATA, "sg-stay-where.sqlite"));
const projectFiles = () => new ProjectFiles(path.join(DATA, "projects"));

// data/whatsapp.json: { enabled, excludeNames: [...], maxMessagesBeforeLink }
function whatsappSettings() {
  const file = path.join(DATA, "whatsapp.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { enabled: false };
}

async function openWhatsApp(store) {
  const { PropertyWhatsApp } = await import("./whatsapp.js");
  const { enabled, ...settings } = whatsappSettings();
  const { whatsappSessionDir } = await import("./session-dir.js");
  const wa = new PropertyWhatsApp({ authDir: whatsappSessionDir(DATA, { log }), store, log, ...settings });
  wa.reviewFlaggedChats();
  return wa;
}

// Each QR is valid ~20 s. Rewrites one PNG and reopens it so Preview shows the
// current code; removed once linked.
async function showQr(wa) {
  const { default: QRCode } = await import("qrcode");
  const file = path.join(DATA, "whatsapp-qr.png");
  let count = 0;
  wa.on("qr", async (qr) => {
    count += 1;
    const { default: terminal } = await import("qrcode-terminal");
    terminal.generate(qr, { small: true });
    await QRCode.toFile(file, qr, { width: 480, margin: 2 });
    log("info", `QR #${count}: WhatsApp > Settings > Linked devices > Link a device (refreshes every ~20s)`);
    if (process.platform === "darwin") execFile("open", count === 1 ? [file] : ["-g", file], () => {});
    else if (process.platform === "win32" && count === 1) execFile("cmd", ["/c", "start", "", file], () => {});
  });
  wa.on("changed", () => { if (wa.state === "live") rmSync(file, { force: true }); });
}

async function serve() {
  // Background services on Windows have no terminal to write to. Synchronous, so
  // the last lines before a crash are kept.
  const logAt = args.indexOf("--log");
  if (logAt >= 0) {
    const file = path.resolve(args[logAt + 1]);
    process.stdout.write = process.stderr.write = (chunk, ...rest) => {
      appendFileSync(file, chunk);
      rest.find((a) => typeof a === "function")?.();
      return true;
    };
  }
  const { startServer } = await import("./server.js");
  const store = openStore();
  const useWhatsApp = whatsappSettings().enabled && !args.includes("--no-whatsapp");
  // The demo dataset (npm run demo) gets a stand-in that looks linked and never sends.
  const demo = existsSync(path.join(DATA, "demo.json"));
  const wa = demo ? demoWhatsApp() : useWhatsApp ? await openWhatsApp(store) : null;
  if (wa && !demo) await showQr(wa);
  else if (!wa) log("info", "WhatsApp off (optional; enable with `npm run whatsapp`, see docs/whatsapp.md)");
  const pollCommand = process.env.SSW_POLL_COMMAND ? process.env.SSW_POLL_COMMAND.split(" ") : undefined;
  const server = await startServer({ root: ROOT, dataDir: DATA, store, projects: projectFiles(), wa, log, pollCommand });
  if (wa) await wa.start();
  const shutdown = async () => { server.close(); await wa?.stop(); store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function demoWhatsApp() {
  return {
    status: () => ({ state: "live", linked: true, self: "6580000000", qr: null }),
    send: async () => { throw new Error("demo data: sending is switched off"); },
    start: async () => {}, stop: async () => {}, logout: async () => {}
  };
}

// Stop the server first: two processes on one WhatsApp session log each other out.
async function whatsapp() {
  const file = path.join(DATA, "whatsapp.json");
  mkdirSync(DATA, { recursive: true });
  const current = whatsappSettings();
  if (!current.enabled) writeFileSync(file, `${JSON.stringify({ excludeNames: [], maxMessagesBeforeLink: 10, ...current, enabled: true }, null, 2)}\n`);
  const store = openStore();
  const wa = await openWhatsApp(store);
  await showQr(wa);
  wa.on("changed", () => {
    if (wa.state === "live") log("info", `linked. Property chats so far: ${store.listChats().length}. Ctrl-C, then start the server (npm start).`);
  });
  await wa.start();
  process.on("SIGINT", async () => { await wa.stop(); store.close(); process.exit(0); });
}

async function project() {
  const [sub = "list", ref] = args;
  const files = projectFiles();
  if (sub === "list") {
    for (const p of files.list()) console.log(`${p.id.padEnd(24)} ${p.title}${p.archived ? " (archived)" : ""} · ${(p.searches ?? []).filter((s) => s.active).length}/${(p.searches ?? []).length} searches on`);
    return;
  }
  if (sub === "check") {
    const p = ref && existsSync(ref) ? JSON.parse(readFileSync(ref, "utf8")) : files.get(ref);
    if (!p) throw new Error(`usage: ssw project check <id|file.json>`);
    const errors = checkProject(p);
    console.log(errors.length ? errors.map((e) => `✗ ${e}`).join("\n") : `✓ ${p.id} is valid`);
    if (errors.length) process.exitCode = 1;
    return;
  }
  if (sub === "new") {
    if (!ref) throw new Error(`usage: ssw project new "<title>" [--copy <id>]`);
    const copy = args.indexOf("--copy");
    const p = files.create({ title: ref, copyFrom: copy > 0 ? args[copy + 1] : null });
    console.log(`created data/projects/${p.id}.json`);
    return;
  }
  throw new Error("usage: ssw project list|check|new");
}

async function attach() {
  const [id, kind, file] = args;
  if (!Number.isInteger(Number(id)) || !/^(listing|maps:[\w-]+)$/.test(kind ?? "") || !existsSync(file ?? "")) {
    throw new Error("usage: ssw attach <listingId> listing|maps:<key> <existing image>");
  }
  const dir = path.join(DATA, "media", String(Number(id)));
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(file).toLowerCase() || ".jpg";
  const name = kind === "listing" ? `listing${ext}` : `${kind.replace(":", "-")}${ext}`;
  copyFileSync(file, path.join(dir, name));
  const body = kind === "listing" ? { listing: name } : { maps: { [kind.split(":")[1]]: name } };
  const res = await fetch(`http://127.0.0.1:${PORT}/api/listings/${Number(id)}/media`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`server said ${res.status}: ${await res.text()}`);
  log("info", `attached ${name} to listing ${id}`);
}

// The scheduled poll's only door: local host only, and never the send route
// (polls must not message anyone).
async function api() {
  const [method = "GET", route, arg] = args;
  if (!/^(GET|POST|PUT|PATCH)$/.test(method) || !route?.startsWith("/api/")) {
    throw new Error("usage: ssw api GET|POST|PUT|PATCH /api/... [json | @file.json]");
  }
  const json = arg?.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg;
  if (/\/send$|\/whatsapp\/|^\/api\/poll$/.test(route.split("?")[0])) throw new Error("refused: the poll does not send messages, touch WhatsApp or start polls");
  // x-ssw-actor lets the server refuse to make the user's choices (watch, hide).
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: { "x-ssw-actor": "poll", ...(json ? { "content-type": "application/json" } : {}) },
    body: json
  });
  process.stdout.write(`${await res.text()}\n`);
  if (!res.ok) process.exitCode = 1;
}

// What the WhatsApp filter stored, ignored and dropped: counts, never text.
async function privacy() {
  const { privacyReport } = await import("./privacy.js");
  const store = openStore();
  const { ok, text } = privacyReport(store, whatsappSettings());
  store.close();
  console.log(`WhatsApp privacy boundary: ${path.join(DATA, "sg-stay-where.sqlite")}\n${text}`);
  if (!ok) process.exitCode = 1;
}

async function demo() {
  const { seedDemo } = await import("./demo.js");
  const dir = path.resolve(process.env.SSW_DATA_DIR || path.join(ROOT, "data-demo"));
  await seedDemo(dir);
  console.log(`demo data in ${dir}\nrun: npm run demo:serve`);
}

async function importLegacy() {
  const { importLegacy: run } = await import("./legacy.js");
  const [from] = args;
  if (!from) throw new Error("usage: ssw import-legacy <old repo folder>");
  console.log(run({ from: path.resolve(from), data: DATA }));
}

async function poll() {
  const { poll: run } = await import("./poll.js");
  // Ctrl-C or a stopped job still removes the lock.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
  process.exitCode = await run({ root: ROOT });
}

const command = process.argv[2] ?? "serve";
const commands = { serve, whatsapp, project, attach, api, privacy, demo, poll, "import-legacy": importLegacy };
if (!commands[command]) {
  console.error(`usage: ssw [${Object.keys(commands).join("|")}]`);
  process.exit(2);
}
commands[command]().catch((error) => {
  log("error", error.stack ?? error.message);
  process.exit(1);
});
