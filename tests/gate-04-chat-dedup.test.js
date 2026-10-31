/**
 * 관문 테스트 4: 채팅 중복 저장 방지
 *
 * 결함: 프론트엔드 saveChatMsg → POST /chats로 사용자 메시지 저장.
 * 백엔드 POST /jobs에서도 같은 메시지를 artifact_chats에 저장.
 * 두 경로가 모두 실행되면 중복 저장됨.
 *
 * 기대: 같은 artifact + 같은 내용 + 짧은 시간 내 중복은 저장하지 않아야 함.
 */

// 중복 체크 로직 시뮬레이션
async function shouldSaveMessage(existingMessages, newMsg) {
  // 5초 이내에 같은 artifact + 같은 who + 같은 content가 있으면 중복
  const fiveSecAgo = Date.now() - 5000
  const dup = existingMessages.find(m =>
    m.artifact_id === newMsg.artifact_id &&
    m.who === newMsg.who &&
    m.content === newMsg.content &&
    new Date(m.created_at).getTime() > fiveSecAgo
  )
  return !dup
}

describe('관문 4: 채팅 중복 저장 방지', () => {
  test('5초 내 동일 메시지 → 저장하지 않음', async () => {
    const existing = [{
      artifact_id: 1, who: 'user', content: '버튼 만들어줘',
      created_at: new Date().toISOString(),
    }]
    const result = await shouldSaveMessage(existing, {
      artifact_id: 1, who: 'user', content: '버튼 만들어줘',
    })
    expect(result).toBe(false)
  })

  test('다른 내용 → 저장함', async () => {
    const existing = [{
      artifact_id: 1, who: 'user', content: '버튼 만들어줘',
      created_at: new Date().toISOString(),
    }]
    const result = await shouldSaveMessage(existing, {
      artifact_id: 1, who: 'user', content: '다른 요청',
    })
    expect(result).toBe(true)
  })

  test('5초 지난 동일 메시지 → 저장함 (새로운 요청)', async () => {
    const existing = [{
      artifact_id: 1, who: 'user', content: '버튼 만들어줘',
      created_at: new Date(Date.now() - 10000).toISOString(),
    }]
    const result = await shouldSaveMessage(existing, {
      artifact_id: 1, who: 'user', content: '버튼 만들어줘',
    })
    expect(result).toBe(true)
  })
})
