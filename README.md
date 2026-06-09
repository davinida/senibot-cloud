# SeniBot Cloud

독거노인을 위한 자동 돌봄 IoT 시스템 '시니봇(SeniBot)'을 AWS 클라우드 기반으로 구현한 프로젝트입니다.

이 프로젝트는 이전 단계인 On-Premise 구현([senibot-onpremise](https://github.com/davinida/senibot-onpremise))을 AWS 클라우드 환경으로 전환한 구현체입니다.

## 구현 진행 상황

| 단계 | 내용 | 상태 |
|------|------|------|
| 0 | 프로젝트 구조 및 GitHub 설정 | ✅ 완료 |
| 1 | 구현 계획 수립 | ✅ 완료 |
| 2 | RDS PostgreSQL 구축 + 스키마 | ✅ 완료 |
| 3 | 환경 데이터 경로 (라즈베리파이 → IoT Core → Lambda → RDS) | ✅ 완료 |
| 4 | 생체 데이터 경로 + 알림 | 예정 |
| 5 | API Gateway + 대시보드 | 예정 |
| 6 | 통합 테스트 및 문서화 | 예정 |

현재까지 구축된 AWS 리소스:

- **Amazon RDS (PostgreSQL)** — 5개 테이블 스키마 적용 (`seniors`, `guardians`, `sensor_data`, `fitbit_data`, `alerts`)
- **AWS IoT Core** — 사물(Thing) `senibot-pi-001`, X.509 디바이스 인증서 및 정책
- **IoT Rule** — `senibot_env_rule` (센서 메시지를 Lambda로 라우팅)
- **AWS Lambda** — `senibot-env-processor` (환경 데이터 처리·저장)

3단계까지 완료되어, 실제 센서 데이터가 라즈베리파이에서 RDS까지 자동으로 적재되는 것을 검증했습니다.

## 시스템 개요

4-Layer 구조(수집 / 처리 / 저장 / 서비스)를 AWS 서비스로 구현합니다.

| Layer | 역할 | 사용 기술 |
|-------|------|-----------|
| 수집 | 센서 및 생체 데이터 수집 | Raspberry Pi + DHT11 → AWS IoT Core, Fitbit → Google Health API |
| 처리 | 데이터 가공 및 비즈니스 로직 | AWS Lambda (서버리스 함수) |
| 저장 | 데이터 영속화 | Amazon RDS (PostgreSQL) |
| 서비스 | API 제공, 대시보드, 알림, 인증 | Amazon API Gateway (RESTful API), S3 대시보드, Amazon SNS 알림, Amazon Cognito 인증 |

## 데이터 흐름 (현재 구현된 환경 데이터 경로)

```
[Raspberry Pi + DHT11]
      |  온습도 측정 (주기적)
      v
  MQTT 발행   topic: senibot/{deviceId}/sensor/dht11
      |
      v
[AWS IoT Core]                  사물 senibot-pi-001 · X.509 인증서/정책으로 인증
      |
      v
[IoT Rule: senibot_env_rule]    메시지를 Lambda로 라우팅 (device_id 포함)
      |
      v
[Lambda: senibot-env-processor] device_id -> senior_id 조회 후 저장
      |
      v
[Amazon RDS / PostgreSQL]       sensor_data 테이블에 INSERT
```

## 폴더 구조

| 폴더 | 역할 | 상태 |
|------|------|------|
| `raspberry-pi/` | DHT11 센서 측정 → IoT Core로 MQTT 발행하는 엣지 코드 | 디바이스에서 운영 중 (저장소 반영 예정) |
| `lambda/env-processor/` | 환경 데이터 처리 함수 (IoT Core → RDS) | ✅ 구현 완료 |
| `lambda/fitbit-collector/` | Fitbit 생체 데이터 수집 함수 | 예정 (4단계) |
| `lambda/alert-sender/` | 이상 상황 알림 발송 함수 | 예정 (4단계) |
| `lambda/api-handler/` | 대시보드 API 요청 처리 함수 | 예정 (5단계) |
| `lambda/auth-handler/` | Cognito 인증 연동 함수 | 예정 (5단계) |
| `database/` | RDS 스키마 및 시드 SQL (`schema.sql`, `seed.sql`) | ✅ 구현 완료 |
| `dashboard/` | 보호자용 웹 대시보드 (정적 파일) | 예정 (5단계) |
| `infra/` | IoT Rule, API Gateway 등 AWS 설정 정의 및 메모 | 예정 |
| `docs/` | 설계 문서 및 아키텍처 (`implementation-plan.md`) | 작성 중 |

## 빌드 / 실행 방법

### 데이터베이스 (`database/`)

1. `database/.env.example`를 복사해 `database/.env`를 만들고 RDS 접속 정보를 입력합니다.
2. `schema.sql`로 테이블·인덱스를 생성하고, `seed.sql`로 초기 데이터를 적재합니다.

### Lambda 함수 (`lambda/env-processor/`)

1. 폴더에서 `npm install`로 의존성(`pg`)을 설치합니다.
2. 폴더 내용을 zip으로 묶어 Lambda에 업로드합니다.
3. 런타임 Node.js 22.x, 핸들러 `index.handler`, 환경변수로 DB 접속 정보를 설정합니다.

> 민감정보(RDS 엔드포인트, 비밀번호, AWS 자격증명, 디바이스 인증서 등)는 저장소에 커밋하지 않으며, `.env`와 AWS Secrets Manager로 관리합니다.

4단계 이후 항목은 구현이 진행되는 대로 업데이트할 예정입니다.
