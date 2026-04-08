#!/bin/bash
# ETF投资分析助手 - Ripple Skill
# 功能：ETF行情查询、综合分析、对比、定投计算

set -euo pipefail

TIMEOUT=10
MAX_RETRIES=2
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ripple-etf"
CACHE_TTL=300

ETF_LIST="510300:沪深300ETF
510050:上证50ETF
510500:中证500ETF
159915:创业板ETF
588000:科创50ETF
159845:中证1000ETF
159997:芯片ETF
159995:新能源车ETF
512170:医疗ETF
512880:光伏ETF
512760:券商ETF
511880:中证消费ETF
510880:红利ETF
518880:黄金ETF"

check_dependencies() {
    local missing=()
    for cmd in curl python; do
        if ! command -v "$cmd" &>/dev/null; then
            missing+=("$cmd")
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        echo "错误: 缺少依赖 - ${missing[*]}"
        echo "请安装: sudo apt install ${missing[*]}"
        exit 1
    fi
}

init_cache() {
    mkdir -p "$CACHE_DIR"
}

get_cache_file() {
    local key=$1
    echo "$CACHE_DIR/${key}.cache"
}

is_cache_valid() {
    local cache_file=$1
    if [ ! -f "$cache_file" ]; then
        return 1
    fi

    local cache_time
    cache_time=$(stat -c %Y "$cache_file" 2>/dev/null || echo 0)
    local current_time
    current_time=$(date +%s)
    local age=$((current_time - cache_time))

    [ $age -lt $CACHE_TTL ]
}

read_cache() {
    local cache_file=$1
    if is_cache_valid "$cache_file"; then
        cat "$cache_file"
        return 0
    fi
    return 1
}

write_cache() {
    local cache_file=$1
    local data=$2
    echo "$data" > "$cache_file"
}

get_exchange_suffix() {
    local code=$1
    case "${code:0:1}" in
        1) echo ".SZ" ;;
        *) echo ".SS" ;;
    esac
}

get_etf_name() {
    local code=$1
    local name
    name=$(echo "$ETF_LIST" | grep "^${code}:" | cut -d: -f2)
    if [ -z "$name" ]; then
        echo "ETF($code)"
    else
        echo "$name"
    fi
}

fetch_etf_data() {
    local code=$1
    local range=${2:-1d}
    local interval=${3:-1m}
    local cache_key="${code}_${range}_${interval}"
    local cache_file
    cache_file=$(get_cache_file "$cache_key")

    if read_cache "$cache_file" 2>/dev/null; then
        return 0
    fi

    local suffix
    suffix=$(get_exchange_suffix "$code")
    local response=""
    local retry=0
    while [ $retry -lt $MAX_RETRIES ]; do
        response=$(curl -s --max-time $TIMEOUT \
            "https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}?range=${range}&interval=${interval}" 2>/dev/null)

        if [ -n "$response" ] && echo "$response" | grep -q "timestamp"; then
            write_cache "$cache_file" "$response"
            echo "$response"
            return 0
        fi

        retry=$((retry + 1))
        [ $retry -lt $MAX_RETRIES ] && sleep 1
    done

    return 1
}

show_help() {
    cat << 'EOF'
==========================================
      ETF投资分析助手 - Ripple Skill
==========================================

用法: etf-assistant.sh <命令> [参数]

命令:
  list                          显示常用ETF列表
  price <代码>                  查询实时行情
  analyze <代码>                综合分析(收益/风险/趋势/量能)
  history <代码>                多周期涨跌幅
  batch <代码1> <代码2> ...     批量查询
  compare <代码1> <代码2>       对比两只ETF
  calc <代码> <金额> <年限>     定投计算器(多情景)
  hot                           热门ETF
  search <关键词>               搜索ETF
  category                      按行业分类
  summary                       投资摘要
  help                          显示帮助

示例:
  etf-assistant.sh analyze 510300
  etf-assistant.sh compare 510300 159915
  etf-assistant.sh calc 510300 1000 10
  etf-assistant.sh batch 510300 159915 510500
EOF
}

cmd_list() {
    echo "=========================================="
    echo "常用ETF列表"
    echo "=========================================="
    printf "%-10s %-20s\n" "代码" "名称"
    echo "------------------------------------------"
    echo "$ETF_LIST" | while IFS=: read -r code name; do
        printf "%-10s %-20s\n" "$code" "$name"
    done
    echo "=========================================="
}

cmd_price() {
    local code=$1
    if [ -z "$code" ]; then
        echo "错误: 请输入ETF代码"
        return 1
    fi

    local name
    name=$(get_etf_name "$code")
    echo "=========================================="
    echo "$name ($code) 实时行情"
    echo "=========================================="

    local response
    response=$(fetch_etf_data "$code" "1d" "1m")

    if [ -z "$response" ]; then
        echo "错误: 无法获取行情数据"
        echo "可能原因: 网络问题 / ETF代码不存在 / API暂不可用"
        return 1
    fi

    echo "$response" | python -c "
import json, sys
try:
    data = json.load(sys.stdin)
    result = data.get('chart', {}).get('result', [{}])[0]
    meta = result.get('meta', {})

    current = meta.get('regularMarketPrice', 0)
    prev_close = meta.get('previousClose', 0)

    if current and prev_close:
        diff = float(current) - float(prev_close)
        pct = (diff / float(prev_close)) * 100
        print(f'当前价格: {current}')
        print(f'昨收价格: {prev_close}')
        print(f'涨跌幅度: {diff:+.4f} ({pct:+.2f}%)')
        print(f'趋势: {\"上涨\" if diff > 0 else \"下跌\" if diff < 0 else \"平盘\"}')
    else:
        print('错误: 数据解析失败')
except Exception as e:
    print(f'错误: 数据解析失败 ({e})')
" 2>/dev/null
    echo "=========================================="
}

cmd_analyze() {
    local code=$1
    if [ -z "$code" ]; then
        echo "错误: 请输入ETF代码"
        return 1
    fi

    local name
    name=$(get_etf_name "$code")
    echo "=========================================="
    echo "$name ($code) 综合分析报告"
    echo "=========================================="

    local response
    response=$(fetch_etf_data "$code" "1y" "1d")

    if [ -z "$response" ]; then
        echo "错误: 无法获取数据（网络问题或代码不存在）"
        return 1
    fi

    echo "$response" | python -c "
import json, sys, math
from datetime import datetime

try:
    data = json.load(sys.stdin)
    result = data.get('chart', {}).get('result', [{}])[0]
    meta = result.get('meta', {})
    timestamps = result.get('timestamp', [])
    quotes = result.get('indicators', {}).get('quote', [{}])[0]

    raw_closes = quotes.get('close', [])
    raw_volumes = quotes.get('volume', [])

    clean = [(timestamps[i], raw_closes[i], raw_volumes[i] if i < len(raw_volumes) and raw_volumes[i] else 0)
             for i in range(len(timestamps))
             if i < len(raw_closes) and raw_closes[i] is not None and raw_closes[i] > 0]

    if len(clean) < 20:
        print('数据不足（少于20个交易日），无法进行综合分析')
        sys.exit(1)

    closes = [c[1] for c in clean]
    volumes = [c[2] for c in clean]

    current = closes[-1]
    prev_close = meta.get('previousClose', closes[-2] if len(closes) > 1 else current)
    if not prev_close or prev_close == 0:
        prev_close = closes[-2] if len(closes) > 1 else current

    # --- 基本信息 ---
    daily_chg = ((current - prev_close) / prev_close) * 100 if prev_close else 0
    print(f'[基本信息]')
    print(f'  当前价格: {current:.4f}')
    print(f'  昨收价格: {prev_close:.4f}')
    print(f'  今日涨跌: {daily_chg:+.2f}%')

    # --- 多周期收益 ---
    print(f'')
    print(f'[收益表现]')
    for label, days in [('近1周', 5), ('近1月', 21), ('近3月', 63), ('近6月', 126), ('近1年', 252)]:
        if len(closes) > days:
            old = closes[-(days + 1)]
            pct = ((current - old) / old) * 100 if old > 0 else 0
            print(f'  {label}: {pct:+.2f}%')

    # --- 风险指标 ---
    log_returns = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            log_returns.append(math.log(closes[i] / closes[i - 1]))

    if len(log_returns) > 10:
        mean_r = sum(log_returns) / len(log_returns)
        variance = sum((r - mean_r) ** 2 for r in log_returns) / (len(log_returns) - 1)
        daily_vol = variance ** 0.5
        annual_vol = daily_vol * math.sqrt(252) * 100

        n_years = len(closes) / 252
        total_return_pct = (closes[-1] / closes[0] - 1) * 100
        annual_return = ((closes[-1] / closes[0]) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0

        rf = 2.0
        sharpe = (annual_return - rf) / annual_vol if annual_vol > 0 else 0

        peak = closes[0]
        max_dd = 0
        for p in closes:
            if p > peak:
                peak = p
            dd = (peak - p) / peak
            if dd > max_dd:
                max_dd = dd

        peak_all = max(closes)
        curr_dd = (peak_all - current) / peak_all

        print(f'')
        print(f'[风险指标]')
        print(f'  年化波动率: {annual_vol:.1f}%')
        print(f'  最大回撤: {max_dd * 100:.1f}%')
        print(f'  当前回撤: {curr_dd * 100:.1f}%')
        print(f'  夏普比率: {sharpe:.2f} (无风险利率2%)')

        if max_dd > 0:
            calmar = annual_return / (max_dd * 100)
            print(f'  卡玛比率: {calmar:.2f}')

    # --- 趋势分析 ---
    print(f'')
    print(f'[趋势分析]')

    ma5 = sum(closes[-5:]) / 5
    ma20 = sum(closes[-20:]) / 20
    print(f'  5日均线: {ma5:.4f} ({\"价格在上方\" if current > ma5 else \"价格在下方\"})')
    print(f'  20日均线: {ma20:.4f} ({\"价格在上方\" if current > ma20 else \"价格在下方\"})')

    if len(closes) >= 60:
        ma60 = sum(closes[-60:]) / 60
        print(f'  60日均线: {ma60:.4f} ({\"价格在上方\" if current > ma60 else \"价格在下方\"})')

        if current > ma20 > ma60:
            trend = '多头排列 - 上升趋势'
        elif current < ma20 < ma60:
            trend = '空头排列 - 下降趋势'
        elif current > ma20 and ma20 < ma60:
            trend = '短期反弹 - 中期趋势待确认'
        elif current < ma20 and ma20 > ma60:
            trend = '短期回调 - 中期趋势仍在'
        else:
            trend = '均线交织 - 方向不明'
        print(f'  趋势判断: {trend}')

    if len(closes) >= 120:
        ma120 = sum(closes[-120:]) / 120
        print(f'  120日均线: {ma120:.4f} ({\"价格在上方\" if current > ma120 else \"价格在下方\"})')

    # --- 价格区间 ---
    high_w = max(closes)
    low_w = min(closes)
    price_range = high_w - low_w
    position = ((current - low_w) / price_range * 100) if price_range > 0 else 50

    print(f'')
    print(f'[价格区间]')
    print(f'  区间最高: {high_w:.4f}')
    print(f'  区间最低: {low_w:.4f}')
    print(f'  当前位置: {position:.0f}% (0%=最低, 100%=最高)')

    if position < 20:
        print(f'  位置评估: 接近低点，可能超卖')
    elif position < 40:
        print(f'  位置评估: 低位区间')
    elif position < 60:
        print(f'  位置评估: 中位区间')
    elif position < 80:
        print(f'  位置评估: 高位区间')
    else:
        print(f'  位置评估: 接近高点，注意风险')

    # --- 成交量分析 ---
    valid_vols = [v for v in volumes[-20:] if v and v > 0]
    if valid_vols and len(valid_vols) >= 5:
        avg_vol = sum(valid_vols) / len(valid_vols)
        recent_vol = volumes[-1] if volumes[-1] and volumes[-1] > 0 else 0

        if avg_vol > 0 and recent_vol > 0:
            vol_ratio = recent_vol / avg_vol
            print(f'')
            print(f'[成交量分析]')
            print(f'  最新成交量: {recent_vol:,.0f}')
            print(f'  20日均量: {avg_vol:,.0f}')
            print(f'  量比: {vol_ratio:.2f}')

            if vol_ratio > 2.0:
                status = '显著放量'
            elif vol_ratio > 1.2:
                status = '温和放量'
            elif vol_ratio < 0.5:
                status = '明显缩量'
            else:
                status = '量能平稳'
            print(f'  量能状态: {status}')

            if daily_chg > 0 and vol_ratio > 1.2:
                print(f'  量价关系: 放量上涨，资金流入信号')
            elif daily_chg > 0 and vol_ratio < 0.8:
                print(f'  量价关系: 缩量上涨，上涨动能不足')
            elif daily_chg < 0 and vol_ratio > 1.2:
                print(f'  量价关系: 放量下跌，抛压较重')
            elif daily_chg < 0 and vol_ratio < 0.8:
                print(f'  量价关系: 缩量下跌，下跌动能衰减')

except Exception as e:
    print(f'分析出错: {e}')
    sys.exit(1)
" 2>/dev/null

    echo "=========================================="
}

cmd_history() {
    local code=$1
    if [ -z "$code" ]; then
        echo "错误: 请输入ETF代码"
        return 1
    fi

    local name
    name=$(get_etf_name "$code")
    echo "=========================================="
    echo "$name ($code) 多周期涨跌幅"
    echo "=========================================="

    local response
    response=$(fetch_etf_data "$code" "1y" "1d")

    if [ -z "$response" ]; then
        echo "错误: 无法获取历史数据"
        return 1
    fi

    echo "$response" | python -c "
import json, sys
from datetime import datetime, timedelta

try:
    data = json.load(sys.stdin)
    result = data.get('chart', {}).get('result', [{}])[0]
    timestamps = result.get('timestamp', [])
    quotes = result.get('indicators', {}).get('quote', [{}])[0]
    closes = quotes.get('close', [])

    clean = [(timestamps[i], closes[i]) for i in range(len(timestamps))
             if i < len(closes) and closes[i] is not None]

    if not clean:
        print('错误: 无有效数据')
        sys.exit(1)

    current_price = clean[-1][1]
    now = datetime.now()

    for label, days in [('近1周', 7), ('近1月', 30), ('近3月', 90), ('近6月', 180), ('近1年', 365)]:
        target_time = (now - timedelta(days=days)).timestamp()
        closest = min(clean, key=lambda x: abs(x[0] - target_time))
        if closest[1] and closest[1] > 0:
            pct = ((current_price - closest[1]) / closest[1]) * 100
            print(f'{label}: {pct:+.2f}%')
        else:
            print(f'{label}: 数据不足')

except Exception as e:
    print(f'错误: {e}')
" 2>/dev/null
    echo "=========================================="
}

cmd_batch() {
    if [ $# -eq 0 ]; then
        echo "错误: 请输入至少一个ETF代码"
        echo "示例: $0 batch 510300 159915 510500"
        return 1
    fi

    echo "=========================================="
    echo "批量查询 ETF 行情"
    echo "=========================================="
    printf "%-10s %-18s %-12s %-10s\n" "代码" "名称" "当前价格" "涨跌幅"
    echo "------------------------------------------"

    for code in "$@"; do
        local name
        name=$(get_etf_name "$code")
        local response
        response=$(fetch_etf_data "$code" "1d" "1m")

        if [ -z "$response" ]; then
            printf "%-10s %-18s %-12s %-10s\n" "$code" "$name" "N/A" "N/A"
            continue
        fi

        local data
        data=$(echo "$response" | python -c "
import json, sys
try:
    data = json.load(sys.stdin)
    result = data.get('chart', {}).get('result', [{}])[0]
    meta = result.get('meta', {})
    current = meta.get('regularMarketPrice', 0)
    prev = meta.get('previousClose', 0)
    if current and prev:
        pct = ((float(current) - float(prev)) / float(prev)) * 100
        print(f'{current}|{pct:+.2f}')
    else:
        print('N/A|N/A')
except: print('N/A|N/A')
" 2>/dev/null)

        IFS='|' read -r price pct <<< "$data"
        printf "%-10s %-18s %-12s %-10s\n" "$code" "$name" "$price" "${pct}%"
    done

    echo "=========================================="
}

cmd_hot() {
    echo "=========================================="
    echo "热门ETF"
    echo "=========================================="
    echo "[宽基指数]"
    echo "  510300 沪深300ETF    - A股核心蓝筹"
    echo "  510500 中证500ETF    - 中盘成长"
    echo "  159915 创业板ETF     - 新兴产业"
    echo "  588000 科创50ETF     - 科技创新"
    echo ""
    echo "[行业热门]"
    echo "  159997 芯片ETF       - 半导体"
    echo "  159995 新能源车ETF   - 新能源"
    echo "  512170 医疗ETF       - 医药医疗"
    echo ""
    echo "[策略/避险]"
    echo "  510880 红利ETF       - 高股息"
    echo "  518880 黄金ETF       - 避险"
    echo "=========================================="
}

cmd_search() {
    local keyword=$1
    if [ -z "$keyword" ]; then
        echo "错误: 请输入搜索关键词"
        return 1
    fi

    echo "=========================================="
    echo "搜索: $keyword"
    echo "=========================================="

    local results
    results=$(echo "$ETF_LIST" | grep -i "$keyword" || true)

    if [ -z "$results" ]; then
        echo "未找到相关ETF"
        echo "提示: 可尝试更简短的关键词，如\"芯片\"\"黄金\"\"红利\""
    else
        local count
        count=$(echo "$results" | wc -l)
        echo "找到 $count 个结果:"
        echo ""
        echo "$results" | while IFS=: read -r code name; do
            printf "  %-10s %s\n" "$code" "$name"
        done
    fi
    echo "=========================================="
}

cmd_compare() {
    local code1=$1
    local code2=$2

    if [ -z "$code1" ] || [ -z "$code2" ]; then
        echo "错误: 请输入两个ETF代码"
        echo "示例: $0 compare 510300 159915"
        return 1
    fi

    local name1
    name1=$(get_etf_name "$code1")
    local name2
    name2=$(get_etf_name "$code2")

    echo "=========================================="
    echo "ETF对比分析"
    echo "$name1($code1)  VS  $name2($code2)"
    echo "=========================================="

    local resp1
    resp1=$(fetch_etf_data "$code1" "1y" "1d")
    local resp2
    resp2=$(fetch_etf_data "$code2" "1y" "1d")

    if [ -z "$resp1" ] || [ -z "$resp2" ]; then
        echo "错误: 无法获取ETF数据"
        return 1
    fi

    python -c "
import json, sys, math

def analyze(json_str):
    data = json.loads(json_str)
    result = data.get('chart', {}).get('result', [{}])[0]
    meta = result.get('meta', {})
    timestamps = result.get('timestamp', [])
    quotes = result.get('indicators', {}).get('quote', [{}])[0]
    raw_closes = quotes.get('close', [])

    closes = [raw_closes[i] for i in range(len(timestamps))
              if i < len(raw_closes) and raw_closes[i] is not None and raw_closes[i] > 0]

    if len(closes) < 20:
        return None

    current = closes[-1]
    prev = meta.get('previousClose', closes[-2])

    daily_pct = ((current - prev) / prev) * 100 if prev else 0

    periods = {}
    for label, days in [('1W', 5), ('1M', 21), ('3M', 63), ('6M', 126), ('1Y', 252)]:
        if len(closes) > days:
            old = closes[-(days + 1)]
            periods[label] = ((current - old) / old) * 100 if old > 0 else 0
        else:
            periods[label] = None

    log_returns = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))
                   if closes[i - 1] > 0 and closes[i] > 0]

    annual_vol = 0
    max_dd = 0
    sharpe = 0
    if len(log_returns) > 10:
        mean_r = sum(log_returns) / len(log_returns)
        var = sum((r - mean_r) ** 2 for r in log_returns) / (len(log_returns) - 1)
        daily_v = var ** 0.5
        annual_vol = daily_v * math.sqrt(252) * 100

        n_y = len(closes) / 252
        ann_ret = ((closes[-1] / closes[0]) ** (1 / n_y) - 1) * 100 if n_y > 0 else 0
        sharpe = (ann_ret - 2.0) / annual_vol if annual_vol > 0 else 0

        peak = closes[0]
        for p in closes:
            if p > peak:
                peak = p
            dd = (peak - p) / peak
            if dd > max_dd:
                max_dd = dd

    high_w = max(closes)
    low_w = min(closes)
    position = ((current - low_w) / (high_w - low_w) * 100) if high_w != low_w else 50

    return {
        'price': current,
        'daily': daily_pct,
        'periods': periods,
        'vol': annual_vol,
        'max_dd': max_dd * 100,
        'sharpe': sharpe,
        'position': position,
    }

try:
    r1 = analyze('''$(echo "$resp1")''')
    r2 = analyze('''$(echo "$resp2")''')

    if not r1 or not r2:
        print('错误: 数据不足，无法对比')
        sys.exit(1)

    print(f'')
    print(f'{\"指标\":<18} {\"$code1\":<16} {\"$code2\":<16} {\"优势方\":<10}')
    print('-' * 60)
    print(f'{\"当前价格\":<18} {r1[\"price\"]:<16.4f} {r2[\"price\"]:<16.4f}')
    print(f'{\"今日涨跌\":<18} {r1[\"daily\"]:+.2f}%{\"\":<11} {r2[\"daily\"]:+.2f}%')

    for label in ['1W', '1M', '3M', '6M', '1Y']:
        v1 = r1['periods'].get(label)
        v2 = r2['periods'].get(label)
        if v1 is not None and v2 is not None:
            winner = '$code1' if v1 > v2 else '$code2'
            print(f'{label + \"收益\":<18} {v1:+.2f}%{\"\":<11} {v2:+.2f}%{\"\":<11} {winner}')

    w_vol = '$code1' if r1['vol'] < r2['vol'] else '$code2'
    print(f'{\"年化波动率\":<18} {r1[\"vol\"]:.1f}%{\"\":<12} {r2[\"vol\"]:.1f}%{\"\":<12} {w_vol}(更低)')

    w_dd = '$code1' if r1['max_dd'] < r2['max_dd'] else '$code2'
    print(f'{\"最大回撤\":<18} {r1[\"max_dd\"]:.1f}%{\"\":<12} {r2[\"max_dd\"]:.1f}%{\"\":<12} {w_dd}(更小)')

    w_sh = '$code1' if r1['sharpe'] > r2['sharpe'] else '$code2'
    print(f'{\"夏普比率\":<18} {r1[\"sharpe\"]:.2f}{\"\":<14} {r2[\"sharpe\"]:.2f}{\"\":<14} {w_sh}')

    print(f'{\"价格位置\":<18} {r1[\"position\"]:.0f}%{\"\":<13} {r2[\"position\"]:.0f}%')

except Exception as e:
    print(f'对比分析出错: {e}')
" 2>/dev/null
    echo ""
    echo "=========================================="
}

cmd_calc() {
    local code=$1
    local amount=$2
    local years=$3

    if [ -z "$code" ] || [ -z "$amount" ] || [ -z "$years" ]; then
        echo "错误: 参数不全"
        echo "示例: $0 calc 510300 1000 10"
        echo "含义: 每月定投1000元到510300，持续10年"
        return 1
    fi

    local name
    name=$(get_etf_name "$code")

    echo "=========================================="
    echo "定投计算器 - 多情景分析"
    echo "=========================================="
    echo "ETF: $name ($code)"
    echo "月定投: ¥$amount"
    echo "定投年限: $years 年"
    echo "------------------------------------------"

    python -c "
months = $years * 12
amount = $amount
total_invest = amount * months

print(f'')
print(f'总投入: ¥{total_invest:,.0f}')
print(f'')
print(f'不同年化收益率下的预估结果:')
print(f'')
print(f'{\"情景\":<16} {\"年化收益\":<10} {\"预计终值\":<16} {\"预计收益\":<16} {\"回报率\":<10}')
print('-' * 68)

scenarios = [
    ('悲观', 0.03),
    ('保守', 0.05),
    ('中性', 0.08),
    ('乐观', 0.10),
    ('极乐观', 0.12),
]

for name, annual in scenarios:
    monthly = annual / 12
    if monthly > 0:
        fv = amount * (((1 + monthly) ** months - 1) / monthly)
    else:
        fv = total_invest
    profit = fv - total_invest
    roi = (profit / total_invest) * 100 if total_invest > 0 else 0
    print(f'{name:<16} {annual*100:.0f}%{\"\":<7} ¥{fv:>12,.0f}   ¥{profit:>12,.0f}   {roi:>6.0f}%')

print(f'')
print(f'说明:')
print(f'  - 沪深300长期年化约8-10%，创业板约10-15%（含高波动）')
print(f'  - 实际收益受市场波动、入场时点影响较大')
print(f'  - 定投在下跌市中积累便宜份额，上涨市中兑现收益')
print(f'  - 建议累计收益达30-50%时考虑分批止盈')
" 2>/dev/null
    echo "=========================================="
}

cmd_category() {
    echo "=========================================="
    echo "ETF 行业分类"
    echo "=========================================="
    echo ""
    echo "[宽基指数 - 配置底仓首选]"
    echo "  510300 沪深300ETF    - A股核心蓝筹，市值最大300家"
    echo "  510050 上证50ETF     - A股最大50家，超大盘集中"
    echo "  510500 中证500ETF    - 中盘成长股，与沪深300互补"
    echo "  159915 创业板ETF     - 新兴产业，高成长性"
    echo "  159845 中证1000ETF   - 小盘股，高弹性高风险"
    echo "  588000 科创50ETF     - 科创板龙头，硬科技"
    echo ""
    echo "[行业主题 - 赛道投资]"
    echo "  159997 芯片ETF       - 半导体产业链"
    echo "  159995 新能源车ETF   - 电动车产业链"
    echo "  512170 医疗ETF       - 医药医疗器械"
    echo "  512880 光伏ETF       - 太阳能光伏"
    echo "  512760 券商ETF       - 证券公司"
    echo "  511880 中证消费ETF   - 消费升级"
    echo ""
    echo "[策略/避险]"
    echo "  510880 红利ETF       - 高股息率，稳定现金流"
    echo "  518880 黄金ETF       - 避险抗通胀"
    echo ""
    echo "=========================================="
}

cmd_summary() {
    echo "=========================================="
    echo "ETF投资速览"
    echo "=========================================="
    echo ""
    echo "入门推荐:"
    echo "  保守 -> 沪深300(510300) + 红利(510880)"
    echo "  均衡 -> 沪深300(510300) + 中证500(510500) + 红利(510880)"
    echo "  进取 -> 创业板(159915) + 科创50(588000) + 行业ETF"
    echo ""
    echo "配置原则:"
    echo "  1. 宽基指数做底仓，占60%以上"
    echo "  2. 行业ETF做卫星，单只不超过20%"
    echo "  3. 黄金/红利做防御，占10-20%"
    echo ""
    echo "定投建议:"
    echo "  - 首选沪深300或中证500"
    echo "  - 每月固定金额，坚持至少3年"
    echo "  - 大跌加码，累计盈利30-50%止盈"
    echo ""
    echo "=========================================="
}

main() {
    check_dependencies
    init_cache

    local cmd="${1:-help}"
    case "$cmd" in
        list)
            cmd_list
            ;;
        price)
            cmd_price "${2:-}"
            ;;
        analyze)
            cmd_analyze "${2:-}"
            ;;
        hot)
            cmd_hot
            ;;
        search)
            cmd_search "${2:-}"
            ;;
        compare)
            cmd_compare "${2:-}" "${3:-}"
            ;;
        calc)
            cmd_calc "${2:-}" "${3:-}" "${4:-}"
            ;;
        history)
            cmd_history "${2:-}"
            ;;
        batch)
            shift
            cmd_batch "$@"
            ;;
        category)
            cmd_category
            ;;
        summary)
            cmd_summary
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            echo "错误: 未知命令 '$cmd'"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
