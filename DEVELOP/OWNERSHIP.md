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
    │   └── OverviewCameraPanel        ... DOM は Hud.root 配下。注視/視点座標系/視点リセット
    ├── MapPicker                      ... マップ被選択物の候補列・右クリック解決・種別別プロパティ/操作の配分・開いているプロパティウィンドウ集合
    │   ├── ContextMenu<MapPickable>       ... 空域右クリック('empty-space')専用メニュー
    │   ├── windows: Map<string, PropertyWindow<MenuAction>>  ... オブジェクト1つ(`${kind}:${id}`)につき高々1枚。呼び出しごとに new
    │   └── ObjectListPanel                ... DOM は Hud.root 配下。軌道オブジェクトウィンドウ(一覧 + クリックでフォーカス移動)
    ├── NavTarget                      ... 航法ターゲット(id)と自機軌道との相対 AN/DN・▲/▽ マーカー
    ├── Navball                        ... 姿勢儀。基準モード(自機/TGT+/TGT-)と天球グリッド6トグルの正本
    │   └── NavballPanel                   ... DOM は Hud.root 配下。SVG のボール + モード選択 + グリッドトグル
    ├── GroupedMarkers (enemyMarkers)  ... 画面上で近接する敵マーカーのまとめ + 画面外方位マーカー
    ├── LeadMarkers                    ... 敵ごとの LEAD マーカーと最終ロック時刻
    ├── SimSpeedManager
    ├── DisplayTimeManager             ... 「いつを見るか」(表示期間・未来ゴーストスライダー)
    │   └── DisplayTimePanel           ... DOM は Hud.root 配下。期間/未来位置スライダー
    ├── PlanEditor                     ... plan は活艦(ship)の Plan への転送 getter。正本ではない
    │   ├── PlanDisplay                ... 計画の未来表示(「見えるとき何を見せるか」)
    │   │   ├── PlanTrajectory         ... 計画折れ線 + per-arc キャッシュ + 画面判定
    │   │   │   └── PlanArc[]          ... arc ごと。各々 OrbitEntity 1本(積分の正本)+ SampledLine を持つ
    │   │   └── TRAJECTORY パネル DOM   ... 表示座標系(frame)の SegmentedControl 1 個のみ
    │   ├── NodeGizmo
    │   │   └── ContextMenu<number>
    │   ├── HudHoldButton ×6            ... Δv 6方向の長押しボタン(dvButtons)
    │   └── 計画パネル DOM
    ├── PlanGuide                       ... 直近ノードの接近/達成通知済みフラグ(ノード自体への参照)を持つ
    ├── Docking                        ... 基地への収容・発進(EntityManager/CameraSystem/Game.player にまたがる横断)
    │   └── DockView                       ... DOM は Hud.root 配下。格納艦/部品/ショップタブのフルスクリーン UI
    ├── ViewManager                    ... 現在のビュー(combat/map/dock)の正本。遷移は setView() ひとつに集約
    ├── ViewBadge                      ... DOM は Hud.root 配下。ViewManager を参照するだけで自身は状態を持たない
    │   └── ContextMenu<true, ViewId>
    ├── Stage (activeStage)            ... initStage() が毎回 new する。クリエイティブモードでは CreativeStage を
    │                                       game.ts が直接 new する(initStage() は経由しない — §1 末尾の補足参照)
    │   ├── ScoreCounter
    │   ├── Logistics                  ... 補給の投入判断と ▣ AMMO マーカー
    │   ├── StageStatusPanel           ... DOM は Hud.root 配下。HP/補助メッセージ/撃墜数
    │   ├── ScoreAttackTimer           ... Stage0 のみ(Stage00 の波状攻撃フェーズ・波数は Stage00 自身のフィールド)
    │   └── ShipPlacerPanel            ... CreativeStage のみ。DOM は Hud.root 配下。艦艇配置フォーム(開閉状態 isOpen も自身が持つ)
    ├── EnvironmentScene               ... game/celestial/ 配下(game/ への依存を持つため render/ から移動)
    │   ├── CelestialBody[]             ... CELESTIAL_VIEWS(celestial-registry.ts)から1体ずつ生成。地球=EarthBody・太陽=SunBody・月/木星=PlanetBody
    │   ├── AmbientLight / stars メッシュ
    │   ├── OrbitLine ×2               ... geoLine / moonLine(マップ参照線)
    │   └── CelestialGrid              ... 赤道面/黄道面それぞれの基準円・緯経線グリッド・両極マーカー
    ├── EffectsSystem
    │   └── FlashEffectManager
    │       └── FlashEffect[]          ... 各々 Billboard を持つ
    ├── Targeter
    │   ├── OrbitLine                  ... 第一ターゲット軌道線(オレンジ)
    │   ├── OrbitLine (secondaryOrbitLine) ... 第二ターゲット軌道線(シアン)
    │   └── ContextMenu<Enemy>         ... 第一/第二ターゲットの設定・解除メニュー
    ├── EntityManager                  ... エンティティ配列の保持のみ。simTime は持たない
    │   ├── Player[] (players)         ... 自機。ステージモードでは1隻のみ。操作対象(Game.player)は
    │   │                                  この配列内の1隻への参照(§3-4 参照)
    │   │   ├── PlayerThrottle
    │   │   ├── PlayerFire
    │   │   ├── Belt
    │   │   │   └── BeltPhysics
    │   │   │       └── BeltSection[]  ... 剛体接触用プロキシ
    │   │   ├── ThermalSystem
    │   │   ├── RadiatorSystem         ... 放熱板2枚の展開度・損耗度。ヒンジ Group は Player.obj 配下を名前で参照
    │   │   ├── PowerSystem            ... 太陽電池の蓄電量。パネル法線は機体固定 (0,1,0)、可動部なし
    │   │   ├── ThrustEffects → Billboard ×2
    │   │   ├── RcsEffects    → Billboard ×8   ... 状態なし。ノズル1基につき1枚、配置は RCS_NOZZLES が正本
    │   │   ├── ReentryEffects → Billboard ×2   ... 状態なし。強度は毎フレーム qdyn から導く
    │   │   ├── PlayerMarkers          ... 方向マーカー・ボアサイト・マップ上の自機位置(操作対象の艦だけが sync する)
    │   │   ├── OrbitLine              ... 自機軌道線。中心天体は毎フレーム state から導出(strongestAttractor)
    │   │   └── Plan                   ... この艦自身のマニューバ計画(正本)。ノード列 + アンカー
    │   ├── Enemy[]                    ... 各々 OrbitLine を持つ
    │   ├── Bullet[]
    │   ├── DebrisPiece[] (casings)
    │   ├── DebrisPiece[] (debris)
    │   ├── Ammo[]
    │   └── Base[]                     ... 各々 baseState(money/inventory/dockedShips)と OrbitLine を持つ
    ├── Simulator                      ... 実シミュレーション。EntityManager の参照を受け取って回すだけ(所有しない)
    │   ├── HitSystem
    │   └── CollisionPhysics
    └── Predictor                      ... 予測列の駆動。EntityManager の参照を受け取って回すだけ(所有しない)。
                                            状態はラウンドロビンのカーソルのみ
```

木に現れないインスタンス:

- 全ての `GameEntity`(Player・Enemy[]・Bullet[]・DebrisPiece[]・Ammo[]・BeltSection[] — 木の
  どのノードも例外なく)は `physics/orbit-entity.ts` の `OrbitEntity` を1本、フィールド名
  `current` で保持する(state/history/prevState の正本)。GameEntity ごとに繰り返さず
  ここに一括で記す。`OrbitEntity` 自身は軌道要素を持たない — `GameEntity.elementsAround(body)` が
  `state` の参照同一性 + `body.id` でメモ化する(§付録「正本でないもの」参照。中心天体 `body` は
  呼び出し側が都度選ぶので `OrbitEntity`/`GameEntity` の状態ではない)。`predictsFuture = true` の
  GameEntity(Ship・Ammo のみ)は、`Predictor` が
  `stepPrediction` を呼んだ時点で2本目の `OrbitEntity` を `predicted` として追加で持つ
  (§付録「正本でないもの」参照 — 未来位置のキャッシュであり、正データではない)。予測する長さ
  (horizon)は種別ごとの定数ではなく、`Predictor.update` が毎フレーム
  `DisplayTimeManager.durationSec(referencePeriod)` から渡す引数。
- `STAGE_DEFINITIONS`(stage-dictionary.ts のモジュールスコープ)… 選択画面のラベル・解放条件を読む
  ためだけの `Stage` インスタンス列。`setup()`/`init()` は呼ばれず、プレイに使う `activeStage` とは別物。
  `CreativeStage` はここに含まれない(選択画面のタブには出ない)ので、`game.ts` は `launch.mode ===
  'creative'` のとき `initStage()` を経由せず `CreativeStage` を直接 `new` し、`setup()`/`init()` を
  自分で順に呼ぶ(`setup()` は `CreativeStage` 自身が override して `ShipPlacerPanel` の組み立てまで行う)。
- `launch-select.ts` の `UnlockManager` … 選択画面用に別途 `new` される。正本は localStorage なので
  Game 側のインスタンスと状態を共有する必要がない。

---

## 2. 参照共有(所有ではない)

複数箇所から使われるため、所有者から参照だけを配って回っているもの。**所有権は移らない。**

| 対象 | 所有者 | 参照する側 |
| --- | --- | --- |
| `THREE.Scene` / `WebGPURenderer` | `GameScene`(main.ts) | Game・各描画物を持つクラス |
| `Hud` / `Sfx` | main.ts | Game(コンストラクタ引数で受け取り)経由でほぼ全サブシステム(hud/sfx は必ず対で注入する方針) |
| `SettingsPanel` | main.ts | Game(`[Esc]` で `toggle()` を呼ぶだけ。開閉の一時停止反映は main.ts 側の配線) |
| `MarkerManager` | Game | マーカーを出す全モジュール(GroupedMarkers・LeadMarkers・PlayerMarkers・Targeter・NavTarget・Logistics・FocusMarkers・PlanGuide・PlanDisplay) |
| `Ephemeris` | Game | EnvironmentScene・Simulator・OverviewCamera・FocusMarkers・NavTarget・PlanEditor(→PlanDisplay) |
| `EntityManager` | Game | Simulator(コンストラクタ引数、配列を直接持たず参照だけ回す)・HitSystem・CollisionPhysics・Targeter・NavTarget・Enemy.behave・Stage/stages/・Logistics・EffectsSystem・NanWatchdog(いずれも読み取り + `addXxx`/`findPlayer` 経由の追加・参照のみ) |
| `PlanTrajectory` | PlanDisplay | PlanEditor(ノードの画面判定 `projectPoint` / `nearestSample` のみ、`planDisplay.traj` 経由) |
| `DisplayTimeManager` | Game | PlanEditor(→PlanDisplay)(コンストラクタ引数で `PlanDisplay` → `PlanTrajectory` へそのまま転送。末尾区間の長さ(`plan.ts` の `segmentDurationFrom`)と `Plan.nodeTimeRange` の上限が PREDICT パネルの選択に追従するための参照で、`PlanTrajectory` はこれを保持するだけで書き換えない) |
| `Plan`(活艦の) | `Player`(活艦自身、`PlanEditor` ではない) | PlanEditor(`plan` getter が activePlayer.plan を転送)・PlanDisplay(`sync` の引数で毎フレーム)・PlanGuide(同)・CreativeStage(followPlan 艦の自動追従) |
| `SimSpeedManager` | Game | PlanEditor(ノードメニューからの自動ワープ) |
| `EffectsSystem` | Game | Player・PlayerFire・Enemy・Stage |
| `Player` / `Simulator` / `EntityManager` / `Stage` | Game | 毎フレームの引数として相互に渡される |
| `UnlockManager` | main.ts | ステージセレクト画面と、各Stage（クリア後画面判定のため） |
| `FocusMarkers.labels` | CameraSystem(→FocusMarkers) | `MapPicker.refresh()` が読んで生存中の自機・敵船・NavTarget のアイコン・`PlanDisplay.apsisMarkers` と合流させ、`MapPicker.handleRightClick`(`pickNearest`)/`OverviewCamera.update` の被選択物候補として渡し直す |
| `PlanDisplay.apsisMarkers` | PlanEditor(→PlanDisplay) | `MapPicker.refresh()` が他の候補と合流させ、`MapPicker.handleRightClick`/`OverviewCamera.update` へ1本の候補列として渡す |

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
| 放熱板の展開度・損耗度 | `RadiatorSystem` | 温度は持たない。放熱面積と太陽入射を `ThermalSystem.setRadiatorLoad` へ渡すのは `Player` |
| 太陽電池の蓄電量 | `PowerSystem` | メッシュ操作なし(パネルは固定)。`sync()` を持たない |
| エンティティ配列(自機/敵/弾/薬莢/デブリ/補給) | `EntityManager` | 追加は `addXxx` 経由。上限管理もここ(`players` のみ無上限で `prune` の対象外 — 喪失艦も配列に残り続ける)。`Simulator` は参照を受け取って回すだけで配列を持たない |
| シミュレーション時刻 / 前フレームの simDt | `Simulator.simTime` / `.lastSimDt` | |
| 予測ラウンドロビンのカーソル | `Predictor.cursor` | `EntityManager.all()` のインデックスとして毎フレーム進む。`tracked`/`complete`/`discarded` の3カウンタも同じインスタンスが持つが、`?perf=1` 表示専用の集計値で次フレームの挙動には影響しない |
| ワープ段・自動ワープ目標時刻 | `SimSpeedManager` | 閾値判定(canPlayerFire 等)もここの getter が唯一 |
| 天球グリッド6トグルの可視状態・navball の基準モード | `Navball` | `gridVisibility`/`mode`。`Game.sync` が `navball.gridVisibility` を読んで `EnvironmentScene.sync` の引数(`gridVisibility`)経由で `CelestialGrid.sync` へ渡すだけで、`CelestialGrid` 自身は状態を持たない |
| Δv アーム/ボタンのホールド継続時間・ラッチ状態 | `PlanEditor.dvHoldTime` / `NodeGizmo.latch` | 6方向ぶんの経過秒数(ホールドレートのランプに使う)と、ドラッグがラッチへ入った軸/超過量。加算そのものは `PlanEditor.applyDv` に一本化 |
| NaN 検出済みフラグ | `NanWatchdog`(Game 所有) | 一度検出したら以後の検査を止める |
| マニューバ計画(ノード列・アンカー) | `Plan` | 所有は各 `Player`(艦ごとに1個。`PlanEditor.plan` は活艦のものを転送する getter)。ノード・アンカーとも 1 個の `OrbitState`(実行時刻 = `t`、Δv は導出値)。ノード列は `OrbitState[]` を1本持つだけで、`addNode` が挿入位置より後ろを破棄してから push するため常に実行時刻順。`dropNodesBefore(t)` は実行時刻が `t` 以前のノードをまとめて取り除き、最後に取り除いたノードを新しい `anchor` に据えて返す(`CreativeStage.advanceFollowPlan` が `followPlan` 艦の自動追従にこの戻り値を使う) |
| 操作対象(アクティブ)艦 | `Game.player` | 唯一の書き換え箇所は `Game.setActivePlayer(ship)`。カメラ参照・計画編集対象・ターゲット解除の副作用もすべてここに閉じる(下記「たまたま同時に切り替わる」節参照) |
| 軌道計画への自動追従 | `Player.followPlan` | 全ての自機が持つ(既定 false)。ON の艦は `CreativeStage.update` が毎フレーム見て、次ノード時刻を跨いだら `state` をノードの絶対状態へ置き換える |
| 選択中ノード・計画編集モード | `PlanEditor.selectedNodeIdx` / `.editMode` | 選択は素の `number \| null`。`deleteNode(idx)` は削除後 `selectedNodeIdx >= idx` なら選択を解除する |
| 直近ノードの接近/達成通知済み | `PlanGuide`(`approachNotified` / `achievedNotified`) | 通知済みのノードそのものへの参照。編集のたびノードは別インスタンスへ置き換わるので、同一性比較がそのまま「同じノードについて通知済みか」の判定になる |
| 予測表示期間(手動レンジの秒数 `manualDurationSec` を含む)・未来ゴーストスライダー(`sliderT`)・未来表示の禁止(`forceCurrent`) | `DisplayTimeManager` | `forceCurrent` は get/set アクセサで、true をセットすると `sliderT` も 0 へ戻す。期間の切替(`durationKey` 変更)でも同様に `sliderT` を 0 へ戻す |
| 計画折れ線を描く表示座標系(trajectoryFrame) | `PlanDisplay` | `OverviewCamera.cameraFrame`(視点固定座標系)とは別の正本 |
| マップ視点(注視点相対オフセット・パン・上方向)・表示座標系・フォーカス(id)・ViewFrame | `OverviewCamera` | `view: ViewFrame` は `CombatCameraSystem` と同じ形。`CameraSystem` はこの `view` を読むだけで自分では持たない。フォーカス id が指す実位置は `OverviewCamera` が持たず、`update` の引数(`MapPicker.refresh()`)から毎フレーム引き直す |
| 戦闘視点(ViewFrame: position/lookTarget/up/fovDeg/aspect)・照準ズーム中か(zoomActive) | `CombatCameraSystem` | rot(クオータニオン)/dist・姿勢追従フラグ(camFollowAttitude)は内部の `ChaseCamera` が持つ。zoomActive はこのクラス自身の `update` が `Input` から読んで保持する |
| 現在のビュー(combat/map/dock) | `ViewManager`(private `_current`) | 遷移は `setView()` のみ。影響先(`CameraSystem.overviewMode` / `PlanEditor.editMode` / `DisplayTimeManager.forceCurrent` / タッチUI)を一斉に切り替える。ドック表示中は背後の 3D 側ビュー(`returnFromDock`)を保持し、閉じるとそこへ戻る |
| ドックビューの対象基地 | `Docking`(private `_activeBase`) | 基地の右クリックメニューで設定。これが空でない間だけ `ViewManager.selectableViews()` に `'dock'` が並ぶ |
| マップモード表示 | `CameraSystem.overviewMode` | 描画・視点側の分岐はこれを見る。`CameraSystem.zoomActive` は `!overviewMode && combatCamera.zoomActive` を返すだけの派生 getter(状態は持たない) |
| 軌道オブジェクトウィンドウの表示中フラグ | `MapPicker`(`objectListVisible`) | 空域右クリックメニューの「軌道オブジェクトウィンドウを表示」でのみ true になる。`ObjectListPanel` の ✕ ボタン(`onClose`)、または `MapPicker.close()`(マップモードを閉じたとき)で false に戻る |
| 開いているプロパティウィンドウの集合・一時ウィンドウのキー | `MapPicker`(`windows`/`tempWindowKey`) | キーは `` `${kind}:${id}` ``。`openPropertyWindow` が新規/移動を判断し、`closeWindow`/`forgetWindow` が畳む。個々の `PropertyWindow` インスタンス自身はクリップ状態(`clipped`)とドラッグ位置だけを持ち、開閉のポリシー(いつ閉じるか)は持たない |
| 第一・第二ターゲット・的通過マーク | `Targeter`(`target`/`secondaryTarget`) | 右クリックメニュー(`applyMenuAct`)でのみ変わる。自動選定・自動再選択はない |
| 航法ターゲット(id)・相対 AN/DN | `NavTarget` | `update()` が自機軌道要素 + `Ephemeris` から毎フレーム再算出する導出値だが、対象の id 自体(`toggleTarget` で変わる)は正本 |
| 勝敗フェーズ | `Stage`(private `_phase`) | 変更は Stage 自身のみ。外部は `phase`/`isPlaying` を読む |
| 発射数・命中数・撃破数・出撃数 | `ScoreCounter` | 所有は Stage |
| 補給の投入間隔タイマー | `Logistics` | 投入できない間は進めない(再開直後のフレームで判定させるため) |
| 補給の自動投入の可否 | `Logistics.resupplyEnabled` | 書き換えは CreativeStage の LOGISTICS パネルのトグルのみ。ワープ倍率による停止は `SimSpeedManager.canResupplyAmmo` が別途担い、両者の積で投入可否が決まる |
| ウェーブフェーズ・波数 | `Stage00`(自身のフィールド) | |
| 残り時間 | `ScoreAttackTimer`(Stage0) | |
| ステージクリア回数 | **localStorage**(`tepui.clearCounts`) | UnlockManager はその読み書き窓口。インスタンスは正本ではない |
| ポーズ | `Game.paused` | 唯一の駆動源は `SettingsPanel.onSettingsOpenChange` |
| 一時エフェクト(フラッシュ)の配列 | `FlashEffectManager.effects` | |
| 地球自転の初期位相 | `EarthBody.phase0` | |
| 各天体の平均黄経の初期位相 | `Ephemeris`(`phaseOffsets`) | 時刻を引数に取るサンプラ。既定で乱数を持つのは月のみ。キャッシュは持たず、毎回天体暦の合成をやり直す |
| 入力スナップショット(押下キー・クリック・マウス移動量) | `Input` | フレーム確定は `update()` の1回だけ。エッジは `takeKey`/`takeKeys`/`takeClicks`/`takeRightClicks` で**先着順に消費**され、処理した側より後ろのモジュールには届かない |
| 敵 AI の実行時状態(最終発砲時刻・バースト残数) | `Enemy` | |
| LEAD マーカーの表示履歴(敵ごとの最終ロック時刻) | `LeadMarkers` | 表示専用の状態なので Enemy には置かない。毎フレーム生存中の敵ぶんだけ作り直す |
| マーカー DOM 要素のプール | `MarkerManager` | キーで索引。`GroupedMarkers`/`LeadMarkers` は自分が前フレームに出したキーを覚えていて、集合から消えたものを hide する |

### 正本が分かれていることに意味がある組み合わせ

- **`CameraSystem.overviewMode`(視点)・`PlanEditor.editMode`(操作系)・`DisplayTimeManager.forceCurrent`
  (未来表示の禁止)** は3つとも別の正本。同時に切り替えるのは `ViewManager` だけで、描画・視点側は
  overviewMode を、入力・挙動側は editMode を、未来表示の可否は forceCurrent を見る。
  「いまどのビューか」そのものの正本は第四の値 `ViewManager.current` で、上の三つ
  (とタッチUI)はその影響先。
- **`FloatingOrigin.r` と `Player.state.r`** は現状同じ値だが意味論的に別物。sync 系は必ず fo を参照し、
  `player.state.r` を描画原点として直接使わない。
- **`Game.player`(操作対象艦)・`ChaseCamera.player`(追従カメラの基準)・`PlanEditor.activePlayer`(計画編集の対象)・
  `Targeter` のロック** は艦を切り替えるたびに揃える必要がある4箇所。同時に切り替えるのは
  `Game.setActivePlayer` だけで、他はそれぞれ自分の持ち分(視点/編集対象/ロック解除)だけを更新する
  — `ViewManager` が3つのフラグを一斉に切り替えるのと同じ形のトグラー集約。
- **`OverviewCamera.cameraFrame`(視点を固定する座標系)と `PlanDisplay.trajectoryFrame`(計画折れ線を
  描く座標系)** は別の正本で、ユーザーが独立に選ぶ。PlanTrajectory が受け取るのは後者だけ。
- **`Targeter.target`(戦闘ターゲット、`Enemy` のみ)と `NavTarget.id`(航法ターゲット、任意の `MapPickable`)**
  は別の正本。前者は射撃・LEAD・的通過マークの対象、後者はマップの相対 AN/DN・時間加速・ノード追加の
  対象で、対象の型も操作系(右クリック位置がヒットしたのが敵かそれ以外か)も異なるため一本化しない。
- **マップモードの操作パネル**は状態の所有者ごとに分かれる。`OverviewCameraPanel` は CameraSystem が、
  `DisplayTimePanel`(期間・未来位置スライダー)は DisplayTimeManager が、TRAJECTORY パネル(表示座標系)
  は PlanDisplay(PlanEditor 所有)が持ち、それぞれ自分の状態だけを映して自分の状態だけを受け取る。
  表示・非表示も各所有者が毎フレームの sync で押し出す(ViewManager は関与しない)。
- **キー割り当ての正本は `input/key-mapping.ts` の `KEY_MAPPING`、キーの処理の正本は各担当モジュール**。
  どのキーがどの操作かは KEY_MAPPING(コード + 表示名)だけが持ち、入力を読む側(`Input.down` /
  `Input.takeKey` は `KeyBinding` を受ける)と説明を出す側(ヘルプ表・操作バー・タッチパッド・
  ステージ briefing・結果画面)は両方ともそれを参照する。どの操作を誰が処理するかは各モジュールに
  閉じたままで(`SettingsPanel`=pauseMenu / `Hud`=help / `Stage`=restart /
  `SimSpeedManager`=warpSlower・warpFaster・autoWarpToNode / `ViewManager`=toggleMapMode /
  `PlanEditor`=deleteNode・dv* / `CameraSystem`=followAttitudeToggle・gunsightZoom・camera* /
  `Player`=rcsDampToggle・progradeReset・fineAttitudeToggle・progradeHoldToggle・throttle*・reload・thrust*・pitch/yaw/roll)、
  `game.ts` が持つのは「どのモジュールに先に配るか」という順序だけ。
  ステージ選択画面のキー(`Stage.selectKeys`)はステージ定義側のデータなので KEY_MAPPING には含めない。
- **`HudPanels` は表示専用**。Game を丸ごと読んで自分の4パネルへ書くだけで、他モジュールの状態や
  DOM は操作しない。ステージ固有の状況パネルは `Stage`(`StageStatusPanel`)、タッチUIのトグル点灯は
  `TouchControls.syncModeButtons()` が担当し、いずれも game.sync が自機/ステージの状態を渡す。
- **HUD マーカーは対象の持ち主が出す**。自機由来(方向/ボアサイト/マップ上の自機)は `PlayerMarkers`、
  第一ターゲット由来(方位・的通過マーク)は `Targeter`、航法ターゲット由来(相対 AN/DN)は
  `NavTarget`、近地点・遠地点は `PlanDisplay`、補給は `Logistics`、天体ラベルは `FocusMarkers`、
  ノード/BURN は `PlanGuide`、計画上の自機位置ゴーストは `PlanDisplay`。Game が直接持つのは
  **1つの対象では決められない2つだけ** — `GroupedMarkers`(画面上のまとめ)と `LeadMarkers`(自機と敵の
  両方に依存)。`Enemy` は自分の見た目とラベルを `markerItem()` で渡すだけで、まとめの判断には
  関与しない。
- **`EntityManager.players` は他の配列と対等に `all()` へ入る** — 操作対象かどうかは `Game.player` との
  参照同一性だけで決まる選択であり、`players` 配列自体はアクティブ/非アクティブを区別しない。
  積分(`Simulator.simulationSubStep`/`.stepAttitudes`)・寿命判定(`EntityManager.cleanup`)・
  剛体接触(`CollisionPhysics.resolve`)はどの艦も一様に扱う。例外は2つだけ: `EntityManager.sync` は
  `players` を丸ごと素通りする(各艦は `Player.syncPlayer` が個別に同期する)。`Predictor.update` は
  `player` 引数を先頭で明示的に一度予算消化してから `entities.all()`(`players` を含む)を
  ラウンドロビンするので、カーソルが操作対象の艦に当たったフレームは二重に予算が付き得る(意図的)。

---

## 付録: 正本でないもの(混同しやすいもの)

所有関係として数えないが、正本と間違えやすいもの。**これらを書き換えてもゲーム状態は変わらない**
(逆に、正本を変えたときに無効化が必要になる)。

| 対象 | 正体 | 無効化の契機 |
| --- | --- | --- |
| `Ephemeris.attractorsAt(t)` の戻り値(`Attractor[]`) | 天体暦(`SOLAR_SYSTEM` 登録順、現在は地球・月・木星・太陽)から毎回組み立てる重力源スナップショット。どのクラスもこれを状態として保持しない — 呼んだその場で使い切るか、次のステップ/フレームでまた引き直す | 呼び出しごとに新しい `t` を渡せば作り直せる。`Ephemeris` はキャッシュを持たないので毎回組み立て直しになる |
| `Elements.center`(`Attractor`) | その軌道要素をどの天体まわりで取ったか。要素と同じ寿命でその天体の `t` 時点スナップショットを抱えるので、要素そのものより長く持ち回してはならない(`OrbitLine` は楕円の平行移動先をここから引く) | 要素を作り直すたび。`GameEntity.elementsAround` のメモ経由なら `state` 差し替えのたび |
| 解析楕円の中心天体(`strongestAttractor(state.r, bodies)` の結果) | `state`(と `bodies`)から都度導く選択であり、`GameEntity`/`Plan`/`PlanDisplay`/`OrbitLine` のどれもこれを状態として保持しない — 選ぶ GUI もない | 呼ぶたび再計算 |
| `GameEntity.elementsAround(body)` の内部メモ | `state` の参照同一性 + `body.id` をキーにした軌道要素のメモ化(中心天体 `body` は呼び出し側が選ぶ) | `state` が差し替わるたび(`current.step`/`.reset`)、または `body.id` が変わるたび自動的に不一致になる |
| `GameEntity.prevState`(→ `current.prevState`) | 直前の `step`/`reset` 時点の state を持つ専用フィールド(`history` とは別) | `step`/`reset` のたび更新 |
| `GameEntity.predicted` | `current.state` + ephemeris から `Predictor` が漸進的に構築する未来軌道のキャッシュ(`predictsFuture = false` のクラスでは常に null)。伸ばす長さ(horizon)は `DisplayTimeManager.durationSec(referencePeriod)` の毎フレーム値で、`GameEntity`/`Predictor` のどちらにも独立した状態としては残らない | `resyncPrediction` の距離判定(§3-4 (a))、または `Player.behave` の推力確定直後(§3-4 (b))。無効化は破棄のみで即再構築はしない — 次フレーム以降の通常の予算配分で伸び直す |
| `SimSpeedManager.canGrowPrediction` | `simSpeed <= C.MAX_PHYS_SIM_SPEED` の派生 getter(`canResolvePhysicalCollisions` と同じ式だが別の問い) | 呼ぶたび再計算 |
| `SimSpeedManager.canResupplyAmmo` | `simSpeed < C.MAX_PHYS_SIM_SPEED` の派生 getter(他の can* より1段厳しく等倍限定) | 呼ぶたび再計算 |
| `OrbitLine.snap` / 頂点配列 | 楕円ジオメトリの再生成判定用スナップショット | 要素ドリフト・`force`・初回 |
| `PlanArc.samples` / `.key`(`{state0, end}`) | 予測 RK4(`OrbitEntity` 積分)の結果と入力スナップショット | `update` の `tracksLiveAnchor` 引数(計画が空の間の唯一の区間だけ true)が false なら `state0`/`end` の同一性・値の変化。true なら区間長・起点時刻とも直近再積分時からの変化がサンプル間隔(区間長 / `PLAN_ARC_MAX_SAMPLES`)未満の間は無効化しない(`'orbit'` プリセットでは起点の接触周期自体が J2・大気抵抗で毎フレーム連続変化するため、厳密一致ではなくこの閾値で判定する)——ただし `state0` の同一性が変わっていて `t` が前進していない(別艦への切り替え・ドック発進・衝突による状態上書きなどの非連続な差し替え)場合はこの閾値を無視して即座に無効化する |
| `PlanTrajectory.arcs` / `.activeCount` / `.nodeCount` / `.frame` / `.unbakeTime` / `.project` | 毎フレーム再構築される区間分割と表示文脈(画面判定もこれを使う)。`arcs` は先頭 `activeCount` 本だけがこのフレームの区間に対応するプール、先頭 `nodeCount` 本がノードで終わる区間 | `update()` 毎 |
| `SampledLine.lastSamples` / `.lastFrame` | bake 済み頂点の入力スナップショット | 点列 or frame の変化 |
| `DebugHistoryLine.lines`(`Map<GameEntity, SampledLine>`) | 対象ごとの `SampledLine` インスタンスのプール(`?debugLines=1` のみ実体化) | 対象集合(`sync` の引数)から外れたエンティティぶんを毎フレーム破棄 |
| `PlanTrajectory.arrivalStates()` / `PlanEditor.nodeDv()` | 各区間の `PlanArc` 終端状態、およびそこから求めるノード Δv の導出値(表示専用) | 呼ぶたび再計算(`PlanArc` 側の積分結果をそのまま読むので、描画中の計画軌道と同じ結果になる) |
| `PlayerThrottle.thrustVizDir` / `.thrustAccelVec` | 推力の表示・ベルト物理向け派生値 | 毎フレーム上書き |
| `Player` の各 getter(`rcsDamp` / `magsLeft` 等) | throttle/fire への転送 | — |
| `FocusMarkers.labels[].pos` | 天体暦から毎フレーム再計算 | `update(t)` 毎(`syncLabels()` はこの値をマーカーへ置くだけ) |
| `NavTarget` の相対 AN/DN 位置・通過時刻 | 自機軌道要素 + 対象の軌道面法線からの導出値(id 自体は正本) | `update()` 毎に全消去→再算出 |
| `CreativeStage.preview`(軌道要素 + 位置) | 艦艇配置フォームの現在値からの導出値(正本はフォームの DOM) | `update()` 毎に再算出。パネルを閉じている間・値を解釈できないときは null |
| `CreativeStage.issues`(`PlacementFieldIssue[]`) | 艦艇配置フォームの現在値からの導出値(正本はフォームの DOM。bodyRadius/mu は `Ephemeris` から引く) | `update()` 毎に再算出、`sync()` で `ShipPlacerPanel.setIssues()` へ push。パネルを閉じている間は空配列 |
| `PlanDisplay.apsisMarkers` / アイコン位置 | `PlanTrajectory.finalSegmentStart` の軌道要素からの解析的な導出値 | `syncApsisMarkers()` 毎(`sync`/`hide` から呼ぶ) |
| `MapPicker.pickables` | `FocusMarkers.labels` + 生存中の全 `entities.players`・敵船の displayState + `NavTarget.mapPickables()` + `PlanDisplay.apsisMarkers` の合成(保持しない使い捨て配列) | `mapPicker.refresh()`(`update()` 内、経路ごとの `cameraSystem.update()` 直前)毎に作り直す |

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

**例外はない。** RK4 の加速度評価も `dynamics.ts` の `stepDynamicsRK4`(内部で `attractor.ts` の
`attractorAccel` の全天体ぶんの和 + 自身の `j2Accel` + `atmosphere.ts` の `dragAccel` を合成)が `Vec3` を返す
純粋関数の積み重ねで、`stepOrbitRK4` はその結果を `AccelFn` として受け取るだけ。ミュータブルな
スクラッチや `out` 引数を
持つ変種は `physics/` のどこにも置かない(その形を撤去した経緯と実測値は
`memos/mikanixonable/軽量化計画.md` の A-1 を参照)。エンティティ数が増えて効くようになったときの
答えは物理 LOD(同 B-1)であって、ミュータブルなスクラッチの再導入ではない。
