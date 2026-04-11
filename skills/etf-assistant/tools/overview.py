#!/usr/bin/env python
"""市场全景仪表盘 — 全 ETF 扫描 + 板块热度 + 市场宽度"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import signal as signal_mod

import common


def _gather_all() -> list[dict]:
    """采集所有 ETF 信号数据"""
    results = []
    for code in common.ETF_CODES:
        try:
            r = signal_mod.compute_signal(code)
            results.append(r)
        except Exception:
            results.append({"code": code, "name": common.etf_name(code), "error": "获取失败"})
    return results


def _print_etf_table(results: list[dict], sort_key: str):
    """打印 ETF 一览表"""
    valid = [r for r in results if "error" not in r]
    if sort_key == "signal":
        valid.sort(key=lambda x: -x["total_score"])
    elif sort_key == "risk":
        valid.sort(key=lambda x: x["total_score"])
    elif sort_key == "change":
        valid.sort(key=lambda x: -x["daily"])
    else:
        valid.sort(key=lambda x: -x["total_score"])

    fmt = "{:<14} {:<6} {:<4} {:>8} {:>7}  {:>4}  {:<10} {:<6}"
    print(fmt.format("名称", "代码", "板块", "价格", "今日", "评分", "信号条", "信号"))
    print("-" * 72)
    for r in valid:
        print(
            fmt.format(
                r["name"],
                r["code"],
                r["category"],
                f"{r['price']:.3f}",
                f"{r['daily']:+.1f}%",
                f"{r['total_score']:.0f}",
                r["bar"],
                r["level"],
            )
        )

    errors = [r for r in results if "error" in r]
    if errors:
        print(f"\n  ({len(errors)} 只ETF获取失败)")


def _print_sector_heat(results: list[dict]):
    """板块热度分析"""
    valid = [r for r in results if "error" not in r]
    sectors: dict[str, list[dict]] = {}
    for r in valid:
        cat = r.get("category", "未知")
        sectors.setdefault(cat, []).append(r)

    print("\n=== 板块热度 ===\n")
    sector_order = ["宽基", "行业", "策略", "跨境", "债券", "商品"]
    fmt = "{:<6} {:>6} {:>8} {:>8} {:>8}  {}"
    print(fmt.format("板块", "数量", "平均涨跌", "平均评分", "最高分", "最强标的"))
    print("-" * 62)

    for cat in sector_order:
        items = sectors.get(cat, [])
        if not items:
            continue
        avg_daily = sum(r["daily"] for r in items) / len(items)
        avg_score = sum(r["total_score"] for r in items) / len(items)
        best = max(items, key=lambda x: x["total_score"])

        heat = "🔥" if avg_daily > 1 else "📈" if avg_daily > 0 else "📉" if avg_daily > -1 else "❄️"
        print(
            fmt.format(
                cat,
                f"{len(items)}只",
                f"{avg_daily:+.1f}%",
                f"{avg_score:.0f}",
                f"{best['total_score']:.0f}",
                f"{heat} {best['name']}",
            )
        )


def _print_market_breadth(results: list[dict]):
    """市场宽度分析"""
    valid = [r for r in results if "error" not in r]
    if not valid:
        return

    total = len(valid)
    up_count = sum(1 for r in valid if r["daily"] > 0)
    down_count = sum(1 for r in valid if r["daily"] < 0)
    flat_count = total - up_count - down_count

    bullish = sum(1 for r in valid if r["total_score"] >= 60)
    bearish = sum(1 for r in valid if r["total_score"] <= 40)
    neutral = total - bullish - bearish

    above_ma20 = 0
    above_ma60 = 0
    for r in valid:
        try:
            data = common.fetch(r["code"], "1y", "1d")
            bars, _ = common.parse(data)
            closes = common.get_closes(bars)
            cur = closes[-1]
            if len(closes) >= 20 and cur > sum(closes[-20:]) / 20:
                above_ma20 += 1
            if len(closes) >= 60 and cur > sum(closes[-60:]) / 60:
                above_ma60 += 1
        except Exception:
            pass

    print("\n=== 市场宽度 ===\n")
    print(f"  涨跌比: {up_count}涨 / {flat_count}平 / {down_count}跌  (共{total}只)")
    print(f"  多空比: {bullish}多 / {neutral}中 / {bearish}空  (按信号评分)")
    print(f"  站上MA20: {above_ma20}/{total} ({above_ma20 / total * 100:.0f}%)")
    print(f"  站上MA60: {above_ma60}/{total} ({above_ma60 / total * 100:.0f}%)")

    if above_ma20 / total > 0.7:
        print("\n  判断: 市场整体偏强，多数标的处于短期上升趋势")
    elif above_ma20 / total < 0.3:
        print("\n  判断: 市场整体偏弱，多数标的处于短期下降趋势")
    elif bullish > bearish * 2:
        print("\n  判断: 信号偏多，关注强势板块机会")
    elif bearish > bullish * 2:
        print("\n  判断: 信号偏空，注意控制风险")
    else:
        print("\n  判断: 市场分化，选择性参与")


def _print_top_volume(results: list[dict]):
    """资金动向 — 按成交额排序"""
    valid = [r for r in results if "error" not in r]
    vol_data = []
    for r in valid:
        try:
            data = common.fetch(r["code"], "1y", "1d")
            bars, _ = common.parse(data)
            if bars:
                amount = bars[-1].get("amount", 0)
                vol_data.append((r["name"], r["code"], amount, r["daily"]))
        except Exception:
            pass

    if not vol_data:
        return

    vol_data.sort(key=lambda x: -x[2])
    print("\n=== 资金活跃度 (成交额 Top 10) ===\n")
    fmt = "{:<3} {:<14} {:<6} {:>14} {:>7}"
    print(fmt.format("", "名称", "代码", "成交额(元)", "今日"))
    print("-" * 50)
    for i, (name, code, amount, daily) in enumerate(vol_data[:10], 1):
        if amount >= 1e8:
            amt_str = f"{amount / 1e8:.1f}亿"
        elif amount >= 1e4:
            amt_str = f"{amount / 1e4:.0f}万"
        else:
            amt_str = f"{amount:.0f}"
        print(fmt.format(f"{i}.", name, code, amt_str, f"{daily:+.1f}%"))


def main():
    sort_key = "signal"
    for arg in sys.argv[1:]:
        if arg.startswith("--sort="):
            sort_key = arg.split("=", 1)[1]

    print("=== ETF 市场全景 ===\n")
    print("正在扫描全部 ETF ...\n")

    results = _gather_all()

    _print_etf_table(results, sort_key)
    _print_sector_heat(results)
    _print_market_breadth(results)
    _print_top_volume(results)

    print("\n  ⚠ 以上数据基于技术指标计算，仅供参考，不构成投资建议。")


if __name__ == "__main__":
    main()
