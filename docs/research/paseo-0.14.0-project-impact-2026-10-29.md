# Paseo 0.14: Auto Compact 영향과 패치 구상

조사·대응일: 2026-10-29. 공개 submodule의 v1.0.2 기반 소스를 검토하고 0.14 검사 환경, native lifecycle 재현, 필요한 패치까지 적용했다. 공식 변경과 고정 소스 링크는 [upstream 조사](paseo-0.14.0-upstream-changes-2026-10-29.md), 실행 증거는 [lifecycle 재현 보고서](paseo-0.14.0-lifecycle-reproduction-2026-10-29.md)에 있다.

## 판단

공개 `/compact` 전송 + Claude Mod 관측 구조를 유지한다. 기존 UI API 제거 또는 env 주입 중단은 발견하지 못했다. 가장 중요한 검증 대상은 플러그인 reload에 따른 자동 세션 reopen이다. 1시간 유휴 런타임 해제도 기존의 사용자 close보다 훨씬 자주 발생할 수 있어 별도 회귀 시나리오가 필요하다.

## 대응 결과

- 0.12/0.13/0.14 SDK 및 native matrix를 추가했다. 최초 대응 checkout에서 세 SDK lane은 각각 136개 검사를 통과했다. 최신 stacked base로 rebase한 PR head는 세 버전·Linux/macOS/Windows SDK lane에서 각각 146개 검사를 통과했고, Linux·Windows native는 버전별 18/18 시나리오를 통과했다.
- reload 직후 Compact now에서 실제 결함을 재현했다. `/compact`는 새 observer launch에서 성공했지만 요청 ID는 이전 launch에 준비되어 operation이 `observing`에 남았다.
- Paseo 0.14처럼 stale plugin session을 reopen하는 host에서는 현재 plugin instance가 observer launch를 소유하는지 확인한다. 소유하지 않으면 manual은 전송 전 실패하고 automatic은 blocked가 되며, 일반 메시지로 reopen한 뒤 정상 실행한다. 0.12/0.13 동작은 유지한다.
- 실제 0.14 idle collector를 clock만 가속해 검사했다. 기존 close/invalidate 경로가 예약을 skip하고, 다음 일반 메시지가 같은 native session을 새 launch로 resume해 새 예약을 만든다. 이 경로에는 제품 수정이 필요하지 않았다.

## 의존 지점별 대조

| 우리 코드 | 의존 계약 | 0.14 영향 |
| --- | --- | --- |
| `index.server.ts`, `server/observer.ts` | `before(agent.session_open)`의 purpose/provider/env, 반환한 request | title/labels/tools/mcpServers 추가. 현재 `...request`, `...request.env`가 새 필드와 타 플러그인 env를 보존하므로 필드 추가 자체는 수정 사유가 아니다. |
| `server/gateway.ts` | `agents.list/ref.refresh`, config/providers, sessionId, usage, lastUserMessageAt | 기존 경로 유지. `refresh()`는 상태 조회여서 stale 세션을 미리 reopen하지 않는다. 새 `reload()`는 다른 의미다. |
| `server/gateway.ts` | `ref.send('/compact', {messageId})`, live timeline의 clientMessageId/turnId/manual compaction | 기존 계약 유지. 전송 앞단에서 stale 세션이 자동 reopen되는 동작이 추가되어 native launch identity 경쟁 가능성이 생긴다. |
| `index.server.ts` | turn/permission/closed/archived lifecycle | cleanup도 `agent.closed` 발행. 기존 invalidate 경로가 연결된다. turn_ended의 빈 timeline은 이미 0.13 대응에 반영했다. |
| `server/observer-source.mjs` | Claude Mod command.run, classic Stop/PreCompact/PostCompact, 모델 요청과 transcript | Paseo 내장 Claude Agent SDK 버전은 동일. 실제 native Claude 업데이트는 별도 축이다. Mod hook 실행은 runtime 검사로 확인해야 한다. |
| `client/conversations.tsx` | composer pill, 설정 화면, legacy UI entry, agent directory subscription | plugin client 소스가 0.13과 동일. `status === closed`이면 pill을 제거하는 현재 정책이 cleanup 후에도 실행될 수 있다. |
| `server/gateway.ts` 복구 | bounded timeline refetch, 메시지·turn 일치와 native receipt | 새 wholeTurns 옵션은 필요하지 않다. 완료된 턴의 UI 접기는 Claude 문맥 압축과 별개다. |

## 우선순위 1: reload 직후 첫 압축

공식 [자동 reopen 계약](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/public-docs/plugins/reference.md#attach-tools-to-agents)과 [prompt 앞단 코드](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/agent-prompt.ts#L119)를 우리 코드에 대입해 세운 다음 가설은 native 실행으로 확인됐다.

1. 플러그인 reload 후 기존 Claude 프로세스의 ledger가 아직 유효하다.
2. gateway가 해당 ledger로 preflight와 observer.prepare를 마친다.
3. 첫 입력 `/compact`를 보낼 때 daemon이 stale 세션을 reopen한다.
4. session_open hook이 예약을 invalidate하고 새 Mod launch를 만든다.
5. gateway가 보관한 기존 launch/generation과 실제 압축을 실행하는 launch가 달라진다.

성공 판정이 native receipt와 command boundary를 모두 요구해 잘못된 성공은 없었지만, 두 증거가 서로 다른 launch에 갈라져 operation이 완료되지 않았다.

검토한 선택지와 결론:

- **재현:** idle 예약 중 plugin reload 뒤 새 사용자 입력 없이 Compact now와 automatic 기한 도달을 각각 검사했다.
- **채택:** observer가 현재 plugin instance에서 만든 launch인지 gateway 전송 직전에 확인한다. stale이면 manual은 `failed_before_dispatch`, automatic은 `blocked`로 남기고 아무것도 보내지 않는다.
- **복구:** 일반 메시지가 Paseo의 정상 reopen을 수행한 뒤 새 ordinary completion으로 예약한다. 그 다음 manual compact는 정확히 한 번 성공한다.
- **제외:** `refresh()`는 reopen하지 않고 `reload()`는 실행 중 턴을 interrupt할 수 있으므로, plugin이 provider를 선제 reload하지 않는다. 0.12/0.13 host에는 새 차단을 적용하지 않는다.

## 우선순위 2: idle cleanup과 resume

공식 cleanup은 `agent.updatedAt` 기준 60분, 우리 예약은 native ordinary end와 캐시 요청 시각을 사용한다. 55분과 60분의 숫자만으로 안전을 보장하지 않는다. [cleanup 구현](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/idle-runtime-cleanup/index.ts).

현재 `agent.closed` hook은 예약을 invalidate하고 gateway는 closed agent를 부적격 처리한다. client도 pill을 제거한다. resume 후 hook이 새 launch를 만들고 ordinary 완료로 새 예약을 생성하는지 검증한다. idle cleanup 전용 reason이 없으므로 일반 closed를 모두 cleanup이라고 표시하지 않는다.

이번 필수 회귀 범위는 cleanup 후 미전송, 같은 persisted session resume 후 새 launch 관측, 새 ordinary 완료 후 예약이다. cleanup 전 정상 압축, 입력·background work 보호와 cleanup/dispatch 경쟁은 더 넓은 후속 경쟁 회귀 후보로 남긴다. cleanup 검사는 upstream 단위의 clock 주입 또는 격리 harness에서 시간을 제어해 수행하고, 실제 1시간 대기 검증과 구분한다. host cleanup 설정이나 사용자의 토큰·50/55분 설정은 변경하지 않는다.

## 적용한 패치 범위

1. SDK 검사를 0.12/0.13/0.14 3종 OS matrix로 확장하고 client/plugin/protocol 버전을 맞췄다. 기본 개발 SDK 0.12와 manifest `>=0.12.0`은 유지했다.
2. simulation CLI 0.14 alias와 lock, runner, matrix, 단일 버전 script, CI artifact 이름과 가이드를 갱신했다.
3. 두 lifecycle 시나리오와 automatic 변형을 test-only harness로 추가하고, 재현된 reload 결함만 제품 코드에서 수정했다.
4. 새 agent tools/MCP 채택, UI import 일괄 이관, 최소 Paseo 버전 상향은 이번 호환 패치에서 제외했다. queue UI가 추가됐다는 이유로 public send 방식도 바꾸지 않았다.

## 검증 경계

공식 릴리스 커밋 소스와 로컬 제품 소스를 대조하고, 격리된 home·daemon·합성 loopback model로 native Claude를 실행했다. lifecycle 재현과 패치 후 확인은 사용자가 지정한 GPT-6.1 Terra (High)가 수행했다. manual reload, 실제 1분 automatic due-dispatch, collector clock을 가속한 cleanup이 통과했다. PR CI에서도 세 Paseo 버전의 Linux·Windows native matrix가 통과했다. cleanup의 실제 1시간 대기, 렌더링된 UI pill, macOS native 0.14, 실제 Anthropic 응답·비용·요약 품질은 확정하지 않는다. 운영 Paseo와 사용자 설정은 변경하지 않았다.
