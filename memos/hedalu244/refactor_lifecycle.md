# Game のライフサイクル(生成し直し)リファクタリング調査

対象: `Game`(`src/game/game.ts`)がコンストラクタで生成・保持する全サブシステム、およびそれらが
再帰的に生成するもの全般。現状は「ステージの再出撃・タイトル復帰・スナップショットのロード・
スロット切替」を `Launcher`(`src/launcher.ts`)の `restart`/`returnToTitle`/`loadSnapshot`/
`switchSlot` の4メソッドだけが担っており(`src/launcher.ts:109-126`)、いずれも
`location.replace`/`location.assign`(=ページ再読込)で表現している。`game/` 配下・`Game` 自身は
`location.*` を一切呼ばない —— `main.ts` に残るのは致命的エラー画面の再読込ボタン
(`location.reload()`、`src/main.ts:97`)だけである。`Game` の破棄をページごと捨てることで
代行しているのは、この `Launcher` の4メソッドの中身である。

本調査は「`Game` を破棄して同一ページ内で作り直す」という将来像に対して、**何が実装上の妨げに
なっているか**を洗い出すことが目的で、コードの変更は行わない。①目指している仕様 ②現在の挙動
(一次情報) ③妨げの分類 ④GPU資源の境界線 ⑤段階分けした計画 ⑥採らない案 ⑦判断を仰ぎたいこと
⑧併せて直す文書、の順にまとめる。

---

## 1. 目指している仕様

- `Game` に `dispose(): void` を持たせ、呼ぶと以下が成り立つこと。
  - `THREE.Scene` に残る子要素が、`Game` 構築前の状態(星殻等シーン初期化時点のもの)に戻る。
  - `Hud.layers` の各層(`marker`/`panel`/`window`/`popup`/`view`/`notify`)配下に、`Game` が
    追加した DOM 要素が一切残らない。
  - `window`/`document`/canvas に `Game` 側が張ったイベントリスナーが一切残らない。
  - `main.ts` 側のどのオブジェクトも、破棄した `Game` インスタンスへの参照を持ち続けない。
- `dispose()` の後、同じ `Hud`/`Sfx`/`SettingsPanel`/`GameScene`(scene/renderer)を使い回して
  `new Game(...)` を呼び直せば、二重登録・リーク・古い `Game` の誤作動のいずれも起きないこと。
- 上記が満たされて初めて、`Launcher` の `restart`/`returnToTitle`/`loadSnapshot`/`switchSlot`
  をページ再読込から「`Game` を作り直す」呼び出しへ置き換えられる(この置き換え自体は本調査の
  スコープ外だが、⑤の最終段として触れる)。

---

## 2. 現在の挙動(一次情報)

### 2-1. `Game` が生成するサブシステム(`game.ts:88-183`)

`game.ts` のコンストラクタは以下をこの順に構築する(抜粋、詳細は
`DEVELOP/OWNERSHIP.md` §1 の保持木が一次情報):

```
Ephemeris → MarkerManager → EntityManager → DisplayWindowManager → CameraSystem
→ SimSpeedManager → FrameControls → Targeter → NavTarget → Navball → EnvironmentScene
→ ActivePlayerController → PlanEditor → MapPicker → PlanGuide → Input → TouchControls?
→ Simulator → Predictor → activeStage(Stage) → ViewManager → NanWatchdog → Docking
→ ViewBadge
```

これらのうち、`THREE.Scene` へ `scene.add` する・`Hud.layers.*` へ DOM を追加する・
`window`/`document`/canvas にイベントリスナーを張る、のいずれかを行うものを 2-2〜2-4 に挙げる。
**逆に、`Simulator`/`Predictor`/`ActivePlayerController`/`SimSpeedManager`/`NanWatchdog`/
`ViewManager`/`PlanGuide`/`NavTarget` の状態そのものは scene/DOM/リスナーのいずれも持たない
純粋なロジック層で、`dispose()` は不要**(参照が切れれば GC される)。ただし `NavTarget` は
自前の `ContextMenu`(`nav-target.ts:45`)を持つため、そちら経由でのみ dispose が要る
(§2-3 の表を参照 —— 「クラス自身は状態を持たないが、内部に DOM 所有物を1個だけ抱えている」
パターン)。

**注意: `Game` 内部の相互参照(例: `Docking` が `game: Game` を丸ごと持つ ——
`docking.ts:34`、`refactor_dock.md` §3-D で既に指摘済み)は、本調査の対象外である。**
`Docking` は `Game` と同じタイミングで生成・破棄される(`game.ts:177-180`)ので、`Game` が
不要になれば `Docking` ごと GC される。ライフサイクルの妨げになるのは、**`Game` より長生きする
オブジェクトが `Game` (またはその子)への参照を持ち続ける場合だけ**である(2-4 参照)。

### 2-2. `THREE.Scene` に追加されるオブジェクト

| 追加元 | 場所 | dispose() の有無 |
|---|---|---|
| `GameEntity.obj`(自機/敵/補給/基地/小惑星。弾・薬莢・破片(fragment)は `addToScene=false` で InstancedPool 経由) | `game-entity.ts:119` | **あり**(`game-entity.ts:311-315`。`scene.remove(obj)` + `equatorNodes`/`marker` の dispose) |
| `Ship`(自機・敵)のメッシュ配下マテリアル | `ship.ts:385-393` | あり(`super.dispose()` に追加でマテリアルのみ dispose。ジオメトリを触らない理由は §4-1) |
| `Ammo` のメッシュ配下マテリアル | `ammo.ts:47-55` | あり(`Ship.dispose()` と同型のコードが重複) |
| `DebrisPiece`(fragment/casing/barrel/magazineFrame)のメッシュ配下 | `debris-piece.ts:109-123` | あり。`mesh.userData.ownsGeometry`/`ownsMaterial` を見て**共有ジオメトリだけは飛ばす**(`render/ships.ts:174-179,333-334,523-524` が旗を立てる側) |
| `Player.orbitLine`/`.trajectoryLine`(`player.ts:129-132`) | 同上 | あり(`player.ts:528-541`。billboard 3種・markers も含めて全部片付ける、模範的な実装) |
| `Enemy.orbitLine`(`enemy.ts` コンストラクタ) | — | あり(`enemy.ts:142-146`) |
| `Base.orbitLine`(`base.ts:81-84`) | — | **一部だけ**。`base.ts:104-108` は `orbitLine` のみ。`baseState.dockedShips[].player` は `new Player(..., scene, ...)`(`base.ts:90`)で自身のメッシュを scene へ足すが、`Base.dispose()` はこれを一切片付けない(`refactor_dock.md` §3-I で既知) |
| `Targeter.orbitLine`/`.secondaryOrbitLine`(`targeter.ts:50,52`、`scene.add` は `targeter.ts:66-67`) | — | **なし**。`Targeter` クラス自体に `dispose()` が無い |
| `CreativeStage.previewOrbitLine`(`creative-stage.ts:70`) | — | なし(`Stage` 系に `dispose()` が無い) |
| `PlanEditor.gizmo3d.group`(`plan-editor.ts:143`)/`PlanPath.group`(`plan-path.ts:78`。折れ線プール `TrajectoryLine[]` はこの group の子) | — | なし。`TrajectoryLine` 自身は `dispose()` を持つ(`trajectory-line.ts:152`)が、`PlanPath`/`PlanEditor` からそれを呼ぶ経路が無い |
| `EnvironmentScene`(`geoLine`/`ambient`/`sunLight`/`starsMesh`/`celestialGrid` の内部6本の線/`referenceLines`)(`environment-scene.ts:81,89,91,93,236` ほか) | — | **なし。クラス全体に `dispose()` が存在しない** |
| `CelestialBody` 実装4種(`SunBody`/`SphereBody`/`PointBody`/`EarthBody`。レジストリ登録101体ぶん、`celestial-registry.ts` 経由で `body.build(scene)`) | `sun-body.ts:26-27`、`sphere-body.ts:63,66`、`point-body.ts:90,93,95`、`earth-body.ts:18` | **いずれも `dispose()` が存在しない** |
| `PointFieldView`(小惑星帯等11,200点、群ごとに1 InstancedMesh) | `point-field-view.ts:68` | なし |
| `render/celestial-grid.ts` `CelestialGrid`(基準円×2・グリッド×2・極マーカー×2の計6本) | `celestial-grid.ts:148,162,176` | なし |
| `EntityManager` の5本の `InstancedPool`(bulletBody/bulletHalo/plasma/casing/debrisFragment×バリアント数) | `entity-manager.ts:68-73` | なし。`InstancedPool` クラス自体に `dispose()` が無い(`instanced-pool.ts` 全53行、`scene.add` は l.30) |
| `EffectsSystem`(`FlashEffectManager`)の `InstancedPool` | `flash-effect-manager.ts:32` | 同上、なし |

**まとめ**: エンティティ単体(`GameEntity` 系列)の dispose は既にほぼ作り込まれている
(§2-5 参照)。**空いている穴は、この上に乗る「環境(EnvironmentScene 一式)」「計画表示・カメラ・
ターゲットの補助線」「InstancedPool」の3系統**で、いずれもクラス自体に `dispose()` が存在しない。

### 2-3. DOM 要素(`Hud.layers` 配下、および `#hud` の外)

`Hud`(`src/game/hud/hud.ts`)は `main.ts` が `Game` より先に構築し、`Game` へ参照として渡す
(`main.ts:196,223`)。`Hud.layers`(`overlay-layer.ts` の7層)自体は `Game` の生死と無関係に
生き続けるので、**`Game` が消えても「層」という入れ物は残る** —— 問題は層の**中身**を誰が空にするか。

`buildHudDom()`(`hud/dom.ts`、`Hud` コンストラクタが1回だけ呼ぶ)が静的に組む要素
(`#hud-status`/`#hud-orbit`/`#hud-enemies`/`#hud-target`/`#hud-stagestatus`/`#hud-help`/
`#hud-hint`/`#hud-toast` 等、固定 id を持つもの)は `Game` の再生成をまたいで再利用してよい
(`HudPanels.sync(game, attractors)` は `game.ts:420` で **`Game` を毎フレーム引数として渡す
だけで保持しない** —— 模範的なパターン)。

これに対し、以下は **`Game` のコンストラクタが `new` するたびに新しい DOM を `Hud.layers.*` へ
追加する側**で、対応する `dispose()` がクラスに存在しない:

| クラス | 追加先 | DOM 構築箇所 | dispose() |
|---|---|---|---|
| `DisplayWindowManager` → `DisplayTimePanel` | `layers.panel` | `game.ts:117` | なし |
| `CameraSystem` → `OverviewCameraPanel` | `layers.panel` | `camera-system.ts:119` | なし |
| `FrameControls` → `AnchorZone`×2 / `RotationZone`×2 | `layers.panel`(本体)+`layers.popup`(ObjectPicker) | `frame-controls.ts:80,85,93,101` | なし |
| `PlanEditor` → 軌道計画パネル本体 + `HudHoldButton`×6(`dvButtons`) + `NodeGizmo` + `PlanGizmo3D` | `layers.panel`/`layers.marker`/`layers.popup` | `plan-editor.ts:114,139-143` | なし |
| `MapPicker` → `ObjectListPanel` + `ContextMenu`('empty-space' 用) + 開いている `PropertyWindow` 群(`windows: Map`) | `layers.panel`/`layers.popup`/`layers.window` | `map-picker.ts:97,102` | **`PropertyWindow` 単体は `closeWindow` 経由で dispose される(`map-picker.ts:322`)。しかし `MapPicker` 自体、`ObjectListPanel`、`menu` に dispose が無いので、`Game` 破棄時点で開いていた窓は永久に残る** |
| `Docking` → `DockView` | `layers.view` | `docking.ts:45` | `DockView.dispose()` は存在する(`dock-view.ts:612-614`)が、**呼び出し元が無い**(後述) |
| `ViewBadge` | `layers.notify` | `game.ts:182` | なし |
| `Targeter` → `ContextMenu`×2 | `layers.popup` | `targeter.ts:64-65` | なし |
| `NavTarget` → `ContextMenu`(基地用) | `layers.popup` | `nav-target.ts:45` | なし |
| `Navball` → `NavballPanel` | `layers.panel` | `navball.ts` 構築時 | なし |
| `activeStage`(`StageStatusPanel`、CreativeStage のみ `ShipPlacerPanel`) | `layers.panel` | `stage.ts`/`creative-stage.ts` | なし(`Stage` 系に dispose が無い) |
| `MarkerManager`(方向マーカー・combatMarkers・leadMarkers・EqAN/DN 等のプール) | `layers.marker`/`svgOverlay` | `game.ts:114` | **なし。プール自体に dispose が無い**(個々のエントリは所有エンティティの dispose 経由で `remove` されるものと、`hide` だけで DOM が残り続ける固定キー枠が混在 —— 後者は `MarkerManager.dispose()` が無ければ回収経路が無い) |
| `TouchControls`(タッチ端末のみ) | **`document.body` 直下**(`#hud` の外、`touch.ts:173-176`) | `game.ts:158` | なし |

`PerfMeter` の `PropertyWindow`(`perf-meter.ts:105-113`)は例外的によく出来ている —— `close()`が
`this.win?.dispose()` を呼ぶ(`perf-meter.ts:118`)。ただし `PerfMeter` 自体は main.ts 所有で
`Game` より長生きするため、この項目は §2-4 で扱う。

### 2-4. イベントリスナー

`window`/`document` に張られる listener を実際に洗った結果、**自己完結して片付くもの**と
**片付かないもの**がはっきり分かれた。

**a) 自己完結して片付くもの(参考・問題なし)**:
- `stage-select.ts:113` の `window.addEventListener('keydown', onKey)` は選択確定時
  `window.removeEventListener('keydown', onKey)`(`stage-select.ts:99`)で自分から外す。
- `save-transfer.ts:107` の `window.addEventListener('focus', onWindowFocus)` も `settle()`
  (`save-transfer.ts:91`)で自分から外す。
- どちらも「開始点と終了点が同じ関数の中に閉じている」ワンショットの待受けで、リーク要因にならない。
  **同じ書き方を Game 系のリスナーにも適用できる**、というのが直し方の指針になる。

**b) 片付かないもの(`dispose()` 不在・または listener 自体を保持していない)**:

| 発生元 | 内容 | 件数/インスタンス | removeEventListener できるか |
|---|---|---|---|
| `Input`(`game.ts:156`) | `window`: keydown/keyup/blur/pagehide(4)、`document`: visibilitychange(1)、canvas(`target`): contextmenu/pointerdown/pointermove/pointerup/pointercancel/dblclick(6)、wheel(1) | 1 インスタンスにつき **12** | **不可**。`input.ts:77-95,107-117,220-228` はすべて無名の矢印関数で `addEventListener` に直渡し —— 参照を保持していないので `removeEventListener` する術が無い。`dispose()` 自体が存在しない |
| `ContextMenu`(`context-menu.ts`) | `window`: resize(無名関数)+keydown(`this.handleKeyDown`)、`document`: pointerdown capture(無名関数) = 3 | 7 インスタンス(`targeter.ts:64-65`、`map-picker.ts:97`、`view-badge.ts:26`、`nav-target.ts:45`、`node-gizmo.ts:109`、`plan-editor.ts:141`) → **のべ21listener** | resize と pointerdown は無名関数なので不可能。keydown は `this.handleKeyDown` を束ねているので技術的には外せるが、`dispose()` 自体が無い |
| `ObjectPicker`(`object-picker.ts:107-110`) | `document`: pointerdown capture(無名関数) | 4 インスタンス(`anchor-zone.ts:43` ×2、`ship-placer-panel.ts:485,571`) → のべ4 | 不可(無名関数)。`dispose()` 無し |
| `TouchControls`(`touch.ts:154`) | `window`: カスタムイベント `tepui-release-touch-inputs`(無名関数) | 1(タッチ端末のみ) | 不可。`dispose()` 無し |
| `ShipPlacerPanel`(`ship-placer-panel.ts:629`) | `window`: keydown(無名関数、`this._isOpen` で内部ガードするだけ) | 1(CreativeStage のみ) | 不可。`dispose()` 無し |

`PropertyWindow`(`property-window.ts:240-243`)は `document.pointerdown`/`window.resize`/
`window.keydown` の3つを **すべて `this.onOutsidePointerDown`/`this.onResize`/
`this.handleKeyDown` というインスタンスフィールドに束ねて張り**、`dispose()`
(`property-window.ts:521-528`)で3つとも `removeEventListener` する。**この設計が、
上表の全クラスが倣うべき唯一のお手本**である。

**実害の程度について**: `window`/`document` 側の listener は「古い `Game`(と、それが握っていた
`Input`/`ContextMenu` 等)を永久に GC 対象から外す」という意味でのリークではあるが、
**古い `Input` の `update()` はもう誰にも呼ばれない**(呼ぶのは死んだ `Game.update` だけ)ので、
古い `pendingPresses` 等が溜まり続けるだけで実際のゲーム挙動に二重発火は起きない ——
という理解で正しいか、Stage を跨いだ地道な検証(`/verify` あるいは手動)は行っていない
(**未検証、憶測ではなく明記**)。一方 **canvas(`target`)側の listener は canvas 自体が
`GameScene` 所有で `Game` の再生成をまたいで生き続ける**ため、`Game` を作り直すたびに
`pointerdown`/`pointermove`/`wheel` 等が新旧の `Input` へ二重に配送され続ける ——
実処理は古い `Input` 側で握りつぶされる(誰も読まない)としても、**イベントの実配送コストと
参照保持は Game を作り直した回数だけ線形に積み上がる**。

### 2-5. `main.ts` が `Game` インスタンスを直接抱えているもの

| クラス | 保持方法 | 用途 | 対比 |
|---|---|---|---|
| `PerfMeter`(`main.ts:240: new PerfMeter(game, hud.layers.window, gs.renderer, sections)`) | コンストラクタ引数で受け、`private readonly counts: PerfCountSource`(`perf-meter.ts:80-87`)として**フィールドに保存** | `flush()`(`perf-meter.ts:181`)が `this.counts.perfCounts()` を毎回呼ぶ | — |
| `SaveBrowser`(`main.ts:227: new SaveBrowser(hud.layers.system, slots, snapshotService, game, hud.modalController)`) | `private readonly game: Game`(`save-browser.ts:51-56`)として**フィールドに保存** | `open()`/`close()` が `game.pause()`/`resume()`(`save-browser.ts:73,80`)、`canCaptureNow()` が `game.activeStage.isPlaying`(`save-browser.ts:91`)、`stageId === this.game.activeStage.id`(`save-browser.ts:162`)、手動クリップが `service.capture(this.game, ...)`(`save-browser.ts:307`) | — |
| `AutoSave`(`main.ts:247: new AutoSave(snapshotService)`) | `Game` を**保持しない**。`update(game: Game)`(`autosave.ts:14`)が**毎フレーム引数で受け取る** | `Game` が作り直されても呼び出し側(rAFループ)が新しい `game` を渡すだけで済む | **模範** |
| `SnapshotControls`(`main.ts:246: new SnapshotControls(hud, settingsPanel, saveBrowser, snapshotService)`) | 同上、`Game` を保持しない。`handleInput(input: Input, game: Game)`(`snapshot-controls.ts:19`)が毎フレーム引数 | 同上 | **模範** |

`PerfMeter`/`SaveBrowser` は「`Game` を丸ごと構築時に受け取ってフィールドへしまう」設計、
`AutoSave`/`SnapshotControls` は「呼び出しのたびに引数で受け取る」設計 —— **同じ main.ts が
同じ問題を2通りのやり方で解いており、後者だけが `Game` の生成し直しと両立する。**

`main.ts` が `settingsPanel`/`saveBrowser` という **main.ts 所有で `Game` より長生きする
オブジェクトのコールバックプロパティ**に代入しているクロージャは6つあるが、`game` を実際に
捕まえているのは1つだけと数え直せる:

- `settingsPanel.onQuitToTitle`(`main.ts:199`)— `launcher.returnToTitle()` への委譲のみ、`game` は捕まえない
- `saveBrowser.onSlotSwitched`(`main.ts:228`)— `launcher.switchSlot()` への委譲のみ
- `saveBrowser.onLoadSnapshot`(`main.ts:229`)— `launcher.loadSnapshot(id)` への委譲のみ
- `settingsPanel.onOpenSnapshots`(`main.ts:231-234`)— `settingsPanel`/`saveBrowser` を読むだけで `game` は捕まえない
- `settingsPanel.onSettingsOpenChange`(`main.ts:236-239`)— `game.pause()`/`game.resume()`。**`game` を直接捕まえる唯一のクロージャ**
- `settingsPanel.onOpenPerfWindow`(`main.ts:242-245`)— `settingsPanel`/`perf` を読むだけで `game` は捕まえない

`onQuitToTitle`/`onSlotSwitched`/`onLoadSnapshot` は `Launcher` の対応するメソッドへ委譲するだけで
(§1)、`game` を捕まえない。`onOpenSnapshots`/`onOpenPerfWindow` も
`settingsPanel`/`saveBrowser`/`perf` という main.ts 所有の別オブジェクトを読むだけで、`game`
自体は登場しない —— ただしその `saveBrowser`/`perf` 自身が上の表の通り `Game` をフィールドに
保存しているため、この2つのクロージャが `game` を直接捕まえていないことは `Game` の生成し直しと
両立する理由にはならない。**`main()` 関数のローカル `const game` を捕まえたクロージャは
`settingsPanel.onSettingsOpenChange` の1箇所だけ**であり、`Game` を作り直すたびに
**配線し直す**必要があるのもここだけである。加えて `startAnimationLoop`(`main.ts:117-164`)の
`animate` 関数自体が `game`(関数引数、`main.ts:118`)を閉じ込めた単一の rAF ループであり、
**同じループを維持したまま参照先の `Game` だけ差し替える口が無い**(`const game` の再代入も、
二重の `requestAnimationFrame` チェーンを避ける仕組みも、今は存在しない)。`animate` 内の
`launcher.update(game)`/`launcher.handleInput(game.input, game)`(`main.ts:134,137`)自体は
`AutoSave`/`SnapshotControls` と同じく `game` を引数で受け取るだけの模範の形だが、それを呼ぶ
`animate` 自身が特定の `Game` を閉じ込めているという問題は変わらない。

### 2-6. 既存の `dispose()` 実装の棚卸し(何をしていて何をしていないか)

| クラス | 何をするか | 何をしないか |
|---|---|---|
| `GameEntity.dispose()`(`game-entity.ts:311-315`) | `scene.remove(obj)`・`equatorNodes?.dispose()`・`marker?.dispose()` | `obj` 配下のメッシュのジオメトリ/マテリアルは触らない(サブクラスの責務) |
| `Ship.dispose()`(`ship.ts:385-393`) | `super.dispose()` に加え、配下メッシュの**マテリアルのみ** dispose | **ジオメトリは dispose しない** —— 意図的。`render/ships.ts:73-78` の設計注記どおり、`cloneIndependent()` はマテリアルだけを個体ごとに複製し、ジオメトリは `template.clone(true)` の既定動作でモジュールキャッシュ(`parsePlayer`/`parseEnemy` 等)と**参照共有**したまま(three.js の `Mesh.copy()` は `this.geometry = source.geometry` —— 参照代入のみ)。ここで geometry を dispose すると、同じ型の艦を後から作った瞬間に壊れた GPU バッファを参照することになる |
| `DebrisPiece.dispose()`(`debris-piece.ts:109-123`) | `mesh.userData.ownsGeometry`/`ownsMaterial` が立っているメッシュだけ dispose | 立っていないメッシュ(`magazineFrameTemplate`・薬莢の共有ジオメトリ等、`render/ships.ts:174-179,333-334`)はスキップ —— 「所有権フラグを見てから壊す」という、本調査が要求する境界線をまさに体現した実装 |
| `Player.dispose()`(`player.ts:528-541`) | `disposed` フラグで二重実行を防止 → `markers`/`orbitLine`/`trajectoryLine`/`thrustEffects`/`rcsEffects`/`reentryEffects` を個別に dispose → `super.dispose()`(`Ship.dispose()`) | 網羅的。**このクラスが「1つのオブジェクトが持つ全付帯物を dispose する」お手本** |
| `Base.dispose()`(`base.ts:104-108`) | `orbitLine` のみ | `obj` 自体のマテリアル(`Ship`/`Ammo` と違い dispose しない)、`baseState.dockedShips[].player` の dispose のいずれもしない(§2-2 既出) |
| `OrbitLine.dispose()`(`orbit-line.ts:139-141`) | 内部の `Curve.dispose()` を呼ぶ | `this.line` を scene から外すのは**呼び出し側の責務**(`Enemy`/`Base`/`Player`/`Targeter` 等が `scene.remove(orbitLine.line)` を自分でやる約束。`Targeter` はこの約束を果たす側の実装自体が無い) |
| `Curve.dispose()`(`curve.ts:522-525`) | 自前の `geom`/`mat`(固定容量バッファ、コンストラクタで確保)を dispose | scene からの除去はしない(`OrbitLine`/`TrajectoryLine` の責務) —— このクラスは per-instance のバッファしか持たないので、これで問題なく完結する |
| `TrajectoryLine.dispose()`(`trajectory-line.ts:152`) | 内部 `Curve` を dispose | 呼び出し元が現状 `Player.dispose()` の1箇所しかなく、`PlanPath` が保持するプール分(区間ごとの折れ線)は誰にも呼ばれない |
| `Billboard.dispose()`(`billboard.ts:42-45`) | 自前の `PlaneGeometry`/`MeshBasicMaterial` を dispose | 共有される `getGlowTexture()`(`glow-texture.ts`)のテクスチャは触らない(`material.dispose()` は three.js の仕様上 `material.map` の texture までは連鎖 dispose しない —— マテリアル自体はコンストラクタで毎回 `new` する per-instance なので、これで正しい) |
| `EntityMarker.dispose()`/`EquatorNodeMarkerPair.dispose()`(`entity-marker.ts:70`、`equator-node-marker-pair.ts:99`) | `MarkerManager` のプールから自分のキーを `remove` する | プール自体(`markerDictionary`)を空にする経路はこれだけでは作れない —— 「固定キー枠」(方向マーカー等)は元々どのオブジェクトの dispose からも呼ばれない(§2-2 既出) |
| `PropertyWindow.dispose()`(`property-window.ts:521-528`) | `disposed` フラグ → 3つの global listener を `removeEventListener` → `this.el.remove()` | 網羅的。**リスナー処理のお手本**(§2-4 既出) |
| `DockView.dispose()`(`dock-view.ts:612-614`) | `this.el.remove()` | **誰からも呼ばれていない**(`docking.ts` を含め呼び出し箇所ゼロ)。書かれているのに配線されていない、宙に浮いた実装 |
| `SaveBrowser.dispose()`(`save-browser.ts:379-381`) | `this.el.remove()` | 同上、呼び出し箇所ゼロ(`SaveBrowser` は main.ts 所有の恒久オブジェクトなので今は不要なだけで、間違いではない) |

**総評**: 「オブジェクト単体が自分の付帯物を片付ける」レベルの `dispose()` はエンティティ層
(`GameEntity`/`Ship`/`DebrisPiece`/`Player`)と一部の描画プリミティブ(`Curve`/`OrbitLine`/
`TrajectoryLine`/`Billboard`)、一部の HUD ウィジェット(`PropertyWindow`)で**既にほぼ
正しく実装されている**。欠けているのは主に2つ:
(a) その一段上、**`Game` が直接持つサブシステム自体に `dispose()` が無い**こと、
(b) 書かれている `dispose()` を**呼ぶ側の配線が無い**こと(`DockView` が典型)。

---

## 3. 妨げの分類

大きく2種類に分かれる。

### 3-A. 「`dispose()` を書けば済むもの」

所有関係(誰が誰を new し、誰が誰への参照を持つか)は現状のままでよく、**該当クラスに
`dispose()` を追加し、親の `dispose()` から呼ぶだけ**で解決するもの。

- `EnvironmentScene` とその配下(`CelestialBody` 4実装、`PointFieldView`、`CelestialGrid`、
  `geoLine`/`referenceLines`、`ambient`/`sunLight`/`starsMesh`)
- `render/instanced-pool.ts` の `InstancedPool`(→ `EntityManager` の5プール、
  `FlashEffectManager` の1プール)
- `CameraSystem`(→ `OverviewCameraPanel`)、`DisplayWindowManager`(→ `DisplayTimePanel`)、
  `FrameControls`(→ `AnchorZone`×2/`RotationZone`×2)、`PlanEditor`(→ 軌道計画パネル・
  `dvButtons`・`NodeGizmo`・`PlanGizmo3D`・`PlanDisplay`→`PlanPath`→`PlanArc`[]/
  `TrajectoryLine[]`)、`Docking`(→ 既存の `DockView.dispose()` を**呼ぶだけ**)、
  `ViewBadge`、`Targeter`(→ 2本の `OrbitLine` + `ContextMenu`×2)、`MapPicker`
  (→ `ObjectListPanel` + 残存 `PropertyWindow` 群 + `ContextMenu`)、`NavTarget`、`Navball`
  (→ `NavballPanel`)、`MarkerManager`(プール一括除去)
- `Stage`(`activeStage`)とその配下(`StageStatusPanel`、CreativeStage の `ShipPlacerPanel`・
  `previewOrbitLine`)
- `ContextMenu`・`ObjectPicker` —— `PropertyWindow` と同じ形(listener をインスタンスフィールドへ
  束ねて `dispose()` で外す)に直すだけ。**Game のライフサイクルと無関係に、今すぐ直しても副作用が
  無い正しさの改善**(現状どの owner も `Game` の生存中は破棄されないので実害は無いが、直す
  こと自体はいつでもできる)
- `Input`・`TouchControls` —— `Input` の12リスナーを名前付き関数へ束ねて `dispose()` で外す。
  `TouchControls` は `document.body` 直下の `#touch-ui` を丸ごと `remove()` すればよい
- `Base.dispose()` の拡張(`dockedShips[].player.dispose()` を回す)、`Ship`/`Ammo` の
  マテリアル dispose 処理の重複除去(ついでの整理、必須ではない)

**これらは「所有木の形を変えずに、抜けている葉を足すだけ」の作業で、`refactor` skill の
言う「モジュールの責務そのものは変わらない」範囲に収まる。**

### 3-B. 「所有関係そのものを変えないと解けないもの」

`Game` より**長生きする**オブジェクトが `Game`(またはその子)への参照を持っている場合、
`dispose()` を足すだけでは解決しない —— 参照の持ち方自体を変える必要がある。

| 対象 | 何が問題か | 解法の方向 |
|---|---|---|
| `PerfMeter.counts`(`perf-meter.ts:80-87`) | `Game` をコンストラクタで受けフィールドに保存。`Game` を作り直しても古い方を握り続ける | `AutoSave`/`SnapshotControls` に倣い、`counts: PerfCountSource` をフィールドから外し、`record()`/`flush()` に**引数**として渡す。`PerfMeter` 自体は main.ts 所有のまま生かせる |
| `SaveBrowser.game`(`save-browser.ts:51-56`) | 同上。`open()`/`close()`/`capture()` が全部 `this.game` を読む | 同上、`game: Game` をフィールドから外し `open(game)`/`canCaptureNow(game)` 等の引数へ倒す。ただし `open()`/`close()` は DOM イベントハンドラから叩かれる(`main.ts` のボタン等)ため、**呼び出し元(main.ts)側が常に最新の `game` を渡せる状態を保つ**必要がある(下記) |
| `main.ts` の `settingsPanel.onSettingsOpenChange` クロージャ(`main.ts:236-239`) | `const game` を捕まえたクロージャが `SettingsPanel` という長寿命オブジェクトのプロパティに刺さっている(§2-5 の通り、これが今 `game` を直接捕まえる唯一のクロージャ) | `main()` に「現在の `Game`」を指す `let currentGame: Game`(または同等のミュータブルな入れ物)を持たせ、クロージャは `currentGame` を経由して読むようにする。`Game` を作り直すたびに `currentGame` を差し替えるだけで済み、コールバックの再配線は不要になる |
| `startAnimationLoop` の `animate` クロージャ(`main.ts:117-164`) | rAF ループ自体が特定の `Game` インスタンスを閉じ込めている。作り直しに対応する口が無い | 上記 `currentGame` と同じ入れ物を経由して `game.update(dt)` 等を呼ぶよう書き換える。ループ自体は張り直さない(二重 rAF を防ぐ) |
| `Launcher`(`launcher.ts:38-39`: `launchedStage`/`resultShown`) | `Game` への参照は持たない —— `update(game)`/`handleInput(input, game)`(`main.ts:134,137`)は `AutoSave`/`SnapshotControls` と同じく毎フレーム**引数**で受け取るだけで、フィールドには保存しない(§2-5)。ただし `Game` より長生きする main.ts 側オブジェクトとして、**周回をまたいで保持する状態**(どのステージを起動したか・今回の決着をもう結果画面に出したか)を持つ。`resultShown` は一度 `true` になったあとリセットする経路が無く(今はページ全体の再読込で消えるため問題にならない)、`Game` を作り直す設計になると次の周回の決着を検知できなくなる | `Game` への参照の持ち方は変える必要が無い(3-A/3-B いずれの意味でも問題ではない)。かわりに `Game` を作り直す側(main.ts)から「新しい周回が始まった」と `Launcher` へ伝える口(例: `beginRun(stageClass)` が `resultShown` をリセットしつつ `launchedStage` を更新する)を新設する必要がある —— 3-A/3-B のどちらにも収まらない、**周回境界の通知**という3つ目の性質 |
| `Hud`/`Sfx`/`SettingsPanel`(main.ts 所有、`Game` へ参照として渡すだけ) | これ自体は**問題ではない**(意図的な設計 —— タイトル画面が `Game` 構築前から `Hud`/`Sfx` を要るため)。ただし `Game` が `Hud.layers` へ積み上げる DOM/`MarkerManager` の SVG 要素等を**自分で全部片付けない限り**、`Hud` を使い回すこと自体が「前の Game のゴミが残った土台の上に次の Game を建てる」結果になる | 3-A の DOM 系 `dispose()` が揃えば自動的に解決する(`Hud` 自体の設計を変える必要は無い) |
| `THREE.Scene`/`WebGPURenderer`(`GameScene`、main.ts 所有) | 同上、`Game` より長生きするのは意図通り。`Game.dispose()` が自分の追加物を全部 `scene.remove` すれば scene 自体は使い回せる | 3-A が揃えば解決。`GameScene` 自体に手を入れる必要はない |

**3-A と 3-B の境目**: 3-A は「木の中に新しい `dispose()` を書き足す」作業(既存の設計方針
`/refactor-fixed` に抵触しない)。3-B は「木の**外**(main.ts)から木の**中**(`Game`)への
参照の持ち方」を変える作業で、`/refactor-fixed` §13(二段初期化を作らない)の裏返し ——
**「`Game` は `new` で完全に組み上がる」ことの対になる「`Game` は参照を持たれたまま消せない
場所が無い」**という制約を、main.ts 側にも要求することになる。

---

## 4. GPU資源の境界線

`dispose()` を機械的に「配下を全部たどって `.dispose()` する」形で書くと、**モジュールスコープの
共有リソースを壊し、次に作る `Game` を巻き添えにする**。今回の調査で確認した「触ってよいもの/
触ってはいけないもの」の境界を明文化する。

### 4-1. 触ってはいけないもの(モジュールスコープの永続キャッシュ)

- `src/render/ships.ts` の `memoParse`(`parsePlayer`/`parseEnemy`/`parseStage0EnemyA-C`/
  `parseMagazine`/`parseAmmo`/`parseCasing`/`parseDebrisChunk`/`parseDebrisPanel`/
  `parseDebrisRod`、`ships.ts:96-103,119-131`)がキャッシュする `THREE.ObjectLoader` の
  パース結果 —— **ジオメトリ**は `cloneIndependent()`(`ships.ts:79-94`)を経ても
  clone されず(three.js の `Mesh.copy()` は `this.geometry = source.geometry` と参照代入
  するのみ)、同じ型の全インスタンスで共有され続ける。マテリアルだけが個体ごとに複製される
- `casingGeometry`/`casingMaterial`(`ships.ts:136-149`、`initCasingResources()`)、
  `debrisFragmentResources`(fragment バリアントの共有ジオメトリ・単色マテリアル)、
  `bulletBodyResources`/`bulletHaloResources`/`plasmaBodyResources`/`casingBodyResources`
  (`ships.ts:281-341`)—— いずれもモジュールレベルの `let`/クロージャで一度だけ作られ、
  **`EntityManager` を何度作り直しても同じ参照が返る**(`bulletBodyResources()` は内部で
  `parseBullet()` = `memoParseShared` を呼び、返る `geometry`/`material` は初回パース時の
  ものと同一参照)。ここを `InstancedPool.dispose()` が誤って dispose すると、**2つめの
  `Game` の弾がいきなり描けなくなる**
- `src/render/celestial-surface.ts` の `sharedLodGeometries`(`celestial-surface.ts:35-45`、
  `SPHERE_LOD_LADDER` の段ごとに1本の単位球ジオメトリを全天体で共有)
- `src/render/glow-texture.ts` の `getGlowTexture()`(`Billboard`・flash 共有のグローテクスチャ、
  `CanvasTexture` を1つだけキャッシュ)
- `render/ships.ts` の `magazineFrameTemplate`/`barrelTemplate` 等、`mesh.userData.ownsGeometry
  = false` が明示的に立っているメッシュ(`ships.ts:174-179,523-524`)—— **この旗が既に
  存在する箇所は判断基準がコード上に明記されている**ので、`InstancedPool`/`EnvironmentScene`
  側の新規 `dispose()` を書く際もこの旗の有無を確認すればよい

これらは JS のモジュールがロードされている限り(=ページがリロードされない限り)自然に
生き続けるので、**`Game.dispose()` からは一切触らない**というのが唯一の正しい境界線になる。
`ships.ts:73-78` のコメントが自ら「そういう用途のテンプレートは複製し直す」と明記しており、
この規約は「1つの `Game` の中でエンティティが何度生成・破棄されても共有ジオメトリは崩れない」
という形で既にコード側の意図として存在する —— 今回の調査はその適用範囲を「1つの `Game` の
中の複数エンティティ」から「複数の `Game` インスタンスをまたぐ複数エンティティ」へ広げるだけで、
規約そのものは変える必要が無い。

### 4-2. 個体ごとに dispose してよいもの

- `cloneIndependent()` を経て複製されたマテリアル(`mesh.userData.ownsMaterial = true`)
- `Curve`/`Billboard` が自前の `new` で確保するジオメトリ・マテリアル(固定容量バッファ、
  per-instance)
- `CelestialSurface.textured()` が `new THREE.TextureLoader().load(url)` で毎回新規に読み込む
  テクスチャ(**キャッシュされていない** —— `celestial-surface.ts:125`。同じ URL でも
  `Game` を作り直すたびに新しい `THREE.Texture` が GPU 上に確保される。放置すると
  `Game` を作り直した回数だけ地球/惑星テクスチャが GPU メモリに重複する)
- `InstancedMesh` 自体(`geometry`/`material` は共有でも、`InstancedMesh` インスタンスと
  その `instanceMatrix`/`instanceColor` バッファは `InstancedPool` ごとの専有)—— scene から
  `remove` するだけでよく、`geometry`/`material` には触れない

### 4-3. 未検証・要確認の点(明記)

- `CelestialSurface` の `dispose()` を書く場合、`textured()` が生成する `THREE.Texture` は
  現状インスタンスのフィールドとして保持されていない(TSL の `textureNode(map, uv())` に
  埋め込まれるのみ、`celestial-surface.ts:124-128`)。**`material.dispose()` が
  `MeshBasicNodeMaterial` の TSL ノードグラフ経由で参照しているテクスチャまで連鎖的に
  解放するかどうかは、three.js/TSL の仕様を実機で確認していない**。連鎖しないなら
  `textured()` 側で `map` を返り値かフィールドとして保持し直す設計変更が要る。本調査では
  ここまでは踏み込まず、Stage 2(§5)着手時に検証すべき事項として残す
- `InstancedMesh.instanceMatrix`/`instanceColor`(`InstancedBufferAttribute`)が
  `WebGPURenderer` 側にバインドグループとして確保した GPU バッファを、mesh を scene から
  `remove` しただけで実際に解放するか(three.js は通常 `Object3D` 自体に `dispose()` は
  無く、`geometry`/`material`/`texture` の `dispose()` イベントを renderer 側が拾って
  解放する設計)は、`InstancedMesh` の attribute バッファがどちらの扱いになるか未確認。
  安全側に倒すなら `InstancedPool.dispose()` は `scene.remove(mesh)` に加えて
  `mesh.instanceMatrix.dispose?.()` 等を試みる形にし、実機(`/verify` のヘッドレス計測、
  または DevTools の GPU メモリプロファイル)で確認するのが望ましい

---

## 5. 段階分けした計画

各段で `npm run typecheck` が通り、各段が単独で意味を持つことを条件にする。3-A(dispose を
書けば済むもの)を先に片付け、3-B(main.ts 側の参照の持ち方)は 3-A が揃ってから着手する
—— 3-B だけ先にやっても「作り直した Game を捨てられない」状態のままなので効果が測れない。

| Step | 内容 | 対応する分類 |
|---|---|---|
| 1 | `InstancedPool.dispose()`(`scene.remove(mesh)` のみ、geometry/material は触らない)を追加。`EntityManager`/`FlashEffectManager` に `dispose()` を追加してこれらを呼ぶ。あわせて `EntityManager.dispose()` は残存する全エンティティ(`players` を含む8配列)を `.dispose()` する(現状の `prune`/`cleanup` は `!alive` のものしか片付けないため、生きたまま `Game` が終わるケースを別途カバーする必要がある) | §2-2 InstancedPool、§3-A |
| 2 | `Base.dispose()` を拡張し `dockedShips[].player.dispose()` を回す。`Ship`/`Ammo` のマテリアル dispose の重複を `Ship` 側の共通実装へ寄せる(ついで) | §2-2 Base、`refactor_dock.md` §3-I の一部先取り |
| 3 | `CelestialSurface`/`SphereBody`/`PointBody`/`SunBody`/`EarthBody`/`RingView`/`CelestialGrid`/`PointFieldView` に `dispose()` を追加(§4-1 の共有ジオメトリ境界を守る。§4-3 のテクスチャ連鎖は実機確認してから確定)。`EnvironmentScene.dispose()` でこれらと `geoLine`/`referenceLines`/`ambient`/`sunLight`/`starsMesh` をまとめる | §2-2 EnvironmentScene、§4 |
| 4 | `ContextMenu`/`ObjectPicker` を `PropertyWindow` と同型(listener をフィールドへ束ねる)に直し、`dispose()` を追加。**この段は Game のライフサイクルと無関係に今すぐ着手でき、既存の正しさの改善として独立に価値がある** | §2-4、§3-A |
| 5 | `Targeter`/`NavTarget`/`Navball`/`MapPicker`(`ObjectListPanel` 含む)/`FrameControls`/`CameraSystem`(`OverviewCameraPanel`)/`DisplayWindowManager`(`DisplayTimePanel`)/`Docking`(既存の `DockView.dispose()` を呼ぶだけ)/`ViewBadge` に `dispose()` を追加。Step 4 で直した `ContextMenu`/`ObjectPicker` をここで実際に使う。`ViewManager`/`PlanGuide` は自前の scene/DOM を持たないため対象外(§2-1 注記) | §2-2〜2-3、§3-A |
| 6 | `PlanEditor`(→`PlanDisplay`→`PlanPath`→`PlanArc[]`/`TrajectoryLine[]`、`NodeGizmo`、`PlanGizmo3D`、`dvButtons`)に `dispose()` を追加。`MarkerManager.dispose()` を追加し、プール全体を一括除去する | §2-2〜2-3、§3-A |
| 7 | `Stage`(`activeStage`)に `dispose()` を追加(`StageStatusPanel`、CreativeStage の `ShipPlacerPanel`/`previewOrbitLine`)。`Input.dispose()`(12リスナー)・`TouchControls.dispose()` を追加 | §2-2〜2-4、§3-A |
| 8 | `Game.dispose()` を新設し、Step 1〜7 で用意した各サブシステムの `dispose()` を(概ね構築の逆順で)呼ぶ。この時点で `new Game(...)` → `dispose()` を繰り返しても scene/DOM が増え続けないことを確認できる(検証は `/verify` skill、または DevTools でシーン子要素数・DOM ノード数を比較) | §3-A の総仕上げ |
| 9 | `PerfMeter`/`SaveBrowser` から `Game` フィールドを外し、必要なメソッドへ引数として渡す形に直す(`AutoSave`/`SnapshotControls` と同型)。`main.ts` に `currentGame` 相当のミュータブルな入れ物を導入し、`settingsPanel`/`saveBrowser` のコールバックと `startAnimationLoop` をそれ経由に書き換える | §3-B |
| 10(最終・任意) | `Launcher` の `restart`/`returnToTitle`/`loadSnapshot`/`switchSlot` の4メソッドを `location.replace`/`assign` から「`game.dispose()` → `new Game(...)`」呼び出しへ置き換える。`location.*` を呼ぶのは既にこの4メソッドだけに集約されているため(§1)、置き換え対象はこの4箇所のみで、`stage.ts`/`result-screen.ts` には触れない。`stage-select.ts` の再利用(タイトルへ戻る経路)を伴う場合は別途設計が要る | 目指す最終形(§1) |

Step 1〜8 は挙動を変えない(`dispose()` を足すだけで、これまで通り `Game` は一度作ったら
壊さない)。Step 9 で初めて `main.ts` 側の構造が変わる。Step 10 は本調査のスコープ外(§7-2 で
判断を仰ぐ)。

---

## 6. 採らない案

- **`InstancedPool`/`CelestialSurface` 等の共有リソースに参照カウントを持たせ、最後の1個が
  dispose されたときだけ実際に GPU リソースを解放する。**
  一見丁寧だが、「モジュールスコープの永続キャッシュは Game の生死と無関係に生き続ける」
  という現状の単純な規約(§4-1)を「何個の Game から参照されているか」という新しい状態に
  置き換えることになり、CLAUDE.md の「少ないステート設計」に反する。今のところ
  `Game` は高々1つしか同時に存在しない設計(タイトル画面には `Game` が無い)なので、
  参照カウントの出番は無い。
- **`Hud`/`Sfx`/`SettingsPanel` も含めて `Game` の子として作り直す(main.ts 側を薄くする)。**
  タイトル(ステージ選択)画面が `Game` 構築前に `Hud`/`Sfx` を要求する(`main.ts:196,200`)
  という既存の制約と正面から矛盾する。`Game` より前に存在すべきものを `Game` の子にはできない。
- **`PerfMeter`/`SaveBrowser` を `Game` 再生成のたびに作り直す。**
  `PerfMeter` は開閉状態・累計統計・`PropertyWindow` の画面位置を、`SaveBrowser` は
  「今どのスロットを見ているか」(`viewedSlotId`)をそれぞれ保持しており、これらは
  **`Game` の生死と無関係にプレイヤーが選んだ UI 状態**である。作り直すとこれらが毎回
  初期状態に戻ってしまい、UX が悪化する。§3-B の「`Game` フィールドを外して引数化する」方が、
  既存の UI 状態を保ったまま解決できる。
- **`Input` を `Game` の外(main.ts 所有)へ移し、`Hud`/`Sfx` と同格の「Game より長生きする
  もの」として扱う。**
  一見 listener リークを回避できそうだが、`Input` は `Game.update` の入力配分ロジック
  (`docking`/`settingsPanel`/`hud`/`simSpeedManager`/`viewManager`/`editor`の優先順位、
  `game.ts:334-348`)と密結合しており、`Game` の消費エッジ管理(`takeKey`/`takeKeys` の
  「先着順消費」契約、`DEVELOP/OWNERSHIP.md` §3 の該当行)は `Game` の生存期間そのものに
  紐づく設計である。決着後の `[R]`(再出撃)はこの優先順位の外にあり、`Game.update` の後で
  `Launcher.handleInput` が消費しなかった入力エッジだけを見て取る —— `Stage` 自身は
  `handleInput` を持たない。`Input` 自体を `Game` の外に出すより、
  `Input.dispose()` を用意して `Game.dispose()` から確実に呼ぶ方が、既存の設計方針を壊さない。

---

## 7. 判断を仰ぎたいこと

1. **§5 の段階分けの粒度と順序でよいか。** 特に Step 1(InstancedPool)と Step 3
   (EnvironmentScene)はそれぞれ独立に着手できるため、順序を入れ替えても良い
   (依存関係は無い)。
2. **§4-3 の未検証事項(`CelestialSurface` のテクスチャ連鎖 dispose、`InstancedMesh` の
   attribute バッファ解放)を、Stage 着手前に実機検証するか、実装しながら確認するか。**
   前者は本調査の延長として `/verify` や DevTools での計測が必要になる。
3. **Step 10(reload 呼び出し箇所の置き換え)まで見据えて計画するか、Step 9 で一旦止めて
   様子を見るか。** Step 10 は `stage-select.ts` の再利用(タイトル復帰時に選択画面を
   同一ページ内で出し直す必要がある)という、今回の調査で洗っていない追加の設計判断を伴う。
4. **Step 4(ContextMenu/ObjectPicker のリスナー整理)は Game のライフサイクルと独立した
   正しさの改善なので、本計画と切り離して先行して着手してよいか。**
5. **`InstancedPool.dispose()` を書く際、`instanceMatrix`/`instanceColor` バッファの扱いを
   どこまで踏み込むか(§4-3)。** 何もしなくても `scene.remove(mesh)` だけで実害が無いなら
   最小実装で済ませたいが、その判断には実機確認が要る。

---

## 8. 併せて直す文書

- `DEVELOP/OWNERSHIP.md` — 「破棄されないまま残る資源」という新しい軸は、現状の保持木
  (§1)には表現されていない(保持木は「誰が誰を new するか」であって「誰が誰を dispose するか」
  ではない)。`dispose()` の追加が一巡した段階(§5 Step 8 目安)で、各ノードに
  `dispose()` の有無・呼び出し方を注記するか、末尾に専用の節を設けるかを検討する。
- `CLAUDE.md` — `render/instanced-pool.ts`・`game/celestial/environment-scene.ts` の
  モジュール解説に `dispose()` の有無を追記する必要が生じる(§5 の各 Step で該当ファイルを
  変更するたびに、その変更セットで更新する)。
- `memos/hedalu244/refactor_dock.md` — §3-I(格納艦の生存期間)は本調査の Step 2 と同じ
  変更(`Base.dispose()` の拡張)を指しているため、どちらかの完了時にもう一方の記述を
  「完了済み」として消す(重複した TODO を残さない)。
