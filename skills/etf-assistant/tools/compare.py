#!/usr/bin/env python
"""对比两只 ETF 的关键指标"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common
import indicators


def _metrics(code: str) -> dict:
    data = common.fetch(code, "1y", "1d")
    bars, meta = common.parse(data)
    closes = common.get_closes(bars)

    if len(closes) < 20:
        raise ValueError(f"{code} 数据不足")

    cur = closes[-1]
    prev = meta.get("previousClose") or closes[-2]

    periods = {}
    for k, d in [("1W", 5), ("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252)]:
        if len(closes) > d:
            periods[k] = (cur / closes[-(d + 1)] - 1) * 100

    log_r = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i - 1] > 0]
    mean = sum(log_r) / len(log_r)
    std = (sum((r - mean) ** 2 for r in log_r) / (len(log_r) - 1)) ** 0.5
    ann_vol = std * math.sqrt(252) * 100
    n_yr = len(closes) / 252
    ann_ret = ((closes[-1] / closes[0]) ** (1 / n_yr) - 1) * 100 if n_yr > 0 else 0

    peak, max_dd = closes[0], 0.0
    for p in closes:
        peak = max(peak, p)
        max_dd = max(max_dd, (peak - p) / peak)

    hi, lo = max(closes), min(closes)

    rsi_val = indicators.rsi(closes)
    macd_line, signal_line, hist = indicators.macd(closes)

    return {
        "name": common.etf_name(code),
        "price": cur,
        "daily": (cur - prev) / prev * 100 if prev else 0,
        "periods": periods,
        "vol": ann_vol,
        "max_dd": max_dd * 100,
        "sharpe": (ann_ret - 2.0) / ann_vol if ann_vol > 0 else 0,
        "position": (cur - lo) / (hi - lo) * 100 if hi != lo else 50,
        "rsi": rsi_val,
        "macd_hist": hist,
    }


def compare(code1: str, code2: str):
    m1, m2 = _metrics(code1), _metrics(code2)

    print(f"=== {m1['name']}({code1}) vs {m2['name']}({code2}) ===\n")
    fmt = "{:<12} {:<14} {:<14} {:<8}"
    print(fmt.format("指标", code1, code2, "优势方"))
    print("-" * 50)
    print(fmt.format("价格", f"{m1['price']:.4f}", f"{m2['price']:.4f}", ""))
    print(fmt.format("今日", f"{m1['daily']:+.2f}%", f"{m2['daily']:+.2f}%", ""))

    for k in ["1W", "1M", "3M", "6M", "1Y"]:
        v1, v2 = m1["periods"].get(k), m2["periods"].get(k)
        if v1 is not None and v2 is not None:
            w = code1 if v1 > v2 else code2
            print(fmt.format(f"{k}收益", f"{v1:+.2f}%", f"{v2:+.2f}%", w))

    w = code1 if m1["vol"] < m2["vol"] else code2
    print(fmt.format("波动率", f"{m1['vol']:.1f}%", f"{m2['vol']:.1f}%", f"{w}(低)"))
    w = code1 if m1["max_dd"] < m2["max_dd"] else code2
    print(fmt.format("最大回撤", f"{m1['max_dd']:.1f}%", f"{m2['max_dd']:.1f}%", f"{w}(小)"))
    w = code1 if m1["sharpe"] > m2["sharpe"] else code2
    print(fmt.format("夏普比率", f"{m1['sharpe']:.2f}", f"{m2['sharpe']:.2f}", w))
    print(fmt.format("价格位置", f"{m1['position']:.0f}%", f"{m2['position']:.0f}%", ""))

    if m1["rsi"] is not None and m2["rsi"] is not None:
        print(fmt.format("RSI(14)", f"{m1['rsi']:.1f}", f"{m2['rsi']:.1f}", ""))
    if m1["macd_hist"] is not None and m2["macd_hist"] is not None:
        print(fmt.format("MACD柱", f"{m1['macd_hist']:.4f}", f"{m2['macd_hist']:.4f}", ""))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python compare.py <代码1> <代码2>")
        print("示例: python compare.py 510300 159915")
        sys.exit(1)
    try:
        compare(sys.argv[1], sys.argv[2])
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)
