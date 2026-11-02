// libsignal (under Baileys) logs "Closing session:" and friends with the whole
// session object, ratchet private keys included, and the server's stdout goes to
// data/serve.log. Runs the real library in a child process, as the server would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const script = `
  import { createRequire } from "node:module";
  await import("./src/whatsapp.js");
  const signal = createRequire(createRequire(import.meta.url).resolve("@whiskeysockets/baileys"));
  const SessionRecord = signal("libsignal/src/session_record.js");
  const record = new SessionRecord();
  const session = SessionRecord.createEntry();
  session.indexInfo = { baseKey: Buffer.from("base-key-bytes"), closed: -1, used: 1 };
  session.currentRatchet = { ephemeralKeyPair: { pubKey: Buffer.from("public"), privKey: Buffer.from("PRIVATE-RATCHET-KEY") }, rootKey: Buffer.from("ROOT-KEY") };
  record.closeSession(session);
  record.closeSession(session);
  record.openSession(session);
`;

test("libsignal's session logs never print key material", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const logged = run.stdout + run.stderr;
  assert.match(logged, /Closing session/);
  assert.match(logged, /Opening session/);
  for (const secret of ["PRIVATE-RATCHET-KEY", "ROOT-KEY", "base-key-bytes"]) {
    const hex = Buffer.from(secret).toString("hex").match(/../g).join(" ");
    assert.ok(!logged.includes(hex) && !logged.includes(secret) && !logged.includes(Buffer.from(secret).toString("base64")), `${secret} leaked`);
  }
  assert.doesNotMatch(logged, /privKey|rootKey|currentRatchet/);
});
