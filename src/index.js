import { handleStageRoutes } from "./stage-tracker.js";
// ===== OPS HUB WORKER — v5 with 3PL API consolidated =====
const CLICKUP_API = "https://api.clickup.com/api/v2";
const SHEET_BASE = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSCO2_B3HitEVQIJE71RL357tdUPErxkhG4AdwXapyhOWtry_-czGMVg_HpZ0paQQ/pub";
const GIDS = { lists: 601447197, settings: 370298211, customFields: 1218915327, statusOptions: 1580123029, brandColors: 1121511065 };
function parseCSV(text) {
  const rows = []; let row = []; let cell = ""; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (inQ && text[i+1] === '"') { cell += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { row.push(cell); cell = ""; }
    else if ((c === '\n' || c === '\r') && !inQ) { if (c === '\r' && text[i+1] === '\n') i++; row.push(cell); cell = ""; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(c => c.trim())).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || "").trim(); });
    return obj;
  });
}
async function fetchSheet(gid) {
  const res = await fetch(`${SHEET_BASE}?gid=${gid}&single=true&output=csv`);
  return parseCSV(await res.text());
}
async function fetchListTasks(token, list) {
  const tasks = []; let page = 0;
  while (page < 10) {
    try {
      const res = await fetch(`${CLICKUP_API}/list/${list["List ID"]}/task?include_closed=true&subtasks=true&page=${page}`, { headers: { Authorization: token } });
      if (!res.ok) break;
      const data = await res.json(); const pageTasks = data.tasks || [];
      pageTasks.forEach(t => {
        const cf = t.custom_fields?.find(f => f.name === "Post Date"); let postDate = null;
        if (cf?.value) { const utc = new Date(parseInt(cf.value)); postDate = `${utc.getUTCFullYear()}-${String(utc.getUTCMonth()+1).padStart(2,'0')}-${String(utc.getUTCDate()).padStart(2,'0')}`; }
        tasks.push({ id: t.id, name: t.name, status: t.status?.status || "", post_date: postDate, list_id: list["List ID"], list_name: list["List Name"], brand: list.Brand, platform: list.Platform, color: list["Platform Color (Hex)"] || "#666", url: t.url || "", custom_fields: JSON.stringify(t.custom_fields || []), tags: JSON.stringify((t.tags || []).map(tag => tag.name || tag)) });
      });
      if (pageTasks.length < 100) break; page++;
    } catch { break; }
  }
  return tasks;
}
async function fullSync(env) {
  // Idempotent migration: ensure tags column exists on tasks table
  try { await env.DB.prepare("ALTER TABLE tasks ADD COLUMN tags TEXT DEFAULT '[]'").run(); } catch (e) { /* column already exists */ }
  const [lists, settings, customFields, statusOptions, brandColors] = await Promise.all([
    fetchSheet(GIDS.lists), fetchSheet(GIDS.settings), fetchSheet(GIDS.customFields), fetchSheet(GIDS.statusOptions), fetchSheet(GIDS.brandColors),
  ]);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO config_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind("lists", JSON.stringify(lists)),
    env.DB.prepare("INSERT OR REPLACE INTO config_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind("settings", JSON.stringify(settings)),
    env.DB.prepare("INSERT OR REPLACE INTO config_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind("customFields", JSON.stringify(customFields)),
    env.DB.prepare("INSERT OR REPLACE INTO config_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind("statusOptions", JSON.stringify(statusOptions)),
    env.DB.prepare("INSERT OR REPLACE INTO config_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind("brandColors", JSON.stringify(brandColors)),
  ]);
  const activeLists = lists.filter(l => (l["Active (TRUE/FALSE)"] || "").toUpperCase() === "TRUE");
  const allTasks = [];
  for (let i = 0; i < activeLists.length; i += 4) {
    const batch = activeLists.slice(i, i + 4);
    const results = await Promise.all(batch.map(list => fetchListTasks(env.CLICKUP_TOKEN, list)));
    results.forEach(t => allTasks.push(...t));
  }
  const batchSize = 50;
  for (let i = 0; i < allTasks.length; i += batchSize) {
    const batch = allTasks.slice(i, i + batchSize);
    const stmts = batch.map(t => env.DB.prepare(`INSERT OR REPLACE INTO tasks (id, name, status, post_date, list_id, list_name, brand, platform, color, url, custom_fields, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).bind(t.id, t.name, t.status, t.post_date, t.list_id, t.list_name, t.brand, t.platform, t.color, t.url, t.custom_fields, t.tags));
    await env.DB.batch(stmts);
  }
  const currentTaskIds = new Set(allTasks.map(t => t.id));
  for (const list of activeLists) {
    const { results: dbTasks } = await env.DB.prepare("SELECT id FROM tasks WHERE list_id = ?").bind(list["List ID"]).all();
    const toDelete = dbTasks.filter(t => !currentTaskIds.has(t.id)).map(t => t.id);
    for (let i = 0; i < toDelete.length; i += 50) { const batch = toDelete.slice(i, i + 50); await env.DB.batch(batch.map(id => env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id))); }
  }
  return allTasks.length;
}
async function handleShipFusionAPI(request, env) {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") { return new Response(null, { headers: corsHeaders }); }
  if (!env.SHIPFUSION_USERNAME || !env.SHIPFUSION_PASSWORD) { return new Response(JSON.stringify({ error: "ShipFusion not configured" }), { status: 400, headers: corsHeaders }); }
  try {
    const auth = btoa(`${env.SHIPFUSION_USERNAME}:${env.SHIPFUSION_PASSWORD}`);
    const headers = { "Authorization": `Basic ${auth}`, "Content-Type": "application/json", "Accept": "application/json" };
    async function fetchAllPages(warehouse) { const allItems = []; let page = 1; let totalPages = 1; while (page <= totalPages) { const url = `https://api.shipfusion.com/v1/inventory?warehouse=${warehouse}&perPage=100&page=${page}`; const response = await fetch(url, { method: "GET", headers }); if (!response.ok) break; const data = await response.json(); totalPages = data.totalPages || 1; allItems.push(...(data.items || [])); page++; } return allItems; }
    async function fetchSkuVelocity(sku, warehouse) { try { const url = `https://api.shipfusion.com/v1/inventory/${encodeURIComponent(sku)}?warehouse=${warehouse}`; const response = await fetch(url, { method: "GET", headers }); if (!response.ok) return { velocity30: 0, velocity60: 0 }; const data = await response.json(); return { velocity30: parseFloat(data['30DayAverage'] || 0), velocity60: parseFloat(data['60DayAverage'] || 0), _rawResponse: data, _url: url }; } catch (e) { return { velocity30: 0, velocity60: 0, _error: e.message }; } }
    const [ilItems, lvItems] = await Promise.all([fetchAllPages('IL'), fetchAllPages('LV')]);
    const inventoryMap = new Map();
    for (const item of ilItems) { const sku = item.SKU || item.sku || ''; if (!sku) continue; inventoryMap.set(sku, { id: sku, sku, name: item.name || item.productName || sku, sfChicago: parseInt(item.ready||0), sfChicagoAllocated: parseInt(item.allocated||0), sfChicagoOnHand: parseInt(item.onHand||0), sfLasVegas: 0, sfLasVegasAllocated: 0, sfLasVegasOnHand: 0, velocityChicago: parseFloat(item['30DayAverage']||item['thirtyDayAverage']||item['velocity']||0), velocityVegas: 0, velocity: parseFloat(item['30DayAverage']||item['thirtyDayAverage']||item['velocity']||0), incoming: parseInt(item.incoming||0), backOrder: parseInt(item.backOrder||0), _rawFields: Object.keys(item).join(',') }); }
    for (const item of lvItems) { const sku = item.SKU || item.sku || ''; if (!sku) continue; const lvV = parseFloat(item['30DayAverage']||item['thirtyDayAverage']||item['velocity']||0); if (inventoryMap.has(sku)) { const e = inventoryMap.get(sku); e.sfLasVegas=parseInt(item.ready||0); e.sfLasVegasAllocated=parseInt(item.allocated||0); e.sfLasVegasOnHand=parseInt(item.onHand||0); e.incoming+=parseInt(item.incoming||0); e.backOrder+=parseInt(item.backOrder||0); e.velocityVegas=lvV; e.velocity=e.velocityChicago+lvV; } else { inventoryMap.set(sku, { id:sku, sku, name:item.name||item.productName||sku, sfChicago:0, sfChicagoAllocated:0, sfChicagoOnHand:0, sfLasVegas:parseInt(item.ready||0), sfLasVegasAllocated:parseInt(item.allocated||0), sfLasVegasOnHand:parseInt(item.onHand||0), velocityChicago:0, velocityVegas:lvV, velocity:lvV, incoming:parseInt(item.incoming||0), backOrder:parseInt(item.backOrder||0), _rawFields:Object.keys(item).join(',') }); } }
    const allSkus = Array.from(inventoryMap.keys());
    const velocityResults = await Promise.all(allSkus.map(sku => fetchSkuVelocity(sku, 'IL').then(vel => ({ sku, ...vel }))));
    for (const vel of velocityResults) { if (inventoryMap.has(vel.sku)) { const item = inventoryMap.get(vel.sku); item.velocity = vel.velocity30; item.velocity60 = vel.velocity60; } }
    const inventory = Array.from(inventoryMap.values()).map(item => ({ ...item, totalAvailable: item.sfChicago + item.sfLasVegas }));
    const sampleRawItem = ilItems[0] || lvItems[0] || null;
    return new Response(JSON.stringify({ success: true, source: "shipfusion", count: inventory.length, inventory, _debug: { ilCount: ilItems.length, lvCount: lvItems.length, sampleRawItem, sampleFields: sampleRawItem ? Object.keys(sampleRawItem) : [], velocityDebug: velocityResults.slice(0,3) } }), { headers: corsHeaders });
  } catch (error) { return new Response(JSON.stringify({ error: "Failed to fetch from ShipFusion", details: error.message }), { status: 500, headers: corsHeaders }); }
}

// ===== SHIPMONK API CLIENT + SYNC =====
// Auth: header `Api-Key: <key>`, base /v1/integrations, storeId on most calls.
const SHIPMONK_BASE = "https://api.shipmonk.com/v1/integrations";

// ShipMonk "MoneyOutput" fields can be a number or an object {amount|value|total}.
function smMoney(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object") return parseFloat(v.amount ?? v.value ?? v.total ?? 0) || 0;
  return parseFloat(v) || 0;
}

async function smFetch(env, path, { method = "GET", query = null, body = null } = {}) {
  if (!env.SHIPMONK_API_KEY) throw new Error("SHIPMONK_API_KEY not configured");
  let url = path.startsWith("http") ? path : `${SHIPMONK_BASE}${path}`;
  const q = new URLSearchParams();
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) q.set(k, v);
  // Note: the API key is already scoped to a store — endpoints reject an extra storeId param.
  const qs = q.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  const headers = { "Api-Key": env.SHIPMONK_API_KEY, "Accept": "application/json" };
  const opts = { method, headers };
  if (body != null) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`ShipMonk ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// Key/value sync-state table (same pattern as campaign_router_config).
async function smState(env, key, value) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shipmonk_sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`).run();
  if (value === undefined) {
    const row = await env.DB.prepare(`SELECT value FROM shipmonk_sync_state WHERE key = ?`).bind(key).first();
    return row ? row.value : null;
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO shipmonk_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).bind(key, String(value)).run();
}

// Pull orders-list pages (defensive about the list field name and pagination flag).
async function smOrdersList(env, { updatedAtStart = null, maxPages = 50 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const query = { page, pageSize: 100, sortOrder: "DESC" };
    if (updatedAtStart) query.updatedAtStart = updatedAtStart;
    const data = await smFetch(env, "/orders-list", { method: "GET", query });
    const root = data.data || data;
    const items = root.orders || root.items || root.results || (Array.isArray(root) ? root : []);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

// ShipMonk returns some fields as objects ({id,name}); reduce to a display string.
function smName(v) { return (v && typeof v === "object") ? (v.name || v.identifier || v.code || "") : (v == null ? "" : String(v)); }

function smMapOrderRow(o) {
  const sd = o.shipment_data || {};
  const sm = o.shipping_method || {};
  const costs = o.order_costs || {};
  const to = o.ship_to || {};
  const items = o.items || [];
  const units = items.reduce((s, it) => s + (parseInt(it.quantity ?? it.qty ?? 0) || 0), 0);
  return {
    shipmentId: smName(o.order_key) || smName(o.order_number) || (o.packages && o.packages[0] && smName(o.packages[0].tracking_number)) || "",
    orderNumber: smName(o.order_number),
    orderDate: smName(o.ordered_at),
    shipDate: smName(o.shipped_at),
    carrier: smName(sd.carrier) || smName(sm.carrier),
    service: smName(sd.service) || smName(o.requested_shipping_service) || smName(sm),
    carrierStatus: smName(o.processing_status) || smName(o.order_status),
    state: smName(to.state),
    country: smName(to.country_code) || smName(to.country),
    numProducts: units,
    shippingCost: smMoney(costs.estimated_shipping_related_charges) || smMoney(sd.estimated_shipping_cost),
    packagingCost: smMoney(costs.estimated_packaging_material_charges),
    pickPackCost: smMoney(costs.estimated_pick_and_pack_charges),
    items: items.map(it => ({ sku: it.sku || it.SKU || "", qty: parseInt(it.quantity ?? it.qty ?? 0) || 0 })).filter(li => li.sku),
  };
}

// Sync ShipMonk orders into tpl_orders + line items into shipmonk_order_items (for velocity).
async function syncShipmonkOrders(env, { backfillDays = 60, full = false } = {}) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tpl_orders (shipment_id TEXT PRIMARY KEY, order_number TEXT, ship_date TEXT, order_date TEXT, carrier_delivery_date TEXT, carrier TEXT, service TEXT, carrier_status TEXT, zone TEXT, state TEXT, country TEXT, num_products INTEGER DEFAULT 0, shipping_cost REAL DEFAULT 0, base_price REAL DEFAULT 0, residential_fee REAL DEFAULT 0, das_fee REAL DEFAULT 0, peak_fee REAL DEFAULT 0, fuel_fee REAL DEFAULT 0, services_cost REAL DEFAULT 0, packaging_cost REAL DEFAULT 0, first_pick_fee REAL DEFAULT 0, additional_pick_fee REAL DEFAULT 0, insert_pick_fee REAL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shipmonk_order_items (order_key TEXT, sku TEXT, qty INTEGER, shipped_at TEXT, PRIMARY KEY (order_key, sku))`).run();

  const last = full ? null : await smState(env, "orders_last_updated");
  const since = last || new Date(Date.now() - backfillDays * 864e5).toISOString();
  const orders = await smOrdersList(env, { updatedAtStart: since });
  const rows = orders.map(smMapOrderRow).filter(r => r.shipmentId);

  let written = 0;
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const stmts = [];
    for (const r of batch) {
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO tpl_orders (shipment_id, order_number, ship_date, order_date, carrier, service, carrier_status, state, country, num_products, shipping_cost, packaging_cost, first_pick_fee, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
      ).bind(r.shipmentId, r.orderNumber, r.shipDate, r.orderDate, r.carrier, r.service, r.carrierStatus, r.state, r.country, r.numProducts, r.shippingCost, r.packagingCost, r.pickPackCost));
      if (r.shipDate) {
        stmts.push(env.DB.prepare(`DELETE FROM shipmonk_order_items WHERE order_key = ?`).bind(r.shipmentId));
        for (const li of r.items) {
          stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO shipmonk_order_items (order_key, sku, qty, shipped_at) VALUES (?,?,?,?)`).bind(r.shipmentId, li.sku, li.qty, r.shipDate));
        }
      }
    }
    await env.DB.batch(stmts);
    written += batch.length;
  }
  await smState(env, "orders_last_updated", new Date().toISOString());
  await smState(env, "orders_last_sync_at", new Date().toISOString());
  return { synced: written, fetched: orders.length, since };
}

// Velocity (units/day) per SKU from shipped order line items.
async function smVelocityBySku(env) {
  const map = {};
  try {
    const q30 = await env.DB.prepare(`SELECT sku, SUM(qty) n FROM shipmonk_order_items WHERE shipped_at >= datetime('now','-30 day') GROUP BY sku`).all();
    const q60 = await env.DB.prepare(`SELECT sku, SUM(qty) n FROM shipmonk_order_items WHERE shipped_at >= datetime('now','-60 day') GROUP BY sku`).all();
    for (const r of (q30.results || [])) map[r.sku] = { velocity: (r.n || 0) / 30, velocity60: 0 };
    for (const r of (q60.results || [])) { map[r.sku] = map[r.sku] || { velocity: 0, velocity60: 0 }; map[r.sku].velocity60 = (r.n || 0) / 60; }
  } catch (e) { /* table may be empty before first sync */ }
  return map;
}

// Pull live inventory from products-search (defensive about field names / pagination).
async function smProductsSearch(env, { maxPages = 100 } = {}) {
  const all = [];
  const unwrap = (data) => { const r = data.data || data; return r.products || r.items || r.results || (Array.isArray(r) ? r : []); };
  const init = await smFetch(env, "/products/search", { method: "POST", body: {} });
  all.push(...unwrap(init));
  let cursor = (init.data && init.data.cursor) || init.cursor || null;
  for (let p = 0; p < maxPages && cursor; p++) {
    const data = await smFetch(env, "/products/search/paginate", { method: "GET", query: { cursor, pageSize: 100 } });
    const items = unwrap(data);
    all.push(...items);
    cursor = (data.data && data.data.cursor) || data.cursor || null;
    if (!items.length) break;
  }
  return all;
}

function smMapInventoryItem(p) {
  const sku = p.sku || "";
  const name = p.name || sku;
  const inv = p.inventory || {};
  const locs = Array.isArray(inv.locations) ? inv.locations : [];
  const warehouses = locs.map(l => ({
    warehouse: (l.warehouse && (l.warehouse.name || l.warehouse.identifier)) || "WH",
    code: (l.warehouse && l.warehouse.identifier) || "",
    available: parseInt(l.quantity_available || 0) || 0,
    onHand: parseInt(l.quantity_on_hand || 0) || 0,
    unavailable: parseInt(l.quantity_unavailable || 0) || 0,
  }));
  const available = parseInt(inv.quantity_total_available || 0) || 0;
  const onHand = parseInt(inv.quantity_total_on_hand || 0) || 0;
  const unavailable = parseInt(inv.quantity_total_unavailable || 0) || 0;
  const quarantined = parseInt(inv.quantity_total_quarantined || 0) || 0;
  return {
    id: sku, sku, name, active: p.is_active !== false,
    warehouses, available, onHand, allocated: unavailable, quarantined,
    stockOutDays: p.stock_out_days ?? null, totalAvailable: available,
  };
}

async function getShipmonkInventory(env) {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const raw = await smProductsSearch(env);
    const vel = await smVelocityBySku(env);
    const inventory = raw.map(smMapInventoryItem).filter(i => i.sku).map(i => ({
      ...i,
      velocity: (vel[i.sku] && vel[i.sku].velocity) || 0,
      velocity60: (vel[i.sku] && vel[i.sku].velocity60) || 0,
    }));
    // distinct warehouse labels seen, for dynamic columns
    const warehouseNames = [...new Set(inventory.flatMap(i => i.warehouses.map(w => w.warehouse)))];
    return new Response(JSON.stringify({ success: true, source: "shipmonk", count: inventory.length, warehouses: warehouseNames, inventory, _debug: { sampleRaw: raw[0] || null, sampleFields: raw[0] ? Object.keys(raw[0]) : [] } }), { headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: cors });
  }
}

// ===== AMAZON SP-API (FBA inventory via Reports API) =====
// Since Oct 2023 SP-API needs only an LWA OAuth token (no AWS SigV4). The FBA planning
// report is async + refreshes ~daily on Amazon's side, so it runs as a cron-driven state
// machine that caches into D1 (fba_inventory), mirroring the ShipMonk sync pattern.
const AMZ_SPAPI_BASE = "https://sellingpartnerapi-na.amazon.com"; // NA region
const AMZ_MARKETPLACE_ID = "ATVPDKIKX0DER"; // US
const AMZ_FBA_REPORT_TYPE = "GET_FBA_INVENTORY_PLANNING_DATA"; // Restock Inventory report

function amzConfigured(env) { return !!(env.AMAZON_REFRESH_TOKEN && env.AMAZON_LWA_CLIENT_ID && env.AMAZON_LWA_CLIENT_SECRET); }

// Key/value sync-state table (same pattern as smState). value===undefined reads; ===null clears.
async function amzState(env, key, value) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS amazon_sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`).run();
  if (value === undefined) {
    const row = await env.DB.prepare(`SELECT value FROM amazon_sync_state WHERE key = ?`).bind(key).first();
    return row ? row.value : null;
  }
  if (value === null) { await env.DB.prepare(`DELETE FROM amazon_sync_state WHERE key = ?`).bind(key).run(); return; }
  await env.DB.prepare(`INSERT OR REPLACE INTO amazon_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).bind(key, String(value)).run();
}

// Exchange the long-lived refresh token for a 1h LWA access token.
async function amzAccessToken(env) {
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.AMAZON_REFRESH_TOKEN,
      client_id: env.AMAZON_LWA_CLIENT_ID,
      client_secret: env.AMAZON_LWA_CLIENT_SECRET,
    }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = {}; }
  if (!res.ok || !json.access_token) throw new Error(`LWA token ${res.status}: ${text.slice(0, 300)}`);
  return json.access_token;
}

// Signed SP-API call (token reused across a sync tick to avoid re-minting).
async function amzFetch(env, path, { method = "GET", body = null, token = null } = {}) {
  const accessToken = token || await amzAccessToken(env);
  const url = path.startsWith("http") ? path : `${AMZ_SPAPI_BASE}${path}`;
  const headers = { "x-amz-access-token": accessToken, "Accept": "application/json" };
  const opts = { method, headers };
  if (body != null) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`SP-API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// Parse the report's tab-separated content. Header names vary, so match on a normalized key.
function amzParseFbaReport(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return { rows: [], headers: [] };
  const norm = h => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rawHeaders = lines[0].split("\t");
  const idx = {};
  rawHeaders.map(norm).forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  const get = (cells, keys) => { for (const k of keys) { if (k in idx) { const v = cells[idx[k]]; if (v != null && v !== "") return v; } } return ""; };
  const numOf = (cells, keys) => { const n = parseInt(String(get(cells, keys)).replace(/[^0-9-]/g, ""), 10); return isNaN(n) ? 0 : n; };
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split("\t");
    const sku = get(cells, ["sku", "sellersku", "merchantsku", "msku"]);
    if (!sku) continue;
    const inParts = numOf(cells, ["afninboundworkingquantity", "inboundworking"]) + numOf(cells, ["afninboundshippedquantity", "inboundshipped"]) + numOf(cells, ["afninboundreceivingquantity", "inboundreceiving"]);
    rows.push({
      sku,
      name: get(cells, ["productname", "title", "itemname"]),
      asin: get(cells, ["asin"]),
      available: numOf(cells, ["available", "afnfulfillablequantity", "availablequantity"]),
      unitsSold30: numOf(cells, ["unitssoldlast30days", "sales30d", "unitsordered30days"]),
      daysOfSupply: numOf(cells, ["daysofsupply", "daysofsupplyatamazonfulfillmentnetwork", "totaldaysofsupplyincludingunitsfromopenshipments"]),
      inbound: inParts > 0 ? inParts : numOf(cells, ["inbound", "inboundquantity"]),
      alert: get(cells, ["alert"]),
    });
  }
  return { rows, headers: rawHeaders };
}

// Download a completed report document (gzip TSV) and replace fba_inventory.
async function amzIngestReport(env, reportDocumentId, token) {
  const doc = await amzFetch(env, `/reports/2021-06-30/documents/${reportDocumentId}`, { token });
  const res = await fetch(doc.url);
  let text;
  if ((doc.compressionAlgorithm || "").toUpperCase() === "GZIP") {
    text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
  } else {
    text = await res.text();
  }
  const { rows, headers } = amzParseFbaReport(text);
  await amzState(env, "last_report_headers", headers.join(",").slice(0, 900));
  // Replace-all so SKUs that dropped off Amazon disappear from the cache too.
  await env.DB.prepare(`DELETE FROM fba_inventory`).run();
  for (let i = 0; i < rows.length; i += 40) {
    const batch = rows.slice(i, i + 40);
    await env.DB.batch(batch.map(r => env.DB.prepare(
      `INSERT OR REPLACE INTO fba_inventory (sku, name, asin, available, units_sold_30, days_of_supply, inbound, alert, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
    ).bind(r.sku, r.name, r.asin, r.available, r.unitsSold30, r.daysOfSupply, r.inbound, r.alert)));
  }
  return rows.length;
}

// Cron-safe state machine: poll a pending report, or request a new one when stale/manual.
async function syncAmazonFba(env) {
  if (!amzConfigured(env)) return { skipped: "not configured" };
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fba_inventory (sku TEXT PRIMARY KEY, name TEXT, asin TEXT, available INTEGER DEFAULT 0, units_sold_30 INTEGER DEFAULT 0, days_of_supply INTEGER DEFAULT 0, inbound INTEGER DEFAULT 0, alert TEXT, updated_at TEXT)`).run();
  try {
    const token = await amzAccessToken(env);
    const pendingId = await amzState(env, "pending_report_id");
    if (pendingId) {
      const rep = await amzFetch(env, `/reports/2021-06-30/reports/${pendingId}`, { token });
      const status = rep.processingStatus;
      if (status === "DONE") {
        const ingested = await amzIngestReport(env, rep.reportDocumentId, token);
        await amzState(env, "pending_report_id", null);
        await amzState(env, "last_synced_at", new Date().toISOString());
        await amzState(env, "last_error", null);
        return { done: true, ingested };
      }
      if (status === "CANCELLED" || status === "FATAL") {
        await amzState(env, "pending_report_id", null);
        await amzState(env, "last_error", `report ${status}`);
        return { failed: status };
      }
      return { pending: status }; // IN_QUEUE / IN_PROGRESS — wait for the next tick
    }
    const manual = await amzState(env, "sync_requested");
    const lastSynced = await amzState(env, "last_synced_at");
    const stale = !lastSynced || (Date.now() - new Date(lastSynced).getTime()) > 20 * 3600 * 1000;
    if (manual || stale) {
      const created = await amzFetch(env, "/reports/2021-06-30/reports", {
        method: "POST", token,
        body: { reportType: AMZ_FBA_REPORT_TYPE, marketplaceIds: [AMZ_MARKETPLACE_ID] },
      });
      if (created.reportId) {
        await amzState(env, "pending_report_id", created.reportId);
        await amzState(env, "pending_requested_at", new Date().toISOString());
        await amzState(env, "sync_requested", null);
      }
      return { created: created.reportId || null };
    }
    return { idle: true };
  } catch (e) {
    await amzState(env, "last_error", e.message.slice(0, 300));
    return { error: e.message };
  }
}

async function handleAmazonFbaAPI(request, env) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!amzConfigured(env)) return new Response(JSON.stringify({ success: false, error: "Amazon SP-API not configured" }), { status: 400, headers: cors });
  const url = new URL(request.url);
  if (url.searchParams.get("sync") === "1") {
    await amzState(env, "sync_requested", "1");
    const detail = await syncAmazonFba(env); // kick immediately; cron also advances it
    return new Response(JSON.stringify({ success: true, status: "requested", detail }), { headers: cors });
  }
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fba_inventory (sku TEXT PRIMARY KEY, name TEXT, asin TEXT, available INTEGER DEFAULT 0, units_sold_30 INTEGER DEFAULT 0, days_of_supply INTEGER DEFAULT 0, inbound INTEGER DEFAULT 0, alert TEXT, updated_at TEXT)`).run();
    const { results } = await env.DB.prepare(`SELECT * FROM fba_inventory ORDER BY sku`).all();
    const inventory = (results || []).map(r => ({
      sku: r.sku,
      name: r.name || r.sku,
      asin: r.asin || "",
      fbaQuantity: r.available || 0,
      fbaVelocity: r.units_sold_30 > 0 ? r.units_sold_30 / 30 : 0,
      fbaDaysOfSupply: r.days_of_supply || 0,
      fbaInbound: r.inbound || 0,
      fbaAlert: r.alert || "",
      fba30DaySales: r.units_sold_30 || 0,
      hasFba: true,
    }));
    return new Response(JSON.stringify({
      success: true,
      count: inventory.length,
      updated_at: await amzState(env, "last_synced_at"),
      pending: !!(await amzState(env, "pending_report_id")),
      last_error: await amzState(env, "last_error"),
      inventory,
    }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
  }
}

// ===== MEDICAL SUPPLIES API (D1-backed inventory + checkout ledger) =====
// Stock model: med_items.office_qty is the imported AppSheet baseline (immutable;
// NULL = never counted). All changes flow through med_moves (checkout -, receive +,
// adjust signed). remaining = COALESCE(office_qty,0) + SUM(qty_delta WHERE counted=1).
// Imported AppSheet history has counted=0 (the export's Office Qty already reflects it).
let medTablesReady = false;
async function ensureMedTables(env) {
  if (medTablesReady) return;
  // Safety net only — canonical DDL lives in tools/med-supplies/out/schema.sql (keep in sync).
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS med_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, dose TEXT, size TEXT,
      variant TEXT, sublocation TEXT, office_qty INTEGER, purchase_link TEXT,
      primary_image_key TEXT, alt_image_key TEXT, notes TEXT,
      order_status TEXT NOT NULL DEFAULT 'none', qty_to_order INTEGER, restock_level INTEGER,
      simulated_label TEXT, shared_supply INTEGER, archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS med_moves (
      id TEXT PRIMARY KEY, item_id TEXT, raw_item_ref TEXT, type TEXT NOT NULL,
      qty_delta INTEGER NOT NULL, counted INTEGER NOT NULL DEFAULT 1, user_name TEXT,
      video_name TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_med_moves_item ON med_moves(item_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_med_moves_created ON med_moves(created_at DESC)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS med_videos (name TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS med_categories (name TEXT PRIMARY KEY, icon TEXT, sort_order INTEGER DEFAULT 100)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS med_bags (
      video_name TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')), done_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS med_bag_items (
      video_name TEXT NOT NULL, item_id TEXT NOT NULL, qty_needed INTEGER NOT NULL DEFAULT 1,
      packed_move_id TEXT, qty_returned INTEGER, return_move_id TEXT,
      note TEXT, created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (video_name, item_id)
    )`),
  ]);
  medTablesReady = true;
}

// remaining-stock subquery shared by items list / shopping list / single-item reads
const MED_STOCK_SQL = `
  SELECT i.*,
         COALESCE(i.office_qty, 0) + COALESCE(m.delta, 0) AS remaining,
         CASE WHEN i.office_qty IS NULL AND m.delta IS NULL THEN 1 ELSE 0 END AS uncounted
  FROM med_items i
  LEFT JOIN (SELECT item_id, SUM(qty_delta) AS delta FROM med_moves WHERE counted = 1 GROUP BY item_id) m
    ON m.item_id = i.id
  WHERE i.archived = 0`;

const MED_IMG_CT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };

async function medItemWithStock(env, id) {
  return env.DB.prepare(`${MED_STOCK_SQL} AND i.id = ?`).bind(id).first();
}

async function handleMedSuppliesAPI(request, env, path) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  const ok = (data) => new Response(JSON.stringify({ success: true, data, ...(Array.isArray(data) ? { count: data.length } : {}) }), { headers: cors });
  const fail = (error, status = 400) => new Response(JSON.stringify({ success: false, error }), { status, headers: cors });

  try {
    await ensureMedTables(env);
    const method = request.method;
    const sub = path.slice("/med-supplies/api/".length);

    // ---- images (served through the Worker so they stay behind Cloudflare Access) ----
    if (sub.startsWith("img/") && method === "GET") {
      if (!env.MED_IMAGES) return fail("R2 not configured", 500);
      const key = decodeURIComponent(sub.slice(4));
      if (!key.startsWith("items/") || key.includes("..")) return fail("bad key");
      const obj = await env.MED_IMAGES.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      const ext = key.split(".").pop().toLowerCase();
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType || MED_IMG_CT[ext] || "application/octet-stream",
          // private: never let a shared cache hold images that Cloudflare Access protects
          "Cache-Control": "private, max-age=86400",
          ...(obj.httpEtag ? { ETag: obj.httpEtag } : {}),
        },
      });
    }
    const imgPut = sub.match(/^img\/items\/([^/]+)\/(primary|alt)$/);
    if (imgPut && method === "PUT") {
      if (!env.MED_IMAGES) return fail("R2 not configured", 500);
      const [, itemId, slot] = imgPut;
      const item = await env.DB.prepare("SELECT id FROM med_items WHERE id = ? AND archived = 0").bind(itemId).first();
      if (!item) return fail("item not found", 404);
      const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      const ext = Object.keys(MED_IMG_CT).find((e) => MED_IMG_CT[e] === ct);
      if (!ext) return fail("unsupported image content-type: " + ct);
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength === 0) return fail("empty body");
      if (bytes.byteLength > 8 * 1024 * 1024) return fail("image too large (8MB max)", 413);
      // timestamped key so the browser's cached old image self-heals on replace
      const key = `items/${itemId}-${slot}-${Date.now()}.${ext}`;
      await env.MED_IMAGES.put(key, bytes, { httpMetadata: { contentType: ct } });
      await env.DB.prepare(`UPDATE med_items SET ${slot === "primary" ? "primary_image_key" : "alt_image_key"} = ?, updated_at = datetime('now') WHERE id = ?`).bind(key, itemId).run();
      return ok({ key });
    }

    // ---- items ----
    if (sub === "items" && method === "GET") {
      const { results } = await env.DB.prepare(`${MED_STOCK_SQL} ORDER BY i.name COLLATE NOCASE`).all();
      return ok(results);
    }
    if (sub === "items" && method === "POST") {
      const b = await request.json();
      if (!b.name || !String(b.name).trim()) return fail("name is required");
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO med_items
        (id, name, category, dose, size, variant, sublocation, office_qty, purchase_link, notes,
         order_status, qty_to_order, restock_level, simulated_label, shared_supply)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, String(b.name).trim(), b.category ?? null, b.dose ?? null, b.size ?? null,
          b.variant ?? null, b.sublocation ?? null,
          Number.isInteger(b.office_qty) ? b.office_qty : null, // initial count — only settable at creation
          b.purchase_link ?? null, b.notes ?? null,
          ["none", "to_order", "ordered"].includes(b.order_status) ? b.order_status : "none",
          Number.isInteger(b.qty_to_order) ? b.qty_to_order : null,
          Number.isInteger(b.restock_level) ? b.restock_level : null,
          b.simulated_label ?? null, [0, 1].includes(b.shared_supply) ? b.shared_supply : null)
        .run();
      return ok(await medItemWithStock(env, id));
    }
    const itemMatch = sub.match(/^items\/([^/]+)$/);
    if (itemMatch && method === "PUT") {
      const b = await request.json();
      if ("office_qty" in b) return fail("office_qty is immutable — use /adjust to recount");
      const FIELDS = ["name", "category", "dose", "size", "variant", "sublocation", "purchase_link",
        "notes", "order_status", "qty_to_order", "restock_level", "simulated_label", "shared_supply"];
      const sets = [], vals = [];
      for (const f of FIELDS) {
        if (!(f in b)) continue;
        if (f === "name" && !String(b.name || "").trim()) return fail("name cannot be empty");
        if (f === "order_status" && !["none", "to_order", "ordered"].includes(b.order_status)) return fail("bad order_status");
        sets.push(`${f} = ?`); vals.push(b[f] === "" ? null : b[f]);
      }
      if (!sets.length) return fail("no editable fields in body");
      const r = await env.DB.prepare(`UPDATE med_items SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? AND archived = 0`)
        .bind(...vals, itemMatch[1]).run();
      if (!r.meta.changes) return fail("item not found", 404);
      return ok(await medItemWithStock(env, itemMatch[1]));
    }
    if (itemMatch && method === "DELETE") {
      const r = await env.DB.prepare("UPDATE med_items SET archived = 1, updated_at = datetime('now') WHERE id = ? AND archived = 0").bind(itemMatch[1]).run();
      if (!r.meta.changes) return fail("item not found", 404);
      return ok({ archived: itemMatch[1] });
    }

    // ---- stock moves ----
    if ((sub === "checkout" || sub === "receive") && method === "POST") {
      const b = await request.json();
      const qty = b.qty;
      if (!Number.isInteger(qty) || qty <= 0) return fail("qty must be a positive integer");
      const item = await env.DB.prepare("SELECT id FROM med_items WHERE id = ? AND archived = 0").bind(b.item_id || "").first();
      if (!item) return fail("item not found", 404);
      const id = crypto.randomUUID();
      const delta = sub === "checkout" ? -qty : qty;
      const stmts = [
        env.DB.prepare(`INSERT INTO med_moves (id, item_id, type, qty_delta, user_name, video_name, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, b.item_id, sub, delta, b.user_name ?? null, b.video_name?.trim() || null, b.note ?? null),
      ];
      if (sub === "checkout" && b.video_name?.trim()) {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO med_videos (name) VALUES (?)").bind(b.video_name.trim()));
      }
      if (sub === "receive") {
        stmts.push(env.DB.prepare("UPDATE med_items SET order_status = 'none', qty_to_order = NULL, updated_at = datetime('now') WHERE id = ?").bind(b.item_id));
      }
      await env.DB.batch(stmts);
      return ok({ move_id: id, item: await medItemWithStock(env, b.item_id) });
    }
    if (sub === "adjust" && method === "POST") {
      const b = await request.json();
      if (!Number.isInteger(b.new_total) || b.new_total < 0) return fail("new_total must be a non-negative integer");
      const item = await medItemWithStock(env, b.item_id || "");
      if (!item) return fail("item not found", 404);
      const delta = b.new_total - item.remaining;
      if (delta === 0) return ok({ move_id: null, item });
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO med_moves (id, item_id, type, qty_delta, user_name, note) VALUES (?, ?, 'adjust', ?, ?, ?)`)
        .bind(id, b.item_id, delta, b.user_name ?? null, b.note ?? null).run();
      return ok({ move_id: id, item: await medItemWithStock(env, b.item_id) });
    }
    if (sub.startsWith("moves") && method === "GET") {
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);
      const itemId = url.searchParams.get("item_id");
      const { results } = await env.DB.prepare(`
        SELECT m.*, i.name AS item_name FROM med_moves m LEFT JOIN med_items i ON i.id = m.item_id
        ${itemId ? "WHERE m.item_id = ?1" : ""} ORDER BY m.created_at DESC, m.id LIMIT ${limit}`)
        .bind(...(itemId ? [itemId] : [])).all();
      return ok(results);
    }
    const moveMatch = sub.match(/^moves\/([^/]+)$/);
    if (moveMatch && method === "DELETE") {
      // undo a mistaken move — imported AppSheet history (counted=0) is read-only
      const r = await env.DB.prepare("DELETE FROM med_moves WHERE id = ? AND counted = 1").bind(moveMatch[1]).run();
      if (!r.meta.changes) return fail("move not found (legacy history can't be deleted)", 404);
      return ok({ deleted: moveMatch[1] });
    }

    // ---- video bags (sim-lab packing lists) ----
    if (sub === "bags" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM med_bags ORDER BY video_name DESC").all();
      return ok(results);
    }
    const bagAction = sub.match(/^bags\/(.+)\/(return|reopen)$/);
    if (bagAction && method === "POST") {
      const video = decodeURIComponent(bagAction[1]);
      const bag = await env.DB.prepare("SELECT * FROM med_bags WHERE video_name = ?").bind(video).first();
      if (!bag) return fail("bag not found", 404);
      if (bagAction[2] === "reopen") {
        await env.DB.prepare("UPDATE med_bags SET status = 'active', done_at = NULL WHERE video_name = ?").bind(video).run();
        return ok({ status: "active" });
      }
      // return: restock what came back; consumption = packed - returned
      if (bag.status === "done") return fail("bag already returned");
      const b = await request.json();
      const returns = new Map((b.returns || []).map((r) => [r.item_id, r.qty_returned]));
      const { results: lines } = await env.DB.prepare(
        "SELECT * FROM med_bag_items WHERE video_name = ? AND packed_move_id IS NOT NULL AND return_move_id IS NULL")
        .bind(video).all();
      const stmts = [];
      let returned = 0, consumed = 0;
      for (const line of lines) {
        let qty = returns.has(line.item_id) ? returns.get(line.item_id) : line.qty_needed;
        if (!Number.isInteger(qty)) qty = 0;
        qty = Math.max(0, Math.min(qty, line.qty_needed));
        returned += qty; consumed += line.qty_needed - qty;
        let moveId = null;
        if (qty > 0) {
          moveId = crypto.randomUUID();
          stmts.push(env.DB.prepare(`INSERT INTO med_moves (id, item_id, type, qty_delta, user_name, video_name, note)
            VALUES (?, ?, 'return', ?, ?, ?, 'returned from bag')`)
            .bind(moveId, line.item_id, qty, b.user_name ?? null, video));
        }
        stmts.push(env.DB.prepare("UPDATE med_bag_items SET qty_returned = ?, return_move_id = ? WHERE video_name = ? AND item_id = ?")
          .bind(qty, moveId, video, line.item_id));
      }
      stmts.push(env.DB.prepare("UPDATE med_bags SET status = 'done', done_at = datetime('now') WHERE video_name = ?").bind(video));
      await env.DB.batch(stmts);
      return ok({ status: "done", returned, consumed });
    }
    if (sub === "bag-items" && method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT b.*, i.name AS item_name FROM med_bag_items b
        LEFT JOIN med_items i ON i.id = b.item_id
        ORDER BY b.video_name DESC, i.name COLLATE NOCASE`).all();
      return ok(results);
    }
    if (sub === "bag-items" && method === "POST") {
      const b = await request.json();
      const video = (b.video_name || "").trim();
      if (!video) return fail("video_name is required");
      const qty = Number.isInteger(b.qty_needed) && b.qty_needed > 0 ? b.qty_needed : 1;
      const item = await env.DB.prepare("SELECT id FROM med_items WHERE id = ? AND archived = 0").bind(b.item_id || "").first();
      if (!item) return fail("item not found", 404);
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO med_videos (name) VALUES (?)").bind(video),
        env.DB.prepare("INSERT OR IGNORE INTO med_bags (video_name) VALUES (?)").bind(video),
        env.DB.prepare("UPDATE med_bags SET status = 'active', done_at = NULL WHERE video_name = ?").bind(video),
        env.DB.prepare(`INSERT INTO med_bag_items (video_name, item_id, qty_needed, note) VALUES (?, ?, ?, ?)
          ON CONFLICT(video_name, item_id) DO UPDATE SET qty_needed = excluded.qty_needed, note = COALESCE(excluded.note, note)`)
          .bind(video, b.item_id, qty, b.note ?? null),
      ]);
      return ok({ video_name: video, item_id: b.item_id, qty_needed: qty });
    }
    if (sub === "bag-items" && method === "PUT") {
      const b = await request.json();
      if (!Number.isInteger(b.qty_needed) || b.qty_needed <= 0) return fail("qty_needed must be a positive integer");
      const r = await env.DB.prepare("UPDATE med_bag_items SET qty_needed = ? WHERE video_name = ? AND item_id = ?")
        .bind(b.qty_needed, b.video_name || "", b.item_id || "").run();
      if (!r.meta.changes) return fail("bag line not found", 404);
      return ok({ updated: true });
    }
    if (sub === "bag-items" && method === "DELETE") {
      const url = new URL(request.url);
      const r = await env.DB.prepare("DELETE FROM med_bag_items WHERE video_name = ? AND item_id = ?")
        .bind(url.searchParams.get("video_name") || "", url.searchParams.get("item_id") || "").run();
      if (!r.meta.changes) return fail("bag line not found", 404);
      return ok({ deleted: true });
    }
    if (sub === "bag-items/pack" && method === "POST") {
      // packing = a real checkout against the video, so stock + activity stay true
      const b = await request.json();
      const line = await env.DB.prepare("SELECT * FROM med_bag_items WHERE video_name = ? AND item_id = ?")
        .bind(b.video_name || "", b.item_id || "").first();
      if (!line) return fail("bag line not found", 404);
      if (line.packed_move_id) return fail("already packed");
      const moveId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO med_moves (id, item_id, type, qty_delta, user_name, video_name, note)
          VALUES (?, ?, 'checkout', ?, ?, ?, 'packed for bag')`)
          .bind(moveId, line.item_id, -line.qty_needed, b.user_name ?? null, line.video_name),
        env.DB.prepare("UPDATE med_bag_items SET packed_move_id = ? WHERE video_name = ? AND item_id = ?")
          .bind(moveId, line.video_name, line.item_id),
      ]);
      return ok({ packed_move_id: moveId, item: await medItemWithStock(env, line.item_id) });
    }
    if (sub === "bag-items/unpack" && method === "POST") {
      const b = await request.json();
      const line = await env.DB.prepare("SELECT * FROM med_bag_items WHERE video_name = ? AND item_id = ?")
        .bind(b.video_name || "", b.item_id || "").first();
      if (!line) return fail("bag line not found", 404);
      if (!line.packed_move_id) return fail("not packed");
      if (line.return_move_id) return fail("bag already returned — reopen it first");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM med_moves WHERE id = ? AND counted = 1").bind(line.packed_move_id),
        env.DB.prepare("UPDATE med_bag_items SET packed_move_id = NULL WHERE video_name = ? AND item_id = ?")
          .bind(line.video_name, line.item_id),
      ]);
      return ok({ unpacked: true, item: await medItemWithStock(env, line.item_id) });
    }
    const bagMatch = sub.match(/^bags\/(.+)$/);
    if (bagMatch && method === "DELETE") {
      const video = decodeURIComponent(bagMatch[1]);
      const [r] = await env.DB.batch([
        env.DB.prepare("DELETE FROM med_bag_items WHERE video_name = ?").bind(video),
        env.DB.prepare("DELETE FROM med_bags WHERE video_name = ?").bind(video),
      ]);
      return ok({ deleted_lines: r.meta.changes });
    }

    // ---- lists ----
    if (sub === "shopping-list" && method === "GET") {
      const { results } = await env.DB.prepare(`
        WITH stock AS (${MED_STOCK_SQL})
        SELECT * FROM stock
        WHERE order_status IN ('to_order','ordered')
           OR COALESCE(qty_to_order, 0) > 0
           OR (restock_level IS NOT NULL AND remaining <= restock_level)
        ORDER BY CASE order_status WHEN 'to_order' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, name COLLATE NOCASE`).all();
      return ok(results);
    }
    if (sub === "videos" && method === "GET") {
      // names start with "YYYY.NNN - …" so DESC ≈ newest first
      const { results } = await env.DB.prepare("SELECT name FROM med_videos ORDER BY name DESC").all();
      return ok(results.map((r) => r.name));
    }
    if (sub === "categories" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT name, icon FROM med_categories ORDER BY sort_order, name").all();
      return ok(results);
    }
    if (sub === "me" && method === "GET") {
      return ok({ email: request.headers.get("Cf-Access-Authenticated-User-Email") || null });
    }

    return fail("not found", 404);
  } catch (e) {
    return fail(e.message, 500);
  }
}

// ===== 3PL API (D1-backed) =====
async function handle3plAPI(request, env, path) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  // Auto-create table
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tpl_orders (
    shipment_id TEXT PRIMARY KEY,
    order_number TEXT,
    ship_date TEXT,
    order_date TEXT,
    carrier_delivery_date TEXT,
    carrier TEXT,
    service TEXT,
    carrier_status TEXT,
    zone TEXT,
    state TEXT,
    country TEXT,
    num_products INTEGER DEFAULT 0,
    shipping_cost REAL DEFAULT 0,
    base_price REAL DEFAULT 0,
    residential_fee REAL DEFAULT 0,
    das_fee REAL DEFAULT 0,
    peak_fee REAL DEFAULT 0,
    fuel_fee REAL DEFAULT 0,
    services_cost REAL DEFAULT 0,
    packaging_cost REAL DEFAULT 0,
    first_pick_fee REAL DEFAULT 0,
    additional_pick_fee REAL DEFAULT 0,
    insert_pick_fee REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();

  // Order lifecycle timestamps from the ShipMonk orders CSV export (the API
  // doesn't expose submit/deliver timestamps). Keyed by Order Key, separate
  // from tpl_orders (API sync, keyed by shipment_id) so neither clobbers the other.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tpl_order_phases (
      order_key TEXT PRIMARY KEY,
      order_number TEXT,
      order_status TEXT,
      shipping_status TEXT,
      shipping_method TEXT,
      warehouse TEXT,
      store TEXT,
      country TEXT,
      state TEXT,
      shipping_zone TEXT,
      ordered_at TEXT,
      submitted_at TEXT,
      shipped_at TEXT,
      delivered_at TEXT,
      tracking_number TEXT,
      item_quantity INTEGER DEFAULT 0,
      weight_oz REAL DEFAULT 0,
      order_total REAL DEFAULT 0,
      shipping_cost REAL DEFAULT 0,
      packaging_cost REAL DEFAULT 0,
      pick_pack_cost REAL DEFAULT 0,
      customer_shipping_paid REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tpl_sla_targets (
      shipping_method TEXT PRIMARY KEY,
      transit_business_days REAL NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`INSERT OR IGNORE INTO tpl_sla_targets (shipping_method, transit_business_days) VALUES
      ('ShipMonk 2 Day', 2),
      ('UPS Next Day Air (by 10:30 AM next day)', 1),
      ('UPS 2nd Day Air (by end of the day in two days)', 2),
      ('ShipMonk Economy', 5),
      ('ShipMonk Standard', 5),
      ('USPS Priority Mail', 3),
      ('Passport Priority DDP', 12)`),
  ]);

  // GET /3pl/api/phases — all order lifecycle rows
  if (path === "/3pl/api/phases" && request.method === "GET") {
    try {
      const { results } = await env.DB.prepare("SELECT * FROM tpl_order_phases ORDER BY ordered_at DESC").all();
      return new Response(JSON.stringify({ success: true, data: results, count: results.length }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  // POST /3pl/api/phases — upsert CSV-imported orders by order_key
  if (path === "/3pl/api/phases" && request.method === "POST") {
    try {
      const body = await request.json();
      const orders = body.orders || [];
      if (orders.length === 0) return new Response(JSON.stringify({ success: true, received: 0 }), { headers: cors });

      const batchSize = 25;
      for (let i = 0; i < orders.length; i += batchSize) {
        const batch = orders.slice(i, i + batchSize);
        const stmts = batch.map(o => env.DB.prepare(`INSERT INTO tpl_order_phases (
            order_key, order_number, order_status, shipping_status, shipping_method,
            warehouse, store, country, state, shipping_zone,
            ordered_at, submitted_at, shipped_at, delivered_at, tracking_number,
            item_quantity, weight_oz, order_total, shipping_cost, packaging_cost,
            pick_pack_cost, customer_shipping_paid, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(order_key) DO UPDATE SET
            order_number=excluded.order_number, order_status=excluded.order_status,
            shipping_status=excluded.shipping_status, shipping_method=excluded.shipping_method,
            warehouse=excluded.warehouse, store=excluded.store, country=excluded.country,
            state=excluded.state, shipping_zone=excluded.shipping_zone,
            ordered_at=excluded.ordered_at, submitted_at=excluded.submitted_at,
            shipped_at=excluded.shipped_at, delivered_at=excluded.delivered_at,
            tracking_number=excluded.tracking_number, item_quantity=excluded.item_quantity,
            weight_oz=excluded.weight_oz, order_total=excluded.order_total,
            shipping_cost=excluded.shipping_cost, packaging_cost=excluded.packaging_cost,
            pick_pack_cost=excluded.pick_pack_cost, customer_shipping_paid=excluded.customer_shipping_paid,
            updated_at=datetime('now')
          `).bind(
            o.orderKey, o.orderNumber, o.orderStatus, o.shippingStatus, o.shippingMethod,
            o.warehouse, o.store, o.country, o.state, o.shippingZone,
            o.orderedAt, o.submittedAt, o.shippedAt, o.deliveredAt, o.trackingNumber,
            o.itemQuantity || 0, o.weightOz || 0, o.orderTotal || 0, o.shippingCost || 0,
            o.packagingCost || 0, o.pickPackCost || 0, o.customerShippingPaid || 0
          ));
        await env.DB.batch(stmts);
      }
      return new Response(JSON.stringify({ success: true, received: orders.length }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  // DELETE /3pl/api/phases — clear phase data only (leaves tpl_orders intact)
  if (path === "/3pl/api/phases" && request.method === "DELETE") {
    try {
      await env.DB.prepare("DELETE FROM tpl_order_phases").run();
      return new Response(JSON.stringify({ success: true }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  // GET /3pl/api/sla-targets — transit-day targets per shipping method
  if (path === "/3pl/api/sla-targets" && request.method === "GET") {
    try {
      const { results } = await env.DB.prepare("SELECT * FROM tpl_sla_targets ORDER BY shipping_method").all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  // POST /3pl/api/sla-targets — upsert targets
  if (path === "/3pl/api/sla-targets" && request.method === "POST") {
    try {
      const body = await request.json();
      const targets = body.targets || [];
      const stmts = targets
        .filter(t => t.shippingMethod && Number.isFinite(Number(t.transitBusinessDays)))
        .map(t => env.DB.prepare(`INSERT INTO tpl_sla_targets (shipping_method, transit_business_days, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(shipping_method) DO UPDATE SET
            transit_business_days=excluded.transit_business_days, updated_at=datetime('now')`)
          .bind(t.shippingMethod, Number(t.transitBusinessDays)));
      if (stmts.length) await env.DB.batch(stmts);
      return new Response(JSON.stringify({ success: true, saved: stmts.length }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  // GET /3pl/api/orders — return all orders
  if (path === "/3pl/api/orders" && request.method === "GET") {
    try {
      const { results } = await env.DB.prepare("SELECT * FROM tpl_orders ORDER BY ship_date DESC").all();
      return new Response(JSON.stringify({ success: true, data: results, count: results.length }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  // POST /3pl/api/orders — upsert orders
  if (path === "/3pl/api/orders" && request.method === "POST") {
    try {
      const body = await request.json();
      const orders = body.orders || [];
      if (orders.length === 0) return new Response(JSON.stringify({ success: true, added: 0, updated: 0 }), { headers: cors });

      let added = 0, updated = 0;
      const batchSize = 25;
      for (let i = 0; i < orders.length; i += batchSize) {
        const batch = orders.slice(i, i + batchSize);
        const stmts = batch.map(o => {
          return env.DB.prepare(`INSERT INTO tpl_orders (shipment_id, order_number, ship_date, order_date, carrier_delivery_date, carrier, service, carrier_status, zone, state, country, num_products, shipping_cost, base_price, residential_fee, das_fee, peak_fee, fuel_fee, services_cost, packaging_cost, first_pick_fee, additional_pick_fee, insert_pick_fee, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(shipment_id) DO UPDATE SET
              order_number=excluded.order_number, ship_date=excluded.ship_date, order_date=excluded.order_date,
              carrier_delivery_date=excluded.carrier_delivery_date, carrier=excluded.carrier, service=excluded.service,
              carrier_status=excluded.carrier_status, zone=excluded.zone, state=excluded.state, country=excluded.country,
              num_products=excluded.num_products, shipping_cost=excluded.shipping_cost, base_price=excluded.base_price,
              residential_fee=excluded.residential_fee, das_fee=excluded.das_fee, peak_fee=excluded.peak_fee,
              fuel_fee=excluded.fuel_fee, services_cost=excluded.services_cost, packaging_cost=excluded.packaging_cost,
              first_pick_fee=excluded.first_pick_fee, additional_pick_fee=excluded.additional_pick_fee,
              insert_pick_fee=excluded.insert_pick_fee, updated_at=datetime('now')
          `).bind(
            o.shipmentId, o.orderNumber, o.shipDate, o.orderDate, o.carrierDeliveryDate,
            o.carrier, o.service, o.carrierStatus, o.zone, o.state, o.country,
            o.numProducts || 0, o.shippingCost || 0, o.basePrice || 0,
            o.residentialFee || 0, o.dasFee || 0, o.peakFee || 0, o.fuelFee || 0,
            o.servicesCost || 0, o.packagingCost || 0, o.firstPickFee || 0,
            o.additionalPickFee || 0, o.insertPickFee || 0
          );
        });
        await env.DB.batch(stmts);
        added += batch.length; // Simplified — D1 upsert doesn't easily distinguish
      }
      return new Response(JSON.stringify({ success: true, added, updated: 0 }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  // DELETE /3pl/api/orders — clear all
  if (path === "/3pl/api/orders" && request.method === "DELETE") {
    try {
      await env.DB.prepare("DELETE FROM tpl_orders").run();
      return new Response(JSON.stringify({ success: true }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
}

// ===== CONTENT TRACKER API (D1-backed) =====
async function initTrackerTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_posts (
      id INTEGER PRIMARY KEY, date TEXT, caption TEXT, media_type TEXT, ig_url TEXT,
      engagement_rate REAL DEFAULT 0, views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0, shares INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
      auto_content_type TEXT DEFAULT ''
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_daily (
      date TEXT PRIMARY KEY, orders INTEGER DEFAULT 0, revenue REAL DEFAULT 0,
      lt_views INTEGER DEFAULT 0, lt_clicks INTEGER DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_overrides (
      post_id INTEGER PRIMARY KEY, content_type TEXT, intent TEXT,
      reviewed INTEGER DEFAULT 0, last_edited TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_sale_days (date TEXT PRIMARY KEY)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_clickup_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, task_id TEXT, task_name TEXT,
      content_type TEXT, UNIQUE(date, task_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_settings (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, weights TEXT, caps TEXT
    )`),
  ]);
}

async function handleTrackerAPI(request, env) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  const db = env.DB;
  await initTrackerTables(db);

  // GET — assemble the full blob from D1 tables
  if (request.method === "GET") {
    try {
      const [postsR, dailyR, overridesR, saleDaysR, clickupR, settingsR, presetsR] = await db.batch([
        db.prepare("SELECT * FROM tracker_posts ORDER BY date DESC"),
        db.prepare("SELECT * FROM tracker_daily ORDER BY date ASC"),
        db.prepare("SELECT * FROM tracker_overrides"),
        db.prepare("SELECT date FROM tracker_sale_days ORDER BY date ASC"),
        db.prepare("SELECT * FROM tracker_clickup_tasks ORDER BY date ASC"),
        db.prepare("SELECT key, value FROM tracker_settings"),
        db.prepare("SELECT name, weights, caps FROM tracker_presets ORDER BY id ASC"),
      ]);

      const posts = postsR.results || [];
      const daily = (dailyR.results || []).map(d => ({ ...d, lt_views: d.lt_views || 0, lt_clicks: d.lt_clicks || 0 }));

      // Rebuild overrides as { postId: { content_type, intent, reviewed, lastEdited } }
      const overrides = {};
      for (const row of (overridesR.results || [])) {
        overrides[row.post_id] = { content_type: row.content_type || '', intent: row.intent || '', reviewed: !!row.reviewed, lastEdited: row.last_edited || '' };
      }

      const saleDays = (saleDaysR.results || []).map(r => r.date);

      // Rebuild clickupMap as { date: [{ taskId, taskName, contentType }] }
      const clickupMap = {};
      for (const row of (clickupR.results || [])) {
        if (!clickupMap[row.date]) clickupMap[row.date] = [];
        clickupMap[row.date].push({ taskId: row.task_id, taskName: row.task_name, contentType: row.content_type });
      }

      // Rebuild settings
      const settingsMap = {};
      for (const row of (settingsR.results || [])) {
        try { settingsMap[row.key] = JSON.parse(row.value); } catch { settingsMap[row.key] = row.value; }
      }

      // Rebuild presets
      const presets = (presetsR.results || []).map(r => {
        try { return { name: r.name, weights: JSON.parse(r.weights), caps: JSON.parse(r.caps), builtIn: false }; }
        catch { return null; }
      }).filter(Boolean);

      const result = {
        posts,
        daily,
        overrides,
        saleDays,
        caps: settingsMap.caps || null,
        weights: settingsMap.weights || null,
        ltMax: settingsMap.ltMax ?? null,
        ltMid: settingsMap.ltMid ?? null,
        clickupMap,
        goals: settingsMap.goals || null,
        sheetData: settingsMap.sheetData || null,
        sheetName: settingsMap.sheetName || '',
        percentileMode: settingsMap.percentileMode || false,
        presets,
      };

      return new Response(JSON.stringify(result), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  // POST — decompose the blob into D1 tables
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const { posts, daily, overrides, saleDays, caps, weights, ltMax, ltMid, clickupMap, goals, sheetData, sheetName, percentileMode, presets } = body;

      // Clear all tracker tables
      await db.batch([
        db.prepare("DELETE FROM tracker_posts"),
        db.prepare("DELETE FROM tracker_daily"),
        db.prepare("DELETE FROM tracker_overrides"),
        db.prepare("DELETE FROM tracker_sale_days"),
        db.prepare("DELETE FROM tracker_clickup_tasks"),
        db.prepare("DELETE FROM tracker_presets"),
      ]);

      // Insert posts in batches of 50
      if (posts && posts.length) {
        for (let i = 0; i < posts.length; i += 50) {
          const batch = posts.slice(i, i + 50);
          await db.batch(batch.map(p =>
            db.prepare("INSERT INTO tracker_posts (id, date, caption, media_type, ig_url, engagement_rate, views, likes, saves, shares, comments, auto_content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(p.id, p.date, p.caption || '', p.media_type || '', p.ig_url || '', p.engagement_rate || 0, p.views || 0, p.likes || 0, p.saves || 0, p.shares || 0, p.comments || 0, p.auto_content_type || '')
          ));
        }
      }

      // Insert daily in batches of 50
      if (daily && daily.length) {
        for (let i = 0; i < daily.length; i += 50) {
          const batch = daily.slice(i, i + 50);
          await db.batch(batch.map(d =>
            db.prepare("INSERT INTO tracker_daily (date, orders, revenue, lt_views, lt_clicks) VALUES (?, ?, ?, ?, ?)")
              .bind(d.date, d.orders || 0, d.revenue || 0, d.lt_views || 0, d.lt_clicks || 0)
          ));
        }
      }

      // Insert overrides
      if (overrides && Object.keys(overrides).length) {
        const ovEntries = Object.entries(overrides);
        for (let i = 0; i < ovEntries.length; i += 50) {
          const batch = ovEntries.slice(i, i + 50);
          await db.batch(batch.map(([pid, ov]) =>
            db.prepare("INSERT INTO tracker_overrides (post_id, content_type, intent, reviewed, last_edited) VALUES (?, ?, ?, ?, ?)")
              .bind(parseInt(pid), ov.content_type || '', ov.intent || '', ov.reviewed ? 1 : 0, ov.lastEdited || ov.last_edited || '')
          ));
        }
      }

      // Insert sale days
      if (saleDays && saleDays.length) {
        for (let i = 0; i < saleDays.length; i += 50) {
          const batch = saleDays.slice(i, i + 50);
          await db.batch(batch.map(d =>
            db.prepare("INSERT INTO tracker_sale_days (date) VALUES (?)").bind(d)
          ));
        }
      }

      // Insert clickup tasks
      if (clickupMap && Object.keys(clickupMap).length) {
        const cuRows = [];
        for (const [date, tasks] of Object.entries(clickupMap)) {
          for (const t of tasks) {
            cuRows.push({ date, task_id: t.taskId, task_name: t.taskName, content_type: t.contentType });
          }
        }
        for (let i = 0; i < cuRows.length; i += 50) {
          const batch = cuRows.slice(i, i + 50);
          await db.batch(batch.map(r =>
            db.prepare("INSERT OR IGNORE INTO tracker_clickup_tasks (date, task_id, task_name, content_type) VALUES (?, ?, ?, ?)")
              .bind(r.date, r.task_id, r.task_name, r.content_type)
          ));
        }
      }

      // Upsert settings
      const settingsStmts = [];
      if (caps) settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('caps', JSON.stringify(caps)));
      if (weights) settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('weights', JSON.stringify(weights)));
      if (ltMax !== undefined && ltMax !== null) settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('ltMax', JSON.stringify(ltMax)));
      if (ltMid !== undefined && ltMid !== null) settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('ltMid', JSON.stringify(ltMid)));
      if (goals) settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('goals', JSON.stringify(goals)));
      if (sheetData) settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('sheetData', JSON.stringify(sheetData)));
      if (sheetName !== undefined) settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('sheetName', JSON.stringify(sheetName)));
      settingsStmts.push(db.prepare("INSERT OR REPLACE INTO tracker_settings (key, value) VALUES (?, ?)").bind('percentileMode', JSON.stringify(!!percentileMode)));
      if (settingsStmts.length) await db.batch(settingsStmts);

      // Insert custom presets
      if (presets && presets.length) {
        const customPresets = presets.filter(p => !p.builtIn);
        if (customPresets.length) {
          await db.batch(customPresets.map(p =>
            db.prepare("INSERT INTO tracker_presets (name, weights, caps) VALUES (?, ?, ?)")
              .bind(p.name, JSON.stringify(p.weights), JSON.stringify(p.caps))
          ));
        }
      }

      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
}

// ===== CX AGENT =====
// Handles Zendesk webhooks, classifies intent, drafts responses
// All tables live in the CX_AGENT_DB binding (separate D1 from the main Ops Hub DB)

async function initCxAgentTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zendesk_ticket_id TEXT NOT NULL UNIQUE,
      subject TEXT, customer_email TEXT, channel TEXT, first_customer_message TEXT,
      classified_intent TEXT, intent_confidence REAL, is_in_scope INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'received', final_action TEXT,
      received_at TEXT DEFAULT (datetime('now')), completed_at TEXT, error_message TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
      step_name TEXT NOT NULL, step_order INTEGER NOT NULL,
      input_data TEXT, output_data TEXT, reasoning TEXT,
      duration_ms INTEGER, tokens_used INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
      status TEXT DEFAULT 'success', error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
      draft_body TEXT NOT NULL, response_confidence REAL, reasoning TEXT, data_sources TEXT,
      status TEXT DEFAULT 'draft', posted_to_zendesk_at TEXT,
      reviewed_by TEXT, reviewed_at TEXT, final_body TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, value_type TEXT NOT NULL DEFAULT 'string',
      description TEXT, updated_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, intent TEXT NOT NULL, name TEXT NOT NULL,
      body TEXT NOT NULL, variables TEXT, is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_human_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      zendesk_ticket_id TEXT NOT NULL,
      zendesk_comment_id TEXT,
      author_id TEXT,
      author_name TEXT,
      body TEXT,
      reply_created_at TEXT,
      captured_at TEXT DEFAULT (datetime('now')),
      source TEXT DEFAULT 'auto',
      rating TEXT,
      rating_note TEXT,
      rated_by TEXT,
      rated_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_human_replies_ticket ON agent_human_replies(ticket_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_human_replies_comment ON agent_human_replies(zendesk_comment_id)`),
    // v4.7: product knowledge base. Stores an IP-safe COVERAGE MAP per product (what
    // topics are covered, chapter/topic level) — never the actual study content — so the
    // drafter can answer "do your materials cover X?" without leaking IP.
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT,
      description TEXT,
      coverage_outline TEXT,
      topics TEXT,
      source_filename TEXT,
      version TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    // v4.9: background product-extraction jobs. The browser splits a PDF into chunk PDFs
    // (stored in R2 under job/<id>/chunk/<n>.pdf); the cron reads each chunk via Claude
    // native PDF, accumulates partials, merges, and saves the product — fully hands-off.
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_product_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_filename TEXT,
      total_chunks INTEGER NOT NULL,
      done_chunks INTEGER DEFAULT 0,
      total_pages INTEGER,
      status TEXT NOT NULL DEFAULT 'uploading',
      partials TEXT DEFAULT '[]',
      topics TEXT DEFAULT '[]',
      product_id INTEGER,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
  ]);

  const existing = await db.prepare("SELECT COUNT(*) as c FROM agent_config").first();
  if (existing.c === 0) {
    await db.batch([
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('agent_enabled', 'true', 'boolean', 'Master switch'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('mode', 'internal_note', 'string', 'internal_note | auto_reply'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('min_confidence_to_respond', '0.75', 'number', 'Min intent classification confidence'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('min_confidence_to_auto_reply', '0.90', 'number', 'Min confidence to auto-reply (when mode=auto_reply)'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('scoped_intents', '["digital_access"]', 'json', 'Intents the agent will handle'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('hard_escalate_topics', '["education_content","clinical_question","partnership","refund_over_50"]', 'json', 'Topics that always escalate'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('shopify_store_domain', 'nurseinthemaking.myshopify.com', 'string', 'Shopify store domain'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('zendesk_subdomain', 'nurseinthemaking', 'string', 'Zendesk subdomain'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('n8n_code_generation_webhook', 'https://nurseinthemaking.app.n8n.cloud/webhook/shopify-order-paid', 'string', 'n8n webhook for code regeneration'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('anthropic_model', 'claude-opus-4-8', 'string', 'Claude model for drafting/escalation'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('classifier_model', 'claude-haiku-4-5-20251001', 'string', 'Cheaper/faster Claude model for intent classification'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('support_staff_ids', '[29324864593179,16129176780315,32863955019931,14117981153307]', 'json', 'Zendesk support staff IDs'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('max_order_age_days', '90', 'number', 'Max age (days) of orders the agent will auto-respond about'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('require_email_match', 'true', 'boolean', 'If true, require Zendesk email matches Shopify order email (unless order number in ticket)'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('suggested_intents', '["product_info","shipping_delivery","education_content","order_general","returns_damaged","billing_payment","account","refund_cancel","social_engagement"]', 'json', 'Intents where agent drafts AI suggestions (vs specialized handler)'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('noise_suggestion_enabled', 'true', 'boolean', 'For noise-classified tickets, post a close-recommendation note'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('help_center_enabled', 'true', 'boolean', 'Query Zendesk Help Center for article context when drafting suggestions'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('help_center_max_articles', '3', 'number', 'Max articles to include as context per suggestion'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('apply_zendesk_tags', 'true', 'boolean', 'Apply ai-processed, ai-drafted, etc tags to Zendesk tickets'),
    ]);
  }

  // v4.4 migration: add new config keys if they don't already exist
  // (the block above only runs on empty DB; this catches existing deployments)
  const v44Keys = [
    ['suggested_intents', '["product_info","shipping_delivery","education_content","order_general","returns_damaged","billing_payment","account","refund_cancel","social_engagement"]', 'json', 'Intents where agent drafts AI suggestions (vs specialized handler)'],
    ['noise_suggestion_enabled', 'true', 'boolean', 'For noise-classified tickets, post a close-recommendation note'],
    ['help_center_enabled', 'true', 'boolean', 'Query Zendesk Help Center for article context when drafting suggestions'],
    ['help_center_max_articles', '3', 'number', 'Max articles to include as context per suggestion'],
    ['apply_zendesk_tags', 'true', 'boolean', 'Apply ai-processed, ai-drafted, etc tags to Zendesk tickets'],
    ['max_order_age_days', '90', 'number', 'Max age (days) of orders the agent will auto-respond about'],
    ['require_email_match', 'true', 'boolean', 'If true, require Zendesk email matches Shopify order email (unless order number in ticket)'],
  ];
  for (const [key, value, value_type, description] of v44Keys) {
    const exists = await db.prepare("SELECT 1 FROM agent_config WHERE key = ?").bind(key).first();
    if (!exists) {
      await db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind(key, value, value_type, description).run();
    }
  }

  // v4.4.4 migration: ensure social_engagement is in suggested_intents
  // (upgrade from earlier v4.4.x deployments where it wasn't yet included)
  try {
    const row = await db.prepare("SELECT value FROM agent_config WHERE key = 'suggested_intents'").first();
    if (row?.value) {
      const arr = JSON.parse(row.value);
      if (Array.isArray(arr) && !arr.includes('social_engagement')) {
        arr.push('social_engagement');
        await db.prepare("UPDATE agent_config SET value = ?, updated_at = datetime('now') WHERE key = 'suggested_intents'").bind(JSON.stringify(arr)).run();
      }
    }
  } catch {}

  // v4.6 migration: model split + Opus 4.8 upgrade.
  // - Bump anthropic_model 4.7 -> 4.8, but ONLY if still the old default (never clobber a manual choice).
  // - Add classifier_model (Haiku) so classification stops paying Opus rates.
  try {
    await db.prepare("UPDATE agent_config SET value = 'claude-opus-4-8', updated_at = datetime('now') WHERE key = 'anthropic_model' AND value = 'claude-opus-4-7'").run();
    const hasClassifier = await db.prepare("SELECT 1 FROM agent_config WHERE key = 'classifier_model'").first();
    if (!hasClassifier) {
      await db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)")
        .bind('classifier_model', 'claude-haiku-4-5-20251001', 'string', 'Cheaper/faster Claude model for intent classification').run();
    }
  } catch {}

  // v4.7 migration: product knowledge base config
  const v47Keys = [
    ['product_kb_enabled', 'true', 'boolean', 'Reference the product knowledge base when drafting coverage/product questions'],
    ['product_kb_max_products', '4', 'number', 'Max products to include as context per draft'],
    ['product_extract_model', 'claude-opus-4-8', 'string', 'Model used to extract product coverage maps (text + vision)'],
  ];
  for (const [key, value, value_type, description] of v47Keys) {
    const exists = await db.prepare("SELECT 1 FROM agent_config WHERE key = ?").bind(key).first();
    if (!exists) {
      await db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind(key, value, value_type, description).run();
    }
  }

  // v4.8 migration: autonomous-reply guardrails. mode supports internal_note | shadow | auto_reply.
  const v48Keys = [
    ['auto_reply_intents', '["product_info"]', 'json', 'Intents eligible for autonomous replies (each still gated by accuracy + confidence)'],
    ['auto_reply_accuracy_bar', '0.9', 'number', 'Min per-intent accuracy (good+minor share) before an intent may auto-send'],
    ['auto_reply_min_sample', '25', 'number', 'Min rated replies for an intent before the accuracy gate can pass'],
  ];
  for (const [key, value, value_type, description] of v48Keys) {
    const exists = await db.prepare("SELECT 1 FROM agent_config WHERE key = ?").bind(key).first();
    if (!exists) {
      await db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind(key, value, value_type, description).run();
    }
  }
  // Update mode description to document the new 'shadow' state.
  await db.prepare("UPDATE agent_config SET description = 'internal_note | shadow | auto_reply' WHERE key = 'mode' AND description = 'internal_note | auto_reply'").run();

  // v4.10 migration: multi-turn follow-up replies + turn-aware training.
  const v410Keys = [
    ['followup_enabled', 'true', 'boolean', 'Respond to customer follow-up replies (multi-turn), not just the first message'],
    ['bot_author_id', '', 'string', 'Zendesk user id the agent posts as (auto-resolved). Used to tell the AI\'s own replies from a human takeover'],
    ['followup_sweep_enabled', 'true', 'boolean', 'Cron sweep that catches customer follow-ups even if the Zendesk reply trigger does not fire'],
  ];
  for (const [key, value, value_type, description] of v410Keys) {
    const exists = await db.prepare("SELECT 1 FROM agent_config WHERE key = ?").bind(key).first();
    if (!exists) await db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind(key, value, value_type, description).run();
  }
  // v4.11 migration: sender filtering, educator escalation, grounding checks.
  const v411Keys = [
    ['ignored_senders', '["@corsearch.com","@publisher.com"]', 'json', 'Never process tickets from these senders. Exact emails or "@domain" suffixes'],
    ['skip_outbound_tickets', 'true', 'boolean', 'Skip tickets WE created (outbound/proactive email) — the customer did not write in'],
    ['hard_escalate_intents', '["educator_institutional","partnership"]', 'json', 'INTENTS that always escalate to a human with no customer reply (hard_escalate_topics matches topics, not intents)'],
    ['grounding_check_enabled', 'true', 'boolean', 'Verify each draft against its context and strip claims it cannot support'],
    ['order_action_proposals_enabled', 'true', 'boolean', 'For refund/return tickets, post a proposed action plan (read-only; a human executes it)'],
  ];
  for (const [key, value, value_type, description] of v411Keys) {
    const exists = await db.prepare("SELECT 1 FROM agent_config WHERE key = ?").bind(key).first();
    if (!exists) await db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind(key, value, value_type, description).run();
  }

  // Guarded column adds (SQLite has no ADD COLUMN IF NOT EXISTS — ignore the error if present).
  for (const ddl of [
    "ALTER TABLE agent_tickets ADD COLUMN last_followup_comment_id TEXT",
    "ALTER TABLE agent_responses ADD COLUMN is_followup INTEGER DEFAULT 0",
    "ALTER TABLE agent_responses ADD COLUMN turn_number INTEGER DEFAULT 1",
    "ALTER TABLE agent_responses ADD COLUMN customer_message TEXT",
    "ALTER TABLE agent_human_replies ADD COLUMN response_id INTEGER",
  ]) { try { await db.prepare(ddl).run(); } catch {} }

  const existingTpl = await db.prepare("SELECT COUNT(*) as c FROM agent_templates").first();
  if (existingTpl.c === 0) {
    await db.batch([
      db.prepare("INSERT INTO agent_templates (intent, name, body, variables) VALUES (?, ?, ?, ?)").bind(
        'digital_access_success',
        'Ebook code delivery - standard',
        "Hi {customer_first_name},\n\nThank you so much for reaching out! I am so sorry for the trouble, and I am more than happy to help!\n\nYour code{plural_s} for {product_titles} {is_are}:\n\n{codes}\n\nI have attached a PDF containing the directions on how to redeem {this_these} code{plural_s}.\n\nIf you have any more questions, I'll be happy to help.\n\nHappy studying, future nurse!\nKristine :)",
        '["customer_first_name","product_titles","codes","plural_s","is_are","this_these"]'
      ),
      db.prepare("INSERT INTO agent_templates (intent, name, body, variables) VALUES (?, ?, ?, ?)").bind(
        'digital_access_regenerating',
        'Ebook code - regenerating due to failed original',
        "Hi {customer_first_name},\n\nThank you so much for reaching out! I am so sorry for the trouble with your ebook code. I can see that there was an issue with the original delivery, and I am generating a fresh code for you right now.\n\nYou should receive your new code in the next few minutes. If it does not arrive within 10 minutes, please reply to this email and I will personally make sure you get it.\n\nI have attached a PDF containing the directions on how to redeem your code once it arrives.\n\nThank you for your patience!\n\nHappy studying, future nurse!\nKristine :)",
        '["customer_first_name"]'
      ),
      db.prepare("INSERT INTO agent_templates (intent, name, body, variables) VALUES (?, ?, ?, ?)").bind(
        'escalation_note',
        'Internal note for human handoff',
        "[AI AGENT - ESCALATED]\n\nReason: {escalation_reason}\n\nClassified intent: {intent} (confidence: {confidence})\n\nCustomer message summary: {message_summary}\n\nRelevant data found:\n{data_found}\n\nRecommended human action: {recommended_action}",
        '["escalation_reason","intent","confidence","message_summary","data_found","recommended_action"]'
      ),
    ]);
  }
}

// v4.11: should the agent leave this ticket completely alone? Two cases:
//  1. the sender is on the ignore list (publishers, copyright/brand-protection bots, etc.)
//  2. WE opened the ticket (outbound/proactive email) — the customer didn't write in
// Called from all three entry points (initial webhook, reply webhook, cron sweep).
async function cxShouldSkipTicket(ticketData, db) {
  try {
    const patterns = (await cxGetConfig(db, 'ignored_senders')) || [];
    const candidates = [
      ticketData?.customerEmail,
      ticketData?.ticket?.via?.source?.from?.address,
    ].filter(Boolean).map(e => String(e).toLowerCase().trim());

    for (const raw of patterns) {
      const p = String(raw || '').toLowerCase().trim();
      if (!p) continue;
      for (const email of candidates) {
        // "@domain.com" matches any address at that domain; anything else is an exact match.
        if (p.startsWith('@') ? email.endsWith(p) : email === p) {
          return { skip: true, reason: `sender ignored (${email} matches "${p}")` };
        }
      }
    }

    if ((await cxGetConfig(db, 'skip_outbound_tickets')) !== false) {
      const t = ticketData?.ticket;
      // submitter = who created the ticket; requester = who it's on behalf of.
      // Different => a teammate/automation opened it, i.e. we reached out first.
      if (t?.submitter_id && t?.requester_id && t.submitter_id !== t.requester_id) {
        return { skip: true, reason: `outbound ticket — created by ${t.submitter_id}, not the customer (${t.requester_id})` };
      }
    }
  } catch (e) {
    console.error('cxShouldSkipTicket error:', e);
  }
  return { skip: false };
}

async function handleCxAgentWebhook(request, env, ctx) {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!env.CX_AGENT_DB) return new Response(JSON.stringify({ error: "CX_AGENT_DB not configured" }), { status: 500, headers: cors });

  const db = env.CX_AGENT_DB;
  await initCxAgentTables(db);

  const rawBody = await request.text();
  if (env.ZENDESK_WEBHOOK_SECRET) {
    const sigHeader = request.headers.get('x-zendesk-webhook-signature');
    const tsHeader = request.headers.get('x-zendesk-webhook-signature-timestamp');
    if (!sigHeader || !tsHeader) return new Response(JSON.stringify({ error: "Missing signature headers" }), { status: 401, headers: cors });
    const valid = await verifyZendeskSignature(rawBody, tsHeader, sigHeader, env.ZENDESK_WEBHOOK_SECRET);
    if (!valid) return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401, headers: cors });
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

  const zendeskTicketId = payload.ticket_id || payload.body?.ticket_id;
  if (!zendeskTicketId) return new Response(JSON.stringify({ error: "Missing ticket_id" }), { status: 400, headers: cors });

  const enabled = await cxGetConfig(db, 'agent_enabled');
  if (enabled !== true) return new Response(JSON.stringify({ skipped: true, reason: "Agent disabled" }), { headers: cors });

  const ticketData = await cxFetchZendeskTicket(zendeskTicketId, db, env);
  if (!ticketData) return new Response(JSON.stringify({ error: "Failed to fetch ticket" }), { status: 500, headers: cors });

  const existing = await db.prepare("SELECT id, status FROM agent_tickets WHERE zendesk_ticket_id = ?").bind(String(zendeskTicketId)).first();
  if (existing) return new Response(JSON.stringify({ skipped: true, reason: "Already processed", ticket_id: existing.id, status: existing.status }), { headers: cors });

  // v4.11: ignored sender / outbound ticket → record it so the Activity Feed explains the
  // silence, but spend nothing (no classifier call, no Zendesk note, no tags).
  const skipCheck = await cxShouldSkipTicket(ticketData, db);
  if (skipCheck.skip) {
    await db.prepare(
      `INSERT INTO agent_tickets (zendesk_ticket_id, subject, customer_email, channel, first_customer_message, status, final_action, error_message, completed_at) VALUES (?, ?, ?, ?, ?, 'ignored', 'ignored', ?, datetime('now'))`
    ).bind(
      String(zendeskTicketId),
      ticketData.subject ?? null,
      ticketData.customerEmail ?? null,
      ticketData.channel ?? null,
      ticketData.firstMessage?.substring(0, 2000) ?? null,
      skipCheck.reason
    ).run();
    return new Response(JSON.stringify({ skipped: true, reason: skipCheck.reason }), { headers: cors });
  }

  const insertResult = await db.prepare(
    `INSERT INTO agent_tickets (zendesk_ticket_id, subject, customer_email, channel, first_customer_message, status) VALUES (?, ?, ?, ?, ?, 'processing')`
  ).bind(
    String(zendeskTicketId),
    ticketData.subject ?? null,
    ticketData.customerEmail ?? null,
    ticketData.channel ?? null,
    ticketData.firstMessage?.substring(0, 2000) ?? null
  ).run();

  const ticketId = insertResult.meta.last_row_id;
  ctx.waitUntil(runCxAgentPipeline(ticketId, ticketData, db, env));
  return new Response(JSON.stringify({ accepted: true, ticket_id: ticketId, zendesk_ticket_id: zendeskTicketId }), { headers: cors });
}

// ============================================================================
// v4.5: HUMAN REPLY CAPTURE WEBHOOK
// ============================================================================
// Fires when a public team reply is added to an agent-processed ticket.
// Captures the reply for training comparison against the agent's draft.
async function handleCxAgentReplyWebhook(request, env, ctx) {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!env.CX_AGENT_DB) return new Response(JSON.stringify({ error: "CX_AGENT_DB not configured" }), { status: 500, headers: cors });

  const db = env.CX_AGENT_DB;
  await initCxAgentTables(db);

  const rawBody = await request.text();
  if (env.ZENDESK_WEBHOOK_SECRET) {
    const sigHeader = request.headers.get('x-zendesk-webhook-signature');
    const tsHeader = request.headers.get('x-zendesk-webhook-signature-timestamp');
    if (sigHeader && tsHeader) {
      const valid = await verifyZendeskSignature(rawBody, tsHeader, sigHeader, env.ZENDESK_WEBHOOK_SECRET);
      if (!valid) return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401, headers: cors });
    }
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

  const zendeskTicketId = payload.ticket_id || payload.body?.ticket_id;
  if (!zendeskTicketId) return new Response(JSON.stringify({ error: "Missing ticket_id" }), { status: 400, headers: cors });

  // Only capture for tickets we've processed
  const ticket = await db.prepare("SELECT id, classified_intent FROM agent_tickets WHERE zendesk_ticket_id = ?").bind(String(zendeskTicketId)).first();
  if (!ticket) return new Response(JSON.stringify({ skipped: true, reason: "Ticket not in agent DB" }), { headers: cors });

  // Background: capture team replies for training, and (v4.10) respond to customer follow-ups.
  ctx.waitUntil((async () => {
    // 1) Always capture team replies for the training loop (existing behavior).
    await captureHumanReply(ticket.id, String(zendeskTicketId), db, env);

    // 2) Follow-up handling.
    if ((await cxGetConfig(db, 'followup_enabled')) === false) return;
    const td = await cxFetchZendeskTicket(zendeskTicketId, db, env);
    if (!td) return;
    if ((await cxShouldSkipTicket(td, db)).skip) return; // ignored sender / outbound
    const botId = await cxGetBotAuthorId(db, env);
    const requesterId = td.ticket?.requester_id;
    const publicComments = (td.comments || []).filter(c => c.public === true);

    // A teammate (not the bot) has replied publicly → the human owns the ticket. We STILL
    // draft internal-note suggestions on customer follow-ups (labeled), but never auto-send.
    const humanActive = publicComments.some(c =>
      typeof c.author_id === 'number' && c.author_id > 0 && c.author_id !== requesterId && c.author_id !== botId);

    // Latest customer message; only act on a genuine follow-up (a 2nd+ customer comment).
    const customerComments = publicComments
      .filter(c => c.author_id === requesterId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (customerComments.length < 2) return;
    const latest = customerComments[0];

    // Already answered? If anyone (team or AI) publicly replied AFTER the customer's latest
    // message, there's nothing to suggest — don't draft noise for a handled turn.
    const answered = publicComments.some(c =>
      typeof c.author_id === 'number' && c.author_id > 0 && c.author_id !== requesterId &&
      new Date(c.created_at) > new Date(latest.created_at));
    if (answered) return;

    const row = await db.prepare("SELECT last_followup_comment_id FROM agent_tickets WHERE id = ?").bind(ticket.id).first();
    if (row?.last_followup_comment_id === String(latest.id)) return; // already handled this turn
    // Claim, run, release-on-failure so a failed draft gets retried by the sweep.
    await db.prepare("UPDATE agent_tickets SET last_followup_comment_id = ? WHERE id = ?").bind(String(latest.id), ticket.id).run();
    const ok = await runCxAgentFollowup(ticket, td, latest, db, env, { humanActive });
    if (!ok) {
      await db.prepare("UPDATE agent_tickets SET last_followup_comment_id = NULL WHERE id = ? AND last_followup_comment_id = ?").bind(ticket.id, String(latest.id)).run();
    }
  })());
  return new Response(JSON.stringify({ accepted: true, ticket_id: ticket.id }), { headers: cors });
}

// Zendesk comment bodies are HTML (or plain_body with stray entities). Convert to clean
// plain text so the Training Review UI is readable AND the few-shot examples we feed the
// drafter aren't polluted with markup/entities.
function cxCleanReplyText(s) {
  if (!s) return '';
  let t = String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');                 // strip remaining tags
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
    mdash: '—', ndash: '–', hellip: '…' };
  t = t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
       .replace(/&([a-zA-Z]+);/g, (m, name) => name.toLowerCase() in named ? named[name.toLowerCase()] : m);
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function captureHumanReply(agentTicketId, zendeskTicketId, db, env) {
  try {
    const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
    const supportStaffIds = await cxGetConfig(db, 'support_staff_ids');
    const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
    const resp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${zendeskTicketId}/comments.json`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    if (!resp.ok) return { captured: false, reason: `zendesk ${resp.status}` };
    const { comments = [] } = await resp.json();

    // Identify the customer (requester) so we can treat ANY other public author as a team
    // member — support_staff_ids is a fragile hardcoded allowlist that misses new agents.
    // Falls back to the allowlist if the ticket fetch fails.
    let requesterId = null;
    try {
      const tResp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${zendeskTicketId}.json`, { headers: { Authorization: `Basic ${auth}` } });
      if (tResp.ok) { const { ticket } = await tResp.json(); requesterId = ticket?.requester_id ?? null; }
    } catch {}

    // Build set of comments we've already captured for this ticket so we don't duplicate
    const existing = await db.prepare("SELECT zendesk_comment_id FROM agent_human_replies WHERE ticket_id = ?").bind(agentTicketId).all();
    const existingIds = new Set((existing.results || []).map(r => r.zendesk_comment_id).filter(Boolean));

    // Most recent public team reply we haven't captured yet (newest first).
    // - author_id > 0 excludes Messaging/chat transcripts (Zendesk stamps those as -1).
    // - "not the requester" = a team member; falls back to the staff allowlist if we
    //   couldn't resolve the requester. (Safe in internal_note mode since the AI posts
    //   only private notes; revisit if auto_reply mode ever posts public replies.)
    const candidates = comments
      .filter(c => c.public === true)
      .filter(c => typeof c.author_id === 'number' && c.author_id > 0)
      .filter(c => requesterId != null ? c.author_id !== requesterId : supportStaffIds.includes(c.author_id))
      .filter(c => !existingIds.has(String(c.id)))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (candidates.length === 0) return { captured: false, reason: 'no team reply' };
    const reply = candidates[0];

    // Pull author name (best-effort)
    let authorName = null;
    try {
      const userResp = await fetch(`https://${subdomain}.zendesk.com/api/v2/users/${reply.author_id}.json`, {
        headers: { Authorization: `Basic ${auth}` }
      });
      if (userResp.ok) {
        const { user } = await userResp.json();
        authorName = user?.name ?? null;
      }
    } catch {}

    // Link to the AI turn this reply answers (the most recent draft for the ticket) so
    // Training Review can show it per-turn and the few-shot loop pairs the right message.
    const respRow = await db.prepare("SELECT id FROM agent_responses WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1").bind(agentTicketId).first();

    await db.prepare(`
      INSERT INTO agent_human_replies (ticket_id, zendesk_ticket_id, zendesk_comment_id, author_id, author_name, body, reply_created_at, source, response_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?)
    `).bind(
      agentTicketId,
      zendeskTicketId,
      String(reply.id),
      String(reply.author_id),
      authorName,
      cxCleanReplyText(reply.plain_body || reply.body || ''),
      reply.created_at,
      respRow?.id ?? null
    ).run();
    return { captured: true };
  } catch (err) {
    console.error('captureHumanReply error:', err);
    return { captured: false, reason: err.message };
  }
}

// Shared 3-way routing used by both the initial pipeline and follow-ups.
async function cxRouteIntent(db, intent) {
  const scopedIntents = await cxGetConfig(db, 'scoped_intents');
  const suggestedIntents = await cxGetConfig(db, 'suggested_intents');
  const hardEscalateTopics = await cxGetConfig(db, 'hard_escalate_topics');
  const hardEscalateIntents = (await cxGetConfig(db, 'hard_escalate_intents')) || [];
  const minConfidence = await cxGetConfig(db, 'min_confidence_to_respond');
  const noiseSuggestionEnabled = await cxGetConfig(db, 'noise_suggestion_enabled');

  // NOTE: hard_escalate_topics is matched against intent.topics (the classifier emits only
  // clinical_question / refund_over_50 / angry / urgent). Intent-level always-escalate lives
  // in hard_escalate_intents — entries like "partnership" in the topics list never fired.
  if (hardEscalateIntents.includes(intent.intent)) {
    return { route: 'escalate', reason: `Intent always requires a human: ${intent.intent}` };
  }

  const hasHardTopic = hardEscalateTopics.some(t => intent.topics?.includes(t));
  if (hasHardTopic) return { route: 'escalate', reason: `Topic requires human review: ${intent.topics.join(', ')}` };
  if (intent.confidence < minConfidence) return { route: 'escalate', reason: `Confidence ${intent.confidence} below threshold ${minConfidence}` };
  if (intent.intent === 'noise' && noiseSuggestionEnabled) return { route: 'noise_suggest', reason: 'Noise classification — suggesting close' };
  if (scopedIntents.includes(intent.intent)) return { route: 'handled', reason: `Specialized handler for: ${intent.intent}` };
  if (suggestedIntents.includes(intent.intent)) return { route: 'suggest', reason: `AI suggestion drafted for: ${intent.intent}` };
  return { route: 'escalate', reason: `No handler or suggestion path for: ${intent.intent}` };
}

async function runCxAgentPipeline(ticketId, ticketData, db, env) {
  const tracer = new CxTracer(db, ticketId);
  try {
    const intent = await tracer.trace('intent_classification', async () => cxClassifyIntent(ticketData, db, env));
    await db.prepare(`UPDATE agent_tickets SET classified_intent = ?, intent_confidence = ? WHERE id = ?`).bind(intent.intent, intent.confidence, ticketId).run();

    const routing = await tracer.trace('routing_decision', async () => cxRouteIntent(db, intent));

    if (routing.route === 'handled' && intent.intent === 'digital_access') {
      await db.prepare('UPDATE agent_tickets SET is_in_scope = 1 WHERE id = ?').bind(ticketId).run();
      await cxHandleDigitalAccess(ticketId, ticketData, intent, db, env, tracer);
    } else if (routing.route === 'suggest') {
      await db.prepare('UPDATE agent_tickets SET is_in_scope = 1 WHERE id = ?').bind(ticketId).run();
      await cxDraftGeneralSuggestion(ticketId, ticketData, intent, db, env, tracer);
    } else if (routing.route === 'noise_suggest') {
      await cxSuggestClose(ticketId, ticketData, intent, db, env, tracer);
    } else {
      await cxEscalate(ticketId, ticketData, intent, routing.reason, db, env, tracer);
    }
  } catch (err) {
    console.error(`CX agent pipeline error for ticket ${ticketId}:`, err);
    await db.prepare(`UPDATE agent_tickets SET status = 'error', error_message = ? WHERE id = ?`).bind(err.message, ticketId).run();
    try { await tracer.trace('pipeline_error', async () => ({ error: err.message, stack: err.stack }), { status: 'error' }); } catch {}
  }
}

// Build a labeled, cleaned transcript of the public conversation for follow-up context.
function cxBuildTranscript(comments, requesterId, botId) {
  return (comments || [])
    .filter(c => c.public === true)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(c => {
      const who = c.author_id === requesterId ? 'Customer' : (botId && c.author_id === botId ? 'AI (you, earlier)' : 'Team');
      return `${who}: ${cxCleanReplyText(c.plain_body || c.body || '').slice(0, 1500)}`;
    })
    .join('\n\n');
}

// v4.10: respond to a customer's follow-up reply using full-thread context. Same routing
// and mode/guardrails as the initial pipeline; never re-runs ebook-code delivery.
async function runCxAgentFollowup(ticketRow, ticketData, latestCustomerComment, db, env, opts = {}) {
  const ticketId = ticketRow.id;
  const tracer = new CxTracer(db, ticketId);
  try {
    const botId = await cxGetBotAuthorId(db, env);
    const transcript = cxBuildTranscript(ticketData.comments, ticketData.ticket?.requester_id, botId);
    const prior = await db.prepare("SELECT COUNT(*) as c FROM agent_responses WHERE ticket_id = ?").bind(ticketId).first();
    const latestMsg = cxCleanReplyText(latestCustomerComment.plain_body || latestCustomerComment.body || '');

    // Conversation-aware view of the ticket for the classifier + drafter.
    const followTd = { ...ticketData, firstMessage: latestMsg, conversationTranscript: transcript, isFollowup: true, turnNumber: (prior?.c || 1) + 1, humanActive: !!opts.humanActive };

    const intent = await tracer.trace('followup_intent_classification', async () => cxClassifyIntent(followTd, db, env));
    await db.prepare(`UPDATE agent_tickets SET classified_intent = ?, intent_confidence = ? WHERE id = ?`).bind(intent.intent, intent.confidence, ticketId).run();
    const routing = await tracer.trace('followup_routing', async () => cxRouteIntent(db, intent));

    if (routing.route === 'suggest' || routing.route === 'handled') {
      // 'handled' (scoped, e.g. digital_access) is drafted, not auto-delivered, on follow-ups.
      await cxDraftGeneralSuggestion(ticketId, followTd, intent, db, env, tracer);
    } else if (routing.route === 'escalate') {
      await cxEscalate(ticketId, followTd, intent, routing.reason, db, env, tracer);
    }
    // noise follow-ups: do nothing (don't reply to spam/auto-mail).
    return true;
  } catch (err) {
    console.error(`CX follow-up error for ticket ${ticketId}:`, err);
    try { await tracer.trace('followup_error', async () => ({ error: err.message }), { status: 'error' }); } catch {}
    return false; // caller clears the turn claim so the next sweep retries
  }
}

// v4.10: cron sweep so follow-ups work even when the Zendesk reply trigger doesn't fire.
// Finds recently-updated ai-processed tickets with a NEW customer comment (no human takeover)
// and runs the follow-up. Deduped with the webhook path via last_followup_comment_id.
async function sweepFollowups(env) {
  const db = env.CX_AGENT_DB;
  if (!db) return;
  if ((await cxGetConfig(db, 'followup_enabled')) === false) return;
  if ((await cxGetConfig(db, 'followup_sweep_enabled')) === false) return;

  const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
  let results = [];
  try {
    const q = encodeURIComponent(`type:ticket tags:ai-processed updated>${cutoff}`);
    const resp = await fetch(`https://${subdomain}.zendesk.com/api/v2/search.json?query=${q}&per_page=25`, { headers: { Authorization: `Basic ${auth}` } });
    if (resp.ok) results = (await resp.json()).results || [];
  } catch { return; }

  const botId = await cxGetBotAuthorId(db, env);
  for (const t of results) {
    try {
      const zid = String(t.id);
      const row = await db.prepare("SELECT id, last_followup_comment_id FROM agent_tickets WHERE zendesk_ticket_id = ?").bind(zid).first();
      if (!row) continue;
      const td = await cxFetchZendeskTicket(zid, db, env);
      if (!td) continue;
      if ((await cxShouldSkipTicket(td, db)).skip) continue; // ignored sender / outbound
      const requesterId = td.ticket?.requester_id;
      const publicComments = (td.comments || []).filter(c => c.public === true);
      // A teammate replied publicly → human owns the ticket. Still draft suggestions
      // (labeled), never auto-send.
      const humanActive = publicComments.some(c => typeof c.author_id === 'number' && c.author_id > 0 && c.author_id !== requesterId && c.author_id !== botId);
      const cc = publicComments.filter(c => c.author_id === requesterId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (cc.length < 2) continue;                                  // no follow-up yet
      const latest = cc[0];
      // Skip if someone (team or AI) already publicly replied AFTER the customer's latest message.
      if (publicComments.some(c => typeof c.author_id === 'number' && c.author_id > 0 && c.author_id !== requesterId && new Date(c.created_at) > new Date(latest.created_at))) continue;
      if (row.last_followup_comment_id === String(latest.id)) continue; // already handled
      if (Date.now() - new Date(latest.created_at).getTime() > 2 * 60 * 60 * 1000) continue; // stale (>2h); don't answer old threads
      // Claim the turn first (dedupes against the webhook path), but if drafting FAILS,
      // release the claim so the next sweep retries instead of silently dropping the turn.
      await db.prepare("UPDATE agent_tickets SET last_followup_comment_id = ? WHERE id = ?").bind(String(latest.id), row.id).run();
      const ok = await runCxAgentFollowup(row, td, latest, db, env, { humanActive });
      if (!ok) {
        await db.prepare("UPDATE agent_tickets SET last_followup_comment_id = NULL WHERE id = ? AND last_followup_comment_id = ?").bind(row.id, String(latest.id)).run();
      }
    } catch (e) { /* per-ticket errors non-fatal */ }
  }
}

async function cxClassifyIntent(ticketData, db, env) {
  // Classification is a cheap structured task — run it on the (much cheaper/faster)
  // classifier_model (Haiku) and reserve the Opus drafter for actual reply writing.
  const model = (await cxGetConfig(db, 'classifier_model')) || (await cxGetConfig(db, 'anthropic_model'));
  const systemPrompt = `You are an intent classifier for Nurse In The Making, a nursing education ecommerce company. Classify the customer's message into exactly ONE of these intents:

- digital_access: Customer asking about ebook access codes, how to redeem codes, missing ebook codes, can't find their code, ebook not working. ALSO includes customers who bought ebooks and are asking when they'll receive them.
- shipping_delivery: Questions about shipping, tracking, delivery, packages, international shipping, delivery delays.
- refund_cancel: Refund requests, cancellation requests, order reversals.
- billing_payment: Billing issues, duplicate charges, payment problems, discount codes not working, gift cards.
- returns_damaged: Returns, damaged items, wrong items received, defective products, missing items from order.
- order_general: General order questions not covered above (order status, order modifications).
- product_info: Questions about what products include, what comes in bundles, product comparisons, product availability.
- education_content: Questions about nursing study content itself (clinical questions, exam content, study material content).
- account: Account login, password, profile issues.
- unsubscribe: Unsubscribe requests.
- partnership: Ambassador, collab, influencer, partnership inquiries.
- educator_institutional: Requests from educators, faculty, schools, or institutions — course/school adoption, using our materials with their students or class, desk/review/sample copies, bulk or class-set orders, institutional or wholesale pricing, purchase orders, invoicing, W-9 or tax-exempt paperwork. Signals include "my students", "my class", "our nursing program", "faculty", "professor", "purchase order", "bulk pricing", "for our school".
- social_engagement: Short social media messages that aren't support requests (reactions, quiz answers, thanks).
- noise: System alerts, spam, auto-generated emails, copyright notices, anything that isn't real support.
- other: Genuinely doesn't fit any category above.

Additional "topics" you can flag (array, can be multiple):
- clinical_question: Message asks for clinical/medical advice or nursing knowledge
- refund_over_50: Refund request explicitly for over $50
- angry: Customer is frustrated/angry
- urgent: Customer says they need urgent help

Respond in this exact JSON format:
{
  "intent": "...",
  "confidence": 0.0-1.0,
  "reasoning": "One sentence why you chose this intent",
  "topics": []
}`;
  const convoBlock = ticketData.conversationTranscript
    ? `\n\nConversation so far (for context):\n${ticketData.conversationTranscript.slice(0, 4000)}\n\nClassify the LATEST customer message below (their newest reply).`
    : '';
  const userPrompt = `Subject: ${ticketData.subject || '(no subject)'}\nChannel: ${ticketData.channel || 'unknown'}${convoBlock}\n\nCustomer message:\n${(ticketData.firstMessage || '').substring(0, 3000)}`;
  const response = await cxCallClaude(env, model, systemPrompt, userPrompt, 500);
  const parsed = cxExtractJson(response.content);
  if (!parsed) return { intent: 'other', confidence: 0.0, reasoning: 'Failed to parse classifier response', topics: [], _tokens: response.tokens, _cost: response.cost };
  return {
    intent: parsed.intent || 'other',
    confidence: parsed.confidence || 0.0,
    reasoning: parsed.reasoning || '',
    topics: parsed.topics || [],
    _tokens: response.tokens,
    _cost: response.cost
  };
}

async function cxHandleDigitalAccess(ticketId, ticketData, intent, db, env, tracer) {
  // STEP: Detect ALL order numbers in ticket (dedupe, keep order)
  const fullText = `${ticketData.subject || ''}\n${ticketData.firstMessage || ''}`;
  const orderNumbersFound = Array.from(new Set(
    (fullText.match(/#?(\d{1,2}-\d{4,7})/g) || []).map(m => m.replace(/^#/, ''))
  ));

  // STEP: Look up orders — by explicit numbers if found, otherwise by customer email
  const orderLookup = await tracer.trace('shopify_order_lookup', async () => {
    return await cxFindCustomerOrders(ticketData, orderNumbersFound, db, env);
  });

  // Case: no orders found at all
  if (!orderLookup.order && !orderLookup.orders?.length && !orderLookup.candidates?.length) {
    await cxEscalate(ticketId, ticketData, intent, 'Could not find any orders for this customer.', db, env, tracer, {
      customer_email: ticketData.customerEmail,
      order_numbers_in_ticket: orderNumbersFound.length > 0 ? orderNumbersFound.join(', ') : 'none'
    });
    return;
  }

  // Case: multiple candidates, no explicit order numbers — can't safely pick one
  if (!orderLookup.orders?.length && orderLookup.candidates?.length > 1) {
    const summary = orderLookup.candidates.slice(0, 5).map(o =>
      `    ${o.name} (${new Date(o.created_at).toLocaleDateString()}) - ${o.line_items.filter(li => li.sku?.startsWith('D-')).map(li => li.sku).join(', ')}`
    ).join('\n');
    await cxEscalate(ticketId, ticketData, intent,
      `Customer has ${orderLookup.candidates.length} ebook orders in last 90 days but didn't specify which one. Needs human review.`,
      db, env, tracer, {
        customer_email: ticketData.customerEmail,
        candidate_orders: '\n' + summary
      });
    return;
  }

  // At this point we have one or more orders to process
  const ordersToProcess = orderLookup.orders || (orderLookup.order ? [orderLookup.order] : []);

  // STEP: Run safeguards on every order; split into valid/invalid
  const validated = await tracer.trace('safeguard_checks', async () => {
    const valid = [];
    const invalid = [];
    const maxAgeDays = await cxGetConfig(db, 'max_order_age_days');
    const requireEmailMatch = await cxGetConfig(db, 'require_email_match');
    const ticketEmail = (ticketData.customerEmail || '').toLowerCase().trim();

    for (const order of ordersToProcess) {
      const issues = [];
      if (order.cancelled_at) issues.push(`Order was cancelled on ${new Date(order.cancelled_at).toLocaleDateString()}`);
      if (['refunded', 'voided', 'partially_refunded'].includes(order.financial_status)) {
        issues.push(`Order financial status is '${order.financial_status}'`);
      }
      const ageDays = Math.floor((Date.now() - new Date(order.created_at).getTime()) / (86400000));
      if (ageDays > maxAgeDays) issues.push(`Order is ${ageDays} days old (policy: max ${maxAgeDays} days)`);
      if (requireEmailMatch && !orderNumbersFound.length) {
        const orderEmail = (order.email || '').toLowerCase().trim();
        if (ticketEmail && orderEmail && ticketEmail !== orderEmail) {
          issues.push(`Email mismatch: ticket '${ticketEmail}' vs order '${orderEmail}'`);
        }
      }
      if (issues.length > 0) {
        invalid.push({ order, issues, name: order.name });
      } else {
        valid.push(order);
      }
    }

    return {
      total: ordersToProcess.length,
      valid_count: valid.length,
      invalid_count: invalid.length,
      valid_orders: valid.map(o => o.name),
      invalid_orders: invalid.map(i => ({ name: i.name, issues: i.issues }))
    };
  });

  // Case: all orders failed safeguards
  if (validated.valid_count === 0) {
    const summary = validated.invalid_orders.map(i => `  ${i.name}: ${i.issues.join('; ')}`).join('\n');
    await cxEscalate(ticketId, ticketData, intent,
      `All referenced orders failed safeguard checks.`,
      db, env, tracer, { invalid_orders: '\n' + summary });
    return;
  }

  // Get the valid orders to process
  const validOrders = ordersToProcess.filter(o => validated.valid_orders.includes(o.name));

  // STEP: Look up fulfillment metafields for each valid order
  const orderFulfillments = await tracer.trace('shopify_metafields_lookup_multi', async () => {
    const results = [];
    for (const order of validOrders) {
      const metafields = await cxFetchOrderMetafields(order.id, db, env);
      const vsStatus = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'status')?.value;
      const vsCode = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'code')?.value;
      const vsExpected = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'expected_count')?.value;
      results.push({ order, vsStatus, vsCode, vsExpected });
    }
    return { count: results.length, summary: results.map(r => ({ order: r.order.name, status: r.vsStatus, has_code: !!r.vsCode })) };
  });

  // Recompute fulfillment results (they're not stored in the tracer summary, need to fetch again to use)
  const fulfillments = [];
  for (const order of validOrders) {
    const metafields = await cxFetchOrderMetafields(order.id, db, env);
    const vsStatus = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'status')?.value;
    const vsCode = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'code')?.value;
    const vsExpected = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'expected_count')?.value;
    fulfillments.push({ order, vsStatus, vsCode, vsExpected });
  }

  // STEP: Decide per-order what to do
  const decisions = await tracer.trace('fulfillment_decision_multi', async () => {
    return fulfillments.map(f => {
      if (f.vsStatus === 'complete' && f.vsCode) return { order_name: f.order.name, action: 'deliver', vsCode: f.vsCode };
      if (f.vsStatus === 'partial') return { order_name: f.order.name, action: 'escalate', reason: `Partial: ${f.vsCode?.split(',').length || 0}/${f.vsExpected} codes generated` };
      if (f.vsStatus === 'failed') return { order_name: f.order.name, action: 'regenerate', reason: 'Generation failed' };
      if (!f.vsStatus) {
        const orderHasEbook = f.order.line_items?.some(li => li.sku?.startsWith('D-'));
        if (orderHasEbook) return { order_name: f.order.name, action: 'regenerate', reason: 'Legacy order, no status metafield' };
        return { order_name: f.order.name, action: 'skip', reason: 'No ebook products' };
      }
      return { order_name: f.order.name, action: 'escalate', reason: `Unknown status: ${f.vsStatus}` };
    });
  });

  const deliverable = decisions.filter(d => d.action === 'deliver');
  const needRegen = decisions.filter(d => d.action === 'regenerate');
  const needEscalate = decisions.filter(d => d.action === 'escalate' || d.action === 'skip');

  // Simple case: everything is deliverable
  if (deliverable.length === ordersToProcess.length && deliverable.length > 0) {
    await cxDeliverExistingCodesMulti(ticketId, ticketData, fulfillments, db, env, tracer, validated.invalid_orders);
    return;
  }

  // Simple case: everything needs regeneration
  if (needRegen.length === ordersToProcess.length && deliverable.length === 0) {
    // Just trigger regen on the first one (typical case: one legacy order)
    const firstOrder = fulfillments.find(f => f.order.name === needRegen[0].order_name).order;
    await cxTriggerRegeneration(ticketId, ticketData, firstOrder, db, env, tracer);
    return;
  }

  // Mixed case: some deliverable, some not — deliver what we can and escalate the rest
  if (deliverable.length > 0) {
    const deliverableFulfillments = fulfillments.filter(f => deliverable.some(d => d.order_name === f.order.name));
    await cxDeliverExistingCodesMulti(
      ticketId, ticketData, deliverableFulfillments, db, env, tracer,
      validated.invalid_orders.concat(
        needEscalate.map(e => ({ name: e.order_name, issues: [e.reason] })),
        needRegen.map(r => ({ name: r.order_name, issues: [r.reason + ' — may need regeneration'] }))
      )
    );
    return;
  }

  // Fallback: nothing deliverable, escalate everything
  const allIssues = decisions.map(d => `  ${d.order_name}: ${d.reason || d.action}`).join('\n');
  await cxEscalate(ticketId, ticketData, intent, `No orders with deliverable codes.`, db, env, tracer, { order_issues: '\n' + allIssues });
}

async function cxDeliverExistingCode(ticketId, ticketData, order, vsCode, db, env, tracer) {
  // Wrap single-order into multi-order flow for consistency
  await cxDeliverExistingCodesMulti(ticketId, ticketData, [{ order, vsCode }], db, env, tracer, []);
}

async function cxDeliverExistingCodesMulti(ticketId, ticketData, fulfillments, db, env, tracer, invalidNotes = []) {
  const response = await tracer.trace('draft_response', async () => {
    // Collect all codes across all orders
    const allParsedCodes = [];
    for (const f of fulfillments) {
      const codeEntries = f.vsCode.split(',').map(s => s.trim()).filter(Boolean);
      for (const entry of codeEntries) {
        const dashIndex = entry.indexOf(' - ');
        if (dashIndex > 0) {
          allParsedCodes.push({
            code: entry.substring(0, dashIndex).trim(),
            title: entry.substring(dashIndex + 3).trim(),
            order_name: f.order.name
          });
        } else {
          allParsedCodes.push({ code: entry, title: null, order_name: f.order.name });
        }
      }
    }

    const firstOrder = fulfillments[0].order;
    const customerFirstName = firstOrder.customer?.first_name || cxFirstNameFromEmail(ticketData.customerEmail);
    const template = await cxGetTemplate(db, 'digital_access_success');
    const plural = allParsedCodes.length > 1;

    const productTitles = Array.from(new Set(allParsedCodes.map(p => p.title || 'your ebook'))).join(' and ');
    const codesFormatted = allParsedCodes.length > 1
      ? allParsedCodes.map(p => `  ${p.code}${p.title ? ` (${p.title})` : ''}`).join('\n')
      : allParsedCodes[0].code;

    const replyBody = template.body
      .replace('{customer_first_name}', customerFirstName)
      .replace('{product_titles}', productTitles)
      .replaceAll('{plural_s}', plural ? 's' : '')
      .replace('{is_are}', plural ? 'are' : 'is')
      .replace('{codes}', codesFormatted)
      .replaceAll('{this_these}', plural ? 'these' : 'this');

    // Build context + warning lines for the branded internal note
    const contextLines = [
      `Intent: digital_access (high confidence specialized handler)`,
      `Codes: ${allParsedCodes.length} code(s) across ${fulfillments.length} order(s)`,
    ];
    for (const f of fulfillments) {
      contextLines.push(`Order ${f.order.name} (${new Date(f.order.created_at).toLocaleDateString()}): ${f.order.financial_status}, status metafield=${f.vsStatus}`);
    }

    const warningLines = [];
    if (invalidNotes && invalidNotes.length > 0) {
      warningLines.push('Customer mentioned other orders that were NOT included above:');
      for (const i of invalidNotes) {
        const issuesText = Array.isArray(i.issues) ? i.issues.join('; ') : i.issues;
        warningLines.push(`  ${i.name}: ${issuesText}`);
      }
      warningLines.push('Review whether those need separate human follow-up.');
    }

    const noteBody = cxFormatNote('reply', {
      body: replyBody,
      confidence: 0.95,
      contextLines,
      warningLines: warningLines.length ? warningLines : undefined
    });

    return {
      body: replyBody,          // raw reply (what CX would copy/paste)
      noteBody,                 // branded note body (what gets posted to Zendesk)
      confidence: 0.95,
      reasoning: `Delivering ${allParsedCodes.length} code(s) across ${fulfillments.length} order(s): ${fulfillments.map(f => f.order.name).join(', ')}${invalidNotes.length ? ` [+${invalidNotes.length} flagged for human]` : ''}`,
      data_sources: {
        order_count: fulfillments.length,
        order_numbers: fulfillments.map(f => f.order.name),
        code_count: allParsedCodes.length,
        customer_name: customerFirstName,
        flagged_orders: invalidNotes.length
      }
    };
  });

  // Save the raw reply as the canonical draft (for future auto-reply mode, we send this verbatim)
  const responseId = await cxSaveResponse(db, ticketId, {
    body: response.body,
    confidence: response.confidence,
    reasoning: response.reasoning,
    data_sources: response.data_sources
  });
  await tracer.trace('post_internal_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, response.noteBody, db, env));
  await tracer.trace('apply_tags', async () => cxApplyZendeskTags(ticketData.zendeskTicketId, ['ai-processed', 'ai-drafted', 'ai-intent-digital_access'], db, env));
  await db.prepare(`UPDATE agent_responses SET status = 'posted_as_note', posted_to_zendesk_at = datetime('now') WHERE id = ?`).bind(responseId).run();
  await db.prepare(`UPDATE agent_tickets SET status = 'drafted', final_action = 'internal_note_posted', completed_at = datetime('now') WHERE id = ?`).bind(ticketId).run();
}

async function cxTriggerRegeneration(ticketId, ticketData, order, db, env, tracer) {
  await tracer.trace('trigger_n8n_regeneration', async () => {
    const webhookUrl = await cxGetConfig(db, 'n8n_code_generation_webhook');
    const payload = {
      id: order.id, name: order.name, order_number: order.order_number, email: order.email,
      customer: order.customer, line_items: order.line_items, financial_status: order.financial_status,
      cancelled_at: order.cancelled_at, created_at: order.created_at
    };
    const resp = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { webhook_triggered: true, status: resp.status, ok: resp.ok };
  });

  const response = await tracer.trace('draft_response', async () => {
    const customerFirstName = order.customer?.first_name || cxFirstNameFromEmail(ticketData.customerEmail);
    const template = await cxGetTemplate(db, 'digital_access_regenerating');
    const replyBody = template.body.replace('{customer_first_name}', customerFirstName);

    const noteBody = cxFormatNote('reply', {
      body: replyBody,
      confidence: 0.85,
      contextLines: [
        `Intent: digital_access (regeneration triggered)`,
        `Order ${order.name}: ${order.financial_status}`,
        `n8n regeneration webhook fired; codes should be on the way`
      ],
      warningLines: ['Monitor whether regeneration actually completes. If customer replies again with the same issue, escalate.']
    });

    return {
      body: replyBody,
      noteBody,
      confidence: 0.85,
      reasoning: `Order ${order.name} had no valid codes. Triggered regeneration via n8n.`,
      data_sources: { order_id: order.id, order_number: order.name, action: 'regeneration_triggered' }
    };
  });
  const responseId = await cxSaveResponse(db, ticketId, {
    body: response.body, confidence: response.confidence, reasoning: response.reasoning, data_sources: response.data_sources
  });
  await tracer.trace('post_internal_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, response.noteBody, db, env));
  await tracer.trace('apply_tags', async () => cxApplyZendeskTags(ticketData.zendeskTicketId, ['ai-processed', 'ai-drafted', 'ai-intent-digital_access', 'ai-regeneration-triggered'], db, env));
  await db.prepare(`UPDATE agent_responses SET status = 'posted_as_note', posted_to_zendesk_at = datetime('now') WHERE id = ?`).bind(responseId).run();
  await db.prepare(`UPDATE agent_tickets SET status = 'drafted', final_action = 'internal_note_posted', completed_at = datetime('now') WHERE id = ?`).bind(ticketId).run();
}

// ==========================================================================
// v4.4: BRANDED INTERNAL NOTE FORMAT
// ==========================================================================

function cxFormatNote(kind, opts) {
  // kind: 'reply' (high confidence draft) | 'suggestion' (general AI suggestion)
  //      | 'escalation' (human needed) | 'noise_close' (suggested close)
  const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const parts = [];

  if (kind === 'reply') {
    parts.push(DIVIDER);
    parts.push(`✨ AI SUGGESTED REPLY — confidence ${Math.round((opts.confidence || 0) * 100)}%`);
    parts.push(DIVIDER);
    parts.push('');
    parts.push(opts.body);
    parts.push('');
    parts.push(DIVIDER);
    parts.push('📋 CONTEXT');
    if (opts.contextLines?.length) {
      for (const line of opts.contextLines) parts.push('  • ' + line);
    }
    if (opts.warningLines?.length) {
      parts.push('');
      parts.push('⚠️  WARNINGS / THINGS TO VERIFY:');
      for (const line of opts.warningLines) parts.push('  • ' + line);
    }
    parts.push('');
    parts.push('▸ To use: copy the reply above and paste into a customer-facing reply.');
    parts.push('▸ To reject: reply to customer manually and ignore this suggestion.');
    parts.push(DIVIDER);
  } else if (kind === 'suggestion') {
    parts.push(DIVIDER);
    parts.push(`💡 AI SUGGESTION — review carefully before sending`);
    parts.push(`   Classified as: ${opts.intent} (confidence ${Math.round((opts.confidence || 0) * 100)}%)`);
    parts.push(DIVIDER);
    parts.push('');
    parts.push(opts.body);
    parts.push('');
    parts.push(DIVIDER);
    parts.push('📋 CONTEXT USED');
    if (opts.contextLines?.length) {
      for (const line of opts.contextLines) parts.push('  • ' + line);
    }
    if (opts.articlesUsed?.length) {
      parts.push('');
      parts.push('📚 Help Center articles referenced:');
      for (const art of opts.articlesUsed) {
        parts.push(`  • ${art.title}`);
        if (art.url) parts.push(`    ${art.url}`);
      }
    }
    if (opts.warningLines?.length) {
      parts.push('');
      parts.push('⚠️  REVIEW CAREFULLY:');
      for (const line of opts.warningLines) parts.push('  • ' + line);
    }
    parts.push('');
    parts.push('▸ This is a general suggestion from the AI, not a specialized handler.');
    parts.push('▸ Verify accuracy against the customer\'s specific situation before sending.');
    parts.push(DIVIDER);
  } else if (kind === 'escalation') {
    parts.push(DIVIDER);
    parts.push(`⚠️  AI AGENT — HUMAN REVIEW NEEDED`);
    parts.push(DIVIDER);
    parts.push('');
    parts.push(`Reason: ${opts.reason}`);
    parts.push('');
    parts.push(`Classified as: ${opts.intent || 'unclassified'} (confidence ${Math.round((opts.confidence || 0) * 100)}%)`);
    if (opts.messageSnippet) {
      parts.push('');
      parts.push('Customer said:');
      parts.push(`  "${opts.messageSnippet}"`);
    }
    if (opts.whatITried?.length) {
      parts.push('');
      parts.push('What the AI tried:');
      for (const line of opts.whatITried) parts.push('  • ' + line);
    }
    if (opts.dataFound?.length) {
      parts.push('');
      parts.push('Data found:');
      for (const line of opts.dataFound) parts.push('  • ' + line);
    }
    if (opts.likelyExplanation) {
      parts.push('');
      parts.push(`Likely explanation: ${opts.likelyExplanation}`);
    }
    if (opts.suggestedNextStep) {
      parts.push('');
      parts.push(`Suggested next step: ${opts.suggestedNextStep}`);
    }
    parts.push('');
    parts.push(DIVIDER);
  } else if (kind === 'noise_close') {
    parts.push(DIVIDER);
    parts.push(`🗑️  AI AGENT — RECOMMEND CLOSING WITHOUT REPLY`);
    parts.push(`   Classified as: noise (confidence ${Math.round((opts.confidence || 0) * 100)}%)`);
    parts.push(DIVIDER);
    parts.push('');
    parts.push(`Reason: ${opts.reason || 'This looks like an automated notification, spam, or system-generated message that does not require a response.'}`);
    if (opts.messageSnippet) {
      parts.push('');
      parts.push(`Message preview: ${opts.messageSnippet}`);
    }
    parts.push('');
    parts.push('▸ If this is actually important, reply to customer + remove the `ai-suggests-close` tag.');
    parts.push('▸ Otherwise: close this ticket without reply to train the agent.');
    parts.push(DIVIDER);
  }

  return parts.join('\n');
}

// ==========================================================================
// v4.4: ZENDESK TAGS
// ==========================================================================

async function cxApplyZendeskTags(ticketId, tags, db, env) {
  const applyTags = await cxGetConfig(db, 'apply_zendesk_tags');
  if (!applyTags) return { skipped: true };
  const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  try {
    const resp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}/tags.json`, {
      method: 'PUT',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags })
    });
    return { status: resp.status, ok: resp.ok, tags };
  } catch (err) {
    return { error: err.message, ok: false };
  }
}

// ==========================================================================
// v4.4: ZENDESK HELP CENTER SEARCH
// ==========================================================================

async function cxSearchHelpCenter(query, db, env, maxResults = 3) {
  const enabled = await cxGetConfig(db, 'help_center_enabled');
  if (!enabled) return [];
  const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  try {
    // Help Center has a search API. Unauthenticated for public articles, but auth works too.
    const url = `https://${subdomain}.zendesk.com/api/v2/help_center/articles/search.json?query=${encodeURIComponent(query)}&per_page=${maxResults}`;
    const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).slice(0, maxResults).map(a => ({
      id: a.id,
      title: a.title,
      url: a.html_url,
      // Strip HTML from body to give clean text to Claude
      body: (a.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000)
    }));
  } catch (err) {
    console.error('Help Center search error:', err);
    return [];
  }
}

// ==========================================================================
// v4.4: GENERAL AI SUGGESTION (uses Help Center context)
// ==========================================================================

// v4.6: Few-shot training loop.
// Pulls vetted past human replies for this intent to use as voice/style examples.
// A rating (good/minor/rewrite) means a human has confirmed the captured reply IS the
// gold-standard answer for that ticket — so it's safe to learn Kristine's voice from it.
// 'flag' is excluded (the interaction was problematic). Returns [] until replies are rated,
// so this is a no-op on a cold DB and turns on automatically as ratings accumulate.
async function cxFetchExampleReplies(db, intent, limit = 3) {
  try {
    const rows = await db.prepare(`
      SELECT COALESCE(r.customer_message, t.first_customer_message) AS customer_msg,
             hr.body AS human_reply, hr.rating, hr.rating_note
      FROM agent_human_replies hr
      JOIN agent_tickets t ON t.id = hr.ticket_id
      LEFT JOIN agent_responses r ON r.id = hr.response_id
      WHERE hr.rating IN ('good','minor','rewrite')
        AND t.classified_intent = ?
        AND hr.body IS NOT NULL AND length(trim(hr.body)) > 20
      ORDER BY hr.rated_at DESC
      LIMIT ?
    `).bind(intent, limit).all();
    return rows.results || [];
  } catch (err) {
    console.error('cxFetchExampleReplies error:', err);
    return [];
  }
}

// v4.11: ShipMonk fulfillment state for one order. Tries a live lookup first (freshness
// matters when deciding whether a shipment can still be stopped), falls back to the local
// synced snapshot. ALWAYS reports the source + age so nobody trusts a stale "not shipped".
async function cxShipmonkOrderState(env, orderNumber) {
  const wanted = String(orderNumber || '').replace(/^#/, '').trim();
  if (!wanted) return { found: false, source: 'none', note: 'no order number to look up' };

  // 1) Live: recent ShipMonk orders (cheap — one page, newest first).
  try {
    if (env.SHIPMONK_API_KEY) {
      const data = await smFetch(env, '/orders-list', { method: 'GET', query: { page: 1, pageSize: 100, sortOrder: 'DESC' } });
      const root = data.data || data;
      const items = root.orders || root.items || root.results || (Array.isArray(root) ? root : []);
      const hit = items.map(smMapOrderRow).find(r =>
        String(r.orderNumber || '').replace(/^#/, '').trim() === wanted ||
        String(r.shipmentId || '').replace(/^#/, '').trim() === wanted);
      if (hit) {
        return {
          found: true, source: 'shipmonk_live', age: 'live (just fetched)',
          shipped: !!hit.shipDate, ship_date: hit.shipDate || null,
          processing_status: hit.carrierStatus || null, carrier: hit.carrier || null, service: hit.service || null,
        };
      }
    }
  } catch (e) { /* fall through to the snapshot */ }

  // 2) Snapshot: the cron-synced tpl_orders table (main DB, not CX_AGENT_DB).
  try {
    const row = await env.DB.prepare(
      `SELECT shipment_id, order_number, ship_date, carrier, service, carrier_status, updated_at
       FROM tpl_orders WHERE REPLACE(order_number,'#','') = ? OR REPLACE(shipment_id,'#','') = ? LIMIT 1`
    ).bind(wanted, wanted).first();
    if (row) {
      const ageMin = row.updated_at ? Math.round((Date.now() - new Date(row.updated_at + 'Z').getTime()) / 60000) : null;
      return {
        found: true, source: 'local_snapshot',
        age: ageMin == null ? 'unknown' : `synced ~${ageMin} min ago`,
        shipped: !!row.ship_date, ship_date: row.ship_date || null,
        processing_status: row.carrier_status || null, carrier: row.carrier || null, service: row.service || null,
      };
    }
  } catch (e) { /* no local data */ }

  return { found: false, source: 'none', note: 'order not found in ShipMonk (live or snapshot) — may be digital-only, too old, or never sent to the 3PL' };
}

// v4.11: decide what SHOULD happen for a cancel/refund/return request. Deterministic — code
// decides eligibility from Shopify + ShipMonk state, NOT the LLM. Read-only: proposes, never acts.
function cxBuildOrderActionPlan(order, sm) {
  const money = (v) => `$${Number(v || 0).toFixed(2)}`;
  const fin = String(order.financial_status || '').toLowerCase();
  const ful = String(order.fulfillment_status || '').toLowerCase();
  const evidence = [
    `Shopify ${order.name}: financial=${fin || '—'}, fulfillment=${ful || 'unfulfilled'}, total=${money(order.total_price)}, placed ${order.created_at ? new Date(order.created_at).toLocaleString() : '—'}`,
    sm.found
      ? `ShipMonk: ${sm.shipped ? `SHIPPED ${sm.ship_date}${sm.carrier ? ` via ${sm.carrier}` : ''}` : `not shipped (status: ${sm.processing_status || 'unknown'})`} — source: ${sm.source}, ${sm.age}`
      : `ShipMonk: ${sm.note} — source: none`,
  ];
  const warnings = [];

  // Terminal states first — nothing to do.
  if (order.cancelled_at) {
    return { recommendation: 'no_action', headline: 'Already cancelled — no action needed',
      steps: [`Order ${order.name} was cancelled on ${new Date(order.cancelled_at).toLocaleString()}.`,
              fin === 'refunded' ? 'Already refunded too — just confirm to the customer.' : 'Check whether a refund was issued; if not, that may still be owed.'],
      evidence, warnings };
  }
  if (fin === 'refunded') {
    return { recommendation: 'no_action', headline: 'Already fully refunded — no action needed',
      steps: [`Order ${order.name} shows financial_status=refunded. Confirm the refund to the customer (bank posting can take 5–10 business days).`],
      evidence, warnings };
  }
  if (fin === 'partially_refunded') warnings.push('Order is PARTIALLY refunded — verify what was already returned before refunding again.');
  if (!fin || fin === 'pending' || fin === 'authorized') warnings.push(`Payment status is "${fin || 'unknown'}" — a refund may not apply; a void/cancel may be correct instead.`);

  const physicallyGone = sm.found ? sm.shipped : (ful === 'fulfilled' || ful === 'partial');
  const inFlightAtWarehouse = sm.found && !sm.shipped;

  if (physicallyGone) {
    if (!sm.found) warnings.push('No ShipMonk record — "shipped" inferred from Shopify fulfillment only. Verify in ShipMonk before telling the customer.');
    return { recommendation: 'return_path', headline: 'Too late to cancel — handle as a return',
      steps: [
        `Order ${order.name} has already shipped${sm.ship_date ? ` (${sm.ship_date})` : ''} — it cannot be stopped at the warehouse.`,
        'Confirm the return policy window applies, then issue return instructions / an RMA to the customer.',
        `Refund ${money(order.total_price)} in Shopify only once the return is received (or per policy for damaged items).`,
        'If it is damaged/defective, a replacement may be preferable to a refund — a human should decide.',
      ], evidence, warnings };
  }

  if (inFlightAtWarehouse) {
    return { recommendation: 'cancel_possible', headline: 'Likely still cancellable — act quickly',
      steps: [
        `1. ShipMonk: request a cancel/hold on order ${order.name} (status: ${sm.processing_status || 'unknown'}) BEFORE refunding. If it is already picked/packed this may fail.`,
        `2. Only after ShipMonk confirms the hold, cancel + refund ${money(order.total_price)} in Shopify.`,
        '3. Confirm to the customer once both are done.',
      ],
      evidence,
      warnings: [...warnings, 'Time-sensitive: warehouse state can change within minutes. Re-check ShipMonk immediately before acting.'] };
  }

  // Not in ShipMonk at all and not fulfilled — likely digital-only or not yet routed.
  return { recommendation: 'cancel_possible_digital', headline: 'No warehouse shipment found — likely cancellable in Shopify alone',
    steps: [
      `1. Confirm order ${order.name} has no physical items pending (digital/ebook orders never reach ShipMonk).`,
      `2. Cancel + refund ${money(order.total_price)} in Shopify.`,
      '3. If it contains ebook codes, note that already-redeemed codes may not be recoverable — check before refunding in full.',
    ],
    evidence,
    warnings: [...warnings, 'Order was not found in ShipMonk — verify it is genuinely digital-only rather than a sync gap.'] };
}

// v4.11: gather Shopify + ShipMonk state for a refund/cancel/return request and return a
// proposed action plan. READ-ONLY — it never mutates either system. Shared by the ticket
// pipeline and the /diag/propose-order-action test endpoint.
async function cxProposeOrderAction(ticketData, db, env) {
  const fullText = `${ticketData.subject || ''}\n${ticketData.firstMessage || ''}`;
  const orderNumbers = Array.from(new Set((fullText.match(/#?(\d{1,2}-\d{4,7})/g) || []).map(s => s.replace('#', ''))));
  const found = await cxFindCustomerOrders(ticketData, orderNumbers, db, env);
  const order = found.order || found.orders?.[0] || found.candidates?.[0] || null;
  if (!order) {
    return { ok: false, reason: `no matching Shopify order (lookup: ${found.found_by || 'none'})`, order_numbers_in_message: orderNumbers };
  }
  const sm = await cxShipmonkOrderState(env, order.order_number || order.name);
  const plan = cxBuildOrderActionPlan(order, sm);
  return {
    ok: true,
    order: { name: order.name, order_number: order.order_number, email: order.email, total: order.total_price,
      financial_status: order.financial_status, fulfillment_status: order.fulfillment_status,
      cancelled_at: order.cancelled_at, created_at: order.created_at,
      items: (order.line_items || []).map(li => `${li.quantity}× ${li.title}${li.sku ? ` (${li.sku})` : ''}`) },
    shipmonk: sm,
    plan,
    matched_by: found.found_by,
  };
}

// Render the proposal as an internal-note block appended under the AI's suggested reply.
function cxFormatActionPlan(proposal) {
  const D = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const p = [];
  p.push('');
  p.push(D);
  p.push('🧾 PROPOSED ACTION (human to execute — the AI has changed nothing)');
  if (!proposal.ok) {
    p.push(`   Could not build a plan: ${proposal.reason}`);
    p.push(D);
    return p.join('\n');
  }
  p.push(`   ${proposal.plan.headline}`);
  p.push(D);
  p.push('');
  for (const s of proposal.plan.steps) p.push('  ' + s);
  p.push('');
  p.push('🔎 Evidence used:');
  for (const e of proposal.plan.evidence) p.push('  • ' + e);
  if (proposal.plan.warnings?.length) {
    p.push('');
    p.push('⚠️  Check before acting:');
    for (const w of proposal.plan.warnings) p.push('  • ' + w);
  }
  p.push(D);
  return p.join('\n');
}

// v4.11: verify a draft against the context it was given and STRIP anything unsupported.
// This is the guard against the agent inventing explanations (e.g. describing a promotion it
// has no data for). Verification is a different task than writing, so the model isn't under
// pressure to be helpful/complete — it just checks. Fails OPEN: any error keeps the original
// draft rather than blocking a reply.
async function cxVerifyGrounding(env, db, draft, contextBlocks) {
  const out = { ran: false, stripped: false, unsupported: [], reply: draft };
  if (!draft || (await cxGetConfig(db, 'grounding_check_enabled')) === false) return out;
  try {
    const model = (await cxGetConfig(db, 'classifier_model')) || (await cxGetConfig(db, 'anthropic_model'));
    const sys = `You are a fact-checker for customer support replies at Nurse In The Making. You are given the CONTEXT an assistant had available and the REPLY it wrote. Find every factual claim in the reply that the context does not support.

Flag a claim as unsupported when it asserts something about: a promotion or discount and how it works, pricing, what a product includes, a policy, order status/history, or WHY something happened — and that specific fact does NOT appear in the context.

Also flag hedged speculation about our business ("usually", "typically", "generally", "should be", "most likely") — hedging means the writer was guessing.

Do NOT flag: greetings, empathy, apologies, tone, offers to check with the team, generic encouragement, or restating what the customer themselves said.

Then produce corrected_reply: the same reply with each unsupported claim REMOVED. Preserve the warm tone, greeting and sign-off exactly. Where a claim is removed, if needed add a brief honest line that we want to confirm the details and are checking with the team. Never add new facts.

Return ONLY valid JSON: {"unsupported":[{"claim":"<exact quote>","why":"<short reason>"}],"corrected_reply":"<full corrected reply>"}
If everything is supported, return {"unsupported":[],"corrected_reply":"<reply unchanged>"}.`;
    const user = `CONTEXT AVAILABLE TO THE ASSISTANT:\n\n--- Customer's orders ---\n${contextBlocks.orders || '(none)'}\n\n--- Help Center articles ---\n${(contextBlocks.articles || '(none)').substring(0, 6000)}\n\n--- Product coverage ---\n${contextBlocks.products || '(none)'}\n\n--- Customer's message ---\n${(contextBlocks.customerMessage || '').substring(0, 1500)}\n\nREPLY TO CHECK:\n${draft}`;
    const resp = await cxCallClaude(env, model, sys, user, 2000);
    const parsed = cxExtractJson(resp.content);
    if (!parsed) return out;
    out.ran = true;
    out._tokens = resp.tokens;
    out._cost = resp.cost;
    const unsupported = Array.isArray(parsed.unsupported) ? parsed.unsupported.filter(u => u && u.claim) : [];
    out.unsupported = unsupported;
    // Only swap in the correction when it flagged something AND returned a usable reply.
    if (unsupported.length && typeof parsed.corrected_reply === 'string' && parsed.corrected_reply.trim().length > 40) {
      out.reply = parsed.corrected_reply.trim();
      out.stripped = true;
    }
    return out;
  } catch (err) {
    console.error('cxVerifyGrounding error:', err);
    return out; // fail open
  }
}

// v4.7: find products whose coverage is relevant to a customer's question. Uses the cheap
// classifier model to match by meaning (so "cancer" matches a product tagged "oncology").
// Returns the full coverage_outline for the matched products (capped at `max`).
async function cxFindRelevantProducts(db, env, query, max = 4) {
  const enabled = await cxGetConfig(db, 'product_kb_enabled');
  if (enabled === false) return [];
  const rows = (await db.prepare("SELECT id, name, topics, coverage_outline FROM agent_products WHERE is_active = 1").all()).results || [];
  if (!rows.length) return [];

  const catalog = rows.map(p => {
    let topics = []; try { topics = JSON.parse(p.topics || '[]'); } catch {}
    return `ID ${p.id}: ${p.name}${topics.length ? ` — topics: ${topics.join(', ')}` : ''}`;
  }).join('\n');
  const model = (await cxGetConfig(db, 'classifier_model')) || (await cxGetConfig(db, 'anthropic_model'));
  const sys = `You match a customer's question to relevant products. Given a catalog and a question, return ONLY the IDs of products whose coverage is genuinely relevant (match by meaning — e.g. "cancer" matches a product about "oncology"). Return JSON: {"ids": [1,2]}. If none are relevant, return {"ids": []}.`;
  const user = `Catalog:\n${catalog}\n\nCustomer question:\n${(query || '').substring(0, 1500)}`;
  let ids = [];
  try {
    const resp = await cxCallClaude(env, model, sys, user, 150);
    const parsed = cxExtractJson(resp.content);
    if (Array.isArray(parsed?.ids)) ids = parsed.ids.map(Number);
  } catch {}
  return rows.filter(p => ids.includes(p.id)).slice(0, max);
}

async function cxDraftGeneralSuggestion(ticketId, ticketData, intent, db, env, tracer) {
  // STEP: Look up any orders for context (non-blocking — suggestion works without them)
  const orderContext = await tracer.trace('shopify_context_lookup', async () => {
    if (!ticketData.customerEmail) return { orders: [], note: 'no email' };
    const shopDomain = await cxGetConfig(db, 'shopify_store_domain');
    try {
      const resp = await fetch(
        `https://${shopDomain}/admin/api/2024-01/orders.json?email=${encodeURIComponent(ticketData.customerEmail)}&status=any&limit=5`,
        { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } }
      );
      if (!resp.ok) return { orders: [], note: `api ${resp.status}` };
      const { orders = [] } = await resp.json();
      return {
        orders: orders.slice(0, 5).map(o => ({
          name: o.name,
          created_at: o.created_at,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status,
          total: o.total_price,
          items: (o.line_items || []).map(li => `${li.quantity}× ${li.title}${li.sku ? ` (${li.sku})` : ''}`).join(', ')
        })),
        count: orders.length
      };
    } catch (err) {
      return { orders: [], error: err.message };
    }
  });

  // STEP: Search Help Center for relevant articles
  // For Messaging tickets, the subject is "Conversation with [name]" which is useless for search.
  // Always prefer the actual message body as the search query.
  const maxArticles = await cxGetConfig(db, 'help_center_max_articles') || 3;
  const subjectIsUseful = ticketData.subject && !/^Conversation with /i.test(ticketData.subject);
  const searchQuery = subjectIsUseful
    ? ticketData.subject
    : (ticketData.firstMessage?.substring(0, 200) || ticketData.subject || '');
  const articles = await tracer.trace('help_center_search', async () => {
    const results = await cxSearchHelpCenter(searchQuery, db, env, maxArticles);
    return { count: results.length, titles: results.map(a => a.title), _raw: results };
  });

  // STEP: Pull vetted past human replies for this intent as few-shot voice examples
  const examples = await tracer.trace('training_examples', async () => {
    const rows = await cxFetchExampleReplies(db, intent.intent, 3);
    return { count: rows.length, _rows: rows };
  });

  // STEP: For product/coverage questions, find relevant products from the knowledge base
  const products = await tracer.trace('product_kb_lookup', async () => {
    const productIntents = ['product_info', 'education_content'];
    if (!productIntents.includes(intent.intent)) return { count: 0, _rows: [] };
    const maxP = await cxGetConfig(db, 'product_kb_max_products') || 4;
    const rows = await cxFindRelevantProducts(db, env, `${ticketData.subject || ''}\n${ticketData.firstMessage || ''}`, maxP);
    return { count: rows.length, names: rows.map(r => r.name), _rows: rows };
  });

  // STEP: Draft the response with Claude
  const response = await tracer.trace('draft_suggestion', async () => {
    const model = await cxGetConfig(db, 'anthropic_model');
    // Order of preference for first name:
    //  1) Zendesk requester name (works for email + Messaging — Instagram users have display names too)
    //  2) The customerName field we extracted in the fetch
    //  3) Derive from email
    //  4) Generic "there"
    const customerFirstName = (ticketData.ticket?.requester?.name?.split(' ')[0])
      || (ticketData.customerName?.split(' ')[0])
      || cxFirstNameFromEmail(ticketData.customerEmail);

    const ordersContext = orderContext.orders?.length
      ? orderContext.orders.map(o => `  - Order ${o.name} (${new Date(o.created_at).toLocaleDateString()}): ${o.items}, financial_status=${o.financial_status}, fulfillment=${o.fulfillment_status || 'none'}, total=$${o.total}`).join('\n')
      : '  (no recent orders found on file)';

    const articlesContext = articles._raw?.length
      ? articles._raw.map((a, i) => `[Article ${i+1}] ${a.title}\nURL: ${a.url}\nContent: ${a.body}\n`).join('\n---\n')
      : '(no relevant help center articles found)';

    // Product coverage maps (IP-safe topic outlines) for products relevant to the question.
    const productsContext = products._rows?.length
      ? products._rows.map(p => `### ${p.name}\n${p.coverage_outline}`).join('\n\n')
      : '';

    // Few-shot block: real, human-vetted replies Kristine sent for this same intent.
    // These are the strongest signal for matching her actual voice — when present, they
    // override generic tone rules. Empty until replies are captured + rated.
    const examplesBlock = examples._rows?.length
      ? `\n\nHere are real replies Kristine has sent for "${intent.intent}" tickets. Match this voice, length, and structure closely — these are the gold standard, more authoritative than the generic tone rules above:\n\n` +
        examples._rows.map((ex, i) =>
          `--- Example ${i + 1} ---\nCustomer wrote:\n${(ex.customer_msg || '').substring(0, 600)}\n\nKristine replied:\n${(ex.human_reply || '').substring(0, 1200)}` +
          (ex.rating_note ? `\nReviewer note (a preference/rule to apply going forward): ${ex.rating_note}` : '')
        ).join('\n\n')
      : '';

    const systemPrompt = `You are Kristine, founder of Nurse In The Making (NITM), a nursing education company. Write a helpful customer service reply in Kristine's warm, supportive tone.

Your tone/style rules:
- Open with "Hi [FirstName]," (use their first name) — but for Instagram DMs and other social messaging, "Hi [FirstName]!" with an exclamation feels more natural
- Warm, encouraging, supportive — you care about future nurses succeeding
- Match the empathy level to the customer's situation (if they're frustrated, acknowledge it without being sappy)
- Match the format to the channel: emails can be longer and more structured; Instagram DMs and Facebook messages should be SHORT, casual, and conversational — closer to how a friend texts. No long paragraphs or formal sign-offs in DMs.
- Keep replies concise — get to the answer, don't pad
- For email: close with "Happy studying, future nurse!" followed by "Kristine :)" on its own line
- For DMs/messaging: skip the formal sign-off entirely, or use a brief "💛" or "xx Kristine" — match how the customer wrote to you
- Use product names exactly as written: "The Complete Nursing School Bundle®", "NurseInTheMaking+", "VitalSource Bookshelf"
- Link to Help Center articles inline when relevant using markdown: [article title](url)

Response rules — GROUNDING IS MANDATORY:
- "Provided context" = the customer's orders, the Help Center articles, and the product coverage shown below. That is the ONLY factual source you have.
- Every factual claim about promotions, discounts, pricing, what a product includes, policies, order status, or WHY something happened must be directly supported by the provided context.
- If the context does not support it: DO NOT state it, DO NOT guess, DO NOT reason it out from what seems likely. Say you want to confirm the details and are looping in a teammate.
- NEVER explain how one of our promotions, bundles, discounts, or policies works unless that explanation appears in the provided context. If a customer says "the site said X", acknowledge what they saw, confirm you'll check exactly what happened, and hand off — do not theorize about what X "usually" means.
- BANNED when describing anything about NITM (promos, pricing, policy, what's included): "usually", "typically", "generally", "normally", "should be", "most likely", "I believe", "it may be that". If you feel the need to hedge like this, you do not have the facts — omit the claim and hand off instead.
- DO NOT invent facts, policies, or product details that are not in the provided context.
- DO NOT promise refunds, exceptions, or account changes — say you'll check with the team.
- A shorter reply that admits what you need to check is CORRECT and preferred. Being incomplete is fine; being wrong is not.

Product coverage rules (when a "Product coverage" section is provided below):
- Use it to answer "do your products/materials cover X?" questions — confirm whether the topic is covered and name the specific product it's in
- Describe coverage at a HIGH LEVEL only (e.g. "yes, our Med-Surg guide covers oncology including cancer types and chemo nursing")
- NEVER reproduce the actual study content, definitions, values, mnemonics, or teaching material — that's our intellectual property. Describe what's covered, then encourage them to grab the product
- Keep it short and enticing — enough to answer their question, not so much that you give the material away
- If the product coverage section is empty or doesn't cover their topic, say you're not sure it's included and offer to check

Return ONLY the reply body. No subject line, no JSON, no commentary.${examplesBlock}`;

    const channelLabel = ticketData.isMessagingChannel
      ? `${ticketData.channel} (social DM — keep reply short and casual)`
      : (ticketData.channel || 'email');

    // Some intents need special framing in the prompt
    let intentGuidance = '';
    if (intent.intent === 'social_engagement') {
      intentGuidance = `\n\nNote on intent: 'social_engagement' means the customer is being kind, sharing a positive experience, expressing gratitude, or just engaging with the brand — they are NOT asking for help. Your reply should be a SHORT warm acknowledgment (1-3 sentences max). Do not over-explain, do not link to articles, do not pitch products. Just receive the kindness graciously and reflect their energy back.`;
    } else if (intent.intent === 'refund_cancel' || intent.intent === 'returns_damaged') {
      intentGuidance = `\n\nNote on intent: '${intent.intent}' involves money/policy. Be empathetic but do NOT promise specific refunds, replacements, or exceptions — say you'll check with the team and follow up.`;
    }

    const convoBlock = ticketData.conversationTranscript ? `
---
Conversation so far (this is an ongoing thread — reply to the customer's LATEST message below, in context, without repeating what was already said):
${ticketData.conversationTranscript.slice(0, 5000)}
` : '';

    const userPrompt = `${ticketData.isFollowup ? "Customer's latest reply" : 'Customer message'}:
Channel: ${channelLabel}
Subject: ${ticketData.subject || '(none)'}
From: ${ticketData.customerEmail || '(no email — likely social DM)'}
${ticketData.firstMessage?.substring(0, 2500) || ''}
${convoBlock}
---
This customer's recent orders:
${ordersContext}

---
Help Center articles that might be relevant:
${articlesContext}
${productsContext ? `
---
Product coverage (what our products include — answer "do you cover X?" at a high level, never reproduce the content):
${productsContext}
` : ''}
---
Intent classified as: ${intent.intent} (confidence ${intent.confidence})${intentGuidance}

Write the reply as Kristine.`;

    const claudeResp = await cxCallClaude(env, model, systemPrompt, userPrompt, 1500);
    return {
      body: claudeResp.content.trim(),
      confidence: intent.confidence,
      reasoning: `General AI suggestion for ${intent.intent}`,
      data_sources: {
        intent: intent.intent,
        orders_found: orderContext.orders?.length || 0,
        articles_used: articles._raw?.length || 0,
        training_examples_used: examples._rows?.length || 0,
        products_used: products._rows?.length || 0,
        // Full context used (mirrors the Zendesk note) so Training Review can show it.
        orders: (orderContext.orders || []).slice(0, 5).map(o => ({ name: o.name, date: o.created_at, financial_status: o.financial_status, fulfillment_status: o.fulfillment_status })),
        articles: (articles._raw || []).map(a => ({ title: a.title, url: a.url })),
        products: (products._rows || []).map(p => p.name)
      },
      // Keep the exact context strings so the grounding check verifies against what the
      // drafter actually saw (not a re-derivation).
      _context: { orders: ordersContext, articles: articlesContext, products: productsContext, customerMessage: ticketData.firstMessage || '' },
      _tokens: claudeResp.tokens,
      _cost: claudeResp.cost
    };
  });

  // STEP: Grounding check — strip any claim the context can't support (anti-hallucination)
  const grounding = await tracer.trace('grounding_check', async () => {
    const g = await cxVerifyGrounding(env, db, response.body, response._context || {});
    return { ran: g.ran, stripped: g.stripped, unsupported_count: g.unsupported.length, unsupported: g.unsupported, _reply: g.reply, _tokens: g._tokens, _cost: g._cost };
  });
  if (grounding.stripped && grounding._reply) {
    response.body = grounding._reply;
  }
  response.data_sources = {
    ...response.data_sources,
    grounding: { ran: !!grounding.ran, stripped: !!grounding.stripped, unsupported: grounding.unsupported || [] }
  };

  // STEP: For refund/cancel/return tickets, work out what SHOULD happen in Shopify + ShipMonk
  // and propose it for a human to execute. Read-only — nothing is mutated in either system.
  let actionPlanBlock = '';
  const actionIntents = ['refund_cancel', 'returns_damaged'];
  if (actionIntents.includes(intent.intent) && (await cxGetConfig(db, 'order_action_proposals_enabled')) !== false) {
    const proposal = await tracer.trace('order_action_proposal', async () => {
      const p = await cxProposeOrderAction(ticketData, db, env);
      return { ok: p.ok, recommendation: p.plan?.recommendation, order: p.order?.name, shipmonk_source: p.shipmonk?.source, _proposal: p };
    });
    if (proposal?._proposal) {
      actionPlanBlock = cxFormatActionPlan(proposal._proposal);
      response.data_sources = { ...response.data_sources, action_plan: { recommendation: proposal.recommendation || null, order: proposal.order || null, ok: !!proposal.ok } };
    }
  }

  // STEP: Format as branded internal note
  const contextLines = [];
  if (orderContext.orders?.length) {
    contextLines.push(`Customer has ${orderContext.orders.length} recent order(s) on file`);
    for (const o of orderContext.orders.slice(0, 2)) {
      contextLines.push(`${o.name} (${new Date(o.created_at).toLocaleDateString()}): ${o.financial_status}/${o.fulfillment_status || '—'}`);
    }
  } else {
    contextLines.push('No orders found for this email');
  }
  contextLines.push(`Intent: ${intent.intent} (${Math.round(intent.confidence * 100)}%)`);

  const warningLines = [];
  if (intent.intent === 'refund_cancel' || intent.intent === 'returns_damaged') {
    warningLines.push('This involves a refund/return — verify policy before committing');
  }
  if (intent.confidence < 0.85) {
    warningLines.push('Low confidence classification — re-read the customer message carefully');
  }
  if (!articles._raw?.length) {
    warningLines.push('No Help Center articles matched — answer is from AI general knowledge only');
  }
  if (grounding.stripped) {
    warningLines.push(`Grounding check removed ${grounding.unsupported_count} unsupported claim(s): ` +
      (grounding.unsupported || []).map(u => `"${String(u.claim).substring(0, 120)}"`).join(' · '));
  } else if (grounding.ran) {
    warningLines.push('Grounding check passed — every claim is supported by the data above');
  }

  const noteBody = cxFormatNote('suggestion', {
    body: response.body,
    intent: intent.intent,
    confidence: response.confidence,
    contextLines,
    articlesUsed: articles._raw || [],
    warningLines
  }) + actionPlanBlock;

  const fu = !!ticketData.isFollowup;
  const responseId = await cxSaveResponse(db, ticketId, {
    body: response.body,
    confidence: response.confidence,
    reasoning: response.reasoning,
    data_sources: response.data_sources,
    is_followup: fu,
    turn_number: ticketData.turnNumber || 1,
    customer_message: ticketData.firstMessage ?? null
  });

  // v4.8: autonomous-reply decision. mode = internal_note (draft only) | shadow (decide +
  // tag, still draft) | auto_reply (send when all gates pass, else fall back to a draft).
  const mode = await cxGetConfig(db, 'mode');
  let decision = { pass: false, reason: 'mode=internal_note' };
  const groundingSources = (response.data_sources?.orders_found || 0) + (response.data_sources?.articles_used || 0) + (response.data_sources?.products_used || 0);
  if (ticketData.humanActive) {
    // A teammate owns this ticket — NEVER auto-send over them, regardless of mode/gates.
    decision = { pass: false, reason: 'a teammate has replied on this ticket — suggestion only' };
  } else if (grounding.stripped) {
    // The draft contained claims we couldn't support. A human reads this one.
    decision = { pass: false, reason: `grounding check stripped ${grounding.unsupported_count} unsupported claim(s) — needs human review` };
  } else if (groundingSources === 0) {
    // No orders, no articles, no product coverage — nothing factual to stand on.
    decision = { pass: false, reason: 'no grounding sources (no orders/articles/product coverage) — needs human review' };
  } else if (mode === 'shadow' || mode === 'auto_reply') {
    decision = await tracer.trace('auto_reply_decision', async () => ({ ...(await cxAutoReplyDecision(db, intent.intent, response.confidence)), mode }));
  }

  if (mode === 'auto_reply' && decision.pass) {
    const atags = ['ai-processed', 'ai-auto-replied', `ai-intent-${intent.intent}`]; if (fu) atags.push('ai-followup');
    await tracer.trace('post_public_reply', async () => cxPostPublicReply(ticketData.zendeskTicketId, response.body, db, env));
    await tracer.trace('apply_tags', async () => cxApplyZendeskTags(ticketData.zendeskTicketId, atags, db, env));
    await db.prepare(`UPDATE agent_responses SET status = 'auto_replied', posted_to_zendesk_at = datetime('now') WHERE id = ?`).bind(responseId).run();
    await db.prepare(`UPDATE agent_tickets SET status = 'auto_replied', final_action = ?, completed_at = datetime('now') WHERE id = ?`).bind(fu ? 'followup_auto_replied' : 'auto_replied', ticketId).run();
    return;
  }

  // Otherwise post the draft as a note. In shadow / held cases, prepend a banner showing
  // what the autonomous decision WOULD have been, so you can validate the gates safely.
  let banner = (mode === 'shadow' || mode === 'auto_reply')
    ? `[${mode === 'auto_reply' ? 'AUTO-REPLY HELD' : 'SHADOW'}] Would auto-send: ${decision.pass ? 'YES ✅' : 'NO ⏸'} — ${decision.reason}\n\n`
    : '';
  if (ticketData.humanActive) banner = `👤 A teammate is handling this ticket — this is a suggestion to help, the AI will not send anything here.\n\n` + banner;
  const tags = ['ai-processed', 'ai-suggested', `ai-intent-${intent.intent}`];
  if (mode === 'shadow') tags.push(decision.pass ? 'ai-shadow-would-send' : 'ai-shadow-hold');
  if (fu) tags.push('ai-followup');

  await tracer.trace('post_internal_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, banner + noteBody, db, env));
  await tracer.trace('apply_tags', async () => cxApplyZendeskTags(ticketData.zendeskTicketId, tags, db, env));
  await db.prepare(`UPDATE agent_responses SET status = 'posted_as_note', posted_to_zendesk_at = datetime('now') WHERE id = ?`).bind(responseId).run();
  await db.prepare(`UPDATE agent_tickets SET status = 'drafted', final_action = ?, completed_at = datetime('now') WHERE id = ?`)
    .bind(fu ? 'followup_drafted' : (mode === 'shadow' ? (decision.pass ? 'shadow_would_send' : 'shadow_held') : 'suggestion_posted'), ticketId).run();
}

// ==========================================================================
// v4.4: NOISE CLOSE SUGGESTION
// ==========================================================================

async function cxSuggestClose(ticketId, ticketData, intent, db, env, tracer) {
  const noteBody = cxFormatNote('noise_close', {
    confidence: intent.confidence,
    reason: intent.reasoning,
    messageSnippet: (ticketData.firstMessage || '').substring(0, 200)
  });

  const responseId = await cxSaveResponse(db, ticketId, {
    body: noteBody,
    confidence: intent.confidence,
    reasoning: intent.reasoning || 'Classified as noise',
    data_sources: { intent: 'noise', confidence: intent.confidence }
  });

  await tracer.trace('post_internal_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, noteBody, db, env));
  await tracer.trace('apply_tags', async () => cxApplyZendeskTags(ticketData.zendeskTicketId, ['ai-processed', 'ai-suggests-close'], db, env));

  await db.prepare(`UPDATE agent_responses SET status = 'posted_as_note', posted_to_zendesk_at = datetime('now') WHERE id = ?`).bind(responseId).run();
  await db.prepare(`UPDATE agent_tickets SET status = 'drafted', final_action = 'suggest_close', completed_at = datetime('now') WHERE id = ?`).bind(ticketId).run();
}

// ==========================================================================
// UPDATED: cxEscalate (v4.4 — branded format + tags + show work)
// ==========================================================================

async function cxEscalate(ticketId, ticketData, intent, reason, db, env, tracer, extraData = {}) {
  const response = await tracer.trace('draft_escalation', async () => {
    // Derive "what I tried" from the reason string (simple heuristic)
    const whatITried = [];
    if (reason.includes('order')) {
      whatITried.push(`Looked up Shopify orders by email: ${ticketData.customerEmail || '(no email)'}`);
      if (extraData.explicit_order_number) whatITried.push(`Looked up specific order number: ${extraData.explicit_order_number}`);
      if (extraData.candidate_orders) whatITried.push(`Found ${String(extraData.candidate_orders).split('\n').length - 1} candidate orders (see below)`);
    }
    if (reason.includes('afeguard') || reason.includes('cancel') || reason.includes('refund')) {
      whatITried.push('Ran safeguard checks on the order (cancelled/refunded/age/email)');
    }

    // Build dataFound lines
    const dataFound = [];
    for (const [k, v] of Object.entries(extraData)) {
      if (v !== null && v !== undefined && v !== '') {
        dataFound.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    }

    // Heuristic: likely explanation
    let likelyExplanation = null;
    if (reason.includes('Could not find') && ticketData.firstMessage?.toLowerCase().includes('gift')) {
      likelyExplanation = 'Customer mentions a gift — order was likely placed with a different email than theirs.';
    } else if (reason.includes('Email mismatch')) {
      likelyExplanation = 'Customer may have checked out with a different email (common with PayPal/guest checkout).';
    } else if (reason.includes('cancelled')) {
      likelyExplanation = 'Order was cancelled; codes should NOT be delivered even if customer asks.';
    } else if (reason.includes('Intent not') || reason.includes('No handler') || reason.includes('No handler or suggestion')) {
      likelyExplanation = `Intent '${intent?.intent}' is not in the auto-handle or auto-suggest scope. Human review needed.`;
    }

    let suggestedNextStep = null;
    if (reason.includes('Could not find') && ticketData.firstMessage?.toLowerCase().includes('gift')) {
      suggestedNextStep = 'Ask customer for the order number OR the email used for checkout.';
    } else if (reason.includes('Email mismatch')) {
      suggestedNextStep = 'Verify the customer\'s identity before sending codes. Ask for their order number.';
    } else if (reason.includes('cancelled') || reason.includes('refunded')) {
      suggestedNextStep = 'Reply explaining the order was cancelled/refunded. Do not send codes.';
    }

    const noteBody = cxFormatNote('escalation', {
      intent: intent?.intent,
      confidence: intent?.confidence || 0,
      reason,
      messageSnippet: (ticketData.firstMessage || '').substring(0, 250),
      whatITried: whatITried.length ? whatITried : undefined,
      dataFound: dataFound.length ? dataFound : undefined,
      likelyExplanation,
      suggestedNextStep
    });

    return { body: noteBody, confidence: 1.0, reasoning: reason, data_sources: extraData };
  });

  const responseId = await cxSaveResponse(db, ticketId, response);
  await tracer.trace('post_escalation_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, response.body, db, env));
  await tracer.trace('apply_tags', async () => cxApplyZendeskTags(ticketData.zendeskTicketId, ['ai-processed', 'ai-escalated', intent?.intent ? `ai-intent-${intent.intent}` : 'ai-intent-unknown'], db, env));

  await db.prepare(`UPDATE agent_responses SET status = 'posted_as_note', posted_to_zendesk_at = datetime('now') WHERE id = ?`).bind(responseId).run();
  await db.prepare(`UPDATE agent_tickets SET status = 'escalated', final_action = 'escalated', completed_at = datetime('now') WHERE id = ?`).bind(ticketId).run();
}

async function cxFetchZendeskTicket(ticketId, db, env) {
  const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  const ticketResp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`, { headers: { Authorization: `Basic ${auth}` } });
  if (!ticketResp.ok) return null;
  const { ticket } = await ticketResp.json();
  const commentsResp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}/comments.json`, { headers: { Authorization: `Basic ${auth}` } });
  const { comments = [] } = commentsResp.ok ? await commentsResp.json() : { comments: [] };
  const supportStaffIds = await cxGetConfig(db, 'support_staff_ids');
  const botId = Number(await cxGetConfig(db, 'bot_author_id')) || null;
  // Prefer "authored by the requester" over the hardcoded staff allowlist — that list goes
  // stale as agents come and go, and when it misses one, OUR outbound email was being treated
  // as the customer's message.
  let customerComments = ticket.requester_id
    ? comments.filter(c => c.public && c.author_id === ticket.requester_id)
    : [];
  // Messaging/social tickets (Instagram, chat) attribute the customer's words to a synthetic
  // author (-1) rather than the requester, so the strict match finds nothing. Fall back to
  // "public and not us" so those still get a real first message instead of the
  // "Conversation with X" placeholder.
  if (!customerComments.length) {
    customerComments = comments.filter(c => c.public
      && !supportStaffIds.includes(c.author_id)
      && (botId ? c.author_id !== botId : true));
  }
  // For Messaging tickets, ticket.description is often a placeholder like "Conversation with [name]".
  // Always prefer the first real customer comment if one exists.
  const firstCustomerMessage = customerComments[0]?.plain_body || ticket.description || null;
  // Messaging channels (instagram_dm, native_messaging, sunshine_conversations_*) often have no requester email.
  const channel = ticket.via?.channel ?? null;
  const isMessagingChannel = channel && (channel === 'instagram_dm' || channel === 'native_messaging' || channel.startsWith('sunshine_conversations'));
  return {
    zendeskTicketId: ticketId,
    subject: ticket.subject ?? null,
    customerEmail: ticket.requester?.email ?? ticket.via?.source?.from?.address ?? null,
    customerName: ticket.requester?.name ?? null,
    channel,
    isMessagingChannel,
    firstMessage: firstCustomerMessage,
    status: ticket.status ?? null,
    ticket,
    comments
  };
}

// Resolve (and cache) the Zendesk user id the agent posts as, so we can tell the AI's own
// public replies apart from a real human teammate taking over a ticket.
async function cxGetBotAuthorId(db, env) {
  const cached = await cxGetConfig(db, 'bot_author_id');
  if (cached) return Number(cached);
  try {
    const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
    const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
    const resp = await fetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, { headers: { Authorization: `Basic ${auth}` } });
    if (resp.ok) {
      const { user } = await resp.json();
      if (user?.id) {
        await db.prepare("UPDATE agent_config SET value=?, updated_at=datetime('now') WHERE key='bot_author_id'").bind(String(user.id)).run();
        return Number(user.id);
      }
    }
  } catch {}
  return null;
}

async function cxPostInternalNote(ticketId, body, db, env) {
  const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  const resp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: { comment: { body, public: false } } })
  });
  return { status: resp.status, ok: resp.ok };
}

// v4.8: post a PUBLIC reply to the customer (autonomous send) and set the ticket pending.
async function cxPostPublicReply(ticketId, body, db, env) {
  const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  const resp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: { comment: { body, public: true }, status: 'pending' } })
  });
  return { status: resp.status, ok: resp.ok };
}

// v4.8: decide whether a drafted reply may be auto-sent. Returns {pass, reason, accuracy, sample}.
// Gates: intent on the allowlist, draft confidence over threshold, and a measured per-intent
// accuracy (good+minor share over the last N rated replies) at or above the trust bar.
async function cxAutoReplyDecision(db, intentName, draftConfidence) {
  const allow = (await cxGetConfig(db, 'auto_reply_intents')) || [];
  if (!allow.includes(intentName)) return { pass: false, reason: `intent '${intentName}' not on auto-reply allowlist` };

  const minConf = await cxGetConfig(db, 'min_confidence_to_auto_reply');
  if (typeof draftConfidence === 'number' && draftConfidence < minConf) {
    return { pass: false, reason: `confidence ${draftConfidence} < ${minConf}` };
  }

  const bar = (await cxGetConfig(db, 'auto_reply_accuracy_bar')) ?? 0.9;
  const minSample = (await cxGetConfig(db, 'auto_reply_min_sample')) ?? 25;
  const rows = (await db.prepare(`
    SELECT hr.rating FROM agent_human_replies hr
    JOIN agent_tickets t ON t.id = hr.ticket_id
    WHERE t.classified_intent = ? AND hr.rating IS NOT NULL
    ORDER BY hr.rated_at DESC LIMIT ?
  `).bind(intentName, minSample).all()).results || [];
  const sample = rows.length;
  if (sample < minSample) return { pass: false, reason: `only ${sample}/${minSample} rated samples for '${intentName}'`, sample };
  const goodish = rows.filter(r => r.rating === 'good' || r.rating === 'minor').length;
  const accuracy = goodish / sample;
  if (accuracy < bar) return { pass: false, reason: `accuracy ${(accuracy * 100).toFixed(0)}% < bar ${(bar * 100).toFixed(0)}%`, accuracy, sample };
  return { pass: true, reason: `accuracy ${(accuracy * 100).toFixed(0)}% over ${sample} (bar ${(bar * 100).toFixed(0)}%)`, accuracy, sample };
}

async function cxFindCustomerOrders(ticketData, orderNumbersFound, db, env) {
  const shopDomain = await cxGetConfig(db, 'shopify_store_domain');
  const maxAgeDays = await cxGetConfig(db, 'max_order_age_days');
  const authHeaders = { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN };

  // Path A: Explicit order numbers in ticket — look up each one
  if (orderNumbersFound && orderNumbersFound.length > 0) {
    const foundOrders = [];
    const notFound = [];
    for (const num of orderNumbersFound) {
      const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + num)}&status=any`, { headers: authHeaders });
      if (resp.ok) {
        const { orders } = await resp.json();
        if (orders && orders.length > 0) {
          foundOrders.push(orders[0]);
        } else {
          notFound.push(num);
        }
      } else {
        notFound.push(num);
      }
    }
    return {
      orders: foundOrders,
      candidates: foundOrders,
      order_numbers_not_found: notFound,
      found_by: 'order_numbers'
    };
  }

  // Path B: No order numbers, look up by customer email
  if (!ticketData.customerEmail) {
    return { orders: [], candidates: [], found_by: 'no_email_no_order_number' };
  }

  const resp = await fetch(
    `https://${shopDomain}/admin/api/2024-01/orders.json?email=${encodeURIComponent(ticketData.customerEmail)}&status=any&limit=20`,
    { headers: authHeaders }
  );
  if (!resp.ok) return { orders: [], candidates: [], found_by: 'api_error' };

  const { orders = [] } = await resp.json();
  const cutoffDate = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const ebookOrders = orders.filter(o => {
    const hasEbook = o.line_items?.some(li => li.sku?.startsWith('D-'));
    const recent = new Date(o.created_at).getTime() >= cutoffDate;
    return hasEbook && recent;
  });

  if (ebookOrders.length === 0) {
    const olderEbookOrders = orders.filter(o => o.line_items?.some(li => li.sku?.startsWith('D-')));
    return { orders: [], candidates: olderEbookOrders, found_by: 'no_recent_ebook_orders' };
  }

  if (ebookOrders.length === 1) {
    return { order: ebookOrders[0], orders: ebookOrders, candidates: ebookOrders, found_by: 'single_recent_ebook_order' };
  }

  // Multiple candidates — don't auto-pick
  return { orders: [], candidates: ebookOrders, found_by: 'multiple_candidates' };
}

async function cxFetchOrderMetafields(orderId, db, env) {
  const shopDomain = await cxGetConfig(db, 'shopify_store_domain');
  const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/orders/${orderId}/metafields.json`, { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } });
  if (!resp.ok) return [];
  const { metafields = [] } = await resp.json();
  return metafields;
}

// Per-MTok pricing keyed by model family. Used for accurate cost logging once we run
// different models for different steps (Haiku classifier vs Opus drafter).
function cxModelPricing(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus'))   return { in: 15e-6, out: 75e-6 };
  if (m.includes('haiku'))  return { in: 1e-6,  out: 5e-6  };
  if (m.includes('sonnet')) return { in: 3e-6,  out: 15e-6 };
  return { in: 15e-6, out: 75e-6 }; // safe default = Opus
}

async function cxCallClaude(env, model, systemPrompt, userPrompt, maxTokens = 1024) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      // System prompt as a cacheable block. Caching is a no-op below the model's
      // cache minimum (~1024 tok), but kicks in once prompts grow (e.g. few-shot examples).
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!resp.ok) { const errText = await resp.text(); throw new Error(`Claude API error ${resp.status}: ${errText}`); }
  const data = await resp.json();
  const content = data.content?.[0]?.text || '';
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const cacheWriteTokens = data.usage?.cache_creation_input_tokens || 0;
  const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;
  const p = cxModelPricing(model);
  // Cache writes cost 1.25× input, cache reads cost 0.1× input.
  const cost = (inputTokens * p.in) + (outputTokens * p.out)
    + (cacheWriteTokens * p.in * 1.25) + (cacheReadTokens * p.in * 0.1);
  return {
    content,
    tokens: inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
    inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, cost
  };
}

// Turn raw product text (extracted from an uploaded PDF) into an IP-SAFE coverage map:
// a topic/chapter-level outline of WHAT is covered, with no actual study content. This is
// the only thing we store + ever feed the drafter, so IP can't leak.
async function cxExtractProductCoverage(env, db, name, text) {
  const model = (await cxGetConfig(db, 'product_extract_model')) || (await cxGetConfig(db, 'anthropic_model'));
  const systemPrompt = `You build an IP-SAFE "coverage map" for a nursing-education product sold by Nurse In The Making. The goal: let customer support confirm WHAT TOPICS a product covers, WITHOUT exposing the actual study content.

CRITICAL — never include actual teaching material: no definitions, explanations, full sentences of content, lab values, dosages, mnemonics, or step-by-step processes. Only topic LABELS — the kind of thing you'd see in a detailed table of contents.

Produce two things:
1. "coverage_outline": a concise markdown outline of what the product covers — sections/chapters with the topics inside each as short labels. Example line:
   "- **Oncology & Cancer Care**: cancer types, TNM staging, chemotherapy nursing, common cancers, side-effect management"
   Keep it scannable. Topic labels only — NOT the material itself.
2. "topics": a flat array of 15–40 lowercase search keywords customers might use, INCLUDING synonyms (e.g. both "cancer" and "oncology", "heart" and "cardiac").

Return ONLY valid JSON: {"coverage_outline": "...markdown...", "topics": ["...", ...]}`;
  // ~600k chars ≈ 150k tokens — fits a full ~300-page text book in Opus's context in one call.
  const userPrompt = `Product name: ${name}\n\nProduct content (may be truncated):\n${(text || '').substring(0, 600000)}`;
  const resp = await cxCallClaude(env, model, systemPrompt, userPrompt, 3000);
  const parsed = cxExtractJson(resp.content);
  return {
    coverage_outline: parsed?.coverage_outline || '',
    topics: Array.isArray(parsed?.topics) ? parsed.topics : [],
    _tokens: resp.tokens,
    _cost: resp.cost
  };
}

function cxAbToBase64(buf) {
  const bytes = new Uint8Array(buf); let binary = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(binary);
}

async function cxDeleteJobChunks(env, jobId) {
  if (!env.CX_UPLOADS) return;
  const list = await env.CX_UPLOADS.list({ prefix: `job/${jobId}/` });
  for (const o of list.objects) { try { await env.CX_UPLOADS.delete(o.key); } catch {} }
}

// Cron worker: advance background product-extraction jobs. Reads a few chunk PDFs per tick
// via Claude native PDF (sees images at full quality), accumulates partials, and on the last
// chunk merges + saves the product. A recency lock prevents overlapping ticks double-processing.
async function processProductJobs(env) {
  const db = env.CX_AGENT_DB;
  if (!db || !env.CX_UPLOADS) return;
  const CHUNKS_PER_TICK = 3;
  await initCxAgentTables(db);

  // Pick one queued job, or a stalled in-progress one (>5 min since last update).
  const job = await db.prepare(`
    SELECT * FROM agent_product_jobs
    WHERE status = 'pending' OR (status = 'processing' AND updated_at < datetime('now','-5 minutes'))
    ORDER BY id ASC LIMIT 1
  `).first();
  if (!job) return;

  await db.prepare("UPDATE agent_product_jobs SET status='processing', updated_at=datetime('now') WHERE id = ?").bind(job.id).run();

  let partials = []; try { partials = JSON.parse(job.partials || '[]'); } catch {}
  let topics = []; try { topics = JSON.parse(job.topics || '[]'); } catch {}
  let done = job.done_chunks || 0;
  const model = (await cxGetConfig(db, 'product_extract_model')) || (await cxGetConfig(db, 'anthropic_model'));

  try {
    const end = Math.min(done + CHUNKS_PER_TICK, job.total_chunks);
    for (let i = done; i < end; i++) {
      const obj = await env.CX_UPLOADS.get(`job/${job.id}/chunk/${i}.pdf`);
      if (!obj) throw new Error(`missing chunk ${i}`);
      const b64 = cxAbToBase64(await obj.arrayBuffer());
      const sys = `You are reading pages from a nursing-education product to build an IP-SAFE coverage map. For THESE pages only, list the sections/topics covered as short topic labels (table-of-contents style). NEVER reproduce actual study content, definitions, lab values, dosages, mnemonics, or full sentences. Return ONLY valid JSON: {"partial_outline":"...markdown bullets...","topics":["lowercase","keywords"]}`;
      const content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: `Product: ${job.name} — chunk ${i + 1}/${job.total_chunks}. Extract the IP-safe topics covered on these pages.` }
      ];
      const resp = await cxCallClaude(env, model, sys, content, 2000);
      const parsed = cxExtractJson(resp.content);
      if (parsed?.partial_outline) partials.push(parsed.partial_outline);
      if (Array.isArray(parsed?.topics)) topics.push(...parsed.topics);
      done = i + 1;
      await db.prepare("UPDATE agent_product_jobs SET done_chunks=?, partials=?, topics=?, updated_at=datetime('now') WHERE id=?")
        .bind(done, JSON.stringify(partials), JSON.stringify([...new Set(topics)]), job.id).run();
    }

    if (done >= job.total_chunks) {
      // All chunks read — merge into one clean map and save the product.
      await db.prepare("UPDATE agent_product_jobs SET status='merging', updated_at=datetime('now') WHERE id=?").bind(job.id).run();
      const sys = `You merge partial coverage notes (read in page order from one product) into ONE clean, deduplicated IP-SAFE coverage map. Organize by section/chapter with short topic labels — a detailed table of contents, NOT the actual content. NEVER include definitions, values, mnemonics, or teaching material. Return ONLY valid JSON: {"coverage_outline":"...markdown...","topics":["..."]}`;
      const user = `Product: ${job.name}\n\nPartial coverage notes (page order):\n${partials.join('\n\n')}\n\nCandidate topic keywords: ${[...new Set(topics)].join(', ')}`;
      const resp = await cxCallClaude(env, model, sys, user, 4000);
      const merged = cxExtractJson(resp.content) || {};
      const ins = await db.prepare(`INSERT INTO agent_products (name, source_filename, coverage_outline, topics, is_active) VALUES (?, ?, ?, ?, 1)`)
        .bind(job.name, job.source_filename ?? null, merged.coverage_outline || partials.join('\n\n'), JSON.stringify(Array.isArray(merged.topics) ? merged.topics : [...new Set(topics)])).run();
      await db.prepare("UPDATE agent_product_jobs SET status='done', product_id=?, updated_at=datetime('now') WHERE id=?").bind(ins.meta.last_row_id, job.id).run();
      await cxDeleteJobChunks(env, job.id);
    }
  } catch (err) {
    await db.prepare("UPDATE agent_product_jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?").bind(String(err.message).slice(0, 500), job.id).run();
  }
}

async function verifyZendeskSignature(body, timestamp, signature, secret) {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(timestamp + body));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return expected === signature;
  } catch (err) { console.error('Signature verification error:', err); return false; }
}

class CxTracer {
  constructor(db, ticketId) { this.db = db; this.ticketId = ticketId; this.stepOrder = 0; }
  async trace(stepName, fn, opts = {}) {
    this.stepOrder++;
    const startTime = Date.now();
    let output = null, status = 'success', errorMsg = null;
    try { output = await fn(); }
    catch (err) { status = 'error'; errorMsg = err.message; throw err; }
    finally {
      const duration = Date.now() - startTime;
      try {
        await this.db.prepare(`INSERT INTO agent_decisions (ticket_id, step_name, step_order, output_data, duration_ms, tokens_used, cost_usd, status, error_message, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(this.ticketId, stepName, this.stepOrder, output ? JSON.stringify(output).substring(0, 10000) : null, duration, output?._tokens || 0, output?._cost || 0, opts.status || status, errorMsg, output?.reasoning || null).run();
      } catch (e) { console.error('Failed to write trace:', e); }
    }
    return output;
  }
}

async function cxGetConfig(db, key) {
  const row = await db.prepare('SELECT value, value_type FROM agent_config WHERE key = ?').bind(key).first();
  if (!row) return null;
  if (row.value_type === 'boolean') return row.value === 'true';
  if (row.value_type === 'number') return parseFloat(row.value);
  if (row.value_type === 'json') { try { return JSON.parse(row.value); } catch { return null; } }
  return row.value;
}
async function cxGetTemplate(db, intent) {
  return await db.prepare('SELECT * FROM agent_templates WHERE intent = ? AND is_active = 1 LIMIT 1').bind(intent).first();
}
async function cxSaveResponse(db, ticketId, response) {
  const result = await db.prepare(`INSERT INTO agent_responses (ticket_id, draft_body, response_confidence, reasoning, data_sources, is_followup, turn_number, customer_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ticketId, response.body, response.confidence, response.reasoning, JSON.stringify(response.data_sources || {}),
      response.is_followup ? 1 : 0, response.turn_number || 1, response.customer_message ?? null).run();
  return result.meta.last_row_id;
}
function cxExtractJson(text) {
  if (!text) return null;
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch {} }
  const rawMatch = text.match(/\{[\s\S]*\}/);
  if (rawMatch) { try { return JSON.parse(rawMatch[0]); } catch {} }
  return null;
}
function cxFirstNameFromEmail(email) {
  if (!email) return 'there';
  const localPart = email.split('@')[0];
  const firstName = localPart.split(/[._-]/)[0];
  return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
}

async function handleCxAgentAPI(request, env, path) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!env.CX_AGENT_DB) return new Response(JSON.stringify({ error: "CX_AGENT_DB not configured" }), { status: 500, headers: cors });

  const db = env.CX_AGENT_DB;
  await initCxAgentTables(db);

  try {
    if (path === '/cx-agent/api/tickets' && request.method === 'GET') {
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const status = url.searchParams.get('status');
      let query = `SELECT * FROM agent_tickets`;
      const params = [];
      if (status) { query += ` WHERE status = ?`; params.push(status); }
      query += ` ORDER BY received_at DESC LIMIT ?`;
      params.push(limit);
      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ tickets: result.results }), { headers: cors });
    }

    const ticketMatch = path.match(/^\/cx-agent\/api\/tickets\/(\d+)$/);
    if (ticketMatch && request.method === 'GET') {
      const ticketId = parseInt(ticketMatch[1]);
      const ticket = await db.prepare('SELECT * FROM agent_tickets WHERE id = ?').bind(ticketId).first();
      if (!ticket) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: cors });
      const decisions = await db.prepare('SELECT * FROM agent_decisions WHERE ticket_id = ? ORDER BY step_order').bind(ticketId).all();
      const responses = await db.prepare('SELECT * FROM agent_responses WHERE ticket_id = ? ORDER BY created_at').bind(ticketId).all();
      return new Response(JSON.stringify({ ticket, decisions: decisions.results, responses: responses.results }), { headers: cors });
    }

    if (path === '/cx-agent/api/stats' && request.method === 'GET') {
      const [total, byStatus, byIntent, last24h, costs] = await db.batch([
        db.prepare('SELECT COUNT(*) as c FROM agent_tickets'),
        db.prepare("SELECT status, COUNT(*) as c FROM agent_tickets GROUP BY status"),
        db.prepare("SELECT classified_intent, COUNT(*) as c FROM agent_tickets WHERE classified_intent IS NOT NULL GROUP BY classified_intent ORDER BY c DESC"),
        db.prepare("SELECT COUNT(*) as c FROM agent_tickets WHERE received_at > datetime('now', '-1 day')"),
        db.prepare("SELECT SUM(cost_usd) as total_cost, SUM(tokens_used) as total_tokens FROM agent_decisions WHERE created_at > datetime('now', '-30 days')"),
      ]);
      return new Response(JSON.stringify({
        total: total.results[0]?.c || 0,
        by_status: byStatus.results,
        by_intent: byIntent.results,
        last_24h: last24h.results[0]?.c || 0,
        cost_30d: costs.results[0]?.total_cost || 0,
        tokens_30d: costs.results[0]?.total_tokens || 0
      }), { headers: cors });
    }

    if (path === '/cx-agent/api/config' && request.method === 'GET') {
      const result = await db.prepare('SELECT * FROM agent_config ORDER BY key').all();
      return new Response(JSON.stringify({ config: result.results }), { headers: cors });
    }
    if (path === '/cx-agent/api/config' && request.method === 'POST') {
      const body = await request.json();
      if (!body.key) return new Response(JSON.stringify({ error: 'Missing key' }), { status: 400, headers: cors });
      await db.prepare("UPDATE agent_config SET value = ?, updated_at = datetime('now') WHERE key = ?").bind(String(body.value), body.key).run();
      return new Response(JSON.stringify({ updated: true, key: body.key, value: body.value }), { headers: cors });
    }

    if (path === '/cx-agent/api/templates' && request.method === 'GET') {
      const result = await db.prepare('SELECT * FROM agent_templates WHERE is_active = 1 ORDER BY intent').all();
      return new Response(JSON.stringify({ templates: result.results }), { headers: cors });
    }
    const tplMatch = path.match(/^\/cx-agent\/api\/templates\/(\d+)$/);
    if (tplMatch && request.method === 'POST') {
      const body = await request.json();
      await db.prepare("UPDATE agent_templates SET body = ?, updated_at = datetime('now') WHERE id = ?").bind(body.body, parseInt(tplMatch[1])).run();
      return new Response(JSON.stringify({ updated: true }), { headers: cors });
    }

    // ==========================================================================
    // v4.7: PRODUCT KNOWLEDGE BASE APIs
    // ==========================================================================

    // GET /cx-agent/api/products  — list all products (coverage maps, not raw content)
    if (path === '/cx-agent/api/products' && request.method === 'GET') {
      const result = await db.prepare('SELECT * FROM agent_products ORDER BY name').all();
      return new Response(JSON.stringify({ products: result.results || [] }), { headers: cors });
    }

    // POST /cx-agent/api/products/extract — { name, text }  (text = PDF text extracted client-side)
    // Runs Claude to produce an IP-safe coverage outline + topic keywords. Does NOT save —
    // the UI shows it for review/edit first.
    if (path === '/cx-agent/api/products/extract' && request.method === 'POST') {
      const body = await request.json();
      if (!body.text || !body.text.trim()) return new Response(JSON.stringify({ error: 'text required' }), { status: 400, headers: cors });
      const extracted = await cxExtractProductCoverage(env, db, body.name || '(untitled)', body.text);
      return new Response(JSON.stringify(extracted), { headers: cors });
    }

    // POST /cx-agent/api/products/vision-batch — { name, images:[base64 jpeg], batch, totalBatches }
    // Reads a batch of page IMAGES (for image-heavy/scanned PDFs) and returns the IP-safe
    // topics covered on those pages. The browser loops batches, then calls vision-merge.
    if (path === '/cx-agent/api/products/vision-batch' && request.method === 'POST') {
      const body = await request.json();
      if (!Array.isArray(body.images) || !body.images.length) return new Response(JSON.stringify({ error: 'images required' }), { status: 400, headers: cors });
      const model = (await cxGetConfig(db, 'product_extract_model')) || (await cxGetConfig(db, 'anthropic_model'));
      const sys = `You are reading page images from a nursing-education product to build an IP-SAFE coverage map. For THESE pages only, list the sections/topics covered as short topic labels (table-of-contents style). NEVER reproduce actual study content, definitions, lab values, dosages, mnemonics, or full sentences of material. Return ONLY valid JSON: {"partial_outline":"...markdown bullets of topic labels...","topics":["lowercase","keywords"]}`;
      const content = body.images.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }));
      content.push({ type: 'text', text: `Product: ${body.name || ''} — batch ${body.batch}/${body.totalBatches}. Extract the IP-safe topics covered on these pages.` });
      const resp = await cxCallClaude(env, model, sys, content, 2000);
      const parsed = cxExtractJson(resp.content);
      return new Response(JSON.stringify({ partial_outline: parsed?.partial_outline || '', topics: Array.isArray(parsed?.topics) ? parsed.topics : [] }), { headers: cors });
    }

    // POST /cx-agent/api/products/vision-merge — { name, partials:[string], topics:[string] }
    // Merges the per-batch partial outlines into one clean, deduped coverage map.
    if (path === '/cx-agent/api/products/vision-merge' && request.method === 'POST') {
      const body = await request.json();
      const model = (await cxGetConfig(db, 'product_extract_model')) || (await cxGetConfig(db, 'anthropic_model'));
      const sys = `You merge partial coverage notes (read page-by-page from one product) into ONE clean, deduplicated IP-SAFE coverage map. Organize by section/chapter with short topic labels — a detailed table of contents, NOT the actual content. NEVER include definitions, values, mnemonics, or teaching material. Return ONLY valid JSON: {"coverage_outline":"...markdown...","topics":["..."]}`;
      const user = `Product: ${body.name || ''}\n\nPartial coverage notes (in page order):\n${(body.partials || []).join('\n\n')}\n\nCandidate topic keywords: ${(body.topics || []).join(', ')}`;
      const resp = await cxCallClaude(env, model, sys, user, 4000);
      const parsed = cxExtractJson(resp.content);
      return new Response(JSON.stringify({ coverage_outline: parsed?.coverage_outline || '', topics: Array.isArray(parsed?.topics) ? parsed.topics : [] }), { headers: cors });
    }

    // POST /cx-agent/api/products — create or update. Body: { id?, name, sku?, description?,
    //   coverage_outline, topics?(array|json string), version? }
    if (path === '/cx-agent/api/products' && request.method === 'POST') {
      const body = await request.json();
      if (!body.name || !body.coverage_outline) {
        return new Response(JSON.stringify({ error: 'name and coverage_outline required' }), { status: 400, headers: cors });
      }
      const topicsJson = Array.isArray(body.topics) ? JSON.stringify(body.topics) : (body.topics || '[]');
      if (body.id) {
        await db.prepare(`UPDATE agent_products SET name=?, sku=?, description=?, coverage_outline=?, topics=?, version=?, is_active=?, updated_at=datetime('now') WHERE id=?`)
          .bind(body.name, body.sku ?? null, body.description ?? null, body.coverage_outline, topicsJson, body.version ?? null, body.is_active === false ? 0 : 1, parseInt(body.id)).run();
        return new Response(JSON.stringify({ updated: true, id: parseInt(body.id) }), { headers: cors });
      }
      const res = await db.prepare(`INSERT INTO agent_products (name, sku, description, coverage_outline, topics, source_filename, version, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(body.name, body.sku ?? null, body.description ?? null, body.coverage_outline, topicsJson, body.source_filename ?? null, body.version ?? null, body.is_active === false ? 0 : 1).run();
      return new Response(JSON.stringify({ created: true, id: res.meta.last_row_id }), { headers: cors });
    }

    // POST /cx-agent/api/products/:id/delete
    const prodDelMatch = path.match(/^\/cx-agent\/api\/products\/(\d+)\/delete$/);
    if (prodDelMatch && request.method === 'POST') {
      await db.prepare('DELETE FROM agent_products WHERE id = ?').bind(parseInt(prodDelMatch[1])).run();
      return new Response(JSON.stringify({ deleted: true }), { headers: cors });
    }

    // ===== v4.9: background extraction jobs (browser splits PDF -> chunks in R2 -> cron reads) =====

    // POST /cx-agent/api/products/job/start  { name, source_filename, total_chunks, total_pages }
    if (path === '/cx-agent/api/products/job/start' && request.method === 'POST') {
      const body = await request.json();
      if (!body.name || !body.total_chunks) return new Response(JSON.stringify({ error: 'name and total_chunks required' }), { status: 400, headers: cors });
      const res = await db.prepare(`INSERT INTO agent_product_jobs (name, source_filename, total_chunks, total_pages, status) VALUES (?, ?, ?, ?, 'uploading')`)
        .bind(body.name, body.source_filename ?? null, parseInt(body.total_chunks), body.total_pages ?? null).run();
      return new Response(JSON.stringify({ job_id: res.meta.last_row_id }), { headers: cors });
    }

    // PUT /cx-agent/api/products/job/:id/chunk/:n   (raw application/pdf body) -> store in R2
    const chunkMatch = path.match(/^\/cx-agent\/api\/products\/job\/(\d+)\/chunk\/(\d+)$/);
    if (chunkMatch && request.method === 'PUT') {
      if (!env.CX_UPLOADS) return new Response(JSON.stringify({ error: 'R2 not configured' }), { status: 500, headers: cors });
      const bytes = await request.arrayBuffer();
      await env.CX_UPLOADS.put(`job/${chunkMatch[1]}/chunk/${chunkMatch[2]}.pdf`, bytes);
      return new Response(JSON.stringify({ stored: true }), { headers: cors });
    }

    // POST /cx-agent/api/products/job/:id/ready  -> all chunks uploaded, hand off to cron
    const readyMatch = path.match(/^\/cx-agent\/api\/products\/job\/(\d+)\/ready$/);
    if (readyMatch && request.method === 'POST') {
      await db.prepare("UPDATE agent_product_jobs SET status = 'pending', updated_at = datetime('now') WHERE id = ?").bind(parseInt(readyMatch[1])).run();
      return new Response(JSON.stringify({ queued: true }), { headers: cors });
    }

    // GET /cx-agent/api/products/jobs  -> active + recently finished jobs (for status display)
    if (path === '/cx-agent/api/products/jobs' && request.method === 'GET') {
      const rows = (await db.prepare(`SELECT id, name, source_filename, total_chunks, done_chunks, total_pages, status, product_id, error, updated_at FROM agent_product_jobs WHERE status != 'done' OR updated_at > datetime('now','-1 day') ORDER BY id DESC LIMIT 30`).all()).results || [];
      return new Response(JSON.stringify({ jobs: rows }), { headers: cors });
    }

    // POST /cx-agent/api/products/job/:id/cancel  -> delete job + its R2 chunks
    const jobCancelMatch = path.match(/^\/cx-agent\/api\/products\/job\/(\d+)\/cancel$/);
    if (jobCancelMatch && request.method === 'POST') {
      const jobId = parseInt(jobCancelMatch[1]);
      await db.prepare("DELETE FROM agent_product_jobs WHERE id = ?").bind(jobId).run();
      if (env.CX_UPLOADS) { try { await cxDeleteJobChunks(env, jobId); } catch {} }
      return new Response(JSON.stringify({ cancelled: true }), { headers: cors });
    }

    // ==========================================================================
    // v4.5: TRAINING REVIEW APIs
    // ==========================================================================

    // GET /cx-agent/api/training/list?limit=50&filter=needs_review|all|rated
    // Returns tickets that have a draft AND a captured human reply, joined with rating.
    if (path === '/cx-agent/api/training/list' && request.method === 'GET') {
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const filter = url.searchParams.get('filter') || 'needs_review';
      const intent = url.searchParams.get('intent') || null;

      // Conversation-grouped: (A) pick the most-recent tickets that have a captured reply
      // matching the filter, then (B) return ALL their turns so each renders as one thread.
      let aWhere = '1=1';
      const aParams = [];
      if (filter === 'needs_review') aWhere += ' AND hr.rating IS NULL';
      if (filter === 'rated') aWhere += ' AND hr.rating IS NOT NULL';
      if (intent) { aWhere += ' AND t.classified_intent = ?'; aParams.push(intent); }
      aParams.push(limit);
      const idsRes = await db.prepare(`
        SELECT hr.ticket_id, MAX(hr.reply_created_at) AS last_reply
        FROM agent_human_replies hr JOIN agent_tickets t ON t.id = hr.ticket_id
        WHERE ${aWhere}
        GROUP BY hr.ticket_id ORDER BY last_reply DESC LIMIT ?
      `).bind(...aParams).all();
      const orderedIds = (idsRes.results || []).map(r => r.ticket_id);
      if (!orderedIds.length) return new Response(JSON.stringify({ conversations: [] }), { headers: cors });

      // Spine on the AI drafts so EVERY turn shows (initial + follow-ups), with the
      // captured human reply attached where one exists.
      const ph = orderedIds.map(() => '?').join(',');
      const turnsRes = await db.prepare(`
        SELECT
          t.id as ticket_id, t.zendesk_ticket_id, t.subject, t.customer_email, t.channel,
          t.classified_intent, t.intent_confidence, t.received_at,
          r.id as response_id,
          COALESCE(r.customer_message, t.first_customer_message) as customer_message,
          r.draft_body as agent_draft, r.response_confidence as draft_confidence, r.data_sources,
          COALESCE(r.is_followup, 0) as is_followup, COALESCE(r.turn_number, 1) as turn_number,
          hr.id as reply_id, hr.body as human_reply, hr.author_name, hr.reply_created_at,
          hr.rating, hr.rating_note, hr.rated_by, hr.rated_at
        FROM agent_responses r
        JOIN agent_tickets t ON t.id = r.ticket_id
        LEFT JOIN agent_human_replies hr ON hr.response_id = r.id
        WHERE r.ticket_id IN (${ph})
        ORDER BY COALESCE(r.turn_number, 1) ASC, r.created_at ASC
      `).bind(...orderedIds).all();

      // Group by ticket, deduping any response that matched multiple replies (prefer a rated one).
      const byTicket = {};
      for (const row of (turnsRes.results || [])) {
        const arr = byTicket[row.ticket_id] = byTicket[row.ticket_id] || [];
        const existing = arr.find(x => x.response_id === row.response_id);
        if (!existing) arr.push(row);
        else if (!existing.rating && row.rating) Object.assign(existing, row);
      }
      const conversations = orderedIds.filter(id => byTicket[id]).map(id => {
        const ts = byTicket[id]; const h = ts[0];
        return {
          ticket_id: id, zendesk_ticket_id: h.zendesk_ticket_id, subject: h.subject,
          customer_email: h.customer_email, classified_intent: h.classified_intent,
          intent_confidence: h.intent_confidence, received_at: h.received_at, turns: ts
        };
      });
      return new Response(JSON.stringify({ conversations }), { headers: cors });
    }

    // POST /cx-agent/api/training/rate
    // Body: { reply_id, rating: 'good'|'minor'|'rewrite'|'flag', rating_note?, rated_by? }
    if (path === '/cx-agent/api/training/rate' && request.method === 'POST') {
      const body = await request.json();
      if (!body.reply_id) {
        return new Response(JSON.stringify({ error: 'reply_id required' }), { status: 400, headers: cors });
      }
      const allowed = ['good', 'minor', 'rewrite', 'flag', null];
      const rating = body.rating ?? null;
      if (!allowed.includes(rating)) {
        return new Response(JSON.stringify({ error: 'invalid rating' }), { status: 400, headers: cors });
      }
      const replyId = parseInt(body.reply_id);
      const hasNote = Object.prototype.hasOwnProperty.call(body, 'rating_note');

      if (rating === null) {
        // Unrate: clear rating + timestamps so it returns to "Needs review". Keep the note.
        await db.prepare(`UPDATE agent_human_replies SET rating = NULL, rated_by = NULL, rated_at = NULL WHERE id = ?`)
          .bind(replyId).run();
      } else if (hasNote) {
        // Only touch rating_note when the caller sends one, so changing just a rating
        // never wipes an existing note.
        await db.prepare(`UPDATE agent_human_replies SET rating = ?, rating_note = ?, rated_by = ?, rated_at = datetime('now') WHERE id = ?`)
          .bind(rating, body.rating_note, body.rated_by ?? 'unknown', replyId).run();
      } else {
        await db.prepare(`UPDATE agent_human_replies SET rating = ?, rated_by = ?, rated_at = datetime('now') WHERE id = ?`)
          .bind(rating, body.rated_by ?? 'unknown', replyId).run();
      }
      return new Response(JSON.stringify({ updated: true }), { headers: cors });
    }

    // POST /cx-agent/api/training/manual-reply
    // Body: { ticket_id (agent ticket id), body, author_name? }
    // Used when auto-capture grabbed the wrong comment or didn't fire.
    if (path === '/cx-agent/api/training/manual-reply' && request.method === 'POST') {
      const body = await request.json();
      if (!body.ticket_id || !body.body) {
        return new Response(JSON.stringify({ error: 'ticket_id and body required' }), { status: 400, headers: cors });
      }
      const ticket = await db.prepare("SELECT zendesk_ticket_id FROM agent_tickets WHERE id = ?").bind(parseInt(body.ticket_id)).first();
      if (!ticket) return new Response(JSON.stringify({ error: 'ticket not found' }), { status: 404, headers: cors });

      await db.prepare(`
        INSERT INTO agent_human_replies (ticket_id, zendesk_ticket_id, body, author_name, reply_created_at, source)
        VALUES (?, ?, ?, ?, datetime('now'), 'manual')
      `).bind(parseInt(body.ticket_id), ticket.zendesk_ticket_id, body.body, body.author_name ?? null).run();
      return new Response(JSON.stringify({ saved: true }), { headers: cors });
    }

    // POST /cx-agent/api/training/capture-now
    // Body: { ticket_id (agent ticket id) }
    // Manually trigger the capture for a ticket — useful for backfilling existing tickets.
    if (path === '/cx-agent/api/training/capture-now' && request.method === 'POST') {
      const body = await request.json();
      if (!body.ticket_id) return new Response(JSON.stringify({ error: 'ticket_id required' }), { status: 400, headers: cors });
      const ticket = await db.prepare("SELECT id, zendesk_ticket_id FROM agent_tickets WHERE id = ?").bind(parseInt(body.ticket_id)).first();
      if (!ticket) return new Response(JSON.stringify({ error: 'ticket not found' }), { status: 404, headers: cors });
      await captureHumanReply(ticket.id, ticket.zendesk_ticket_id, db, env);
      return new Response(JSON.stringify({ captured: true }), { headers: cors });
    }

    // POST /cx-agent/api/training/backfill?batch=20&before_id=<cursor>
    // Pulls historical human replies from Zendesk for processed tickets that don't yet
    // have one captured. Walks tickets newest-first by id using a descending cursor so
    // each batch strictly advances — tickets with no public team reply never get a row,
    // so a NOT-EXISTS-only filter would re-select them forever. The UI passes next_cursor
    // back until it's null. Batched to stay within Worker time / Zendesk rate limits.
    if (path === '/cx-agent/api/training/backfill' && request.method === 'POST') {
      const url = new URL(request.url);
      const batch = Math.min(Math.max(parseInt(url.searchParams.get('batch') || '20'), 1), 50);
      const beforeId = parseInt(url.searchParams.get('before_id') || '0') || Number.MAX_SAFE_INTEGER;

      const todo = await db.prepare(`
        SELECT id, zendesk_ticket_id FROM agent_tickets
        WHERE status IN ('drafted','escalated') AND id < ?
          AND NOT EXISTS (SELECT 1 FROM agent_human_replies hr WHERE hr.ticket_id = agent_tickets.id)
        ORDER BY id DESC LIMIT ?
      `).bind(beforeId, batch).all();

      const rows = todo.results || [];
      let captured = 0, nextCursor = null;
      for (const t of rows) {
        const r = await captureHumanReply(t.id, t.zendesk_ticket_id, db, env);
        if (r?.captured) captured++;
        nextCursor = t.id; // rows are id-descending, so the last one is the lowest id seen
      }

      return new Response(JSON.stringify({
        processed: rows.length,
        captured,
        // Null when this batch wasn't full → no older candidates remain → UI stops looping.
        next_cursor: rows.length === batch ? nextCursor : null
      }), { headers: cors });
    }

    // GET /cx-agent/api/training/insights
    // Aggregate stats: rating distribution, by intent, by action, time saved estimate.
    if (path === '/cx-agent/api/training/insights' && request.method === 'GET') {
      const totalReplies = await db.prepare("SELECT COUNT(*) as c FROM agent_human_replies").first();
      const ratedReplies = await db.prepare("SELECT COUNT(*) as c FROM agent_human_replies WHERE rating IS NOT NULL").first();
      const ratingDist = await db.prepare("SELECT rating, COUNT(*) as n FROM agent_human_replies WHERE rating IS NOT NULL GROUP BY rating").all();
      const byIntent = await db.prepare(`
        SELECT t.classified_intent, hr.rating, COUNT(*) as n
        FROM agent_human_replies hr
        JOIN agent_tickets t ON t.id = hr.ticket_id
        WHERE hr.rating IS NOT NULL
        GROUP BY t.classified_intent, hr.rating
      `).all();
      const flags = await db.prepare(`
        SELECT t.zendesk_ticket_id, t.classified_intent, hr.rating_note, hr.rated_at
        FROM agent_human_replies hr
        JOIN agent_tickets t ON t.id = hr.ticket_id
        WHERE hr.rating = 'flag'
        ORDER BY hr.rated_at DESC LIMIT 20
      `).all();

      // Estimate time saved: 'good' = 3 min, 'minor' = 1 min, 'rewrite' = 0, 'flag' = 0
      const TIME = { good: 3, minor: 1, rewrite: 0, flag: 0 };
      let timeSavedMin = 0;
      for (const r of ratingDist.results || []) timeSavedMin += (TIME[r.rating] || 0) * r.n;

      return new Response(JSON.stringify({
        total_replies_captured: totalReplies.c,
        total_rated: ratedReplies.c,
        rating_distribution: ratingDist.results || [],
        by_intent: byIntent.results || [],
        recent_flags: flags.results || [],
        estimated_time_saved_minutes: timeSavedMin
      }, null, 2), { headers: cors });
    }

    // GET /cx-agent/api/training/readiness
    // Per-intent auto-send readiness: rolling accuracy over the last N rated replies
    // (same metric the auto-reply gate uses), sample count, allowlist + ready status.
    if (path === '/cx-agent/api/training/readiness' && request.method === 'GET') {
      const mode = await cxGetConfig(db, 'mode');
      const bar = (await cxGetConfig(db, 'auto_reply_accuracy_bar')) ?? 0.9;
      const minSample = (await cxGetConfig(db, 'auto_reply_min_sample')) ?? 25;
      const minConf = await cxGetConfig(db, 'min_confidence_to_auto_reply');
      const allow = (await cxGetConfig(db, 'auto_reply_intents')) || [];

      const rows = (await db.prepare(`
        WITH ranked AS (
          SELECT t.classified_intent AS intent, hr.rating,
                 ROW_NUMBER() OVER (PARTITION BY t.classified_intent ORDER BY hr.rated_at DESC) AS rn
          FROM agent_human_replies hr
          JOIN agent_tickets t ON t.id = hr.ticket_id
          WHERE hr.rating IS NOT NULL AND t.classified_intent IS NOT NULL
        )
        SELECT intent,
          COUNT(*) AS total,
          SUM(CASE WHEN rn <= ? AND rating IN ('good','minor') THEN 1 ELSE 0 END) AS recent_good,
          SUM(CASE WHEN rn <= ? THEN 1 ELSE 0 END) AS recent_n
        FROM ranked GROUP BY intent ORDER BY total DESC
      `).bind(minSample, minSample).all()).results || [];

      const intents = rows.map(r => {
        const recent_n = r.recent_n || 0;
        const accuracy = recent_n ? (r.recent_good || 0) / recent_n : 0;
        const on_allowlist = allow.includes(r.intent);
        const enough = recent_n >= minSample;
        const ready = on_allowlist && enough && accuracy >= bar;
        return {
          intent: r.intent, total_rated: r.total || 0, recent_n, accuracy: Math.round(accuracy * 100),
          on_allowlist, ready,
          status: !on_allowlist ? 'not_enabled' : !enough ? 'needs_samples' : accuracy >= bar ? 'ready' : 'below_bar',
          needed: enough ? 0 : minSample - recent_n
        };
      });

      return new Response(JSON.stringify({
        mode, bar: Math.round(bar * 100), min_sample: minSample,
        min_confidence: minConf, auto_reply_intents: allow, intents
      }, null, 2), { headers: cors });
    }

    // GET /cx-agent/api/diag/reply-capture?ticket=<zendesk_ticket_id>
    // Mirrors captureHumanReply WITHOUT inserting — shows exactly why a reply did or
    // didn't get captured (ticket-in-DB? which comments are public? which author_ids
    // match support_staff_ids?). If no ticket given, picks the most recent drafted ticket.
    // GET /cx-agent/api/diag/propose-order-action?order=<number>  (or ?email=<addr>)
    // Runs the full cancel/refund/return decision engine against a real order — Shopify +
    // ShipMonk reads only, NO ticket, NO Zendesk write, NOTHING mutated. This is the way to
    // spot-check whether the agent would make the right call before trusting it.
    if (path === '/cx-agent/api/diag/propose-order-action' && request.method === 'GET') {
      const url = new URL(request.url);
      const orderNum = url.searchParams.get('order');
      const email = url.searchParams.get('email');
      if (!orderNum && !email) return new Response(JSON.stringify({ error: 'pass ?order=<order number> or ?email=<customer email>' }), { status: 400, headers: cors });
      // Synthesize the minimum ticketData the engine needs.
      const fakeTicket = {
        subject: orderNum ? `order ${orderNum}` : 'refund request',
        firstMessage: orderNum ? `I want to cancel my order ${orderNum}` : 'I want to cancel my order',
        customerEmail: email || null,
        ticket: {},
      };
      const proposal = await cxProposeOrderAction(fakeTicket, db, env);
      return new Response(JSON.stringify({
        read_only: true,
        note: 'Nothing was changed in Shopify or ShipMonk. This is what the agent would propose.',
        ...proposal,
        rendered_note: proposal.ok ? cxFormatActionPlan(proposal) : undefined,
      }, null, 2), { headers: cors });
    }

    // GET /cx-agent/api/diag/top-noise-senders — senders whose tickets keep classifying as
    // noise/spam. Use it to populate ignored_senders with the real repeat offenders.
    if (path === '/cx-agent/api/diag/top-noise-senders' && request.method === 'GET') {
      const rows = (await db.prepare(`
        SELECT customer_email,
               COUNT(*) AS total,
               SUM(CASE WHEN classified_intent = 'noise' THEN 1 ELSE 0 END) AS noise,
               MAX(received_at) AS last_seen
        FROM agent_tickets
        WHERE customer_email IS NOT NULL AND customer_email != ''
        GROUP BY customer_email
        HAVING noise >= 2
        ORDER BY noise DESC LIMIT 40
      `).all()).results || [];
      const domains = {};
      for (const r of rows) {
        const d = '@' + String(r.customer_email).split('@')[1];
        domains[d] = (domains[d] || 0) + r.noise;
      }
      return new Response(JSON.stringify({
        note: 'Senders with 2+ noise-classified tickets. Add the ones you never want processed to the ignored_senders config (exact address, or "@domain" to block the whole domain).',
        senders: rows,
        by_domain: Object.entries(domains).sort((a, b) => b[1] - a[1]).map(([domain, noise]) => ({ domain, noise })),
      }, null, 2), { headers: cors });
    }

    // GET /cx-agent/api/diag/recent — one-page health view: recent tickets (with turn
    // claims), recent drafts, and recent follow-up traces. For "replies aren't running".
    if (path === '/cx-agent/api/diag/recent' && request.method === 'GET') {
      const tickets = (await db.prepare("SELECT id, zendesk_ticket_id, status, classified_intent, final_action, last_followup_comment_id, received_at, completed_at FROM agent_tickets ORDER BY id DESC LIMIT 10").all()).results || [];
      const responses = (await db.prepare("SELECT id, ticket_id, is_followup, turn_number, status, substr(customer_message,1,80) as msg, created_at FROM agent_responses ORDER BY id DESC LIMIT 12").all()).results || [];
      const traces = (await db.prepare("SELECT ticket_id, step_name, status, error_message, created_at FROM agent_decisions WHERE step_name LIKE 'followup%' OR step_name='pipeline_error' ORDER BY id DESC LIMIT 15").all()).results || [];
      return new Response(JSON.stringify({ now: new Date().toISOString(), tickets, responses, followup_traces: traces }, null, 2), { headers: cors });
    }

    // GET|POST /cx-agent/api/diag/retry-followup?ticket=<zid> — release the turn claim so
    // the next cron sweep re-detects and re-drafts the latest customer reply.
    if (path === '/cx-agent/api/diag/retry-followup') {
      const url = new URL(request.url);
      const zid = url.searchParams.get('ticket');
      if (!zid) return new Response(JSON.stringify({ error: 'pass ?ticket=<zendesk_ticket_id>' }), { status: 400, headers: cors });
      await db.prepare("UPDATE agent_tickets SET last_followup_comment_id = NULL WHERE zendesk_ticket_id = ?").bind(String(zid)).run();
      return new Response(JSON.stringify({ released: true, ticket: zid, note: 'The 2-min sweep will re-handle the latest customer reply (if <2h old and no human takeover).' }), { headers: cors });
    }

    // GET|POST /cx-agent/api/diag/simulate-followup?ticket=<id>&message=<text>
    // Runs the follow-up pipeline directly (bypasses the Zendesk trigger + takeover check) so
    // you can SEE the agent respond to a follow-up. Drafts/sends per current mode. If no
    // message is given, uses the latest real customer comment on the ticket.
    if (path === '/cx-agent/api/diag/simulate-followup' && (request.method === 'GET' || request.method === 'POST')) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const zid = body.ticket || url.searchParams.get('ticket');
      const message = body.message || url.searchParams.get('message') || null;
      if (!zid) return new Response(JSON.stringify({ error: 'pass ?ticket=<zendesk_ticket_id>' }), { status: 400, headers: cors });
      const ticketRow = await db.prepare("SELECT * FROM agent_tickets WHERE zendesk_ticket_id = ?").bind(String(zid)).first();
      if (!ticketRow) return new Response(JSON.stringify({ error: 'ticket not in agent DB (process it initially first)' }), { status: 404, headers: cors });
      const td = await cxFetchZendeskTicket(zid, db, env);
      if (!td) return new Response(JSON.stringify({ error: 'could not fetch ticket from Zendesk' }), { status: 500, headers: cors });
      const requesterId = td.ticket?.requester_id;
      let latest;
      if (message) {
        latest = { id: 'sim-' + Date.now(), plain_body: message, author_id: requesterId, public: true, created_at: new Date().toISOString() };
      } else {
        const cc = (td.comments || []).filter(c => c.public === true && c.author_id === requesterId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        latest = cc[0];
      }
      if (!latest) return new Response(JSON.stringify({ error: 'no customer message found — pass &message=...' }), { status: 400, headers: cors });
      await runCxAgentFollowup(ticketRow, td, latest, db, env);
      return new Response(JSON.stringify({ simulated: true, ticket: zid, used_message: (latest.plain_body || '').slice(0, 200), note: 'Check the ticket in Zendesk for the AI follow-up draft/reply.' }, null, 2), { headers: cors });
    }

    // GET /cx-agent/api/diag/followup?ticket=<zendesk_ticket_id>
    // Mirrors the follow-up gating WITHOUT posting — shows why a customer reply did or
    // didn't get an AI response (webhook must actually be firing for the real thing to run).
    if (path === '/cx-agent/api/diag/followup' && request.method === 'GET') {
      const url = new URL(request.url);
      const zid = url.searchParams.get('ticket');
      if (!zid) return new Response(JSON.stringify({ error: 'pass ?ticket=<zendesk_ticket_id>' }), { status: 400, headers: cors });
      const ticketRow = await db.prepare("SELECT id, last_followup_comment_id FROM agent_tickets WHERE zendesk_ticket_id = ?").bind(String(zid)).first();
      const followupEnabled = await cxGetConfig(db, 'followup_enabled');
      const td = await cxFetchZendeskTicket(zid, db, env);
      const botId = await cxGetBotAuthorId(db, env);
      const requesterId = td?.ticket?.requester_id ?? null;
      const publicComments = (td?.comments || []).filter(c => c.public === true);
      const teamPublic = publicComments.filter(c => typeof c.author_id === 'number' && c.author_id > 0 && c.author_id !== requesterId && c.author_id !== botId);
      const customerComments = publicComments.filter(c => c.author_id === requesterId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const latest = customerComments[0];
      const answered = latest ? publicComments.some(c => typeof c.author_id === 'number' && c.author_id > 0 && c.author_id !== requesterId && new Date(c.created_at) > new Date(latest.created_at)) : false;
      const stale = latest ? (Date.now() - new Date(latest.created_at).getTime() > 2 * 60 * 60 * 1000) : false;
      let verdict;
      if (!ticketRow) verdict = 'SKIP — ticket not in agent DB (was it processed initially?)';
      else if (followupEnabled === false) verdict = 'SKIP — followup_enabled is off';
      else if (!td) verdict = 'SKIP — could not fetch ticket from Zendesk';
      else if (customerComments.length < 2) verdict = `SKIP — only ${customerComments.length} public comment(s) from the requester (need ≥2 for a follow-up)`;
      else if (answered) verdict = 'SKIP — the latest customer message was already publicly answered (by team or AI)';
      else if (ticketRow.last_followup_comment_id === String(latest?.id)) verdict = 'SKIP — this customer turn was already handled';
      else if (stale) verdict = 'SKIP — latest customer message is older than 2h (sweep won\'t answer stale threads)';
      else verdict = `WOULD RESPOND ✅ — next sweep (≤2 min) drafts a suggestion${teamPublic.length ? ' (labeled: teammate handling — suggestion only, never auto-sent)' : ''}`;
      return new Response(JSON.stringify({
        zendesk_ticket_id: zid,
        ticket_in_agent_db: !!ticketRow,
        followup_enabled: followupEnabled,
        resolved_bot_author_id: botId,
        requester_id: requesterId,
        public_comment_count: publicComments.length,
        public_comment_authors: [...new Set(publicComments.map(c => c.author_id))],
        human_active: teamPublic.length > 0,
        latest_customer_msg_answered: answered,
        customer_public_comments: customerComments.length,
        latest_customer_comment_id: latest?.id ?? null,
        last_handled_comment_id: ticketRow?.last_followup_comment_id ?? null,
        verdict
      }, null, 2), { headers: cors });
    }

    if (path === '/cx-agent/api/diag/reply-capture' && request.method === 'GET') {
      const url = new URL(request.url);
      let zid = url.searchParams.get('ticket');
      if (!zid) {
        const recent = await db.prepare("SELECT zendesk_ticket_id FROM agent_tickets WHERE status='drafted' ORDER BY id DESC LIMIT 1").first();
        zid = recent?.zendesk_ticket_id;
      }
      if (!zid) return new Response(JSON.stringify({ error: 'no ticket to inspect' }), { status: 400, headers: cors });

      const ticketRow = await db.prepare("SELECT id, classified_intent, status FROM agent_tickets WHERE zendesk_ticket_id = ?").bind(String(zid)).first();
      const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
      const supportStaffIds = await cxGetConfig(db, 'support_staff_ids');
      const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);

      const resp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${zid}/comments.json`, { headers: { Authorization: `Basic ${auth}` } });
      const zendeskStatus = resp.status;
      let comments = [];
      if (resp.ok) ({ comments = [] } = await resp.json());

      // Resolve the requester — mirrors the live capture rule ("public, not -1, not the customer").
      let requesterId = null;
      try {
        const tResp = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${zid}.json`, { headers: { Authorization: `Basic ${auth}` } });
        if (tResp.ok) { const { ticket } = await tResp.json(); requesterId = ticket?.requester_id ?? null; }
      } catch {}

      const isTeam = (c) => c.public === true && typeof c.author_id === 'number' && c.author_id > 0
        && (requesterId != null ? c.author_id !== requesterId : supportStaffIds.includes(c.author_id));
      const analyzed = comments.map(c => ({
        id: c.id,
        author_id: c.author_id,
        public: c.public,
        in_support_staff_ids: supportStaffIds.includes(c.author_id),
        would_capture: isTeam(c),
        created_at: c.created_at,
        snippet: (c.plain_body || c.body || '').substring(0, 120)
      }));
      const wouldCapture = analyzed.filter(c => c.would_capture);
      const hasMessagingTranscript = analyzed.some(c => c.public && c.author_id === -1);

      return new Response(JSON.stringify({
        zendesk_ticket_id: zid,
        ticket_in_agent_db: !!ticketRow,
        agent_ticket: ticketRow || null,
        zendesk_comments_status: zendeskStatus,
        requester_id: requesterId,
        configured_support_staff_ids: supportStaffIds,
        total_comments: analyzed.length,
        public_comment_author_ids: [...new Set(analyzed.filter(c => c.public).map(c => c.author_id))],
        would_capture_count: wouldCapture.length,
        diagnosis: !ticketRow ? 'TICKET NOT IN AGENT DB — webhook skips it'
          : zendeskStatus !== 200 ? `Zendesk comments API returned ${zendeskStatus}`
          : wouldCapture.length > 0 ? 'Would capture OK'
          : hasMessagingTranscript ? 'Only a Messaging/chat transcript (author_id -1) — not captured by design'
          : 'No public team reply found',
        comments: analyzed
      }, null, 2), { headers: cors });
    }

    // GET /cx-agent/api/diag/channels
    // Hits Zendesk search API and returns ticket count grouped by channel for last 7 days.
    // Useful to verify whether Messaging/Instagram tickets are actually hitting the ticket queue.
    if (path === '/cx-agent/api/diag/channels' && request.method === 'GET') {
      const subdomain = await cxGetConfig(db, 'zendesk_subdomain');
      const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
      const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
      try {
        const resp = await fetch(
          `https://${subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent('type:ticket created>' + cutoff)}&per_page=100`,
          { headers: { Authorization: `Basic ${auth}` } }
        );
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: `Zendesk API ${resp.status}`, body: await resp.text() }), { status: 500, headers: cors });
        }
        const data = await resp.json();
        const results = data.results || [];
        const byChannel = {};
        const bySource = {};
        const samples = {};
        for (const t of results) {
          const ch = t.via?.channel || 'unknown';
          const src = t.via?.source?.rel || t.via?.source?.from?.name || '—';
          byChannel[ch] = (byChannel[ch] || 0) + 1;
          bySource[`${ch} / ${src}`] = (bySource[`${ch} / ${src}`] || 0) + 1;
          if (!samples[ch]) samples[ch] = [];
          if (samples[ch].length < 3) {
            samples[ch].push({
              id: t.id,
              subject: t.subject,
              requester_email: t.via?.source?.from?.address,
              requester_name: t.via?.source?.from?.name,
              description_preview: (t.description || '').substring(0, 200),
              created_at: t.created_at
            });
          }
        }
        return new Response(JSON.stringify({
          total_tickets: results.length,
          cutoff_date: cutoff,
          by_channel: byChannel,
          by_channel_and_source: bySource,
          sample_tickets: samples,
          note: 'Total is capped at 100 per Zendesk Search API call. Use this to verify which channels are creating tickets.'
        }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
      }
    }

    // GET /cx-agent/api/export?start=YYYY-MM-DD&end=YYYY-MM-DD&format=csv
    // Exports tickets + their decision trace + draft responses as CSV for analysis.
    if (path === '/cx-agent/api/export' && request.method === 'GET') {
      const url = new URL(request.url);
      const start = url.searchParams.get('start'); // YYYY-MM-DD
      const end = url.searchParams.get('end');     // YYYY-MM-DD (inclusive)
      const format = url.searchParams.get('format') || 'csv';

      // Build WHERE clause
      let whereClause = '1=1';
      const params = [];
      if (start) {
        whereClause += ' AND received_at >= ?';
        params.push(start + ' 00:00:00');
      }
      if (end) {
        whereClause += ' AND received_at <= ?';
        params.push(end + ' 23:59:59');
      }

      // Pull all tickets in range
      const ticketsResult = await db.prepare(`SELECT * FROM agent_tickets WHERE ${whereClause} ORDER BY received_at DESC`).bind(...params).all();
      const tickets = ticketsResult.results || [];

      if (tickets.length === 0) {
        return new Response('No tickets in selected date range', { status: 404, headers: { ...cors, 'Content-Type': 'text/plain' } });
      }

      const ticketIds = tickets.map(t => t.id);

      // Chunked fetch: D1 caps bind variables at ~100 per query, so we batch.
      // Without chunking, exports of more than ~100 tickets fail with
      // "D1_ERROR: too many SQL variables".
      const CHUNK = 90; // safely under D1's limit
      const decisions = [];
      const responses = [];
      for (let i = 0; i < ticketIds.length; i += CHUNK) {
        const chunk = ticketIds.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const dRes = await db.prepare(`SELECT * FROM agent_decisions WHERE ticket_id IN (${placeholders}) ORDER BY ticket_id, step_order`).bind(...chunk).all();
        const rRes = await db.prepare(`SELECT * FROM agent_responses WHERE ticket_id IN (${placeholders}) ORDER BY ticket_id, created_at`).bind(...chunk).all();
        if (dRes.results) decisions.push(...dRes.results);
        if (rRes.results) responses.push(...rRes.results);
      }

      // Group by ticket_id
      const decisionsByTicket = {};
      for (const d of decisions) {
        if (!decisionsByTicket[d.ticket_id]) decisionsByTicket[d.ticket_id] = [];
        decisionsByTicket[d.ticket_id].push(d);
      }
      const responsesByTicket = {};
      for (const r of responses) {
        if (!responsesByTicket[r.ticket_id]) responsesByTicket[r.ticket_id] = [];
        responsesByTicket[r.ticket_id].push(r);
      }

      // Build CSV — one row per ticket with summarized trace + full response
      const rows = [];
      const headers = [
        'ticket_id', 'zendesk_ticket_id', 'received_at', 'completed_at',
        'customer_email', 'channel', 'subject', 'first_customer_message',
        'classified_intent', 'intent_confidence', 'is_in_scope',
        'status', 'final_action', 'error_message',
        'steps_count', 'total_duration_ms', 'total_tokens', 'total_cost_usd',
        'step_names', 'decision_trace_summary',
        'draft_body', 'draft_status', 'posted_to_zendesk_at'
      ];
      rows.push(headers);

      for (const t of tickets) {
        const tDecisions = decisionsByTicket[t.id] || [];
        const tResponses = responsesByTicket[t.id] || [];
        const lastResponse = tResponses[tResponses.length - 1] || {};

        const totalDuration = tDecisions.reduce((sum, d) => sum + (d.duration_ms || 0), 0);
        const totalTokens = tDecisions.reduce((sum, d) => sum + (d.tokens_used || 0), 0);
        const totalCost = tDecisions.reduce((sum, d) => sum + (d.cost_usd || 0), 0);
        const stepNames = tDecisions.map(d => d.step_name).join(' > ');
        const traceSummary = tDecisions.map(d =>
          `[${d.step_order}] ${d.step_name}: ${d.reasoning || d.status}${d.error_message ? ' ERROR: ' + d.error_message : ''}`
        ).join(' || ');

        rows.push([
          t.id,
          t.zendesk_ticket_id,
          t.received_at,
          t.completed_at,
          t.customer_email,
          t.channel,
          t.subject,
          t.first_customer_message,
          t.classified_intent,
          t.intent_confidence,
          t.is_in_scope,
          t.status,
          t.final_action,
          t.error_message,
          tDecisions.length,
          totalDuration,
          totalTokens,
          totalCost.toFixed(6),
          stepNames,
          traceSummary,
          lastResponse.draft_body || '',
          lastResponse.status || '',
          lastResponse.posted_to_zendesk_at || ''
        ]);
      }

      // CSV escape
      const csv = rows.map(row =>
        row.map(cell => {
          if (cell === null || cell === undefined) return '';
          const s = String(cell);
          if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
            return '"' + s.replaceAll('"', '""') + '"';
          }
          return s;
        }).join(',')
      ).join('\r\n');

      const dateStr = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        headers: {
          ...cors,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="cx-agent-export-${dateStr}.csv"`
        }
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
}

// ===== ICP MODULE =====
// Pulls Klaviyo profiles + Ordered Product events into D1 so we can do
// cross-segment product analysis that Klaviyo's UI won't let us do natively.
// Required env: KLAVIYO_API_KEY (Wrangler secret, read access to profiles + events)

const KLAVIYO_API = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2024-10-15";

async function initIcpTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS icp_profiles (
      profile_id TEXT PRIMARY KEY,
      email TEXT,
      role_or_stage TEXT,
      created_kl TEXT,
      updated_kl TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS icp_order_items (
      event_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      order_date TEXT NOT NULL,
      sku TEXT,
      product_name TEXT,
      quantity INTEGER DEFAULT 1,
      line_value REAL DEFAULT 0,
      synced_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS icp_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_icp_profiles_role ON icp_profiles(role_or_stage)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_icp_profiles_email_nocase ON icp_profiles(email COLLATE NOCASE)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_icp_items_profile ON icp_order_items(profile_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_icp_items_sku ON icp_order_items(sku)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_icp_items_date ON icp_order_items(order_date)`),
  ]);
}

async function klaviyoFetch(url, env) {
  const res = await fetch(url, {
    headers: {
      "Authorization": `Klaviyo-API-Key ${env.KLAVIYO_API_KEY}`,
      "Accept": "application/json",
      "revision": KLAVIYO_REVISION,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Klaviyo ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Map of Klaviyo segment ID -> the role/stage label we want to tag profiles with.
// To find a segment ID: open the segment in Klaviyo, look at the URL.
// To rebuild this map (e.g. if you rename or recreate segments), update both
// the IDs and the label strings — the labels here become what shows up in the
// dashboard. Use the en-dash (U+2013) for "Year 1–2" to match the Klaviyo value.
const ICP_SEGMENT_MAP = (() => {
  const enDash = String.fromCharCode(0x2013);
  return {
    "S3MHkw": `Nursing student (Year 1${enDash}2)`,
    "V8vWgd": `Pre-nursing / A&P student`,
    "VAYudS": `Nursing student (Final year / NCLEX prep)`,
    "X44QgY": `New grad nurse (on the floor)`,
    "UYFrD5": `Other healthcare professional`,
    "Rn3Uv3": `Nurse educator / Faculty`,
  };
})();

async function syncIcpProfiles(env, opts = {}) {
  const db = env.DB;
  const maxPagesPerSegment = opts.maxPagesPerSegment || 5000;

  // Resume state lives at the segment level: which segments are already done,
  // and where in the current segment we left off.
  const completedRow = await db.prepare(
    `SELECT value FROM icp_sync_state WHERE key = 'profiles_segments_completed'`
  ).first();
  const completed = !opts.restart && completedRow?.value
    ? new Set(JSON.parse(completedRow.value))
    : new Set();

  const segmentEntries = Object.entries(ICP_SEGMENT_MAP);
  const result = { segments_processed: 0, profiles_synced: 0, total_pages: 0, by_segment: {}, complete: false };

  for (const [segmentId, role] of segmentEntries) {
    if (completed.has(segmentId)) {
      result.by_segment[role] = { skipped: true };
      continue;
    }

    // Resume URL for this specific segment if we left off mid-segment
    const cursorKey = `profiles_segment_cursor_${segmentId}`;
    const cursorRow = await db.prepare(
      `SELECT value FROM icp_sync_state WHERE key = ?`
    ).bind(cursorKey).first();
    const initialUrl = `${KLAVIYO_API}/segments/${segmentId}/profiles/?page[size]=100`;
    let url = (!opts.restart && cursorRow?.value && cursorRow.value !== "")
      ? cursorRow.value
      : initialUrl;

    let pages = 0;
    let writtenThisSegment = 0;
    let missing = false;

    try {
      while (url && pages < maxPagesPerSegment) {
        const data = await klaviyoFetch(url, env);
        const profiles = data.data || [];

        if (profiles.length > 0) {
          const stmts = profiles.map(p =>
            db.prepare(
              `INSERT OR REPLACE INTO icp_profiles (profile_id, email, role_or_stage, created_kl, updated_kl, synced_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`
            ).bind(
              p.id,
              p.attributes?.email || null,
              role,
              p.attributes?.created || null,
              p.attributes?.updated || null,
            )
          );
          await db.batch(stmts);
          writtenThisSegment += profiles.length;
        }

        url = data.links?.next || null;
        pages++;
      }
    } catch (e) {
      // A deleted/renamed Klaviyo segment 404s — skip it (mark done) instead of
      // stalling the whole sync. Other errors still throw.
      if (/404|not_found|does not exist/i.test(String(e.message || e))) {
        missing = true;
        url = null;
        result.by_segment[role] = { skipped: true, missing_segment: segmentId };
      } else {
        throw e;
      }
    }

    // Save cursor for this segment (empty if we finished it)
    await db.prepare(
      `INSERT OR REPLACE INTO icp_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
    ).bind(cursorKey, url || "").run();

    result.profiles_synced += writtenThisSegment;
    result.total_pages += pages;
    result.segments_processed++;
    if (!missing) result.by_segment[role] = { synced: writtenThisSegment, pages, complete: !url };

    if (!url) {
      // Mark this segment as fully done
      completed.add(segmentId);
      await db.prepare(
        `INSERT OR REPLACE INTO icp_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
      ).bind("profiles_segments_completed", JSON.stringify([...completed])).run();
    } else {
      // Hit page cap on this segment — stop here so user can click again to continue.
      // This keeps each "click" responsive and avoids burning all CPU on one segment.
      break;
    }
  }

  result.complete = completed.size === segmentEntries.length;

  if (result.complete) {
    await db.prepare(
      `INSERT OR REPLACE INTO icp_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
    ).bind("profiles_last_sync", new Date().toISOString()).run();
    // Reset the completed-list so the next sync run starts fresh
    await db.prepare(
      `DELETE FROM icp_sync_state WHERE key = 'profiles_segments_completed'`
    ).run();
  }

  return result;
}

async function syncIcpOrderEvents(env, opts = {}) {
  const db = env.DB;
  const maxPages = opts.maxPages || 5000;

  // Find the Ordered Product metric ID (cached after first lookup)
  let metricId = null;
  const cached = await db.prepare(
    `SELECT value FROM icp_sync_state WHERE key = 'ordered_product_metric_id'`
  ).first();
  if (cached?.value) {
    metricId = cached.value;
  } else {
    const metricsData = await klaviyoFetch(`${KLAVIYO_API}/metrics/?filter=equals(integration.name,"Shopify")`, env);
    const metric = (metricsData.data || []).find(m =>
      m.attributes?.name === "Ordered Product"
    );
    if (!metric) throw new Error("Could not find Ordered Product metric — is Shopify connected to Klaviyo?");
    metricId = metric.id;
    await db.prepare(
      `INSERT OR REPLACE INTO icp_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
    ).bind("ordered_product_metric_id", metricId).run();
  }

  // Determine since-date for the backfill. We hard-code March 1, 2026 as the floor
  // because that's when role_or_stage started being collected — orders before that
  // can't be reliably tagged with the buyer's role-at-time-of-purchase.
  // Incremental syncs continue forward from the last sync timestamp.
  const ROLE_OR_STAGE_LAUNCH = "2026-03-01T00:00:00Z";
  const sinceRow = await db.prepare(
    `SELECT value FROM icp_sync_state WHERE key = 'events_last_sync'`
  ).first();
  const sinceISO = opts.fullBackfill || !sinceRow?.value
    ? ROLE_OR_STAGE_LAUNCH
    : sinceRow.value;

  const filter = `and(equals(metric_id,"${metricId}"),greater-than(datetime,${sinceISO}))`;
  let url = `${KLAVIYO_API}/events/?filter=${encodeURIComponent(filter)}&fields[event]=event_properties,datetime&include=profile&page[size]=100`;

  let pages = 0;
  let written = 0;

  while (url && pages < maxPages) {
    const data = await klaviyoFetch(url, env);
    const events = data.data || [];

    if (events.length > 0) {
      const validEvents = events.filter(e => e.relationships?.profile?.data?.id);
      const stmts = validEvents.map(e => {
        const props = e.attributes?.event_properties || {};
        // Klaviyo's Shopify integration uses these exact property names:
        // SKU, Name (NOT ProductName), Quantity, $value (NOT RowTotal/Value)
        const sku = props.SKU || props.sku || (props.ProductID != null ? String(props.ProductID) : null);
        const name = props.Name || props.ProductName || props.product_name || props.Title || null;
        const qty = parseInt(props.Quantity || props.quantity || 1) || 1;
        const value = parseFloat(props["$value"] || props.RowTotal || props.row_total || props.ProductPrice || props.LineValue || props.value || 0) || 0;
        const profileId = e.relationships.profile.data.id;
        return db.prepare(
          `INSERT OR REPLACE INTO icp_order_items (event_id, profile_id, order_date, sku, product_name, quantity, line_value, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(e.id, profileId, e.attributes?.datetime, sku, name, qty, value);
      });
      if (stmts.length > 0) await db.batch(stmts);
      written += stmts.length;
    }

    url = data.links?.next || null;
    pages++;
  }

  await db.prepare(
    `INSERT OR REPLACE INTO icp_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).bind("events_last_sync", new Date().toISOString()).run();

  return { events_synced: written, pages, since: sinceISO };
}

async function handleIcpAPI(request, env, path) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  const db = env.DB;
  await initIcpTables(db);

  try {
    if (path === "/icp/api/sync/profiles" && request.method === "POST") {
      if (!env.KLAVIYO_API_KEY) return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY not configured" }), { status: 500, headers: cors });
      const reqUrl = new URL(request.url);
      const restart = reqUrl.searchParams.get("restart") === "1";
      const result = await syncIcpProfiles(env, { restart });
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    if (path === "/icp/api/sync/events" && request.method === "POST") {
      if (!env.KLAVIYO_API_KEY) return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY not configured" }), { status: 500, headers: cors });
      const url = new URL(request.url);
      const fullBackfill = url.searchParams.get("full") === "1";
      const result = await syncIcpOrderEvents(env, { fullBackfill });
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    if (path === "/icp/api/status" && request.method === "GET") {
      const [profiles, items, syncState] = await db.batch([
        db.prepare(`SELECT COUNT(*) as c, COUNT(DISTINCT role_or_stage) as roles FROM icp_profiles`),
        db.prepare(`SELECT COUNT(*) as c, MIN(order_date) as earliest, MAX(order_date) as latest FROM icp_order_items`),
        db.prepare(`SELECT key, value, updated_at FROM icp_sync_state`),
      ]);
      return new Response(JSON.stringify({
        profiles: profiles.results[0],
        order_items: items.results[0],
        sync_state: syncState.results,
      }), { headers: cors });
    }

    if (path === "/icp/api/segments" && request.method === "GET") {
      const url = new URL(request.url);
      const days = parseInt(url.searchParams.get("days") || "365");
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const profileCounts = await db.prepare(`
        SELECT role_or_stage, COUNT(*) as profile_count
        FROM icp_profiles
        WHERE role_or_stage IS NOT NULL
        GROUP BY role_or_stage
      `).all();

      const orderStats = await db.prepare(`
        SELECT
          p.role_or_stage,
          COUNT(DISTINCT oi.profile_id) as buyers,
          COUNT(*) as line_items,
          SUM(oi.quantity) as units,
          SUM(oi.line_value) as revenue
        FROM icp_order_items oi
        JOIN icp_profiles p ON p.profile_id = oi.profile_id
        WHERE p.role_or_stage IS NOT NULL
          AND oi.order_date >= ?
        GROUP BY p.role_or_stage
      `).bind(cutoff).all();

      const byRole = {};
      for (const r of profileCounts.results) {
        byRole[r.role_or_stage] = {
          role: r.role_or_stage,
          profile_count: r.profile_count,
          buyers: 0, line_items: 0, units: 0, revenue: 0,
        };
      }
      for (const r of orderStats.results) {
        if (!byRole[r.role_or_stage]) {
          byRole[r.role_or_stage] = { role: r.role_or_stage, profile_count: 0 };
        }
        Object.assign(byRole[r.role_or_stage], {
          buyers: r.buyers || 0,
          line_items: r.line_items || 0,
          units: r.units || 0,
          revenue: r.revenue || 0,
        });
      }
      return new Response(JSON.stringify({ days, segments: Object.values(byRole) }), { headers: cors });
    }

    if (path === "/icp/api/debug/clear-events" && request.method === "POST") {
      // Wipes order events + sync state so a Full 365-day backfill can re-pull
      // everything cleanly. Profiles are untouched.
      await db.batch([
        db.prepare(`DELETE FROM icp_order_items`),
        db.prepare(`DELETE FROM icp_sync_state WHERE key = 'events_last_sync'`),
      ]);
      return new Response(JSON.stringify({ ok: true, message: "Events cleared. Run Full 365-day backfill next." }), { headers: cors });
    }

    if (path === "/icp/api/debug" && request.method === "GET") {
      // Show 5 sample order items from D1 + 1 raw event from Klaviyo so we can see
      // exactly which property names hold the value/quantity in the live payload.
      const sampleRows = await db.prepare(
        `SELECT event_id, profile_id, order_date, sku, product_name, quantity, line_value
         FROM icp_order_items LIMIT 5`
      ).all();

      let rawEvent = null;
      let rawError = null;
      if (env.KLAVIYO_API_KEY) {
        try {
          const metricRow = await db.prepare(
            `SELECT value FROM icp_sync_state WHERE key = 'ordered_product_metric_id'`
          ).first();
          if (metricRow?.value) {
            const filter = `equals(metric_id,"${metricRow.value}")`;
            const evUrl = `${KLAVIYO_API}/events/?filter=${encodeURIComponent(filter)}&fields[event]=event_properties,datetime&page[size]=1`;
            const evData = await klaviyoFetch(evUrl, env);
            rawEvent = evData.data?.[0] || null;
          } else {
            rawError = "No ordered_product_metric_id cached yet";
          }
        } catch (e) {
          rawError = e.message;
        }
      }

      return new Response(JSON.stringify({
        sample_rows: sampleRows.results,
        raw_klaviyo_event: rawEvent,
        raw_klaviyo_error: rawError,
      }, null, 2), { headers: cors });
    }

    if (path === "/icp/api/product-segments" && request.method === "GET") {
      const url = new URL(request.url);
      const days = parseInt(url.searchParams.get("days") || "365");
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const role = url.searchParams.get("role");

      let query = `
        SELECT
          COALESCE(oi.product_name, oi.sku, '(unknown)') as product,
          oi.sku,
          p.role_or_stage as role,
          SUM(oi.quantity) as units,
          SUM(oi.line_value) as revenue,
          COUNT(DISTINCT oi.profile_id) as buyers
        FROM icp_order_items oi
        JOIN icp_profiles p ON p.profile_id = oi.profile_id
        WHERE p.role_or_stage IS NOT NULL
          AND oi.order_date >= ?
      `;
      const params = [cutoff];
      if (role) { query += ` AND p.role_or_stage = ?`; params.push(role); }
      query += ` GROUP BY product, oi.sku, role ORDER BY units DESC`;

      const result = await db.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ days, rows: result.results }), { headers: cors });
    }

    if (path === "/icp/api/stage-affinity" && request.method === "GET") {
      // Products distinctively bought by a particular stage — via lift (over-indexing)
      // × in-stage-share, so neither big stages nor tiny ones dominate. Unit = distinct
      // buyers per (SKU, stage). source=klaviyo (directional icp_order_items, default)
      // or shopify (exact all-time from the affinity build).
      const url = new URL(request.url);
      const days = parseInt(url.searchParams.get("days") || "365");
      const minBuyers = Math.max(1, parseInt(url.searchParams.get("min_buyers") || "10"));
      const source = url.searchParams.get("source") === "shopify" ? "shopify" : "klaviyo";

      let baseRows, skuRows;
      const meta = { source };
      if (source === "shopify") {
        await ensureAffinityTables(env.DB);
        baseRows = (await db.prepare(`SELECT stage AS role, buyers FROM affinity_stage_totals`).all()).results;
        skuRows = (await db.prepare(`SELECT product, sku, stage AS role, buyers FROM affinity_counts`).all()).results;
        meta.last_completed = await icpState(env, "affinity_last_completed");
        meta.in_progress = (await icpState(env, "affinity_running")) !== null;
        meta.build = (await readStageSummary(env, "affinity_running") !== null)
          ? await readStageSummary(env, "affinity_summary")
          : await readStageSummary(env, "affinity_last_summary");
      } else {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        baseRows = (await db.prepare(`
          SELECT p.role_or_stage AS role, COUNT(DISTINCT oi.profile_id) AS buyers
          FROM icp_order_items oi JOIN icp_profiles p ON p.profile_id = oi.profile_id
          WHERE p.role_or_stage IS NOT NULL AND oi.order_date >= ?
          GROUP BY p.role_or_stage`).bind(cutoff).all()).results;
        skuRows = (await db.prepare(`
          SELECT COALESCE(oi.product_name, oi.sku, '(unknown)') AS product, oi.sku AS sku,
                 p.role_or_stage AS role, COUNT(DISTINCT oi.profile_id) AS buyers
          FROM icp_order_items oi JOIN icp_profiles p ON p.profile_id = oi.profile_id
          WHERE p.role_or_stage IS NOT NULL AND oi.order_date >= ?
          GROUP BY product, oi.sku, p.role_or_stage`).bind(cutoff).all()).results;
        meta.days = days;
      }

      const { baseline, products } = computeStageAffinity(baseRows, skuRows, minBuyers);
      return new Response(JSON.stringify({ ...meta, min_buyers: minBuyers, baseline, products }), { headers: cors });
    }

    if (path === "/icp/api/affinity/build" && request.method === "POST") {
      if (!env.SHOPIFY_ACCESS_TOKEN) {
        return new Response(JSON.stringify({ error: "SHOPIFY_ACCESS_TOKEN not configured" }), { status: 500, headers: cors });
      }
      const reqUrl = new URL(request.url);
      if (env.SYNC_SECRET && reqUrl.searchParams.get("secret") !== env.SYNC_SECRET) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });
      }
      const restart = reqUrl.searchParams.get("restart") === "1";
      const full = reqUrl.searchParams.get("full") === "1";
      const result = await buildStageAffinity(env, { restart, full });
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    if (path === "/icp/api/affinity/status" && request.method === "GET") {
      await ensureAffinityTables(env.DB);
      const [running, cursor, lastCompleted, lastSummary, cur, lastError] = await Promise.all([
        icpState(env, "affinity_running"),
        icpState(env, "affinity_cursor"),
        icpState(env, "affinity_last_completed"),
        readStageSummary(env, "affinity_last_summary"),
        readStageSummary(env, "affinity_summary"),
        icpState(env, "affinity_last_error"),
      ]);
      return new Response(JSON.stringify({
        in_progress: running !== null,
        page_cursor: cursor,
        last_completed: lastCompleted,
        last_summary: lastSummary,
        running_summary: cur,
        last_error: lastError,
      }), { headers: cors });
    }

    if (path === "/icp/api/icp-product-mix" && request.method === "GET") {
      // Composition table: for each product (variants merged), the % of its buyers in
      // each of the 3 ICPs. Rows sum to 100%. Other-HC + Educators excluded from the
      // denominator. Exact all-time Shopify data (affinity_counts).
      const url = new URL(request.url);
      const minBuyers = Math.max(1, parseInt(url.searchParams.get("min_buyers") || "15"));
      await ensureAffinityTables(env.DB);
      const rows = (await db.prepare(`SELECT product, sku, stage, buyers FROM affinity_counts`).all()).results;

      const PRE = "Pre-nursing / A&P student";
      const YR = "Nursing student (Year 1–2)";
      const FINAL = "Nursing student (Final year / NCLEX prep)";
      const NG = "New grad nurse (on the floor)";
      const bucketOf = (stage) => stage === PRE ? "pre"
        : stage === YR ? "nur"
        : (stage === FINAL || stage === NG) ? "ncl" : null; // Other-HC / Educator -> excluded

      const byProduct = new Map();
      for (const r of rows) {
        const b = bucketOf(r.stage);
        if (!b) continue;
        const name = canonicalizeProduct(r.product);
        if (!byProduct.has(name)) byProduct.set(name, { product: name, pre: 0, nur: 0, ncl: 0 });
        byProduct.get(name)[b] += r.buyers || 0;
      }

      const out = [];
      for (const e of byProduct.values()) {
        const total = e.pre + e.nur + e.ncl;
        if (total < minBuyers) continue;
        out.push({
          product: e.product,
          icp_buyers: total,
          pre: { n: e.pre, pct: e.pre / total },
          nur: { n: e.nur, pct: e.nur / total },
          ncl: { n: e.ncl, pct: e.ncl / total },
        });
      }
      out.sort((a, b) => b.icp_buyers - a.icp_buyers);
      const lastCompleted = await icpState(env, "affinity_last_completed");
      return new Response(JSON.stringify({ min_buyers: minBuyers, last_completed: lastCompleted, rows: out }), { headers: cors });
    }

    if (path === "/icp/api/first-purchase" && request.method === "GET") {
      const url = new URL(request.url);
      const days = parseInt(url.searchParams.get("days") || "365");
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const result = await db.prepare(`
        WITH first_dates AS (
          SELECT profile_id, MIN(order_date) as first_date
          FROM icp_order_items
          WHERE order_date >= ?
          GROUP BY profile_id
        )
        SELECT
          p.role_or_stage as role,
          COALESCE(oi.product_name, oi.sku, '(unknown)') as product,
          oi.sku,
          COUNT(DISTINCT oi.profile_id) as first_buyers,
          SUM(oi.quantity) as units
        FROM icp_order_items oi
        JOIN first_dates fd
          ON fd.profile_id = oi.profile_id
         AND fd.first_date = oi.order_date
        JOIN icp_profiles p ON p.profile_id = oi.profile_id
        WHERE p.role_or_stage IS NOT NULL
        GROUP BY p.role_or_stage, product, oi.sku
        ORDER BY p.role_or_stage, first_buyers DESC
      `).bind(cutoff).all();

      return new Response(JSON.stringify({ days, rows: result.results }), { headers: cors });
    }

    if (path === "/icp/api/sync/stage-metafields" && request.method === "POST") {
      if (!env.SHOPIFY_ACCESS_TOKEN) {
        return new Response(JSON.stringify({ error: "SHOPIFY_ACCESS_TOKEN not configured" }), { status: 500, headers: cors });
      }
      const reqUrl = new URL(request.url);
      // Optional belt-and-suspenders gate on top of Cloudflare Access.
      if (env.SYNC_SECRET && reqUrl.searchParams.get("secret") !== env.SYNC_SECRET) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });
      }
      const restart = reqUrl.searchParams.get("restart") === "1";
      const full = reqUrl.searchParams.get("full") === "1";
      const result = await syncStageMetafields(env, { restart, full });
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    if (path === "/icp/api/sync/stage-metafields/scopes" && request.method === "GET") {
      // Diagnostic: what scopes does the token the Worker actually holds have?
      if (!env.SHOPIFY_ACCESS_TOKEN) {
        return new Response(JSON.stringify({ error: "SHOPIFY_ACCESS_TOKEN not configured" }), { status: 500, headers: cors });
      }
      const shopDomain = await shopifyStoreDomain(env);
      const data = await shopifyGraphQL(env, shopDomain,
        `{ currentAppInstallation { accessScopes { handle } } }`, {});
      const handles = (data?.currentAppInstallation?.accessScopes || []).map(s => s.handle).sort();
      return new Response(JSON.stringify({
        shop_domain: shopDomain,
        scopes: handles,
        has_write_customers: handles.includes("write_customers"),
      }, null, 2), { headers: cors });
    }

    if (path === "/icp/api/sync/stage-metafields/verify" && request.method === "GET") {
      // Diagnostic: read the live metafield for the first page of Shopify customers and,
      // for those matching a profile stage, compare expected vs actual.
      const shopDomain = await shopifyStoreDomain(env);
      const data = await shopifyGraphQL(env, shopDomain, CUSTOMERS_PAGE_QUERY, { after: null }, {});
      const edges = data?.customers?.edges || [];
      const emails = edges.map((e) => e.node.email).filter(Boolean).map((x) => x.toLowerCase());
      const roleByEmail = new Map();
      if (emails.length) {
        const ph = emails.map(() => "?").join(",");
        const rs = (await env.DB.prepare(
          `SELECT email, role_or_stage FROM icp_profiles
           WHERE role_or_stage IS NOT NULL AND email COLLATE NOCASE IN (${ph})`
        ).bind(...emails).all()).results;
        for (const r of rs) if (r.email) roleByEmail.set(r.email.toLowerCase(), r.role_or_stage);
      }
      const checks = [];
      for (const e of edges) {
        const email = e.node.email;
        if (!email) continue;
        const expected = roleByEmail.get(email.toLowerCase());
        if (!expected) continue; // not a matched customer — skip
        const actual = e.node.stage?.value ?? null;
        const actualDate = e.node.stageDate?.value ?? null;
        checks.push({ email, expected, actual, actual_date: actualDate, match: actual === expected });
        if (checks.length >= 8) break;
      }
      return new Response(JSON.stringify({ matched_on_first_page: checks.length, checks }, null, 2), { headers: cors });
    }

    if (path === "/icp/api/sync/stage-metafields/status" && request.method === "GET") {
      const [runningFlag, pageCursor, lastCompleted, lastSummary, running, lastError, lastErrorAt] = await Promise.all([
        icpState(env, "stage_mf_running"),
        icpState(env, "stage_mf_page_cursor"),
        icpState(env, "stage_mf_last_completed"),
        readStageSummary(env, "stage_mf_last_summary"),
        readStageSummary(env, "stage_mf_summary"),
        icpState(env, "stage_mf_last_error"),
        icpState(env, "stage_mf_last_error_at"),
      ]);
      return new Response(JSON.stringify({
        in_progress: runningFlag !== null,
        page_cursor: pageCursor,
        last_completed: lastCompleted,
        last_summary: lastSummary,
        running_summary: running,
        last_error: lastError,
        last_error_at: lastErrorAt,
      }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers: cors });
  }
}

// ===== STAGE → SHOPIFY METAFIELD SYNC =====
// Writes each customer's self-declared nursing stage (from icp_profiles, which the
// ICP profile sync already populates from Klaviyo segments) onto the matching
// Shopify customer as metafield custom.nursing_journey_stage. This lets us analyze
// purchasing behavior by ICP stage using Shopify's exact all-time order data via
// customer segments / Admin GraphQL. Metafield-only by design (no tag) — a metafield
// can't be GROUP BY'd in ShopifyQL, but that path isn't what we're using.
// Required env: SHOPIFY_ACCESS_TOKEN. Optional: SHOPIFY_STORE_DOMAIN, SYNC_SECRET.

const SHOPIFY_GQL_VERSION = "2024-10";
const STAGE_MF_NAMESPACE = "custom";
const STAGE_MF_KEY = "nursing_journey_stage";
// Companion date metafield: the date the CURRENT stage was recorded. Set when the stage
// is first written or whenever it changes — so it marks entry into the current stage,
// giving a "time in stage" signal to predict when a student moves to the next stage.
const STAGE_MF_DATE_KEY = "nursing_stage_recorded_at";
// role_or_stage collection began 2026-03-01, so a stage can't have been entered before
// then. Turn a Klaviyo ISO timestamp into a YYYY-MM-DD estimate clamped to that floor.
const STAGE_COLLECTION_START = "2026-03-01";
function clampStageDate(iso) {
  if (!iso) return null;
  const d = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d < STAGE_COLLECTION_START ? STAGE_COLLECTION_START : d;
}

const stageSleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function shopifyStoreDomain(env) {
  try {
    const d = await cxGetConfig(env.CX_AGENT_DB, "shopify_store_domain");
    if (d) return d;
  } catch { /* CX config unavailable — fall through */ }
  return env.SHOPIFY_STORE_DOMAIN || "nurseinthemaking.myshopify.com";
}

// POST a GraphQL op to Shopify Admin, retrying on HTTP 429 and cost-based THROTTLED.
// `counters.throttle_retries` (if passed) is incremented per backoff so the sync
// summary can report throttling.
async function shopifyGraphQL(env, shopDomain, query, variables, { maxRetries = 6, counters = null } = {}) {
  let attempt = 0;
  while (true) {
    const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_GQL_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    // Retry transient transport errors: 429 rate limit + 5xx gateway/server errors
    // (502/503/504 return non-JSON bodies, so parse them only after this check).
    if (res.status === 429 || res.status >= 500) {
      if (attempt++ >= maxRetries) throw new Error(`Shopify HTTP ${res.status} (max retries)`);
      if (counters) counters.throttle_retries = (counters.throttle_retries || 0) + 1;
      await stageSleep(Math.min(8000, 500 * Math.pow(2, attempt)));
      continue;
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      // Non-JSON body on a non-5xx status (rare) — treat as transient and retry.
      if (attempt++ >= maxRetries) throw new Error(`Shopify non-JSON response (HTTP ${res.status})`);
      await stageSleep(Math.min(8000, 500 * Math.pow(2, attempt)));
      continue;
    }

    const errs = json.errors || [];
    // THROTTLED and Shopify-side INTERNAL_SERVER_ERROR are both transient — back off + retry.
    const throttled = errs.some((e) => e?.extensions?.code === "THROTTLED");
    const serverErr = errs.some((e) => e?.extensions?.code === "INTERNAL_SERVER_ERROR");
    if (throttled || serverErr) {
      if (attempt++ >= maxRetries) throw new Error("Shopify GraphQL " + (throttled ? "THROTTLED" : "INTERNAL_SERVER_ERROR") + " (max retries)");
      if (counters) counters.throttle_retries = (counters.throttle_retries || 0) + 1;
      const cost = json.extensions?.cost;
      const restore = cost?.throttleStatus?.restoreRate || 50;
      const needed = cost?.requestedQueryCost || 100;
      const wait = throttled ? Math.ceil((needed / restore) * 1000) : 500 * Math.pow(2, attempt);
      await stageSleep(Math.min(8000, Math.max(500, wait)));
      continue;
    }
    if (errs.length) throw new Error("Shopify GraphQL: " + JSON.stringify(errs).slice(0, 400));
    return json.data;
  }
}

// Idempotent — safe to call every run. Ensures both the stage and the recorded-date
// definitions exist; swallows the "already exists"/TAKEN userError.
async function ensureStageMetafieldDefinition(env, shopDomain) {
  const mutation = `
    mutation CreateDef($def: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $def) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }`;
  const defs = [
    {
      name: "Nursing Journey Stage",
      namespace: STAGE_MF_NAMESPACE,
      key: STAGE_MF_KEY,
      type: "single_line_text_field",
      ownerType: "CUSTOMER",
      pin: true,
    },
    {
      name: "Nursing Stage Recorded At",
      namespace: STAGE_MF_NAMESPACE,
      key: STAGE_MF_DATE_KEY,
      type: "date",
      ownerType: "CUSTOMER",
      pin: true,
    },
  ];
  for (const def of defs) {
    try {
      const data = await shopifyGraphQL(env, shopDomain, mutation, { def });
      const ues = data?.metafieldDefinitionCreate?.userErrors || [];
      const fatal = ues.filter((e) => e.code !== "TAKEN" && !/already|taken|exist/i.test(e.message || ""));
      if (fatal.length) throw new Error("metafieldDefinitionCreate: " + JSON.stringify(fatal).slice(0, 300));
    } catch (e) {
      // Non-fatal: definition may already exist / lack scope; metafieldsSet still works
      // for an existing (or app-owned) definition.
    }
  }
}

// Batch up to 25 prebuilt MetafieldsSetInput objects per metafieldsSet call.
// Returns the number of metafields written.
async function shopifyWriteMetafields(env, shopDomain, inputs, counters) {
  const mutation = `
    mutation SetMF($mfs: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $mfs) {
        metafields { id }
        userErrors { field message }
      }
    }`;
  let written = 0;
  for (let i = 0; i < inputs.length; i += 25) {
    const chunk = inputs.slice(i, i + 25);
    const data = await shopifyGraphQL(env, shopDomain, mutation, { mfs: chunk }, { counters });
    const ues = data?.metafieldsSet?.userErrors || [];
    if (ues.length) counters.write_errors = (counters.write_errors || 0) + ues.length;
    written += data?.metafieldsSet?.metafields?.length || 0;
  }
  return written;
}

// icp_sync_state get/set/delete (value===undefined reads, value===null deletes).
async function icpState(env, key, value) {
  const db = env.DB;
  if (value === undefined) {
    const row = await db.prepare(`SELECT value FROM icp_sync_state WHERE key = ?`).bind(key).first();
    return row ? row.value : null;
  }
  if (value === null) {
    await db.prepare(`DELETE FROM icp_sync_state WHERE key = ?`).bind(key).run();
    return;
  }
  await db.prepare(
    `INSERT OR REPLACE INTO icp_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).bind(key, String(value)).run();
}

const emptyStageSummary = () => ({
  considered: 0, matched: 0, written: 0, dated: 0, unchanged: 0,
  unmatched: 0, skipped: 0, throttle_retries: 0, write_errors: 0,
});

async function readStageSummary(env, key) {
  const raw = await icpState(env, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Advance one resumable pass over SHOPIFY CUSTOMERS (the ~10k buyers), matching each
// email against the local icp_profiles table (a free D1 lookup) and writing the stage
// metafield only on matches. Far cheaper than scanning all ~463k Klaviyo profiles:
// every read leads to a useful write instead of ~98% being wasted on non-buyers.
// State: stage_mf_running ("1" while a pass is in progress), stage_mf_page_cursor
// (Shopify endCursor to resume after; absent/"" = first page), stage_mf_summary.
const CUSTOMER_PAGE_SIZE = 100;
const CUSTOMERS_PAGE_QUERY = `
  query StagePage($after: String) {
    customers(first: ${CUSTOMER_PAGE_SIZE}, after: $after) {
      edges { node {
        id email
        stage: metafield(namespace: "${STAGE_MF_NAMESPACE}", key: "${STAGE_MF_KEY}") { value }
        stageDate: metafield(namespace: "${STAGE_MF_NAMESPACE}", key: "${STAGE_MF_DATE_KEY}") { value }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

// Prepare a fresh pass: ensure the definition, mark running, clear cursor + summary.
async function beginStageRun(env, shopDomain) {
  await ensureStageMetafieldDefinition(env, shopDomain);
  await icpState(env, "stage_mf_running", "1");
  await icpState(env, "stage_mf_page_cursor", null);
  await icpState(env, "stage_mf_summary", null);
  await icpState(env, "stage_mf_cursor", null); // clear legacy rowid cursor from the old model
}

async function runStageBatch(env, { pagesPerRun = 20 } = {}) {
  await initIcpTables(env.DB);
  const shopDomain = await shopifyStoreDomain(env);

  let after = await icpState(env, "stage_mf_page_cursor");
  if (after === "") after = null;

  const running = (await readStageSummary(env, "stage_mf_summary")) || emptyStageSummary();
  const counters = { throttle_retries: running.throttle_retries || 0, write_errors: running.write_errors || 0 };
  const today = new Date().toISOString().slice(0, 10);

  let pages = 0, hasNext = true, cursor = after;
  while (pages < pagesPerRun) {
    const data = await shopifyGraphQL(env, shopDomain, CUSTOMERS_PAGE_QUERY, { after: cursor }, { counters });
    const conn = data.customers;
    const edges = conn.edges || [];
    pages++;

    // One D1 query resolves stage + Klaviyo timestamps for the whole page
    // (case-insensitive email match). estDate = a rough "entered stage" estimate
    // used only for the initial backfill (genuine changes we observe use today).
    const emails = edges.map((e) => e.node.email).filter(Boolean).map((x) => x.toLowerCase());
    const infoByEmail = new Map();
    if (emails.length) {
      const ph = emails.map(() => "?").join(",");
      const rs = (await env.DB.prepare(
        `SELECT email, role_or_stage, created_kl, updated_kl FROM icp_profiles
         WHERE role_or_stage IS NOT NULL AND email COLLATE NOCASE IN (${ph})`
      ).bind(...emails).all()).results;
      for (const r of rs) {
        if (!r.email) continue;
        infoByEmail.set(r.email.toLowerCase(), {
          role: r.role_or_stage,
          estDate: clampStageDate(r.updated_kl || r.created_kl) || today,
        });
      }
    }

    const writes = [];
    for (const e of edges) {
      const node = e.node;
      running.considered++;
      if (!node.email) { running.skipped++; continue; }
      const info = infoByEmail.get(node.email.toLowerCase());
      if (!info) { running.unmatched++; continue; }
      running.matched++;
      const role = info.role;
      const curStage = node.stage?.value ?? null;
      const curDate = node.stageDate?.value ?? null;
      const stageChanged = curStage !== role;              // true for both new and genuinely changed
      const genuineChange = curStage !== null && stageChanged; // had a prior different value
      const needDate = stageChanged || !curDate;           // set/backfill the recorded date
      if (!stageChanged && !needDate) { running.unchanged++; continue; }
      if (stageChanged) {
        writes.push({ ownerId: node.id, namespace: STAGE_MF_NAMESPACE, key: STAGE_MF_KEY, type: "single_line_text_field", value: role });
        running.written++;
      }
      if (needDate) {
        writes.push({ ownerId: node.id, namespace: STAGE_MF_NAMESPACE, key: STAGE_MF_DATE_KEY, type: "date", value: genuineChange ? today : info.estDate });
        running.dated++;
      }
    }
    if (writes.length) await shopifyWriteMetafields(env, shopDomain, writes, counters);

    running.throttle_retries = counters.throttle_retries;
    running.write_errors = counters.write_errors;
    cursor = conn.pageInfo.endCursor;
    hasNext = conn.pageInfo.hasNextPage;

    await icpState(env, "stage_mf_summary", JSON.stringify(running));
    await icpState(env, "stage_mf_page_cursor", cursor || "");

    if (!hasNext) break;
  }

  if (!hasNext) {
    // Complete: freeze summary, stamp completion, clear in-progress markers.
    await icpState(env, "stage_mf_last_summary", JSON.stringify(running));
    await icpState(env, "stage_mf_last_completed", new Date().toISOString());
    await icpState(env, "stage_mf_running", null);
    await icpState(env, "stage_mf_page_cursor", null);
    await icpState(env, "stage_mf_summary", null);
    return { ...running, done: true, pages };
  }
  return { ...running, done: false, pages, page_cursor: cursor };
}

// Manual driver: optionally reset, optionally loop over pages until done or a page budget.
async function syncStageMetafields(env, { restart = false, full = false, pagesPerRun = 20, pageBudget = 50 } = {}) {
  await initIcpTables(env.DB);
  const shopDomain = await shopifyStoreDomain(env);

  // A manual trigger clears any prior error backoff so it always attempts fresh
  // (e.g. right after a Shopify scope is added).
  await icpState(env, "stage_mf_last_error_at", null);
  await icpState(env, "stage_mf_last_error", null);

  const inProgress = (await icpState(env, "stage_mf_running")) !== null;
  if (restart || !inProgress) await beginStageRun(env, shopDomain);

  if (!full) return await runStageBatch(env, { pagesPerRun });

  let last = null, pagesDone = 0;
  while (pagesDone < pageBudget) {
    last = await runStageBatch(env, { pagesPerRun });
    pagesDone += last.pages || 0;
    if (last.done) break;
  }
  return last || { ...emptyStageSummary(), done: false };
}

// Called from cron: self-driving nightly pass. In progress -> advance a chunk of pages;
// else if the last completion is >20h ago (or never) -> start fresh + advance; else idle.
// A failure (e.g. a missing Shopify scope) records an error timestamp and backs the
// loop off for an hour so we don't re-hammer Shopify every 2-minute tick.
async function tickStageMetafieldSync(env) {
  if (!env.SHOPIFY_ACCESS_TOKEN) return;
  await initIcpTables(env.DB);

  const lastError = await icpState(env, "stage_mf_last_error_at");
  if (lastError && (Date.now() - new Date(lastError).getTime()) < 60 * 60 * 1000) return;

  try {
    const inProgress = (await icpState(env, "stage_mf_running")) !== null;
    if (inProgress) { await runStageBatch(env, { pagesPerRun: 50 }); return; }

    const lastCompleted = await icpState(env, "stage_mf_last_completed");
    const due = !lastCompleted || (Date.now() - new Date(lastCompleted).getTime()) > 20 * 60 * 60 * 1000;
    if (!due) return;

    const shopDomain = await shopifyStoreDomain(env);
    await beginStageRun(env, shopDomain);
    await runStageBatch(env, { pagesPerRun: 50 });
  } catch (e) {
    await icpState(env, "stage_mf_last_error_at", new Date().toISOString());
    await icpState(env, "stage_mf_last_error", String(e.message || e).slice(0, 300));
  }
}

// ===== STAGE AFFINITY (exact, from Shopify order history) =====
// Phase 2 of the stage analysis: instead of Klaviyo order events (partial/stale),
// pull each staged customer's real Shopify orders and tally distinct buyers per SKU
// per stage into D1, so the affinity view can run on exact all-time data. Pages all
// customers (same as the stage sync), and for each that has the stage metafield pulls
// their orders' line items. Resumable via a customer-page cursor; idempotent per
// customer via affinity_customers (so resumes/overlaps don't double-count buyers).

// Collapse SKU/title variants of the same product to one canonical name: drop
// ®/™/© marks and a trailing "| <year>", collapse whitespace. (e.g. the several
// "Complete Nursing School Bundle" variants → one.)
function canonicalizeProduct(name) {
  return String(name || "(unknown)")
    .replace(/[®™©]/g, "")
    .replace(/\s*\|\s*20\d\d\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureAffinityTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS affinity_counts (
      pkey TEXT NOT NULL, product TEXT, sku TEXT, stage TEXT NOT NULL, buyers INTEGER DEFAULT 0,
      PRIMARY KEY (pkey, stage))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS affinity_stage_totals (
      stage TEXT PRIMARY KEY, buyers INTEGER DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS affinity_customers (gid TEXT PRIMARY KEY)`),
  ]);
}

// Shared lift×share computation used by both the Klaviyo (directional) and Shopify
// (exact) sources. Input rows: baseRows=[{role,buyers}], skuRows=[{product,sku,role,buyers}].
function computeStageAffinity(baseRows, skuRows, minBuyers) {
  const allStagedBuyers = baseRows.reduce((s, r) => s + (r.buyers || 0), 0) || 1;
  const stageShare = {};
  const baseline = baseRows.map((r) => {
    const share = (r.buyers || 0) / allStagedBuyers;
    stageShare[r.role] = share;
    return { role: r.role, buyers: r.buyers || 0, share };
  }).sort((a, b) => b.buyers - a.buyers);

  const byKey = new Map();
  for (const r of skuRows) {
    const key = `${r.product}||${r.sku ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, { product: r.product, sku: r.sku || null, total_buyers: 0, stages: {} });
    const e = byKey.get(key);
    e.stages[r.role] = (e.stages[r.role] || 0) + (r.buyers || 0);
    e.total_buyers += r.buyers || 0;
  }

  const products = [];
  for (const e of byKey.values()) {
    if (e.total_buyers < minBuyers) continue;
    const by_stage = {};
    let topStage = null, topScore = -1, topLift = 0, topShare = 0, exclusivity = 0;
    for (const [role, buyers] of Object.entries(e.stages)) {
      const share = buyers / e.total_buyers;
      const base = stageShare[role] || 0;
      const lift = base > 0 ? share / base : 0;
      by_stage[role] = { buyers, share, lift };
      if (share > exclusivity) exclusivity = share;
      const score = lift * share;   // reward both over-indexing and concentration
      if (score > topScore) { topScore = score; topStage = role; topLift = lift; topShare = share; }
    }
    products.push({
      product: e.product, sku: e.sku, total_buyers: e.total_buyers,
      by_stage, top_stage: topStage, top_lift: topLift, top_share: topShare, score: topScore,
      exclusivity, exclusive: topShare >= 0.6 && topLift >= 1.5,
    });
  }
  products.sort((a, b) => b.score - a.score);
  return { baseline, products };
}

// Pull the set of distinct products a customer has ever bought (paginating orders).
async function affinityCustomerSkus(env, shopDomain, gid, counters) {
  const query = `
    query CustOrders($id: ID!, $after: String) {
      customer(id: $id) {
        orders(first: 20, after: $after) {
          edges { node { lineItems(first: 30) { edges { node { sku title } } } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
  const skus = new Map(); // pkey -> {product, sku}
  let after = null, guard = 0;
  while (guard++ < 25) {
    const data = await shopifyGraphQL(env, shopDomain, query, { id: gid, after }, { counters });
    const orders = data?.customer?.orders;
    if (!orders) break;
    for (const oe of orders.edges || []) {
      for (const le of oe.node.lineItems?.edges || []) {
        const sku = le.node.sku || null;
        const product = le.node.title || sku || "(unknown)";
        const pkey = `${product}||${sku ?? ""}`;
        if (!skus.has(pkey)) skus.set(pkey, { product, sku });
      }
    }
    if (!orders.pageInfo?.hasNextPage) break;
    after = orders.pageInfo.endCursor;
  }
  return skus;
}

async function beginAffinityRun(env) {
  await ensureAffinityTables(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM affinity_counts`),
    env.DB.prepare(`DELETE FROM affinity_stage_totals`),
    env.DB.prepare(`DELETE FROM affinity_customers`),
  ]);
  await icpState(env, "affinity_running", "1");
  await icpState(env, "affinity_cursor", null);
  await icpState(env, "affinity_summary", null);
  await icpState(env, "affinity_last_error", null);
  await icpState(env, "affinity_last_error_at", null); // clear backoff so a fresh build advances immediately
}

async function runAffinityBatch(env, { pagesPerRun = 20 } = {}) {
  await ensureAffinityTables(env.DB);
  const shopDomain = await shopifyStoreDomain(env);
  let after = await icpState(env, "affinity_cursor");
  if (after === "") after = null;

  const running = (await readStageSummary(env, "affinity_summary")) ||
    { considered: 0, staged: 0, customers_counted: 0, orders_customers: 0, throttle_retries: 0 };
  const counters = { throttle_retries: running.throttle_retries || 0 };

  let pages = 0, hasNext = true, cursor = after;
  while (pages < pagesPerRun) {
    const data = await shopifyGraphQL(env, shopDomain, CUSTOMERS_PAGE_QUERY, { after: cursor }, { counters });
    const conn = data.customers;
    const edges = conn.edges || [];
    pages++;

    // Resolve each customer's stage from icp_profiles by email (the source of truth),
    // NOT the Shopify metafield — so this build doesn't depend on the stage sync having
    // already tagged them.
    const emails = edges.map((e) => e.node.email).filter(Boolean).map((x) => x.toLowerCase());
    const roleByEmail = new Map();
    if (emails.length) {
      const ph = emails.map(() => "?").join(",");
      const rs = (await env.DB.prepare(
        `SELECT email, role_or_stage FROM icp_profiles
         WHERE role_or_stage IS NOT NULL AND email COLLATE NOCASE IN (${ph})`
      ).bind(...emails).all()).results;
      for (const r of rs) if (r.email) roleByEmail.set(r.email.toLowerCase(), r.role_or_stage);
    }

    for (const e of edges) {
      const node = e.node;
      running.considered++;
      const stage = node.email ? roleByEmail.get(node.email.toLowerCase()) : null;
      if (!stage) continue;
      running.staged++;
      // Idempotency: count each staged customer at most once across resumes.
      const ins = await env.DB.prepare(`INSERT OR IGNORE INTO affinity_customers (gid) VALUES (?)`).bind(node.id).run();
      if (!ins.meta?.changes) continue; // already counted
      let skus;
      try {
        skus = await affinityCustomerSkus(env, shopDomain, node.id, counters);
      } catch (e) {
        // Order pull failed (after retries): un-mark so a later pass retries this
        // customer instead of leaving them counted-but-empty (which undercounts).
        await env.DB.prepare(`DELETE FROM affinity_customers WHERE gid = ?`).bind(node.id).run();
        throw e;
      }
      running.orders_customers++;
      const stmts = [ env.DB.prepare(
        `INSERT INTO affinity_stage_totals (stage, buyers) VALUES (?, 1)
         ON CONFLICT(stage) DO UPDATE SET buyers = buyers + 1`).bind(stage) ];
      for (const { product, sku } of skus.values()) {
        const pkey = `${product}||${sku ?? ""}`;
        stmts.push(env.DB.prepare(
          `INSERT INTO affinity_counts (pkey, product, sku, stage, buyers) VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(pkey, stage) DO UPDATE SET buyers = buyers + 1`).bind(pkey, product, sku, stage));
      }
      await env.DB.batch(stmts);
      running.customers_counted++;
    }

    running.throttle_retries = counters.throttle_retries;
    cursor = conn.pageInfo.endCursor;
    hasNext = conn.pageInfo.hasNextPage;
    await icpState(env, "affinity_summary", JSON.stringify(running));
    await icpState(env, "affinity_cursor", cursor || "");
    if (!hasNext) break;
  }

  if (!hasNext) {
    await icpState(env, "affinity_last_summary", JSON.stringify(running));
    await icpState(env, "affinity_last_completed", new Date().toISOString());
    await icpState(env, "affinity_running", null);
    await icpState(env, "affinity_cursor", null);
    await icpState(env, "affinity_summary", null);
    return { ...running, done: true, pages };
  }
  return { ...running, done: false, pages, page_cursor: cursor };
}

// Manual driver: restart clears prior counts; full loops pages within a budget.
async function buildStageAffinity(env, { restart = false, full = false, pagesPerRun = 40, pageBudget = 250 } = {}) {
  await ensureAffinityTables(env.DB);
  const inProgress = (await icpState(env, "affinity_running")) !== null;
  if (restart || !inProgress) await beginAffinityRun(env);
  if (!full) return await runAffinityBatch(env, { pagesPerRun });
  let last = null, pagesDone = 0;
  while (pagesDone < pageBudget) {
    last = await runAffinityBatch(env, { pagesPerRun });
    pagesDone += last.pages || 0;
    if (last.done) break;
  }
  return last || { done: false };
}

// Cron: only advance an in-progress affinity build (do NOT auto-start — it's a heavy
// full-customer scan the user kicks on demand). 1hr error backoff.
async function tickStageAffinity(env) {
  if (!env.SHOPIFY_ACCESS_TOKEN) return;
  await ensureAffinityTables(env.DB);
  if ((await icpState(env, "affinity_running")) === null) return;
  const lastError = await icpState(env, "affinity_last_error_at");
  if (lastError && (Date.now() - new Date(lastError).getTime()) < 60 * 60 * 1000) return;
  try {
    await runAffinityBatch(env, { pagesPerRun: 120 });
  } catch (e) {
    await icpState(env, "affinity_last_error_at", new Date().toISOString());
    await icpState(env, "affinity_last_error", String(e.message || e).slice(0, 300));
  }
}

// Weekly refresh state machine (cron-driven): keeps the exact ICP analysis current
// without a heavy scan every night. Phase 1 re-syncs Klaviyo profiles (refreshes each
// customer's CURRENT stage), in safe ~50-page chunks per tick; when complete, phase 2
// restarts the exact affinity build (refreshes order data), advanced by
// tickStageAffinity. Runs at most once every 7 days. Deploying with no prior
// completion makes it due immediately (doubles as a manual kick).
async function tickWeeklyIcpRefresh(env) {
  if (!env.SHOPIFY_ACCESS_TOKEN || !env.KLAVIYO_API_KEY) return;
  const phase = await icpState(env, "weekly_refresh_phase");

  if (phase === null) {
    const last = await icpState(env, "weekly_refresh_completed");
    const due = !last || (Date.now() - new Date(last).getTime()) > 7 * 24 * 60 * 60 * 1000;
    if (!due) return;
    if ((await icpState(env, "affinity_running")) !== null) return; // don't collide with a manual build
    await icpState(env, "weekly_refresh_phase", "profiles");
    await icpState(env, "weekly_refresh_started", new Date().toISOString());
    const r = await syncIcpProfiles(env, { restart: true, maxPagesPerSegment: 50 });
    if (r.complete) { await icpState(env, "weekly_refresh_phase", "affinity"); await beginAffinityRun(env); }
    return;
  }

  if (phase === "profiles") {
    const r = await syncIcpProfiles(env, { maxPagesPerSegment: 50 });
    if (r.complete) { await icpState(env, "weekly_refresh_phase", "affinity"); await beginAffinityRun(env); }
    return;
  }

  if (phase === "affinity") {
    // tickStageAffinity advances the build; when it finishes (affinity_running cleared) the cycle is done.
    if ((await icpState(env, "affinity_running")) === null) {
      await icpState(env, "weekly_refresh_completed", new Date().toISOString());
      await icpState(env, "weekly_refresh_phase", null);
    }
  }
}

// ===== MAIN WORKER =====

// ===== LIST GROWTH MODULE =====
// Tracks gross new subscriptions per Klaviyo list so we can see which
// lead magnets are pulling. Reuses klaviyoFetch + KLAVIYO_API constants from
// the ICP module above. Data lives in env.DB alongside the ICP tables.
//
// Required env: KLAVIYO_API_KEY (already configured for ICP)
//
// Data flow:
//  1. List registry (klaviyo_lists) — periodically refreshed from GET /api/lists
//  2. Daily backfill — pulls "Subscribed to List" metric aggregates from
//     Klaviyo grouped by List name, writes one row per (list, day) into
//     klaviyo_list_subs.
//  3. Ongoing pulls — same query but only the last few days, run from cron
//     every 6 hours (gated inside the existing 2-min cron).
//
// Known caveats (surfaced in the UI):
//  - Klaviyo's "Subscribed to List" event is only recorded for opt-ins via
//    forms / API single-subscribe / opt-in pages. Profiles imported in bulk
//    or added via double-opt-in flows on existing subscribers may NOT log
//    the event, so absolute numbers can differ from Klaviyo's own dashboard
//    growth reports. Relative comparisons across lists are still valid.
//  - Metric aggregates can only group by List name, not list_id, so we join
//    back to klaviyo_lists by name. If two lists share the same exact name
//    in Klaviyo, their counts will be merged in the dashboard.

async function initGrowthTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS klaviyo_lists (
      list_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lead_magnet_label TEXT,
      category TEXT DEFAULT 'other',
      is_active INTEGER DEFAULT 1,
      created_kl TEXT,
      updated_kl TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS klaviyo_list_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_name TEXT NOT NULL,
      list_id TEXT,
      bucket_date TEXT NOT NULL,
      gross_subs INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT DEFAULT (datetime('now')),
      UNIQUE(list_name, bucket_date)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS growth_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS growth_categories (
      name TEXT PRIMARY KEY,
      sort_order INTEGER DEFAULT 100,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_list_subs_date ON klaviyo_list_subs(bucket_date)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_list_subs_name ON klaviyo_list_subs(list_name)`),
  ]);

  // Seed default categories ONLY on first-ever run. Without this guard, every
  // API request would re-INSERT-OR-IGNORE the seed rows, which means any
  // category the user deletes ('lead_magnet', 'purchaser', 'system') would
  // get resurrected on the very next GET. The seeds are a one-time convenience,
  // not invariants.
  //
  // We track first-run via a sentinel row in growth_sync_state. 'other' must
  // always exist regardless because it's the demote target — that one we
  // re-create unconditionally below.
  const seeded = await db.prepare(
    `SELECT value FROM growth_sync_state WHERE key = 'categories_seeded'`
  ).first();
  if (!seeded) {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO growth_categories (name, sort_order, is_default) VALUES ('lead_magnet', 10, 0)`),
      db.prepare(`INSERT OR IGNORE INTO growth_categories (name, sort_order, is_default) VALUES ('purchaser', 20, 0)`),
      db.prepare(`INSERT OR IGNORE INTO growth_categories (name, sort_order, is_default) VALUES ('system', 30, 0)`),
      db.prepare(`INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES ('categories_seeded', '1', datetime('now'))`),
    ]);
  }

  // 'other' is always present — it's the fallback bucket lists demote to when
  // their category gets deleted. Safe to re-INSERT-OR-IGNORE on every call.
  await db.prepare(
    `INSERT OR IGNORE INTO growth_categories (name, sort_order, is_default) VALUES ('other', 99, 1)`
  ).run();

  // One-time migration: earlier deploys marked all four seed rows as defaults.
  // Reset the three non-fallback ones so they can be deleted. Guarded the same
  // way so it doesn't re-run after the user has made changes.
  const migrated = await db.prepare(
    `SELECT value FROM growth_sync_state WHERE key = 'categories_defaults_migrated'`
  ).first();
  if (!migrated) {
    await db.batch([
      db.prepare(`UPDATE growth_categories SET is_default = 0 WHERE name IN ('lead_magnet', 'purchaser', 'system')`),
      db.prepare(`UPDATE growth_categories SET is_default = 1 WHERE name = 'other'`),
      db.prepare(`INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES ('categories_defaults_migrated', '1', datetime('now'))`),
    ]);
  }
}

// Resolves and caches the "Subscribed to List" metric ID. Klaviyo's
// internal metrics don't have a stable known ID across accounts so we look
// it up once and stash it.
async function getSubscribedToListMetricId(env) {
  const db = env.DB;
  const cached = await db.prepare(
    `SELECT value FROM growth_sync_state WHERE key = 'subscribed_to_list_metric_id'`
  ).first();
  if (cached?.value) return cached.value;

  // Pull metrics 1 page at a time looking for the exact name.
  let url = `${KLAVIYO_API}/metrics/`;
  while (url) {
    const data = await klaviyoFetch(url, env);
    const match = (data.data || []).find(m => m.attributes?.name === "Subscribed to List");
    if (match) {
      await db.prepare(
        `INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
      ).bind("subscribed_to_list_metric_id", match.id).run();
      return match.id;
    }
    url = data.links?.next || null;
  }
  throw new Error("Could not find 'Subscribed to List' metric in Klaviyo account");
}

// Refresh the list registry from Klaviyo. Preserves any lead_magnet_label /
// category the user has set in the dashboard.
async function syncListRegistry(env) {
  const db = env.DB;
  let url = `${KLAVIYO_API}/lists/?page[size]=10`;
  let added = 0;
  let updated = 0;

  while (url) {
    const data = await klaviyoFetch(url, env);
    const lists = data.data || [];
    if (lists.length === 0) break;

    // For each list, upsert without clobbering user-edited fields.
    const stmts = lists.map(l => {
      return db.prepare(`
        INSERT INTO klaviyo_lists (list_id, name, created_kl, updated_kl, synced_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(list_id) DO UPDATE SET
          name = excluded.name,
          updated_kl = excluded.updated_kl,
          synced_at = datetime('now')
      `).bind(l.id, l.attributes?.name || "(unnamed)", l.attributes?.created || null, l.attributes?.updated || null);
    });
    await db.batch(stmts);
    added += lists.length;

    url = data.links?.next || null;
  }

  await db.prepare(
    `INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).bind("registry_last_sync", new Date().toISOString()).run();

  return { lists_seen: added };
}

// Pull "Subscribed to List" daily counts grouped by list name.
// `days` is how many days back to fetch (start of the window).
// Klaviyo's metric aggregates endpoint is a POST with a JSON body.
// Klaviyo caps the date range at 1 year per request — callers that need
// more history should chunk and call fetchListSubsAggregatesRange instead.
async function fetchListSubsAggregates(env, days) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0); // start of today UTC
  // Bump end forward to tomorrow so today's partial bucket is included.
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return fetchListSubsAggregatesRange(env, start, end);
}

// Explicit-range version. start and end are Date objects (UTC, inclusive/exclusive).
// Klaviyo's metric-aggregates endpoint enforces a max 366-day range per call.
async function fetchListSubsAggregatesRange(env, start, end) {
  const metricId = await getSubscribedToListMetricId(env);

  const body = {
    data: {
      type: "metric-aggregate",
      attributes: {
        metric_id: metricId,
        interval: "day",
        measurements: ["count"],
        by: ["List"],
        filter: [
          `greater-or-equal(datetime,${start.toISOString()})`,
          `less-than(datetime,${end.toISOString()})`,
        ],
        timezone: "UTC",
      },
    },
  };

  const res = await fetch(`${KLAVIYO_API}/metric-aggregates/`, {
    method: "POST",
    headers: {
      "Authorization": `Klaviyo-API-Key ${env.KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "revision": KLAVIYO_REVISION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Klaviyo metric-aggregates ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Parse the aggregate response into [{list_name, date, count}] rows.
// Klaviyo returns:
//   data.attributes.dates: ["2026-04-01T00:00:00+00:00", ...]
//   data.attributes.data: [{ dimensions: ["List Name"], measurements: { count: [n, n, ...] } }, ...]
function parseAggregateResponse(payload) {
  const attrs = payload?.data?.attributes;
  if (!attrs) return [];
  const dates = attrs.dates || [];
  const rows = [];
  for (const series of (attrs.data || [])) {
    const listName = (series.dimensions || [])[0];
    if (!listName) continue;
    const counts = series.measurements?.count || [];
    for (let i = 0; i < counts.length && i < dates.length; i++) {
      const c = counts[i];
      if (c == null) continue;
      // Trim to YYYY-MM-DD
      const date = dates[i].slice(0, 10);
      rows.push({ list_name: listName, date, count: c });
    }
  }
  return rows;
}

async function writeAggregateRows(env, rows) {
  if (rows.length === 0) return 0;
  const db = env.DB;

  // Lookup table from name -> list_id (best-effort; some lists with shared
  // names will just take whichever list_id comes back first).
  const lookup = new Map();
  const lists = await db.prepare(`SELECT list_id, name FROM klaviyo_lists`).all();
  for (const l of lists.results || []) {
    if (!lookup.has(l.name)) lookup.set(l.name, l.list_id);
  }

  // D1 batch size limit ~100 statements, so chunk.
  const CHUNK = 80;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const stmts = slice.map(r => db.prepare(`
      INSERT INTO klaviyo_list_subs (list_name, list_id, bucket_date, gross_subs, captured_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(list_name, bucket_date) DO UPDATE SET
        gross_subs = excluded.gross_subs,
        list_id = COALESCE(excluded.list_id, klaviyo_list_subs.list_id),
        captured_at = datetime('now')
    `).bind(r.list_name, lookup.get(r.list_name) || null, r.date, r.count));
    await db.batch(stmts);
    written += stmts.length;
  }
  return written;
}

async function syncGrowthBackfill(env, days = 90) {
  const db = env.DB;
  await syncListRegistry(env);
  const payload = await fetchListSubsAggregates(env, days);
  const rows = parseAggregateResponse(payload);
  const written = await writeAggregateRows(env, rows);
  await db.prepare(
    `INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).bind("last_full_backfill", new Date().toISOString()).run();
  return { days_requested: days, lists_with_subs: new Set(rows.map(r => r.list_name)).size, rows_written: written };
}

// Year-by-year backfill walking backward from today until we hit a year with
// no data (or the safety cap). Each call to Klaviyo covers ~365 days, the max
// the metric-aggregates endpoint accepts in a single request.
//
// Stop conditions: empty year (no rows), 10-year safety cap, or
// pre-2018 floor (the Subscribed to List event was only added in late 2018
// and almost no accounts have meaningful data before then).
async function syncGrowthBackfillAllTime(env) {
  const db = env.DB;
  await syncListRegistry(env);

  const MAX_YEARS = 10;
  const FLOOR_YEAR = 2018;

  const yearEnd = new Date();
  yearEnd.setUTCHours(0, 0, 0, 0);
  yearEnd.setUTCDate(yearEnd.getUTCDate() + 1); // tomorrow, exclusive

  const summary = { years_processed: 0, years_with_data: 0, rows_written: 0, lists_with_subs: new Set(), earliest_date: null };

  for (let y = 0; y < MAX_YEARS; y++) {
    const yearStart = new Date(yearEnd);
    yearStart.setUTCFullYear(yearStart.getUTCFullYear() - 1);

    // Don't go before the floor year
    if (yearStart.getUTCFullYear() < FLOOR_YEAR) {
      yearStart.setUTCFullYear(FLOOR_YEAR, 0, 1);
      if (yearStart >= yearEnd) break;
    }

    const payload = await fetchListSubsAggregatesRange(env, yearStart, yearEnd);
    const rows = parseAggregateResponse(payload);
    summary.years_processed++;

    if (rows.length === 0) {
      // No data this year — assume no further data going back. Stop here.
      break;
    }

    summary.years_with_data++;
    const written = await writeAggregateRows(env, rows);
    summary.rows_written += written;
    for (const r of rows) {
      summary.lists_with_subs.add(r.list_name);
      if (!summary.earliest_date || r.date < summary.earliest_date) {
        summary.earliest_date = r.date;
      }
    }

    // Move window back another year
    yearEnd.setTime(yearStart.getTime());

    // Don't go past the floor
    if (yearEnd.getUTCFullYear() < FLOOR_YEAR) break;
  }

  await db.prepare(
    `INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).bind("last_full_backfill", new Date().toISOString()).run();
  await db.prepare(
    `INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).bind("last_alltime_backfill", new Date().toISOString()).run();

  return {
    years_processed: summary.years_processed,
    years_with_data: summary.years_with_data,
    rows_written: summary.rows_written,
    lists_with_subs: summary.lists_with_subs.size,
    earliest_date: summary.earliest_date,
  };
}

// Incremental sync — refresh the most recent 7 days. Cheap and covers any
// late-arriving events without re-fetching the world.
async function syncGrowthRecent(env) {
  const db = env.DB;
  const payload = await fetchListSubsAggregates(env, 7);
  const rows = parseAggregateResponse(payload);
  const written = await writeAggregateRows(env, rows);
  await db.prepare(
    `INSERT OR REPLACE INTO growth_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).bind("last_recent_sync", new Date().toISOString()).run();
  return { rows_written: written, lists_seen: new Set(rows.map(r => r.list_name)).size };
}

async function handleGrowthAPI(request, env, path) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  const db = env.DB;
  await initGrowthTables(db);

  try {
    // ----- Status / metadata -----
    if (path === "/growth/api/status" && request.method === "GET") {
      const [listsRow, subsRow, syncState] = await db.batch([
        db.prepare(`SELECT COUNT(*) as c FROM klaviyo_lists`),
        db.prepare(`SELECT COUNT(*) as c, MIN(bucket_date) as earliest, MAX(bucket_date) as latest, SUM(gross_subs) as total FROM klaviyo_list_subs`),
        db.prepare(`SELECT key, value, updated_at FROM growth_sync_state`),
      ]);
      return new Response(JSON.stringify({
        lists: listsRow.results[0],
        subs: subsRow.results[0],
        sync_state: syncState.results,
      }), { headers: cors });
    }

    // ----- Refresh just the list registry -----
    if (path === "/growth/api/sync/registry" && request.method === "POST") {
      if (!env.KLAVIYO_API_KEY) return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY not configured" }), { status: 500, headers: cors });
      const result = await syncListRegistry(env);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    // ----- Backfill: full historical pull -----
    if (path === "/growth/api/sync/backfill" && request.method === "POST") {
      if (!env.KLAVIYO_API_KEY) return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY not configured" }), { status: 500, headers: cors });
      const url = new URL(request.url);
      const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "90")));
      const result = await syncGrowthBackfill(env, days);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    // ----- Backfill: all-time, year-by-year until empty year -----
    if (path === "/growth/api/sync/backfill-all" && request.method === "POST") {
      if (!env.KLAVIYO_API_KEY) return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY not configured" }), { status: 500, headers: cors });
      const result = await syncGrowthBackfillAllTime(env);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    // ----- Incremental: last 7 days only -----
    if (path === "/growth/api/sync/recent" && request.method === "POST") {
      if (!env.KLAVIYO_API_KEY) return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY not configured" }), { status: 500, headers: cors });
      const result = await syncGrowthRecent(env);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    }

    // ----- List registry CRUD (label + category editing) -----
    if (path === "/growth/api/lists" && request.method === "GET") {
      const result = await db.prepare(`
        SELECT l.list_id, l.name, l.lead_magnet_label, l.category, l.is_active,
               l.created_kl, l.updated_kl,
               COALESCE(SUM(s.gross_subs), 0) as all_time_subs
        FROM klaviyo_lists l
        LEFT JOIN klaviyo_list_subs s ON s.list_name = l.name
        GROUP BY l.list_id
        ORDER BY all_time_subs DESC, l.name
      `).all();
      return new Response(JSON.stringify({ lists: result.results }), { headers: cors });
    }

    if (path === "/growth/api/lists" && request.method === "POST") {
      const body = await request.json();
      const { list_id, lead_magnet_label, category, is_active } = body;
      if (!list_id) return new Response(JSON.stringify({ error: "list_id required" }), { status: 400, headers: cors });
      await db.prepare(`
        UPDATE klaviyo_lists
        SET lead_magnet_label = ?, category = ?, is_active = ?
        WHERE list_id = ?
      `).bind(lead_magnet_label || null, category || 'other', is_active ? 1 : 0, list_id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ----- Categories CRUD -----
    if (path === "/growth/api/categories" && request.method === "GET") {
      // Return categories with the count of lists assigned to each.
      const result = await db.prepare(`
        SELECT c.name, c.sort_order, c.is_default,
               COUNT(l.list_id) as list_count
        FROM growth_categories c
        LEFT JOIN klaviyo_lists l ON l.category = c.name
        GROUP BY c.name
        ORDER BY c.sort_order, c.name
      `).all();
      return new Response(JSON.stringify({ categories: result.results || [] }), { headers: cors });
    }

    if (path === "/growth/api/categories" && request.method === "POST") {
      const body = await request.json();
      const name = (body.name || "").trim().toLowerCase().replace(/\s+/g, "_");
      if (!name) return new Response(JSON.stringify({ error: "name required" }), { status: 400, headers: cors });
      if (name.length > 40) return new Response(JSON.stringify({ error: "name too long (max 40 chars)" }), { status: 400, headers: cors });
      if (!/^[a-z0-9_]+$/.test(name)) return new Response(JSON.stringify({ error: "name must be lowercase letters, numbers, and underscores only" }), { status: 400, headers: cors });

      // INSERT OR IGNORE so re-adding an existing one is a no-op rather than an error
      await db.prepare(
        `INSERT OR IGNORE INTO growth_categories (name, sort_order, is_default) VALUES (?, ?, 0)`
      ).bind(name, body.sort_order || 50).run();
      return new Response(JSON.stringify({ ok: true, name }), { headers: cors });
    }

    // Delete is keyed by name in the URL path: /growth/api/categories/<name>
    if (path.startsWith("/growth/api/categories/") && request.method === "DELETE") {
      const name = decodeURIComponent(path.slice("/growth/api/categories/".length));
      if (!name) return new Response(JSON.stringify({ error: "name required" }), { status: 400, headers: cors });

      // Protect defaults (currently just 'other') from deletion.
      const row = await db.prepare(`SELECT is_default FROM growth_categories WHERE name = ?`).bind(name).first();
      if (!row) return new Response(JSON.stringify({ error: "category not found" }), { status: 404, headers: cors });
      if (row.is_default) return new Response(JSON.stringify({ error: `'${name}' is a default category and can't be deleted` }), { status: 400, headers: cors });

      // Demote any lists in this category to 'other', then delete the category.
      await db.batch([
        db.prepare(`UPDATE klaviyo_lists SET category = 'other' WHERE category = ?`).bind(name),
        db.prepare(`DELETE FROM growth_categories WHERE name = ?`).bind(name),
      ]);
      return new Response(JSON.stringify({ ok: true, demoted: true }), { headers: cors });
    }

    // ----- Category totals for pill bar (single round-trip vs. one per category) -----
    if (path === "/growth/api/category-totals" && request.method === "GET") {
      const url = new URL(request.url);
      const days = Math.max(1, Math.min(3650, parseInt(url.searchParams.get("days") || "30")));
      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(end.getUTCDate() + 1);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - days);
      const cutoff = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);

      // Sum subs per category, plus a synthetic "_all" total.
      const perCat = await db.prepare(`
        SELECT COALESCE(l.category, 'other') as category,
               SUM(s.gross_subs) as subs,
               COUNT(DISTINCT s.list_name) as list_count
        FROM klaviyo_list_subs s
        LEFT JOIN klaviyo_lists l ON l.name = s.list_name
        WHERE s.bucket_date >= ? AND s.bucket_date < ?
        GROUP BY COALESCE(l.category, 'other')
      `).bind(cutoff, endStr).all();

      const totals = {};
      let grand = 0;
      let grandLists = 0;
      for (const r of (perCat.results || [])) {
        totals[r.category] = { subs: r.subs || 0, list_count: r.list_count || 0 };
        grand += r.subs || 0;
        grandLists += r.list_count || 0;
      }
      return new Response(JSON.stringify({
        days,
        totals,
        _all: { subs: grand, list_count: grandLists },
      }), { headers: cors });
    }

    // ----- Leaderboard: gross subs per list over a window -----
    if (path === "/growth/api/leaderboard" && request.method === "GET") {
      const url = new URL(request.url);
      const days = Math.max(1, Math.min(3650, parseInt(url.searchParams.get("days") || "30")));
      const categoryFilter = url.searchParams.get("category");  // optional

      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(end.getUTCDate() + 1);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - days);
      const prevStart = new Date(start);
      prevStart.setUTCDate(prevStart.getUTCDate() - days);

      const cutoff = start.toISOString().slice(0, 10);
      const prevCutoff = prevStart.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);

      // Build the category filter clause — applied to BOTH current and previous
      // window so totals and deltas stay apples-to-apples within the category.
      // If no category specified, no filter; if specified, must match exactly.
      const catClause = categoryFilter ? ` AND COALESCE(l.category, 'other') = ?` : "";
      const catBind = categoryFilter ? [categoryFilter] : [];

      // Current window
      const current = await db.prepare(`
        SELECT s.list_name, COALESCE(l.list_id, s.list_id) as list_id,
               COALESCE(l.lead_magnet_label, s.list_name) as label,
               COALESCE(l.category, 'other') as category,
               SUM(s.gross_subs) as gross_subs,
               COUNT(DISTINCT s.bucket_date) as days_with_data
        FROM klaviyo_list_subs s
        LEFT JOIN klaviyo_lists l ON l.name = s.list_name
        WHERE s.bucket_date >= ? AND s.bucket_date < ?${catClause}
        GROUP BY s.list_name
        ORDER BY gross_subs DESC
      `).bind(cutoff, endStr, ...catBind).all();

      // Previous window for delta — same category filter
      const previous = await db.prepare(`
        SELECT s.list_name, SUM(s.gross_subs) as prev_subs
        FROM klaviyo_list_subs s
        LEFT JOIN klaviyo_lists l ON l.name = s.list_name
        WHERE s.bucket_date >= ? AND s.bucket_date < ?${catClause}
        GROUP BY s.list_name
      `).bind(prevCutoff, cutoff, ...catBind).all();

      const prevMap = new Map((previous.results || []).map(r => [r.list_name, r.prev_subs || 0]));

      const total = (current.results || []).reduce((a, r) => a + (r.gross_subs || 0), 0);
      const rows = (current.results || []).map(r => {
        const prev = prevMap.get(r.list_name) || 0;
        const delta = (r.gross_subs || 0) - prev;
        const pct_change = prev > 0 ? delta / prev : (r.gross_subs > 0 ? null : 0);
        return {
          list_name: r.list_name,
          list_id: r.list_id,
          label: r.label,
          category: r.category || 'other',
          gross_subs: r.gross_subs || 0,
          daily_avg: r.days_with_data > 0 ? (r.gross_subs / r.days_with_data) : 0,
          pct_of_total: total > 0 ? (r.gross_subs / total) : 0,
          prev_subs: prev,
          delta,
          pct_change,
        };
      });

      return new Response(JSON.stringify({
        days,
        window_start: cutoff,
        window_end: endStr,
        total_subs: total,
        rows,
      }), { headers: cors });
    }

    // ----- Time series for chart -----
    if (path === "/growth/api/timeseries" && request.method === "GET") {
      const url = new URL(request.url);
      const days = Math.max(1, Math.min(3650, parseInt(url.searchParams.get("days") || "30")));
      const topN = Math.max(1, Math.min(20, parseInt(url.searchParams.get("top") || "8")));

      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(end.getUTCDate() + 1);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - days);
      const cutoff = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);

      // Top N lists for window
      const topLists = await db.prepare(`
        SELECT s.list_name, COALESCE(l.lead_magnet_label, s.list_name) as label,
               SUM(s.gross_subs) as total
        FROM klaviyo_list_subs s
        LEFT JOIN klaviyo_lists l ON l.name = s.list_name
        WHERE s.bucket_date >= ? AND s.bucket_date < ?
        GROUP BY s.list_name
        ORDER BY total DESC
        LIMIT ?
      `).bind(cutoff, endStr, topN).all();

      const topNames = (topLists.results || []).map(r => r.list_name);
      const labelMap = new Map((topLists.results || []).map(r => [r.list_name, r.label]));

      // Pull series for those lists
      let series = { results: [] };
      if (topNames.length > 0) {
        const placeholders = topNames.map(() => "?").join(",");
        series = await db.prepare(`
          SELECT bucket_date, list_name, gross_subs
          FROM klaviyo_list_subs
          WHERE bucket_date >= ? AND bucket_date < ?
            AND list_name IN (${placeholders})
          ORDER BY bucket_date
        `).bind(cutoff, endStr, ...topNames).all();
      }

      // Pivot into [{date, list_a: n, list_b: n, ...}]
      const byDate = new Map();
      for (const r of (series.results || [])) {
        if (!byDate.has(r.bucket_date)) byDate.set(r.bucket_date, { date: r.bucket_date });
        byDate.get(r.bucket_date)[r.list_name] = r.gross_subs || 0;
      }

      // Fill missing dates with zeros so the chart is continuous
      const dateList = [];
      const d = new Date(start);
      while (d < end) {
        dateList.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
      }
      const out = dateList.map(date => {
        const row = byDate.get(date) || { date };
        for (const name of topNames) {
          if (row[name] == null) row[name] = 0;
        }
        return row;
      });

      return new Response(JSON.stringify({
        days,
        series_keys: topNames.map(n => ({ key: n, label: labelMap.get(n) || n })),
        rows: out,
      }), { headers: cors });
    }

    // ----- Movers: biggest accelerators and decelerators -----
    if (path === "/growth/api/movers" && request.method === "GET") {
      const url = new URL(request.url);
      const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get("days") || "14")));
      // Compare last `days` to prior `days`
      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(end.getUTCDate() + 1);
      const cutA = new Date(end); cutA.setUTCDate(cutA.getUTCDate() - days);
      const cutB = new Date(cutA); cutB.setUTCDate(cutB.getUTCDate() - days);

      const endStr = end.toISOString().slice(0, 10);
      const cutAStr = cutA.toISOString().slice(0, 10);
      const cutBStr = cutB.toISOString().slice(0, 10);

      const result = await db.prepare(`
        WITH curr AS (
          SELECT list_name, SUM(gross_subs) as subs
          FROM klaviyo_list_subs
          WHERE bucket_date >= ? AND bucket_date < ?
          GROUP BY list_name
        ),
        prev AS (
          SELECT list_name, SUM(gross_subs) as subs
          FROM klaviyo_list_subs
          WHERE bucket_date >= ? AND bucket_date < ?
          GROUP BY list_name
        )
        SELECT
          COALESCE(c.list_name, p.list_name) as list_name,
          COALESCE(l.lead_magnet_label, COALESCE(c.list_name, p.list_name)) as label,
          COALESCE(c.subs, 0) as curr_subs,
          COALESCE(p.subs, 0) as prev_subs,
          (COALESCE(c.subs, 0) - COALESCE(p.subs, 0)) as delta
        FROM curr c
        FULL OUTER JOIN prev p ON p.list_name = c.list_name
        LEFT JOIN klaviyo_lists l ON l.name = COALESCE(c.list_name, p.list_name)
        WHERE (COALESCE(c.subs, 0) + COALESCE(p.subs, 0)) >= 5
      `).bind(cutAStr, endStr, cutBStr, cutAStr).all().catch(async () => {
        // D1 doesn't support FULL OUTER JOIN; fall back to UNION emulation.
        return db.prepare(`
          WITH curr AS (
            SELECT list_name, SUM(gross_subs) as subs
            FROM klaviyo_list_subs
            WHERE bucket_date >= ? AND bucket_date < ?
            GROUP BY list_name
          ),
          prev AS (
            SELECT list_name, SUM(gross_subs) as subs
            FROM klaviyo_list_subs
            WHERE bucket_date >= ? AND bucket_date < ?
            GROUP BY list_name
          ),
          combined AS (
            SELECT list_name FROM curr
            UNION
            SELECT list_name FROM prev
          )
          SELECT
            cb.list_name,
            COALESCE(l.lead_magnet_label, cb.list_name) as label,
            COALESCE(c.subs, 0) as curr_subs,
            COALESCE(p.subs, 0) as prev_subs,
            (COALESCE(c.subs, 0) - COALESCE(p.subs, 0)) as delta
          FROM combined cb
          LEFT JOIN curr c ON c.list_name = cb.list_name
          LEFT JOIN prev p ON p.list_name = cb.list_name
          LEFT JOIN klaviyo_lists l ON l.name = cb.list_name
          WHERE (COALESCE(c.subs, 0) + COALESCE(p.subs, 0)) >= 5
        `).bind(cutAStr, endStr, cutBStr, cutAStr).all();
      });

      const rows = (result.results || []).map(r => ({
        list_name: r.list_name,
        label: r.label,
        curr_subs: r.curr_subs || 0,
        prev_subs: r.prev_subs || 0,
        delta: r.delta || 0,
        pct_change: r.prev_subs > 0 ? r.delta / r.prev_subs : null,
      }));
      rows.sort((a, b) => (b.pct_change ?? -Infinity) - (a.pct_change ?? -Infinity));
      const accelerators = rows.filter(r => r.delta > 0).slice(0, 5);
      const decelerators = rows.filter(r => r.delta < 0).slice(-5).reverse();

      return new Response(JSON.stringify({
        days,
        window_curr: [cutAStr, endStr],
        window_prev: [cutBStr, cutAStr],
        accelerators,
        decelerators,
      }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers: cors });
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ===== STAGE TIMING (handles /stage/* ; returns null otherwise) =====
    const stageResp = await handleStageRoutes(request, env, ctx, path);
    if (stageResp) return stageResp;

    // Helper: add noindex header to any response
    function addNoIndex(response) {
      const newResp = new Response(response.body, response);
      newResp.headers.set("X-Robots-Tag", "noindex, nofollow");
      return newResp;
    }

    if (request.method === "OPTIONS") { return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }); }
    // ===== CX AGENT =====
    if (path === "/cx-agent/webhook/zendesk") { return handleCxAgentWebhook(request, env, ctx); }
    if (path === "/cx-agent/webhook/zendesk-reply") { return handleCxAgentReplyWebhook(request, env, ctx); }
    if (path.startsWith("/cx-agent/api/")) { return handleCxAgentAPI(request, env, path); }
    // ===== ICP =====
    if (path.startsWith("/icp/api/")) { return handleIcpAPI(request, env, path); }
    // ===== LIST GROWTH =====
    if (path.startsWith("/growth/api/")) { return handleGrowthAPI(request, env, path); }
    // ===== CONTENT TRACKER API (D1-backed) =====
    if (path === "/tracker/api/data") { return handleTrackerAPI(request, env); }
    // ===== SHIPMONK SYNC / PROBE =====
    if (path === "/3pl/api/shipmonk-sync") {
      try { const full = url.searchParams.get("full") === "1"; const r = await syncShipmonkOrders(env, { full }); return new Response(JSON.stringify({ success: true, ...r }), { headers: { "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } }); }
    }
    if (path === "/3pl/api/shipmonk-probe") {
      try {
        let orders = null, products = null;
        try { orders = await smFetch(env, "/orders-list", { method: "GET", query: { page: 1, pageSize: 2, sortOrder: "DESC" } }); } catch (e) { orders = { error: e.message }; }
        try { products = await smProductsSearch(env, { maxPages: 1 }); } catch (e) { products = { error: e.message }; }
        return new Response(JSON.stringify({ ordersSample: orders, productsSample: Array.isArray(products) ? products.slice(0, 2) : products }, null, 2), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } }); }
    }
    // ===== 3PL API (D1-backed) =====
    if (path.startsWith("/3pl/api/")) { return handle3plAPI(request, env, path); }
    // ===== MEDICAL SUPPLIES API (D1-backed) =====
    if (path.startsWith("/med-supplies/api/")) { return handleMedSuppliesAPI(request, env, path); }
    // ===== CAMPAIGN ROUTER API (D1-backed, shared audience config) =====
    if (path === "/campaign-router/api/audiences") {
      const SEED = [
        { id: "nclex",      name: "NCLEX peeps",                              color: "#993C1D", bg: "#FAECE7", condition: "List: Nursing student (Final year / NCLEX prep)" },
        { id: "repeat",     name: "Bought basically everything! (repeat customers)", color: "#534AB7", bg: "#EEEDFE", condition: "List: Customers who have purchased 2+ times" },
        { id: "bundle",     name: "Bundle Buyers",                            color: "#0F6E56", bg: "#E1F5EE", condition: "List: Bundle Purchasers [Last 365 days]" },
        { id: "nonbundle",  name: "Those who haven't purchased the Bundle",   color: "#854F0B", bg: "#FAEEDA", condition: "List: Engaged - 180 days" },
        { id: "prenursing", name: "Pre-nursing / A&P student",               color: "#185FA5", bg: "#E6F1FB", condition: "" },
        { id: "newgrad",    name: "New grad nurse (on the floor)",           color: "#993556", bg: "#FBEAF0", condition: "" },
        { id: "otherhcp",   name: "Other healthcare professional",           color: "#3B6D11", bg: "#EAF3DE", condition: "" },
      ];
      try {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaign_router_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`).run();
        if (request.method === "POST") {
          const body = await request.json();
          await env.DB.prepare(`INSERT OR REPLACE INTO campaign_router_config (key, value, updated_at) VALUES ('audiences', ?, datetime('now'))`).bind(JSON.stringify(body.audiences || [])).run();
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        }
        const row = await env.DB.prepare(`SELECT value FROM campaign_router_config WHERE key = 'audiences'`).first();
        if (!row) {
          await env.DB.prepare(`INSERT OR REPLACE INTO campaign_router_config (key, value, updated_at) VALUES ('audiences', ?, datetime('now'))`).bind(JSON.stringify(SEED)).run();
          return new Response(JSON.stringify({ audiences: SEED }), { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ audiences: JSON.parse(row.value) }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    // ===== CAMPAIGN ROUTER — KLAVIYO SIZES =====
    if (path.startsWith("/campaign-router/api/klaviyo")) {
      const cj = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
      if (!env.KLAVIYO_API_KEY) return cj({ error: "KLAVIYO_API_KEY not configured" }, 500);
      // Pull every page of a Klaviyo collection endpoint, following links.next.
      const klAll = async (startUrl, pageCap = 50) => {
        const items = []; let next = startUrl; let pages = 0;
        while (next && pages < pageCap) { const d = await klaviyoFetch(next, env); items.push(...(d.data || [])); next = d.links && d.links.next; pages++; }
        return { items, capped: !!next };
      };
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      try {
        // List every Klaviyo list + segment for the audience picker.
        // Note: Klaviyo's /lists/ and /segments/ endpoints cap page[size] at 10,
        // so we page through with size 10. Each type is fetched independently so
        // one failure can't blank the whole picker.
        if (path === "/campaign-router/api/klaviyo-options") {
          const fetchType = async (kind, t) => {
            try {
              const r = await klAll(`${KLAVIYO_API}/${kind}/?page[size]=10`, 200);
              return { options: r.items.map(x => ({ type: t, id: x.id, name: (x.attributes && x.attributes.name) || x.id })) };
            } catch (e) { return { error: `${kind}: ${e.message}` }; }
          };
          const [L, S] = await Promise.all([fetchType("lists", "list"), fetchType("segments", "segment")]);
          const options = [...(L.options || []), ...(S.options || [])].sort((a, b) => a.name.localeCompare(b.name));
          const errors = [L.error, S.error].filter(Boolean);
          return cj({ options, errors });
        }
        // Raw member counts for a set of refs: { refs: [{type,id}], force? }.
        // Klaviyo's profile_count field has a strict burst limit, so we fetch
        // sequentially with retry/backoff and cache results in D1 for 30 min.
        if (path === "/campaign-router/api/klaviyo-sizes" && request.method === "POST") {
          const { refs = [], force = false } = await request.json();
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaign_router_sizes (ref TEXT PRIMARY KEY, count INTEGER, updated_at TEXT)`).run();
          const sizes = {};
          const getCount = async (r, attempt = 0) => {
            try {
              const af = `additional-fields[${r.type}]=profile_count`;
              const d = await klaviyoFetch(`${KLAVIYO_API}/${r.type}s/${r.id}/?${af}`, env);
              return (d.data && d.data.attributes && d.data.attributes.profile_count) ?? null;
            } catch (e) {
              if (attempt < 5 && /429|rate.?limit/i.test(e.message)) { await sleep(700 * (attempt + 1)); return getCount(r, attempt + 1); }
              throw e;
            }
          };
          for (const r of refs.filter(r => r && r.id && r.type)) {
            const refKey = `${r.type}:${r.id}`;
            if (!force) {
              const cached = await env.DB.prepare(`SELECT count FROM campaign_router_sizes WHERE ref = ? AND updated_at > datetime('now','-30 minutes')`).bind(refKey).first();
              if (cached) { sizes[r.id] = cached.count; continue; }
            }
            try {
              const c = await getCount(r);
              sizes[r.id] = c;
              if (c != null) await env.DB.prepare(`INSERT OR REPLACE INTO campaign_router_sizes (ref, count, updated_at) VALUES (?, ?, datetime('now'))`).bind(refKey, c).run();
            } catch (e) { sizes[r.id] = null; }
          }
          return cj({ sizes });
        }
        // Exact mutually-exclusive net reach. Body: { tiers: [{id,type}] } in priority order.
        // Pull each audience's member ids (cached 6h in D1) in parallel, then apply
        // the waterfall: each tier's net = members not already counted by higher tiers.
        if (path === "/campaign-router/api/klaviyo-net-reach" && request.method === "POST") {
          const { tiers = [] } = await request.json();
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaign_router_members (ref TEXT PRIMARY KEY, ids TEXT, n INTEGER, updated_at TEXT)`).run();
          const PER_TIER_PAGE_CAP = 400; // up to ~40k profiles per audience

          const pullIds = async (t) => {
            if (!t || !t.id || !t.type) return { error: "not linked" };
            const refKey = `${t.type}:${t.id}`;
            try {
              const cached = await env.DB.prepare(`SELECT ids, n FROM campaign_router_members WHERE ref = ? AND updated_at > datetime('now','-6 hours')`).bind(refKey).first();
              if (cached && cached.ids) return { ids: JSON.parse(cached.ids), raw: cached.n };
            } catch (e) { /* cache miss / parse error — fall through to live pull */ }
            const ids = []; let capped = false, error = null, pages = 0;
            let next = `${KLAVIYO_API}/${t.type}s/${t.id}/profiles/?fields[profile]=id&page[size]=100`;
            try {
              while (next) {
                if (pages >= PER_TIER_PAGE_CAP) { capped = true; break; }
                const d = await klaviyoFetch(next, env); pages++;
                for (const p of (d.data || [])) ids.push(p.id);
                next = d.links && d.links.next;
              }
            } catch (e) { error = e.message; }
            if (!error && !capped) {
              try { if (ids.length <= 60000) await env.DB.prepare(`INSERT OR REPLACE INTO campaign_router_members (ref, ids, n, updated_at) VALUES (?, ?, ?, datetime('now'))`).bind(refKey, JSON.stringify(ids), ids.length).run(); } catch (e) { /* too large to cache — ignore */ }
            }
            return { ids, raw: ids.length, capped, error };
          };

          const pulled = await Promise.all(tiers.map(pullIds));
          const seen = new Set();
          const out = pulled.map((res, i) => {
            const id = tiers[i] && tiers[i].id;
            if (res.error) return { id, raw: res.raw ?? null, net: null, error: res.error };
            let net = 0;
            for (const x of res.ids) if (!seen.has(x)) net++;
            for (const x of res.ids) seen.add(x);
            return { id, raw: res.raw, net, capped: res.capped };
          });
          return cj({ tiers: out, totalReach: seen.size });
        }
        return cj({ error: "unknown klaviyo route" }, 404);
      } catch (err) {
        return cj({ error: err.message }, 500);
      }
    }
    // ===== INVENTORY =====
    if (path === "/inventory/api/shipmonk") { return getShipmonkInventory(env); }
    if (path === "/inventory/api/shipfusion") { return handleShipFusionAPI(request, env); }
    if (path === "/inventory/api/amazon-fba") { return handleAmazonFbaAPI(request, env); }
    // ===== CALENDAR =====
    if (path === "/calendar/api/config") { try { const { results } = await env.DB.prepare("SELECT key, value FROM config_cache").all(); const config = {}; results.forEach(r => { try { config[r.key] = JSON.parse(r.value); } catch { config[r.key] = r.value; } }); return new Response(JSON.stringify(config), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); } }
    if (path === "/calendar/api/tasks") { try { const { results } = await env.DB.prepare("SELECT * FROM tasks WHERE post_date IS NOT NULL ORDER BY post_date DESC").all(); const tasks = results.map(t => ({ ...t, customFields: JSON.parse(t.custom_fields || "[]"), tags: JSON.parse(t.tags || "[]") })); return new Response(JSON.stringify({ tasks, synced_at: new Date().toISOString() }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); } }
    if (path === "/calendar/api/sync") { try { const count = await fullSync(env); return new Response(JSON.stringify({ ok: true, tasks_synced: count }), { headers: { "Content-Type": "application/json" } }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); } }
    if (path.startsWith("/calendar/api/")) { const clickupPath = path.replace("/calendar/api/", ""); const clickupUrl = `${CLICKUP_API}/${clickupPath}${url.search}`; const headers = new Headers(request.headers); headers.set("Authorization", env.CLICKUP_TOKEN); headers.set("Content-Type", "application/json"); try { const resp = await fetch(clickupUrl, { method: request.method, headers, body: request.method !== "GET" ? await request.text() : undefined }); const respHeaders = new Headers(resp.headers); respHeaders.set("Access-Control-Allow-Origin", "*"); return new Response(resp.body, { status: resp.status, headers: respHeaders }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 502 }); } }
    // ===== REDIRECTS =====
    if (path === "/calendar") return Response.redirect(url.origin + "/calendar/", 301);
    if (path === "/3pl") return Response.redirect(url.origin + "/3pl/", 301);
    if (path === "/inventory") return Response.redirect(url.origin + "/inventory/", 301);
    if (path === "/ambassadors") return Response.redirect(url.origin + "/ambassadors/", 301);
    if (path === "/tracker") return Response.redirect(url.origin + "/tracker/", 301);
    if (path === "/cx-agent") return Response.redirect(url.origin + "/cx-agent/", 301);
    if (path === "/icp") return Response.redirect(url.origin + "/icp/", 301);
    if (path === "/growth") return Response.redirect(url.origin + "/growth/", 301);
    if (path === "/med-supplies") return Response.redirect(url.origin + "/med-supplies/", 301);
    // ===== LANDING PAGE =====
    if (path === "/" || path === "") { return new Response(landingPageHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8", "X-Robots-Tag": "noindex, nofollow" } }); }
    // ===== AMBASSADOR API =====
    if (path === "/ambassadors/api" || path === "/ambassadors/api/") {
      const db = env.DB;
      await db.prepare(`CREATE TABLE IF NOT EXISTS ambassador_data (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run();
      if (request.method === "GET") { const rows = await db.prepare("SELECT key, value FROM ambassador_data").all(); const result = {}; const orders = {}; for (const row of rows.results) { if (row.key === "ambassadors") { result.ambassadors = JSON.parse(row.value); } else if (row.key.startsWith("orders_")) { orders[row.key.replace("orders_", "")] = JSON.parse(row.value); } } result.orders = orders; return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
      if (request.method === "POST") { const body = await request.json(); const { key, value } = body; if (value === null) { await db.prepare("DELETE FROM ambassador_data WHERE key = ?").bind(key).run(); } else { await db.prepare("INSERT OR REPLACE INTO ambassador_data (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(key, JSON.stringify(value)).run(); } return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
      if (request.method === "DELETE") { await db.prepare("DELETE FROM ambassador_data").run(); return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
      if (request.method === "OPTIONS") { return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }); }
    }
    // ===== STATIC ASSETS (with noindex) =====
    const assetResp = await env.ASSETS.fetch(request);
    return addNoIndex(assetResp);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fullSync(env));
    // Advance background product-extraction jobs (a few chunks per tick).
    ctx.waitUntil((async () => { try { await processProductJobs(env); } catch (e) { /* non-fatal */ } })());
    // Catch customer follow-ups even if the Zendesk reply trigger doesn't fire.
    ctx.waitUntil((async () => { try { await sweepFollowups(env); } catch (e) { /* non-fatal */ } })());
    // Incremental ShipMonk orders sync, gated to ~every 10 min (cron fires every 2 min).
    ctx.waitUntil((async () => {
      try {
        if (!env.SHIPMONK_API_KEY) return;
        const lastRun = await smState(env, "cron_last_run");
        if (lastRun && (Date.now() - new Date(lastRun).getTime()) < 9 * 60 * 1000) return;
        await smState(env, "cron_last_run", new Date().toISOString());
        await syncShipmonkOrders(env, {});
      } catch (e) { /* cron sync errors are non-fatal */ }
    })());
    // Advance the Amazon FBA report state machine (poll pending / request when stale).
    ctx.waitUntil((async () => {
      try {
        if (!amzConfigured(env)) return;
        await syncAmazonFba(env);
      } catch (e) { /* cron sync errors are non-fatal */ }
    })());
    // Self-driving nightly Klaviyo-stage -> Shopify metafield sync (advances a batch
    // per tick while a run is in progress; starts fresh ~once a day).
    ctx.waitUntil((async () => {
      try { await tickStageMetafieldSync(env); } catch (e) { /* cron sync errors are non-fatal */ }
    })());
    // Advance an in-progress exact stage-affinity build (user-kicked; not auto-started).
    ctx.waitUntil((async () => {
      try { await tickStageAffinity(env); } catch (e) { /* cron sync errors are non-fatal */ }
    })());
    // Weekly refresh: re-sync Klaviyo profiles (stages) then rebuild exact affinity (orders).
    ctx.waitUntil((async () => {
      try { await tickWeeklyIcpRefresh(env); } catch (e) { /* cron sync errors are non-fatal */ }
    })());
  },
};
function landingPageHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NITM Operations Hub</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'DM Sans',system-ui,-apple-system,sans-serif;min-height:100vh}
.hub-wrap{max-width:1080px;margin:0 auto;padding:48px 24px 80px}
.hub-head{margin-bottom:40px}
.hub-title{font-size:30px;font-weight:700;letter-spacing:-0.4px;color:var(--text)}
.hub-sub{font-size:15px;color:var(--muted);margin-top:6px}
.hub-section{margin-bottom:34px}
.hub-section-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--faint);margin-bottom:14px}
.app-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:14px}
.app-card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;text-decoration:none;color:var(--text);transition:all .15s;display:flex;align-items:flex-start;gap:14px}
.app-card:hover{border-color:var(--border2);box-shadow:0 4px 14px rgba(17,24,39,0.06);transform:translateY(-2px)}
.app-icon{font-size:26px;line-height:1;flex:0 0 auto}
.app-text{display:flex;flex-direction:column;gap:3px}
.app-name{font-size:15px;font-weight:600;color:var(--text)}
.app-desc{font-size:13px;color:var(--muted);line-height:1.4}
@media(max-width:600px){.app-grid{grid-template-columns:1fr}.hub-title{font-size:24px}}
</style><script defer src="/shared/nav.js"></script></head><body>
<div class="hub-wrap">
  <div class="hub-head">
    <h1 class="hub-title">NITM Operations Hub</h1>
    <p class="hub-sub">Every tool to run the business, in one place. Pick where you're headed.</p>
  </div>

  <div class="hub-section">
    <div class="hub-section-label">Content &amp; Social</div>
    <div class="app-grid">
      <a href="/calendar/" class="app-card"><div class="app-icon">\u{1F4C5}</div><div class="app-text"><div class="app-name">Content Calendar</div><div class="app-desc">Plan &amp; schedule social posts (ClickUp)</div></div></a>
      <a href="/tracker/" class="app-card"><div class="app-icon">\u{1F3AF}</div><div class="app-text"><div class="app-name">Content Tracker</div><div class="app-desc">Instagram performance &amp; scoring</div></div></a>
      <a href="/social/" class="app-card"><div class="app-icon">\u{1F4F1}</div><div class="app-text"><div class="app-name">Social Attribution</div><div class="app-desc">Tie revenue back to social posts</div></div></a>
      <a href="/stage/" class="app-card"><div class="app-icon">\u{23F1}</div><div class="app-text"><div class="app-name">Stage Timing</div><div class="app-desc">How long tasks sit in each stage</div></div></a>
    </div>
  </div>

  <div class="hub-section">
    <div class="hub-section-label">Email &amp; Klaviyo</div>
    <div class="app-grid">
      <a href="/growth/" class="app-card"><div class="app-icon">\u{1F4C8}</div><div class="app-text"><div class="app-name">List Growth</div><div class="app-desc">Which Klaviyo lists are growing</div></div></a>
      <a href="/icp/" class="app-card"><div class="app-icon">\u{1F50D}</div><div class="app-text"><div class="app-name">ICP Analytics</div><div class="app-desc">Klaviyo segment + product analysis</div></div></a>
      <a href="/campaign-router/" class="app-card"><div class="app-icon">\u{1F4E8}</div><div class="app-text"><div class="app-name">Campaign Router</div><div class="app-desc">Build no-overlap Klaviyo sends</div></div></a>
    </div>
  </div>

  <div class="hub-section">
    <div class="hub-section-label">Inventory &amp; Fulfillment</div>
    <div class="app-grid">
      <a href="/inventory/" class="app-card"><div class="app-icon">\u{1F4CA}</div><div class="app-text"><div class="app-name">Inventory Dashboard</div><div class="app-desc">Stock levels, orders &amp; forecasting</div></div></a>
      <a href="/3pl/" class="app-card"><div class="app-icon">\u{1F4E6}</div><div class="app-text"><div class="app-name">3PL Dashboard</div><div class="app-desc">Warehouse &amp; fulfillment</div></div></a>
      <a href="/med-supplies/" class="app-card"><div class="app-icon">\u{1FA7A}</div><div class="app-text"><div class="app-name">Medical Supplies</div><div class="app-desc">Filming props inventory &amp; checkout</div></div></a>
    </div>
  </div>

  <div class="hub-section">
    <div class="hub-section-label">Customers &amp; Partners</div>
    <div class="app-grid">
      <a href="/cx-agent/" class="app-card"><div class="app-icon">\u{1F916}</div><div class="app-text"><div class="app-name">CX Agent</div><div class="app-desc">AI customer support automation</div></div></a>
      <a href="/ambassadors/" class="app-card"><div class="app-icon">\u{1F91D}</div><div class="app-text"><div class="app-name">Ambassadors</div><div class="app-desc">Ambassador sales &amp; commission tracking</div></div></a>
    </div>
  </div>
</div></body></html>`;
}
