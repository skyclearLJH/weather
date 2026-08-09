#!/usr/bin/env python3
"""ECMWF IFS·NOAA GFS 네이티브 0.25° 강수 격자를 R2로 적재한다.

왜 이 스크립트가 필요한가
------------------------
Open-Meteo 지점(point) API로 지도를 채우려면 격자 칸마다 좌표를 질의해야 해서,
무료 호출 제한 때문에 2.5°처럼 성긴 격자만 쓸 수 있었다(방송 부적합).
원본 GRIB2는 두 기관 모두 0.25°를 무료로 공개하므로, 여기서 직접 받아
동아시아 영역만 잘라 앱이 바로 읽는 바이너리로 만든다.

핵심 설계(모두 실측으로 확인한 사실에 근거)
-----------------------------------------
* 바이트 범위 subset: 인덱스 파일로 필요한 필드의 offset/length만 알아내
  전 지구 파일(수백 MB) 중 400~700KB만 받는다.
* GRIB2 패킹이 GFS=complex+spatial differencing(tmpl 3), ECMWF=CCSDS(tmpl 42)라
  수작업 언패킹이 불가능하다. 그래서 정식 디코더(cfgrib/eccodes)를 쓴다.
* 경도 원점이 다르다: GFS는 lo1=0°, ECMWF는 lo1=180°. xarray 재정렬로 흡수한다.
* 누적 방식이 다르다: GFS는 6시간 구간 누적(APCP 6-12h)을 그대로 주지만,
  ECMWF tp는 예보 시작부터의 총누적이라 인접 스텝을 차분해야 6시간 값이 된다.
* ECMWF S3가 간헐적으로 503을 준다(실측: 3회 중 2회). 재시도가 필수다.

출력 포맷(앱의 기존 KIM 프레임과 동일한 규약)
--------------------------------------------
uint16 little-endian, 값 = mm × 100 (centimm), 결측 = 65535.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import io
import json
import os
import sys
import tempfile
import time
from typing import Iterable

import boto3
import numpy as np
import requests
import xarray as xr

# 동아시아 표출 영역. 앱의 전구 뷰가 쓰는 범위와 맞춘다.
AREA = {"lon_min": 75.0, "lon_max": 170.0, "lat_min": 5.0, "lat_max": 65.0}
STEP_HOURS = 6
FRAME_COUNT = 40  # 6h × 40 = +240h
MISSING = 65535
SCHEMA_VERSION = "v1"

GFS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
ECMWF_BASE = "https://ecmwf-forecasts.s3.amazonaws.com"

session = requests.Session()
session.headers.update({"User-Agent": "weathernow-model-native/1.0"})


def log(message: str) -> None:
    print(message, flush=True)


def request_with_retry(
    method: str,
    url: str,
    *,
    attempts: int = 5,
    timeout: int = 120,
    **kwargs,
) -> requests.Response | None:
    """503/네트워크 오류를 백오프로 재시도한다. 최종 실패는 None."""
    delay = 2.0
    for attempt in range(1, attempts + 1):
        try:
            response = session.request(method, url, timeout=timeout, **kwargs)
        except requests.RequestException as error:
            if attempt == attempts:
                log(f"    ! {type(error).__name__}: {url}")
                return None
            time.sleep(delay)
            delay = min(delay * 2, 20)
            continue
        if response.status_code in (200, 206):
            return response
        if response.status_code == 404:
            return None  # 아직 발표되지 않은 스텝 — 재시도해도 의미 없다
        if attempt == attempts:
            log(f"    ! HTTP {response.status_code}: {url}")
            return None
        time.sleep(delay)
        delay = min(delay * 2, 20)
    return None


def crop_to_area(field: xr.DataArray) -> tuple[np.ndarray, dict]:
    """전 지구 격자를 동아시아로 자르고 (북→남, 서→동) 순서로 정규화한다.

    경도 원점이 모델마다 다르므로(GFS 0°, ECMWF 180°) 항상 0~360으로 환산한
    뒤 정렬한다. 이 단계를 빼먹으면 지도가 통째로 반대편으로 밀린다.
    """
    lat_name = "latitude" if "latitude" in field.coords else "lat"
    lon_name = "longitude" if "longitude" in field.coords else "lon"

    lon = field[lon_name].values
    lon360 = np.where(lon < 0, lon + 360, lon)
    field = field.assign_coords({lon_name: lon360}).sortby(lon_name)
    field = field.sortby(lat_name, ascending=False)  # 북 → 남

    field = field.sel(
        {
            lat_name: slice(AREA["lat_max"], AREA["lat_min"]),
            lon_name: slice(AREA["lon_min"], AREA["lon_max"]),
        }
    )
    values = np.asarray(field.values, dtype=np.float64)
    grid = {
        "lonMin": float(field[lon_name].values[0]),
        "lonMax": float(field[lon_name].values[-1]),
        "latMin": float(field[lat_name].values[-1]),
        "latMax": float(field[lat_name].values[0]),
        "width": int(field.sizes[lon_name]),
        "height": int(field.sizes[lat_name]),
        "step": 0.25,
        "order": "north-to-south-row-major",
    }
    return values, grid


def encode_centimm(values_mm: np.ndarray) -> bytes:
    """mm 실수 격자 → uint16 centimm. 음수는 0, 결측은 65535."""
    encoded = np.full(values_mm.shape, MISSING, dtype=np.uint16)
    finite = np.isfinite(values_mm)
    scaled = np.clip(np.rint(np.maximum(values_mm[finite], 0.0) * 100.0), 0, MISSING - 1)
    encoded[finite] = scaled.astype(np.uint16)
    return encoded.tobytes(order="C")


def encode_decihpa(values_hpa: np.ndarray) -> bytes:
    """hPa 실수 격자 → uint16 decihPa(hPa×10). 앱의 기존 기압 인코딩과 같다.

    지상 해면기압의 현실적 범위(800~1200hPa)를 벗어나면 결측 처리한다.
    """
    encoded = np.full(values_hpa.shape, MISSING, dtype=np.uint16)
    valid = np.isfinite(values_hpa) & (values_hpa > 800) & (values_hpa < 1200)
    encoded[valid] = np.rint(values_hpa[valid] * 10.0).astype(np.uint16)
    return encoded.tobytes(order="C")


def open_grib_bytes(payload: bytes) -> xr.Dataset:
    """cfgrib은 파일 경로만 받으므로 임시 파일로 넘긴다."""
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as handle:
        handle.write(payload)
        path = handle.name
    try:
        return xr.load_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
    finally:
        for candidate in (path, f"{path}.923a8.idx"):
            try:
                os.remove(candidate)
            except OSError:
                pass


# ---------------------------------------------------------------- GFS

def gfs_cycle_candidates(now: dt.datetime) -> list[str]:
    """최근 발표분부터 과거로. GFS는 발표 후 배포까지 3~5시간 걸린다."""
    anchor = now - dt.timedelta(hours=5)
    anchor = anchor.replace(minute=0, second=0, microsecond=0)
    anchor = anchor.replace(hour=(anchor.hour // 6) * 6)
    return [(anchor - dt.timedelta(hours=6 * index)).strftime("%Y%m%d%H") for index in range(4)]


def gfs_frame_url(cycle: str, lead_hour: int) -> str:
    day, hour = cycle[:8], cycle[8:10]
    return f"{GFS_BASE}/gfs.{day}/{hour}/atmos/gfs.t{hour}z.pgrb2.0p25.f{lead_hour:03d}"


def gfs_fetch_field(cycle: str, lead_hour: int, match: str) -> np.ndarray | None:
    """인덱스에서 match와 일치하는 레코드만 바이트 범위로 받아 격자로 만든다."""
    url = gfs_frame_url(cycle, lead_hour)
    index = request_with_retry("GET", f"{url}.idx", timeout=60)
    if index is None:
        return None

    lines = index.text.strip().split("\n")
    for position, line in enumerate(lines):
        if match not in line:
            continue
        start = int(line.split(":")[1])
        if position + 1 < len(lines):
            end = int(lines[position + 1].split(":")[1]) - 1
            headers = {"Range": f"bytes={start}-{end}"}
        else:
            headers = {"Range": f"bytes={start}-"}
        message = request_with_retry("GET", url, headers=headers)
        if message is None:
            return None
        dataset = open_grib_bytes(message.content)
        field = dataset[list(dataset.data_vars)[0]]
        values, grid = crop_to_area(field)
        gfs_fetch_field.grid = grid  # type: ignore[attr-defined]
        return values
    return None


def gfs_fetch_frame(cycle: str, lead_hour: int) -> np.ndarray | None:
    """APCP 6시간 구간 누적을 mm 격자로 만든다.

    GFS는 '6-12 hour acc' 처럼 구간 누적을 직접 제공하므로 차분이 필요 없다.
    """
    window_start = lead_hour - STEP_HOURS
    values = gfs_fetch_field(
        cycle, lead_hour, f"APCP:surface:{window_start}-{lead_hour} hour acc fcst"
    )
    if values is not None:
        gfs_fetch_frame.grid = getattr(gfs_fetch_field, "grid", None)  # type: ignore[attr-defined]
    return values


def gfs_fetch_pressure(cycle: str, lead_hour: int) -> np.ndarray | None:
    """해면기압(PRMSL, Pa)을 hPa 격자로 만든다. 등압선·고저기압 표시에 쓴다."""
    values = gfs_fetch_field(cycle, lead_hour, "PRMSL:mean sea level")
    return None if values is None else values / 100.0


# ------------------------------------------------------------- ECMWF

def ecmwf_cycle_candidates(now: dt.datetime) -> list[str]:
    """ECMWF 오픈데이터는 00/12Z를 발표 후 약 7~8시간 뒤 공개한다."""
    anchor = now - dt.timedelta(hours=8)
    anchor = anchor.replace(minute=0, second=0, microsecond=0)
    anchor = anchor.replace(hour=0 if anchor.hour < 12 else 12)
    return [(anchor - dt.timedelta(hours=12 * index)).strftime("%Y%m%d%H") for index in range(4)]


def ecmwf_step_urls(cycle: str, step: int) -> tuple[str, str]:
    day, hour = cycle[:8], cycle[8:10]
    stem = f"{ECMWF_BASE}/{day}/{hour}z/ifs/0p25/oper/{day}{hour}0000-{step}h-oper-fc"
    return f"{stem}.index", f"{stem}.grib2"


def ecmwf_fetch_param(cycle: str, step: int, param: str) -> np.ndarray | None:
    """해당 스텝에서 param 레코드만 바이트 범위로 받아 격자로 만든다."""
    index_url, grib_url = ecmwf_step_urls(cycle, step)
    index = request_with_retry("GET", index_url, timeout=60)
    if index is None:
        return None

    for line in index.text.strip().split("\n"):
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("param") != param:
            continue
        start = int(entry["_offset"])
        end = start + int(entry["_length"]) - 1
        message = request_with_retry("GET", grib_url, headers={"Range": f"bytes={start}-{end}"})
        if message is None:
            return None
        dataset = open_grib_bytes(message.content)
        field = dataset[list(dataset.data_vars)[0]]
        values, grid = crop_to_area(field)
        ecmwf_fetch_param.grid = grid  # type: ignore[attr-defined]
        return values
    return None


def ecmwf_fetch_total(cycle: str, step: int) -> np.ndarray | None:
    """해당 스텝의 tp(예보 시작부터의 총 누적, m 단위)를 mm 격자로 반환."""
    values = ecmwf_fetch_param(cycle, step, "tp")
    if values is None:
        return None
    ecmwf_fetch_total.grid = getattr(ecmwf_fetch_param, "grid", None)  # type: ignore[attr-defined]
    return values * 1000.0  # m → mm


def ecmwf_fetch_pressure(cycle: str, step: int) -> np.ndarray | None:
    """해면기압(msl, Pa)을 hPa 격자로 반환."""
    values = ecmwf_fetch_param(cycle, step, "msl")
    return None if values is None else values / 100.0


# --------------------------------------------------------------- R2

@dataclasses.dataclass
class R2Target:
    account_id: str
    access_key_id: str
    secret_access_key: str
    bucket: str

    def client(self):
        return boto3.client(
            "s3",
            endpoint_url=f"https://{self.account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            region_name="auto",
        )


def frame_key(model: str, cycle: str, index: int) -> str:
    return f"models/native/{SCHEMA_VERSION}/{model}/{cycle}/frame-{index:02d}.bin"


def pressure_key(model: str, cycle: str, index: int) -> str:
    return f"models/native/{SCHEMA_VERSION}/{model}/{cycle}/pressure-{index:02d}.bin"


def manifest_key(model: str, cycle: str) -> str:
    return f"models/native/{SCHEMA_VERSION}/{model}/{cycle}/manifest.json"


def latest_key(model: str) -> str:
    return f"models/native/{SCHEMA_VERSION}/{model}/latest.json"


def upload(target: R2Target, key: str, body: bytes, content_type: str) -> None:
    target.client().put_object(
        Bucket=target.bucket, Key=key, Body=body, ContentType=content_type
    )


def object_exists(target: R2Target, key: str) -> bool:
    try:
        target.client().head_object(Bucket=target.bucket, Key=key)
        return True
    except Exception:
        return False


def prune_old_cycles(target: R2Target, model: str, keep: int = 3) -> list[str]:
    """오래된 예보 주기를 지운다.

    주기가 바뀔 때마다 40프레임이 새로 쌓이므로(모델당 약 7MB/주기, 하루 2~4주기)
    정리하지 않으면 R2가 계속 증가한다. 최신 keep개만 남긴다.
    """
    client = target.client()
    prefix = f"models/native/{SCHEMA_VERSION}/{model}/"
    cycles: set[str] = set()
    token = None
    while True:
        kwargs = {"Bucket": target.bucket, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        page = client.list_objects_v2(**kwargs)
        for item in page.get("Contents", []):
            part = item["Key"][len(prefix):].split("/")[0]
            if len(part) == 10 and part.isdigit():
                cycles.add(part)
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")

    expired = sorted(cycles, reverse=True)[keep:]
    for cycle in expired:
        cycle_prefix = f"{prefix}{cycle}/"
        token = None
        while True:
            kwargs = {"Bucket": target.bucket, "Prefix": cycle_prefix, "MaxKeys": 1000}
            if token:
                kwargs["ContinuationToken"] = token
            page = client.list_objects_v2(**kwargs)
            keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
            if keys:
                client.delete_objects(Bucket=target.bucket, Delete={"Objects": keys})
            if not page.get("IsTruncated"):
                break
            token = page.get("NextContinuationToken")
    return expired


# --------------------------------------------------------------- run

def run_model(model: str, target: R2Target, limit: int, force: bool) -> dict:
    now = dt.datetime.now(dt.timezone.utc)
    candidates = gfs_cycle_candidates(now) if model == "gfs" else ecmwf_cycle_candidates(now)

    cycle = None
    for candidate in candidates:
        probe = (
            gfs_fetch_frame(candidate, STEP_HOURS)
            if model == "gfs"
            else ecmwf_fetch_total(candidate, STEP_HOURS)
        )
        if probe is not None:
            cycle = candidate
            log(f"  cycle {candidate} available")
            break
        log(f"  cycle {candidate} not ready")
    if cycle is None:
        return {"model": model, "ok": False, "reason": "no-cycle-available"}

    grid = None
    written = 0
    frames_state: list[bool] = []
    previous_total: np.ndarray | None = None

    for index in range(FRAME_COUNT):
        lead_hour = (index + 1) * STEP_HOURS
        key = frame_key(model, cycle, index)

        if not force and object_exists(target, key):
            frames_state.append(True)
            previous_total = None  # 캐시된 프레임은 차분 기준으로 못 쓴다
            continue
        if written >= limit:
            frames_state.append(False)
            continue

        if model == "gfs":
            values = gfs_fetch_frame(cycle, lead_hour)
            grid = getattr(gfs_fetch_frame, "grid", grid)
        else:
            total = ecmwf_fetch_total(cycle, lead_hour)
            grid = getattr(ecmwf_fetch_total, "grid", grid)
            if total is None:
                values = None
            elif index == 0:
                values = total  # 첫 구간은 누적 자체가 6시간 값
            else:
                base = previous_total
                if base is None:
                    base = ecmwf_fetch_total(cycle, lead_hour - STEP_HOURS)
                values = None if base is None else total - base
            previous_total = total

        if values is None:
            frames_state.append(False)
            log(f"  {model} frame {index:02d} (+{lead_hour}h) unavailable")
            continue

        upload(target, key, encode_centimm(values), "application/octet-stream")

        # 등압선·고저기압용 해면기압. 강수와 같은 격자·같은 시각이며, 없더라도
        # 강수 프레임은 이미 올렸으므로 실패를 치명적으로 다루지 않는다.
        pressure = (
            gfs_fetch_pressure(cycle, lead_hour)
            if model == "gfs"
            else ecmwf_fetch_pressure(cycle, lead_hour)
        )
        if pressure is not None:
            upload(
                target,
                pressure_key(model, cycle, index),
                encode_decihpa(pressure),
                "application/octet-stream",
            )
        else:
            log(f"  {model} pressure {index:02d} unavailable")

        frames_state.append(True)
        written += 1
        log(f"  {model} frame {index:02d} (+{lead_hour}h) uploaded")

    if grid is not None:
        manifest = {
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "model": model,
            "cycle": cycle,
            "grid": grid,
            "stepHours": STEP_HOURS,
            "frameCount": FRAME_COUNT,
            "encoding": "uint16-centimm-le",
            "missingValue": MISSING,
            "unit": "mm/6h",
            "pressureEncoding": "uint16-decihpa-le",
            "pressureUnit": "hPa",
            "frames": frames_state + [False] * (FRAME_COUNT - len(frames_state)),
            "complete": all(frames_state) and len(frames_state) == FRAME_COUNT,
        }
        body = json.dumps(manifest).encode("utf-8")
        upload(target, manifest_key(model, cycle), body, "application/json")
        upload(target, latest_key(model), body, "application/json")

    pruned = []
    try:
        pruned = prune_old_cycles(target, model)
        if pruned:
            log(f"  pruned old cycles: {', '.join(pruned)}")
    except Exception as error:  # 정리 실패가 적재 결과를 무효화하면 안 된다
        log(f"  ! prune skipped: {type(error).__name__}: {error}")

    return {
        "model": model,
        "ok": True,
        "cycle": cycle,
        "uploaded": written,
        "ready": sum(1 for state in frames_state if state),
        "pruned": pruned,
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", default="ecmwf,gfs")
    parser.add_argument("--limit", type=int, default=12, help="이번 실행에서 새로 올릴 최대 프레임 수")
    parser.add_argument("--force", action="store_true", help="이미 있는 프레임도 다시 만든다")
    args = parser.parse_args(list(argv) if argv is not None else None)

    missing = [
        name
        for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
        if not os.environ.get(name)
    ]
    if missing:
        log(f"missing secrets: {', '.join(missing)}")
        return 2

    target = R2Target(
        account_id=os.environ["R2_ACCOUNT_ID"],
        access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        bucket=os.environ.get("R2_BUCKET", "weathernow-model-tiles"),
    )

    results = []
    for model in [name.strip() for name in args.models.split(",") if name.strip()]:
        log(f"== {model} ==")
        try:
            results.append(run_model(model, target, args.limit, args.force))
        except Exception as error:  # 한 모델 실패가 다른 모델을 막지 않게
            log(f"  !! {type(error).__name__}: {error}")
            results.append({"model": model, "ok": False, "reason": str(error)})

    log(json.dumps(results, ensure_ascii=False))
    return 0 if any(result.get("ok") for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
