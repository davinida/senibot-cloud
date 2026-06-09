-- =============================================================
-- SeniBot Cloud - RDS PostgreSQL 스키마
-- 기준 문서: docs/implementation-plan.md (6장 DB 스키마 설계)
--
-- 적용 방법(다음 단계): RDS 접속 정보 설정 후
--   psql "$DATABASE_URL" -f database/schema.sql
-- 모든 객체는 IF NOT EXISTS 로 작성되어 반복 실행해도 안전하다.
-- =============================================================

-- 어르신 정보 (돌봄 대상자)
CREATE TABLE IF NOT EXISTS seniors (
    senior_id   SERIAL PRIMARY KEY,
    name        VARCHAR(50),
    device_id   VARCHAR(100),   -- 연결된 라즈베리파이 디바이스 식별자
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 보호자 정보 (어르신과 1:N, 알림 수신 대상)
CREATE TABLE IF NOT EXISTS guardians (
    guardian_id  SERIAL PRIMARY KEY,
    senior_id    INTEGER REFERENCES seniors(senior_id),
    name         VARCHAR(50),
    phone        VARCHAR(20),    -- SNS 알림 발송용
    cognito_sub  VARCHAR(100),   -- Cognito 사용자 식별자
    created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 환경 센서 데이터 (라즈베리파이 + DHT11 → IoT Core → Lambda)
CREATE TABLE IF NOT EXISTS sensor_data (
    id           SERIAL PRIMARY KEY,
    senior_id    INTEGER REFERENCES seniors(senior_id),
    timestamp    TIMESTAMPTZ NOT NULL,
    sensor_type  VARCHAR(20),
    temperature  REAL,
    humidity     REAL
);

-- 생체 데이터 (Fitbit / Google Health API → Lambda)
CREATE TABLE IF NOT EXISTS fitbit_data (
    id           SERIAL PRIMARY KEY,
    senior_id    INTEGER REFERENCES seniors(senior_id),
    timestamp    TIMESTAMPTZ NOT NULL,
    heart_rate   INTEGER,
    steps        INTEGER,
    sleep_score  INTEGER,        -- 미측정 시 NULL 허용
    spo2         REAL
);

-- 알림 이력 (임계값 초과 시 생성, SNS 발송 근거)
CREATE TABLE IF NOT EXISTS alerts (
    id            SERIAL PRIMARY KEY,
    senior_id     INTEGER REFERENCES seniors(senior_id),
    timestamp     TIMESTAMPTZ NOT NULL,
    alert_type    VARCHAR(30),   -- TEMP_HIGH, HR_HIGH 등
    level         VARCHAR(20),   -- INFO / WARNING / EMERGENCY
    message       TEXT,
    acknowledged  BOOLEAN DEFAULT false
);

-- =============================================================
-- 인덱스 (implementation-plan 6.3 조회 패턴 기준)
-- =============================================================

-- 최근 환경 데이터 조회 (어르신별 시간 역순)
CREATE INDEX IF NOT EXISTS idx_sensor_data_senior_time
    ON sensor_data (senior_id, timestamp DESC);

-- 최근 생체 데이터 조회 (어르신별 시간 역순)
CREATE INDEX IF NOT EXISTS idx_fitbit_data_senior_time
    ON fitbit_data (senior_id, timestamp DESC);

-- 알림 디바운싱 조회 (어르신 + 알림종류별 최근 발생 시각 확인)
CREATE INDEX IF NOT EXISTS idx_alerts_senior_type_time
    ON alerts (senior_id, alert_type, timestamp DESC);

-- 미확인 알림 조회 (대시보드 배지 등)
CREATE INDEX IF NOT EXISTS idx_alerts_senior_ack
    ON alerts (senior_id, acknowledged);
