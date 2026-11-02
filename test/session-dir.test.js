import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { whatsappSessionDir } from "../src/session-dir.js";

test("the WhatsApp session lives outside the data folder, owner-only, and an old one is moved there", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ssw-session-"));
  const data = path.join(root, "project", "data");
  const home = path.join(root, "home");
  mkdirSync(path.join(data, "whatsapp-auth"), { recursive: true });
  writeFileSync(path.join(data, "whatsapp-auth", "creds.json"), '{"canary":true}');

  const dir = whatsappSessionDir(data, { env: {}, home });
  assert.ok(!path.relative(path.join(root, "project"), dir).match(/^[^.]/), `${dir} must not be inside the project`);
  assert.ok(dir.startsWith(path.join(home, ".config", "sg-stay-where")));
  assert.equal(existsSync(path.join(data, "whatsapp-auth")), false, "nothing left in data/");
  assert.equal(readFileSync(path.join(dir, "creds.json"), "utf8"), '{"canary":true}', "the linked session survives the move");
  // Windows has no POSIX modes; a folder in the user's profile is already theirs alone.
  if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(whatsappSessionDir(data, { env: {}, home }), dir, "stable across starts");
  assert.notEqual(whatsappSessionDir(path.join(root, "other"), { env: {}, home }), dir, "another data folder gets its own session");
  assert.equal(whatsappSessionDir(data, { env: { SSW_WA_AUTH_DIR: "/x/y" }, home }), path.resolve("/x/y"));
});
