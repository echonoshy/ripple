#!/bin/sh

set -eu

CHUNK_LINES=3200
COMMAND=
TARGET=
CHUNK=
MAX_DEPTH=

fail() {
    printf '{"status":"error","error":"%s"}\n' "$1"
    exit 1
}

json_bool() {
    if [ "$1" = "1" ]; then
        printf true
    else
        printf false
    fi
}

target_file() {
    case "$1" in
        summary) printf summary.md ;;
        mindmap) printf mind.md ;;
        title) printf title.md ;;
        *) fail "target must be summary, mindmap, or title" ;;
    esac
}

todo_start_line() {
    awk '
        /^#+[[:space:]]/ {
            last_heading = NR
            heading = tolower($0)
            last_is_todo = index($0, "待办") || heading ~ /todo/ || heading ~ /to-do/ || heading ~ /action item/
        }
        /^[[:space:]]*-[[:space:]]*\[[ xX]\][[:space:]]+/ {
            if (last_is_todo) {
                print last_heading
            } else {
                print NR
            }
            exit
        }
    ' "$1"
}

[ "$#" -gt 0 ] || fail "command is required"
COMMAND=$1
shift
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target)
            [ "$#" -ge 2 ] || fail "--target requires a value"
            TARGET=$2
            shift 2
            ;;
        --chunk)
            [ "$#" -ge 2 ] || fail "--chunk requires a value"
            CHUNK=$2
            shift 2
            ;;
        --max-depth)
            [ "$#" -ge 2 ] || fail "--max-depth requires a value"
            MAX_DEPTH=$2
            shift 2
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

[ -n "$TARGET" ] || fail "--target is required"
TARGET_FILE=$(target_file "$TARGET")
[ -f AGENTS.md ] || fail "current Record is missing AGENTS.md"
if [ -f transcript.md ]; then
    SOURCE_FILE=transcript.md
elif [ -f content.md ]; then
    SOURCE_FILE=content.md
else
    fail "current Record is missing transcript.md or content.md"
fi

SOURCE_LINES=$(wc -l < "$SOURCE_FILE" | tr -d ' ')
SOURCE_BYTES=$(wc -c < "$SOURCE_FILE" | tr -d ' ')
[ "$SOURCE_LINES" -gt 0 ] || fail "transcript is empty"
CHUNKS=$(( (SOURCE_LINES + CHUNK_LINES - 1) / CHUNK_LINES ))

case "$COMMAND" in
    inspect)
        TODO_PRESENT=0
        TODO_HASH=null
        if [ "$TARGET" = summary ] && [ -f "$TARGET_FILE" ]; then
            TODO_START=$(todo_start_line "$TARGET_FILE")
            if [ -n "$TODO_START" ]; then
                TODO_PRESENT=1
                TODO_HASH=\"$(tail -n "+$TODO_START" "$TARGET_FILE" | sha256sum | awk '{print $1}')\"
            fi
        fi
        SOURCE_HASH=$(sha256sum "$SOURCE_FILE" | awk '{print $1}')
        printf '{"schema_version":1,"target":"%s","source":{"path":"%s","bytes":%s,"lines":%s,"sha256":"%s","chunk_lines":%s,"chunks":[' \
            "$TARGET" "$SOURCE_FILE" "$SOURCE_BYTES" "$SOURCE_LINES" "$SOURCE_HASH" "$CHUNK_LINES"
        INDEX=1
        while [ "$INDEX" -le "$CHUNKS" ]; do
            START=$(( (INDEX - 1) * CHUNK_LINES + 1 ))
            END=$(( INDEX * CHUNK_LINES ))
            if [ "$END" -gt "$SOURCE_LINES" ]; then
                END=$SOURCE_LINES
            fi
            [ "$INDEX" -eq 1 ] || printf ','
            printf '{"chunk":%s,"start_line":%s,"end_line":%s}' "$INDEX" "$START" "$END"
            INDEX=$((INDEX + 1))
        done
        printf ']},"preservation":{"todo_present":'
        json_bool "$TODO_PRESENT"
        printf ',"todo_sha256":%s}}\n' "$TODO_HASH"
        ;;
    read)
        case "$CHUNK" in
            ''|*[!0-9]*) fail "--chunk must be a positive integer" ;;
        esac
        [ "$CHUNK" -ge 1 ] && [ "$CHUNK" -le "$CHUNKS" ] ||
            fail "chunk is outside the source plan"
        START=$(( (CHUNK - 1) * CHUNK_LINES + 1 ))
        END=$(( CHUNK * CHUNK_LINES ))
        if [ "$END" -gt "$SOURCE_LINES" ]; then
            END=$SOURCE_LINES
        fi
        printf '{"schema_version":1,"chunk":%s,"chunks_total":%s,"start_line":%s,"end_line":%s}\n' \
            "$CHUNK" "$CHUNKS" "$START" "$END"
        sed -n "${START},${END}p" "$SOURCE_FILE"
        ;;
    apply)
        DRAFT=$(mktemp "./.${TARGET_FILE}.draft.XXXXXX")
        OUTPUT=$(mktemp "./.${TARGET_FILE}.output.XXXXXX")
        cleanup() {
            rm -f "$DRAFT" "$OUTPUT"
        }
        trap cleanup EXIT HUP INT TERM
        cat > "$DRAFT"
        grep -q '[^[:space:]]' "$DRAFT" || fail "draft is empty"

        if [ "$TARGET" = title ]; then
            TITLE_LINES=$(awk 'END { print NR }' "$DRAFT")
            [ "$TITLE_LINES" -eq 1 ] || fail "title must contain exactly one line"
        fi
        if [ "$TARGET" = summary ] &&
            grep -Eq '^[[:space:]]*-[[:space:]]*\[[ xX]\][[:space:]]+' "$DRAFT"; then
            fail "summary draft must not contain todo task lines"
        fi
        if [ "$TARGET" = mindmap ]; then
            HEADING_DEPTH=$(awk '
                /^#+[[:space:]]/ {
                    depth = index($0, " ") - 1
                    if (depth > max) max = depth
                    found = 1
                }
                END {
                    if (!found) exit 2
                    print max
                }
            ' "$DRAFT") || fail "mind map must contain Markdown headings"
            if [ -n "$MAX_DEPTH" ]; then
                case "$MAX_DEPTH" in
                    *[!0-9]*|'') fail "--max-depth must be a positive integer" ;;
                esac
                [ "$MAX_DEPTH" -ge 1 ] || fail "--max-depth must be a positive integer"
                [ "$HEADING_DEPTH" -le "$MAX_DEPTH" ] ||
                    fail "mind map heading depth exceeds maximum"
            fi
        fi

        cat "$DRAFT" > "$OUTPUT"
        if [ "$TARGET" = summary ] && [ -f "$TARGET_FILE" ]; then
            TODO_START=$(todo_start_line "$TARGET_FILE")
            if [ -n "$TODO_START" ]; then
                printf '\n' >> "$OUTPUT"
                tail -n "+$TODO_START" "$TARGET_FILE" >> "$OUTPUT"
            fi
        fi
        mv "$OUTPUT" "$TARGET_FILE"
        TARGET_HASH=$(sha256sum "$TARGET_FILE" | awk '{print $1}')
        TARGET_BYTES=$(wc -c < "$TARGET_FILE" | tr -d ' ')
        TODO_PRESERVED=0
        if [ "$TARGET" = summary ] && [ -n "${TODO_START:-}" ]; then
            TODO_PRESERVED=1
        fi
        printf '{"schema_version":1,"status":"applied","target":"%s","bytes":%s,"sha256":"%s","todo_preserved":' \
            "$TARGET" "$TARGET_BYTES" "$TARGET_HASH"
        json_bool "$TODO_PRESERVED"
        printf '}\n'
        ;;
    *)
        fail "command must be inspect, read, or apply"
        ;;
esac
