// Drives PropertyWhatsApp's real event handlers with a fake Baileys socket and
// a real SQLite file, then reads that file back (every table, and its raw
// bytes) to check what reached the disk.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { newProject, ProjectFiles } from "../src/projects.js";
import { PropertyWhatsApp } from "../src/whatsapp.js";

process.env.SSW_PORT = "0";
const { startServer } = await import("../src/server.js");

const SELF = "6580000001@s.whatsapp.net";
const SELF_LID = "100000000001@lid";
const PG = (id) => `https://www.propertyguru.com.sg/listing/for-rent-example-${id}`;
const T0 = 1_760_000_000;

function message(jid, id, text, { fromMe = false, ts = T0, pushName = null, alt } = {}) {
  return {
    key: { remoteJid: jid, id, fromMe, ...(alt ? { remoteJidAlt: alt } : {}) },
    message: { conversation: text },
    messageTimestamp: ts,
    pushName
  };
}

function protocol(jid, id, type, target, text) {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    message: { protocolMessage: { type, key: { id: target }, ...(text ? { editedMessage: { conversation: text } } : {}) } },
    messageTimestamp: T0 + 500
  };
}

function setup(t, settings = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-gate-"));
  const file = path.join(dir, "sg-stay-where.sqlite");
  const store = new Store(file);
  const wa = new PropertyWhatsApp({ authDir: path.join(dir, "auth"), store, log: () => {}, ...settings });
  const ev = new EventEmitter();
  wa.attach({ ev, user: { id: "6580000001:7@s.whatsapp.net", lid: "100000000001:7@lid" }, end() {} });
  ev.emit("connection.update", { connection: "open" });
  t.after(async () => {
    await wa.stop();
    clearInterval(wa.purgeTimer);
    clearTimeout(wa.droppedTimer);
    try { store.close(); } catch { /* closed by the test */ }
    rmSync(dir, { recursive: true, force: true });
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  return {
    dir, file, store, wa,
    async live(...messages) { ev.emit("messages.upsert", { messages, type: "notify" }); await settle(); },
    async history(messages, extra = {}) { ev.emit("messaging-history.set", { messages, ...extra }); await settle(); },
    async emit(name, payload) { ev.emit(name, payload); await settle(); }
  };
}

// Every row of every table, read through a separate connection to the file.
function everyRow(file) {
  const db = new DatabaseSync(file);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(tables.includes("wa_messages") && tables.includes("kv"), `tables: ${tables}`);
    return JSON.stringify(Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()])));
  } finally { db.close(); }
}

// The database file and its -wal / -shm companions, byte for byte.
function rawBytes(dir) {
  return readdirSync(dir).filter((f) => f.startsWith("sg-stay-where.sqlite"))
    .map((f) => readFileSync(path.join(dir, f)).toString("latin1")).join("\n");
}

function assertNotOnDisk(env, secrets) {
  const rows = everyRow(env.file);
  const bytes = rawBytes(env.dir);
  for (const s of secrets) {
    assert.ok(!rows.includes(s), `"${s}" found in a table`);
    assert.ok(!bytes.includes(s), `"${s}" found in the raw database bytes`);
  }
}

function assertStored(env, texts) {
  const rows = everyRow(env.file);
  for (const s of texts) assert.ok(rows.includes(s), `"${s}" should be stored`);
}

async function withServer(t, store, fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ssw-gate-http-"));
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  projects.save(newProject({ title: "Home" }));
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(dataDir, { recursive: true, force: true }); });
  const get = (route) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}${route}`, { agent: false }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    }).on("error", reject);
  });
  await fn(get);
}

test("a one-to-one chat without a listing link never reaches the disk or the API", async (t) => {
  const env = setup(t);
  const friend = "6591110001@s.whatsapp.net";
  const secrets = ["PERSONAL-nolink-1", "PERSONAL-nolink-2", "PERSONAL-nolink-3"];
  await env.live(...secrets.map((s, i) => message(friend, `f${i}`, s, { ts: T0 + i, pushName: "Friend" })));
  await env.history([message(friend, "h1", "PERSONAL-nolink-history", { ts: T0 - 100 })]);
  assertNotOnDisk(env, [...secrets, "PERSONAL-nolink-history", "Friend"]);
  await withServer(t, env.store, async (get) => {
    assert.equal((await get(`/api/chats/${encodeURIComponent(friend)}/messages`)).status, 404);
    const state = await get("/api/state?project=home");
    assert.equal(state.status, 200);
    assert.ok(!state.text.includes("PERSONAL-"), "the app state carries no personal text");
  });
});

test("a link after more than 10 messages marks the chat personal and stores none of it", async (t) => {
  const env = setup(t);
  const friend = "6591110002@s.whatsapp.net";
  const chatter = Array.from({ length: 11 }, (_, i) => message(friend, `c${i}`, `PERSONAL-chatter-${i}`, { ts: T0 + i, fromMe: i % 2 === 1 }));
  await env.live(...chatter.slice(0, 6));
  await env.live(...chatter.slice(6));
  await env.live(message(friend, "link", `PERSONAL-shared ${PG(500000101)}`, { ts: T0 + 20, pushName: "Old Friend" }));
  await env.live(message(friend, "after", "PERSONAL-after-link", { ts: T0 + 30 }));
  assertNotOnDisk(env, [...chatter.map((m) => m.message.conversation), "PERSONAL-shared", "PERSONAL-after-link", "Old Friend"]);
  assert.equal(env.store.getChat(friend).ignore_reason, "personal");
  await withServer(t, env.store, async (get) => {
    assert.equal((await get(`/api/chats/${encodeURIComponent(friend)}/messages`)).status, 404);
  });
});

test("the same long chat delivered in one history batch is personal too", async (t) => {
  const env = setup(t);
  const friend = "6591110003@s.whatsapp.net";
  const batch = Array.from({ length: 11 }, (_, i) => message(friend, `c${i}`, `PERSONAL-batch-${i}`, { ts: T0 + i }));
  batch.push(message(friend, "link", `PERSONAL-batch-link ${PG(500000102)}`, { ts: T0 + 50 }));
  await env.history(batch.reverse());
  assertNotOnDisk(env, batch.map((m) => m.message.conversation.split(" ")[0]));
  assert.equal(env.store.isFlagged(friend), false);
});

test("a group chat with a listing link is never stored", async (t) => {
  const env = setup(t);
  const group = "120363000000000001@g.us";
  const m = message(group, "g1", `PERSONAL-group ${PG(500000103)}`, { pushName: "Group Member" });
  m.key.participant = "6591110004@s.whatsapp.net";
  await env.live(m);
  await env.history([message(group, "g2", `PERSONAL-group-history ${PG(500000104)}`)]);
  await env.live(message("status@broadcast", "s1", `PERSONAL-status ${PG(500000105)}`));
  assertNotOnDisk(env, ["PERSONAL-group", "PERSONAL-group-history", "PERSONAL-status", "120363000000000001"]);
});

test("your own chat with a listing link is never stored", async (t) => {
  const env = setup(t);
  await env.live(message(SELF, "n1", `PERSONAL-note-to-self ${PG(500000106)}`, { fromMe: true }));
  await env.live(message(SELF_LID, "n2", `PERSONAL-note-to-self-lid ${PG(500000107)}`, { fromMe: true }));
  assertNotOnDisk(env, ["PERSONAL-note-to-self", "PERSONAL-note-to-self-lid"]);
});

test("a person in excludeNames is never stored, even when the chat opens with a link", async (t) => {
  const env = setup(t, { excludeNames: ["Mum", "Partner Name"] });
  const mum = "6591110005@s.whatsapp.net";
  await env.live(message(mum, "m1", `PERSONAL-mum ${PG(500000108)}`, { pushName: "Mum" }));
  // The partner is matched by your contact name, which arrives with history.
  const partner = "6591110006@s.whatsapp.net";
  await env.history(
    [message(partner, "p1", `PERSONAL-partner ${PG(500000109)}`, { fromMe: true, ts: T0 }), message(partner, "p2", "PERSONAL-partner-reply", { fromMe: true, ts: T0 + 1 })],
    { contacts: [{ id: partner, name: "Partner Name" }] }
  );
  await env.live(message(partner, "p3", "PERSONAL-partner-later", { pushName: "J", ts: T0 + 2 }));
  assertNotOnDisk(env, ["PERSONAL-mum", "PERSONAL-partner", "PERSONAL-partner-reply", "PERSONAL-partner-later"]);
  assert.equal(env.store.getChat(mum).ignore_reason, "excluded");
  assert.equal(env.store.getChat(partner).ignore_reason, "excluded");
});

test("held history is dropped when the sync window closes, and never written", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: T0 * 1000 });
  const env = setup(t);
  const friend = "6591110007@s.whatsapp.net";
  await env.history([1, 2, 3].map((i) => message(friend, `h${i}`, `PERSONAL-held-${i}`, { ts: T0 + i })));
  assert.equal(env.wa.pending.get(friend)?.length, 3, "held in memory during the sync window");
  assertNotOnDisk(env, ["PERSONAL-held-1", "PERSONAL-held-2", "PERSONAL-held-3"]);
  t.mock.timers.tick(4 * 60_000);
  assert.equal(env.wa.pending.size, 0, "dropped when the window closed");
  await env.live(message(friend, "late", `Hi, is this available? ${PG(500000110)}`, { ts: T0 + 10 }));
  assertNotOnDisk(env, ["PERSONAL-held-1", "PERSONAL-held-2", "PERSONAL-held-3"]);
});

test("a long lead-in that arrives after the link is never written", async (t) => {
  const env = setup(t);
  const friend = "6591110008@s.whatsapp.net";
  await env.history([
    message(friend, "link", `PERSONAL-looks-like-agent ${PG(500000111)}`, { ts: T0 + 100 }),
    message(friend, "r1", "PERSONAL-reply-after-link", { ts: T0 + 101 })
  ]);
  assert.equal(env.store.isFlagged(friend), true, "looked like an agent chat at first");
  const older = Array.from({ length: 11 }, (_, i) => message(friend, `o${i}`, `PERSONAL-older-${i}`, { ts: T0 + i }));
  await env.history(older);
  assertNotOnDisk(env, [...older.map((m) => m.message.conversation), "PERSONAL-looks-like-agent", "PERSONAL-reply-after-link"]);
  assert.equal(env.store.getChat(friend).ignore_reason, "personal");
});

test("edits and deletions in chats that are not property chats are never written", async (t) => {
  const env = setup(t);
  const friend = "6591110009@s.whatsapp.net";
  await env.live(message(friend, "e1", "PERSONAL-original", { ts: T0 }));
  await env.live(protocol(friend, "e2", 14, "e1", `PERSONAL-edited ${PG(500000112)}`));
  await env.live(protocol(friend, "e3", 0, "e1"));
  assertNotOnDisk(env, ["PERSONAL-original", "PERSONAL-edited"]);
  // A message deleted while held is not stored when the link arrives.
  const agent = "6591110010@s.whatsapp.net";
  await env.history([message(agent, "a2", "PERSONAL-unsent", { ts: T0 + 5 })]);
  await env.history([protocol(agent, "a3", 0, "a2")]);
  await env.history([message(agent, "a1", `Hi, I am interested in your listing ${PG(500000113)}`, { fromMe: true, ts: T0 + 1 })]);
  assert.equal(env.store.isFlagged(agent), true);
  const agent2 = "6591110015@s.whatsapp.net";
  await env.history([message(agent2, "b2", "PERSONAL-unsent-same-batch", { ts: T0 + 5 }), protocol(agent2, "b3", 0, "b2")]);
  await env.history([message(agent2, "b1", `Hi, is this available? ${PG(500000120)}`, { fromMe: true, ts: T0 + 1 })]);
  assert.equal(env.store.isFlagged(agent2), true);
  assertNotOnDisk(env, ["PERSONAL-unsent", "PERSONAL-unsent-same-batch"]);
});

test("a chat counted under its LID stays personal once its phone number is known", async (t) => {
  const env = setup(t);
  const lid = "200000000009@lid";
  const pn = "6591110011@s.whatsapp.net";
  await env.live(...Array.from({ length: 11 }, (_, i) => message(lid, `l${i}`, `PERSONAL-lid-${i}`, { ts: T0 + i })));
  await env.emit("lid-mapping.update", { lid, pn });
  await env.live(message(pn, "link", `PERSONAL-lid-link ${PG(500000114)}`, { ts: T0 + 20 }));
  assertNotOnDisk(env, ["PERSONAL-lid-link", ...Array.from({ length: 11 }, (_, i) => `PERSONAL-lid-${i}`)]);
  assert.equal(env.store.isFlagged(pn), false);
});

test("an agent chat started from the listing's WhatsApp button is stored and readable", async (t) => {
  const env = setup(t);
  const agent = "6598880001@s.whatsapp.net";
  const intro = `Hi, I am interested in your property listing on PropertyGuru: ${PG(500000115)}`;
  // Out of order: the reply arrives before the enquiry that carries the link.
  await env.history([message(agent, "a2", "AGENT-reply: viewing Saturday 3pm?", { ts: T0 + 60, pushName: "Agent Tan" })]);
  await env.history([message(agent, "a1", intro, { fromMe: true, ts: T0 })]);
  await env.live(message(agent, "a3", "AGENT-followup: unit still available", { ts: T0 + 120, pushName: "Agent Tan" }));
  assertStored(env, [intro, "AGENT-reply: viewing Saturday 3pm?", "AGENT-followup: unit still available"]);
  const listing = env.store.findListingByKey("propertyguru:500000115");
  assert.ok(listing, "the link created a listing");
  await withServer(t, env.store, async (get) => {
    const chat = await get(`/api/chats/${encodeURIComponent(agent)}/messages`);
    assert.equal(chat.status, 200);
    assert.equal(JSON.parse(chat.text).length, 3);
    const messages = await get(`/api/listings/${listing.id}/messages`);
    assert.match(messages.text, /AGENT-reply/);
  });
});

test("npm run privacy reports positions and counts without text, and fails on a chat that slipped past the rule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = setup(t);
  await env.live(message("6598880003@s.whatsapp.net", "a1", `AGENT-intro ${PG(500000117)}`, { fromMe: true, ts: T0, pushName: null }));
  await env.live(message("6598880003@s.whatsapp.net", "a2", "AGENT-answer", { ts: T0 + 1, pushName: "Agent Lim" }));
  await env.live(...Array.from({ length: 4 }, (_, i) => message("6591110012@s.whatsapp.net", `d${i}`, `PERSONAL-dropped-${i}`, { ts: T0 + i })));
  await env.live(...Array.from({ length: 11 }, (_, i) => message("6591110013@s.whatsapp.net", `p${i}`, `PERSONAL-p-${i}`, { ts: T0 + i })));
  await env.live(message("6591110013@s.whatsapp.net", "plink", `PERSONAL-plink ${PG(500000118)}`, { ts: T0 + 20 }));
  t.mock.timers.tick(3000);
  const { privacyReport } = await import("../src/privacy.js");
  const report = privacyReport(env.store, { maxMessagesBeforeLink: 10 });
  assert.equal(report.ok, true, report.text);
  assert.match(report.text, /Stored property chats: 1 \(2 messages\)/);
  assert.match(report.text, /first link at message 1 \(www\.propertyguru\.com\.sg\)/);
  assert.match(report.text, /personal \(more messages than allowed before the first link\): 1/);
  assert.match(report.text, /only a message count kept: 1 chat, 4 messages/);
  assert.doesNotMatch(report.text, /AGENT-|PERSONAL-|Agent Lim|659111|659888/);
  // A chat written around the gate is caught.
  const sneaky = "6591110014@s.whatsapp.net";
  env.store.flagChat(sneaky, { reason: "test" });
  env.store.addMessages(sneaky, [...Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, ts: T0 + i, text: "chit chat" })), { id: "slink", ts: T0 + 50, text: PG(500000119) }]);
  const failed = privacyReport(env.store, { maxMessagesBeforeLink: 10 });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /chat 1 has 11 messages before its first link/);
});

test("Not an agent wipes a stored chat from the database file", async (t) => {
  const env = setup(t);
  const agent = "6598880002@s.whatsapp.net";
  await env.live(message(agent, "a1", `PERSONAL-was-stored ${PG(500000116)}`, { fromMe: true, ts: T0 }));
  assertStored(env, ["PERSONAL-was-stored"]);
  env.store.ignoreChat(agent, "manual");
  assertNotOnDisk(env, ["PERSONAL-was-stored"]);
  env.store.close();
  assertNotOnDisk(env, ["PERSONAL-was-stored"]);
});

test("a friend's Carousell link never opens the gate; a tracked Carousell listing's link does", async (t) => {
  const env = setup(t);
  const friend = "6591110020@s.whatsapp.net";
  await env.live(message(friend, "f1", "PERSONAL-sofa https://www.carousell.sg/p/ikea-sofa-1234567890/", { ts: T0, pushName: "Friend" }));
  await env.live(message(friend, "f2", "PERSONAL-want it?", { ts: T0 + 1, pushName: "Friend" }));
  assertNotOnDisk(env, ["PERSONAL-sofa", "PERSONAL-want it?"]);
  assert.ok(!env.store.findListingByKey("carousell:1234567890"), "no stub listing for an untracked Carousell link");

  env.store.upsertListing({ source: "carousell", source_id: "1468612437", url: "https://www.carousell.sg/p/3-1-whole-unit-for-rent-1468612437/" });
  const agent = "6598880020@s.whatsapp.net";
  const intro = "Hi, is this still available? https://www.carousell.sg/p/3-1-whole-unit-for-rent-1468612437/";
  await env.live(message(agent, "c1", intro, { fromMe: true, ts: T0 + 10 }));
  await env.live(message(agent, "c2", "AGENT-yes available", { ts: T0 + 20, pushName: "Agent Kannan" }));
  assertStored(env, [intro, "AGENT-yes available"]);
});
