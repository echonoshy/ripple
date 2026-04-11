#!/usr/bin/env python
"""风险预警扫描 — 回撤/波动率/量能/连跌/破位 五维预警"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common
import indicators

RISK_LEVELS = {
    0: ("低风险", "🟢"),
    1: ("中风险", "🟡"),
    2: ("高风险", "🟠"),
    3: ("极高风险", "🔴"),
}


def _check_drawdown(closes: list[float]) -> list[dict]:
    """回撤预警"""
    alerts = []
    if len(closes) < 20:
        return alerts

    peak = max(closes)
    cur = closes[-1]
    curr_dd = (peak - cur) / peak * 100

    recent_peak = max(closes[-60:]) if len(closes) >= 60 else max(closes)
    recent_dd = (recent_peak - cur) / recent_peak * 100

    if curr_dd > 30:
        alerts.append({"level": 3, "type": "回撤", "msg": f"历史回撤 {curr_dd:.1f}%，距高点跌幅巨大"})
    elif curr_dd > 20:
        alerts.append({"level": 2, "type": "回撤", "msg": f"历史回撤 {curr_dd:.1f}%，处于深度调整"})
    elif curr_dd > 10:
        alerts.append({"level": 1, "type": "回撤", "msg": f"历史回撤 {curr_dd:.1f}%，中度调整"})

    if recent_dd > 15:
        alerts.append({"level": 2, "type": "回撤", "msg": f"近期回撤 {recent_dd:.1f}% (60日高点)"})
    elif recent_dd > 8:
        alerts.append({"level": 1, "type": "回撤", "msg": f"近期回撤 {recent_dd:.1f}% (60日高点)"})

    return alerts


def _check_volatility(closes: list[float]) -> list[dict]:
    """波动率异常预警"""
    alerts = []
    if len(closes) < 65:
        return alerts

    def _vol(prices: list[float]) -> float:
        log_r = [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices)) if prices[i - 1] > 0]
        if len(log_r) < 2:
            return 0
        mean = sum(log_r) / len(log_r)
        var = sum((r - mean) ** 2 for r in log_r) / (len(log_r) - 1)
        return math.sqrt(var) * math.sqrt(252) * 100

    vol_5 = _vol(closes[-6:])
    vol_60 = _vol(closes[-61:])

    if vol_60 > 0:
        ratio = vol_5 / vol_60
        if ratio > 2.0:
            alerts.append({"level": 3, "type": "波动率", "msg": f"5日波动率是60日均值的 {ratio:.1f} 倍，异常放大"})
        elif ratio > 1.5:
            alerts.append({"level": 2, "type": "波动率", "msg": f"5日波动率是60日均值的 {ratio:.1f} 倍，明显上升"})

    if vol_60 > 35:
        alerts.append({"level": 2, "type": "波动率", "msg": f"年化波动率 {vol_60:.1f}%，波动极高"})

    return alerts


def _check_volume(volumes: list[int]) -> list[dict]:
    """量能异常预警"""
    alerts = []
    if len(volumes) < 20 or volumes[-1] <= 0:
        return alerts

    valid = [v for v in volumes[-20:] if v > 0]
    if not valid:
        return alerts

    avg_v = sum(valid) / len(valid)
    ratio = volumes[-1] / avg_v if avg_v > 0 else 1.0

    if ratio > 3.0:
        alerts.append({"level": 2, "type": "量能", "msg": f"成交量暴增 (量比 {ratio:.1f})，异常放量"})
    elif ratio > 2.0:
        alerts.append({"level": 1, "type": "量能", "msg": f"成交量显著放大 (量比 {ratio:.1f})"})
    elif ratio < 0.3:
        alerts.append({"level": 1, "type": "量能", "msg": f"成交量极度萎缩 (量比 {ratio:.1f})，流动性风险"})

    return alerts


def _check_consecutive(closes: list[float]) -> list[dict]:
    """连续下跌预警"""
    alerts = []
    if len(closes) < 6:
        return alerts

    down_count = 0
    for i in range(-1, -len(closes), -1):
        if closes[i] < closes[i - 1]:
            down_count += 1
        else:
            break

    if down_count >= 5:
        alerts.append({"level": 3, "type": "连跌", "msg": f"连续下跌 {down_count} 个交易日"})
    elif down_count >= 4:
        alerts.append({"level": 2, "type": "连跌", "msg": f"连续下跌 {down_count} 个交易日"})
    elif down_count >= 3:
        alerts.append({"level": 1, "type": "连跌", "msg": f"连续下跌 {down_count} 个交易日"})

    total_drop = (closes[-1] / closes[-down_count - 1] - 1) * 100 if down_count >= 3 else 0
    if total_drop < -5:
        alerts.append({"level": 2, "type": "连跌", "msg": f"连跌期间累计跌幅 {total_drop:.1f}%"})

    return alerts


def _check_breakdown(closes: list[float]) -> list[dict]:
    """技术破位预警"""
    alerts = []
    cur = closes[-1]

    if len(closes) >= 60:
        ma60 = sum(closes[-60:]) / 60
        if cur < ma60 and closes[-2] >= ma60:
            alerts.append({"level": 2, "type": "破位", "msg": f"跌破 60 日均线 (MA60={ma60:.4f})"})
        elif cur < ma60:
            deviation = (cur - ma60) / ma60 * 100
            if deviation < -5:
                alerts.append({"level": 1, "type": "破位", "msg": f"低于 60 日均线 {abs(deviation):.1f}%"})

    if len(closes) >= 120:
        ma120 = sum(closes[-120:]) / 120
        if cur < ma120 and closes[-2] >= ma120:
            alerts.append({"level": 3, "type": "破位", "msg": f"跌破 120 日均线 (MA120={ma120:.4f})"})
        elif cur < ma120:
            deviation = (cur - ma120) / ma120 * 100
            if deviation < -8:
                alerts.append({"level": 2, "type": "破位", "msg": f"低于 120 日均线 {abs(deviation):.1f}%"})

    rsi_val = indicators.rsi(closes)
    if rsi_val is not None and rsi_val > 80:
        alerts.append({"level": 1, "type": "超买", "msg": f"RSI={rsi_val:.1f} 进入超买区，回调风险增加"})

    return alerts


def scan_risk(code: str) -> dict:
    """扫描单只 ETF 的风险"""
    try:
        data = common.fetch(code, "1y", "1d")
        bars, meta = common.parse(data)
    except Exception as e:
        return {"code": code, "name": common.etf_name(code), "error": str(e), "level": -1}

    closes = common.get_closes(bars)
    volumes = common.get_volumes(bars)

    if len(closes) < 20:
        return {"code": code, "name": common.etf_name(code), "error": "数据不足", "level": -1}

    all_alerts = []
    all_alerts.extend(_check_drawdown(closes))
    all_alerts.extend(_check_volatility(closes))
    all_alerts.extend(_check_volume(volumes))
    all_alerts.extend(_check_consecutive(closes))
    all_alerts.extend(_check_breakdown(closes))

    max_level = max((a["level"] for a in all_alerts), default=0)

    cur = closes[-1]
    prev = meta.get("previousClose") or closes[-2]
    daily = (cur - prev) / prev * 100 if prev else 0

    return {
        "code": code,
        "name": common.etf_name(code),
        "category": common.etf_category(code),
        "price": cur,
        "daily": daily,
        "level": max_level,
        "level_text": RISK_LEVELS[max_level][0],
        "level_icon": RISK_LEVELS[max_level][1],
        "alerts": all_alerts,
        "alert_count": len(all_alerts),
    }


def print_risk(result: dict):
    if "error" in result and result.get("level", -1) < 0:
        print(f"  {result['name']}({result['code']}): {result['error']}")
        return

    r = result
    print(f"=== {r['name']} ({r['code']}) 风险评估 ===\n")
    print(f"  风险等级: {r['level_icon']} {r['level_text']}")
    print(f"  当前价格: {r['price']:.4f}  今日: {r['daily']:+.2f}%")
    print(f"  预警条目: {r['alert_count']} 项\n")

    if r["alerts"]:
        for a in sorted(r["alerts"], key=lambda x: -x["level"]):
            icon = RISK_LEVELS[a["level"]][1]
            print(f"  {icon} [{a['type']}] {a['msg']}")
    else:
        print("  ✅ 未发现风险预警信号")

    print()
    suggestions = []
    if r["level"] >= 3:
        suggestions.append("建议减仓或设置止损")
        suggestions.append("密切关注后续走势，避免追涨")
    elif r["level"] >= 2:
        suggestions.append("建议控制仓位，谨慎操作")
        suggestions.append("可适当降低该标的配置比例")
    elif r["level"] >= 1:
        suggestions.append("保持关注，无需恐慌")
        suggestions.append("可正常持有，注意观察趋势变化")
    else:
        suggestions.append("当前风险可控，可正常操作")

    print("  [应对建议]")
    for s in suggestions:
        print(f"    • {s}")


def main():
    codes = sys.argv[1:] if len(sys.argv) > 1 else list(common.ETF_CODES.keys())

    if len(codes) == 1:
        try:
            result = scan_risk(codes[0])
            print_risk(result)
        except Exception as e:
            print(f"错误: {e}")
            sys.exit(1)
    else:
        print("=== ETF 风险扫描 ===\n")
        results = []
        for code in codes:
            results.append(scan_risk(code))

        results.sort(key=lambda x: -x.get("level", -1))
        fmt = "{:<2} {:<14} {:<6} {:>8} {:>6}  {:<8} {:>3}"
        print(fmt.format("", "名称", "代码", "价格", "今日", "风险", "预警"))
        print("-" * 56)
        for r in results:
            if r.get("level", -1) < 0:
                print(f"  {r['name']:<12} {r['code']:<6}  数据异常")
                continue
            print(
                fmt.format(
                    r["level_icon"],
                    r["name"],
                    r["code"],
                    f"{r['price']:.3f}",
                    f"{r['daily']:+.1f}%",
                    r["level_text"],
                    f"{r['alert_count']}项",
                )
            )

        high_risk = [r for r in results if r.get("level", 0) >= 2]
        if high_risk:
            print(f"\n  ⚠ 发现 {len(high_risk)} 只高风险ETF，建议重点关注。")
        else:
            print("\n  ✅ 整体风险可控，未发现高风险标的。")


if __name__ == "__main__":
    main()
