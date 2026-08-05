// ============================================================================
// VIDEO REVIEW  —  ops-hub feature module
// ----------------------------------------------------------------------------
// QA for short nursing-education videos (TikToks) using Google Gemini.
//
// WHY THIS EXISTS:
//   Nursing content fails in ways a non-nurse reviewer can't catch: a wrong
//   dose, a wrong route, an interaction stated too loosely. Gemini reads BOTH
//   the spoken audio and the burned-in on-screen captions in a single pass and
//   returns a structured QA report. Crucially, the model does NOT get the final
//   say on safety — see enforceHumanNurse() below, which force-escalates
//   anything pharmacological or anything the model wasn't confident about.
//
// HOW IT WIRES INTO src/index.js:
//   1. import { handleVideoReviewAPI } from "./video-review.js";   (top of file)
//   2. In the fetch dispatch, alongside the other startsWith delegates:
//        if (path.startsWith("/video-review/api/")) { return handleVideoReviewAPI(request, env, path); }
//
// DB: uses the existing `env.DB` binding (content-calendar). Table self-creates
//     (see ensureVideoReviewTables) AND has a migration at
//     migrations/0001_video_reviews.sql — keep the two DDLs in sync.
// R2: env.VIDEO_REVIEW_UPLOADS (bucket nitm-video-review) holds drag-and-dropped
//     videos. Read via the BINDING, never over HTTP — the live site sits behind
//     Cloudflare Access, so a Worker fetching its own URL would hit the login
//     gate. Videos are kept after review so a nurse can rewatch a flagged moment.
// SECRET: env.GEMINI_API_KEY   (wrangler secret put — this repo is public)
// VAR:    env.GEMINI_MODEL     (wrangler.jsonc vars; see MODEL note below)
//
// Dependency-free: fetch + D1 + R2 only, no SDK.
// ============================================================================

const GEMINI_BASE = "https://generativelanguage.googleapis.com";

// Last-resort fallback only. The live order is: model saved in D1 (set from the
// UI) -> env.GEMINI_MODEL -> this.
//
// History worth knowing: this started as gemini-2.5-flash on the strength of its
// published 2026-10-16 retirement date. Google cut it off well before then —
// "no longer available to new users", a hard 404 — while STILL listing it in
// ListModels. So neither the retirement calendar nor the model list can be
// trusted; only an actual call can. That is why POST /models verifies a model
// before saving it, and why the choice lives in the database.
const DEFAULT_MODEL = "gemini-3.6-flash";

// Ceiling on a single video. R2-backed uploads stream, so this is about keeping
// Gemini cost and processing time sane rather than Worker memory; the buffered
// fallback path (unknown content-length) is the one that actually risks the
// 128 MB Worker limit.
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 90 * 1024 * 1024;

// Browser slices uploads into parts of this size. R2 multipart requires every
// part except the last to be identical in size, and at least 5 MB.
const UPLOAD_PART_BYTES = 10 * 1024 * 1024;

// Chunk size for the R2 -> Gemini leg. Must be a multiple of 256 KiB for
// intermediate chunks of a resumable upload.
const GEMINI_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

const VIDEO_CONTENT_TYPES = new Set([
  "video/mp4", "video/quicktime", "video/webm", "video/x-m4v",
  "video/mpeg", "video/x-matroska", "video/3gpp",
]);

// File API processing (transcode/index) for a short clip is seconds, but a
// cold/large upload can take longer. Give up rather than hang the caller.
const MAX_POLL_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

// ----------------------------------------------------------------------------
// RAG grounding against the existing nursing textbook corpus.
//
// The corpus was built by the qbank project and is reused as-is: 43,990 chunks
// across 8 titles, embeddings in Vectorize (nitm-textbooks) and passage text in
// nitm-qbank.textbook_chunks under the same id (e.g. "davis:p1012:c0").
//
// EMBEDDING_MODEL must match whatever produced those vectors or retrieval
// returns noise. Verified empirically by re-embedding a known chunk and
// checking it comes back top-1: bge-large-en-v1.5 self-matched at 0.91,
// bge-m3 at 0.055. Do not change this without re-running that check.
const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

// Drug and pharmacology claims are searched against the two pharmacology titles
// only. Precision matters most here: drug information is the documented weakest
// area for LLMs, and a med-surg chapter that merely mentions the drug crowds out
// the drug-guide monograph that actually answers the question.
const PHARM_BOOKS = ["davisdrug", "ford"];

const RETRIEVE_TOP_K = 5;
const MAX_PASSAGE_CHARS = 1400;
// Total passage budget for the grounding call. Passages are spent in relevance
// order across all claims rather than capped per claim, so a claim with one
// excellent match isn't padded while a hard one goes hungry.
const MAX_GROUNDING_CHARS = 60_000;

// ----------------------------------------------------------------------------
// Schema — self-creating. Mirrors migrations/0001 + 0002 combined; change one,
// change the other.
// ----------------------------------------------------------------------------
async function ensureVideoReviewTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS video_reviews (
      id                 TEXT PRIMARY KEY,
      video_url          TEXT NOT NULL,                   -- source label: the URL, or the uploaded filename
      r2_key             TEXT,                            -- set when the video was uploaded (kept, so it can be rewatched)
      video_meta         TEXT,                            -- JSON, caller-supplied
      recommendation     TEXT,
      needs_human_nurse  INTEGER NOT NULL DEFAULT 1,      -- fail safe: escalate
      review_json        TEXT NOT NULL,
      input_tokens       INTEGER DEFAULT 0,
      output_tokens      INTEGER DEFAULT 0,
      est_cost_usd       REAL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_video_reviews_created_at ON video_reviews (created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_video_reviews_needs_human ON video_reviews (needs_human_nurse)`),
    // Model choice lives in D1, not just the wrangler var, so it can be changed
    // from the UI without a deploy. Same shape as campaign_router_config.
    db.prepare(`CREATE TABLE IF NOT EXISTS video_review_config (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TEXT
    )`),
  ]);

  // Self-migration for tables created before r2_key existed (migration 0001 was
  // applied before uploads were built). CREATE TABLE IF NOT EXISTS is a no-op on
  // an existing table, so the column has to be added explicitly. Duplicate-column
  // errors are expected and harmless — same pattern as initCxAgentTables.
  try {
    await db.prepare(`ALTER TABLE video_reviews ADD COLUMN r2_key TEXT`).run();
  } catch { /* column already there */ }
  // Which model produced a given report — needed to make sense of history once
  // the model can be switched from the UI.
  try {
    await db.prepare(`ALTER TABLE video_reviews ADD COLUMN model TEXT`).run();
  } catch { /* column already there */ }
}

// ----------------------------------------------------------------------------
// Model selection.
//
// Resolution order: the model saved in D1 (set from the UI) -> env.GEMINI_MODEL
// (wrangler var) -> DEFAULT_MODEL. Google retires Gemini models on a schedule
// and, worse, stops serving them to new API keys BEFORE the published retirement
// date — which is what broke gemini-2.5-flash here. Keeping the choice in D1
// means recovering from that is a dropdown, not a deploy.
// ----------------------------------------------------------------------------
async function getConfig(db, key) {
  try {
    const row = await db.prepare(`SELECT value FROM video_review_config WHERE key = ?`).bind(key).first();
    return row ? row.value : null;
  } catch { return null; }
}

async function setConfig(db, key, value) {
  await db.prepare(`INSERT INTO video_review_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .bind(key, value).run();
}

async function resolveModel(db, env) {
  return (await getConfig(db, "model")) || env.GEMINI_MODEL || DEFAULT_MODEL;
}

// Ask Gemini what this API key can actually use, rather than hardcoding a list
// that rots. Filtered to models that support generateContent and can take video.
async function listGeminiModels(apiKey) {
  const out = [];
  let pageToken = "";
  // Paginate, but bound it — the list is short and a runaway loop here would
  // burn subrequests for nothing.
  for (let page = 0; page < 5; page++) {
    const url = `${GEMINI_BASE}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini listModels -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    for (const m of data.models || []) out.push(m);
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }

  return out
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .filter((m) => /^models\/gemini/.test(m.name || ""))
    // Drop families that technically expose generateContent but can't do this
    // job: image generators (Nano Banana), text-to-speech, robotics and
    // computer-use. Leaving them in makes the dropdown actively misleading.
    .filter((m) => !/(-image|-tts|robotics|computer-use|embedding)/.test(m.name || ""))
    .map((m) => ({
      id: (m.name || "").replace(/^models\//, ""),
      label: m.displayName || (m.name || "").replace(/^models\//, ""),
      description: m.description || "",
      input_token_limit: m.inputTokenLimit || null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Cheap text-only call used to prove a model actually works with this key before
// we save it. This is the check that would have caught the retired-model 404 at
// selection time instead of halfway through a video review.
async function verifyModel(apiKey, model) {
  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 512 },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* keep raw */ }
    throw new Error(msg);
  }
  return true;
}

// Keys come from the client on every upload/playback call, so never trust one:
// confine them to the uploads/ prefix and reject traversal.
function badUploadKey(key) {
  if (!key || typeof key !== "string") return "key is required";
  if (!key.startsWith("uploads/")) return "bad key";
  if (key.includes("..")) return "bad key";
  return null;
}

// ----------------------------------------------------------------------------
// Pricing — rough per-MTok estimate, keyed by model-name substring the same way
// cxModelPricing() does in index.js. Gemini prices video/audio input tiers
// differently from text, so treat est_cost_usd as a budget signal, not a bill.
//
// Rates below are per-model rather than one flat "flash" tier, because the
// spread is large: 3.6-flash is the flagship at $1.50/$7.50 per MTok, 5x the
// input cost of 2.5-flash and 6x that of 3.1-flash-lite. A single flash rate
// understated the model now in use by roughly 4x.
//
// Sizing, for reference: a 60s clip is ~18k video tokens (Google documents ~300
// tokens/second at default media resolution — 258/frame at 1 FPS plus 32/second
// of audio), so ~20k in and ~1.5k out per review. At 30 videos/month that is
// ~$1.24 on 3.6-flash or ~$0.22 on 3.1-flash-lite. Either is a rounding error.
// ----------------------------------------------------------------------------
// First match wins, so the most specific patterns come first. Rates are per
// token (published per-1M figures / 1e6), standard tier.
const GEMINI_PRICES = [
  [/3\.6-flash/,                        1.50e-6, 7.50e-6],
  [/3-flash-preview/,                   0.50e-6, 3.00e-6],
  [/3\.1-flash-lite|3\.5-flash-lite/,   0.25e-6, 1.50e-6],
  [/2\.5-flash-lite|2\.0-flash-lite/,   0.10e-6, 0.40e-6],
  [/2\.5-flash|2\.0-flash/,             0.30e-6, 2.50e-6],
  [/pro/,                               1.25e-6, 10.00e-6],
];

function geminiPricing(model) {
  const m = (model || "").toLowerCase();
  for (const [re, inRate, outRate] of GEMINI_PRICES) {
    if (re.test(m)) return { in: inRate, out: outRate };
  }
  // Unknown model: bill at the most expensive known tier. Over-estimating cost
  // is the safe direction — an under-estimate hides a runaway.
  return { in: 1.50e-6, out: 10.00e-6 };
}

// ----------------------------------------------------------------------------
// The nursing-QA prompt. responseMimeType is application/json, so Gemini is
// already constrained to emit JSON — the schema here defines the SHAPE.
// ----------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a meticulous clinical content reviewer for a nursing-education brand.
You are reviewing a short-form educational video (TikTok/Reels style) aimed at nursing students and new grad nurses.

You receive the video itself. Review BOTH channels independently and together:
  - the SPOKEN AUDIO (narration, voiceover, dialogue)
  - the ON-SCREEN TEXT (burned-in captions, titles, labels, overlays, anything legible)
On-screen text and narration frequently disagree in this format. When they do, that is a finding — report it.

You are NOT the final authority. A licensed nurse reviews anything you flag. Your job is to be
precise and complete, not reassuring. Do not soften a concern to be agreeable, and do not invent
problems that are not present. If something is unclear or illegible, say so rather than guessing.

Return ONLY valid JSON matching exactly this shape:

{
  "transcript": "full spoken transcript, verbatim, with [inaudible] where unclear",
  "on_screen_text": [
    { "text": "exact on-screen text", "timestamp": "M:SS", "issue": "null, or how it conflicts with narration / is wrong / is misspelled" }
  ],
  "clinical_claims": [
    {
      "claim": "the clinical assertion as stated",
      "timestamp": "M:SS",
      "source": "audio | on_screen | both",
      "accuracy": "accurate | misleading | incorrect | unverifiable",
      "confidence": "high | medium | low",
      "note": "what is right or wrong about it, and the correct version if it is wrong"
    }
  ],
  "drug_pharmacology_claims": [
    {
      "claim": "the assertion as stated",
      "timestamp": "M:SS",
      "drug": "drug or class named",
      "type": "dose | route | frequency | indication | contraindication | interaction | side_effect | mechanism | other",
      "accuracy": "accurate | misleading | incorrect | unverifiable",
      "confidence": "high | medium | low",
      "note": "specifics — exact dose/route stated vs. correct"
    }
  ],
  "spelling_grammar": [
    { "text": "the erroneous text", "location": "on_screen | narration", "timestamp": "M:SS", "correction": "the fix" }
  ],
  "production_notes": {
    "audio_quality": "brief note on clarity, levels, background noise",
    "pacing": "brief note",
    "text_legibility": "brief note on size/contrast/on-screen duration",
    "hook_strength": "brief note on the first 3 seconds",
    "other": "anything else worth a re-shoot or re-edit"
  },
  "red_flags": [
    { "issue": "anything unsafe, scope-of-practice violating, legally risky, or presentable as medical advice", "timestamp": "M:SS", "severity": "critical | high | medium" }
  ],
  "overall": {
    "recommendation": "publish | publish_with_edits | revise | do_not_publish",
    "reason": "one or two sentences",
    "needs_human_nurse": true
  }
}

Rules:
- ANY mention of a drug, dose, route, frequency, or interaction goes in drug_pharmacology_claims, even if it is correct.
- Set overall.needs_human_nurse to true whenever there is any pharmacology content at all, or any
  clinical claim you rated below "high" confidence. When in doubt, set it to true.
- Use "M:SS" timestamps throughout. Use empty arrays, not null, when a category has no entries.
- Return the JSON object only. No prose before or after.`;

const USER_INSTRUCTION = `Review this nursing-education video and return the JSON QA report described in your instructions.
Transcribe the spoken audio in full, read every piece of on-screen text, and cross-check the two against each other.`;

// ----------------------------------------------------------------------------
// Gemini File API — resumable upload
// ----------------------------------------------------------------------------

// Start a resumable session and return the upload URL.
async function startResumableUpload(apiKey, { bytes, mimeType, displayName }) {
  const res = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini upload start -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const uploadUrl = res.headers.get("X-Goog-Upload-URL") || res.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini upload start: no X-Goog-Upload-URL in response");
  return uploadUrl;
}

// Resolve the video into { bytes, body, mimeType } regardless of where it came
// from. The resumable protocol needs the byte count up front, which is why the
// length matters so much here.
async function resolveSource(env, { videoUrl, r2Key, mimeType }) {
  // --- Uploaded file: read straight off the R2 binding. ---
  // Deliberately NOT over HTTP: the live site is behind Cloudflare Access, so a
  // Worker fetching its own URL would get the login page instead of the video.
  // R2 also gives an exact size, so this path always streams.
  if (r2Key) {
    if (!env.VIDEO_REVIEW_UPLOADS) throw new Error("VIDEO_REVIEW_UPLOADS (R2) not configured");
    const head = await env.VIDEO_REVIEW_UPLOADS.head(r2Key);
    if (!head) throw new Error(`Uploaded video not found: ${r2Key}`);
    if (head.size === 0) throw new Error("Uploaded video is empty");
    if (head.size > MAX_VIDEO_BYTES) throw new Error(`Video is ${head.size} bytes; limit is ${MAX_VIDEO_BYTES}`);
    return {
      bytes: head.size,
      mimeType: mimeType || head.httpMetadata?.contentType || "video/mp4",
      // Ranged reader instead of one long stream. Piping a ~100 MB R2 body
      // straight into the Gemini upload fails intermittently with "Network
      // connection lost", and every one of these videos is that size, so the
      // upload is done in bounded chunks instead. See uploadToGemini.
      readRange: async (offset, length) => {
        const part = await env.VIDEO_REVIEW_UPLOADS.get(r2Key, { range: { offset, length } });
        if (!part) throw new Error(`R2 range read failed at offset ${offset}`);
        return await part.arrayBuffer();
      },
    };
  }

  // --- Remote URL: stream when the server declares a length, buffer if not. ---
  const src = await fetch(videoUrl);
  if (!src.ok) throw new Error(`Fetch video -> ${src.status} ${src.statusText}`);
  if (!src.body) throw new Error("Fetch video: empty body");

  const resolvedMime = mimeType || src.headers.get("content-type") || "video/mp4";
  const declared = parseInt(src.headers.get("content-length") || "", 10);

  if (Number.isFinite(declared) && declared > 0) {
    if (declared > MAX_VIDEO_BYTES) throw new Error(`Video is ${declared} bytes; limit is ${MAX_VIDEO_BYTES}`);
    return { bytes: declared, body: src.body, mimeType: resolvedMime };
  }

  // Length unknown — we have to buffer it, so the tighter memory-safe cap applies.
  const buf = await src.arrayBuffer();
  if (buf.byteLength === 0) throw new Error("Fetch video: zero-length body");
  if (buf.byteLength > MAX_BUFFERED_BYTES) {
    throw new Error(`Video is ${buf.byteLength} bytes and the source sent no content-length; the limit in that case is ${MAX_BUFFERED_BYTES}`);
  }
  return { bytes: buf.byteLength, body: buf, mimeType: resolvedMime };
}

// Push an already-resolved source to the Gemini File API.
//
// Two paths. If the source can be read in ranges (R2), the bytes go up in bounded
// chunks — a single ~100 MB stream to the upload endpoint drops connections often
// enough to be useless, and every real video here is that size. Otherwise (a
// remote URL, where ranged reads aren't guaranteed) fall back to one stream.
async function uploadToGemini(apiKey, source, displayName) {
  const { bytes, body, mimeType, readRange } = source;
  const uploadUrl = await startResumableUpload(apiKey, { bytes, mimeType, displayName });

  let res;
  if (typeof readRange === "function") {
    let offset = 0;
    while (offset < bytes) {
      const length = Math.min(GEMINI_UPLOAD_CHUNK_BYTES, bytes - offset);
      const chunk = await readRange(offset, length);
      const last = offset + length >= bytes;
      res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Length": String(length),
          "X-Goog-Upload-Offset": String(offset),
          // Only the final chunk finalizes; the rest just extend the session.
          "X-Goog-Upload-Command": last ? "upload, finalize" : "upload",
        },
        body: chunk,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini upload chunk at ${offset} -> ${res.status}: ${text.slice(0, 300)}`);
      }
      offset += length;
    }
  } else {
    res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(bytes),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini upload -> ${res.status}: ${text.slice(0, 300)}`);
    }
  }
  const data = await res.json();
  const file = data.file || data;
  if (!file?.name || !file?.uri) throw new Error("Gemini upload: response had no file name/uri");
  return { name: file.name, uri: file.uri, state: file.state, mimeType: file.mimeType || mimeType };
}

// Gemini transcodes/indexes video asynchronously; it isn't usable until ACTIVE.
async function waitForActive(apiKey, fileName) {
  const deadline = Date.now() + MAX_POLL_MS;
  let state = "PROCESSING";
  while (Date.now() < deadline) {
    const res = await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini file poll -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const file = await res.json();
    state = file.state;
    if (state === "ACTIVE") return file;
    if (state === "FAILED") {
      throw new Error(`Gemini file processing FAILED: ${JSON.stringify(file.error || {}).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Gemini file still ${state} after ${MAX_POLL_MS}ms`);
}

// Uploaded files auto-expire after 48h, so a failed delete is harmless.
async function deleteGeminiFile(apiKey, fileName) {
  try {
    await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`, { method: "DELETE" });
  } catch { /* non-fatal */ }
}

// ----------------------------------------------------------------------------
// JSON extraction — responseMimeType should give us clean JSON, but a truncated
// or fenced response shouldn't take the whole request down. Same defensive
// shape as cxExtractJson() in index.js, kept local so this module stays
// standalone.
// ----------------------------------------------------------------------------
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch { /* fall through */ } }
  const rawMatch = text.match(/\{[\s\S]*\}/);
  if (rawMatch) { try { return JSON.parse(rawMatch[0]); } catch { /* fall through */ } }
  return null;
}

// ----------------------------------------------------------------------------
// THE SAFETY GATE. Enforced in code, not delegated to the model.
//
// needs_human_nurse is forced true when EITHER:
//   - there is any drug/dose/route/interaction content at all, OR
//   - any clinical claim came back below high confidence.
// A missing, malformed, or unrecognised confidence counts as low — a garbled
// model response must escalate, never silently pass. This only ever flips the
// flag ON; a model-set true is never overridden.
// ----------------------------------------------------------------------------
function isHighConfidence(value) {
  if (typeof value === "number") return value >= 0.9;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "high") return true;
    const n = parseFloat(s);                       // tolerate "0.95" as a string
    if (Number.isFinite(n)) return n >= 0.9;
  }
  return false;                                    // missing/unknown => not high
}

function enforceHumanNurse(review) {
  if (!review.overall || typeof review.overall !== "object") review.overall = {};

  const reasons = [];

  // The prompt requires both of these to be arrays (empty when there's nothing
  // to report). Anything else means the response is malformed — escalate rather
  // than read a missing/garbled field as "no claims found".
  const drugClaims = review.drug_pharmacology_claims;
  const clinicalClaims = review.clinical_claims;
  if (!Array.isArray(drugClaims) || !Array.isArray(clinicalClaims)) {
    reasons.push("malformed review (claims fields were not arrays)");
  }

  if (Array.isArray(drugClaims) && drugClaims.length > 0) {
    reasons.push(`${drugClaims.length} drug/pharmacology claim(s) present`);
  }
  if (Array.isArray(clinicalClaims)) {
    const lowConf = clinicalClaims.filter((c) => !isHighConfidence(c?.confidence));
    if (lowConf.length > 0) {
      reasons.push(`${lowConf.length} clinical claim(s) below high confidence`);
    }
  }

  if (reasons.length > 0) {
    review.overall.needs_human_nurse = true;
    // Tell the reviewer why this landed on their desk.
    const why = `Auto-escalated to nurse review: ${reasons.join("; ")}.`;
    review.overall.reason = review.overall.reason ? `${review.overall.reason} ${why}` : why;
  } else {
    review.overall.needs_human_nurse = review.overall.needs_human_nurse === true;
  }
  return review;
}

// ----------------------------------------------------------------------------
// One multimodal generateContent call.
// ----------------------------------------------------------------------------
async function generateReview(apiKey, model, file) {
  // Pass 1 is deliberately ungrounded: the model watches the video and reports
  // what it sees and hears. Grounding happens afterwards, in a separate text-only
  // pass (see retrievePassages / groundClaims), because the claims have to exist
  // before there is anything to look up.
  const parts = [
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: USER_INSTRUCTION },
  ];

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini generateContent -> ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("");
  const parsed = extractJson(text);
  if (!parsed) {
    const why = candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : "";
    throw new Error(`Gemini returned unparseable JSON${why}: ${text.slice(0, 300)}`);
  }

  const u = data.usageMetadata || {};
  const inputTokens = u.promptTokenCount || 0;
  const outputTokens = u.candidatesTokenCount || 0;
  const p = geminiPricing(model);

  return {
    review: parsed,
    usage: {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: u.totalTokenCount || inputTokens + outputTokens,
      est_cost_usd: inputTokens * p.in + outputTokens * p.out,
    },
  };
}

// ----------------------------------------------------------------------------
// RAG: retrieve candidate textbook passages for every clinical / drug claim.
// ----------------------------------------------------------------------------

// Flatten the claims the model produced into a single list to ground.
function collectClaims(review) {
  const out = [];
  const drug = Array.isArray(review.drug_pharmacology_claims) ? review.drug_pharmacology_claims : [];
  const clinical = Array.isArray(review.clinical_claims) ? review.clinical_claims : [];
  drug.forEach((c, i) => out.push({
    ref: `drug:${i}`, kind: "drug", index: i,
    query: [c?.drug, c?.type, c?.claim].filter(Boolean).join(" — "),
    claim: c?.claim || "", drug: c?.drug || "", timestamp: c?.timestamp || "",
  }));
  clinical.forEach((c, i) => out.push({
    ref: `clinical:${i}`, kind: "clinical", index: i,
    query: c?.claim || "",
    claim: c?.claim || "", timestamp: c?.timestamp || "",
  }));
  return out.filter((c) => c.query.trim().length > 0);
}

async function retrievePassages(env, claims) {
  if (!env.AI || !env.TEXTBOOKS || !env.QBANK_DB) {
    throw new Error("grounding bindings not configured (AI / TEXTBOOKS / QBANK_DB)");
  }

  // One batched embedding call for every claim query.
  const embedded = await env.AI.run(EMBEDDING_MODEL, {
    text: claims.map((c) => c.query.slice(0, 2000)),
  });
  const vectors = embedded?.data || [];

  // Vectorize queries run concurrently; each claim gets its own hit list.
  const hitLists = await Promise.all(claims.map(async (c, i) => {
    const vec = vectors[i];
    if (!vec) return [];
    const opts = { topK: RETRIEVE_TOP_K, returnMetadata: true };
    // Pharmacology claims are restricted to the drug references (see PHARM_BOOKS).
    if (c.kind === "drug") opts.filter = { book_key: { $in: PHARM_BOOKS } };
    try {
      const res = await env.TEXTBOOKS.query(vec, opts);
      return (res.matches || []).map((m) => ({
        id: m.id, score: m.score,
        book: m.metadata?.book || m.metadata?.book_key || "",
        page: m.metadata?.page ?? null,
      }));
    } catch { return []; }
  }));

  // Fetch passage text for every unique chunk in one round trip.
  const ids = [...new Set(hitLists.flat().map((h) => h.id))];
  const textById = new Map();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = await env.QBANK_DB.prepare(
      `SELECT id, book, page, text FROM textbook_chunks WHERE id IN (${placeholders})`
    ).bind(...ids).all();
    for (const r of rows.results || []) textById.set(r.id, r);
  }

  // Spend the character budget in global relevance order, so the strongest
  // passages survive regardless of which claim they belong to.
  const ranked = hitLists
    .flatMap((hits, i) => hits.map((h) => ({ ...h, claimIdx: i })))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const perClaim = claims.map(() => []);
  let budget = MAX_GROUNDING_CHARS;
  for (const h of ranked) {
    const row = textById.get(h.id);
    if (!row) continue;
    const text = String(row.text || "").slice(0, MAX_PASSAGE_CHARS);
    if (text.length > budget) continue;
    budget -= text.length;
    perClaim[h.claimIdx].push({
      id: h.id,
      book: row.book || h.book,
      page: row.page ?? h.page,
      score: Number((h.score || 0).toFixed(4)),
      text,
    });
  }
  return perClaim;
}

// ----------------------------------------------------------------------------
// RAG pass 2: check each claim against its retrieved passages. Text-only, so
// the video is not re-uploaded and this call is cheap.
// ----------------------------------------------------------------------------
const GROUNDING_SYSTEM_PROMPT = `You are checking claims from a nursing-education video against passages from nursing textbooks.

You will receive numbered claims, each with candidate passages quoted from real textbooks (with book and page).

For EACH claim, decide strictly on the basis of the passages provided:
  - "supported"     — a passage directly supports the claim. Cite it.
  - "contradicted"  — a passage directly contradicts the claim. Cite it and give the corrected statement.
  - "not_addressed" — the passages do not settle it either way.

Rules that matter:
- Judge ONLY from the passages given. Do NOT fall back on your own knowledge — if the passages don't
  settle it, the answer is "not_addressed". This is the entire point of the exercise.
- "not_addressed" is a perfectly good answer and is much safer than a guess. Do not stretch a loosely
  related passage into support.
- A passage that mentions the same drug or topic but does not speak to the specific assertion is
  "not_addressed", not "supported".
- Quote the exact sentence you relied on, kept short.

Return ONLY valid JSON:

{
  "claims": [
    {
      "ref": "the ref string given to you, verbatim",
      "verdict": "supported | contradicted | not_addressed",
      "citations": [ { "id": "chunk id", "book": "book title", "page": 123, "quote": "the exact sentence relied on" } ],
      "correction": "if contradicted, the correct statement; otherwise empty string",
      "note": "one short sentence of reasoning"
    }
  ]
}`;

async function groundClaims(apiKey, model, claims, passagesPerClaim) {
  const blocks = claims.map((c, i) => {
    const ps = passagesPerClaim[i] || [];
    const passageText = ps.length
      ? ps.map((p, n) => `  [${n + 1}] id=${p.id} | ${p.book}, p.${p.page}\n      "${p.text}"`).join("\n")
      : "  (no passages retrieved)";
    return `CLAIM ref=${c.ref} (${c.kind}${c.drug ? `, drug: ${c.drug}` : ""}${c.timestamp ? `, at ${c.timestamp}` : ""})\n  "${c.claim}"\n  PASSAGES:\n${passageText}`;
  }).join("\n\n");

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GROUNDING_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: blocks }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini grounding -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const parsed = extractJson(text);
  if (!parsed) throw new Error("grounding returned unparseable JSON");

  const u = data.usageMetadata || {};
  return {
    byRef: new Map((parsed.claims || []).map((c) => [c.ref, c])),
    usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 },
  };
}

// Normalise for quote matching: collapse whitespace, drop punctuation, lowercase.
// Textbook OCR is full of odd spacing and stray hyphens, so an exact string
// compare would reject quotes that are genuinely present.
function normaliseQuote(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Verify each citation against the passages that were actually retrieved.
//
// Without this, "supported" rests on the model's word: it could cite a page it
// was never shown, or paraphrase a quote that doesn't exist. Both are exactly
// the failure this whole feature exists to prevent, so both are checked
// mechanically rather than trusted:
//   1. the cited chunk id must be one we actually put in front of the model
//   2. the quoted sentence must really appear in that chunk's text
// A citation failing either check is dropped and recorded. If a "supported"
// verdict loses every citation, it is demoted to not_addressed — which forces
// low confidence and escalates to the nurse.
function verifyCitations(grounding, passages) {
  const byId = new Map((passages || []).map((p) => [p.id, normaliseQuote(p.text)]));
  const kept = [], rejected = [];

  for (const c of grounding.citations || []) {
    const haystack = byId.get(c?.id);
    if (!haystack) { rejected.push({ ...c, why: "cited a passage that was never retrieved" }); continue; }
    const needle = normaliseQuote(c?.quote);
    if (!needle) { kept.push({ ...c, verified: false, why: "no quote given" }); continue; }
    // Match on a prefix: models routinely truncate a long sentence, and the
    // passage itself is capped at MAX_PASSAGE_CHARS so the tail may be cut off.
    const probe = needle.length > 40 ? needle.slice(0, 40) : needle;
    if (haystack.includes(probe)) kept.push({ ...c, verified: true });
    else rejected.push({ ...c, why: "quote not found in the cited passage" });
  }

  grounding.citations = kept;
  if (rejected.length) grounding.rejected_citations = rejected;

  const anyVerified = kept.some((c) => c.verified);
  if (grounding.verdict === "supported" && !anyVerified) {
    grounding.verdict = "not_addressed";
    grounding.demoted_from = "supported";
    grounding.note = (grounding.note ? grounding.note + " " : "")
      + "Demoted: no citation could be verified against the retrieved passages.";
  }
  return grounding;
}

// Merge grounding verdicts back onto the claims.
//
// The key safety move: a clinical or drug claim that the textbooks contradict or
// simply don't address is FORCED to low confidence. enforceHumanNurse() then
// escalates it through the path that is already tested — an ungrounded claim
// cannot pass as high-confidence just because the model felt sure.
function applyGrounding(review, claims, passagesPerClaim, byRef) {
  let supported = 0, contradicted = 0, notAddressed = 0;

  claims.forEach((c, i) => {
    const target = c.kind === "drug" ? review.drug_pharmacology_claims : review.clinical_claims;
    const claimObj = target?.[c.index];
    if (!claimObj || typeof claimObj !== "object") return;

    const g = byRef.get(c.ref);
    const grounding = {
      verdict: g?.verdict || "not_addressed",
      citations: Array.isArray(g?.citations) ? g.citations : [],
      correction: g?.correction || "",
      note: g?.note || "",
      passages_retrieved: (passagesPerClaim[i] || []).length,
    };

    // Verify BEFORE counting or adjusting confidence — verification can demote a
    // "supported" verdict, and the tallies and the nurse gate must reflect that.
    verifyCitations(grounding, passagesPerClaim[i]);
    claimObj.grounding = grounding;

    if (grounding.verdict === "supported") supported++;
    else if (grounding.verdict === "contradicted") contradicted++;
    else notAddressed++;

    if (grounding.verdict !== "supported") {
      claimObj.confidence_before_grounding = claimObj.confidence ?? null;
      claimObj.confidence = "low";
    }
  });

  review.grounding = {
    corpus: "nitm-textbooks (8 nursing titles, 43,990 passages)",
    supported, contradicted, not_addressed: notAddressed,
    checked: claims.length,
  };

  // Pass 1 set the recommendation before any of this was known. If the textbooks
  // contradict a claim, leaving a green "publish" next to a contradiction tells
  // the reviewer two opposite things — and the pill is what they act on.
  // A contradicted drug claim is a wrong dose or route: that is not "revise".
  if (contradicted > 0) {
    const drugContradicted = (Array.isArray(review.drug_pharmacology_claims) ? review.drug_pharmacology_claims : [])
      .some((c) => c?.grounding?.verdict === "contradicted");
    downgradeRecommendation(review, drugContradicted ? "do_not_publish" : "revise",
      drugContradicted
        ? "A drug or dosage claim is contradicted by the reference library."
        : "A clinical claim is contradicted by the reference library.");
  }
  return review;
}

// Severity order, least to most serious. Only ever moves toward more caution.
const RECOMMENDATION_ORDER = ["publish", "publish_with_edits", "revise", "do_not_publish"];

function downgradeRecommendation(review, floor, why) {
  if (!review.overall || typeof review.overall !== "object") review.overall = {};
  const current = review.overall.recommendation;
  const ci = RECOMMENDATION_ORDER.indexOf(current);
  const fi = RECOMMENDATION_ORDER.indexOf(floor);
  if (fi < 0) return review;
  // An unrecognised current value is treated as the mildest, so it still gets
  // pulled up to the floor rather than being left alone.
  if (ci >= fi) return review;
  review.overall.recommendation = floor;
  review.overall.recommendation_before_grounding = current ?? null;
  review.overall.reason = review.overall.reason ? `${review.overall.reason} ${why}` : why;
  return review;
}

// ----------------------------------------------------------------------------
// Full pipeline: fetch -> upload -> wait ACTIVE -> review -> enforce -> cleanup
// ----------------------------------------------------------------------------
async function reviewVideo(env, db, { videoUrl, r2Key, mimeType, meta }) {
  const apiKey = env.GEMINI_API_KEY;
  const model = await resolveModel(db, env);
  const displayName = (meta && (meta.title || meta.name)) || "ops-hub-video-review";

  const source = await resolveSource(env, { videoUrl, r2Key, mimeType });
  const uploaded = await uploadToGemini(apiKey, source, String(displayName).slice(0, 120));
  try {
    const active = await waitForActive(apiKey, uploaded.name);
    const { review, usage } = await generateReview(apiKey, model, {
      uri: active.uri || uploaded.uri,
      mimeType: active.mimeType || uploaded.mimeType,
    });

    // --- RAG grounding pass -------------------------------------------------
    // Pass 1 above judged claims from the model's own knowledge. This second,
    // text-only pass re-checks every clinical and drug claim against the nursing
    // textbook corpus, and anything the books don't support is knocked down to
    // low confidence so the nurse gate catches it.
    const claims = collectClaims(review);
    if (claims.length && env.TEXTBOOKS && env.QBANK_DB && env.AI) {
      try {
        const passages = await retrievePassages(env, claims);
        const { byRef, usage: gUsage } = await groundClaims(apiKey, model, claims, passages);
        applyGrounding(review, claims, passages, byRef);
        usage.grounding_input_tokens = gUsage.input_tokens;
        usage.grounding_output_tokens = gUsage.output_tokens;
        const p = geminiPricing(model);
        usage.est_cost_usd += gUsage.input_tokens * p.in + gUsage.output_tokens * p.out;
        usage.input_tokens += gUsage.input_tokens;
        usage.output_tokens += gUsage.output_tokens;
      } catch (e) {
        // Grounding is a safety net, not a gate. If it fails we still return the
        // review — and because enforceHumanNurse() escalates all pharmacology and
        // anything below high confidence regardless, a grounding failure can only
        // ever make the outcome MORE cautious, never less.
        review.grounding = { error: e.message, checked: 0 };
      }
    } else if (claims.length) {
      review.grounding = { error: "grounding not configured", checked: 0 };
    }

    return { review: enforceHumanNurse(review), usage };
  } finally {
    await deleteGeminiFile(apiKey, uploaded.name);
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
export async function handleVideoReviewAPI(request, env, path) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!env.DB) return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: cors });

  const db = env.DB;
  await ensureVideoReviewTables(db);

  try {
    // ---- model selection ------------------------------------------------

    // GET /video-review/api/models — what this API key can actually use, plus
    // which one is currently selected and where that selection came from.
    if (path === "/video-review/api/models" && request.method === "GET") {
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 500, headers: cors });
      }
      const saved = await getConfig(db, "model");
      const models = await listGeminiModels(env.GEMINI_API_KEY);
      return new Response(JSON.stringify({
        models,
        selected: saved || env.GEMINI_MODEL || DEFAULT_MODEL,
        source: saved ? "saved" : (env.GEMINI_MODEL ? "wrangler var" : "built-in default"),
        env_default: env.GEMINI_MODEL || DEFAULT_MODEL,
      }), { headers: cors });
    }

    // POST /video-review/api/models  { model }
    // Verified against the live API before saving, so a retired or unavailable
    // model is rejected here rather than failing mid-review.
    if (path === "/video-review/api/models" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 500, headers: cors });
      }
      const b = await request.json().catch(() => ({}));
      const model = typeof b.model === "string" ? b.model.trim() : "";
      if (!model || !/^[\w.\-]+$/.test(model)) {
        return new Response(JSON.stringify({ error: "a valid model id is required" }), { status: 400, headers: cors });
      }
      try {
        await verifyModel(env.GEMINI_API_KEY, model);
      } catch (e) {
        return new Response(JSON.stringify({ error: `${model} did not work: ${e.message}` }), { status: 400, headers: cors });
      }
      await setConfig(db, "model", model);
      return new Response(JSON.stringify({ ok: true, selected: model }), { headers: cors });
    }

    // ---- chunked upload (drag-and-drop from the browser) ----------------
    // Multipart, not one big PUT: video length varies and a single request that
    // dies at 95% is a miserable way to find out you hit a size ceiling.

    // POST /video-review/api/upload/start  { filename, contentType }
    if (path === "/video-review/api/upload/start" && request.method === "POST") {
      if (!env.VIDEO_REVIEW_UPLOADS) return new Response(JSON.stringify({ error: "R2 not configured" }), { status: 500, headers: cors });
      const b = await request.json().catch(() => ({}));
      const contentType = String(b.contentType || "").split(";")[0].trim().toLowerCase();
      if (!VIDEO_CONTENT_TYPES.has(contentType)) {
        return new Response(JSON.stringify({ error: `unsupported video type: ${contentType || "(none)"}` }), { status: 400, headers: cors });
      }
      const safeName = String(b.filename || "video").replace(/[^\w.\-]+/g, "_").slice(-80);
      const key = `uploads/${crypto.randomUUID()}-${safeName}`;
      const mpu = await env.VIDEO_REVIEW_UPLOADS.createMultipartUpload(key, { httpMetadata: { contentType } });
      return new Response(JSON.stringify({ key, uploadId: mpu.uploadId, partSize: UPLOAD_PART_BYTES }), { headers: cors });
    }

    // PUT /video-review/api/upload/part?key=&uploadId=&part=N   (raw bytes)
    if (path === "/video-review/api/upload/part" && request.method === "PUT") {
      if (!env.VIDEO_REVIEW_UPLOADS) return new Response(JSON.stringify({ error: "R2 not configured" }), { status: 500, headers: cors });
      const q = new URL(request.url).searchParams;
      const key = q.get("key"), uploadId = q.get("uploadId"), partNumber = parseInt(q.get("part") || "", 10);
      const keyErr = badUploadKey(key);
      if (keyErr) return new Response(JSON.stringify({ error: keyErr }), { status: 400, headers: cors });
      if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
        return new Response(JSON.stringify({ error: "uploadId and a part number >= 1 are required" }), { status: 400, headers: cors });
      }
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength === 0) return new Response(JSON.stringify({ error: "empty part" }), { status: 400, headers: cors });
      const mpu = env.VIDEO_REVIEW_UPLOADS.resumeMultipartUpload(key, uploadId);
      const part = await mpu.uploadPart(partNumber, bytes);
      return new Response(JSON.stringify({ partNumber: part.partNumber, etag: part.etag }), { headers: cors });
    }

    // POST /video-review/api/upload/complete  { key, uploadId, parts:[{partNumber, etag}] }
    if (path === "/video-review/api/upload/complete" && request.method === "POST") {
      if (!env.VIDEO_REVIEW_UPLOADS) return new Response(JSON.stringify({ error: "R2 not configured" }), { status: 500, headers: cors });
      const b = await request.json().catch(() => ({}));
      const keyErr = badUploadKey(b.key);
      if (keyErr) return new Response(JSON.stringify({ error: keyErr }), { status: 400, headers: cors });
      if (!b.uploadId || !Array.isArray(b.parts) || b.parts.length === 0) {
        return new Response(JSON.stringify({ error: "uploadId and a non-empty parts array are required" }), { status: 400, headers: cors });
      }
      const mpu = env.VIDEO_REVIEW_UPLOADS.resumeMultipartUpload(b.key, b.uploadId);
      const obj = await mpu.complete(b.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
      return new Response(JSON.stringify({ key: b.key, size: obj.size }), { headers: cors });
    }

    // POST /video-review/api/upload/abort  { key, uploadId }  — tidy up a cancelled upload
    if (path === "/video-review/api/upload/abort" && request.method === "POST") {
      if (!env.VIDEO_REVIEW_UPLOADS) return new Response(JSON.stringify({ error: "R2 not configured" }), { status: 500, headers: cors });
      const b = await request.json().catch(() => ({}));
      const keyErr = badUploadKey(b.key);
      if (keyErr) return new Response(JSON.stringify({ error: keyErr }), { status: 400, headers: cors });
      try { await env.VIDEO_REVIEW_UPLOADS.resumeMultipartUpload(b.key, b.uploadId).abort(); } catch { /* already gone */ }
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // GET /video-review/api/video/<key>  — play an uploaded video back.
    // Served through the Worker so it stays behind Cloudflare Access, same as
    // the med-supplies images. Range requests so the player can scrub.
    if (path.startsWith("/video-review/api/video/") && request.method === "GET") {
      if (!env.VIDEO_REVIEW_UPLOADS) return new Response("R2 not configured", { status: 500 });
      const key = decodeURIComponent(path.slice("/video-review/api/video/".length));
      if (badUploadKey(key)) return new Response("bad key", { status: 400 });
      const range = request.headers.get("Range");
      const obj = await env.VIDEO_REVIEW_UPLOADS.get(key, range ? { range: request.headers } : undefined);
      if (!obj) return new Response("not found", { status: 404 });
      const headers = {
        "Content-Type": obj.httpMetadata?.contentType || "video/mp4",
        "Accept-Ranges": "bytes",
        // private: never let a shared cache hold media that Access protects
        "Cache-Control": "private, max-age=3600",
        ...(obj.httpEtag ? { ETag: obj.httpEtag } : {}),
      };
      // Only a client that actually sent Range gets a 206. R2 reports a `range`
      // on full reads too, so keying off the object alone 206s everything.
      if (range && obj.range && typeof obj.range.offset === "number") {
        const end = obj.range.offset + (obj.range.length ?? 0) - 1;
        headers["Content-Range"] = `bytes ${obj.range.offset}-${end}/${obj.size}`;
        return new Response(obj.body, { status: 206, headers });
      }
      return new Response(obj.body, { headers });
    }

    // POST /video-review/api/review  { videoUrl | r2Key, mimeType?, meta? }
    if (path === "/video-review/api/review" && request.method === "POST") {
      // Validate the caller's request before the server's own config, so a
      // malformed body isn't reported as a config error.
      const body = await request.json().catch(() => ({}));
      const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl : null;
      const r2Key = typeof body.r2Key === "string" ? body.r2Key : null;
      if (!videoUrl && !r2Key) {
        return new Response(JSON.stringify({ error: "videoUrl or r2Key is required" }), { status: 400, headers: cors });
      }
      if (r2Key) {
        const keyErr = badUploadKey(r2Key);
        if (keyErr) return new Response(JSON.stringify({ error: keyErr }), { status: 400, headers: cors });
      }
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 500, headers: cors });
      }

      const { review, usage } = await reviewVideo(env, db, {
        videoUrl,
        r2Key,
        mimeType: body.mimeType,
        meta: body.meta,
      });

      const id = crypto.randomUUID();
      const needsHumanNurse = review.overall?.needs_human_nurse === true;
      // Source label: the URL for a link, the original filename for an upload.
      const sourceLabel = videoUrl || (body.meta && body.meta.filename) || r2Key;
      await db.prepare(`INSERT INTO video_reviews
          (id, video_url, r2_key, video_meta, recommendation, needs_human_nurse, review_json, input_tokens, output_tokens, est_cost_usd, model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          id,
          sourceLabel,
          r2Key,
          body.meta ? JSON.stringify(body.meta) : null,
          review.overall?.recommendation ?? null,
          needsHumanNurse ? 1 : 0,
          JSON.stringify(review),
          usage.input_tokens,
          usage.output_tokens,
          usage.est_cost_usd,
          usage.model
        ).run();

      return new Response(JSON.stringify({ id, needs_human_nurse: needsHumanNurse, review, usage }), { headers: cors });
    }

    // GET /video-review/api/reviews  — 50 most recent
    if (path === "/video-review/api/reviews" && request.method === "GET") {
      const result = await db.prepare(`SELECT id, video_url, r2_key, recommendation, needs_human_nurse, est_cost_usd, model, created_at
        FROM video_reviews ORDER BY created_at DESC LIMIT 50`).all();
      return new Response(JSON.stringify({ reviews: result.results }), { headers: cors });
    }

    // GET /video-review/api/reviews/:id  — full stored review
    const idMatch = path.match(/^\/video-review\/api\/reviews\/([^/]+)$/);
    if (idMatch && request.method === "GET") {
      const row = await db.prepare(`SELECT * FROM video_reviews WHERE id = ?`).bind(idMatch[1]).first();
      if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
      const { review_json, ...rest } = row;
      return new Response(JSON.stringify({
        ...rest,
        needs_human_nurse: row.needs_human_nurse === 1,
        video_meta: row.video_meta ? JSON.parse(row.video_meta) : null,
        review: JSON.parse(review_json),
      }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
}
