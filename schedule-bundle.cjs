"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/modules/schedule/routes.ts
var routes_exports = {};
__export(routes_exports, {
  scheduleApp: () => scheduleApp
});
module.exports = __toCommonJS(routes_exports);
var import_hono = require("hono");

// src/events.ts
var listeners = /* @__PURE__ */ new Map();
async function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  await Promise.all(
    [...set].map((h) => {
      try {
        return h(payload);
      } catch (e) {
        console.error(`[events] handler failed for ${event}:`, e);
        return void 0;
      }
    })
  );
}

// src/services/recurrence.ts
var DAY_MS = 864e5;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDatePart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}
function keyOfUTC(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function shiftKey(key, days) {
  const p = parseDatePart(key);
  if (!p) return key;
  return keyOfUTC(Date.UTC(p.y, p.m - 1, p.d) + days * DAY_MS);
}
function parseRRule(rule) {
  if (!rule || typeof rule !== "string") return null;
  const parts = {};
  for (const seg of rule.split(";")) {
    const i = seg.indexOf("=");
    if (i < 0) continue;
    parts[seg.slice(0, i).trim().toUpperCase()] = seg.slice(i + 1).trim().toUpperCase();
  }
  const freq = parts["FREQ"];
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;
  let byday = null;
  if (parts["BYDAY"]) {
    const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const days = parts["BYDAY"].split(",").map((s) => map[s.trim()]).filter((n) => n !== void 0);
    if (days.length > 0) {
      const uniq = days.filter((n, i) => days.indexOf(n) === i).sort((a, b) => a - b);
      byday = uniq;
    }
  }
  let count = null;
  if (parts["COUNT"]) {
    const n = parseInt(parts["COUNT"], 10);
    if (Number.isInteger(n) && n > 0) count = n;
  }
  let until = null;
  if (parts["UNTIL"]) {
    const digits = parts["UNTIL"].replace(/\D/g, "");
    if (digits.length >= 8) {
      until = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      if (!DATE_RE.test(until)) until = null;
    }
  }
  return { freq, byday, count, until };
}
function matchesRule(dayUTC, rule, startUTC) {
  const dt = new Date(dayUTC);
  const start = new Date(startUTC);
  switch (rule.freq) {
    case "DAILY":
      return true;
    case "WEEKLY": {
      const dow = dt.getUTCDay();
      if (rule.byday) return rule.byday.includes(dow);
      return dow === start.getUTCDay();
    }
    case "MONTHLY":
      return dt.getUTCDate() === start.getUTCDate();
    default:
      return false;
  }
}
function toExpanded(s, startAt, isRecurring) {
  const occDate = startAt.slice(0, 10);
  let endAt = s.end_at;
  if (s.end_at) {
    const sp = parseDatePart(s.start_at);
    const ep = parseDatePart(s.end_at);
    if (sp && ep) {
      const offDays = Math.round(
        (Date.UTC(ep.y, ep.m - 1, ep.d) - Date.UTC(sp.y, sp.m - 1, sp.d)) / DAY_MS
      );
      const endTime = s.end_at.length > 10 ? s.end_at.slice(10) : "";
      endAt = shiftKey(occDate, Math.max(0, offDays)) + endTime;
    }
  }
  return {
    ...s,
    start_at: startAt,
    end_at: endAt,
    is_recurring: isRecurring,
    original_id: s.id,
    occurrence_date: occDate
  };
}
function singleOccurrence(schedule) {
  return toExpanded(schedule, schedule.start_at, false);
}
function expandRecurrence(schedule, fromDate, toDate) {
  const single = () => [toExpanded(schedule, schedule.start_at, false)];
  const sp = parseDatePart(schedule.start_at);
  if (!sp) return single();
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) return single();
  const rule = parseRRule(schedule.recurrence_rule);
  if (!rule) return single();
  const timePart = schedule.start_at.length > 10 ? schedule.start_at.slice(10) : "";
  const startUTC = Date.UTC(sp.y, sp.m - 1, sp.d);
  const hardStop = startUTC + 3 * 366 * DAY_MS;
  const maxCount = rule.count ?? Infinity;
  const out = [];
  let produced = 0;
  let guard = 0;
  for (let cur = startUTC; cur <= hardStop && guard < 2200; cur += DAY_MS, guard++) {
    const key = keyOfUTC(cur);
    if (rule.until && key > rule.until) break;
    if (key > toDate) break;
    if (!matchesRule(cur, rule, startUTC)) continue;
    if (produced >= maxCount) break;
    produced++;
    if (key >= fromDate) {
      out.push(toExpanded(schedule, key + timePart, true));
    }
  }
  return out;
}

// src/modules/schedule/routes.ts
var scheduleApp = new import_hono.Hono();
function isISODateTime(s) {
  if (typeof s !== "string" || !s) return false;
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s);
}
function normalizeInput(json) {
  const title = (json.title ?? "").trim();
  if (!title) return { ok: false, error: "title_required" };
  if (title.length > 200) return { ok: false, error: "title_too_long" };
  if (!isISODateTime(json.start_at)) return { ok: false, error: "start_at_invalid" };
  if (json.end_at != null && json.end_at !== "" && !isISODateTime(json.end_at)) {
    return { ok: false, error: "end_at_invalid" };
  }
  if (json.end_at && json.start_at && json.end_at < json.start_at) {
    return { ok: false, error: "end_before_start" };
  }
  const status = json.status ?? "active";
  if (!["active", "cancelled", "done"].includes(status)) return { ok: false, error: "status_invalid" };
  return {
    ok: true,
    data: {
      title,
      description: (json.description ?? "").trim().slice(0, 2e3),
      location: (json.location ?? "").trim().slice(0, 200),
      start_at: json.start_at,
      end_at: json.end_at || null,
      timezone: (json.timezone ?? "Asia/Seoul").slice(0, 50),
      recurrence_rule: json.recurrence_rule ? String(json.recurrence_rule).slice(0, 200) : null,
      status
    }
  };
}
scheduleApp.get("/list", async (c) => {
  const from = c.req.query("from")?.trim() || "";
  const to = c.req.query("to")?.trim() || "";
  const status = c.req.query("status")?.trim() || "";
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const hasStatus = ["active", "cancelled", "done"].includes(status);
  const COLS = `id, title, description, location, start_at, end_at, timezone, recurrence_rule, status, created_at, updated_at`;
  const conds = [`(recurrence_rule IS NULL OR recurrence_rule = '')`];
  const params = [];
  if (dateRe.test(from)) {
    conds.push("substr(start_at, 1, 10) >= ?");
    params.push(from);
  }
  if (dateRe.test(to)) {
    conds.push("substr(start_at, 1, 10) <= ?");
    params.push(to);
  }
  if (hasStatus) {
    conds.push("status = ?");
    params.push(status);
  }
  const { results: singles } = await c.env.DB.prepare(
    `SELECT ${COLS} FROM schedules WHERE ${conds.join(" AND ")} ORDER BY start_at ASC LIMIT ?`
  ).bind(...params, limit).all();
  const todayKey = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const effFrom = dateRe.test(from) ? from : todayKey;
  let effTo;
  if (dateRe.test(to)) {
    effTo = to;
  } else {
    const d = /* @__PURE__ */ new Date(effFrom + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 90);
    effTo = d.toISOString().slice(0, 10);
  }
  const rConds = [`recurrence_rule IS NOT NULL`, `recurrence_rule != ''`, `substr(start_at, 1, 10) <= ?`];
  const rParams = [effTo];
  if (hasStatus) {
    rConds.push("status = ?");
    rParams.push(status);
  }
  const { results: recurring } = await c.env.DB.prepare(
    `SELECT ${COLS} FROM schedules WHERE ${rConds.join(" AND ")} ORDER BY start_at ASC`
  ).bind(...rParams).all();
  const expanded = [
    ...singles.map((r) => singleOccurrence(r)),
    ...recurring.flatMap((r) => expandRecurrence(r, effFrom, effTo))
  ];
  expanded.sort((a, b) => a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0);
  return c.json({ ok: true, schedules: expanded.slice(0, limit) });
});
scheduleApp.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT id, title, description, location, start_at, end_at, timezone, recurrence_rule, status, created_at, updated_at FROM schedules WHERE id = ?"
  ).bind(id).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, schedule: row });
});
scheduleApp.post("/create", async (c) => {
  const json = await c.req.json().catch(() => ({}));
  const v = normalizeInput(json);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const d = v.data;
  const r = await c.env.DB.prepare(
    `INSERT INTO schedules (title, description, location, start_at, end_at, timezone, recurrence_rule, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(d.title, d.description, d.location, d.start_at, d.end_at, d.timezone, d.recurrence_rule, d.status).run();
  const newId = Number(r.meta.last_row_id);
  await emit("schedule.created", { id: newId });
  return c.json({ ok: true, id: newId });
});
scheduleApp.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const json = await c.req.json().catch(() => ({}));
  const v = normalizeInput(json);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const d = v.data;
  const r = await c.env.DB.prepare(
    `UPDATE schedules SET title = ?, description = ?, location = ?, start_at = ?, end_at = ?,
     timezone = ?, recurrence_rule = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(d.title, d.description, d.location, d.start_at, d.end_at, d.timezone, d.recurrence_rule, d.status, id).run();
  if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await emit("schedule.updated", { id });
  return c.json({ ok: true });
});
scheduleApp.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  await c.env.DB.prepare("DELETE FROM reminders WHERE schedule_id = ?").bind(id).run();
  const r = await c.env.DB.prepare("DELETE FROM schedules WHERE id = ?").bind(id).run();
  if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await emit("schedule.deleted", { id });
  return c.json({ ok: true });
});
scheduleApp.post("/:id/reminders", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const json = await c.req.json().catch(() => ({}));
  if (!isISODateTime(json.remind_at)) return c.json({ error: "remind_at_invalid" }, 400);
  const dedupe = (json.dedupe_key ?? `sched:${id}:${json.remind_at}`).slice(0, 200);
  try {
    const r = await c.env.DB.prepare(
      "INSERT INTO reminders (schedule_id, remind_at, dedupe_key) VALUES (?, ?, ?)"
    ).bind(id, json.remind_at, dedupe).run();
    return c.json({ ok: true, id: Number(r.meta.last_row_id) });
  } catch {
    return c.json({ error: "duplicate" }, 409);
  }
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  scheduleApp
});
