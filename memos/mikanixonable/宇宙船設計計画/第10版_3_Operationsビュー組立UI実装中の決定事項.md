# 第10版_3_Operationsビュー組立UI実装中の決定事項

作成日 2026-08-20。`第10版_3_Operationsビュー組立UI実装計画.md` の §9 未決定事項に対する実装着手時点の
決定、および実装中に判明した計画外の変更点をここへ追記していく(経緯は残さず、決定の内容と理由だけを
記録する)。ブランチ `feature/operations-assembly-ui`(worktree
`/Users/pandeaconica/lab/dive-into-tepui-assembly-ui`)で作業する。

## §9 未決定事項への決定

1. **カメラの実装方法**: 新しい `ViewId` は増やさない。`CombatCameraSystem`/`ChaseCamera` に
   「組立対象への一時的な注視」を持たせる — `ChaseCamera.update` は既に `target: GameEntity | null`
   を引数で受け取る形になっているため、組立セッション中は `Game` 側が渡す `target` を組立対象へ
   差し替えるだけで実現する。距離は対象の当たり判定(`collision-shape.ts` の `deriveCapsules` から
   求めた外接半径)に `ASSEMBLY_CAMERA_DISTANCE_MARGIN` 倍のマージンを掛けて決める。
2. **保持中オブジェクトの出現位置**: 既定案(ボタンを押した瞬間からカーソル追従)を採用。
3. **新規船下書きの表示**: 現行どおりセッション限定(確定/建造するまで保存されない)のまま変更しない。
4. **`DockWorkbenchSession` の履歴粒度**: 1回のドロップ、または1回の数値確定(断面編集の「更新」
   ボタン押下)を1履歴単位とする。
5. **入口の到達経路**: 基地のプロパティウィンドウに「組み立てる」と「格納艦艇/部品/生産を見る」を
   別項目として並べる。
6. **`ViewId:'dock'` の扱い**: 型からは削除しない。`ViewId:'combat'` が保存互換のために内部idとして
   残されている前例に倣い、`'dock'` も保存互換のためだけの値として型に残す。ロード時、
   `requestedView === 'dock'` を `ViewManager` の初期化解決(`resolveView`/コンストラクタ)で
   `'combat'` へ読み替える。新規に `'dock'` へ遷移するコードパス(`setView('dock')` の呼び出し)は
   実装からすべて除去する。
7. **基地操作ウィンドウを開く前提条件**: 接岸不要。既定案どおり、他の対象のプロパティウィンドウと
   同じく常に開ける。
8. **基地操作ウィンドウの複数共存**: `PropertyWindow` の一時ウィンドウ排他グループ
   (`tempWindowGroup`)と同じ方式を踏襲する — 未クリップは1つだけ、📌クリップすれば複数共存可。
9. **1つの窓にまとめるか**: 既定案どおり、組立ウィンドウ(§5.2)と基地操作ウィンドウ(§5.9)は
   別ウィンドウのまま実装する。

## 実装フェーズ分割(計画書に無かったため、ここで確定する)

- **フェーズA(基盤)**: `hud/draggable-window.ts`(`PropertyWindow` からの外枠抽出)、
  `vessel/mount-candidates.ts`(新設・純関数)。両者は互いに独立。
- **フェーズB(組立ドラッグ)**: `vessel/assembly-drag-controller.ts`、`hud/assembly-panel.ts`、
  `docking.ts`/`map-context-actions.ts` への入口配線、`base-view.ts` の3D作業台タブ除去。
  フェーズAに依存。
- **フェーズC(基地操作ウィンドウ)**: `hud/base-operations-window.ts`、`ViewId:'dock'` の
  遷移コードパス除去、`hud/base-view.ts` ファイル自体の削除。フェーズAに依存。フェーズBとは
  独立に並行できる。
- **フェーズD(仕上げ)**: `CLAUDE.md`/`DEVELOP/CALLSTACK.md`/`DEVELOP/OWNERSHIP.md`/`DEVELOP/SPEC.md`
  の更新、廃止済み計画書2件を `old/` へ移動、最終レビューと `npm run typecheck`。フェーズB・Cに依存。

## 実装中に判明した計画外の変更点

(実装を進める中で追記する)
