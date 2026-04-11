#!/usr/bin/env python
"""定投收益计算器 — 多情景对比"""

import sys


def calc(monthly: float, years: int):
    months = years * 12
    total = monthly * months

    print("=== 定投计算 ===")
    print(f"月投: ¥{monthly:,.0f}  年限: {years}年  总投入: ¥{total:,.0f}\n")

    fmt = "{:<10} {:<8} {:<14} {:<14} {:<8}"
    print(fmt.format("情景", "年化", "终值", "收益", "回报率"))
    print("-" * 56)

    for name, rate in [("悲观", 0.03), ("保守", 0.05), ("中性", 0.08), ("乐观", 0.10), ("极乐观", 0.12)]:
        mr = rate / 12
        fv = monthly * (((1 + mr) ** months - 1) / mr) if mr > 0 else total
        profit = fv - total
        roi = profit / total * 100
        print(fmt.format(name, f"{rate * 100:.0f}%", f"¥{fv:>10,.0f}", f"¥{profit:>10,.0f}", f"{roi:>5.0f}%"))

    print("\n说明: 沪深300长期年化约8-10%，实际受市场波动和入场时点影响")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python calc.py <月投金额> <年限>")
        print("示例: python calc.py 1000 10")
        sys.exit(1)
    try:
        calc(float(sys.argv[1]), int(sys.argv[2]))
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)
