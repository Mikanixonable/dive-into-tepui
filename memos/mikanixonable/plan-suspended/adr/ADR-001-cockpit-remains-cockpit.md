# ADR-001: 操縦部品の名称と責務は cockpit のまま維持する

- 日付: 2026-09-14
- 状態: superseded by ADR-002
- 対象計画: vessel-assembly-dock-construction-plan_2026-09-14.md

## 決定

船体モジュールの操縦部品は `command` へ改名せず、既存の `cockpit` をそのまま使う。

`cockpit` は、健全である場合に操縦命令を受けられる能力を与える。存在する cockpit が全損した場合は
船体喪失とする。cockpit を元から持たないブースター断片は、cockpit 不在だけでは喪失させない。

## 理由

現行コードとSPECが `cockpit` を既存部品型、HP配分、critical-part喪失条件として扱っているため、
改名による概念の分裂を避ける。`command` を新しい部品名にすると、保存・表示・性能移行の対応関係が
不要に増える。

## 影響

- モジュールカタログは `cockpit` を含み、`command` は含まない。
- 計画書中の船体部品としての `command` 表記は `cockpit` に統一する。
- `flight command` のように入力操作を表す一般語の command はこの決定の対象外とする。
