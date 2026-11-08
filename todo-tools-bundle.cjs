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

// src/services/todo-tools.ts
var todo_tools_exports = {};
__export(todo_tools_exports, {
  executeTodoAdd: () => executeTodoAdd,
  executeTodoDelete: () => executeTodoDelete,
  executeTodoDone: () => executeTodoDone,
  executeTodoList: () => executeTodoList,
  executeTodoUpdate: () => executeTodoUpdate,
  parseTodoMarkers: () => parseTodoMarkers
});
module.exports = __toCommonJS(todo_tools_exports);
function parseTodoMarkers(text) {
  const results = [];
  const addRe = /\[TODO_ADD\]([\s\S]*?)\[\/TODO_ADD\]/gi;
  let m;
  while ((m = addRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.title) {
        results.push({ full: m[0], action: "add", data });
      }
    } catch {
    }
    if (results.length >= 3) break;
  }
  const listRe = /\[TODO_LIST\]([\s\S]*?)\[\/TODO_LIST\]/gi;
  while ((m = listRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      results.push({ full: m[0], action: "list", data });
    } catch {
    }
    if (results.length >= 3) break;
  }
  const doneRe = /\[TODO_DONE\]([\s\S]*?)\[\/TODO_DONE\]/gi;
  while ((m = doneRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: "done", data });
      }
    } catch {
    }
    if (results.length >= 3) break;
  }
  const updateRe = /\[TODO_UPDATE\]([\s\S]*?)\[\/TODO_UPDATE\]/gi;
  while ((m = updateRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: "update", data });
      }
    } catch {
    }
    if (results.length >= 3) break;
  }
  const deleteRe = /\[TODO_DELETE\]([\s\S]*?)\[\/TODO_DELETE\]/gi;
  while ((m = deleteRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: "delete", data });
      }
    } catch {
    }
    if (results.length >= 3) break;
  }
  return results;
}
async function executeTodoAdd(env, data) {
  try {
    const { title, due_at, priority } = data;
    if (!title) {
      return { success: false, error: "\uC81C\uBAA9 \uD544\uC694" };
    }
    const result = await env.DB.prepare(
      `INSERT INTO todos (title, due_at, priority, status)
       VALUES (?, ?, ?, 'pending')`
    ).bind(title, due_at || null, priority || 1).run();
    return { success: true, data: { id: result.meta.last_row_id } };
  } catch (e) {
    return { success: false, error: "\uD560\uC77C \uCD94\uAC00 \uC2E4\uD328" };
  }
}
async function executeTodoList(env, data) {
  try {
    const status = data.status || "pending";
    const { results } = await env.DB.prepare(
      `SELECT id, title, due_at, priority
       FROM todos
       WHERE status = ?
       ORDER BY priority DESC, created_at ASC LIMIT 20`
    ).bind(status).all();
    return { success: true, data: results || [] };
  } catch (e) {
    return { success: false, error: "\uD560\uC77C \uC870\uD68C \uC2E4\uD328" };
  }
}
async function executeTodoDone(env, data) {
  try {
    let id = Number(data.id);
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const titleQuery = String(data.title).trim();
      const found = await env.DB.prepare(
        "SELECT id FROM todos WHERE title LIKE ? AND status != ? ORDER BY id DESC LIMIT 5"
      ).bind(`%${titleQuery}%`, "done").all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" \uD560\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C` };
      }
      if (rows.length > 1) {
        return { success: false, error: `\uC5EC\uB7EC \uD560\uC77C\uC774 \uBC1C\uACAC\uB428. ID\uB97C \uC9C0\uC815\uD574\uC918.` };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: "\uC720\uD6A8\uD55C \uD560\uC77C ID\uB098 \uC81C\uBAA9\uC774 \uD544\uC694" };
    }
    await env.DB.prepare(
      `UPDATE todos SET status = 'done', updated_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: "\uC644\uB8CC \uCC98\uB9AC \uC2E4\uD328" };
  }
}
async function executeTodoUpdate(env, data) {
  try {
    let id = Number(data.id);
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const titleQuery = String(data.title).trim();
      const found = await env.DB.prepare(
        "SELECT id FROM todos WHERE title LIKE ? ORDER BY id DESC LIMIT 5"
      ).bind(`%${titleQuery}%`).all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" \uD560\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C` };
      }
      if (rows.length > 1) {
        return { success: false, error: `\uC5EC\uB7EC \uD560\uC77C\uC774 \uBC1C\uACAC\uB428. ID\uB97C \uC9C0\uC815\uD574\uC918.` };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: "\uC720\uD6A8\uD55C \uD560\uC77C ID\uB098 \uC81C\uBAA9\uC774 \uD544\uC694" };
    }
    const existing = await env.DB.prepare("SELECT id FROM todos WHERE id = ?").bind(id).first();
    if (!existing) {
      return { success: false, error: "\uD560\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C" };
    }
    const fields = [];
    const params = [];
    if (data.title !== void 0 && data.title !== null) {
      fields.push("title = ?");
      params.push(data.title);
    }
    if (data.description !== void 0 && data.description !== null) {
      fields.push("description = ?");
      params.push(data.description);
    }
    if (data.due_at !== void 0) {
      fields.push("due_at = ?");
      params.push(data.due_at || null);
    }
    if (data.priority !== void 0 && data.priority !== null) {
      const p = Number(data.priority);
      if (!Number.isInteger(p) || p < 0 || p > 2) {
        return { success: false, error: "\uC6B0\uC120\uC21C\uC704\uB294 0~2 \uC0AC\uC774" };
      }
      fields.push("priority = ?");
      params.push(p);
    }
    if (fields.length === 0) {
      return { success: false, error: "\uBCC0\uACBD\uD560 \uB0B4\uC6A9\uC774 \uC5C6\uC74C" };
    }
    fields.push(`updated_at = datetime('now')`);
    await env.DB.prepare(`UPDATE todos SET ${fields.join(", ")} WHERE id = ?`).bind(...params, id).run();
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: "\uD560\uC77C \uC218\uC815 \uC2E4\uD328" };
  }
}
async function executeTodoDelete(env, data) {
  try {
    let id = Number(data.id);
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const found = await env.DB.prepare(
        "SELECT id, title FROM todos WHERE title LIKE ? AND status != 'done' ORDER BY id DESC LIMIT 5"
      ).bind(`%${data.title}%`).all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" \uD560\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C` };
      }
      if (rows.length > 1) {
        return { success: false, error: `\uC5EC\uB7EC \uD560\uC77C\uC774 \uBC1C\uACAC\uB428: ${rows.map((r) => `${r.title}(id:${r.id})`).join(", ")}. ID\uB97C \uC9C0\uC815\uD574\uC918.` };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: "\uC720\uD6A8\uD55C \uD560\uC77C ID\uB098 \uC81C\uBAA9\uC774 \uD544\uC694" };
    }
    const result = await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
    const deleted = result.meta?.changes ?? 0;
    if (deleted === 0) {
      return { success: false, error: "\uD560\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C" };
    }
    return { success: true, data: { id, deleted } };
  } catch (e) {
    return { success: false, error: "\uD560\uC77C \uC0AD\uC81C \uC2E4\uD328" };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  executeTodoAdd,
  executeTodoDelete,
  executeTodoDone,
  executeTodoList,
  executeTodoUpdate,
  parseTodoMarkers
});
