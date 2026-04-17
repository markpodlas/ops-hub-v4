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
        tasks.push({ id: t.id, name: t.name, status: t.status?.status || "", post_date: postDate, list_id: list["List ID"], list_name: list["List Name"], brand: list.Brand, platform: list.Platform, color: list["Platform Color (Hex)"] || "#666", url: t.url || "", custom_fields: JSON.stringify(t.custom_fields || []) });
      });
      if (pageTasks.length < 100) break; page++;
    } catch { break; }
  }
  return tasks;
}
async function fullSync(env) {
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
    const stmts = batch.map(t => env.DB.prepare(`INSERT OR REPLACE INTO tasks (id, name, status, post_date, list_id, list_name, brand, platform, color, url, custom_fields, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).bind(t.id, t.name, t.status, t.post_date, t.list_id, t.list_name, t.brand, t.platform, t.color, t.url, t.custom_fields));
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
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('anthropic_model', 'claude-opus-4-7', 'string', 'Claude model'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('support_staff_ids', '[29324864593179,16129176780315,32863955019931,14117981153307]', 'json', 'Zendesk support staff IDs'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('max_order_age_days', '90', 'number', 'Max age (days) of orders the agent will auto-respond about'),
      db.prepare("INSERT INTO agent_config (key, value, value_type, description) VALUES (?, ?, ?, ?)").bind('require_email_match', 'true', 'boolean', 'If true, require Zendesk email matches Shopify order email (unless order number in ticket)'),
    ]);
  }

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

  const insertResult = await db.prepare(
    `INSERT INTO agent_tickets (zendesk_ticket_id, subject, customer_email, channel, first_customer_message, status) VALUES (?, ?, ?, ?, ?, 'processing')`
  ).bind(String(zendeskTicketId), ticketData.subject, ticketData.customerEmail, ticketData.channel, ticketData.firstMessage?.substring(0, 2000) || null).run();

  const ticketId = insertResult.meta.last_row_id;
  ctx.waitUntil(runCxAgentPipeline(ticketId, ticketData, db, env));
  return new Response(JSON.stringify({ accepted: true, ticket_id: ticketId, zendesk_ticket_id: zendeskTicketId }), { headers: cors });
}

async function runCxAgentPipeline(ticketId, ticketData, db, env) {
  const tracer = new CxTracer(db, ticketId);
  try {
    const intent = await tracer.trace('intent_classification', async () => cxClassifyIntent(ticketData, db, env));
    await db.prepare(`UPDATE agent_tickets SET classified_intent = ?, intent_confidence = ? WHERE id = ?`).bind(intent.intent, intent.confidence, ticketId).run();

    const scopeCheck = await tracer.trace('scope_check', async () => {
      const scopedIntents = await cxGetConfig(db, 'scoped_intents');
      const hardEscalateTopics = await cxGetConfig(db, 'hard_escalate_topics');
      const minConfidence = await cxGetConfig(db, 'min_confidence_to_respond');
      const isInScope = scopedIntents.includes(intent.intent);
      const shouldEscalate = hardEscalateTopics.some(t => intent.topics?.includes(t));
      const confidenceOk = intent.confidence >= minConfidence;
      return {
        in_scope: isInScope && !shouldEscalate && confidenceOk,
        reason: !isInScope ? 'Intent not in handled scope'
              : shouldEscalate ? 'Topic requires human review'
              : !confidenceOk ? `Confidence ${intent.confidence} below threshold ${minConfidence}`
              : 'In scope'
      };
    });

    if (!scopeCheck.in_scope) {
      await cxEscalate(ticketId, ticketData, intent, scopeCheck.reason, db, env, tracer);
      return;
    }
    await db.prepare('UPDATE agent_tickets SET is_in_scope = 1 WHERE id = ?').bind(ticketId).run();

    if (intent.intent === 'digital_access') {
      await cxHandleDigitalAccess(ticketId, ticketData, intent, db, env, tracer);
    } else {
      await cxEscalate(ticketId, ticketData, intent, `No handler for intent: ${intent.intent}`, db, env, tracer);
    }
  } catch (err) {
    console.error(`CX agent pipeline error for ticket ${ticketId}:`, err);
    await db.prepare(`UPDATE agent_tickets SET status = 'error', error_message = ? WHERE id = ?`).bind(err.message, ticketId).run();
    try { await tracer.trace('pipeline_error', async () => ({ error: err.message, stack: err.stack }), { status: 'error' }); } catch {}
  }
}

async function cxClassifyIntent(ticketData, db, env) {
  const model = await cxGetConfig(db, 'anthropic_model');
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
  const userPrompt = `Subject: ${ticketData.subject || '(no subject)'}\nChannel: ${ticketData.channel || 'unknown'}\n\nCustomer message:\n${(ticketData.firstMessage || '').substring(0, 3000)}`;
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
  // STEP: Detect order number in ticket (if any)
  const orderNumberMatch = (ticketData.subject || '').match(/#?(\d{1,2}-\d{4,7})/) || (ticketData.firstMessage || '').match(/#?(\d{1,2}-\d{4,7})/);
  const explicitOrderNumber = orderNumberMatch ? orderNumberMatch[1] : null;

  // STEP: Look up customer orders (may return multiple)
  const orderLookup = await tracer.trace('shopify_order_lookup', async () => {
    return await cxFindCustomerOrders(ticketData, explicitOrderNumber, db, env);
  });

  if (!orderLookup.order && !orderLookup.candidates?.length) {
    await cxEscalate(ticketId, ticketData, intent, 'Could not find any orders for this customer.', db, env, tracer, {
      customer_email: ticketData.customerEmail,
      explicit_order_number: explicitOrderNumber || 'none'
    });
    return;
  }

  // STEP: Multi-order disambiguation
  if (!orderLookup.order && orderLookup.candidates?.length > 1) {
    const summary = orderLookup.candidates.slice(0, 5).map(o =>
      `    ${o.name} (${new Date(o.created_at).toLocaleDateString()}) - ${o.line_items.filter(li => li.sku?.startsWith('D-')).map(li => li.sku).join(', ')}`
    ).join('\n');
    await cxEscalate(ticketId, ticketData, intent,
      `Customer has ${orderLookup.candidates.length} ebook orders in last 90 days. Needs human to identify which one they are asking about.`,
      db, env, tracer, {
        customer_email: ticketData.customerEmail,
        explicit_order_number: explicitOrderNumber || 'none',
        candidate_orders: '\n' + summary
      });
    return;
  }

  const order = orderLookup.order;

  // STEP: Safeguard checks
  const safeguardIssues = await tracer.trace('safeguard_checks', async () => {
    const issues = [];

    // Cancelled order
    if (order.cancelled_at) {
      issues.push(`Order was cancelled on ${new Date(order.cancelled_at).toLocaleDateString()}`);
    }

    // Refunded / voided
    if (order.financial_status === 'refunded' || order.financial_status === 'voided' || order.financial_status === 'partially_refunded') {
      issues.push(`Order financial status is '${order.financial_status}'`);
    }

    // Age check
    const maxAgeDays = await cxGetConfig(db, 'max_order_age_days');
    const orderAgeDays = Math.floor((Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24));
    if (orderAgeDays > maxAgeDays) {
      issues.push(`Order is ${orderAgeDays} days old (policy: max ${maxAgeDays} days)`);
    }

    // Email match (unless explicit order number was provided in ticket)
    const requireEmailMatch = await cxGetConfig(db, 'require_email_match');
    if (requireEmailMatch && !explicitOrderNumber) {
      const ticketEmail = (ticketData.customerEmail || '').toLowerCase().trim();
      const orderEmail = (order.email || '').toLowerCase().trim();
      if (ticketEmail && orderEmail && ticketEmail !== orderEmail) {
        issues.push(`Email mismatch: ticket from '${ticketEmail}' vs order billed to '${orderEmail}'. No order number in ticket to confirm which order.`);
      }
    }

    return {
      passed: issues.length === 0,
      issues,
      order_id: order.id,
      order_number: order.name,
      order_email: order.email,
      order_created_at: order.created_at,
      order_age_days: orderAgeDays,
      order_cancelled: !!order.cancelled_at,
      order_financial_status: order.financial_status,
      email_match_required: requireEmailMatch,
      explicit_order_number: explicitOrderNumber || null
    };
  });

  if (!safeguardIssues.passed) {
    await cxEscalate(ticketId, ticketData, intent,
      `Safeguard check failed: ${safeguardIssues.issues.join('; ')}`,
      db, env, tracer, {
        order_id: order.id,
        order_number: order.name,
        order_email: order.email,
        order_created: order.created_at,
        issues: safeguardIssues.issues.join(' | ')
      });
    return;
  }

  // STEP: Read fulfillment metafields
  const metafields = await tracer.trace('shopify_metafields_lookup', async () => cxFetchOrderMetafields(order.id, db, env));
  const vsStatus = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'status')?.value;
  const vsCode = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'code')?.value;
  const vsExpected = metafields.find(m => m.namespace === 'vitalsource' && m.key === 'expected_count')?.value;

  const decision = await tracer.trace('fulfillment_decision', async () => {
    if (vsStatus === 'complete' && vsCode) return { action: 'deliver_existing_code', reasoning: 'Codes generated successfully, need to resend' };
    if (vsStatus === 'partial') return { action: 'escalate_partial', reasoning: `Only ${vsCode?.split(',').length || 0}/${vsExpected} codes generated. Human should regenerate missing ones.` };
    if (vsStatus === 'failed') return { action: 'trigger_regeneration', reasoning: 'All code generation failed. Triggering regeneration via n8n.' };
    if (!vsStatus) {
      const orderHasEbook = order.line_items?.some(li => li.sku?.startsWith('D-'));
      if (orderHasEbook) return { action: 'trigger_regeneration', reasoning: 'Legacy order, no fulfillment status metafield. Triggering regeneration.' };
      return { action: 'escalate_no_ebook', reasoning: 'Order contains no ebook products.' };
    }
    return { action: 'escalate_unknown_state', reasoning: `Unknown fulfillment status: ${vsStatus}` };
  });

  if (decision.action === 'deliver_existing_code') {
    await cxDeliverExistingCode(ticketId, ticketData, order, vsCode, db, env, tracer);
  } else if (decision.action === 'trigger_regeneration') {
    await cxTriggerRegeneration(ticketId, ticketData, order, db, env, tracer);
  } else {
    await cxEscalate(ticketId, ticketData, intent, decision.reasoning, db, env, tracer, {
      order_id: order.id, order_number: order.name,
      vs_status: vsStatus, vs_code: vsCode, vs_expected: vsExpected
    });
  }
}

async function cxDeliverExistingCode(ticketId, ticketData, order, vsCode, db, env, tracer) {
  const response = await tracer.trace('draft_response', async () => {
    // Parse codes — format from the metafield is "CODE - Product Title, CODE2 - Product Title 2"
    const codeEntries = vsCode.split(',').map(s => s.trim()).filter(Boolean);
    const parsedCodes = codeEntries.map(entry => {
      const dashIndex = entry.indexOf(' - ');
      if (dashIndex > 0) {
        return { code: entry.substring(0, dashIndex).trim(), title: entry.substring(dashIndex + 3).trim() };
      }
      return { code: entry, title: null };
    });

    const customerFirstName = order.customer?.first_name || cxFirstNameFromEmail(ticketData.customerEmail);
    const template = await cxGetTemplate(db, 'digital_access_success');
    const plural = parsedCodes.length > 1;

    // Format: product titles list (e.g. "Mother Baby Study Guide and Fundamentals Study Guide")
    const productTitles = parsedCodes
      .map(p => p.title || 'your ebook')
      .filter((v, i, a) => a.indexOf(v) === i) // dedupe
      .join(' and ');

    // Format: codes listed with their product (one per line for multi-code orders)
    const codesFormatted = parsedCodes.length > 1
      ? parsedCodes.map(p => `  ${p.code}${p.title ? ` (${p.title})` : ''}`).join('\n')
      : parsedCodes[0].code;

    const body = template.body
      .replace('{customer_first_name}', customerFirstName)
      .replace('{product_titles}', productTitles)
      .replaceAll('{plural_s}', plural ? 's' : '')
      .replace('{is_are}', plural ? 'are' : 'is')
      .replace('{codes}', codesFormatted)
      .replaceAll('{this_these}', plural ? 'these' : 'this');

    return {
      body,
      confidence: 0.95,
      reasoning: `Found ${parsedCodes.length} valid code(s) on order ${order.name}.`,
      data_sources: {
        order_id: order.id,
        order_number: order.name,
        code_count: parsedCodes.length,
        customer_name: customerFirstName,
        codes_summary: parsedCodes.map(p => p.code.substring(0, 6) + '...').join(', ')
      }
    };
  });
  const responseId = await cxSaveResponse(db, ticketId, response);
  await tracer.trace('post_internal_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, response.body, db, env));
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
    const body = template.body.replace('{customer_first_name}', customerFirstName);
    return { body, confidence: 0.85, reasoning: `Order ${order.name} had no valid codes. Triggered regeneration via n8n.`,
      data_sources: { order_id: order.id, order_number: order.name, action: 'regeneration_triggered' } };
  });
  const responseId = await cxSaveResponse(db, ticketId, response);
  await tracer.trace('post_internal_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, response.body, db, env));
  await db.prepare(`UPDATE agent_responses SET status = 'posted_as_note', posted_to_zendesk_at = datetime('now') WHERE id = ?`).bind(responseId).run();
  await db.prepare(`UPDATE agent_tickets SET status = 'drafted', final_action = 'internal_note_posted', completed_at = datetime('now') WHERE id = ?`).bind(ticketId).run();
}

async function cxEscalate(ticketId, ticketData, intent, reason, db, env, tracer, extraData = {}) {
  const response = await tracer.trace('draft_escalation', async () => {
    const template = await cxGetTemplate(db, 'escalation_note');
    const dataFound = Object.keys(extraData).length > 0 ? Object.entries(extraData).map(([k, v]) => `  - ${k}: ${v}`).join('\n') : '  (none)';
    const body = template.body
      .replace('{escalation_reason}', reason)
      .replace('{intent}', intent?.intent || 'unclassified')
      .replace('{confidence}', (intent?.confidence || 0).toFixed(2))
      .replace('{message_summary}', (ticketData.firstMessage || '').substring(0, 300))
      .replace('{data_found}', dataFound)
      .replace('{recommended_action}', 'Human review required');
    return { body, confidence: 1.0, reasoning: reason, data_sources: extraData };
  });
  const responseId = await cxSaveResponse(db, ticketId, response);
  await tracer.trace('post_escalation_note', async () => cxPostInternalNote(ticketData.zendeskTicketId, response.body, db, env));
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
  const customerComments = comments.filter(c => c.public && !supportStaffIds.includes(c.author_id));
  const firstCustomerMessage = customerComments[0]?.plain_body || ticket.description;
  return {
    zendeskTicketId: ticketId, subject: ticket.subject,
    customerEmail: ticket.requester?.email || ticket.via?.source?.from?.address,
    channel: ticket.via?.channel, firstMessage: firstCustomerMessage,
    status: ticket.status, ticket, comments
  };
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

async function cxFindCustomerOrders(ticketData, explicitOrderNumber, db, env) {
  const shopDomain = await cxGetConfig(db, 'shopify_store_domain');
  const maxAgeDays = await cxGetConfig(db, 'max_order_age_days');

  // Path A: Explicit order number in ticket — use that as ground truth
  if (explicitOrderNumber) {
    const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + explicitOrderNumber)}&status=any`, {
      headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN }
    });
    if (resp.ok) {
      const { orders } = await resp.json();
      if (orders && orders.length > 0) {
        return { order: orders[0], candidates: orders, found_by: 'order_number' };
      }
    }
    // Order number provided but not found — return no order so escalation triggers
    return { order: null, candidates: [], found_by: 'order_number_not_found' };
  }

  // Path B: No order number, look up by customer email
  if (!ticketData.customerEmail) {
    return { order: null, candidates: [], found_by: 'no_email_no_order_number' };
  }

  const resp = await fetch(
    `https://${shopDomain}/admin/api/2024-01/orders.json?email=${encodeURIComponent(ticketData.customerEmail)}&status=any&limit=20`,
    { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } }
  );
  if (!resp.ok) return { order: null, candidates: [], found_by: 'api_error' };

  const { orders = [] } = await resp.json();

  // Filter to recent ebook orders only
  const cutoffDate = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const ebookOrders = orders.filter(o => {
    const hasEbook = o.line_items?.some(li => li.sku?.startsWith('D-'));
    const recent = new Date(o.created_at).getTime() >= cutoffDate;
    return hasEbook && recent;
  });

  if (ebookOrders.length === 0) {
    // Maybe customer has older orders — return them as candidates for context, but no auto-match
    const olderEbookOrders = orders.filter(o => o.line_items?.some(li => li.sku?.startsWith('D-')));
    return { order: null, candidates: olderEbookOrders, found_by: 'no_recent_ebook_orders' };
  }

  if (ebookOrders.length === 1) {
    return { order: ebookOrders[0], candidates: ebookOrders, found_by: 'single_recent_ebook_order' };
  }

  // Multiple candidates — don't auto-pick, let handler escalate
  return { order: null, candidates: ebookOrders, found_by: 'multiple_candidates' };
}

// Legacy single-order function kept for backward compatibility (not used anymore)
async function cxFindCustomerOrder(ticketData, db, env) {
  const shopDomain = await cxGetConfig(db, 'shopify_store_domain');
  const orderMatch = (ticketData.subject || '').match(/#?(\d{1,2}-\d{4,7})/) || (ticketData.firstMessage || '').match(/#?(\d{1,2}-\d{4,7})/);
  if (orderMatch) {
    const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + orderMatch[1])}&status=any`, { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } });
    if (resp.ok) {
      const { orders } = await resp.json();
      if (orders && orders.length > 0) return orders[0];
    }
  }
  if (ticketData.customerEmail) {
    const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/orders.json?email=${encodeURIComponent(ticketData.customerEmail)}&status=any&limit=10`, { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } });
    if (resp.ok) {
      const { orders } = await resp.json();
      if (orders && orders.length > 0) {
        const ebookOrders = orders.filter(o => o.line_items?.some(li => li.sku?.startsWith('D-')));
        return ebookOrders[0] || orders[0];
      }
    }
  }
  return null;
}

async function cxFetchOrderMetafields(orderId, db, env) {
  const shopDomain = await cxGetConfig(db, 'shopify_store_domain');
  const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/orders/${orderId}/metafields.json`, { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } });
  if (!resp.ok) return [];
  const { metafields = [] } = await resp.json();
  return metafields;
}

async function cxCallClaude(env, model, systemPrompt, userPrompt, maxTokens = 1024) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
  });
  if (!resp.ok) { const errText = await resp.text(); throw new Error(`Claude API error ${resp.status}: ${errText}`); }
  const data = await resp.json();
  const content = data.content?.[0]?.text || '';
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const cost = (inputTokens * 0.000015) + (outputTokens * 0.000075);
  return { content, tokens: inputTokens + outputTokens, inputTokens, outputTokens, cost };
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
  const result = await db.prepare(`INSERT INTO agent_responses (ticket_id, draft_body, response_confidence, reasoning, data_sources) VALUES (?, ?, ?, ?, ?)`)
    .bind(ticketId, response.body, response.confidence, response.reasoning, JSON.stringify(response.data_sources || {})).run();
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

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
}

// ===== MAIN WORKER =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Helper: add noindex header to any response
    function addNoIndex(response) {
      const newResp = new Response(response.body, response);
      newResp.headers.set("X-Robots-Tag", "noindex, nofollow");
      return newResp;
    }

    if (request.method === "OPTIONS") { return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }); }
    // ===== CX AGENT =====
    if (path === "/cx-agent/webhook/zendesk") { return handleCxAgentWebhook(request, env, ctx); }
    if (path.startsWith("/cx-agent/api/")) { return handleCxAgentAPI(request, env, path); }
    // ===== CONTENT TRACKER API (D1-backed) =====
    if (path === "/tracker/api/data") { return handleTrackerAPI(request, env); }
    // ===== 3PL API (D1-backed) =====
    if (path.startsWith("/3pl/api/")) { return handle3plAPI(request, env, path); }
    // ===== INVENTORY =====
    if (path === "/inventory/api/shipfusion") { return handleShipFusionAPI(request, env); }
    // ===== CALENDAR =====
    if (path === "/calendar/api/config") { try { const { results } = await env.DB.prepare("SELECT key, value FROM config_cache").all(); const config = {}; results.forEach(r => { try { config[r.key] = JSON.parse(r.value); } catch { config[r.key] = r.value; } }); return new Response(JSON.stringify(config), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); } }
    if (path === "/calendar/api/tasks") { try { const { results } = await env.DB.prepare("SELECT * FROM tasks WHERE post_date IS NOT NULL ORDER BY post_date DESC").all(); const tasks = results.map(t => ({ ...t, customFields: JSON.parse(t.custom_fields || "[]") })); return new Response(JSON.stringify({ tasks, synced_at: new Date().toISOString() }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); } }
    if (path === "/calendar/api/sync") { try { const count = await fullSync(env); return new Response(JSON.stringify({ ok: true, tasks_synced: count }), { headers: { "Content-Type": "application/json" } }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); } }
    if (path.startsWith("/calendar/api/")) { const clickupPath = path.replace("/calendar/api/", ""); const clickupUrl = `${CLICKUP_API}/${clickupPath}${url.search}`; const headers = new Headers(request.headers); headers.set("Authorization", env.CLICKUP_TOKEN); headers.set("Content-Type", "application/json"); try { const resp = await fetch(clickupUrl, { method: request.method, headers, body: request.method !== "GET" ? await request.text() : undefined }); const respHeaders = new Headers(resp.headers); respHeaders.set("Access-Control-Allow-Origin", "*"); return new Response(resp.body, { status: resp.status, headers: respHeaders }); } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 502 }); } }
    // ===== REDIRECTS =====
    if (path === "/calendar") return Response.redirect(url.origin + "/calendar/", 301);
    if (path === "/3pl") return Response.redirect(url.origin + "/3pl/", 301);
    if (path === "/inventory") return Response.redirect(url.origin + "/inventory/", 301);
    if (path === "/ambassadors") return Response.redirect(url.origin + "/ambassadors/", 301);
    if (path === "/tracker") return Response.redirect(url.origin + "/tracker/", 301);
    if (path === "/cx-agent") return Response.redirect(url.origin + "/cx-agent/", 301);
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
  async scheduled(event, env, ctx) { ctx.waitUntil(fullSync(env)); },
};
function landingPageHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NITM Operations Hub</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0f1a;color:#f1f5f9;font-family:'DM Sans',sans-serif;min-height:100vh}
.top-nav{background:linear-gradient(180deg,#1a2332 0%,#141c28 100%);padding:12px 24px;display:flex;align-items:center;gap:24px;border-bottom:1px solid #1e293b}
.top-nav .brand{color:#f1f5f9;font-weight:700;font-size:14px;text-decoration:none;letter-spacing:0.5px}
.top-nav a{color:#64748b;text-decoration:none;font-size:13px;font-weight:500;transition:color 0.15s}
.top-nav a:hover,.top-nav a.active{color:#f1f5f9}
.hub-wrap{display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 49px);padding:40px 20px}
.hub{text-align:center;max-width:760px;width:100%}
.hub-title{font-size:36px;font-weight:700;letter-spacing:-0.5px;margin-bottom:44px}
.app-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;max-width:680px;margin:0 auto}
.app-card{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:36px 24px;text-decoration:none;color:#f1f5f9;transition:all 0.2s;display:flex;flex-direction:column;align-items:center;gap:10px}
.app-card:hover{background:#1e293b;border-color:#334155;transform:translateY(-2px)}
.app-icon{font-size:40px}
.app-name{font-size:17px;font-weight:700}
.app-desc{font-size:13px;color:#64748b;text-align:center}
@media(max-width:600px){.app-grid{grid-template-columns:1fr}.hub-title{font-size:28px}}
</style></head><body>
<nav class="top-nav">
  <span class="brand">NITM Ops</span>
  <a href="/" class="active">Hub</a>
  <a href="/calendar/">Calendar</a>
  <a href="/inventory/">Inventory</a>
  <a href="/3pl/">3PL</a>
  <a href="/tracker/">Tracker</a>
  <a href="/ambassadors/">Ambassadors</a>
  <a href="/cx-agent/">CX Agent</a>
</nav>
<div class="hub-wrap">
<div class="hub">
  <h1 class="hub-title">Operations Hub</h1>
  <div class="app-grid">
    <a href="/calendar/" class="app-card"><div class="app-icon">\u{1F4C5}</div><div class="app-name">Content Calendar</div><div class="app-desc">Social media scheduling & tracking</div></a>
    <a href="/inventory/" class="app-card"><div class="app-icon">\u{1F4CA}</div><div class="app-name">Inventory Dashboard</div><div class="app-desc">Stock levels, orders & forecasting</div></a>
    <a href="/3pl/" class="app-card"><div class="app-icon">\u{1F4E6}</div><div class="app-name">3PL Dashboard</div><div class="app-desc">Warehouse & fulfillment</div></a>
    <a href="/tracker/" class="app-card"><div class="app-icon">\u{1F3AF}</div><div class="app-name">Content Tracker</div><div class="app-desc">IG performance scoring & attribution</div></a>
    <a href="/ambassadors/" class="app-card"><div class="app-icon">\u{1F91D}</div><div class="app-name">Ambassadors</div><div class="app-desc">Ambassador sales & commission tracking</div></a>
    <a href="/cx-agent/" class="app-card"><div class="app-icon">\u{1F916}</div><div class="app-name">CX Agent</div><div class="app-desc">AI customer support automation</div></a>
  </div>
</div>
</div></body></html>`;
}
