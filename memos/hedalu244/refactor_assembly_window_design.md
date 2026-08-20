# 組立ウィンドウ リファクタリング計画 (2) 責務分割・重複・UX

## 前提 / 対象範囲

対象は「組み立てウィンドウ」まわり — `src/game/docking.ts`(`Docking`)、
`src/game/hud/assembly-panel.ts`(`AssemblyPanel`)、`src/game/hud/base-operations-window.ts`
(`BaseOperationsWindow`)、`src/game/vessel/assembly-drag-controller.ts`
(`AssemblyDragController`)、`src/game/vessel/dock-workbench.ts`/`dock-workbench-controller.ts`
(`DockWorkbenchSession`/`DockWorkbenchController`)、`src/game/vessel/assembly-editor.ts`
まわり。バグ (B1〜B5) と未使用コード (D1〜D6) は別担当が扱うため本計画では触れないが、
衝突する箇所は「実施順序の提案」に明記する。

行番号はすべて 2026-08-20 時点の実ファイルを読んで確認した値。

## 現状の事実

### game.ts から Docking への参照(実測)

| 行 | 呼び出し |
|---|---|
| `game.ts:218` | `this.docking = new Docking(...)` |
| `game.ts:224` | `this.mapActions.setDocking(this.docking)` |
| `game.ts:247` | `this.docking.dispose()` |
| `game.ts:321` | `this.docking.updateAssembly(this.input)` |
| `game.ts:367` / `375` | `updateDockedPhysics()` / `checkProximity()` |
| `game.ts:396` | `if (this._isPaused \|\| this.docking.assemblyInProgress) return;`(ポインタ入力の遮断) |
| `game.ts:514` | `this.docking.syncAssembly(fo)` |

`Docking` への参照は6箇所のみで、いずれも `Docking` 自身の公開メソッドを1回呼ぶだけの
薄い配線。`assemblyInProgress`(396行目、ポインタ入力を遮断する判定)は R1 の分割後も
`Docking` からアクセスできる必要がある——`AssemblySessionController` へ実体を移した後、
`Docking` 側に `get assemblyInProgress(): boolean { return this.assemblySession.inProgress; }`
という委譲ゲッターを残す。`game.ts` 側のこの1行は変更不要。

### Docking の全メソッド一覧

`src/game/docking.ts` は938行。責務は先行調査どおり①〜⑥の6つに分かれており、加えて
⑦「対象一覧・対象種別ごとの検証(`targetValidation`/`designIssues`)」という第7の責務が
モジュール末尾の自由関数として存在する(先行調査に無かった追加発見)。

| メソッド | 行 | 何をするか | 責務 |
|---|---|---|---|
| `setPartMeshVisible`(自由関数) | 118-122 | 描画木を traverse して `partVisualRef` 一致メッシュの visible を切替 | ④THREE表示 |
| `assemblyExtentRadius`(自由関数) | 106-115 | ツリーの外接半径を求める(カプセル+ノード) | ⑤カメラ |
| `constructor` | 150-169 | 依存注入、`transferDialog`/`vesselDeps`/`dragController` を構築 | 配線 |
| `getAvailableBases` | 172-174 | 生存中の基地一覧 | ①ドッキング |
| `getDockedTarget` | 177-184 | 艦のドッキング先を取得(死んでいれば掃除) | ①ドッキング |
| `canDock` | 187-199 | ドッキング可否判定 | ①ドッキング |
| `dockTo` | 202-212 | 物理ドッキング実行 | ①ドッキング |
| `undock` | 215-221 | ドッキング解除 | ①ドッキング |
| `openTransfer` | 224-226 | 物資融通ダイアログを開く(`ResourceTransferDialog` へ委譲) | ①ドッキング |
| `selectBase` | 229-231 | `_activeBase` を書く | ②基地ウィンドウ |
| `openBaseOperations` | 238-252 | `BaseOperationsWindow` を開く/移動 | ②基地ウィンドウ |
| `syncBaseWindows`(private) | 255-262 | 消えた基地のウィンドウを閉じる(毎フレーム) | ②基地ウィンドウ |
| `clearActiveBaseIf` | 265-274 | 基地消滅時に選択・ウィンドウ・組立セッションを畳む | ②③横断 |
| `assemblyInProgress`(getter) | 279 | 組立中か | ③組立 |
| `startAssembly` | 284-339 | セッション構築、`AssemblyPanel`/`DockWorkbenchSession`/`Controller` を new、`pauseGame()` | ③組立(生成) |
| `frameAssemblyCamera`(private) | 346-355 | 対象の外接半径からチェイスカメラ距離を計算し `cameraSystem` へ書く | ⑤カメラ |
| `commitAssembly`(private) | 359-379 | セッション→実機へ書き戻し | ③組立(確定) |
| `cancelAssembly` | 382-387 | セッション破棄 | ③組立 |
| `endAssembly`(private) | 391-407 | セッション後片付け(下書き破棄・ゴースト解除・カメラ復帰・`resumeGame()`) | ③③④⑤横断 |
| `updateAssembly` | 415-439 | 3Dクリックのキュー消費、ドラッグ update 呼び出し(update フェーズ入口) | ③組立(入力) |
| `handleAssemblyClick`(private) | 442-454 | 1クリックの処理分岐(離す/拾う) | ③組立(入力) |
| `applyPick`(private) | 458-468 | 拾った対象が部品ならドラッグ開始、ノード/エッジなら選択 | ③組立(入力) |
| `targetRenderRoot`(private) | 472-477 | 対象の描画木ルートを返す | ④THREE表示 |
| `hideHeldOriginal`(private) | 481-483 | `heldOriginal` へ記録するだけ | ④THREE表示(論理側) |
| `syncAssembly` | 489-498 | sync フェーズ入口。基地ウィンドウ/下書き描画/パネル/構造露出/隠しメッシュ/ドラッグの sync を束ねる | ②③④横断(オーケストレーション) |
| `revealTargetStructure`(private) | 504-510 | ワイヤーフレーム構造を露出/復帰 | ④THREE表示 |
| `syncHeldOriginal`(private) | 513-519 | 掴んだ部品の実機メッシュを隠す/戻す | ④THREE表示 |
| `dragTarget`(private) | 523-530 | `AssemblyDragTarget` を組む(慣性系での置かれ方) | ③組立(座標解決) |
| `targetPose`(private) | 534-546 | 対象の慣性系での位置・姿勢を求める | ③組立(座標解決) |
| `assemblyTargets`(private) | 549-560 | 対象一覧(基地本体・格納艦・下書き)を組む | ③組立 |
| `targetById`(private) | 562-564 | id から対象を引く | ③組立 |
| `syncDraftRenders`(private) | 568-588 | 下書きの `AssemblyRenderObject` を組み直し・配置 | ④THREE表示 |
| `reconcileDrafts`(private) | 592-610 | 下書き表示の写しをセッションの対象一覧へ同期 | ③組立(論理) |
| `commitDockedAssembly` | 616-638 | 格納艦の構成を新しい `Vessel` へ差し替え | ③組立(確定・生成) |
| `updateDockedPhysics` | 641-651 | ドッキング中の相対速度同期(毎フレーム) | ①ドッキング(物理) |
| `checkProximity` | 654-656 | `updateDockedPhysics` を呼ぶだけ | ①ドッキング |
| `storeInBase` | 659-691 | 艦を基地へ格納(物理・操作対象引き継ぎ・SFX・view切替まで) | ①ドッキング(横断) |
| `reportEditFailure`(private) | 693-695 | ヒントを出すだけ | ③組立 |
| `applyTargetAssembly`(private) | 698-713 | 検証済み構成を対象種別ごとに書き戻す | ③組立(確定) |
| `commitBaseAssembly`(private) | 717-739 | 基地本体の構成差し替え(ドック口の同一性検証含む) | ③組立(確定) |
| `createDraft` | 743-756 | 新規船下書きを作る | ③組立 |
| `freeSlotIndex`(private) | 759-764 | 空きドック枠を探す | ③組立 |
| `removeDraft` | 767-775 | 下書きを削除 | ③組立 |
| `disposeDraft`(private) | 777-782 | 下書きの表示写しを退避 | ④THREE表示 |
| `buildDraft` | 785-811 | 下書きを実艦として建造(**⑥生産・経済**) | ⑥生産 |
| `consumeMountedInventory`(private) | 815-823 | 倉庫在庫を実際に消費 | ⑥生産 |
| `draftBuildRequest`(private) | 827-835 | 建造費の `ProducibilityBlueprint` を組む(倉庫由来分を除外) | ⑥生産 |
| `draftBuildStatus`(private) | 840-850 | 「建造して格納」ボタンの但し書き(費用文言+賄えるか) — **P1で指摘の重複実装** | ⑥生産(表示派生) |
| `launch` | 853-886 | 格納艦をドックから発進 | ①ドッキング |
| `dispose` | 889-894 | 後片付け | 配線 |
| `targetValidation`(自由関数) | 900-906 | 対象1つの検証(blocking + issues) | ⑦検証 |
| `designIssues`(自由関数) | 909-924 | `validateAssembly` を呼んで設計上の指摘を得る | ⑦検証 |
| `sameDockPort`(自由関数) | 927-938 | 2つのドック口が同一か比較 | ③組立(補助) |

全45要素(自由関数6・メソッド39)。責務別の行数(概算、コメント込み):
①ドッキング物理 ≈150行、②基地ウィンドウ ≈60行、③組立セッション本体 ≈330行、
④THREE表示切替 ≈90行、⑤カメラ ≈25行、⑥生産・経済 ≈65行、⑦検証 ≈40行、配線・雑 ≈180行。

### 検証結果: R1 は正しい

先行調査の①〜⑥はすべて実在し、行数の見立てもおおむね正しい。**ただし新たに⑦(検証ロジック
`targetValidation`/`designIssues`)が独立責務として存在し、これも `Docking` の外に出す価値が
ある**(後述)。また `syncAssembly`(489-498)が②③④の横断オーケストレーションを担っており、
これは「複数モジュールにまたがる横断」を1つのメソッドに閉じ込めている点で `/refactor-fixed`
ルール1の第2選択肢(「その横断そのものを責務とするモジュールを1つ立てる」)の実例そのもの
——つまり `Docking` 自体は元々このパターンに則って作られたモジュールだが、**中に③(組立
セッション)というさらに独立した横断責務を抱え込んでしまった**、というのが実体である。

### AssemblyPanel の構成

`src/game/hud/assembly-panel.ts`(685行)。DOM構築・差分同期(`sync`)・入力ハンドラの3層。

- **DOM/表示専用**: 対象タブ(`TabBar`)、元に戻す/やり直す/確定/取消ボタン、下書き操作
  ボタン、選択行、断面編集(`SegmentedControl`/`ToggleSwitch`/`ValueInput`)、部材棚、
  検索欄(`ValueInput`)、エラー一覧、部品棚(`Button` per part)。
- **ロジック**: `applyPrimitiveEdit`(550-557)・`removeSelection`(538-546)は
  `this.workbench`(`DockWorkbenchController`)を直接叩いて `editSection`/`removeNode`/
  `removeEdge` を呼ぶ——ファイル冒頭コメントが宣言するとおり、断面編集・選択削除は
  `session`/`workbench` を直接持っているのでここで完結させている。**これは責務違反では
  ない**(コメントに書かれた設計どおり)。
- **境界**: 新規船下書きの作成・建造(`onCreateDraft`/`onBuildDraft`/`onRemoveDraft`)と
  `draftBuildStatus` は `Docking` 側のコールバックに委ねる、と明記されている
  (1-7行目のコメント)。**これも実装と一致**——`Docking` 側が資源・在庫という基地の持ち物を
  扱うため。

`AssemblyPanel` 自体は「表示 + セッション内で完結する編集(選択削除・断面編集)」という
一貫した境界を保っており、**責務分割上の問題は見当たらない**。P1(建造費表示の重複)は
`AssemblyPanel` 自身ではなく、それが呼ぶ `Docking.draftBuildStatus` の側の実装重複である。

### 依存関係図(誰が誰を参照しているか)

```
Docking (constructor 引数で受ける)
  ├─ Hud, WorldSfx, THREE.Scene, EffectsSystem, MarkerManager, GraphicsSettings
  ├─ EntityManager, MapContextActions, CameraSystem, ViewManager, ActiveVesselController
  ├─ ResourceTransferDialog        (new する — Docking が所有)
  └─ AssemblyDragController        (new する — Docking が所有、セッションより長生き)

Docking.startAssembly() 内で per-session に new するもの:
  DockWorkbenchSession
    └─ AssemblyDragController.beginDrag/beginMemberDrag が workbench(=Controller) を経由して触る
  DockWorkbenchController(session)
  AssemblyPanel(root, overlayManager, dragController, workbench)
    └─ workbench.editSection/removeNode/removeEdge を直接呼ぶ
    └─ dragController.beginDrag を部品棚ボタンから呼ぶ

AssemblyDragController
  ├─ assembly-editor.ts の addPlacement/movePlacement を直接呼ぶ(判定はしない、editor に問うだけ)
  ├─ mount-candidates.ts の nearestMountCandidate を呼ぶ
  ├─ member.ts の memberAdditionAt/memberGhostTree を呼ぶ
  └─ render/hull/{part-meshes,loft-mesh}.ts でゴーストメッシュを作る(THREE)

BaseOperationsWindow (Docking が openBaseOperations で new する。1基地1枚、Map<string,_> で保持)
  ├─ economy/producibility.ts の producibility/consumeProductionResources を直接呼ぶ
  ├─ vessel/production.ts の repairBlueprintOf 等を直接呼ぶ
  └─ Vessel.baseState.resources / .inventory / .parts を直接書き換える(part.hp = ..., tank.fuel = ...)

Docking.draftBuildStatus (939行のうち840-850)
  └─ economy/producibility.ts の producibility を直接呼ぶ(BaseOperationsWindow と同じ経路を再実装)
```

`AssemblyDragController` と `BaseOperationsWindow` は互いに独立(どちらも `Docking` からしか
参照されない)。`AssemblyPanel` は `AssemblyDragController` と `DockWorkbenchController` を
直接持つが、`BaseOperationsWindow` を一切参照しない——**組立セッションと基地操作ウィンドウは
コード上は疎結合**で、`Docking` がその2つを同じクラスの中で束ねているために「1クラスが
無関係な2つの GUI ライフサイクルを持つ」という形になっている。

## R1 Docking の責務分割

### 検証結果

先行調査の①〜⑥はすべて実在。938行のうち、②(基地操作ウィンドウのライフサイクル)は
実装として薄く(`openBaseOperations`/`syncBaseWindows`/`clearActiveBaseIf` の一部、
合計 ≈40行)、③(組立セッション統括)が実質的な本体(≈330行、④⑤⑥の呼び出し元も含めれば
938行の6割超)。**「938行のうち大半は組立セッションであり、①(物理ドッキング)と
②(基地ウィンドウ)は相対的に小さな付け足しである」**というのが実態に近い。

### 再配置案

分割の指針は「独立して変更されうる単位に分け、かつ新モジュールの数を必要最小限にする」。
先行調査が挙げた①〜⑥をそのまま6モジュールに割ると過剰分割になる
(⑤カメラフレーミングは25行しかなく、単独モジュールにする価値がない。④THREE表示切替も
③組立セッションの内部実装の一部であり、外から呼ばれる独立APIではない)。

以下の3モジュールへの分割を提案する。**Docking 自体は残し、③(組立セッション統括)だけを
新設の `AssemblySessionController` へ丸ごと移す。** ①②は元の `Docking` に残す
(どちらも「基地」を主語にした薄い責務で、互いに強く関連する——「基地を選ぶ」→
「基地操作ウィンドウを開く/組立を始める」という導線を1つのクラスが持つ方が自然)。

```
src/game/docking.ts                          … ①物理ドッキング + ②基地操作ウィンドウの
                                                 ライフサイクル + Docking 全体の配線(不変)
  class Docking {
    getAvailableBases / getDockedTarget / canDock / dockTo / undock / openTransfer
    selectBase / openBaseOperations / syncBaseWindows / clearActiveBaseIf
    updateDockedPhysics / checkProximity / storeInBase / launch
    dispose
    // 組立セッションへは委譲するだけ
    get assemblySession(): AssemblySessionController  (公開フィールド、Game 等はここ経由で触る)
  }

src/game/assembly-session-controller.ts             … 新設。③組立セッション統括の丸ごと移設
  class AssemblySessionController {
    // 元 Docking の private assembly: AssemblySession | null と、それを操作する
    // startAssembly / commitAssembly / cancelAssembly / endAssembly / updateAssembly /
    // handleAssemblyClick / applyPick / syncAssembly / dragTarget / targetPose /
    // assemblyTargets / targetById / reconcileDrafts / commitDockedAssembly /
    // applyTargetAssembly / commitBaseAssembly / createDraft / freeSlotIndex /
    // removeDraft / disposeDraft を丸ごと移設。
    // ④THREE表示切替(setPartMeshVisible/revealTargetStructure/syncHeldOriginal/
    //   syncDraftRenders/targetRenderRoot/hideHeldOriginal)もここに残す
    //   ——これらは組立セッション"専用"の描画切替で、他の呼び出し元を持たないため
    //   独立モジュールに切り出す価値がない(切り出すと assembly-session-controller.ts
    //   と往復する2モジュールになるだけ)。
    // ⑤カメラフレーミング(frameAssemblyCamera/assemblyExtentRadius)もここに残す
    //   ——同じ理由。25行の呼び出し元が1つしかない計算をモジュール分割する理由はない。
    get inProgress(): boolean          // 旧 assemblyInProgress
    startAssembly(base, preferredTargetId?): void
    updateAssembly(input): void        // update フェーズ入口
    syncAssembly(fo): void             // sync フェーズ入口
    cancelAssembly(): void
    dispose(): void
  }
  // 生産(⑥)だけは分離(下記)。buildDraft/consumeMountedInventory/draftBuildRequest/
  // draftBuildStatus は AssemblySessionController が経由地点として持つが、実処理は
  // vessel/production.ts へ委譲する形にする(P1参照)。

src/game/docking.ts 内、末尾の自由関数(⑦検証)
  targetValidation / designIssues / sameDockPort
  → src/game/vessel/dock-workbench-validation.ts へ切り出す(新設)。
    dock-workbench.ts でも dock-workbench-controller.ts でもなく新規ファイルにする理由:
    この3関数は「対象1つが構成として成り立つか」という判定であり、DockWorkbenchSession の
    コンストラクタが受け取るコールバック(targetValidator)としてのみ使われる——
    dock-workbench.ts 自体を汚さず、docking.ts からも独立させられる。
    公開 API: targetValidation(target, dockedCount): TargetIssues 1つだけ
    (designIssues/sameDockPort は private のまま)。
```

**Docking と AssemblySessionController の関係**: `Docking` のコンストラクタが
`AssemblySessionController` を1つ new して private フィールドとして持ち、
`assemblySession` getter で公開する。`openBaseOperations`/`clearActiveBaseIf`/
`selectBase` など①②側から③の状態を参照する必要がある箇所
(`clearActiveBaseIf` が `this.assembly?.base === base` なら `cancelAssembly()` する、
`storeInBase`/`launch` が「組立中なら拒否」を見る箇所)は、`this.assemblySession.inProgress`
/ `this.assemblySession.baseOf()`(新設、対象の基地を返す)を読む形にする。

**Game 側の呼び出し変更点**: 「現状の事実」節の表のとおり、`game.ts` は
`docking.updateAssembly(this.input)`(321行)/ `docking.syncAssembly(fo)`(514行)/
`docking.assemblyInProgress`(396行)を含む6箇所で `Docking` を参照する。分割後も
`Game` は `docking.updateAssembly(input)`/`docking.syncAssembly(fo)`/
`docking.assemblyInProgress` を呼ぶままにし、**`Docking` 側のこれら3つを
`this.assemblySession.updateAssembly(input)`/`.syncAssembly(fo)`/`.inProgress` への
1行委譲に変える**——`game.ts` 側の6箇所は一切変更不要。これにより「`Game` は `Docking`
を1つ叩けばよい」という既存の呼び出し規約を壊さずに内部構造だけを変えられる。

**`DEVELOP/OWNERSHIP.md` 上の位置づけ**: 現状 117行目の `Docking` エントリの子として
131-175行目あたりに `AssemblyDragController`/`AssemblySession?`/`DockWorkbenchSession`/
`DockWorkbenchController`/`AssemblyPanel`/`DraftEntry ×n` がぶら下がっている。分割後は
この所有木を1段掘り下げ、`Docking → AssemblySessionController → (AssemblyDragController /
AssemblySession? / DockWorkbenchSession / DockWorkbenchController / AssemblyPanel /
DraftEntry ×n)` という木にする。`AssemblyDragController` は「セッションより長生きする」
という既存の注記どおり `AssemblySessionController` がコンストラクタで1つ new して持つ
(旧 `Docking` から移設するだけ)。510行目・580行目・582-585行目・609行目の各エントリの
「持ち主」列を `Docking` から `AssemblySessionController` へ書き換える必要がある
(`selectBase`/`openBaseOperations` に関する582-583行目のエントリだけは `Docking` に残る)。

### なぜその境界か

- **`src/game/assembly/` というディレクトリを新設しない理由**: `game/` 直下には既に
  `docking.ts`/`map-context-actions.ts`/`view-manager.ts` のような「複数の所有者に
  またがる横断責務」を1ファイルで表すモジュールが並んでいる。`AssemblySessionController`
  も同じ性質(組立セッションという1つの横断責務を1クラスで表す)であり、この時点では
  移設対象が1ファイルしかないため、専用ディレクトリを切る理由がない。ディレクトリ分割は
  「そこに複数ファイルが実際に入ると分かってから」で十分——先に切ると、後から
  `AssemblyPanel`/`AssemblyDragController` 等を同じディレクトリへ移すべきかという
  余計な判断を今すぐ迫ることになる(これらは HUD 層・vessel 層それぞれの既存の置き場所
  が既にあり、動かす理由がない)。よって `src/game/assembly-session-controller.ts` を
  `game/` 直下に置く。
- **「①②を残す・③を切り出す」という非対称な分割にした理由**: ①②はどちらも「基地」を
  主語にした薄い操作で、互いの導線が強い(基地を右クリック→ウィンドウを開く/組み立てる、
  という同じメニューから分岐する)。一方③は「艦体の設計を編集する」という全く別の作業で、
  時間を止める・カメラを寄せる・専用のUndo履歴を持つなど、①②とは異なる不変条件の塊を
  抱えている。CLAUDE.md の既存記述(1-2行目)自体が「基地まわりの3つの関心事:
  物理ドッキング、基地操作ウィンドウの開閉、艦体の組立セッション」と3つに分けて説明して
  おり、**実装のコメントが元々③を独立した関心事として認識していた**——それをクラス境界に
  反映するのが今回の変更。
- **④(THREE表示切替)・⑤(カメラ)を独立モジュールにしなかった理由**: どちらも
  「組立セッションが開いている間だけ」意味を持ち、呼び出し元は `AssemblySessionController`
  の中の2〜3箇所に限られる。独立ファイルに切り出すと `AssemblySessionController` との
  往復（フィールドの受け渡し）が増えるだけで、「変更が1箇所で済む」という目的に資さない。
  CLAUDE.md 冒頭の指示どおり「分けること自体が目的ではなく、変更が1箇所で済むようにする」
  ——これらは組立セッションの内部実装の詳細であり、③の一部として動くのが自然。
- **⑥(生産・経済)を切り出す理由**: `buildDraft`/`consumeMountedInventory`/
  `draftBuildRequest` は「基地の在庫・資源を消費して実艦を作る」という、`economy/`・
  `vessel/production.ts` と直接対話するロジックであり、THREE.js にも組立セッションの
  DOM/ドラッグ状態にも依存しない。かつ P1 で指摘するとおり `BaseOperationsWindow` の
  生産タブと**全く同じパイプライン**(`producibility` → `formatResourceAmount` →
  `consumeProductionResources`)を再実装している。ここは独立モジュール化する価値がある
  (詳細は P1 の節)。
- **⑦(検証)を切り出す理由**: `targetValidation`/`designIssues` は `DockWorkbenchSession`
  のコンストラクタへ渡すコールバック関数でしかなく、`Docking` のどのメソッドからも直接
  呼ばれていない(`startAssembly` 内で1回、コールバックとして渡されるだけ)。`Docking`
  クラスの外に出しても呼び出し側は1行(import元の変更)で済み、`docking.ts` の行数を
  純粋に減らせる。

### 手順(段階的に、各段階で typecheck が通る単位に分ける)

1. **`src/game/vessel/dock-workbench-validation.ts` を新設**し、`targetValidation`/
   `designIssues`/`sameDockPort` を移設。`docking.ts` からは import に変更。
   (影響: `docking.ts` の import 行と `startAssembly` 内の参照のみ。他ファイルへの影響なし。
   typecheck 確認可能な最小単位。)
2. **`src/game/assembly-session-controller.ts` を新設**する。
   まず**空の骨格**(コンストラクタが `Docking` から渡された依存を受けるだけ)を作り、
   `Docking` 側に `assemblySession` フィールドを追加して new する配線だけ済ませる
   (メソッドはまだ移さない)。
3. **③のメソッド群を1つずつ `AssemblySessionController` へ移設**——`startAssembly` から
   始め、`commitAssembly`/`cancelAssembly`/`endAssembly`/`updateAssembly`/
   `handleAssemblyClick`/`applyPick`/`syncAssembly` の順(呼び出し依存の少ない末端メソッド
   から先に動かす)。移設のたびに `Docking` 側の対応するメソッドを
   `this.assemblySession.foo(...)` への1行委譲に置き換え、typecheck を通す。
   このステップは複数コミットに分けてよい(1メソッド〜数メソッドずつ)。
4. **④(THREE表示切替系)と⑤(カメラ)のメソッドを移設**——`setPartMeshVisible`/
   `revealTargetStructure`/`syncHeldOriginal`/`syncDraftRenders`/`targetRenderRoot`/
   `hideHeldOriginal`/`frameAssemblyCamera`/`assemblyExtentRadius`。ステップ3で移した
   メソッドから既に参照されているはずなので、実質的にはステップ3と同時に動かすのが自然
   (③と④⑤は密結合のため無理に分けない)。
5. **`AssemblyDragController` の所有権を `Docking` から `AssemblySessionController` へ
   移す**——コンストラクタでの `new AssemblyDragController(scene)` を移設し、`Docking`
   側のフィールドを削除。`DEVELOP/OWNERSHIP.md` の該当箇所を書き換える
   (`/develop-docs` を通す)。
6. **⑥(生産)の切り出し**(P1 と合流、後述の P1 手順を参照)。
7. **`Docking` の残りメソッド**(①②)がすべて `AssemblySessionController` へ何も
   委譲しなくなったことを確認し、`docking.ts` の import から不要になったものを削る。
   最終行数を確認(①②の実装量から、200〜250行程度になる見込み)。
8. 各ステップ後に `npm run typecheck` を実行(`test:physics` は該当なし——このモジュール
   群は `src/physics/` を触らない)。全ステップ完了後に `CLAUDE.md`/`DEVELOP/OWNERSHIP.md`/
   `DEVELOP/CALLSTACK.md` を `/develop-docs` の手順で同期する(責務の移動なので必須)。

### リスク / 波及

- **`pauseGame`/`resumeGame` クロージャ注入の例外**: 現在 `Docking` のコンストラクタは
  `pauseGame: () => void` / `resumeGame: () => void` の2つのクロージャを受けている
  (CLAUDE.md に明記された確定済みの暫定例外)。この2つは実質的に③(組立セッション、
  `startAssembly`/`endAssembly` の中でのみ呼ばれる)専用であり、①②では一度も使われない
  (`getDockedTarget`/`storeInBase`/`launch` 等はポーズに触れない)。
  **分割後は、この2つのクロージャは `Docking` ではなく新設の `AssemblySessionController`
  のコンストラクタが直接受け取るべき**——`Docking` はこれらを一切必要としなくなる。
  これにより CLAUDE.md の暫定例外の記述(「持ち主は `Docking`」)を
  `AssemblySessionController` に付け替える文書更新が必要になる。この移動自体は
  「クロージャ注入をやめて `Game` 参照を渡す」という本来あるべき形への是正ではなく、
  単に**同じ暫定例外を正しい持ち主(実際に使うクラス)へ動かすだけ**なので、恒久対応は
  別担当(あるいは別計画)に委ねてよい。本計画ではこの移動のみを実施する。
- **`AssemblyPanel` のコンストラクタ引数**: 現状 `dragController`/`workbench` を直接
  受けている。`AssemblySessionController` へ移設後もこの2つは変わらず
  `AssemblySessionController` 内で new されて渡されるので、`AssemblyPanel` 自体には
  変更不要。
- **循環 import の懸念**: `assembly-session-controller.ts` は `docking.ts` から
  import されない(`docking.ts` が `assembly-session-controller.ts` を import する
  一方向)ため、循環は発生しない。ただし `AssemblySelection` 型(現在 `docking.ts` が
  export し、`assembly-panel.ts` が import している)を `assembly-session-controller.ts`
  側へ移す場合、`assembly-panel.ts` の import 元を変更する必要がある。
- **`MapContextActions`/`ViewManager` からの参照**: `docking.ts` の import 一覧に
  `MapContextActions`/`CameraSystem`/`ViewManager` があり、これらが `Docking` の
  どのメソッドから使われるかは①②③に跨る(`storeInBase` が `mapActions.close()`/
  `cameraSystem.mapCamera.clearFocusIf`/`viewManager.setView` を呼ぶ)。
  `AssemblySessionController` 側では `cameraSystem`(⑤カメラフレーミング用)だけを
  受け取ればよく、`mapActions`/`viewManager` は不要——コンストラクタ引数を絞れる。

## R2 BaseOperationsWindow の責務混在

### 検証結果

先行調査は概ね正しい。`base-operations-window.ts`(779行)は冒頭コメント(1-4行目)で
「資源の増減・生産可否の判定は economy/ と vessel/ が持ち、このクラスはそれらを呼んで
結果を描くだけ」と宣言しているが、実装を見ると**この宣言と矛盾する直接ミューテーションが
複数箇所にある**:

| 箇所 | 行 | 内容 | コメントとの矛盾 |
|---|---|---|---|
| `handleRepairPart` | 701-712 | `part.hp = part.maxHp` | 「呼んで結果を描くだけ」のはずが `Part` の状態を直接書く |
| `handleRepairAll` | 714-726 | `parts.forEach((p) => { p.hp = p.maxHp; })` | 同上 |
| `handleSwapPart` | 738-751 | `shipData.parts.splice(partIdx, 1, incoming)` / `base.baseState!.inventory.splice(invIdx, 1, installed)` | 艦の部品配列・基地在庫を直接 splice |
| `refuelTank` | 772-778 | `tank.fuel = capacity` | 同上 |
| `handleGrantResource` | 688-699 | `base.baseState!.resources.add(id, mass)` | これは `ResourceLedger.add` という正規の書き込み口を呼んでいるので問題なし |
| `handleProducePart` | 680-686 | `base.baseState!.inventory.push(buildPartFrom(sample))` | 在庫配列への直接 push |

**ただし**、これらの直接ミューテーションは「資源の増減・生産可否の**判定**は economy/ と
vessel/ が持つ」という宣言とは矛盾しない——冒頭コメントが約束しているのは
**判定ロジック**(`producibility`/`canAfford`)を自前で持たないことであり、**実際に
HP・燃料・在庫を書き込む代入自体**についてはコメントは何も約束していない。読み直すと
矛盾は「コメントの表現が実装より広い範囲を約束しているように読める」という**コメントの
精度不足**であり、致命的な設計違反とまでは言えない。とはいえ、`Part.hp`/`tank.fuel`/
`inventory`/`shipData.parts` への直接代入が7箇所に分散しているのは事実で、
「艦・基地の在庫状態を変更する権限を持つ場所」が `Vessel`/`base-module.ts` 側ではなく
HUD 側に散っている点は改善の余地がある。

### 影響

- 艦の部品HP・燃料・在庫が「誰が正本か」ではなく「誰が最初にこれを書いたウィンドウか」で
  決まっている。将来、修理・補給・換装を別の経路(例: 自動修理システム、AI 基地の自動整備)
  からも行いたくなったとき、同じ代入コードをもう一度書くか、このクラスの private メソッドを
  無理に公開するかの二択になる。
- `syncDockedSnapshot`(730-734行)は「`shipData.parts` が艦本体の `parts` と同一参照
  なので直接反映される」という代入の副作用に依存した実装になっており、`DockedVesselEntry`
  の `hp`/`maxHp` フィールドが `parts` の内容から独立して存在する理由(表示用スナップショット)
  が実装のコメントでしか説明されていない。

### 修正案

修理・補給・換装・生産の4操作を、`vessel/production.ts`(または新設する
`vessel/base-inventory-ops.ts`)に**「実行する」関数**として切り出す。現状
`vessel/production.ts` は「費用を計算する」関数(`repairBlueprintOf` 等)しか持っておらず、
「実際に HP/燃料/在庫を書き換える」実行部分は `BaseOperationsWindow` にしかない。

```
src/game/vessel/base-inventory-ops.ts  … 新設
  // 費用計算(production.ts の既存関数)と実行(ここ)を対にする。
  // 「足りるか判定 → 引く → 書き込む」を1関数にまとめ、部分適用を作らない。
  export function repairPart(base: Vessel, part: AnyPart): boolean       // 資源を引き、part.hp = part.maxHp
  export function repairAll(base: Vessel, parts: readonly AnyPart[]): boolean
  export function refuelTank(base: Vessel, tank: PropellantTankPart): boolean
  export function swapInstalledPart(base: Vessel, shipData: DockedVesselEntry, partIdx: number, invId: string): boolean
  export function producePart(base: Vessel, sample: AnyPart): boolean
```

`BaseOperationsWindow` の `handleRepairPart` 等は、この関数を呼んで結果(成功/失敗)に
応じて `this.refresh()` するだけに変える。これにより冒頭コメントの「呼んで結果を描くだけ」
が文字どおり正しくなる。

### 変更ファイルと手順

1. `vessel/base-inventory-ops.ts` を新設し、上記5関数を実装(`spend`/`shortfall`/
   `canAfford` の判定ロジックは P1 で切り出す共通実装をここから呼ぶ——R2 と P1 は
   同時に行うのが自然、詳細は P1 参照)。
2. `base-operations-window.ts` の `handleRepairPart`/`handleRepairAll`/`handleSwapPart`/
   `refuelTank`/`handleProducePart` を書き換え、新関数を呼ぶだけにする。
3. `syncDockedSnapshot` はそのまま残す(表示スナップショットの更新は HUD 側の責務のまま
   でよい——`DockedVesselEntry.hp`/`maxHp` はあくまで一覧表示用の写しであり、正本は
   `Vessel.parts` 経由の集計)。
4. typecheck 確認。

### 検証方法

`npm run typecheck` のみ(このファイルはゲームロジックだが `src/physics/` ではないので
`test:physics` の対象外)。手動確認が必要なら `/verify` を使うが、今回は挙動を変えない
リファクタリングなので必須ではない。

### リスク

- `repairPart`/`refuelTank` 等を `Vessel`/`base-module.ts` ではなく `vessel/` 直下の
  新規ファイルに置く判断——`Vessel` 自身のメソッドにする案もあり得るが、「基地の資源を
  引いて艦を直す」という操作は艦単体の責務ではなく「基地×艦」の関係なので、`Vessel`
  クラスに生やすと基地の存在を前提にした奇妙なメソッドになる。独立関数の形が妥当。

## R3 AssemblyDragController の責務混在

### 検証結果

先行調査はほぼ正しいが、**ファイル冒頭のコメント自体が「取り付けの可否をこのモジュールが
判定することはない」(3行目)と明言している一方、実装は `updatePartDrag`(199-226行)
/ `updateMemberDrag`(230-241行)の中で `assembly-editor.ts` の `addPlacement`/
`movePlacement`/`memberAdditionAt` を直接呼び、その結果(`AssemblyEditResult`)を
`this.pose`/`this.pendingMemberEdit`/`SnapCandidate` に組み込んでいる**。これは
「判定はしない」という文言と矛盾しているように見えるが、正確には——

- **可否そのものの計算**(「この位置は構造として成り立つか」)は `assembly-editor.ts`
  の `addPlacement`/`movePlacement`/`memberAdditionAt` が行っており、
  `AssemblyDragController` はその**戻り値をそのまま使っているだけ**(`result.accepted`
  を読んで色を変える、`result` をそのまま `pendingMemberEdit`/`SnapCandidate` へ格納する)。
- しかし、**「どの取り付け位置を候補として editor に問い合わせるか」を決める
  `resolveMount`/`resolvePortMount`/`probeMountPoint`(333-365行)は、レイキャスト→
  カプセル近傍探索→`nearestMountCandidate` 呼び出しという3D幾何ロジックであり、これは
  ドラッグコントローラ固有の仕事として妥当**(取り付け候補の探索は「掴んでいるものを
  どこへ吸い寄せるか」という UI 操作そのものであり、editor の責務ではない)。

つまり実態は「**取り付け候補の探索(3D幾何)はここの責務、可否の最終判定は editor の責務**」
という分担であり、コメントの「判定はしない」は成立している。**ただし `updatePartDrag`/
`updateMemberDrag` が `editor` の呼び出し結果を `SnapCandidate`/`PendingMemberEdit` という
UI 都合の型へ変換する処理まで持っているのは、"呼んで表示するだけ" の範囲を超えて
"ドラッグの状態機械としての判断"(掴んでいるのが部品か部材かで呼ぶ editor 関数を変える、
`held`/`workbench` を毎回参照する)まで担っており、これは③(組立セッション、
`AssemblySessionController`)ではなく `DockWorkbenchController` の責務に近い部分がある**。

### 影響

- P2(後述)の重複実装が、この「探索ロジックと変換ロジックが同居している」構造から
  生まれている——部品と部材で「候補を探索→editorへ問い合わせ」という同型の処理を
  2回書いているため。「変換」側(`SnapCandidate`/`PendingMemberEdit` の構築)は
  型が異なるため共通化できない(P3で見送りとした理由と同じ)。
- `AssemblyDragController` 自体を割る必要はない(R1のように複数モジュールへ分割するほどの
  規模ではない)。P2 の重複解消(候補探索の共通化)で解決できる範囲はそこまで——
  「探索ロジックと変換ロジックが同居している」構造そのものは、変換側の型が部品/部材で
  異なる以上、これ以上は分離できない。

### 修正案

R3 単独でのモジュール分割は行わない。P2 の重複解消によって、部品/部材の分岐を
「探索半径・候補フィルタ」という**データの違い**に閉じ込める(詳細は P2 節)。
「探索→変換」という手続き全体の共通化は P3 で検討し見送った(規約に反するため)。
これにより「判定はしない」という宣言と、実際にやっている「候補の探索とUI表現への
変換」という仕事の境界は、P2 の範囲でコード上に表現される。

### 変更ファイルと手順

P2 の手順に合流。単独の変更は不要。

### リスク

なし(構造変更を伴わない、内部の重複解消のみ)。

## P1 建造費表示パイプラインの重複

### 検証結果: 正しい

- `Docking.draftBuildStatus`(`docking.ts:840-850`):
  ```
  const request = this.draftBuildRequest(entry, draft, entry.session.getTarget(targetId).assembly);
  const ledger = base.baseState.resources;
  const demand = productionResourceDemand(request, ledger);
  const costText = [...demand].map(([id, mass]) => formatResourceAmount(id, mass)).join('・') || '資源なし';
  const affordable = producibility(request, ledger, baseFacilities(base), basePowerAvailable(base)).length === 0;
  ```
- `BaseOperationsWindow.formatCost`(`base-operations-window.ts:654-658`)+
  `shortfall`(638-640)+`canAfford`(643-645):
  ```
  private shortfall(base, request) { return producibility(request, base.baseState!.resources, baseFacilities(base), basePowerAvailable(base)); }
  private canAfford(base, request) { return this.shortfall(base, request).length === 0; }
  private formatCost(request) {
    const demand = productionResourceDemand(request, this.currentBase!.baseState!.resources);
    const parts = [...demand].map(([id, mass]) => formatResourceAmount(id, mass));
    return parts.length === 0 ? '資源なし' : parts.join('・');
  }
  ```

2つは完全に同じ4ステップ(`producibility` で可否判定 → `productionResourceDemand` で
内訳を得る → `formatResourceAmount` で文字列化 → 空なら「資源なし」)を独立に実装している。
`Docking.draftBuildStatus` のコメント自体が「base-operations-window.ts の生産タブと
同じ形」と明言しており(837行目)、**重複が意図的に許容されていたことがコメントから
読み取れる**——つまり実装者は重複を認識した上で、当時は共通化を後回しにした形跡がある。

### 影響

- `producibility`/`productionResourceDemand`/`formatResourceAmount` の呼び出し順や
  引数(`baseFacilities(base)`/`basePowerAvailable(base)`)を将来変更するとき、
  2箇所を同時に直す必要がある。片方だけ直すと「建造ボタンの費用表示」と「生産タブの
  費用表示」が異なる基準で「賄えるか」を判定する、というバグを生みうる。
- 「資源なし」という空表記の文言も2箇所に重複している。

### 修正案

`vessel/` 配下に新規ファイルを置く案も検討したが、それでは `formatResourceAmount`
(`hud/inventory-labels.ts`)を `vessel/` から import することになり、**`vessel/`(下位層)
が `hud/`(上位層)に依存する逆転を生む**。`hud/inventory-labels.ts` は既に
「基地が持つものの表示名と数値書式」という責務を持つファイルで、
`PART_TYPE_LABELS`/`formatPartMeta`/`formatResourceAmount` が既にここにあり、
`BaseOperationsWindow`(既存の呼び出し元)と `AssemblyPanel`(将来の呼び出し元)の
双方が既にこのファイルを import している。**したがってこの4ステップは
`hud/inventory-labels.ts` に追加する**(新規ファイルは作らない)。

```ts
// hud/inventory-labels.ts に追加
export interface ProductionCostSummary {
  readonly costText: string;       // "アルミ 12.0 kg・電子機器 3.0 kg" or "資源なし"
  readonly affordable: boolean;
}

export function productionCostSummary(
  base: Vessel, request: ProducibilityBlueprint,
): ProductionCostSummary {
  const ledger = base.baseState!.resources;
  const demand = productionResourceDemand(request, ledger);
  const costText = [...demand].map(([id, mass]) => formatResourceAmount(id, mass)).join('・') || '資源なし';
  const affordable = producibility(request, ledger, baseFacilities(base), basePowerAvailable(base)).length === 0;
  return { costText, affordable };
}
```

`BaseOperationsWindow.formatCost`/`shortfall`/`canAfford`、`Docking.draftBuildStatus`
はいずれもこの1関数を呼ぶだけにする。`BaseOperationsWindow` 側は `canAfford`(可否だけ
欲しい箇所が複数ある: `handleRepairPart` 等のボタン有効化判定)も使うため、
`productionCostSummary(...).affordable` を読む形にするか、別途
`affordableProductionRequest(base, request): boolean` という軽量版も併置する
(`shortfall` を経由せず `producibility(...).length === 0` だけを返す——`formatCost` を
呼ぶたびに `productionResourceDemand` まで計算するのは、ボタンの有効/無効判定だけなら
無駄なため)。

### 変更ファイルと手順

1. `hud/inventory-labels.ts` に `productionCostSummary`/`affordableProductionRequest`
   の2関数を追加。
2. `base-operations-window.ts` の `shortfall`/`canAfford`/`formatCost` を削除し、
   呼び出し箇所を新関数に置き換える(`canAfford` の呼び出し17箇所程度——ボタンの
   `setEnabled` 判定に多用されているため、`affordableProductionRequest` への
   置換が中心になる)。
3. `docking.ts`(または R1 移設後は `assembly-session-controller.ts`)の
   `draftBuildStatus` を `productionCostSummary` の1行呼び出しに置き換える。
4. typecheck 確認。

### 検証方法

`npm run typecheck`。表示文言・可否判定のロジックは変更しないため、動作は変わらない
(純粋なリファクタリング)。

### リスク

- R1(Docking分割)と同時に触ると `draftBuildRequest`/`draftBuildStatus` の移設先が
  `AssemblySessionController` になるため、**R1 のステップ6(⑥生産の切り出し)と
  この P1 を同時に行うのが効率的**——上記「実施順序の提案」参照。

## P2 resolveMount / resolvePortMount の重複

### 検証結果: 正しい

`assembly-drag-controller.ts:333-343`:
```ts
private resolveMount(target, cameraPos, direction): MountCandidate | null {
  const probe = this.probeMountPoint(target, cameraPos, direction);
  return probe && nearestMountCandidate(target.assembly, probe, SNAP_DISTANCE);
}

private resolvePortMount(target, cameraPos, direction): MountCandidate | null {
  const probe = this.probeMountPoint(target, cameraPos, direction);
  return probe && nearestMountCandidate(target.assembly, probe, SNAP_DISTANCE, (m) => m.kind === 'port', ['axial', 'lateral']);
}
```

差分は `nearestMountCandidate` への第4・第5引数(フィルタ関数と `portKinds`)だけ。
`mount-candidates.ts` を確認したところ(`nearestMountCandidate(assembly, localPoint,
maxDistance, filter?, portKinds?)`)、この2引数はまさにこの差分のために既に用意された
オプション引数であり、**2つの薄いラッパーを維持する理由がない**。

### 影響

軽微。行数としては11行の重複だが、`SNAP_DISTANCE` という定数を2箇所で使っており、
将来スナップ距離を部品用/部材用で分けたくなったときに片方だけ変える改修が2箇所に散る。

### 修正案

`resolveMount`/`resolvePortMount` を1つの `resolveMountCandidate` に統合し、呼び出し側
(`updatePartDrag`/`updateMemberDrag`)がフィルタ・`portKinds` を渡す形にする:

```ts
private resolveMountCandidate(
  target: AssemblyDragTarget, cameraPos: Vec3, direction: Vec3,
  filter?: (m: MountCandidate) => boolean, portKinds?: readonly PortKind[],
): MountCandidate | null {
  const probe = this.probeMountPoint(target, cameraPos, direction);
  return probe && nearestMountCandidate(target.assembly, probe, SNAP_DISTANCE, filter, portKinds);
}
```

`updatePartDrag` は `this.resolveMountCandidate(target, cameraPos, direction)`
(引数省略=既定の全候補)、`updateMemberDrag` は
`this.resolveMountCandidate(target, cameraPos, direction, (m) => m.kind === 'port', ['axial', 'lateral'])`
と呼ぶ。

### 変更ファイルと手順

1. `assembly-drag-controller.ts` の `resolveMount`/`resolvePortMount` を
   `resolveMountCandidate` に統合。
2. `updatePartDrag`/`updateMemberDrag` の呼び出し箇所を書き換え。
3. typecheck 確認。

### 検証方法

`npm run typecheck`。挙動変更なし。

### リスク

なし。純粋な統合。

## P3 updatePartDrag / updateMemberDrag の重複 — 見送り

### 検証結果: 重複は事実だが、修正対象から外す

`assembly-drag-controller.ts:199-226`(`updatePartDrag`)と `230-241`
(`updateMemberDrag`)を比較すると、骨格(「mount を解決 → 無ければ far 姿勢を組んで
return → editor 関数を呼ぶ → 結果から `pose` と保持用の値を組む」)は同型だが、
**「保持用の値」の型がそれぞれ `SnapCandidate`(`DockWorkbenchController.updateCandidate`
経由で書く)と `PendingMemberEdit`(このクラス自身のフィールドに直接持つ)で全く異なり、
呼び出し先の副作用も違う**(`updatePartDrag` は `this.workbench!.updateCandidate(candidate)`
という外部への通知、`updateMemberDrag` は `this.pendingMemberEdit = ...` という内部代入)。

共通化できるのは「mount 解決 → 無ければ far 姿勢を組んで return」という前置き部分
(6〜7行程度)だけで、本体(placement 組み立て・validateBlueprint オプション・
candidate/pendingEdit の構築)は型が違うため共通化できない。

**当初この前置き部分だけを `private` ヘルパーとして括り出す案を検討したが、
`this.pose`(状態)を書き換えつつ「mount が見つかったか」を戻り値としても返す
——という形にせざるを得ず、これは CLAUDE.md の TypeScript 規則が明示的に禁じる
アンチパターン(「状態を変更しつつ派生値も返す関数」、`camera/` 節に明記)に該当する。**
状態変更(`this.pose` への書き込み)と値の算出(mount が見つかったかどうかの判定)を
分離した形で括り出そうとすると、結局「mount を解決するだけの関数」(既に P2 で
`resolveMountCandidate` として括り出し済み)と「見つからなかった場合に far 姿勢を
組んで `this.pose` へ書く」という1〜2行の代入が呼び出し側にそれぞれ残るだけになり、
実質的に何も減らない。

**したがって P3 は「重複はあるが、規約(状態変更と値の算出を混ぜない)を守ったまま
括り出せる部分が実質ない」と結論し、修正対象から外す。** P2(`resolveMountCandidate`
への統合)だけを実施し、`updatePartDrag`/`updateMemberDrag` 本体はそれぞれ独立した
実装のまま残す——これは CLAUDE.md の「似た形の実装があっても、個別に調整される要素
なのでまとめない」という重複容認の基準にも合致する(部品と部材は今後も異なる仕様
——U2で扱う建造コストの有無など——で分岐しうる別々の対象であり、無理な共通化は
将来の分岐を1つの関数に押し込める結果になりかねない)。

### 影響

軽微。将来「部品でも部材でも同じ 3D 演出を足す」(例: 吸着時のハイライト強化)といった
変更のとき、2箇所に同じ変更を書く必要がある——ただしこれは P2 で共通化した
`resolveMountCandidate` の変更だけで大半は賄えるため、実質的な重複コストは小さい。

### 修正案

修正なし(見送り)。P2 の統合(`resolveMountCandidate`)のみ実施する。

### 変更ファイルと手順

なし。

### 検証方法

該当なし。

### リスク

なし(変更しないため)。

## P4 PartInventory.fuelOf / maxFuelOf / propellantSummary の重複 — 対象外

### 検証結果: 事実としては重複が存在するが、本計画の担当範囲外のため扱わない

`part-inventory.ts:229-233`(`fuelOf`)・`236-242`(`maxFuelOf`)・`246-261`
(`propellantSummary`)はいずれも `this.propellantTankRefs` を回して `p.hp > 0 &&
p.propellant === propellant`(または無条件)の条件でタンクを集計する、ほぼ同型のループを
持つ——重複自体は事実。しかし `PartInventory` は艦の推進剤会計を担うクラスで、
**組み立てウィンドウ(組立セッション・基地操作ウィンドウ・ドラッグ)の構成要素ではない**。
本計画の対象範囲は「前提 / 対象範囲」節に明記したとおり組み立てウィンドウ周辺に限られ、
`part-inventory.ts` はそこに含まれていない。

参考までに呼び出し箇所を確認したところ(`grep -rn "fuelOf\|maxFuelOf\|propellantSummary"`)、
`fuelOf` は `Vessel.restoreBase`(セーブ復元時、1回限り)からのみ、`maxFuelOf` は
`Vessel` の転送メソッド以外どこからも呼ばれておらず、`propellantSummary` は
`hud/vessel-panel.ts`(HUD 同期、既存の間引き済み `sync` サイクルの中)から1箇所のみ
呼ばれている——いずれも高頻度呼び出しではないため、統合しても性能上の懸念はない。
ただしこれは組み立てウィンドウの担当範囲外であるため、**本計画では修正を提案せず、
別の担当・別の計画へ委ねる**(担当を割り振るなら「艦の推進剤・燃料まわり」の
リファクタリング計画が適切)。

## U1 元に戻す/やり直すボタンに履歴表示がない

### 検証結果: 正しい

`assembly-panel.ts:244-245`:
```ts
this.undoBtn = new Button('元に戻す', () => this.onUndo?.());
this.redoBtn = new Button('やり直す', () => this.onRedo?.());
```
ラベルは固定文字列で、`WorkbenchCommand.label`(`dock-workbench.ts:56` で定義される
インターフェースのフィールド)への参照は無い。`undoBtn?.setEnabled(session.canUndo)`
(323行目)で有効/無効の切り替えはしているが、「何を戻すか」はボタンからは分からない。

`dock-workbench.ts` の `undoHistory`(136行目)/`redoHistory`(140行目)getter は
存在するが、`grep` で確認したところ `AssemblyPanel` を含めどこからも呼ばれていない
(D4として別担当が「未使用」を指摘している対象と一致)。

### 影響

利用者が「取消」の効果を予測できない。特にUndo履歴が複数積み上がった状態
(部品を数個取り付けた後など)では、1回のクリックで何が戻るか分からないまま
連打することになり、意図しない操作の取り消しにつながりうる。

### 修正案

2案を併記する(価値判断を伴うため、質問事項へ)。

**案A: `title` 属性でツールチップとして表示する**
```ts
this.undoBtn.element.title = session.undoHistory[session.undoHistory.length - 1]?.label ?? '';
```
最小の変更(ボタンのラベル自体は変えず、ホバー時のツールチップだけ追加)。
`Button`(`widgets/button.ts`)は `readonly element: HTMLElement` に加えて
`setLabel(label: string): void` を持つ(確認済み)ので、
`setLabel('元に戻す (部品を取り付ける)')` のようにボタン文言自体へ埋め込む案もある
——こちらは常時見えるが、長いラベルだとボタン幅が不安定になる。

**案B: `undoHistory`/`redoHistory` を使わず、ラベル表示機能自体を削除する**
D4(別担当)が `undoHistory`/`redoHistory` を「未使用コード」として削除候補に挙げている
前提に立つなら、そもそもこの機能を追加する価値がないという判断もありうる——UNDOの
効果はボタンを押した直後にゴースト/実際の構成が視覚的に変化することで分かる、という
考え方(このゲームは「見て分かる」ことを重視する設計が随所にある)。

### 変更ファイルと手順

案Aを採用する場合: `assembly-panel.ts` の `sync` 内、`undoBtn?.setEnabled(...)` の
直後に `undoBtn.element.title = ...` を追加。`WorkbenchCommand.label` は既に
`WorkbenchTarget.id` 単位ではなくセッション全体に対して積まれる(`past`/`future` が
`DockWorkbenchSession` の private フィールド)ため、対象タブを跨いだ操作も含めて
1本の履歴として表示されることになる——これは仕様として妥当(セッション全体が1つの
Undo/Redo系列)。

### 検証方法

`npm run typecheck` + 手動確認(`/verify` または実プレイで部品を取り付けて
ボタンのツールチップを確認)。

### リスク

- D4(未使用コードの削除)と競合する。**D4 の担当が `undoHistory`/`redoHistory` の
  削除を先に実施すると、この U1 修正の前提が失われる**——実施順序の調整が必要
  (「実施順序の提案」参照)。

## U2 構造部材が無限・無コストで生成できる

### 検証結果: 正しい。ただし仕様文書には既に方針が記述されている

`memos/mikanixonable/dev.md` の757行目付近(引用箇所):

> **構造材(外皮・トラス・分離機構)を取り付ける**: 部材棚で種別(外皮/トラス/分離機構)・
> 長さ(0.5 m刻み)・断面の外接半径(分離機構なら分離時撃力も)を選んで「部材を掴む」を
> 押すと、その場でゴーストが現れる。(中略)離す(もう一度クリック)と、その位置に
> 本当にノードとエッジが生える。

この記述には資源消費への言及が一切なく、`member.ts`/`assembly-drag-controller.ts`の
コメント(1-8行目)も「部材(構造材)は空きポートへだけ吸い寄せられ…確定は
workbench.applyAssemblyEdit を直に呼ぶ」とだけ書いており、コストの概念に触れていない。
一方で `vessel/production.ts` の説明(CLAUDE.md 該当節)は「殻の材料を推進剤が決める
3種のタンクだけが `tanks` の枠へも入り、`structure` は `mass-properties.ts` の
`structuralMasses` が返す外皮/トラス/分離機構の質量を `hull-panel`/`truss-member` へ
割り振る」と明記しており、**「構造部材にも建造コストの概念自体は既に定義されている」**
(通常の部品と同じ生産経路が想定されている)。つまり——

- **仕様上、構造部材は本来コストを持つべきものとして設計されている**
  (`production.ts` の `structure` 資源枠がまさにそれ)。
- **しかし組立ウィンドウの部材棚(`assembly-panel.ts` の `buildMemberShelf`)は、
  その資源枠を一切参照せず、入力欄の値からその場で `MemberSpec` を作って
  無条件に掴める**——`member.ts`/`assembly-drag-controller.ts` にも
  `producibility`/`ResourceLedger` への参照は一切ない。

これは「仕様に反する実装漏れ」であり、「まだ実装されていない機能」である可能性が高い
(部材システム自体が比較的新しく、通常パーツの生産・在庫システムに追随できていない)。

### 影響

- ゲームバランス上、通常パーツ(在庫が有限・生産に資源が要る)と構造部材(無制限)の
  非対称性がプレイヤーに露呈する——巨大な構造物を無コストで組み立てられてしまう。
- 設計判断として「構造部材にもコストを課すべきか」は本計画の担当範囲外の価値判断。

### 修正案(質問事項へ)

2案を併記する。

**案A: 部材にも生産コストを課す**
`production.ts` の `structuralMasses`/`structure` 資源枠を使い、部材を確定する瞬間
(`AssemblyDragController.drop`→`applyPendingMemberEdit`→`workbench.applyAssemblyEdit`)
に基地の在庫から資源を消費する。`buildDraft` の建造費計算と同様の経路
(`producibility`→`consumeProductionResources`)を、部材1本の追加についても通す。
ただし部材は在庫に「実体」を持たない(掴む瞬間にその場で仕様を組む)設計のため、
「掴む前に資源が足りるか判定する」UIをどこに置くか(部材棚のボタン自体を
`disabled` にする、掴んでから吸着に失敗したら資源不足を通知する、等)は追加設計が要る。

**案B: 現状維持(部材は意図的に無コストの"設計補助"として扱う)**
組立ウィンドウ自体が「構成の編集」を主目的とし、実際の資源消費は基地操作ウィンドウの
生産タブ・建造ボタン(`buildDraft`)でのみ発生する、という設計判断もありうる——
部材は「艦体の骨格」であり通常パーツ(エンジン・タンク等)と違って個体の在庫を
持たない特殊な扱い(本文コメントにも「在庫に実体を持たない」と明記されている)なので、
意図的にコストレスにしてある可能性もゼロではない。

**この判断はゲームデザイン上の価値判断であり、本計画の担当範囲では決められない。
質問事項Q2として扱う。**

### 変更ファイルと手順

質問への回答待ち。案Aが採用された場合の変更ファイルは `member.ts`(建造コスト計算の
追加)、`assembly-drag-controller.ts`(`applyPendingMemberEdit` での資源消費)、
`assembly-panel.ts`(部材棚ボタンの有効/無効化、コスト表示)。

### 検証方法

方針確定後に決定。

### リスク

- ゲームバランスに直結する変更のため、価値判断を誤ると既存プレイの体験を大きく変える。

## U3 部材のドロップ失敗が無言で消える

### 検証結果: 正しい

`assembly-drag-controller.ts:301-319`(`release`)を確認:
```ts
public release(targetId: string): void {
  ...
  if (this.held.kind === 'member') {
    if (this.pendingMemberEdit?.result.accepted) this.drop(targetId);
    else this.cancelDrag();          // ← ここで無言で消える
    return;
  }
  const drag = workbench.dragging;
  if (drag?.candidate?.verdict.accepted) { this.drop(targetId); return; }
  if (drag && drag.source.kind === 'target') {
    workbench.remove(drag.source.targetId, drag.part.id);   // ← 部品は倉庫へ戻す
  }
  this.cancelDrag();
}
```
部品(`kind !== 'member'`)は、機体から掴み上げていた場合 `workbench.remove` で
倉庫へ戻される(313-317行)——「掴んでいたものが消える」ことはない。一方、部材は
`cancelDrag()` を呼ぶだけで、`AssemblyPanel.beginMemberDrag`(676-684行)が入力欄の
値から「その場で」組んだ `MemberSpec` を単に捨てる。呼び出し元のコメント自体
(138-139行目)が「部材(構造材)は…移動元や在庫還元の概念を持たない――離した先が
見つからなければ何も生えず、部材はただ捨てられる」と**意図的な設計として明記している**。

つまり、コメント上は「意図された挙動」だが、**利用者への通知(トースト等)が無い**点は
先行調査の指摘どおり実際に欠けている——部品が在庫へ戻るときも実は明示的な通知は無い
(単に倉庫リストに再度現れるだけ)が、部材は在庫という「戻り先」自体が存在しないため、
「何も起きなかった」という結果と「取り付けに失敗した」という結果が利用者から見て
区別できない。

### 影響

利用者が部材棚の入力欄で長さ・断面を苦労して設定し「部材を掴む」→ 取り付け位置を
外して離す、という操作をした際、何のフィードバックもなく手元の部材が消える。
特に「掴んだ状態のまま `Esc` や対象タブ切替で意図せずキャンセルされる」経路
(`onTargetSelect` 320-327行、`endAssembly` 396-407行)でも同様に無言で消える。

### 修正案

`release`(および対象タブ切替・セッション終了時の `cancelDrag`)で、部材を保持していて
かつ取り付けに失敗した場合にのみ `Hud.hint(...)` を1回出す。既存の `Docking`/
`AssemblySessionController` が `hud: Hud` を持っているので、通知の呼び出し元は
`AssemblyDragController` 自身ではなく、`AssemblyDragController` に `Hud` 参照を
持たせるか(コンストラクタ引数を増やす)、`Docking`/`AssemblySessionController` 側で
`release`/`cancelDrag` を呼ぶ前後に判定して通知する形にする。

**`AssemblyDragController` に `Hud` を持たせるべきか**は再考の余地がある——現状
`AssemblyDragController` は THREE 描画専用のクラスであり、HUD への直接参照を持たせると
責務が広がる。**呼び出し元(`AssemblySessionController.handleAssemblyClick` 相当)側で
`dragController.dragging` かつ `kind === 'member'` かを判定してから `release` を呼び、
結果に応じて `hud.hint(...)` を呼ぶ**方が、`AssemblyDragController` を THREE専用に保てる。
ただし `held`/`pendingMemberEdit` は `AssemblyDragController` の private フィールドで
外から読めないため、`release` の戻り値を `boolean`(成功したか)に変える必要がある。

```ts
// release の戻り値を追加: 部材を捨てた(=取り付けに失敗した)かどうか
public release(targetId: string): { readonly discardedMember: boolean } { ... }
```

呼び出し元(`AssemblySessionController.handleAssemblyClick`)で
`if (result.discardedMember) this.hud.hint('部材の取り付け位置が見つかりませんでした');`
とする。

### 変更ファイルと手順

1. `assembly-drag-controller.ts` の `release` の戻り値型を変更。
2. `AssemblySessionController`(R1移設後)または `Docking.handleAssemblyClick`
   (R1未実施の場合)で戻り値を見て `hud.hint` を呼ぶ。
3. typecheck 確認。

### 検証方法

`npm run typecheck` + 手動確認(部材を掴んで機体から外れた位置で離し、ヒントが
出ることを確認)。

### リスク

- 軽微。既存の `hud.hint` の使用パターン(`reportEditFailure` 等)に沿った変更。

## U4 検索欄がライブフィルタでない

### 検証結果: 正しいが、「ライブフィルタにすべきか」はウィジェット規約との整合を要確認

`ValueInput`(`hud/widgets/value-input.ts`)の設計はコメント1行目から明確:
「Enter=確定・blur=確定・Escape=破棄が唯一の規約で、打鍵ごとの clamp や通知は行わない
(編集途中の値を黙って書き換えないため)」。`DEVELOP/DESIGN-RULES.md` を確認する前に
CLAUDE.md 側で既に「ValueInput の確定でしか model は動かない」という前提が
`assembly-panel.ts` 自身のコメント(400-402行)にも明記されている。

**これは意図的な設計であり、"打鍵ごとに絞り込まれない" は `ValueInput` というウィジェット
自体の規約から来る、単なる実装漏れではない**。`/refactor-fixed` ルール12の
「入力欄は必ず `keydown` の伝播を止める」節・CLAUDE.md 全体の「打ちかけの数値が
一瞬でも設定値として使われないようにする」という思想と一致する。

ただし、検索(フィルタ)は「設定値」ではなく「表示の絞り込み」であり、他の `ValueInput`
利用箇所(数値入力・断面編集)とは性質が異なる——**間違った数値が一瞬でも `Part` の
構成へ反映される心配がない**(フィルタは既存の部品ボタンを隠すだけで、`AssemblyEditResult`
を生まない)。この点で「確定時のみ反映」という規約を検索欄にまで一律適用する必然性は
薄い。

### 影響

- 部品棚が長い(倉庫の部品種別が多い)ときに検索性が低い——入力→Enter/blurという
  ワンテンポが要る。
- 現状 `filterInput` は `escapeBehavior: 'clear'` を渡しており(286行目)、これは
  「検索欄に限り Escape で空にする」という `ValueInput` 自体が用意した例外
  (`EscapeBehavior` 型のコメント7-10行目「渡してよいのは検索フィールドに限る」)を
  正しく使っている——検索欄は既に一定程度「特別扱い」されている。

### 修正案

`ValueInput` 自体を変更せず(規約を壊さない)、`assembly-panel.ts` 側で
**検索欄だけ生の `<input>` の `input` イベントを追加購読**する案と、**`ValueInput` に
新しいオプション `liveCommit?: boolean` を追加する**案の2つがある。

**案A(ValueInput は変更しない)**: `filterInput.element` に対して
`assembly-panel.ts` 側で直接 `input` イベントリスナを追加し、`applyFilter` を
呼ぶ(Enter/blur の確定は既存のまま残す・二重発火はしない——`applyFilter` は
何度呼ばれても副作用が「表示のhidden切替」だけなので冪等)。
```ts
this.filterInput.element.addEventListener('input', () => this.applyFilter(this.filterInput!.element.value));
```
これは `ValueInput` の外側からイベントを足すだけなので、`ValueInput` 自体の規約
(「打鍵ごとの clamp や通知は行わない」)には触れない——`ValueInput` はあくまで
「確定した値」の管理者であり続け、`assembly-panel.ts` が別途「表示の絞り込み」という
別の目的でDOM要素を直接見ているだけ、という整理になる。ただし**`hud/widgets/` の
「押せる/切り替えられる/入力できる DOM は10種のウィジェットに限り自作しない」という
規約(`/refactor-fixed` 12節)には、"ウィジェットの内部 DOM 要素に対して追加の
イベントリスナを外から張る" ことへの言及が無い**——グレーゾーンであり、
`ui-design` スキルでの追加確認、または質問事項として扱うのが安全。

**案B(ValueInput に `liveCommit` オプションを追加)**: `ValueInputOptions` に
`liveCommit?: boolean`(既定 `false`)を追加し、`true` のときは `input` イベントでも
`commit()` 相当を呼ぶ(ただし「非数値は破棄」等の数値バリデーションは検索欄では
無関係なので、`liveCommit` は `type: 'search'` の場合のみ許可する、といった制約を
型で表現する)。これは `ValueInput` という共有ウィジェットの規約を1つ増やすことになり、
影響範囲が `assembly-panel.ts` 一箇所に留まらない可能性がある(将来の呼び出し元が
安易に `liveCommit: true` を使い、数値欄でも打鍵ごと反映が広がる懸念)。

**推奨は案A**——`ValueInput` 自体の規約(確定時のみ反映)は「設定値の誤反映防止」という
明確な理由があるため変えず、検索という性質の異なる用途だけ呼び出し側で対応する。
ただしこれも UI 規約への解釈が絡むため、質問事項Q3として明記する。

### 変更ファイルと手順

1. (案A採用の場合)`assembly-panel.ts` の検索欄構築箇所(283-291行)に `input`
   イベントリスナを追加。
2. typecheck 確認。

### 検証方法

`npm run typecheck` + 手動確認(検索欄に文字を打つたびに部品棚が絞り込まれることを確認)。

### リスク

- `ValueInput` の外側からイベントを直接張る行為が、将来「`ValueInput` は確定時のみ」
  という前提で書かれた他のコードとの一貫性を崩す可能性がある(ui-design スキルでの
  最終確認を推奨)。

## U5 「選択を削除」ボタンが、拒否されるとわかっている操作を平然と提示する

### 検証結果: 先行調査の前提は誤り。事実は逆(実装済みコードの確認による確定事実)

`assembly-panel.ts:267`(`this.removeSelectionBtn = new Button('選択を削除', () =>
this.removeSelection())`)は固定文言。`removeSelection`(538-546行)は
`selection.kind === 'node' ? workbench.removeNode(...) : workbench.removeEdge(...)`
と分岐するが、ボタン自体のラベル・有効/無効は分岐しない。

`src/game/vessel/assembly-editor.ts` を実際に読んだところ、**先行調査・当初案の
「ノード削除は連鎖して多くを失う」という前提は誤りで、事実は逆**——`removeNode`
(212-238行)は連鎖削除を一切行わず、そのノードに繋がるエッジが1本でもあれば
即座に拒否する:

```ts
// removeNode(212行〜)
const edgeIds = assembly.tree.edges.filter((edge) => edge.a === nodeId || edge.b === nodeId).map((edge) => edge.id);
if (edgeIds.length > 0) {
  return rejected(assembly, editError('reference-in-use', nodeId,
    `ノード "${nodeId}" はエッジ ${edgeIds.join(', ')} から参照されています。先にエッジを削除してください`));
}
const placementIds = externalPlacementsAtNode(assembly, nodeId);
if (placementIds.length > 0) {
  return rejected(assembly, editError('reference-in-use', nodeId,
    `ノード "${nodeId}" は部品 ${placementIds.join(', ')} の取付口から参照されています`));
}
```

`removeEdge`(295-315行)も同型で、そのエッジ上に部品が取り付けられていれば拒否する
(部品を先に外すよう促す)。**つまりノード削除もエッジ削除も、どちらも「まだ何かに
参照されていれば無条件で拒否」という同じ性質のガードを持っており、連鎖削除は
どちらにも存在しない。**

事実がこうである以上、実際の UX 問題は当初想定していた「影響範囲が予測できず
取り返しがつかない」ではなく、**「孤立したノード/エッジ(何にも繋がっていないもの)
以外を選んで『選択を削除』を押すと、ほぼ確実に拒否される」**という別の問題である。
プレイヤーはボタンを押して初めて「先にエッジを削除してください」と言われる——
これは本プロジェクトの UI 原則(`MapContextActions` の各所で徹底されている
「押せてから拒否されることのないよう、提示自体を判定に対応させる」考え方
——例えば `navTargetItems` は解決可能な id にしか項目を出さない)に反する。

### 影響

- 「選択を削除」ボタンは、参照が残っているノード/エッジに対しては常に失敗し、
  `editStatusEl` にエラー文言(「先にエッジを削除してください」等)が出るだけで
  終わる——プレイヤーから見ると「押しても何も起きない(ように見える)ボタン」に
  なりがちで、実際に削除できる状態(孤立ノード/未装着エッジ)を毎回自分で見極める
  負担が生まれる。
- U1(Undo履歴のラベル表示)とは無関係な問題——削除操作自体が実行されず
  `AssemblyEditResult` が `rejected` を返すだけなので、Undo履歴には積まれない。

### 修正案

**確認ダイアログの追加は前提が消えたため案から除外する。** 代わりに以下を検討する。

- **案A(推奨)**: `syncSelection` で「このノード/エッジは今削除できるか」を毎フレーム
  判定し、削除できないなら `removeSelectionBtn.setEnabled(false)` にした上で、
  拒否理由(「エッジ ¤¤¤ から参照されています」等)をボタン脇に表示する。判定は
  `removeNode`/`removeEdge` を実際に `validateBlueprint: false` で試して
  `AssemblyEditResult.accepted`/`errors` を読む形(`DockWorkbenchController` は
  既に同じ2関数を実行用に呼んでいるので、判定専用に呼ぶだけなら副作用は無い——
  `AssemblyEditResult` を作るだけで実際にセッションへ適用するのは
  `applyAssemblyEdit` を呼んだときだけ)。これにより「押せてから拒否される」ボタンが
  「そもそも押せない」ボタンに変わり、`MapContextActions` 等が既に徹底している
  「提示して却下される項目を出さない」という原則に組立ウィンドウも合流する。
- **案B**: ボタン文言をノード/エッジで出し分ける(`removeSelectionBtn.setLabel(
  selection.kind === 'node' ? 'ノードを削除' : 'エッジを削除')`)。これは
  「連鎖削除が起きるかどうか」という誤った前提とは無関係に、単に「今何を選んでいるか」
  を文言に反映するだけの改善であり、事実確認の結果に関わらず妥当なので**案Aと
  合わせて実施してよい**。
- **案C(仕様変更、質問事項へ)**: ノード削除を連鎖削除に変える(繋がるエッジ・
  取り付け済み部品も一括で消す)。これは現在の「参照が残っていれば拒否」という
  設計を覆す仕様変更であり、ゲームデザイン・誤操作リスクの両面で価値判断を要する
  ため、本計画では採用しない(質問事項Q4として残す)。

### 変更ファイルと手順

1. `assembly-panel.ts` に、選択中のノード/エッジが今削除可能かを判定するヘルパー
   (`removeNode`/`removeEdge` を `validateBlueprint: false` で試し、
   `accepted`/`errors[0]` を返す)を追加する。
2. `syncSelection`(354-363行)で、この判定結果に応じて
   `removeSelectionBtn.setEnabled(...)` と拒否理由の表示を追加し、ラベルを
   `selection.kind` で出し分ける(案B)。
3. `removeSelection`(538-546行)自体は変更不要——ボタンが無効化されていれば
   そもそも呼ばれない。
4. typecheck 確認。

### 検証方法

`npm run typecheck` + 手動確認。

### リスク

- ボタンの有効/無効判定を `syncSelection` の中で毎フレーム `removeNode`/`removeEdge`
  を試すことになるため、他の `sync` 呼び出しと同様に「呼び出し自体は副作用が無い
  (`AssemblyEditResult` を作るだけ)」ことを typecheck だけでなく実装時にコードで
  再確認すること——万一 `removeNode`/`removeEdge` が `commit` を経由して
  セッションの状態を書き換える経路が将来追加された場合、この毎フレーム呼び出しが
  そのまま副作用の温床になる。

## 質問事項

1. **U1(Undo/Redoラベル表示)**: `WorkbenchCommand.label` を実際にボタンへ繋ぐか
   (案A)、それとも別担当のD4計画に合わせて `undoHistory`/`redoHistory` ごと
   「使われていない」まま削除するか(案B)。D4の担当者との調整が必要。
2. **U2(構造部材のコスト)**: 部材にも通常パーツと同じ生産コスト(`producibility`/
   `ResourceLedger` 消費)を課すべきか(案A)、それとも意図的にコストレスの設計補助
   として現状維持するか(案B)。`vessel/production.ts` の `structure` 資源枠が
   既に定義されている以上、仕様としては「いずれ課金する」想定に見えるが、
   実装の優先度・タイミングはゲームデザイン判断。
3. **U4(検索欄のライブフィルタ)**: `ValueInput` の外側から `input` イベントを
   直接購読する案(案A)が `DEVELOP/DESIGN-RULES.md`/ウィジェット規約上許容されるか。
   許容されない場合、`ValueInput` 自体に `liveCommit` オプションを追加する案Bを
   取るか、または現状維持(確定時のみ絞り込み)を受け入れるか。
4. **U5(ノード削除の連鎖化・案C)**: 「参照が残っていれば拒否する」という現在の設計
   (ノード削除もエッジ削除も連鎖しない)を変え、ノード削除を連鎖削除(繋がるエッジ・
   取り付け済み部品も一括で消す)に変更すべきか。本計画は案A(削除不可能な選択は
   ボタンを無効化する)+案B(文言分岐)を推奨し、案Cの採用は見送っているが、
   ゲームデザイン上「連鎖削除の方が組み立て作業として自然」という判断もありうるため
   質問事項として残す。

## 実施順序の提案

1. **P2 を実施**(P3 は見送りのため対象外)。`resolveMountCandidate` への統合を
   R1 の移設より先に済ませておく方が、移設対象のコード量が減って見通しがよい。
2. **P1 と R1のステップ6を同時に実施**(⑥生産の切り出し先が `productionCostSummary`
   を呼ぶ形になるよう、両方を1つの変更セットにまとめる)。
3. **R1(Docking の分割)をステップ1〜8の順で実施**——他のどの項目よりも影響範囲が
   広いため、最初に構造を安定させてから R2・U系の変更を積む方が衝突が少ない。
4. **R2(BaseOperationsWindow)は R1・P1 と独立して並行可能**——`base-operations-window.ts`
   は `Docking` の内部構造変更の影響を受けない(`Docking` からは `new
   BaseOperationsWindow(...)` で参照されるだけ)。ただし P1 の `productionCostSummary`
   を R2 の `base-inventory-ops.ts` からも呼ぶため、**P1 の完了を待ってから着手**するのが
   望ましい。
5. **U3(部材ドロップ失敗の通知)は R1 完了後に実施**——`release` の戻り値を見て
   `hud.hint` を呼ぶ場所が `AssemblySessionController.handleAssemblyClick` になるため、
   R1 のクラス移設が先に済んでいる方が変更箇所が明確になる。
6. **U5(ボタンの無効化・文言分岐)は独立して着手可能**——事実確認は本計画で完了して
   いるため、他項目の完了を待たずに着手できる。案C(連鎖削除への仕様変更)を
   採用する場合のみ質問事項Q4の回答待ち。
7. **U1(ラベル表示)は質問事項Q1の回答待ち**、他の変更と独立に着手可能。
8. **U2(構造部材のコスト)は質問事項Q2の回答待ちで、着手を最後に回す**——ゲーム
   バランスに直結する変更であり、他の項目の完了を待って落ち着いて設計すべき。
9. **U4(検索欄ライブフィルタ)は質問事項Q3の回答待ち**、他の変更と独立して
   いつでも着手可能(規約さえ確認できれば1ファイルの小変更)。

### 他計画書 (1) との衝突

- **B1〜B5(`docking.ts` のバグ)**: 本計画の R1(Docking の分割)は `docking.ts` の
  ほぼ全メソッドを移動する大規模変更のため、**バグ修正 (B1〜B5) は R1 の分割より
  "前"に完了させておくことを強く推奨する**——分割後にバグ修正を行うと、修正対象の
  メソッドがどちらのファイル(`docking.ts` か `assembly-session-controller.ts` か)に
  移動したかを都度確認する手間が生じ、コンフリクトのリスクも高い。逆に、R1 を先に
  終えてしまうと、バグ修正パッチが移設前の行番号を前提に書かれていた場合に当たらなく
  なる。**推奨順序: B1〜B5(バグ修正)を先に完了 → 本計画の R1 に着手。**
- **D1〜D6(未使用コード)**: `undoHistory`/`redoHistory`(D4想定)は U1 と直接衝突する
  (質問事項1で調整済み)。それ以外の D1〜D6 が `docking.ts`/`assembly-drag-controller.ts`/
  `base-operations-window.ts` 内の未使用コードを削除するものであれば、R1〜R3・P1〜P4 の
  変更対象と重なる可能性が高い。**D計画の対象リストを確認し、本計画の変更対象ファイルと
  重複する項目があれば、D計画を先に完了させてから本計画に着手する**のが安全
  (未使用コードを先に削ってから責務分割する方が、分割時に運ぶコード量が減る)。
