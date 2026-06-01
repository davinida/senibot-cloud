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

## 폴더 구조

| 폴더 | 역할 |
|------|------|
| `raspberry-pi/` | 센서를 읽어 AWS IoT Core로 발행하는 엣지 코드 |
| `lambda/` | AWS Lambda 함수 모음 (함수별 하위 폴더) |
| `lambda/env-processor/` | 환경 데이터(온습도 등) 처리 함수 |
| `lambda/fitbit-collector/` | Fitbit 생체 데이터 수집 함수 |
| `lambda/alert-sender/` | 이상 상황 알림 발송 함수 |
| `lambda/api-handler/` | 대시보드 API 요청 처리 함수 |
| `lambda/auth-handler/` | Cognito 인증 연동 함수 |
| `database/` | Amazon RDS 스키마 SQL 파일 |
| `dashboard/` | 보호자용 웹 대시보드 (정적 파일) |
| `infra/` | IoT Rule, API Gateway 등 AWS 설정 정의 및 메모 |
| `docs/` | 설계 문서 및 아키텍처 자료 |

## 빌드 / 실행 방법

구현 진행 중입니다. (코드 작성 단계가 시작되면 본 항목을 업데이트할 예정입니다.)
