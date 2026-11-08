#!/usr/bin/env python3
"""
MyHub 127차 — 잔여 API 15개 로컬 검증
대상: wrangler dev 로컬 Worker (http://localhost:18787) + 로컬 D1 (.wrangler/qa127)
세션: /tmp/qa127_session.txt (scripts/create-test-session.mjs 생성)

분류:
  기타 6: API-MEMO-008, API-MEMO-009, API-AI-015, API-SCHEDULE-006, API-AUTH-001, API-AUTH-002
  파일 5: API-MEMO-010, API-MEMO-011, API-MEMO-015, API-MEMO-016, API-MEMO-017
  외부AI 4: API-AI-002, API-AI-003, API-AI-018, API-AI-019
"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

BASE = "http://localhost:18787"
SESSION = open("/tmp/qa127_session.txt").read().strip()
AUTH_H = {"Cookie": f"myhub_session={SESSION}", "Content-Type": "application/json"}
AUTH_H_NOCtype = {"Cookie": f"myhub_session={SESSION}"}

results = []

def req(method, path, body=None, headers=None, raw_body=None, ctype="application/json"):
    url = BASE + path
    data = None
    h = dict(headers or {})
    if raw_body is not None:
        data = raw_body
    elif body is not None:
        data = json.dumps(body).encode()
    if data is not None and "Content-Type" not in h:
        h["Content-Type"] = ctype
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)

def check(qa_id, name, cond, detail=""):
    results.append({"id": qa_id, "name": name, "pass": bool(cond), "detail": detail})
    print(f"{'PASS' if cond else 'FAIL'} {qa_id} {name} {detail}")

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

_noredir_opener = urllib.request.build_opener(_NoRedirect)

def req_noredir(method, path, headers=None):
    """리다이렉트를 따라가지 않고 302 상태+Location을 그대로 확인"""
    r = urllib.request.Request(BASE + path, method=method, headers=dict(headers or {}))
    try:
        with _noredir_opener.open(r, timeout=30) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)

def d1(cmd):
    """로컬 D1 직접 조회 (테스트 데이터 준비용)"""
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "myhub-db", "--local",
         "--persist-to", ".wrangler/qa127", "--command", cmd, "--json"],
        capture_output=True, text=True, cwd="/home/hatch/workspace/myhub")
    try:
        j = json.loads(out.stdout)
        return j[0]["results"] if j else []
    except Exception:
        return []

# ============ 사전 준비: 메모/일정 생성 ============
s, b, _ = req("POST", "/api/memo", {"text": "127차 QA 메모 - 잔여 API 테스트용"}, AUTH_H)
memo = json.loads(b)
memo_id = memo.get("id")
check("PREP", "메모 생성", s == 200 and memo_id, f"status={s} id={memo_id}")

s, b, _ = req("POST", "/api/schedule/create",
              {"title": "127차 일정", "start_at": "2026-10-20T10:00:00", "end_at": "2026-10-20T11:00:00"}, AUTH_H)
sch = json.loads(b)
sch_id = sch.get("id") or sch.get("schedule", {}).get("id")
check("PREP", "일정 생성", s == 200 and sch_id, f"status={s} id={sch_id}")

# ============ 기타 6 ============
# API-MEMO-008 lock-block
s, b, _ = req("POST", f"/api/memo/{memo_id}/lock-block", {"html": "<p>비밀 블록</p>"}, AUTH_H)
d = json.loads(b)
block_id = d.get("blockId")
check("API-MEMO-008", "블록 잠금", s == 200 and d.get("ok") and block_id, f"status={s} blockId={block_id}")
rows = d1(f"SELECT locked_blocks FROM memos WHERE id={memo_id}")
import json as _j
blocks = _j.loads(rows[0]["locked_blocks"]) if rows and rows[0]["locked_blocks"] else []
check("API-MEMO-008", "DB locked_blocks 보존", any(x.get("id") == block_id for x in blocks), f"blocks={len(blocks)}")
s, b, _ = req("POST", "/api/memo/999999/lock-block", {"html": "<p>x</p>"}, AUTH_H)
check("API-MEMO-008", "없는 메모 404", s == 404, f"status={s}")
s, b, _ = req("POST", f"/api/memo/{memo_id}/lock-block", {"html": ""}, AUTH_H)
check("API-MEMO-008", "빈 html 400", s == 400, f"status={s}")
s, _, _ = req("POST", f"/api/memo/{memo_id}/lock-block", {"html": "<p>x</p>"})
check("API-MEMO-008", "미인증 401", s == 401, f"status={s}")

# API-MEMO-009 unlock-block
s, b, _ = req("POST", f"/api/memo/{memo_id}/unlock-block/{block_id}", {}, AUTH_H)
d = json.loads(b)
check("API-MEMO-009", "블록 해제", s == 200 and d.get("ok") and "비밀 블록" in d.get("html", ""), f"status={s}")
s, _, _ = req("POST", f"/api/memo/{memo_id}/unlock-block/blk_nonexistent", {}, AUTH_H)
check("API-MEMO-009", "없는 블록 404", s == 404, f"status={s}")
s, _, _ = req("POST", f"/api/memo/{memo_id}/unlock-block/{block_id}")
check("API-MEMO-009", "미인증 401", s == 401, f"status={s}")

# API-AI-015 settings
s, b, _ = req("POST", "/api/ai/settings", {"key": "model.chat", "value": "qa-test-model"}, AUTH_H)
check("API-AI-015", "설정 저장", s == 200 and json.loads(b).get("ok"), f"status={s}")
rows = d1("SELECT value FROM ai_settings WHERE key='model.chat'")
check("API-AI-015", "DB 반영", rows and rows[0]["value"] == "qa-test-model", f"rows={rows}")
s, _, _ = req("POST", "/api/ai/settings", {"key": "evil.key", "value": "x"}, AUTH_H)
check("API-AI-015", "허용되지 않은 키 400", s == 400, f"status={s}")
s, _, _ = req("POST", "/api/ai/settings", {"key": "model.chat"}, AUTH_H)
check("API-AI-015", "value 누락 400", s == 400, f"status={s}")
s, _, _ = req("POST", "/api/ai/settings", {"key": "model.chat", "value": "x"})
check("API-AI-015", "미인증 401", s == 401, f"status={s}")
# 정리
req("POST", "/api/ai/settings", {"key": "model.chat", "value": ""}, AUTH_H)

# API-SCHEDULE-006 reminders
import time as _time
_dedupe = f"qa127-{int(_time.time())}"
s, b, _ = req("POST", f"/api/schedule/{sch_id}/reminders",
              {"remind_at": "2026-10-20T09:00:00", "dedupe_key": _dedupe}, AUTH_H)
check("API-SCHEDULE-006", "리마인더 생성", s == 200 and json.loads(b).get("ok"), f"status={s} body={b[:120]}")
rows = d1(f"SELECT COUNT(*) AS n FROM reminders WHERE schedule_id={sch_id}")
check("API-SCHEDULE-006", "DB 반영", rows and rows[0]["n"] >= 1, f"rows={rows}")
s, b, _ = req("POST", f"/api/schedule/{sch_id}/reminders",
              {"remind_at": "2026-10-20T09:00:00", "dedupe_key": _dedupe}, AUTH_H)
check("API-SCHEDULE-006", "중복 dedupe_key 처리", s in (200, 409), f"status={s}")
s, _, _ = req("POST", f"/api/schedule/{sch_id}/reminders", {"remind_at": "x"}, AUTH_H)
print(f"INFO API-SCHEDULE-006 잘못된 remind_at: status={s}")
s, _, _ = req("POST", f"/api/schedule/{sch_id}/reminders", {"remind_at": "2026-10-20T09:00:00"})
check("API-SCHEDULE-006", "미인증 401", s == 401, f"status={s}")

# API-AUTH-001 request
s, b, _ = req("POST", "/api/auth/request", {})
check("API-AUTH-001", "OTP 요청", s == 200 and json.loads(b).get("ok"), f"status={s}")
rows = d1("SELECT code FROM otp_codes WHERE email='testa@example.com'")
otp_code = rows[0]["code"] if rows else None
check("API-AUTH-001", "D1 OTP 생성", bool(otp_code), f"code_len={len(otp_code) if otp_code else 0}")

# API-AUTH-002 verify
s, b, _ = req("POST", "/api/auth/verify", {"code": "000000"})
check("API-AUTH-002", "잘못된 코드 400", s == 400, f"status={s}")
s, b, h = req("POST", "/api/auth/verify", {"code": otp_code})
d = json.loads(b)
has_cookie = "myhub_session" in h.get("Set-Cookie", "")
check("API-AUTH-002", "올바른 코드 200+세션", s == 200 and d.get("ok") and has_cookie, f"status={s} cookie={has_cookie}")
s, _, _ = req("POST", "/api/auth/verify", {"code": otp_code})
check("API-AUTH-002", "재사용 400 (단일사용)", s == 400, f"status={s}")

# ============ 파일 5 (Cloudinary 없이 가능한 범위) ============
# API-MEMO-015 upload
s, _, _ = req("POST", f"/api/memo/{memo_id}/files", raw_body=b"", ctype="multipart/form-data; boundary=x")
check("API-MEMO-015", "미인증 401", s == 401, f"status={s}")
s, b, _ = req("POST", f"/api/memo/{memo_id}/files",
              raw_body=b'--x\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--x--\r\n',
              ctype="multipart/form-data; boundary=x", headers=AUTH_H_NOCtype)
check("API-MEMO-015", "빈 업로드 400", s == 400, f"status={s} body={b[:80]}")
# 10MB 초과
big = b"--x\r\nContent-Disposition: form-data; name=\"files\"; filename=\"big.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n" + b"0" * (10 * 1024 * 1024 + 1) + b"\r\n--x--\r\n"
s, b, _ = req("POST", f"/api/memo/{memo_id}/files", raw_body=big, ctype="multipart/form-data; boundary=x", headers=AUTH_H_NOCtype)
check("API-MEMO-015", "10MB 초과 400", s == 400, f"status={s}")
# 정상 파일 → Cloudinary 없음 → 500 (외부 의존)
small = b"--x\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--x--\r\n"
s, b, _ = req("POST", f"/api/memo/{memo_id}/files", raw_body=small, ctype="multipart/form-data; boundary=x", headers=AUTH_H_NOCtype)
check("API-MEMO-015", "정상 업로드 (Cloudinary 없어 500 예상=외부검증필요)", s == 500, f"status={s}")

# 테스트용 파일 행 직접 삽입 (업로드 완료 상태 시뮬레이션)
d1(f"INSERT INTO files (memo_id, storage_key, filename, mime, size, url, resource_type, is_locked) VALUES ({memo_id}, 'qa127/key1', 'qa.txt', 'text/plain', 5, 'https://example.com/qa.txt', 'raw', 0)")
rows = d1("SELECT id FROM files WHERE storage_key='qa127/key1' ORDER BY id DESC LIMIT 1")
file_id = rows[0]["id"] if rows else None
check("PREP", "파일 행 삽입", bool(file_id), f"file_id={file_id}")
# 로컬 D1 WAL 가시성 대기: CLI INSERT가 Worker에 보일 때까지 폴링 (miniflare 로컬 특성)
import time as _t2
for _i in range(20):
    _s, _h = req_noredir("GET", f"/api/memo/files/{file_id}", AUTH_H)
    if _s == 302:
        break
    _t2.sleep(0.5)

# API-MEMO-016 get → 302 redirect (리다이렉트 미추적)
s, h = req_noredir("GET", f"/api/memo/files/{file_id}", AUTH_H)
loc = h.get("Location", "")
check("API-MEMO-016", "파일 조회 302 리다이렉트", s == 302 and "example.com" in loc, f"status={s} loc={loc}")
s, _, _ = req("GET", "/api/memo/files/999999", headers=AUTH_H)
check("API-MEMO-016", "없는 파일 404", s == 404, f"status={s}")
s, _, _ = req("GET", f"/api/memo/files/{file_id}")
check("API-MEMO-016", "미인증 401", s == 401, f"status={s}")

# API-MEMO-011 content (잠금 해제 파일 → 302)
s, h = req_noredir("GET", f"/api/memo/files/{file_id}/content", AUTH_H)
check("API-MEMO-011", "콘텐츠 302 리다이렉트", s == 302, f"status={s}")
s, _, _ = req("GET", "/api/memo/files/999999/content", headers=AUTH_H)
check("API-MEMO-011", "없는 파일 404", s == 404, f"status={s}")
s, _, _ = req("GET", f"/api/memo/files/{file_id}/content")
check("API-MEMO-011", "미인증 401", s == 401, f"status={s}")

# API-MEMO-010 lock
s, _, _ = req("POST", "/api/memo/files/999999/lock", {"locked": True}, AUTH_H)
check("API-MEMO-010", "없는 파일 404", s == 404, f"status={s}")
s, b, _ = req("POST", f"/api/memo/files/{file_id}/lock", {"locked": False}, AUTH_H)
check("API-MEMO-010", "no-op 잠금해제 200", s == 200 and json.loads(b).get("ok"), f"status={s}")
s, b, _ = req("POST", f"/api/memo/files/{file_id}/lock", {"locked": True}, AUTH_H)
check("API-MEMO-010", "실제 잠금 (Cloudinary 없어 500 예상=외부검증필요)", s == 500, f"status={s}")
s, _, _ = req("POST", f"/api/memo/files/{file_id}/lock", {"locked": True})
check("API-MEMO-010", "미인증 401", s == 401, f"status={s}")

# API-MEMO-017 delete
s, _, _ = req("DELETE", "/api/memo/files/999999", headers=AUTH_H)
check("API-MEMO-017", "없는 파일 404", s == 404, f"status={s}")
s, _, _ = req("DELETE", f"/api/memo/files/{file_id}")
check("API-MEMO-017", "미인증 401", s == 401, f"status={s}")
s, b, _ = req("DELETE", f"/api/memo/files/{file_id}", headers=AUTH_H)
check("API-MEMO-017", "파일 삭제 200", s == 200 and json.loads(b).get("ok"), f"status={s}")
rows = d1(f"SELECT COUNT(*) AS n FROM files WHERE id={file_id}")
check("API-MEMO-017", "DB 삭제 확인", rows and rows[0]["n"] == 0, f"rows={rows}")

# ============ 외부AI 4 (키 없음 → 인증/검증/실패처리만) ============
# API-AI-002 chat
s, _, _ = req("POST", "/api/ai/chat", {"personaId": "concierge", "messages": []})
check("API-AI-002", "미인증 401", s == 401, f"status={s}")
s, b, _ = req("POST", "/api/ai/chat", {"personaId": "concierge", "conversationId": 999999, "messages": [{"role": "user", "content": "hi"}]}, AUTH_H)
check("API-AI-002", "없는 대화 404", s == 404, f"status={s}")
s, b, _ = req("POST", "/api/ai/chat", {"personaId": "concierge", "messages": [{"role": "user", "content": "hi"}]}, AUTH_H)
d = json.loads(b)
check("API-AI-002", "외부 키 없어 502 (실패처리)", s == 502, f"status={s} err={str(d.get('error'))[:60]}")

# API-AI-003 orchestrate
s, _, _ = req("POST", "/api/ai/orchestrate", {"text": "hi"})
check("API-AI-003", "미인증 401", s == 401, f"status={s}")
s, b, _ = req("POST", "/api/ai/orchestrate", {"text": "메모 찾아줘"}, AUTH_H)
print(f"INFO API-AI-003 orchestrate: status={s} body={b[:150]}")

# API-AI-018 websearch
s, _, _ = req("GET", "/api/ai/websearch")
check("API-AI-018", "미인증 401", s == 401, f"status={s}")
s, b, _ = req("GET", "/api/ai/websearch", headers=AUTH_H)
check("API-AI-018", "q 누락 400", s == 400, f"status={s}")
s, b, _ = req("GET", "/api/ai/websearch?q=test", headers=AUTH_H)
print(f"INFO API-AI-018 websearch: status={s} body={b[:150]}")

# API-AI-019 github
s, _, _ = req("GET", "/api/ai/github")
check("API-AI-019", "미인증 401", s == 401, f"status={s}")
s, b, _ = req("GET", "/api/ai/github?q=test", headers=AUTH_H)
print(f"INFO API-AI-019 github: status={s} body={b[:150]}")

# ============ 결과 ============
fails = [r for r in results if not r["pass"]]
print(f"\n==== 127차 잔여 API: {len(results)-len(fails)}/{len(results)} PASS ====")
for r in fails:
    print(f"  FAIL {r['id']} {r['name']} {r['detail']}")
with open("/home/hatch/workspace/myhub/tests/qa/qa127_remaining_apis.json", "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
sys.exit(1 if fails else 0)
