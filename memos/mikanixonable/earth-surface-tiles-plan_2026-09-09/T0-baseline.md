# T0: 基準状態を保存する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、このタスクを実装するときに読む作業単位である。共通の固定前提は親計画の§2、
依存関係は§3を参照する。実装済みの契約は`done/`ではなくコードを原本とする。


**目的**: 実装前後を比較し、無関係なprotein差分を混ぜない。

1. `git rev-parse --short HEAD`、Node/npm、macOS、ブラウザ、WebGPU backend、実描画サイズを
   `.earth-surface/verification/baseline.json`へ保存する。
2. 次を実行し、件数・終了コード・commitを同じJSONへ保存する。

   ```text
   npm run typecheck
   npm run test:render
   npm run test:game
   npm run earth-surface:test
   python3 -m unittest discover -s tools/earth-surface -p 'test_*.py'
   ```

3. `.earth-surface/`、生成bundle、撮影画像をGit管理対象へ入れない。protein差分は触らない。

**完了条件**: baseline JSONがあり、以後の差分が地表タスクとして説明できる。
