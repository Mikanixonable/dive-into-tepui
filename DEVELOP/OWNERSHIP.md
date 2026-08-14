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
├── SnapshotService        ... LocalStorageSaveStore・SaveSlots を参照で持つ。Game ↔ GameSaveData の片方向変換(capture: Game → GameSaveData / load: スナップショットID → GameSaveData | null、いずれも Game 自体は受け取らない)。main.ts が起動時に load() の結果を Game のコンストラクタ引数 initialSave として渡す
├── Hud                  ... initHud() でタイトル(ステージ選択)画面より前に生成、Game へ参照を渡す。
│   │                       root 直下の重なり順は layers: OverlayLayers(overlay-layer.ts、marker/panel/window/popup/view/notify/system の
│   │                       7層、この順に z-index 10〜16)が正本 — z-index を持つのは overlay-layer.ts だけで、他の全 DOM 所有者は
│   │                       自分がどの層の子になるかを選ぶだけ。層内の前後は DOM 順、最前面化は bringToFront() のみ
│   └── HudPanels        (buildHudDom が作った要素索引を共有)
├── Sfx                  ... 同上
├── SettingsPanel        ... 同上。DOM は Hud.layers.system 配下。onSettingsOpenChange を Game.pause()/resume() へ配線。onOpenSnapshots / onOpenPerfWindow は main.ts が settingsPanel.toggle(false) + saveBrowser.open() / perf.open() へ配線。onQuitToTitle は launcher.returnToTitle() への一行委譲
├── Launcher               ... 「Game インスタンスを捨てて次の周回へ移る」判断(再出撃・タイトル復帰・スナップショットのロード・スロット切替)の唯一の持ち主。`location.*` を呼ぶのはこのクラスだけで、game/ 配下は一切呼ばない。initHud() の直後・ステージ解決の前に main.ts が new する(UnlockManager・SaveSlots・SnapshotService・Sfx を参照で持つ)。`resolveStage()` が起動する StageClass を、`initialSaveFor(stageClass)` が initialSave を、`noteLaunched(stageClass)`(Game 構築後に呼ぶ)がスロットへの起動記録と restart() 用のステージ記憶を担う。rAF ループが `snapshotControls.handleInput` の直後に `handleInput(game.input, game)` を、`autoSave.update` の直後に `update(game)` を呼ぶ
│   └── ResultScreen        ... `#hud-end`(hud/dom.ts が Hud.layers.system 配下へ静的に構築)の表示のみを担う。Launcher が自身(`this`、RunTransitions)を渡してコンストラクタで new する — 「再出撃」「タイトル画面に戻る」の2ボタンはそのまま launcher.restart()/returnToTitle() を呼ぶ
├── SaveBrowser            ... Game 自身を構築引数に取るため Game より後に main.ts が new する。Game 側はこれへの参照を一切持たない(`open()`/`close()` が `game.pause()`/`resume()` を直接呼ぶだけ)。DOM は Hud.layers.system 配下。`onLoadSnapshot`/`onSlotSwitched` コールバックを main.ts が launcher.loadSnapshot(id)/launcher.switchSlot() へ配線する
├── SnapshotControls       ... Hud・SettingsPanel・SaveBrowser・SnapshotService を参照で持つ。`[F5]`/`[F9]`/一覧表示中の `[Esc]` を扱う。main.ts が SaveBrowser 構築後に new し、rAF ループが `game.update(dt)` の直後に `handleInput(game.input, game)` を呼ぶ(Game 側が消費しなかった入力エッジだけを見る)
├── AutoSave               ... SnapshotService を参照で持つ。startAnimationLoop() へその場で渡すだけで main() 側は変数に束縛しない
├── FrameSections        ... update の区間別所要時間の集計器(frame-sections.ts)。main.ts が new し、Game(コンストラクタ引数)・PerfMeter(コンストラクタ引数)へ参照で渡す。Game はさらに Simulator のコンストラクタ引数として同じ参照を渡す。rAF ループが game.update(dt) を beginFrame()/endFrame() で挟む。区間の境界(enter/exit)を打つのは Game.update / Simulator.advance だけで、累計を持つのはこのオブジェクト。enabled の書き手は PerfMeter.open()/close() のみ
├── PerfMeter            ... 負荷確認ウィンドウ。Game を PerfCountSource として、GameScene.renderer(WebGPURenderer)を draw call/triangle 数の読み取り元として、いずれも構築時に参照で受け取る(renderer 参照の新設は main.ts 側の GameScene を経由し、Game には持たせない)。rAF ループが `game.update(dt)` → `snapshotControls.handleInput(...)` の直後に `perf.handleInput(game.input)` を呼び、`[F3]` を消費する。FrameSections も構築時に参照で受け取り、update内訳の行を組む。表示する PropertyWindow を自分で new/dispose し、DOM は Hud.layers.window 配下。開いている間だけ on が真になり計測が走る(同時に FrameSections.enabled も真にする)。`Game.perfCounts()` は自分では数えず、EntityManager・Predictor・Simulator・PlanEditor・Ephemeris・MapPicker 各自の `perfCounts()` を1つにマージし、`displayDurationSec`(= DisplayWindowManager.current.duration)・`warp` を足すだけ
├── Ephemeris             ... 状態を持たない純サンプラ。main.ts の initEphemeris(stageClass, phaseOffsets) が
│                              stageClass.createEphemeris(phaseOffsets) を await して Game より前に完成させる
│                              (既定は Stage 自身の静的実装 — 天体暦プロファイル解決 + 精密暦パック取得を経て
│                              new Ephemeris(...)。StageDebugAltSystem だけが自前の架空レジストリを同期的に
│                              返す override を持つ)。完成したインスタンスを Game のコンストラクタへそのまま渡す
├── GameScene            (createGameScene: canvas / THREE.Scene / WebGPURenderer)
└── Game
    ├── Input
    ├── TouchControls?       ... タッチデバイスのみ。ViewManager のコンストラクタ引数として参照で渡す
    ├── MarkerManager        ... DOM の親は Hud.layers.marker / Hud.svgOverlay、所有は Game
    │   ├── GroupedMarkers (combatMarkers)  ... 画面上で近接する戦闘対象(敵+自機以外の生存中の全自機)マーカーのまとめ + 画面外方位マーカー。呼ぶのは Targeter.syncTargetMarkers
    │   └── LeadMarkers                     ... 戦闘対象ごとの LEAD マーカーと最終ロック時刻。呼ぶのは Targeter.syncTargetMarkers
    ├── CameraSystem
    │   ├── CombatCameraSystem
    │   │   ├── ChaseCamera
    │   │   └── GunsightCamera
    │   ├── OverviewCamera
    │   ├── FocusMarkers
    │   └── OverviewCameraPanel        ... DOM は Hud.layers.panel 配下。天体クラス別トグル(軌道線/ラベル)+ 弾薬マーカートグルのみ。座標系の選択は持たない
    ├── FrameControls                  ... 座標系パネル。カメラ(視点)区画と軌道計画(描画基準)区画がそれぞれ
    │                                       中心・回転の2ゾーンを持ち、OverviewCamera・DisplayWindowManager.frame を書く。
    │                                       自分の状態は「カメラの基準に追随」トグル(followCamera)だけ。
    │                                       パネル DOM は Hud.layers.panel 配下。CameraSystem の直後、PlanEditor より前に
    │                                       construct する(PlanEditor が構築引数として参照を受け取るため)
    │   ├── AnchorZone × 2                 ... カメラ/並進ゾーン。ObjectPicker + SegmentedControl(いまいる系のクイックボタン)。ObjectPicker のポップアップは Hud.layers.popup 配下
    │   └── RotationZone × 2               ... カメラ回転/計画軌道回転ゾーン。SegmentedControl のみ
    ├── MapPicker                      ... マップ被選択物の候補列・右クリック解決・種別別プロパティ/操作の配分・開いているプロパティウィンドウ集合。
    │                                       Game への参照は持たず、操作の実行先(ActivePlayerController・FrameControls・
    │                                       activeStage・CameraSystem)を個別に参照で持つ。activeStage が要るので
    │                                       activeStage の直後に construct する(ViewManager・Docking はこれより後)
    │   ├── ContextMenu<MapPickable>       ... 空域右クリック('empty-space')専用メニュー。DOM は Hud.layers.popup 配下
    │   ├── windows: Map<string, WindowEntry>  ... {win: PropertyWindow<MenuAction>, target}。オブジェクト1つ(`${kind}:${id}`)につき高々1枚。呼び出しごとに new。PropertyWindow は Hud.layers.window 配下に append
    │   └── ObjectListPanel                ... DOM は Hud.layers.panel 配下。軌道オブジェクトウィンドウ(一覧 + クリックで選択状態 + ダブルクリックでフォーカス移動 + 右クリックでプロパティウィンドウ)。マップ視点である間は常設表示
    ├── NavTarget                      ... 航法ターゲット(id)と自機軌道との相対 AN/DN・▲/▽ マーカー
    ├── Navball                        ... 天球グリッド6トグルの正本
    │   └── NavballPanel                   ... DOM は Hud.layers.panel 配下。グリッドトグルのみ
    ├── ActivePlayerController         ... 操作対象艦(0..n隻のうちどれを操作するか)の切替・削除と、それに伴う各所有者への伝播を1箇所へ集める(`set`/`setOrNull` は Targeter・Sfx へ、`remove` は NavTarget・Targeter・CameraSystem(フォーカス解除)へ)。PlanEditor・MapPicker・ViewManager への参照は持たない — PlanEditor はこちらを参照で持つ側で、逆方向の参照は無い。Game.player はこれへ転送する getter。起動時の操作対象艦は自分で解決する(構築引数の activePlayerId → entities.players の id 一致 → 先頭 → null)
    ├── SimSpeedManager
    ├── DisplayWindowManager           ... 「どの座標系で(frame)・いつを(displayTime)見るか」の正本(表示期間・
    │                                       未来ゴーストスライダー・frame)と、1フレーム分の DisplayWindow
    │                                       ({frame, simTime, referencePeriod, duration, displayTime})・
    │                                       重力源窓(解析天体+重力を持つ生存中の GameEntity の合流)を resolve() で
    │                                       1回だけ確定させ、update・sync 両フェーズの全消費者へ共有する。
    │                                       Ephemeris・EntityManager を参照で持つ(所有しない)。entities の直後に
    │                                       construct する(entities 自身のコンストラクタが EffectsSystem の
    │                                       生成まで終えている)
    │   └── DisplayTimePanel           ... DOM は Hud.layers.panel 配下。期間/未来位置スライダー。画面下端の帯として
    │                                       #hud-displaytime-wrap に開閉トグル(hud/dom.ts の buildCollapseToggle)と
    │                                       並べて包まれる。開閉状態はトグル対象要素の `.collapsed` クラスが正本(この
    │                                       クラス自身は持たない)で、ビューの往復では戻さない(折りたたみは
    │                                       ビューの性質ではなく操作者の選択)
    ├── PlanEditor                     ... plan は活艦(ship)の Plan への転送 getter。正本ではない
    │   ├── PlanDisplay                ... 計画の未来表示(「見えるとき何を見せるか」)
    │   │   └── PlanPath         ... 計画折れ線 + per-arc 積分キャッシュ + 画面判定
    │   │       ├── PlanArc[]          ... 区間ごとの積分結果。各々 DynamicTrajectory 1本(積分の正本)を持つ。区間を作り直すたびインスタンスごと差し替わる(既存インスタンスの書き換えではない)
    │   │       └── TrajectoryLine[]   ... 区間 index ごとの折れ線プール。区間数が減っても捨てず隠すだけ(色は index で決まるため使い回す)
    │   ├── NodeGizmo                   ... ノードハンドル/Δv 矢の DOM は Hud.layers.marker 配下
    │   │   └── ContextMenu<number>     ... DOM は Hud.layers.popup 配下
    │   ├── HudHoldButton ×6            ... Δv 6方向の長押しボタン(dvButtons)
    │   └── 計画パネル DOM
    ├── PlanGuide                       ... 直近ノードの接近/達成通知済みフラグ(ノード自体への参照)を持つ
    ├── Docking                        ... 基地への収容・発進(EntityManager/CameraSystem/ActivePlayerController/
    │                                       ViewManager にまたがる横断)。Game への参照は持たず、ポーズだけは
    │                                       pauseGame/resumeGame の2クロージャで受け取る(「クロージャ注入を避け
    │                                       参照を渡す」規則への暫定的な例外。理由は docking.ts のコンストラクタ
    │                                       コメントと CLAUDE.md にある)
    │   └── DockView                       ... DOM は Hud.layers.view 配下。格納艦/部品/ショップタブのフルスクリーン UI
    ├── ViewManager                    ... 現在のビュー(combat/map/dock)の正本。遷移は setView() ひとつに集約。
    │                                       ActivePlayerController・TouchControls | null はいずれもコンストラクタ引数
    │                                       (ViewManager より先に生成される)。docking への参照は ViewManager より後に
    │                                       生成されるため setDocking() で構築後に注入される(private フィールドとして
    │                                       保持)。Stage への参照は持たないが、生成は activeStage より後 — 初期ビューを
    │                                       canEnter('combat') で解決するので、Stage の初期配置で自機が置かれた後
    │                                       でなければ判定できない
    ├── ViewBadge                      ... DOM は Hud.layers.notify 配下。ViewManager を参照するだけで自身は状態を持たない
    │   └── ContextMenu<true, ViewId>  ... DOM は Hud.layers.popup 配下
    ├── Stage (activeStage)            ... Game のコンストラクタが受け取る解決済みの StageClass を直接 new し、
    │                                       saved(StageSaveData | undefined)と StageDeps 一式(hud/sfx/scene/entities/
    │                                       unlockManager/fx/markerManager/ephemeris/simulator/activePlayers、
    │                                       stage.ts 参照)を渡す(分岐は無く、CREATIVE も同じ経路)。
    │                                       コンストラクタ一段で初期化が完結し、新規開始の世界の初期状態(自機を含む)と
    │                                       ブリーフィングは各具象ステージのコンストラクタ末尾の begin() → init(entities)
    │                                       が行う(基底のコンストラクタからは呼べない — 具象側のフィールド初期化が
    │                                       super() の後に走るため)。自機を置くのは protected addPlayer(init?) で、
    │                                       new Player → entities.addPlayer → activePlayers.claimIfNone をこの1箇所に
    │                                       まとめる(初期弾薬は PlayerInit.ammo として艦の構築引数に載る)。
    │                                       起動時の天体暦は Stage の静的 async createEphemeris(phaseOffsets)
    │                                       が既定実装(天体暦プロファイル解決 + 精密暦パック取得の末に
    │                                       new Ephemeris(...))を持ち、StageDebugAltSystem だけが自前の
    │                                       架空レジストリを同期的に返す override を持つ — 読むのは Game
    │                                       ではなく main.ts(Stage の構築より前に済ませ、完成した
    │                                       Ephemeris を Game のコンストラクタへ渡す)。
    │                                       隻数の静的宣言は無い — 何隻をどこへ置くかは init の中身。
    │                                       freeProcurement/executesPlans は
    │                                       インスタンス側の既定 false なフラグ、authoring は既定 null の ObjectAuthoring
    │                                       (配置・複製の口)。CreativeStage だけが両方を有効にし、authoring は自身を返す。
    │                                       _activePlayers は StageDeps の一つとして引数で受け取り(protected _activePlayers)、
    │                                       CreativeStage.placeObject の艦の配置も同じ addPlayer を通る。
    │                                       喪失した自機の回収は
    │                                       ActivePlayerController.reclaimDead() が全ステージ共通で毎フレーム無条件に
    │                                       行うので、ここに対応するフラグはない
    │   ├── ScoreCounter
    │   ├── Logistics                  ... 補給の投入判断
    │   ├── StageStatusPanel           ... DOM は Hud.layers.panel 配下。HP/補助メッセージ/撃墜数。#hud-stagestatus の表示を書くのはこのクラスだけで、sync(player | null, …) の null が畳む指示(保持中の艦参照もそこで落とす)。戦闘ビュー専用 — マップビューでは同じ画面下端中央を PREDICT バーが占める
    │   ├── ScoreAttackTimer           ... Stage0 のみ
    │   ├── WaveAttack                 ... Stage00・CreativeStage がそれぞれのコンストラクタで1個ずつ生成し、private readonly waveAttack として保持する(stage-utils/wave-attack.ts)。波状攻撃フェーズ(waiting_for_ammo/spawning_enemies/active_combat)・タイマー・波数の正本。CreativeStage 側は waveAttackEnabled(自身のフィールド、既定 false)が true の間だけ update を呼ぶ — 敵の AI 自体(behaveAllEnemies)はトグルと無関係に毎フレーム進む
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
    ├── Targeter
    │   ├── OrbitLine                  ... 第一ターゲット軌道線(オレンジ)
    │   ├── OrbitLine (secondaryOrbitLine) ... 第二ターゲット軌道線(シアン)
    │   └── ContextMenu<Enemy>         ... 第一/第二ターゲットの設定・解除メニュー。DOM は Hud.layers.popup 配下
    ├── EntityManager                  ... エンティティ配列の保持と、破片(entity)の生成窓口である EffectsSystem
    │                                       の所有。コンストラクタ引数 saved(GameSaveData | undefined)があれば
    │                                       その顔ぶれを復元するだけで、新規開始では全配列が空のまま始まる
    │                                       (起動時の顔ぶれを組むのは Stage.init — どの艦を操作するかも決めない。
    │                                       ActivePlayerController が自分で解決する)。simTime は持たない
    │   ├── InstancedPool (bulletBodyPool) ... geometry/material は render/ships.ts のモジュールスコープ
    │   │                                      共有リソースを参照するだけ(所有しない)。sync が毎フレーム push する
    │   ├── InstancedPool (bulletHaloPool)
    │   ├── InstancedPool (plasmaPool)
    │   ├── InstancedPool (casingPool)
    │   ├── InstancedPool[] (debrisFragmentPools) ... 破片(fragment)バリアントごとに1本(render/ships.ts の
    │   │                                      debrisFragmentResources が持つジオメトリ配列と1本の白マテリアルを共有)。
    │   │                                      push の第2引数に DebrisPiece.fragmentColor(per-instance color)を渡す
    │   ├── EffectsSystem               ... フラッシュ・破片の生成窓口。コンストラクタは EntityManager 自身(this)を
    │   │                                      受け取る(addDebris 呼び出し用の注入クロージャは持たない)
    │   │   └── FlashEffectManager
    │   │       ├── InstancedPool (pool)   ... geometry/material は render/billboard.ts の flashResources() が持つ
    │   │       │                              共有リソースを参照するだけ(所有しない)。sync が毎フレーム push する
    │   │       └── FlashEffect[]          ... 各々 THREE.Object3D(transform)のみ持つ(geometry/material は持たない)
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
    │   │   │                              表示抑制(setSuppressed)は Game.sync がこの艦自身の supersedesAnalyticEllipse(...)から渡す(§付録参照)
    │   │   ├── TrajectoryLine         ... 自機予測軌道線。Game.sync が毎フレーム this.syncTrajectoryLine(操作対象, ...)を呼ぶ
    │   │   ├── Plan                   ... この艦自身のマニューバ計画(正本)。ノード列 + アンカー
    │   │   └── PlanExecutor           ... この艦自身の計画実行状態機械(正本)。CreativeStage が艦ごとに呼ぶだけで保持しない
    │   ├── Enemy[]                    ... 各々 OrbitLine を持つ
    │   ├── Bullet[]                    ... 各々コンストラクタで Sfx への参照を持つ(至近通過音を自分の checkLoss から鳴らすため)。
    │   │                                  obj はシーンへ足さない(GameEntity の addToScene=false) — bulletBodyPool/bulletHaloPool/plasmaPool が
    │   │                                  obj の変換を読んで描画する。obj 自体は Bullet.sync が書き込む変換の置き場所として残る
    │   ├── DebrisPiece[] (casings)      ... 各々コンストラクタで Sfx・EffectsSystem への参照を持つ(接触音・ガスパフを自分の collideWith から出すため)。
    │   │                                  obj はシーンへ足さない(addToScene=false) — casingPool が obj の変換を読んで描画する
    │   ├── DebrisPiece[] (debris)       ... 同上。fragment 種別のみ obj もシーンへ足さない(addToScene=false) —
    │   │                                  obj は変換の置き場所のみで、debrisFragmentPools[fragmentVariant] が読んで描画する。
    │   │                                  barrel/magazineFrame 種別は個別メッシュのまま(addToScene=true)
    │   ├── Ammo[]
    │   ├── Base[]                     ... 各々 baseState(money/inventory/dockedShips)と OrbitLine を持つ
    │   └── Asteroid[]                 ... 重力を及ぼし・受ける小天体。mass/radius はコンストラクタ引数から mu = G・mass を導いて固定。
    │                                       j2/c22 を渡した場合は degree2(pole/tesseral)も構築時に att から一括で固定
    ├── Simulator                      ... 実シミュレーション。EntityManager・Ephemeris・FrameSections の参照を受け取って回すだけ(いずれも所有しない)
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
  (horizon)は種別ごとの定数ではなく、`Predictor.update` が毎フレーム `DisplayWindowManager.current.duration`
  (`resolve(simTime, player)` が update フェーズ・sync フェーズそれぞれで確定させたもの)から渡す引数。
- `STAGE_CLASSES`(stage-dictionary.ts のモジュールスコープ、`export const`)… クラス参照(`StageClass`)の
  並びだけを持つ配列で、`Stage` インスタンスは1つも作らない。選択画面のラベル・解放条件(`isUnlocked`)・
  起動時の天体暦(静的 async `createEphemeris`)はすべて各クラスの静的宣言
  から読む(`stage.ts` の `StageClass` インターフェース参照)。`CreativeStage` も `STAGE_CLASSES` 末尾の
  一員としてここに含まれ、選択画面のクリエイティブモードタブに CREATIVE として出る(タブは各ステージの
  静的 `selectGroup` の初出順に組まれる — `stage-select.ts` 参照)。ID からクラスを引くのは
  `findStageClass`(同モジュール)の責務で、`launcher.ts`(`Launcher.resolveStage`/モジュール private な
  `resumableStageClass`)・`unlock-manager.ts`・`hud/save-browser.ts` がこれを使う。`game.ts`(`Game` のコンストラクタ)は解決済みの
  `StageClass` を `new stageClass(saved, ...deps)` するだけで、CREATIVE を含め分岐は無い。実行中の
  `activeStage`(インスタンス)自身は `Stage.stageClass` ゲッター(`this.constructor` を返す)で自身の
  クラスへ戻れ、`Stage.id`(=`stageClass.id`)や `ViewBadge` が表示するラベル
  (`activeStage.stageClass.selectLabel`)はここ経由で読む。
- `stage-select.ts` の `UnlockManager` … 選択画面用に別途 `new` される。正本は localStorage なので
  Game 側のインスタンスと状態を共有する必要がない。

---

## 2. 参照共有(所有ではない)

複数箇所から使われるため、所有者から参照だけを配って回っているもの。**所有権は移らない。**

| 対象 | 所有者 | 参照する側 |
| --- | --- | --- |
| `THREE.Scene` / `WebGPURenderer` | `GameScene`(main.ts) | Game・各描画物を持つクラス |
| `Hud` / `Sfx` | main.ts | Game(コンストラクタ引数で受け取り)経由でほぼ全サブシステム(hud/sfx は必ず対で注入する方針)。`Sfx` は `Launcher`(コンストラクタ引数、`update` が決着の瞬間に `setThrust(false)`/`stopBgm()` を呼ぶ)へも直接渡る |
| `SettingsPanel` | main.ts | Game(`[Esc]` で `toggle()` を呼ぶだけ。開閉の一時停止反映は main.ts 側の配線)・MapPicker(空域右クリックの「設定メニューを開く」項目、`Targeter.emptySpaceMenu` と同じパターン) |
| `MarkerManager` | Game | マーカーを出す全モジュール(PlayerMarkers・Targeter・NavTarget・Logistics・FocusMarkers・PlanGuide・PlanDisplay)。`combatMarkers`/`leadMarkers` は参照共有ではなく MarkerManager 自身の子(§1 参照) |
| `Ephemeris` | main.ts(`Stage.createEphemeris` 経由で `Game` の構築より前に完成させる) | Game(コンストラクタ引数)経由で EnvironmentScene・Simulator・OverviewCamera・FocusMarkers・NavTarget・PlanEditor(→PlanDisplay)・DisplayWindowManager(コンストラクタ引数) |
| `CameraSystem.bodyClassToggles`(`BodyClassToggles`) | CameraSystem | MAP VIEW パネルが書き換え、読む側はすべて `MapVisibilityPolicy` を通す(`MapPicker.refresh`・`FocusMarkers.update`・`EnvironmentScene.sync`/参照線・`Game.sync` → Stage/Logistics/CreativeStage/Targeter)。マップの描画・ピック候補・軌道オブジェクト一覧・配置UIの基準天体が同じ1つの状態を共有するための唯一の持ち主。初期値は `localStorage`(`tepui.bodyClassToggles`)から読み込み(`camera-system.ts` の `loadBodyClassToggles`)、トグルのたびに `saveBodyClassToggles` で書き戻す(同上) |
| `EntityManager` | Game | Simulator(コンストラクタ引数、配列を直接持たず参照だけ回す)・ContactPhysics(`Simulator.advance` が呼び出しのたびに参照を渡すだけで保持しない)・Targeter・NavTarget・Enemy.behave・Stage/stages/・Logistics・EffectsSystem・NanWatchdog(いずれも読み取り + `addXxx`/`findPlayer`/`findEnemy` 経由の追加・参照のみ)・PlanEditor(コンストラクタ引数。`update` が `simulation/attractors.ts` の `planAttractorProvider`/`planSourceRevision` を組むのに読むだけで保持しない)・DisplayWindowManager(コンストラクタ引数、`attractorsAt` が `entities.attractors()` を読むだけ)。`attractors()` は毎回のフィルタ呼び出しで正本を持たない(§付録「正本でないもの」) |
| `PlanPath` | PlanDisplay | PlanEditor(ノードの画面判定 `projectPoint` / `nearestSample` のみ、`planDisplay.path` 経由) |
| `DisplayWindowManager`(`plan/plan.ts` の狭い `DisplayDurationSource`(`{durationSec(referencePeriod): number}`)としてのみ見える) | Game | PlanEditor(→PlanDisplay)(コンストラクタ引数で `PlanDisplay` → `PlanPath` へそのまま転送。末尾区間の長さ(`plan.ts` の `segmentDurationFrom`)と `Plan.nodeTimeRange` の上限が PREDICT パネルの選択に追従するための参照で、`PlanPath` はこれを保持するだけで書き換えない。`plan/` 配下は `durationSec` 以外の具象 `DisplayWindowManager` のフィールド・メソッドを一切読まない) |
| `Plan`(活艦の) | `Player`(活艦自身、`PlanEditor` ではない) | PlanEditor(`plan` getter が活艦の `plan` を転送。艦がいなければ `null`)・PlanDisplay(`update` の引数で毎フレーム受ける。出さないフレームは `null`)・PlanGuide(引数では受けず、渡された `Player` の `plan` から自分で引く)・CreativeStage(`planExecution` 艦のノード消化) |
| `PlanExecutor`(艦ごとの) | `Player`(艦自身) | CreativeStage(`update`/`nextSimulationEventTime`/`applySimulationEvents` から呼ぶだけで保持しない) |
| `SimSpeedManager` | Game | PlanEditor(ノードメニューからの自動ワープ) |
| `FrameControls` | Game | PlanEditor(構築引数。ノードメニューの「フォーカス」項目で `frameControls.setFocus(...)` を直接呼ぶ) |
| `EffectsSystem`(`EntityManager.effects`) | EntityManager | Player・PlayerFire・Enemy・Stage(`Game` は `entities.effects` 経由でのみ触れる。所有権は持たない) |
| `Player` / `Simulator` / `EntityManager` / `Stage` | Game | 毎フレームの引数として相互に渡される |
| `UnlockManager` | main.ts | Launcher(コンストラクタ引数、`resolveStage` の `resumableStageClass` が `isUnlocked` を読み、選択画面が必要なときは引数として `selectStage` へ渡す)・各Stage（クリア後画面判定のため） |
| `SnapshotService` | main.ts | Launcher(コンストラクタ引数、`initialSaveFor` から `load()` を呼んで `initialSave` を組む)・AutoSave(コンストラクタ引数)・SaveBrowser(コンストラクタ引数)・SnapshotControls(コンストラクタ引数、`[F5]` から `capture` を呼ぶ)。Game はこれへの参照を持たない |
| `SaveSlots` | main.ts | Launcher(コンストラクタ引数、`resolveStage`/`initialSaveFor`/`noteLaunched`/`update` の `noteRunEnded` から読み書きする)・SnapshotService(コンストラクタ引数)・SaveBrowser(コンストラクタ引数) |
| `SaveBrowser` | main.ts | SnapshotControls(コンストラクタ引数、`[F9]` と一覧表示中の `[Esc]` で `open()`/`close()` を呼ぶ)。Game はこれへの参照を持たない |
| `SnapshotControls` | main.ts | rAF ループ(`startAnimationLoop` が `game.update(dt)` の直後に `handleInput(game.input, game)` を呼ぶ) |
| `FrameSections` | main.ts | Game(コンストラクタ引数。`update` が区間境界へ `enter`/`exit` を打つだけ)・Simulator(Game 経由のコンストラクタ引数。軌道積分/接触/姿勢の3区間の境界を自分で打つ)・PerfMeter(コンストラクタ引数。`enabled` を開閉で書き、`record` で全区間 + `otherMs()` を採取する) |
| `PerfMeter` | main.ts | rAF ループ(`startAnimationLoop` が `snapshotControls.handleInput` の直後に `perf.handleInput(game.input)` を呼び、`[F3]` で `toggle()` する)・SettingsPanel(`onOpenPerfWindow` 経由で `open()`) |
| `PropertyWindow`(負荷確認ウィンドウ) | PerfMeter(`open()` で new し `close()`/✕ で dispose する1枚) | PerfMeter 自身のみ。500ms ごとの flush で `syncRows` へ行一式を渡す |
| `FocusMarkers.bodyPickables(t, visibilityPolicy)` の戻り値 | CameraSystem(→FocusMarkers、呼ぶたびに作り直す使い捨て配列) | `MapPicker.refresh()` が読んで生存中の自機・敵船・弾薬・基地・NavTarget のアイコン・`PlanDisplay.apsisMarkers` と合流させ、`MapPicker.handleRightClick`(`pickNearest`)/`OverviewCamera.update` の被選択物候補として渡し直す。引数の `MapVisibilityPolicy` が admits した天体+ラグランジュ点だけを返し、遮蔽・ラベル衝突でこのフレームに描かれなかった対象は `pickable: false` を伴って残す(表示設定で消えているわけではないので候補からは落とさない) |
| `MapVisibilityPolicy`(1フレームの使い捨て) | `MapPicker`(`refresh` が `registry`/`bodyClassToggles`/`focusTargetId(...)`/`systemMembersAt(cameraPos, ...)` から毎フレーム1つ組み立て、`visibilityPolicy` getter で公開。`refresh` 前と、マップ視点でないフレームは null — `refresh` は早期 return の前に null を代入するので、読む側はビューを見て潰す必要がない) | `FocusMarkers.update`(引数)/ `Game.sync` が `mapPicker.visibilityPolicy` を読んで `EnvironmentScene.sync`・参照線 / `Stage.sync`・`EntityManager.syncMarkers`・`Targeter.sync` へ配る。受け取り側は渡されなければ同じ4入力から自前で組む経路も残す(マップ経路の外からも呼べるようにするためで、マップ描画中は必ず共有インスタンス)。天体は `body(id)`、エンティティは `entity(kind, isActivePlayer)` で `{category, icon, label, orbit, pickable}` を返す判定関数であって状態を持たない(正本は `CameraSystem.bodyClassToggles` とフォーカス・カメラ位置) |
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
| HP / 生存 | `Ship.hp` / `GameEntity.alive` | 死亡は `alive = false` のみ。除去は非自機が EntityManager.cleanup(→prune)、自機は ActivePlayerController.reclaimDead() |
| RCS 制動・スロットル段・ホールド | `PlayerThrottle` | |
| 姿勢微調整モード | `Player.fineAttitude` | |
| 残弾・マガジン・バレル・装填タイマー | `PlayerFire` | |
| ベルトのたわみ(節点位置・ツイスト) | `BeltPhysics` | 表示用リンク変換は Belt が毎フレーム導出 |
| 外殻温度・動圧・高度警告 | `ThermalSystem` | 破壊判定そのものは `Player.checkLoss` |
| 放熱板の展開度・損耗度 | `RadiatorSystem` | 温度は持たない。放熱面積と太陽入射を `ThermalSystem.setRadiatorLoad` へ渡すのは `Player` |
| 太陽電池の蓄電量 | `PowerSystem` | メッシュ操作なし(パネルは固定)。`sync()` を持たない |
| エンティティ配列(自機/敵/弾/薬莢/デブリ/補給) | `EntityManager` | 追加は `addXxx` 経由。上限管理もここ(`players` のみ無上限で `prune` の対象外 — 除去は `ActivePlayerController.reclaimDead()` が担い、喪失した瞬間に配列から取り除かれる)。`Simulator` は参照を受け取って回すだけで配列を持たない |
| 保持配列の顔ぶれの世代 | `EntityManager.collectionRevision`(private `_collectionRevision` + public getter) | `addXxx`/除去のたびに増える。`all()`/`attractors()` の結合キャッシュの再構築判定に使う。`alive` が false になっただけでは増えない(除去は非自機が `cleanup` → `prune`、自機が `ActivePlayerController.reclaimDead()` で、それぞれ毎フレーム行う)。public getter は、結合配列そのものは参照が変わらないため、外から顔ぶれの変化を知る唯一の手段になる |
| シミュレーション時刻 / 前フレームの simDt | `Simulator.simTime` / `.lastSimDt` | |
| エンティティ側の最小イベント時刻の控え | `Simulator.cachedEventTime`(private。有効性 `cachedEventValid`、算出時の LOD `cachedEventLod`、算出時の顔ぶれの世代 `cachedEventRevision` を併せ持つ) | エンティティの締切は固定の絶対時刻なので substep ごとに引き直さず、simTime がこの時刻へ到達したとき・`EntityManager.collectionRevision` が変わったとき・`passiveWarpLod` が切り替わったときだけ全生存エンティティを走査して求め直す。ステージ側のイベント時刻は艦の現在の Δv と加速度から毎回決まるため、ここには含めず毎 substep 引く |
| このフレームの表示窓(`DisplayWindow` = `{frame, simTime, referencePeriod, duration, displayTime}`) | `DisplayWindowManager.current`(private `_current`) | `resolve(simTime, player)` で組み直す唯一の書き込み経路。内部でキャッシュキー(引数の simTime・player・player の `state`、および `frame`/`forceCurrent`/`durationKey`/`sliderT` などの setter が増やす private `revision`)を持ち、いずれも動いていなければ組み直さない — `game.update` から2回(`advanceSimulation` を飛ばした/実行した直後)、`game.sync` の先頭で1回呼ぶが、実際に `currentOrbitPeriod()`(登録天体全体を組んで `strongestAttractor` を回す重い計算)まで走るのはキャッシュキーが動いたときだけ。`Predictor.update` の horizon・`game.update` 内の各値・`sync(player)` のパネル反映はいずれもこの1個を読むだけで、それぞれが `currentOrbitPeriod()` を呼び直すことはない |
| このフレームの重力源窓(解析天体 + 重力を持つ生存中の GameEntity の合流) | `DisplayWindowManager.attractorsAt(simTime)`(private キャッシュ、`attractorsBodies`/`attractorsDynamic`/`attractorsCache`) | `ephemeris.attractorsAt(simTime)` と `entities.attractors()` の両方の戻り値(参照)が前回と同じ simTime で一致していれば組み直さず前回の合流配列を返す。`game.update` 内の `cameraSystem.update` と `game.sync` が読む |
| 予測ラウンドロビンのカーソル | `Predictor.cursor` | `EntityManager.all()` のインデックスとして毎フレーム進む。`tracked`/`complete`/`discarded` の3カウンタも同じインスタンスが持つが、`?perf=1` 表示専用の集計値で次フレームの挙動には影響しない |
| ワープ段・自動ワープ目標時刻 | `SimSpeedManager` | 閾値判定(canShipAct 等)もここの getter が唯一 |
| 天球グリッド6トグルの可視状態 | `Navball` | `gridVisibility`。`Game.sync` が `navball.gridVisibility` を読んで `EnvironmentScene.sync` の引数(`gridVisibility`)経由で `CelestialGrid.sync` へ渡すだけで、`CelestialGrid` 自身は状態を持たない。初期値は `localStorage`(`tepui.gridVisibility`)から読み込み(`navball.ts` の `loadGridVisibility`)、トグルのたびに `saveGridVisibility` で書き戻す——`UnlockManager`/`tepui.clearCounts` と同じ形だが、正本はこのフィールド自身のまま |
| Δv アーム/ボタンのホールド継続時間・ラッチ状態 | `PlanEditor.dvHoldTime` / `NodeGizmo.latch` | 6方向ぶんの経過秒数(ホールドレートのランプに使う)と、ドラッグがラッチへ入った軸/超過量。加算そのものは `PlanEditor.applyDv` に一本化 |
| NaN 検出済みフラグ | `NanWatchdog`(Game 所有) | 一度検出したら以後の検査を止める |
| マニューバ計画(ノード列・アンカー) | `Plan` | 所有は各 `Player`(艦ごとに1個。`PlanEditor.plan` は活艦のものを転送する getter)。起点とノード列は **`{ anchor, nodes } \| null` という1つの値**で持ち、`null` ⟺ ノードが1件も無い — 片方だけを更新できる形にしていない。ノードが1件も無い計画の起点は自機の現在状態そのものなので `Plan` 自身は持たず、`PlanEditor.visibleStart` が `plan.anchor ?? ship.state` として毎フレーム解決する。ノード・起点とも 1 個の `KinematicState`(実行時刻 = `t`、Δv は導出値)。ノード列は `addNode` が挿入位置より後ろを破棄してから push するため常に実行時刻順。`addNode(postState, from)` はノードがまだ1件も無いときだけ `from` を起点として凍結し(既に凍結済みなら使わない)、`(凍結済みの起点 ?? from).t` 以前の状態は受け付けず `-1` を返す。`consumeNodesUpTo(t, actualState)` は実行時刻が `t` 以前のノードをまとめて取り除き、取り除いた件数を返すとともに、**残るノードがあるときだけ** `anchor` を `actualState`(実際に到達した状態)へ差し替える — 1件も残らなければ起点ごと捨てる。呼ぶのは `PlanGuide.update`・`PlanExecutor.finish`・`CreativeStage.applySimulationEvents` の3か所だけで、動力飛行の残差を消さずに以降の計画へ残すのが `actualState` を使う目的。編集世代 `revision`(private `_revision` + public getter)を増やすのは実際に変えた呼び出しだけ(`addNode`/`removeNode`/`replaceNode`/`consumeNodesUpTo`/`clear`。`applyNodeDv` は委譲先の `replaceNode` でのみ)。`_revision` は `{anchor, nodes}` の外に持ち、空↔非空をまたいでも単調増加する(キャッシュ鍵として衝突させないため)。ノードが1件も無いあいだ起点が自機を追うことは編集ではないので増やさず、その判定は `PlanArc.represents` の `tracksLiveAnchor` 経路(積分済みサンプル間隔との比較・`anchorJumped`)が持つ |
| 操作対象(アクティブ)艦 | `ActivePlayerController`(private `_current`) | `Game.player` はこれへ転送するだけの getter。初期値は構築時に自分で解決する(構築引数の `activePlayerId` → `entities.players` の id 一致 → 先頭 → null)。以後の書き換えは `set(ship)`/`setOrNull(ship \| null)`/`remove(ship)`/`reclaimDead()` の4つに閉じる。カメラ参照・ターゲット解除の副作用もすべてここに閉じる(下記「たまたま同時に切り替わる」節参照)。`remove` はマップの削除メニューなど明示的な取り除きから、`reclaimDead` は `Game.advanceSimulation` が全ステージ共通で毎フレーム無条件に呼ぶ(喪失した自機を他のエンティティと同じく速やかに回収する) |
| 軌道計画の実行モード | `Player.planExecution`(型 `PlanExecutionMode` = `'off' \| 'instant' \| 'powered'` は `plan/plan-executor.ts` が定義し `player.ts` は re-export するだけ) | 全ての自機が持つ(既定 `'off'`)。`'instant'` は `CreativeStage.applySimulationEvents` がノード時刻ちょうどで `state` をノードの絶対状態へ置き換え、`'powered'` は `PlanExecutor` が姿勢制御・噴射で実行する。操作対象艦での手動並進(`this.thrust !== null`)・手動回転(`throttle.hasManualRotationInput`)は `Player.behave` が `'powered'` を `'off'` へ落とす |
| PlanExecutor の状態機械(`phase`/`targetNode`/`burnDirWorld`/`burnUpWorld`/`pendingAccel`) | `PlanExecutor`(艦ごとの) | 艦の `planExecution`/ノード/生死/ゲートから毎フレーム `update` が導出。`targetNode` はノードの**参照**を持ち、`node.t` ではなく `node !== targetNode` で差し替わりを検出する(`Plan.applyNodeDv`/`replaceNode` は同じ `t` のまま新しいオブジェクトへ差し替えるため)。噴射ゲート(`simSpeed.canShipAct`)は保持せず、`update`/`applyIgnitionAndCutoff`/`nextEventTime` が各自引数で受け取る。`ship.torque`/`ship.thrust`/`ship.plan` は `PlanExecutor` が唯一書き換える(`'powered'` の間のみ)が、書き込みは `update`(毎フレーム、`Player.behave` の後)と `applyIgnitionAndCutoff`(simTime イベント境界ごと)の両方から起きる — 前者は「操作艦で `behave` が毎フレーム上書きする `thrust` を、その後で確実に正しい値へ戻す」役、後者は「点火・遮断の瞬間を simTime ちょうどに固定する」役で、互いの代わりにはならない |
| 選択中ノード・計画編集モード | `PlanEditor.selectedNode` / `.editMode` | 選択の正本はノード(`KinematicState`)そのものへの**参照**。`selectedNodeIdx` は `plan.nodes` から同一性で引き直す get/set のみで、列から消えたノード(削除・下流の切り捨て・消化)は自動的に「未選択」になる |
| 直近ノードの接近/達成通知済み | `PlanGuide`(`approachNotified` / `achievedNotified`) | 通知済みのノードそのものへの参照。編集のたびノードは別インスタンスへ置き換わるので、同一性比較がそのまま「同じノードについて通知済みか」の判定になる |
| 予測表示期間の選択(`durationKey`)・任意期間の秒数(`customDurationSec`)・未来ゴーストスライダー(`sliderT`)・未来表示の禁止(`forceCurrent`) | `DisplayWindowManager` | いずれも private(`forceCurrent` のみ get/set アクセサで外部公開)。`forceCurrent` に true をセットすると `sliderT` も 0 へ戻す。期間の切替(`durationKey` 変更、または任意期間の確定)でも同様に `sliderT` を 0 へ戻す |
| 未来表示(計画折れ線・予測軌道線・交点マーカー)を描く座標系(`frame`) | `DisplayWindowManager` | `OverviewCamera.cameraFrame`(視点固定座標系)とは別の正本。get/set アクセサ(`frame`)で公開。書き換えは `FrameControls` の「軌道計画(描画基準)」区画の中心/回転ゾーン(`planCenterZone`/`planRotationZone`)のみ、いずれも `Ephemeris.frameOf(center, rotatingWith)` 経由。同区画の「カメラの基準に追随」トグル(`followCamera`、既定 on)が on の間は `setFocus` によるカメラ側フォーカス移動もここへ連動する |
| 予測到達割合(`predictionRatio`)・直近 `sync()` で受け取った表示期間(`lastDuration`) | `DisplayWindowManager` | いずれも private な導出値。`predictionRatio` は `sync(player)` が呼ばれるたび private `predictionCoverageRatio(player)` が自機の `predictedTrajectory.state.t` と `current`(simTime, duration)から自分で求め直す(外部からの書き込みはない)。`lastDuration` は直近の `resolve()` 呼び出しが確定させた表示期間を憶えておくだけの値で、ジャンプ入力(DOM イベント、フレーム外)が `sliderT` を逆算する際にだけ参照される |
| マップ視点(注視点相対オフセット・パン・上方向)・座標系(cameraFrame)・フォーカス(FocusTarget)・Viewpoint | `OverviewCamera` | `viewpoint: Viewpoint` は `CombatCameraSystem` と同じ形。`CameraSystem` はこの `viewpoint` を読むだけで自分では持たない。フォーカスは `camera/focus-target.ts` の `FocusTarget`(`{kind:'object', id}` または `{kind:'point', frame, point}`)で、`{kind:'object'}` が指す実位置は `OverviewCamera` が持たず、`update` の引数(`MapPicker.refresh()`)から毎フレーム引き直す。書き換えは `setFocusTarget`/`setCameraRotation` のみ、いずれも `FrameControls` の「カメラ(視点)」区画の中心/回転ゾーン(`cameraCenterZone`/`cameraRotationZone`)から呼ばれる |
| 戦闘視点(Viewpoint: position/lookTarget/up/fovDeg/aspect)・照準ズーム中か(zoomActive) | `CombatCameraSystem` | rot(クオータニオン)/dist・姿勢追従フラグ(camFollowAttitude)は内部の `ChaseCamera` が持つが、追従対象そのものは保持せず、`CameraSystem.update` から渡る `player` を毎フレーム `chaseCamera.update`/`toggleFollowAttitude` の引数として転送するだけ。`[G]`(`K.followAttitudeToggle`)を読んで `chaseCamera.toggleFollowAttitude(player)` を呼ぶのもこのクラス自身の `update`(`CameraSystem` は読まない)。zoomActive はこのクラス自身の `update` が `Input` から読んで保持する |
| 現在のビュー(combat/map/dock) | `ViewManager`(private `worldView`/`isDockOpen`) | 遷移は基本的に `setView()` のみ(影響先 `CameraSystem.overviewMode` / `PlanEditor.editMode` / `DisplayWindowManager.forceCurrent` / タッチUI を一斉に切り替える)だが、`leaveDock()` だけは例外で、ドックを閉じて背後のビューへ戻るだけの操作を `setView()` を経由せず `isDockOpen` を直接倒して行う(`worldView` は動かさないので `canEnter` チェックも不要)。`worldView` が背後の 3D 側ビュー、`isDockOpen` がドックの開閉を持ち、`current` はこの2つから導出する |
| ドックビューの対象基地 | `Docking`(private `_activeBase`) | 基地の右クリックメニューで設定。これが空でない間だけ `ViewManager.selectableViews()` に `'dock'` が並ぶ |
| マップモード表示 | `CameraSystem.overviewMode` | 描画・視点側の分岐はこれを見る。`CameraSystem.zoomActive` は `!overviewMode && combatCamera.zoomActive` を返すだけの派生 getter(状態は持たない) |
| 開いているプロパティウィンドウの集合・一時ウィンドウのキー | `MapPicker`(`windows`/`tempWindowKey`) | キーは `` `${kind}:${id}` ``。`openPropertyWindow` が新規/移動を判断し、`closeWindow`/`forgetWindow` が畳む。個々の `PropertyWindow` インスタンス自身はクリップ状態(`clipped`)とドラッグ位置だけを持ち、開閉のポリシー(いつ閉じるか)は持たない — クリップ状態が変わったこと自体は `onClipChange` で `MapPicker` に通知し、`tempWindowKey` の付け替えは通知を受けた `MapPicker` 側が行う |
| 第一・第二ターゲット・的通過マーク | `Targeter`(`target`/`secondaryTarget`) | 右クリックメニュー(`applyMenuAct`)でのみ変わる。自動選定・自動再選択はない |
| 航法ターゲット(id)・相対 AN/DN | `NavTarget` | `update()` が自機軌道要素 + `Ephemeris` から毎フレーム再算出する導出値だが、対象の id 自体(`toggleTarget` で変わる)は正本 |
| 勝敗フェーズ | `Stage`(private `_phase`) | 変更は Stage 自身のみ。外部は `phase`/`isPlaying` を読む |
| 決着した周回の結果画面の内容(`StageResult` = `{win, title, detailHtml}`) | `Stage`(private `_result`) | `protected decide(phase, result)` が `_phase` と同時に書き込む唯一の入口(`onWin`/`recordPlayerLost`/各ステージの独自の決着経路が呼ぶ)。外部は `result` getter で読む。表示するのは `Launcher.update` — `Stage` 自身は結果画面を出さない。`StageResult` はセーブに含まれない(`serialize()` が保存するのは `phase` のみ)ので、決着済み `phase` を持つ復元セーブでは `Launcher` 側の `fallbackResult(phase)` が見出しだけの内容へ差し替える |
| 今回起動した StageClass | `Launcher`(private `launchedStage`) | `noteLaunched(stageClass)`(main.ts が `new Game(...)` の直後に呼ぶ)が書く唯一の入口。`restart()` がこれを読んで `?stage=<launchedStage.id>` を組む(未設定なら何もしない) |
| 結果画面を出したか | `Launcher`(private `resultShown`) | `update(game)` が決着した最初のフレームで true にする。以後の `update` 呼び出しはこのフラグだけを見て即 return するので、結果画面は決着につき一度しか出さない |
| 発射数・命中数・撃破数・出撃数 | `ScoreCounter` | 所有は Stage |
| 補給の投入間隔タイマー | `Logistics` | 投入できない間は進めない(再開直後のフレームで判定させるため) |
| 補給の自動投入の可否 | `Logistics.resupplyEnabled` | 書き換えは CreativeStage の「設定」パネルのトグルのみ。ワープ倍率による停止は `SimSpeedManager.canResupplyAmmo` が別途担い、両者の積で投入可否が決まる |
| 敵の波状攻撃(新規ウェーブ発生)の可否 | `CreativeStage.waveAttackEnabled`(既定 false) | 書き換えは「設定」パネルのトグルのみ。true の間だけ `update` が `WaveAttack.update` を呼ぶ。既存敵の AI(`behaveAllEnemies`)はこのフラグと無関係に毎フレーム進む |
| ウェーブフェーズ・波数 | `WaveAttack`(Stage00・CreativeStage がそれぞれ1個 own) | |
| 残り時間 | `ScoreAttackTimer`(Stage0) | |
| ステージクリア回数 | **localStorage**(`tepui.clearCounts`) | UnlockManager はその読み書き窓口。インスタンスは正本ではない |
| ポーズ | `Game.paused` | 駆動源は `SettingsPanel.onSettingsOpenChange` と `SaveBrowser.open()`/`close()` の2つ。どちらもシステム窓で、開いている間だけ止める |
| スナップショット一覧の表示状態 | `SaveBrowser`(private `_visible`) | `open()`/`close()` のみが書き換える。毎フレーム sync は持たず、操作のたびに自分で DOM を作り直す一発モーダル |
| 一時エフェクト(フラッシュ)の配列 | `FlashEffectManager.effects` | 各要素は位置を時刻つきの `KinematicState` で持ち、`updateFlashEffects` がその時刻から `simTime` まで移流させる |
| 地球自転の初期位相 | `EarthBody.phase0`(既定 0、乱数は持たない) | `spinPhase0()`/`setSpinPhase0()` で読み書き可能。乱数を引くのは `main.ts` の1箇所だけ(`initialSave?.earthSpinPhase0 ?? Math.random() * 2π`)。`Game` のコンストラクタはその結果を `earthSpinPhase0: number` 引数としてそのまま受け取り、`new EnvironmentScene(scene, ephemeris, earthSpinPhase0)` として構築時に一度だけ渡す。`EnvironmentScene` のコンストラクタは受け取った値で無条件に `setSpinPhase0` を呼ぶ(地球が現在のレジストリに無ければ対象が見つからず何もしないだけ)。セーブは `EnvironmentScene.earthSpinPhase0()` 経由 |
| 各天体の平均黄経の初期位相 | `Ephemeris`(`phaseOffsets`、コンストラクタ引数として受け取り以後不変) | 時刻を引数に取るサンプラ。既定は空(`{}`)、すなわち全天体オフセット0 — 乱数は一切持たない。時刻 `t` 完全一致キーの3スロットのリングキャッシュ(`planetHelioState`/`satelliteRelState`/`attractorsAt`)を持ち、ヒットしない呼び出しだけ天体暦の合成をやり直す。セーブは `getPhaseOffsets()` で読み取るだけ(書き込み経路は無い)。ロードは `main.ts` が読み込んだ `phaseOffsets`(`initialSave?.phaseOffsets ?? {}`)を `Stage.createEphemeris(phaseOffsets)` 経由の `new Ephemeris(...)` へそのまま渡し、完成した `Ephemeris` を `Game` のコンストラクタへ渡す — 実行中のインスタンスへ書き戻すことはない(スナップショットのロードはページ再読込で `Ephemeris` ごと作り直すため) |
| `registry`/`originId`/`epochOffsetSec` | `Ephemeris`(コンストラクタ引数、以後不変) | どのステージも既定値(`SOLAR_SYSTEM`/`'earth'`/`EPOCH_T_OFFSET`)で構築されるが、`StageDebugAltSystem` だけは自身の `createEphemeris` override が別のレジストリ・原点・オフセット0 で直接 `new Ephemeris(...)` する。構築するのは `main.ts`(`stageClass.createEphemeris(phaseOffsets)` 経由)で、`Game` 自身はこの3引数を選ばない。`starId`/`inertialFrame`/`frames`(登録天体ぶんの `ReferenceFrame` 一覧)もこの3引数からコンストラクタが1回だけ導出する正本(いずれも下記 `frameCache` を経由して作る) |
| `frameCache`(`Map<AttractorId, Map<OrbitingId \| null, ReferenceFrame>>`) | `Ephemeris`(`frameOf` 経由) | `(center, rotatingWith)` の対ごとに `ReferenceFrame` を1個だけ持つ、実行時に伸びる正本。レジストリ登録の有無を問わない(生存中の重力天体を中心にする回転系にも同じ契約で応じる)。`inertialFrame`/`frames`/`frameFor` はすべてこのキャッシュを経由して作られた値を返すので、同じ対に対して異なる参照が生まれない(`trajectory-line.ts` の `frame === lastFrame` 参照同一性契約を満たすためのもの) |
| 入力スナップショット(押下キー・クリック・マウス移動量) | `Input` | フレーム確定は `update()` の1回だけ。エッジは `takeKey`/`takeKeys`/`takeClicks`/`takeRightClicks` で**先着順に消費**され、処理した側より後ろのモジュールには届かない |
| 敵 AI の実行時状態(最終発砲時刻・バースト残数) | `Enemy` | |
| LEAD マーカーの表示履歴(戦闘対象ごとの最終ロック時刻) | `MarkerManager.leadMarkers` | 表示専用の状態なので Enemy/Player には置かない。毎フレーム生存中の戦闘対象(敵 + 自機以外の生存中の全自機)ぶんだけ作り直す。呼ぶのは `Targeter.syncTargetMarkers` |
| EqAN/EqDN アイコン(位置・通過時刻) | 各 `GameEntity.equatorNodes`(`EquatorNodeMarkerPair.icons`) | 出す対象を選ぶ側(`PlanEditor`/`Targeter`/`EntityManager.updateBaseEquatorNodes`/`NavTarget`)がそれぞれ `update` を呼んで求め直す。`sync` は置いたあとに捨てるので、そのフレームに update されなかったペアは自動的に隠れる |
| 戦闘ターゲット用の生存対象・マーカー item のスクラッチ配列 | `Targeter`(`aliveScratch`/`markerItemScratch`) | `syncTargetMarkers` が毎フレーム組み直す作業用配列。正データではない |
| update の区間別所要時間・区間外時間 | `FrameSections.elapsedMs` / `frameMs` | 1フレーム分だけの累計で、`beginFrame` が捨て `endFrame` が総和を確定する。境界を打つのは Game.update / Simulator.advance、読むのは PerfMeter.record だけ |
| 計測の可否 | `FrameSections.enabled` | 書き手は `PerfMeter.open()`/`close()`(窓の開閉)のみ。偽の間は enter/exit が `performance.now()` を読まない |
| マーカー DOM 要素のプール | `MarkerManager` | キーで索引。`combatMarkers`/`leadMarkers` は自分が前フレームに出したキーを覚えていて、集合から消えたものを hide する。`EquatorNodeMarkerPair` は所有者の dispose でキーごと remove する |

### 正本が分かれていることに意味がある組み合わせ

- **`CameraSystem.overviewMode`(視点)・`PlanEditor.editMode`(操作系)・`DisplayWindowManager.forceCurrent`
  (未来表示の禁止)** は3つとも別の正本。同時に切り替えるのは `ViewManager` だけで、描画・視点側は
  overviewMode を、未来表示の可否は forceCurrent を見る。実噴射(WASDQE)の可否は真偽値では表さない —
  ノードを選択している間だけ `PlanEditor.updateEditing` が `Input.takeHeld` で6キーを先着確保し、
  後から読む `Player` にはそれが押されていないように見える。マップビューが開いていても選択中ノードが
  無ければ実噴射が効く。手動回転(RCS・IJKLUO)と射撃はキーを取り合わないので、マップビュー中でも常時有効。
  「いまどのビューか」そのものの正本は第四の値 `ViewManager.current` で、上の三つ
  (とタッチUI)はその影響先。
- **`FloatingOrigin.r`** の正本はアクティブカメラの ECI 位置(`CameraSystem.activeCameraPos`)であり、
  `Player.state.r` とは別物 — 戦闘ビューではチェイスカメラが自機から数十mしか離れないため近い値に
  なるだけ。sync 系は必ず fo を参照し、`player.state.r`/カメラ位置を描画原点として直接使わない。
- **`ActivePlayerController.current`(操作対象艦、`Game.player` はここへ転送する getter)・
  `Targeter` のロック** は艦を切り替えるたびに揃える必要がある2箇所。同時に切り替えるのは
  `ActivePlayerController.set()`/`setOrNull()`/`remove()` だけで、`Targeter` はロック解除だけを
  自分の持ち分として更新する — `ViewManager` が3つのフラグを一斉に切り替えるのと同じ形の
  トグラー集約。追従カメラ(`ChaseCamera`)は基準となる艦を保持せず、`update`/`toggleFollowAttitude`
  の引数として `CombatCameraSystem.update` から毎フレーム受け取るので、この揃える対象には含まれない。
  `PlanEditor` も基準となる艦を保持せず、`plan` getter が `ActivePlayerController.current` を
  そのつど参照で読むだけなので、同じくこの揃える対象には含まれない。
- **`OverviewCamera.cameraFrame`(視点を固定する座標系)と `DisplayWindowManager.frame`(未来表示を
  描く座標系)** は別の正本で、ユーザーが `FrameControls` の2区画×(中心・回転)の
  4ゾーンからそれぞれ独立に選ぶ — 4ゾーンとも状態は書き込み先の2クラス(`OverviewCamera`・
  `DisplayWindowManager`)に残したまま `FrameControls` は仲介するだけなので、この独立性自体は
  ゾーンの分割で変わらない。両者を連動させるかどうかだけが `FrameControls` 自身の状態
  (`followCamera`)で、有効なあいだフォーカス移動が `frame` の中心も動かす。
  PlanPath が受け取るのは後者だけ。
- **`Targeter.target`(戦闘ターゲット、`Enemy` のみ)と `NavTarget.id`(航法ターゲット、任意の `MapPickable`)**
  は別の正本。前者は射撃・LEAD・的通過マークの対象、後者はマップの相対 AN/DN・時間加速・ノード追加の
  対象で、対象の型も操作系(右クリック位置がヒットしたのが敵かそれ以外か)も異なるため一本化しない。
- **マップモードの操作パネル**は状態の所有者ごとに分かれる。`OverviewCameraPanel`(天体クラス別トグル・
  弾薬トグル)は CameraSystem が、`DisplayTimePanel`(期間・未来位置スライダー)は DisplayWindowManager が
  持ち、それぞれ自分の状態だけを映して自分の状態だけを受け取る。座標系パネル(FrameControls)だけは
  例外で、状態を持たず `OverviewCamera` と `DisplayWindowManager`(`frame`)という別々の所有者へ
  4ゾーンから書き込む横断モジュール(上記「同時に切り替わる」節参照)。表示・非表示も各所有者が毎フレームの
  sync で押し出す(ViewManager は関与しない)。
- **キー割り当ての正本は `input/key-mapping.ts` の `KEY_MAPPING`、キーの処理の正本は各担当モジュール**。
  どのキーがどの操作かは KEY_MAPPING(コード + 表示名)だけが持ち、入力を読む側(`Input.down` /
  `Input.takeKey` は `KeyBinding` を受ける)と説明を出す側(ヘルプ表・操作バー・タッチパッド・
  ステージ briefing・結果画面)は両方ともそれを参照する。どの操作を誰が処理するかは各モジュールに
  閉じたままで(`SettingsPanel`=pauseMenu / `Hud`=help / `Launcher`=restart /
  `SimSpeedManager`=warpSlower・warpFaster・autoWarpToNode / `ViewManager`=toggleMapMode /
  `PlanEditor`=deleteNode・dv* / `CameraSystem`=camera*(旋回・ズーム・パン) / `CombatCameraSystem`=followAttitudeToggle・gunsightZoom /
  `Player`=rcsDampToggle・progradeReset・fineAttitudeToggle・progradeHoldToggle・throttle*・reload・thrust*・pitch/yaw/roll)、
  `game.ts` が持つのは「どのモジュールに先に配るか」という順序だけ。
  ステージ選択画面のキー(`Stage.selectKeys`)はステージ定義側のデータなので KEY_MAPPING には含めない。
- **`HudPanels` は表示専用**。Game を丸ごと読んで自分の4パネルへ書くだけで、他モジュールの状態や
  DOM は操作しない。ステージ固有の状況パネルは `Stage`(`StageStatusPanel`)、タッチUIのトグル点灯は
  `TouchControls.syncModeButtons()` が担当し、いずれも game.sync が自機/ステージの状態を渡す。
- **HUD パネルの表示はその所有者だけが書く**。`#hud-status`/`#hud-orbit`/`#hud-enemies`/`#hud-target` は
  `HudPanels`、`#hud-stagestatus` は `StageStatusPanel`、MAP VIEW パネルとフォーカスラベルは
  `CameraSystem`、ビュー起因だけで決まるものは `#hud.map-mode` の CSS。**1つの要素を2箇所が書くと、
  同じフレームの後に走ったほうが必ず勝つため、先に書いたほうの条件式が黙って死ぬ。**
- **HUD マーカーは対象の持ち主が出す**。自機由来(方向/ボアサイト/マップ上の自機)は `PlayerMarkers`、
  戦闘ターゲット由来(方位・的通過マーク)は `Targeter`、航法ターゲット由来(相対 AN/DN)は
  `NavTarget`、近地点・遠地点は `PlanDisplay`、補給は `Logistics`、天体ラベルは `FocusMarkers`、
  ノード/BURN は `PlanGuide`、計画上の自機位置ゴーストは `PlanDisplay`。`MarkerManager` が own するのは
  **1つの対象では決められない2つだけ** — `combatMarkers`(画面上のまとめ、`Targeter.syncTargetMarkers`
  が敵 + 自機以外の生存中の全自機を組んで呼ぶ)、`leadMarkers`(同じ対象集合に依存、同じく
  `Targeter.syncTargetMarkers` が呼ぶ)。赤道交点(EqAN/EqDN)は対象ごとに1つなので
  各 `GameEntity.equatorNodes` が持つ。`Enemy`/`Player`
  は自分の見た目とラベルを `markerItem()` で渡すだけで、まとめの判断には関与しない。
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
| `Ephemeris.attractorsAt(t)` の戻り値(`Attractor[]`) | 天体暦(`SOLAR_SYSTEM` 登録順 — 地球・月・水星・金星・火星・フォボス・ダイモス・木星・メティス・アドラステア・アマルテア・テーベ・イオ・エウロパ・ガニメデ・カリスト・ヒマリア・エララ・アナンケ・カルメ・パシファエ・シノーペ・土星・パン・ダフニス・プロメテウス・パンドラ・エピメテウス・ヤヌス・ミマス・エンケラドゥス・テティス・ディオネ・レア・タイタン・ヒペリオン・イアペトゥス・フェーベ・天王星・海王星・トリトン・ネレイド・ケレス・ベスタ・パラス・冥王星・ハウメア・マケマケ・エリス・ハレー彗星・エンケ彗星・太陽周回小天体32体・天王星系6衛星・冥王星系5衛星・準惑星/小惑星の衛星6体・太陽の101体)から組み立てる重力源スナップショット。各要素は位置・速度に加えて、その時刻に解決した2次重力場(`degree2`: J2・基準半径・自転軸・長軸。持たない天体は `null`)も抱える。全天体を含む唯一の窓で、重力積分の3箇所(`GameEntity.stepActual`・`Predictor.advanceBudget`・`PlanArc` の積分刻み)も遮蔽判定・表面到達判定・中心天体解決・サンプリング間隔導出・HUD/マーカー等も同じこの窓を使う(`mu = 0` の天体は寄与がゼロなので積分側で除外する必要が無い)。どのクラスもこれを状態として保持しない — 呼んだその場で使い切るか、次のステップ/フレームでまた引き直す。`Ephemeris` は時刻 `t` 完全一致キーのリングキャッシュを持ち、同一 `t` への呼び出しは同一の配列参照を返す(呼び出し側は書き換え禁止) | 呼び出しごとに新しい `t` を渡せば作り直される(リングキャッシュがヒットしない場合のみ再計算)。位相オフセット自体はコンストラクタで確定し以後変わらないため、これ以外にキャッシュを無効化する経路はない |
| `OrbitalElements.center`(`Attractor`) | その軌道要素をどの天体まわりで取ったか。要素と同じ寿命でその天体の `t` 時点スナップショットを抱えるので、要素そのものより長く持ち回してはならない(`OrbitLine` は楕円の平行移動先をここから引く) | 要素を作り直すたび。`GameEntity.orbitalElementsAround` のメモ経由なら `state` 差し替えのたび |
| 解析楕円の中心天体(`strongestAttractor(state.r, attractors)` の結果) | `state`(と `attractors`)から都度導く選択であり、`GameEntity`/`Plan`/`PlanDisplay`/`OrbitLine` のどれもこれを状態として保持しない — 選ぶ GUI もない | 呼ぶたび再計算 |
| `GameEntity.orbitalElementsAround(center)` の内部メモ | `state` の参照同一性 + `center.id` をキーにした軌道要素のメモ化(中心天体 `center` は呼び出し側が選ぶ) | `state` が差し替わるたび(`current.step`/`.reset`)、または `center.id` が変わるたび自動的に不一致になる |
| `GameEntity.prevState`(→ `current.prevState`) | 直前の `step`/`reset` 時点の state を持つ専用フィールド(`history` とは別) | `step`/`reset` のたび更新 |
| `GameEntity.predictedTrajectory` | `actualTrajectory.state` + ephemeris から `Predictor` が漸進的に構築する未来軌道のキャッシュ(`predictsFuture = false` のクラスでは常に null)。伸ばす長さ(horizon)は `DisplayWindowManager.durationSec(referencePeriod)` の毎フレーム値で、`GameEntity`/`Predictor` のどちらにも独立した状態としては残らない | `discardPredictionIfDiverged` の距離判定(§3-4 (a))、または `Player.behave` の推力確定直後(§3-4 (b))。無効化は破棄のみで即再構築はしない — 次フレーム以降の通常の予算配分で伸び直す |
| `SimSpeedManager.canResupplyAmmo` | `simSpeed === 1` の派生 getter(等倍限定) | 呼ぶたび再計算 |
| `OrbitLine.snap` | 楕円ジオメトリの再生成判定用スナップショット(長半径・離心率・`hHat`/`pHat`) | 要素ドリフト・`force`・初回 |
| `DynamicTrajectory.sampleInterval` | 直近の `step` に渡された間引き間隔。列がどれだけ粗いかという列自身の属性で、`GameEntity.divergenceTolerance` が乖離判定の許容量をここから引く(現在の表示期間から引くと、期間を縮めた瞬間に既存の粗い列を破棄し続ける) | `step` のたび |
| `FocusLabel.pickable` | このフレームに画面上で掴めるか。`update` が表示対象を true で置き直し、`syncLabels` が天体による遮蔽なら false、ラベル衝突で名前を落とした場合はアイコンが残るかどうか(`showIcon`)で上書きする。`bodyPickables` が候補の `pickable` に映すだけで、候補からは落とさない | `update` → `syncLabels` の順に毎フレーム書き換え |
| `TrajectoryLine.startTime` / `.endTime`(描画区間の下限/上限) | `syncGeometry` の `from`/`to` 引数を、それぞれ bake 済み区間の先頭/末尾時刻へクランプした値(`to` が `null` なら上限なし)。`GameEntity.trajectoryLine`(`syncTrajectoryLine` は `from=simTime`/`to=null` を渡す — 予測線は先端まで無制限に描く)と `PlanPath` の per-index `TrajectoryLine`(`from=null`/`to=arc.end` — 積分先端が継ぎ足しでその区間の答える範囲より先まで伸びていても、そこで描画を止める)の双方が使う。線の先頭頂点は `startTime` で保持列を補間した点になるので、実状態そのものではない(`GameEntity.trajectoryLine` 側の乖離は `discardPredictionIfDiverged` の許容量内に収まる) | `syncGeometry` を呼ぶたび(=表示中は毎フレーム)。ただし bake 自体(`baked` の再構築)は保持列の参照か `frame` が変わったときだけ — `from`/`to` の変化だけなら revision の差し替えで足りる |
| 自機 `OrbitLine` の表示抑制(`setSuppressed` の引数) | この艦自身の `supersedesAnalyticEllipse(simTime, horizon, overviewMode)` から導く真偽値。マップビューでは予測が表示範囲を覆いきるまで解析楕円を代替表示として残し、戦闘ビューでは予測線が描かれてさえいれば抑制する(視点近傍しか映さないため「覆いきったか」は意味を持たない)。`OrbitLine` 自身はこの理由を持たない | `Game.sync` が毎フレーム渡し直す |
| `PlanArc.state0` / `.sourceRevision` / `.apsisCenterId`(readonly、constructor で確定) | この arc がどの入力から作られたかのスナップショット。`sourceRevision` は `planAttractorProvider` の `revision`、すなわち `planSourceRevision(...)` が計画の編集世代・除外 id 集合・`predictsFuture` が真の各対象個体の id と予測の届き具合(予測列なし / 計画終端 `planEnd` まで届いていない / 届いている、の3値)を 32bit へ畳み込んだ値。伸長の途中では値が動かず、届いた瞬間に一度だけ変わる。`PlanPath.update` が区間ごとに今フレームの値を `represents(state0, end, sourceRevision, apsisCenterId, tracksLiveAnchor)` へ渡して一致を問う | 一致しなければ `PlanPath.update` が `new PlanArc(...)` を作って丸ごと差し替える(この3値自体は既存インスタンス上では書き換わらない) |
| `PlanArc._end`(`.end` getter) / `.samples`(getter、メモ化) | `_end` は「この arc が答える終端時刻」— `_trajectory` の積分先端(`.state.t`)より手前にも先にもなりうる(`setEnd` の継ぎ足しで先端が `_end` を追い越すこともある)。`samples` は `_trajectory.samplesOldestFirst()` を `_end` でクリップした結果を `(元配列の参照, _end)` でメモ化したもの — 切る必要が無ければ元配列をそのまま返すので、`TrajectoryLine.syncGeometry` の参照同一性による再bake抑制が効く | `_end` は `setEnd(end)` の呼び出しごとに書き換え。`samples` は `_trajectory` が実際に積分を進める(`step` が呼ばれる)たび、または `_end` が動くたび再計算 |
| `PlanArc.periapsisState` / `.apoapsisState` | 同じ積分ループの中で、`apsisCenter`(呼び出し側が渡す基準天体。末尾区間以外は null で検出自体を省く)に対して `physics/trajectory-features.ts` の `apsisCrossing` をステップ対ごとに掛けた結果、最初に見つかった近地点・遠地点(それぞれ独立)。折れ線サンプルではなく積分の生ステップ対から求めるので、衝突コースで動径速度が符号反転しない区間は近地点側が null のまま残る。読み出し用の `periapsisPoint()`/`apoapsisPoint()` は、その状態の時刻が `_end` を超えていれば(区間が縮んでその先で見つかったことになれば)null を返す | インスタンス生成時に null で初期化され、以後は見つかった時が最初の1回だけ確定 — `setEnd` → `integrateTo` の継ぎ足しで積分が続いても再リセットはされない(arc を丸ごと差し替えることだけが唯一のリセット契機) |
| `PlanArc` の `integrateTo()` の据え置き対象(ローカル変数。時刻・`PlanAttractorSources`・衝突体の id 索引・`classifyAttractors` の結果を1つに束ねたもの) | `PlanAttractorProvider.at(t)` は毎回一意な時刻を要求されると暦のキャッシュに当たらないので、積分先端が `ATTRACTOR_REBUILD_SEC` 進むごとに1回だけ組み直し、その間の全ステップで使い回す(`Predictor.advanceBudget` と同じ定数・同じ判断)。据え置いた時間ぶんの天体位置のズレは、この区間の刻み幅そのものが持つ RK4 の誤差より小さい | `integrateTo()` の呼び出しごと(constructor からの初回、または `setEnd` からの継ぎ足し)に作り直し、積分先端が `ATTRACTOR_REBUILD_SEC` 進むたびに更新 |
| `PlanPath.arcs` / `.lines` / `.activeCount` / `.nodeCount` / `.frame` / `.unbakeTime` / `.project` | 毎フレーム再構築される区間分割と表示文脈(画面判定もこれを使う)。`arcs` は区間の積分結果プールで、`update()` のたび `this.arcs.length = segments.length` へ切り詰められる(区間が減れば末尾を捨てる)。`lines` は折れ線の index ごとのプールで、`lineAt(i)` が遅延生成するだけで縮めない(区間数が減っても捨てず `sync()` が非表示にするだけ — 色が index で決まるため使い回す)。先頭 `activeCount` 本(`arcs`)がこのフレームの区間、先頭 `nodeCount` 本がノードで終わる区間 | `arcs`/`activeCount`/`nodeCount`/`frame`/`unbakeTime`/`project` は `update()` 毎。`lines` は必要な index が初めて登場したときだけ伸びる |
| `PlanPath.finalSegment()`(private `final`) | 末尾区間(次のバーンが無い区間)の `state0` / `samples`(`PlanArc.samples` ゲッターの返り値をそのまま公開 — `_end` で切る必要が無ければ `trajectory.samplesOldestFirst()` と同じ配列参照を返し続けるので、積分が走らない限り `TrajectoryLine.syncGeometry` の参照同一性による再bake抑制が効く)/ 同じ末尾 arc の `periapsisPoint()`/`apoapsisPoint()`(`_end` を超えていれば null を返すアクセサ経由 — 生の `periapsisState`/`apoapsisState` ではない)をそのまま転送した `periapsis`/`apoapsis` / `apsisCenter`(`Segment` が持つ、その区間の起点自身の時刻で `strongestAttractor` が選んだ基準天体。区間長の算出と同じ天体窓から1回だけ選ぶ)。`PlanDisplay` の Pe/Ap アイコンはこの3つを直接読む。`samples` は `PlanEditor.update` が操作艦の `equatorNodes` へ渡す EqAN/EqDN 走査元 | `update()` 毎(`update()` を一度も通していなければ null) |
| `PlanPath.cameraPos` / `NavTarget.attractors` / `EquatorNodeMarkerPair.attractors` / `PlanDisplay.attractors` | マップビューの遮蔽判定(`physics/occlusion.ts` の `isOccluded`)向けに、直近の `sync`/`update` が受け取ったカメラ位置・`Attractor[]` を引き継ぐだけのキャッシュ。`PlanPath.cameraPos` は `nearestSample` が DOM ポインタイベント起点でフレーム外から呼ばれるために要る | 次の `sync`/`update` で上書き |
| `simulation/attractors.ts` のモジュール内作業領域(`seenScratch` / `muScratch` / `griddedScratch`) | それぞれ `collectPlanCollision` の重複排除、`alwaysThresholdMu` の μ 整列、`classifyAttractors` の grid 投入待ち行列だけに使う器。いずれも使う関数の中で閉じ、返り値からは到達できない(`classifyAttractors` は `SpatialGrid` へ挿入し終えた時点で内容を捨てる) | 使うたび先頭で clear/`length = 0` |
| `ObjectListPanel` の区画ごとの表示順(`Section.order`: `ids`/`rootIds`/`childIds`、いずれも id のみ)と前フレーム入力の記録(`prevIds`/`prevNames`/`prevKinds`/`prevParents`/`prevMatches`/`prevSort`/`prevFilter`) | 候補列・親子関係・絞り込み/並び順から導く表示順のキャッシュ。行の値(距離・詳細)と見出しの件数はここに入れず毎フレーム候補から引き直す | 入力(id 集合・表示名・種別・親・絞り込み通過可否・絞り込み/並び順の選択)が前フレームと変わったフレーム、または保持している順序が今フレームの値で整列条件を満たさなくなったフレーム(距離順では候補が変わらなくても正しい順序が動くため) |
| `PlanPath.arrivalStates()` / `PlanEditor.nodeDv()` | 各区間の `PlanArc` 終端状態、およびそこから求めるノード Δv の導出値(表示専用) | 呼ぶたび再計算(`PlanArc` 側の積分結果をそのまま読むので、描画中の計画軌道と同じ結果になる) |
| `PlayerThrottle.thrustAccelVec` | ベルト物理(`Belt.update`)向けの推力加速度ベクトル | 毎フレーム上書き。プルーム・エンジン音は `ThrustEffects.sync` が `ship.thrust`(`GameEntity` 側、`PlayerThrottle`/`PlanExecutor` どちらが書いても同じ)を直接読むので、ここには含まれない |
| `Player` の各 getter(`rcsDamp` / `magsLeft` 等) | throttle/fire への転送 | — |
| `FocusMarkers` 内部の `shownLabels[].pos`(マップの描画マーカー用、private) | 天体暦から毎フレーム再計算。ただし `MapVisibilityPolicy.body(id).pickable` が立つ天体だけ — 対象外の天体は座標を引かない | `update(t, focusId, toggles, cameraPos)` 毎(`syncLabels()` はこの値をマーカーへ置くだけ) |
| `NavTarget` の相対 AN/DN 位置・通過時刻 | 自機軌道要素 + 対象の軌道面法線からの導出値(id 自体は正本) | `update()` 毎に全消去→再算出 |
| `CreativeStage.preview`(軌道要素 + 位置) | 艦艇配置フォームの現在値からの導出値(正本はフォームの DOM) | `update()` 毎に再算出。パネルを閉じている間・値を解釈できないときは null |
| `CreativeStage.issues`(`PlacementFieldIssue[]`) | 艦艇配置フォームの現在値からの導出値(正本はフォームの DOM。centerRadius/mu は `Ephemeris` から引く) | `update()` 毎に再算出、`sync()` で `ShipPlacerPanel.setIssues()` へ push。パネルを閉じている間は空配列 |
| `PlanDisplay.apsisMarkers` / アイコン位置 | `path.finalSegment()` の `periapsis`/`apoapsis`(末尾 `PlanArc` が積分中に検出した値)を読み、検出時と同じ基準天体(`FinalSegment.apsisCenter`)に対して — その位置だけを極値の時刻で `ephemeris.positionOf` から引き直して — 距離・高度を出した導出値(軌道要素からの解析的な導出ではない — エポック依存の値だと Δv=0 のノード追加でも動いてしまうため) | `apsisIconsOf()` 毎(`update()` から呼ぶ) |
| 操作艦の EqAN/EqDN 位置 | `PlanEditor.update` が渡す `PlanPath.finalSegment()` の `samples` を `findEquatorCrossings` で走査した導出値。それ以外の対象(戦闘ターゲット・基地・航法ターゲット)は軌道要素からの解析的な導出値 | `EquatorNodeMarkerPair.update()` 毎 || `MapPicker.pickables` | `FocusMarkers.bodyPickables(displayTime, visibility)`(そのフレームの `MapVisibilityPolicy` が admits した天体+ラグランジュ点) + 生存中の全 `entities.players`・敵船・弾薬・基地のうち `visibility.entity(kind, ...)` が admits したものの displayState + `NavTarget.mapPickables()` + `PlanDisplay.apsisMarkers` + `entities.all()` の各 `equatorNodes?.mapPickables()` の合成(保持しない使い捨て配列) | `mapPicker.refresh()`(`game.update` 内、`cameraSystem.update()` 直前)毎に作り直す |

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
