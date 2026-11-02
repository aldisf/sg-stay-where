// Privacy boundary: only *property chats* are stored or shown. A chat becomes
// one when a message in it carries a 99.co or PropertyGuru link (or when this
// app sends an intro, which always carries the listing link). Everything else
// is checked for a link in memory and dropped. Group chats, broadcasts,
// channels and the self chat are never considered.
//
// History sync can deliver a chat's newer messages before the older message
// with the link, so during the sync window unflagged one-to-one messages are
// held in memory (never written, never logged) and dropped when it closes.
//
// Never marks messages read and never sends presence. The only outbound call
// is send(), which the user triggers per listing.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { findPropertyLinks } from "./links.js";
import { normalizePhone, phoneFromJid } from "./phone.js";

// libsignal, under Baileys, logs "Closing session:" and the like with the whole
// session, ratchet private keys included, and the server's stdout is a log file.
const signal = createRequire(createRequire(import.meta.url).resolve("@whiskeysockets/baileys"));
signal("libsignal/src/session_record.js").createEntry().constructor.prototype[inspect.custom] = () => "<session>";

const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const HISTORY_WINDOW_MS = 3 * 60_000;
const PENDING_PER_CHAT = 300;
// An agent chat starts with (or right before) the listing link. A long
// conversation in which someone shares a link is a personal chat.
const DEFAULT_MAX_BEFORE_LINK = 10;
const PROTOCOL_REVOKE = 0;
const PROTOCOL_MESSAGE_EDIT = 14;

function timestampOf(value) {
  if (value == null) return null;
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

export function messageText(content) {
  const type = getContentType(content);
  if (!type) return null;
  const node = content[type];
  switch (type) {
    case "conversation": return node ?? "";
    case "extendedTextMessage": return node?.text ?? "";
    case "imageMessage": return node?.caption ? `[photo] ${node.caption}` : "[photo]";
    case "videoMessage": return node?.caption ? `[video] ${node.caption}` : "[video]";
    case "documentMessage": case "documentWithCaptionMessage":
      return `[document] ${node?.fileName ?? node?.caption ?? ""}`.trim();
    case "audioMessage": return "[voice message]";
    case "locationMessage": return `[location] ${[node?.name, node?.address].filter(Boolean).join(", ")}`.trim();
    case "contactMessage": return `[contact] ${node?.displayName ?? ""}`.trim();
    case "stickerMessage": return "[sticker]";
    default: return typeof node?.text === "string" ? node.text : null;
  }
}

export class PropertyWhatsApp extends EventEmitter {
  // deviceName: how the session appears under WhatsApp › Linked devices.
  constructor({ authDir, store, log = console.log, excludeNames = [], maxMessagesBeforeLink = DEFAULT_MAX_BEFORE_LINK, deviceName = "sg-stay-where" }) {
    super();
    this.deviceName = deviceName;
    this.authDir = authDir;
    this.store = store;
    this.log = log;
    this.excludeNames = new Set(excludeNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
    this.maxBeforeLink = maxMessagesBeforeLink;
    // Per unflagged chat: how many messages were seen and discarded. A count only.
    this.dropped = new Map(Object.entries(store.get("wa.dropped_counts", {})));
    this.state = this.linked() ? "stopped" : "unlinked";
    this.qr = null;
    this.selfJid = null;
    this.selfLid = null;
    this.lidToPn = new Map(Object.entries(store.get("wa.lid_to_pn", {})));
    this.pending = new Map();
    this.lastHistoryAt = 0;
    this.reconnectAttempts = 0;
    this.stopped = true;
  }

  linked() {
    return existsSync(`${this.authDir}/creds.json`);
  }

  status() {
    return {
      state: this.state,
      linked: this.linked(),
      self: this.selfJid ? phoneFromJid(this.selfJid) : null,
      qr: this.state === "qr" ? this.qr : null,
      historySyncing: Date.now() - this.lastHistoryAt < HISTORY_WINDOW_MS,
    };
  }

  async start() {
    mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    this.stopped = false;
    await this.#connect();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
    this.pending.clear();
    this.state = this.linked() ? "stopped" : "unlinked";
  }

  async logout() {
    this.stopped = true;
    try { await this.sock?.logout(); } catch { /* already gone */ }
    rmSync(this.authDir, { recursive: true, force: true });
    this.pending.clear();
    this.state = "unlinked";
  }

  async #connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    // The version pinned in a Baileys release lags WhatsApp Web; ask for the live one.
    const { version } = await fetchLatestWaWebVersion()
      .catch(() => fetchLatestBaileysVersion())
      .catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu(this.deviceName),
      logger: pino({ level: process.env.RENT_BAILEYS_LOG || "warn" }),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      shouldIgnoreJid: (jid) => isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid),
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    });
    sock.ev.on("creds.update", () => { this.credsSaved = saveCreds(); });
    this.attach(sock);
  }

  // Tests attach a fake socket here.
  attach(sock) {
    this.sock = sock;
    this.state = "connecting";
    sock.ev.on("connection.update", (update) => this.#onConnection(update));
    sock.ev.on("messaging-history.set", ({ messages = [], lidPnMappings = [], contacts = [] }) => {
      this.lastHistoryAt = Date.now();
      this.#learnLids(lidPnMappings.map((m) => [m.lid, m.pn]));
      // Excluded contacts first, so their messages in this batch are already blocked.
      this.#onContacts(contacts)
        .finally(() => this.#ingest(messages, { history: true }))
        .catch((e) => this.log("error", `history ingest: ${e.message}`));
    });
    sock.ev.on("messages.upsert", ({ messages }) => {
      this.#ingest(messages, { history: false }).catch((e) => this.log("error", `ingest: ${e.message}`));
    });
    sock.ev.on("lid-mapping.update", (m) => this.#learnLids([[m?.lid, m?.pn]]));
    sock.ev.on("contacts.upsert", (cs) => this.#onContacts(cs));
    sock.ev.on("contacts.update", (cs) => this.#onContacts(cs));
    this.purgeTimer ??= setInterval(() => this.#purgePending(), 30_000);
    this.purgeTimer.unref?.();
  }

  async #onConnection({ connection, lastDisconnect, qr }) {
    if (qr) {
      this.qr = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
      this.state = "qr";
      this.emit("qr", qr);
    }
    if (connection === "open") {
      this.selfJid = jidNormalizedUser(this.sock.user?.id);
      this.selfLid = this.sock.user?.lid ? jidNormalizedUser(this.sock.user.lid) : null;
      this.reconnectAttempts = 0;
      this.qr = null;
      this.state = "live";
      this.log("info", `WhatsApp connected as +${phoneFromJid(this.selfJid)}`);
      this.emit("changed", []);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        rmSync(this.authDir, { recursive: true, force: true });
        this.state = "unlinked";
        this.log("warn", "WhatsApp unlinked by the phone; scan a new QR to relink");
        this.emit("changed", []);
        if (!this.stopped) this.reconnectTimer = setTimeout(() => this.#connect().catch((e) => this.log("error", e.message)), 2000);
        return;
      }
      if (this.stopped) return;
      const delay = code === DisconnectReason.restartRequired ? 0
        : Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempts++) * (0.5 + Math.random() / 2);
      this.state = "reconnecting";
      this.log("warn", `WhatsApp closed (${code ?? "unknown"}); reconnecting in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => Promise.resolve(this.credsSaved)
        .then(() => this.#connect())
        .catch((e) => this.log("error", e.message)), delay);
    }
  }

  #isExcludedName(...names) {
    return names.some((n) => n && this.excludeNames.has(String(n).trim().toLowerCase()));
  }

  // People the user shares listings with: never a property chat.
  #exclude(jid) {
    if (this.store.isIgnored(jid)) return;
    this.store.ignoreChat(jid, "excluded");
    this.pending.delete(jid);
    this.#forgetDropped(jid);
    this.emit("changed", [jid]);
  }

  async #onContacts(contacts) {
    const list = contacts ?? [];
    this.#learnLids(list.filter((c) => c.lid && c.phoneNumber).map((c) => [c.lid, c.phoneNumber]));
    for (const c of list) {
      if (!c?.id || !this.#isExcludedName(c.name, c.notify, c.verifiedName)) continue;
      const ids = [c.id, c.lid, c.phoneNumber].filter(Boolean);
      for (const id of ids) this.#exclude(await this.#resolveChat(id, c.phoneNumber).catch(() => jidNormalizedUser(id)));
    }
  }

  #countDropped(chat, n) {
    if (!n) return;
    this.dropped.set(chat, (this.dropped.get(chat) ?? 0) + n);
    this.#saveDropped();
  }

  #forgetDropped(chat) {
    if (this.dropped.delete(chat)) this.#saveDropped();
  }

  #saveDropped() {
    clearTimeout(this.droppedTimer);
    this.droppedTimer = setTimeout(() => this.store.set("wa.dropped_counts", Object.fromEntries(this.dropped)), 2000);
    this.droppedTimer.unref?.();
  }

  #learnLids(pairs) {
    let changed = false;
    for (const [lid, pn] of pairs) {
      if (!lid || !pn) continue;
      const l = jidNormalizedUser(lid);
      const p = jidNormalizedUser(pn);
      if (this.lidToPn.get(l) === p) continue;
      this.lidToPn.set(l, p);
      this.#samePerson(l, p);
      changed = true;
    }
    if (changed) this.store.set("wa.lid_to_pn", Object.fromEntries(this.lidToPn));
  }

  // Messages seen under a LID before its phone number was known count for the
  // phone-number chat, and a chat ignored under one address is ignored under both.
  #samePerson(lid, pn) {
    const dropped = this.dropped.get(lid);
    if (dropped) {
      this.#forgetDropped(lid);
      this.#countDropped(pn, dropped);
    }
    const held = this.pending.get(lid);
    if (held) {
      this.pending.delete(lid);
      this.pending.set(pn, [...(this.pending.get(pn) ?? []), ...held]);
    }
    const [a, b] = [this.store.getChat(lid), this.store.getChat(pn)];
    if (a?.ignored && !b?.ignored) this.store.ignoreChat(pn, a.flag_reason.replace(/^ignored:/, ""));
    if (b?.ignored && a && !a.ignored) this.store.ignoreChat(lid, b.flag_reason.replace(/^ignored:/, ""));
  }

  // Prefer the phone-number JID so one agent keeps one chat across addressing modes.
  async #resolveChat(jid, alt) {
    if (!isLidUser(jid)) return jidNormalizedUser(jid);
    const lid = jidNormalizedUser(jid);
    if (alt && !isLidUser(alt)) {
      this.#learnLids([[lid, alt]]);
      return jidNormalizedUser(alt);
    }
    if (this.lidToPn.has(lid)) return this.lidToPn.get(lid);
    const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID(lid).catch(() => null);
    if (pn) {
      this.#learnLids([[lid, pn]]);
      return jidNormalizedUser(pn);
    }
    return lid;
  }

  #isSelf(jid) {
    return jid === this.selfJid || jid === this.selfLid;
  }

  async #parse(msg) {
    const key = msg?.key;
    const remote = key?.remoteJid;
    if (!remote || !key.id) return null;
    if (isJidGroup(remote) || isJidBroadcast(remote) || isJidNewsletter(remote) || isJidStatusBroadcast(remote)) return null;
    const content = normalizeMessageContent(msg.message);
    if (!content) return null;
    const chat = await this.#resolveChat(remote, key.remoteJidAlt);
    if (this.#isSelf(chat)) return null;
    const base = { chat, id: key.id, fromMe: !!key.fromMe, ts: timestampOf(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000), pushName: key.fromMe ? null : msg.pushName ?? null };
    if (content.protocolMessage) {
      const pm = content.protocolMessage;
      if (pm.type === PROTOCOL_REVOKE && pm.key?.id) return { ...base, kind: "delete", target: pm.key.id };
      if (pm.type === PROTOCOL_MESSAGE_EDIT && pm.key?.id && pm.editedMessage) {
        return { ...base, kind: "edit", target: pm.key.id, text: messageText(normalizeMessageContent(pm.editedMessage)) ?? "" };
      }
      return null;
    }
    if (content.reactionMessage) return null;
    const text = messageText(content);
    if (text == null) return null;
    return { ...base, kind: "message", text };
  }

  async #ingest(rawMessages, { history }) {
    const byChat = new Map();
    for (const raw of rawMessages ?? []) {
      let parsed;
      try { parsed = await this.#parse(raw); } catch { parsed = null; }
      if (!parsed) continue;
      if (!byChat.has(parsed.chat)) byChat.set(parsed.chat, []);
      byChat.get(parsed.chat).push(parsed);
    }
    const changed = [];
    for (const [chat, items] of byChat) {
      if (this.store.isIgnored(chat)) continue;
      if (this.#isExcludedName(...items.map((m) => m.pushName))) {
        this.#exclude(chat);
        continue;
      }
      if (this.pending.has(chat)) this.#revise(this.pending.get(chat), items);
      const messages = this.#revise(items.filter((m) => m.kind === "message").sort((a, b) => a.ts - b.ts), items);
      let flagged = this.store.isFlagged(chat);
      if (!flagged) {
        const linkMsg = messages.find((m) => this.#links(m.text).length);
        if (linkMsg) {
          const held = this.pending.get(chat) ?? [];
          const before = (this.dropped.get(chat) ?? 0)
            + held.filter((m) => m.ts < linkMsg.ts).length
            + messages.filter((m) => m.ts < linkMsg.ts).length;
          this.pending.delete(chat);
          this.#forgetDropped(chat);
          if (before > this.maxBeforeLink) {
            this.store.ignoreChat(chat, "personal");
            continue;
          }
          const pushName = messages.find((m) => m.pushName)?.pushName ?? null;
          this.store.flagChat(chat, { reason: this.#links(linkMsg.text)[0].url, phone: phoneFromJid(chat), name: pushName });
          messages.unshift(...held);
          flagged = true;
        }
      }
      if (!flagged) {
        if (history && Date.now() - this.lastHistoryAt < HISTORY_WINDOW_MS) this.#hold(chat, messages);
        else this.#countDropped(chat, messages.length);
        continue;
      }
      // History can deliver a chat's older part after the part with the link,
      // so the rule is checked again before anything new is written.
      if (this.#leadIn(chat, messages) > this.maxBeforeLink) {
        this.store.ignoreChat(chat, "personal");
        continue;
      }
      this.store.addMessages(chat, messages);
      const name = messages.find((m) => m.pushName)?.pushName;
      if (name) this.store.setChatName(chat, name);
      this.store.classifyChat(chat);
      for (const m of items) {
        if (m.kind === "edit") this.store.editMessage(chat, m.target, m.text);
        if (m.kind === "delete") this.store.deleteMessage(chat, m.target);
      }
      this.#linkListings(chat, messages);
      changed.push(chat);
    }
    if (changed.length) this.emit("changed", changed);
  }

  // How many messages came before the chat's first listing link, counting the
  // stored ones and the incoming ones. Agent chats start at the link.
  #leadIn(chat, incoming = []) {
    const all = new Map(this.store.chatMessages(chat).map((m) => [m.msg_id, m]));
    for (const m of incoming) all.set(m.id, m);
    const messages = [...all.values()];
    const first = Math.min(...messages.filter((m) => this.#links(m.text).length).map((m) => m.ts));
    return first === Infinity ? 0 : messages.filter((m) => m.ts < first).length;
  }

  // A message not yet stored that the sender edits or deletes is kept as it
  // now reads, or not at all.
  #revise(messages, items) {
    for (const m of items) {
      const i = messages.findIndex((x) => x.id === m.target);
      if (i < 0) continue;
      if (m.kind === "delete") messages.splice(i, 1);
      if (m.kind === "edit") messages[i] = { ...messages[i], text: m.text };
    }
    return messages;
  }

  // Listing links that make a chat a property chat. Carousell links count only
  // for listings the tracker already holds.
  #links(text) {
    return findPropertyLinks(text, { isTracked: (key) => Boolean(this.store.findListingByKey(key)) });
  }

  #hold(chat, messages) {
    const held = this.pending.get(chat) ?? [];
    held.push(...messages);
    this.#countDropped(chat, Math.max(0, held.length - PENDING_PER_CHAT));
    this.pending.set(chat, held.slice(-PENDING_PER_CHAT));
  }

  #purgePending() {
    if (Date.now() - this.lastHistoryAt < HISTORY_WINDOW_MS) return;
    for (const [chat, held] of this.pending) this.#countDropped(chat, held.length);
    this.pending.clear();
  }

  // Applies the current rules to chats flagged earlier (e.g. under an older rule).
  // Also re-reads stored links, so link formats learned later get linked.
  reviewFlaggedChats() {
    for (const chat of this.store.listChats()) {
      if (this.#isExcludedName(chat.name)) this.#exclude(chat.jid);
      else if (this.#leadIn(chat.jid) > this.maxBeforeLink) this.store.ignoreChat(chat.jid, "personal");
      else {
        this.store.classifyChat(chat.jid);
        this.#linkListings(chat.jid, this.store.chatMessages(chat.jid));
      }
    }
  }

  #linkListings(chat, messages) {
    const listingIds = new Set(this.store.listingIdsForChat(chat));
    for (const m of messages) {
      for (const link of this.#links(m.text)) {
        if (!link.listingKey) continue;
        const listing = this.store.findListingByKey(link.listingKey)
          ?? this.store.upsertListing({ source: link.source, source_id: link.sourceId, url: link.url, found_by: "whatsapp" }).listing;
        this.store.linkChat(chat, listing.id, "url");
        listingIds.add(listing.id);
      }
    }
    for (const id of listingIds) this.store.refreshLead(id);
  }

  #sending = new Set();

  async send(listing, text) {
    if (this.state !== "live") throw new Error(`WhatsApp is not connected (${this.state})`);
    const phone = normalizePhone(listing.agent_phone);
    if (!phone) throw new Error("listing has no agent phone number");
    if (!text?.trim()) throw new Error("message is empty");
    const [result] = (await this.sock.onWhatsApp(phone)) ?? [];
    if (!result?.exists) throw new Error(`+${phone} is not on WhatsApp`);
    const jid = jidNormalizedUser(result.jid);
    if (this.store.isIgnored(jid)) throw new Error("this chat is marked 'not an agent'; un-ignore it first");
    // A repeat or a double click would send the agent the same text twice.
    const key = `${jid}\n${text.replace(/\s+/g, " ").trim()}`;
    if (this.#sending.has(key) || this.store.sentBefore(jid, text)) throw new Error("this message was already sent to this agent");
    this.#sending.add(key);
    this.store.flagChat(jid, { reason: `intro for listing ${listing.id}`, phone, name: listing.agent_name ?? null });
    this.store.linkChat(jid, listing.id, "sent");
    try {
      const sent = await this.sock.sendMessage(jid, { text });
      this.store.addMessages(jid, [{ id: sent.key.id, fromMe: true, ts: Math.floor(Date.now() / 1000), text }]);
      this.store.recordSend({ listingId: listing.id, chatJid: jid, text, msgId: sent.key.id });
      this.store.refreshLead(listing.id);
      this.emit("changed", [jid]);
      return { jid, msgId: sent.key.id };
    } catch (error) {
      this.store.recordSend({ listingId: listing.id, chatJid: jid, text, error: error.message });
      throw error;
    } finally {
      this.#sending.delete(key);
    }
  }
}
