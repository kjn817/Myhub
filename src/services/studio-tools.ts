// AI 스튜디오 Function Calling 도구 세트
// Codex/VSCode Copilot급 파일 기반 작업을 위한 도구들

export interface StudioToolCall {
  name: string
  arguments: Record<string, any>
  id?: string
}

export interface StudioToolResult {
  ok: boolean
  output: string
  error?: string
}

// 도구 정의 (OpenAI Function Calling 형식)
export const STUDIO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: '프로젝트에 새 파일을 생성합니다. 이미 존재하는 경로면 덮어씁니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로 (예: index.html, style.css, app.js)' },
          content: { type: 'string', description: '파일 전체 내용' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '기존 파일의 일부를 수정합니다. old_string이 정확히 일치해야 합니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로' },
          old_string: { type: 'string', description: '교체할 기존 문자열 (정확히 일치)' },
          new_string: { type: 'string', description: '새 문자열' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '파일 내용을 읽습니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '프로젝트의 모든 파일 목록을 반환합니다.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_in_files',
      description: '파일들에서 텍스트를 검색합니다. "버튼이 어디에 있지?" 같은 경우에 먼저 검색하고 read_file로 해당 부분을 읽으세요. 결과가 "파일:줄번호: 내용" 형식으로 반환됩니다.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '검색할 문자열 (대소문자 구분)' },
          file_pattern: { type: 'string', description: '파일 필터 (예: "*.html", "*.js", 생략 시 전체)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_files',
      description: '생성/수정한 파일들의 문법을 검증합니다. HTML 구조와 JS 문법을 체크합니다. 파일을 완성한 뒤 반드시 호출하세요. 오류가 있으면 edit_file로 고치세요.',
      parameters: {
        type: 'object',
        properties: {
          files: { type: 'string', description: '검증할 파일 경로들 (쉼표 구분, 생략 시 전체)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '파일을 삭제합니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: '파일에 패치를 적용합니다. 여러 줄을 한 번에 수정할 때 사용하세요. 형식:\n*** Begin Patch\n*** Update File: path/to/file\n@@\n-삭제할 줄\n+추가할 줄\n *** End Patch\n여러 파일도 한 번에 가능합니다.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: '패치 내용 (Codex 스타일)' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description: '사용자에게 질문합니다. 요구사항이 모호해서 추측하면 안 될 때 사용하세요. 질문을 보내면 작업이 잠시 멈추고, 사용자가 답하면 작업이 재개됩니다. 남용하지 말고 정말 필요할 때만 사용하세요 (최대 3개).',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '질문 목록 (최대 3개)',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '질문 ID (영문)' },
                question: { type: 'string', description: '질문 내용' },
                options: {
                  type: 'array',
                  description: '선택지 (없으면 자유 입력)',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: '선택지 ID' },
                      label: { type: 'string', description: '선택지 표시 텍스트' },
                      description: { type: 'string', description: '선택지 설명 (선택)' },
                    },
                    required: ['id', 'label'],
                  },
                },
                allow_custom: { type: 'boolean', description: '자유 입력 허용 여부 (기본 true)' },
              },
              required: ['id', 'question'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
]

// 시스템 프롬프트 (에이전트용)
export const STUDIO_AGENT_SYSTEM = `당신은 노바, AI 스튜디오의 코딩 어시스턴트입니다.

사용자와 자연스럽게 대화하세요. 필요하면 의견을 제시하고, 질문에 답하세요.

도구(create_file, edit_file, read_file, search_in_files, validate_files, list_files, delete_file, apply_patch, ask_question)가 있습니다. 앱을 만들거나 수정할 때 사용하세요. 언제 도구를 쓸지는 스스로 판단하세요.

요구사항이 모호해서 추측하면 결과물이 어긋날 것 같으면, ask_question으로 사용자에게 물어보세요. 질문을 보내면 작업이 멈추고 답이 오면 재개됩니다.

파일을 만들 때는 완전한 형태로 만드세요. HTML은 <!DOCTYPE html>을 포함한 완전한 문서로.

예시: "버튼을 파란색으로 바꿔줘"라는 요청이 오면, search_in_files로 "red"를 찾아서 어디에 빨간색이 정의되어 있는지 확인하고, edit_file로 파란색으로 바꾸세요. Tailwind라면 bg-red-600을 bg-blue-600으로 바꾸는 식으로.`


