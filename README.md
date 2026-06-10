# SeniBot Cloud

독거노인을 위한 24시간 자동 돌봄 IoT 시스템 '시니봇(SeniBot)'의 AWS 클라우드 버전입니다.

어르신은 가정에 설치된 센서와 웨어러블만 착용하면 되고, 보호자는 원격에서 대시보드로 상태를 모니터링합니다. 온도·습도·심박수 등에서 위험이 자동으로 감지되면 보호자에게 즉시 알림이 전송됩니다.

이 프로젝트는 이전 단계인 On-Premise 구현([senibot-onpremise](https://github.com/davinida/senibot-onpremise))을 AWS 클라우드 환경으로 이전한 구현체입니다.

## 아키텍처

AWS 관리형 서비스 기반의 서버리스 구조입니다. 데이터는 두 갈래(환경 / 생체)로 수집되어 RDS에 저장되고, 임계값을 벗어나면 보호자에게 알림이 발송됩니다.

아래는 실제 구현된 시스템 아키텍처입니다.

![SeniBot Cloud 아키텍처](docs/architecture.png)

다음은 위 구조의 텍스트 요약입니다.

```
[ 환경 데이터 ]
  Raspberry Pi 4 + DHT11
        |  온습도 측정 → MQTT 발행
        v
  AWS IoT Core → IoT Rule → Lambda (env-processor) → RDS (sensor_data)

[ 생체 데이터 ]
  EventBridge (주기 트리거)
        |
        v
  Lambda (fitbit-collector) → Google Health API (← Fitbit Charge 5 측정값)
        |  최신 생체값 수신
        v
  RDS (fitbit_data)

[ 알림 (두 Lambda 공통) ]
  임계값 초과 판정 → Amazon SNS → 보호자 이메일
                  (+ alerts 테이블에 발화 기록)
```

## 기술 스택

| 구분 | 사용 기술 |
|------|-----------|
| 수집(엣지) | Raspberry Pi 4 + DHT11, Fitbit Charge 5 |
| 데이터 연동 | AWS IoT Core(MQTT), Google Health API |
| 처리 | AWS Lambda (Node.js 22), Amazon EventBridge |
| 저장 | Amazon RDS (PostgreSQL) |
| 알림 | Amazon SNS (이메일) |
| 조회 API | Amazon API Gateway (예정) |

## 구현 현황

- [x] RDS PostgreSQL 구축 및 스키마 적용
- [x] 환경 데이터 수집 파이프라인 (IoT Core → Lambda → RDS)
- [x] 생체 데이터 수집 (Google Health API 실연동 → Lambda → RDS)
- [x] 임계값 기반 보호자 알림 (SNS 이메일)
- [ ] 조회 REST API (API Gateway + Lambda)
- [ ] 보호자 대시보드

## 디렉터리 구조

```
senibot-cloud/
├── database/                 # RDS 스키마(schema.sql), 시드 데이터(seed.sql)
├── lambda/
│   ├── env-processor/        # 환경 데이터 처리 (IoT Core → RDS) + 알림 평가
│   ├── fitbit-collector/     # 생체 데이터 수집 (Google Health API → RDS) + 알림 평가
│   ├── shared/               # 공용 모듈 (alert-engine.js: 임계값 알림 엔진)
│   ├── api-handler/          # 조회 REST API (예정)
│   └── auth-handler/         # 인증 연동 (예정)
├── raspberry-pi/             # 엣지 코드 (DHT11 측정 → MQTT 발행)
├── dashboard/                # 보호자 웹 대시보드 (예정)
├── infra/                    # AWS 리소스 설정 정의 및 메모
└── docs/                     # 설계 문서 (implementation-plan.md 등)
```

## 주요 기능

### 임계값 기반 보호자 알림

환경/생체 데이터를 규칙 기반으로 평가하여 위험 상황을 감지합니다. 임계값은 환경변수로 조정할 수 있으며, 기본값은 다음과 같습니다.

| 종류 | 조건(기본값) | 수준 |
|------|------|------|
| 실내 온도 | 35°C 초과 / 10°C 미만 | WARNING |
| 실내 습도 | 80% 초과 / 20% 미만 | INFO |
| 안정 시 심박수 | 100 bpm 초과 / 45 bpm 미만 | WARNING |
| 활동량(걸음수) | 평소 대비 현저히 낮음 | INFO |

알림 메시지는 보호자 관점의 한국어로 작성됩니다 (예: "어머니 댁 실내 온도가 위험 수준입니다 ... 안부 확인을 권장합니다."). 발송은 Amazon SNS 이메일로 이루어지며, 동시에 `alerts` 테이블에 발화 이력이 기록됩니다.

### 디바운싱 (중복 알림 방지)

같은 종류의 알림이 짧은 시간(기본 5분) 안에 반복 발생하면 한 번만 발송합니다. `alerts` 테이블 조회로 직전 발화 시각을 확인하여, 동일한 경보가 보호자에게 반복 전송되는 것을 방지합니다.

### 생체 데이터 중복 저장 방지

주기적으로 실행되는 생체 수집 Lambda가 같은 측정 시각의 데이터를 중복 저장하지 않도록, 직전 저장값의 측정 시각과 비교해 동일하면 저장을 건너뜁니다.

## 환경 변수 / 보안

이 저장소는 공개되어 있어 **자격증명과 접속 정보를 일절 포함하지 않습니다.** 모든 민감정보는 코드에 하드코딩하지 않고 다음 방식으로 관리합니다.

- DB 접속 정보, Google OAuth 자격증명, SNS 토픽 식별자 등은 **Lambda 환경변수**(또는 AWS Secrets Manager)로 주입합니다.
- IoT 디바이스 인증서·키, `.env` 파일은 저장소에 커밋하지 않습니다(`.gitignore` 처리).
- AWS 리소스(IoT Rule, SNS 토픽, IAM 권한 등)는 **AWS 콘솔에서 설정**합니다.
