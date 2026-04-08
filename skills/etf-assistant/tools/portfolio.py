#!/usr/bin/env python
"""组合诊断 — 持仓分析 / 集中度 / 相关性 / 板块暴露 / 再平衡建议"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common


def _daily_returns(closes: list[float]) -> list[float]:
    return [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes)) if closes[i - 1] > 0]


def _correlation(r1: list[float], r2: list[float]) -> float:
    n = min(len(r1), len(r2))
    if n < 10:
        return 0.0
    r1, r2 = r1[-n:], r2[-n:]
    m1, m2 = sum(r1) / n, sum(r2) / n
    cov = sum((a - m1) * (b - m2) for a, b in zip(r1, r2)) / (n - 1)
    s1 = math.sqrt(sum((a - m1) ** 2 for a in r1) / (n - 1))
    s2 = math.sqrt(sum((b - m2) ** 2 for b in r2) / (n - 1))
    return cov / (s1 * s2) if s1 > 0 and s2 > 0 else 0.0


def _annualized_vol(closes: list[float]) -> float:
    log_r = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i - 1] > 0]
    if len(log_r) < 2:
        return 0.0
    mean = sum(log_r) / len(log_r)
    var = sum((r - mean) ** 2 for r in log_r) / (len(log_r) - 1)
    return math.sqrt(var) * math.sqrt(252) * 100


def diagnose(holdings: list[tuple[str, float]]):
    """
    holdings: [(代码, 权重%), ...]  权重之和应为 100
    """
    total_weight = sum(w for _, w in holdings)
    if abs(total_weight - 100) > 0.1:
        print(f"  ⚠ 权重之和为 {total_weight:.1f}%，已自动归一化到 100%")
        holdings = [(c, w / total_weight * 100) for c, w in holdings]

    # 获取数据
    etf_data: dict[str, dict] = {}
    for code, weight in holdings:
        try:
            data = common.fetch(code, "1y", "1d")
            bars, meta = common.parse(data)
            closes = common.get_closes(bars)
            if len(closes) < 20:
                print(f"  ⚠ {code} 数据不足，跳过")
                continue
            cur = closes[-1]
            prev = meta.get("previousClose") or closes[-2]
            daily = (cur - prev) / prev * 100 if prev else 0
            returns_1m = (cur / closes[-22] - 1) * 100 if len(closes) > 22 else 0
            returns_3m = (cur / closes[-64] - 1) * 100 if len(closes) > 64 else 0
            returns_1y = (cur / closes[0] - 1) * 100 if len(closes) > 1 else 0
            vol = _annualized_vol(closes)
            daily_r = _daily_returns(closes)

            etf_data[code] = {
                "name": common.etf_name(code),
                "category": common.etf_category(code),
                "weight": weight,
                "price": cur,
                "daily": daily,
                "returns_1m": returns_1m,
                "returns_3m": returns_3m,
                "returns_1y": returns_1y,
                "vol": vol,
                "daily_returns": daily_r,
                "closes": closes,
            }
        except Exception as e:
            print(f"  ⚠ {code} 获取失败: {e}")

    if not etf_data:
        print("错误: 无有效持仓数据")
        return

    # 1. 持仓明细
    print("=== 组合诊断 ===\n")
    print("[持仓明细]")
    fmt = "{:<14} {:<6} {:>6}  {:>8} {:>7} {:>7} {:>7}  {:>6}"
    print(fmt.format("名称", "代码", "权重", "价格", "今日", "近1月", "近1年", "波动率"))
    print("-" * 78)

    weighted_daily = 0.0
    weighted_1m = 0.0
    weighted_1y = 0.0
    weighted_vol = 0.0

    for code, info in etf_data.items():
        w = info["weight"]
        print(
            fmt.format(
                info["name"],
                code,
                f"{w:.0f}%",
                f"{info['price']:.3f}",
                f"{info['daily']:+.1f}%",
                f"{info['returns_1m']:+.1f}%",
                f"{info['returns_1y']:+.1f}%",
                f"{info['vol']:.1f}%",
            )
        )
        weighted_daily += info["daily"] * w / 100
        weighted_1m += info["returns_1m"] * w / 100
        weighted_1y += info["returns_1y"] * w / 100
        weighted_vol += info["vol"] * w / 100

    print("-" * 78)
    print(f"  加权收益 — 今日: {weighted_daily:+.2f}%  近1月: {weighted_1m:+.2f}%  近1年: {weighted_1y:+.2f}%")
    print(f"  加权波动率: {weighted_vol:.1f}% (简单加权，未考虑相关性)")

    # 2. 集中度风险
    print("\n[集中度风险]")
    alerts = []
    for code, info in etf_data.items():
        if info["weight"] > 30:
            alerts.append(f"  ⚠ {info['name']}({code}) 占比 {info['weight']:.0f}%，超过单只上限 30%")

    category_weights: dict[str, float] = {}
    for code, info in etf_data.items():
        cat = info["category"]
        category_weights[cat] = category_weights.get(cat, 0) + info["weight"]

    for cat, w in category_weights.items():
        if cat == "行业" and w > 40:
            alerts.append(f"  ⚠ 行业类 ETF 合计 {w:.0f}%，超过行业上限 40%")

    if alerts:
        for a in alerts:
            print(a)
    else:
        print("  ✅ 集中度检查通过")

    # 3. 板块暴露
    print("\n[板块暴露]")
    for cat in ["宽基", "行业", "策略", "跨境", "债券", "商品"]:
        w = category_weights.get(cat, 0)
        if w > 0:
            bar_len = int(w / 5)
            bar = "█" * bar_len + "░" * (20 - bar_len)
            names = [info["name"] for code, info in etf_data.items() if info["category"] == cat]
            print(f"  {cat:<4} {w:>5.1f}%  {bar}  {', '.join(names)}")

    missing = []
    if "宽基" not in category_weights:
        missing.append("宽基（底仓）")
    if "商品" not in category_weights and "债券" not in category_weights:
        missing.append("商品或债券（防御）")

    if missing:
        print(f"\n  💡 建议补充: {', '.join(missing)}")

    # 4. 相关性矩阵
    codes = list(etf_data.keys())
    if len(codes) >= 2:
        print("\n[相关性矩阵]")
        header = "         " + "".join(f"{c:>8}" for c in codes)
        print(header)

        high_corr_pairs = []
        for i, c1 in enumerate(codes):
            row = f"  {c1}  "
            for j, c2 in enumerate(codes):
                if i == j:
                    row += "    1.00"
                elif j < i:
                    row += "        "
                else:
                    corr = _correlation(etf_data[c1]["daily_returns"], etf_data[c2]["daily_returns"])
                    row += f"    {corr:.2f}"
                    if corr > 0.8:
                        high_corr_pairs.append((c1, c2, corr))
            print(row)

        if high_corr_pairs:
            print("\n  ⚠ 高相关性预警:")
            for c1, c2, corr in high_corr_pairs:
                n1, n2 = etf_data[c1]["name"], etf_data[c2]["name"]
                print(f"    {n1} ↔ {n2}: {corr:.2f} (分散效果有限)")

    # 5. 风险贡献度
    print("\n[风险贡献度]")
    risk_contributions = []
    for code, info in etf_data.items():
        rc = info["vol"] * info["weight"] / 100
        risk_contributions.append((code, info["name"], rc, info["weight"], info["vol"]))

    risk_contributions.sort(key=lambda x: -x[2])
    total_rc = sum(rc for _, _, rc, _, _ in risk_contributions)

    for code, name, rc, weight, vol in risk_contributions:
        pct = rc / total_rc * 100 if total_rc > 0 else 0
        bar_len = int(pct / 5)
        bar = "█" * bar_len
        print(f"  {name:<12} {code}  权重{weight:>4.0f}% × 波动{vol:>5.1f}% = 贡献{pct:>5.1f}%  {bar}")

    # 6. 再平衡建议
    print("\n[再平衡建议]")
    suggestions = []

    if "宽基" not in category_weights or category_weights.get("宽基", 0) < 20:
        suggestions.append("• 宽基 ETF 配置不足，建议至少配置 30-40% 作为底仓")

    if category_weights.get("行业", 0) > 50:
        suggestions.append("• 行业 ETF 占比过高，建议降至 30% 以内，分散行业风险")

    if "商品" not in category_weights and "债券" not in category_weights:
        suggestions.append("• 缺少避险资产，建议配置 5-10% 黄金ETF 或国债ETF")

    if len(etf_data) < 3:
        suggestions.append("• 持仓过于集中，建议持有 3-5 只 ETF 以分散风险")

    if high_corr_pairs:
        suggestions.append("• 存在高相关性持仓，可考虑替换其中一只以提高分散度")

    max_weight_etf = max(etf_data.items(), key=lambda x: x[1]["weight"])
    if max_weight_etf[1]["weight"] > 40:
        suggestions.append(
            f"• {max_weight_etf[1]['name']} 占比过高 ({max_weight_etf[1]['weight']:.0f}%)，建议降至 30% 以内"
        )

    if suggestions:
        for s in suggestions:
            print(f"  {s}")
    else:
        print("  ✅ 组合结构合理，暂无调整建议")

    print("\n  ⚠ 以上诊断基于历史数据，仅供参考，不构成投资建议。")


def main():
    if len(sys.argv) < 2:
        print("用法: python portfolio.py <代码:权重> [代码:权重] ...")
        print("示例: python portfolio.py 510300:40 159915:30 518880:20 510880:10")
        sys.exit(1)

    holdings = []
    for arg in sys.argv[1:]:
        if ":" not in arg:
            print("错误: 参数格式应为 '代码:权重'，如 510300:40")
            sys.exit(1)
        code, weight = arg.split(":", 1)
        holdings.append((code.strip(), float(weight.strip())))

    try:
        diagnose(holdings)
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
