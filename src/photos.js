// PropertyGuru's and Carousell's CDNs serve photos to the server. 99.co's sit
// behind a bot check, so the browser fingerprints those with the same code.
// One listing at a time, a few photos each.
import sharp from "sharp";
import { dhash, HASH_SIZE, toGray } from "./photohash.js";

const SERVER_FETCHABLE = /^https:\/\/([\w-]+\.pgimgs\.com|media\.karousell\.com)\//;
export const canHashOnServer = (url) => SERVER_FETCHABLE.test(url ?? "");

export async function hashUrl(url) {
  const res = await fetch(url, { headers: { accept: "image/jpeg,image/png;q=0.9,image/*;q=0.8", "user-agent": "sg-stay-where (personal home search)" } });
  if (!res.ok) throw new Error(`${res.status} for photo`);
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
    .resize(HASH_SIZE, HASH_SIZE, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return dhash(toGray(data, info.width, info.height, info.channels), info.width, info.height);
}

export function photoUrls(listing, limit = 8) {
  return (listing.photos ?? []).filter((p) => p.kind !== "floor plan" && p.src).map((p) => p.src).slice(0, limit);
}

export function photoQueue({ store, log, done }) {
  const waiting = [];
  const queued = new Set();
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    while (waiting.length) {
      const id = waiting.shift();
      queued.delete(id);
      const listing = store.getListing(id);
      const urls = listing ? photoUrls(listing).filter(canHashOnServer) : [];
      const hashes = [];
      for (const url of urls) {
        try { const h = await hashUrl(url); if (h) hashes.push(h); } catch (error) { log("warn", `photo hash #${id}: ${error.message}`); }
      }
      // Nothing usable still records a marker, so the listing isn't queued again.
      done(id, hashes.length ? hashes : ["0000000000000000"]);
    }
    running = false;
  }
  return {
    add(listing) {
      if (!listing || queued.has(listing.id) || listing.photo_hashes?.length) return;
      if (!photoUrls(listing).some(canHashOnServer)) return;
      queued.add(listing.id);
      waiting.push(listing.id);
      run().catch((error) => { running = false; log("error", `photo queue: ${error.message}`); });
    },
    get size() { return waiting.length; }
  };
}
