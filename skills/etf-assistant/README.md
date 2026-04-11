# ETF 投资分析助手 Pro

A 股 ETF 专业投资分析工具集，为 agent 提供交易信号、风险预警、行情分析、组合诊断和定投计算能力。

## 架构

```
skills/etf-assistant/
├── SKILL.md                              # Skill 定义（agent 入口）
├── tools/
│   ├── common.py                         # 共享模块：东方财富/同花顺 双数据源、缓存、OHLCV 解析
│   ├── indicators.py                     # 技术指标：RSI/MACD/布林带/KDJ/ATR/EMA
│   ├── signal.py                         # 多因子交易信号系统
│   ├── risk.py                           # 风险预警扫描
│   ├── overview.py                       # 市场全景仪表盘
│   ├── analyze.py                        # 单只ETF综合分析
│   ├── compare.py                        # 两只ETF对比
│   ├── portfolio.py                      # 组合诊断
│   └── calc.py                           # 定投收益计算器
├── references/
│   ├── analysis-framework.md             # 分析方法论与指标解读
│   ├── etf-universe.md                   # ETF分类与配置指南
│   └── signal-methodology.md             # 信号系统方法论
└── README.md
```

## 工具说明

### signal.py — 交易信号（核心）
```bash
python tools/signal.py 510300              # 单只信号
python tools/signal.py 510300 159915       # 批量信号
```
输出：五因子综合评分（0-100）、信号级别（强烈买入→强烈卖出）、各因子得分明细、关键信号点、建议仓位。

### risk.py — 风险预警
```bash
python tools/risk.py                       # 扫描全部 ETF
python tools/risk.py 510300                # 单只风险检查
```
输出：风险等级（低/中/高/极高）、五维预警（回撤/波动率/量能/连跌/破位）、应对建议。

### overview.py — 市场全景
```bash
python tools/overview.py                   # 全景扫描（默认按信号排序）
python tools/overview.py --sort=change     # 按涨跌排序
python tools/overview.py --sort=amount     # 按成交额排序
```
输出：全ETF一览表、板块热度、市场宽度指标、资金动向。

### analyze.py — 综合分析
```bash
python tools/analyze.py 510300
```
输出：价格、多周期收益、风险指标、趋势（均线/价格位置）、成交量、技术指标（RSI/MACD/布林带/KDJ）。

### compare.py — ETF 对比
```bash
python tools/compare.py 510300 159915
```
输出：两只 ETF 多维度指标并排对比（含RSI/MACD），标注优势方。

### portfolio.py — 组合诊断
```bash
python tools/portfolio.py 510300:40 159915:30 518880:20 510880:10
```
输出：持仓明细、集中度风险、板块暴露、相关性矩阵、风险贡献度、再平衡建议。

### calc.py — 定投计算
```bash
python tools/calc.py 1000 10
```
输出：5 种年化收益率下的定投终值、收益和回报率。

## 技术特性

- 纯 Python 标准库，无额外依赖
- 数据源：东方财富（主） + 同花顺（备），自动切换
- 完整 OHLCV 数据解析（开高低收量 + 成交额/振幅/涨跌幅/换手率）
- 5 分钟本地缓存，减少 API 请求
- 内置 RSI、MACD、布林带、KDJ、ATR、EMA/SMA 技术指标
- 多因子信号打分：趋势(30%) + 动量(25%) + 波动(20%) + 量能(15%) + 形态(10%)

## 覆盖的 ETF

| 类型 | ETF |
|------|-----|
| 宽基 | 510300 沪深300 · 510050 上证50 · 510500 中证500 · 159915 创业板 · 588000 科创50 · 159845 中证1000 |
| 行业 | 159997 芯片 · 159995 新能源车 · 512170 医疗 · 512880 证券 · 512660 军工 · 512800 银行 · 512690 酒 · 515790 光伏 · 159819 人工智能 · 159928 消费 |
| 策略 | 510880 红利 |
| 跨境 | 513100 纳指 · 513500 标普500 · 513050 中概互联 |
| 债券 | 511010 国债 |
| 商品 | 518880 黄金 · 159985 豆粕 |
