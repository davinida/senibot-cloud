'use strict';

const { Client } = require('pg');
const { SNSClient } = require('@aws-sdk/client-sns');
const alertEngine = require('./alert-engine');

// 조회 대상 어르신 디바이스 (env-processor와 동일 패턴)
const DEFAULT_DEVICE_ID = 'senibot-pi-001';

// SNS 클라이언트는 컨테이너 재사용을 위해 모듈 스코프에서 1회 생성 (리전은 AWS_REGION 자동)
const snsClient = new SNSClient({});

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const HEALTH_BASE = 'https://health.googleapis.com/v4/users/me/dataTypes';

/**
 * fitbit-collector
 * EventBridge(주기 실행) -> (이 Lambda) -> Google Health API -> RDS(fitbit_data)
 *
 * 동작:
 *   1) 리프레시 토큰으로 액세스 토큰 갱신
 *   2) 액세스 토큰으로 Health API 호출 (심박수 / 걸음 / SpO2)
 *   3) 응답에서 최신값 추출 (방어적 파싱)
 *   4) fitbit_data 테이블에 저장 (sleep_score는 현재 null, 알림 평가는 별도)
 *
 * 환경변수: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
 *           DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 */
exports.handler = async (event) => {
  requireEnv([
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
    'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  ]);

  const deviceId = (event && event.device_id) || DEFAULT_DEVICE_ID;

  // (1) 액세스 토큰 갱신 -------------------------------------------------
  let accessToken;
  try {
    accessToken = await refreshAccessToken();
  } catch (err) {
    console.error('[1/3 토큰 갱신 실패]', err.message);
    throw err;
  }

  // (2) Health API 호출 + (3) 파싱 --------------------------------------
  // 타입별로 독립 처리: 한 타입이 실패해도 나머지는 계속 진행한다.
  const hr = await collectType(accessToken, 'heart-rate');
  const st = await collectType(accessToken, 'steps');
  const ox = await collectType(accessToken, 'oxygen-saturation');

  const heartRate = toInt(hr.value);          // INTEGER 컬럼
  const steps = toInt(st.value);              // INTEGER 컬럼
  const spo2 = isNum(ox.value) ? ox.value : null; // REAL 컬럼
  // 측정 시각: 추출 가능한 최신 timestamp 우선, 없으면 수집 시각(now)
  const measuredAt = hr.timestamp || st.timestamp || ox.timestamp || new Date().toISOString();

  // 세 값이 모두 없으면(빈 응답/오류) 빈 행을 남기지 않고 건너뛴다.
  if (heartRate === null && steps === null && spo2 === null) {
    console.warn('수집된 생체 값이 없어(heart_rate/steps/spo2 모두 null) 저장을 건너뜁니다.');
    return { ok: true, skipped: true };
  }

  // (4) RDS 저장 --------------------------------------------------------
  try {
    const saved = await saveToRds(deviceId, {
      timestamp: measuredAt, heartRate, steps, spo2,
    });
    if (saved.skipped) {
      console.log(
        `중복 측정값으로 저장 건너뜀(reason=${saved.reason}): ` +
        `senior_id=${saved.seniorId}, timestamp=${measuredAt}`
      );
      return { ok: true, skipped: true, reason: saved.reason };
    }
    console.log(
      `저장 완료: fitbit_data.id=${saved.id}, senior_id=${saved.seniorId}, ` +
      `heart_rate=${heartRate}, steps=${steps}, spo2=${spo2}, timestamp=${measuredAt}`
    );
    return { ok: true, id: saved.id, heart_rate: heartRate, steps, spo2 };
  } catch (err) {
    console.error('[3/3 DB 저장 실패]', err.code || '', '-', err.message);
    throw err;
  }
};

// ---------------------------------------------------------------------
// (1) OAuth: 리프레시 토큰 -> 액세스 토큰
// ---------------------------------------------------------------------
async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // 토큰/시크릿은 절대 로그에 남기지 않는다. 상태코드와 표준 error 코드만 기록.
    let code = '';
    try { const e = await res.json(); code = e.error || ''; } catch (_) { /* ignore */ }
    throw new Error(`HTTP ${res.status}${code ? ' ' + code : ''}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error('응답에 access_token 없음');
  return data.access_token; // 반환값(토큰)은 로그로 출력하지 않는다.
}

// ---------------------------------------------------------------------
// (2)+(3) 한 데이터 타입을 호출하고 최신값/시각을 추출 (실패해도 throw하지 않음)
// ---------------------------------------------------------------------
async function collectType(accessToken, dataType) {
  try {
    const resp = await fetchDataPoints(accessToken, dataType);
    logSnippet(dataType, resp);
    const latest = pickLatest(resp && resp.dataPoints, dataType);
    return { value: extractNumber(latest, dataType), timestamp: extractTimestamp(latest, dataType) };
  } catch (err) {
    console.error(`[2/3 Health API 실패: ${dataType}]`, err.message);
    return { value: null, timestamp: null };
  }
}

async function fetchDataPoints(accessToken, dataType) {
  // 최근 1시간만 받기 위한 filter(physical_time 기준)를 의도했으나, Google Health API의
  // 정확한 filter 쿼리파라미터 문법이 확인되지 않았다. 잘못된 필터는 400을 유발할 수 있어,
  // 지금은 필터 없이 전체를 받아온 뒤 코드에서 가장 최근 dataPoint를 선택한다.
  // (OAuth Playground에서 필터 없이 200 OK 확인됨)
  // 필터 문법 확인 후 아래처럼 적용하면 된다 (미검증 예시):
  //   const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  //   url += `?filter=${encodeURIComponent(`physical_time >= "${since}"`)}`;
  const url = `${HEALTH_BASE}/${dataType}/dataPoints`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }, // 토큰은 헤더로만, 로그 금지
  });
  if (!res.ok) {
    throw new Error(`${dataType} HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------
// 파싱 헬퍼 (응답 구조가 불확실하여 모두 방어적으로 처리)
// ---------------------------------------------------------------------

// 디버깅용: 응답의 dataPoints 개수와 첫 항목 일부를 출력 (건강값일 뿐 민감정보 아님)
function logSnippet(label, resp) {
  const dps = resp && resp.dataPoints;
  const count = Array.isArray(dps) ? dps.length : 0;
  const first = count > 0 ? JSON.stringify(dps[0]).slice(0, 500) : '(없음)';
  console.log(`[${label}] dataPoints=${count}, first=${first}`);
}

// 데이터 타입별 타임스탬프 경로 (실제 Google Health API 응답 구조 기준)
function tsField(dp, dataType) {
  if (!dp) return '';
  switch (dataType) {
    case 'heart-rate':
      return dp.heartRate?.sampleTime?.physicalTime || '';
    case 'steps':
      // endTime 우선, 없으면 startTime
      return dp.steps?.interval?.endTime || dp.steps?.interval?.startTime || '';
    case 'oxygen-saturation':
      return dp.oxygenSaturation?.sampleTime?.physicalTime || '';
    default:
      return '';
  }
}

// dataPoints 배열에서 가장 최근 항목 선택. ISO 문자열이면 사전식 정렬이 시간순과 일치.
function pickLatest(dataPoints, dataType) {
  if (!Array.isArray(dataPoints) || dataPoints.length === 0) return null;
  return [...dataPoints]
    .sort((a, b) => String(tsField(a, dataType)).localeCompare(String(tsField(b, dataType))))
    .pop();
}

// 유효한 날짜 문자열일 때만 timestamp로 사용 (그 외엔 null -> 상위에서 now 대체)
function extractTimestamp(dp, dataType) {
  const ts = tsField(dp, dataType);
  return (typeof ts === 'string' && ts && !Number.isNaN(Date.parse(ts))) ? ts : null;
}

// 데이터 타입별 값 경로 (실제 응답 구조 기준).
// 값이 문자열일 수 있으므로 Number()로 변환하고, 변환 실패(NaN)면 null.
function extractNumber(dp, dataType) {
  if (!dp) return null;

  let raw;
  switch (dataType) {
    case 'heart-rate':
      raw = dp.heartRate?.beatsPerMinute;          // 예: "70" (문자열)
      break;
    case 'steps':
      // 걸음수는 "최신 1개 구간의 count"를 그대로 사용한다.
      // (오늘 누적 / 여러 구간 합산이 더 의미 있으나, 지금은 단순화. 나중에 다듬음.)
      raw = dp.steps?.count;                        // 예: "4" (문자열)
      break;
    case 'oxygen-saturation':
      raw = dp.oxygenSaturation?.percentage;        // 예: 50 (숫자)
      break;
    default:
      return null;
  }

  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);                            // 문자열/숫자 모두 변환
  return Number.isFinite(n) ? n : null;             // NaN이면 null
}

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toInt(n) {
  return isNum(n) ? Math.round(n) : null;
}

// ---------------------------------------------------------------------
// (4) RDS 저장
// ---------------------------------------------------------------------
async function saveToRds(deviceId, row) {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }, // RDS SSL (운영 시 RDS CA 번들 사용 권장)
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();

    const senior = await client.query(
      'SELECT senior_id FROM seniors WHERE device_id = $1 LIMIT 1',
      [deviceId]
    );
    if (senior.rowCount === 0) {
      throw new Error(`등록되지 않은 device_id: ${deviceId} (seniors 테이블에 없음)`);
    }
    const seniorId = senior.rows[0].senior_id;

    // 중복 저장 방지 가드:
    // 같은 senior의 마지막 저장 timestamp가 이번 측정과 '정확히 같은 시각'이면 INSERT를 건너뛴다.
    // 비교는 PostgreSQL의 timestamptz 동등 비교로 수행한다(정밀도/시간대 정합성 보장).
    // 기존 데이터가 없으면(첫 저장) same 행이 없으므로 그대로 INSERT 진행.
    const last = await client.query(
      `SELECT (timestamp = $2::timestamptz) AS same
       FROM fitbit_data
       WHERE senior_id = $1
       ORDER BY timestamp DESC
       LIMIT 1`,
      [seniorId, row.timestamp]
    );
    if (last.rowCount > 0 && last.rows[0].same === true) {
      return { skipped: true, reason: 'duplicate', seniorId };
    }

    const inserted = await client.query(
      `INSERT INTO fitbit_data (senior_id, timestamp, heart_rate, steps, sleep_score, spo2)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [seniorId, row.timestamp, row.heartRate, row.steps, null, row.spo2] // sleep_score는 현재 null
    );
    const id = inserted.rows[0].id;

    // 임계값 알림 평가 (중복 skip이 아닌 '신규 저장' 경로에서만 도달 / 저장과 격리)
    // 같은 pg 커넥션과 seniorId, 모듈 스코프 snsClient 재사용. heart_rate/steps 기준 판정.
    try {
      await alertEngine.evaluateFitbitAlerts(client, snsClient, seniorId, {
        heart_rate: row.heartRate, steps: row.steps,
      });
    } catch (alertErr) {
      console.error('알림 평가 중 오류(생체 저장은 정상):', alertErr.message);
    }

    return { id, seniorId };
  } finally {
    try {
      await client.end();
    } catch (endErr) {
      console.error('커넥션 종료 중 오류:', endErr.message);
    }
  }
}

// ---------------------------------------------------------------------
// 공통: 필수 환경변수 확인 (값이 아니라 '키 이름'만 노출)
// ---------------------------------------------------------------------
function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`환경변수 누락: ${missing.join(', ')}`);
  }
}
