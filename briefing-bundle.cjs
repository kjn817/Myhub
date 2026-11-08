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

// src/modules/briefing/routes.ts
var routes_exports = {};
__export(routes_exports, {
  briefingApp: () => briefingApp
});
module.exports = __toCommonJS(routes_exports);
var import_hono = require("hono");
var briefingApp = new import_hono.Hono();
function todayStr(timezone = "Asia/Seoul") {
  const now = /* @__PURE__ */ new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}
function todayRange(timezone = "Asia/Seoul") {
  const today = todayStr(timezone);
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const ny = next.getUTCFullYear();
  const nm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(next.getUTCDate()).padStart(2, "0");
  const tomorrow = `${ny}-${nm}-${nd}`;
  return {
    start: `${today}T00:00:00`,
    end: `${tomorrow}T00:00:00`
  };
}
briefingApp.get("/today", async (c) => {
  const timezone = "Asia/Seoul";
  const today = todayStr(timezone);
  const range = todayRange(timezone);
  const { results: schedules } = await c.env.DB.prepare(
    `SELECT id, title, start_at, end_at, location
     FROM schedules
     WHERE start_at >= ? AND start_at < ? AND status = 'active'
     ORDER BY start_at ASC`
  ).bind(range.start, range.end).all();
  const { results: todos } = await c.env.DB.prepare(
    `SELECT id, title, due_at, priority
     FROM todos
     WHERE status = 'pending'
     ORDER BY priority DESC, due_at ASC NULLS LAST, id DESC
     LIMIT 10`
  ).all();
  const { results: memos } = await c.env.DB.prepare(
    `SELECT id, substr(text, 1, 200) as text
     FROM memos
     WHERE is_locked = 0 AND sensitivity < 2
     ORDER BY id DESC
     LIMIT 5`
  ).all();
  let memories = [];
  try {
    const memResult = await c.env.DB.prepare(
      `SELECT id, substr(content, 1, 200) as content
       FROM ai_memory_v2
       WHERE allow_ai_use = 1
       ORDER BY id DESC
       LIMIT 5`
    ).all();
    memories = memResult.results ?? [];
  } catch {
    memories = [];
  }
  return c.json({
    ok: true,
    date: today,
    timezone,
    schedules: schedules ?? [],
    todos: todos ?? [],
    memos: memos ?? [],
    memories,
    counts: {
      schedules: schedules?.length ?? 0,
      todos: todos?.length ?? 0,
      memos: memos?.length ?? 0,
      memories: memories.length
    }
  });
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  briefingApp
});
