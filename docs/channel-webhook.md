# 채널 웹훅 (CHANNEL_WEBHOOK_SECRET) 등록 절차

외부 채널(예: 텔레그램 봇, 사내 웹훅)이 MyHub 비서에게 메시지를 보내려면
공유 시크릿 `CHANNEL_WEBHOOK_SECRET`이 Worker에 등록돼 있어야 한다.
미설정 시 웹훅은 fail-closed로 비활성화되고 `POST /api/channel/webhook/:channelId`는
503 `webhook_disabled`을 반환한다. 잘못된 시크릿에는 401을 반환한다.

## 시크릿 값 조건

- 임의의 긴 무작위 문자열이면 된다 (권장 32자 이상, 영문·숫자·기호 혼합).
- `SESSION_SECRET`, `MEMO_ENCRYPTION_KEY` 등 다른 시크릿과 **절대 같은 값을 쓰지 말 것**.
- 값은 코드·채팅·문서에 적지 않는다. 분실 시 새로 만들어 교체하면 된다.

생성 예 (로컬에서 한 번만 실행, 값은 화면에만 뜨고 저장되지 않음):

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 등록 절차 (Cloudflare 대시보드 — 사용자가 직접)

1. Cloudflare 대시보드 → Workers & Pages → `myhub` → Settings → Variables and Secrets
2. **Add** → 종류를 **Secret**으로 선택 → 이름 `CHANNEL_WEBHOOK_SECRET`, 값에 위에서 만든 문자열 입력 → 저장
3. 재배포: `python3 ~/workspace/myhub/deploy_full.py production`
   (시크릿 등록만으로는 기존 배포본에 반영되지 않으므로 재배포 필수.
   `deploy_full.py`는 시크릿 소실 가드가 내장돼 있어 기존 시크릿 24개가 유지되는지
   업로드 전후로 비교한다.)

## 호출 방법

```
POST /api/channel/webhook/:channelId
Authorization: Bearer <CHANNEL_WEBHOOK_SECRET>
Content-Type: application/json

{ "text": "안녕", "senderId": "u1" }
```

- `Authorization: Bearer <시크릿>` 헤더 대신 본문 `secret` 필드로도 인증된다.
- 등록된 채널 ID는 `GET /api/channel/channels`로 확인한다 (현재 `webhook` 1개).
- 미등록 채널은 404, 본문이 비어 있으면 400을 반환한다.

## 동작 확인

| 상황 | 예상 응답 |
|---|---|
| 시크릿 미설정 | 503 `webhook_disabled` (메시지에 등록 절차 안내 포함) |
| 시크릿 설정 + 잘못된 값 | 401 `unauthorized` |
| 시크릿 설정 + 올바른 값 + 미등록 채널 | 404 `unknown_channel` |
| 시크릿 설정 + 올바른 값 + 등록 채널 | 200 + 비서 응답 `reply` |
