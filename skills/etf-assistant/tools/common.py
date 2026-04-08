"""ETF 数据公共模块 — 东方财富（主） / 同花顺（备）双数据源"""

import json
import re
import time
import urllib.request
from pathlib import Path

CACHE_DIR = Path.home() / ".cache" / "ripple-etf"
CACHE_TTL = 300

ETF_CODES = {
    # 宽基
    "510300": "沪深300ETF",
    "510050": "上证50ETF",
    "510500": "中证500ETF",
    "159915": "创业板ETF",
    "588000": "科创50ETF",
    "159845": "中证1000ETF",
    # 行业
    "159997": "芯片ETF",
    "159995": "新能源车ETF",
    "512170": "医疗ETF",
    "512880": "证券ETF",
    "512660": "军工ETF",
    "512800": "银行ETF",
    "512690": "酒ETF",
    "515790": "光伏ETF",
    "159819": "人工智能ETF",
    "159928": "消费ETF",
    # 策略
    "510880": "红利ETF",
    # 跨境
    "513100": "纳指ETF",
    "513500": "标普500ETF",
    "513050": "中概互联ETF",
    # 债券
    "511010": "国债ETF",
    # 商品
    "518880": "黄金ETF",
    "159985": "豆粕ETF",
}

ETF_CATEGORY = {
    "510300": "宽基",
    "510050": "宽基",
    "510500": "宽基",
    "159915": "宽基",
    "588000": "宽基",
    "159845": "宽基",
    "159997": "行业",
    "159995": "行业",
    "512170": "行业",
    "512880": "行业",
    "512660": "行业",
    "512800": "行业",
    "512690": "行业",
    "515790": "行业",
    "159819": "行业",
    "159928": "行业",
    "510880": "策略",
    "513100": "跨境",
    "513500": "跨境",
    "513050": "跨境",
    "511010": "债券",
    "518880": "商品",
    "159985": "商品",
}

_RANGE_LIMIT = {"5d": 5, "1m": 21, "3m": 63, "6m": 126, "1y": 250, "2y": 500, "5y": 1250}
_INTERVAL_KLT = {"1d": 101, "1wk": 102, "1mo": 103}

_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def etf_name(code: str) -> str:
    return ETF_CODES.get(code, f"ETF({code})")


def etf_category(code: str) -> str:
    return ETF_CATEGORY.get(code, "未知")


def _secid(code: str) -> str:
    """上海=1, 深圳=0"""
    return f"1.{code}" if code.startswith(("5", "6")) else f"0.{code}"


# ── 东方财富 ──────────────────────────────────────────────


def _fetch_eastmoney(code: str, range_: str, interval: str) -> dict:
    secid = _secid(code)
    lmt = _RANGE_LIMIT.get(range_, 250)
    klt = _INTERVAL_KLT.get(interval, 101)
    url = (
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get?"
        f"secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
        f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
        f"&klt={klt}&fqt=1&beg=0&end=20500101&lmt={lmt}"
    )
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    if not data.get("data", {}).get("klines"):
        raise ValueError(f"东方财富返回空数据: {code}")
    data["_source"] = "eastmoney"
    return data


def _parse_eastmoney(data: dict) -> tuple[list[dict], dict]:
    result = data.get("data", {})
    meta = {"name": result.get("name", ""), "code": result.get("code", "")}
    bars = []
    for line in result.get("klines", []):
        parts = line.split(",")
        if len(parts) >= 6:
            c = float(parts[2])
            if c > 0:
                bar = {
                    "date": parts[0],
                    "open": float(parts[1]),
                    "close": c,
                    "high": float(parts[3]),
                    "low": float(parts[4]),
                    "volume": int(float(parts[5])),
                    "amount": float(parts[6]) if len(parts) > 6 else 0.0,
                    "change_pct": float(parts[8]) if len(parts) > 8 else 0.0,
                    "turnover": float(parts[10]) if len(parts) > 10 else 0.0,
                }
                bars.append(bar)
    if len(bars) >= 2:
        meta["previousClose"] = bars[-2]["close"]
    return bars, meta


# ── 同花顺 ──────────────────────────────────────────────


def _fetch_10jqka(code: str, range_: str, interval: str) -> dict:
    prefix = "hs" if code.startswith(("5", "6")) else "hs"
    url = f"https://d.10jqka.com.cn/v6/line/{prefix}_{code}/01/last.js"
    headers = {**_HEADERS, "Referer": "https://stockpage.10jqka.com.cn/"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read().decode("utf-8")
    m = re.search(r"\((\{.*\})\)", raw, re.DOTALL)
    if not m:
        raise ValueError(f"同花顺响应解析失败: {code}")
    data = json.loads(m.group(1))
    if not data.get("data"):
        raise ValueError(f"同花顺返回空数据: {code}")
    data["_source"] = "10jqka"
    return data


def _parse_10jqka(data: dict) -> tuple[list[dict], dict]:
    meta = {"name": data.get("name", "")}
    bars = []
    for record in data.get("data", "").split(";"):
        parts = record.strip().split(",")
        if len(parts) < 6:
            continue
        try:
            c = float(parts[4])
            if c > 0:
                bar = {
                    "date": parts[0],
                    "open": float(parts[1]),
                    "close": c,
                    "high": float(parts[2]),
                    "low": float(parts[3]),
                    "volume": int(float(parts[5])),
                    "amount": float(parts[6]) if len(parts) > 6 else 0.0,
                    "change_pct": 0.0,
                    "turnover": 0.0,
                }
                bars.append(bar)
        except (ValueError, IndexError):
            continue
    if len(bars) >= 2:
        meta["previousClose"] = bars[-2]["close"]
    return bars, meta


# ── 公共接口 ──────────────────────────────────────────────


def fetch(code: str, range_: str = "1y", interval: str = "1d") -> dict:
    """获取 ETF 数据，5 分钟本地缓存 + 双数据源自动切换"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{code}_{range_}_{interval}.json"

    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < CACHE_TTL:
        return json.loads(cache_file.read_text())

    errors = []
    for name, fetcher in [("东方财富", _fetch_eastmoney), ("同花顺", _fetch_10jqka)]:
        try:
            data = fetcher(code, range_, interval)
            cache_file.write_text(json.dumps(data, ensure_ascii=False))
            return data
        except Exception as e:
            errors.append(f"{name}: {e}")

    raise RuntimeError(f"无法获取 {code} 的数据: " + "; ".join(errors))


def parse(data: dict) -> tuple[list[dict], dict]:
    """解析 API 响应 → (bars, meta)，每个 bar 含 date/open/close/high/low/volume/amount/change_pct/turnover"""
    source = data.get("_source", "")
    if source == "10jqka":
        return _parse_10jqka(data)
    return _parse_eastmoney(data)


# ── 向后兼容辅助函数 ──────────────────────────────────────


def get_closes(bars: list[dict]) -> list[float]:
    return [b["close"] for b in bars]


def get_highs(bars: list[dict]) -> list[float]:
    return [b["high"] for b in bars]


def get_lows(bars: list[dict]) -> list[float]:
    return [b["low"] for b in bars]


def get_opens(bars: list[dict]) -> list[float]:
    return [b["open"] for b in bars]


def get_volumes(bars: list[dict]) -> list[int]:
    return [b["volume"] for b in bars]
