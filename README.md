# antigravity-compaction-guard

Google Antigravity의 장기 세션 자동압축으로 인한 **“압축 치매(제약조건 망각·재탐색 루프)”**를 방지하는 무의존성 `PreInvocation` 훅 + 3계층 컨텍스트 방어 도구입니다.

> A zero-dependency `PreInvocation` hook and 3-tier context discipline kit for Google Antigravity that mitigates context-compaction amnesia via pre-compaction backups, post-compaction disk re-injection, and deterministic transcript breadcrumbs.

---

## 왜 필요한가? (Why `antigravity-compaction-guard`?)

Antigravity는 긴 세션에서 약 **256k / 512k 토큰** 구간에 도달하면 자동으로 과거 대화를 요약(`CHECKPOINT`)합니다. 하지만 LLM 기반 요약 압축은 본질적으로 손실이 발생해 다음 문제가 잦습니다:

- **부정·부가 제약조건 누락** (*“이 파일/ID는 건드리지 마”*, *“배포 전 검증 필수”* 등)
- **세부 작업 맥락 상실** → 압축 직후 이미 확인한 파일을 다시 뒤지는 재탐색 루프
- **SessionStart 훅 희석** → 대화 시작 시 주입했던 장기 메모리 스냅샷이 중반 압축에서 함께 요약·소실

### 이 도구가 해결하는 방식

| 시점 | 동작 | 효과 |
| --- | --- | --- |
| **평소 턴** | 아무것도 주입하지 않음 (`{}`) | **토큰 오버헤드 0**, 대용량(7 MB+) 트랜스크립트 기준 ~50 ms |
| **압축 임박 (200k / 430k, 각 1회)** | 아티팩트 `session_state.md` 덮어쓰기 백업(1~2 KB) + 선택 `/compact` 안내 | 압축 직전에 진행 상태·제약조건·남은 할 일을 디스크에 고정 |
| **압축 직후 (`CHECKPOINT` 직후 1회)** | ① `session_state.md` 복원 ② `transcript.jsonl`에서 **최근 사용자 요청 3건·수정 파일·참조 파일·최근 명령(Breadcrumbs)** 결정적 추출 ③ (선택) `memory` MCP 스냅샷 재주입 | 급격한 토큰 점프로 `session_state.md`를 못 썼더라도 직전 작업 흔적을 100% 복원 |
| **3계층 규칙 (`GEMINI.md`)** | 불변 규칙(`GEMINI.md` <4 KB) / 세션 상태(`session_state.md`) / 장기 기억(`memory` MCP) 분리 + 넓은 탐색은 `research` 서브에이전트 위임 | `GEMINI.md` 비대화(24 KB 절단) 방지 및 메인 세션 압축 빈도 감소 |

### 실전 방어 디테일
- **서브에이전트 오발동 차단**: `USER_EXPLICIT`가 있는 실제 사용자 대화에서만 동작하며, 브라우저 서브에이전트의 `# Browser Session Checkpoint`는 무시합니다.
- **민감 정보 마스킹**: Breadcrumbs 추출 시 `Bearer`, `token=`, `password=`, `api_key=` 패턴을 자동 마스킹합니다.
- **Antigravity 런타임 호환성**: `utils.scrubMessage` Go 패닉을 유발하는 `metadata.user_markdown` 없이 안전한 순수 `systemMessage`만 사용하며, 오류 시에도 대화를 절대 차단하지 않습니다(`{}` 반환).
- **재시작 불필요**: Antigravity는 `hooks.json`을 실시간 핫로드합니다.

---

## 원터치 설치 (Node.js 18+만 필요, 외부 패키지 0개)

### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/servaltullius/antigravity-compaction-guard/main/install.ps1 | iex
```

### macOS / Linux (Bash)
```bash
curl -fsSL https://raw.githubusercontent.com/servaltullius/antigravity-compaction-guard/main/install.sh | bash
```

### 오프라인 / 수동 설치
```bat
git clone https://github.com/servaltullius/antigravity-compaction-guard.git
cd antigravity-compaction-guard
install.bat
```

---

## 원터치 제거

### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/servaltullius/antigravity-compaction-guard/main/uninstall.ps1 | iex
```

### macOS / Linux (Bash)
```bash
curl -fsSL https://raw.githubusercontent.com/servaltullius/antigravity-compaction-guard/main/uninstall.sh | bash
```

---

## 설치되는 파일 및 변경 위치
- 훅 스크립트: `~/.gemini/hooks/compaction-guard-hook.mjs`
- 훅 설정: `~/.gemini/config/hooks.json` (기존 파일 자동 `.bak-*` 백업 후 `compaction-guard` 항목만 안전 병합)
- 전역 규칙: `~/.gemini/GEMINI.md` (`<!-- compaction-guard:start/end -->` 마커 블록만 추가, `-SkipRule` / `AGY_SKIP_RULE=1`로 생략 가능)
- 대화별 상태 캐시: `~/.gemini/memory/hook-state/` (30일 경과 파일 자동 정리)

## 선택 환경변수
| 변수명 | 기본값 | 설명 |
| --- | --- | --- |
| `AGY_COMPACT_WARN_1` | `200000` | 1차 사전 백업 알림 임계 토큰 |
| `AGY_COMPACT_WARN_2` | `430000` | 2차 사전 백업 알림 임계 토큰 |
| `AGY_SESSION_RECALL_SCRIPT` | `~/.gemini/memory-mcp/session-recall-hook.mjs` | 압축 직후 함께 재주입할 메모리 스냅샷 훅 경로 (없으면 자동 생략) |
| `AGY_COMPACT_STATE_DIR` | `~/.gemini/memory/hook-state` | 대화별 훅 상태 저장 디렉터리 |
