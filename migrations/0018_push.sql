-- Web Push 구독 (일정 알림용)
-- VAPID 키는 Worker secret으로 관리 (VAPID_PRIVATE_KEY / VAPID_SUBJECT)
-- 키 생성: node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ec',{namedCurve:'prime256v1'});console.log(JSON.stringify(k.privateKey.export({format:'jwk'})))"
-- 사용자는 D1 콘솔에서 아래 SQL을 직접 실행해야 함 (배포 스크립트는 마이그레이션을 자동 적용하지 않음)

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
