# マップモードの積分軌道表示に関する問題調査と修正案

本ドキュメントは、マップモードの軌道表示を楕円近似から積分表示に切り替えたことに伴い発生した、3つの描画問題についての原因と具体的な修正案をまとめたものです。
対象となるコードの文脈・ファイルパスを明確に示し、このファイル単体で修正作業が行えるように記述しています。

---

## 問題1: 時間加速時（ワープ時）に積分軌道の表示が崩れる

### 発生している現象
マップモードにおいて、シミュレーションの時間加速（ワープ）を行うと、自機の積分軌道（過去履歴と未来予測を繋いだ線）の描画がねじれたり、交差したりするなど、表示が破綻する。

### 原因
時間加速時（`simSpeed > MAX_PHYS_SIM_SPEED`）は、パフォーマンス維持のため `src/game/dynamic/predictor.ts` の `Predictor.update` 内で未来予測の更新処理が意図的にスキップされます（`suspended = true`）。
しかし、シミュレーション本体は進行し続けるため、自機の「過去履歴（`DynamicEntity.current.samplesOldestFirst()`）」には最新の位置データが追加されていきます。その結果、「最新の過去」と「更新が止まった古い未来」の間に時間的・空間的な矛盾（時刻の逆転など）が生じます。
軌道描画を担当する `src/game/debug-history-line.ts` では、この2つの配列を無条件に `[...current, ...predicted]` の形で連結して1本の線として描画しているため、破綻したデータ列がそのまま描画されて表示が崩れます。

### 修正案
`src/game/debug-history-line.ts` の `sync` メソッド内において、過去履歴と未来予測を連結する前に、未来予測が陳腐化していないか（時刻の逆転が起きていないか）を判定するロジックを追加します。

**具体的な修正手順:**
`src/game/debug-history-line.ts` の `sync` メソッド（40行目付近）の以下のコード：
```typescript
const samples = [...entity.current.samplesOldestFirst(), ...(entity.predicted?.samplesOldestFirst() ?? [])];
```
これを、未来予測の先頭時刻と過去履歴の末尾時刻を比較し、未来予測が古くなっている場合は未来予測を描画から除外するように修正します。
```typescript
const currentSamples = entity.current.samplesOldestFirst();
let predictedSamples = entity.predicted?.samplesOldestFirst() ?? [];

// 未来予測の先頭が、現在の履歴の末尾よりも古い（または同等）場合は、予測が陳腐化しているとみなして結合しない
if (currentSamples.length > 0 && predictedSamples.length > 0) {
  const lastCurrentTime = currentSamples[currentSamples.length - 1].t;
  const firstPredictedTime = predictedSamples[0].t;
  if (firstPredictedTime <= lastCurrentTime) {
    predictedSamples = []; // 破綻を防ぐため未来予測を破棄
  }
}
const samples = [...currentSamples, ...predictedSamples];
```

---

## 問題2: 月回転フレームで軌道が逆向きに公転し、閉じた軌道にならない

### 発生している現象
月を周回する宇宙船に対し、マップ画面の「MAP VIEW」パネルでカメラ視点を「月回転系」に設定しても、積分軌道が月の周りに閉じた楕円にならず、地球中心のスパイラル状の軌道として表示される。さらに、月回転系のカメラから見ているため、軌道全体が月公転と逆向きに高速で公転しているように見える。

### 原因
「カメラの視点座標系」と「軌道描画の座標系」が連動していません。
`src/game/game.ts` の `updateMapPresentation` 内で `DebugHistoryLine.sync` を呼び出す際、描画座標系としてマニューバ計画用の `this.editor.planDisplay.trajectoryFrame`（初期値: `'inertial'` = 地球慣性系）を渡しています。
一方、マップカメラの視点は `src/game/camera/overview-camera-panel.ts` のUI操作によって変更されており、カメラは月回転系（`moonRotating`）になっていても、軌道自体は地球慣性系のまま描画されてしまっています。

### 修正案
軌道描画（`DebugHistoryLine.sync`）へ渡す座標系を、マニューバ計画用の独立した設定ではなく、現在のマップカメラの視点フレームと同期させます。

**具体的な修正手順:**
1. **カメラフレームの取得**: `src/game/camera/overview-camera.ts` または `camera-system.ts` から、現在選択されている表示フレーム（`Frame` 型の `'inertial'` や `'moonRotating'` など）を取得できる getter（例: `this.cameraSystem.overviewCamera.frame`）を用意します。（現状、視点フレームは内部に保持されているか確認し、外部から取得可能にします）
2. **渡し値の変更**: `src/game/game.ts` の `updateMapPresentation` の末尾付近（518行目付近）にある `DebugHistoryLine.sync` の呼び出しを以下のように修正します。

【修正前】
```typescript
this.debugHistoryLine.sync(debugTargets, this.editor.planDisplay.trajectoryFrame, simTime, this.ephemeris, this.floatingOrigin);
```
【修正後】
```typescript
// overviewCamera が現在使用している frame を取得して渡す
const currentMapFrame = this.cameraSystem.overviewCamera.frame || 'inertial'; 
this.debugHistoryLine.sync(debugTargets, currentMapFrame, simTime, this.ephemeris, this.floatingOrigin);
```
※ `OverviewCamera` クラスに `frame` プロパティが public 公開されていない場合は、public アクセサを追加してください。

---

## 問題3: 関係ないオレンジ色の計画軌道が常に描画されてしまう

### 発生している現象
マニューバノードを作成していない（計画が空の）状態であっても、マップモード（[M]キー）を開くと、自機の現在の軌道に沿ってオレンジ色の計画軌道（`PlanTrajectory`）が描画されてしまう。これにより、本来のシアン色の積分表示と二重に表示されてしまう。

### 原因
マップモードへの切り替えを行う `src/game/map-mode-toggler.ts` において、マップ展開時に `this.editor.setMapMode(open)` が呼ばれます。
これを受けた `src/game/plan/plan-editor.ts` は、マップが開いている間は常に `this.editMode = true` となります。
`PlanEditor` の `update` および `sync` メソッドでは、`editMode` が true の場合、計画ノードの有無にかかわらず `PlanDisplay` に対して描画指示（`show = true`）を出してしまいます。結果として、空の計画（＝現在の自機軌道のコピー）がオレンジ色の計画軌道として描画され続けます。

### 修正案
`src/game/plan/plan-editor.ts` において、`editMode` が true であっても、マニューバノードが1つも存在しない（計画が空の）場合は、オレンジ色の計画軌道を描画しないようにロジックを変更します。

**具体的な修正手順:**
`src/game/plan/plan-editor.ts` の `update` メソッドと `sync` メソッドの表示判定条件を変更します。

【修正前】(517行目, 522行目付近)
```typescript
  update(simTime: number, displayTime: number): void {
    this.simTime = simTime;
    this.planDisplay.update(this.plan, simTime, displayTime, this.editMode || this.plan.nodes.length > 0);
  }

  sync(mapDist: number, simTime: number, fo: FloatingOrigin, project: ProjectFn): void {
    if (this.editMode || this.plan.nodes.length > 0) {
      this.planDisplay.sync(fo, project, this.editMode);
    }
```

【修正後】
マップモードを開いているだけでは表示せず、「ノードが存在する」か、または「計画パネルなどの明示的な編集アクションがアクティブである」場合に限定します。仕様上「ノードが1つでもある場合のみ描画する」とするのが最もシンプルです。
```typescript
  update(simTime: number, displayTime: number): void {
    this.simTime = simTime;
    // ノードが1つ以上ある場合のみ描画を有効化する
    const shouldShowPlan = this.plan.nodes.length > 0;
    this.planDisplay.update(this.plan, simTime, displayTime, shouldShowPlan);
  }

  sync(mapDist: number, simTime: number, fo: FloatingOrigin, project: ProjectFn): void {
    const shouldShowPlan = this.plan.nodes.length > 0;
    if (shouldShowPlan) {
      this.planDisplay.sync(fo, project, this.editMode);
    } else {
      this.planDisplay.hide();
    }
```
※ ノードが0のときでも操作用の TRAJECTORY パネル（UI）自体は出しておきたい場合は、UIパネルの表示（`syncPanel`等）と、軌道の描画（`planDisplay.update/sync` への `show` フラグ）のロジックを分離する必要があります。（上記修正はオレンジの線自体を消すための最低限の変更です）
