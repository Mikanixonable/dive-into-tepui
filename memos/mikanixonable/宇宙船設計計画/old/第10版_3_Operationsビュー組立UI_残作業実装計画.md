# 第10版_3_Operationsビュー組立UI 残作業実装計画

作成日 2026-08-20。`第10版_3_Operationsビュー組立UI実装計画.md` とその
`実装中の決定事項.md` で**フェーズEとして後回しにした項目**、および統合フェーズ完了時点で
未到達のまま残った項目を、すべて実装しきるための計画。状態: 未着手(計画のみ)。

前提: 部品(搭載要素)のドラッグ取り付け・移動・取り外しと、基地操作ウィンドウは実装済みで
`workspace2` にマージ済み。この計画が扱うのは**その上に残っている5項目**である。

## 1. 残っている未実装項目

| # | 項目 | 現状 | 元の記載 |
|---|---|---|---|
| 1 | 装着済み部品を3D上で直接掴む | 掴めるのは部品棚のボタンからだけ | 計画 §5.4、完了条件 #4 |
| 2 | 構造材(外皮エッジ/トラス/分離機構)のドラッグ生成 | 経路が一切ない | 計画 §5.5、完了条件 #3 |
| 3 | 断面の数値編集 | `editSection` はあるが UI が無い | 計画 §5.6 |
| 4 | `createDraft`/`buildDraft` の入口 | 両方 public で動くが呼ぶ側が無い | 統合フェーズの積み残し |
| 5 | 組立対象へのカメラ寄せ | 未実装 | 決定事項 §9-1 |

**項目6として挙がっていた「格納艦どうしの部品移送」は、独立した作業ではない** —
`DockWorkbenchController.beginDrag(part, sourceTargetId, …)` と `drop(targetId)` は既に
移送元と移送先を別々に取る形になっており、`Docking.dragTarget` は現在選択中のタブの対象を返す。
つまり**項目1(3Dから掴む)が入った時点で、「艦Aで掴む → タブで艦Bへ切り替える → 離す」で
`session.movePlacement(A, B, …)` が走る**。項目1の副産物として自動的に満たされるので、
独立した UI を足さない。

## 2. 実装前に押さえておく技術的制約

計画を書くにあたって調べた結果、素直に見えて実際には成り立たない前提が複数ある。設計判断(§3)は
これらから導いている。

### 2-1. 辺の長さは保存値ではなく導出値で、0.5m の倍数でなければ弾かれる

`assembly-editor.ts` の `addNode`/`addEdge` は、呼び出し側が `EdgeDraft.length` に何を入れても
**無視して `recomputeEdgeLengths` で両端の `portFrame` の距離から引き直す**。そのうえで
`validateTree` が「`MIN_EDGE_LENGTH`(0.5m)以上」「`DIMENSION_UNIT`(0.5m)の倍数」を要求し、
外れれば `validation-failed` で拒否する。`validateBlueprint: false` を渡しても `validateTree` は
必ず走るので回避できない。

→ **ノードをカーソルの指す任意の位置に置く操作は、ほぼ必ず検証で弾かれる。**
構造材のドラッグは「長さを先に決めた部材を、空きポートへ吸わせる」形にしなければ成立しない。

### 2-2. `mateVerdict` の5項目のうち3つは、計算する実装がどこにも無い

`assembly-mode.ts` の `mateVerdict({occupied, widthFits, phaseFits, lengthFits, withinWorkArea})` は
**真偽値をラベルへ写すだけの純関数**で、自分では何も判定しない。5項目のうち:

- `occupied` — `assembly-editor.ts` の `occupiedPorts` が実質同じ判定を持っている(重複)。
- `lengthFits` — `validateTree` の量子化・最小長の検査が実質同じ判定を持っている(重複)。
- `widthFits` / `phaseFits` / `withinWorkArea` — **実装がどこにも無い。**
  特に `withinWorkArea` が指す「作業範囲」という概念は、コードベースのどこにも表現が存在しない。

さらに、現に動いている `assembly-drag-controller.ts` は `mateVerdict` を呼ばず、
`assembly-editor.ts` のエラーコードから `MateVerdict` を**手で組んで**いる。
`assembly-mode.ts` は `MateFailure` 型を除いて `src/` から一切呼ばれていない死んだモジュールである。

→ §3-2 で扱う。

### 2-3. `nearestMountCandidate` は lateral ポートを列挙しない

現状の候補は「ノードの空き**軸**ポート(`axial ±1`)」と「hull/truss エッジの**外表面**」の2種だけ。
`PortRef` のもう一方の形である `lateral`(`{primitiveId, faceIndex}` — 断面を構成する原始図形の
特定の面)は候補に上がらない。部品は外表面に付くので今まで問題にならなかったが、
**構造材は必ずポートに接続する**ので、lateral ポートの列挙が要る。

### 2-4. ドラッグ状態機械と `SnapCandidate` は「部品」に型付けされている

`DragState.part: AnyPart`、`SnapCandidate.placement: PartPlacement`、
`DockWorkbenchController.drop` は `installPlacement`/`movePlacement` を呼ぶ。
構造材は `PartPlacement` ではなく `TreeEdge`(+ 必要なら `TreeNode`)なので、
**この経路には乗らない。**

ただし逃げ道は既にある: `DockWorkbenchSession.applyAssemblyEdit(targetId, result, label)` は
**任意の `AssemblyEditResult` を1つの取り消し可能なコマンドとして適用する**汎用の口で、
`DockWorkbenchController` にも同名で生えている。呼び出し側が `src/` に一つも無いだけである。
構造材の確定はここを通せばよい。

### 2-5. 3D側の選択用メタデータは残っているが、読む側がいない

`hull-mesh.ts` は今も各部品メッシュへ `userData['partVisualRef']` を、
`render/vessel-wireframe.ts` は各ノード/エッジへ `userData['assemblyNodeId']`/`['assemblyEdgeId']` を
書いている。しかしこれらを読んでいたレイキャスト(`Docking.pickWorkbenchObject`)は統合フェーズで
削除されたので、**現在どこからも読まれていない**。項目1・3の3D選択は、この既存の目印を読む
新しいレイキャストを1つ書けば足りる(目印を付け直す作業は不要)。

### 2-6. 現在の操作は「押しながらドラッグ」ではなく「クリック→追従→クリック」

`Button` は `click` イベント(= `pointerup` の後)で `onClick` を発火する。
`AssemblyDragController.beginDrag` が `document` の `pointerup` を購読するのはその後なので、
**棚ボタンを押し終えた離しはもう過ぎており、実際に落ちるのは次の離し**である。
つまり現行の操作は「棚のボタンをクリック → 部品がカーソルに追従 → どこかでクリックして置く」。

これは `DEVELOP/DESIGN-RULES.md` §7 が禁じている「`window`/`document` への `pointerdown`/`keydown`
直付け」に、`pointerup` という形で片足を踏み入れている状態でもある(「離すまで続く操作には毎フレームの
入力キューに現れる縁が無い」という理由で入れたが、実態が click-move-click ならその理由は成り立たない)。

### 2-7. `ChaseCamera` が対象から読んでいるのは2つのフィールドだけ

`ChaseCamera.update(…, target: GameEntity | null)` が `target` から読むのは
`target.state.r`(注視点)と `target.att.q`(`camFollowAttitude` の基準)のみ。
一方で組立対象は3種あり、**そのうち下書きは `GameEntity` ではない**(`DraftEntry` +
`AssemblyRenderObject`)し、格納艦は `entities` から外れているので `state` が更新されない。
`Docking.targetPose` は既に3種すべてについて `{position, attitude}` を計算しているので、
カメラ側がその2つだけを受け取る形になれば3種とも扱える。

## 3. 設計判断

### 3-1. ドラッグは「クリック→追従→クリック」に統一し、`document` 直付けを解消する

§2-6 の実態に実装を合わせる。`AssemblyDragController` の `document` `pointerup` 購読を**やめ**、
掴み・置き・3Dからの掴み上げのすべてを `Docking.updateAssembly(input)` 内の
`input.takeClicks(...)` 1箇所へ集約する。

- 掴んでいる → そのクリックで置く。
- 掴んでいない → そのクリックの位置でレイキャストし、装着済み部品に当たれば掴み上げる。

**同じキューを1箇所で消費するので、「離した瞬間に置いて、その同じ離しで拾い直す」という取り違えが
構造的に起きない。**(現行の `document` 購読のままこれを足すと、`pointerup` листener が
フレームより先に走って置いた直後に、同じ操作由来の click で拾い直してしまう。)
DESIGN-RULES §7 の違反も1つ消える。

棚のボタンは HUD 側にあり `Input` のリスナーは canvas に張られているので、
棚のクリックが `Input` のクリックキューへ混ざる心配はない。

**要調整**: `Game.update` では `handlePointerInput()`(マップ/戦闘の選択)が
`docking.updateAssembly` より先に走り、クリックを先に消費しうる。組立セッション中は
`handlePointerInput` を通さないか、`updateAssembly` を先に置くかを決める必要がある(§7-1)。

### 3-2. `assembly-mode.ts` の重複した判定語彙は使わず、廃止する

§2-2 のとおり `mateVerdict` は、実装のある2項目が `assembly-editor.ts` と重複し、
残り3項目には実装が無く、うち1つは概念自体が存在しない。このプロジェクトの規則は
「1つの判定に実装は1つ」なので、**新しく `widthFits`/`phaseFits`/`withinWorkArea` を作らない**。

接続の可否は `assembly-editor.ts`(`addEdge`/`addNode`/`addPlacement`/`movePlacement` が返す
`AssemblyEditResult.errors` と、その内側の `validateTree`/`validateAssembly`)を唯一の正本とする。
これは既に動いている部品ドラッグがしていることでもあり、構造材も同じ扱いに揃う。

したがってこの計画は `assembly-mode.ts` から、`src/` の誰も使っていない部分
(`mateVerdict`/`MateVerdict`/`MateFailure`/`PartOrder`/`PartStock`/`AssemblyDraft`/
`partOrder`/`partOrderProducibility`/`addToPartStock`/`removeFromPartStock`/`rebuildPlan`/
`treeFromDraft`/`mountPart`/`blueprintFromDraft`/`assemblyFromDraft`)を**削除する**。
`SnapCandidate.verdict` は `MateVerdict` をやめ、`AssemblyEditResult` から直に持つ形へ変える
(表示に要るのは「通ったか」と「通らない理由の文言」だけで、後者は `AssemblyEditError.message` が
既に日本語で持っている)。`DockWorkbenchController.failureText` も不要になる。

**この判断は既存テストに及ぶ** — `tests/unit/assembly-mode.test.ts` と
`tests/unit/dock-workbench.test.ts` が `mateVerdict` を呼んでいるので、同じ変更セットで直す。

### 3-3. 構造材は「長さと断面を先に決めた部材」であり、ノードはその結果として立つ

§2-1 の量子化制約への答え。旧計画 `old/戦闘ビュー部品組み立てUI実装計画.md` §13.2 の
「ノードを自由移動させる操作は提供しない。ノードは接続の結果として立つ」をそのまま採る。

- 棚には**部材**が並ぶ。部材は種別(外皮/トラス/分離機構)・**長さ**・断面を持つ。
  長さは 0.5m 刻みの選択なので、**量子化は構成上つねに満たされる**(検証で弾かれる経路が消える)。
- 部材をドラッグして**空きポート**へ吸わせて離すと、その反対側の端に新しいノードが
  `portFrame.origin + portFrame.z × 長さ` の位置・`portFrame.z` の軸で生成され、
  部材自身が辺になる(`addNode` に `{node, edge}` を両方渡す1回の呼び出しで済む)。
- ノードの断面は部材が持っている断面をそのまま使う。異なる断面のノード間の外皮は
  ロフトが截頭錐として扱えるので、断面の一致を求める必要はない(= §3-2 の `widthFits` を
  作らない判断とも整合する)。

**両端とも既存のポートへ繋ぐ(閉じた構造を作る)場合は、部材の長さと2つのポート間の距離が
一致していなければならない。**これは実装難度が段違いに高いので段階を分ける(§4 の F5b)。

### 3-4. カメラは対象の実体ではなく「姿勢」を受け取る形へ広げる

§2-7 の答え。`ChaseCamera.update` の `target: GameEntity | null` を、
`{ position: Vec3; attitude: Quat } | null` という**狭い構造的インターフェース**へ変える
(`PlanExecutorShip`/`DisplayDurationSource`/`CapabilityVessel` と同じ流儀)。
`GameEntity` はこの形を構造的に満たさない(`state.r`/`att.q` という入れ子なので)ため、
実体から姿勢を取り出すのは呼び出し側(`CameraSystem`/`CombatCameraSystem`)の1行になる。

これで下書き(実体が無い)・格納艦(`state` が止まっている)・基地の3種すべてを、
`Docking.targetPose` が既に返している値のまま渡せる。

距離は `deriveCapsules` と `tree.nodes` の `circumradius` から対象の外接半径を求め、
新設の `ASSEMBLY_CAMERA_DISTANCE_MARGIN` を掛けて決める。**`deriveCapsules` は分離機構の辺を
飛ばす**ので、カプセルだけを見ると分離機構の先にある部分を取りこぼす。ノード位置も併せて見る。

### 3-5. 断面編集はドラッグ化せず、選択中ノードの数値フォームで行う

計画 §5.6 のとおり。`SectionPrimitive` は `shape`(4種の判別共用体、`sides` や `branchCount` が
リテラル型の列挙)・`phaseAngle`・`attachment` からなり、いずれもドラッグでは表しにくい。
列挙は `SegmentedControl`、半径・位相は `ValueInput` で組む(DESIGN-RULES §3 の語彙)。

## 4. フェーズ分割

依存の向きだけを固定し、並行できるものは並行させる。

### F1. 3D選択とクリック操作の統一 — 他の前提

- `AssemblyDragController` の `document` `pointerup`/`pointercancel` 購読を削除。
- `AssemblyDragController` に `pickAt(camera, cameraPos, pointerScreen, viewport, target)` を追加:
  対象の `renderObject`(または下書きの `AssemblyRenderObject.object`)へレイキャストし、
  親を辿って `userData['partVisualRef']`/`['assemblyNodeId']`/`['assemblyEdgeId']` を読む
  (§2-5、目印は既に付いている)。返すのは判別共用体
  `{kind:'part', partId} | {kind:'node', nodeId} | {kind:'edge', edgeId} | null`。
- `Docking.updateAssembly` を `input.takeClicks(...)` の消費者にする。掴んでいれば置き、
  いなければ `pickAt` して、部品なら `beginDrag(..., sourceInventory: false)`、
  ノード/エッジなら選択状態(F3/F4 が読む)に入れる。
- `AssemblyPanel` に選択中のノード/エッジの表示行を足す(内容は F4 で埋まる)。
- `Game.update` の呼び出し順、または組立中の `handlePointerInput` の扱いを決着させる(§7-1)。

**これで項目1が満たされ、項目6(格納艦どうしの部品移送)も副産物として満たされる。**

### F2. カメラ寄せ — F1 と独立

- `ChaseCamera.update` の対象引数を姿勢インターフェースへ広げ、`CombatCameraSystem`/
  `CameraSystem` の呼び出し側で実体から姿勢を取り出す(§3-4)。
- `const.ts` に `ASSEMBLY_CAMERA_DISTANCE_MARGIN` を追加。
- `Docking.startAssembly` が対象の外接半径から距離を決め、セッション中は
  `targetPose(base, view)` の姿勢をカメラへ渡す。対象タブを切り替えたら追従する。
- セッション終了で元の対象・距離へ戻す。

### F3. 新規船下書きの入口 — F1 と独立(小)

- `AssemblyPanel` に「新規船下書き」ボタン(`onCreateDraft`)と、
  対象が下書きのときだけ出る「建造して格納」ボタン(`onBuildDraft`)を足す。
- `Docking` 側で `createDraft`/`buildDraft` へ配線する(両メソッドは既に public で動く)。
- 建造は資源を引くので、`producibility` の不足内容をボタンの但し書きに出す
  (`base-operations-window.ts` の生産タブが既にやっている形をそのまま使う)。

### F4. 断面の数値編集 — F1 に依存

- `AssemblyPanel` に、選択中ノードの断面を編集する面を足す:
  原始図形の一覧、選択した原始図形の `shape`(種別・`sides`/`branchCount`・半径)と
  `phaseAngle` の編集、追加・削除。
- 確定は `editSection(assembly, edit)` → `workbench.applyAssemblyEdit(targetId, result, ラベル)`。
  決定事項 §9-4 のとおり**「更新」1回で1履歴**。
- ノード/エッジの削除(`removeNode`/`removeEdge`)も同じ面から同じ経路で出す
  (現在まったく到達できない操作なので、ここで一緒に入れる)。

### F5. 構造材のドラッグ生成 — F1 に依存。この計画の本体

**F5a: 片端が自由な部材(基本形)**

1. `mount-candidates.ts` を拡張し、lateral ポートを候補に加える(§2-3)。
   `placeSectionPrimitives(node.section)` で原始図形を並べ、面ごとに `portFrame` を求めて
   `occupiedPorts` で空きを判定する。**部品用の既存の呼び出しの答えを変えてはいけない**ので、
   ポート種別で絞れる形(`filter` 引数か、ポート専用の別関数)にする。
2. 棚に並ぶ部材を表す型を新設(種別・長さ・断面)。`AssemblyPanel` に部材の面を足す
   (種別の `SegmentedControl`、長さの選択、断面の選択)。
3. `AssemblyDragController` を、掴んでいるものが「部品」か「部材」かで分岐できる形へ広げる
   (§2-4 — `part: AnyPart | null` を判別共用体へ)。ゴーストは部材の長さ・断面から作る。
4. 吸着先は**空きポートのみ**。離したら `addNode({node: 反対端のノード, edge: 部材の辺})` を
   組んで `workbench.applyAssemblyEdit(...)` へ渡す(§2-4 の汎用の口)。
5. 3D上の既存の辺を掴んで外す(`removeEdge` — 端のノードが孤立するなら `removeNode` も)。

**F5b: 両端を既存のポートへ繋ぐ(閉じた構造)**

- 部材の長さと2ポート間の距離が一致するときだけ吸着を許す(許容差は `validateTree` の
  `LENGTH_TOLERANCE_RATIO` に合わせる)。`addEdge` を使う(新しいノードは生えない)。
- 一致する組み合わせを見つけにくいので、**先に一方の端を吸わせた時点で、
  長さの合う空きポートを候補として光らせる**必要がある。F5a が動いてから着手する。

### F6. 仕上げ

- `assembly-mode.ts` の死んだ部分を削除(§3-2)、`SnapCandidate.verdict` の作り直し、
  `failureText` の削除、影響するテスト2件の修正。
- `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` の更新。
- `npm run typecheck` と `npm run test:unit` の両方(決定事項に記録したとおり、
  `typecheck` は `tests/` を見ないので単体テストを別に走らせる)。

## 5. 影響ファイル

| 種別 | ファイル | フェーズ |
|---|---|---|
| 変更(大) | `src/game/vessel/assembly-drag-controller.ts` | F1・F5 |
| 変更(大) | `src/game/hud/assembly-panel.ts` | F1・F3・F4・F5 |
| 変更(大) | `src/game/docking.ts` | F1・F2・F3・F5 |
| 変更 | `src/game/vessel/mount-candidates.ts`(lateral ポート列挙) | F5a |
| 変更 | `src/game/camera/chase-camera.ts`・`combat-camera-system.ts`・`camera-system.ts` | F2 |
| 変更 | `src/game/game.ts`(ポインタ入力の順序、カメラ対象) | F1・F2 |
| 変更 | `src/game/const.ts`(`ASSEMBLY_CAMERA_DISTANCE_MARGIN`、部材の寸法) | F2・F5 |
| 変更(削減) | `src/game/vessel/assembly-mode.ts` | F6 |
| 変更 | `src/game/vessel/dock-workbench-controller.ts`(`SnapCandidate`/`failureText`) | F6 |
| 新規の可能性 | 部材の型と既定値(`src/game/vessel/` 配下) | F5a |
| テスト | `tests/unit/assembly-mode.test.ts`・`dock-workbench.test.ts` | F6 |
| テスト(追加) | lateral ポート列挙、部材からのノード生成 | F5a |
| 文書 | `CLAUDE.md`・`DEVELOP/*.md` | F6 |

## 6. 着手前に通す手順

- **`/ui-design`**: F1・F3・F4・F5 はいずれも HUD/DOM/CSS に触れる。着手前に必ず通し、
  `DEVELOP/DESIGN-RULES.md` のウィジェット語彙・置き場・タッチ規約に沿わせる。
  特に F4 の断面フォームと F5 の部材棚は新しい UI の塊なので、ここを飛ばさない。
- **`/add-feature`**: F5a の lateral ポート列挙は、既存の `nearestMountCandidate` と
  `occupiedPorts` を**呼ぶ**形にできるかを先に確かめる(新しい占有判定を書かない)。

## 7. 未決定事項

1. **組立セッション中のクリックの持ち主**(§3-1)。`Game.update` の
   `handlePointerInput()` → `docking.updateAssembly()` の順を入れ替えるか、
   セッション中は `handlePointerInput` を素通りさせるか、組立パネルを
   `OverlayManager` の `gatesInput: true` にするか。3つ目は「パネルの外(=3D世界)を
   クリックできなくなる」ので採れない。前2つのどちらかになる。
2. **部材の長さと断面をどう選ばせるか**。長さは 0.5m 刻みの数値入力か、
   よく使う長さのボタン列か。断面は既存ノードの断面から選ぶか、独立に組ませるか。
3. **F5b(閉じた構造)を今回の範囲に含めるか**。含めない場合、
   三角形やはしご状の機体は組めないままになる。
4. **`assembly-mode.ts` の削除範囲**(§3-2)。`AssemblyDraft`/`blueprintFromDraft` は
   将来の設計保存で使う余地があるかもしれないので、消す前に第2巻 §4 の設計データと
   突き合わせる。
5. **カメラを戻す先**。セッション終了時に元の操作艦へ戻すか、対象を見たままにするか。

## 8. 完了条件

1. 装着済みの部品を3D上で掴んで、別の取り付け位置へ動かす・倉庫へ戻すことができる。
2. 掴んだ部品を持ったまま対象タブを切り替えて別の格納艦へ落とせる(項目6)。
3. 部材棚から外皮エッジ・トラス・分離機構を出し、空きポートへ吸わせてノードと辺を生成できる。
4. 3D上の辺を掴んで取り外せる。
5. 選択中ノードの断面(種別・寸法・位相)を数値で編集でき、1回の確定が1履歴になる。
6. 「新規船下書き」と「建造して格納」に UI からの入口がある。
7. 組立を始めるとカメラが対象を収める位置へ寄る。
8. `mateVerdict` を含む `assembly-mode.ts` の死んだ輸出が `src/` から消え、
   接続可否の判定が `assembly-editor.ts` の1箇所に閉じている。
9. `npm run typecheck` と `npm run test:unit` の両方が通る。
10. `CLAUDE.md`/`DEVELOP/CALLSTACK.md`/`DEVELOP/OWNERSHIP.md`/`DEVELOP/SPEC.md` が
    同じ変更セットで更新されている。
