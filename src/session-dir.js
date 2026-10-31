// Where the WhatsApp linked-device session lives. Its keys can read every chat,
// so it sits outside the project folder: searches over the repo or data/, git,
// and agents working in the project never come across it.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function whatsappSessionDir(dataDir, { env = process.env, home = os.homedir(), log = () => {} } = {}) {
  if (env.SSW_WA_AUTH_DIR) return path.resolve(env.SSW_WA_AUTH_DIR);
  const id = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 10);
  const dir = path.join(home, ".config", "sg-stay-where", id, "whatsapp-auth");
  // Sessions linked before this lived in data/; move them so nobody relinks.
  const old = path.join(dataDir, "whatsapp-auth");
  if (existsSync(old) && !existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    try { renameSync(old, dir); } catch { cpSync(old, dir, { recursive: true }); rmSync(old, { recursive: true, force: true }); }
    chmodSync(dir, 0o700);
    log("info", `moved the WhatsApp session out of the project folder to ${dir}`);
  }
  return dir;
}
