# GPT 검토 요청: 노바 아티팩트 마커 미준수 문제

## 배경
- MyHub 홈화면에 "노바의 공간" 위젯 추가 (노바가 만든 HTML/Python/게임을 표시)
- 노바(builder persona, NVIDIA poolside/laguna-xs-2.1)가 `[ARTIFACT_CREATE]{"title": "...", "html": "..."}[/ARTIFACT_CREATE]` 마커를 출력하면 백엔드가 DB에 저장하고 홈화면에 표시

## 문제
브라우저 QA에서 노바에게 "간단한 계산기 HTML 만들어줘"라고 요청했더니:
- `[ARTIFACT_CREATE]` 마커를 출력하지 않음
- 대신 HTML 전체 코드를 마크다운 코드 블록으로 출력 + 기능 설명
- 결과적으로 아티팩트가 생성되지 않음

## 현재 프롬프트 (노바 systemPrompt末尾)
```
홈화면 아티팩트(게임, 도구 등)를 만들 때는 [ARTIFACT_CREATE]{"title": "제목", "html": "<html>...</html>"}[/ARTIFACT_CREATE] 형식으로 출력해.
html은 완전한 독립 실행형 HTML이어야 해 (style과 script 포함).
파이썬 코드가 필요하면 [ARTIFACT_CREATE]{"title": "제목", "python": "print('hello')"}[/ARTIFACT_CREATE] 형식으로 출력해.
GitHub에서 멋진 프로젝트를 가져오려면 [ARTIFACT_FROM_GITHUB]{"repo": "user/repo"}[/ARTIFACT_FROM_GITHUB] 형식으로 출력해.
아티팩트 삭제는 [ARTIFACT_DELETE]{"title": "제목"}[/ARTIFACT_DELETE]로 해.
```

## 마커 처리 흐름
1. 노바 응답 텍스트 → `parseArtifactMarkers()`가 정규식으로 `[ARTIFACT_CREATE]...[/ARTIFACT_CREATE]` 추출
2. JSON 파싱 → `executeArtifactCreate()`가 D1 `artifacts` 테이블에 저장
3. 홈화면 위젯이 `/api/artifact`로 목록 조회 후 표시

## 검토 요청 사항
1. **프롬프트 개선안**: 이 모델(NVIDIA laguna-xs-2.1)이 마커 형식을 따르도록 프롬프트를 어떻게 강화해야 하는가?
2. **대안 아키텍처**: 마커 의존 대신, 노바 응답에서 완전한 HTML 문서(<!DOCTYPE html> 또는 <html>...)를 감지하면 자동으로 아티팩트 저장을 제안/실행하는 후처리 방식은 어떤가?
3. **기타**: Function Calling 방식으로 전환하는 것이 나은가? (현재 노바는 legacy 마커 방식, 에코는 FC 사용 중)

## 제약
- 하드코딩 금지 (정규식으로 특정 패턴을 억지로 파싱하는 방식 지양)
- 보안: 아티팩트 HTML의 `<script>`는 허용해야 함 (인터랙티브 게임이 목적)
