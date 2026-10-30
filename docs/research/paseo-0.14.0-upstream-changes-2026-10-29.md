# Paseo 0.13.0 → 0.14.0 공식 변경사항 조사

조사일: 2026-10-29. 공식 릴리스와 실제 소스를 기준으로 정리한다. 제품 대응 및 검증 결과와 구분하며, 아래 위험 항목은 별도 실행 검증 전에는 확인된 버그가 아니다.

## 조사 기준

- [v0.14.0 공식 릴리스](https://github.com/getpaseo/paseo/releases/tag/v0.14.0)는 2026-10-29 공개됐고 릴리스 커밋은 [8c6de842a3157530c26a7a94c78a3d647fb96ce9](https://github.com/getpaseo/paseo/commit/8c6de842a3157530c26a7a94c78a3d647fb96ce9)이다.
- 이전 정식 기준은 0.13.0의 `d34d17a9072149320ace35ec2a2e5c7dcd992cb3`. [공식 비교](https://github.com/getpaseo/paseo/compare/v0.13.0...v0.14.0) API는 89 commits를 반환한다. GitHub compare 파일 목록은 300개로 잘리므로 전체 변경 확인은 두 소스 트리를 직접 비교했다.
- 릴리스 커밋 tarball을 `.scratch/paseo-0140-upstream/paseo-0.14.0/`에 풀어 기존 `.scratch/paseo-0130-upstream/paseo-0.13.0/`와 대조했다. 이 문서의 소스 링크는 릴리스 커밋으로 고정한다.

## 주요 제품 변화

| 영역 | 0.14.0 변화 |
| --- | --- |
| 플러그인 | agent별 도구 부착, 세션 시작 시 launch 전용 MCP 서버 주입 |
| 채팅 | 완료한 턴 접기·요약 및 도구 호출 그룹화 설정, 숨겨진 채팅의 텍스트 렌더링 중단 |
| 입력 | Enter 또는 Ctrl/⌘+Enter 전송 선택, 빈 Composer에서 위·아래로 보낸 메시지 재호출, Send 길게 눌러 queue 또는 즉시 전송 |
| 런타임 | 조건을 충족한 idle agent runtime을 1시간 후 해제하고 다음 프롬프트에서 저장된 대화 재개 |
| 음성 | 기본 off로 변경, 로컬 음성 모델 다운로드 및 SenseVoice·Whisper 중국어 지원 |
| 성능 | 큰 Claude·OMP 이력, 플러그인 빌드, 이미지 처리, 설정 reload와 파일시스템 작업의 daemon stall 완화 |
| 기타 | 프로젝트별 외부 editor, 모바일 subagent 이동, Windows atomic save의 일시적 파일 lock 복구 등 |

근거: [고정 CHANGELOG](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/CHANGELOG.md#0140---2026-10-29). Pi 수동 압축 중 입력 처리 수정은 **Pi provider**에 대한 항목이며 Claude 압축 계약의 변경으로 해석하지 않는다.

## 가장 중요한 동작 변화: 1시간 idle runtime cleanup

기본값은 on이며 `agents.idleRuntimeCleanup: false`로 host 전체 opt-out이 가능하다. 일정 간격은 60초, idle 기준은 60분이다. 기준 시각은 runtime candidate의 `lastActivityAt`, agent manager에서는 `agent.updatedAt`이다. 따라서 플러그인의 마지막 실제 모델 요청 시각이나 캐시 TTL과 같은 시계라고 가정하면 안 된다. [설정](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/config.ts#L679), [cleanup 구현](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/idle-runtime-cleanup/index.ts#L32), [candidate 구성](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/agent-manager.ts#L1846).

아무 대화나 무조건 중단하지 않는다. 저장된 sessionId가 있어야 하고, agent가 idle이며 foreground turn·run·permission·session event·running subagent 등의 pending work가 없어야 한다. family 전체의 eligibility와 provider safety probe를 확인한 뒤 close 직전에 다시 검사한다. provider가 거부한 시각에서 새 유예를 둔다. [eligibility](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/agent-manager.ts#L1887), [family 및 probe](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/idle-runtime-cleanup/index.ts#L47).

Claude는 foreground/autonomous turn, 미시작 message UUID, permission, SDK message 처리 여부를 검사하고 background task roster도 확인한다. Claude Code 2.1.292 이상은 roster 지원을 알려진 것으로 취급하고, 더 오래된 버전은 roster 메시지로 지원을 증명할 수 있다. 실행 중 background task와 도착을 기다리는 완료 notification이 모두 없어야 한다. [Claude canStopRuntime](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/providers/claude/agent.ts#L2951), [runtime safety](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/providers/claude/runtime-safety.ts).

close는 provider session을 종료하고 저장한 snapshot의 lifecycle을 `closed`로 바꾸며 `agent.closed`를 발행한다. 이 이벤트에는 idle cleanup이라는 별도 reason이 없다. archive/delete가 아니며 다음 prompt에서 저장된 대화를 resume하는 동작이다. [closeAgentRuntime](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/agent-manager.ts#L1920), [prepareAgentForClosure·emitClosedAgent](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/agent-manager.ts#L4007), [공식 릴리스](https://github.com/getpaseo/paseo/releases/tag/v0.14.0).

**우리 플러그인의 검증 과제:** 55분 자동 압축은 통상 60분보다 앞서지만 두 기능의 시계가 달라 충돌이 없다는 보장은 아니다. cleanup→`agent.closed`에서 countdown·준비된 observer·in-flight 전송 상태가 어떻게 정리되는지, resume 후 같은 대화의 새로운 launch를 정확히 추적하는지 검사해야 한다. host 설정을 플러그인이 임의로 off로 바꾸는 대응은 필요성이 입증되지 않았다.

## session_open 플러그인 reload 시 자동 세션 reopen

이 변화는 새 tools API를 쓰지 않는 env 주입 플러그인에도 중요하다. `agent.session_open`을 선언한 플러그인의 start/stop/reload는 open session을 stale로 표시한다. running turn은 지속하고, 다음 idle prompt 전에 세션을 reopen해 hook을 다시 실행한다. `paseo.agents.ref(id).reload()`는 즉시 reopen하며 실행 중 turn을 interrupt한다. 기존 `.refresh()`는 snapshot 조회다. [공식 세션 reopen 표](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/public-docs/plugins/reference.md#attach-tools-to-agents), [generation 검사](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/agent-manager.ts#L904), [client reload](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/client/src/index.ts#L372).

**우리 플러그인의 검증 과제:** reload 직후 첫 전송이 자동 `/compact`라면, gateway가 preflight에서 확보한 observer 이후에 전송 내부의 reopen이 `agent.session_open(reason: "refresh")`를 일으킬 수 있다. 우리 hook의 scheduler invalidate·새 observer launch/generation 생성이 전송 시도와 교차하는지 검사해야 한다. 이는 현재 코드 경로에서 도출한 위험이며 **실행으로 확인된 오동작은 아니다**. 강제 `.reload()`는 running turn interrupt 계약이므로 단순 호환 패치에서 무조건 호출할 API가 아니다.

## 추가된 API와 기존 계약

| 계약 | 확인 결과 |
| --- | --- |
| `PluginSessionOpenRequest` | `title`, `labels` readonly 추가. `tools: AgentToolDefinition[]`, `mcpServers` 편집 가능 필드 추가. 기존 `env` 유지. |
| 도구 | `defineAgentTool` 추가. input Zod schema와 execute callback으로 정의하고 세션 hook의 tools에 부착. 이름은 소문자 시작, 소문자·숫자·underscore, 최대 64자. |
| MCP 주입 | launch 전용으로 매번 재계산. 저장 config의 MCP나 내부 Paseo 서버·다른 플러그인 이름과 충돌하면 open 실패. `purpose: "interactive"`에서 적용. |
| hook 반환 | 변경하지 않는 필드까지 `...request`로 보존해야 한다. `env`는 누적되지만 tools/MCP는 플러그인별로 관리된다. |
| provider | optional `session.can_stop_runtime` capability 및 요청/응답 추가. 일반 env 주입 플러그인이 provider를 구현할 필요는 없다. |
| UI SDK | `packages/plugin/src/client/` 전체가 0.13과 동일. client slot 계약 변경을 발견하지 못했다. host chat 렌더링 변화는 별도 UI 검증 필요. |
| timeline | `wholeTurns` 선택 옵션 및 `wholeTurnTimeline` feature gate 추가. capability가 없는 구 host에는 새 필드를 보내지 않는다. 기존 item paging 계약 유지. |
| `agent.turn_ended.timeline` | 0.13과 같이 `[]`; 새로운 regression이 아니라 기존 deprecated 계약 유지. |
| SDK package | plugin의 client·protocol peer가 모두 정확히 0.14.0. SDK를 올리면 세 패키지를 함께 맞춰야 한다. |

근거: [lifecycle 타입](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/plugin/src/server/lifecycle.ts#L33), [도구 타입](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/plugin/src/server/agent-tools.ts), [MCP merge·충돌 검사](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/agent-manager.ts#L5596), [MCP 문서](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/public-docs/plugins/reference.md#inject-mcp-servers), [provider capability](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/plugin/src/server/provider.ts), [UI 소스](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/plugin/src/client), [timeline client gate](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/client/src/daemon-client.ts#L3553), [turn publish](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/plugins/lifecycle/index.ts#L138), [plugin package](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/plugin/package.json).

## Claude Mod와 압축 경로

Paseo의 `@anthropic-ai/claude-agent-sdk` 의존성은 0.13과 0.14 모두 **0.3.246**이다. Paseo 업데이트만으로 native Claude Code 또는 Mod 규격이 변경됐다고 단정하지 않는다. launch context env 주입도 유지하며, live `compacting`·`compact_boundary`의 timeline 및 사용량 처리는 남아 있다. 이력 로드·경로 탐색을 async로 바꾼 부분과 runtime safety 검사가 추가됐다. [server dependency](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/package.json#L108), [provider launch env](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/providers/claude/agent.ts#L1613), [압축 이벤트](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/providers/claude/agent.ts#L4727).

릴리스는 선택 설치하는 Claude Code entrypoint 플러그인으로 `CLAUDE_CODE_ENTRYPOINT=Paseo`를 넣는 community workaround를 소개한다. 이는 내장 기본 동작이나 캐시 TTL 보장이 아니다. 우리 env 주입과 함께 사용할 때 서로의 env를 보존하는지 확인할 항목이며, token 계산·기본 TTL을 이 근거로 바꾸면 안 된다. [공식 릴리스 Notes](https://github.com/getpaseo/paseo/releases/tag/v0.14.0), [관련 PR #7976](https://github.com/getpaseo/paseo/pull/7976), [#8164](https://github.com/getpaseo/paseo/pull/8164).

## 대응 우선순위 제안

1. 기존 public send + native Mod 관측 방식을 유지하고 0.14 runtime matrix부터 추가한다. 새 MCP/tool API로 압축을 다시 구현할 근거는 없다.
2. `agent.closed` cleanup→resume와 plugin reload→첫 `/compact` 자동 reopen을 집중 검증한다. launch·session identity가 바뀌면 이전 완료를 성공으로 귀속하지 않아야 한다.
3. composer queue/즉시 전송과 숨겨진 채팅·접힌 턴 상태에서도 countdown·수동 compact·대화별 toggle 및 입력 경쟁 취소가 일관되는지 확인한다.
4. 새 API를 실제 채택할 때 SDK 3종을 함께 올리고, 0.12·0.13 유지 여부와 minVersion을 따로 결정한다. compatibility 확인만을 위해 minimum 0.14를 강제할 필요성은 아직 없다.
5. host idle cleanup 비활성화, 기본 55분 변경, entrypoint env 강제 주입은 기본 패치에 포함하지 않는다. 현재 발견한 위험에 대한 실행 증거를 먼저 확보한다.
