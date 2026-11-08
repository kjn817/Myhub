// MyHub 모듈 간 이벤트 버스 (in-process pub/sub)
// 모듈이 서로를 직접 import하지 않고 사건을 주고받는 통로.
// 예: memo 모듈이 'memo.deleted'를 발행하면, 나중에 생길 휴지통/검색 모듈이 구독.
// Workers는 요청마다 격리되므로 리스너는 모듈 로드 시점에 등록된다.

export type EventHandler = (payload: any) => void | Promise<void>

const listeners = new Map<string, Set<EventHandler>>()

export function on(event: string, handler: EventHandler): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(handler)
  return () => {
    set!.delete(handler)
  }
}

export async function emit(event: string, payload?: any): Promise<void> {
  const set = listeners.get(event)
  if (!set || set.size === 0) return
  await Promise.all(
    [...set].map((h) => {
      try {
        return h(payload)
      } catch (e) {
        console.error(`[events] handler failed for ${event}:`, e)
        return undefined
      }
    })
  )
}

// 표준 이벤트 이름 규칙: '<모듈>.<동작>' (예: 'memo.created', 'memo.deleted', 'file.uploaded')
// 엔티티 참조 규칙: '<모듈>:<id>' (예: 'memo:123') — 모듈 간 링크의 공용 형식.
