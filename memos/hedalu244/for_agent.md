# 今後の todo

`PlanTrajectory` / `PredictedLine` の再実装(`OrbitEntity` への一本化)から出た残件。
同じ話題の todo が `predict_todo.md` にもあるので、そちらにある項目はここでは繰り返さない。

---

# 軌道計画モードのデバッグ: コード検査で挙がった疑わしい箇所

「軌道やノードがクリックできない・編集できない・表示が空のまま」の調査用。
上から順に、疑わしさが高い(= 症状を丸ごと説明できる)ものから並べる。

## 使えるようになったデバッグ手段

- **`?stage=practice`** — 敵の出ない軌道操作練習ステージ。選択画面からは `[P]`。
- **`PlanEditor.addDebugNode()`**(`plan-editor.ts:359`)— コンストラクタから1度だけ呼ばれ、
  高度約 430km の円軌道上に t=0 のノードを1つ置く。マップを開いた時点で計画が入っている。
  不要になったら関数とコンストラクタからの呼び出しの2行を消せばよい。
  - 挙動の注意: ノードが最初からあるので `Plan.trackAnchor` がアンカーを更新せず、
    アンカーは初期値(地球中心・t=0)のまま。よって anchor→ノードの区間は長さ0で線が出ず、
    描かれるのはノード以降の白い折れ線1本になる。MANEUVER PLAN パネルの Δv は
    「ノード速度 − 到達速度(=0)」なので 7656 m/s と出る。
  - 切り分けの筋道:
    - ノード(◆ハンドル)も折れ線も出ない → **描画/更新が走っていない**(下記 1 を最初に疑う)
    - 折れ線とハンドルは出るがクリック/ドラッグが効かない → **ヒット判定側**(下記 2〜6)
    - ハンドルは出るが折れ線だけ出ない → `PlanArc.integrate` / `SampledLine`

---

## 0. 【修正済み】`SampledLine` の頂点更新が GPU に届いていなかった ★これが本命だった

`SampledLine.syncGeometry` は再構築のたびに `new THREE.BufferGeometry()` を作って
`line.geometry` ごと差し替え、古い方を `dispose()` していた。three.js の `RenderObject` は
生成時のジオメトリと position 属性をキャッシュするので、**差し替えは拾われず最初の頂点を
描き続ける**。再積分もサンプル生成も走っているのに線だけ固まる、という症状の正体。

正しく動いていた `OrbitLine` と同じ「バッファは生成時に1度だけ確保し、書き込んで
`needsUpdate` を立て、本数は `setDrawRange` で変える」形へ統一した。**属性の差し替えも
同じ罠を踏む**ので、容量は `MAX_VERTICES` 固定にしてある。

## 1. rAF ループは例外1回で永久に停止する ★最有力

`main.ts:86` の `catch` は `console.error` するだけで `requestAnimationFrame` を再予約しない。
`update` / `sync` / `render` のどこかで1度でも例外が飛ぶと、**その瞬間の画面のまま固まり、
以後キーにもクリックにも一切反応しなくなる**。「表示が空のまま・何も操作できない」という
症状はこれだけで全部説明がつく。

**まず DevTools のコンソールを見ること。** 例外が出ているなら以下は全部無関係。

計画側で例外が出うる箇所:
- `hermiteInterpolate` は区間外の `t` で `throw` する(`orbital.ts:77`)。
  `StateQueue.at` / `OrbitEntity.at` / `PlanArc.at` の境界判定を1つでも取りこぼすと飛ぶ。
- `NanWatchdog` はコンソールと HUD に報告するだけで、非有限値の伝播自体は止めない。

## 2. ヒット判定が1フレーム古い投影関数を使っている

`PlanTrajectory.project` が更新されるのは `Game.sync` → `PlanEditor.sync` →
`PlanDisplay.sync` → `traj.update`(`plan-trajectory.ts:54`)だけ。
一方クリック判定は `Game.update` の中(`game.ts:240` の `editor.handleMapPointer`)。

さらに `OverviewCamera.update` は毎フレーム `this.view` を**新しいオブジェクトで置き換える**
(`overview-camera.ts:142`)ので、`projectionFromView(view)`(`camera-system.ts:42`)が閉じ込めた
`view` は必ず1フレーム前のもの。

→ カメラ静止中は一致するが、**ドラッグしながら/ドラッグ直後のクリックは確実にずれる**。
ノードの DOM ハンドル位置(`sync` で今フレームの投影)と、その右クリック判定
(`update` で前フレームの投影)が食い違うのも同じ理由。

## 3. マップを開いた最初のフレームのクリックは必ず無効

`[M]` は `Game.handleInput`(update の先頭)で処理されるので、同じフレームの
`editor.handleMapPointer` がもう走る。しかしその時点では `traj.project === null`
かつ `activeCount === 0` なので、`projectPoint` は `OFFSCREEN` を返し
`nearestSample` は必ず `null`(`plan-trajectory.ts:100-122`)。

## 4. `#node-gizmo` が HUD レイヤの下にいる

- `#node-gizmo` … `z-index: 9`(`node-gizmo.ts:12`)、`document.body` 直下
- `.ctx-menu` … `z-index: 9`(`context-menu.ts:10`)、同じく `document.body` 直下
- `#hud` … `z-index: 10`(`dom.ts:15`)

**HUD レイヤ全体がノードハンドルより手前に描かれる。** `#hud` 自体は `pointer-events: none`
なのでクリックは素通りするが、`pointer-events: auto` のパネルと重なった領域では
ノードが見えず押せもしない。CLAUDE.md が謳う「`#hud` は1つのスタッキングコンテキストで
子に 0〜4 のバンドを割り当てる」という規約の外に、この2つが居るのが原因。

## 5. マップモードでは画面左に幅 292px・高さ約 400px の不感帯ができる

`pointer-events: auto` のパネルが左端に3枚縦に並ぶ(`dom.ts:104-108`):

| パネル | top | width |
|---|---|---|
| `#hud-overview-camera` | 12px | 292px |
| `#hud-displaytime` | 166px | 292px |
| `#hud-trajframe` | 296px | 292px |

この帯では canvas に `pointerdown` が届かない = `Input` にクリックが積まれない。
パンやズームで計画軌道がこの帯に入ると、そこはクリックできない。

## 6. ノードを「クリックしたつもり」が retime になり、下流ノードが全部消える ★実バグ

`NODE_GIZMO_DRAG_THRESHOLD_PX = 4`(`const.ts:189`)を超えた `pointermove` **ごとに**
`onNodeDragMove` → `dragNodeToNearestSample`(`plan-editor.ts:214`)が呼ばれる。その中身は

```ts
const sample = this.planDisplay.traj.nearestSample(clientX, clientY, Infinity);
if (sample) this.selectedNodeIdx = this.plan.retimeNode(idx, sample);
```

- **許容距離が `Infinity`** なので、ポインタがどこにあっても必ず軌道上の最寄りサンプルへ
  スナップする。手が 5px 揺れただけでノードが軌道の反対側へ飛ぶ。
- `Plan.retimeNode`(`plan.ts:63`)は `this._nodes.length = newIdx + 1` で
  **下流ノードを毎回切り捨てる**。ドラッグ1回につき何度も呼ばれる。
- canvas 側のクリック判定閾値は `CLICK_MOVE_THRESHOLD = 6`(`input.ts:21`)で、値が食い違う。

## 7. `Plan.addNode` だけ下流ノードを破棄しない

`retimeNode` / `applyNodeDv` は破棄するのに `addNode`(`plan.ts:34`)はしない。
既存ノードの間に新しいノードを挿すと、下流ノードは「差し替え前の軌道上で凍結された
絶対状態」のまま残るので、折れ線が下流ノードで不連続に飛ぶ。(`editor_todo.md` に既出)

## 8. 選択中ノードがあると毎フレーム `applyNodeDv` が呼ばれている

`PlanEditor.updateEditing`(`plan-editor.ts:332`)はキー入力がゼロでも
`plan.applyNodeDv(idx, fromOrbitalAxes(selNode, local))` を呼ぶ。
救っているのは `applyNodeDv` 側の「`dvWorld` が厳密に 0 なら early return」だけ
(`plan.ts:76`)。`fromOrbitalAxes` が丸めで 1e-18 でも返せば、**毎フレーム下流ノードが
破棄され続ける**。入力がゼロなら呼ばない形にすべき。

---

## 検査して「問題なし」と確認した箇所(再調査の無駄を省くため)

- クリック座標系は一致している。`Input` は `e.clientX/Y`(ビューポート座標)、
  `projectionFromView` は `window.innerWidth/innerHeight` へ写す。
  `public/index.html` で `body { margin: 0 }`、canvas は `display: block` で全面。ズレはない。
- `hermiteInterpolate` は引数の時刻の前後関係に依存しない(`h` が負でも正しい)。
  `StateQueue.at` が(新しい, 古い)の順で渡し、`OrbitEntity.at` が(古い, 新しい)の順で
  渡しているが、どちらも正しい。
- `PlanArc` は初回 `update` で必ず積分する(`key === null` かつ `lastComputeMs = -Infinity`)。
  初回だけ折れ線が出ない、ということはない。
- `StateQueue.cleanup(duration, 2)` は区間全体を保持窓にしているので、間引き後も
  約 1,550 サンプル(1日表示)が残る。`SampledLine` の「2頂点未満は隠す」条件には掛からない。
- `Plan.addNode` の `indexOf(postState)` は参照比較だが、サンプルは毎回新しいオブジェクトなので
  同一視される危険はない。
- ノードギズモの DOM は `pointerdown` で `stopPropagation` するので、canvas 側の `Input` と
  二重にイベントを処理することはない。
- `ContextMenu` のキャプチャ段階リスナは、ノードの `pointerdown` ハンドラより先に走る
  (キャプチャ → ターゲット)ので、「閉じてから開く」の順になっていて自己閉塞しない。
- マップモード中の `W/S/A/D/Q/E` は `Player.behave` 側が `editMode` で無効化済み
  (`player.ts:143` / `player-throttle.ts:104`)。Δv 編集キーと並進キーの競合はない。
