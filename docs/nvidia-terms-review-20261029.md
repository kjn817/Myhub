# NVIDIA API 약관 정독 — 에코(NVIDIA) 상시 경로 리스크 판정

> 조사일: 2026-10-29 (KST)
> 트랙: 2026-10-29 트렌드 조사(`~/workspace/your_files/trend-research-20261029.md` 팩트체크 #23, "부분 확인")의 종결 작업
> 방법: 2차 출처가 아닌 **NVIDIA 공식 약관 원문을 직접 열람·전수 정독**. 인용은 전부 원문 문구 그대로.
> 대상 사용: MyHub '에코'(keeper, `model.summarize=nvidia`)가 `https://integrate.api.nvidia.com/v1/chat/completions` 로 NVIDIA Nemotron 계열을 호출하는 상시 경로. 코드 기준 모델은 `src/services/ai.ts`의 NVIDIA 7종 (`nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, `meta/muse-glimmer-30b`, `google/diffusiongemma-26b-a4b-it`, `openai/gpt-oss-20b`)이며 전부 같은 Trial 약관 아래 있다 (아래 §0).

---

## 판정 (요약)

### **민감 요청 제외 필요** — 단, 에코의 본업(메모 요약·검색)은 민감 범주라 실질 효과는 "에코 기본 경로 교체"에 가깝다

| 질문 | 판정 | 핵심 근거 |
|---|---|---|
| 상시 개인 용도가 허용 범위인가 | **회색 — Trial 약관 문언상 "테스트·평가 전용"이며, 상시 의존은 그 문언 바깥이다. 단 개인·비상업·단일 사용자·외부 이용자 없음은 NVIDIA 공식 FAQ의 "production" 정의(사업 거래·실제 최종이용자 서빙)에도 정면으로 걸리지 않는다** | Trial §1.2·§1.4 / NIM FAQ의 production 정의 |
| 입출력 수집 범위 | **세션 중 이용은 "서비스 제공 목적"으로 한정되나, §3.3(iv)가 비식별 User/Generated Content를 "AI 모델을 포함한 제품·서비스 개선"용으로 수집한다고 별도로 명시한다. "학습에 쓰지 않는다"는 약속은 원문에 없다. 보관 기간·옵트아웃은 Trial 약관에 명시 없음** | Trial §2.2·§2.3·§2.7·§3.3 |
| 개인 메모·개인정보 전송 | **약관 문언상 금지 영역이다.** 기밀정보·개인정보는 "API Service가 명시적으로 허용한 경우"가 아니면 넣지 말라고 두 조항이 중복으로 금지한다. Nemotron 채팅 API에서 그런 명시적 허용은 확인되지 않았다 | Trial §2.6(a)·§4.3 |

실무 리스크의 성격: 법적 배상 리스크(책임 상한 $10, §13.2)보다 **①계정·서비스 종료 리스크(§11.2 — 위반 시 통지 없이 자동 종료, §8 — 언제든 중단·폐지 가능), ②보낸 개인 내용이 비식별 개선 수집(§3.3(iv))에 들어간 뒤에는 회수 수단이 없다는 리스크**가 본질이다.

---

## 0. 어떤 약관이 적용되는가 (확인됨)

MyHub의 호출에 적용되는 문서는 층이 나뉜다. 혼동하면 판정이 달라진다.

1. **NVIDIA API Trial Terms of Service** — 호스팅 API(`integrate.api.nvidia.com`, build.nvidia.com API Catalog) 사용 자체를 규율하는 본 약관.
   - 원문: `https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf`
   - 버전 표기: 문서 말미 `v. September 19, 2025`. 2026-10-29에 직접 열람해 §1~§15 전수 확인.
   - Nemotron-3-Ultra 모델 문서(`docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b`)의 명시 문구: *"Governing Terms: The trial service is governed by the NVIDIA API Trial Terms of Service."* 다른 카탈로그 모델 페이지들도 동일하게 이 PDF를 가리킨다.
2. **모델 라이선스** (예: Nemotron-3-Ultra는 OpenMDW-1.1) — 모델 가중치와 Generated Content 소유(§6.3이 이 라이선스에 위임)를 규율할 뿐, **호스팅 API의 사용 목적 제한을 풀어주지 않는다.** 모델 카드의 "ready for commercial and non-commercial use"는 모델(가중치) 기준 문구이지 Trial API의 production 허용이 아니다.
3. **NVIDIA NIM 공식 FAQ** (`docs.api.nvidia.com/nim/docs/product`, Updated 2026-08-06 표기) — Developer Program 경유 NIM 접근과 production의 정의를 설명하는 공식 문서. 약관 본문은 아니지만 NVIDIA 자신의 해석 기준이다.
4. **NVIDIA Privacy Policy** (`nvidia.com/en-us/about-nvidia/privacy-policy`) — 계정·웹사이트 개인정보 처리 일반. Trial §3.1이 이 정책을 참조한다. API의 User Content 수집은 정책 본문이 아니라 Trial §3이 직접 규율한다 (둘이 규율 대상이 다름 — 아래 §3.4).
5. **NVIDIA Developer / Technology Access Terms of Use** (`developer.nvidia.com/legal/terms` §7 Trial and Other Promotional Offerings) — 사이트·기술 전반의 재판/평가 제공 일반 조항. API 전용 판정은 위 1이 우선한다.

유료 경로와의 구분: NVIDIA AI Enterprise 구독 / 유료 Subscription의 약관(DPA 포함, "개인정보를 사업 목적 외로 보관·사용하지 않는다" 류의 보호)은 **Trial 경로에는 적용되지 않는다.** MyHub는 무과금 Trial 키를 쓰므로 이 문서의 판정은 전부 Trial 약관 기준이다.

---

## 1. 상시 개인 용도 — "프로토타이핑/평가 전용" 제한은 실재한다 (확인됨)

### 1.1 Trial 약관 원문

**§1.2 Trial Access Rights**

> "NVIDIA will provide you access to the API Service **for limited trial purposes only and without use of the API Service or Generated Content in production**."

**§1.4 Trial Terms and Credits**

> "You must have a separate service subscription ("Subscription") from NVIDIA or a third-party service provider ("Service Provider") **to use the API Service in production** or to use the API Service after you have used your available Credits. **Unless you purchase a Subscription** from NVIDIA or a Service Provider (as applicable), **you may only use the API Service for internal testing and evaluation purposes, not in production**."

**§4.1**도 용도를 §1로 한정한다: "You will not use the API Service for any purpose other than as described in Section 1 above…"

**§1.3 Pre-Release**는 별도의 불안정성 고지다: 프리릴리스 버전은 "not intended for use in production or business-critical systems"이며 상용 버전이 안 나올 수도, 언제든 개발을 포기하고 종료할 수도 있다.

### 1.2 "production"의 범위 — 공식 FAQ의 정의

NIM 공식 FAQ 원문:

> "NIM access through the NVIDIA Developer Program is **for prototyping, research, development and testing purposes only** and does not include enterprise features or support."
>
> "**Production use involves any use of NIM for purposes other than development, testing, research or evaluation such as conducting business transactions and any non-testing activity including activity serving real end-users.** Using NIM in production requires an NVIDIA AI Enterprise license."

### 1.3 MyHub 상시 경로에의 대입

사실관계 (코드·운영 기준):

- 에코는 일회성 모델 평가가 아니라 **매일 실제로 쓰는 개인 비서의 상시 추론 경로**다. 요약 결과를 사용자가 실제 기록 관리에 쓴다. "모델을 테스트 중"인 상태가 아니다.
- 반면 사용자는 1명(본인), 비상업, 외부 최종이용자 없음, 사업 거래 없음, 요금을 받거나 제3자에게 서비스를 제공하지 않는다.

해석:

- **문언 엄격 해석**: §1.4의 허용 범위는 "internal testing and evaluation"이다. 일상 업무를 실제로 처리하는 상시 의존은 testing/evaluation이 아니므로 문언 바깥이다. FAQ 정의 후단 "any non-testing activity"를 그대로 읽으면 개인 상시 사용도 걸린다.
- **목적·정의 해석**: FAQ 정의의 예시는 "conducting business transactions", "serving real end-users"로, 타인에게 서빙하는 운영을 겨냥한다. 본인 1인용 도구는 그 예시에 해당하지 않고, NVIDIA가 Developer Program 접근을 "duration of program membership" 동안 열어 두는 구조와도 충돌이 적다.
- 어느 해석이 NVIDIA의 집행 기준인지는 **원문만으로 확정할 수 없다** (미확인 §6 참조). 다만 집행이 문제될 때의 결과는 명확하다: §11.2 — 약관 위반 시 사용권이 "terminates automatically without notice", NVIDIA는 "at any time" 서비스/사용을 종료할 수 있다. §12 무보증("AS IS"), §13.2 책임 상한 US$10. 즉 **상시 경로로 의존할 안정성·계속성 보장이 약관상 전혀 없다**는 점은 해석과 무관하게 확정이다.

결론 (이 항목): "프로토타이핑 전용" 제한은 **실재하고 문구도 명확하다.** 개인 1인 사용이 그 제한에 곧바로 위반이라고 단정할 근거도, 안전하다고 단정할 근거도 원문에 없다. 확실한 것은 ①Trial인 이상 언제 끊겨도 약관상 항변할 수 없고 ②아래 §2의 개인정보 금지는 이 회색 영역과 무관하게 별도로 성립한다는 점이다.

---

## 2. 입력·출력 수집 — §2.3과 §3.3(iv)의 긴장 (확인됨, 해소는 미확인)

조항이 네 층으로 돼 있고, 겉보기에 상충하는 두 문장이 공존한다. 분리해서 읽어야 한다.

### 2.1 세션 중 이용 — 서비스 제공 목적으로 한정 (§2.2)

> "you grant NVIDIA, its affiliates and their service providers a worldwide license with respect to User Content and Generated Content, to use, host, store, reproduce, modify, create derivative works …, display and transmit such User Content and Generated Content **during your API Service session solely to provide you with the API Service** and as otherwise described in this Agreement or expressly disclosed to you for an API Service."

### 2.2 세션 종료 후 비보관 — 단, 예외 단서가 달려 있다 (§2.3)

> "**Except as stated below in Section 2.4 or unless expressly disclosed to you for an API Service, NVIDIA will not store or use User Content or Generated Content at the end of each API Service session.**"

### 2.3 예외 — Fine-tuning 보관 + 보안·부정방지 로깅 (§2.4)

- Fine Tuning API 등 특정 서비스: User Content를 최초 업로드 후 **30일**, Fine Tuning의 Generated Content를 **90일** 보관.
- 그와 별개로 "NVIDIA may log and store User Content and Generated Content **to monitor for security or to prevent fraud or abuse as stated in Section 3.3**."
- MyHub가 쓰는 일반 채팅 추론은 Fine Tuning이 아니므로 30/90일 조항 자체는 직접 적용 대상이 아니다. 보안·부정방지 로깅 예외는 적용될 수 있다. 그 로깅의 **보관 기간은 명시 없음**.

### 2.4 모니터링 권한 (§2.7)

> "You agree that NVIDIA **may, but is not obligated to, block, monitor, scan or review** communications or User Content or Generated Content transmitted through the API Service…"

### 2.5 결정적 조항 — 개선 목적 수집 (§3.3)

**§3.3 Privacy: Collection and Use of Information** 원문:

> "NVIDIA will collect the following data, **without identifying specific users, to operate and improve the API Services and other products and services**: (i) session metrics (e.g., the amount of processing power consumed, type of request made); (ii) error logs and execution logs relating to your session (e.g., whether your request was executed successfully); (iii) your feedback and ranking of specific API Services; and **(iv) User Content and Generated Content to improve NVIDIA products and services, including AI models.** Your use of the API Services will be logged for security, fraud or abuse monitoring and shared with third party service providers for this purpose."

정밀 판정:

- **수집 자체는 명시돼 있다.** §2.3의 "세션 후 저장·사용 안 함"은 §3.3을 예외로 배제하는 문구가 없고, 오히려 §3.3이 수집 항목 (iv)로 User/Generated Content 자체를 적시한다. 두 조항의 정합적 독법은 2차 분석들과 동일하다: *식별되는 세션 기록으로는 남기지 않지만, 비식별 형태로 내용은 개선 목적 수집 대상이 될 수 있다.*
- **"학습(training)"이라는 단어는 원문에 없다.** 문구는 "to improve NVIDIA products and services, **including AI models**"이다. 따라서 "프롬프트로 모델을 학습시킨다고 명시돼 있다"는 서술은 과장이다. 정확한 서술은: **①개선 사용(모델 포함)이 허용·고지돼 있고 ②"학습에 쓰지 않는다"는 약속(no-training commitment)은 원문 어디에도 없으며 ③개선 사용의 구체 형태(학습 데이터 편입인지, 평가·분석인지)를 원문이 특정하지 않는다.** 보수적 운용에서는 학습 상당 사용을 전제하는 것이 안전하다.
- **옵트아웃: Trial 약관 원문 전수에서 §3.3 수집에 대한 옵트아웃 조항을 찾지 못했다.** 있는 옵트아웃은 §14.4(중재·집단소송 포기 조항에 대한 opt-out)뿐으로 데이터 수집과 무관하다. 계정 개인정보에 대한 Privacy Policy상 삭제·열람 권리(Privacy Center / privacy@nvidia.com)는 §3.1이 참조하는 계정 데이터 얘기이며, §3.3(iv)의 "without identifying specific users" 수집에 그 권리가 미치는지는 원문이 말하지 않는다 (미확인).
- **보관 기간: §3.3 수집분의 기간 명시는 원문에 없다.** §2.4의 30/90일은 Fine Tuning 한정이다. Privacy Policy의 "engagement 지속 중 보관, 5년 무접촉 시 기업·고객 개인정보 삭제"는 계정 개인정보 기준이라 API User Content에 그대로 대입할 수 없다.
- **제3자 공유**: §2.2 라이선스의 상대에 "its affiliates and their service providers"가 포함되고, §3.3 말미는 보안·부정방지 목적 로깅을 "shared with third party service providers for this purpose"라고 한다. §3.5는 제3자 소프트웨어 제공자에게 등록·사용 정보(결제수단 제외)를 공유할 수 있다고 한다.
- NVIDIA 스태프의 공식 포럼 답변(2025-06-10, Clarification On Trial API Use 스레드)도 이 긴장을 해소하지 않았다: "unless disclosed for a specific API Service, NVIDIA will use User Content and Generated Content solely to provide users with the API Service (Section 2.2 and 2.3)"라며 §2.2·§2.3을 인용하고, 수집 고지는 §3.3에 있다고 안내하는 데 그쳤다. **"학습에 쓰지 않는다"는 확인은 스태프도 주지 않았다** (포럼 원문 직접 확인).

> 정정 기록: 일부 2차 글의 "NVIDIA states it does not use prompts and responses to train models / stateless, no content logging" 서술은 §3.3(iv) 원문과 양립하지 않아 **채택하지 않는다.** 반대로 "훈련에 쓴다고 확정" 서술도 원문 문구를 넘어서므로 채택하지 않는다. 원문이 확정하는 것은 위 굵은 3점까지다.

### 2.6 소유권 (참고, 확인됨)

§6.2 "as between you and NVIDIA, you own your User Content", §6.3 Generated Content는 동반 라이선스가 정하고, 없으면 원칙적으로 사용자 소유. 소유권 조항은 §3.3의 개선 수집 허락을 취소하지 않는다 — 소유와 수집·이용 허락은 별개다.

---

## 3. 개인 메모·개인정보 전송 리스크 (확인됨 — 금지 문언이 직접 있다)

### 3.1 §2.6(a) — 넣지 말아야 할 것의 명시

§2.6에서 사용자는 API Catalog로 User Content를 만들 때 다음을 하지 않기로 한다:

> "(a) **include any confidential information, controlled or sensitive data, including protected health information, personal data (unless expressly permitted by an API Service), payment card industry information or sensitive human subject research**, or data that was processed or collected in violation of law;"

"personal data"만 괄호 예외(서비스가 명시 허용한 경우)가 있고, **confidential information에는 예외가 없다.** 말미: "You are responsible for the consequences of User Content or Generated Content that do not conform to these limitations."

### 3.2 §4.3 — 개인정보 업로드의 중복 금지 + 서버 부적합 고지

> "**Unless expressly permitted by an API Service, you will not upload any personal information relating to an identifiable individual, financial, health or governmental information**, or any other information which may be subject to data privacy or data security laws, rules, or regulations. **NVIDIA does not represent, and specifically disclaims, that NVIDIA servers are appropriate for processing of any data including personal data**, data constituting credit card information subject to PCI DSS or Protected Health Information under HIPAA … or equivalent laws in other jurisdictions."

### 3.3 "명시적 허용"이 있는가

Nemotron-3-Ultra 모델 문서와 API Catalog 모델 페이지에서 채팅 추론에 대해 개인정보 전송을 "expressly permitted"로 고지한 문구는 **확인되지 않았다.** 오히려 카탈로그 계열 페이지에는 정반대 고지가 반복된다 (예: NGC 컬렉션 페이지 — "Please do not upload any confidential information or personal data. Your use is logged for security."). §3.2도 음성 입력 등 개인정보를 받는 서비스는 "expressly permit" + 동의 전제로 별도 설계돼 있음을 보여준다 — 일반 텍스트 채팅은 그 범주가 아니다.

### 3.4 MyHub의 실제 전송 흐름에 대입 (코드 확인)

- 에코(keeper)는 Function Calling으로 메모를 다룬다. `src/services/ai-access.ts`의 경계: `is_locked=0 AND sensitivity <= 1` 인 메모만 AI 접근 가능, 잠긴 메모와 sensitivity 2·3은 SQL + 코드 이중 필터로 원천 제외된다. **이 경계 자체는 유효하다 — 잠긴 메모(사용자가 API 키·카드번호·비밀번호·기밀 업무자료 보관용으로 둔 3단계 잠금의 최상위)는 NVIDIA로 가지 않는다.**
- 그러나 경계를 통과한 sensitivity 0·1 메모의 **전문(full text)** 이 `memo_get` 도구 결과로 NVIDIA 세션에 들어간다 (§2.2의 User Content에 해당 — 도구 결과도 사용자가 API Service에 제공하는 content다). 사용자의 기존 정책(2026-10-10 확정)은 "잠그지 않은 일반/개인 메모는 외부 AI 전송 허용"인데, 이 정책은 Gemini·Groq 등과의 관계에서 세운 것이고 **NVIDIA Trial §2.6(a)·§4.3의 문언과 정면으로 어긋나는 구간이 생긴다**: sensitivity 1 "개인 메모"에는 식별 가능한 개인의 정보(이름·일정·관계·건강·재무 단편)가 통상 포함되며, 이는 두 조항이 말하는 personal data / personal information 그 자체다.
- 대화형 요청도 마찬가지다: 사용자가 에코에게 자기 일정·가족·업무를 언급하며 요약을 시키면 그 프롬프트가 User Content가 된다.
- 추가로 §3.3(iv) 때문에 이 내용은 "보냈다가 응답만 받고 끝"이 아니라 **비식별 개선 수집의 대상**이 될 수 있고, §2.7의 스캔·리뷰 대상이며, §3.3 말미대로 보안 목적 로깅이 제3자 서비스 제공자와 공유될 수 있다. 비식별이라는 단서는 재식별 불가를 보장하는 기술적 설명이 아니라 약관의 서술일 뿐이며, 메모 전문처럼 문맥이 풍부한 텍스트는 비식별 처리의 실효를 원문만으로 검증할 수 없다 (미확인).

결론 (이 항목): **개인 메모 전문·개인정보가 포함될 수 있는 요청을 현 Trial 경로로 보내는 것은 약관 문언 위반 소지가 직접 있고, NVIDIA 스스로 서버가 개인정보 처리에 적합하다고 보증하지 않는다고 고지한 상태다.** 이 항목은 해석의 회색 영역이 아니라 금지 문구가 있는 영역이다.

---

## 4. 권고

### 4.1 판정 재확인

**민감 요청 제외 필요.** 근거는 §1(상시성 회색)보다 §3(개인정보 금지 명문)이 결정적이다. "계속 사용 가능"은 §2.6·§4.3 때문에 불가하고, 전면 "경로 교체"까지 갈 필요는 비민감 용도(공개 정보 요약, 일반 지식·추론, 코드 없는 일반 문장 작업)에서는 Trial의 본래 목적인 평가·실험과 개인 사용 범위 안에서 쓸 여지가 남기 때문이다. 단 아래 분류를 코드로 강제할 수 없으면 그때는 경로 교체가 정답이다 — 분류는 수동 주의가 아니라 라우터 정책으로 박아야 한다.

### 4.2 NVIDIA로 보내면 안 되는 것 (제외 목록)

1. 메모 전문이 실리는 모든 요청 — `memo_get`/`memo_search` 도구 결과를 포함하는 에코 세션 전체 (요약·심층분석·인용 포함)
2. sensitivity 0이라도 개인 식별 정보가 포함된 메모 (현행 경계는 sensitivity 2부터 막으므로, NVIDIA 경로에서는 기준을 "메모 컨텍스트 없음"으로 올려야 한다)
3. 일정·할 일·연락처·가족 사항 등 사용자 본인과 제3자의 개인정보가 든 프롬프트
4. 기밀정보 일체 — 업무 기밀, 자격증명 단편, 재무·건강 정보 (§2.6(a)는 예외 없는 금지)
5. 웹검색 결과라도 개인과 결합되는 맥락 (공개 뉴스 자체는 비민감이나, "내 메모와 연결해 요약"이 되면 1번으로 재분류)

### 4.3 NVIDIA로 남겨도 되는 것 (조건부)

- 공개 정보만으로 구성된 일반 질문·추론·번역·문장 작업, 공개 뉴스/문서의 단독 요약처럼 **사용자 데이터가 전혀 실리지 않는** 요청. 이 경우에도 §3.3(iv) 수집 전제는 그대로이므로 "공개돼도 되는 내용만"이 기준이다.
- 모델 비교·평가 목적의 호출 (Trial의 본래 목적 그 자체).

### 4.4 에코 기본 경로의 대체 후보 (기존 자산 안에서)

에코의 본업이 메모 요약·검색인 이상, 기본 경로는 아래 중 하나로 옮기는 것이 이 판정의 실질이다.

| 후보 | 근거 | 주의 |
|---|---|---|
| **Workers AI** (1순위) | 2026-10-15 이전 에코의 기존 경로였고 코드에 keeper × workers-ai FC 지원이 이미 있다 (`useFC`가 workers-ai와 nvidia 모두 지원). Trial/프로토타이핑 제한이 없는 정식 플랫폼 경로, 키 불필요, 뉴런 무료 풀 | 긴 프롬프트의 공유 모델 리스크는 별도 기존 주의 유지 (2026-10-26 GLM KV 캐시 사고 교훈 — 잠긴 메모는 애초에 경계에서 제외됨). 모델 품질·지연은 Nemotron Ultra 대비 실측 필요 |
| **Gemini (lite 경로)** | 루미·노바가 이미 쓰는 경로, FC·한국어 품질 실측 축적 | 프로젝트 단위 무료 쿼터 제약(2026-10-29 확정 메커니즘), 무료 티어의 Google 제품 개선 사용 문제는 별도 기존 전제와 동일하게 취급 |
| **Groq** | 캘리가 쓰는 경로, ZDR 활성화가 기존에 확인돼 있다 (MEMORY 기록) | TPM 8,000 병목 — 긴 메모 요약에는 토큰 예산 설계 필요 |

NVIDIA AI Enterprise 유료 구독($4,500/GPU/년 체계)은 무카드·무료 원칙과 충돌하므로 대체안으로 제시하지 않는다. OpenRouter `:free`의 Nemotron도 업스트림이 NVIDIA일 수 있고 약관 문제가 이동할 뿐 해소되지 않으므로 이 문제의 대체안으로 보지 않는다.

### 4.5 구현 시 최소 조치 (설계 메모, 본 트랙은 조사만 수행)

1. 라우터에서 keeper + 메모 도구 컨텍스트 조합일 때 NVIDIA를 후보에서 제외 (fail-closed — 분류 실패 시 NVIDIA가 아니라 대체 경로).
2. NVIDIA 호출 직전 가드: 도구 결과(memo 유래 텍스트)가 messages에 포함돼 있으면 차단/전환. §2.6 위반 방지는 프롬프트 주의가 아니라 이 가드로만 성립한다.
3. NVIDIA를 비민감 전용으로 남길 경우에도 상시 의존 금지 — §8·§11.2상 예고 없는 중단이 가능하므로 폴백 체인의 말단이 아니라 선택 경로로 둔다.

---

## 5. 확인한 것 (공식 원문 직접 대조)

1. Trial 약관의 존재·버전(2025-09-19)·전 조항 (§1~§15 전수 열람, PDF 원문).
2. §1.2 "limited trial purposes only … not in production", §1.4 "internal testing and evaluation purposes, not in production" + Subscription 없이는 production 불가.
3. NIM 공식 FAQ의 production 정의와 "prototyping, research, development and testing purposes only".
4. §2.2 세션 중 라이선스(서비스 제공 한정), §2.3 세션 후 비보관 + 예외 단서, §2.4 Fine Tuning 30/90일 + 보안 로깅 예외, §2.7 모니터링·스캔·리뷰 권한.
5. §3.3 수집 4항목 — 특히 (iv) User/Generated Content의 "improve NVIDIA products and services, including AI models" 목적 수집, 보안 로깅의 제3자 서비스 제공자 공유.
6. §2.6(a) 기밀·개인정보 포함 금지, §4.3 식별 가능 개인정보 업로드 금지 + 개인정보 처리 부적합 면책 고지.
7. §6.2·§6.3 소유권, §8 변경·중단 권한, §11.2 위반 시 자동 종료 + 임의 종료, §12 무보증, §13.2 책임 상한 $10, §15.7 약관의 일방 갱신(게시 시 효력).
8. Nemotron-3-Ultra 모델 문서의 Governing Terms가 Trial 약관을 가리키는 것, 모델 라이선스(OpenMDW-1.1)와 API 약관의 분리.
9. NVIDIA 스태프 포럼 답변이 §2.2·§2.3 + §3.3 안내에 그치고 학습 부정을 확인해 주지 않은 것 (공식 포럼 원문).
10. MyHub 측 사실: 에코 = NVIDIA 고정(`model.summarize=nvidia`), FC 도구 결과로 sensitivity ≤1 메모 전문이 세션에 실리는 구조, 잠긴 메모·sensitivity 2·3의 원천 제외 경계 (코드 직접 확인).

## 6. 확인 못 한 것 (미확인 — 추측으로 메우지 않음)

1. **개인 1인·비상업 사용을 NVIDIA가 production으로 집행하는지** — 원문과 FAQ 정의만으로는 확정 불가. 스태프의 구두성 설명("side project는 무기한 괜찮다" 류)은 2차 글 인용으로만 존재해 원문 대조를 못 했다.
2. **§3.3(iv) 수집분의 실제 처리 형태** — 학습 데이터 편입 여부, 비식별 처리 방법, 보관 기간, 삭제 요청의 효력. 원문이 특정하지 않고, 스태프 답변도 §3.3 안내 이상을 주지 않았다.
3. **§2.3과 §3.3(iv)의 법적 정합에 대한 NVIDIA의 공식 해석문** — 별도 해설 문서·DPA(Trial용)는 찾지 못했다. 유료 Cloud Services용 DPA는 존재하나 Trial에 적용되지 않는다.
4. **모델별 "expressly disclosed" 고지의 전수 여부** — MyHub가 쓰는 7개 모델 전부의 카탈로그 페이지에서 개인정보 허용 고지를 전수 대조하지는 않았다. 대표 모델(Ultra) + 카탈로그 공통 패턴까지 확인했고, 허용 고지가 있는 모델이 발견되면 §3.3의 판정 일부(개인정보 금지의 예외 성립 여부)가 그 모델에 한해 달라질 수 있다.
5. **실제 집행 사례** — Trial 약관 위반(상시 사용·개인정보 전송)으로 개인 계정이 종료된 공개 사례의 유무는 확인하지 못했다. 집행이 없다는 뜻이 아니다.
6. **한국 개인정보보호법 등 국내법상 평가** — 본 문서는 NVIDIA 약관 해석까지이며, 개인정보의 국외 이전 등 국내법 검토는 별도 영역이다.

---

## 출처

- NVIDIA API Trial Terms of Service (v. September 19, 2025) — https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf (2026-10-29 직접 열람, §1~§15)
- NVIDIA NIM General FAQ — https://docs.api.nvidia.com/nim/docs/product (production 정의, Developer Program 범위)
- Nemotron-3-Ultra 모델 문서 — https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b (Governing Terms)
- NVIDIA Developer Forums, "Clarification On Trial API Use" (스태프 답변 2025-06-10) — https://forums.developer.nvidia.com/t/clarification-on-trial-api-use/334275
- NVIDIA Privacy Policy — https://www.nvidia.com/en-us/about-nvidia/privacy-policy/ (§3.1 참조 대상 확인)
- NVIDIA Developer Terms of Use §7 — https://developer.nvidia.com/legal/terms
- MyHub 코드: `src/services/ai.ts` (NVIDIA 모델 7종·호출), `src/services/ai-access.ts` (메모 접근 경계), `src/modules/ai/admin-routes.ts` (`model.summarize=nvidia`)
- 선행 조사: `~/workspace/your_files/trend-research-20261029.md` 팩트체크 #23 (부분 확인 → 본 문서로 종결)

---

## 해소 경위 (2026-10-30)

본 문서의 판정("민감 요청 제외 필요", GPT 재평가에서는 NVIDIA Trial 상시 운영 경로 완전 제외가 P0로 지정됨)에 대한 후속 조치의 기록이다. 수치는 전부 실측·실행 근거가 있는 것만 적는다. 상세 측정 근거는 `docs/nvidia-replacement-measurement-20261030.md`, 구현은 커밋 `eb8e316`, 배포·라이브 QA는 코디네이터가 직접 수행·확인한 결과다.

### 실측 — 대체 경로 선정 근거 (트랙 1)

- 최근 14일 `summarize`(에코) 117회 중 NVIDIA 91회(78%), 메모 가드 우회(Workers AI) 26회였다. 일 피크는 33회다.
- 대체 1차 모델로 `@cf/qwen/qwen3-30b-a3b-fp8`를 선정했다. 피크일 기준 뉴런 소비는 약 792 뉴런으로 무료 한도 10,000의 8% 수준이며, 지연은 1.4~2.0초로 NVIDIA 평균 11.5초보다 짧았다.
- `@cf/openai/gpt-oss-120b`는 빈 응답으로 탈락했고, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`는 극단 부하 시 한도 초과 가능성이 있어 폴백 3순위로 뒀다.

### 구현 (트랙 2, 커밋 `eb8e316`)

- 비서 핀의 단일 원천(`expert-registry`)에서 keeper를 `nvidia`에서 `workers-ai`로 전환했다. MODELS 레지스트리의 NVIDIA 7개 모델은 전부 `deprecated`로 바꿨다. 플러그인 코드(`callNVIDIA`)와 시크릿은 비활성 상태로 보존해 가역성을 유지하되, 선택 경로에서는 차단한다.
- 진입점 차단(커밋 `eb8e316` diff 기준): 설정 저장, 아티팩트 잡(`POST /jobs`·구 `POST /model`), 스튜디오 에이전트 진입점(`PROVIDER_DISABLED`), job-processor 레거시 행(Gemini lite 전환), `generate-html`, 노바 서브에이전트 추천, UI 드롭다운까지 전수 적용했다.
- 뉴런 소진(4006) 시 핀을 해제하고 Gemini lite로 1회 degraded 재시도(FC 없음, 구조화 로그)하는 경로를 신설했다. 기존에는 즉시 throw였다.
- `callWorkersAI`의 usage 기록을 보강하고 마이그레이션 0064(`ai_usage.neurons`)를 추가했다. 메모 가드(`nvidia-memo-guard`)는 dormant 방어로 유지했다(판단 근거는 모듈 주석에 기록).
- 카나리아 테스트 16건을 신설하고 뮤테이션으로 실증했다(예: 핀을 되돌리면 9건 실패). 전수 검증: Jest 271 스위트 5,492 PASS, 런타임 130 PASS.

### 배포 (코디네이터 직접 수행)

- 마이그레이션 0064를 운영에 단독 적용했다(bookmark 404로 스냅샷으로 대체, 적용 전 `ai_usage` 1,084행).
- `deploy_full.py production`으로 배포해 버전 **d568a5b8 @100%**가 됐고, 시크릿 30개를 유지했으며, Cron은 `*/5`다.
- `ai_settings` 단건 쓰기 1건: `model.summarize`를 `nvidia/nemotron-3-ultra-550b-a55b`에서 `@cf/qwen/qwen3-30b-a3b-fp8`로 변경했다(changes=1). 전 `model.*` 키 중 NVIDIA 참조는 이 키 하나뿐이었다.
- verify 4/4 PASS.

### 라이브 QA (배포 후 실증)

- 에코 메모 턴·뉴스 턴 모두 `workers-ai`/`qwen3-30b`로 성공했다(`ai_usage` id 1090–1092). 호출당 뉴런 12~47이 실기록됐고(이전에는 NULL), 배포 후 NVIDIA `ai_usage` 행은 0건이다.
- 비서 4명 전원 HTTP 200, MCP `tools/list` 200, Google 연결 유지, step-up 유지를 확인했다(메모 133을 PIN 없이 해제 시도 → 403 `PIN_REQUIRED`, 잠금·암호문 불변).

### 정직한 잔여 사항

- NVIDIA 플러그인 코드와 `NVIDIA_API_KEY` 시크릿 3개는 등록 상태로 남아 있으나, 어떤 선택 경로에서도 도달할 수 없다. 재활성화는 코드 변경과 모델 status 복원이 필요한 의도적 행위다.
- degraded 경로는 FC가 없어 도구 없는 일반 답변만 가능하다.
- 예약 cron 틱 자체의 재관측은 하지 않았다(카나리아와 랭킹 제외로 갈음).
- 번호 주의: 마이그레이션 0064는 이 작업이 사용했으므로, `docs/talorys-patterns-20261029.md`가 계획 카드용으로 예약했던 0064는 후속 작업 시 재번호가 필요하다.
