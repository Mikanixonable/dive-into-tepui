# 責務境界の監査ログ — `/refactor` `/refactor-fixed` の徹底状況

対象: `8778273`(workspace2 マージ)〜 `37b2302` を中心に、作業ツリー全体。
方法: `.claude/hooks/check-boundaries.mjs`(今回追加した機械検査)の全 `src/` スイープ + 手読み。
検証: `npm run typecheck` 通過 / `npm run test:physics` **116/116 通過**(3件追加・2件修正)。

---

## 0. この変更セットで実施したこと

1. **`/refactor-fixed` を 371 行 → 約 190 行に圧縮。** 個別モジュールの判断(カメラの `ViewFrame`、
   `OrbitEntity` 一本化、`FrameRotation`、戦闘/航法ターゲットの分離、`Plan` の所有、
   `EntityManager.players`、アクティブ艦の切替、`CreativeStage`、天球グリッドの可視状態)は
   すべて CLAUDE.md へ移した。残したのは横断的・恒久的な 12 節のみ。
2. **5 つのルールを明文化**(1: Game はロジックを持たない / 2: update と sync を混ぜない /
   4: physics/ は正確さ最優先・物理でないものを持ち込まない)。
3. **再発防止フック `.claude/hooks/check-boundaries.mjs` を追加**(§3)。
4. **検出した違反をすべて是正**(§1)。現在フックのスイープは違反 0 件。

---

## 1. 検出した違反(すべて是正済み)

### A. `Game` がマップ被選択物のロジックを持っていた

`ab7ebc0` で `MapPickMenu`(対象を保持するだけのラッパー)を正しく削除した際、**その周辺の
ロジックが `Game` へ吸い上げられたまま残り**、`/refactor-fixed` に「所有者がまたがるので
`Game` が持つ」と確定判断として記録されていた。`Game` にあったのは `buildMapPickables` /
`refreshMapPickables`(候補列の組み立て)、`mapMenuItemsFor` / `navTargetItems`(種別ごとの
メニュー項目表)、`handleMapContextMenu`(右クリック解決)、`mapPickMenu.onSelect` の7分岐。

**是正:** `src/game/map-picker.ts`(`MapPicker`, 153行)を新設し、候補列 `pickables` の組み立て・
右クリック解決・種別別メニュー・選ばれた操作の配分をまとめて移した。`game.ts` は 546 → **442行**。
`MapModeToggler` が受け取るのも `ContextMenu<MapPickable>` から `MapPicker` へ変わった。

**`Game.setActivePlayer` は `Game` に残した**(ユーザー判断)。分岐も組み立ても持たず、自分の
フィールドを書いて各所有者へ1行ずつ知らせるだけなので、外へ出しても薄すぎるラッパーにしかならず、
`pause`/`resume` と同じ「配線の一部」。この線引き(**境界は行数ではなく分岐と組み立ての有無**)を
`/refactor-fixed` 1 に明記し、フックの許可リストにも入れた。

**教訓:** 薄いラッパーを消すときに、そのラッパーが**持つべきだった**責務まで上位へ流さない。
`MapPickMenu` は薄すぎたのであって、「マップ被選択物」という責務自体は正しかった。

### B. `sync` が論理値を進めていた / `update` を呼んでいた

`/refactor-fixed` 2 の違反 4 箇所。いずれも update 相へ切り出した。

| 箇所 | 内容 | 是正 |
| --- | --- | --- |
| `vfx/flash-effect-manager.ts` | `syncFlashEffects` が `fx.age += dt` と `simDt` ぶんの移流と寿命破棄をしていた | `updateFlashEffects(dt, simDt)` へ分離。`EffectsSystem.update` として `Game.update` から呼ぶ |
| `targeter.ts` | `syncBoardMarkers` が `m.age += dt` と寿命破棄をしていた | 記録側の `markBoardCrossings` と統合して `updateBoardMarks(dt, ...)` に。`syncBoardMarkers` は描くだけ |
| `plan/plan-display.ts` | `sync` が `traj.update()` を呼び、その中で **RK4 積分**が走り、`finalSegmentStart` と `_apsisMarkers`(次フレームの `update` が読む値)を書いていた | `update(plan, simTime, displayTime, show)` を新設。積分・ゴースト位置・アプシスアイコンの算出はそちら、`sync(fo, project, showPanel)` は反映だけ |
| `plan/plan-arc.ts` | `update` が `sampled.syncGeometry/syncTransform` を呼んでいた | `update`(積分)と `sync`(メッシュ反映)に分離。`PlanTrajectory` も同様 |

**副次的な効果:** 被選択物のアプシスアイコンが「前フレームの `sync` が求めた値」になっていた
歪みが消えた(旧 `/refactor-fixed` はそれを「1フレームの遅れは無害」と書いて正当化していた)。
`Game.update` の順序も `guide.update` → `trackAnchor` → `editor.update` → `mapPicker.refresh` へ
整理した。

**挙動の変化(意図的):** フラッシュエフェクトの寿命が update 相に移ったので、**ポーズ中は
爆発が止まる**(以前はポーズ中もフェードし続けていた)。決着後は簡略経路でも `effects.update` を
呼ぶので、撃墜の瞬間の爆発は最後まで再生される。

### C. `update` フェーズが DOM を書いていた

`plan-editor.ts` の `updateEditing`(`Game.update` から呼ばれる)が末尾で `renderPanel()` を呼び、
MANEUVER PLAN パネルの `innerHTML` を書き換えていた。**是正:** パネルの組み立てごと
`syncPanel(simTime)` として `PlanEditor.sync` へ移動。`updateEditing(dt, input)` は Δv の加算だけに
なった。あわせて命名も規約へ合わせた: `renderPanel` → `syncPanel`(`render` は
`renderer.render` を呼ぶものだけ)、`updateGizmo` → `syncGizmo`(実体は DOM スペックの組み立て)。
`HudPanels.update` → `HudPanels.sync` も同様(DOM しか書かないのに update を名乗り、`Game.sync`
から呼ばれていた)。

### D. `physics/projection.ts` の位置づけ

**「physics に置いてよい」で決着**(ユーザー判断)。直交座標から射影座標への変換は調整値を
含まない厳密な幾何であり、`physics/` の対象。境界は「用途が表示かどうか」ではなく
「**厳密な数学・物理そのものか、調整の入った歪めか**」であることを `/refactor-fixed` 4 と
`projection.ts` 冒頭・CLAUDE.md に明記したので、次回以降の検査には掛からない。

### E. `physics/halo.ts` の近似 — 加えて**係数の符号バグを発見・修正**

調査の過程で、面内振動数の式に**符号の誤り**が見つかった。
`λ² = (√(9c₂²−8c₂) + c₂ − 2)/2` は特性方程式 `λ⁴+(c₂−2)λ²−(2c₂+1)(c₂−1)=0` の**振動解ではない
方の根**で、正しくは `(√(9c₂²−8c₂) − c₂ + 2)/2`。太陽-地球 L1 で λ=2.53(誤)→ **2.0864**(正、
文献値と一致)。これで λ・ωz・k がすべて文献値に一致するようになった。

そのうえで、**Richardson (1980) の三次振幅拘束 `l1·Ax² + l2·Az² + Δ = 0` を実装**した。線形解では
λ ≠ ωz なのでハロー軌道は存在せず、両振動数が一致するのは三次でこの拘束が成り立つときだけ
— 従来の「面外振動数に λ を流用して共鳴させる」は文献にない独自の細工だった。`haloState` は
面外振幅 `Az` だけを取り、拘束から `Ax` を解いてから駆動する形にした。艦艇配置パネルの
「面内振幅」入力はハロー選択時には出さない(導出値になるため)。

**検算:** ISEE-3 ハロー(太陽-地球 L1、Az=110,000 km)で Ax=205,046 km・Ay=662,131 km を再現
(文献値 206,000 / 666,000 km に対し誤差 1% 未満)。テストに固定した。

### E-2. ラグランジュ点がヒル半径近似だった(E の調査で発覚)

`ephemeris.ts` の共線点 L1/L2 が `(μ/3)^(1/3)`(ヒル半径)そのままだった。真の値は5次方程式の
根で、**地球-月系では 5.6%(約 5,400 km)ずれる**(γ: 0.1594 → 0.15093)。Newton 法で解く形に
修正した。L1 と L2 は副天体から等距離ではなくなる(EM: 0.15093 / 0.16783)ので、それを等距離だと
断定していた既存テスト2件も文献値との突き合わせに書き換えた。

### F. `SUBSTEP_MAX_DT` が上位2段のワープで成立していなかった

`nSub = min(SUBSTEP_MAX_COUNT=64, ceil(simDt/20))` の上限に張り付くと `SUBSTEP_MAX_DT` が守られ
なくなっていた(60fps・×131072 で subDt ≈ 34 s)。**是正:** ユーザー判断により `SUBSTEP_MAX_COUNT`
のガードごと削除。最大ワープでもサブステップ数は約2倍(64 → 110)にしかならない。

参考に実測した積分誤差(`stepOrbitRK4`、1周期ぶん): LEO 420 km 円軌道で刻み 20 s → 0.29 m、
34 s → 2.57 m。Molniya 相当(e=0.741)で 0.01 km → 0.07 km。実害は元々小さかったが、
定数が主張する不変条件が成立していないことが問題だった。

### G. `CreativeStage.simTime` の正データ重複

`Simulator.simTime` のコピーを毎フレーム覚え直していた。**是正:** `Stage.setup` の注入に
`Simulator` を加え、`CreativeStage` は参照から直接読む形にした(注入は `setup` 1回のまま
— `/refactor-fixed` 10 の二段初期化禁止に従う)。

### H. `OverviewCamera` のロールとヨー/ピッチが噛み合っていなかった

`up_r` でロールは効くのに、ヨー/ピッチは `sphericalOffset(yaw, pitch, dist)` = ワールド Y 軸基準の
ままで、90° ロールすると画面上の見た目と回転方向がずれていた。**是正:** `ChaseCamera` と同じく
現在の上/右軸まわりの回転として組み直した。`sphericalOffset` は初期視点・リセット専用に残る。

### I. 文書の壊れた参照

`314cf6a` で `memos/hedalu244/refactoring_plan/` を削除した際、参照側が残っていた
(CLAUDE.md ×3、`/refactor` ×2、`/overview` ×1、`DEVELOP/README.md` ×1)。実在するパスへ直した。
`memos/README` にも `## ./refactoring_plan` の節が残っているが、**`memos/hedalu244/` 外は
エージェントの編集対象外**なので手を付けていない。

---

## 2. 違反していないことを確認したもの

- **フローティングオリジンの境界** — `Vec3` → `THREE.Vector3` の変換は `FloatingOrigin` 経由のみ。
- **`physics/` の依存純度** — THREE・`game/`・`FloatingOrigin` への依存は 0 件。
- **`*Ctx`** — 残っているのは `Player.behave` のパラメータオブジェクトだけ。
- **`Belt` / `RadiatorSystem` / `PowerSystem` / `Predictor` / `Simulator` / `EntityManager`** —
  update と sync が正しく割れている。
- **`MapModeToggler` の3フラグ同時トグル** — 維持されている。
- **`EntityManager.players` への一本化**(`8036f82`) — 除外分岐と `= null` 既定引数は残っていない。
- **改名の徹底** — `CreativeShip`/`MapContextGizmo`/`MapPickMenu`/`FocusGizmo` 等は全文検索 0 件。
- **関数長** — 90 行超は `selectLaunch`(122)・`Game.update`(112)・`Game.constructor`(91) のみ。

## 3. 再発防止(追加したフック)

`.claude/hooks/check-boundaries.mjs` を `PostToolUse`(Edit|Write)に追加した。
`src/**/*.ts` を編集するたびに、波括弧の対応でメソッド本文を切り出して次を検査する:

1. `game.ts` に許可メンバー(`constructor`/`update`/`sync`/`render`/`handleInput`/`pause`/`resume`/
   `setActivePlayer`/`perfCounts`。アクセサは対象外)以外のメソッドが増えていないか。
2. `sync*` の中に `.update(` / `age +=` / `step*RK4` / 寿命 filter が無いか。
3. `update*` / `behave` の中に `.sync(` / `.position.set` / `.visible =` / `.style.*=` /
   `.innerHTML =` が無いか。
4. `physics/` が `three` / `../game/` / `FloatingOrigin` に触れていないか。

検出時は編集直後に「該当節を読んでコードを直せ、ルールに例外を足して正当化するな」と出す。

**限界(承知の上):** 呼び出し先まで追わないので §C(`updateEditing` → `renderPanel`)のような
1段先の違反は素通りする。`physics/` の近似の妥当性(§E)や概念の置き場所(§D)は機械検査では
判定できない。**フックは取りこぼす前提で、判断そのものは `/refactor-fixed` を読む。**

## 4. 残 todo

- **行数** — `render/ships.ts` 605 / `audio/sfx.ts` 505 / `plan/plan-editor.ts` 515 /
  `game/game.ts` 442 / `hud/dom.ts` 424 / `game/const.ts` 379。200 行基準を大きく超える。
  `plan-editor.ts` は Δv 編集(キー/ボタン/ドラッグ/ラッチ)とノードギズモの配線が同居しており、
  分割の余地がある。
- **`halo.ts` の三次級数展開** — 振幅拘束は入れたが、位置・速度そのものは一次解のまま。
  厳密な周期解にするには三次の級数(a21..d32 の全係数)まで要る。ゲームの積分器が制限三体問題
  ではない以上どのみちドリフトするので、優先度は低い。
