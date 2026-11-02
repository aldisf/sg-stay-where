// Server and browser share this code so their hashes match. 99.co's CDN sends
// CORS but blocks servers, so the browser hashes those photos.
//
// dHash: each bit says whether a 9×8 cell is brighter than its right neighbour.
// Robust to resizing, recompression and faint watermarks.

export const HASH_SIZE = 256;

export function dhash(gray, width, height) {
  const cols = 9;
  const rows = 8;
  const cells = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / cols));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += gray[y * width + x];
      cells[r * cols + c] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  // A near-blank photo (white wall, logo card) has no fingerprint: its bits are noise.
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  const spread = Math.sqrt(cells.reduce((a, v) => a + (v - mean) ** 2, 0) / cells.length);
  if (spread < 10) return null;
  let hex = "";
  for (let r = 0; r < rows; r++) {
    let byte = 0;
    for (let c = 0; c < 8; c++) byte = (byte << 1) | (cells[r * cols + c] > cells[r * cols + c + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function toGray(pixels, width, height, channels = 4) {
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    gray[i] = 0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2];
  }
  return gray;
}

export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i += 4) {
    let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

// Each photo pairs once, so the count reads the same either way round. Hashes
// with little structure (most rows alike: a blank or striped image) say nothing.
export const MATCH_BITS = 10;
export function informative(h) {
  if (!/^[0-9a-f]{16}$/.test(h)) return false;
  const rows = new Set(h.match(/../g));
  return rows.size >= 4;
}

export function photoMatches(a = [], b = [], maxBits = MATCH_BITS) {
  const free = (b ?? []).filter(informative);
  let pairs = 0;
  for (const h of (a ?? []).filter(informative)) {
    let best = -1;
    let bestBits = maxBits + 1;
    free.forEach((g, i) => { const d = hamming(h, g); if (d < bestBits) { best = i; bestBits = d; } });
    if (best >= 0) { free.splice(best, 1); pairs += 1; }
  }
  return pairs;
}

export async function hashImagesInBrowser(urls, { limit = 8, timeoutMs = 8000 } = {}) {
  const one = (url) => new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, HASH_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(9, Math.round(img.naturalWidth * scale));
        const h = Math.max(8, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        resolve(dhash(toGray(ctx.getImageData(0, 0, w, h).data, w, h, 4), w, h));
      } catch {
        resolve(null); // no CORS: the canvas is tainted
      }
    };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
  const out = [];
  for (const url of urls.slice(0, limit)) {
    const h = await one(url);
    if (h) out.push(h);
  }
  return out;
}
