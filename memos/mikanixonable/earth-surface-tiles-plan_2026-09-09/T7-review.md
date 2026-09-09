# T7: レビューと記録

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、このタスクを実装するときに読む作業単位である。共通の固定前提は親計画の§2、
依存関係は§3を参照する。実装済みの契約は`done/`ではなくコードを原本とする。


1. 差分をコードレビューし、Earth fallback、月/他天体、dispose、色空間、NoData、経度wrap、極、2:1 frontier、旧GEBCO参照を確認する。
2. `/refactor`の観点で重複境界、不要な公開API、コメント、例外経路を整理する。
3. `npm run typecheck`を常に実行し、render/game/data/releaseの変更に対応するテストを実行する。
4. 各段へcommit、検証コマンド、fixture完了または外部受け入れ待ちを追記する。
