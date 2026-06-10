'use strict';

// =============================================================
// Rule-based 알림 엔진 (클라우드 이식판)
//
// On-Premise services/alert-engine.js 로직을 AWS용으로 이식한 공유 모듈이다.
//  - 임계값/메시지: On-Premise와 동일 (보호자 관점 한국어)
//  - 저장: SQLite storage.saveAlert 대신 pg Client로 alerts 테이블에 직접 INSERT
//  - 디바운싱: 메모리 캐시 대신 alerts 테이블 조회 (idx_alerts_senior_type_time 활용)
//  - 발화 시 SNS(@aws-sdk/client-sns)로 보호자에게 알림 발행
//
// 주의: 이 파일은 각 Lambda 폴더로 복사되어 배포된다
//       (lambda/env-processor/alert-engine.js, lambda/fitbit-collector/alert-engine.js).
//       원본은 lambda/shared/alert-engine.js 이며, 수정 시 복사본도 갱신할 것.
// =============================================================

const { PublishCommand } = require('@aws-sdk/client-sns');

// 환경변수 -> 숫자 (NaN이면 기본값)
function num(envValue, defaultValue) {
  const n = parseFloat(envValue);
  return Number.isNaN(n) ? defaultValue : n;
}

// 임계값 (모듈 로드 시 1회 읽음, 환경변수 override + 기본값 fallback)
const TH = {
  TEMP_HIGH: num(process.env.TEMP_HIGH_THRESHOLD, 35),
  TEMP_LOW: num(process.env.TEMP_LOW_THRESHOLD, 10),
  HUMID_HIGH: num(process.env.HUMID_HIGH_THRESHOLD, 80),
  HUMID_LOW: num(process.env.HUMID_LOW_THRESHOLD, 20),
  HR_HIGH: num(process.env.HR_HIGH_THRESHOLD, 100),
  HR_LOW: num(process.env.HR_LOW_THRESHOLD, 45),
  LOW_ACTIVITY_RATIO: num(process.env.LOW_ACTIVITY_RATIO, 0.3),
  DEBOUNCE_SEC: num(process.env.ALERT_DEBOUNCE_SEC, 300),
  SEED_STEPS: num(process.env.FITBIT_SEED_STEPS, 1500),
};

const SNS_SUBJECT = '[시니봇] 보호자 알림';

// ─── 디바운싱 (DB 기반) ───────────────────────────────────────────
// 같은 senior_id + alert_type의 최근 알림이 DEBOUNCE_SEC 이내에 있으면 true(=skip).
async function shouldDebounce(pgClient, seniorId, alertType) {
  const res = await pgClient.query(
    `SELECT 1
       FROM alerts
      WHERE senior_id = $1
        AND alert_type = $2
        AND timestamp > now() - ($3::double precision * interval '1 second')
      ORDER BY timestamp DESC
      LIMIT 1`,
    [seniorId, alertType, TH.DEBOUNCE_SEC]
  );
  if (res.rowCount > 0) {
    console.log(`[Alert] 디바운싱: senior_id=${seniorId} ${alertType} skip (최근 ${TH.DEBOUNCE_SEC}초 내 발화)`);
    return true;
  }
  return false;
}

// ─── SNS 발행 ─────────────────────────────────────────────────────
// 실패해도 alerts 저장을 무효화하지 않도록, 에러를 삼키고 상태만 반환한다.
async function publishToSns(snsClient, message) {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!snsClient || !topicArn) {
    console.warn('[Alert] SNS_TOPIC_ARN 미설정 또는 snsClient 없음 -> SNS 발행 생략');
    return 'skipped';
  }
  try {
    await snsClient.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: SNS_SUBJECT,
      Message: message,
    }));
    return 'sent';
  } catch (err) {
    // 민감정보 아님. SNS 에러명/메시지만 기록.
    console.error('[Alert] SNS 발행 실패:', err.name || '', '-', err.message);
    return 'failed';
  }
}

// ─── 단일 알림 처리 ───────────────────────────────────────────────
// 디바운싱 체크 -> alerts INSERT(먼저) -> SNS 발행(후). 저장과 발행을 격리한다.
async function emitAlert(pgClient, snsClient, seniorId, candidate) {
  const { alert_type, level, message } = candidate;

  // 1) 디바운싱
  if (await shouldDebounce(pgClient, seniorId, alert_type)) {
    return { alert_type, status: 'debounced' };
  }

  const timestamp = new Date().toISOString();
  console.log(`[Alert] 발화: ${level} ${alert_type} - ${message}`);

  // 2) alerts 테이블 기록 (SNS보다 먼저 — SNS 실패해도 기록은 남는다)
  const inserted = await pgClient.query(
    `INSERT INTO alerts (senior_id, timestamp, alert_type, level, message, acknowledged)
     VALUES ($1, $2, $3, $4, $5, false)
     RETURNING id`,
    [seniorId, timestamp, alert_type, level, message]
  );
  const alertId = inserted.rows[0].id;

  // 3) SNS 발행 (실패는 삼키고 상태만 기록)
  const snsStatus = await publishToSns(snsClient, message);

  return { alert_type, level, status: 'emitted', id: alertId, sns: snsStatus };
}

// 후보 배열을 각각 처리. 한 건 실패해도 다른 건 진행 (Promise.allSettled).
async function emitAll(pgClient, snsClient, seniorId, candidates, label) {
  const results = await Promise.allSettled(
    candidates.map((c) => emitAlert(pgClient, snsClient, seniorId, c))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[Alert] ${label} 알림 처리 실패 (${candidates[i].alert_type}):`, r.reason && r.reason.message);
    }
  });
  return results;
}

// ─── 환경 알림 평가 ───────────────────────────────────────────────
// sensorData: { temperature, humidity }
async function evaluateEnvironmentAlerts(pgClient, snsClient, seniorId, sensorData) {
  const { temperature, humidity } = sensorData || {};
  console.log(`[Alert] 환경 평가: senior_id=${seniorId} TEMP=${temperature} HUMID=${humidity}`);

  const candidates = [];

  if (typeof temperature === 'number') {
    if (temperature > TH.TEMP_HIGH) {
      candidates.push({
        alert_type: 'TEMP_HIGH',
        level: 'WARNING',
        message: `어머니 댁 실내 온도가 위험 수준입니다 (${temperature.toFixed(1)}°C). 안부 확인을 권장합니다.`,
      });
    } else if (temperature < TH.TEMP_LOW) {
      candidates.push({
        alert_type: 'TEMP_LOW',
        level: 'WARNING',
        message: `어머니 댁 실내 온도가 너무 낮습니다 (${temperature.toFixed(1)}°C). 난방 점검을 권장합니다.`,
      });
    }
  }

  if (typeof humidity === 'number') {
    if (humidity > TH.HUMID_HIGH) {
      candidates.push({
        alert_type: 'HUMID_HIGH',
        level: 'INFO',
        message: `어머니 댁 습도가 너무 높습니다 (${humidity.toFixed(0)}%). 환기를 권장합니다.`,
      });
    } else if (humidity < TH.HUMID_LOW) {
      candidates.push({
        alert_type: 'HUMID_LOW',
        level: 'INFO',
        message: `어머니 댁 습도가 너무 낮습니다 (${humidity.toFixed(0)}%). 가습을 권장합니다.`,
      });
    }
  }

  return emitAll(pgClient, snsClient, seniorId, candidates, '환경');
}

// ─── Fitbit 알림 평가 ─────────────────────────────────────────────
// fitbitData: { heart_rate, steps }
async function evaluateFitbitAlerts(pgClient, snsClient, seniorId, fitbitData) {
  const { heart_rate, steps } = fitbitData || {};
  console.log(`[Alert] 생체 평가: senior_id=${seniorId} HR=${heart_rate} STEPS=${steps}`);

  const candidates = [];

  if (typeof heart_rate === 'number') {
    if (heart_rate > TH.HR_HIGH) {
      candidates.push({
        alert_type: 'HR_HIGH',
        level: 'WARNING',
        message: `어머니의 안정 시 심박수가 높습니다 (${heart_rate} bpm). 즉시 안부 확인 권장.`,
      });
    } else if (heart_rate < TH.HR_LOW) {
      candidates.push({
        alert_type: 'HR_LOW',
        level: 'WARNING',
        message: `어머니의 안정 시 심박수가 낮습니다 (${heart_rate} bpm). 즉시 안부 확인 권장.`,
      });
    }
  }

  if (typeof steps === 'number') {
    const lowThreshold = Math.floor(TH.SEED_STEPS * TH.LOW_ACTIVITY_RATIO);
    if (steps < lowThreshold) {
      candidates.push({
        alert_type: 'LOW_ACTIVITY',
        level: 'INFO',
        message: `어머니의 오늘 활동량이 매우 낮습니다 (${steps}보 / 평소 ${TH.SEED_STEPS}보). 컨디션 확인 권장.`,
      });
    }
  }

  return emitAll(pgClient, snsClient, seniorId, candidates, '생체');
}

module.exports = {
  evaluateEnvironmentAlerts,
  evaluateFitbitAlerts,
  // 테스트/디버깅용 export
  _internal: { TH, shouldDebounce, emitAlert, publishToSns },
};
