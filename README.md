# SeniBot Cloud

독거노인을 위한 자동 돌봄 IoT 시스템 '시니봇(SeniBot)'을 AWS 클라우드 기반으로 구현한 프로젝트입니다.

이 프로젝트는 이전 단계인 On-Premise 구현([senibot-onpremise](https://github.com/davinida/senibot-onpremise))을 AWS 클라우드 환경으로 전환한 구현체입니다.

## 시스템 개요

4-Layer 구조(수집 / 처리 / 저장 / 서비스)를 AWS 서비스로 구현합니다.

| Layer | 역할 | 사용 기술 |
|-------|------|-----------|
| 수집 | 센서 및 생체 데이터 수집 | Raspberry Pi + DHT11 → AWS IoT Core, Fitbit → Google Health API |
| 처리 | 데이터 가공 및 비즈니스 로직 | AWS Lambda (서버리스 함수) |
| 저장 | 데이터 영속화 | Amazon RDS (PostgreSQL) |
| 서비스 | API 제공, 대시보드, 알림, 인증 | Amazon API Gateway (RESTful API), S3 대시보드, Amazon SNS 알림, Amazon Cognito 인증 |

## 데이터 흐름

라즈베리파이가 측정한 환경 센서 데이터가 AWS IoT Core를 거쳐 RDS에 저장됩니다.

```
[Raspberry Pi + DHT11]
      |  온습도 측정
      v
  MQTT 발행   topic: senibot/{deviceId}/sensor/dht11
      |
      v
[AWS IoT Core]              X.509 인증서/정책으로 디바이스 인증
      |
      v
[IoT Rule]                 메시지를 Lambda로 라우팅
      |
      v
[AWS Lambda]               device_id -> senior_id 매핑 후 저장
      |
      v
[Amazon RDS / PostgreSQL]  sensor_data 테이블에 INSERT
```

## 폴더 구조

| 폴더 | 역할 |
|------|------|
| `raspberry-pi/` | 센서를 읽어 AWS IoT Core로 발행하는 엣지 코드 |
| `lambda/env-processor/` | 환경 데이터(온습도) 처리 함수 (IoT Core → RDS) |
| `lambda/fitbit-collector/` | Fitbit 생체 데이터 수집 함수 |
| `lambda/alert-sender/` | 이상 상황 알림 발송 함수 |
| `lambda/api-handler/` | 대시보드 API 요청 처리 함수 |
| `lambda/auth-handler/` | Cognito 인증 연동 함수 |
| `database/` | RDS 스키마 및 시드 SQL |
| `dashboard/` | 보호자용 웹 대시보드 (정적 파일) |
| `infra/` | IoT Rule, API Gateway 등 AWS 설정 정의 및 메모 |
| `docs/` | 설계 문서 및 아키텍처 자료 |

## 빌드 / 실행 방법

### 데이터베이스 (`database/`)

1. `database/.env.example`를 복사해 `database/.env`를 만들고 RDS 접속 정보를 입력합니다.
2. `schema.sql`로 테이블·인덱스를 생성하고, `seed.sql`로 초기 데이터를 적재합니다.

### Lambda 함수 (`lambda/env-processor/`)

1. 폴더에서 `npm install`로 의존성(`pg`)을 설치합니다.
2. 폴더 내용을 zip으로 묶어 Lambda에 업로드합니다.
3. 런타임 Node.js 22.x, 핸들러 `index.handler`, 환경변수로 DB 접속 정보를 설정합니다.

> 민감정보(RDS 엔드포인트, 비밀번호, AWS 자격증명, 디바이스 인증서 등)는 저장소에 커밋하지 않으며, `.env`와 AWS Secrets Manager로 관리합니다.
