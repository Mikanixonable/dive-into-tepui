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
├── UnlockManager
├── Hud                  ... initHud() でタイトル(ステージ選択)画面より前に生成、Game へ参照を渡す
│   └── HudPanels        (buildHudDom が作った要素索引を共有)
├── Sfx                  ... 同上
├── SettingsPanel        ... 同上。DOM は Hud.root 配下。onSettingsOpenChange を Game.pause()/resume() へ配線
├── PerfMeter            (?perf=1 の DOM 表示。Game を PerfCountSource として参照するだけ)
├── GameScene            (createGameScene: canvas / THREE.Scene / WebGPURenderer)
└── Game
    ├── FloatingOrigin       ... sync ごとに作り直す使い捨て
    ├── Input
    ├── TouchControls?       ... タッチデバイスのみ
    ├── MarkerManager        ... DOM の親は Hud.root / Hud.svgOverlay、所有は Game
    ├── Ephemeris            ... 状態を持たない純サンプラ。各所へ参照共有する単一インスタンス
    ├── CameraSystem
    │   ├── CombatCameraSystem
    │   │   ├── ChaseCamera
    │   │   └── GunsightCamera
    │   ├── OverviewCamera
    │   ├── FocusMarkers
    │   ├── OverviewCameraPanel        ... DOM は Hud.root 配下。注視/視点座標系/視点リセット
    │   └── FocusGizmo
    │       └── ContextMenu
    ├── GroupedMarkers (enemyMarkers)  ... 画面上で近接する敵マーカーのまとめ + 画面外方位マーカー
    ├── LeadMarkers                    ... 敵ごとの LEAD マーカーと最終ロック時刻
    ├── Player               (extends Ship / GameEntity)
    │   ├── PlayerThrottle
    │   ├── PlayerFire
    │   ├── Belt
    │   │   └── BeltPhysics
    │   │       └── BeltSection[]      ... 剛体接触用プロキシ
    │   ├── ThermalSystem
    │   ├── RadiatorSystem             ... 放熱板2枚の展開度・健全度。ヒンジ Group は Player.obj 配下を名前で参照
    │   ├── ThrustEffects → Billboard ×2
    │   ├── RcsEffects    → Billboard ×4
    │   ├── PlayerMarkers              ... 方向マーカー・ボアサイト・マップ上の自機位置
    │   └── OrbitLine                  ... 自機軌道線
    ├── SimSpeedManager
    ├── DisplayTimeManager             ... 「いつを見るか」(表示期間・未来ゴーストスライダー)
    │   └── DisplayTimePanel           ... DOM は Hud.root 配下。期間/未来位置スライダー
    ├── PlanEditor
    │   ├── Plan                       ... ノード列 + アンカー(計画の正本)
    │   ├── PlanDisplay                ... 計画の未来表示(「見えるとき何を見せるか」)
    │   │   ├── PlanTrajectory         ... 予測折れ線 + per-arc キャッシュ + 画面判定
    │   │   │   └── PlanArc[]          ... arc ごと。各々 OrbitEntity 1本(積分の正本)+ SampledLine を持つ
    │   │   └── TRAJECTORY パネル DOM   ... 表示座標系(frame)の SegmentedControl 1 個のみ
    │   ├── NodeGizmo
    │   │   └── ContextMenu
    │   └── 計画パネル DOM
    ├── PlanGuide
    ├── MapModeToggler                 ... 所有物なし(マップ開閉フラグ mapMode だけを持つ)
    ├── Stage (activeStage)            ... initStage() が毎回 new する
    │   ├── ScoreCounter
    │   ├── Logistics                  ... 補給の投入判断と ▣ AMMO マーカー
    │   ├── StageStatusPanel           ... DOM は Hud.root 配下。HP/補助メッセージ/撃墜数
    │   └── ScoreAttackTimer           ... Stage0 のみ(Stage00 の波状攻撃フェーズ・波数は Stage00 自身のフィールド)
    ├── EnvironmentScene
    │   ├── Earth / Sun / DirectionalLight / AmbientLight / stars / moon メッシュ
    │   └── OrbitLine ×2               ... geoLine / moonLine(マップ参照線)
    ├── EffectsSystem
    │   └── FlashEffectManager
    │       └── FlashEffect[]          ... 各々 Billboard を持つ
    ├── Targeter
    │   └── OrbitLine                  ... ターゲット軌道線(オレンジ)
    ├── EntityManager                  ... エンティティ配列の保持のみ。simTime は持たない
    │   ├── Enemy[]                    ... 各々 OrbitLine を持つ
    │   ├── Bullet[]
    │   ├── DebrisPiece[] (casings)
    │   ├── DebrisPiece[] (debris)
    │   └── Ammo[]
    ├── Simulator                      ... 実シミュレーション。EntityManager の参照を受け取って回すだけ(所有しない)
    │   ├── HitSystem
    │   └── CollisionPhysics
    └── Predictor                      ... 予測列の駆動。EntityManager の参照を受け取って回すだけ(所有しない)。
                                            状態はラウンドロビンのカーソルのみ
```

木に現れないインスタンス:

- 全ての `GameEntity`(Player・Enemy[]・Bullet[]・DebrisPiece[]・Ammo[]・BeltSection[] — 木の
  どのノードも例外なく)は `physics/orbit-entity.ts` の `OrbitEntity` を1本、フィールド名
  `current` で保持する(state/history/prevState/elements の正本)。GameEntity ごとに繰り返さず
  ここに一括で記す。`predictDuration > 0` の GameEntity(Ship・Ammo のみ)は、`Predictor` が
  `stepPrediction` を呼んだ時点で2本目の `OrbitEntity` を `predicted` として追加で持つ
  (§付録「正本でないもの」参照 — 未来位置のキャッシュであり、正データではない)。
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
| `Hud` / `Sfx` | main.ts | Game(コンストラクタ引数で受け取り)経由でほぼ全サブシステム(hud/sfx は必ず対で注入する方針) |
| `SettingsPanel` | main.ts | Game(`[Esc]` で `toggle()` を呼ぶだけ。開閉の一時停止反映は main.ts 側の配線) |
| `MarkerManager` | Game | マーカーを出す全モジュール(GroupedMarkers・LeadMarkers・PlayerMarkers・Targeter・Logistics・FocusMarkers・PlanGuide・PlanDisplay) |
| `Ephemeris` | Game | EnvironmentScene・Simulator・OverviewCamera・FocusMarkers・PlanEditor(→PlanDisplay) |
| `EntityManager` | Game | Simulator(コンストラクタ引数、配列を直接持たず参照だけ回す)・HitSystem・CollisionPhysics・Targeter・Enemy.behave・Stage/stages/・Logistics・EffectsSystem・NanWatchdog(いずれも読み取り + `addXxx` 経由の追加のみ) |
| `PlanTrajectory` | PlanDisplay | PlanEditor(ノードの画面判定 `projectPoint` / `nearestSample` のみ、`planDisplay.traj` 経由) |
| `Plan` | PlanEditor | PlanDisplay(`sync` の引数で毎フレーム)・PlanGuide(同)|
| `SimSpeedManager` | Game | PlanEditor(ノードメニューからの自動ワープ) |
| `EffectsSystem` | Game | Player・PlayerFire・Enemy・Stage |
| `Player` / `Simulator` / `EntityManager` / `Stage` | Game | 毎フレームの引数として相互に渡される |
| `UnlockManager` | main.ts | ステージセレクト画面と、各Stage（クリア後画面判定のため） |
| `DisplayTimeManager.onDurationChange`(コールバック) | Game が配線 | `editor.planDisplay.traj.invalidate()` を呼ぶ。所有者が違う(DisplayTimeManager は Game 直属、PlanDisplay は PlanEditor 所有)ため Game が繋ぐ唯一の場所 |

---

## 3. 状態の正本

| 状態 | 正本の所有者 | 備考 |
| --- | --- | --- |
| 自機の位置・速度・エポック (ECI) | `Player.state` | 書き換えるのは RK4 積分(Simulator)・反動(PlayerFire)・接触(CollisionPhysics) |
| エンティティの過去 state 列(`StateQueue`) | `GameEntity.history`(→ `current.history`) | 記録するのは `OrbitEntity.step` だけ。時間窓は `historyDuration`(既定 0、Ship のみ `SHIP_HISTORY_DURATION`)、間引き間隔は `sampleInterval()`(軌道周期ベース)で `cleanup` に渡す |
| 自機の姿勢・角速度 | `Player.att` | 積分は Simulator.stepAttitudes に一元化 |
| 機体座標系トルク | `Player.torque` | 毎フレーム PlayerThrottle の戻り値で上書きされる |
| 推力加速度 | `GameEntity.thrust` | 自機は `PlayerThrottle.updateThrustState` の戻り値で毎フレーム上書き。無推力なら null |
| HP / 生存 | `Ship.hp` / `GameEntity.alive` | 死亡は `alive = false` のみ。除去は EntityManager.cleanup |
| RCS 制動・スロットル段・ホールド | `PlayerThrottle` | |
| 姿勢微調整モード | `Player.fineAttitude` | |
| 残弾・マガジン・バレル・装填タイマー | `PlayerFire` | |
| ベルトのたわみ(節点位置・ツイスト) | `BeltPhysics` | 表示用リンク変換は Belt が毎フレーム導出 |
| 外殻温度・動圧・高度警告 | `ThermalSystem` | 破壊判定そのものは `Player.checkLoss` |
| 放熱板の展開度・健全度 | `RadiatorSystem` | 温度は持たない。放熱面積と太陽入射を `ThermalSystem.setRadiatorLoad` へ渡すのは `Player` |
| エンティティ配列(敵/弾/薬莢/デブリ/補給) | `EntityManager` | 追加は `addXxx` 経由。上限管理もここ。`Simulator` は参照を受け取って回すだけで配列を持たない |
| シミュレーション時刻 / 前フレームの simDt | `Simulator.simTime` / `.lastSimDt` | |
| 予測ラウンドロビンのカーソル | `Predictor.cursor` | 唯一の状態。`EntityManager.all()` のインデックスとして毎フレーム進む |
| ワープ段・自動ワープ目標時刻 | `SimSpeedManager` | 閾値判定(canPlayerFire 等)もここの getter が唯一 |
| NaN 検出済みフラグ | `NanWatchdog`(Game 所有) | 一度検出したら以後の検査を止める |
| マニューバ計画(ノード列・アンカー) | `Plan` | 所有は PlanEditor。ノード・アンカーとも 1 個の `OrbitState`(実行時刻 = `t`、Δv は導出値)。各ノードに 1 対 1 の内部 ID を発行する(`nodeIdAt`/`indexOfNodeId`) |
| 選択中ノード・計画編集モード | `PlanEditor.selectedNodeId` / `.editMode` | 選択は index ではなく Plan 発行の ID で持つ(`consumeFirstNode` 等で配列が動いてもずれない)。`selectedNodeIdx` は ID から都度解決する index ビュー |
| 予測表示期間・未来ゴーストスライダー・未来表示の禁止(forceCurrent) | `DisplayTimeManager` | |
| 予測折れ線を描く表示座標系(trajectoryFrame) | `PlanDisplay` | `OverviewCamera.cameraFrame`(視点固定座標系)とは別の正本 |
| マップ視点(注視点相対オフセット・パン)・表示座標系・フォーカス・ViewFrame | `OverviewCamera` | `view: ViewFrame` は `CombatCameraSystem` と同じ形。`CameraSystem` はこの `view` を読むだけで自分では持たない |
| 戦闘視点(ViewFrame: position/lookTarget/up/fovDeg/aspect)・照準ズーム中か(zoomActive) | `CombatCameraSystem` | rot(クオータニオン)/dist・姿勢追従フラグ(camFollowAttitude)は内部の `ChaseCamera` が持つ。zoomActive はこのクラス自身の `update` が `Input` から読んで保持する |
| マップモードの開閉 | `MapModeToggler.mapMode` | 影響先(`CameraSystem.overviewMode` / `PlanEditor.editMode` / `DisplayTimeManager.forceCurrent` / タッチUI)を一斉に切り替える |
| マップモード表示 | `CameraSystem.overviewMode` | 描画・視点側の分岐はこれを見る。`CameraSystem.zoomActive` は `!overviewMode && combatCamera.zoomActive` を返すだけの派生 getter(状態は持たない) |
| ターゲットロック・自動ターゲット・的通過マーク | `Targeter` | |
| 勝敗フェーズ | `Stage`(private `_phase`) | 変更は Stage 自身のみ。外部は `phase`/`isPlaying` を読む |
| 発射数・命中数・撃破数・出撃数 | `ScoreCounter` | 所有は Stage |
| 補給の投入間隔タイマー | `Logistics` | |
| ウェーブフェーズ・波数 | `Stage00`(自身のフィールド) | |
| 残り時間 | `ScoreAttackTimer`(Stage0) | |
| ステージクリア回数 | **localStorage**(`tepui.clearCounts`) | UnlockManager はその読み書き窓口。インスタンスは正本ではない |
| ポーズ | `Game.paused` | 唯一の駆動源は `SettingsPanel.onSettingsOpenChange` |
| 一時エフェクト(フラッシュ)の配列 | `FlashEffectManager.effects` | |
| 地球自転の初期位相 | `EnvironmentScene.earthPhase0` | |
| 太陽・月の初期位相 | `Ephemeris` | 時刻を引数に取るサンプラ。他に持つのは `sunPosAt`/`moonPosAt` の直近1件のメモ(時刻と結果)だけで、返す値が不変なので呼び出し側から観測できる状態ではない |
| 入力スナップショット(押下キー・クリック・マウス移動量) | `Input` | フレーム確定は `update()` の1回だけ。エッジは `takeKey`/`takeKeys`/`takeClicks`/`takeRightClicks` で**先着順に消費**され、処理した側より後ろのモジュールには届かない |
| 敵 AI の実行時状態(最終発砲時刻・バースト残数) | `Enemy` | |
| LEAD マーカーの表示履歴(敵ごとの最終ロック時刻) | `LeadMarkers` | 表示専用の状態なので Enemy には置かない。毎フレーム生存中の敵ぶんだけ作り直す |
| マーカー DOM 要素のプール | `MarkerManager` | キーで索引。`GroupedMarkers`/`LeadMarkers` は自分が前フレームに出したキーを覚えていて、集合から消えたものを hide する |

### 正本が分かれていることに意味がある組み合わせ

- **`CameraSystem.overviewMode`(視点)・`PlanEditor.editMode`(操作系)・`DisplayTimeManager.forceCurrent`
  (未来表示の禁止)** は3つとも別の正本。同時に切り替えるのは `MapModeToggler` だけで、描画・視点側は
  overviewMode を、入力・挙動側は editMode を、未来表示の可否は forceCurrent を見る。
  「マップモードが開いているか」そのものの正本は第四の値 `MapModeToggler.mapMode` で、上の三つ
  (とタッチUI)はその影響先。
- **`FloatingOrigin.r` と `Player.state.r`** は現状同じ値だが意味論的に別物。sync 系は必ず fo を参照し、
  `player.state.r` を描画原点として直接使わない。
- **`OverviewCamera.cameraFrame`(視点を固定する座標系)と `PlanDisplay.trajectoryFrame`(予測折れ線を
  描く座標系)** は別の正本で、ユーザーが独立に選ぶ。PlanTrajectory が受け取るのは後者だけ。
- **マップモードの操作パネル**は状態の所有者ごとに分かれる。`OverviewCameraPanel` は CameraSystem が、
  `DisplayTimePanel`(期間・未来位置スライダー)は DisplayTimeManager が、TRAJECTORY パネル(表示座標系)
  は PlanDisplay(PlanEditor 所有)が持ち、それぞれ自分の状態だけを映して自分の状態だけを受け取る。
  表示・非表示も各所有者が毎フレームの sync で押し出す(MapModeToggler は関与しない)。
- **キー割り当ての正本は `input/key-mapping.ts` の `KEY_MAPPING`、キーの処理の正本は各担当モジュール**。
  どのキーがどの操作かは KEY_MAPPING(コード + 表示名)だけが持ち、入力を読む側(`Input.down` /
  `Input.takeKey` は `KeyBinding` を受ける)と説明を出す側(ヘルプ表・操作バー・タッチパッド・
  ステージ briefing・結果画面)は両方ともそれを参照する。どの操作を誰が処理するかは各モジュールに
  閉じたままで(`SettingsPanel`=pauseMenu / `Hud`=help / `Stage`=restart /
  `SimSpeedManager`=warpSlower・warpFaster・autoWarpToNode / `MapModeToggler`=toggleMapMode /
  `PlanEditor`=deleteNode・dv* / `CameraSystem`=followAttitudeToggle・gunsightZoom・camera* /
  `Player`=rcsDampToggle・progradeReset・fineAttitudeToggle・progradeHoldToggle・throttle*・reload・thrust*・pitch/yaw/roll)、
  `game.ts` が持つのは「どのモジュールに先に配るか」という順序だけ。
  ステージ選択画面のキー(`Stage.selectKeys`)はステージ定義側のデータなので KEY_MAPPING には含めない。
- **`HudPanels` は表示専用**。Game を丸ごと読んで自分の4パネルへ書くだけで、他モジュールの状態や
  DOM は操作しない。ステージ固有の状況パネルは `Stage`(`StageStatusPanel`)、タッチUIのトグル点灯は
  `TouchControls.syncModeButtons()` が担当し、いずれも game.sync が自機/ステージの状態を渡す。
- **HUD マーカーは対象の持ち主が出す**。自機由来(方向/ボアサイト/マップ上の自機)は `PlayerMarkers`、
  ターゲット由来(方位・相対 AN/DN・的通過マーク)は `Targeter`、補給は `Logistics`、天体ラベルは
  `FocusMarkers`、ノード/BURN は `PlanGuide`、未来ゴーストは `PlanDisplay`。Game が直接持つのは
  **1つの対象では決められない2つだけ** — `GroupedMarkers`(画面上のまとめ)と `LeadMarkers`(自機と敵の
  両方に依存)。`Enemy` は自分の見た目とラベルを `markerItem()` で渡すだけで、まとめの判断には
  関与しない。

---

## 付録: 正本でないもの(混同しやすいもの)

所有関係として数えないが、正本と間違えやすいもの。**これらを書き換えてもゲーム状態は変わらない**
(逆に、正本を変えたときに無効化が必要になる)。

| 対象 | 正体 | 無効化の契機 |
| --- | --- | --- |
| `GameEntity.elements`(→ `current.elements`) | `state` からの軌道要素のメモ化 | `current.step`/`.reset`(差し替えのたび自動) |
| `GameEntity.prevState`(→ `current.prevState`) | 直前の `step`/`reset` 時点の state を持つ専用フィールド(`history` とは別) | `step`/`reset` のたび更新 |
| `GameEntity.predicted` | `current.state` + ephemeris から `Predictor` が漸進的に構築する未来軌道のキャッシュ(`predictDuration = 0` のクラスでは常に null) | `resyncPrediction` の距離判定(§3-4 (a))、または `Player.behave` の推力確定直後(§3-4 (b))。無効化は破棄のみで即再構築はしない — 次フレーム以降の通常の予算配分で伸び直す |
| `OrbitLine.snap` / 頂点配列 | 楕円ジオメトリの再生成判定用スナップショット | 要素ドリフト・`force`・初回 |
| `PlanArc.samples` / `.key`(`{state0, end}`) | 予測 RK4(`OrbitEntity` 積分)の結果と入力スナップショット | `(state0, end)` の変化 + スロットル、`force` |
| `PlanTrajectory.arcs` / `.activeCount` / `.nodeCount` / `.frame` / `.unbakeTime` / `.project` | 毎フレーム再構築される区間分割と表示文脈(画面判定もこれを使う)。`arcs` は先頭 `activeCount` 本だけがこのフレームの区間に対応するプール、先頭 `nodeCount` 本がノードで終わる区間 | `update()` 毎 |
| `SampledLine.lastSamples` / `.lastFrame` | bake 済み頂点の入力スナップショット | 点列 or frame の変化 |
| `DebugHistoryLine.lines`(`Map<GameEntity, SampledLine>`) | 対象ごとの `SampledLine` インスタンスのプール(`?debugLines=1` のみ実体化) | 対象集合(`sync` の引数)から外れたエンティティぶんを毎フレーム破棄 |
| `PlanTrajectory.arrivalStates()` / `PlanEditor.nodeDv()` | 各区間の `PlanArc` 終端状態、およびそこから求めるノード Δv の導出値(表示専用) | 呼ぶたび再計算(`PlanArc` 側の積分結果をそのまま読むので、描画中の予測軌道と同じ結果になる) |
| `PlayerThrottle.thrustVizDir` / `.thrustAccelVec` | 推力の表示・ベルト物理向け派生値 | 毎フレーム上書き |
| `Player` の各 getter(`rcsDamp` / `magsLeft` 等) | throttle/fire への転送 | — |
| `FocusMarkers.labels[].pos` | 天体暦から毎フレーム再計算 | `syncLabels()` 毎 |

### 基礎データ型の不変性(整合性の前提)

`Vec3` / `OrbitState` / `Quat` / `Attitude` は **不変**。値を進めるときは中身を書き換えず、
新しいオブジェクトを作って差し替える(`stepOrbitRK4` は新しい `OrbitState` を、`stepAttitude` は
新しい `Attitude` を返す)。これは最適化ではなく整合性の前提で、`physics/orbit-entity.ts` の
`OrbitEntity`(`GameEntity.current`)が `step`/`reset` のたび軌道要素メモを破棄し、差し替え前の
state を条件付きで `history` へ送れるのは「state が差し替え以外では変化しない」からである。
参照を共有したまま中身を書き換えると保持側が変化を検知できず、メモが黙って腐り、履歴も取り落とす。

`OrbitState` は `{t, r, v}`(エポック付き状態ベクトル)で、**予測点列・エンティティ履歴・計画ノードは
すべてこの 1 型で表す**。同じ情報量の型を複数持たない(旧 `TrajectorySample` / `LineSample` /
`PlannedNode.time` はここへ統合済み)ため、「状態」と「その時刻」が別々に渡されて食い違うことがない。

**例外はない。** RK4 の環境加速度評価も `envaccel.ts` の `envAccel` が `Vec3` を返す純粋関数で、
`stepOrbitRK4` はそれを `ExtraAccelFn` として受け取る。ミュータブルなスクラッチや `out` 引数を
持つ変種は `physics/` のどこにも置かない(その形を撤去した経緯と実測値は
`memos/mikanixonable/軽量化計画.md` の A-1 を参照)。エンティティ数が増えて効くようになったときの
答えは物理 LOD(同 B-1)であって、ミュータブルなスクラッチの再導入ではない。
