-- 0042: 비밀번호 로그인용 계정 테이블
-- 최초 설정은 이메일 OTP로 본인 확인(세션 발급) 후에만 가능하며,
-- 비밀번호는 PBKDF2-SHA256 해시(salt·iterations 포함)로만 저장한다. 평문 저장 금지.
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
