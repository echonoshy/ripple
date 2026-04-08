#!/usr/bin/env python
"""单只 ETF 综合分析 — 收益 / 风险 / 趋势 / 量能 / 技术指标"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common
import indicators


def analyze(code: str):
    name = common.etf_name(code)
    data = common.fetch(code, "1y", "1d")
    bars, meta = common.parse(data)
    closes = common.get_closes(bars)
    volumes = common.get_volumes(bars)

    if len(closes) < 20:
        print(f"错误: {name}({code}) 数据不足，无法分析")
        return

    cur = closes[-1]
    prev = meta.get("previousClose") or closes[-2]
    daily = (cur - prev) / prev * 100 if prev else 0

    print(f"=== {name} ({code}) ===")
    print(f"\n[价格]  当前: {cur:.4f}  昨收: {prev:.4f}  今日: {daily:+.2f}%")

    print("\n[收益]")
    for label, d in [("1周", 5), ("1月", 21), ("3月", 63), ("6月", 126), ("1年", 252)]:
        if len(closes) > d:
            pct = (cur / closes[-(d + 1)] - 1) * 100
            print(f"  近{label}: {pct:+.2f}%")

    log_r = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i - 1] > 0]
    if len(log_r) > 10:
        mean = sum(log_r) / len(log_r)
        std = (sum((r - mean) ** 2 for r in log_r) / (len(log_r) - 1)) ** 0.5
        ann_vol = std * math.sqrt(252) * 100
        n_yr = len(closes) / 252
        ann_ret = ((closes[-1] / closes[0]) ** (1 / n_yr) - 1) * 100 if n_yr > 0 else 0
        sharpe = (ann_ret - 2.0) / ann_vol if ann_vol > 0 else 0

        peak, max_dd = closes[0], 0.0
        for p in closes:
            peak = max(peak, p)
            max_dd = max(max_dd, (peak - p) / peak)
        curr_dd = (max(closes) - cur) / max(closes)

        print("\n[风险]")
        print(f"  年化波动率: {ann_vol:.1f}%")
        print(f"  最大回撤: {max_dd * 100:.1f}%")
        print(f"  当前回撤: {curr_dd * 100:.1f}%")
        print(f"  夏普比率: {sharpe:.2f}")

    ma20 = sum(closes[-20:]) / 20
    print("\n[趋势]")
    print(f"  20日均线: {ma20:.4f} ({'上方' if cur > ma20 else '下方'})")

    if len(closes) >= 60:
        ma60 = sum(closes[-60:]) / 60
        print(f"  60日均线: {ma60:.4f} ({'上方' if cur > ma60 else '下方'})")
        if cur > ma20 > ma60:
            print("  判断: 多头排列")
        elif cur < ma20 < ma60:
            print("  判断: 空头排列")
        else:
            print("  判断: 方向不明")

    hi, lo = max(closes), min(closes)
    pos = (cur - lo) / (hi - lo) * 100 if hi != lo else 50
    print(f"  价格位置: {pos:.0f}% (最低{lo:.4f} ~ 最高{hi:.4f})")

    vols = [v for v in volumes[-20:] if v > 0]
    if vols and volumes[-1] > 0:
        avg_v = sum(vols) / len(vols)
        ratio = volumes[-1] / avg_v if avg_v else 0
        status = "显著放量" if ratio > 2 else "温和放量" if ratio > 1.2 else "明显缩量" if ratio < 0.5 else "平稳"
        print(f"\n[成交量]  量比: {ratio:.2f}  {status}")

    # 技术指标
    highs = common.get_highs(bars)
    lows = common.get_lows(bars)

    print("\n[技术指标]")
    rsi = indicators.rsi(closes)
    if rsi is not None:
        rsi_label = "超买" if rsi > 70 else "超卖" if rsi < 30 else "中性"
        print(f"  RSI(14): {rsi:.1f}  {rsi_label}")

    macd_line, signal_line, hist = indicators.macd(closes)
    if macd_line is not None:
        cross = "金叉" if hist > 0 and macd_line > signal_line else "死叉" if hist < 0 else "—"
        print(f"  MACD: DIF={macd_line:.4f}  DEA={signal_line:.4f}  柱={hist:.4f}  {cross}")

    upper, middle, lower = indicators.bollinger(closes)
    if upper is not None:
        boll_pos = (cur - lower) / (upper - lower) * 100 if upper != lower else 50
        print(f"  布林带: 上={upper:.4f}  中={middle:.4f}  下={lower:.4f}  位置={boll_pos:.0f}%")

    k, d, j = indicators.kdj(highs, lows, closes)
    if k is not None:
        kdj_label = "超买" if j > 100 else "超卖" if j < 0 else "中性"
        print(f"  KDJ: K={k:.1f}  D={d:.1f}  J={j:.1f}  {kdj_label}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python analyze.py <ETF代码>")
        print("示例: python analyze.py 510300")
        sys.exit(1)
    try:
        analyze(sys.argv[1])
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)
