// Only property chats (a 99.co / PropertyGuru link was seen in them) ever
// reach wa_chats / wa_messages; see whatsapp.js.
import { createHash } from "node:crypto";
import { findPropertyLinks } from "./links.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { advanceStatus, FOLLOWED, followupStatus, isPortalBotMessage, leadSignals, STATUSES } from "./leads.js";
import { normalizePhone } from "./phone.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  listing_key TEXT UNIQUE,
  source TEXT, source_id TEXT, url TEXT NOT NULL,
  title TEXT, building TEXT, address TEXT, street TEXT, postal TEXT, district TEXT,
  property_type TEXT, bedrooms INTEGER, bathrooms INTEGER, sqft INTEGER, price INTEGER,
  furnishing TEXT, lease TEXT, availability TEXT, built_year TEXT, facts TEXT,
  agent_name TEXT, agent_phone TEXT, agent_agency TEXT,
  lat REAL, lng REAL, source_mrts TEXT, posted_at TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT NOT NULL DEFAULT '',
  found_by TEXT,
  details_at TEXT,
  enrichment TEXT, enriched_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_chats (
  jid TEXT PRIMARY KEY,
  phone TEXT, name TEXT,
  flagged_at TEXT, flag_reason TEXT,
  ignored INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wa_messages (
  chat_jid TEXT NOT NULL, msg_id TEXT NOT NULL,
  from_me INTEGER NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', push_name TEXT,
  PRIMARY KEY (chat_jid, msg_id)
);
CREATE INDEX IF NOT EXISTS wa_messages_chat_ts ON wa_messages (chat_jid, ts);
CREATE TABLE IF NOT EXISTS chat_listings (
  chat_jid TEXT NOT NULL, listing_id INTEGER NOT NULL, how TEXT NOT NULL,
  PRIMARY KEY (chat_jid, listing_id)
);
CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER, chat_jid TEXT, text TEXT NOT NULL, msg_id TEXT,
  sent_at TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL, search TEXT, seen INTEGER, added INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS listing_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL, token TEXT NOT NULL, payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, next TEXT,
  chat_jid TEXT, msg_id TEXT,
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(listing_id, token)
);
CREATE INDEX IF NOT EXISTS listing_updates_listing ON listing_updates(listing_id, id DESC);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
-- Short links (99.co/e/<code>) resolved to the listing they point at.
CREATE TABLE IF NOT EXISTS listing_aliases (alias TEXT PRIMARY KEY, listing_id INTEGER NOT NULL);
`;

// Columns added after the first release; ALTERed in when missing.
const ADDED_COLUMNS = {
  // project_id: the project (data/projects/<id>.json) whose search found it.
  // also: the same flat's other adverts merged into this one ([{ id, source, url }]);
  // merged_into: on such a copy, the listing it was merged into.
  // photo_hashes: fingerprints of its photos (src/photohash.js), for matching across sites.
  listings: { summary: "TEXT", photos: "TEXT", media: "TEXT", project_id: "TEXT", also: "TEXT", merged_into: "INTEGER", photo_hashes: "TEXT", status_version: "INTEGER NOT NULL DEFAULT 0", manual_message_floor: "INTEGER NOT NULL DEFAULT 0" },
  // "agent" or "portal" (a listing site's enquiry bot, e.g. PropertyGuru's).
  wa_chats: { kind: "TEXT" }
};

// Fields an importer may set. status/notes are the user's and never imported.
const LISTING_FIELDS = [
  "source", "source_id", "url", "title", "building", "address", "street", "postal", "district",
  "property_type", "bedrooms", "bathrooms", "sqft", "price", "furnishing", "lease", "availability",
  "built_year", "facts", "agent_name", "agent_phone", "agent_agency", "lat", "lng", "source_mrts",
  "posted_at", "found_by", "details_at", "photos", "project_id"
];
const JSON_FIELDS = new Set(["facts", "source_mrts", "enrichment", "summary", "photos", "media", "also", "photo_hashes"]);
const EDITABLE = new Set(["status", "notes", "agent_phone", "agent_name", "price", "building", "address", "bedrooms", "lat", "lng"]);

const now = () => new Date().toISOString();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const replyDigest = messages => {
  const m = messages.findLast(m => !m.from_me && !m.via_portal);
  return m ? digest([m.chat_jid, m.msg_id, m.text]) : null;
};
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// The token a chat message contains when it mentions this listing: the id
// from its key ("propertyguru:500297009" -> "500297009"; a 99.co short link
// "99co:e-AbC123" -> "AbC123").
function mentionNeedle(listing) {
  const id = listing?.listing_key?.split(":")[1];
  return id ? id.replace(/^e-/, "") : listing?.url ?? null;
}

function decodeListing(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of JSON_FIELDS) out[key] = row[key] ? JSON.parse(row[key]) : null;
  return out;
}

export class Store {
  // Carousell links count as listing links only for listings already tracked.
  #tracked = { isTracked: (key) => Boolean(this.findListingByKey(key)) };

  constructor(file) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // secure_delete: deleted chat text is overwritten, not left in free pages.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    this.db.exec(SCHEMA);
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const [name, type] of Object.entries(columns)) {
        if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
    // Earlier versions stored a placeholder summary on every manual status change.
    this.db.exec("UPDATE listings SET summary = NULL WHERE summary IS NOT NULL AND json_extract(summary, '$.text') IS NULL");
  }

  close() { this.db.close(); }

  get(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key, value) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  // Matches on listing_key (source:id) or, failing that, the canonical URL.
  // Incoming non-empty fields overwrite; the user's status and notes are kept.
  upsertListing(input) {
    const listingKey = input.listing_key ?? (input.source && input.source_id ? `${input.source}:${input.source_id}` : null);
    // input.id targets a row directly, e.g. a short-link stub whose real
    // listing was just opened. The row keeps its key (the short code), which
    // is what the chat contains.
    const existing = input.id
      ? this.db.prepare("SELECT * FROM listings WHERE id = ?").get(input.id)
      : listingKey
        ? this.db.prepare("SELECT * FROM listings WHERE listing_key = ?").get(listingKey)
        : this.db.prepare("SELECT * FROM listings WHERE url = ?").get(input.url);
    if (input.id && !existing) throw new Error(`no listing ${input.id}`);
    const values = {};
    for (const key of LISTING_FIELDS) {
      let value = input[key];
      if (value === undefined || value === null || value === "") continue;
      if (key === "agent_phone") value = normalizePhone(value);
      if (JSON_FIELDS.has(key)) value = JSON.stringify(value);
      values[key] = value;
    }
    const stamp = now();
    // A search-card import must not overwrite what the listing page gave us;
    // from a card, only the things that change (price, availability) apply.
    // A listing stays with the project that found it first.
    if (existing?.project_id) delete values.project_id;
    if (existing?.details_at && !values.details_at) {
      for (const key of Object.keys(values)) if (!["price", "availability"].includes(key)) delete values[key];
    }
    if (existing) {
      // A new position invalidates the old distances.
      const moved = (values.lat != null && values.lat !== existing.lat) || (values.lng != null && values.lng !== existing.lng);
      const keys = Object.keys(values);
      if (moved) keys.push("enriched_at");
      if (keys.length) {
        const sets = keys.map((k) => `${k} = ?`).join(", ");
        const args = keys.map((k) => (k === "enriched_at" ? null : values[k]));
        this.db.prepare(`UPDATE listings SET ${sets}, updated_at = ? WHERE id = ?`).run(...args, stamp, existing.id);
      }
      return { listing: this.getListing(existing.id), created: false };
    }
    if (!values.url) throw new Error("listing needs a url");
    const keys = ["listing_key", ...Object.keys(values), "created_at", "updated_at"];
    const args = [listingKey, ...Object.values(values), stamp, stamp];
    const { lastInsertRowid } = this.db.prepare(
      `INSERT INTO listings (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`
    ).run(...args);
    const id = Number(lastInsertRowid);
    this.#linkChatsByUrl(id);
    return { listing: this.getListing(id), created: true };
  }

  getListing(id) {
    return this.#listings().byId.get(Number(id)) ?? null;
  }

  // A merged copy answers with the listing it was merged into, so a chat about
  // either site's link lands on the one card.
  findListingByKey(listingKey) {
    const found = decodeListing(this.db.prepare("SELECT * FROM listings WHERE listing_key = ?").get(listingKey))
      ?? decodeListing(this.db.prepare("SELECT l.* FROM listing_aliases a JOIN listings l ON l.id = a.listing_id WHERE a.alias = ?").get(listingKey));
    return found?.merged_into ? this.getListing(found.merged_into) ?? found : found;
  }

  mergeListing(copyId, requestedKeepId, note) {
    // Always merge into the end of a chain, and never into itself.
    let keepId = requestedKeepId;
    for (let hops = 0; hops < 10; hops++) {
      const next = this.getListing(keepId)?.merged_into;
      if (!next || next === keepId) break;
      keepId = next;
    }
    const copy = this.getListing(copyId);
    const keep = this.getListing(keepId);
    if (!copy || !keep || copyId === keepId || keep.merged_into) return null;
    this.db.prepare("UPDATE listings SET status = 'rejected', notes = ?, merged_into = ?, summary = NULL, status_version = status_version + 1, updated_at = ? WHERE id = ?").run(note, keepId, now(), copyId);
    this.db.prepare("UPDATE listings SET status_version = status_version + 1, manual_message_floor = MAX(manual_message_floor, ?) WHERE id = ?").run(copy.manual_message_floor, keepId);
    // The copy's status and notes, so a split can put it back as it was. Copies
    // already merged into the copy move along to the listing kept.
    this.db.prepare("UPDATE listings SET merged_into = ?, summary = NULL, status_version = status_version + 1 WHERE merged_into = ?").run(keepId, copyId);
    this.db.prepare("UPDATE listing_aliases SET listing_id = ? WHERE listing_id = ?").run(keepId, copyId);
    const also = [...(keep.also ?? []).filter((a) => a.id !== copyId), ...(copy.also ?? []), { id: copyId, source: copy.source, url: copy.url, status: copy.status, notes: copy.notes }];
    this.db.prepare("UPDATE listings SET also = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(also), now(), keepId);
    this.db.prepare("UPDATE listings SET also = NULL WHERE id = ?").run(copyId);
    if (copy.listing_key) {
      this.db.prepare("INSERT INTO listing_aliases (alias, listing_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET listing_id = excluded.listing_id").run(copy.listing_key, keepId);
    }
    this.db.prepare("INSERT OR IGNORE INTO chat_listings (chat_jid, listing_id, how) SELECT chat_jid, ?, how FROM chat_listings WHERE listing_id = ?").run(keepId, copyId);
    this.db.prepare("DELETE FROM chat_listings WHERE listing_id = ?").run(copyId);
    this.refreshLead(keepId);
    return this.getListing(keepId);
  }

  // A short link turned out to be `listingId`: remember that, and fold the
  // stub listing it had created (chats, status, notes) into the real one.
  mergeAlias(aliasKey, listingId) {
    this.db.prepare("INSERT INTO listing_aliases (alias, listing_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET listing_id = excluded.listing_id")
      .run(aliasKey, listingId);
    const stub = this.db.prepare("SELECT * FROM listings WHERE listing_key = ? AND id != ?").get(aliasKey, listingId);
    if (!stub) return;
    this.db.prepare("INSERT OR IGNORE INTO chat_listings (chat_jid, listing_id, how) SELECT chat_jid, ?, how FROM chat_listings WHERE listing_id = ?")
      .run(listingId, stub.id);
    const real = this.getListing(listingId);
    const order = ["new", "shortlisted", "contacted", "replied", "viewing_scheduled", "viewed", "applied"];
    const patch = {};
    if (order.includes(real.status) && order.indexOf(stub.status) > order.indexOf(real.status)) patch.status = stub.status;
    if (stub.status === "rejected" || (order.includes(real.status) && ["closed", "unavailable"].includes(stub.status))) patch.status = stub.status;
    if (stub.notes && !real.notes.includes(stub.notes)) patch.notes = [real.notes, stub.notes].filter(Boolean).join("\n");
    if (Object.keys(patch).length) this.updateListing(listingId, patch);
    this.db.prepare("UPDATE listings SET status_version = status_version + 1 WHERE id = ?").run(listingId);
    this.deleteListing(stub.id);
  }

  aliasesFor(listingId) {
    return this.db.prepare("SELECT alias FROM listing_aliases WHERE listing_id = ?").all(listingId).map((r) => r.alias);
  }

  // Decoded listings, reused until the database changes: this connection's writes
  // (total_changes) or another process's (data_version). Loops that compare every
  // listing with every other one would otherwise decode the table each time.
  #cache = { key: null, rows: [], byId: new Map() };
  changeKey() {
    return `${this.db.prepare("SELECT total_changes() AS n").get().n}:${this.db.prepare("PRAGMA data_version").get().data_version}`;
  }

  #listings() {
    const key = this.changeKey();
    if (this.#cache.key !== key) {
      const rows = this.db.prepare("SELECT * FROM listings ORDER BY created_at DESC").all().map((r) => Object.freeze(decodeListing(r)));
      this.#cache = { key, rows, byId: new Map(rows.map((l) => [l.id, l])) };
    }
    return this.#cache;
  }

  listListings(projectId = null) {
    const { rows } = this.#listings();
    return projectId ? rows.filter((l) => l.project_id === projectId) : [...rows];
  }

  // Listings with no project yet (from before projects, or a chat link) join this one.
  adoptOrphans(projectId) {
    return this.db.prepare("UPDATE listings SET project_id = ? WHERE project_id IS NULL").run(projectId).changes;
  }

  updateListing(id, patch, { automatic = false } = {}) {
    const keys = Object.keys(patch).filter((k) => EDITABLE.has(k));
    if (keys.includes("status") && !STATUSES.includes(patch.status)) fail(400, `unknown status ${patch.status}`);
    if (!keys.length) return this.getListing(id);
    if (keys.includes("status")) {
      const floor = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM wa_messages").get().n;
      this.db.prepare(`UPDATE listings SET status_version = status_version + 1${automatic ? "" : ", manual_message_floor = ?"} WHERE id = ?`)
        .run(...(automatic ? [id] : [floor, id]));
      // The user's choice supersedes the agent's earlier read: keep its text, drop its appointment and verdict.
      const summary = automatic ? null : this.getListing(id)?.summary;
      if (summary?.text) {
        const { decision, ...rest } = summary;
        this.db.prepare("UPDATE listings SET summary = ? WHERE id = ?")
          .run(JSON.stringify({ ...rest, viewing: null, manually_adjusted: true }), id);
      }
    }
    const args = keys.map((k) => (k === "agent_phone" ? normalizePhone(patch[k]) : patch[k]));
    this.db.prepare(`UPDATE listings SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...args, now(), id);
    return this.getListing(id);
  }

  deleteListing(id) {
    this.db.prepare("DELETE FROM listing_updates WHERE listing_id = ?").run(id);
    this.db.prepare("DELETE FROM chat_listings WHERE listing_id = ?").run(id);
    this.db.prepare("DELETE FROM listings WHERE id = ?").run(id);
  }

  setEnrichment(id, enrichment) {
    this.db.prepare("UPDATE listings SET enrichment = ?, enriched_at = ? WHERE id = ?")
      .run(JSON.stringify(enrichment), now(), id);
  }

  invalidateMaps(projectId) {
    for (const listing of this.listListings(projectId)) {
      this.db.prepare("UPDATE listings SET enrichment = NULL, enriched_at = NULL, media = ? WHERE id = ?")
        .run(JSON.stringify({ ...listing.media, maps: {} }), listing.id);
    }
  }

  // Claude's reading of the listing's chat: { text, viewing: { at, place,
  // confirmed }, next, through_ts }. through_ts is the last message it covers.
  setSummary(id, summary) {
    const conversation = this.followup(id);
    this.db.prepare("UPDATE listings SET summary = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ ...summary, conversation_token: conversation.token, reply_digest: replyDigest(conversation.messages), updated_at: now() }), now(), id);
  }

  // The pair is remembered as two different flats so automatic matching leaves it alone.
  splitListing(copyId) {
    const copy = this.getListing(copyId);
    if (!copy?.merged_into) return null;
    const keep = this.getListing(copy.merged_into);
    const entry = keep?.also?.find((a) => a.id === copyId);
    this.db.prepare("UPDATE listings SET status = ?, notes = ?, merged_into = NULL, summary = NULL, status_version = status_version + 1, updated_at = ? WHERE id = ?")
      .run(entry?.status && entry.status !== "rejected" ? entry.status : "new", entry?.notes ?? "", now(), copyId);
    this.updateListing(copyId, { status: this.getListing(copyId).status });
    if (keep) this.db.prepare("UPDATE listings SET status_version = status_version + 1 WHERE id = ?").run(keep.id);
    if (keep) this.db.prepare("UPDATE listings SET also = ?, updated_at = ? WHERE id = ?").run(JSON.stringify((keep.also ?? []).filter((a) => a.id !== copyId)), now(), keep.id);
    if (copy.listing_key) this.db.prepare("DELETE FROM listing_aliases WHERE alias = ? AND listing_id = ?").run(copy.listing_key, copy.merged_into);
    this.#linkChatsByUrl(copyId);
    this.markDistinct(copyId, copy.merged_into);
    this.refreshLead(copyId);
    if (keep) this.refreshLead(keep.id);
    return this.getListing(copyId);
  }

  // Pairs the user said are different flats (kv "distinct_pairs": ["3-17", ...]).
  markDistinct(a, b) {
    const key = [a, b].sort((x, y) => x - y).join("-");
    const pairs = new Set(this.get("distinct_pairs", []));
    pairs.add(key);
    this.set("distinct_pairs", [...pairs]);
  }

  isDistinct(a, b) {
    return this.get("distinct_pairs", []).includes([a, b].sort((x, y) => x - y).join("-"));
  }

  setPhotoHashes(id, hashes) {
    const listing = this.getListing(id);
    if (!listing) return null;
    const all = [...new Set([...(listing.photo_hashes ?? []), ...hashes.filter((h) => /^[0-9a-f]{16}$/.test(h))])].slice(0, 24);
    this.db.prepare("UPDATE listings SET photo_hashes = ? WHERE id = ?").run(JSON.stringify(all), id);
    return all;
  }

  setMedia(id, media) {
    this.db.prepare("UPDATE listings SET media = ? WHERE id = ?").run(JSON.stringify(media), id);
  }

  listingsNeedingEnrichment() {
    return this.db.prepare("SELECT * FROM listings WHERE enriched_at IS NULL").all().map(decodeListing);
  }

  getChat(jid) {
    return this.db.prepare("SELECT * FROM wa_chats WHERE jid = ?").get(jid) ?? null;
  }

  isFlagged(jid) {
    const chat = this.getChat(jid);
    return !!chat?.flagged_at && !chat.ignored;
  }

  isIgnored(jid) {
    return !!this.getChat(jid)?.ignored;
  }

  flagChat(jid, { reason, phone = null, name = null }) {
    this.db.prepare(`
      INSERT INTO wa_chats (jid, phone, name, flagged_at, flag_reason) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        phone = COALESCE(excluded.phone, wa_chats.phone),
        name = COALESCE(excluded.name, wa_chats.name),
        flagged_at = COALESCE(wa_chats.flagged_at, excluded.flagged_at),
        flag_reason = COALESCE(wa_chats.flag_reason, excluded.flag_reason)
      WHERE wa_chats.ignored = 0
    `).run(jid, phone, name, now(), reason);
  }

  classifyChat(jid) {
    const portal = this.chatMessages(jid).some(isPortalBotMessage);
    this.db.prepare("UPDATE wa_chats SET kind = ? WHERE jid = ?").run(portal ? "portal" : "agent", jid);
    return portal ? "portal" : "agent";
  }

  setChatName(jid, name) {
    if (name) this.db.prepare("UPDATE wa_chats SET name = ? WHERE jid = ? AND ignored = 0").run(name, jid);
  }

  // Not an agent chat (excluded person, personal chat, or the user said so):
  // forget everything stored for it and never flag it again. Listings that only
  // this chat had moved to contacted/replied go back to shortlisted.
  ignoreChat(jid, reason = "manual") {
    const listingIds = this.listingIdsForChat(jid);
    this.#forgetChatInterpretations(jid);
    this.db.prepare("DELETE FROM wa_messages WHERE chat_jid = ?").run(jid);
    this.db.prepare("DELETE FROM chat_listings WHERE chat_jid = ?").run(jid);
    this.db.prepare(`
      INSERT INTO wa_chats (jid, ignored, flag_reason) VALUES (?, 1, ?)
      ON CONFLICT(jid) DO UPDATE SET ignored = 1, flagged_at = NULL, flag_reason = excluded.flag_reason, name = NULL
    `).run(jid, `ignored:${reason}`);
    // Older page versions in the write-ahead log still hold the deleted text.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const id of listingIds) {
      const listing = this.getListing(id);
      if (listing && !this.chatsForListing(id).length && ["contacted", "replied"].includes(listing.status)) {
        this.updateListing(id, { status: "shortlisted" }, { automatic: true });
      }
    }
  }

  // Lets a chat be flagged again (e.g. an agent you had chatted with before).
  unignoreChat(jid) {
    this.db.prepare("DELETE FROM wa_chats WHERE jid = ? AND ignored = 1").run(jid);
  }

  listChats() {
    return this.db.prepare(`
      SELECT c.*, COUNT(m.msg_id) AS message_count, MAX(m.ts) AS last_ts,
             (SELECT GROUP_CONCAT(listing_id) FROM chat_listings cl WHERE cl.chat_jid = c.jid) AS listing_ids
      FROM wa_chats c LEFT JOIN wa_messages m ON m.chat_jid = c.jid
      WHERE c.flagged_at IS NOT NULL AND c.ignored = 0
      GROUP BY c.jid ORDER BY last_ts DESC
    `).all().map((row) => ({ ...row, listing_ids: row.listing_ids ? row.listing_ids.split(",").map(Number) : [] }));
  }

  // Counts for `ssw privacy`: ignored chats by reason, and messages held for
  // chats that are not property chats (the gate keeps this at 0).
  chatCensus() {
    return {
      ignored: this.db.prepare("SELECT flag_reason AS reason, COUNT(*) AS n FROM wa_chats WHERE ignored = 1 GROUP BY flag_reason ORDER BY n DESC").all(),
      outside: this.db.prepare("SELECT COUNT(*) AS n FROM wa_messages m LEFT JOIN wa_chats c ON c.jid = m.chat_jid WHERE c.flagged_at IS NULL OR c.ignored = 1").get().n
    };
  }

  addMessages(chatJid, messages) {
    if (!this.isFlagged(chatJid)) throw new Error(`refusing to store messages for unflagged chat ${chatJid}`);
    const insert = this.db.prepare(`
      INSERT INTO wa_messages (rowid, chat_jid, msg_id, from_me, ts, text, push_name) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid, msg_id) DO UPDATE SET text = excluded.text
    `);
    let seq = Math.max(this.get("message_sequence", 0), this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM wa_messages").get().n);
    for (const m of messages) insert.run(++seq, chatJid, m.id, m.fromMe ? 1 : 0, m.ts, m.text ?? "", m.pushName ?? null);
    this.set("message_sequence", seq);
  }

  editMessage(chatJid, msgId, text) {
    this.db.prepare("UPDATE wa_messages SET text = ? WHERE chat_jid = ? AND msg_id = ?").run(text, chatJid, msgId);
  }

  deleteMessage(chatJid, msgId) {
    this.#forgetChatInterpretations(chatJid);
    this.db.prepare("DELETE FROM wa_messages WHERE chat_jid = ? AND msg_id = ?").run(chatJid, msgId);
  }

  chatMessages(jid) {
    return this.db.prepare("SELECT rowid AS received_seq, * FROM wa_messages WHERE chat_jid = ? ORDER BY ts, rowid").all(jid);
  }

  linkChat(chatJid, listingId, how) {
    this.db.prepare("INSERT OR IGNORE INTO chat_listings (chat_jid, listing_id, how) VALUES (?, ?, ?)").run(chatJid, listingId, how);
  }

  unlinkChat(chatJid, listingId) {
    this.#forgetChatInterpretations(chatJid);
    this.db.prepare("DELETE FROM chat_listings WHERE chat_jid = ? AND listing_id = ?").run(chatJid, listingId);
  }

  listingIdsForChat(chatJid) {
    return this.db.prepare("SELECT listing_id FROM chat_listings WHERE chat_jid = ?").all(chatJid).map((r) => r.listing_id);
  }

  chatsForListing(listingId) {
    return this.db.prepare(`
      SELECT c.*, cl.how FROM chat_listings cl JOIN wa_chats c ON c.jid = cl.chat_jid
      WHERE cl.listing_id = ? AND c.ignored = 0
      ORDER BY c.kind = 'portal'
    `).all(listingId);
  }

  // A chat that mentioned this listing's URL before the listing was tracked.
  #linkChatsByUrl(listingId) {
    const needle = mentionNeedle(this.getListing(listingId));
    if (!needle) return;
    const rows = this.db.prepare(`
      SELECT DISTINCT m.chat_jid FROM wa_messages m JOIN wa_chats c ON c.jid = m.chat_jid
      WHERE c.ignored = 0 AND instr(m.text, ?) > 0
    `).all(needle);
    for (const { chat_jid } of rows) this.linkChat(chat_jid, listingId, "url");
  }

  // The part of each linked chat that concerns this listing: from the first
  // message mentioning it onwards. An agent may send several listings in one
  // chat; each starts its own thread there. Chats linked by an app send or by
  // hand count from their start.
  listingMessages(listingId) {
    const listing = this.getListing(listingId);
    if (!listing) return [];
    const needles = [mentionNeedle(listing), ...this.aliasesFor(listingId).map((a) => mentionNeedle({ listing_key: a }))].filter(Boolean);
    const out = [];
    const mentions = (m) => needles.some((n) => m.text.includes(n));
    for (const chat of this.db.prepare(`
      SELECT cl.chat_jid, cl.how, c.kind FROM chat_listings cl JOIN wa_chats c ON c.jid = cl.chat_jid WHERE cl.listing_id = ? AND c.ignored = 0 AND c.flagged_at IS NOT NULL
    `).all(listingId)) {
      const messages = this.chatMessages(chat.chat_jid);
      // In a portal bot chat only your enquiry about this listing matters.
      if (chat.kind === "portal") {
        out.push(...messages.filter((m) => m.from_me && mentions(m)).map((m) => ({ ...m, via_portal: 1 })));
        continue;
      }
      // A later link starts another property's segment. Do not display its
      // replies under every flat the same agent has ever discussed.
      let relevant = chat.how !== "url" && !messages.some(m => findPropertyLinks(m.text, this.#tracked).length) && this.listingIdsForChat(chat.chat_jid).length === 1;
      for (const m of messages) {
        const links = findPropertyLinks(m.text, this.#tracked);
        if (links.length) relevant = links.every(link => this.#listingForLink(link) === listingId);
        if (relevant) out.push(m);
      }
    }
    return out.sort((a, b) => a.ts - b.ts || a.received_seq - b.received_seq);
  }

  // The chat is with the listing's agent, so its number is the agent's when
  // the listing page did not give one.
  refreshLead(listingId) {
    const listing = this.getListing(listingId);
    if (!listing) return null;
    if (!listing.agent_phone) {
      const phone = this.chatsForListing(listingId).find((c) => c.phone)?.phone;
      if (phone) this.db.prepare("UPDATE listings SET agent_phone = ? WHERE id = ?").run(phone, listingId);
    }
    const signals = leadSignals(this.listingMessages(listingId));
    const next = advanceStatus(listing.status, signals);
    if (next !== listing.status) this.updateListing(listingId, { status: next }, { automatic: true });
    return signals;
  }

  followup(id, messages = this.listingMessages(id)) {
    const listing = this.getListing(id);
    if (!listing) fail(404, "No such listing");
    return {
      listing, messages,
      token: digest([listing.status, listing.status_version, listing.merged_into, messages])
    };
  }

  #listingForLink(link) {
    if (link.listingKey) return this.findListingByKey(link.listingKey)?.id;
    const row = this.db.prepare("SELECT id, merged_into FROM listings WHERE url = ?").get(link.url);
    return row?.merged_into ?? row?.id;
  }

  #forgetChatInterpretations(jid) {
    const ids = new Set(this.listingIdsForChat(jid));
    for (const l of this.listListings()) if (ids.has(l.merged_into)) ids.add(l.id);
    for (const id of ids) {
      this.db.prepare("DELETE FROM listing_updates WHERE listing_id = ?").run(id);
      this.db.prepare("UPDATE listings SET summary = NULL WHERE id = ?").run(id);
    }
    this.db.prepare("DELETE FROM listing_updates WHERE chat_jid = ?").run(jid);
  }

  #evidenceFor(id, messages, reference) {
    const evidence = messages.find(m => m.chat_jid === reference?.chat_jid && m.msg_id === reference?.msg_id);
    if (!evidence || evidence.from_me || evidence.via_portal) fail(400, "Evidence must name a stored incoming property-agent message");
    if (messages.findLast(m => m.chat_jid === evidence.chat_jid && !m.from_me) !== evidence) fail(409, "Use the latest agent message in this conversation");
    // The last property link establishes the subject. Unknown links or multiple
    // flats in the same message leave it ambiguous; the poll can summarise only.
    const conversation = this.chatMessages(evidence.chat_jid);
    const end = conversation.findIndex(m => m.msg_id === evidence.msg_id);
    const subject = conversation.slice(0, end + 1).findLast(m => findPropertyLinks(m.text, this.#tracked).length);
    const links = findPropertyLinks(subject?.text, this.#tracked);
    if (!links.length || links.some(link => this.#listingForLink(link) !== id)) fail(409, "The reply's property is ambiguous. Save a summary without changing status.");
    return evidence;
  }

  recordFollowup(id, input) {
    const payloadHash = digest(input);
    const prior = this.db.prepare("SELECT * FROM listing_updates WHERE listing_id = ? AND token = ?").get(id, input.token ?? "");
    if (prior) {
      if (prior.payload_hash !== payloadHash) fail(409, "This conversation snapshot was already reviewed");
      return { listing: this.getListing(id), update: prior, applied: false };
    }
    const { listing, messages, token } = this.followup(id);
    if (listing.merged_into || listing.status === "rejected") fail(409, "Hidden or merged listings cannot be changed by a chat review");
    if (input.token !== token) fail(409, "The conversation or status changed. Read the follow-up again.");
    const summary = input.summary;
    if (!summary || typeof summary.text !== "string" || !summary.text.trim() || summary.text.length > 4000 || (summary.next != null && (typeof summary.next !== "string" || summary.next.length > 2000))) fail(400, "A short summary and optional next step are required");
    if (!messages.length) fail(409, "No property messages to review");
    const outcome = input.outcome ?? "none";
    let next;
    try { next = followupStatus(listing.status, outcome); } catch (error) { fail(409, error.message); }
    let evidence = messages.findLast(m => !m.from_me && !m.via_portal);
    if (outcome !== "none") {
      evidence = this.#evidenceFor(id, messages, input.evidence);
      if (evidence.received_seq <= listing.manual_message_floor) fail(409, "This message predates the user's last status choice. Keep that choice.");
    }
    const viewing = summary.viewing;
    if (viewing != null && (typeof viewing !== "object" || !Number.isFinite(Date.parse(viewing.at)) || !/(Z|[+-]\d\d:\d\d)$/.test(viewing.at) || typeof viewing.confirmed !== "boolean" || (viewing.place != null && (typeof viewing.place !== "string" || viewing.place.length > 1000)))) fail(400, "Viewing needs an ISO date with timezone, confirmed boolean, and optional place");
    if (outcome === "viewing_scheduled" && !viewing?.confirmed) fail(400, "A scheduled viewing needs a confirmed time");
    const clearViewing = ["viewing_cancelled", "declined", "ended", "unavailable"].includes(outcome) || ["closed", "unavailable"].includes(next);
    const decision = clearViewing ? "not_viewing" : next === "viewing_scheduled" ? "viewing" : next === "viewed" ? "viewed" : "maybe";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (next !== listing.status) this.updateListing(id, { status: next }, { automatic: true });
      const saved = {
        text: summary.text.trim(), next: summary.next ?? null,
        viewing: clearViewing ? null : outcome === "viewing_scheduled" ? viewing : listing.summary?.viewing ?? null, decision,
        outcome, through_ts: messages.at(-1).ts,
        reply_digest: replyDigest(messages),
        conversation_token: this.followup(id, messages).token, updated_at: now()
      };
      this.db.prepare("UPDATE listings SET summary = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(saved), now(), id);
      const result = this.db.prepare(`INSERT INTO listing_updates
        (listing_id, token, payload_hash, kind, text, next, chat_jid, msg_id, from_status, to_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, token, payloadHash, outcome, saved.text, saved.next, evidence?.chat_jid ?? messages.at(-1).chat_jid, evidence?.msg_id ?? messages.at(-1).msg_id, listing.status, next, now());
      this.db.exec("COMMIT");
      return { listing: this.getListing(id), update: Number(result.lastInsertRowid), applied: next !== listing.status };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  updates(projectId, conversations = null) {
    const seen = new Set(this.get(`updates_seen:${projectId}`, []));
    const reviews = this.db.prepare(`SELECT u.* FROM listing_updates u
      JOIN listings l ON l.id = u.listing_id
      JOIN wa_chats c ON c.jid = u.chat_jid
      JOIN chat_listings cl ON cl.chat_jid = u.chat_jid AND cl.listing_id = l.id
      WHERE l.project_id = ? AND l.merged_into IS NULL AND l.status NOT IN ('new', 'rejected')
        AND c.ignored = 0 AND c.flagged_at IS NOT NULL
      ORDER BY u.id DESC LIMIT 100`).all(projectId)
      .map(u => ({ ...u, key: `review:${u.id}`, at: Date.parse(u.created_at) / 1000 }));
    const replies = [];
    const snapshots = conversations ? [...conversations.values()] : this.listListings(projectId).map(l => this.followup(l.id));
    for (const { listing: l, messages } of snapshots) {
      if (l.merged_into || !(FOLLOWED.has(l.status) || ["closed", "unavailable"].includes(l.status))) continue;
      const message = messages.findLast(m => !m.from_me && !m.via_portal);
      if (!message || l.summary?.reply_digest === replyDigest(messages)) continue;
      replies.push({ key: `reply:${l.id}:${digest([message.chat_jid, message.msg_id, message.text])}`, listing_id: l.id, kind: "reply", text: message.text.slice(0, 2000), at: message.ts });
    }
    const items = [...reviews, ...replies].sort((a, b) => b.at - a.at || b.key.localeCompare(a.key)).slice(0, 100)
      .map(item => ({ ...item, unread: !seen.has(item.key) }));
    return { items, unread: items.filter(item => item.unread).length };
  }

  readUpdates(projectId, keys) {
    if (!Array.isArray(keys) || keys.length > 100 || keys.some(k => typeof k !== "string")) fail(400, "keys must be the displayed updates (at most 100)");
    const allowed = new Set(this.updates(projectId).items.map(item => item.key));
    const seen = new Set(this.get(`updates_seen:${projectId}`, []));
    for (const key of keys) if (allowed.has(key)) { seen.delete(key); seen.add(key); }
    this.set(`updates_seen:${projectId}`, [...seen].slice(-500));
  }

  recordSend({ listingId, chatJid, text, msgId = null, error = null }) {
    this.db.prepare("INSERT INTO sends (listing_id, chat_jid, text, msg_id, sent_at, error) VALUES (?, ?, ?, ?, ?, ?)")
      .run(listingId, chatJid, text, msgId, now(), error);
  }

  sentBefore(chatJid, text) {
    const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
    return this.db.prepare("SELECT text FROM sends WHERE chat_jid = ? AND error IS NULL").all(chatJid).some((s) => norm(s.text) === norm(text));
  }

  sendsForListing(listingId) {
    return this.db.prepare("SELECT * FROM sends WHERE listing_id = ? ORDER BY sent_at").all(listingId);
  }

  recordPoll({ search, seen, added, note = null }) {
    this.db.prepare("INSERT INTO polls (at, search, seen, added, note) VALUES (?, ?, ?, ?, ?)").run(now(), search, seen, added, note);
  }

  lastPollBySearch() {
    const rows = this.db.prepare("SELECT * FROM polls WHERE id IN (SELECT MAX(id) FROM polls GROUP BY search)").all();
    return Object.fromEntries(rows.map((r) => [r.search, r]));
  }

  recentPolls(limit = 10) {
    return this.db.prepare("SELECT * FROM polls ORDER BY id DESC LIMIT ?").all(limit);
  }
}
