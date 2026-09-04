# 定数差で増えているシェーダを畳む — 実装計画

対象コミット `4a25588c`(作業ブランチ `optimize-load-and-runtime`)。

## 目的

**同じ形のシェーダグラフが、JS で計算した定数を焼いているせいで別々のシェーダとして
コンパイルされている箇所を潰す。** 起動時のシェーダ構築(いま最大 20 数秒フレームが
途切れる)と、プレイ中に物が初めて画面へ入った瞬間のカクつきの両方が減る。

### 前提 — three が 2 つのマテリアルを 1 本のシェーダへ畳む条件

判断の根拠なので、three r185 の該当箇所を挙げる(`node_modules/three/build/three.webgpu.js`)。

1. **GPU のシェーダは WGSL の本文だけで共有される。** `Pipelines.getForRender` は
   `this.programs.vertex` / `.fragment`(Map)を**シェーダ本文の文字列**で引き、当たれば
   `createShaderModule` を呼ばない。パイプラインの鍵も
   `stageVertex.id + ',' + stageFragment.id + ',' + backend.getRenderCacheKey(renderObject)` なので、
   **本文が 1 バイトも違わず描画状態が同じなら、マテリアルが別でもパイプラインは 1 本。**
2. **一方、TSL のグラフ構築(ノードを組んで WGSL 文字列を吐くところ)はマテリアルごとに
   走る。** `Nodes.getForRender` は `renderObject.initialCacheKey` で `nodeBuilderCache` を引き、
   その鍵は `NodeMaterial#customProgramCacheKey()` → 各ノードの `getCacheKey()` → 葉の
   `customCacheKey()` = **`this.id`** で決まる。`uniform()` や `float()` を呼び直せば id が
   変わるので、**形がまったく同じグラフでもマテリアルの数だけ組み直される。**
3. **ノード id は WGSL の本文には出ない。** 識別子は構築順の連番(`nodeUniform0`,
   `nodeVar0`, …)。**例外は `NodeBuffer_<id>` だけ**で、これは uniform 配列と storage
   バッファの構造体名に付く(`WGSLNodeBuilder.getUniformFromNode`)。

つまり:

| やること | WGSL 本文 | シェーダ本数 | グラフ構築の回数 |
| --- | --- | --- | --- |
| JS で計算した値を定数として焼く | **変わる** | **増える** | 増える |
| uniform を 1 本増やす | 変わらない | 増えない | 増える |
| storage / uniform 配列を 1 本増やす | **変わる**(名前に id) | **増える** | 増える |
| 同じノード実体を使い回す(マテリアル共有) | 変わらない | 増えない | **増えない** |

この読みは実測と合う。`lens-pass.ts` はフィルタを 30 枚作るのに、記録されたフラグメント
シェーダは **26 本**だった — 縮小 5 段は読み元テクスチャが違うだけで本文が同じなので 1 本へ
畳まれ(−4)、条 20・拡大 4・ゴースト 1 がそのまま残る、で 26。

### 直すもの

| 箇所 | いま何が起きているか | 効き |
| --- | --- | --- |
| `pipeline/lens-pass.ts` `pipeline/lens-kernels.ts` | 条の角度と刻み、拡大段の重みを JS で焼くので、フィルタ 24 枚が全部別のシェーダ | **起動時に 26 本 → 4 本** |
| `curve.ts` | `vertexColors` を実行中に切り替えるので、そこでマテリアルが組み直される | 実行中の 1 回 |
| `cumulus-shell.ts` | 地表半径・粒の周波数・勾配の幅を定数として焼く。殻を持つ天体を増やすと本数が増える | 予防(いまは 1 体) |
| `ring.ts` `ring-view.ts` | 帯ごと・扇形ごとにマテリアルを作るので、**同じ形のグラフが 86 回組み直される** | 画面へ入るたび分散して来る約 1 秒 |
| `protein-motion-material.ts` | 体ごとの storage バッファがグラフへ焼かれるので、**敵 1 体ごとに専用のシェーダ**が湧く | 湧いた瞬間のカクつき |

`celestial-surface.ts` は**直さない**(下の「決めたこと」)。

## 決めたこと

- **`celestial-surface.ts` には手を入れない。** `solid` / `textured` は素の
  `THREE.MeshStandardMaterial` で、`getMaterialCacheKey` は色のような object 値を `'{}'` と
  しか書かず、`map` からはマッピングとフィルタと巻きしか読まない。天体を何体足しても
  マテリアルのキャッシュキーは「map あり」「map なし」の 2 種類しか生まれない。分割段
  ラダーも、ジオメトリの鍵が属性名・itemSize・index の有無だけなので段をまたいで同じ。
  `clouded` はノードで組むが地球 1 体だけ。**定数差でシェーダが増える構造になっていない。**
- **`cumulus-shell.ts` のレイマーチの刻み数(`SAMPLING_OF_DETAIL` の `march` / `refine`)は
  展開したままにする。** これを uniform + `Loop()` へ移すとシェーダは 1 本になるが、
  実行時のレジスタ圧が変わるので描画時間を測ってからでないと決められない。定数差の話とは
  別の判断なので、この計画には入れない。
- **`protein-motion-material.ts` を手順 5 として入れる。** 原因(グラフへ焼かれる storage
  バッファ名)が他と同じで、しかも唯一「プレイ中に湧いた瞬間」に効く。ただしこの手順だけ
  規模が大きく、**外しても手順 1〜4 には影響しない。**
- **手順 5 の pooled バッファの容量は残基数で決め打ちにする**(`PROTEIN_RESIDUE_SLOTS =
  65536` vec4 = 1 MB、`PROTEIN_MODE_SLOTS = 4096` float = 16 KB)。同時に湧くタンパク質の
  上限が決まっていないので、スロットは解放時に返す自由リストで回し、**尽きたら motion を
  付けずに描く**(例外で落とさない)。カタログ最大の残基数は 4713(`6n2y`)なので、
  65536 なら最大の体でも 13 体は同時に持てる。

## 達成目標

1. `?stage=1` の起動で作られる**レンズ効果のフラグメントシェーダが 26 本 → 4 本**、
   同パスの WGSL が 291.8 KB → 140 KB 以下になる。
2. **環の帯のマテリアルが 86 枚 → 2 枚**になる(`src/render/ring.ts` で
   `new THREE.MeshBasicNodeMaterial` / `new THREE.LineBasicNodeMaterial` を呼ぶ箇所が、
   帯ごとのコードパスから消えて共有の 1 か所だけになる)。
3. **タンパク質の敵を 2 体目以降湧かせても、新しいパイプラインが 1 本も作られない**
   (同じアセットなら)。
4. `curve.ts` から `vertexColors` の実行時切り替えが消える
   (`grep -n "vertexColors" src/render/curve.ts` が生成時の 1 か所だけになる)。
5. `cumulus-shell.ts` が `groundRadius` / `grainFrequency` / `gradientAngle` を数値として
   グラフへ渡さない(3 つとも `FloatUniform` になる)。
6. 見た目が変わらない。`npm run render-lab:shot` の `leo` / `sun-1au` / `saturn` /
   `saturn-shadow` / `earth` / `earth-oblique` / `protein-*` が、撮り直しの揺れ
   (半影を持つケースで ±4 LSB)を超えて動かない。
7. `npm run typecheck` と `npm run test:render` が通る。

---

## 手順 1. レンズ効果の条と拡大段を uniform 化する

### 目的

条 20 枚は `Math.cos(angle) * distance` と `STREAK_TAPS ** pass` を、拡大 4 枚は
`coarserWeight` を JS で計算して焼いているため、**形が同じなのに 24 本の別々のシェーダに
なっている。** 向き・刻み・利得・重みを uniform へ移すと、条は 1 本、拡大も 1 本へ畳まれる。
**絵は変えない** — 焼いていた値をそのまま uniform の初期値として渡すだけ。

### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/lens-kernels.ts` | `streakPass` の引数を角度・パス番号から uniform ノードへ変える。刻みを外へ出す `streakStride` を足す |
| `src/render/pipeline/lens-pass.ts` | 条の鎖と拡大段で uniform を作り、初期値を入れる |

`lens-kernels.ts`:

```ts
// 条 1 パスぶんの刻み。パスをまたいでタップ数倍になる。
export function streakStride(pass: number): number;

// direction は画面上の単位ベクトル、stride は 1 タップぶんの刻み [読み元のテクセル]。
// 重みの総和はグラフの中で積み直すので、刻みが変わっても核の総和は 1 のまま。
export function streakPass(
  source: THREE.Texture, texel: Vec2Uniform, direction: Vec2Uniform, stride: FloatUniform,
): Vec3Node;
```

- タップ数 `STREAK_TAPS = 12` は**全フィルタで同じ**なので、JS の `for` 展開のまま残す。
  展開の形が同じなら本文は変わらない。
- `distance = stride.mul(step)`、`weight = exp(distance.div(-STREAK_FALLOFF))`、
  オフセットは `direction.mul(distance)`。いま `spreadAt(source, texel, x, y)` が数値の
  x/y を受けているので、`Vec2Node` のオフセットを受ける口を足す(縮小・拡大は全フィルタで
  同じ定数を使うので、数値版のまま触らない)。
- `total` は 12 項を `.add()` で畳んだ `FloatNode` にする。等比級数の閉じた式にはしない
  — タップの展開と 1 対 1 に読めるほうがよい。

`lens-pass.ts` の条の鎖:

```ts
const direction: Vec2Uniform = uniform(new THREE.Vector2(Math.cos(angle), Math.sin(angle)));
const stride: FloatUniform = uniform(streakStride(pass));
const gain: FloatUniform = uniform(last ? 1 / STREAK_DIRECTIONS : 1);
return createFilter((texel) => streakPass(from, texel, direction, stride).mul(gain), last);
```

利得は `streakPass(...).mul(gain)` として呼び側で掛ける(`.mul(last ? … : 1)` を uniform へ
置き換えるだけ)。拡大段も同様に `const coarserWeight = uniform((LEVELS - 1 - i) / (LEVELS - i))`
を作って `mix(..., coarserWeight)` へ渡す。

**uniform を増やすとマテリアルごとのグラフ構築(30 回)は減らないが、本文が揃うので
`createShaderModule` と `createRenderPipeline` の回数が減る。** 高いのは後者なので、これで
足りる。

### 達成条件と検証

- `grep -n "Math.cos\|Math.sin\|Math.exp\|STREAK_TAPS \*\*" src/render/pipeline/lens-kernels.ts`
  が `streakStride` の中の `STREAK_TAPS ** pass` 以外に当たらない。
- `npm run typecheck`。
- `npm run render-lab:shot` を実行し、`leo` / `sun-1au` / `sun-5au` / `sun-30au` /
  `earth-terminator`(条とゴーストがいちばん強く出る)の PNG が変更前と一致する。
  **`memos/mikanixonable/protein-motion-baseline.json` が書き換わるので、
  タンパク質の数値が動く理由がないこの手順では `git checkout` で戻す。**
- シェーダ本数の確認(達成目標 1)は、手順 5 まで終えてから下の「本数の数え方」で 1 回だけ行う。

---

## 手順 2. 曲線の頂点カラーを常時有効にする

### 目的

`Curve` は `colorAt` を渡されたかどうかで `material.vertexColors` を実行中に立て下げする。
`vertexColors` は `getMaterialCacheKey` に入る boolean なので、**切り替わった瞬間に別の
シェーダとしてグラフが組み直される。** 色属性は生成時から束縛済みなので、常に有効にして
色を渡されないときは白を焼けば、切り替え自体が要らなくなる。**絵は変えない**(白の乗算は
恒等)。

### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/render/curve.ts` | 生成時のマテリアルへ `vertexColors: true` を入れる。`hasVertexColors` と `useVertexColors` を消す。`pushVertex` が `colorAt` を持たないときは色バッファへ 1,1,1 を書く。`writePositions` は色属性を常に `needsUpdate` にする |

- [curve.ts:219-223](src/render/curve.ts#L219-L223) のマテリアル生成、
  [curve.ts:258-272](src/render/curve.ts#L258-L272) の `pushVertex` / `bakeColor`、
  [curve.ts:370-383](src/render/curve.ts#L370-L383) の切り替え、
  [curve.ts:397](src/render/curve.ts#L397) の `needsUpdate` が対象。
- `bakeColor` は `colorAt` を必須にしたまま、呼び側で `colorAt` が無いときに白を書く小さな
  分岐を持つ形にする(色バッファへの書き込みが 1 か所に残る)。

### 達成条件と検証

- `grep -n "vertexColors" src/render/curve.ts` が生成時の 1 行だけに当たる。
- `npm run typecheck`。
- `npm run render-lab:shot` の `order`(色つきの線を出すケース)が変わらない。
- 実機(`npm run dev`)で軌道線を出し、色つきの軌道線(接近予報)と単色の軌道線が
  どちらも同じ色で出ることを目で見る。

---

## 手順 3. 積雲の殻の天体依存の定数を uniform へ移す

### 目的

`CumulusShell` は `groundRadius` / `grainFrequency` / `gradientAngle` を天体の半径から
JS で計算して定数としてグラフへ焼く。いま殻を持つ天体は地球だけなので本数は増えていないが、
**2 体目を足した瞬間にシェーダが 2 倍になる構造**になっている。遮蔽側
(`pipeline/sun-occlusion.ts`)は既に `cumulusSurfaceRadius` という uniform から
`grainFrequency` を割り出しているので、殻をそちらへ揃える。**絵は変えない。**

### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/render/cumulus-shell.ts` | 3 つのフィールドを `FloatUniform` にし、使っている 4 か所をノード演算へ直す |

```ts
private readonly groundRadius: FloatUniform;   // uniform(1 / shellScale)
private readonly grainFrequency: FloatUniform; // uniform(bodyRadius / CUMULUS_GRAIN_SIZE)
private readonly gradientAngle: FloatUniform;  // uniform(0.5 / grainFrequency の値)
```

- `marchEnd` の `half.add(this.groundRadius * this.groundRadius)` →
  `half.add(this.groundRadius.mul(this.groundRadius))`。
- `cloudTopRadiusOf` の `cloudTop.mul(1 - this.groundRadius).add(this.groundRadius)` →
  `cloudTop.mul(this.groundRadius.oneMinus()).add(this.groundRadius)`。
- `grainAt(direction, this.grainFrequency, …)` は `grainAt` が既に `FloatNode | number` を
  受けるのでそのまま。
- `cloudTopNormalAt` の `.mul(this.gradientAngle)` / `.div(this.gradientAngle)` はノード同士の
  演算になるだけ。**`shellScale`(メッシュのスケール)は JS 側の値のままでよい** — これは
  グラフに入らない。

### 達成条件と検証

- `grep -n "this.groundRadius\|this.grainFrequency\|this.gradientAngle" src/render/cumulus-shell.ts`
  の全行が、数値演算ではなくノード演算になっている。
- `npm run typecheck`。
- `npm run render-lab:shot` の `earth` / `earth-oblique` / `earth-polar` /
  `earth-polar-terminator` / `earth-terminator` が変わらない。**雲の粒と雲頂の法線が
  いちばん敏感**なので、ここが一致すれば移し替えは正しい。

---

## 手順 4. 環の帯のマテリアルを種類ごとに 1 枚へまとめる

### 目的

`createAnnulusRing` / `createRingLine` / `createTorusRing` は帯ごと、さらにアークで切った
扇形ごとに新しいマテリアルを作る。登録されている環は木星 4・土星 9・天王星 13・海王星 5
(アダムス環はアーク 5 本で 11 扇形へ割れる)・カリクロー 2・クワオアー 2 で、
**マテリアルは 86 枚**になる。本文は同じなので GPU のシェーダは増えないが、**86 回ぶんの
グラフ構築が、環を持つ天体が画面へ入るたびに分散して走る。** 帯ごとの値を頂点属性へ移して
マテリアルを共有すれば 2 枚で済む。

**この手順は絵を変えない**が、環軸の与え方だけが変わる(uniform → モデル行列から引く)。

### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/render/ring.ts` | 共有マテリアルを持つ `RingMaterials` を新設。`ringOpticsNodes` を属性読みへ書き換え、`physicalMaterial` / `lineOpticsMaterial` を削除。3 つの `create*Ring` の引数を差し替え |
| `src/game/celestial/celestial-entity/ring-view.ts` | `RingVisualState` を捨て、線の被覆率だけを毎フレーム渡す。環軸の同期を消す |
| `src/game/celestial/celestial-entity/celestial-entity.ts` | `build` の引数を `(scene, ringMaterials)` へ |
| `src/game/celestial/celestial-entity/sphere-entity.ts` | 同上 |
| `src/game/celestial/celestial-entity/point-entity.ts` | 同上 |
| `src/game/celestial/celestial-system.ts` | `build` で `RingMaterials` を 1 つ作って配り、`dispose` で解放する |
| `tools/render-lab/cases.ts` | `ringDisc` を `RingMaterials` 経由にし、`userData.ownsMaterial` を立てるのをやめる |

新しい口:

```ts
// src/render/ring.ts
// 環の帯が使うマテリアル。全天体・全帯で共有するので、作るのも解放するのも 1 か所。
export class RingMaterials {
  constructor(sunOcclusion: SunOcclusion, sunLight: SunLight);
  readonly surface: THREE.MeshBasicNodeMaterial;  // annulus と annular prism
  readonly line: THREE.LineBasicNodeMaterial;
  dispose(): void;
}

export interface RingVisual {
  readonly object: THREE.Object3D;
  // 自前の geometry だけを解放する。マテリアルは RingMaterials が持つ。
  readonly dispose: () => void;
}
// 線の帯だけが、見かけ幅ぶんの減光を毎フレーム受ける。
export interface RingLineVisual extends RingVisual {
  readonly setCoverage: (coverage: number) => void;
}

export function createAnnulusRing(
  optics: RingOpticsDef, innerRadius: number, outerRadius: number,
  materials: RingMaterials, arcs?: readonly RingArcDef[],
): RingVisual;
export function createRingLine(
  optics: RingOpticsDef, radius: number,
  materials: RingMaterials, arcs?: readonly RingArcDef[],
): RingLineVisual;
export function createTorusRing(
  optics: RingOpticsDef, innerRadius: number, outerRadius: number, thickness: number,
  materials: RingMaterials,
): RingVisual;
```

帯ごとの値の運び方:

- **静的な光学値は頂点属性 `ringOptics`(vec3 = 光学的深さ・単散乱アルベド・位相 g)。**
  扇形ごとの `opticalDepthScale` は、いまと同じく `normalOpticalDepth` へ掛けた値を書く。
  1 つのジオメトリの全頂点へ同じ 3 値を書くだけ。
- **被覆率は線だけの頂点属性 `ringCoverage`(float)。** `setCoverage` が全頂点へ同じ値を
  書いて `needsUpdate` を立てる。面(annulus / prism)は常に 1 なので、`surface` 側の
  グラフは属性を読まずに 1 を使う。
- **環軸は `normalize((modelWorldMatrix * vec4(0, 0, 1, 0)).xyz)` で引く。** 帯のジオメトリは
  XY 平面に組んで `rotation.x = RING_TILT` で寝かせてあるので、メッシュのローカル +Z が
  そのまま環面の法線。`RingView` は `spinOrientation(axis, 0)`(モデルの +Y を軸へ向ける)を
  group へ入れているので、いま uniform で渡している `ringAxis` と一致する。
  **`RingVisualState` と `sync` は不要になる。**
- **使っていない属性を落とす。** グラフは `positionWorld` しか読まないので、`RingGeometry`
  からは `normal` と `uv` を `deleteAttribute` し、`annularPrism` からは
  `computeVertexNormals()` を外す。これで annulus と prism のジオメトリの鍵が揃い、
  グラフ構築が 2 回 → 1 回になる(線は非 index なので別)。

`ring-view.ts` の毎フレームの仕事は、姿勢と `group.scale` を合わせるのと、
`showAnnulus` の切り替えと、線への `setCoverage` だけになる。

### 達成条件と検証

- `grep -n "NodeMaterial(" src/render/ring.ts` が `RingMaterials` の中の 2 行だけに当たる。
- `grep -rn "RingVisualState" src` が 0 件。
- `npm run typecheck` と `npm run test:render`。
- `npm run render-lab:shot` の `saturn` / `saturn-shadow`(帯・アーク・環の影)と
  `far`(小天体の細い環が線へ落ちるケース)が変わらない。
- 実機(`npm run dev`)で土星・天王星・海王星へ寄り、(a) 細い帯が 1px を割ったところで
  線へ切り替わって薄くなること、(b) 海王星のアダムス環のアークが濃く出ること、
  (c) 環の傾きに応じて透過が変わること(= 環軸が正しく引けていること)を見る。

---

## 手順 5. タンパク質の残基変位バッファを 1 本へ pool する

### 目的

`createProteinMotionBinding` は敵 1 体ごとに `residueOffsets` と `coefficients` の
`StorageBufferAttribute` を作る。storage バッファは WGSL の構造体名へノード id が入る
(`NodeBuffer_<id>`)ので、**体が 1 つ湧くたびに、その体だけのための頂点シェーダ
(素材 4 種 × G バッファ + 影パス)と compute シェーダが新しくコンパイルされる。**
これが唯一「プレイ中に湧いた瞬間」に効くもの。バッファを共有して、体ごとの区別を
**uniform のオフセット**(uniform は本文へ出ない)に移せば、シェーダの本数はアセットの
種類数(最大 4)で頭打ちになる。

### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/render/protein-motion-material.ts` | 共有バッファとスロットの自由リストを新設。binding は「スロットの借り手」に変える。`residueOffsetNode` と compute ノードをオフセット付きの読み書きへ |
| `tests/render/protein-render-bindings.test.ts` | スロットの確保・解放・枯渇と、共有バッファの内容を見るテストへ書き直す |

```ts
// 全タンパク質の残基変位を載せる共有バッファの容量。カタログ最大の残基数は 4713(6n2y)。
const PROTEIN_RESIDUE_SLOTS = 65536; // vec4 = 1 MB
const PROTEIN_MODE_SLOTS = 4096;     // float = 16 KB

export interface ProteinMotionBinding {
  readonly residueCount: number;
  readonly modeCount: number;
  // 共有バッファ上の借り位置。グラフへは uniform として入るので、本文は体をまたいで同じ。
  readonly residueBase: FloatUniform;
  readonly modeBase: FloatUniform;
  readonly modeDisplacements: THREE.StorageBufferAttribute; // アセット単位で共有(現状のまま)
  computeNode?: THREE.Node;
  disposed?: boolean;
}

// スロットが尽きたら null を返す。呼び手は motion 無しで描く。
export function createProteinMotionBinding(
  residueCount: number, modeDisplacements: Float32Array, modeCount: number,
): ProteinMotionBinding | null;
```

- **`residueOffsets` と `coefficients` はモジュールスコープの共有 `StorageBufferAttribute`
  1 本ずつ**にし、`storage()` ノードもモジュールスコープで 1 つずつ作って全 binding が
  同じ実体を指す。これで `NodeBuffer_<id>` が揃う。
- `residueOffsetNode` は `offsets.element(residueA.add(residueBase))` のように読む。
  **`residueBase` は uniform なので本文は変わらない。**
- compute ノードは binding ごとに作ったままでよい。**それぞれが自分の uniform バッファを
  持つので、1 フレームに複数体をディスパッチしても base が混ざらない。** 本文は
  `modeDisplacements` の名前でしか変わらないので、**同じアセットの体どうしは 1 本を共有する。**
- `Loop({ end: uint(binding.modeCount) })` と `uint(binding.residueCount)` も uniform へ移す
  (`Loop` の上限に uniform を渡すのは `ray-march.ts` と同じ形)。これでアセットが違っても
  本文が揃い、残るのは `modeDisplacements` の名前だけになる。
- スロットは `residueCount` ぶんの区間を確保する自由リストで回し、`dispose` で返す。
  **アセット単位で共有している `modeDisplacements` の参照数管理は今のまま。**

### 達成条件と検証

- `grep -n "new THREE.StorageBufferAttribute" src/render/protein-motion-material.ts` が
  共有バッファの 2 行と、アセット単位の `acquireModeDisplacements` の 1 行だけに当たる。
- `npm run typecheck` と `npm run test:render`。
- `npm run render-lab:shot` の `protein-*` が変わらない。**この手順は
  `memos/mikanixonable/protein-motion-baseline.json` の数値が動きうる**ので、動いたら
  差分を読んで(GPU 時間が下がるのは想定内、形が変わるのは異常)commit に含める。
- 実機の `?stage=creative` でタンパク質の敵を **同じ種類で 3 体続けて湧かせ**、
  2 体目・3 体目でフレームが飛ばないことを見る。**種類を変えた 1 体目では飛んでよい。**

---

## 本数の数え方(達成目標 1・3 の検証)

全手順のあとに 1 回だけ行う。使い捨てのプローブはスクラッチパッドへ置く。

1. `npx webpack --mode development --output-path <dir>` でビルドする
   (スタックに `src/render/pipeline/*.ts` の関数名が残る。生成される WGSL は本番ビルドと
   一致することが確認済み)。
2. `tools/chrome-session.mjs` の `openChromeSession({ serveDir: path.resolve(dir), … })` で
   配信 + ヘッドレス Chrome を上げる。**`serveDir` を `path.resolve` しないと静的サーバが
   403 を返す。**
3. `Page.addScriptToEvaluateOnNewDocument` で `GPUDevice.prototype` の `createShaderModule` /
   `createRenderPipeline(Async)` / `createComputePipeline(Async)` を包み、
   `Error.stackTraceLimit = 80` を立ててスタックごと記録する(既定の 10 段では `src/` まで
   届かない)。rAF の到来時刻も同時に取る。
4. `?stage=1` を開いて、**パイプライン本数・シェーダ本数・WGSL の総バイト数・rAF の最大欠落**を
   スタックのパスごとに集計する。
5. **プロファイルは毎回捨てる。** 使い回すと Chrome の GPU ディスクキャッシュに当たって
   1.6 秒で終わり、何も測れない。

達成目標 3 は、`?stage=creative` で同じアセットの敵を 2 体湧かせて
`createRenderPipeline` の記録が増えないことで見る。

---

## 見積り

| 手順 | 変更の量 | 効き(導出) |
| --- | --- | --- |
| 1. レンズ | 2 ファイル・約 60 行 | フラグメントシェーダ 26 → 4 本。WGSL はタップ数にほぼ比例するので、現在の 26 本のタップ総数 20(縮小)+ 9×4(拡大)+ 12×20(条)+ 14×3×4(ゴースト)= 464 が、20+9+12+168 = 209 へ。291.8 KB × 209/464 ≈ **131 KB**(−160 KB)。パイプラインは 26 → 5(条は加算合成の有無で 2 本) |
| 2. 曲線 | 1 ファイル・約 20 行 | 実行中のグラフ組み直しが 1 回消える |
| 3. 積雲の殻 | 1 ファイル・約 15 行 | いまは 0(1 体しかない)。殻を持つ天体を 1 体足すごとに 2 本ぶん節約する |
| 4. 環 | 7 ファイル・約 200 行 | グラフ構築 86 回 → 2 回。起動時に 120 本を 1.4 秒で組んだ実測(平均 12 ms/本)から、84 回ぶんで**約 1 秒**。環のグラフは平均より小さいので実際は数百 ms と見る。これは起動時に固まって来るのではなく、環を持つ天体が画面へ入るたびに分散して来る |
| 5. タンパク質 | 2 ファイル・約 250 行 | 体ごと → アセットごと。体 1 つあたり最大 8 本(素材 4 種 × G バッファ + 影)+ compute 1 本が湧いた瞬間に組まれていたのが、アセット初出の 1 回だけになる |

手順 1〜3 は互いに独立で、どれから着手してもよい。手順 4 と 5 は他のどれとも競合しない。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 条の重みの総和を JS の `total` からノードの総和へ移すとき、正規化を落とす | 条だけが明るく(暗く)なり、核の総和 1 が崩れて半精度の上限を跨ぐ。画面が NaN になりうる | 手順 1。`sun-1au` / `sun-30au` の条の明るさ |
| `spreadAt` の数値版とノード版が混ざり、縮小・拡大まで uniform 化してしまう | 本文が揃わず、シェーダが減らない(**絵は変わらないので気づけない**) | 手順 1。本数の数え方で縮小・拡大が 1 本ずつになっているか |
| `vertexColors` を常時有効にしたのに、色を渡されない曲線へ白を焼き忘れる | その曲線が黒く消える(色属性の初期値が 0) | 手順 2。`order` ケースと、実機の単色の軌道線 |
| `groundRadius` を uniform にしたとき `1 - x` を `x.oneMinus()` へ直し忘れて数値演算のまま残す | 型が通ってしまう箇所があると雲頂の高さが定数へ落ちる | 手順 3。`earth-polar` の雲頂の起伏 |
| 環軸をモデル行列から引くとき、group のスケール(`bodyRadius`)を正規化で吸い忘れる | 透過率 `exp(-tau/|N·V|)` の分母が桁で狂い、環が真っ黒か真っ白になる | 手順 4。`saturn` |
| 環のジオメトリから `normal` / `uv` を落としたことで three が別の経路へ落ちる | 環が描かれない、または例外 | 手順 4。`saturn` が空になる |
| 共有マテリアルを `RingVisual.dispose` が解放してしまう | 2 体目の天体を解放した瞬間に全部の環が消える | 手順 4。`tools/render-lab/cases.ts` の `userData.ownsMaterial`、`CelestialSystem.dispose` |
| pooled な `residueOffsets` のスロットを解放し忘れる / 二重に返す | 別の体の変位を読んでタンパク質が壊れた形で描かれる。スロットが尽きると motion が止まる | 手順 5。敵を湧かせては壊す操作を繰り返したときの形 |
| compute ノードを binding ごとではなく 1 本共有にしてしまう | 同じ uniform バッファへ複数体の base を書くので、1 フレームに 2 体以上いると**最後の体の変位だけが全体へ出る** | 手順 5。同じアセットの敵を 2 体同時に出したとき |
| `render-lab:shot` が `memos/mikanixonable/protein-motion-baseline.json` を書き換える | 手順 1〜4 で無関係な差分が commit へ入る | 手順 1〜4。commit 前の `git status` |
| 撮り直しで PNG が揺れる(半影を持つケースで ±4 LSB) | 変わっていないものを「変わった」と読む | 全手順。差分を根拠にする前に撮り直す |
