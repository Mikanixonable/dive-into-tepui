# `origin/workspace2` レビュー — マップ/クリエイティブモード改修

対象: `f621929`(merge-base) … `origin/workspace2` (`7ebd7cc`)
差分規模: 68 ファイル / +3336 −536。うち `src/` は 55 ファイル。
コードは一切変更していない。以下は差分とコミットログからの読み取り。

ブランチ名は `workplace2` ではなく **`workspace2`**。

---

## 0. コミット構成

| commit | 内容 |
| --- | --- |
| `cadf7e8` | move: docs |
| `cd8e9aa` | 実装指示書 `memos/mikanixonable/MAPMODE_CREATIVE_PLAN.md`(491行)を新規作成 |
| `c0a18ab` | WP-A1/A2(MapPickable・MapContextGizmo)、WP-D3/D4/D5(ワープ段・自動ワープ・日時)、WP-D2a(天球グリッド)、WP-B5(Δv編集UI) |
| `e1823d2` | WP-C1/C2(ターゲット手動化・第二ターゲット)、WP-D1(カメラロール)、WP-B4(手動レンジ) |
| `809fb6e` | docs: Wave1 |
| `71e5228` | WP-B1/B2/B3(船のフォーカス・NavTarget・アプシス) |
| `718030b` | docs: Wave2/3 + `refactor-fixed` |
| `b4d82c7` | WP-D2b/E1/E6(navball・起動タブ・CreativeStage) |
| `cd95e2a` | WP-E3(halo.ts) |
| `673368f` | WP-E4/E5(アクティブ艦切替・Plan の艦所有・自動追従) |
| `10be267` | WP-E2(艦艇配置パネル・`semiMajorFromPeriod`・`moonVelAt`) |
| `a783fc1` / `7ebd7cc` | docs |

指示書は「1 WP = 1 変更セットで、実装と設計文書更新を同じコミットに含める」と自分で書いているが、
**実際は docs が別コミット(`809fb6e` / `718030b` / `a783fc1`)にまとめられている。** 最終状態としては
4 文書 + `refactor-fixed` すべて更新済みなので実害は小さいが、規約通りではない。

---

## 1. 要求 → どのモジュールへの変更として反映されたか

### マップモードのUI

| 要求 | 反映先 | 状態 |
| --- | --- | --- |
| 船を右クリックメニューでフォーカス対象に | `map-pick.ts`(新), `map-pick-menu.ts`(新), `game.ts` `buildMapPickables`/`mapMenuItemsFor`, `overview-camera.ts`(`resolveFocus(candidates)`) | ✅ |
| 月・ラグランジュ点をターゲットに | `nav-target.ts`(新 `canTarget`), `game.ts` `navTargetItems` | ✅ |
| ターゲットとの相対 AN/DN をアイコン表示、右クリックで加速/ノード追加/フォーカス | `nav-target.ts`(`Targeter` から移設), `game.ts`(act ディスパッチ), `plan-editor.ts` `addNodeAt` | ✅ |
| 近地点・遠地点アイコン + 右クリックメニュー | `plan-display.ts`(`syncApsisMarkers`/`apsisMarkers`/`apsisTimeOf`), `const.ts` `APSIS_MIN_ECC` | ✅ |
| 時間スライダーの目盛り + 手動レンジ | `display-time-manager.ts`(`'manual'`/`manualDurationSec`/`tickLabels`), `display-time-panel.ts`, `plan-arc.ts`(`PLAN_ARC_MAX_STEPS` 打ち切り) | ✅ |
| Δv 長押しボタン + ドラッグラッチ | `hud/buttons.ts` `HudHoldButton`(新), `node-gizmo.ts` `AxisLatchState`, `plan-editor.ts` `applyDv`/`applyHeldDv` | ✅ レート適用点は `applyDv` 一箇所に集約済み |

### 戦闘ビューのUI

| 要求 | 反映先 | 状態 |
| --- | --- | --- |
| オートターゲット廃止 → 右クリックメニュー | `targeter.ts`(`resolveAutoTarget`/`lockedTarget`/`handleTargetLockByRightClick` を削除、`target` を唯一の正本に), `input.ts`(右クリックにも `CLICK_MOVE_THRESHOLD` 適用) | ✅ |
| 第二ターゲット・別色 | `targeter.ts` `secondaryTarget`/`secondaryOrbitLine`, `theme.ts` `ACCENT_SECONDARY`(`#00c8ff`), `enemy.ts` `markerItem(role)`, `grouped-markers.ts` `color?`, `hud/panel.ts` | ✅ renderOrder は player=1 / secondary=2 / primary=3 / planned=4 に振り直し済み |

### 両ビュー共通

| 要求 | 反映先 | 状態 |
| --- | --- | --- |
| カメラロールをテンキー0/1 | `key-mapping.ts`(`cameraRollLeft/Right`), `chase-camera.ts`(`keyRoll`), `overview-camera.ts`(`up_r` を新設) | ⚠️(→ 4-4) |
| navball ウィンドウ | `game/navball/navball.ts` + `navball-panel.ts`(新、`Game` 所有) | ✅ |
| ターゲット順行/逆行モードトグル | `navball.ts` `NavballMode`(`self`/`targetPro`/`targetRetro`) | ✅ |
| 黄道/赤道の面・極・グリッド6トグル | `render/celestial-grid.ts`(新、`EnvironmentScene` 所有)、可視状態は `Navball.gridVisibility` | ⚠️ Ctx を広げた(→ 4-1) |
| 最大加速 ×32 | `const.ts` `SIM_SPEED_LEVELS` → `…,4096,16384,65536,131072` | ⚠️ 副作用未対処(→ 3-E) |
| ノードまでの残り加速時間表示・所要半減 | `sim-speed-manager.ts` `estimatedRealSecondsToWarpEnd`, `AUTOWARP_MARGIN` 4→2, `hud/panel.ts` | ✅ 段が下がる将来を積算する実装で妥当 |
| 現在日時 + 経過時間 (yyyymmddhhmmss) | `hud/utils.ts` `fmtDateTime`, `const.ts` `SIM_EPOCH_UTC='2030-01-01T00:00:00Z'`, `hud/panel.ts` | ✅ |

### クリエイティブモード

| 要求 | 反映先 | 状態 |
| --- | --- | --- |
| モード概念・タイトルのタブ | `game-mode.ts`(新 `GameMode`/`LaunchSelection`), `launch-select.ts`(新、`stages/stage-select.ts` を廃止して移動), `main.ts` `resolveLaunchSelection`(`?mode=creative`) | ✅ |
| マップから開始 | `map-mode-toggler.ts`(`initialMapMode` 引数 + `applyInitialState`) | ✅ |
| 軌道要素指定で艦を配置 | `creative/ship-placer-panel.ts`(新 278行), `stages/creative-stage.ts`(新), `orbital.ts` `semiMajorFromPeriod`, `ephemeris.ts` `moonVelAt` | ✅ 排他な3組(近地点+遠地点 / 半長軸+離心率 / 周期+離心率) |
| ハロー・リサジュー軌道 | `physics/halo.ts`(新) + `tests/physics/halo.test.ts` | ⚠️ 指示書の Richardson 三次近似ではなく線形化解(→ 4-8) |
| 右クリックでアクティブ化 | `entity-manager.ts` `players`/`findPlayer`, `game.ts` `setActivePlayer`, `camera-system.ts`/`combat-camera-system.ts`/`chase-camera.ts` の `setPlayer` 連鎖 | ✅ |
| 軌道計画の自動追従 | `Plan` の所有を `PlanEditor` → `Player` へ移動、`Player.followPlan`, `CreativeStage.advanceFollowPlan` | ✅ ノード時刻を跨いだら `state` をノードの絶対状態へ置換 |
| アクティブ時に [M] で戦闘ビュー | `map-mode-toggler.ts` `canToggleView` 引数 | ✅ |

---

## 2. ユーザーの3つの懸念への回答

### 懸念1: 「player を単独のものとして扱う」前提が崩れる

**解消済み。** `CreativeShip` を廃止し、すべての自機を `EntityManager.players` に入れて対等に扱う形へ
変更した(`/refactor-fixed`「自機は1隻でも `EntityManager.players` に入れ、シミュレーションでは
対等に扱う」節に確定判断として記録済み)。除外分岐と `= null` 既定引数は無くなった。

### 懸念2: マップモードの責務分配が壊れていないか

**壊れていない。むしろ一部は改善している。**

- `MapModeToggler` は解体されず、`initialMapMode`(コンストラクタ)と `canToggleView`(引数)で拡張された。
  `[M]` の開閉が `editor.editMode` / `cameraSystem.overviewMode` / `displayTimeManager.forceCurrent` を
  同時に切り替える構造はそのまま。`applyInitialState` で初期値も同じ経路を通る。
- `OverviewCamera` から `FocusMarkers` 依存が切れ、`resolveFocus(candidates)` が
  引数で受けた `MapPickable[]` から id で引き直す形になった。カメラが「候補が何であるか」を
  知らなくなったので、これは責務分割としては前進。
- `FocusGizmo`(`camera/`)→ `MapContextGizmo`(`game/` 直下)への一般化 + 所有者の `CameraSystem` → `Game`
  移動も筋が通っている(メニュー項目が camera / targeter / plan / simSpeed にまたがるため)。
  旧名 `FocusGizmo` / `focusGizmo` / `closeFocusMenu` / `FOCUS_LABEL_PICK_PX` は全文検索 0 件。改名は綺麗。
- ポインタ優先順位の「呼び出し順だけで表現し、ギズモは互いを参照しない」設計も維持
  (`editor.handleMapPointer` → `game.handleMapContextMenu`)。
- **懸念があるとすれば `Game` 側**: `CameraSystem.handleMapPointer` が消えた代わりに、
  右クリック処理そのものが `Game.handleMapContextMenu` へ移った。マップの責務が
  各所有者から `Game` へ吸い上げられた面はある(→ 4-2)。

### 懸念3: `Targeter` の責務が混乱していないか

**混乱していない。分割の判断は正しい。**

- `NavTarget`(新規 99行)を別クラスとして立て、`Targeter` は `Enemy` 専用のまま据え置いた。
  `syncNodeMarkers`(相対 AN/DN)は `Targeter` から**移設**され、複製ではない(`Targeter` 側から消えている)。
  `Targeter` は 230行 → 206行 に減っている。
- `refactor-fixed/SKILL.md` に「戦闘ターゲットと航法ターゲットは別クラスにする」として判断が記録済み。
- ただし副作用が2つ:
  1. `Targeter` が `MapPickable` を import し、`pickEnemyAt` が毎クリック偽の `MapPickable[]` を
     組み立てて `pickNearest` を呼ぶ。`/add-feature` としては正解(ヒットテストの複製を避けた)だが、
     戦闘側がマップ用の型に依存する形になった。`pickNearest` を `MapPickable` ではなく
     `{ pos: Vec3 }` 制約の汎用関数にしておけば依存は生じなかった。
  2. `Targeter` が `ContextMenu` を直接持ち、`currentMenuTarget` + `onSelect` ディスパッチという
     **`MapContextGizmo` と同型のパターンを再実装**している(→ 4-5)。

---

## 3. 機能欠落・バグ(重要度順)

### E. ×131072 が サブステップ設計の前提を破る

`SUBSTEP_MAX_DT = 20` / `SUBSTEP_MAX_COUNT = 64` は変更されていない。
`nSub = min(64, ceil(simDt / 20))`、`subDt = simDt / nSub`。60fps・×131072 では
`simDt ≈ 2185 s` → `nSub = 64` → **`subDt ≈ 34 s`** で `SUBSTEP_MAX_DT` を大きく超える。
指示書 WP-D3 は「高ワープ時に軌道が目に見えて崩れないか実際の値で確認する。崩れるなら
`SUBSTEP_MAX_COUNT` を上げるか、最上段を諦めてユーザーに報告すること」と明示していたが、
定数にもコミットログにも対処の形跡がない。上位1〜2段は精度保証の外にある。

### F. `ship-placer-panel.ts` の数値入力にスタイルが当たっていない

`numberField` が `input.className = 'manual-duration-value'` を付けているが、
`dom.ts` の該当セレクタは `#hud-displaytime input[type="number"].manual-duration-value` で
**`#hud-displaytime` 配下にスコープされている。** パネル id は `hud-shipplacer` なので無効。
かつ、クラス名が別モジュール(表示期間の手動レンジ)の概念を指しており、命名規約の
「類義語の混雑 / 混同のおそれ」に該当する。

---

## 4. 責務漏洩・リファクタリング規約違反

### 1. `EnvironmentSyncParams` を広げた ★規約の明示的違反

CLAUDE.md:「**`*Ctx` snapshot objects are a rejected pattern here — don't add new ones and don't widen
the survivors.** …what remains is `EnvironmentSyncParams`」。
今回 `celestialGridVisibility: CelestialGridVisibility` をこの残存 Ctx に**追加**した。
指示書自身も WP-D2a で「`EnvironmentScene.sync` へ引数で渡す(`*Ctx` 禁止)」と書いていたので、
指示書からも規約からも外れている。`refactor-fixed` には「`EnvironmentSyncParams` 経由で渡す」と
**違反した形のまま確定判断として記録されてしまっている**ので、ここは巻き戻すか判断を改める必要がある。

### 2. `game.ts` が大きい

371行 → **542行**。艦操作(`findCreativeShip` 等)は `EntityManager.findPlayer` + 2行の配線へ縮めた
ので振る舞いの漏洩は解消したが、`mapMenuItemsFor`(種別ごとのメニュー項目表)・`buildMapPickables`
(候補集合の組み立て)・`handleMapContextMenu` はまだ `Game` にある。前2つは
`/refactor-fixed` に「所有者がまたがるので `Game` が持つ」と確定判断として記録済み。
残る論点は行数だけ。

### 4. `OverviewCamera` のロールとヨー/ピッチが噛み合っていない

`up_r` を導入してロールは効くようになったが、ヨー/ピッチは相変わらず
`sphericalOffset(yaw, pitch, dist)` = ワールド Y 軸基準で計算されている。
90° ロールした状態で左右ドラッグしても、画面上の見た目と回転方向が一致しない。
`ChaseCamera` 側は現在の右/上軸を使うのでこの問題は無い。両者で操作感が割れている。

### 5. `Targeter` がコンテキストメニュー機構を再実装している

`MapContextGizmo` = 「`ContextMenu` + 対象保持 + 項目は呼び出し側」。
`Targeter` の `contextMenu` + `currentMenuTarget` + `applyMenuAct` は同じ形の再実装。
`MapContextGizmo` は `MapPickable` を握る形なので `Enemy` をそのまま渡せない、というのが
理由だとは推測できるが、**「同じ処理が複数箇所に分散している」実装の重複**にあたる。
`MapContextGizmo` を `<T>` にするか、対象保持を呼び出し側に戻すかで解消できる。

### 7. `CreativeStage` の `private simTime`

`Simulator.simTime` のコピーを毎フレーム覚え直す。理由はコメントに書かれている
(配置パネルの confirm が DOM イベントとして非同期に発火するため)が、正データの重複であることに変わりはない。
`ShipPlacerPanel.onConfirm` に `simTime` を引数で渡す形にできないか要検討。

### 8. 指示書からの逸脱: ハロー軌道

WP-E3 は「Richardson の三次近似解を使う(推奨)」で、指示書 §6-4 は
「推奨案が破綻すると分かった場合は**勝手に別案へ倒さず報告して判断を仰ぐこと**」。
実装(`physics/halo.ts`)は**線形化(一次)解のみ**で、三次の振幅拘束は実装していない。
ハロー軌道は「面外振動数に λ を流用して面内と共鳴させる」近似。
モジュール先頭コメントにその旨は明記されているので隠蔽はされていないが、
推奨案から外れた判断であり、報告・承認を経たかはコミットからは読み取れない。

なお同コメントの「Richardson (1980) の三次近似のうち…**実装していない**」は
`/comment` 方針の「なにをしないか は書かない」に触れる。ただしゲームの積分器が制限三体問題ではなく
配置後にドリフトする、という注意は非自明なので残す価値がある。書き方の整理が要る箇所。

### 9. `Navball` が天球グリッドの可視状態を持つ

指示書 WP-D2b が「グリッドトグル6つはこのウィンドウ内に置く」と指示した帰結で、
`refactor-fixed` にも判断として記録済み。ただし姿勢儀(機体座標)と天球グリッド(ワールド座標の表示物)は
別概念で、`Navball.gridVisibility` は `Navball` の責務外の状態。
「GUI はその GUI が書き換える状態の所有者が持つ」という既存原則の帰結ではあるので、
規約違反というより**トグルの置き場所の選択が状態の置き場所を決めてしまった**例。要判断。

### 10. 行数

- `game.ts` 542行 / `plan-editor.ts` 545行 / `ship-placer-panel.ts` 278行。
  モジュール 200行 の基準を大きく超える。`ship-placer-panel.ts` はフィールド宣言だけで20行以上あり、
  「軌道要素フォーム」と「ラグランジュ点フォーム」で分割の余地がある。

### 11. `navTarget.update` の呼び出し位置

`Game.update` の**先頭**(`stepSimulation` より前)で呼ばれるため、AN/DN の位置と
同フレームで sync されるメッシュとの間に1ステップぶんのずれがある。
`buildMapPickables` の `displayState(displayTime)` も同様。ワープ倍率が高いほど無視できなくなる。

---

## 5. よかった点(残すべき判断)

- **`Targeter` / `NavTarget` の分離。** 懸念3への正しい答え。移設であって複製ではなく、
  `Targeter` は行数が減っている。判断が `refactor-fixed` に記録済み。
- **改名の徹底。** `FocusGizmo` / `focusGizmo` / `closeFocusMenu` / `autoTarget` / `lockedTarget` /
  `resolveAutoTarget` / `handleTargetLockByRightClick` / `syncNodeMarkers` / `selectStage` /
  `resolveStageSelection` / `FOCUS_LABEL_PICK_PX` — `src/` `tests/` で全文検索 0 件。互換エイリアスも無い。
- **`Input` のクリック閾値判定の一本化。** 左/中/右で3回書かれていたものを `pushIfClick` に集約
  (`/add-feature` 準拠)。
- **`Plan` の所有を `Player` へ移し、`PlanEditor.plan` を getter だけにした。**
  ステージモードも同じ経路を通り、`PlanEditor` は計画の実データを一切持たない。
- **Δv 加算のレート適用点を `PlanEditor.applyDv` 一箇所に集約。** ドラッグ・ラッチ・キー・ボタンの
  4経路すべてがここを通り、「加算量の求め方だけが違う」形になっている。
- **`HudHoldButton` を `isHeld` ポーリング型にした判断。** `setInterval` を使わないので
  ポーズ・マップ閉時の止め忘れが構造的に起きない(指示書の推奨通り)。
- **`estimatedRealSecondsToWarpEnd`。** 現在段のまま外挿するのではなく、段が下がる将来を
  段リストを舐めて積算している。理由もコメントに書かれている。
- **`celestial-grid.ts`。** 傾斜角を直書きせず `Q_ECL_TO_ECI` から基底を作り、
  `LineLoop` 非対応の回避も明記。星殻半径を共有。
- **設計文書。** `CLAUDE.md` / `CALLSTACK.md` / `OWNERSHIP.md` / `SPEC.md` / `refactor-fixed` が
  最終状態では整合している。`refactor-fixed` に7件の新しい責務判断が追記されている。

---

## 6. 次に手を入れるなら(優先順)

1. **4-1** — `EnvironmentSyncParams` から `celestialGridVisibility` を引数へ出し、
   `refactor-fixed` の該当節を書き換える。
2. **4-5** — `Targeter` のコンテキストメニュー再実装を `MapPickMenu` の共有へ寄せる。
3. **3-F** — `ship-placer-panel.ts` の数値入力に効いていない CSS クラス名。
4. **3-E** — ×131072 の精度を実測し、`SUBSTEP_MAX_COUNT` を上げるか最上段を落とす。
5. **4-4** — `OverviewCamera` のロールとヨー/ピッチの噛み合わせ。
6. **4-9 / 4-8** — 天球グリッド可視状態の置き場所、ハロー軌道の近似次数。どちらも要判断。
7. **4-10 / 4-11** — 行数、`navTarget.update` の呼び出し位置。

---

## 付記

- 検証コマンド(`npm run typecheck` / `npm run test:physics`)は**実行していない**。
  作業ツリーを変更しない方針のため、静的な読み取りのみ。
- `memos/mikanixonable/dev.md` が `cadf7e8` と `7ebd7cc` で変更されている。
  CLAUDE.md では「この文書は人間のみが記入できる」とされているファイル。
  追記内容は今回のプロンプト全文と、その後の要望メモ(「軌道計画は、保存できるようにする。」等)なので
  人間の記入と読めるが、`7ebd7cc` は "update docs" というコミットに同梱されている。
  エージェントが触っていないかは要確認。
