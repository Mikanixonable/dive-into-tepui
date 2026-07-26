# リファクタリング調査レポート

対象: `eb208ed`（リファクタ前）〜 `dda9caa`（PR #1 `refactoring` マージ, 現HEAD）
調査日: 2026-07-26 / 実コードと git 履歴を読んだ事実のみを記載。

> 注: 本リポジトリには既に `DEVELOP/{README,OWNERSHIP,CALLSTACK,SPEC}.md`（実装の正典）と
> `refactoring_plan/*.md`（作業計画）がある。本書はそれらとは別に、
> 「何が起きたか」と「現在の責務分担」を外部から俯瞰した調査結果としてまとめたもの。

---

## 0. サマリ

- `src/` は **105 ファイル変更 / +9111 / −6448 行**、コミット約 173 個。
- 中身の総量はほぼ横ばいだが、**ファイル数が激増**（最大でも 490 行、大半は 200 行以下）。
  旧 `game.ts` 1,810 行 → 現 `game.ts` **387 行**。
- 二大テーマは **(A) 巨大クラスの解体** と **(B) `XxxCtx` スナップショット注入パターンの全廃**。
- 併せて **immutable データ構造化 + branded type による座標系の型分離** が導入された。

---

## 1. リファクタの内容

### 1.1 消えたファイルと分割先

旧 `src/game/` 直下のモノリシックなモジュール群は全廃され、機能ごとのディレクトリに再編された。

| 旧ファイル | 主な分割先 |
|---|---|
| `game/combat.ts` | `orbit-entity/{bullet,collision,hit}.ts`, `player/{player-fire,rcs-effects,thrust-effects}.ts`, `vfx/{effects-system,flash-effect-manager}.ts` |
| `game/environment.ts` | `physics/envaccel.ts`, `physics/ephemeris.ts`, `player/thermal.ts`, `render/environment-scene.ts` |
| `game/planner.ts` + `game/mapview.ts` | `plan/{plan,plan-editor,plan-guide,node-gizmo}.ts`, `predict/{predict-system,predict-panel,plan-trajectory,predicted-line}.ts`, `camera/overview-camera*.ts` |
| `game/markers.ts` | `marker/{grouped-markers,lead-markers,pip-overlay}.ts`, `player/player-markers.ts` |
| `game/hud.ts` | `hud/{hud,dom,panel,buttons,context-menu,result-screen,settings-panel,utils}.ts`, `marker/marker-manager.ts` |
| `game/stages.ts` | `stages/{stage,stage0,stage00,stage1,stage2,stage-dictionary,stage-select}.ts`, `stages/spawner/*`, `stages/stage-utils/*` |
| `game/entities.ts` | `orbit-entity/{entities,enemy,simulator}.ts`, `player/player.ts` |
| `game/belt.ts` | `player/{belt,belt-physics}.ts` |
| `game/camera.ts` | `camera/{camera-system,chase-camera,overview-camera,pip-camera,focus-markers,focus-gizmo,overview-camera-panel}.ts` |
| `game/input.ts` | `input/{input,key-mapping,touch}.ts` |
| `game/mapgizmo.ts` | `plan/node-gizmo.ts`（rename） |
| `game/audio.ts` / `game/bgm.ts` | `audio/sfx.ts` / `audio/bgm-tracks.ts`（rename） |
| `render/trajline.ts` | `predict/predicted-line.ts` + `render/sampled-line.ts` |

**新設された責務**（分割元を持たない新規クラス）:
`game/floating-origin.ts`, `game/sim-speed-manager.ts`, `game/targeter.ts`,
`game/unlock-manager.ts`, `game/map-mode-toggler.ts`, `game/pip-renderer.ts`,
`physics/{frame,intercept,projection}.ts`, `render/{billboard,glow-texture}.ts`, `perf-meter.ts`。

### 1.2 テーマ別の分類

**(a) 巨大クラスの解体**
`e48c02f`(Game.ts), `4efacba`(combat.ts), `4382608`(environment.ts), `a7ee6f3`(markerForGame),
`2c4bc7e`(マンモス HUD), `ed4c9a6`(stage-director), `e8dd4a0`(たらい回しの planSystem)。

**(b) Ctx 注入パターンの全廃** ← 今回最大の構造変更
旧設計では `CombatCtx`(21フィールド) / `MarkersCtx`(29) / `StageCtx`(13) / `PlannerCtx`(7) といった
可変スナップショット構造体を毎フレーム作って各システムに配り、参照経由で配列を書き換えていた。
計画文書 `refactoring_plan/STOP_USING_CTX.md`（`d4fa949`, 364行）を起点に段階的に撤去:
`78b1647`, `7fc487b`(SimulatorCtx), `3d64577`(StageCtx), `16141af`(TargeterCtx/CameraUpdateCtx),
`2839678`(combatCtx/checkLossCtx), `a486483`(hitCtx), `ed5920b`, `4887c13`, `cfb345b`, `e1d2c59`。
→ 現在はすべて **素の引数渡し + コンストラクタ注入** に置き換わり、`Ctx` 型は残っていない。

**(c) 責務境界の是正**
`96decc0`(Player/Enemy 分離), `904f3a5`(Player を 3 分割), `600f225`/`d354f1f`/`f923fe1`(エフェクト・
発砲・熱を Player 配下へ), `1f9a0d6`(カメラ責務分離), `813a8c6`(map-mode 抜本改築),
`59a6218`(データモデルと不一致だった map-toolbar 解体), `9472778`(syncMarkers 解体),
`60730c0`(OrbitLine 更新責務を game から下ろす), `1132bce`(PlanTrajectory の所有権を predict へ),
`0d0adaf`(physics/predict が plan を知らないよう依存方向を逆転)。

**(d) 型安全化・データ構造の是正**
`830841a`(OrbitState を immutable 化), `b7c9a27`(OrbitState に時刻を同梱),
`ecd2a94`(Vec3 の branded type 化 — THREE.Vector3 は原点補正後専用 / 独自 Vec3 は ECI 専用),
`c64fefb`+`8be012a`(frame モジュール新設・フラグを enum 化), `20ae385`(map-camera 型安全化),
`6c1345b`(スクリーン座標変換から THREE 依存と floatingOrigin 依存を排除)。

**(e) 依存方向・配置整理**
`810309d`/`8ae0170`(フォルダ整理), `bba6a8d`(依存関係整理),
`f7aa80a`(ephemeris と environmentScene の境界是正), `7d499e9`(simulator の雑な ephemeris キャッシュ廃止),
`7e5cd35`(マップカメラ座標計算から二値前提を排除)。

**(f) 設定・入力の一元化**
`27766cf`(キーコンフィグクラス新設 = `input/key-mapping.ts`), `f7240fe`(input の分散管理),
`69cc27f`(settings 管理を game の外へ)。

**(g) 命名**
`28ecb35`(`cameraSystem.mapMode` → `overviewMode`), `55ae336`(`K.mapMode` → `K.toggleMapMode`),
`1b4fed1`(`warp` → `sim-speed`), `ab6ac49`, `e0fb093`, `648bbc8`, `6b0c72c`, `fa96cee`。

### 1.3 運用面

- `refactoring_plan/refactor_instruction.md` に基準が明文化されている:
  **「モジュールは 200 行、関数は 100 行を基準」「悪いデータ構造 = 正データの分散・
  複数箇所の整合性維持が必要な状態」**。以降の分割判断はこの基準に紐づく。
- `DEVELOP/{OWNERSHIP,CALLSTACK,SPEC,README}.md` が実装の正典として新設され、
  `.claude/skills/{develop-docs,overview,refactor,refactor-fixed,verify}` が整備された。

---

## 2. 現在の構成と責務分担

### 2.1 レイヤ構造（依存は上から下への一方向）

```
main.ts                 … WebGPU 初期化・Hud/Sfx/SettingsPanel/UnlockManager 所有・rAF ループ
  └ game/game.ts (387)  … 全システムの生成・保持・呼び出し順序のみ
       ├ orbit-entity/  … シミュレーション本体（積分・当たり判定・衝突）
       ├ player/        … 自機の挙動（推進・射撃・ベルト・熱・エフェクト）
       ├ stages/        … ステージ定義・敵スポーン・勝敗
       ├ camera/ marker/ hud/ vfx/ predict/ plan/ input/
       └ physics/  render/  audio/     … 下位ライブラリ層
physics/*  … THREE / DOM 非依存の純関数・純データ（逆向き import なし）
```

### 2.2 モジュール別の責務

#### コア

| モジュール | 行 | 責務 |
|---|---|---|
| `main.ts` | 133 | WebGPU 初期化、ローディング、`Hud`/`Sfx`/`SettingsPanel`/`UnlockManager` の生成（Game より先に所有）、ステージ選択、rAF ループ（`update`→`sync`→`render`）、エラーオーバーレイ |
| `game/game.ts` | 387 | 全システムの生成・保持と**呼び出し順序の決定のみ**。物理・衝突・当たり判定は Simulator 系へ完全委譲。自前ロジックは pipActive 判定とポーズ/勝敗の early return 程度 |
| `game/floating-origin.ts` | 38 | ECI 絶対座標 → 描画座標（自機中心）への**唯一の変換窓口**。位置用 `RtoThreeV3` / 相対速度用 `VtoThreeV3` |
| `game/sim-speed-manager.ts` | 105 | 時間ワープ段階と `[N]` ノード自動ワープ。倍率に応じた「推進/射撃/衝突解決/敵AI発砲」可否を getter で公開 |
| `game/targeter.ts` | 220 | ターゲットロック/自動選択、標的板の弾道通過マーク、ターゲット軌道線・方向・AN/DN マーカー同期 |
| `game/map-mode-toggler.ts` | 87 | **マップモードの正本フラグ**を保持し、開閉時に `cameraSystem.overviewMode` / `editor.editMode` / `predict.forceCurrent` / `touchControls` を一斉同期 |
| `game/unlock-manager.ts` | 56 | ステージ解放状態の localStorage 永続化と解放トースト。`main.ts` が所有し参照共有 |
| `game/pip-renderer.ts` | 59 | PIP の 2 度目の描画パスと `PipOverlay` 所有 |

#### orbit-entity/（シミュレーション）

| モジュール | 行 | 責務 |
|---|---|---|
| `simulator.ts` | 206 | 全エンティティ配列の所有・上限管理・RK4 サブステップ積分・姿勢積分・寿命管理・sync。`HitSystem`/`CollisionPhysics` も所有 |
| `entities.ts` | 196 | `OrbitEntity` 基底（immutable `OrbitState` の差し替え管理・履歴・軌道要素メモ化）、`Ship`/`Ammo`/`DebrisPiece`/`BeltSection` |
| `enemy.ts` | 212 | 被弾・破壊・自然死判定、AI 行動（射程判定・バーストプラズマ・見越し照準） |
| `bullet.ts` | 57 | 通常弾/敵プラズマ弾の寿命と描画同期 |
| `collision.ts` | 88 | 剛体球接触解決（めり込み補正＋反発）。ベルト・薬莢と自機の特別扱い |
| `hit.ts` | 42 | 弾 vs 機体のセグメント対球判定（トンネリング防止） |

#### player/

`player.ts`(279) が `PlayerThrottle`(167) / `PlayerFire`(319) / `Belt`(93) + `BeltPhysics`(307) /
`ThermalSystem`(107) / `ThrustEffects`(33) / `RcsEffects`(55) / `PlayerMarkers`(54) を束ね、
`behave` で移動・射撃・入力処理を委譲、被弾・喪失判定・`syncPlayer` を持つ。
`belt-physics.ts`（THREE 非依存の算術）と `belt.ts`（メッシュ反映）の分離が、
player 配下のエフェクト系にも共通する「ロジックと描画を分ける」型になっている。

#### stages/

- `stage.ts`(193) 抽象基底 — 撃破数勝利判定、`setup()` 一度きり注入、`ScoreCounter`/`Logistics`/`StageStatusPanel` 所有。
- `stage-dictionary.ts`(59) — `STAGE_CLASSES` 列挙、選択画面用の読み取り専用インスタンス `STAGE_DEFINITIONS`、`initStage()`。
- `stage0`(55, 訓練/タイムアタック) / `stage00`(83, 無限サバイバル) / `stage1`(51) / `stage2`(56, 解放条件 override)。
- `spawner/enemy-generator.ts`(105) 個体生成関数群 ／ `spawner/enemy-spawner.ts`(154) 集団配置計算。
- `stage-utils/` — `logistics`(110, 補給), `wave-manager`(132, Stage00 専用の 3 フェーズ遷移),
  `score-counter`(17), `score-attack-timer`(19), `stage-status-panel`(53)。

> **ステージ追加時に触るファイル**: ① `stages/stageN.ts` を新規作成（`Stage` 継承）
> ② `stage.ts` の `StageId` ユニオンに ID 追加 ③ `stage-dictionary.ts` の `STAGE_CLASSES` に登録
> ④ 必要なら `spawner/*` に生成関数、`const.ts` にチューニング定数を追加。

#### predict/ と plan/ — 4 分割された「軌道計画」

| 役割 | モジュール | 内容 |
|---|---|---|
| **正データ** | `plan/plan.ts`(86) | アンカー + ノード列の純データと編集操作。予測計算・キャッシュは一切持たない |
| **編集** | `plan/plan-editor.ts`(457) | クリック配置・時刻ドラッグ・Δv アームドラッグ・右クリックメニュー・選択状態。画面判定は `PlanTrajectory` へ委譲 |
| **未来表示** | `predict/predict-system.ts`(161) | 表示期間・表示座標系・未来ゴースト・`PredictPanel` 所有、そして **`PlanTrajectory` の所有と駆動** |
| **実施** | `plan/plan-guide.ts`(101) | 直近ノードの噴射ガイド・達成判定・ノード消化。**predict に一切依存せず**凍結ノードの絶対状態を直接読む |

軌道ライン描画の責務連鎖:
`PlanTrajectory`(171, arc 分解と複数 B-1 のライフサイクル) → `PredictedLine`(89, 1 arc の予測計算 + キャッシュ)
→ `SampledLine`(89, 汎用折れ線 / bake=形状・un-bake=毎フレーム剛体回転) → `THREE.Line`。
`OrbitLine`(144, 解析楕円専用) はこの連鎖には加わらず別系統として並立する。

#### camera/

`CameraSystem`(159) が `ChaseCamera`(159) / `OverviewCamera`(192) / `PipCamera`(72, 常設) を保持し、
`overviewMode` で `activeCamera` を切り替える。`overviewMode` は**正本ではなく `MapModeToggler.mapMode` の反映先**
（同様に `PlanEditor.editMode` も反映先）。フォーカス候補は `FocusMarkers`(71) が算出、
選択 UI は `FocusGizmo`(33) / `OverviewCameraPanel`(57)。`ProjectFn` 型の定義元も `camera-system.ts`。

#### marker/

`MarkerManager`(191) は**表示機構のみ**（DOM 生成・投影・ラベル衝突回避の SVG 引き出し線）。
「何をどこに出すか」は各所有者が決める:
`GroupedMarkers`(116, 近接クラスタ化と画面外方位マーカー化の汎用ロジック) /
`LeadMarkers`(66, 自機と敵の双方に依存するため独立) / `PipOverlay`(57, PIP 矩形内座標専用) /
`PlayerMarkers`(player/) / `FocusMarkers`(camera/)。

#### hud/

`hud.ts` は 71 行のシェルに縮小（トースト・ヒント・ヘルプ、`root`/`svgOverlay`/`panels` の公開のみ）。
構築は `dom.ts`(368, 静的 DOM と STYLE)、内容同期は `panel.ts`(242)。
`settings-panel.ts`(73) / `context-menu.ts`(92) / `result-screen.ts`(47) / `buttons.ts`(42) / `utils.ts`(31) は独立。
計画・予測・広範囲視点・ステージ状況の各パネルは **それぞれ `PlanEditor` / `PredictSystem` /
`CameraSystem` / `Stage` が自分で root へ構築**し、CSS だけ `dom.ts` の STYLE に一元管理する方式。
`SettingsPanel` は `main.ts` が生成して `Game` にコンストラクタ注入（`main.ts:91`, `game.ts:114`）。
BGM ON/OFF の永続化自体は `audio/sfx.ts` が `localStorage: tepui.settings.bgm` で持つ。

#### input/

`key-mapping.ts`(98) の `KEY_MAPPING` が**キーコードと表示名の唯一の定義元**
（ヘルプ表・操作バー・タッチパッド・マーカーラベルがすべてここだけを参照）。
`Input`(282) は生キーコードを内部に閉じ込め、外部には `KeyBinding` 単位の API
（`down` / `takeKey` / `takeKeys` / `takeClicks` / `takeRightClicks`）を出す。
消費は**先着順モデル** — ハンドラが true を返した要素だけをキューから除くので、呼び出し順序＝優先順位。
`TouchControls`(242) は `input.setVirtualKey` で物理キーと同じ経路に合流する。

#### physics/（全て THREE / DOM 非依存の純関数・純データ）

`orbital.ts`(200) immutable `OrbitState` と RK4 / J2 / 第三体 / ケプラー変換 ・
`envaccel.ts`(33) 抗力+J2+日月の**唯一の合成定義**（本体と predict が共有、predict 側は `bcInv=0` で抗力を意図的に無効化）・
`atmosphere.ts`(48) ・ `attitude.ts`(183) ・ `ephemeris.ts`(203) ・ `frame.ts`(119) 慣性系⇄回転系変換 ・
`predict.ts`(136) 単一 arc の自由伝播（ノード分割は知らない）・ `projection.ts`(42) ピンホール投影 ・
`intercept.ts`(40) 見越し点解 ・ `vec3.ts`(89)。

#### render/ ・ audio/ ・ vfx/

`environment-scene.ts`(194) 太陽/月/星/地球/環境光/参照線の構築と同期 ・
`earth.ts`(261) 実写テクスチャ + TSL ノードシェーダによる大気・リム光・雲の影・オーロラ ・
`ships.ts`(490) ・ `stars.ts`(63) ・ `sampled-line.ts` / `orbitline.ts` ・ `billboard.ts` / `glow-texture.ts` / `scene.ts`。
`vfx/effects-system.ts`(127) がフラッシュ・破片生成の一元窓口、`flash-effect-manager.ts`(59) が寿命管理。
`audio/sfx.ts`(463) + `bgm-tracks.ts`(100, 5 トラックの作曲データ定義のみ)。

### 2.3 実行フロー（呼び出し順）

```
main.ts animate(now)
├ game.update(dt)
│   ├ input.update()
│   ├ handleInput()   // settingsPanel → hud → activeStage → simSpeedManager → mapModeToggler → editor
│   ├ (!activeStage.isPlaying → 簡略積分して return) / (isPaused → return)
│   ├ player.behave({...})            // HP 回復・移動・射撃試行
│   ├ activeStage.update(...)         // 敵 AI・スポーン・勝敗判定
│   ├ simSpeedManager.update(simTime)
│   ├ simulator.stepSimulation(...)
│   │     ├ simulationSubStep × nSub  // RK4 積分（envAccel）+ hitSystem.checkBulletHits
│   │     ├ collisionPhysics.resolve(...)   // 低ワープ時のみ
│   │     └ stepAttitudes(...)
│   ├ targeter.markBoardCrossings / player.checkLoss / simulator.cleanup
│   ├ cameraSystem.update(...) / editor.plan.trackAnchor(...)
│   └ editMode ? マップ入力 : targeter.updateCombatTargeting
├ game.sync(min(dt,0.1))
│   ├ floatingOrigin = new FloatingOrigin(player.state.r, player.state.v)   ← 毎フレーム再生成
│   ├ predict.resolveDisplayTime → cameraSystem.sync → environment.sync
│   ├ player.syncPlayer → simulator.sync → effects.sync → targeter.sync
│   ├ enemyMarkers / leadMarkers / pipRenderer / predict / editor / touch / stage の各 sync
│   ├ hud.panels.update(this, dt) / hud.tick() / guide.update(...)
│   └ markerManager.resolveCollisions()      ← 必ず最後
└ game.render()  … renderer.render(scene, cameraSystem.activeCamera) → pipRenderer.renderPip()
```

---

## 3. 現在のコーディング規約（コードから読み取れる暗黙ルール）

1. **Ctx スナップショットは使わない。** 必要な値（`player` / `simulator` / `floatingOrigin` / `project` など）を
   毎フレーム明示的な引数として渡す。インフラ（`Hud`/`Sfx`/`MarkerManager`/`Scene`/`Ephemeris`）は
   コンストラクタ注入で `private readonly` 保持。
2. **DOM/UI 部品は上位へコールバックで通知する**（`onSettingsOpenChange` / `onSelect` / `onMenuFocus` …）。
   配線は上位クラスのコンストラクタで行う。
3. **`physics/*` は THREE / DOM に依存しない純関数**。逆向きの import は存在しない。
4. **immutable + セッターで整合性を保証。** `OrbitState`・`Vec3` は readonly、
   `OrbitEntity.state` セッターが履歴 push と軌道要素メモ破棄を自動で行うので、
   積分器は `entity.state = stepOrbitRK4(...)` と代入するだけでよい。
5. **branded type で座標系の取り違えを型で禁止。** `frame.ts` の `RelativeVec3` / `RelativeOrbitState` は
   慣性系の型と構造的に似ているが非互換で、明示変換なしに混在できない。
   同様に THREE.Vector3 = 原点補正後 / 独自 Vec3 = ECI という区別を型で表現する。
6. **描画座標は必ず `FloatingOrigin` 経由。** `player.state.r` を直接原点として参照しない。
7. **正本（source of truth）は 1 箇所。** マップモードは `MapModeToggler`、
   キー割当は `KEY_MAPPING`、色は `theme.ts`、力の合成は `envaccel.ts`、
   `PlanTrajectory` の所有者は `PredictSystem`。他はすべて反映先。
8. **算術と描画反映を別モジュールに割る**（`belt-physics` / `belt`、`predicted-line` / `sampled-line`）。
9. 目安として **モジュール 200 行 / 関数 100 行**。

### 既知の例外
- `hud/panel.ts` だけが `Game` 型を直接 import する（ファイル内コメントで唯一の例外と明記）。
- `Stage.setup()` / `WaveManager.setup()` は一度きりの後付け注入。
  モジュール読み込み時に `new` される静的インスタンスがあるためコンストラクタ注入できない、と明記されている。

---

## 4. `CLAUDE.md` との乖離（要更新）

現行の `CLAUDE.md` はリファクタ前の記述のままで、以下がすべて実態と食い違う。

- **消えたファイルを前提にした説明**: `game/belt.ts`, `combat.ts`, `stages.ts`, `environment.ts`,
  `markers.ts`, `planner.ts`, `mapview.ts`, `hud.ts`, `input.ts`, `camera.ts`, `entities.ts` の解説が丸ごと該当。
- **`Ctx-injection パターン` の記述**（`CombatCtx` / `StageCtx` / `MarkersCtx` / `PlannerCtx`）は全廃済み。
  現在の規約はむしろ「Ctx を使わない」。
- **`game.ts` は 1,810 行** → 実際は 387 行。
- **描画方式**: 地球の「頂点色に焼き込んだ雲」「fBm の実行時頂点色計算」「`ships.ts` のプリミティブ直接組み立て」は、
  現在 `tools/export-earth-texture.mjs` / `tools/export-models.mjs` によるビルド前焼き込み
  （実行時は実写テクスチャと `src/assets/models/*.json` を読むだけ）に置き換わっている。
  `earth.ts` は TSL ノードシェーダによる解析的な大気表現になっている。
- **`navball.ts` / `mapgizmo.ts` / `render/trajline.ts`** は存在しない（後者 2 つはリネーム/分割済み）。
- `dev.md` が人間専用である点、`npm run test:physics` の運用は現在も有効。

更新の際は `DEVELOP/OWNERSHIP.md` / `DEVELOP/CALLSTACK.md` が正典なので、
`CLAUDE.md` はそちらへのポインタと最小限の要約に留めるのが整合的。
