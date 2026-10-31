import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { PropertyWhatsApp } from "../src/whatsapp.js";

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-send-"));
  const store = new Store(path.join(dir, "s.sqlite"));
  const wa = new PropertyWhatsApp({ authDir: path.join(dir, "auth"), store, log: () => {} });
  const ev = new EventEmitter();
  const sent = [];
  wa.attach({
    ev, user: { id: "6580000001:7@s.whatsapp.net" }, end() {},
    onWhatsApp: async (phone) => [{ exists: true, jid: `${phone}@s.whatsapp.net` }],
    sendMessage: async (jid, { text }) => { await new Promise((r) => setTimeout(r, 20)); sent.push([jid, text]); return { key: { id: `m${sent.length}` } }; }
  });
  ev.emit("connection.update", { connection: "open" });
  t.after(async () => { await wa.stop(); clearInterval(wa.purgeTimer); clearTimeout(wa.droppedTimer); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const listing = (id, phone) => store.upsertListing({ source: "propertyguru", source_id: String(id), url: `https://www.propertyguru.com.sg/listing/${id}`, project_id: "home", agent_phone: phone }).listing;
  return { wa, sent, listing };
}

test("intros go out back to back; the same message is never sent twice to one agent", async (t) => {
  const { wa, sent, listing } = setup(t);
  const a = listing(500000001, "+6591110001");
  const b = listing(500000002, "+6591110002");
  const c = listing(500000003, "+6591110001");
  await wa.send(a, `Hi, about ${a.url}`);
  await wa.send(b, `Hi, about ${b.url}`);
  await wa.send(c, `Hi, about ${c.url}`);
  assert.equal(sent.length, 3, "no wait between sends");
  await assert.rejects(wa.send(a, `Hi, about  ${a.url}\n`), /already sent/);
  const twice = await Promise.allSettled([wa.send(b, "Can we view Saturday?"), wa.send(b, "Can we view Saturday?")]);
  assert.deepEqual(twice.map((r) => r.status).sort(), ["fulfilled", "rejected"], "a double click sends once");
  assert.equal(sent.length, 4);
});
