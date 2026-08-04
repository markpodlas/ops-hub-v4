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
// SECRET: env.GEMINI_API_KEY   (wrangler secret put — this repo is public)
// VAR:    env.GEMINI_MODEL     (wrangler.jsonc vars; see MODEL note below)
//
// Dependency-free: fetch + D1 only, no SDK.
// ============================================================================

const GEMINI_BASE = "https://generativelanguage.googleapis.com";

// gemini-2.5-flash RETIRES 2026-10-16. The model is read from env.GEMINI_MODEL
// (set in wrangler.jsonc) precisely so the migration is a one-line config change
// with no code deploy. This constant is only the last-resort fallback.
const DEFAULT_MODEL = "gemini-2.5-flash";

// Worker memory is 128 MB and we may have to buffer the whole video (see
// uploadToGemini). Refuse anything that would put us near the ceiling.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// File API processing (transcode/index) for a short clip is seconds, but a
// cold/large upload can take longer. Give up rather than hang the caller.
const MAX_POLL_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

// ----------------------------------------------------------------------------
// Schema — self-creating. Mirrors migrations/0001_video_reviews.sql exactly;
// change one, change the other.
// ----------------------------------------------------------------------------
async function ensureVideoReviewTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS video_reviews (
      id                 TEXT PRIMARY KEY,
      video_url          TEXT NOT NULL,
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
  ]);
}

// ----------------------------------------------------------------------------
// Pricing — rough per-MTok estimate, keyed by model-name substring the same way
// cxModelPricing() does in index.js. Gemini prices video/audio input tiers
// differently from text, so treat est_cost_usd as a budget signal, not a bill.
// ----------------------------------------------------------------------------
function geminiPricing(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("flash-lite")) return { in: 0.10e-6, out: 0.40e-6 };
  if (m.includes("flash"))      return { in: 0.30e-6, out: 2.50e-6 };
  if (m.includes("pro"))        return { in: 1.25e-6, out: 10.00e-6 };
  return { in: 1.25e-6, out: 10.00e-6 }; // safe default = Pro
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

// Fetch the source video and push it to Gemini. Streams the body straight
// through when the source told us its length; only buffers when it didn't
// (the resumable protocol needs the byte count up front).
async function uploadToGemini(apiKey, videoUrl, mimeTypeHint, displayName) {
  const src = await fetch(videoUrl);
  if (!src.ok) throw new Error(`Fetch video -> ${src.status} ${src.statusText}`);
  if (!src.body) throw new Error("Fetch video: empty body");

  const mimeType = mimeTypeHint || src.headers.get("content-type") || "video/mp4";
  const declared = parseInt(src.headers.get("content-length") || "", 10);

  let bytes, body;
  if (Number.isFinite(declared) && declared > 0) {
    if (declared > MAX_VIDEO_BYTES) {
      throw new Error(`Video is ${declared} bytes; limit is ${MAX_VIDEO_BYTES}`);
    }
    bytes = declared;
    body = src.body;                          // stream through, no buffering
  } else {
    const buf = await src.arrayBuffer();      // length unknown — must buffer
    if (buf.byteLength > MAX_VIDEO_BYTES) {
      throw new Error(`Video is ${buf.byteLength} bytes; limit is ${MAX_VIDEO_BYTES}`);
    }
    bytes = buf.byteLength;
    body = buf;
  }
  if (bytes === 0) throw new Error("Fetch video: zero-length body");

  const uploadUrl = await startResumableUpload(apiKey, { bytes, mimeType, displayName });

  const res = await fetch(uploadUrl, {
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
  // === RAG GROUNDING HOOK ===========================================
  // A retrieval layer plugs in HERE, before the request is built. Fetch the
  // top-k passages from the nursing reference corpus (Vectorize / D1 FTS keyed
  // off the video's topic or a cheap first-pass transcript), then:
  //   1. push them as an extra part:
  //        parts.push({ text: `REFERENCE MATERIAL (cite by [n]):\n${passages}` })
  //   2. instruct the model in SYSTEM_PROMPT to cite them per claim via a
  //      `sources: [{ ref: "[2]", quote: "..." }]` field on each claim object
  //   3. treat an uncited clinical claim as NOT high confidence in
  //      isHighConfidence() above, so ungrounded assertions still escalate.
  // Nothing is wired yet — every claim today rests on the model's own
  // knowledge, which is exactly why enforceHumanNurse() is unconditional.
  // ==================================================================
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
// Full pipeline: fetch -> upload -> wait ACTIVE -> review -> enforce -> cleanup
// ----------------------------------------------------------------------------
async function reviewVideo(env, { videoUrl, mimeType, meta }) {
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const displayName = (meta && (meta.title || meta.name)) || "ops-hub-video-review";

  const uploaded = await uploadToGemini(apiKey, videoUrl, mimeType, String(displayName).slice(0, 120));
  try {
    const active = await waitForActive(apiKey, uploaded.name);
    const { review, usage } = await generateReview(apiKey, model, {
      uri: active.uri || uploaded.uri,
      mimeType: active.mimeType || uploaded.mimeType,
    });
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
    // POST /video-review/api/review  { videoUrl, mimeType?, meta? }
    if (path === "/video-review/api/review" && request.method === "POST") {
      // Validate the caller's request before the server's own config, so a
      // malformed body isn't reported as a config error.
      const body = await request.json().catch(() => ({}));
      const videoUrl = body.videoUrl;
      if (!videoUrl || typeof videoUrl !== "string") {
        return new Response(JSON.stringify({ error: "videoUrl is required" }), { status: 400, headers: cors });
      }
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 500, headers: cors });
      }

      const { review, usage } = await reviewVideo(env, {
        videoUrl,
        mimeType: body.mimeType,
        meta: body.meta,
      });

      const id = crypto.randomUUID();
      const needsHumanNurse = review.overall?.needs_human_nurse === true;
      await db.prepare(`INSERT INTO video_reviews
          (id, video_url, video_meta, recommendation, needs_human_nurse, review_json, input_tokens, output_tokens, est_cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          id,
          videoUrl,
          body.meta ? JSON.stringify(body.meta) : null,
          review.overall?.recommendation ?? null,
          needsHumanNurse ? 1 : 0,
          JSON.stringify(review),
          usage.input_tokens,
          usage.output_tokens,
          usage.est_cost_usd
        ).run();

      return new Response(JSON.stringify({ id, needs_human_nurse: needsHumanNurse, review, usage }), { headers: cors });
    }

    // GET /video-review/api/reviews  — 50 most recent
    if (path === "/video-review/api/reviews" && request.method === "GET") {
      const result = await db.prepare(`SELECT id, recommendation, needs_human_nurse, est_cost_usd, created_at
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
