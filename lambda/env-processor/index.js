'use strict';

const { Client } = require('pg');

// device_id가 이벤트에 없을 때 사용할 기본 어르신 디바이스
const DEFAULT_DEVICE_ID = 'senibot-pi-001';

/**
 * env-processor
 * IoT Core -> IoT Rule -> (이 Lambda) -> RDS(sensor_data)
 *
 * 환경 센서 메시지를 sensor_data 테이블에 저장한다. (알림 평가는 4단계 별도 함수)
 *
 * 기대 event 형식:
 *   {
 *     "device_id": "senibot-pi-001",        // 선택. 없으면 기본값 사용
 *     "timestamp": "2026-06-10T00:00:00Z",  // ISO 문자열
 *     "sensor_type": "DHT11",
 *     "temperature": 28,
 *     "humidity": 59
 *   }
 *
 * DB 접속 정보는 환경변수에서 읽는다: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 */
exports.handler = async (event) => {
  // IoT Rule은 보통 객체를 그대로 전달하지만, 문자열로 올 경우를 대비해 방어적으로 파싱
  const data = typeof event === 'string' ? JSON.parse(event) : (event || {});

  const deviceId = data.device_id || DEFAULT_DEVICE_ID;
  const timestamp = data.timestamp || new Date().toISOString();
  const sensorType = data.sensor_type || 'DHT11';
  // 0도 유효값이므로 ?? 사용 (||를 쓰면 0이 null로 바뀜)
  const temperature = data.temperature ?? null;
  const humidity = data.humidity ?? null;

  // 매 호출마다 새 커넥션 (풀 재사용 최적화는 현 단계에서 불필요)
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

    // device_id -> senior_id 조회
    const senior = await client.query(
      'SELECT senior_id FROM seniors WHERE device_id = $1 LIMIT 1',
      [deviceId]
    );
    if (senior.rowCount === 0) {
      throw new Error(`등록되지 않은 device_id: ${deviceId} (seniors 테이블에 없음)`);
    }
    const seniorId = senior.rows[0].senior_id;

    // sensor_data 저장
    const inserted = await client.query(
      `INSERT INTO sensor_data (senior_id, timestamp, sensor_type, temperature, humidity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [seniorId, timestamp, sensorType, temperature, humidity]
    );

    const id = inserted.rows[0].id;
    console.log(
      `저장 완료: sensor_data.id=${id}, senior_id=${seniorId}, device_id=${deviceId}, ` +
      `sensor_type=${sensorType}, temperature=${temperature}, humidity=${humidity}`
    );

    return { ok: true, id, senior_id: seniorId };
  } catch (err) {
    // 민감정보(비밀번호 등)는 남기지 않는다. code/message만 기록.
    console.error('env-processor 실패:', err.code || '', '-', err.message);
    throw err; // Lambda 실패로 표시 -> CloudWatch 지표/재시도/모니터링 가능
  } finally {
    try {
      await client.end();
    } catch (endErr) {
      console.error('커넥션 종료 중 오류:', endErr.message);
    }
  }
};
