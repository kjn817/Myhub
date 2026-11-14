import type { Hono } from 'hono'
import type { Env } from './types'
import { Hono as HonoBase } from 'hono'
import { memoApp } from './modules/memo/routes'
import { aiApp } from './modules/ai/routes'
import { scheduleApp } from './modules/schedule/routes'
import { todoApp } from './modules/todo/routes'
import { artifactApp } from './modules/artifact/routes'
import { briefingApp } from './modules/briefing/routes'
import { pptxApp } from './modules/pptx/routes'
import { pushApp } from './modules/push/routes'
import memoryApp from './modules/memory/routes'
import backupApp from './modules/backup/routes'
import { keyRotationApp } from './modules/key-rotation/routes'
import { channelApp } from './modules/channel/routes'
import { cronApp } from './modules/cron/routes'
import { googleApp } from './modules/google/routes'
import { voiceApp } from './modules/voice/routes'
import { mcpApp } from './modules/mcp/routes'
import { desktopApp } from './modules/desktop/routes'
import { driveApp } from './modules/drive/routes'
import { browseApp } from './modules/browse/routes'
import { callSingleAssistant } from './modules/ai/routes'
import { setAssistantHandler } from './services/channel-gateway'

// 채널 게이트웨이 AI 핸들러 연결 (트랙 5)
// - 게이트웨이(서비스)는 모듈을 직접 import하지 않고, 이 레지스트리(구성 루트)가
//   AI 모듈의 callSingleAssistant를 핸들러 포트로 주입한다.
// - 핸들러 미연결 시 게이트웨이는 503으로 fail-closed 된다.
// 채널 경유 실행은 출처가 'channel'이다 (③-A): 웹훅 발신자는 채팅 세션의
// 승인 상대가 아니므로, 비서의 쓰기·파괴적 도구는 게이트에서 deny된다.
setAssistantHandler((env, personaId, messages) =>
  callSingleAssistant(env, personaId, messages, { origin: 'channel' }),
)

export interface ModuleDef {
  id: string // /api/<id> 로 붙는 경로
  name: string // 대시보드에 표시될 이름
  desc: string // 대시보드에 표시될 설명
  path: string // 프론트 페이지 경로 (public/ 밑)
  app: Hono<{ Bindings: Env }>
  hidden?: boolean // true면 대시보드 아이콘에 표시하지 않음 (API 전용 모듈)
}

// 새 모듈 추가 방법: 아래 배열에 한 줄만 추가하면 끝.
// 예: { id: 'todo', name: '할 일', desc: '...', path: '/todo.html', app: todoApp },
export const modules: ModuleDef[] = [
  { id: 'memo', name: '메모', desc: '간단한 메모장 (D1 사용 예제)', path: '/memo.html', app: memoApp },
  { id: 'drive', name: '파일 보관함', desc: '파인더 저장소 — 업무 파일 폴더·업로드·휴지통', path: '/finder.html', app: driveApp, hidden: true },
  { id: 'ai', name: 'AI 비서', desc: 'AI 비서 채팅', path: '/chat.html', app: aiApp },
  { id: 'schedule', name: '일정', desc: '스케줄 관리', path: '/schedule.html', app: scheduleApp },
  { id: 'todo', name: '할일', desc: '할일 체크리스트', path: '/todo.html', app: todoApp },
  { id: 'studio', name: 'AI 스튜디오', desc: '노바와 함께 앱 만들기', path: '/agent.html', app: new HonoBase<{ Bindings: Env }>() },
  { id: 'artifact', name: '아티팩트', desc: '노바의 창작 공간', path: '', app: artifactApp, hidden: true }, // 정적 프론트 없음 — 내용은 artifactApp이 서빙한다. 옛 데스크톱(index.html)을 가리키던 경로는 2026-11-12 정리 때 제거했다.
  { id: 'briefing', name: '오늘 브리핑', desc: '오늘 일정·할일 요약', path: '/schedule.html', app: briefingApp, hidden: true },
  { id: 'pptx', name: 'PPT 내보내기', desc: '아침 브리핑·주간 보고서 PPTX 내보내기', path: '', app: pptxApp, hidden: true },
  { id: 'push', name: '푸시 알림', desc: '일정 알림 구독', path: '/schedule.html', app: pushApp, hidden: true },
  // 통합 검색(search) 모듈은 D3 결정(2026-11-14)으로 제거 — GET /api/search/
  // 호출자 없음. unifiedSearch 서비스는 유지된다.
  { id: 'memory', name: '장기 기억', desc: '사용자 동의 기반 장기 기억', path: '/memory.html', app: memoryApp, hidden: true },
  // backup 앱은 AppEnv(Variables 포함)로 타입되지만 모듈 레지스트리의
  // 공통 형태는 Bindings-only다 — 구성 루트에서만 경계 캐스트로 맞춘다 (L-05).
  { id: 'backup', name: '백업', desc: '일관된 백업 (관리자 전용)', path: '', app: backupApp as Hono<{ Bindings: Env }>, hidden: true },
  { id: 'key-rotation', name: '키 로테이션', desc: '암호화 키 재암호화 (관리자 전용, step-up 필요)', path: '', app: keyRotationApp, hidden: true },
  { id: 'channel', name: '채널', desc: '메시지 채널 게이트웨이 (웹훅)', path: '', app: channelApp, hidden: true },
  { id: 'cron', name: '자동화', desc: '반복 자동화 (자연어 cron)', path: '', app: cronApp, hidden: true },
  { id: 'google', name: 'Google 연동', desc: 'Gmail·Google 캘린더 연동 (OAuth)', path: '', app: googleApp, hidden: true },
  { id: 'voice', name: '음성', desc: '음성 입력·출력 (Whisper STT·MeloTTS)', path: '', app: voiceApp, hidden: true },
  { id: 'mcp', name: 'MCP 서버', desc: '표준 MCP(Streamable HTTP) 읽기 도구', path: '', app: mcpApp, hidden: true },
  { id: 'desktop', name: '데스크톱', desc: '웹OS 데스크톱 배경화면(오늘의 사진)', path: '/desktop.html', app: desktopApp, hidden: true },
  { id: 'browse', name: '브라우저', desc: '원격 실제 브라우저(Oracle) 프록시', path: '', app: browseApp, hidden: true },
]
