/**
 * AI 할일 도구
 */

export function parseTodoMarkers(text: string): Array<{ full: string; action: string; data: any }> {
  const results: Array<{ full: string; action: string; data: any }> = [];
  
  // [TODO_ADD]{...}[/TODO_ADD]
  const addRe = /\[TODO_ADD\]([\s\S]*?)\[\/TODO_ADD\]/gi;
  let m: RegExpExecArray | null;
  while ((m = addRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.title) {
        results.push({ full: m[0], action: 'add', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }
  
  // [TODO_LIST]{...}[/TODO_LIST]
  const listRe = /\[TODO_LIST\]([\s\S]*?)\[\/TODO_LIST\]/gi;
  while ((m = listRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      results.push({ full: m[0], action: 'list', data });
    } catch {}
    if (results.length >= 3) break;
  }
  
  // [TODO_DONE]{...}[/TODO_DONE]
  const doneRe = /\[TODO_DONE\]([\s\S]*?)\[\/TODO_DONE\]/gi;
  while ((m = doneRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: 'done', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }

  // [TODO_UPDATE]{...}[/TODO_UPDATE]
  const updateRe = /\[TODO_UPDATE\]([\s\S]*?)\[\/TODO_UPDATE\]/gi;
  while ((m = updateRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: 'update', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }

  // [TODO_DELETE]{...}[/TODO_DELETE]
  const deleteRe = /\[TODO_DELETE\]([\s\S]*?)\[\/TODO_DELETE\]/gi;
  while ((m = deleteRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: 'delete', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }

  return results;
}

export async function executeTodoAdd(env: any, data: any): Promise<any> {
  try {
    const { title, due_at, priority } = data;
    if (!title) {
      return { success: false, error: '제목 필요' };
    }
    const result = await env.DB.prepare(
      `INSERT INTO todos (title, due_at, priority, status)
       VALUES (?, ?, ?, 'pending')`
    ).bind(title, due_at || null, priority || 1).run();
    return { success: true, data: { id: result.meta.last_row_id } };
  } catch (e) {
    return { success: false, error: '할일 추가 실패' };
  }
}

export async function executeTodoList(env: any, data: any): Promise<any> {
  try {
    const status = data.status || 'pending';
    const { results } = await env.DB.prepare(
      `SELECT id, title, due_at, priority
       FROM todos
       WHERE status = ?
       ORDER BY priority DESC, created_at ASC LIMIT 20`
    ).bind(status).all();
    return { success: true, data: results || [] };
  } catch (e) {
    return { success: false, error: '할일 조회 실패' };
  }
}

export async function executeTodoDone(env: any, data: any): Promise<any> {
  try {
    let id = Number(data.id);
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const titleQuery = String(data.title).trim();
      const found = await env.DB.prepare(
        'SELECT id FROM todos WHERE title LIKE ? AND status != ? ORDER BY id DESC LIMIT 5'
      ).bind(`%${titleQuery}%`, 'done').all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" 할일을 찾을 수 없음` };
      }
      if (rows.length > 1) {
        return { success: false, error: `여러 할일이 발견됨. ID를 지정해줘.` };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: '유효한 할일 ID나 제목이 필요' };
    }
    await env.DB.prepare(
      `UPDATE todos SET status = 'done', updated_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '완료 처리 실패' };
  }
}

export async function executeTodoUpdate(env: any, data: any): Promise<any> {
  try {
    let id = Number(data.id);
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const titleQuery = String(data.title).trim();
      const found = await env.DB.prepare(
        'SELECT id FROM todos WHERE title LIKE ? ORDER BY id DESC LIMIT 5'
      ).bind(`%${titleQuery}%`).all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" 할일을 찾을 수 없음` };
      }
      if (rows.length > 1) {
        return { success: false, error: `여러 할일이 발견됨. ID를 지정해줘.` };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: '유효한 할일 ID나 제목이 필요' };
    }
    const existing = await env.DB.prepare('SELECT id FROM todos WHERE id = ?').bind(id).first();
    if (!existing) {
      return { success: false, error: '할일을 찾을 수 없음' };
    }
    const fields: string[] = [];
    const params: any[] = [];
    if (data.title !== undefined && data.title !== null) {
      fields.push('title = ?');
      params.push(data.title);
    }
    if (data.description !== undefined && data.description !== null) {
      fields.push('description = ?');
      params.push(data.description);
    }
    if (data.due_at !== undefined) {
      fields.push('due_at = ?');
      params.push(data.due_at || null);
    }
    if (data.priority !== undefined && data.priority !== null) {
      const p = Number(data.priority);
      if (!Number.isInteger(p) || p < 0 || p > 2) {
        return { success: false, error: '우선순위는 0~2 사이' };
      }
      fields.push('priority = ?');
      params.push(p);
    }
    if (fields.length === 0) {
      return { success: false, error: '변경할 내용이 없음' };
    }
    fields.push(`updated_at = datetime('now')`);
    await env.DB.prepare(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`).bind(...params, id).run();
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '할일 수정 실패' };
  }
}

export async function executeTodoDelete(env: any, data: any): Promise<any> {
  try {
    let id = Number(data.id);
    // ID가 없고 title이 있으면 제목으로 조회
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const found = await env.DB.prepare(
        'SELECT id, title FROM todos WHERE title LIKE ? AND status != \'done\' ORDER BY id DESC LIMIT 5'
      ).bind(`%${data.title}%`).all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" 할일을 찾을 수 없음` };
      }
      if (rows.length > 1) {
        return { success: false, error: `여러 할일이 발견됨: ${rows.map((r: any) => `${r.title}(id:${r.id})`).join(', ')}. ID를 지정해줘.` };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: '유효한 할일 ID나 제목이 필요' };
    }
    const result = await env.DB.prepare('DELETE FROM todos WHERE id = ?').bind(id).run();
    const deleted = result.meta?.changes ?? 0;
    if (deleted === 0) {
      return { success: false, error: '할일을 찾을 수 없음' };
    }
    return { success: true, data: { id, deleted } };
  } catch (e) {
    return { success: false, error: '할일 삭제 실패' };
  }
}
