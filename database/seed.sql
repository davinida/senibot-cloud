-- =============================================================
-- SeniBot Cloud - 개발/테스트용 시드 데이터
-- 선행 조건: database/schema.sql 를 먼저 적용할 것.
--
-- 어르신 1명과 그 보호자 1명을 등록한다.
-- 같은 데이터가 이미 있으면 중복 삽입하지 않으므로 반복 실행해도 안전하다.
-- =============================================================

-- 어르신 1명 등록 (device_id 기준 중복 방지)
INSERT INTO seniors (name, device_id)
SELECT '김복순', 'senibot-pi-001'
WHERE NOT EXISTS (
    SELECT 1 FROM seniors WHERE device_id = 'senibot-pi-001'
);

-- 위 어르신의 보호자 1명 등록
-- senior_id 는 SERIAL 자동 생성값이므로 device_id 로 조회해 연결한다.
-- phone 은 placeholder 이며, 실제 번호로 교체 필요 (SNS 알림 발송용).
INSERT INTO guardians (senior_id, name, phone)
SELECT s.senior_id, '김민준', '010-0000-0000'   -- TODO: phone 을 실제 번호로 교체
FROM seniors s
WHERE s.device_id = 'senibot-pi-001'
  AND NOT EXISTS (
      SELECT 1 FROM guardians g WHERE g.senior_id = s.senior_id
  );
