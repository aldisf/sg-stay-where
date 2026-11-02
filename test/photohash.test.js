import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { dhash, hamming, HASH_SIZE, photoMatches, toGray } from "../src/photohash.js";

// A synthetic "room": gradient wall, dark sofa block, bright window.
async function room({ width = 800, height = 600, shift = 0, watermark = false, format = "jpeg" } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#ddd"/><stop offset="1" stop-color="#777"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="${60 + shift}" y="${height * 0.55}" width="${width * 0.4}" height="${height * 0.25}" fill="#334"/>
    <rect x="${width * 0.6}" y="${height * 0.1}" width="${width * 0.3}" height="${height * 0.35}" fill="#f5f8ff"/>
    ${watermark ? `<text x="50%" y="50%" font-size="${width / 10}" fill="#fff" fill-opacity="0.25" text-anchor="middle">Agent Name</text>` : ""}
  </svg>`;
  return sharp(Buffer.from(svg)).toFormat(format, { quality: 70 }).toBuffer();
}

async function hashOf(buf) {
  const { data, info } = await sharp(buf).resize(HASH_SIZE, HASH_SIZE, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return dhash(toGray(data, info.width, info.height, info.channels), info.width, info.height);
}

test("the same photo at another size, quality or with a faint watermark hashes alike", async () => {
  const base = await hashOf(await room());
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.ok(hamming(base, await hashOf(await room({ width: 450, height: 338 }))) <= 4);
  assert.ok(hamming(base, await hashOf(await room({ watermark: true }))) <= 10);
  assert.ok(hamming(base, await hashOf(await room({ format: "webp" }))) <= 4);
});

test("a different photo is far away", async () => {
  const a = await hashOf(await room());
  const b = await hashOf(await sharp({ create: { width: 800, height: 600, channels: 3, background: "#888" } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect x="500" y="300" width="250" height="250" fill="#111"/><rect x="40" y="40" width="300" height="200" fill="#eee"/></svg>') }])
    .jpeg().toBuffer());
  assert.ok(hamming(a, b) > 15);
});

test("photo matches pair photos one to one and ignore blank ones", () => {
  const a = ["0e9ed6a6badda8a9", "06e676849eb4f66e", "0000000000000000"];
  const b = ["0e9ed6a6badda8ab", "377f8c8cd89e518f", "0000000000000000"];
  assert.equal(photoMatches(a, b), 1);
  assert.equal(photoMatches(a, []), 0);
  assert.equal(photoMatches(undefined, b), 0);
  // A near-blank photo (rows alike) close to many photos counts for nothing,
  // and one photo can't match several: the count reads the same both ways.
  const blankish = ["7868687078686868"];
  const many = ["7868687078686869", "786868707868686a", "786868707868686c"];
  assert.equal(photoMatches(blankish, many), 0);
  assert.equal(photoMatches(many, blankish), 0);
  const one = ["0e9ed6a6badda8a9"];
  const three = ["0e9ed6a6badda8a9", "0e9ed6a6badda8ab", "0e9ed6a6badda8ad"];
  assert.equal(photoMatches(one, three), 1);
  assert.equal(photoMatches(three, one), 1);
});

test("a near-blank photo gets no fingerprint", () => {
  const gray = new Float64Array(90 * 80).fill(240);
  assert.equal(dhash(gray, 90, 80), null);
});
