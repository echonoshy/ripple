#!/bin/bash
# ETF投资助理 - Ripple Skill
# 功能：ETF查询、行情、筛选、对比、定投计算

set -euo pipefail

# 配置
TIMEOUT=10
MAX_RETRIES=2
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ripple-etf"
CACHE_TTL=300  # 5分钟缓存

# 常用ETF列表
ETF_LIST="510300:沪深300ETF
510500:中证500ETF
159915:创业板ETF
159941:纳指ETF
513100:恒生ETF
510880:红利ETF
159919:科创50ETF
159997:芯片ETF
159995:新能源车ETF
512880:光伏ETF
512760:券商ETF
512170:医疗ETF
159845:中证1000ETF
511880:中证消费ETF"

# 依赖检查
check_dependencies() {
    local missing=()
    for cmd in curl python3 bc; do
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

# 初始化缓存目录
init_cache() {
    mkdir -p "$CACHE_DIR"
}

# 获取缓存文件路径
get_cache_file() {
    local key=$1
    echo "$CACHE_DIR/${key}.cache"
}

# 检查缓存是否有效
is_cache_valid() {
    local cache_file=$1
    if [ ! -f "$cache_file" ]; then
        return 1
    fi

    local cache_time=$(stat -c %Y "$cache_file" 2>/dev/null || echo 0)
    local current_time=$(date +%s)
    local age=$((current_time - cache_time))

    [ $age -lt $CACHE_TTL ]
}

# 读取缓存
read_cache() {
    local cache_file=$1
    if is_cache_valid "$cache_file"; then
        cat "$cache_file"
        return 0
    fi
    return 1
}

# 写入缓存
write_cache() {
    local cache_file=$1
    local data=$2
    echo "$data" > "$cache_file"
}

show_help() {
    cat << 'EOF'
==========================================
      ETF投资助理 - Ripple Skill
==========================================

用法: etf-assistant.sh <命令> [参数]

命令:
  list                          显示常用ETF列表
  price <代码>                  查询ETF实时行情
  history <代码>                查询历史涨跌幅(1周/1月/3月)
  batch <代码1> <代码2> ...     批量查询多个ETF
  hot                           显示热门ETF
  search <关键词>               搜索ETF
  compare <代码1> <代码2>       对比两只ETF
  calc <代码> <金额> <年限>     定投计算器
  category                      按行业分类展示ETF
  summary                       ETF投资摘要
  help                          显示帮助

示例:
  etf-assistant.sh list
  etf-assistant.sh price 510300
  etf-assistant.sh history 510300
  etf-assistant.sh batch 510300 159915 159919
  etf-assistant.sh compare 510300 159915
  etf-assistant.sh calc 510300 1000 10
  etf-assistant.sh category
EOF
}

get_etf_name() {
    local code=$1
    local name=$(echo "$ETF_LIST" | grep "^${code}:" | cut -d: -f2)
    if [ -z "$name" ]; then
        echo "未知ETF"
    else
        echo "$name"
    fi
}

# 显示ETF列表
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

# 获取ETF数据（带重试和缓存）
fetch_etf_data() {
    local code=$1
    local cache_file=$(get_cache_file "$code")

    # 尝试读取缓存
    if read_cache "$cache_file" 2>/dev/null; then
        return 0
    fi

    # 请求数据（带重试）
    local response=""
    local retry=0
    while [ $retry -lt $MAX_RETRIES ]; do
        response=$(curl -s --max-time $TIMEOUT \
            "https://query1.finance.yahoo.com/v8/finance/chart/${code}.SS" 2>/dev/null)

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

# 查询ETF行情
cmd_price() {
    local code=$1
    if [ -z "$code" ]; then
        echo "错误: 请输入ETF代码"
        return 1
    fi

    local name=$(get_etf_name "$code")
    echo "=========================================="
    echo "$name ($code) 实时行情"
    echo "=========================================="

    local response=$(fetch_etf_data "$code")

    if [ -z "$response" ]; then
        echo "错误: 无法获取行情数据"
        echo "可能原因:"
        echo "  1. 网络连接问题"
        echo "  2. ETF代码不存在"
        echo "  3. Yahoo Finance API 暂时不可用"
        return 1
    fi

    # 解析数据
    local data=$(echo "$response" | python3 -c "
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
        print(f'{current}|{prev_close}|{diff:+.4f}|{pct:+.2f}')
    else:
        print('N/A|N/A|N/A|N/A')
except Exception as e:
    print('N/A|N/A|N/A|N/A')
" 2>/dev/null)

    IFS='|' read -r current prev_close diff pct <<< "$data"

    if [ "$current" = "N/A" ]; then
        echo "错误: 数据解析失败"
        return 1
    fi

    echo "当前价格: $current"
    echo "昨收价格: $prev_close"
    echo "涨跌幅度: $diff ($pct%)"

    if [[ "$diff" == +* ]]; then
        echo "趋势: 上涨"
    else
        echo "趋势: 下跌"
    fi
    echo "=========================================="
}

# 热门ETF
cmd_hot() {
    echo "=========================================="
    echo "热门ETF推荐"
    echo "=========================================="
    echo "1. 沪深300ETF (510300) - 蓝筹白马"
    echo "2. 科创50ETF (159919) - 科技创新"
    echo "3. 纳指ETF (159941) - 美股科技"
    echo "4. 恒生ETF (513100) - 港股核心"
    echo "5. 中证500ETF (510500) - 中盘成长"
    echo "6. 创业板ETF (159915) - 新兴产业"
    echo "7. 芯片ETF (159997) - 半导体"
    echo "8. 新能源车ETF (159995) - 新能源"
    echo "=========================================="
}

# 搜索ETF
cmd_search() {
    local keyword=$1
    if [ -z "$keyword" ]; then
        echo "错误: 请输入搜索关键词"
        return 1
    fi

    echo "=========================================="
    echo "搜索: $keyword"
    echo "=========================================="

    local results=$(echo "$ETF_LIST" | grep -i "$keyword")

    if [ -z "$results" ]; then
        echo "未找到相关ETF"
    else
        local count=$(echo "$results" | wc -l)
        echo "找到 $count 个结果:"
        echo ""
        echo "$results" | while IFS=: read -r code name; do
            printf "%-10s %s\n" "$code" "$name"
        done
    fi
    echo "=========================================="
}

# ETF对比
cmd_compare() {
    local code1=$1
    local code2=$2

    if [ -z "$code1" ] || [ -z "$code2" ]; then
        echo "错误: 请输入两个ETF代码"
        echo "示例: $0 compare 510300 159915"
        return 1
    fi

    local name1=$(get_etf_name "$code1")
    local name2=$(get_etf_name "$code2")

    echo "=========================================="
    echo "ETF对比分析"
    echo "=========================================="
    echo "$code1 $name1  VS  $code2 $name2"
    echo "------------------------------------------"

    # 获取两只ETF的数据
    local response1=$(fetch_etf_data "$code1")
    local response2=$(fetch_etf_data "$code2")

    if [ -z "$response1" ] || [ -z "$response2" ]; then
        echo "错误: 无法获取ETF数据"
        return 1
    fi

    # 解析数据
    local data1=$(echo "$response1" | python3 -c "
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

    local data2=$(echo "$response2" | python3 -c "
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

    IFS='|' read -r price1 pct1 <<< "$data1"
    IFS='|' read -r price2 pct2 <<< "$data2"

    printf "%-20s %-15s %-15s\n" "指标" "$code1" "$code2"
    echo "------------------------------------------"
    printf "%-20s %-15s %-15s\n" "当前价格" "$price1" "$price2"
    printf "%-20s %-15s %-15s\n" "今日涨跌幅" "$pct1%" "$pct2%"
    echo "=========================================="
}

# 定投计算器
cmd_calc() {
    local code=$1
    local amount=$2
    local years=$3

    if [ -z "$code" ] || [ -z "$amount" ] || [ -z "$years" ]; then
        echo "错误: 参数不全"
        echo "示例: $0 calc 510300 1000 10"
        echo "含义: 每月定投1000元，定投10年"
        return 1
    fi

    local name=$(get_etf_name "$code")

    echo "=========================================="
    echo "定投计算器"
    echo "=========================================="
    echo "ETF: $name ($code)"
    echo "月定投: ¥$amount"
    echo "定投年限: $years 年"
    echo "------------------------------------------"

    # 计算（假设年化收益率8%）
    local months=$((years * 12))
    local total_invest=$((amount * months))

    # 使用Python计算复利（bc的^运算符不可靠）
    local result=$(python3 -c "
annual_return = 0.08
monthly_return = annual_return / 12
months = $months
amount = $amount

# 定投终值公式: FV = PMT * ((1 + r)^n - 1) / r
future_value = amount * (((1 + monthly_return) ** months - 1) / monthly_return)
profit = future_value - ($total_invest)

print(f'{future_value:.2f}|{profit:.2f}')
" 2>/dev/null)

    IFS='|' read -r future_value profit <<< "$result"

    echo ""
    echo "估算收益 (假设年化8%):"
    echo "  总投入: ¥$total_invest"
    echo "  预计价值: ¥$future_value"
    echo "  预计收益: ¥$profit"
    echo ""
    echo "提示: 实际收益取决于市场表现，此为理想情况估算"
    echo "=========================================="
}

# 历史数据查询
cmd_history() {
    local code=$1
    if [ -z "$code" ]; then
        echo "错误: 请输入ETF代码"
        return 1
    fi

    local name=$(get_etf_name "$code")
    echo "=========================================="
    echo "$name ($code) 历史涨跌幅"
    echo "=========================================="

    # 获取历史数据（1个月、3个月、1年）
    local response=$(fetch_etf_data "$code")

    if [ -z "$response" ]; then
        echo "错误: 无法获取历史数据"
        return 1
    fi

    # 解析历史数据
    local history_data=$(echo "$response" | python3 -c "
import json, sys
from datetime import datetime, timedelta

try:
    data = json.load(sys.stdin)
    result = data.get('chart', {}).get('result', [{}])[0]

    # 获取时间戳和收盘价
    timestamps = result.get('timestamp', [])
    quotes = result.get('indicators', {}).get('quote', [{}])[0]
    closes = quotes.get('close', [])

    if not timestamps or not closes:
        print('N/A|N/A|N/A')
        sys.exit(0)

    # 当前价格（最后一个有效值）
    current_price = None
    for price in reversed(closes):
        if price is not None:
            current_price = price
            break

    if not current_price:
        print('N/A|N/A|N/A')
        sys.exit(0)

    # 计算不同时间段的涨跌幅
    now = datetime.now()
    periods = {
        '1w': 7,
        '1m': 30,
        '3m': 90,
    }

    results = []
    for period_name, days in periods.items():
        target_time = (now - timedelta(days=days)).timestamp()

        # 找到最接近的历史价格
        closest_idx = 0
        min_diff = float('inf')
        for i, ts in enumerate(timestamps):
            diff = abs(ts - target_time)
            if diff < min_diff and closes[i] is not None:
                min_diff = diff
                closest_idx = i

        if closes[closest_idx] is not None:
            old_price = closes[closest_idx]
            pct_change = ((current_price - old_price) / old_price) * 100
            results.append(f'{pct_change:+.2f}')
        else:
            results.append('N/A')

    print('|'.join(results))

except Exception as e:
    print('N/A|N/A|N/A')
" 2>/dev/null)

    IFS='|' read -r week_pct month_pct quarter_pct <<< "$history_data"

    echo "近1周涨跌: ${week_pct}%"
    echo "近1月涨跌: ${month_pct}%"
    echo "近3月涨跌: ${quarter_pct}%"
    echo "=========================================="
}

# 批量查询
cmd_batch() {
    if [ $# -eq 0 ]; then
        echo "错误: 请输入至少一个ETF代码"
        echo "示例: $0 batch 510300 159915 159919"
        return 1
    fi

    echo "=========================================="
    echo "批量查询 ETF 行情"
    echo "=========================================="
    printf "%-10s %-20s %-12s %-12s\n" "代码" "名称" "当前价格" "涨跌幅"
    echo "------------------------------------------"

    for code in "$@"; do
        local name=$(get_etf_name "$code")
        local response=$(fetch_etf_data "$code")

        if [ -z "$response" ]; then
            printf "%-10s %-20s %-12s %-12s\n" "$code" "$name" "N/A" "N/A"
            continue
        fi

        local data=$(echo "$response" | python3 -c "
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
        printf "%-10s %-20s %-12s %-12s\n" "$code" "$name" "$price" "${pct}%"
    done

    echo "=========================================="
}

# 按行业分类展示
cmd_category() {
    echo "=========================================="
    echo "ETF 行业分类"
    echo "=========================================="
    echo ""
    echo "[宽基指数 - 分散投资首选]"
    echo "  510300 沪深300ETF    - A股核心蓝筹，市值最大300家"
    echo "  510500 中证500ETF    - 中盘成长股，补充大盘"
    echo "  159915 创业板ETF     - 新兴产业，高成长性"
    echo "  159845 中证1000ETF   - 小盘股，高风险高收益"
    echo ""
    echo "[科技创新 - 高成长赛道]"
    echo "  159919 科创50ETF     - 科创板龙头，硬科技"
    echo "  159997 芯片ETF       - 半导体产业链"
    echo "  512760 券商ETF       - 金融科技"
    echo ""
    echo "[新能源 - 碳中和主题]"
    echo "  159995 新能源车ETF   - 电动车产业链"
    echo "  512880 光伏ETF       - 太阳能光伏"
    echo ""
    echo "[医疗健康 - 防御性板块]"
    echo "  512170 医疗ETF       - 医药医疗器械"
    echo ""
    echo "[消费 - 内需驱动]"
    echo "  511880 中证消费ETF   - 消费升级"
    echo ""
    echo "[港股/海外 - 全球配置]"
    echo "  513100 恒生ETF       - 港股核心指数"
    echo "  159941 纳指ETF       - 美股科技巨头"
    echo ""
    echo "[Smart Beta - 策略增强]"
    echo "  510880 红利ETF       - 高股息率，稳定现金流"
    echo ""
    echo "=========================================="
    echo "投资建议:"
    echo "  - 新手: 宽基指数 (510300/510500)"
    echo "  - 进取: 科技创新 + 新能源"
    echo "  - 稳健: 红利ETF + 医疗ETF"
    echo "  - 全球: 港股 + 纳指"
    echo "=========================================="
}

# ETF投资摘要
cmd_summary() {
    echo "=========================================="
    echo "ETF投资摘要"
    echo "=========================================="
    echo ""
    echo "主流ETF分类:"
    echo ""
    echo "[宽基指数]"
    echo "  510300 沪深300 - 蓝筹白马代表"
    echo "  159915 创业板 - 新兴产业"
    echo "  159919 科创50 - 科技创新"
    echo "  159941 纳指100 - 美股科技"
    echo ""
    echo "[行业主题]"
    echo "  159997 芯片ETF - 半导体"
    echo "  159995 新能源车 - 新能源"
    echo "  512170 医疗ETF - 医药医疗"
    echo "  512880 光伏ETF - 光伏产业"
    echo ""
    echo "[港股/海外]"
    echo "  513100 恒生ETF - 港股核心"
    echo "  513050 中概互联 - 互联网"
    echo ""
    echo "[Smart Beta]"
    echo "  510880 红利ETF - 高股息"
    echo ""
    echo "=========================================="
}

# 主逻辑
main() {
    check_dependencies
    init_cache

    case "$1" in
        list)
            cmd_list
            ;;
        price)
            cmd_price "$2"
            ;;
        hot)
            cmd_hot
            ;;
        search)
            cmd_search "$2"
            ;;
        compare)
            cmd_compare "$2" "$3"
            ;;
        calc)
            cmd_calc "$2" "$3" "$4"
            ;;
        history)
            cmd_history "$2"
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
        help|--help|-h|"")
            show_help
            ;;
        *)
            echo "错误: 未知命令 '$1'"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
