# マップ/ゲーム全般の改修 + クリエイティブモード — 実装指示書

この文書は、**サブエージェントがこれだけを読んで着手できる**ことを目的とした作業指示書である。
親エージェント(Opus)が設計・レビューを行い、個々の作業は Sonnet サブエージェントが実施する。

---

## 0. 読む前に — 共有前提

### 0.1 このプロジェクトの絶対ルール(違反はレビューで差し戻す)

- **一次情報は文書。** `CLAUDE.md` / `DEVELOP/OWNERSHIP.md`(所有木)/ `DEVELOP/CALLSTACK.md`(毎フレーム呼び出し順)/ `DEVELOP/SPEC.md`(挙動仕様)。`src/` を読み始める前にこれらで当たりを付ける。
- **`src/` を変えたら同じ変更セットで上記4文書を更新する。**「あとでまとめて」は禁止。手順は `/develop-docs`。
- **命名 `update` / `sync` / `build` / `render`。** `update` は論理状態のみ(THREE を触らない)。`sync` は算出済みデータをメッシュ/DOM に押し出すだけ。`render` は `renderer.render` を呼ぶ `Game.render` のみ。`draw` は使わない。
- **`*Ctx` スナップショット引数は禁止パターン。** 新設しない。明示引数か共有参照にする。
- **機能追加は必ず `/add-feature` の手順を通す。** 既存の類似実装を探し、再利用可能な形で適切なモジュールにあればそれを呼ぶ。無ければ適切なモジュールに再利用可能な形で実装し、**既存側もその呼び出しに置き換えるまでを同じ変更セットで**行う。数行でも例外にしない。
- **コメントは `/comment` の方針。** モジュールの責務外に言及しない。「どう実装しているか」「以前どうだったか」「何を変えたか」は書かない。逆に、関数直前の呼出規約コメントと 10 行以上の関数の文脈コメントは、無いこと自体が欠陥。
- **改名は痕跡を残さない。** 旧名エイリアス・「旧」「former」等の記述を残さない。旧名は全文検索で 0 件にする。
- **基本データ型は不変。** `Vec3` / `OrbitState` / `Quat` / `Attitude` は `readonly`。置換で進める。`Vec3` は branded 型なので必ず `v3()` 等で作る。
- **各オブジェクトは自分のマーカーを自分の `sync` の中で更新する。** `sync` と別に `syncMarker` を公開しない。
- 検証は既定で `npm run typecheck` のみ。`src/physics/` を触った場合のみ `npm run test:physics` を追加。実行時確認はユーザーが明示的に求めたときだけ。

### 0.2 触ることになる既存モジュールの要約

| モジュール | 責務 |
| --- | --- |
| `src/game/game.ts` | オーケストレータ。`update`/`sync`/`render` の三相と**呼び出し順だけ**を決める。キーの意味は持たない |
| `src/game/input/key-mapping.ts` | キー割り当ての唯一の定義(コードも表示名もここ以外に書かない) |
| `src/game/input/input.ts` | エッジ入力キュー。`takeKey`/`takeKeys`/`takeClicks`/`takeRightClicks` は**早い者勝ちで消費**する |
| `src/game/targeter.ts` | ターゲット選定 + ターゲット由来の表示(軌道線ハイライト・的通過マーク・◇◆方位・相対 AN/DN) |
| `src/game/camera/camera-system.ts` | `CombatCameraSystem`/`OverviewCamera` を所有。`overviewMode`、`ProjectFn` の生成、フォーカス関連(`FocusMarkers`/`FocusGizmo`/MAP VIEW パネル)を所有 |
| `src/game/camera/focus-markers.ts` | 天体・ラグランジュ点ラベル(`FocusLabel {id,name,pos}`)の算出・射影・`findLabel` |
| `src/game/camera/focus-gizmo.ts` | フォーカス選択コンテキストメニュー(現在は「フォーカスを移動」/「キャンセル」のみ) |
| `src/game/camera/overview-camera.ts` | マップの地球中心軌道カメラ。`focus`(ラベル ID 文字列)、`cameraFrame` |
| `src/game/plan/plan.ts` | ノード列 + `anchor`。**ノードは絶対 `OrbitState`(バーン後状態)**。Δv は導出値 |
| `src/game/plan/plan-editor.ts` | `plan`/`editMode`/`NodeGizmo`/MANEUVER PLAN パネル/`planDisplay` を所有。クリック配置・ドラッグ・WASDQE Δv 編集 |
| `src/game/plan/node-gizmo.ts` | ノードハンドル + Δv アーム + ノード右クリックメニュー(warp/delete)の DOM ポインタ層 |
| `src/game/display-time-manager.ts` / `display-time-panel.ts` | 「いつを見るか」— `durationKey`/`sliderT`/`resolveDisplayTime`/`forceCurrent` とその DOM |
| `src/game/sim-speed-manager.ts` | ワープ段(`SIM_SPEED_LEVELS`)、`[N]` 自動ワープ、`can*` 述語 |
| `src/game/marker/marker-manager.ts` | マーカー DOM のプール。`set`/`setPosition`/`setDirection`/`setBearing`/`hide`/`remove` |
| `src/game/hud/context-menu.ts` | 画面座標ポップアップの共有実装(`NodeGizmo`/`FocusGizmo` が使用) |
| `src/game/hud/dom.ts` | HUD の静的 DOM/CSS と **z-index バンドの唯一の定義**(0 マーカー / 1 ゲームパネル / 2 トースト / 3 終了画面 / 4 ESC メニュー) |
| `src/game/hud/buttons.ts` | `SegmentedControl` / `hudButton` / `HudToggle` |
| `src/game/stages/stage-select.ts` | `selectStage()` — タイトル + ステージ選択画面 |
| `src/game/stages/stage-dictionary.ts` | `STAGE_CLASSES`/`STAGE_DEFINITIONS`/`initStage()` |
| `src/physics/ephemeris.ts` | 太陽・月・ラグランジュ点の解析暦、回転フレーム |
| `src/physics/orbital.ts` | `OrbitState`、RK4、要素⇄状態、`orbitalAxes`、`stateFromElements` |

### 0.3 マップモードのポインタ優先順位(現状)

`Game.update` は マップモード時に `PlanEditor.handleMapPointer(input)` → `CameraSystem.handleMapPointer(...)` の順で呼ぶ。
`PlanEditor` は**ノードに当たった右クリックだけ**を消費し、残りがフォーカス選択に落ちる。
**優先順位はこの呼び出し順だけで表現されており、各ギズモは互いを参照しない。この設計を壊さないこと。**
本改修で右クリック対象が増えるので、この鎖に順序を足す形で拡張する(§1.2)。

---

## 1. 共通基盤(先に作る。以降の作業はこれに乗る)

> **WP-A は他のすべての前提。単独で完了・レビューしてから WP-B 以降に進む。**

### WP-A1: `MapPickable` — マップ上の被選択物の統一

**動機:** 右クリック対象が「ラグランジュ点ラベル」だけだったところに、自機/敵船・近地点/遠地点・相対 AN/DN が増える。各所に個別のヒットテストを書くと、優先順位と当たり半径が散らばる。

**方針:** `src/game/map-pick.ts`(新規、`game/` 直下)に、画面ピッキングの共有型と共有関数を置く。

```ts
// マップ上で右クリック対象になりうるものの共通形。
export interface MapPickable {
  readonly id: string;        // マーカーキーと共通。安定していること
  readonly name: string;      // メニュー見出しに出す表示名
  readonly pos: Vec3;         // 表示時刻における ECI 位置
  readonly kind: MapPickKind; // 'body' | 'ship' | 'apsis' | 'relnode'
}
export type MapPickKind = 'body' | 'ship' | 'apsis' | 'relnode';

// 画面座標 (x,y) に最も近い候補を返す。許容半径外なら null。
export function pickNearest(
  items: readonly MapPickable[], x: number, y: number, project: ProjectFn, radiusPxSq: number,
): MapPickable | null;
```

- 許容半径定数は `const.ts` に `MAP_PICK_PX_SQ` を新設(既存 `TARGET_LOCK_PICK_PX_SQ` と同じ値で始めてよいが、別の意味なので別定数)。
- `FocusMarkers.FocusLabel` は `MapPickable`(`kind:'body'`)を満たす形に**改名なしで拡張**する(`kind` フィールドを足す)。`findLabel` はそのまま残す。
- **`/add-feature` 該当:** `Targeter.pickTargetAt` の「画面射影して最近傍を探す」ループは `pickNearest` と同じ処理。`Targeter` 側も `pickNearest` を呼ぶ形に置き換えるところまでを同じ変更セットで行う。

**検証:** `npm run typecheck`。

---

### WP-A2: 右クリックメニューの対象別ディスパッチ

**動機:** 対象種別ごとにメニュー項目が異なる(船=フォーカス/ターゲット/アクティブ化、AN/DN=ワープ/ノード追加/フォーカス、apsis=ノード追加/フォーカス)。`FocusGizmo` は「フォーカスを移動」固定なので拡張が要る。

**方針:**
- `FocusGizmo` を **`MapPickable` を受け取り、項目リストを引数で受ける**形に一般化する。クラス名は `FocusGizmo` のままだと責務と合わなくなるので **`MapContextGizmo` に改名**(`src/game/map-context-gizmo.ts`、`game/` 直下)。旧名は全文検索 0 件にすること。

```ts
export interface MapMenuItem { readonly label: string; readonly act: string; }
export class MapContextGizmo {
  onSelect: ((act: string, target: MapPickable) => void) | null = null;
  openMenu(clientX: number, clientY: number, target: MapPickable, items: readonly MapMenuItem[]): void;
  closeMenu(): void;
}
```
- 所有者は **`CameraSystem` から `Game` へ移す。** 理由: メニュー項目がカメラ(フォーカス)だけでなく `Targeter`(ターゲット指定)・`PlanEditor`(ノード追加)・`SimSpeedManager`(ワープ)にまたがるため、単一のサブシステムには属さない。`Game` が `onSelect` を各所有者のメソッドへ振り分ける。
  - **`Game` は「順序を決めるだけ」の原則との整合:** ここでの `Game` の役割は「どの act をどの所有者に渡すか」の配線であり、既存の `handleInput` が各キーを所有者へ渡しているのと同じ形。判断ロジック(何が起きるか)は各所有者側に置く。
- MAP VIEW パネルのフォーカス shortlist は `CameraSystem` に残す(あれはメニューではない)。

**検証:** `npm run typecheck`。既存のラグランジュ点右クリック→フォーカスが従来通り動くこと。

---

## 2. マップビューの変更

### WP-B1: 宇宙船・敵船をフォーカス対象にする

**要件:** マップで宇宙船・敵船を右クリックしたメニューからフォーカス対象にできる。

**方針:**
- `OverviewCamera.focus` は現在ラベル ID 文字列で、`resolveFocus()` が `FocusMarkers.findLabel` を引く。**エンティティは位置が毎フレーム変わるので、ID 文字列引きの仕組みを拡張する。**
- **推奨案:** `OverviewCamera.focus` を `string` から `FocusTarget = { kind: 'label'; id: string } | { kind: 'entity'; entity: GameEntity }` にせず、**`focus: MapPickable | null`(null = 地球)**にする。`MapPickable.pos` を毎フレーム更新済みの値として読むだけで済み、ラベルもエンティティも同じ扱いになる。
  - エンティティ側は `GameEntity` に `mapPickable(displayTime): MapPickable` を生やすのではなく、**マップ用の `MapPickable` を毎フレーム組み立てるのは `Game.sync` の担当**にする(`displayState(displayTime)` を引くのは `Game.sync` が既にやっている仕事)。
  - `OverviewCamera` は保持した `MapPickable` の `id` を鍵に、そのフレームの候補配列から引き直す。参照を握りっぱなしにすると死亡エンティティを掴み続ける。**`focus` は `id: string` を保持し、`resolveFocus` は「そのフレームの `MapPickable[]`」から引く**形にする(引けなければ地球にフォールバック)。
- 候補配列は `CameraSystem` が `sync` 時に受け取る(`Game.sync` から明示引数で渡す。`*Ctx` は禁止)。

**価値判断が必要な点 → 提案:**
- **Q. 敵船・自機のマップ上のマーカーは何を出すか。** 現状マップでは敵は `GroupedMarkers`、自機は `▷`。フォーカス可能であることを示す追加装飾は付けず、既存マーカーをそのままピッキング対象にする(装飾を増やすと画面が濃くなる)。**推奨: 追加装飾なし。**

**検証:** `npm run typecheck`。

---

### WP-B2: 汎用ターゲット + 相対軌道昇降点アイコン

**要件:**
- 宇宙船だけでなく月・ラグランジュ点等もターゲットにできる。
- ターゲットと現在軌道の**軌道昇降点(相対 AN/DN)**をアイコン表示する。
- そのアイコンの右クリックメニューから「そこまで時間加速」「そこにノードを追加」「そこをフォーカス」ができる。

**現状:** `Targeter` は `Enemy` 専用(`lockedTarget: Enemy | null`、`autoTarget: Enemy | null`)。相対 AN/DN は `syncNodeMarkers` が `aliveTarget.elements` から算出し、`▲`/`▽` マーカーを出すだけで**右クリックできない**。

**方針:**
1. `Targeter` のターゲット型を `Enemy` から広げる。**ここが最大の設計判断点。**

   **価値判断 → 提案(推奨案 A):**
   - **A(推奨): ターゲットを二層に分ける。** `Targeter` は「戦闘ターゲット(`Enemy`)」を持ち続け、**マップ側の「航法ターゲット(任意の `MapPickable`)」は別クラス `NavTarget`(`src/game/nav-target.ts`)に持たせる。**
     - 理由: `Targeter` の既存責務(リード計算、的通過マーク、敵 AI 連携、`LeadMarkers`)はすべて `Enemy` 前提であり、月をそこに流し込むと全経路に `instanceof` 分岐が入る。相対 AN/DN・軌道昇降点は「その天体の軌道面」だけを必要とするので、必要な情報は `Elements` あるいは位置+速度のみ。
     - `NavTarget` の責務: 航法ターゲット(`MapPickable` の id + その軌道面法線を得る手段)の保持、相対 AN/DN の算出、その `▲`/`▽` マーカーの `sync`、`MapPickable` としての公開(右クリック対象になるため)。
     - `Targeter.syncNodeMarkers` はこの `NavTarget` へ移す(**移動であって複製ではない。`Targeter` 側から消す**)。敵をターゲットにした場合は `Game` が航法ターゲットにも同じ相手を設定する、のではなく、**ユーザーがメニューから明示的に設定する**(§WP-C1 でオート選択を廃止する方針と揃う)。
   - **B: `Targeter` をジェネリック化する。** 一見素直だが、上記の理由で分岐が全域に散る。**非推奨。**

2. 月・ラグランジュ点の「軌道面」:
   - 月は `ephemeris.moonOrbitNormal` 相当が既にある。**新規に法線計算を書かない**(`/add-feature`)。
   - ラグランジュ点は EM 系なら月軌道面、SE 系なら黄道面。`ephemeris` の既存 `moonOrbitRotationAt`/`sunOrbitRotationAt` の ẑ を使う。**`physics/ephemeris.ts` に既存 API で足りない場合のみ追加し、追加したら `npm run test:physics` を走らせる。**
   - 相対 AN/DN の算出そのもの(`cross(playerEl.hHat, tgtHat)` → 自機軌道上の真近点角 → 半径)は既存 `syncNodeMarkers` のロジックをそのまま移設・一般化する。

3. アイコンの右クリックメニュー(`MapContextGizmo` 経由、`kind:'relnode'`):
   - 「ここまで時間加速」→ `SimSpeedManager.startAutoWarpTo(t)`。**AN/DN の通過時刻**が要る。自機軌道の要素と真近点角から `orbital.ts` の `tofBetween` で求める(既存関数。新規に書かない)。
   - 「ここにノードを追加」→ `PlanEditor` にノード追加 API を生やす。**現状ノード追加は `plan.addNode(sample)` を `PlanEditor` 内のクリック処理が呼んでいるだけなので、時刻指定で追加する公開メソッド `PlanEditor.addNodeAt(t: number): void` を切り出し、既存のクリック配置経路もそれを通す**(`/add-feature`)。
     - 追加位置は「その時刻における計画軌道上の状態」= `planDisplay.traj.at(t)`。取れなければ何もしない(ヒントを出す)。
   - 「フォーカスを移動」→ WP-B1 と同じ経路。

**検証:** `npm run typecheck`。`physics/` を触ったら `npm run test:physics`。

---

### WP-B3: 近地点・遠地点アイコン

**要件:** 自機軌道の近地点・遠地点をアイコン表示し、右クリックメニューから「ノード追加」「フォーカス移動」ができる。

**方針:**
- **所有者の判断 → 提案:** 近地点/遠地点は**計画軌道の**アプシスを出すべきで(ノードを置く先が計画軌道だから)、`PlanDisplay` が所有するのが自然。しかし計画が空のとき(= anchor が実軌道追従)も出したい。
  - **推奨: `PlanDisplay` が所有する。** 計画が空でも `PlanTrajectory` は「anchor から表示終端まで」の軌道を持っているので、常に描ける。`plan-display.ts` に `syncApsisMarkers` は作らず、既存の `sync` の中で更新する(マーカー所有ルール)。
  - アプシス位置は**セグメント末端の要素から解析的に**求める(`elementsFromState` → `positionOnOrbit(el, 0)` / `positionOnOrbit(el, π)`)。ポリライン標本から最大/最小半径を探す実装にはしないこと(標本粗さに依存して跳ねる)。
  - 複数ノードがある場合、**最終セグメント(最後のバーン後の軌道)のアプシスを出す。** それが「これから乗る軌道」だから。
- マーカー記号: 近地点 `Pe`、遠地点 `Ap` をラベルに、記号は `◇`(既存 `mk-node` とは別クラスを `dom.ts` に追加)。高度をラベルに併記する(`fmtDist`、`hud/utils.ts` の既存関数を使う)。
- 右クリックメニュー(`kind:'apsis'`): 「ここにノードを追加」(WP-B2 の `PlanEditor.addNodeAt`)/「フォーカスを移動」/「キャンセル」。
- 離心率がほぼ 0(`e < 閾値`)のときはアプシスが定まらないので**両方隠す。** 閾値は `const.ts` に `APSIS_MIN_ECC` を新設。

**検証:** `npm run typecheck`。

---

### WP-B4: 時間スライダーの目盛りと手動レンジ

**要件:** マップの時間スライダーに目盛りを表示。時間範囲を手動設定できるモードを追加し、より先の未来を表示できるようにする。

**現状:** `DisplayTimeManager` の `durationKey: 'orbit'|'day'|'week'|'month'`、`sliderT: 0..1`、`resolveDisplayTime = simTime + sliderT * durationSec()`。DOM は `DisplayTimePanel`(期間 `SegmentedControl` + スライダー + `T+` ラベル)。

**方針:**
- `PredictDurationKey` に `'manual'` を追加。`durationSec()` は `'manual'` のとき `manualDurationSec` フィールドを返す。
- `DisplayTimePanel` に数値入力(値 + 単位 `SegmentedControl`: 時/日/週/年)を足し、`'manual'` 選択時のみ表示する。`onManualDurationChange` コールバックで `DisplayTimeManager` に返す。
- 目盛り: スライダーの下に**5〜7本の目盛りと、その時刻の相対ラベル**を出す。ラベル書式は既存の `futureTimeLabel` を一般化する。現状 `T+{h}h{mm}m` 固定で、月・年スケールでは読めない。**`hud/utils.ts` の `fmtTime` に合流できるか確認し、できるなら `futureTimeLabel` を捨てて `fmtTime` を使う**(`/add-feature`)。合流できない場合のみ `fmtTime` 側を拡張する。
- **`onDurationChange` は `'manual'` の数値変更でも呼ぶこと。** これは `game.ts` が `editor.planDisplay.traj.invalidate()` に配線しており、呼ばないと予測ポリラインが古いまま残る。
- 予測の実体側の制約に注意: `PlanArc` は最長 28 日想定でステップ幅を決めている(`plan-arc.ts` の `stepDt`、`keplerPeriod(r)/STEPS_PER_REV`)。**年スケールを許すなら、精度ではなくステップ数(=フレーム時間)が問題になる。**
  - **価値判断 → 提案:** 手動レンジの上限を `const.ts` の `DISPLAY_DURATION_MAX`(推奨: 1 年)で頭打ちにし、それを超える入力はクランプする。加えて `PlanArc` の 1 セグメントあたり最大ステップ数の上限を設け、超えたらそこで打ち切って `endState()` を返す既存の打ち切り経路に乗せる。**「重くて固まる」より「線が途中で切れる」ほうが良い。**

**検証:** `npm run typecheck`。ユーザーに実行確認を求められた場合のみ `/verify`。

---

### WP-B5: マニューバ編集 UI(長押し / ドラッグラッチ)

**要件:**
- ボタン長押しでその方向への加速を加えられる。
- ドラッグが一定距離を超えたら、以降は指を止めていてもドラッグし続けているかのように加速が加算され続け、ボタンを離すと終わる。

**現状:** `NodeGizmo` が Δv アームのドラッグを扱い、`PlanEditor` が WASDQE キーによる Δv 編集を持つ。ドラッグは変位に比例した Δv を与えるため、大きな Δv には何度もドラッグが要る。

**方針:**
1. **Δv 加算のレート適用点を一箇所にする。** 現状「ドラッグ変位 → Δv」と「キー押下 → Δv」で二経路ある。`PlanEditor` に `applyDvRate(axis: DvAxis, rate: number, dt: number)` を作り、両方をここへ通す(`/add-feature`)。`plan.applyNodeDv` はその下。
2. **ラッチ:** `NodeGizmo` のドラッグ処理に、アーム基点からの変位が `DV_DRAG_LATCH_PX` を超えたら「ラッチ状態」に入る。ラッチ中は**変位に比例したレート**(px 超過量に比例)を毎フレーム加算し続ける。`pointerup` でラッチ解除。
   - ラッチ中も指を動かせばレートが変わる(超過量が変わるため)。「止めても続く」要件はこれで満たされる。
   - ラッチ前(閾値以下)は従来通りの**変位比例の絶対 Δv**、ラッチ後は**レート積分**。この切り替わりで Δv が跳ばないよう、ラッチ開始時点の Δv を基準に積分を始める。
3. **ボタン長押し:** MANEUVER PLAN パネル(`PlanEditor` 所有)に 6 方向ボタン(prograde/retrograde/normal/antinormal/radial out/in)を追加。`hud/buttons.ts` に**押しっぱなしを扱う `hudHoldButton`** を新設し(`onHoldStart`/`onHoldEnd`、または `isHeld` を毎フレーム読む形)、`PlanEditor.sync` で `isHeld` を見て `applyDvRate` を呼ぶ。
   - **価値判断 → 提案:** イベント駆動(`onHoldStart`/`onHoldEnd` + 内部 `setInterval`)ではなく、**`isHeld` を公開して毎フレーム `sync` から読む**形を推奨。`setInterval` はフレームレートと独立に走り、ポーズやマップ閉時に止め忘れる。ゲームループから読む形なら止め忘れが構造的に起きない。
   - ボタンは既存 WASDQE キーと同じ意味なので、**ラベルにキー名を併記する**(`key-mapping.ts` の `label` を使う。文字列を直書きしない)。
4. **レートのランプ:** 押し始めは細かく、長押しで粗くする(`DV_RATE_MIN` → `DV_RATE_MAX` へ `DV_RATE_RAMP_SEC` 秒で指数的に。定数は `const.ts`)。これが無いと微調整と大加速のどちらかが必ず苦痛になる。

**検証:** `npm run typecheck`。

---

## 3. 戦闘ビューの変更

### WP-C1: オートターゲット廃止 → 明示的なメニュー選択

**要件:** ターゲットの自動切換えを廃止。敵船を右クリックして出るメニューから手動で設定・解除する。

**現状:** `Targeter.resolveAutoTarget` がカメラ正面に最も近い生存敵を毎フレーム選ぶ。右クリックは `handleTargetLockByRightClick` が**当たったかに関わらず消費**し、外れると固定解除。右クリックは射撃と兼用。

**方針:**
- `resolveAutoTarget` を**削除**する(痕跡を残さない)。`autoTarget` フィールドも消し、`lockedTarget` を唯一の真実にする。**公開名は `target` に統一**し、`aliveTarget` は残す(生存判定込みの読み口として使われている)。
- 戦闘ビューの右クリックは**射撃と兼用のまま**。ここが要件の衝突点。
  - **価値判断 → 提案(推奨):** 右クリック**単押し(クリック閾値内)で敵に当たった場合のみメニューを開く**。当たらなければ従来通り消費(=射撃はホールドで行われるので、単クリックがメニューに使われても射撃体験は損なわれない)。`Input.clicks()` が左クリックについて既に `CLICK_MOVE_THRESHOLD` (6px) 判定を持っているので、**右クリックにも同じ判定を適用する**(`input.ts` を拡張。`/add-feature` — 閾値判定ロジックを複製しない)。
  - メニュー項目: 「ターゲットに設定 / 解除」「第二ターゲットに設定 / 解除」「キャンセル」。
  - 既存の `hint('ターゲット固定')` 系はメニュー選択時の通知として残す。
- ターゲットが撃破されたら `target = null` にする(オート再選択はしない)。`aliveTarget` の null 経路は既に全所で扱われているので追加対応は不要のはずだが、`LeadMarkers`/`HudPanels`/`PlanGuide` を確認すること。

**検証:** `npm run typecheck`。

---

### WP-C2: 第二ターゲット

**要件:** 第二ターゲットを設定できる。そのアイコンの色は第一ターゲットと異なる。

**方針:**
- `Targeter` に `secondaryTarget` を追加(`target` と同じ型・同じ生存判定)。同一の敵を両方に設定できないようにする(第一に設定したら第二から外す、逆も同様)。
- **第二ターゲットが影響する範囲を明確に限定する。**
  - **価値判断 → 提案(推奨):** 第二ターゲットは**表示だけ**。すなわち「軌道線ハイライト(別色)」「マーカー色」「敵リストパネルでの強調」まで。的通過マーク・◇◆方位マーカー・LEAD マーカー・相対 AN/DN は第一ターゲットのみ。
    - 理由: 第二ターゲットの用途は「次に狙う相手を見失わないこと」であり、照準系を二重化すると画面が読めなくなる。
- 色: `theme.ts` に `ACCENT_SECONDARY` を追加する。**推奨値: シアン系 `#00c8ff`。** 現行テーマは「モノトーン + オレンジ一色」なので、**二色目を入れることはテーマ規約の変更**にあたる。`CLAUDE.md` の HUD テーマ記述(「one saturated orange accent」)を同じ変更セットで更新すること。
- `Enemy.accentColor` / `Enemy.markerItem(isTarget, ...)` が第一ターゲットしか知らない。**`markerItem` の引数を `isTarget: boolean` から `role: 'none'|'primary'|'secondary'` に変える**(bool の追加ではなく、意味のある列挙にする)。
- `Targeter.orbitLine` は 1 本しかない。第二ターゲット用に 2 本目の `OrbitLine` を持つ。`renderOrder` は第一(2)より下、自機(1)より上 — **整数が空いていないので、既存の renderOrder を `player=1, secondary=2, primary=3, planned=4` に振り直す**(`orbitline.ts` のコメントと `CLAUDE.md` の記述を同時に更新)。

**検証:** `npm run typecheck`。

---

## 4. 戦闘ビュー・マップビュー共通

### WP-D1: カメラのロール回転をテンキー 0 / 1 に割り当て

**現状:** チェイスカメラは `rot` クォータニオン + `dist` のみを持ち、`update(mouse, keyYaw, keyPitch, dt)` でヨー・ピッチのみ。ドラッグは構造上ロールを生まない設計(視線軸まわりの回転を入れない)。

**方針:**
- `key-mapping.ts` に `cameraRollLeft: { code: 'Numpad0', label: 'Num0' }` / `cameraRollRight: { code: 'Numpad1', label: 'Num1' }` を追加(**既存の `Digit0`/`Digit9` ラジエータとはコードが異なるので衝突しない**)。`SCROLL_GUARD_KEYS` への追加は不要。
- `ChaseCamera.update` に `keyRoll` 引数を追加し、**現在の視線軸まわり**に `rot` を回す。ドラッグがロールを生まない設計は維持したまま、明示キーでのみロールを許す形。
- マップカメラ(`OverviewCamera`)にも同じキーでロールを効かせる。`OverviewCamera` は `offset_r`/`pan_r` の二ベクトルが真実で、上方向は現状固定と思われる。**ロールを持たせるには「上方向ベクトル」を状態として持つ必要がある。**
  - **価値判断 → 提案:** マップカメラの上方向も `cameraFrame` 相対のベクトル `up_r` として保持し、`offset_r` を軸にロールで回す。`toFramePos`/`toInertialPos` に乗るので回転フレームでも co-rotate する。ヨー/ピッチ操作のたびに `up_r` を `offset_r` に対して再直交化する。
- `CameraSystem.update` がキーを読んで各カメラへ渡す(既存の `cameraYaw*`/`cameraPitch*` と同じ経路)。**`Game` はキーを知らない**原則を守る。

**検証:** `npm run typecheck`。

---

### WP-D2: navball ウィンドウ + グリッド表示トグル

**要件:**
- ビュー左上に navball ウィンドウ。
- 戦闘ビュー: 「ターゲット座標での進行方向 / その逆」を表示できるモードのトグル。
- 両ビュー: 黄道・黄道極・黄道緯経度グリッド・赤道・赤道極・赤道緯経度グリッドの表示トグル(それぞれ独立)。

**これは本改修で最大の新規実装。2 つに分割すること。**

#### WP-D2a: グリッド描画(ワールド空間)

- **設置場所:** `src/render/celestial-grid.ts`(新規)。`EnvironmentScene` が所有し、その `sync` から更新する(`EnvironmentScene` は既に星殻・太陽・月・参照軌道線を持つ)。
- 内容: 赤道面グリッド / 黄道面グリッド(緯線・経線の球面ワイヤ)、赤道極 / 黄道極マーカー。
  - 赤道面はゲーム ECI そのもの(Y = 北極)。黄道面は `ephemeris.ts` の `Q_ECL_TO_ECI` を使う。**傾斜角 23.44° を直書きしない。**
  - グリッドは**カメラ位置に追従する固定半径の殻**として描く(星殻と同じ扱い。マップのズームアウトで殻の外に出ないこと)。半径定数は星殻と同じものを使う。
  - `THREE.LineLoop` は WebGPU レンダラで未対応。**`THREE.Line` で手動で閉じる。**
- 6 つの独立したトグル(黄道面/黄道極/黄道グリッド/赤道面/赤道極/赤道グリッド)。可視状態は navball ウィンドウ側が持ち、`EnvironmentScene.sync` へ引数で渡す(`*Ctx` 禁止)。

#### WP-D2b: navball ウィンドウ

- **設置場所:** `src/game/navball/`(新規フォルダ)。`navball.ts`(状態と `sync`)+ `navball-panel.ts`(DOM)。所有者は **`Game`**(戦闘・マップ両方で出るのでカメラにもステージにも属さない)。
- **描画方式の価値判断 → 提案:**
  - **A(推奨): DOM/SVG による 2D 投影の navball。** 球体を正射影した円に、緯経線と方位マーカー(prograde/retrograde/target/anti-target/normal/radial)を `physics/projection.ts` の純粋関数ではなく、**姿勢クォータニオンから直接 2D 座標を出す**方式で描く。HUD は既に DOM/SVG オーバーレイ(`Hud.svgOverlay`)を持っており、追加のレンダーターゲットもシーンも要らない。
  - **B: 別シーン + `WebGPURenderer` の第二パス。** テクスチャ付きの本物の球が描けるが、レンダラは 1 つしか作らない設計(`render/scene.ts` が唯一の生成点)であり、ビューポート分割かレンダーターゲットの導入が要る。**コストに見合わない。非推奨。**
- 表示モードのトグル:「自機基準」/「ターゲット基準(進行方向)」/「ターゲット基準(進行方向の逆)」。ターゲットは `Targeter.aliveTarget`(第一のみ)。ターゲットが無いときはトグルを無効化する。
- グリッドトグル 6 つはこのウィンドウ内に置く(`hud/buttons.ts` の `HudToggle` を使う)。ボタンは `pointer-events: auto` が必要(`#hud` 自体は `none`)。
- z-index は `dom.ts` のバンド 1(ゲームパネル)。**`dom.ts` の STYLE にバンドを追加すること**(マーカーはランタイム生成なので、バンドを与えないと上に乗る)。

**検証:** `npm run typecheck`。

---

### WP-D3: 時間の最大加速を 32 倍に

**現状:** `SIM_SPEED_LEVELS = [1, 4, 16, 64, 256, 1024, 4096]`(×4 の等比)。

**要件:** 最大加速単位を現在の 32 倍 → 4096 × 32 = **131072**。

**価値判断 → 提案:**
- **推奨: ×4 の等比を保ったまま段を足し、最上段だけ帳尻を合わせる。** `[1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 131072]`。最後だけ ×2 になるが、要件の「32 倍」を正確に満たし、段の刻みも一定に近い。
- 代案: `[..., 4096, 32768, 131072]`(×8 刻み、段数を増やしすぎない)。段の飛びが大きく操作感が悪いので非推奨。
- **`MAX_PHYS_SIM_SPEED = 4` は変更しない。** 物理相互作用の上限は独立した意味を持つ。
- **副作用の確認が必須:** `SUBSTEP_MAX_DT` / `SUBSTEP_MAX_COUNT` により、1 フレームあたりのサブステップ数は上限で頭打ちになる。×131072 では 1 サブステップが数十秒になり、軌道積分精度が落ちる。**高ワープ時に軌道が目に見えて崩れないか、`npm run test:physics` ではなく実際の値で確認する**(`stepOrbitRK4` の 1 周期ドリフトのテストがあるので、LEO 周期に対するステップ幅の比で見積もれる)。崩れるなら `SUBSTEP_MAX_COUNT` を上げるか、最上段を諦めてユーザーに報告すること。

**検証:** `npm run typecheck` + `npm run test:physics`(定数変更が physics の前提に触れるため)。

---

### WP-D4: 自動ワープの残り時間表示 + 加速の急峻化

**要件:** ノードまでの加速時に残り加速時間を表示。所要時間を現在の半分程度になるよう加速を急激にする。

**現状:** `SimSpeedManager.update` は `SIM_SPEED_LEVELS[i] <= tRem / AUTOWARP_MARGIN`(`AUTOWARP_MARGIN = 4`)を満たす最大段を選ぶ。`AUTOWARP_STOP = 20` 秒前に解除。

**方針:**
- **残り時間表示:** 「残り**シミュレーション時間**」ではなく「残り**実時間**」を出す。ユーザーが待つのは実時間。
  - 実時間の見積もり = 現在段のまま進んだ場合ではなく、**段が下がっていく将来を織り込んだ積分**。`AUTOWARP_MARGIN` による段選択は `tRem` の関数なので解析的に和が出る: 各段 `s` が使われる `tRem` 区間は `[s·M, s'·M)`(`s'` は次段)、その区間の実時間は `(s'−M·... )` — **実装は素直に、段のリストを上から下へ舐めて各段の消化実時間を足し上げる小さなループでよい。** `SimSpeedManager` に `estimatedRealSecondsToWarpEnd(simTime): number | null` を新設。
  - 表示先: **`Hud` のヒントではなく、常時見える場所。** 自動ワープ中だけ出す小さな表示を `HudPanels` のステータス側に置く(`HudPanels` は表示専用で `Game` を直接読むので、`simSpeedManager` を読むだけで済む)。
- **急峻化:** `AUTOWARP_MARGIN` を 4 → **2** にする。段選択が `tRem/2` 基準になり、各段の滞在時間がおよそ半分になる → 全体の所要実時間もおよそ半分。要件の「半分程度」に直接対応する。
  - `AUTOWARP_STOP = 20` は変更しない(ここを縮めると BURN ガイドを読む時間が無くなる)。
- **`CLAUDE.md` / `DEVELOP/SPEC.md` の該当記述を更新すること。**

**検証:** `npm run typecheck`。

---

### WP-D5: 戦闘ビューに現在日時とミッション経過時間を表示

**要件:** `yyyymmddhhmmss` 形式で、現在の時間とミッション開始からの経過時間。

**方針:**
- **`simTime` の絶対時刻としての意味を決める必要がある。** `simTime` は `Simulator` が持つ秒。**エポック(`simTime = 0` が何年何月何日か)がプロジェクトに定義されているか、まず `ephemeris.ts` と `const.ts` を確認すること。** `Ephemeris` は `sunPhase0`/`moonPhase0` を持つので、暦との対応がどこかにあるはず。
  - 無い場合 → **価値判断 → 提案: `const.ts` に `SIM_EPOCH_UTC`(推奨: `2030-01-01T00:00:00Z`)を新設し、`simTime` 秒をそこからの経過とする。** 近未来設定としても妥当で、`Ephemeris` の位相初期値との整合はゲーム内演出上問題にならない。ユーザーに確認するのが望ましい判断点。
- 書式化関数は `hud/utils.ts` に置く(`fmtDist`/`fmtTime` の隣)。**`fmtTime` と用途が違う(絶対日時 vs 経過秒)ので別関数**だが、経過時間側は `fmtTime` で足りないか先に確認すること(`/add-feature`)。
- 表示先: `HudPanels` のステータスパネル。マップモードでも出して問題ない(要件は戦闘ビューだが、隠す理由がない)。**ただし要件通り戦闘ビューで必ず見えること。**

**検証:** `npm run typecheck`。

---

## 5. クリエイティブモード

> **WP-E は WP-A〜D と独立に着手できるが、規模が最大。E1 → E2 → E4 → E5 → E3/E6 の順で進め、各段でレビューを受けること。**

### WP-E1: モード概念とタイトルのタブ

**要件:** 従来のゲームを「ステージモード」と定義し、「クリエイティブモード」を新設。タイトル下のタブメニューから選択して起動する。

**方針:**
- `GameMode = 'stage' | 'creative'` を `src/game/game-mode.ts`(新規)に定義。
- `stage-select.ts` の `selectStage()` を**タブ付きの起動画面**に一般化する。返り値を `StageId` から `{ mode: 'stage', stage: StageId } | { mode: 'creative' }` に変える。**関数名も `selectStage` から実態に合う名前へ改名する(`selectLaunch` 等)。旧名は 0 件にする。**
  - ファイル名 `stage-select.ts` も責務と合わなくなる。`src/game/launch-select.ts` へ移動を推奨(`stages/` の下はステージ固有のものだけにする)。
- `resolveStageSelection`(`?stage=` 短絡)も同様に一般化する。**クリエイティブモードにも URL 短絡を用意する(`?mode=creative`)。** 開発時の再現に必須。
- `main.ts` はこの結果を見て `Game` の構築を分岐する。
- **`UnlockManager` はクリエイティブモードに関与しない**(クリア回数を記録しない)。

**価値判断 → 提案:**
- **Q. クリエイティブモードは `Stage` の一種か、`Game` の別モードか。**
  - **推奨: `Stage` のサブクラス `CreativeStage` として実装する。** `Stage` は既に「勝敗 `phase`」「毎フレーム `update`」「ステータスパネル」「`Logistics`」を持ち、`Game` はそれを 1 つだけ持つ形になっている。クリエイティブを `Game` の第二の軸にすると `Game` 全体に分岐が入る。`CreativeStage.checkWin()` は常に `false`(`StageDebug` と同じ手法)。
  - ただし `STAGE_DEFINITIONS` には**載せない**(ステージ選択タブに出さない)。`STAGE_CLASSES` への登録の要否は実装時に判断し、`hiddenFromSelect` で済むならそれを使う。

**検証:** `npm run typecheck`。

---

### WP-E2: 軌道指定による宇宙船配置

**要件:** マップモードから始まる。基準天体/場所を選び、軌道高度・軌道傾斜角・位相・離心率・近地点・遠地点・周期などの**軌道要素のうちいずれかを指定して**軌道を決め、確定してそこに宇宙船を浮かべる。複数設置できる。

**方針:**
- **UI:** マップモードのパネル群に「艦艇配置」パネルを追加(`src/game/creative/ship-placer-panel.ts`)。所有者は `CreativeStage`。
- **軌道の指定方法の価値判断 → 提案:**
  - 「軌道要素のうちいずれかを指定」は素朴に取ると不定(6 要素必要)。**推奨: 「6 要素すべてに既定値を持つフォームを出し、ユーザーは触りたい欄だけ触る」。** 加えて**相互に排他な入力の組**を用意する:
    - サイズ/形: 「近地点高度 + 遠地点高度」または「半長軸 + 離心率」または「周期 + 離心率」を**タブで排他選択**し、選んだ組から残りを導出して即座に表示する。
    - 向き: 傾斜角 `i`、昇交点赤経 `Ω`、近点引数 `ω`。
    - 位相: 真近点角 `ν`。
  - 確定は `orbital.ts` の **`stateFromElements` をそのまま使う**(新規に要素→状態の変換を書かない)。周期↔半長軸は **`keplerPeriod` の逆**が要る。`keplerPeriod(a)` が唯一の変換点という規約があるので、**逆関数 `semiMajorFromPeriod(T)` を `orbital.ts` に追加し、そこを唯一の逆変換点にする**(`npm run test:physics` に往復テストを追加すること)。
  - **基準天体:** 地球・月。月周回軌道は ECI 上では二体近似が成り立たないが、**「月中心の要素で状態を作り、月の位置・速度を足して ECI に置く」**で十分(その後は全エンティティ共通の摂動込み積分に乗る)。月の速度は `ephemeris` の位置の有限差分で足りる。**新規に月の速度式を書かない — `moonPosAt` の差分で済ませ、必要なら `ephemeris.ts` に `moonVelAt` を追加する(追加したら `test:physics`)。**
- **設置される宇宙船:** 既存の `Ship` 系を使う。**`Player` は 1 機前提の設計(`Game.player` は非 null、`FloatingOrigin` は `player.state` から作られる)なので、複数機は `Player` の複製にはできない。**
  - **価値判断 → 提案:** クリエイティブの艦艇は **`Enemy` ではなく、新クラス `CreativeShip extends Ship`** とする。`Enemy` は AI(射撃)とグループ攻撃者上限を持ち、意味が合わない。`CreativeShip` は AI を持たず、軌道を進むだけ + 計画自動追従(WP-E5)を持つ。
  - **アクティブ化(WP-E4)は「その `CreativeShip` を `Player` にする」のではなく、「`Player` をその状態へ移す」でもない。** 設計は WP-E4 で決める。
- `EntityManager` に `CreativeShip` の配列を足すか、既存 `enemies` に相乗りさせるか → **足す。** `enemies` は `Enemy[]` 型で、AI・ターゲット・撃破判定の全経路が繋がっている。

**検証:** `npm run typecheck` + `npm run test:physics`(`orbital.ts`/`ephemeris.ts` に追加した場合)。

---

### WP-E3: ハロー軌道・リサジュー軌道

**要件:** ラグランジュ点にあるハロー軌道・リサジュー軌道を選んで宇宙船を浮かべられる。

**方針:**
- **これは物理的に難度が高い。単独の作業単位として最後に回すこと。**
- ハロー軌道は制限三体問題の周期解であり、**閉形式では出ない。** 二通りある:
  - **A(推奨): Richardson の三次近似解を使う。** 解析式で初期状態が出る。厳密な周期軌道ではないので長期的にはドリフトするが、**クリエイティブモードの「置いて眺める」用途には十分**で、`physics/` に純粋関数として置ける(`src/physics/halo.ts`、`npm run test:physics` でカバー)。
  - **B: 微分修正で数値的に周期解を求める。** 正確だが実装量が桁違いで、`physics/` の「純粋関数」規約とも相性が悪い(反復収束)。**非推奨。**
- リサジュー軌道は同じ線形化から、面内・面外の振動数が非共鳴なまま組み合わせたもの。Richardson の枠内で振幅を独立に指定すれば出る。
- **配置後の挙動の注意:** ゲームの積分は「地球中心二体 + J2 + 抗力 + 日月三体」であり、**制限三体問題そのものではない。** SE 系ラグランジュ点(1.5e6 km 先)ではこの近似は地球中心二体として振る舞い、ハロー軌道は保たれない。
  - **価値判断 → ユーザーに確認すべき点:** 「ハロー軌道が実際に維持されて見える」ことを求めるなら、積分器側の対応(該当領域では別の力モデルを使う、あるいは配置した船だけ運動学的に軌道をなぞらせる)が要る。**推奨: 初版は「Richardson 解の初期状態を置くだけ」とし、ドリフトすることを承知の実装にする。** そのうえで、必要になった時点で `CreativeShip` に「運動学的追従モード」を足す(WP-E5 の計画自動追従と同じ仕組みに乗せられる)。

**検証:** `npm run typecheck` + `npm run test:physics`。

---

### WP-E4: 宇宙船のアクティブ化

**要件:** 設置した宇宙船を右クリックメニューから「操作対象(アクティブ)」にできる。アクティブな船のマップビューはステージモードのマップビューに近い(軌道計画を設定できる)。

**現状の制約:** `Game.player: Player` は非 null 前提。`FloatingOrigin` は `player` の状態から毎 `sync` 構築。`PlanEditor`/`Plan.trackAnchor` は `player` を見る。`ChaseCamera` は `player` 参照をコンストラクタで受ける。

**価値判断 → 提案(推奨案):**
- **`Player` を「役割」として扱い、どの `CreativeShip` に憑くかを差し替える**のではなく、**クリエイティブモードでは `Player` が常に 1 機存在し、アクティブ化とは「`Player` の状態をその `CreativeShip` の状態に一致させ、その `CreativeShip` を非表示にする」** — これは状態の二重管理になり、非推奨。
- **推奨: `CreativeShip` を `Player` のサブクラスにせず、代わりに `Game.player` の参照先を差し替え可能にする。**
  - すなわち `CreativeShip extends Player` とし、クリエイティブモードでは設置された全艦が `CreativeShip`。`Game.player` はそのうち 1 機を指す。アクティブ化 = `Game.player` の指す先を変える。
  - 影響: `ChaseCamera` がコンストラクタで `player` を握っている。**`ChaseCamera` の `player` を可変(setter)にする**か、`Game` がアクティブ切替時に各所へ通知する。**推奨: `Game` に `setActivePlayer(ship)` を新設し、そこが `player` フィールド・`ChaseCamera.player`・`PlanEditor` の計画リセット・`Targeter` のクリアをまとめて行う。切替の副作用を一箇所に閉じる。**
  - `Player` は `PlayerThrottle`/`PlayerFire`/`Belt`/`Thermal`/`Radiator`/`Power` を composed しており、全艦がこれを持つのは重い。**`CreativeShip` が `Player` を継承するなら、非アクティブ艦の `behave` は呼ばない**(`CreativeStage.update` が制御する)。それでもコンストラクタコストは掛かるので、**設置可能隻数に上限を設ける**(`const.ts` の `CREATIVE_MAX_SHIPS`、推奨 8)。
  - **この案は `Player` の「1 機前提」を崩すため、影響範囲の調査を実装前に必ず行うこと。** `grep -rn "\.player" src/` で全参照を洗い出し、切替に耐えるかを一つずつ確認し、その結果をレビュー時に報告する。**調査の結果この案が破綻するなら、報告して代案の判断を仰ぐこと。勝手に別案へ倒さない。**
- 右クリックメニュー項目(`kind:'ship'`、WP-A2 の `MapContextGizmo` 経由): 「操作対象にする」「軌道計画に自動追従 ON/OFF」(WP-E5)「フォーカスを移動」「削除」「キャンセル」。

**検証:** `npm run typecheck`。

---

### WP-E5: 軌道計画への自動追従

**要件:** 右クリックメニューから「軌道計画に自動的に従うか」を切り替えられる。従う設定なら計画は自動実行され、宇宙船は計画軌道を移動する。

**方針:**
- **各艦が自分の `Plan` を持つ必要がある。** 現状 `Plan` は `PlanEditor` が 1 つだけ持つ。**`Plan` の所有を `CreativeShip` へ移し、`PlanEditor` は「アクティブ艦の `Plan` を編集する」形にする。**
  - ステージモードでは `Player` が `Plan` を持つ。`PlanEditor` は `player.plan` を編集する。**この変更はステージモードにも及ぶので、ステージモードの挙動が変わらないことを確認すること。**
- **自動実行の方法の価値判断 → 提案:**
  - **A(推奨): ノード時刻に達したら状態を瞬間的にノードの状態へ置き換える。** ノードは既に「バーン後の絶対状態」なので、`GameEntity.state` の setter(`OrbitEntity.reset`)を呼ぶだけで済む。有限時間のバーンを模擬しないので、計画軌道と実軌道が厳密に一致する — 「計画軌道を移動する」という要件そのもの。
  - B: Δv を有限推力で実行する。物理的に正しいが、計画とずれるので「自動追従」の看板と合わない。**非推奨。**
- 自動追従が ON の艦は、`CreativeStage.update` が毎フレーム「次ノードの時刻を跨いだか」を見て `reset` する。跨いだノードは消費して次へ進む。
- **アクティブ艦が自動追従 ON のとき、ユーザーの手動操作と競合する。** 推奨: アクティブ化しても自動追従の設定は独立に保つ。手動推力を入れると計画が実軌道からずれるが、それはユーザーの選択。

**検証:** `npm run typecheck`。

---

### WP-E6: アクティブ艦から `[M]` で戦闘ビューへ

**要件:** 宇宙船がアクティブ状態のとき、`[M]` キーで戦闘ビューに切り替えられる。

**方針:**
- これは**既存の `MapModeToggler` の挙動そのもの**(`[M]` はマップ⇄戦闘のトグル)。したがって追加実装はほぼ不要。
- ただしクリエイティブモードは**マップモードから始まる**ので、`MapModeToggler.mapMode` の初期値をモードによって変える必要がある。**初期値をコンストラクタ引数で受ける形にする**(`CreativeStage` かモード解決側から渡す)。
- **アクティブ艦が無いときは `[M]` を無効にする。** 戦闘ビューは `player` を必要とするため。`MapModeToggler.update` に「切り替え可能か」を引数で受ける(既に `isPaused` を受けているのと同じ形)。

**検証:** `npm run typecheck`。

---

## 6. 作業の進め方(サブエージェント向け)

1. 着手前に該当 WP の節を読み、`DEVELOP/OWNERSHIP.md` と `DEVELOP/CALLSTACK.md` で影響範囲を確認する。`src/` を闇雲に読み始めない。
2. **1 WP = 1 変更セット。** 複数 WP をまとめてコミットしない。
3. 変更セットには必ず以下を含める:
   - 実装
   - `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` のうち該当するものの更新(`/develop-docs` の判定手順に従う)
   - 責務配置の新しい判断を下した/変えた場合は `.claude/skills/refactor-fixed/SKILL.md` の書き直し(追記ではなく全体が整合するように)
   - 自分が書いたコメントの点検(`/comment`)
   - `npm run typecheck`(常に)/ `npm run test:physics`(`src/physics/` を触ったときのみ)
4. **「価値判断 → 提案」と書かれた箇所は推奨案がそのまま指示。** 実装中にその案が破綻すると分かった場合は、**勝手に別案へ倒さず、理由を添えて報告して判断を仰ぐこと。**
5. 完了報告には以下を含める: 触ったファイル一覧 / 推奨案から外れた点とその理由 / 更新した設計文書 / 検証コマンドの結果(失敗したなら出力そのまま)。

## 7. 未決事項(ユーザーへの確認が必要)

- **`simTime` のエポック**(WP-D5)。`2030-01-01T00:00:00Z` を提案。
- **HUD テーマの二色目**(WP-C2)。第二ターゲット用にシアン `#00c8ff` を提案。現行の「オレンジ一色」規約の変更にあたる。
- **ハロー軌道の維持**(WP-E3)。初版は Richardson 三次近似の初期状態を置くだけ(ドリフトする)を提案。「維持されて見える」ことを求めるなら別途対応が要る。
- **`Player` の 1 機前提を崩す是非**(WP-E4)。影響範囲の調査結果を見てから最終判断したい。
