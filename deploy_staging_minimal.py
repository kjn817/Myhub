#!/usr/bin/env python3
"""스테이징 최소 배포: 백엔드 + memory.html만 (2.3MB 제한 우회)

- Worker 스크립트: 1.1MB (백엔드 보안 수정 포함)
- memory.html: 7.8KB (체크박스 UI 포함)
- 총합: ~1.2MB (2.3MB 제한 이하)
"""
import sys, json, subprocess, urllib.request, urllib.error
from pathlib import Path

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import add_surrogate_to_request, read_json_response

CREDENTIAL = 'custom.cloudflare'
ALLOWED_HOSTS = ['api.cloudflare.com']
BASE = 'https://api.cloudflare.com/client/v4'
ACCOUNT_ID = '59e749ed2e9cdb8b0bf70d47227968a1'
SCRIPT_NAME = 'myhub-staging'

project = Path('/home/hatch/workspace/myhub')

# 1. memory.html만 인라인하는 최소 index-inline.ts 생성
NODE_GEN = r'''
const fs = require("fs");
let ts = fs.readFileSync("./src/index.ts", "utf-8");
const marker = "/*__STATIC_FILES__*/";
if (!ts.includes(marker)) { console.error("MARKER NOT FOUND"); process.exit(1); }
const pub = "./public";
const read = (p) => fs.readFileSync(pub + p, "utf-8");
// 최소 파일만: memory.html (체크박스 UI) + 필수 인증 파일
const files = {
  "/memory.html": read("/memory.html"),
  "/login.html": read("/login.html"),
  "/manifest.json": read("/manifest.json"),
};
let sc = "const STATIC_FILES_B64={\n";
for (const [p,c] of Object.entries(files)) {
  const b64 = Buffer.from(c, 'utf-8').toString('base64');
  sc += " "+JSON.stringify(p)+":"+JSON.stringify(b64)+",\n";
}
sc += "};\n";
ts = ts.replace(marker, sc);
fs.writeFileSync("./src/index-inline-minimal.ts", ts);
console.log("written");
'''

def main():
    result = subprocess.run(['node', '-e', NODE_GEN],
                            cwd=str(project), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Generate failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    result = subprocess.run(
        ['npx', 'esbuild', 'src/index-inline-minimal.ts', '--bundle', '--format=esm',
         '--platform=neutral', '--outfile=/tmp/myhub-staging-minimal.js'],
        cwd=str(project), capture_output=True, text=True, errors='replace')
    if result.returncode != 0:
        print(f"Build failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    with open('/tmp/myhub-staging-minimal.js', 'rb') as f:
        worker_js = f.read()
    print(f"Bundle: {len(worker_js)} bytes", file=sys.stderr)
    
    if len(worker_js) > 2_300_000:
        print(f"WARNING: Bundle too large!", file=sys.stderr)
        sys.exit(1)

    # Worker 업로드
    import uuid
    boundary = uuid.uuid4().hex
    metadata = {
        "main_module": "index.js",
        "bindings": [
            {"type": "d1", "name": "DB", "id": "995184a9-b291-402c-adf5-0d8d80a59e1c"},
            {"type": "kv_namespace", "name": "KV", "namespace_id": "45e164df619847f5bd0a829340d3b71d"},
        ]
    }
    parts = [
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="metadata"\r\n\r\n',
        json.dumps(metadata).encode() + b'\r\n',
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n',
        b'Content-Type: application/javascript+module\r\n\r\n',
        worker_js + b'\r\n',
        f'--{boundary}--\r\n'.encode(),
    ]
    body = b''.join(parts)

    url = BASE + f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}'
    req = urllib.request.Request(url, data=body, method='PUT')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED_HOSTS)

    try:
        with urllib.request.urlopen(req) as resp:
            result = read_json_response(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:1000]}", file=sys.stderr)
        sys.exit(1)

    if result.get('success'):
        print("Staging deployed (minimal)!", file=sys.stderr)
    else:
        print(f"Failed: {result}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
