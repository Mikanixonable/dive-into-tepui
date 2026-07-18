# リファクタリング計画: game.ts のモード分離とテーマ統一

作成: 2026-07-18 / 対象コミット時点: `2913b02` 以降の作業ツリー

## 背景と目的

`src/game/game.ts` は 3065 行の単一クラスで、戦闘ビューとマップ(軌道計画)ビューの
2 系統が `this.mapMode`(boolean、参照 38 箇所)の分岐で 1 クラスに折り畳まれている。
軌道計画系(ノード編集・予測軌道・ギズモ・マップカメラ)は今後のシスルナ遷移計画で
確実に肥大するため、いま境界を切る。あわせてダークテーマ定数の重複
(main.ts / hud.ts で SURFACE・EDGE・ACCENT を二重定義)を解消する。

**方針: 挙動変更ゼロの純粋な移動リファクタリング。** 各タスクは独立に
`npm run typecheck` が通り、ゲームが同一挙動で動く状態でコミットする。

## 全体像(完了後の構成)

```
src/game/
  game.ts        … オーケストレータ(戦闘・物理・エンティティ・HUD同期)
  theme.ts       … [新規] ダークテーマ色定数(唯一の定義元)
  planner.ts     … [新規] MapPlanner: マニューバノード列・予測軌道・ノード編集・噴射ガイド
  mapview.ts     … [新規] MapView: マップカメラ・ラベル・フォーカス・太陽回転系・スライダー
  (hud.ts / input.ts / mapgizmo.ts / navball.ts などは現状維持)
```

責務の線引き:

- **MapPlanner** = 「計画のデータと編集」。マップモードでなくても生きている
  (確定済みノードの噴射ガイドは戦闘ビューで表示される)。
- **MapView** = 「マップモード中の見た目と視点」。mapMode 中のみ意味を持つ。
- **Game** = mapMode フラグの唯一の所有者。入力のルーティング
  (戦闘操作 or 計画編集)と、simulate / syncRender からの委譲呼び出しだけを行う。
- 自動ワープ(`autoWarpUntil`)は時間ワープ制御の一部なので **Game に残す**。
  Planner はノード時刻を提供するだけ。

## 実施順序と依存関係

```
タスク1 (theme.ts)          … 独立。いつでも実施可
タスク2 (MapPlanner: 状態+予測) ─→ タスク3 (MapPlanner: 入力編集) ─→ タスク4 (噴射ガイド)
タスク5 (MapView)           … タスク2 完了後ならいつでも(3・4 と並行不可、同一ファイルを触るため直列推奨)
タスク6 (mapMode 集約)      … タスク2〜5 完了後
タスク7 (StageSpec)         … 独立・任意(優先度低)
```

各タスク終了時に必ず: `npm run typecheck` → `npm run dev` で下記スモークテスト → コミット。

### 共通スモークテスト(全タスク)

1. `http://localhost:8080/?stage=1` で起動し戦闘ビューが出る
2. `[M]` でマップモードへ → 軌道クリックでノード配置 → W/S でΔv 調整
   → 白い計画軌道が更新される → `[M]` で確定
3. 戦闘ビューに ◆NODE マーカーと ⬢BURN ガイドが出る → `[N]` で自動ワープが走る
4. `[M]` 再突入 → 右クリックでノードメニューが開く → ノード削除
5. `,` / `.` の時間ワープ、Space の射撃、ゲームオーバー(そのまま放置は不要、
   `phase !== 'playing'` でマップ強制解除のコードパスが残っていることを目視確認)

---

## タスク1: テーマ定数の一元化(`src/game/theme.ts` 新規)

**小規模・独立。最初の肩慣らしに適する。**

1. `src/game/theme.ts` を新規作成し、hud.ts の値を正として export する:
   ```ts
   export const ACCENT = '#ff6a00';
   export const ACCENT_SOFT = '#ff9040';
   export const SURFACE = 'rgba(13, 15, 18, 0.82)';
   export const SURFACE_OPAQUE = 'rgba(13, 15, 18, 0.92)'; // main.ts の選択画面・ローディング用
   export const EDGE = 'rgba(255, 255, 255, 0.09)';
   export const BG = '#08090c';
   export const TEXT = '#e6e8eb';
   export const TEXT_DIM = '#7d838c';
   ```
2. `src/game/hud.ts` 冒頭(56–59 行付近)のローカル `const ACCENT/ACCENT_SOFT/SURFACE/EDGE`
   を削除し import に置換。hud.ts 内にリテラル `#ff6a00` `#7d838c` 等が
   直書きされている箇所も grep して定数参照へ置換する。
3. `src/main.ts` の `selectStage()` / `showLoading()` / エラーオーバーレイ内の
   ローカル定数・リテラル(`SURFACE`=0.92 版、`ACCENT`、`#08090c`、`#e6e8eb`、`#7d838c`、
   `rgba(255,255,255,0.09)`、`rgba(255,106,0,0.4)` 等)を theme.ts 参照に置換。
   ※ main.ts の SURFACE は不透明度 0.92 で hud.ts の 0.82 と異なる。**色は変えない**こと
   (SURFACE_OPAQUE として別定数にする)。
4. `rgba(255,106,0,…)` のようなアクセント色の派生(透明度違い)は、無理に関数化せず
   `ACCENT_RGB = '255, 106, 0'` を export して `rgba(${ACCENT_RGB}, 0.4)` と書く程度に留める。
5. mapgizmo.ts・navball.ts・touch.ts にも色リテラルがあれば同様に置換
   (grep: `#ff6a00|#ff9040|13, 15, 18|255, 255, 255, 0.09`)。canvas 描画の色も対象。

**受け入れ条件**: typecheck 通過。画面の見た目が全モードで変化しない
(スクリーンショット比較までは不要、目視で可)。`#ff6a00` の直書きが
theme.ts 以外に残っていない(`grep -rn "#ff6a00" src/` が theme.ts のみ)。

---

## タスク2: MapPlanner 抽出(第1段: 状態と予測キャッシュ)

`src/game/planner.ts` を新規作成し、**計画データと予測軌道の再計算**を移す。
入力処理(クリック・ドラッグ・ギズモ)はまだ Game に残す(タスク3)。

### 移動する Game のフィールド(game.ts 208–238 行付近)

| フィールド | 備考 |
|---|---|
| `planNodes: PlannedNode[]` | ノード列(時刻順ソート維持) |
| `selectedNodeIdx: number \| null` | |
| `trajSamples: TrajectorySample[]` | 予測結果キャッシュ |
| `trajDirty` / `trajGeomDirty` / `trajLastRefreshMs` | ダーティフラグ群 |
| `trajYawRef` | 太陽回転系の基準角(refreshTrajectory 時に固定) |
| `predictDurationKey: 'orbit'\|'day'\|'week'\|'month'` | |

`activeTarget` と `autoWarpUntil` はこの段では移さない(タスク4参照)。

### 移動するメソッド

- `predictDurationSec()`(1050 行付近)
- `refreshTrajectory()`(1061)— 内部で player 状態・simTime・環境加速度を使うので、
  コンストラクタ注入ではなく **呼び出し時引数**で渡す(下記 ctx)。
- `updateTrajectoryRefresh()`(1087)

### インターフェース設計

```ts
// planner.ts
export interface PlannerCtx {
  simTime: number;
  playerR: Vec3;          // player.state.r
  playerV: Vec3;          // player.state.v
  envShip: ExtraAccel;    // makeEnvAccel(C.SHIP_BCINV) — 予測積分用
  sunPhase0: number;      // 太陽回転系の方位計算用
}

export class MapPlanner {
  readonly nodes: PlannedNode[] = [];        // 直接 push しない。メソッド経由
  selectedIdx: number | null = null;
  samples: TrajectorySample[] = [];          // 読み取り専用扱い
  trajYawRef = 0;
  predictDurationKey: 'orbit' | 'day' | 'week' | 'month' = 'day';
  markDirty(): void;                          // trajDirty = true
  markGeomClean(): void; isGeomDirty(): boolean;
  predictDurationSec(ctx: PlannerCtx): number;
  refresh(ctx: PlannerCtx): void;             // 旧 refreshTrajectory
  maybeRefresh(ctx: PlannerCtx, mapMode: boolean): void; // 旧 updateTrajectoryRefresh
  firstNode(): PlannedNode | undefined;
  addNode(time: number): number;              // 追加+ソート+選択、戻り値 idx
  removeNode(idx: number): void;
  shiftAchieved(): void;                      // 先頭ノード達成時の除去
  pruneZeroDvNodes(): void;                   // toggleMap 確定時の NODE_MIN_DV 未満破棄
}
```

- Game 側は `private readonly planner = new MapPlanner()` を持ち、
  `private plannerCtx(): PlannerCtx` ヘルパーを 1 つ作って各呼び出しで渡す。
- game.ts 内の `this.planNodes` 参照(約 20 箇所)を `this.planner.nodes` に、
  `this.trajSamples` / `this.trajDirty` 等(33 箇所)を planner 経由に機械的に置換。
  この段では**参照の付け替えのみで、ロジックの行は動かさない**箇所
  (handleMapClick 等)はそのままフィールド参照だけ変える。
- `PlannedNode` / `TrajectorySample` の型定義が game.ts にあれば planner.ts へ移し、
  game.ts からは import する(predict.ts に既にあるならそちらを正とする)。

**受け入れ条件**: typecheck 通過、共通スモークテスト全項目、
game.ts に `planNodes` / `trajSamples` / `trajDirty` というフィールド宣言が残っていない。

---

## タスク3: MapPlanner 抽出(第2段: ノード編集入力)

マップモード中の編集ロジックを planner.ts へ移す。**タスク2 完了が前提。**

### 移動するメソッド(game.ts 890–1217 行付近)

- `handleMapClick` / `handleMapRightClick`
- `dragNodeToNearestSample` / `applyAxisDrag` / `computeAxisScreenDirs` / `buildAxisHandles`
- `updateMapGizmo`(フィールド `mapGizmo: MapGizmo` ごと移動。game.ts の
  `mapGizmo.closeMenu()` 呼び出し 2 箇所 — update() の強制解除と toggleMap —
  は `planner.closeMenu()` に委譲)
- `nodeScreenPos` / `ghostLabel`
- `updateMapPlanning`(update() から `this.planner.updateEditing(...)` として呼ぶ)
- `toDisplayFrame` — **注意**: これは MapView の太陽回転系状態
  (`mapFrameRotating`)に依存する。タスク3 の時点では引数
  `frameRotating: boolean` を取る形で planner に置き、Game が
  `this.mapFrameRotating` を渡す(タスク5 で MapView から渡すよう変える)。

### 追加で必要な依存(PlannerCtx を拡張 or 引数渡し)

- `project(rel: Vec3)`(スクリーン投影)— アクティブカメラに依存するので
  **コールバックとして渡す**: `project: (rel: Vec3) => {x,y,front} | ...`
- `hud`(setPlanPanel / setMapToolbarState / hint / planHtml)と `sfx`(warp)—
  コンストラクタ注入でよい(生成順: Game コンストラクタで hud・sfx 生成後に planner 生成)。
- `input`(takeClicks / takeRightClicks / down / fineAttitude 相当)—
  `updateEditing(dt, ctx, io)` の引数で渡す。

### 右クリックメニューの分担

`handleMapRightClick` はマップラベル(`mapLabels`: L1/L2・静止軌道などのフォーカス
候補)へのフォーカス切替も扱っている。ラベルは MapView の持ち物(タスク5)なので、
この段では **「ラベルヒットした場合のコールバック」** `onFocusLabel: (id: string) => void`
を引数で受け、Game 側で従来処理を行う形にして循環依存を避ける。

**受け入れ条件**: typecheck 通過、共通スモークテスト(特に 2・4)、
game.ts から上記メソッドが消えている。game.ts の行数が 2300 行以下になっている目安。

---

## タスク4: 噴射ガイドと達成判定の移動(第3段)

戦闘ビュー側に残っている計画関連ロジックを planner へ寄せる。**タスク3 完了が前提。**

### 移動するもの

- フィールド `activeTarget`(game.ts 238 行。凍結セマンティクスの長文コメントごと移動)
- `updateNodeGuide`(1256)→ `planner.updateGuide(ctx, io)` に改名。
  内部の `hud.marker/hideMarker/hint/setPlanPanel` はタスク3 で注入済みの hud を使う。
- `orbitClose`(1337)→ planner の private へ
- ノード達成時に Game 側で必要な後始末(`autoWarpUntil = null`)は、
  `updateGuide` の**戻り値** `{ achieved: boolean }` で通知し Game が処理する
  (autoWarpUntil を planner に持ち込まない)。
- `toggleMap` 内の `activeTarget = null` / `pruneZeroDvNodes` 相当は
  `planner.onMapClosed()` としてまとめる。

### Game に残すもの(移動しないこと)

- `autoWarpUntil` と simulate() 冒頭の自動ワープ段数制御(1349–1360 付近)
- `[N]` キー処理(780 付近)— `planner.firstNode()?.time` を読むだけに書き換え

**受け入れ条件**: typecheck 通過、スモークテスト 3(◆NODE / ⬢BURN 表示、
噴射して軌道一致→「✓ マニューバ達成」ヒント、自動ワープが達成時に解除)。

---

## タスク5: MapView 抽出(`src/game/mapview.ts` 新規)

マップモードの視点・表示状態を移す。**タスク2 完了が前提(3・4 の後に直列で実施)。**

### 移動する Game のフィールド(196–231 行付近)

`mapYaw` `mapPitch` `mapDist` `mapFocus` `mapPan` `mapCamera`
`mapFrameRotating` `mapSliderT` `mapLabels`(1219)

`starsMesh` `trajLine` は移動しない(戦闘ビューでも使う/シーン所有物のため Game に残す。
trajLine のジオメトリ再構築 `rebuildTrajLineGeom` / `updateTrajLineAndMarkers` も
Game に残し、planner.samples を読む現行構造を維持する)。

### 移動するメソッド

- `resetMapView`(881)
- `drawMapLabels`(1221)— hud 注入が必要
- syncRender 内のマップカメラ更新ブロック(2103–2151 付近)を
  `mapView.updateCamera(mouse, keyYaw, keyPitch, dt, focusRel, sunAz)` として切り出す。
  `focusRel` の解決(`mapFocus !== 'earth'` のときラベル位置を引く)は
  mapLabels が MapView 内に来るので `mapView` 内で完結できる。
- ゴーストスライダー関連: `mapSliderT` の読み書き(HUD ツールバー・タッチ操作から
  設定される)。現状の設定経路を grep(`mapSliderT`)し、セッター経由に統一する。
- タスク3 で保留した `onFocusLabel` コールバックを `mapView.setFocus(id)` に接続。
- タスク3 の `toDisplayFrame(frameRotating)` 引数へ `mapView.frameRotating` を渡す。

### インターフェース

```ts
export class MapView {
  readonly camera: THREE.PerspectiveCamera;   // 旧 mapCamera(near 1e4 / far 6e8)
  frameRotating = false;
  sliderT = 0;
  focus: string = 'earth';
  labels: { id: string; name: string; pos: Vec3 }[] = [];
  reset(): void;
  updateCamera(...): void;
  drawLabels(o: Vec3, project: ProjectFn): void;
  displayTime(simTime: number, duration: number): number; // simTime + sliderT * duration
}
```

- Game の `activeCamera` getter は `this.mapMode ? this.mapView.camera : this.camera` に変更。
- mapCamera の生成コード(コンストラクタ内)も MapView コンストラクタへ移す。

**受け入れ条件**: typecheck 通過、共通スモークテストに加えて:
マップの回転・ホイールズーム・中ドラッグパン・視点リセット・太陽回転系トグル・
未来スライダー(ゴースト表示)・L1/L2 等ラベルへのフォーカス切替が従来どおり動く。

---

## タスク6: mapMode 分岐の集約

**タスク2〜5 完了が前提。** 仕上げとして mapMode の散在チェックを減らす。

1. `mapMode: boolean` はそのまま Game の private に残す(状態機械の導入はしない。
   `phase` との直交は現状の後始末コード — update() 冒頭の強制解除 — で十分)。
2. syncRender 内の `if (this.mapMode) { … } else { … }` が独立した関心事ごとに
   複数回出てくる(星スケール・月の実寸/圧縮・地球照明・敵マーカー・軌道線表示)。
   これらを**無理に統合しない**こと。ただし各分岐の中身が 10 行を超えるものは
   `syncRenderMap(o, …)` / `syncRenderCombat(o, …)` 系の private メソッドへ
   切り出して syncRender 本体を「共通処理+分岐で 2 メソッドに委譲」の形に整える。
3. `updateMarkers` / `updateNavball` / `updateRcsEffects` 等の冒頭 early-return
   (`if (this.mapMode) …`)は現状維持でよい(呼び出し側で分岐を増やすより明瞭)。
4. 最終確認: `grep -c "this.mapMode" src/game/game.ts` が **15 箇所以下**を目安とする
   (入力ゲート・activeCamera・toggleMap・syncRender の委譲分岐で残るのは正常)。

**受け入れ条件**: typecheck 通過、共通スモークテスト全項目。挙動変化なし。

---

## タスク7(任意・優先度低): StageSpec テーブル化

ステージ分岐は現在 7 箇所(`stage === 0/1/2`)で許容範囲。ステージ追加の予定が
具体化するまで**着手しない**。着手する場合は `const.ts` に
`STAGES: { enemySpecs, timeLimit?, clearAction?, initialAmmoDrop? }[]` を定義し、
`makeEnemySpecs` / `makeStage0Specs` / `updateStage0Timer` / 勝利時の
`STAGE1_CLEARED_KEY` 書き込み(1943 付近)/ HUD の `stage0TimeLeft`(2897 付近)を
テーブル参照へ置換する。

---

## 実装上の注意(全タスク共通)

- **THREE は `'three/webgpu'` からのみ import**(`'three'` 混在禁止。CLAUDE.md 参照)。
- planner.ts / mapview.ts から game.ts を import しない(循環依存禁止)。
  依存は ctx 引数・コンストラクタ注入・コールバックの 3 手段のみ。
- 既存コメント(特に activeTarget の凍結理由、trajYawRef の表示/判定整合の説明)は
  **削らずコードと一緒に移動**する。設計判断の記録なので要約・省略しない。
- 移動時にロジックを「ついでに改善」しない。改善候補を見つけたら計画書末尾に
  追記して人間の判断に回す。
- dev.md は人間専用ドキュメント。**編集禁止**。
- コミットは 1 タスク 1 コミット。メッセージは既存の慣習
  (`refactor: …` 形式、日本語)に合わせる。
- 各タスク完了時、CLAUDE.md のアーキテクチャ節(`src/game/…` の説明)に
  新ファイルの 1 行説明を追記する(タスク1 は theme.ts、タスク2〜4 は planner.ts、
  タスク5 は mapview.ts)。

## 改善候補メモ(このリファクタでは実施しない)

- (実装エージェントがここに気付きを追記する)
- タスク6実施後の実測: `grep -c "this.mapMode" src/game/game.ts` は 33 のまま
  (目安の 15 以下には届かなかった)。理由: 10 行超の分岐本体を
  syncRenderMap*/syncRenderCombat* へ切り出しても、呼び出し元の
  `if (this.mapMode) { … } else { … }` という条件式自体は syncRender に残るため
  (これは「無理な統合をしない」方針と両立しない限りテキスト出現数は減らない)。
  加えて、タスク6の対象外である入力ゲート・toggleMap・activeCamera・
  早期リターン群だけで既に 21 箇所あり、これらは計画書自身が「残ってよい」と
  明記している。15 という目安は、この許容カテゴリの実測値と整合しない
  (実質的な下限は 21 前後)。数値目標というより「syncRender 本体の各分岐が
  読みやすく整理されているか」を見るための目安として運用するのが妥当。
