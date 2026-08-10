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
├── LocalStorageSaveStore  ... セーブの永続化窓口(索引・スナップショット本体の JSON 読み書きのみ)
├── SaveSlots              ... LocalStorageSaveStore を参照で持つ。SaveIndex(スロット/ステージ履歴/スナップショットメタ)の正本。initSaveSlots() が pruneOrphans() → migrateLegacySave() → アクティブスロット確定までを起動時に一度だけ行う
├── SnapshotService        ... LocalStorageSaveStore・SaveSlots を参照で持つ。Game ↔ GameSaveData の変換(capture/restore)。Game のコンストラクタ引数として渡す(Hud/Sfx と同じ「main.ts が先に作って注入する」形)
├── Hud                  ... initHud() でタイトル(ステージ選択)画面より前に生成、Game へ参照を渡す。
│   │                       root 直下の重なり順は layers: OverlayLayers(overlay-layer.ts、marker/panel/window/popup/view/notify/system の
│   │                       7層、この順に z-index 10〜16)が正本 — z-index を持つのは overlay-layer.ts だけで、他の全 DOM 所有者は
│   │                       自分がどの層の子になるかを選ぶだけ。層内の前後は DOM 順、最前面化は bringToFront() のみ
│   └── HudPanels        (buildHudDom が作った要素索引を共有)
├── Sfx                  ... 同上
├── SettingsPanel        ... 同上。DOM は Hud.layers.system 配下。onSettingsOpenChange を Game.pause()/resume() へ配線。onOpenSnapshots は main.ts が settingsPanel.toggle(false) + saveBrowser.open() へ配線
├── SaveBrowser            ... Game 自身を構築引数に取るため Game より後に main.ts が new し、Game.setSaveBrowser で遅延注入する(ViewManager.setDocking と同じ形)。所有は main.ts、Game 側は参照を持つだけ。DOM は Hud.layers.system 配下
├── AutoSave               ... SnapshotService を参照で持つ。startAnimationLoop() へその場で渡すだけで main() 側は変数に束縛しない
├── PerfMeter            (?perf=1 の DOM 表示。Game を PerfCountSource として参照するだけ)
├── GameScene            (createGameScene: canvas / THREE.Scene / WebGPURenderer)
└── Game
    ├── FloatingOrigin       ... sync ごとに作り直す使い捨て
    ├── Input
    ├── TouchControls?       ... タッチデバイスのみ
    ├── MarkerManager        ... DOM の親は Hud.layers.marker / Hud.svgOverlay、所有は Game
    ├── Ephemeris            ... 状態を持たない純サンプラ。各所へ参照共有する単一インスタンス
    ├── CameraSystem
    │   ├── CombatCameraSystem
    │   │   ├── ChaseCamera
    │   │   └── GunsightCamera
    │   ├── OverviewCamera
    │   ├── FocusMarkers
    │   └── OverviewCameraPanel        ... DOM は Hud.layers.panel 配下。天体クラス別トグル(軌道線/ラベル)+ 弾薬マーカートグルのみ。座標系の選択は持たない
    ├── FrameControls                  ... 座標系パネル。カメラ(視点)区画と軌道計画(描画基準)区画がそれぞれ
    │                                       中心・回転の2ゾーンを持ち、OverviewCamera・PlanDisplay.planFrame を書く。
    │                                       自分の状態は「カメラの基準に追随」トグル(followCamera)だけ。
    │                                       パネル DOM は Hud.layers.panel 配下
    │   ├── AnchorZone × 2                 ... カメラ/並進ゾーン。ObjectPicker + SegmentedControl(いまいる系のクイックボタン)。ObjectPicker のポップアップは Hud.layers.popup 配下
    │   └── RotationZone × 2               ... カメラ回転/計画軌道回転ゾーン。SegmentedControl のみ
    ├── MapPicker                      ... マップ被選択物の候補列・右クリック解決・種別別プロパティ/操作の配分・開いているプロパティウィンドウ集合
    │   ├── ContextMenu<MapPickable>       ... 空域右クリック('empty-space')専用メニュー。DOM は Hud.layers.popup 配下
    │   ├── windows: Map<string, WindowEntry>  ... {win: PropertyWindow<MenuAction>, target}。オブジェクト1つ(`${kind}:${id}`)につき高々1枚。呼び出しごとに new。PropertyWindow は Hud.layers.window 配下に append
    │   └── ObjectListPanel                ... DOM は Hud.layers.panel 配下。軌道オブジェクトウィンドウ(一覧 + クリックで選択状態 + ダブルクリックでフォーカス移動 + 右クリックでプロパティウィンドウ)。マップ視点である間は常設表示
    ├── NavTarget                      ... 航法ターゲット(id)と自機軌道との相対 AN/DN・▲/▽ マーカー
    ├── Navball                        ... 天球グリッド6トグルの正本
    │   └── NavballPanel                   ... DOM は Hud.layers.panel 配下。グリッドトグルのみ
    ├── GroupedMarkers (enemyMarkers)  ... 画面上で近接する敵マーカーのまとめ + 画面外方位マーカー
    ├── LeadMarkers                    ... 敵ごとの LEAD マーカーと最終ロック時刻
    ├── EquatorNodeMarkers             ... 操作艦・navTarget・targeter の対象ごとの EqAN/EqDN。source 列(id で重複除去)は Game が毎フレーム組む
    ├── SimSpeedManager
    ├── DisplayTimeManager             ... 「いつを見るか」(表示期間・未来ゴーストスライダー)
    │   └── DisplayTimePanel           ... DOM は Hud.layers.panel 配下。期間/未来位置スライダー。画面下端の帯として
    │                                       #hud-displaytime-wrap に開閉トグル(hud/dom.ts の buildCollapseToggle)と
    │                                       並べて包まれる。開閉状態はトグル対象要素の `.collapsed` クラスが正本(この
    │                                       クラス自身は持たない)で、ビューの往復では戻さない(折りたたみは
    │                                       ビューの性質ではなく操作者の選択)
    ├── PlanEditor                     ... plan は活艦(ship)の Plan への転送 getter。正本ではない
    │   ├── PlanDisplay                ... 計画の未来表示(「見えるとき何を見せるか」)
    │   │   └── PlanPath         ... 計画折れ線 + per-arc キャッシュ + 画面判定
    │   │       └── PlanArc[]          ... arc ごと。各々 DynamicTrajectory 1本(積分の正本)+ SampledLine を持つ
    │   ├── NodeGizmo                   ... ノードハンドル/Δv 矢の DOM は Hud.layers.marker 配下
    │   │   └── ContextMenu<number>     ... DOM は Hud.layers.popup 配下
    │   ├── HudHoldButton ×6            ... Δv 6方向の長押しボタン(dvButtons)
    │   └── 計画パネル DOM
    ├── PlanGuide                       ... 直近ノードの接近/達成通知済みフラグ(ノード自体への参照)を持つ
    ├── Docking                        ... 基地への収容・発進(EntityManager/CameraSystem/Game.player にまたがる横断)
    │   └── DockView                       ... DOM は Hud.layers.view 配下。格納艦/部品/ショップタブのフルスクリーン UI
    ├── ViewManager                    ... 現在のビュー(combat/map/dock)の正本。遷移は setView() ひとつに集約
    ├── ViewBadge                      ... DOM は Hud.layers.notify 配下。ViewManager を参照するだけで自身は状態を持たない
    │   └── ContextMenu<true, ViewId>  ... DOM は Hud.layers.popup 配下
    ├── Stage (activeStage)            ... initStage() が毎回 new する。クリエイティブモードでは CreativeStage を
    │                                       game.ts が直接 new する(initStage() は経由しない — §1 末尾の補足参照)
    │   ├── ScoreCounter
    │   ├── Logistics                  ... 補給の投入判断と ▣ AMMO マーカー
    │   ├── StageStatusPanel           ... DOM は Hud.layers.panel 配下。HP/補助メッセージ/撃墜数
    │   ├── ScoreAttackTimer           ... Stage0 のみ(Stage00 の波状攻撃フェーズ・波数は Stage00 自身のフィールド)
    │   └── ShipPlacerPanel            ... CreativeStage のみ。パネル本体は Hud.layers.panel 配下、ObjectPicker のポップアップは Hud.layers.popup 配下(別々の引数で受け取る)。艦艇配置フォーム(開閉状態 isOpen も自身が持つ)
    ├── EnvironmentScene               ... game/celestial/ 配下(game/ への依存を持つため render/ から移動)
    │   ├── CelestialBody[]             ... CELESTIAL_BODIES(celestial-registry.ts)から1体ずつ生成。地球=EarthBody・太陽=SunBody・pointBrightness 未指定の惑星/月/土星等=SphereBody・pointBrightness 指定の惑星(金星・木星・水星・火星・土星・天王星)=PointBody。木星・土星・天王星・海王星は SOLAR_SYSTEM の CelestialBodyDef.rings(物理データ)を own し、build 時に RingView を1つ生成してシーン直下へ追加(本体メッシュの子ではない — sphere-body.ts/point-body.ts 参照)。SphereBody/PointBody は build 時に CelestialSurface(render/celestial-surface.ts、メッシュと昼夜陰影の uniform)を1つ own する
    │   ├── PointFieldView              ... 小惑星帯・トロヤ群・ヒルダ群・カイパーベルト cold/hot・散乱円盤の点群(群ごとに1つの InstancedMesh、計11200点)。point-field.ts の PointFieldDef 配列(POINT_FIELD_DEFS)から build 時に一度だけ生成し、以後は不変
    │   │   └── groups: readonly PointFieldGroupView[] ... PointFieldDef 1つにつき1インスタンス。群ごとの描画半径・色は point-field-view.ts の GROUP_VIEW が持つ
    │   │       ├── points: readonly PointElements[]   ... 決定論的乱数(mulberry32、ASTEROID_SEED)で生成、生成後は読み取り専用
    │   │       ├── positions: Vec3[]    ... 各点の太陽中心位置。update がラウンドロビン(1/8点/フレーム)で書き換える唯一の書き手
    │   │       ├── sunPos: Vec3         ... 直近 update 時点の太陽 ECI 位置。sync の ECI 化(太陽中心→ECI)がここを読む
    │   │       └── cursor: number       ... ラウンドロビンの次回開始添字
    │   ├── AmbientLight / DirectionalLight / stars メッシュ ... 平行光は描画原点近傍の実スケール物体(自機・デブリ・薬莢)専用。天体は各自の CelestialSurface が sunDirection uniform を持って自分で陰影を計算するのでこの光を受けない
    │   ├── OrbitLine (geoLine)         ... 静止軌道の参照線(天体ではない特例、個別フィールドのまま)
    │   ├── referenceLines: ReadonlyMap<OrbitingId, OrbitLine> ... SOLAR_SYSTEM の公転天体ぶん自動生成(衛星=旧月線色、惑星=白)。天体の登録追加だけで線が増える
    │   └── CelestialGrid              ... 赤道面/黄道面それぞれの基準円・緯経線グリッド・両極マーカー
    ├── EffectsSystem
    │   └── FlashEffectManager
    │       └── FlashEffect[]          ... 各々 Billboard を持つ
    ├── Targeter
    │   ├── OrbitLine                  ... 第一ターゲット軌道線(オレンジ)
    │   ├── OrbitLine (secondaryOrbitLine) ... 第二ターゲット軌道線(シアン)
    │   └── ContextMenu<Enemy>         ... 第一/第二ターゲットの設定・解除メニュー。DOM は Hud.layers.popup 配下
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
    │   │   │   └── foldProxies (Record<side, RadiatorFold[]>) ... 側ごとの剛体接触用プロキシ。折り数まで
    │   │   │       遅延生成し以後使い回す。collisionFolds() が毎 substep 位置を置き直すだけで、
    │   │   │       Verlet 等の独立した力学は持たない(艦の姿勢+展開度から一意に決まる剛体の取り付け)
    │   │   ├── PowerSystem            ... 太陽電池の蓄電量。パネル法線は機体固定 (0,1,0)、可動部なし
    │   │   ├── ThrustEffects → Billboard ×2
    │   │   ├── RcsEffects    → Billboard ×8   ... 状態なし。ノズル1基につき1枚、配置は RCS_NOZZLES が正本
    │   │   ├── ReentryEffects → Billboard ×2   ... 状態なし。強度は毎フレーム qdyn から導く
    │   │   ├── PlayerMarkers          ... 方向マーカー・ボアサイト・マップ上の自機位置(操作対象の艦だけが sync する)
    │   │   ├── OrbitLine              ... 自機軌道線。中心天体は毎フレーム state から導出(strongestAttractor)。
    │   │   │                              表示抑制(setSuppressed)は Game.sync が PredictedTrajectoryLine.coversHorizon(この艦)から渡す(§付録参照)
    │   │   ├── Plan                   ... この艦自身のマニューバ計画(正本)。ノード列 + アンカー
    │   │   └── PlanExecutor           ... この艦自身の計画実行状態機械(正本)。CreativeStage が艦ごとに呼ぶだけで保持しない
    │   ├── Enemy[]                    ... 各々 OrbitLine を持つ
    │   ├── Bullet[]                    ... 各々コンストラクタで Sfx への参照を持つ(至近通過音を自分の checkLoss から鳴らすため)
    │   ├── DebrisPiece[] (casings)      ... 各々コンストラクタで Sfx・EffectsSystem への参照を持つ(接触音・ガスパフを自分の collideWith から出すため)
    │   ├── DebrisPiece[] (debris)       ... 同上
    │   ├── Ammo[]
    │   ├── Base[]                     ... 各々 baseState(money/inventory/dockedShips)と OrbitLine を持つ
    │   └── Asteroid[]                 ... 重力を及ぼし・受ける小天体。mass/radius はコンストラクタ引数から mu = G・mass を導いて固定。
    │                                       j2/c22 を渡した場合は degree2(pole/tesseral)も構築時に att から一括で固定
    ├── Simulator                      ... 実シミュレーション。EntityManager の参照を受け取って回すだけ(所有しない)
    │   └── ContactPhysics             ... 接触の検出(physics/sphere-contact.ts)・剛体解決(physics/collision-response.ts)を
    │                                       substep ごと(resolveSubstep)/フレームに1回のベルト(resolveBelt)で呼ぶ列挙・順序付け層
    └── Predictor                      ... 予測列の駆動。EntityManager の参照を受け取って回すだけ(所有しない)。
                                            状態はラウンドロビンのカーソルのみ
```

木に現れないインスタンス:

- 全ての `GameEntity`(Player・Enemy[]・Bullet[]・DebrisPiece[]・Ammo[]・Base[]・Asteroid[]・
  BeltSection[]・RadiatorFold[] — 木のどのノードも例外なく)は `id`(コンストラクタで固定。省略時は
  基底の `EntityIdAllocator` が自動採番)・`radius`(物理半径、既定 0)・`collides`(剛体接触参加可否、
  既定 false)・`mass`(剛体接触の換算質量、既定 1)・`attachedTo`(自分が取り付いている艦。独立した
  実体なら既定 `null` — `BeltSection`/`RadiatorFold` が構築時に自身の owner を設定する唯一の書き手で、
  以後書き換えない)・`mu`(重力定数 GM、既定 0)・`degree2`(2次重力場、既定 null)・`isStar`(既定 false)
  を自身のフィールドとして持つ — 変換なしで `physics/attractor.ts` の `Attractor` と同じ形になり、
  `EntityManager.attractors()` は `mu !== 0` かつ生存中の個体をフィルタするだけで済む。`degree2`/
  `isStar` は(`id`/`radius`/`collides`/`mu` と違い)`readonly` ではない派生クラス可変フィールドで、
  派生クラスが構築時に自分で組み立てる余地を残す。`GameEntity.setGravitatingMass(mass)` は質量から
  `mass`(剛体接触の換算質量)と `mu = GRAVITATIONAL_CONSTANT・mass` を同時に定める唯一の入口。
  `Asteroid` はこれを使って `mu` を、コンストラクタ引数の `radius` をそのまま `radius`/`collides=true`
  へ固定し、任意の `j2`/`c22` が非零なら自身の `att.q` から `degree2`(pole/tesseral)を構築時に
  1度だけ組む(§付録「正本でないもの」は参照しない — 導出は構築時の1回きり)。
- 全ての `GameEntity`(Player・Enemy[]・Bullet[]・DebrisPiece[]・Ammo[]・BeltSection[] — 木の
  どのノードも例外なく)は `physics/dynamic-trajectory.ts` の `DynamicTrajectory` を1本、フィールド名
  `actualTrajectory` で保持する(state/history/prevState の正本)。GameEntity ごとに繰り返さず
  ここに一括で記す。`DynamicTrajectory` 自身は軌道要素を持たない — `GameEntity.orbitalElementsAround(center)` が
  `state` の参照同一性 + `center.id` でメモ化する(§付録「正本でないもの」参照。中心天体 `center` は
  呼び出し側が都度選ぶので `DynamicTrajectory`/`GameEntity` の状態ではない)。`predictsFuture = true` の
  GameEntity(Ship・Ammo のみ)は、`Predictor` が
  `stepPredicted` を呼んだ時点で2本目の `DynamicTrajectory` を `predictedTrajectory` として追加で持つ
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
| `MarkerManager` | Game | マーカーを出す全モジュール(GroupedMarkers・LeadMarkers・EquatorNodeMarkers・PlayerMarkers・Targeter・NavTarget・Logistics・FocusMarkers・PlanGuide・PlanDisplay) |
| `Ephemeris` | Game | EnvironmentScene・Simulator・OverviewCamera・FocusMarkers・NavTarget・PlanEditor(→PlanDisplay) |
| `CameraSystem.bodyClassToggles`(`BodyClassToggles`) | CameraSystem | MAP VIEW パネルが書き換え、ラベル側を `FocusMarkers.update`、軌道線側を `EnvironmentScene.showsReferenceLine` が読む。マップのラベル・配置UIの基準天体が同じ1つの状態を共有するための唯一の持ち主(軌道オブジェクト一覧はこれを経由しない、下記 `FocusMarkers.allBodyPickables` を参照)。初期値は `localStorage`(`tepui.bodyClassToggles`)から読み込み(`camera-system.ts` の `loadBodyClassToggles`)、トグルのたびに `saveBodyClassToggles` で書き戻す(同上) || `EntityManager` | Game | Simulator(コンストラクタ引数、配列を直接持たず参照だけ回す)・ContactPhysics(`Simulator.advance` が呼び出しのたびに参照を渡すだけで保持しない)・Targeter・NavTarget・Enemy.behave・Stage/stages/・Logistics・EffectsSystem・NanWatchdog(いずれも読み取り + `addXxx`/`findPlayer`/`findEnemy` 経由の追加・参照のみ)。`attractors()` は毎回のフィルタ呼び出しで正本を持たない(§付録「正本でないもの」) |
| `PlanPath` | PlanDisplay | PlanEditor(ノードの画面判定 `projectPoint` / `nearestSample` のみ、`planDisplay.path` 経由) |
| `DisplayTimeManager` | Game | PlanEditor(→PlanDisplay)(コンストラクタ引数で `PlanDisplay` → `PlanPath` へそのまま転送。末尾区間の長さ(`plan.ts` の `segmentDurationFrom`)と `Plan.nodeTimeRange` の上限が表示時刻パネルの選択に追従するための参照で、`PlanPath` はこれを保持するだけで書き換えない) |
| `Plan`(活艦の) | `Player`(活艦自身、`PlanEditor` ではない) | PlanEditor(`plan` getter が activePlayer.plan を転送)・PlanDisplay(`sync` の引数で毎フレーム)・PlanGuide(同)・CreativeStage(`planExecution` 艦のノード消化) |
| `PlanExecutor`(艦ごとの) | `Player`(艦自身) | CreativeStage(`update`/`nextSimulationEventTime`/`applySimulationEvents` から呼ぶだけで保持しない) |
| `SimSpeedManager` | Game | PlanEditor(ノードメニューからの自動ワープ) |
| `EffectsSystem` | Game | Player・PlayerFire・Enemy・Stage |
| `Player` / `Simulator` / `EntityManager` / `Stage` | Game | 毎フレームの引数として相互に渡される |
| `UnlockManager` | main.ts | ステージセレクト画面と、各Stage（クリア後画面判定のため） |
| `SnapshotService` | main.ts | Game(コンストラクタ引数で受け取り、`clipSnapshot` から呼ぶ)・AutoSave(コンストラクタ引数)・SaveBrowser(コンストラクタ引数) |
| `SaveSlots` | main.ts | SnapshotService(コンストラクタ引数)・SaveBrowser(コンストラクタ引数) |
| `SaveBrowser` | main.ts | Game(`setSaveBrowser` で受け取った参照。`handleInput` が `[F9]` と一覧表示中の `[Esc]` で `open()`/`close()` を呼ぶだけ) |
| `FocusMarkers.allBodyPickables(t)` の戻り値 | CameraSystem(→FocusMarkers、呼ぶたびに作り直す使い捨て配列) | `MapPicker.refresh()` が読んで生存中の自機・敵船・弾薬・基地・NavTarget のアイコン・`PlanDisplay.apsisMarkers` と合流させ、`MapPicker.handleRightClick`(`pickNearest`)/`OverviewCamera.update` の被選択物候補として渡し直す。MAP VIEW トグルを経由しない全登録天体+全ラグランジュ点 |
| `FocusMarkers.allLabels` | CameraSystem(→FocusMarkers、構築時に1度だけ) | `MapPicker.sync()` が id/isLagrange から親子関係(parentOf)を組むのに読む |
| `PlanDisplay.apsisMarkers` | PlanEditor(→PlanDisplay) | `MapPicker.refresh()` が他の候補と合流させ、`MapPicker.handleRightClick`/`OverviewCamera.update` へ1本の候補列として渡す |

---

## 3. 状態の正本

| 状態 | 正本の所有者 | 備考 |
| --- | --- | --- |
| 自機の位置・速度・エポック (ECI) | `Player.state` | 書き換えるのは RK4 積分(Simulator)・反動(PlayerFire)・接触(ContactPhysics) |
| エンティティの過去 state 列(`StateQueue`) | `GameEntity.history`(→ `current.history`) | 記録するのは `DynamicTrajectory.step` だけ。時間窓は `historyDuration`(既定 0、Ship のみ `SHIP_HISTORY_DURATION`)、間引き間隔は `sampleInterval()`(軌道周期ベース)で `cleanup` に渡す |
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
| 天球グリッド6トグルの可視状態 | `Navball` | `gridVisibility`。`Game.sync` が `navball.gridVisibility` を読んで `EnvironmentScene.sync` の引数(`gridVisibility`)経由で `CelestialGrid.sync` へ渡すだけで、`CelestialGrid` 自身は状態を持たない。初期値は `localStorage`(`tepui.gridVisibility`)から読み込み(`navball.ts` の `loadGridVisibility`)、トグルのたびに `saveGridVisibility` で書き戻す——`UnlockManager`/`tepui.clearCounts` と同じ形だが、正本はこのフィールド自身のまま |
| Δv アーム/ボタンのホールド継続時間・ラッチ状態 | `PlanEditor.dvHoldTime` / `NodeGizmo.latch` | 6方向ぶんの経過秒数(ホールドレートのランプに使う)と、ドラッグがラッチへ入った軸/超過量。加算そのものは `PlanEditor.applyDv` に一本化 |
| NaN 検出済みフラグ | `NanWatchdog`(Game 所有) | 一度検出したら以後の検査を止める |
| マニューバ計画(ノード列・アンカー) | `Plan` | 所有は各 `Player`(艦ごとに1個。`PlanEditor.plan` は活艦のものを転送する getter)。ノード・アンカーとも 1 個の `KinematicState`(実行時刻 = `t`、Δv は導出値)。ノード列は `KinematicState[]` を1本持つだけで、`addNode` が挿入位置より後ろを破棄してから push するため常に実行時刻順。`consumeNodesUpTo(t, actualState)` は実行時刻が `t` 以前のノードをまとめて取り除き、取り除いた件数を返すとともに、`anchor` を `actualState`(実際に到達した状態)へ**後続ノードの有無によらず無条件に**差し替える — 呼ぶのは `PlanGuide.update`・`PlanExecutor.finish`・`CreativeStage.applySimulationEvents` の3か所だけで、動力飛行の残差を消さずに以降の計画へ残すのがこの無条件差し替えの目的。`addNode` は `anchor.t` 以前の状態を受け付けず `-1` を返す |
| 操作対象(アクティブ)艦 | `Game.player` | 唯一の書き換え箇所は `Game.setActivePlayer(ship)`。カメラ参照・計画編集対象・ターゲット解除の副作用もすべてここに閉じる(下記「たまたま同時に切り替わる」節参照) |
| 軌道計画の実行モード | `Player.planExecution`(型 `PlanExecutionMode` = `'off' \| 'instant' \| 'powered'` は `plan/plan-executor.ts` が定義し `player.ts` は re-export するだけ) | 全ての自機が持つ(既定 `'off'`)。`'instant'` は `CreativeStage.applySimulationEvents` がノード時刻ちょうどで `state` をノードの絶対状態へ置き換え、`'powered'` は `PlanExecutor` が姿勢制御・噴射で実行する。操作対象艦での手動並進(`this.thrust !== null`)・手動回転(`throttle.hasManualRotationInput`)は `Player.behave` が `'powered'` を `'off'` へ落とす |
| PlanExecutor の状態機械(`phase`/`targetNode`/`burnDirWorld`/`burnUpWorld`/`pendingAccel`) | `PlanExecutor`(艦ごとの) | 艦の `planExecution`/ノード/生死/ゲートから毎フレーム `update` が導出。`targetNode` はノードの**参照**を持ち、`node.t` ではなく `node !== targetNode` で差し替わりを検出する(`Plan.applyNodeDv`/`replaceNode` は同じ `t` のまま新しいオブジェクトへ差し替えるため)。噴射ゲート(`simSpeed.canPlayerThrust`)は保持せず、`update`/`applyIgnitionAndCutoff`/`nextEventTime` が各自引数で受け取る。`ship.torque`/`ship.thrust`/`ship.plan` は `PlanExecutor` が唯一書き換える(`'powered'` の間のみ)が、書き込みは `update`(毎フレーム、`Player.behave` の後)と `applyIgnitionAndCutoff`(simTime イベント境界ごと)の両方から起きる — 前者は「操作艦で `behave` が毎フレーム上書きする `thrust` を、その後で確実に正しい値へ戻す」役、後者は「点火・遮断の瞬間を simTime ちょうどに固定する」役で、互いの代わりにはならない |
| 選択中ノード・計画編集モード | `PlanEditor.selectedNode` / `.editMode` | 選択の正本はノード(`KinematicState`)そのものへの**参照**。`selectedNodeIdx` は `plan.nodes` から同一性で引き直す get/set のみで、列から消えたノード(削除・下流の切り捨て・消化)は自動的に「未選択」になる |
| 直近ノードの接近/達成通知済み | `PlanGuide`(`approachNotified` / `achievedNotified`) | 通知済みのノードそのものへの参照。編集のたびノードは別インスタンスへ置き換わるので、同一性比較がそのまま「同じノードについて通知済みか」の判定になる |
| 予測表示期間(手動レンジの秒数 `manualDurationSec` を含む)・未来ゴーストスライダー(`sliderT`)・未来表示の禁止(`forceCurrent`) | `DisplayTimeManager` | `forceCurrent` は get/set アクセサで、true をセットすると `sliderT` も 0 へ戻す。期間の切替(`durationKey` 変更)でも同様に `sliderT` を 0 へ戻す |
| 計画折れ線を描く表示座標系(planFrame) | `PlanDisplay` | `OverviewCamera.cameraFrame`(視点固定座標系)とは別の正本。書き換えは `FrameControls` の軌道計画区画の中心/回転ゾーンのみ、いずれも `Ephemeris.frameOf(center, rotatingWith)` 経由 |
| マップ視点(注視点相対オフセット・パン・上方向)・座標系(cameraFrame)・フォーカス(FocusTarget)・Viewpoint | `OverviewCamera` | `viewpoint: Viewpoint` は `CombatCameraSystem` と同じ形。`CameraSystem` はこの `viewpoint` を読むだけで自分では持たない。フォーカスは `camera/focus-target.ts` の `FocusTarget`(`{kind:'object', id}` または `{kind:'point', frame, point}`)で、`{kind:'object'}` が指す実位置は `OverviewCamera` が持たず、`update` の引数(`MapPicker.refresh()`)から毎フレーム引き直す。書き換えは `setFocusTarget`/`setCameraRotation` のみ、いずれも `FrameControls` のカメラ区画の中心/回転ゾーンから呼ばれる |
| 戦闘視点(Viewpoint: position/lookTarget/up/fovDeg/aspect)・照準ズーム中か(zoomActive) | `CombatCameraSystem` | rot(クオータニオン)/dist・姿勢追従フラグ(camFollowAttitude)は内部の `ChaseCamera` が持つ。zoomActive はこのクラス自身の `update` が `Input` から読んで保持する |
| 現在のビュー(combat/map/dock) | `ViewManager`(private `_current`) | 遷移は `setView()` のみ。影響先(`CameraSystem.overviewMode` / `PlanEditor.editMode` / `DisplayTimeManager.forceCurrent` / タッチUI)を一斉に切り替える。ドック表示中は背後の 3D 側ビュー(`returnFromDock`)を保持し、閉じるとそこへ戻る |
| ドックビューの対象基地 | `Docking`(private `_activeBase`) | 基地の右クリックメニューで設定。これが空でない間だけ `ViewManager.selectableViews()` に `'dock'` が並ぶ |
| マップモード表示 | `CameraSystem.overviewMode` | 描画・視点側の分岐はこれを見る。`CameraSystem.zoomActive` は `!overviewMode && combatCamera.zoomActive` を返すだけの派生 getter(状態は持たない) |
| 開いているプロパティウィンドウの集合・一時ウィンドウのキー | `MapPicker`(`windows`/`tempWindowKey`) | キーは `` `${kind}:${id}` ``。`openPropertyWindow` が新規/移動を判断し、`closeWindow`/`forgetWindow` が畳む。個々の `PropertyWindow` インスタンス自身はクリップ状態(`clipped`)とドラッグ位置だけを持ち、開閉のポリシー(いつ閉じるか)は持たない — クリップ状態が変わったこと自体は `onClipChange` で `MapPicker` に通知し、`tempWindowKey` の付け替えは通知を受けた `MapPicker` 側が行う |
| 第一・第二ターゲット・的通過マーク | `Targeter`(`target`/`secondaryTarget`) | 右クリックメニュー(`applyMenuAct`)でのみ変わる。自動選定・自動再選択はない |
| 航法ターゲット(id)・相対 AN/DN | `NavTarget` | `update()` が自機軌道要素 + `Ephemeris` から毎フレーム再算出する導出値だが、対象の id 自体(`toggleTarget` で変わる)は正本 |
| 勝敗フェーズ | `Stage`(private `_phase`) | 変更は Stage 自身のみ。外部は `phase`/`isPlaying` を読む |
| 発射数・命中数・撃破数・出撃数 | `ScoreCounter` | 所有は Stage |
| 補給の投入間隔タイマー | `Logistics` | 投入できない間は進めない(再開直後のフレームで判定させるため) |
| 補給の自動投入の可否 | `Logistics.resupplyEnabled` | 書き換えは CreativeStage の LOGISTICS パネルのトグルのみ。ワープ倍率による停止は `SimSpeedManager.canResupplyAmmo` が別途担い、両者の積で投入可否が決まる |
| ウェーブフェーズ・波数 | `Stage00`(自身のフィールド) | |
| 残り時間 | `ScoreAttackTimer`(Stage0) | |
| ステージクリア回数 | **localStorage**(`tepui.clearCounts`) | UnlockManager はその読み書き窓口。インスタンスは正本ではない |
| ポーズ | `Game.paused` | 駆動源は `SettingsPanel.onSettingsOpenChange` と `SaveBrowser.open()`/`close()` の2つ。どちらもシステム窓で、開いている間だけ止める |
| スナップショット一覧の表示状態 | `SaveBrowser`(private `_visible`) | `open()`/`close()` のみが書き換える。毎フレーム sync は持たず、操作のたびに自分で DOM を作り直す一発モーダル |
| 一時エフェクト(フラッシュ)の配列 | `FlashEffectManager.effects` | 各要素は位置を時刻つきの `KinematicState` で持ち、`updateFlashEffects` がその時刻から `simTime` まで移流させる |
| 地球自転の初期位相 | `EarthBody.phase0` | `spinPhase0()`/`setSpinPhase0()` で読み書き可能。セーブ/ロードは `GameSaveData.earthSpinPhase0`(`EnvironmentScene.earthSpinPhase0()`/`setEarthSpinPhase0()` 経由、`Game.restore` が値のある場合だけ書き戻す) |
| 各天体の平均黄経の初期位相 | `Ephemeris`(`phaseOffsets`) | 時刻を引数に取るサンプラ。既定で乱数を持つのは月のみ。時刻 `t` 完全一致キーの3スロットのリングキャッシュ(`planetHelioState`/`satelliteRelState`/`attractorsAt`)を持ち、ヒットしない呼び出しだけ天体暦の合成をやり直す。セーブ/ロードは `getPhaseOffsets()`/`setPhaseOffsets()` で読み書きする(`Game.restore` が共有インスタンスへ書き戻す。インスタンスの作り直しはしない。`setPhaseOffsets` は3系統のキャッシュを全てクリアする) |
| `registry`/`originId`/`epochOffsetSec` | `Ephemeris`(コンストラクタ引数、以後不変) | どのステージも既定値(`SOLAR_SYSTEM`/`'earth'`/`EPOCH_T_OFFSET`)を渡すが、`StageClass.ephemerisConfig` を宣言したステージだけ `Game` が別の値を渡して構築する。`starId`/`inertialFrame`/`frames`(登録天体ぶんの `ReferenceFrame` 一覧)もこの3引数からコンストラクタが1回だけ導出する正本(いずれも下記 `frameCache` を経由して作る) |
| `frameCache`(`Map<AttractorId, Map<OrbitingId \| null, ReferenceFrame>>`) | `Ephemeris`(`frameOf` 経由) | `(center, rotatingWith)` の対ごとに `ReferenceFrame` を1個だけ持つ、実行時に伸びる正本。レジストリ登録の有無を問わない(生存中の重力天体を中心にする回転系にも同じ契約で応じる)。`inertialFrame`/`frames`/`frameFor` はすべてこのキャッシュを経由して作られた値を返すので、同じ対に対して異なる参照が生まれない(`sampled-line.ts` の `frame === lastFrame` 参照同一性契約を満たすためのもの) |
| 入力スナップショット(押下キー・クリック・マウス移動量) | `Input` | フレーム確定は `update()` の1回だけ。エッジは `takeKey`/`takeKeys`/`takeClicks`/`takeRightClicks` で**先着順に消費**され、処理した側より後ろのモジュールには届かない |
| 敵 AI の実行時状態(最終発砲時刻・バースト残数) | `Enemy` | |
| LEAD マーカーの表示履歴(敵ごとの最終ロック時刻) | `LeadMarkers` | 表示専用の状態なので Enemy には置かない。毎フレーム生存中の敵ぶんだけ作り直す |
| EqAN/EqDN アイコン(source ごとの位置・通過時刻) | `EquatorNodeMarkers.pairs` | update が求め直す。source 列自体は `Game.equatorNodeSources()` が毎フレーム組み、このクラスには保持しない |
| マーカー DOM 要素のプール | `MarkerManager` | キーで索引。`GroupedMarkers`/`LeadMarkers` は自分が前フレームに出したキーを覚えていて、集合から消えたものを hide する。`EquatorNodeMarkers` は対象の増減でキー集合自体が変わるので remove する |

### 正本が分かれていることに意味がある組み合わせ

- **`CameraSystem.overviewMode`(視点)・`PlanEditor.editMode`(操作系)・`DisplayTimeManager.forceCurrent`
  (未来表示の禁止)** は3つとも別の正本。同時に切り替えるのは `ViewManager` だけで、描画・視点側は
  overviewMode を、発射可否(`fire.tickMapMode` か `updateFireState` か)は editMode を、未来表示の可否は
  forceCurrent を見る。実噴射(WASDQE)の可否はさらに一段細かく、`Game` が組む
  `dvEditActive = editor.editMode && editor.selectedNodeIdx !== null` を `Player.behave` が見る —
  マップビューが開いていても選択中ノードが無ければ実噴射が効く。手動回転(RCS・IJKLUO)はこの
  いずれも見ず、マップビュー中でも常時有効。
  「いまどのビューか」そのものの正本は第四の値 `ViewManager.current` で、上の三つ
  (とタッチUI)はその影響先。
- **`FloatingOrigin.r`** の正本はアクティブカメラの ECI 位置(`CameraSystem.activeCameraPos`)であり、
  `Player.state.r` とは別物 — 戦闘ビューではチェイスカメラが自機から数十mしか離れないため近い値に
  なるだけ。sync 系は必ず fo を参照し、`player.state.r`/カメラ位置を描画原点として直接使わない。
- **`Game.player`(操作対象艦)・`ChaseCamera.player`(追従カメラの基準)・`PlanEditor.activePlayer`(計画編集の対象)・
  `Targeter` のロック** は艦を切り替えるたびに揃える必要がある4箇所。同時に切り替えるのは
  `Game.setActivePlayer` だけで、他はそれぞれ自分の持ち分(視点/編集対象/ロック解除)だけを更新する
  — `ViewManager` が3つのフラグを一斉に切り替えるのと同じ形のトグラー集約。
- **`OverviewCamera.cameraFrame`(視点を固定する座標系)と `PlanDisplay.planFrame`(計画折れ線を
  描く座標系)** は別の正本で、ユーザーが `FrameControls` の2区画×(中心・回転)の
  4ゾーンからそれぞれ独立に選ぶ — 4ゾーンとも状態は書き込み先の2クラスに残したまま `FrameControls` は
  仲介するだけなので、この独立性自体はゾーンの分割で変わらない。両者を連動させるかどうかだけが
  `FrameControls` 自身の状態(`followCamera`)で、有効なあいだフォーカス移動が planFrame の中心も動かす。
  PlanPath が受け取るのは後者だけ。
- **`Targeter.target`(戦闘ターゲット、`Enemy` のみ)と `NavTarget.id`(航法ターゲット、任意の `MapPickable`)**
  は別の正本。前者は射撃・LEAD・的通過マークの対象、後者はマップの相対 AN/DN・時間加速・ノード追加の
  対象で、対象の型も操作系(右クリック位置がヒットしたのが敵かそれ以外か)も異なるため一本化しない。
- **マップモードの操作パネル**は状態の所有者ごとに分かれる。`OverviewCameraPanel`(天体クラス別トグル・
  弾薬トグル)は CameraSystem が、`DisplayTimePanel`(期間・未来位置スライダー)は DisplayTimeManager が
  持ち、それぞれ自分の状態だけを映して自分の状態だけを受け取る。座標系パネル(FrameControls)だけは
  例外で、状態を持たず `OverviewCamera` と `PlanDisplay.planFrame` という別々の所有者へ4ゾーンから
  書き込む横断モジュール(上記「同時に切り替わる」節参照)。表示・非表示も各所有者が毎フレームの
  sync で押し出す(ViewManager は関与しない)。
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
  **1つの対象では決められない3つだけ** — `GroupedMarkers`(画面上のまとめ)、`LeadMarkers`(自機と敵の
  両方に依存)、`EquatorNodeMarkers`(操作艦・navTarget・targeter という複数の役割にまたがる source 列
  に依存)。`Enemy` は自分の見た目とラベルを `markerItem()` で渡すだけで、まとめの判断には関与しない。
- **`EntityManager.players` は他の配列と対等に `all()` へ入る** — 操作対象かどうかは `Game.player` との
  参照同一性だけで決まる選択であり、`players` 配列自体はアクティブ/非アクティブを区別しない。
  積分(`Simulator.substep`/`.stepAttitudes`)・寿命判定(`EntityManager.cleanup`)・
  剛体接触(`ContactPhysics.resolveSubstep`)はどの艦も一様に扱う。例外は2つだけ: `EntityManager.sync` は
  `players` を丸ごと素通りする(各艦は `Player.syncPlayer` が個別に同期する)。`Predictor.update` は
  `player` 引数を先頭で明示的に一度予算消化してから `entities.all()`(`players` を含む)を
  ラウンドロビンするので、カーソルが操作対象の艦に当たったフレームは二重に予算が付き得る(意図的)。

---

## 付録: 正本でないもの(混同しやすいもの)

所有関係として数えないが、正本と間違えやすいもの。**これらを書き換えてもゲーム状態は変わらない**
(逆に、正本を変えたときに無効化が必要になる)。

| 対象 | 正体 | 無効化の契機 |
| --- | --- | --- |
| `Ephemeris.attractorsAt(t)` の戻り値(`Attractor[]`) | 天体暦(`SOLAR_SYSTEM` 登録順 — 地球・月・水星・金星・火星・フォボス・ダイモス・木星・メティス・アドラステア・アマルテア・テーベ・イオ・エウロパ・ガニメデ・カリスト・ヒマリア・エララ・アナンケ・カルメ・パシファエ・シノーペ・土星・パン・ダフニス・プロメテウス・パンドラ・エピメテウス・ヤヌス・ミマス・エンケラドゥス・テティス・ディオネ・レア・タイタン・ヒペリオン・イアペトゥス・フェーベ・天王星・海王星・トリトン・ネレイド・ケレス・ベスタ・パラス・冥王星・ハウメア・マケマケ・エリス・ハレー彗星・エンケ彗星・太陽周回小天体32体・天王星系6衛星・冥王星系5衛星・準惑星/小惑星の衛星6体・太陽の101体)から組み立てる重力源スナップショット。各要素は位置・速度に加えて、その時刻に解決した2次重力場(`degree2`: J2・基準半径・自転軸・長軸。持たない天体は `null`)も抱える。全天体を含む唯一の窓で、重力積分の3箇所(`GameEntity.stepActual`・`Predictor.advanceBudget`・`PlanArc` の積分刻み)も遮蔽判定・表面到達判定・中心天体解決・サンプリング間隔導出・HUD/マーカー等も同じこの窓を使う(`mu = 0` の天体は寄与がゼロなので積分側で除外する必要が無い)。どのクラスもこれを状態として保持しない — 呼んだその場で使い切るか、次のステップ/フレームでまた引き直す。`Ephemeris` は時刻 `t` 完全一致キーのリングキャッシュを持ち、同一 `t` への呼び出しは同一の配列参照を返す(呼び出し側は書き換え禁止) | 呼び出しごとに新しい `t` を渡せば作り直される(リングキャッシュがヒットしない場合のみ再計算)。`setPhaseOffsets` は全キャッシュを明示的にクリアする |
| `OrbitalElements.center`(`Attractor`) | その軌道要素をどの天体まわりで取ったか。要素と同じ寿命でその天体の `t` 時点スナップショットを抱えるので、要素そのものより長く持ち回してはならない(`OrbitLine` は楕円の平行移動先をここから引く) | 要素を作り直すたび。`GameEntity.orbitalElementsAround` のメモ経由なら `state` 差し替えのたび |
| 解析楕円の中心天体(`strongestAttractor(state.r, attractors)` の結果) | `state`(と `attractors`)から都度導く選択であり、`GameEntity`/`Plan`/`PlanDisplay`/`OrbitLine` のどれもこれを状態として保持しない — 選ぶ GUI もない | 呼ぶたび再計算 |
| `GameEntity.orbitalElementsAround(center)` の内部メモ | `state` の参照同一性 + `center.id` をキーにした軌道要素のメモ化(中心天体 `center` は呼び出し側が選ぶ) | `state` が差し替わるたび(`current.step`/`.reset`)、または `center.id` が変わるたび自動的に不一致になる |
| `GameEntity.prevState`(→ `current.prevState`) | 直前の `step`/`reset` 時点の state を持つ専用フィールド(`history` とは別) | `step`/`reset` のたび更新 |
| `GameEntity.predictedTrajectory` | `actualTrajectory.state` + ephemeris から `Predictor` が漸進的に構築する未来軌道のキャッシュ(`predictsFuture = false` のクラスでは常に null)。伸ばす長さ(horizon)は `DisplayTimeManager.durationSec(referencePeriod)` の毎フレーム値で、`GameEntity`/`Predictor` のどちらにも独立した状態としては残らない | `discardPredictionIfDiverged` の距離判定(§3-4 (a))、または `Player.behave` の推力確定直後(§3-4 (b))。無効化は破棄のみで即再構築はしない — 次フレーム以降の通常の予算配分で伸び直す |
| `SimSpeedManager.canResupplyAmmo` | `simSpeed < C.MAX_PHYS_SIM_SPEED` の派生 getter(他の can* より1段厳しく等倍限定) | 呼ぶたび再計算 |
| `OrbitLine.snap` / 頂点配列 / `lastExclude` | 楕円ジオメトリの再生成判定用スナップショットと、フェード帯の再計算判定用の直近の除外天体(離心近点角・半径) | 要素ドリフト・`force`・初回。フェードは帯の境界が頂点間隔ぶん動いたときだけ焼き直す |
| `SampledLine.bakedScale` / `lastSamples` / `lastFrame` | 頂点を焼き直すかの判定に使う直近の bake 入力。スケールは点列**先頭**のサンプルで1回だけ評価した数値(列が伸びても動かない点なので、カメラが静止していれば値も動かない) | 点列の参照・座標系・スケール(`SCALE_REBAKE_RATIO` 幅)のいずれかが変わったとき |
| `DynamicTrajectory.sampleInterval` | 直近の `step` に渡された間引き間隔。列がどれだけ粗いかという列自身の属性で、`GameEntity.divergenceTolerance` が乖離判定の許容量をここから引く(現在の表示期間から引くと、期間を縮めた瞬間に既存の粗い列を破棄し続ける) | `step` のたび |
| `FocusMarkers.hiddenLabelIds` | 直近の `syncLabels` でマーカーを描かなかったラベル id(ラベル衝突・天体による遮蔽)。`allBodyPickables` が候補の `pickable` に映すだけで、候補からは落とさない | `syncLabels` のたび(マップ非表示時は空集合) |
| 自機 `OrbitLine` の表示抑制(`setSuppressed` の引数) | `PredictedTrajectoryLine.coversHorizon(player, simTime, horizon)` から導く真偽値。予測が表示範囲を覆いきるまでは解析楕円を代替表示として残すための調整で、`OrbitLine` 自身はこの理由を持たない | `Game.sync` が毎フレーム渡し直す |
| `PlanArc.samples` / `.key`(`{state0, end, sourceRevision, apsisCenterId}` — 結果に効く入力をすべて含む。基準天体が変われば極値も変わるので `apsisCenterId` も鍵の一部) | 予測 RK4(`DynamicTrajectory` 積分)の結果と入力スナップショット | `update` の `tracksLiveAnchor` 引数(計画が空の間の唯一の区間だけ true)が false なら `state0`/`end` の同一性・値の変化。true なら区間長・起点時刻とも直近再積分時からの変化がサンプル間隔(区間長 / `PLAN_ARC_MAX_SAMPLES`)未満の間は無効化しない(`'orbit'` プリセットでは起点の接触周期自体が J2・大気抵抗で毎フレーム連続変化するため、厳密一致ではなくこの閾値で判定する)——ただし `state0` の同一性が変わっていて `t` が前進していない(別艦への切り替え・ドック発進・衝突による状態上書きなどの非連続な差し替え)場合はこの閾値を無視して即座に無効化する |
| `PlanArc.periapsisState` / `.apoapsisState` | 同じ積分ループの中で、`apsisCenter`(呼び出し側が渡す基準天体。末尾区間以外は null で検出自体を省く)に対して `physics/trajectory-features.ts` の `apsisCrossing` をステップ対ごとに掛けた結果、最初に見つかった近地点・遠地点(それぞれ独立)。折れ線サンプルではなく積分の生ステップ対から求めるので、衝突コースで動径速度が符号反転しない区間は近地点側が null のまま残る | `integrate()` の呼び出しごとに null へリセットして最初の1回のみ確定(`.samples`/`.key` と同じ再積分条件) |
| `PlanPath.arcs` / `.activeCount` / `.nodeCount` / `.frame` / `.unbakeTime` / `.project` | 毎フレーム再構築される区間分割と表示文脈(画面判定もこれを使う)。`arcs` は先頭 `activeCount` 本だけがこのフレームの区間に対応するプール、先頭 `nodeCount` 本がノードで終わる区間 | `update()` 毎 |
| `PlanPath.finalSegment()`(private `final`) | 末尾区間(次のバーンが無い区間)の `state0` / `samples`(`PlanArc.samples` の同じ配列参照をそのまま公開 — 新しい配列を作り直すと `SampledLine.syncGeometry` の参照同一性による再bake抑制が効かなくなる)/ 同じ末尾 arc の `periapsisState`/`apoapsisState` をそのまま転送した `periapsis`/`apoapsis`。`PlanDisplay` の Pe/Ap アイコンは後者2つを直接読む。`samples` は `Game.equatorNodeSources` が渡す自艦の EqAN/EqDN 走査元 | `update()` 毎(`update()` を一度も通していなければ null) |
| `PlanPath.cameraPos` / `NavTarget.attractors` / `EquatorNodeMarkers.attractors` / `PlanDisplay.attractors` | マップビューの遮蔽判定(`physics/occlusion.ts` の `isOccluded`)向けに、直近の `sync`/`update` が受け取ったカメラ位置・`Attractor[]` を引き継ぐだけのキャッシュ。`PlanPath.cameraPos` は `nearestSample` が DOM ポインタイベント起点でフレーム外から呼ばれるために要る | 次の `sync`/`update` で上書き |
| `SampledLine.lastSamples` / `.lastFrame` / `.bakedScale` | bake 済み頂点の入力スナップショット(`bakedScale` は点列先頭のサンプルで評価した画面スケール) | 点列・frame の変化、または `bakedScale` から `SCALE_REBAKE_RATIO` 以上動いた画面スケールの変化 |
| `EntityLineSet.lines`(`Map<GameEntity, SampledLine>`。`DebugTrajectoryLine`/`PredictedTrajectoryLine` がそれぞれ private に1つ持つ) | エンティティごとに `SampledLine` を1本対応させるプールと、対象集合から外れた分の破棄だけを担う共通機構。線の見た目(色・不透明度・renderOrder)は各所有者がコンストラクタへ渡す `factory` が決めるので、このクラス自身は知らない(`DebugTrajectoryLine` の分は `?debugLines=1` のときだけ実体化) | 対象集合(`sync` の引数)から外れたエンティティぶんを毎フレーム破棄 |
| `PlanPath.arrivalStates()` / `PlanEditor.nodeDv()` | 各区間の `PlanArc` 終端状態、およびそこから求めるノード Δv の導出値(表示専用) | 呼ぶたび再計算(`PlanArc` 側の積分結果をそのまま読むので、描画中の計画軌道と同じ結果になる) |
| `PlayerThrottle.thrustAccelVec` | ベルト物理(`Belt.update`)向けの推力加速度ベクトル | 毎フレーム上書き。プルーム・エンジン音は `ThrustEffects.sync` が `ship.thrust`(`GameEntity` 側、`PlayerThrottle`/`PlanExecutor` どちらが書いても同じ)を直接読むので、ここには含まれない |
| `Player` の各 getter(`rcsDamp` / `magsLeft` 等) | throttle/fire への転送 | — |
| `FocusMarkers` 内部の `shownLabels[].pos`(マップの描画マーカー用、private) | 天体暦から毎フレーム再計算。ただし `visibleBodyIds` が admits した天体だけ — 対象外の天体は座標を引かない | `update(t, focusId, toggles)` 毎(`syncLabels()` はこの値をマーカーへ置くだけ) |
| `NavTarget` の相対 AN/DN 位置・通過時刻 | 自機軌道要素 + 対象の軌道面法線からの導出値(id 自体は正本) | `update()` 毎に全消去→再算出 |
| `CreativeStage.preview`(軌道要素 + 位置) | 艦艇配置フォームの現在値からの導出値(正本はフォームの DOM) | `update()` 毎に再算出。パネルを閉じている間・値を解釈できないときは null |
| `CreativeStage.issues`(`PlacementFieldIssue[]`) | 艦艇配置フォームの現在値からの導出値(正本はフォームの DOM。centerRadius/mu は `Ephemeris` から引く) | `update()` 毎に再算出、`sync()` で `ShipPlacerPanel.setIssues()` へ push。パネルを閉じている間は空配列 |
| `PlanDisplay.apsisMarkers` / アイコン位置 | `path.finalSegment()` の `periapsis`/`apoapsis`(末尾 `PlanArc` が積分中に検出した値)を読み、各点ごとに `strongestAttractor` で中心天体を引き直して距離・高度を出した導出値(軌道要素からの解析的な導出ではない — エポック依存の値だと Δv=0 のノード追加でも動いてしまうため) | `apsisIconsOf()` 毎(`update()` から呼ぶ) |
| `EquatorNodeMarkers` の自艦ぶんの EqAN/EqDN 位置 | `EqNodeSource.samples`(`Game.equatorNodeSources` が `PlanPath.finalSegment()` の `samples` を渡す)を `findEquatorCrossings` で走査した導出値。それ以外の source(敵・基地・航法ターゲット)は従来どおり軌道要素からの解析的な導出値 | `update()` 毎 || `MapPicker.pickables` | `FocusMarkers.allBodyPickables(displayTime)`(全登録天体+全ラグランジュ点、MAP VIEW トグルを経由しない) + 生存中の全 `entities.players`・敵船・弾薬・基地の displayState + `NavTarget.mapPickables()` + `PlanDisplay.apsisMarkers` + `EquatorNodeMarkers.mapPickables()` の合成(保持しない使い捨て配列) | `mapPicker.refresh()`(`update()` 内、経路ごとの `cameraSystem.update()` 直前)毎に作り直す |

### 基礎データ型の不変性(整合性の前提)

`Vec3` / `KinematicState` / `Quat` / `Attitude` は **不変**。値を進めるときは中身を書き換えず、
新しいオブジェクトを作って差し替える(`stepRK4` は新しい `KinematicState` を、`stepAttitude` は
新しい `Attitude` を返す)。これは最適化ではなく整合性の前提で、`physics/dynamic-trajectory.ts` の
`DynamicTrajectory`(`GameEntity.actualTrajectory`)が `step`/`reset` のたび軌道要素メモを破棄し、差し替え前の
state を条件付きで `history` へ送れるのは「state が差し替え以外では変化しない」からである。
参照を共有したまま中身を書き換えると保持側が変化を検知できず、メモが黙って腐り、履歴も取り落とす。

`KinematicState` は `{t, r, v}`(エポック付き状態ベクトル)で、**予測点列・エンティティ履歴・計画ノードは
すべてこの 1 型で表す**。同じ情報量の型を複数持たない(旧 `TrajectorySample` / `LineSample` /
`PlannedNode.time` はここへ統合済み)ため、「状態」と「その時刻」が別々に渡されて食い違うことがない。

**例外はない。** RK4 の加速度評価も `dynamics.ts` の `stepDynamics`(内部で `attractor.ts` の
`attractorAccel` の全天体ぶんの和 + 自身の `j2Accel` + `atmosphere.ts` の `dragAccel` を合成)が `Vec3` を返す
純粋関数の積み重ねで、`stepRK4` はその結果を `AccelFn` として受け取るだけ。ミュータブルな
スクラッチや `out` 引数を
持つ変種は `physics/` のどこにも置かない(その形を撤去した経緯と実測値は
`memos/mikanixonable/軽量化計画.md` の A-1 を参照)。エンティティ数が増えて効くようになったときの
答えは物理 LOD(同 B-1)であって、ミュータブルなスクラッチの再導入ではない。
