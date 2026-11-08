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

// src/modules/todo/routes.ts
var routes_exports = {};
__export(routes_exports, {
  todoApp: () => todoApp,
  validateReorderIds: () => validateReorderIds
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

// src/modules/todo/routes.ts
var todoApp = new import_hono.Hono();
function isISODateTime(s) {
  if (typeof s !== "string" || !s) return false;
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s);
}
function normalizeInput(json) {
  const title = (json.title ?? "").trim();
  if (!title) return { ok: false, error: "title_required" };
  if (title.length > 200) return { ok: false, error: "title_too_long" };
  if (json.due_at != null && json.due_at !== "" && !isISODateTime(json.due_at)) {
    return { ok: false, error: "due_at_invalid" };
  }
  const priority = json.priority ?? 1;
  if (![0, 1, 2].includes(priority)) return { ok: false, error: "priority_invalid" };
  const status = json.status ?? "pending";
  if (!["pending", "done"].includes(status)) return { ok: false, error: "status_invalid" };
  return {
    ok: true,
    data: {
      title,
      description: (json.description ?? "").trim().slice(0, 2e3),
      due_at: json.due_at || null,
      priority,
      status
    }
  };
}
function validateReorderIds(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) {
    return { ok: false, error: "ids_invalid" };
  }
  const ids = [];
  for (const v of input) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "ids_invalid" };
    ids.push(n);
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: "ids_duplicate" };
  return { ok: true, ids };
}
todoApp.get("/list", async (c) => {
  const status = c.req.query("status")?.trim() || "pending";
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
  const conds = [];
  const params = [];
  if (["pending", "done"].includes(status)) {
    conds.push("status = ?");
    params.push(status);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, due_at, priority, status, sort_order, created_at, updated_at
     FROM todos ${where} ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, sort_order ASC, id DESC LIMIT ?`
  ).bind(...params, limit).all();
  return c.json({ ok: true, todos: results });
});
todoApp.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT id, title, description, due_at, priority, status, sort_order, created_at, updated_at FROM todos WHERE id = ?"
  ).bind(id).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, todo: row });
});
todoApp.post("/create", async (c) => {
  const json = await c.req.json().catch(() => ({}));
  const v = normalizeInput(json);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const d = v.data;
  const r = await c.env.DB.prepare(
    `INSERT INTO todos (title, description, due_at, priority, status, sort_order)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM todos WHERE status = ?))`
  ).bind(d.title, d.description, d.due_at, d.priority, d.status, d.status).run();
  const newId = Number(r.meta.last_row_id);
  await emit("todo.created", { id: newId });
  return c.json({ ok: true, id: newId });
});
todoApp.put("/reorder", async (c) => {
  const json = await c.req.json().catch(() => ({}));
  const v = validateReorderIds(json.ids);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const stmts = v.ids.map(
    (id, i) => c.env.DB.prepare("UPDATE todos SET sort_order = ?, updated_at = datetime('now') WHERE id = ?").bind(i, id)
  );
  await c.env.DB.batch(stmts);
  await emit("todo.reordered", { count: v.ids.length });
  return c.json({ ok: true, count: v.ids.length });
});
todoApp.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const json = await c.req.json().catch(() => ({}));
  const v = normalizeInput(json);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const d = v.data;
  const r = await c.env.DB.prepare(
    `UPDATE todos SET title = ?, description = ?, due_at = ?, priority = ?,
     status = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(d.title, d.description, d.due_at, d.priority, d.status, id).run();
  if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await emit("todo.updated", { id });
  return c.json({ ok: true });
});
todoApp.post("/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const row = await c.env.DB.prepare("SELECT status FROM todos WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  const newStatus = row.status === "done" ? "pending" : "done";
  const maxRow = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM todos WHERE status = ?").bind(newStatus).first();
  await c.env.DB.prepare(
    `UPDATE todos SET status = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(newStatus, (maxRow?.m ?? -1) + 1, id).run();
  await emit("todo.toggled", { id, status: newStatus });
  return c.json({ ok: true, status: newStatus });
});
todoApp.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const r = await c.env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
  if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await emit("todo.deleted", { id });
  return c.json({ ok: true });
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  todoApp,
  validateReorderIds
});
