#!/usr/bin/env python3
"""서울 열린데이터광장 실거래 원자료를 구·월 단위로 받아 tools/data/raw/{yyyymm}/{gu}.json 에 저장한다.

사용자가 직접 실행하는 스크립트다 (세션 안에서 실행하지 않는다).
키는 환경 변수 SEOUL_API_KEY 로만 받고, 출력·로그·오류 메시지에 절대 넣지 않는다.

    export SEOUL_API_KEY=...        # 본인 터미널에서만
    python3 tools/data/fetch_raw.py --months 202609,202610 --out tools/data/raw
    node tools/data/aggregate.mjs --raw tools/data/raw --out frontend/public/data --months 202609,202610,202611

저장 형식은 집계기가 읽는 압축형 {"fields": [...], "rows": [[...], ...]} 이며, 집계에 쓰는 다섯 필드
(STDG_NM, THING_AMT, ARCH_AREA, BLDG_USG, RTRCN_DAY)만 담는다. 본번·부번·건물명은 저장하지 않는다.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE_URL = "http://openapi.seoul.go.kr:8088"
SERVICE = "tbLnOpendataRtmsV"
PAGE_SIZE = 1000
MAX_PAGES = 40            # 구·연도당 최대 4만 행. 결과는 최근 계약부터 오므로 목표 달을 지나면 멈춘다.
TIMEOUT = 30
FIELDS = ["STDG_NM", "THING_AMT", "ARCH_AREA", "BLDG_USG", "RTRCN_DAY"]
GU_ORDER = [
    "종로구", "중구", "용산구", "성동구", "광진구", "동대문구", "중랑구", "성북구", "강북구", "도봉구",
    "노원구", "은평구", "서대문구", "마포구", "양천구", "강서구", "구로구", "금천구", "영등포구", "동작구",
    "관악구", "서초구", "강남구", "송파구", "강동구",
]


def fetch_page(key: str, start: int, end: int, year: str, gu: str) -> list[dict]:
    # 선택 인자는 순서대로 RCPT_YR / CGG_CD / CGG_NM. 자치구코드 자리는 공백으로 비운다.
    path = "/".join([urllib.parse.quote(key, safe=""), "json", SERVICE, str(start), str(end),
                     year, "%20", urllib.parse.quote(gu, safe="")])
    url = f"{BASE_URL}/{path}/"
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            data = json.load(resp)
    except (OSError, ValueError):
        # 예외 메시지에 URL(=키)이 섞일 수 있으므로 원인을 붙이지 않는다.
        raise RuntimeError("호출 실패 (네트워크 또는 응답 형식)") from None
    body = (data.get(SERVICE) or data) if isinstance(data, dict) else None
    if not isinstance(body, dict):
        raise RuntimeError("응답 형식이 예상과 다릅니다")
    result = body.get("RESULT") or {}
    code = result.get("CODE", "UNKNOWN")
    if code == "INFO-200":
        return []
    if code != "INFO-000":
        raise RuntimeError(f"서울 열린데이터광장 오류 {code}")
    return body.get("row", [])


def fetch_month(key: str, gu: str, year_month: str) -> list[list]:
    """해당 구·월의 모든 행을 압축형 행(FIELDS 순서)으로 돌려준다."""
    year = year_month[:4]
    out: list[list] = []
    for page in range(MAX_PAGES):
        start = page * PAGE_SIZE + 1
        rows = fetch_page(key, start, start + PAGE_SIZE - 1, year, gu)
        older_seen = False
        for r in rows:
            day = str(r.get("CTRT_DAY", ""))
            if day.startswith(year_month):
                out.append([r.get(f, "") if f != "ARCH_AREA" else r.get(f, 0) for f in FIELDS])
            elif day[:6] < year_month:
                older_seen = True
        # 최근 계약부터 오므로 목표 달보다 오래된 행이 보이면 그 뒤는 볼 필요가 없다.
        if older_seen or len(rows) < PAGE_SIZE:
            break
        time.sleep(0.2)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--months", required=True, help="쉼표로 구분한 YYYYMM 목록")
    ap.add_argument("--out", default="tools/data/raw")
    ap.add_argument("--gus", default=",".join(GU_ORDER), help="쉼표로 구분한 자치구 목록 (기본 25개 전부)")
    args = ap.parse_args()

    key = os.environ.get("SEOUL_API_KEY", "")
    if len(key) < 8:
        print("환경 변수 SEOUL_API_KEY 가 없습니다. 본인 터미널에서 export 한 뒤 다시 실행하세요.", file=sys.stderr)
        return 2

    months = [m.strip() for m in args.months.split(",") if m.strip()]
    gus = [g.strip() for g in args.gus.split(",") if g.strip()]
    out_root = Path(args.out)
    manifest_path = out_root / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text("utf8")) if manifest_path.exists() else {"months": {}}
    manifest.setdefault("projected", True)

    for month in months:
        (out_root / month).mkdir(parents=True, exist_ok=True)
        manifest["months"].setdefault(month, {})
        total = 0
        for gu in gus:
            try:
                rows = fetch_month(key, gu, month)
            except RuntimeError as e:
                print(f"[fetch] {month} {gu}: 실패 ({e}) → 건너뜀", file=sys.stderr)
                continue
            (out_root / month / f"{gu}.json").write_text(
                json.dumps({"fields": FIELDS, "rows": rows}, ensure_ascii=False) + "\n", "utf8")
            manifest["months"][month][gu] = len(rows)
            total += len(rows)
            print(f"[fetch] {month} {gu}: {len(rows)}행")
        manifest["months"][month]["_total"] = total
        print(f"[fetch] {month} 합계 {total}행")

    manifest["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
