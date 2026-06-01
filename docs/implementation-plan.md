# SeniBot Cloud 구현 계획서

본 문서는 SeniBot Cloud 프로젝트의 모든 구현 단계에 대한 기준 문서이다. 설계 변경이나 의사결정이 있을 때마다 본 문서를 갱신한다.

## 1. 프로젝트 개요

- 독거노인을 위한 자동 돌봄 IoT 시스템 시니봇(SeniBot)을 AWS 클라우드 기반으로 구현한다.
- 이전 단계인 On-Premise 구현(senibot-onpremise)을 AWS 클라우드 환경으로 전환한 구현체이다.
- 4-Layer 구조(수집 / 처리 / 저장 / 서비스)를 AWS 관리형 서비스로 구현한다.

## 2. 사용할 AWS 서비스 및 리전

- 리전: `ap-northeast-2` (서울). 모든 리소스는 이 리전에 생성한다.

| 서비스 | 역할 |
|--------|------|
| AWS IoT Core | 라즈베리파이 환경 센서 데이터 수신 (MQTT) |
| AWS Lambda | 서버리스 처리 함수 5종 (env-processor, fitbit-collector, alert-sender, api-handler, auth-handler) |
| Amazon RDS | PostgreSQL, 데이터 저장 |
| Amazon API Gateway | RESTful API |
| Amazon SNS | 보호자 알림 (실제 SMS, 본인 번호 등록 방식. 막히면 이메일 폴백) |
| Amazon S3 | 대시보드 정적 호스팅 (개발 마지막 단계에 업로드) |
| Amazon Cognito | 보호자 인증 |
| AWS Secrets Manager | OAuth 토큰, DB 자격증명 보관 |

## 3. 데이터 흐름 (두 경로)

### 경로 A: 환경 데이터 (우선 구현)

```
Raspberry Pi + DHT11
  → IoT Core (MQTT)
  → IoT Rule
  → Lambda(env-processor)
  → RDS
  → (알림 조건 충족 시) Lambda(alert-sender) → SNS
```

### 경로 B: 생체 데이터

```
EventBridge (1분 주기)
  → Lambda(fitbit-collector)
  → Google Health API 호출
  → RDS
```

- Google Health API 실연동을 1차 목표로 한다.
- 인증/연동에서 막히는 경우, On-Premise의 시뮬레이터 로직을 Lambda로 이식하는 방식으로 폴백한다.

### 경로 B 증빙 방침

- 실연동 성공 여부와 무관하게, 본인 Fitbit Charge 5의 실제 측정값(안정 시 심박수, 걸음수, 수면 점수, SpO2)을 데이터 근거로 사용한다.
- 본인 Charge 5 앱 화면 캡처를 보고서와 시연 영상에 포함하여 'Fitbit 밴드 사용' 요구사항을 충족하고 증빙한다.

## 4. 구현 순서 (단계별)

| 단계 | 내용 |
|------|------|
| 2단계 | RDS PostgreSQL 구축 + 스키마 생성 (seniors, guardians, sensor_data, fitbit_data, alerts) |
| 3단계 | 환경 데이터 경로 (라즈베리파이 → IoT Core → Lambda → RDS) |
| 4단계 | 생체 데이터 경로 + 알림(SNS) |
| 5단계 | API Gateway + 대시보드 (로컬 개발 후 마지막에 S3 업로드) |
| 6단계 | 통합 테스트 + 보고서 / PPT / 시연영상 |

## 5. 운영 규칙

- RDS는 비용 절감을 위해 작업할 때만 시작(start)하고 작업 종료 시 중지(stop)한다. 매 작업 세션 시작 시 RDS 인스턴스 시작을 잊지 말 것.
- AWS 자격증명, OAuth 토큰, DB 비밀번호 등 민감정보는 절대 git에 커밋하지 않는다. `.env`와 Secrets Manager로 관리한다.
- 모든 리소스는 `ap-northeast-2` 리전에 생성한다.

## 6. On-Premise에서 계승하는 자산

- 알림 판정 임계값 및 보호자 친화적 한국어 메시지 (TEMP_HIGH 등 7종)
- DB 스키마 개념 (sensor_data, fitbit_data, alerts)
- 대시보드 UI (HTML/CSS) 디자인
- MQTT 토픽 / 메시지 형식 (`senibot/{deviceId}/sensor/dht11`, JSON 페이로드)

## 7. 제출물 요구사항 체크리스트 (6단계에서 확인)

### 보고서

- 표지
- 명예서약서
- 요약 페이지 (1~2p): 구현한 모든 기능을 빠짐없이 나열한다. 요약에 없는 내용은 평가에서 제외되므로 누락에 특히 주의한다.
- 목차
- 본문: 최종 설계, 소스코드 설명, 작동 / 미작동 서비스 구분, 화면 캡처
- 결론: 조원 각자가 느낀점 · 배운점 · 아쉬운점을 개별 작성

### 기타 제출물

- PPT는 PDF로 변환하여 제출
- 소스코드 zip 포함
- 시연 동영상 유튜브 링크 포함
