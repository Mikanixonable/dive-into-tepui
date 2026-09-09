# T6-3: runtime接続の扱い

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

runtime bootstrap、Pages subpath、manifest URL、dataset検証はT3へ統合する。
このファイルは旧T6-3の重複手順を残さず、実装者が参照を間違えないための移行記録だけを持つ。

## T3へ移す要件

- manifest URLをデータセットの正本にする。
- Pagesのrepository subpathからmanifestと相対asset URLを解決する。
- manifest、tile-index、datasetId、hash不一致、URL未設定を検査する。
- loading/ready/error/fallbackをゲーム更新へ公開する。
- T3の検証でpackage、check、build、release URLの整合を確認する。

T6-3単独の実装完了条件は廃止する。T3の完了条件を満たした時点でruntime接続を完了とする。
