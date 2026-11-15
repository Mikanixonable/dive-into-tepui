#!/bin/bash
# 雲のフィードバックループの半自動化 — 生成気象の焼き直しと regime 監査を 1 コマンドで回す。
#
# 使い方:
#   tools/cloud-loop.sh run <label>            # probe 再生成 + 監査 → history/audit-<label>.txt
#   tools/cloud-loop.sh audit-only <label>     # probe を飛ばして監査だけ(対応づけ・採点器側の変更時)
#   tools/cloud-loop.sh diff <A> <B>           # 2 つの監査レポートの見出し点と区分表を並べる
#
# ラベルは比較の単位(候補名)。レポートは .cloud-detail/history/audit-<label>.txt に残る。
# ポートは CLOUD_LAB_PORT / CLOUD_LAB_DEBUG_PORT で差し替えられる。
set -e
cd "$(dirname "$0")/.."
PORT="${CLOUD_LAB_PORT:-8841}"
DPORT="${CLOUD_LAB_DEBUG_PORT:-9541}"
HIST=".cloud-detail/history"
mkdir -p "$HIST"

headline() {
  sed -n '/見出しの点数/,/^=== (A)/p' "$1" | head -9
}
regime_rows() {
  sed -n '/(B) 区分ごとの平均/,/^tropical-land/p' "$1" | head -8
}

if [ "$1" = "run" ]; then
  [ -z "$2" ] && { echo "usage: cloud-loop.sh run <label>"; exit 1; }
  echo "=== probe: generated-weather の焼き直し (port $PORT) ==="
  CLOUD_LAB_PORT=$PORT CLOUD_LAB_DEBUG_PORT=$DPORT node tools/cloud-regime-weather.mjs
  echo "=== audit → $HIST/audit-$2.txt ==="
  node tools/cloud-regime-audit.mjs > "$HIST/audit-$2.txt"
  headline "$HIST/audit-$2.txt"
elif [ "$1" = "audit-only" ]; then
  [ -z "$2" ] && { echo "usage: cloud-loop.sh audit-only <label>"; exit 1; }
  echo "=== audit(probe 省略) → $HIST/audit-$2.txt ==="
  node tools/cloud-regime-audit.mjs > "$HIST/audit-$2.txt"
  headline "$HIST/audit-$2.txt"
elif [ "$1" = "diff" ]; then
  [ -z "$2" ] || [ -z "$3" ] && { echo "usage: cloud-loop.sh diff <A> <B>"; exit 1; }
  for f in "$2" "$3"; do
    echo "--- audit-$f.txt ---"
    headline "$HIST/audit-$f.txt"
    regime_rows "$HIST/audit-$f.txt"
  done
else
  sed -n '2,12p' "$0"
  exit 1
fi
