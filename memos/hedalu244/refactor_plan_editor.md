# plan-editor.ts — 下ろせるものを下ろし、大気圏警告の仕様違反を直す

行番号はすべて `7f904d28` 時点のもの。

## 目的

`src/game/plan/plan-editor.ts`(635行)は、戦闘ビューの表示物を `PlanDisplay` へ移した結果、
**マップモードでの計画編集**だけを持つようになった。この計画は、そこから先に残っている
「上位・兄弟へ移すのではなく、下位(`NodeGizmo` / `PlanGizmo3D` / `AxisDragGizmo` / `PlanPanel`)
へ下ろせるもの」と「編集セッションの中に残った重複」を取り除き、あわせて**大気圏警告の仕様違反**
を直す。

取り除く対象は次の5種類。

1. **他モジュールの見た目パラメータが編集側に置かれている。** 3D 矢印の伸縮量を決める係数
   (`0.01` / `0.5` / `0.2`)と、見かけサイズの係数(`0.002`)が `plan-editor.ts` にある。
2. **整合性を呼び出し側が保っているデータ。** `NodeGizmo` が `latch` と `activeAxis` を別々に
   公開していて、「`latch` があれば `activeAxis` も同じ軸で立っている」という不変条件を、読む側が
   知っていないと正しく合成できない(規約1.6「整合性保持責務の漏洩は重大な違反」)。
   同じ形が `PlanPanel` の境界にもある — 行ごとの `selected` と `hasSelection` が別々に渡る。
3. **同じ導出が2箇所にある。** 「ノードの Δv を到着状態の軌道基準枠へ分解する」が
   `rebuildDraggedNode` と `syncPanel` に別々に書かれていて、片方は ECI 差から、もう片方は
   中心天体相対の差から組んでいる。自動ワープの成否ヒントも2箇所にある。
4. **使われない計算と、実際には要らない引数。** 3D ギズモの姿勢を組むところで `radOut` を
   求めて表示座標へ変換しているが、どこにも渡していない。`sync()` は `CameraSystem` を丸ごと
   受けて `mapCamera.dist` しか読まず、`simTime` を引数で受けながら同じ値をフィールドにも持つ。
5. **仕様違反。** 大気圏警告を中心天体の id が `earth` かどうかで出している。`SPEC/ORBIT.md`
   「大気」は**「大気の有無と密度モデルは天体ごとのパラメータである」**と定めており、id の
   リテラルはこれに反する。しきい値の判定も、パネル側が高度 `120e3` を直に見ている。

## 決めたこと

**モジュールの新設・分割は行わない。** 当たり判定/編集/ギズモ同期/パネル同期/入力受けは、
どれも「マップで計画ノードを編集する」の中の工程であって、それ自身の名前で呼べる別責務ではない。
最長の関数でも `syncGizmo` の 63行で、規約1.2 の 100行基準に届いていない。分ける線が無いところに
線を引かない。

**500行は下回らない見込みで、それでよい。** 本計画をすべて実施しても 600行前後に留まる。残るのは
「同じ関心の実装が単に多い」状態(規約1.2 の第4分類)で、行数を根拠に線を引かない。

**`syncPanel` は `PlanPanel` へ下ろせない。** 表示値の導出には `Plan` / `PlanPath` /
`CelestialSystem` が要り、`PlanPanel` はそのどれも持たない。`syncPanel` が長いのは下ろせる仕事が
残っているからではなく、上の 3.(導出の重複)が原因である。下ろせるのは選択の表現だけ(手順7)。

**大気圏警告は、近点での大気密度で判定する。** 中心天体の id を見るのをやめ、その天体の大気へ
問い合わせる。密度は**近点の位置**から求める — 近点の中心天体相対位置を軌道要素から出し、その
地心緯度での基準楕円体高度を測り、そこでの大気密度を見る。しきい値は地球の高度 120km 相当の密度に
置くので、既定の太陽系での見え方はほぼ変わらない。警告の文言は変えない。

**これは挙動の変更である。** 変わるのは、警告が出る近点高度の**表示値**が地心緯度で動くこと
(地球で ±7〜−14km)。パネルが表示している近点高度は天体の真球半径から測った量、大気の高度は
基準楕円体から測った量で、別の量だからである。

**打ち切りではなく助言である。** 大気へ入る計画は普通に立てられ、普通に描かれる。計画軌道が
打ち切られるのは天体の地表へ到達したときだけ(`SPEC/ORBIT.md`「未来予測(予測軌道)」)。
ノードを置ける時刻範囲も大気を見ない。この手順でそこは変えない。

ユーザーがこれを覆す場合:

- 「モジュールを分けたい」なら、手順4〜7 の下ろし先が変わる(分割後のどちらが持つかを先に決める)。
- 「しきい値は密度でなく固定高度でよい」なら、手順1 の仕様文と手順8 の判定式が変わる
  (`positionOnOrbit` / `ellipsoidAltitude` / `atmosphericDensity` の合成が不要になり、
  `atmosphereAt() !== null` と高度比較だけになる)。

## 達成目標

全手順の実施後、次がすべて成り立つこと。

- `DEVELOP/SPEC/PLAN.md` に、噴射後の軌道の表示と大気圏警告の振る舞いが書かれている。
- `grep -rn "id === 'earth'" src/game/plan/` が **0件**。
- `grep -n "120e3" src/game/plan/plan-panel.ts` が **0件**。
- `grep -n "radOut" src/game/plan/plan-editor.ts` が **1件**(`nodeDvLocal` の中だけ)。
- `grep -rn "\.latch\b|activeAxis" src/game/plan/` が **0件**(統合後の名前だけが残る)。
- `grep -n "CameraSystem" src/game/plan/plan-editor.ts` が **0件**。
- `grep -n "relativeToBody" src/game/plan/plan-editor.ts` が **0件**。
- `grep -n "computeAxisScreenDirs" src/game/plan/plan-editor.ts` が **0件**。
- `0.01` `0.5` `0.2` `0.002` の裸の係数が `plan-editor.ts` から消え、名前付き定数として
  `plan-gizmo-3d.ts` にある。
- `syncGizmo` が **45行以下**、`syncPanel` が **36行以下**、`plan-editor.ts` が **610行以下**。
- `PlanEditor` の `public` メンバーが、`MapView` と `ObjectWindows` が実際に呼ぶものだけになる
  (`selectedNodeIdx` / `plan` / `closeMenu` / `deleteNode` / `deleteSelected` / `handleInput` /
  `handleMapPointer` / `addNodeAt` / `dispose` / `update` / `sync` / `onMapClosed`)。
- `npm run typecheck` と `npm run test:game` が通る。
- マップモードで、ノード配置・ドラッグ移動・矢印ハンドルのドラッグとラッチ・WASDQE と
  パネルのボタンによる Δv 加算・パネルの数値入力が、実施前と同じに動く。
- 地球周回の計画ノードで近点を下げると `⚠ 近地点が大気圏内` が出て、月周回のノードでは
  近月点をどれだけ下げても出ない。

## 手順

### 手順4. Δv アームのドラッグ状態を1つにし、伸縮の演出を `PlanGizmo3D` へ下ろす

**目的.** `latch` と `activeAxis` が保つべき不変条件を読む側から取り除き、「どれだけ伸ばすか」を
矢印を持つ `PlanGizmo3D` の中へ移す。伸縮の見かけは変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `node-gizmo.ts:61-66,91-92` | `AxisLatchState` と `activeAxis` を1つの公開型へ統合する(下記) |
| `node-gizmo.ts:168-173,250-298` | `latch` / `activeAxis` への代入をすべて新しい単一フィールドへ書き換える。要素破棄時・ドラッグ終了時に `null` へ戻すのは現状どおり |
| `plan-gizmo-3d.ts:84-103` | `setStretch` を `public setActiveDrag(drag: AxisHandleDrag \| null): void` へ置き換え、伸び率の計算をこの中に入れる。係数は名前付き定数として同ファイルへ置く |
| `plan-gizmo-3d.ts:86` | `for (let s of [1, -1])` を `for (const s of [1, -1] as const)` にする(規約1.12) |
| `plan-editor.ts:496-513` | ブロックごと `this.gizmo3d.setActiveDrag(this.nodeGizmo.axisHandleDrag)` の1行へ置き換える |
| `plan-editor.ts:535-543` | `this.nodeGizmo.latch` の読みを新しいフィールドへ読み替える。ラッチ中の判定は `drag.excessPx !== null` |

新設する型(`node-gizmo.ts`。`AxisHandleSpec` と同じ場所に置く — Δv アームの語彙はこのモジュールが
持っている):

```ts
// ドラッグ中の Δv アーム。ラッチ前は変位をそのまま onAxisDrag へ流すので excessPx は null、
// ラッチ後は基点からの超過量を載せる(レートでの積分は毎フレーム読み手が行う)。
export interface AxisHandleDrag {
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
  readonly excessPx: number | null;
}
```

`NodeGizmo` 側のフィールド:

```ts
public axisHandleDrag: AxisHandleDrag | null = null;
```

`PlanGizmo3D` 側へ移す定数:

```ts
const DRAG_STRETCH = 0.2;          // ラッチ前のドラッグ中に矢印を伸ばす割合
const LATCH_STRETCH_PER_PX = 0.01; // ラッチ超過 1px あたりの伸び
const LATCH_STRETCH_MAX = 0.5;     // ラッチで伸ばす割合の上限
```

**達成条件と検証**

- `grep -rn "\.latch\b|activeAxis" src/` が 0件。
- 伸縮の係数 `0.01` / `0.5` / `0.2` が `plan-editor.ts` に残っていない。
- `syncGizmo` が 45行以下。
- `npm run typecheck` と `npm run test:game` が通る。
- `npm run dev` でマップモードのノードを選び、矢印ハンドルを **60px 未満**ドラッグしたときに
  その矢印が少し伸び、**60px を超えて**ドラッグし続けたときにさらに伸びて上限で止まり、
  離すと元へ戻ることを目で見る。

---

### 手順5. 軸ハンドルの2段呼びを `AxisDragGizmo` の中へ畳む

**目的.** `computeAxisScreenDirs` は `buildAxisHandles` へ渡すためだけに1箇所から呼ばれていて、
戻り値の構造型が2つの署名に書かれている(規約1.6「同一の意味、同一の情報量を持つ型を複数作らない」)。
順序を持ち主の中へ移し、型の重複を消す。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `plan-axis-drag.ts:35-53` | `computeAxisScreenDirs` を `private` にする |
| `plan-axis-drag.ts:56-80` | `public buildAxisHandles(nx: number, ny: number, node: KinematicState, mapDist: number): AxisHandleSpec[]` へ変え、中で `computeAxisScreenDirs` を呼ぶ |
| `plan-editor.ts:479-480` | `axisSpecs = this.axisDrag.buildAxisHandles(p.x, p.y, arrFor3D ?? node, mapDist)` の1行にする |

**達成条件と検証**

- `grep -rn "computeAxisScreenDirs" src/` が `plan-axis-drag.ts` の中だけで 2件(宣言と呼び出し)。
- `{ pro: { x: number; y: number; }` の構造型が `plan-axis-drag.ts` に1回だけ現れる。
- `npm run typecheck` が通る。
- `npm run dev` でノードを選び、6方向のハンドルがノードの周りに現状どおり並ぶことを目で見る。

---

### 手順6. 到着基準ローカル Δv の導出を1つにする

**目的.** 「ノードの Δv を到着状態の軌道基準枠へ分解する」が2箇所にあり、片方(`syncPanel`)は
中心天体相対の差から組んでいる。`nodeDv` のコメントが述べているとおり、この差は ECI で取って
到着状態の基底へ射影するのが正しい形なので、そちらへ寄せて1つにする。

`syncPanel` 側の中心天体相対の差は、`arr.t` がノード時刻と厳密に一致する
(`plan-path.ts:500` が `end: node.t` で区間を切り、`arrivalStates()` がその時刻の状態を返す)ため、
同じ中心・同じ時刻の並進フレームが両辺で打ち消し合い、ECI 差と一致する。**表示値は変わらない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `plan-editor.ts`(`nodeDv` の隣) | `private nodeDvLocal(i: number, arriving: readonly (KinematicState \| null)[]): Vec3 \| null` を新設する(下記) |
| `plan-editor.ts:372,380-387` | `rebuildDraggedNode` の `dvWorldOld` / `axesOld` / `dvLocal` を `nodeDvLocal(idx, arriving)` の呼び出し1回に置き換える。`null` なら `return null`。使われなくなる `node` / `arr` の局所変数も落とす |
| `plan-editor.ts:559-576` | `syncPanel` の `centerState` / `plan.anchorOr` 経由をやめ、`center` は選択中ノードがあるときだけ `strongestAttractor(node.r, …, node.t)` で求める。`localDv` は `nodeDvLocal` から取る |
| `plan-editor.ts:582-584` | `warnAtmosphere` は `center !== null && center.id === 'earth'` にする(この式そのものは手順8 で置き換わる) |
| `plan-editor.ts:444-449` | 呼び出し元が1つになる `relativeToBody` を `bodyState` へインライン展開して消す |

新設するメソッド:

```ts
// i 番目のノードの Δv を、到着状態の軌道基準枠(PRO/NRM/RAD)成分へ分解する。
// ノードか到着状態が求まっていなければ null。
private nodeDvLocal(i: number, arriving: readonly (KinematicState | null)[]): Vec3 | null {
  const arr = arriving[i];
  if (!this.plan?.nodes[i] || !arr) return null;
  const dvWorld = this.nodeDv(i, arriving);
  const axes = orbitAxes(this.bodyState(arr));
  return v3(dot(dvWorld, axes.pro), dot(dvWorld, axes.nrm), dot(dvWorld, axes.radOut));
}
```

**`anchorOr` 経由を落としてよい根拠.** 落とすことで `warnAtmosphere` が「選択なしのとき常に false」
へ変わるが、`plan-panel.ts:85-98` はこの値を `if (selEl)` の中でしか読まない。選択が無ければ
`selEl` は `null` なので、出力される HTML は変わらない。

**達成条件と検証**

- `grep -n "relativeToBody|anchorOr" src/game/plan/plan-editor.ts` が 0件。
- `grep -n "radOut" src/game/plan/plan-editor.ts` が 1件。
- `syncPanel` が 36行以下。
- `npm run typecheck` と `npm run test:game` が通る。
- `npm run dev` でノードに Δv を入れ、TRAJECTORY パネルの PRO / NRM / RAD 欄が、矢印ハンドルで
  加えた向きと符号どおりに動くこと、矢印ハンドルで加えた量とパネルの `m/s` 表示が一致することを
  目で見る。**月の影響圏の内側と外側のノードで両方見る** — 中心天体相対から ECI へ寄せた変更なので、
  影響圏の境界を跨ぐケースが差の出る場所。

---

### 手順7. 選択の正本を1つにして `PlanPanel` へ渡す

**目的.** いま `PlanPanel.sync` は「行ごとの `selected`」と「`hasSelection`」という、同じ1つの
事実の別表現を2つ受け取っていて、呼び出し側が両者の整合を保っている。選択中の index を1つだけ
渡し、行ごとの印とパネルの開閉は `PlanPanel` が導く。**表示は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `plan-panel.ts:22-26` | `PlanPanelNodeRow` から `selected` を落とし、`tRel` / `dvMag` だけにする |
| `plan-panel.ts:68-83` | `planPanelHtml` が `selectedIdx: number \| null` を受け、行の `▸` を `i === selectedIdx` で決める |
| `plan-panel.ts:171-191` | `public sync(nodes: readonly PlanPanelNodeRow[], selectedIdx: number \| null, selEl: OrbitalElements \| null, localDv: Vec3 \| null, nodeSecondsFromNow: number \| null, warnAtmosphere: boolean): void` へ変え、`hasSelection` を `selectedIdx !== null` から導く |
| `plan-editor.ts:551-556,582-584` | 行の組み立てから `selected` を外し、`sync` へ `this.selectedNodeIdx` を渡す |

**達成条件と検証**

- `grep -rn "hasSelection" src/game/plan/` が 0件。
- `grep -n "selected" src/game/plan/plan-editor.ts` が `selectedNode` / `selectedNodeIdx` の
  参照だけになる。
- `npm run typecheck` が通る。
- `npm run dev` でノードを2つ以上置き、選択を切り替えるたびにパネルの `▸` が移り、選択を外すと
  パネル全体が消えることを目で見る。

---

### 手順8. 大気圏警告を、天体 id ではなく近点での大気密度で判定する

**目的.** 中心天体の id が `earth` かどうかで大気の有無を決めている箇所を、その天体の大気への
問い合わせに替える。**この手順だけは挙動を変える** — 既定の太陽系では地球しか大気を持たないので
出る/出ないの結果はほぼ同じだが、判定が近点での大気密度になるため、警告が出る近点高度の表示値が
地心緯度で動く(手順1 で書いた仕様のとおり)。

**新しい物理関数は作らない。** 必要な部品は既に `physics/` に揃っていて、再利用可能な形で
正しいモジュールにある(規約 `/modify-feature` の2軸判定で ○/○):

- `positionOnOrbit(el, 0)` — 真近点角 0 = 近点の、中心天体相対の位置。
- `ellipsoidAltitude(rRel, atm)` — その位置の地心緯度における基準楕円体からの高度。
- `atmosphericDensity(alt, atm)` — その高度の大気密度。
- `CelestialMotion.atmosphereAt(pivot)` — 大気を持たない天体では `null`。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `plan-editor.ts`(`bodyState` の隣) | `private peInAtmosphere(el: OrbitalElements, t: number): boolean` を新設する(下記) |
| `plan-editor.ts`(定数) | しきい値の密度を名前付き定数として置く |
| `plan-editor.ts:578-584` | `center.id === 'earth'` をやめ、`selEl` があるときだけ `peInAtmosphere(selEl, node.t)` を呼ぶ。`CLAUDE.md` を根拠に引く4行のコメント(その記述は `CLAUDE.md` に無い)を削る |
| `plan-editor.ts:4-35` | `positionOnOrbit` を `physics/elements` から、`atmosphericDensity` / `ellipsoidAltitude` を `physics/atmosphere` から import する |
| `plan-panel.ts:95` | `warnAtmosphere && isFinite(apsis.pe) && apsis.pe < 120e3` を、渡された真偽値だけの判定にする。`120e3` はこのファイルから消える |
| `plan-panel.ts:67,68-72,171-174` | 引数名を `warnAtmosphere` から `peInAtmosphere` へ改め、冒頭コメントの「(<120km)」を落とす |

新設するメソッドと定数:

```ts
// 噴射後の軌道の近点がこの大気密度に達したら警告する [kg/m^3]。地球の高度 120km 相当。
const PE_WARN_DENSITY = 2.4e-8;
```

```ts
// 噴射後の軌道 el の近点が、中心天体の大気の中にあるか。大気の高度は基準楕円体から測るので、
// パネルへ出している近点高度(真球基準)ではなく近点の位置そのものから測る。
private peInAtmosphere(el: OrbitalElements, t: number): boolean {
  const atm = el.center.atmosphereAt(t);
  if (atm === null) return false;
  return atmosphericDensity(ellipsoidAltitude(positionOnOrbit(el, 0), atm), atm) >= PE_WARN_DENSITY;
}
```

**達成条件と検証**

- `grep -rn "id === 'earth'" src/game/plan/` が 0件。
- `grep -n "120e3" src/game/plan/plan-panel.ts` が 0件。
- `npm run typecheck` と `npm run test:game` が通る。
- `npm run dev` で地球周回の計画ノードを置き、レトログレード方向へ Δv を増やして近地点を下げると、
  パネルの `近地点 Pe` が 120km を切るあたりで `⚠ 近地点が大気圏内` が出ることを目で見る。
  **軌道傾斜角が 0° 付近の軌道と 90° 付近の軌道で両方見る** — 極寄りに近点がある軌道では、
  表示値がより低くならないと出ないのが正しい。
- 月周回のノードで近月点をどれだけ下げても警告が出ないことを目で見る。

## 見積り

| 手順 | 触るファイル | 変更箇所 | 増減見込み(`plan-editor.ts`) |
| --- | --- | --- | --- |
| 1 | 1(SPEC) | 1箇所 | ±0 |
| 2 | 1 | 5箇所 + メンバー修飾の一括 | −5行 |
| 3 | 2 | 4箇所 | −2行 |
| 4 | 3 | 6箇所 | −22行 |
| 5 | 2 | 3箇所 | −1行 |
| 6 | 1 | 5箇所 | −7行 |
| 7 | 2 | 4箇所 | −1行 |
| 8 | 2 | 6箇所 | +6行 |

合計 635 − 32 = **603行**。`syncGizmo` は 63 − 19 = **44行**、`syncPanel` は 41 − 6 = **35行**。

検証は各手順で `npm run typecheck`(`tsc --noEmit`)、`src/game/` の挙動に触る手順4・6・8 で
`npm run test:game`。目視は手順3・4・5・6・7 の末尾に書いた5点を最後にまとめて1回で見てよいが、
**手順8 の目視は手順8 の直後に単独で行う** — ここだけ挙動が変わるので、他の手順の目視と混ぜると
どちらの変更で見え方が変わったのか分からなくなる。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `PlanEditor.simTime` が、マップへ入った最初のフレームで `update()` より先に読まれる | ワープメニューの基準時刻とパネルの `T-` 表示が1フレームぶん古い値(初回は 0)になる。無言で少しずれるだけで例外は出ない | 手順3。`Game.update()` 内で `activeView.update` がビュー切替より後であることを、着手前にコードで確認する |
| `latch` と `activeAxis` を統合するとき、要素破棄時(`node-gizmo.ts:168-173`)の解除を落とす | 選択が外れて Δv アームの DOM が消えた後もラッチ状態が残り、**指を離していないのに Δv が加算され続ける** | 手順4。マップでノードを選び、矢印をラッチさせたまま別の場所をクリックして選択を外し、Δv が止まることを見る |
| `excessPx: null` を「ラッチしていない」ではなく「ドラッグしていない」と読み違える | ラッチ前のドラッグで 3D 矢印が伸びなくなる、あるいはラッチ後の伸び方が変わる | 手順4。60px 未満/超のドラッグを両方見る |
| `arr.t === node.t` の前提が崩れる(区間の切り方が変わる) | `syncPanel` の Δv 表示が中心天体の公転速度ぶんずれる。値は出るので気付きにくい | 手順6。`plan-path.ts:500` の `end: node.t` を着手前に確認し、月の影響圏の内外でパネル値と矢印操作量の一致を見る |
| `strongestAttractor` の引数を `centerState` から `node` へ変えたとき、選択が無い経路の `center` を消し忘れる | `plan.anchorOr` 経由が残り、削減にならないだけで挙動は変わらない(静かな取りこぼし) | 手順6。`grep -n "anchorOr" src/game/plan/plan-editor.ts` が 0件 |
| `PlanPanelNodeRow` から `selected` を落としたとき、`planPanelHtml` の `map((n, i) => …)` の `i` が `plan.nodes` の index と一致しない並びを作る | 別のノードに `▸` が付く | 手順7。行は必ず `plan.nodes` の順・全件で組み、間引かないことを確認する |
| `positionOnOrbit(el, 0)` が返すのは**中心天体相対**の位置なのに、絶対 ECI のつもりで `ellipsoidAltitude` へ渡す | 高度が地球の公転半径ぶん(1億 km 台)になり、密度が完全にゼロへ落ちて**警告が二度と出なくなる**。例外は出ない | 手順8。地球周回で近地点を 100km まで下げて警告が出ることを必ず見る |
| `atmosphereAt(pivot)` に渡す時刻を、ノード時刻ではなく現在時刻にする | 大気の自転軸が別時刻のものになる。ずれは極めて小さく、目では見えない | 手順8。`peInAtmosphere` の呼び出しで `node.t` を渡していることをコードで確認する |
| しきい値を密度ではなく高度のまま名前を付け替えただけで済ませる | 仕様違反(天体ごとのパラメータで決まるべきものを固定値で決める)がそのまま残る | 手順8。`grep -n "120e3\|120 \* 1000" src/game/plan/` が 0件 |
| 手順8 の目視を他の手順とまとめて行う | 見え方が変わったのが手順8 のせいか、それ以前の下ろしのせいか切り分けられない | 手順8。手順8 の直後に単独で見る |

## 今回やらないと決めたもの(再提案しないための記録)

- **`MAX_PLAN_NODE_MARKERS` を `NodeGizmo` へ移す。** DOM 要素数の上限なので持ち主は `NodeGizmo`
  だが、いまは編集側が投影する前に打ち切っていて、移すと全ノードを投影してから捨てることになる。
  上限が「投影を省く」意味も担っているので、そのまま置く。
- **6方向(PRO/RET・NRM/ANM・OUT/IN)の定義を1箇所へまとめる。** いま `plan-axis-drag.ts`
  (ハンドルのラベルと配置)・`plan-panel.ts`(長押しボタンのラベルとキー表示)・
  `plan-gizmo-3d.ts`(矢印の色)・`plan-editor.ts`(キーとボタンの読み取り)の4箇所が同じ6方向を
  並べている。ただし並べている内容(ラベル・キー割当・色・入力源)はそれぞれ別物で、
  モジュール間で index を受け渡してはいない。共通化してよいのは「今後も一緒に変わる」場合だけで、
  それはコードから判断できない。**残る問題**: 方向を1つ足す/順序を変えるときに4箇所を直す必要がある。
- **`syncPanel` の表示値の導出を `PlanPanel` へ下ろす。** `Plan` / `PlanPath` /
  `CelestialSystem` が要り、下ろすと `PlanPanel` がゲームの盤面を知ることになる。
  `PlanPanel` は表示専用のまま置く。
- **`updateEditing` の6行(WASDQE とボタンの読み取り)を表にする。** 6行が並んでいるだけで
  分岐も整合性の要求も無く、キー割当という「見て確かめたいもの」がその場に見えている状態のほうが
  読める。
- **大気圏の高度しきい値を、自機の高度低下警告(120/100/80 km の3段)と揃える。** あちらは
  自機の実位置を平滑化して段階的に鳴らす警報で、こちらは計画した軌道の近点が大気に入るかの助言。
  鳴る条件も持つ状態も違うので、値がたまたま一致していても1つにしない。
- **敵の出現高度が使う再突入高度と揃える。** あちらはステージのバランス調整値で、大気のモデル
  とは別に調整される。
- **ノードを大気の中へ置けないようにする。** 計画軌道が打ち切られるのは天体の地表へ到達した
  ときだけ(`SPEC/ORBIT.md`「未来予測(予測軌道)」)で、大気は打ち切りの理由ではない。
  警告は助言のまま置く。
