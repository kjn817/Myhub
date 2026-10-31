-- 0043: PIN 로그인용 테이블 (2026-10-22, 사용자 지시로 비밀번호 로그인을 6자리 PIN으로 교체)
-- 흐름: 최초 1회 이메일 OTP 본인확인(세션 발급) → PIN 설정 → 이후 PIN만으로 로그인.
-- PIN 재발급(재설정)도 OTP 본인확인 후 이 테이블의 행을 교체하는 방식이며, 교체 즉시 기존 PIN은 무효가 된다.
-- PIN은 PBKDF2-SHA256 해시(salt·iterations 포함)로만 저장한다. 평문 저장 금지.
-- accounts(0042, 비밀번호용) 테이블은 건드리지 않는다 — 비밀번호 로그인은 코드에서 제거되고 테이블은 휴면 상태로 남는다.
CREATE TABLE IF NOT EXISTS auth_pins (
  email TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
