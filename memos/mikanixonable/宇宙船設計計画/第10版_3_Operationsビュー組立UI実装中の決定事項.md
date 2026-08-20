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

- **フェーズA完了**(2026-08-20)。
- `mount-candidates.ts` の `nearestMountCandidate` は、計画 §6.2 の下書きが引数に取っていた
  `VesselTree` ではなく `VesselAssembly` を取る。ノードの空き軸ポートを判定するには
  `assembly-editor.ts` の `occupiedPorts`(エッジだけでなく外装部品の配置も占有源に数える)が要り、
  それには `assembly.placements` が要るため、木だけでは判定できない。
- 上記に伴い、`assembly-editor.ts` のモジュール内関数だった `occupiedPorts` を `export` した
  (占有判定の唯一の実装を再利用するため、`mount-candidates.ts` からも呼べるようにする必要があった)。
- `hud/draggable-window.ts` の抽出により、`hud/property-window.ts` は `DraggableWindow` を
  合成するだけの薄いクラスになった。今後 `hud/base-operations-window.ts`(フェーズC)も同じ
  `DraggableWindow` を土台にする。
- **フェーズBのスコープを縮小**: `DockWorkbenchController`/`DockWorkbenchSession` を読んだところ、
  部品の取り付け(`installPlacement`/`movePlacement`)は既にドラッグ状態機械として完成しているが、
  外皮/トラス/分離機構を部材としてドラッグして接合する経路(計画 §5.5)は `assembly-mode.ts` の
  `mateVerdict`(断面適合・位相・長さ・作業範囲の判定)を要し、現状これを呼び出す3D側の実装が
  何も無い、まとまった別作業になる。今回のフェーズBは**部品(既存の搭載要素)のドラッグ取り付け・
  移動・取り外しのみ**を実装し、部材(外皮/トラス/分離機構)のドラッグ生成と断面の数値編集
  (計画 §5.5/§5.6)はフェーズEとして後日に回す。ユーザーが明示的に求めた「ボタンを押すと
  3Dモデルが現れ、ドラッグして接合する」という核となる操作は部品で実現される。
- **`DockWorkbenchController.SnapCandidate.position`** は現状 `{x,y,z}` の裸オブジェクトだが、
  このセッションで初めて実配線するにあたり `physics/vec3.ts` の `Vec3` へ揃える(このプロジェクトの
  座標値は必ず `Vec3` を使う、という不変条件に合わせるため)。
- **フェーズB・C完了**(2026-08-20)。`assembly-drag-controller.ts`/`assembly-panel.ts`/
  `base-operations-window.ts` を、互いに新規ファイルのみを触る3並列作業として実装した(共有ファイル
  — `docking.ts`/`base-view.ts`/`map-context-actions.ts`/`view-manager.ts` — への配線・削除は
  次の統合フェーズでまとめて行う。並列作業どうしが同じファイルを取り合って壊さないための分離)。
  - `assembly-editor.ts` に新規 `export function addPlacement(assembly, placement, options)` を
    追加した。既存の `movePlacement` は**既に配置済みの部品の取り付け位置を変える**ための関数で、
    倉庫から新しい部品を初めて取り付ける経路が assembly-editor.ts に一つも無かった
    (現行 `docking.ts` の `installWorkbenchPart` は検証を経ずに `placements` へ直接足していた)。
    `addPlacement` は `movePlacement`/`removePlacement` と同じ形(`validateMount` で検証してから
    `commit`)で、この抜けを埋める。
  - `hud/inventory-labels.ts` を新設し、`base-view.ts` にモジュール内で持っていた
    `PART_TYPE_LABELS`/`formatPartMeta`/`formatResourceAmount` をここへ出した。
    `base-operations-window.ts`(既存ロジック側)と `assembly-panel.ts`(新規ドラッグ側)の
    両方が同じ表示ロジックを要したため。`base-view.ts` 自身は次の統合フェーズで削除されるので、
    そちらに残る同名の重複はそのフェーズで一緒に消える。
  - 部材(外皮/トラス/分離機構)のドラッグ生成、断面の数値編集は引き続き未着手(フェーズE、
    上に既に記載した縮小方針のとおり)。
  - `hull-mesh.ts` にモジュール内であった外装部品ごとの造形テーブル(`FITTINGS`)を
    `assembly-drag-controller.ts` がやむを得ず複製していたのを、この場でレビューの一環として
    `vessel/part-fittings.ts`(新設)へ引き上げ、両者がそこから読むよう直した。**`render/`側
    (`part-meshes.ts`)へは置かない** — `PartType` は `game/game-entity/parts.ts` のもので、
    `render/` が `game/` の型を読むのはこのプロジェクトの render/game 境界規則に反するため、
    `game/vessel/` 側の共有モジュールとした。
