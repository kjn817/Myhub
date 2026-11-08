#!/usr/bin/env python3
"""MyHub 스테이징 배포: 정적 파일 인라인 + esbuild 번들 + Worker 업로드.

운영(myhub)에는 절대 배포하지 않음. 스테이징(myhub-staging) 전용.
- D1: myhub-db-staging (995184a9-b291-402c-adf5-0d8d80a59e1c)
- KV: myhub-kv-staging (45e164df619847f5bd0a829340d3b71d)
- ENVIRONMENT=staging
- Cron 없음 (스테이징에서 자동 실행 방지)
"""
import sys, json, subprocess, urllib.request, urllib.error, time
from pathlib import Path

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import add_surrogate_to_request, read_json_response

CREDENTIAL = 'custom.cloudflare'
ALLOWED_HOSTS = ['api.cloudflare.com']
BASE = 'https://api.cloudflare.com/client/v4'
ACCOUNT_ID = '59e749ed2e9cdb8b0bf70d47227968a1'
SCRIPT_NAME = 'myhub-staging'

STAGING_D1_ID = '995184a9-b291-402c-adf5-0d8d80a59e1c'
STAGING_KV_ID = '45e164df619847f5bd0a829340d3b71d'
PROD_D1_ID = '0dd871c5-3d1c-4cea-bfbe-3e258f477106'
PROD_KV_ID = '83d3e9027c9145ae89c15df3bdee9999'

assert STAGING_D1_ID != PROD_D1_ID, "스테이징 D1이 운영 D1과 같습니다!"
assert STAGING_KV_ID != PROD_KV_ID, "스테이징 KV가 운영 KV와 같습니다!"
assert SCRIPT_NAME != 'myhub', "운영 스크립트명으로 배포 시도!"

project = Path('/home/hatch/workspace/myhub')

NODE_GEN = r'''
const fs = require("fs");
const crypto = require("crypto");
let ts = fs.readFileSync("./src/index.ts", "utf-8");
const marker = "// [STATIC_INJECT]";
if (!ts.includes(marker)) { console.error("MARKER NOT FOUND"); process.exit(1); }
const pub = "./public";
const read = (p) => fs.readFileSync(pub + p, "utf-8");
const staticBufs = ["/shell.css", "/nav.js", "/assistant-widget.js", "/assistant-widget.css", "/sw.js", "/index.html", "/memo.html", "/chat.html", "/schedule.html", "/todo.html", "/login.html", "/search.html", "/memory.html", "/manifest.json", "/css/chat.css", "/js/chat.js", "/css/memo.css", "/js/memo-bundle.js"]
  .map((p) => fs.readFileSync(pub + p));
const AV = crypto.createHash("sha1").update(Buffer.concat(staticBufs)).digest("hex").slice(0, 8);
const ver = (s) => s.replace(/(["'(]|url\()(['"]?)\/(shell\.css|nav\.js|manifest\.json|wallpaper\.webp|icon-192\.png|icon-512\.png|avatars\/[\w-]+\.webp|js\/chat\.js|css\/chat\.css|js\/memo-bundle\.js|css\/memo\.css)/g,
  "$1$2/$3?v=" + AV);
const files = {
  "/": ver(read("/index.html")),
  "/index.html": ver(read("/index.html")),
  "/memo.html": ver(read("/memo.html")),
  "/chat.html": ver(read("/chat.html")),
  "/schedule.html": ver(read("/schedule.html")),
  "/todo.html": ver(read("/todo.html")),
  "/search.html": ver(read("/search.html")),
  "/memory.html": ver(read("/memory.html")),
  "/login.html": ver(read("/login.html")),
  "/manifest.json": ver(read("/manifest.json")),
  "/nav.js": read("/nav.js"),
  "/assistant-widget.js": read("/assistant-widget.js"),
  "/assistant-widget.css": read("/assistant-widget.css"),
  "/shell.css": read("/shell.css"),
  "/sw.js": read("/sw.js"),
  "/css/chat.css": read("/css/chat.css"),
  "/css/memo.css": read("/css/memo.css"),
  "/js/memo-bundle.js": read("/js/memo-bundle.js"),
        "/js/chat.js": read("/js/chat.js"),
};
let sc = "const STATIC_FILES_B64={\n";
for (const [p,c] of Object.entries(files)) {
  const b64 = Buffer.from(c, 'utf-8').toString('base64');
  sc += " "+JSON.stringify(p)+":"+JSON.stringify(b64)+",\n";
}
sc += "};\n";
sc += "const STATIC_FILES={};\n";
sc += "for(const [p,b] of Object.entries(STATIC_FILES_B64)){const bin=atob(b);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);STATIC_FILES[p]=new TextDecoder().decode(bytes);}\n";
sc += "const ICON192_B64=" + JSON.stringify(fs.readFileSync(pub + "/icon-192.png").toString("base64")) + ";\n";
sc += "const ICON512_B64=" + JSON.stringify(fs.readFileSync(pub + "/icon-512.png").toString("base64")) + ";\n";
sc += "const WALLPAPER_B64=" + JSON.stringify(fs.readFileSync(pub + "/wallpaper.webp").toString("base64")) + ";\n";
sc += "const AV_RUMI_B64=" + JSON.stringify(fs.readFileSync(pub + "/avatars/rumi.webp").toString("base64")) + ";\n";
sc += "const AV_ECHO_B64=" + JSON.stringify(fs.readFileSync(pub + "/avatars/echo.webp").toString("base64")) + ";\n";
sc += "const AV_NOVA_B64=" + JSON.stringify(fs.readFileSync(pub + "/avatars/nova.webp").toString("base64")) + ";\n";
sc += "const AV_CALI_B64=" + JSON.stringify(fs.readFileSync(pub + "/avatars/cali.webp").toString("base64")) + ";\n";
const routes = "// Inline static (asset ver "+AV+")\n"+sc+
  "const CT={\"/\":\"text/html\",\"/index.html\":\"text/html\",\"/memo.html\":\"text/html\",\"/chat.html\":\"text/html\",\"/schedule.html\":\"text/html\",\"/todo.html\":\"text/html\",\"/search.html\":\"text/html\",\"/login.html\":\"text/html\",\"/manifest.json\":\"application/json\",\"/nav.js\":\"application/javascript\",\"/shell.css\":\"text/css\",\"/sw.js\":\"application/javascript\",\"/css/chat.css\":\"text/css\",\"/js/chat.js\":\"application/javascript\"};\n"+
  "const HTML_PAGES=new Set([\"/\",\"/index.html\",\"/memo.html\",\"/chat.html\",\"/schedule.html\",\"/todo.html\",\"/search.html\",\"/login.html\"]);\n"+
  "const IMG_CC={\"Cache-Control\":\"public, max-age=31536000, immutable\"};\n"+
  "for(const [p,c] of Object.entries(STATIC_FILES)){const t=CT[p]+\"; charset=utf-8\";const cc=HTML_PAGES.has(p)?\"no-cache\":\"public, max-age=31536000, immutable\";app.get(p,(ctx)=>ctx.text(c,200,{\"Content-Type\":t,\"Cache-Control\":cc}));}\n"+
  "app.get(\"/icon-192.png\",(ctx)=>{const b=Uint8Array.from(atob(ICON192_B64),c=>c.charCodeAt(0));return new Response(b,{headers:{\"Content-Type\":\"image/png\",...IMG_CC}})});\n"+
  "app.get(\"/icon-512.png\",(ctx)=>{const b=Uint8Array.from(atob(ICON512_B64),c=>c.charCodeAt(0));return new Response(b,{headers:{\"Content-Type\":\"image/png\",...IMG_CC}})});\n"+
  "app.get(\"/wallpaper.webp\",(ctx)=>{const b=Uint8Array.from(atob(WALLPAPER_B64),c=>c.charCodeAt(0));return new Response(b,{headers:{\"Content-Type\":\"image/webp\",...IMG_CC}})});\n"+
  "app.get(\"/avatars/rumi.webp\",(ctx)=>{const b=Uint8Array.from(atob(AV_RUMI_B64),c=>c.charCodeAt(0));return new Response(b,{headers:{\"Content-Type\":\"image/webp\",...IMG_CC}})});\n"+
  "app.get(\"/avatars/echo.webp\",(ctx)=>{const b=Uint8Array.from(atob(AV_ECHO_B64),c=>c.charCodeAt(0));return new Response(b,{headers:{\"Content-Type\":\"image/webp\",...IMG_CC}})});\n"+
  "app.get(\"/avatars/nova.webp\",(ctx)=>{const b=Uint8Array.from(atob(AV_NOVA_B64),c=>c.charCodeAt(0));return new Response(b,{headers:{\"Content-Type\":\"image/webp\",...IMG_CC}})});\n"+
  "app.get(\"/avatars/cali.webp\",(ctx)=>{const b=Uint8Array.from(atob(AV_CALI_B64),c=>c.charCodeAt(0));return new Response(b,{headers:{\"Content-Type\":\"image/webp\",...IMG_CC}})});\n\n"+marker;
ts = ts.replace(marker, routes);
fs.writeFileSync("./src/index-inline.ts", ts);
console.log("written");
'''


def main():
    result = subprocess.run(['node', '-e', NODE_GEN],
                            cwd=str(project), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Generate failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    with open(str(project / 'src' / 'index-inline.ts'), encoding='utf-8', errors='ignore') as f:
        generated = f.read()
    if 'STATIC_FILES_B64' not in generated:
        print("ERROR: Generated file missing STATIC_FILES_B64!", file=sys.stderr)
        sys.exit(1)

    result = subprocess.run(
        ['npx', 'esbuild', 'src/index-inline.ts', '--bundle', '--format=esm',
         '--platform=neutral', '--outfile=/tmp/myhub-staging-inline.js'],
        cwd=str(project), capture_output=True, text=True, errors='replace')
    if result.returncode != 0:
        print(f"Bundle failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    with open('/tmp/myhub-staging-inline.js', 'rb') as f:
        worker_js = f.read()
    if b'STATIC_FILES_B64' not in worker_js:
        print("ERROR: Bundle missing STATIC_FILES_B64!", file=sys.stderr)
        sys.exit(1)
    print(f"Bundle: {len(worker_js)} bytes", file=sys.stderr)

    boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
    metadata = {
        'main_module': 'index.js',
        'compatibility_date': '2026-10-01',
        'bindings': [
            {'type': 'd1', 'name': 'DB', 'id': STAGING_D1_ID},
            {'type': 'kv_namespace', 'name': 'KV', 'namespace_id': STAGING_KV_ID},
            {'type': 'ai', 'name': 'AI'},
            {'type': 'plain_text', 'name': 'APP_NAME', 'text': 'MyHub'},
            {'type': 'plain_text', 'name': 'ENVIRONMENT', 'text': 'staging'},
        ],
        # 스테이징: Cron 없음 (자동 실행 방지)
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
        print("Staging deployed!", file=sys.stderr)
    else:
        print(f"Failed: {result}", file=sys.stderr)
        sys.exit(1)

    # 배포 후 검증
    time.sleep(3)
    base_url = 'https://myhub-staging.myhub-app.workers.dev'
    checks = {'/api/health': 200, '/manifest.json': 200}
    failed = False
    for path, want in checks.items():
        try:
            req = urllib.request.Request(base_url + path + '?vfy=1',
                                         headers={'User-Agent': 'MyHubDeploy/1.0'})
            with urllib.request.urlopen(req, timeout=15) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception as e:
            code = f'ERR {e}'
        ok = (code == want)
        print(f"  verify {path}: {code} {'OK' if ok else 'FAIL'}", file=sys.stderr)
        if not ok:
            failed = True
    if failed:
        print("WARNING: some checks failed", file=sys.stderr)


if __name__ == '__main__':
    main()
