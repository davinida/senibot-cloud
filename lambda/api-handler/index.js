'use strict';

const { Client } = require('pg');

// =============================================================
// api-handler
// API Gateway(프록시 통합) -> (이 Lambda 하나) -> RDS(PostgreSQL)
//
// 보호자 대시보드가 사용하는 조회/확인 REST API.
// On-Premise routes/(environment, fitbit, alerts, dashboard).js 로직을 이전했다.
// 라우트별 Lambda를 따로 두지 않고, event.httpMethod + event.path 로 분기한다.
//
// 환경변수: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
// =============================================================

// 모든 응답에 붙는 CORS 헤더 (+ JSON)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// 프록시 통합 응답 헬퍼
function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj === undefined ? null : bodyObj),
  };
}

exports.handler = async (event) => {
  const method = (event && event.httpMethod) || 'GET';

  // CORS preflight: DB 접근 없이 즉시 200
  if (method === 'OPTIONS') {
    return respond(200, {});
  }

  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }, // 퍼블릭 RDS 엔드포인트 SSL (운영 시 CA 번들 권장)
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    const { statusCode, body } = await route(event, client);
    return respond(statusCode, body);
  } catch (err) {
    // 민감정보(비밀번호 등)는 남기지 않는다. code/message만 기록.
    console.error('[API] 처리 실패:', method, normalizePath(event && event.path), '-', err.code || '', err.message);
    return respond(500, { error: '서버 오류가 발생했습니다.' });
  } finally {
    try {
      await client.end();
    } catch (endErr) {
      console.error('[API] 커넥션 종료 중 오류:', endErr.message);
    }
  }
};

// ─── 라우팅 ───────────────────────────────────────────────────────
// method + 정규화된 path 로 분기. 각 분기는 { statusCode, body } 반환.
async function route(event, client) {
  const method = event.httpMethod;
  const path = normalizePath(event.path);
  const q = event.queryStringParameters || {};

  // GET /api/environment/current : 최신 환경 1건 (timestamp 최신)
  if (method === 'GET' && path === '/api/environment/current') {
    const r = await client.query('SELECT * FROM sensor_data ORDER BY timestamp DESC LIMIT 1');
    return { statusCode: 200, body: r.rows[0] || null };
  }

  // GET /api/environment/history?limit=N : 환경 이력 (1~500, 기본 50, 시간 오름차순)
  if (method === 'GET' && path === '/api/environment/history') {
    const limit = clampLimit(q.limit, 50, 1, 500);
    const r = await client.query(
      `SELECT * FROM (
         SELECT * FROM sensor_data ORDER BY timestamp DESC LIMIT $1
       ) sub ORDER BY timestamp ASC`,
      [limit]
    );
    return { statusCode: 200, body: r.rows };
  }

  // GET /api/fitbit/latest : 최신 생체 1건
  if (method === 'GET' && path === '/api/fitbit/latest') {
    const r = await client.query('SELECT * FROM fitbit_data ORDER BY timestamp DESC LIMIT 1');
    return { statusCode: 200, body: r.rows[0] || null };
  }

  // GET /api/fitbit/history?limit=N : 생체 이력 (1~200, 기본 20, 시간 오름차순)
  if (method === 'GET' && path === '/api/fitbit/history') {
    const limit = clampLimit(q.limit, 20, 1, 200);
    const r = await client.query(
      `SELECT * FROM (
         SELECT * FROM fitbit_data ORDER BY timestamp DESC LIMIT $1
       ) sub ORDER BY timestamp ASC`,
      [limit]
    );
    return { statusCode: 200, body: r.rows };
  }

  // GET /api/alerts?limit=N&unacknowledged_only=true/false : 알림 (1~200, 기본 30, 시간 내림차순)
  if (method === 'GET' && path === '/api/alerts') {
    const limit = clampLimit(q.limit, 30, 1, 200);
    const unackOnly = q.unacknowledged_only === 'true';
    // acknowledged 는 boolean — SQL에서 = false 로 필터 (JS 0/1 비교 사용 안 함)
    const sql = unackOnly
      ? 'SELECT * FROM alerts WHERE acknowledged = false ORDER BY timestamp DESC LIMIT $1'
      : 'SELECT * FROM alerts ORDER BY timestamp DESC LIMIT $1';
    const r = await client.query(sql, [limit]);
    return { statusCode: 200, body: r.rows };
  }

  // POST /api/alerts/{id}/acknowledge : 해당 알림 acknowledged=true
  const ackMatch = path.match(/^\/api\/alerts\/([^/]+)\/acknowledge$/);
  if (method === 'POST' && ackMatch) {
    const id = parseInt(ackMatch[1], 10);
    if (Number.isNaN(id)) {
      return { statusCode: 400, body: { error: '잘못된 ID' } };
    }
    const r = await client.query(
      'UPDATE alerts SET acknowledged = true WHERE id = $1 RETURNING id',
      [id]
    );
    if (r.rowCount === 0) {
      return { statusCode: 404, body: { error: '알림을 찾을 수 없음' } };
    }
    return { statusCode: 200, body: { success: true } };
  }

  // GET /api/dashboard/summary : 대시보드 요약
  if (method === 'GET' && path === '/api/dashboard/summary') {
    return { statusCode: 200, body: await buildSummary(client) };
  }

  return { statusCode: 404, body: { error: '존재하지 않는 경로입니다.' } };
}

// ─── 대시보드 요약 (On-Premise dashboard.js 형식 유지) ─────────────
async function buildSummary(client) {
  // 어르신/보호자: 환경변수 대신 DB에서 조회 (senior_id 가장 작은 = 첫 어르신)
  const seniorRes = await client.query(
    'SELECT senior_id, name FROM seniors ORDER BY senior_id ASC LIMIT 1'
  );
  const senior = seniorRes.rows[0] || null;

  let guardian = null;
  if (senior) {
    const gRes = await client.query(
      'SELECT name, phone FROM guardians WHERE senior_id = $1 ORDER BY guardian_id ASC LIMIT 1',
      [senior.senior_id]
    );
    guardian = gRes.rows[0] || null;
  }

  const fitbitRes = await client.query(
    'SELECT heart_rate, steps, sleep_score, spo2, timestamp FROM fitbit_data ORDER BY timestamp DESC LIMIT 1'
  );
  const sensorRes = await client.query(
    'SELECT temperature, humidity, timestamp FROM sensor_data ORDER BY timestamp DESC LIMIT 1'
  );
  const unackRes = await client.query(
    `SELECT id, alert_type, level, message, timestamp
       FROM alerts
      WHERE acknowledged = false
      ORDER BY timestamp DESC`
  );
  const unacknowledged = unackRes.rows;

  // 어르신 상태: 미확인 알림 레벨로 판정
  let status = 'normal';
  if (unacknowledged.some((a) => a.level === 'EMERGENCY')) {
    status = 'emergency';
  } else if (unacknowledged.some((a) => a.level === 'WARNING')) {
    status = 'warning';
  }

  return {
    senior: {
      name: senior ? senior.name : null,
      status,
    },
    guardian: {
      name: guardian ? guardian.name : null,
      phone: guardian ? guardian.phone : null,
    },
    fitbit: fitbitRes.rows[0] || null,
    environment: sensorRes.rows[0] || null, // sensor → environment 키 매핑
    unacknowledged_alerts: unacknowledged,
  };
}

// ─── 헬퍼 ─────────────────────────────────────────────────────────

// 프록시 path를 '/api/...' 기준으로 정규화 (스테이지 접두어가 붙어도 안전)
function normalizePath(rawPath) {
  if (!rawPath) return '/';
  const idx = rawPath.indexOf('/api/');
  let p = idx >= 0 ? rawPath.slice(idx) : rawPath;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1); // 끝 슬래시 제거
  return p;
}

// limit 파싱 + 클램프 (On-Premise와 동일: NaN/0이면 기본값, 이후 min~max 클램프)
function clampLimit(raw, def, min, max) {
  const n = parseInt(raw, 10) || def;
  return Math.min(Math.max(n, min), max);
}
