# 🚇 crazy-subway — 오늘의 지하철 혼잡도 예측

SK Open API(퍼즐 지하철 혼잡도)의 **역 기준 통계 혼잡도 데이터**를 활용해,
오늘(요일 기준) 시간대별 열차 혼잡도와 칸별 혼잡도를 예측해서 보여주는 웹서비스입니다.

## 주요 기능

- **역 검색**: 서울교통공사 1~8호선 역을 이름으로 검색
- **시간대별 혼잡도 예측**: 오늘 요일 기준 05시~24시 혼잡도를 막대 차트로 표시
  - 현재 시간 강조, 가장 붐비는/여유로운 시간, "지금 vs 1시간 뒤" 비교 조언
- **칸별 혼잡도**: 선택한 시간대의 1~10번째 칸 혼잡도 시각화 + 여유로운 칸 추천
- **방향(상·하행 / 내·외선) 선택** 탭
- **자동 폴백**: API 키가 없거나 SK API 호출이 실패하면 출퇴근 피크 곡선을 반영한
  통계 패턴 기반 데모 데이터로 자동 전환 (화면 상단 배지로 모드 표시)

## 혼잡도 단계

혼잡도(%)는 열차 정원 대비 탑승 인원 비율입니다.

| 단계 | 범위 |
|------|------|
| 여유 | 80% 미만 |
| 보통 | 80~129% |
| 혼잡 | 130~149% |
| 매우 혼잡 | 150% 이상 |

## 실행 방법

```bash
npm install
npm start
# http://localhost:3000
```

### SK Open API 키 연동 (선택)

1. [SK Open API](https://openapi.sk.com)에서 회원가입 후 앱을 생성하고
   **퍼즐(Puzzle) - 지하철 혼잡도** API 사용을 신청해 `appKey`를 발급받습니다.
2. `.env.example`을 복사해 `.env`를 만들고 키를 넣습니다.

```bash
cp .env.example .env
# .env 파일에서 SK_APP_KEY=발급받은키
npm start
```

키가 설정되면 서버가 다음 SK API를 호출합니다.

- `GET /puzzle/subway/congestion/stat/train/stations/{stationCode}?dow={요일}` — 역 기준 통계 열차 혼잡도
- `GET /puzzle/subway/congestion/stat/car/stations/{stationCode}?dow={요일}&hh={시간}` — 역 기준 통계 칸 혼잡도
  (칸별 혼잡도는 `"34|31|31|38|…"` 형태의 구분자 문자열로 반환되며 서버에서 파싱합니다)

## 서버 API

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /api/config` | API 키 설정 여부 |
| `GET /api/stations` | 역 목록 (1~8호선) |
| `GET /api/congestion/daily?code=222[&dow=MON]` | 방향별 시간대 혼잡도 (기본: 오늘 요일) |
| `GET /api/congestion/car?code=222&hh=08&updnLine=0[&dow=MON]` | 특정 시간대 칸별 혼잡도 |

appKey는 서버에서만 사용되므로 브라우저에 노출되지 않습니다.

## 프로젝트 구조

```
├── server.js          # Express 서버 · SK API 프록시 · 데모 데이터 폴백
├── data/stations.js   # 1~8호선 역 코드 목록
└── public/            # 프론트엔드 (바닐라 JS)
    ├── index.html
    ├── style.css
    └── app.js
```
