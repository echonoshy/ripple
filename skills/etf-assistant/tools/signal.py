#!/usr/bin/env python
"""多因子交易信号系统 — 趋势/动量/波动/量能/形态 五因子综合评分"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common
import indicators

# ── 因子权重 ──────────────────────────────────────────────

WEIGHTS = {
    "trend": 0.30,
    "momentum": 0.25,
    "volatility": 0.20,
    "volume": 0.15,
    "pattern": 0.10,
}

SIGNAL_LEVELS = [
    (80, "强烈买入", "██████████"),
    (65, "买入", "████████░░"),
    (50, "观望偏多", "██████░░░░"),
    (40, "观望", "████░░░░░░"),
    (25, "卖出", "██░░░░░░░░"),
    (0, "强烈卖出", "░░░░░░░░░░"),
]


def _clamp(val: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, val))


# ── 趋势因子 (30%) ──────────────────────────────────────


def _score_trend(closes: list[float]) -> tuple[float, list[str]]:
    """均线排列 + 价格位置 → 0-100"""
    signals = []
    score = 50.0

    if len(closes) < 60:
        return 50.0, ["数据不足，趋势因子中性"]

    cur = closes[-1]
    ma5 = sum(closes[-5:]) / 5
    ma20 = sum(closes[-20:]) / 20
    ma60 = sum(closes[-60:]) / 60

    if cur > ma5 > ma20 > ma60:
        score = 85
        signals.append("完美多头排列 (价格>MA5>MA20>MA60)")
    elif cur > ma20 > ma60:
        score = 72
        signals.append("多头排列 (价格>MA20>MA60)")
    elif cur > ma20:
        score = 60
        signals.append("短期偏强 (价格>MA20)")
    elif cur < ma5 < ma20 < ma60:
        score = 15
        signals.append("完美空头排列 (价格<MA5<MA20<MA60)")
    elif cur < ma20 < ma60:
        score = 28
        signals.append("空头排列 (价格<MA20<MA60)")
    elif cur < ma20:
        score = 40
        signals.append("短期偏弱 (价格<MA20)")
    else:
        score = 50
        signals.append("均线纠缠，方向不明")

    hi, lo = max(closes), min(closes)
    pos = (cur - lo) / (hi - lo) * 100 if hi != lo else 50
    if pos < 20:
        score = _clamp(score + 10)
        signals.append(f"价格位置 {pos:.0f}%，接近低点")
    elif pos > 80:
        score = _clamp(score - 10)
        signals.append(f"价格位置 {pos:.0f}%，接近高点")

    if len(closes) >= 120:
        ma120 = sum(closes[-120:]) / 120
        if cur > ma120:
            score = _clamp(score + 5)
        else:
            score = _clamp(score - 5)
            signals.append("跌破半年线 (MA120)")

    return _clamp(score), signals


# ── 动量因子 (25%) ──────────────────────────────────────


def _score_momentum(closes: list[float]) -> tuple[float, list[str]]:
    """RSI + MACD → 0-100"""
    signals = []
    scores = []

    rsi_val = indicators.rsi(closes)
    if rsi_val is not None:
        if rsi_val < 20:
            scores.append(90)
            signals.append(f"RSI={rsi_val:.1f} 极度超卖，反弹概率高")
        elif rsi_val < 30:
            scores.append(75)
            signals.append(f"RSI={rsi_val:.1f} 超卖区")
        elif rsi_val > 80:
            scores.append(10)
            signals.append(f"RSI={rsi_val:.1f} 极度超买，回调风险大")
        elif rsi_val > 70:
            scores.append(25)
            signals.append(f"RSI={rsi_val:.1f} 超买区")
        elif rsi_val > 50:
            scores.append(60)
            signals.append(f"RSI={rsi_val:.1f} 偏强")
        else:
            scores.append(40)
            signals.append(f"RSI={rsi_val:.1f} 偏弱")

    dif, dea, hist = indicators.macd(closes)
    if dif is not None:
        dif_list, dea_list, hist_list = indicators.macd_series(closes)
        if len(hist_list) >= 2:
            if hist > 0 and hist_list[-2] <= 0:
                scores.append(85)
                signals.append("MACD 金叉确认")
            elif hist < 0 and hist_list[-2] >= 0:
                scores.append(15)
                signals.append("MACD 死叉确认")
            elif hist > 0 and hist > hist_list[-2]:
                scores.append(70)
                signals.append("MACD 红柱放大")
            elif hist > 0 and hist < hist_list[-2]:
                scores.append(55)
                signals.append("MACD 红柱缩短")
            elif hist < 0 and abs(hist) < abs(hist_list[-2]):
                scores.append(45)
                signals.append("MACD 绿柱缩短，动能减弱")
            elif hist < 0:
                scores.append(30)
                signals.append("MACD 绿柱区域")

    return _clamp(sum(scores) / len(scores)) if scores else 50.0, signals


# ── 波动因子 (20%) ──────────────────────────────────────


def _score_volatility(closes: list[float], highs: list[float], lows: list[float]) -> tuple[float, list[str]]:
    """布林带位置 + ATR 变化 → 0-100"""
    signals = []
    score = 50.0

    upper, middle, lower = indicators.bollinger(closes)
    if upper is not None and upper != lower:
        cur = closes[-1]
        boll_pos = (cur - lower) / (upper - lower) * 100

        if boll_pos < 10:
            score = 80
            signals.append("价格触及布林带下轨，可能超卖反弹")
        elif boll_pos < 25:
            score = 65
            signals.append(f"价格接近布林带下轨 ({boll_pos:.0f}%)")
        elif boll_pos > 90:
            score = 20
            signals.append("价格触及布林带上轨，可能超买回调")
        elif boll_pos > 75:
            score = 35
            signals.append(f"价格接近布林带上轨 ({boll_pos:.0f}%)")
        else:
            score = 50
            signals.append(f"价格在布林带中间区域 ({boll_pos:.0f}%)")

        bw = (upper - lower) / middle * 100 if middle > 0 else 0
        if bw < 3:
            signals.append(f"布林带极度收窄 ({bw:.1f}%)，变盘在即")
        elif bw > 15:
            signals.append(f"布林带大幅展开 ({bw:.1f}%)，波动剧烈")

    atr_vals = indicators.atr_series(highs, lows, closes)
    if len(atr_vals) >= 20:
        recent_atr = atr_vals[-1]
        avg_atr = sum(atr_vals[-20:]) / 20
        if avg_atr > 0:
            ratio = recent_atr / avg_atr
            if ratio > 1.5:
                score = _clamp(score - 10)
                signals.append(f"ATR 突增 ({ratio:.1f}x)，波动加剧")
            elif ratio < 0.6:
                signals.append(f"ATR 收缩 ({ratio:.1f}x)，波动降低")

    return _clamp(score), signals


# ── 量能因子 (15%) ──────────────────────────────────────


def _score_volume(closes: list[float], volumes: list[int]) -> tuple[float, list[str]]:
    """量比 + 量价配合 → 0-100"""
    signals = []
    score = 50.0

    if len(volumes) < 20 or volumes[-1] <= 0:
        return 50.0, ["成交量数据不足"]

    valid_vols = [v for v in volumes[-20:] if v > 0]
    if not valid_vols:
        return 50.0, ["无有效成交量"]

    avg_v = sum(valid_vols) / len(valid_vols)
    ratio = volumes[-1] / avg_v if avg_v > 0 else 1.0

    price_up = closes[-1] > closes[-2] if len(closes) >= 2 else False
    price_down = closes[-1] < closes[-2] if len(closes) >= 2 else False

    if ratio > 2.0 and price_up:
        score = 80
        signals.append(f"放量上涨 (量比{ratio:.1f})，资金流入明显")
    elif ratio > 1.5 and price_up:
        score = 70
        signals.append(f"温和放量上涨 (量比{ratio:.1f})")
    elif ratio > 2.0 and price_down:
        score = 20
        signals.append(f"放量下跌 (量比{ratio:.1f})，恐慌抛售")
    elif ratio > 1.5 and price_down:
        score = 30
        signals.append(f"放量下跌 (量比{ratio:.1f})")
    elif ratio < 0.5 and price_up:
        score = 40
        signals.append(f"缩量上涨 (量比{ratio:.1f})，上涨乏力")
    elif ratio < 0.5 and price_down:
        score = 55
        signals.append(f"缩量下跌 (量比{ratio:.1f})，下跌动能衰减")
    elif ratio < 0.5:
        score = 45
        signals.append(f"明显缩量 (量比{ratio:.1f})")
    else:
        score = 50
        signals.append(f"量能平稳 (量比{ratio:.1f})")

    return _clamp(score), signals


# ── 形态因子 (10%) ──────────────────────────────────────


def _score_pattern(highs: list[float], lows: list[float], closes: list[float]) -> tuple[float, list[str]]:
    """KDJ + 近期形态 → 0-100"""
    signals = []
    scores = []

    k, d, j = indicators.kdj(highs, lows, closes)
    if k is not None:
        if j < 0:
            scores.append(80)
            signals.append(f"KDJ J值={j:.0f} 超卖区")
        elif j < 20 and k < d:
            scores.append(70)
            signals.append(f"KDJ 低位 (K={k:.0f} D={d:.0f})")
        elif j > 100:
            scores.append(20)
            signals.append(f"KDJ J值={j:.0f} 超买区")
        elif j > 80 and k > d:
            scores.append(30)
            signals.append(f"KDJ 高位 (K={k:.0f} D={d:.0f})")
        elif k > d:
            scores.append(60)
            signals.append("KDJ K>D 偏多")
        else:
            scores.append(40)
            signals.append("KDJ K<D 偏空")

    if len(closes) >= 5:
        consecutive_up = 0
        consecutive_down = 0
        for i in range(-1, -6, -1):
            if closes[i] > closes[i - 1]:
                consecutive_up += 1
            elif closes[i] < closes[i - 1]:
                consecutive_down += 1
            else:
                break
        if consecutive_up >= 4:
            scores.append(35)
            signals.append(f"连涨{consecutive_up}日，注意回调")
        elif consecutive_down >= 4:
            scores.append(65)
            signals.append(f"连跌{consecutive_down}日，可能反弹")

    return _clamp(sum(scores) / len(scores)) if scores else 50.0, signals


# ── 综合评分 ──────────────────────────────────────────────


def compute_signal(code: str) -> dict:
    """计算单只 ETF 的综合信号评分"""
    data = common.fetch(code, "1y", "1d")
    bars, meta = common.parse(data)
    closes = common.get_closes(bars)
    highs = common.get_highs(bars)
    lows = common.get_lows(bars)
    volumes = common.get_volumes(bars)

    if len(closes) < 30:
        return {"code": code, "name": common.etf_name(code), "error": "数据不足"}

    factors = {}
    all_signals = []

    trend_score, trend_signals = _score_trend(closes)
    factors["trend"] = trend_score
    all_signals.extend(trend_signals)

    mom_score, mom_signals = _score_momentum(closes)
    factors["momentum"] = mom_score
    all_signals.extend(mom_signals)

    vol_score, vol_signals = _score_volatility(closes, highs, lows)
    factors["volatility"] = vol_score
    all_signals.extend(vol_signals)

    volume_score, volume_signals = _score_volume(closes, volumes)
    factors["volume"] = volume_score
    all_signals.extend(volume_signals)

    pattern_score, pattern_signals = _score_pattern(highs, lows, closes)
    factors["pattern"] = pattern_score
    all_signals.extend(pattern_signals)

    total = sum(factors[k] * WEIGHTS[k] for k in WEIGHTS)

    level = "强烈卖出"
    bar = "░░░░░░░░░░"
    for threshold, label, b in SIGNAL_LEVELS:
        if total >= threshold:
            level = label
            bar = b
            break

    position_pct = 0
    if total >= 75:
        position_pct = 80
    elif total >= 65:
        position_pct = 60
    elif total >= 55:
        position_pct = 40
    elif total >= 45:
        position_pct = 20
    elif total >= 35:
        position_pct = 10
    else:
        position_pct = 0

    cur = closes[-1]
    prev = meta.get("previousClose") or closes[-2]
    daily = (cur - prev) / prev * 100 if prev else 0

    return {
        "code": code,
        "name": common.etf_name(code),
        "category": common.etf_category(code),
        "price": cur,
        "daily": daily,
        "total_score": total,
        "level": level,
        "bar": bar,
        "position_pct": position_pct,
        "factors": factors,
        "signals": all_signals,
    }


# ── 输出 ──────────────────────────────────────────────

FACTOR_NAMES = {
    "trend": "趋势",
    "momentum": "动量",
    "volatility": "波动",
    "volume": "量能",
    "pattern": "形态",
}


def print_signal(result: dict):
    if "error" in result:
        print(f"  {result['name']}({result['code']}): {result['error']}")
        return

    r = result
    print(f"=== {r['name']} ({r['code']}) 交易信号 ===\n")
    print(f"  综合评分: {r['total_score']:.0f}/100  {r['bar']}  【{r['level']}】")
    print(f"  当前价格: {r['price']:.4f}  今日: {r['daily']:+.2f}%")
    print(f"  建议仓位: {r['position_pct']}%\n")

    print("  [因子明细]")
    for key, weight in WEIGHTS.items():
        score = r["factors"][key]
        name = FACTOR_NAMES[key]
        pct = int(weight * 100)
        level = "强" if score >= 65 else "弱" if score <= 35 else "中"
        print(f"    {name}({pct}%): {score:.0f}分  [{level}]")

    print("\n  [关键信号]")
    for s in r["signals"]:
        print(f"    • {s}")

    print("\n  ⚠ 以上信号基于技术指标量化计算，仅供参考，不构成投资建议。")


def main():
    if len(sys.argv) < 2:
        print("用法: python signal.py <ETF代码> [代码2] [代码3] ...")
        print("示例: python signal.py 510300")
        print("      python signal.py 510300 159915 518880")
        sys.exit(1)

    codes = sys.argv[1:]
    results = []
    for code in codes:
        try:
            results.append(compute_signal(code))
        except Exception as e:
            print(f"错误: {code} - {e}")

    if len(results) == 1:
        print_signal(results[0])
    elif len(results) > 1:
        print("=== 批量信号扫描 ===\n")
        fmt = "{:<14} {:<6} {:>8} {:>6}  {:<10} {:<8}"
        print(fmt.format("名称", "代码", "价格", "今日", "评分", "信号"))
        print("-" * 62)
        results.sort(key=lambda x: x.get("total_score", 0), reverse=True)
        for r in results:
            if "error" in r:
                print(f"  {r['name']:<12} {r['code']:<6}  {r['error']}")
                continue
            print(
                fmt.format(
                    r["name"],
                    r["code"],
                    f"{r['price']:.3f}",
                    f"{r['daily']:+.1f}%",
                    f"{r['total_score']:.0f} {r['bar']}",
                    r["level"],
                )
            )
        print("\n  ⚠ 以上信号基于技术指标量化计算，仅供参考，不构成投资建议。")


if __name__ == "__main__":
    main()
