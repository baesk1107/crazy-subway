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

// appKey는 API별이 아니라 앱(프로젝트) 단위 하나로 모든 API에 공통 사용
const SK_APP_KEY = process.env.SK_APP_KEY || '';

// HTTPS_PROXY가 설정된 환경(사내망, 원격 컨테이너 등)에서는 fetch가 프록시를 타도록 설정.
// Node 기본 fetch(undici)는 프록시 환경변수를 자동으로 읽지 않는다. 로컬 직접 연결에는 영향 없음.
if (process.env.HTTPS_PROXY || process.env.https_proxy) {
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    console.warn('HTTPS_PROXY 감지됐지만 undici 미설치 — 직접 연결로 시도합니다.');
  }
}
// SK Open API의 지하철 혼잡도는 두 가지 상품/엔드포인트 체계가 있다.
//  - puzzle : "Free(지하철 혼잡도) PUZZLE-SUBWAY" 상품. 역 코드(stationCode) 경로 방식, 1~8호선.
//  - transit: "TMAP 대중교통" 상품. 노선명+역명(routeNm/stationNm) 쿼리 방식, 1~9호선.
// 어떤 상품을 구매했는지에 따라 되는 쪽이 다르므로, 둘 다 시도해 성공하는 쪽을 기억한다.
// SK_API_MODE=puzzle|transit 으로 고정할 수도 있다.
const SK_API_STYLES = {
  puzzle: {
    url(kind, station, dow, hh) {
      // 퍼즐 상품은 서울교통공사(1~8호선) 역 코드 기반 — 9호선은 지원하지 않음
      if (station.line === '9') return null;
      return `https://apis.openapi.sk.com/puzzle/subway/congestion/stat/${kind}/stations/${station.code}?dow=${dow}&hh=${hh}`;
    }
  },
  transit: {
    url(kind, station, dow, hh) {
      const qs = new URLSearchParams({ routeNm: `${station.line}호선`, stationNm: station.name, dow, hh });
      return `https://apis.openapi.sk.com/transit/puzzle/subway/congestion/stat/${kind}?${qs}`;
    }
  }
};
let skPreferredStyle = SK_API_STYLES[process.env.SK_API_MODE] ? process.env.SK_API_MODE : 'puzzle';
const skModeLocked = Boolean(SK_API_STYLES[process.env.SK_API_MODE]);
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
// SK Open API (TMAP 대중교통 · 진입 역 기준 통계 혼잡도) 호출
// 하나의 appKey로 열차/칸 혼잡도 API를 모두 호출한다.
// ---------------------------------------------------------------------------

// 통계 데이터는 사실상 고정이므로 7일간 캐시해 무료 일일 쿼터를 아낀다.
// 서버를 재시작해도 쿼터를 다시 쓰지 않도록 디스크(.cache/)에도 저장한다.
const SK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE = path.join(__dirname, '.cache', 'sk-stat.json');
const skCache = new Map();
try {
  for (const [k, e] of Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')))) {
    if (Date.now() - e.t < SK_CACHE_TTL) skCache.set(k, e);
  }
  if (skCache.size) console.log(`디스크 캐시 로드: ${skCache.size}건`);
} catch { /* 캐시 파일 없음 — 첫 실행 */ }

let cacheSaveTimer = null;
function scheduleCacheSave() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(skCache)));
    } catch (err) {
      console.warn(`캐시 저장 실패: ${err.message}`);
    }
  }, 1000);
}

function cacheGet(key) {
  const e = skCache.get(key);
  if (e && Date.now() - e.t < SK_CACHE_TTL) return e.v;
  skCache.delete(key);
  return null;
}
function cacheSet(key, v) {
  skCache.set(key, { t: Date.now(), v });
  scheduleCacheSave();
}

// 폴백 사유를 프론트로 전달하기 위한 분류 (quota: 일일 한도 소진, auth: 키/상품 권한)
function skErrorReason(err) {
  const msg = String(err && err.message);
  if (msg.includes('QUOTA_EXCEEDED')) return 'quota';
  if (msg.includes('INVALID_API_KEY')) return 'auth';
  return 'error';
}

async function skFetch(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', appKey: SK_APP_KEY },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`SK API ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// 진입 역 기준 통계 혼잡도 조회 (kind: 'train' | 'car')
// dow/hh를 안 주면 요청 시각 기준 데이터만 오므로 시간대별로 명시 조회한다.
// 선호 스타일(puzzle/transit)로 먼저 호출하고, 실패하면 다른 스타일을 시도해
// 성공한 쪽을 이후 기본값으로 기억한다.
async function skStat(kind, station, dow, hh) {
  const key = `${kind}:${station.line}:${station.name}:${dow}:${hh}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const styles = skModeLocked
    ? [skPreferredStyle]
    : [skPreferredStyle, ...Object.keys(SK_API_STYLES).filter((s) => s !== skPreferredStyle)];

  let lastErr;
  for (const styleName of styles) {
    const url = SK_API_STYLES[styleName].url(kind, station, dow, hh);
    if (!url) continue; // 이 스타일이 지원하지 않는 노선
    try {
      const json = await skFetch(url);
      // 상품/문서 버전에 따라 contents 또는 data 아래에 stat 배열이 온다
      const stat = json?.contents?.stat ?? json?.data?.stat;
      if (!Array.isArray(stat) || stat.length === 0) throw new Error(`SK API: ${kind} 응답에 stat 없음`);
      if (skPreferredStyle !== styleName) {
        skPreferredStyle = styleName;
        console.log(`SK API 스타일 전환: ${styleName} 방식이 동작해 기본값으로 사용합니다.`);
      }
      cacheSet(key, stat);
      return stat;
    } catch (err) {
      // 쿼터 소진이 다른 스타일의 권한 오류에 가려지지 않게 우선 보존
      if (!lastErr || skErrorReason(err) === 'quota') lastErr = err;
    }
  }
  throw lastErr || new Error(`SK API: ${kind} 조회 실패`);
}

// 방향 식별: 상/하행(updnLine) + 급행 여부(directAt) 조합
const dirKeyOf = (s) => `${s.updnLine}:${s.directAt ? 1 : 0}`;
function dirLabelOf(s, line) {
  const base = s.endStationName
    ? `${s.endStationName} 방면`
    : line === '2'
      ? (String(s.updnLine) === '0' ? '내선순환' : '외선순환')
      : (String(s.updnLine) === '0' ? '상행' : '하행');
  return s.directAt ? `${base} 급행` : base;
}

// 진입 역 기준 열차 혼잡도를 시간대별로 조회해 방향별 하루 곡선으로 합친다
async function skDaily(station, dow) {
  const byHourStat = new Map();
  let firstErr = null;
  for (let i = 0; i < HOURS.length; i += 5) {
    // 과도한 동시 호출을 피하기 위해 5개씩 묶어 병렬 조회
    await Promise.all(HOURS.slice(i, i + 5).map(async (hh) => {
      try {
        byHourStat.set(hh, await skStat('train', station, dow, hh));
      } catch (err) {
        if (!firstErr || skErrorReason(err) === 'quota') firstErr = err;
        byHourStat.set(hh, null);
      }
    }));
  }
  if (![...byHourStat.values()].some(Boolean)) throw firstErr || new Error('SK API: 전 시간대 조회 실패');

  const dirs = new Map();
  for (const hh of HOURS) {
    for (const s of byHourStat.get(hh) || []) {
      const key = dirKeyOf(s);
      if (!dirs.has(key)) {
        dirs.set(key, {
          updnLine: Number(s.updnLine) || 0,
          directAt: s.directAt ? 1 : 0,
          label: dirLabelOf(s, station.line),
          byHour: new Map()
        });
      }
      // 10분 단위 슬롯을 시간대 평균으로 집계
      const vals = (s.data || [])
        .map((d) => Number(d.congestionTrain))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (vals.length) dirs.get(key).byHour.set(hh, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
    }
  }

  return [...dirs.values()]
    .sort((a, b) => a.updnLine - b.updnLine || a.directAt - b.directAt)
    .map((d) => ({
      updnLine: d.updnLine,
      directAt: d.directAt,
      label: d.label,
      hours: HOURS.map((hh) => {
        const c = d.byHour.get(hh);
        return c == null ? { hh, congestion: null, level: null } : { hh, congestion: c, level: level(c) };
      })
    }));
}

// 진입 역 기준 칸 혼잡도 → 해당 시간대의 칸별 평균
async function skCars(station, dow, hh, updnLine, directAt) {
  const stat = await skStat('car', station, dow, hh);
  const s =
    stat.find((x) => String(x.updnLine) === String(updnLine) && (x.directAt ? 1 : 0) === directAt) ||
    stat.find((x) => String(x.updnLine) === String(updnLine)) ||
    stat[0];

  // congestionCar: "34|31|31|38|…" 구분자 문자열 → 숫자 배열
  const slots = (s.data || [])
    .map((d) => String(d.congestionCar || '').split('|').map(Number))
    .filter((arr) => arr.length > 1 && arr.every((n) => Number.isFinite(n)));
  if (slots.length === 0) throw new Error('SK API: 칸 혼잡도 데이터 없음');

  const n = slots[0].length;
  return Array.from({ length: n }, (_, i) => {
    const avg = slots.reduce((sum, arr) => sum + (arr[i] || 0), 0) / slots.length;
    return Math.round(avg);
  });
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
    directAt: 0,
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
      const directions = await skDaily(station, dow);
      return res.json({ station, dow, source: 'sk-api', directions });
    } catch (err) {
      console.warn(`[daily] SK API 실패, 데모 데이터로 폴백: ${err.message}`);
      return res.json({
        station, dow, source: 'demo', reason: skErrorReason(err),
        directions: demoDaily(code, dow, station.line)
      });
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
  const directAt = req.query.directAt === '1' ? 1 : 0;

  if (SK_APP_KEY) {
    try {
      const cars = await skCars(station, dow, hh, updnLine, directAt);
      return res.json({
        station, dow, hh, updnLine, directAt, source: 'sk-api',
        cars: cars.map((c) => ({ congestion: c, level: level(c) }))
      });
    } catch (err) {
      console.warn(`[car] SK API 실패, 데모 데이터로 폴백: ${err.message}`);
      const cars = demoCars(code, dow, hh, updnLine);
      return res.json({
        station, dow, hh, updnLine, directAt, source: 'demo', reason: skErrorReason(err),
        cars: cars.map((c) => ({ congestion: c, level: level(c) }))
      });
    }
  }
  const cars = demoCars(code, dow, hh, updnLine);
  res.json({
    station, dow, hh, updnLine, directAt, source: 'demo',
    cars: cars.map((c) => ({ congestion: c, level: level(c) }))
  });
});

app.listen(PORT, () => {
  console.log(`🚇 crazy-subway 서버 실행 중: http://localhost:${PORT}`);
  console.log(SK_APP_KEY ? 'SK Open API 키 감지됨 (실데이터 모드)' : 'SK_APP_KEY 없음 → 데모 데이터 모드');
});
