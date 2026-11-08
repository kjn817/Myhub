const WRITE_OBJECTS_KO = /(일정|약속|회의|할\s*일|메모|기록|알림|리마인더|예약|파일|문서|캘린더|달력|메일|이메일|자동화|크론)/
const WRITE_VERBS_KO = /(등록|추가|삭제|취소|수정|변경|저장|생성|지워|지우|옮겨|옮기|보내|넣어|넣|올려|올리|작성|제거|켜줘|켜|꺼줘|정리|잡아|잡는|만들어|만들|예약|설정|써줘|적어|남겨)/
const WRITE_OBJECTS_EN = /\b(memo|note|schedule|calendar|to-?do|task|e-?mail|reminder|file|document|automation|cron|event|appointment)\b/i
const WRITE_VERBS_EN = /\b(delete|remove|create|add|update|edit|send|schedule|save|write|post|cancel|move|turn\s+on|turn\s+off|enable|disable)\b/i

export function detectWriteIntent(message: string): boolean {
  if (!message) return false
  const hasObject = WRITE_OBJECTS_KO.test(message) || WRITE_OBJECTS_EN.test(message)
  if (!hasObject) return false
  return WRITE_VERBS_KO.test(message) || WRITE_VERBS_EN.test(message)
}
