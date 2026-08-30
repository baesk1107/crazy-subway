const express = require('express');
const fs = require('fs');
const path = require('path');
const { STATIONS } = require('./data/stations');

// .env 로더 (외부 의존성 없이 최소한만 지원: KEY=VALUE 줄)
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const SK_APP_KEY = process.env.SK_APP_KEY || '';
const SK_BASE = 'https://apis.openapi.sk.com/puzzle/subway/congestion';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const DOWS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// 서비스 대상이 서울 지하철이므로 서버 타임존과 무관하게 KST(UTC+9, DST 없음) 기준
function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
const kstDow = () => DOWS[kstNow().getUTCDay()];
const kstHour = () => String(kstNow().getUTCHours()).padStart(2, '0');
const HOURS = Array.from({ length: 20 }, (_, i) => String(i + 5).padStart(2, '0')); // 05~24시

// 혼잡도 단계 (서울교통공사 기준: 정원 대비 %)
function level(pct) {
  if (pct < 80) return '여유';
  if (pct < 130) return '보통';
  if (pct < 150) return '혼잡';
  return '매우 혼잡';
}

function stationByCode(code) {
  return STATIONS.find((s) => s.code === code);
}

// ---------------------------------------------------------------------------
// SK Open API 호출
// ---------------------------------------------------------------------------
async function skFetch(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', appKey: SK_APP_KEY },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`SK API ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// 역 기준 통계 열차 혼잡도 → 방향별 시간대 혼잡도로 집계
async function skDaily(code, dow) {
  const json = await skFetch(`${SK_BASE}/stat/train/stations/${code}?dow=${dow}`);
  const stats = json?.data?.stat;
  if (!Array.isArray(stats) || stats.length === 0) throw new Error('SK API: empty stat');

  const directions = [];
  for (const s of stats) {
    // 10분 단위 슬롯을 시간대별 평균으로 집계
    const byHour = new Map();
    for (const d of s.data || []) {
      const hh = String(d.hh).padStart(2, '0');
      if (!byHour.has(hh)) byHour.set(hh, []);
      byHour.get(hh).push(Number(d.congestionTrain) || 0);
    }
    const hours = HOURS.map((hh) => {
      const vals = byHour.get(hh);
      if (!vals || vals.length === 0) return { hh, congestion: null, level: null };
      const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      return { hh, congestion: avg, level: level(avg) };
    });
    directions.push({
      updnLine: s.updnLine,
      label: s.endStationName ? `${s.endStationName} 방면` : s.updnLine === 0 ? '상행' : '하행',
      hours
    });
  }
  return directions;
}

// 역 기준 통계 칸 혼잡도 → 해당 시간대의 칸별 평균
async function skCars(code, dow, hh, updnLine) {
  const json = await skFetch(`${SK_BASE}/stat/car/stations/${code}?dow=${dow}&hh=${hh}`);
  const stats = json?.data?.stat;
  if (!Array.isArray(stats) || stats.length === 0) throw new Error('SK API: empty car stat');

  const s = stats.find((x) => String(x.updnLine) === String(updnLine)) || stats[0];
  const slots = (s.data || [])
    .map((d) => String(d.congestionCar || '').split('|').map(Number))
    .filter((arr) => arr.length > 1 && arr.every((n) => !Number.isNaN(n)));
  if (slots.length === 0) throw new Error('SK API: no car data');

  const n = slots[0].length;
  const cars = Array.from({ length: n }, (_, i) => {
    const avg = slots.reduce((sum, arr) => sum + (arr[i] || 0), 0) / slots.length;
    return Math.round(avg);
  });
  return cars;
}

// ---------------------------------------------------------------------------
// 데모 데이터 (API 키가 없거나 SK API 장애 시 폴백)
// 역/요일/시간을 시드로 한 결정적 통계 패턴 — 출퇴근 피크 곡선 반영
// ---------------------------------------------------------------------------
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function demoHourCongestion(code, dow, hh, updnLine) {
  const hour = Number(hh);
  const weekend = dow === 'SAT' || dow === 'SUN';
  const rand = mulberry32(hashSeed(`${code}:${dow}:${hh}:${updnLine}`));
  // 역별 기본 붐빔 계수 (0.65 ~ 1.35)
  const busy = 0.65 + (hashSeed(`busy:${code}`) % 700) / 1000;

  let base;
  if (weekend) {
    // 주말: 낮 시간대 완만한 곡선
    base = 45 + 35 * Math.exp(-((hour - 14) ** 2) / 18);
  } else {
    // 평일: 출근(8시), 퇴근(18시) 이중 피크
    const morning = 105 * Math.exp(-((hour - 8) ** 2) / 2.6);
    const evening = 95 * Math.exp(-((hour - 18.3) ** 2) / 3.2);
    // 상행(0)은 아침이, 하행(1)은 저녁이 상대적으로 붐빈다고 가정
    const dirBias = updnLine === 0 ? 1.15 : 0.9;
    base = 38 + morning * dirBias + evening * (2 - dirBias) * 0.95;
  }
  const noise = (rand() - 0.5) * 12;
  return Math.max(8, Math.round(base * busy + noise));
}

function demoDaily(code, dow, line) {
  const labels = line === '2' ? ['내선순환', '외선순환'] : ['상행', '하행'];
  return [0, 1].map((updnLine) => ({
    updnLine,
    label: labels[updnLine],
    hours: HOURS.map((hh) => {
      const c = demoHourCongestion(code, dow, hh, updnLine);
      return { hh, congestion: c, level: level(c) };
    })
  }));
}

function demoCars(code, dow, hh, updnLine) {
  const avg = demoHourCongestion(code, dow, hh, Number(updnLine));
  const rand = mulberry32(hashSeed(`cars:${code}:${dow}:${hh}:${updnLine}`));
  const carCount = 10;
  // 계단/환승 통로와 가까운 칸이 붐비는 패턴: 역마다 붐비는 칸 위치가 다르다
  const hotCar = Math.floor(rand() * carCount);
  return Array.from({ length: carCount }, (_, i) => {
    const dist = Math.min(Math.abs(i - hotCar), carCount - Math.abs(i - hotCar));
    const shape = 1.25 - dist * 0.09 + (rand() - 0.5) * 0.16;
    return Math.max(5, Math.round(avg * shape));
  });
}

// ---------------------------------------------------------------------------
// API 라우트
// ---------------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({ hasApiKey: Boolean(SK_APP_KEY) });
});

app.get('/api/stations', (_req, res) => {
  res.json({ stations: STATIONS });
});

// 오늘(또는 지정 요일)의 시간대별 혼잡도 예측
app.get('/api/congestion/daily', async (req, res) => {
  const code = String(req.query.code || '');
  const station = stationByCode(code);
  if (!station) return res.status(400).json({ error: '알 수 없는 역 코드입니다.' });

  const dow = DOWS.includes(req.query.dow) ? req.query.dow : kstDow();

  if (SK_APP_KEY) {
    try {
      const directions = await skDaily(code, dow);
      return res.json({ station, dow, source: 'sk-api', directions });
    } catch (err) {
      console.warn(`[daily] SK API 실패, 데모 데이터로 폴백: ${err.message}`);
    }
  }
  res.json({ station, dow, source: 'demo', directions: demoDaily(code, dow, station.line) });
});

// 특정 시간대의 칸별 혼잡도
app.get('/api/congestion/car', async (req, res) => {
  const code = String(req.query.code || '');
  const station = stationByCode(code);
  if (!station) return res.status(400).json({ error: '알 수 없는 역 코드입니다.' });

  const dow = DOWS.includes(req.query.dow) ? req.query.dow : kstDow();
  const hh = String(req.query.hh || kstHour());
  const updnLine = req.query.updnLine === '1' ? 1 : 0;

  if (SK_APP_KEY) {
    try {
      const cars = await skCars(code, dow, hh, updnLine);
      return res.json({
        station, dow, hh, updnLine, source: 'sk-api',
        cars: cars.map((c) => ({ congestion: c, level: level(c) }))
      });
    } catch (err) {
      console.warn(`[car] SK API 실패, 데모 데이터로 폴백: ${err.message}`);
    }
  }
  const cars = demoCars(code, dow, hh, updnLine);
  res.json({
    station, dow, hh, updnLine, source: 'demo',
    cars: cars.map((c) => ({ congestion: c, level: level(c) }))
  });
});

app.listen(PORT, () => {
  console.log(`🚇 crazy-subway 서버 실행 중: http://localhost:${PORT}`);
  console.log(SK_APP_KEY ? 'SK Open API 키 감지됨 (실데이터 모드)' : 'SK_APP_KEY 없음 → 데모 데이터 모드');
});
