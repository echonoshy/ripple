"""技术指标计算库 — 纯标准库实现，无第三方依赖"""

import math


def sma(data: list[float], period: int) -> list[float]:
    """简单移动平均"""
    if len(data) < period:
        return []
    result = []
    window_sum = sum(data[:period])
    result.append(window_sum / period)
    for i in range(period, len(data)):
        window_sum += data[i] - data[i - period]
        result.append(window_sum / period)
    return result


def ema(data: list[float], period: int) -> list[float]:
    """指数移动平均"""
    if len(data) < period:
        return []
    k = 2 / (period + 1)
    result = [sum(data[:period]) / period]
    for i in range(period, len(data)):
        result.append(data[i] * k + result[-1] * (1 - k))
    return result


def rsi(closes: list[float], period: int = 14) -> float | None:
    """相对强弱指标，返回最新 RSI 值"""
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def rsi_series(closes: list[float], period: int = 14) -> list[float]:
    """返回完整 RSI 序列"""
    if len(closes) < period + 1:
        return []
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    result = []
    if avg_loss == 0:
        result.append(100.0)
    else:
        result.append(100 - 100 / (1 + avg_gain / avg_loss))

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        if avg_loss == 0:
            result.append(100.0)
        else:
            result.append(100 - 100 / (1 + avg_gain / avg_loss))
    return result


def macd(
    closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[float | None, float | None, float | None]:
    """MACD 指标，返回 (DIF, DEA, MACD柱) 最新值"""
    if len(closes) < slow + signal:
        return None, None, None
    fast_ema = ema(closes, fast)
    slow_ema = ema(closes, slow)
    dif = [f - s for f, s in zip(fast_ema[-len(slow_ema) :], slow_ema)]
    if len(dif) < signal:
        return None, None, None
    dea = ema(dif, signal)
    if not dea:
        return None, None, None
    hist = (dif[-1] - dea[-1]) * 2
    return dif[-1], dea[-1], hist


def macd_series(
    closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[list[float], list[float], list[float]]:
    """返回完整 MACD 序列 (DIF, DEA, MACD柱)"""
    if len(closes) < slow + signal:
        return [], [], []
    fast_ema = ema(closes, fast)
    slow_ema = ema(closes, slow)
    dif = [f - s for f, s in zip(fast_ema[-len(slow_ema) :], slow_ema)]
    dea = ema(dif, signal)
    n = len(dea)
    dif_tail = dif[-n:]
    hist = [(d - e) * 2 for d, e in zip(dif_tail, dea)]
    return dif_tail, dea, hist


def bollinger(
    closes: list[float], period: int = 20, num_std: float = 2.0
) -> tuple[float | None, float | None, float | None]:
    """布林带，返回 (上轨, 中轨, 下轨) 最新值"""
    if len(closes) < period:
        return None, None, None
    window = closes[-period:]
    middle = sum(window) / period
    variance = sum((x - middle) ** 2 for x in window) / period
    std = math.sqrt(variance)
    return middle + num_std * std, middle, middle - num_std * std


def kdj(
    highs: list[float], lows: list[float], closes: list[float], period: int = 9
) -> tuple[float | None, float | None, float | None]:
    """KDJ 随机指标，返回 (K, D, J) 最新值"""
    n = len(closes)
    if n < period or len(highs) < period or len(lows) < period:
        return None, None, None

    k_val, d_val = 50.0, 50.0
    for i in range(period - 1, n):
        hh = max(highs[i - period + 1 : i + 1])
        ll = min(lows[i - period + 1 : i + 1])
        rsv = (closes[i] - ll) / (hh - ll) * 100 if hh != ll else 50
        k_val = 2 / 3 * k_val + 1 / 3 * rsv
        d_val = 2 / 3 * d_val + 1 / 3 * k_val

    j_val = 3 * k_val - 2 * d_val
    return k_val, d_val, j_val


def atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> float | None:
    """真实波动幅度均值 (ATR)，返回最新值"""
    n = len(closes)
    if n < period + 1 or len(highs) < n or len(lows) < n:
        return None

    true_ranges = []
    for i in range(1, n):
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        true_ranges.append(tr)

    if len(true_ranges) < period:
        return None
    atr_val = sum(true_ranges[:period]) / period
    for i in range(period, len(true_ranges)):
        atr_val = (atr_val * (period - 1) + true_ranges[i]) / period
    return atr_val


def atr_series(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> list[float]:
    """返回完整 ATR 序列"""
    n = len(closes)
    if n < period + 1 or len(highs) < n or len(lows) < n:
        return []

    true_ranges = []
    for i in range(1, n):
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        true_ranges.append(tr)

    if len(true_ranges) < period:
        return []
    atr_val = sum(true_ranges[:period]) / period
    result = [atr_val]
    for i in range(period, len(true_ranges)):
        atr_val = (atr_val * (period - 1) + true_ranges[i]) / period
        result.append(atr_val)
    return result


if __name__ == "__main__":
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).parent))
    import common

    code = sys.argv[1] if len(sys.argv) > 1 else "510300"
    data = common.fetch(code, "1y", "1d")
    bars, meta = common.parse(data)
    c = common.get_closes(bars)
    h = common.get_highs(bars)
    lo = common.get_lows(bars)

    print(f"=== {common.etf_name(code)} 技术指标 ===")
    print(f"RSI(14): {rsi(c):.1f}")
    dif, dea, hist = macd(c)
    print(f"MACD: DIF={dif:.4f} DEA={dea:.4f} 柱={hist:.4f}")
    upper, mid, lower = bollinger(c)
    print(f"布林带: 上={upper:.4f} 中={mid:.4f} 下={lower:.4f}")
    k, d, j = kdj(h, lo, c)
    print(f"KDJ: K={k:.1f} D={d:.1f} J={j:.1f}")
    print(f"ATR(14): {atr(h, lo, c):.4f}")
