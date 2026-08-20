# 第10版_3_Operationsビュー組立UI実装計画

作成日 2026-08-19、追記 2026-08-20。対象は第10版第3巻の艦体組立UI。**現状の「3D作業台」タブ
(ドックビュー内)を廃止し、Operations ビュー(戦闘ビュー、`ViewId: 'combat'`)上で完結する組立UIへ
置き換える。併せて、全画面モーダルの `BaseView`(ドックビュー)自体を廃止し、基地を操作対象に選んだ
ときに開く、ドラッグ可能・クリップ可能なウィンドウとして基地操作を表現する。**
状態: 未着手(計画のみ)。

## 1. 目的

- 現在の3D作業台は、実体としては「画面全体を覆う半透明のDOM矩形に、裏側で動いているゲームカメラへの
  レイキャストを流し込んでいるだけ」であり、専用の3Dビューポート・ドラッグ中の連続したゴースト表示・
  自由な着地位置決定を持たない(`第10版_3_基地造船実装中の追加事項.md` が明記する既知の欠落)。
- この計画は、その場当たり実装を廃止し、**ウィンドウに並んだボタンを押すと部品/構造材の3Dモデルが
  実際にシーン上へ現れ、それを掴んでドラッグし、艦体へ近づけると接続候補が光り、離すと接合される**
  という、実際に3D空間で完結する操作へ作り直す。
- 併せて、これまで死蔵されていた `dock-workbench.ts`/`dock-workbench-controller.ts`
  (`DockWorkbenchSession`/`DockWorkbenchController` — Undo/Redo・ドラッグ状態を持つ純粋なエンジンだが、
  単体テストからしか呼ばれておらずランタイムに未接続)を実際に動かす。
- **さらに、基地を操作するために画面全体を覆う専用ビュー(`BaseView`/`ViewId:'dock'`)へ切り替える
  という現行の設計自体を廃止する。** 格納艦艇一覧・部品(倉庫/修理/燃料補給)・生産・組立は、
  マップ/プロパティウィンドウが既に持つ「ドラッグで動かせ、📌でクリップして常設できる」ウィンドウの
  語彙(`hud/property-window.ts` の `PropertyWindow`)へ統一し、基地は他の対象(艦・天体など)と
  同じ「クリックして操作対象に選び、ウィンドウで詳細を触る」という一貫した操作感の中に収める。
  全画面へ切り替える・切り戻すという文脈の断絶自体を無くすのが狙い。

## 2. スコープ

**廃止・置き換えの対象**:
- `hud/base-view.ts`(`BaseView` クラス)そのもの — `格納艦艇`/`部品`/`生産`/`3D作業台` の4タブを
  持つ全画面モーダルを丸ごと廃止する。これに伴い `ViewManager` の `ViewId:'dock'`(全画面へ切り替えて
  基地を操作する、という現行の入場・退出の仕組み — `Docking.enterDock`/`leaveDock`/`activate`/
  `canEnterDock` のうち「ビューを切り替える」役割の部分)も廃止する。
- `docking.ts` 側で3D作業台タブのDOMイベントに応じて動いていたグルーコード(`pickWorkbenchObject`
  によるレイキャスト選択、`selectedMounts` を経由した暗黙のマウント選択、HTML5 ネイティブ
  drag-and-drop によるインベントリ行 → ステージ矩形のやり取り)。

**置き換え後の姿**: 基地を操作対象に選ぶと、`格納艦艇`/`部品`/`生産`/`組立` の内容は、Operations
ビュー(またはマップビュー)の上に浮かぶ**ドラッグ可能・クリップ可能なウィンドウ**として現れる
(詳細は §5.9)。全画面表示への切り替えという操作は一切発生しない。

**維持する対象**: 一覧・修理・燃料補給・生産判定(`producibility`)などの**中身のロジック**は
今回のスコープ外 — `BaseView` が持っていた各タブのDOM構築・状態管理は新しいウィンドウ側へそのまま
移すが、判定・適用のロジック自体(`docking.ts` の該当メソッド群、`producibility.ts`)は書き直さない。

**維持し、そのまま呼び直す対象**(データ整合性の核。書き直さない):
`assembly-editor.ts` の編集コマンド群(`addNode`/`moveNode`/`removeNode`/`addEdge`/`reconnectEdge`/
`removeEdge`/`editSection`/`movePlacement`/`removePlacement`/`validateAssembly`/`occupiedPorts`/
`validateMount`)、`docking.ts` の適用経路(`applyTargetAssembly`/`commitBaseAssembly`/
`commitDockedAssembly`/`assemblyError`/`createDraft`/`buildDraft`/`transferWorkbenchPart` 相当の移送検証)。
これらは「3D空間でどう選ぶか」とは独立な、既に検証済みの資源側の実装であり、入口が変わるだけで内容は
変わらない。

## 3. 廃止理由(現状の問題点)

1. `.dock-workbench-stage` は破線枠のプレースホルダー `<div>` であり、専用の3D描画領域を持たない。
   クリック座標は `document.documentElement.clientWidth/clientHeight` で正規化され、**その時点で
   アクティブなゲームカメラへ直接投げられる** — ボックスの見た目とレイキャスト対象は無関係で、
   偶然そこに艦が描画されているから機能しているに過ぎない。
2. 部品の取り付け位置(`MountPoint`)は「先に3D上をクリックして選ぶ → 次にインベントリ行を
   ネイティブdrag-and-dropでステージへ落とす」という**2段階・非対称な操作**になっている
   (`moveWorkbenchPart` は `selectedMounts` が空だと「先に3D上の接続口または外表面を選択してください」
   と拒否する — 本セッションの発端になったエラー)。ドラッグ中に接続候補が見えず、結果は離すまで分からない。
3. 部品の性能パネルは `PropertyWindow` を使わず `showPartProperties` が `innerHTML` で独自に組み立てて
   おり、既存のウィジェット/オーバーレイ規約(`DEVELOP/DESIGN-RULES.md`)から外れている。
4. `docking.ts` はこのタブのためだけに `portKey`/`freePort`/`edgeMount`/`defaultDockPlacement` を
   ローカルに再実装しており、`tree.ts` の `portKey` や `assembly-editor.ts` の `occupiedPorts` と
   二重管理になっている。
5. `DockWorkbenchSession`/`DockWorkbenchController` という、ドラッグ・Undo/Redo・スナップ候補を扱う
   ための設計済みエンジンが存在するのに、ランタイムから一度も呼ばれていない。
6. 基地を操作するたびに全画面の `BaseView` へ切り替える現行設計は、他の対象(艦・天体・マーカー)を
   「クリックしてプロパティウィンドウを開く」という一貫した操作から基地だけを外れさせている。
   全画面へ出入りする分だけ文脈が切れ、複数の基地/艦を並べて見比べる(クリップして常設する)ことも
   できない。

## 4. 新設計の要旨

- 組立は Operations ビュー(`combat`)の**上に重ねるオーバーレイ**として行う。ドックビューへは切り替えない
  — 対象艦(基地本体・ドック中の艦・新規船下書き)はその場の3Dワールドに実際に描画されたまま、カメラが
  それへ寄る。
- 部品/構造材の一覧は**ウィンドウ上のボタン列**(`部品棚パネル`、`PropertyWindow`/`Button` と同じ
  ウィジェット語彙で組む)として常時表示され、ボタンを押すとその部品の実メッシュがカーソルに追従する
  「保持中」状態で出現する。
- 保持中のオブジェクトを艦体へ近づけると、`assembly-editor.ts` の検証を通る最も近い `MountPoint` が
  候補として光り(色は接続可否で切り替え)、離した瞬間にその候補へ接合される。候補が無い状態で離すと
  出現前の状態(在庫)へ戻る。
- 既に取り付け済みの部品も、3Dモデルを直接つかんで同じ操作で移動・取り外しできる — 「先にクリックで
  選択してから別操作でドラッグ」という2段階を廃し、掴む=選ぶ=動かす、を1つのジェスチャーに統合する。
- 外皮/トラス/分離機構も「部品」と同列の棚アイテムとして扱う。ノード位置を数値で直接動かす操作は
  廃止し、**ノードと辺は、部材(2端点を持つ部品)をドラッグして両端を空きポートへスナップさせた結果として
  生成される**(旧計画 `old/戦闘ビュー部品組み立てUI実装計画.md` §13.2 の設計をそのまま採用)。
- 状態機械は新規に書かず、`dock-workbench.ts`/`dock-workbench-controller.ts` を実際に接続して使う。

## 5. UI / インタラクション設計

### 5.1 入口

組立は「対象(基地本体・ドック中の艦・下書き)を選び、組立モードへ入る」という単一のアクションから
始まる。入口の候補は次の2つの右クリックメニュー項目に集約する(いずれも `Vessel` を対象に取る、
既存の `MapContextActions`/`Targeter` の項目追加パターンを踏襲):

- マップビュー上の基地・ドック中の艦・自艦のプロパティウィンドウに「組み立てる」項目を追加。
- Operations ビュー上での右クリック(コンバットビュー右クリックの `MapContextActions.handleCombatRightClick`
  経由)でも同じ項目を出す。
- 基地のプロパティウィンドウ自体にも「格納艦艇/部品/生産を見る」項目を置き、こちらは §5.9 の
  基地操作ウィンドウ(3D組立ではなく一覧・修理・生産)を開く、別の入口とする。

選択すると:

1. `ViewManager` が Operations(`combat`)ビューでなければ `setView('combat')` する(マップから
   呼んだ場合はここで切り替わる)。
2. `Game.pause()` 相当で物理・時間加速・武装発射を止める(`docking.ts` が現在ドック入場時に行っている
   一時停止と同じ扱いを、新しい `AssemblySession` の開始/終了に付け替える)。
3. カメラが対象へ寄る。既存の `ChaseCamera`/`CombatCameraSystem` に「対象を差し替えて注視する」ための
   軽量な上書きを足す(新しい `ViewId` は増やさない — Operations ビューのカメラの一時的な振る舞い変更
   として実装する。詳細は §9 未決定事項)。
4. 組立ウィンドウ(§5.2)が開く。

### 5.2 組立ウィンドウ(部品棚パネル)

`hud/assembly-panel.ts`(新設)が持つ、常設のHUDウィンドウ。既存の `PropertyWindow`/`Button` の
ウィジェット語彙で組み、`innerHTML` の丸ごと書き換えは行わない(差分更新 — `PropertyWindow` が
既に持つ `syncRows`/`syncItems` の仕組みに合わせる)。

構成:

- **対象切り替え**: 基地本体 / ドック中の艦 / 新規船下書き — 既存の `WorkbenchTargetView` の考え方を
  そのまま踏襲(名前は `AssemblyTarget` へ改名)。「新規船下書き」ボタンも維持。
- **部材棚**: 外皮エッジ / トラス / 分離機構。あらかじめ長さ・断面を数値入力で決めてから
  ボタンを押す(部材は2端点を持つため、生成後の形状は固定 — 旧計画 §13.2 と同じ)。
- **部品棚**: 在庫(`base.baseState.inventory`)を種別ごとにグルーピングし、1部品=1ボタン。
  検索欄(現行のフィルタ入力を踏襲)。
- **選択中パネル**: 3D上で今つかんでいる/選択している対象の性能・詳細(現行 `showPartProperties`
  相当だが `PropertyWindow` の行として表示)。
- **確定 / 取消 / Undo / Redo**: `DockWorkbenchController.undo()`/`redo()` をここで初めて実際に配線する。
- **下書きを建造して格納**: 現行のボタンを維持。

### 5.3 部品を出してつなぐ(新規ドラッグ)

1. 部品棚のボタンを押す → 新設の `AssemblyDragController`(§6.4)が
   `DockWorkbenchController.beginDrag(part, sourceTargetId, sourceInventory=true)` を呼び、部品の
   実メッシュ(`render/hull/part-meshes.ts` の `buildFitting`/`placePanel` 等、既存の外装部品ビルダーを
   そのまま使う)をシーンへ生成し、**カーソルに追従する状態**で表示する(押した瞬間から追従を開始し、
   別途「つかむ」操作を要求しない)。
2. 毎フレーム(`Game.update`→`sync` の該当フェーズ、§6.4)、カメラからカーソル方向へレイを飛ばし、
   艦体の当たり判定(`collision-shape.ts` の `HullCapsule` を broad-phase に使う)近くにあれば
   `vessel/mount-candidates.ts`(新設、§6.3)で最寄りの `MountPoint` を求め、
   `assembly-editor.ts` の `validateMount`/`occupiedPorts` で接続可否を判定する。
3. 保持中のオブジェクトは、候補が無ければレイと艦体近傍平面の交点に、候補があればその
   `MountFrame` に位置・姿勢を合わせて描画する。色は接続可能/不可/対象外で切り替える
   (`const.ts` の色管理節に `COLOR_ASSEMBLY_GHOST_VALID`/`_INVALID` を追加)。
4. 離す(pointerup)と `DockWorkbenchController.drop(targetId)` を呼ぶ。成功すれば
   `assembly-editor.ts` の対応する編集コマンド(部品なら `movePlacement` 相当、部材なら `addNode`+
   `addEdge`)を組み、`docking.ts` の `applyTargetAssembly` へそのまま渡す(§6.6、ここから先は
   現行コードを一切変えない)。失敗すれば保持中オブジェクトを破棄し在庫へ戻す。

### 5.4 既存部品を動かす・外す

3D上で既存の部品/部材メッシュを直接クリック&ドラッグすると、同じ `AssemblyDragController` が
`sourceInventory=false` で `beginDrag` する(選択とドラッグ開始が同じジェスチャーになり、現行の
「先にクリックで選ぶ」ステップが消える)。離した場所に有効な候補が無ければ、その部品/部材は在庫へ
戻る(=取り外し)。ダブルクリックでの即時取り外しは維持する。

### 5.5 構造材の追加・変更

§5.3 と同じドラッグ機構を使う。棚から外皮/トラス/分離機構を出すと、部材の一端が最寄りの空きポートへ
スナップした時点でその側のノード/エッジが確定し、もう一端をドラッグで動かして別の空きポートへ
スナップさせると `addEdge`(必要なら新規ノードを伴う `addNode`)が発行される。ノード位置を数値で
直接編集する操作(現行の X/Y/Z 入力欄)は廃止する。

### 5.6 断面・数値編集

外皮断面の半径など、ドラッグでは表現しづらい数値は、既存部材を選択した状態で組立ウィンドウの
「選択中パネル」に現れる数値欄から編集する(`editSection` をそのまま呼ぶ)。ここは現行の
`buildWorkbenchEditControls` の数値入力部分を `PropertyWindow` 形式へ移すだけで、ドラッグ化の
対象外。

### 5.7 一時停止・カメラ

組立中は物理・時間加速・発砲を止める(現行のドック入場時の一時停止をそのまま移設)。カメラは
自由に回転・ズームできる(現行のOperationsビューのカメラ操作を継続)。

### 5.8 タッチ対応

`DEVELOP/DESIGN-RULES.md` のタッチ規約に従う。長押しでドラッグ開始、二本指操作はカメラへ渡す、
という既存の使い分け(`input/touch.ts`)に合わせて、部材/部品ボタンのタップ→保持→ドラッグは
既存の `pointerdown`/`pointermove` 系イベントで統一し、`node-gizmo.ts` が既に採用している
「移動量が閾値を超えるまではクリック扱い」の判定パターンを流用する(3D空間の位置決定には使わないが、
ジェスチャー判定の考え方は再利用できる)。

### 5.9 基地操作ウィンドウ(格納艦艇・部品・生産)

`BaseView` が担っていた `格納艦艇`/`部品`/`生産` の3タブは、全画面モーダルではなく、**基地を
操作対象に選んだときに開く、ドラッグで動かせ📌でクリップできる1つのウィンドウ**として表現する。
組立ウィンドウ(§5.2)とは別の入口・別のウィンドウとする(組立は「3D空間を触る」操作、こちらは
「一覧を見て数値を確認・実行する」操作で性格が異なるため — ただし同じ基地を対象に同時に両方
開けてよい)。

- **開き方**: 基地のプロパティウィンドウの項目、またはマップ/Operations上での基地の左クリックから
  開く。既存の `canEnterDock()`(=利用可能な基地が1つ以上ある)のような「入場可否」の判定は不要になる
  — 他の対象のプロパティウィンドウと同じく、基地が存在すれば常に開ける。物理的な接岸
  (`Docking.checkProximity` が行う自艦のドッキング)は、格納艦艇一覧に「今ドッキング中の艦」を
  表示するための情報であり続けるが、ウィンドウを開くための前提条件ではなくなる。
- **中身**: `PropertyWindow` と同じ見た目の骨格(ヘッダー・ドラッグ・📌クリップ・✕閉じる)の中に、
  `TabBar` で `格納艦艇`/`部品`/`生産` を切り替える(現行 `BaseView` のタブ構成をそのまま踏襲)。
  各タブの中身(艦艇行・部品行・生産可否表示)は `PropertyWindow` の `rows`/`items` では表現しきれない
  複雑なDOMを持つため、`PropertyWindow` そのものではなく、同じ骨格を共有する新しいウィンドウ種別
  (§6.2 の `hud/base-operations-window.ts`)として実装する。
- **一時停止**: このウィンドウは一時停止を伴わない(一覧を見ている間もゲームは進行する) —
  一時停止が必要なのは組立ウィンドウ(§5.7、実際に艦の構成をその場で変えるため)だけであり、
  現行の「ドック入場で常に一時停止する」という一律の扱いをやめる。
- **他の対象との一貫性**: 基地はこれで、艦・天体・マーカーと同じ「クリック→プロパティウィンドウ→
  必要ならさらに詳細ウィンドウを開く」という経路の中に収まる。複数の基地/艦のウィンドウを並べて
  クリップしておける点も含め、他の対象への操作と地続きになる。

## 6. データ・技術設計

### 6.1 既存資産の再利用方針(`/add-feature` の事前調査)

| 目的 | 再利用する既存実装 |
|---|---|
| 編集コマンドの適用・検証 | `vessel/assembly-editor.ts` の全関数 |
| 占有ポート判定 | `assembly-editor.ts` の `occupiedPorts`(`docking.ts` ローカル版の `freePort` は削除) |
| 取り付け位置の物理フレーム | `vessel/tree.ts` の `mountFrame`/`portFrame`/`edgeFrame` |
| 艦体への適用・基地固有バリデーション | `docking.ts` の `applyTargetAssembly`/`commitBaseAssembly`/`commitDockedAssembly`/`assemblyError` |
| 下書き作成・建造 | `docking.ts` の `createDraft`/`buildDraft`(変更なし) |
| ドラッグ・Undo/Redo状態機械 | `dock-workbench.ts`/`dock-workbench-controller.ts`(`DockWorkbenchSession`/`DockWorkbenchController`) — 初めて実働化する |
| 部品の実メッシュ | `render/hull/part-meshes.ts`(`buildFitting` 等) |
| ウィンドウ・ボタン | `hud/property-window.ts`・`hud/widgets/*`(`Button` など) |
| ウィンドウの外枠(ドラッグ・📌クリップ・✕・`OverlayManager`登録・ビューポート再クランプ・compact時のボトムシート化) | `hud/property-window.ts` が既に持つ実装 — §6.2 で共通シェルとして切り出す |
| 一覧・修理・燃料補給・生産判定のDOM/ロジック | `hud/base-view.ts` の各タブの中身(判定ロジックは書き直さず、外枠だけ載せ替える) |
| 当たり判定の broad-phase | `vessel/collision-shape.ts`(`HullCapsule`/`deriveCapsules`) |
| ジェスチャー判定の考え方 | `plan/node-gizmo.ts` の pointer-capture・移動量閾値パターン(3D位置決定ではなく、クリックとドラッグの判別ロジックの参考) |

### 6.2 新設モジュール

- `src/game/vessel/mount-candidates.ts`(DOM/THREE非依存、`physics/`同様の純関数群)
  ```ts
  export interface MountCandidate {
    readonly mount: MountPoint;
    readonly frame: MountFrame;
    readonly distance: number; // localPoint からの距離 [m]
  }
  // tree のポート(node の空き軸方向)とエッジ表面(along/around の連続パラメータ)の両方を
  // localPoint から直接逆算し、閾値内で最も近い候補を返す。
  export function nearestMountCandidate(
    tree: VesselTree, localPoint: Vec3, maxDistance: number,
    filter?: (mount: MountPoint) => boolean,
  ): MountCandidate | null
  ```
  エッジ表面上の `along`/`around` は総当たりで探すのではなく、`edgeFrame(tree, edge).z` への射影で
  `along` を、その断面内でのなす角から `around` を直接解く(現行 `docking.ts` の `freePort`/
  `edgeMount` が担っていた「離散的な候補列挙」を、連続空間での最近傍探索に置き換える)。

- `src/game/vessel/assembly-drag-controller.ts`(`game/` 側、THREE可)
  `DockWorkbenchController` をラップし、①棚ボタン押下/③D部品つかみ → `beginDrag` 呼び出しと
  メッシュ生成、②毎フレームのレイキャスト→`nearestMountCandidate`→`updateCandidate`→
  ゴーストメッシュの位置・色更新、③離す→`drop`→`applyTargetAssembly` 呼び出しとメッシュの
  後始末、を担う。`update`/`sync` の分離を守る(§6.4)。

- `src/game/hud/assembly-panel.ts`(HUD、DOM)
  §5.2 のウィンドウ本体。`PropertyWindow`/`Button`/`ValueInput` を用いて構築し、`innerHTML` の
  丸ごと再構築はしない。

- `src/game/hud/draggable-window.ts`(HUD、DOM、`property-window.ts` からの抽出)
  `PropertyWindow` が現在 rows/items 専用の実装として内包している「ドラッグ移動・📌クリップ・✕閉じる・
  `OverlayManager` への登録・ビューポート再クランプ・compact時のボトムシート化」という**外枠だけ**を
  切り出した共通基盤。`PropertyWindow` はこれを土台にした「rows/items 表示専用」の特化版になり、
  §5.9 の基地操作ウィンドウと §6.2 の `base-operations-window.ts` はこれを土台にした「自由なDOM内容」
  の特化版になる — 外枠のロジックが2箇所に分岐しないようにするための抽出(`/add-feature` の
  「再利用可能な形へ切り出してから両方を置き換える」規則に従う)。

- `src/game/hud/base-operations-window.ts`(HUD、DOM)
  §5.9 の基地操作ウィンドウ本体。`draggable-window.ts` を土台に、`TabBar` で
  `格納艦艇`/`部品`/`生産` を切り替える。各タブの中身は現行 `hud/base-view.ts` の該当タブの
  DOM構築をほぼそのまま移し替える(判定・適用ロジックは変更しない)。

### 6.3 update/sync の分離(CLAUDE.md の固定規約)

- `update` フェーズ: カーソル方向のレイと艦体近傍の交差判定、`nearestMountCandidate` の呼び出し、
  `DockWorkbenchController.updateCandidate` の呼び出し。THREE オブジェクトには触れない。
- `sync` フェーズ: 保持中メッシュの位置・姿勢・色を、`update` が求めた候補へ合わせて書き込むだけ。
- `Game.update`/`Game.sync` への差し込み位置(呼び出し順)は実装フェーズで `DEVELOP/CALLSTACK.md` を
  更新しながら確定する。

### 6.4 保持中メッシュの破棄規則

`hull-mesh.ts` の規約により、艦体本体の外皮メッシュは形状が変わるたびに丸ごと作り直す(WebGPUでは
既存メッシュのジオメトリ差し替えができない)。したがって:

- ドラッグ中の保持メッシュは艦体本体のメッシュとは**別オブジェクト**として持ち、`drop` が成功したら
  破棄し、`applyTargetAssembly` の結果として艦体側が丸ごと再構築(`buildHullMesh` の再呼び出し)される
  のに委ねる。
- `drop` が失敗(候補なしで離す)した場合も保持メッシュは破棄するだけで、艦体側の再構築は発生しない。

### 6.5 適用経路は変更しない

`AssemblyDragController` が組む「編集コマンド」(`addNode`/`addEdge`/`movePlacement` など)は
`assembly-editor.ts` の既存関数をそのまま呼び、その結果の `VesselAssembly` を
`docking.ts` の `applyTargetAssembly(base, targetId, assembly)` へ渡す。この関数以降
(`assemblyError` によるゲート、`commitBaseAssembly`/`commitDockedAssembly`/下書きの再構築、
`workbenchDirty` 相当のダーティフラグ)は現行のまま動かす。

## 7. 廃止するコード

- **`hud/base-view.ts` ファイル自体**(`BaseView` クラス)。4タブすべて(`buildWorkbenchTab`/
  `buildWorkbenchSelection`/`buildWorkbenchEditControls`/`buildWorkbenchPartRow`/
  `buildTransferControl`/`showPartProperties`、`WorkbenchSelectionInfo` 型、`onWorkbench*` 系
  コールバック全て、および格納艦艇/部品/生産タブのDOM構築)を、3D作業台タブは §5.2/§6 の
  組立ウィンドウへ、残る3タブは §5.9/§6.2 の基地操作ウィンドウへ、それぞれ移し替えたうえでファイルを
  削除する。
- `docking.ts`: `workbenchRaycaster`/`selectedMounts`/`pickWorkbenchObject`/`startWorkbench`/
  `openWorkbenchView`/`syncDraftRenders`(呼び出し元がDOMタブに紐づく部分)、ローカルの
  `portKey`/`freePort`/`edgeMount`/`defaultDockPlacement`/`sameDockPort`(`mount-candidates.ts`/
  `assembly-editor.ts` へ吸収)。`installWorkbenchPart`/`moveWorkbenchPart`/`removeWorkbenchPart`/
  `transferWorkbenchPart` はロジックを `assembly-drag-controller.ts` 側の呼び出しに置き換えるが、
  検証・適用の中身自体は再利用する。`enterDock`/`leaveDock`/`activate`/`canEnterDock` のうち
  「`ViewManager` を `'dock'` へ切り替える」役割は削除し、`selectBase`(操作対象として選ぶだけの
  部分)は基地操作ウィンドウ・組立ウィンドウ双方の開始点として存続させる。
- `application/x-tepui-part` を使ったネイティブ `dragstart`/`dragover`/`drop`(base-view.ts の
  現行実装のみが使っている、他に流用先が無いことを確認済み)。
- `view-manager.ts` の `ViewId` から `'dock'` を削除(または保存互換のためだけの未到達値として残す
  — §9 未決定事項)。`hud/view-badge.ts` の `'Base Dock'` ラベル、`hud/overlay-layer.ts` の
  `view` レイヤーの説明コメント(「`BaseView` より下に置く」という現行のコメントは前提が崩れるため
  書き直す — レイヤー自体を削除するかは §9)。

## 8. 影響ファイル一覧

| 種別 | ファイル |
|---|---|
| 新規 | `src/game/vessel/mount-candidates.ts` |
| 新規 | `src/game/vessel/assembly-drag-controller.ts` |
| 新規 | `src/game/hud/assembly-panel.ts` |
| 新規 | `src/game/hud/draggable-window.ts`(`property-window.ts` からの外枠抽出) |
| 新規 | `src/game/hud/base-operations-window.ts` |
| 削除 | `src/game/hud/base-view.ts`(全タブを新しいウィンドウ群へ移し替えた後にファイルごと削除) |
| 大幅変更 | `src/game/hud/property-window.ts`(`draggable-window.ts` を土台にした特化版へ縮小) |
| 大幅変更 | `src/game/docking.ts`(組立系メソッドの入れ替え、`'dock'` ビュー切り替えの廃止、入口の追加) |
| 変更 | `src/game/view-manager.ts`(`ViewId` から `'dock'` を削除、または保存互換のみの未到達値化) |
| 変更 | `src/game/hud/view-badge.ts`(`'Base Dock'` ラベルの扱い) |
| 変更 | `src/game/hud/overlay-layer.ts`(`view` レイヤーの説明・要否の見直し) |
| 変更 | `src/game/save-data.ts`/`src/game/save/`(`camera.view` に保存された旧 `'dock'` 値の移行方針、§9) |
| 変更 | `src/game/vessel/dock-workbench.ts`/`dock-workbench-controller.ts`(ランタイムからの実接続) |
| 変更 | `src/game/map-context-actions.ts`(「組み立てる」「格納艦艇/部品/生産を見る」項目の追加) |
| 変更 | `src/game/const.ts`(`COLOR_ASSEMBLY_GHOST_*` の追加) |
| 変更 | `src/game/camera/`(組立対象への一時的な注視、詳細は §9) |
| 文書 | `CLAUDE.md`(BaseView/Docking の説明更新 — `BaseView` の項自体を新ウィンドウ群の説明へ差し替える。ついでに現存する記述の食い違い — `Docking.produceVessel` という既に存在しないメソッド名の記述 — も同じ変更セットで正す) |
| 文書 | `DEVELOP/CALLSTACK.md`(組立ドラッグの毎フレーム呼び出し追加) |
| 文書 | `DEVELOP/OWNERSHIP.md`(`AssemblyDragController`/`DockWorkbenchSession` の所有者確定) |
| 文書 | `DEVELOP/SPEC.md`(操作方法の変更) |
| 文書整理 | `memos/mikanixonable/宇宙船設計計画/第10版_3_基地本体カスタム形状作業台実装計画.md` および両「追加事項」メモを、本計画の実装完了後に `old/` へ移す |

## 9. 未決定事項

1. **カメラの実装方法**: 新しい `ViewId` を増やさずに Operations ビューのカメラへ「一時的な注視対象の
   上書き」を足すか、`ChaseCamera` に組立専用のパラメータ(距離・画角)を持たせるか。既存の
   `ChaseCamera.update(..., target)` が対象を引数で受け取る形に既になっているため、対象の差し替え
   自体は難しくないが、艦全体が収まる距離をどう決めるか(艦体の外接半径から逆算する、など)は要検討。
2. **保持中オブジェクトの出現位置**: ボタンを押した瞬間にカーソル位置(画面奥の一定距離)へ出すか、
   艦の近くの決まった置き場(現行ドラフトの浮遊位置に近い場所)へ出してから掴み直させるか。
   本計画は前者(即座にカーソル追従)を既定案として書いたが、操作感を確認して決める。
3. **新規船下書きの表示**: 下書きは現行どおりセッション限定(確定/建造するまで保存されない)のまま
   とするか、Operationsビュー上に常時見える実体として扱うか。
4. **`DockWorkbenchSession` の履歴粒度**: Undo/Redo の1単位を「1回のドロップ」とするか、断面編集などの
   数値変更も含めるか。
5. **入口の到達経路**: マップビューのプロパティウィンドウ・Operationsビューの右クリックの両方に
   「組み立てる」項目を出す設計としたが、基地操作ウィンドウ(§5.9)を開く項目とどう並べるか
   (同じメニュー内の別項目とする案で書いたが、統合するかは要検討)。
6. **`ViewId:'dock'` の扱い**: 完全に削除するか、`ViewId:'combat'` が保存互換のために内部idとして
   残されている前例(`view-manager.ts`)に倣い、`'dock'` も保存互換のためだけの値として型に残し、
   ロード時に `'combat'` へ読み替えるか。後者であれば `save-data.ts`/`launcher.ts` 側の移行コードが
   別途要る。
7. **基地操作ウィンドウを開く前提条件**: 接岸(物理的なドッキング)を要求せず、他の対象と同様に
   常に開けることを既定案としたが、格納艦艇一覧からの部品移送など「ドッキング中の艦がある前提」の
   操作をどう扱うか(ウィンドウ自体は常に開けるが、該当欄が空/操作不可として表示される、という
   現状追従の方針でよいか)。
8. **基地操作ウィンドウの複数共存**: 複数の基地/艦を同時にクリップして並べられるようにするか、
   `PropertyWindow` の一時ウィンドウ排他グループ(`tempWindowGroup`)と同様、未クリップ時は1つだけに
   絞るか。
9. **格納艦艇/部品/生産/組立を1つの窓にまとめるか**: 本計画は「一覧・修理・生産」(§5.9)と
   「3D組立」(§5.2)を別ウィンドウとする案で書いたが、1つのウィンドウの中でタブ切り替えにまとめる
   案も比較検討する。

## 10. 完了条件

1. `src/game/hud/base-view.ts` が存在しない(ファイル自体が削除されている)。
2. `docking.ts` に `pickWorkbenchObject`/`selectedMounts`/`workbenchRaycaster` が存在しない。
3. Operations ビュー上で、部品棚のボタンを押すと3Dモデルが出現し、ドラッグして艦体へ近づけると
   接続候補が色で示され、離すと接合される(部品・外皮・トラス・分離機構のいずれでも)。
4. 既存の取り付け済み部品を3D上で直接ドラッグして移動・取り外しできる。
5. Undo/Redo が実際に効く。
6. 基地を操作対象に選ぶと、格納艦艇/部品/生産の内容がドラッグ可能・📌クリップ可能なウィンドウとして
   表示され、全画面表示への切り替えが一切発生しない。
7. `hud/property-window.ts` と新設の基地操作ウィンドウが、ドラッグ・クリップ・閉じる・
   `OverlayManager` 登録の実装を共有している(同じロジックが2箇所に分岐していない)。
8. `npm run typecheck` が通る。HUD/DOM/CSSを触るため実装フェーズの着手前に `/ui-design` を通し、
   `DEVELOP/DESIGN-RULES.md` のウィジェット・置き場規約に従っていることを確認する。
9. `CLAUDE.md`/`DEVELOP/CALLSTACK.md`/`DEVELOP/OWNERSHIP.md`/`DEVELOP/SPEC.md` が同じ変更セットで
   更新されている。
10. 廃止対象の実装済み計画書2件(§8「文書整理」)が `old/` へ移されている。
