const LINE_COLORS = {
  1: '#0052A4', 2: '#00A84D', 3: '#EF7C1C', 4: '#00A5DE',
  5: '#996CAC', 6: '#CD7C2F', 7: '#747F00', 8: '#E6186C', 9: '#BDB092'
};
const DOW_KO = { SUN: '일요일', MON: '월요일', TUE: '화요일', WED: '수요일', THU: '목요일', FRI: '금요일', SAT: '토요일' };
const LEVEL_CLASS = { '여유': 'lv-여유', '보통': 'lv-보통', '혼잡': 'lv-혼잡', '매우 혼잡': 'lv-매우혼잡' };
const LEVEL_COLOR = { '여유': '#22c55e', '보통': '#eab308', '혼잡': '#f97316', '매우 혼잡': '#ef4444' };

const $ = (sel) => document.querySelector(sel);

// 서울 지하철 서비스이므로 사용자의 로컬 타임존과 무관하게 KST(UTC+9) 기준
const kstHour = () => String(new Date(Date.now() + 9 * 3600 * 1000).getUTCHours()).padStart(2, '0');

const state = {
  stations: [],
  station: null,     // 선택한 역
  daily: null,       // /api/congestion/daily 응답
  dirIndex: 0,       // 선택한 방향 인덱스
  selectedHh: null   // 차트에서 선택한 시간
};

init();

async function init() {
  const [cfg, st] = await Promise.all([
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/stations').then((r) => r.json())
  ]);
  state.stations = st.stations;

  const badge = $('#sourceBadge');
  badge.hidden = false;
  if (cfg.hasApiKey) {
    badge.textContent = 'SK Open API 연동됨';
    badge.className = 'badge badge-live';
  } else {
    badge.textContent = '데모 모드 (SK_APP_KEY 미설정 · 통계 패턴 데이터)';
    badge.className = 'badge badge-demo';
  }

  setupSearch();
}

/* ---------------- 역 검색 ---------------- */
function setupSearch() {
  const input = $('#searchInput');
  const results = $('#searchResults');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) { results.hidden = true; return; }
    const matches = state.stations
      .filter((s) => s.name.includes(q))
      .slice(0, 12);
    if (matches.length === 0) { results.hidden = true; return; }
    results.innerHTML = matches
      .map((s, i) => `
        <li data-i="${i}" data-code="${s.code}">
          <span class="line-badge" style="background:${LINE_COLORS[s.line]}">${s.line}</span>
          <span>${s.name}</span>
        </li>`)
      .join('');
    results.hidden = false;
    results.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => {
        const s = state.stations.find((x) => x.code === li.dataset.code);
        results.hidden = true;
        input.value = `${s.name} (${s.line}호선)`;
        selectStation(s);
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) results.hidden = true;
  });
}

/* ---------------- 데이터 로드 ---------------- */
async function selectStation(station) {
  state.station = station;
  state.dirIndex = 0;
  state.selectedHh = null;

  const res = await fetch(`/api/congestion/daily?code=${station.code}`);
  state.daily = await res.json();

  // 배지를 실제 응답 출처 기준으로 갱신 (키가 있어도 API 실패 시 데모로 폴백될 수 있음)
  const badge = $('#sourceBadge');
  if (state.daily.source === 'sk-api') {
    badge.textContent = 'SK Open API 실데이터';
    badge.className = 'badge badge-live';
  } else {
    const reasons = {
      quota: '데모 데이터 — SK API 일일 쿼터 소진 (자정 이후 리셋)',
      auth: '데모 데이터 — API 키/상품 권한 오류 (포털에서 확인)',
      error: '데모 데이터 — SK API 오류 (서버 로그 확인)'
    };
    badge.textContent = reasons[state.daily.reason] || '데모 데이터 (통계 패턴)';
    badge.className = 'badge badge-demo';
  }

  $('#empty').hidden = true;
  $('#result').hidden = false;
  render();
}

/* ---------------- 렌더링 ---------------- */
function render() {
  const { station, daily } = state;
  const dir = daily.directions[state.dirIndex];

  // 역 카드
  const lineBadge = $('#lineBadge');
  lineBadge.textContent = station.line;
  lineBadge.style.background = LINE_COLORS[station.line];
  $('#stationName').textContent = station.name;
  $('#dowLabel').textContent = `오늘 · ${DOW_KO[daily.dow]} 기준 예측`;

  // 방향 탭
  const tabs = $('#dirTabs');
  tabs.innerHTML = daily.directions
    .map((d, i) => `<button class="dir-tab ${i === state.dirIndex ? 'active' : ''}" data-i="${i}">${d.label}</button>`)
    .join('');
  tabs.querySelectorAll('.dir-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.dirIndex = Number(btn.dataset.i);
      state.selectedHh = null;
      render();
    });
  });

  renderSummary(dir);
  renderChart(dir);

  const nowHh = kstHour();
  const hh = state.selectedHh || clampHour(nowHh, dir);
  loadCars(hh);
}

function clampHour(hh, dir) {
  const available = dir.hours.filter((h) => h.congestion !== null).map((h) => h.hh);
  if (available.includes(hh)) return hh;
  return available[0] || '08';
}

function renderSummary(dir) {
  const valid = dir.hours.filter((h) => h.congestion !== null);
  if (valid.length === 0) { $('#summary').innerHTML = ''; return; }

  const nowHh = kstHour();
  const now = valid.find((h) => h.hh === nowHh);
  const peak = valid.reduce((a, b) => (b.congestion > a.congestion ? b : a));
  const calm = valid.reduce((a, b) => (b.congestion < a.congestion ? b : a));

  const cards = [];
  if (now) {
    cards.push(card('지금 이 시간대', `${now.level} · ${now.congestion}%`, `${Number(now.hh)}시 예측치`, LEVEL_COLOR[now.level]));
  }
  cards.push(card('가장 붐비는 시간', `${Number(peak.hh)}시`, `${peak.level} · ${peak.congestion}%`, LEVEL_COLOR[peak.level]));
  cards.push(card('가장 여유로운 시간', `${Number(calm.hh)}시`, `${calm.level} · ${calm.congestion}%`, LEVEL_COLOR[calm.level]));

  // 지금 vs 1시간 뒤 조언
  if (now) {
    const next = valid.find((h) => Number(h.hh) === Number(nowHh) + 1);
    if (next) {
      const diff = next.congestion - now.congestion;
      const advice = diff > 10 ? '지금 출발이 유리해요 📈' : diff < -10 ? '1시간 뒤가 더 여유로워요 📉' : '1시간 내 큰 차이 없어요';
      cards.push(card('1시간 뒤와 비교', advice, `1시간 뒤 예측 ${next.congestion}% (${diff >= 0 ? '+' : ''}${diff}%p)`, 'var(--text)'));
    }
  }
  $('#summary').innerHTML = cards.join('');
}

function card(label, value, sub, color) {
  return `
    <div class="summary-card">
      <div class="label">${label}</div>
      <div class="value" style="color:${color}">${value}</div>
      <div class="sub">${sub}</div>
    </div>`;
}

function renderChart(dir) {
  const chart = $('#chart');
  const nowHh = kstHour();
  const max = Math.max(150, ...dir.hours.map((h) => h.congestion || 0));

  chart.innerHTML = dir.hours
    .map((h) => {
      const pct = h.congestion === null ? 0 : Math.round((h.congestion / max) * 100);
      const cls = h.level ? LEVEL_CLASS[h.level] : '';
      const isNow = h.hh === nowHh;
      const isSel = h.hh === state.selectedHh;
      return `
        <div class="bar-wrap ${isNow ? 'now' : ''} ${isSel ? 'selected' : ''}" data-hh="${h.hh}"
             title="${Number(h.hh)}시 · ${h.congestion === null ? '데이터 없음' : `${h.congestion}% (${h.level})`}">
          ${h.congestion !== null ? `<div class="bar-pct">${h.congestion}</div>` : ''}
          <div class="bar ${cls}" style="height:${pct}%"></div>
          <div class="bar-hour">${Number(h.hh)}</div>
        </div>`;
    })
    .join('');

  chart.querySelectorAll('.bar-wrap').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedHh = el.dataset.hh;
      chart.querySelectorAll('.bar-wrap').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      loadCars(state.selectedHh);
    });
  });
}

/* ---------------- 칸별 혼잡도 ---------------- */
async function loadCars(hh) {
  const { station, daily } = state;
  const dir = daily.directions[state.dirIndex];
  const updnLine = dir.updnLine ?? state.dirIndex;
  const directAt = dir.directAt ?? 0;

  $('#carTitle').textContent = `칸별 혼잡도 · ${Number(hh)}시 (${dir.label})`;

  const res = await fetch(`/api/congestion/car?code=${station.code}&hh=${hh}&updnLine=${updnLine}&directAt=${directAt}&dow=${daily.dow}`);
  const data = await res.json();
  const cars = data.cars;

  const minC = Math.min(...cars.map((c) => c.congestion));
  const bestIdx = cars.findIndex((c) => c.congestion === minC);

  $('#train').innerHTML = cars
    .map((c, i) => `
      <div class="car ${i === bestIdx ? 'best' : ''}" style="background:${LEVEL_COLOR[c.level]}"
           title="${i + 1}번째 칸 · ${c.congestion}% (${c.level})">
        <div class="car-no">${i + 1}칸</div>
        <div class="car-pct">${c.congestion}%</div>
      </div>`)
    .join('');

  const calmCars = cars
    .map((c, i) => ({ i: i + 1, c: c.congestion }))
    .sort((a, b) => a.c - b.c)
    .slice(0, 3);
  let tip =
    `여유로운 칸 추천: ${calmCars.map((x) => `${x.i}번째 칸(${x.c}%)`).join(', ')} — ` +
    `혼잡도는 열차 정원 대비 탑승 비율(%)입니다.`;
  // 차트는 실데이터인데 칸별만 폴백된 경우 명확히 알린다
  if (data.source === 'demo' && daily.source === 'sk-api') {
    const why = data.reason === 'quota'
      ? 'SK API 일일 쿼터가 소진되어'
      : '칸 혼잡도 API 호출에 실패해';
    tip = `⚠️ ${why} 칸별 데이터는 데모(통계 패턴)로 표시 중입니다.\n${tip}`;
  }
  $('#carTip').textContent = tip;
}
