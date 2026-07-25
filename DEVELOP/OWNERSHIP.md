# OWNERSHIP — クラス/モジュール間の保持関係と状態の正本

「どのクラスが何を所有しているか」= **正本(source of truth)の所在**を一覧する文書。
責務の置き場所を検討するときの一次情報として使う。

## 読み方 / 扱う範囲

- 扱うのは **正本だけ**。キャッシュ・メモ化・導出値・参照共有(hud/sfx/scene など)は所有関係として
  数えない。混同しやすいものだけ末尾の付録に「正本でないもの」として列挙する。
- インスタンス保持木は「`new` した側が所有者」。コンストラクタ/フィールド初期化子で他所から
  受け取っているだけのものは所有ではなく **参照共有** として別項に分ける。
- 状態表の「正本」は、**その値を書き換えてよい唯一のクラス**を指す。他所は読み取り専用で参照する。

## 更新義務

`src/` を変更したらこの文書も同じ変更セットで更新する(`.claude/skills/develop-docs/SKILL.md`)。
特にクラスの新設・削除・フィールドの移動を行ったときは必ず反映する。

---

## 1. インスタンス保持木

```
main.ts
├── GameScene            (createGameScene: canvas / THREE.Scene / WebGPURenderer)
├── PerfMeter            (?perf=1 の DOM 表示。Game を PerfCountSource として参照するだけ)
└── Game
    ├── FloatingOrigin       ... sync ごとに作り直す使い捨て
    ├── Input
    ├── TouchControls?       ... タッチデバイスのみ
    ├── Hud
    │   └── HudPanels        (buildHudDom が作った要素索引を共有)
    ├── Sfx
    ├── MapToolbar           ... DOM は Hud.root 配下、所有は Game
    ├── SettingsPanel        ... 同上
    ├── MarkerManager        ... DOM の親は Hud.root / Hud.svgOverlay、所有は Game
    ├── Ephemeris            ... 状態を持たない純サンプラ。各所へ参照共有する単一インスタンス
    ├── CameraSystem
    │   ├── ChaseCamera
    │   ├── MapCamera
    │   ├── PipCamera
    │   ├── MapMarkers
    │   └── FocusGizmo
    │       └── ContextMenu
    ├── Player               (extends Ship / OrbitEntity)
    │   ├── PlayerThrottle
    │   ├── PlayerFire
    │   ├── Belt
    │   │   └── BeltPhysics
    │   │       └── BeltSection[]      ... 剛体接触用プロキシ
    │   ├── ThermalSystem
    │   ├── ThrustEffects → Billboard ×2
    │   ├── RcsEffects    → Billboard ×4
    │   └── OrbitLine                  ... 自機軌道線
    ├── SimSpeedManager
    ├── PlanEditor
    │   ├── Plan                       ... ノード列 + アンカー(計画の正本)
    │   ├── PlanTrajectory
    │   │   └── PredictedLine[]        ... arc ごと。各々 SampledLine を持つ
    │   ├── NodeGizmo
    │   │   └── ContextMenu
    │   └── 計画パネル DOM
    ├── PredictSystem
    ├── PlanGuide
    │   └── OrbitLine                  ... 計画軌道ライン(白)
    ├── MapModeToggler                 ... 状態を持たない(所有物なし)
    ├── Stage (activeStage)            ... initStage() が毎回 new する
    │   ├── ScoreCounter
    │   ├── Logistics
    │   ├── ScoreAttackTimer           ... Stage0 のみ
    │   └── WaveManager                ... Stage00 のみ
    ├── EnvironmentScene
    │   ├── Earth / Sun / DirectionalLight / AmbientLight / stars / moon メッシュ
    │   └── OrbitLine ×2               ... geoLine / moonLine(マップ参照線)
    ├── UnlockManager
    ├── HitSystem
    ├── MarkerForGame
    ├── CollisionPhysics
    ├── EffectsSystem
    │   └── FlashEffectManager
    │       └── FlashEffect[]          ... 各々 Billboard を持つ
    ├── Targeter
    │   └── OrbitLine                  ... ターゲット軌道線(オレンジ)
    ├── Simulator
    │   ├── Enemy[]                    ... 各々 OrbitLine を持つ
    │   ├── Bullet[]
    │   ├── DebrisPiece[] (casings)
    │   ├── DebrisPiece[] (debris)
    │   └── Ammo[]
    └── PipRenderer                    ... PIP クロスヘア DOM
```

木に現れないインスタンス:

- `STAGE_DEFINITIONS`(stage-dictionary.ts のモジュールスコープ)… 選択画面のラベル・解放条件を読む
  ためだけの `Stage` インスタンス列。`setup()`/`init()` は呼ばれず、プレイに使う `activeStage` とは別物。
- `stage-select.ts` の `UnlockManager` … 選択画面用に別途 `new` される。正本は localStorage なので
  Game 側のインスタンスと状態を共有する必要がない。

---

## 2. 参照共有(所有ではない)

複数箇所から使われるため、所有者から参照だけを配って回っているもの。**所有権は移らない。**

| 対象 | 所有者 | 参照する側 |
| --- | --- | --- |
| `THREE.Scene` / `WebGPURenderer` | `GameScene`(main.ts) | Game・各描画物を持つクラス |
| `Hud` / `Sfx` | Game | ほぼ全サブシステム(hud/sfx は必ず対で注入する方針) |
| `MarkerManager` | Game | MarkerForGame・Targeter・PlanGuide・PredictSystem・MapMarkers |
| `Ephemeris` | Game | EnvironmentScene・Simulator・MapCamera・PlanEditor・PlanTrajectory |
| `MapToolbar` | Game | CameraSystem(視点側の配線)・PredictSystem(表示期間側の配線) |
| `SimSpeedManager` | Game | PlanEditor(ノードメニューからの自動ワープ) |
| `EffectsSystem` | Game | Player・PlayerFire・Enemy・Stage |
| `Simulator.ammos` | Simulator | Logistics(読み取り + `addAmmo` 経由の追加のみ) |
| `Player` / `Simulator` / `Stage` | Game | 毎フレームの引数として相互に渡される |

---

## 3. 状態の正本

| 状態 | 正本の所有者 | 備考 |
| --- | --- | --- |
| 自機の位置・速度 (ECI) | `Player.state` | 書き換えるのは RK4 積分(Simulator)・反動(PlayerFire)・接触(CollisionPhysics) |
| 自機の姿勢・角速度 | `Player.att` | 積分は Simulator.stepAttitudes に一元化 |
| 機体座標系トルク | `Player.torque` | 毎フレーム PlayerThrottle の戻り値で上書きされる |
| 推力加速度関数 | `Player.thrustFn` | 同上。無推力なら null |
| HP / 生存 | `Ship.hp` / `OrbitEntity.alive` | 死亡は `alive = false` のみ。除去は Simulator.cleanup |
| RCS 制動・スロットル段・ホールド | `PlayerThrottle` | |
| 姿勢微調整モード | `Player.fineAttitude` | |
| 残弾・マガジン・バレル・装填タイマー | `PlayerFire` | |
| ベルトのたわみ(節点位置・ツイスト) | `BeltPhysics` | 表示用リンク変換は Belt が毎フレーム導出 |
| 外殻温度・動圧・高度警告 | `ThermalSystem` | 破壊判定そのものは `Player.checkLoss` |
| エンティティ配列(敵/弾/薬莢/デブリ/補給) | `Simulator` | 追加は `addXxx` 経由。上限管理もここ |
| シミュレーション時刻 / 前フレームの simDt | `Simulator.simTime` / `.lastSimDt` | |
| ワープ段・自動ワープ目標時刻 | `SimSpeedManager` | 閾値判定(canPlayerFire 等)もここの getter が唯一 |
| マニューバ計画(ノード列・アンカー) | `Plan` | 所有は PlanEditor。ノードは Δv ではなく実行後状態を持つ |
| 選択中ノード・計画編集モード | `PlanEditor.selectedNodeIdx` / `.editMode` | |
| 予測表示期間・未来ゴーストスライダー | `PredictSystem` | |
| マップ視点(注視点相対オフセット・パン)・表示座標系・フォーカス | `MapCamera` | 予測折れ線の座標系もこれを読む |
| 戦闘視点(yaw/pitch/dist・姿勢追従フラグ) | `ChaseCamera` | |
| マップモード表示・照準ズーム | `CameraSystem.mapMode` / `.zoomActive` | |
| PIP 矩形 | `PipCamera.rect` | |
| ターゲットロック・自動ターゲット・的通過マーク | `Targeter` | |
| 勝敗フェーズ | `Stage`(private `_phase`) | 変更は Stage 自身のみ。外部は `phase`/`isPlaying` を読む |
| 発射数・命中数・撃破数・出撃数 | `ScoreCounter` | 所有は Stage |
| 補給の投入間隔タイマー | `Logistics` | |
| ウェーブフェーズ・波数 | `WaveManager`(Stage00) | |
| 残り時間 | `ScoreAttackTimer`(Stage0) | |
| ステージクリア回数 | **localStorage**(`tepui.clearCounts`) | UnlockManager はその読み書き窓口。インスタンスは正本ではない |
| ポーズ | `Game.paused` | 唯一の駆動源は `SettingsPanel.onSettingsOpenChange` |
| 一時エフェクト(フラッシュ)の配列 | `FlashEffectManager.effects` | |
| 地球自転の初期位相 | `EnvironmentScene.earthPhase0` | |
| 太陽・月の初期位相 | `Ephemeris` | それ以外の状態は持たない(時刻を引数に取る純サンプラ) |
| 入力スナップショット(押下キー・クリック・マウス移動量) | `Input` | フレーム確定は `update()` の1回だけ |
| 敵 AI の実行時状態(最終発砲時刻・バースト残数・最終ロック時刻) | `Enemy` | |

### 正本が分かれていることに意味がある組み合わせ

- **`CameraSystem.mapMode`(視点)と `PlanEditor.editMode`(操作系)** は別の正本。同時に切り替えるのは
  `MapModeToggler` だけで、描画・視点側は mapMode を、入力・挙動側は editMode を見る。
- **`FloatingOrigin.r` と `Player.state.r`** は現状同じ値だが意味論的に別物。sync 系は必ず fo を参照し、
  `player.state.r` を描画原点として直接使わない。
- **`MapCamera.cameraFrame`** は表示座標系の唯一の正本。PredictSystem/PlanTrajectory は読むだけ。

---

## 付録: 正本でないもの(混同しやすいもの)

所有関係として数えないが、正本と間違えやすいもの。**これらを書き換えてもゲーム状態は変わらない**
(逆に、正本を変えたときに無効化が必要になる)。

| 対象 | 正体 | 無効化の契機 |
| --- | --- | --- |
| `OrbitEntity.elements` | `state` からの軌道要素のメモ化 | `clearMemo()` |
| `OrbitLine.snap` / 頂点配列 | 楕円ジオメトリの再生成判定用スナップショット | 要素ドリフト・`force`・初回 |
| `PredictedLine.samples` / `.key` | 予測 RK4 の結果と入力スナップショット | 入力変化 + スロットル、`force` |
| `PlanTrajectory.arcs` / `.frame` / `.unbakeTime` | 毎フレーム再構築される表示文脈 | `update()` 毎 |
| `SampledLine.lastSamples` / `.lastFrame` | bake 済み頂点の入力スナップショット | 点列 or frame の変化 |
| `PlanEditor.nodeArrivings()` / `nodeDv()` | ノード到達状態と Δv の導出値(表示専用) | 呼ぶたび再計算 |
| `PlayerThrottle.thrustVizDir` / `.thrustAccelVec` | 推力の表示・ベルト物理向け派生値 | 毎フレーム上書き |
| `Player` の各 getter(`rcsDamp` / `magsLeft` 等) | throttle/fire への転送 | — |
| `MapMarkers.labels[].pos` | 天体暦から毎フレーム再計算 | `syncLabels()` 毎 |

### 既知の不整合

- `OrbitEntity.clearMemo()` が **どこからも呼ばれていない**(`src/` 全体で定義箇所のみ)。
  `elements` は初回アクセス時の値をインスタンス寿命の間ずっと返すため、自機・敵の軌道要素表示や
  軌道線・AN/DN マーカーは初回フレームの値で固定される。積分後に無効化する呼び出しが必要
  (`Simulator.stepSimulation` の末尾が自然な位置)。
