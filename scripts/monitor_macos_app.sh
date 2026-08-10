#!/usr/bin/env bash

set -euo pipefail

duration_seconds="${1:-600}"
interval_seconds="${2:-5}"
output_csv="${3:-/private/tmp/takagi-stability.csv}"
process_name="${4:-takagi-desktop-pet}"

if [[ ! "$duration_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "duration_seconds 必须是正整数" >&2
  exit 2
fi

if [[ ! "$interval_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "interval_seconds 必须是正整数" >&2
  exit 2
fi

pid="$(pgrep -x "$process_name" | head -n 1 || true)"
if [[ -z "$pid" ]]; then
  echo "未找到进程：$process_name" >&2
  exit 3
fi

output_dir="$(dirname "$output_csv")"
mkdir -p "$output_dir"

printf 'epoch_seconds,elapsed_seconds,pid,cpu_percent,rss_kib,process_elapsed\n' \
  > "$output_csv"

start_epoch="$(date +%s)"
sample_count=0

while kill -0 "$pid" 2>/dev/null; do
  current_epoch="$(date +%s)"
  elapsed_seconds=$((current_epoch - start_epoch))
  process_sample="$(ps -p "$pid" -o %cpu=,rss=,etime= | awk '{$1=$1; print}')"

  if [[ -z "$process_sample" ]]; then
    break
  fi

  cpu_percent="$(awk '{print $1}' <<< "$process_sample")"
  rss_kib="$(awk '{print $2}' <<< "$process_sample")"
  process_elapsed="$(awk '{print $3}' <<< "$process_sample")"
  printf '%s,%s,%s,%s,%s,%s\n' \
    "$current_epoch" \
    "$elapsed_seconds" \
    "$pid" \
    "$cpu_percent" \
    "$rss_kib" \
    "$process_elapsed" \
    >> "$output_csv"
  sample_count=$((sample_count + 1))

  if (( elapsed_seconds >= duration_seconds )); then
    break
  fi
  sleep "$interval_seconds"
done

if (( sample_count == 0 )); then
  echo "进程在首次采样前退出：$process_name ($pid)" >&2
  exit 4
fi

first_rss="$(awk -F, 'NR == 2 { print $5 }' "$output_csv")"
last_rss="$(awk -F, 'END { print $5 }' "$output_csv")"
max_rss="$(awk -F, 'NR > 1 && $5 > max { max = $5 } END { print max + 0 }' "$output_csv")"
average_cpu="$(awk -F, 'NR > 1 { sum += $4; count += 1 } END {
  if (count > 0) printf "%.2f", sum / count;
}' "$output_csv")"
rss_delta=$((last_rss - first_rss))

printf 'samples=%s first_rss_kib=%s last_rss_kib=%s rss_delta_kib=%s max_rss_kib=%s average_cpu_percent=%s csv=%s\n' \
  "$sample_count" \
  "$first_rss" \
  "$last_rss" \
  "$rss_delta" \
  "$max_rss" \
  "$average_cpu" \
  "$output_csv"
