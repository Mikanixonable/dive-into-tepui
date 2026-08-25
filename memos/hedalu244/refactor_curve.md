# Curve モジュールの利用の是正

## 目的

`src/render/curve.ts` の `Curve` は「t∈[0,1] の媒介変数関数を渡せば、画面上のサジッタと折れ角を
見て自分で必要なだけ細かく分割する」機構である。頂点をどこに置くかは Curve が決め、曲線が
どんな形かはサンプラが決める、という責務分担で立っている。

後から入った利用者はこの分担を理解しておらず、次の4つが起きている。

1. **サンプラが折れ線を返している。** `GuideCurve` は事前に確定した `Vec3[]` を線形補間して返す
   ため、適応分割は入力の折れ線を超える精度を作れない。Curve の中核が無効化されている。
2. **「滑らかに見えない」を、サンプラの外側でサンプル数を増やすことで対処する回帰が起きている。**
   `49441125 ハロー軌道を滑らかに` は `HALO_SAMPLES` を 128→512 にした。焼き込みカタログの
   点列は変わっていないので、これは線形補間サンプラによって Curve の適応分割が無効化されている
   ことへの対処であって、角ばる原因そのものを直していない。
3. **サンプル数がサンプル列の代わりに Curve の境界を越えている。**
   `cbda467d perf: cache decoded families and skip lines that cannot exist` は
   「long paths keep their shape」を理由にリサジューのサンプル数を周回数に比例させた。
   **サンプル数の下限が周回数に比例すること自体は正しい** — エルミート補間が縮退しない最小限は
   周回数に比例する。誤っているのは境界の引き方で、解析的に解けるなら解析サンプラを渡し、
   解けないならサンプル列そのものを渡すべきところを、「周回数」という数だけを渡している。
4. **Curve 自身も、呼び出し側から渡された情報を捨てている。** `initialTs` を
   `INITIAL_SEGMENT_BUDGET_RATIO` で間引き、そのあと適応分割で同じ点を復元し直している。

サンプル数の決め方そのものは、`src/game/const.ts` の `TRAJECTORY_SAMPLES_PER_REV`（1周回あたり
32点、補間誤差 30m の実測から）や `ARC_STEPS_PER_REV`（1周回あたり 300 歩、形状誤差がマップ 1px
未満になる実測から）が正しい形をしている。**「1周回あたり何点なら補間が破綻しないか」を実測から
決めるのはサンプラ側の仕事で、「画面上で何 px 曲がって見えるか」は Curve の仕事である。**

修正後に期待される状態: 曲線の滑らかさは「サンプラが滑らかな値を返すこと」だけで決まり、
サンプル数の定数は「エルミート補間が縮退しない最小限」を表す値としてのみ残る。画面上の
細かさに関わる定数は `Curve` の中にしか無い。

## 決めたこと

ユーザーが覆せる。覆したときに変わる手順を各項の末尾に書く。

### 決定1. `Curve` は初期頂点列を間引かない。予算超過は契約違反として throw する

間引きは「呼び出し側が知っている細部の位置」を捨てる操作で、適応分割はそれを推測し直せない。
`INITIAL_SEGMENT_BUDGET_RATIO` と `seedStride` を削除し、初期頂点列は全点を頂点にする。
節点の個数が `maxVertices` を超えるのは予算の設定ミスなので throw する（`hermiteInterpolate` が
区間外の t を throw するのと同じ扱い。黙って間引くフォールバックは置かない）。

→ 覆した場合: 手順3が消え、手順2で `initialTs` を外す動機だけが残る。

### 決定2. 滑らかさはサンプラの責務。点列しか持たないサンプラは接線を持たせてエルミート補間する

サンプル数を増やすのではなく、`src/physics/kinematic-state.ts` の `hermiteInterpolate` と同じ
3次エルミート（両端の位置を通り、両端の接線を持つ）で埋める。サンプル数が意味を持つのは
「エルミート補間が縮退・破綻する」場合、すなわち1周あたり数点しか無いなど、区間内の曲率が
3次多項式で表せない場合だけである。

解析的に位置が求まる曲線（参照軌道4種・リサジュー）は、点列を経由せず解析関数を直接サンプラ
にする。この場合サンプル数の定数そのものが消える。

→ 覆した場合: 手順4・手順5が消える。

### 決定3. 焼き込みカタログは速度を持ち、1メンバーの点数を 96→48 へ下げる

`tools/export-lagrange-orbits.mjs` は RK4 で6次元状態を積分しているのに、焼き込み時に速度を
捨てて `[x, y, z, tFrac]`（`CATALOG_STRIDE = 4`）だけを残している。これを
`[x, y, z, tFrac, vx, vy, vz]`（`CATALOG_STRIDE = 7`）にし、点数を 48 へ下げる。

サイズの算数（現状 `src/assets/orbits/lagrange-orbits.json` は 4.14MB、うち `points` の base64 が
3.93MB = 95%）:

- 現状: 1メンバー 96点 × 4値 × 4B = 1536B
- 変更後: 1メンバー 48点 × 7値 × 4B = 1344B（**12.5% 減**）
- バンドル2系: 4.14MB → 約 3.67MB（目標 `BUNDLE_SIZE_TARGET = 4.9MB` の内側。
  `SAMPLES_FALLBACK` への退避は起きない）
- 遅延ロード5系の合計: 8.76MB → 約 7.66MB

**点数を半分にしてなお、線は今より滑らかになり、アセットは小さくなる。** これが決定2の実証に
なっている。

→ 覆した場合: 手順5は「デコード時に隣接点の中心差分で接線を作る（アセット非変更）」へ縮む。
残る問題は接線が O(h²) の近似になること — 曲線は C¹ になるので見た目には出ないが、
「速度が求まるのに使わない」状態が残り、同じ議論が将来また起きる。

### 決定4. 単色の線に `colorAt` を渡さない。頂点カラーはマテリアル色に乗算されることを型で明示する

three.js の頂点カラーは `diffuseColor *= vColor` である。`styleFor` はリサジュー・参照軌道・
模式図に対して定数色の `colorAt` を返しており、マテリアル色と頂点色が二重に掛かっている。
模式図（`SCHEMATIC_LINE = 0x101014`）ではリニア空間で 0.005 の2乗となり、線が黒く潰れる。

### 決定5. `revision` を色の焼き直しトリガに流用しない。`Curve` に色だけ焼き直す経路を足す

`revision` は「サンプラの中身が変わったこと」を表す値である。`GuideCurve.setStyle` /
`invalidateColors` が `revision = {}` を代入しており、色だけの変更で幾何の全再分割が走る。
焼いた頂点とその t を持っているのは `Curve` なので、色だけ焼き直す責務も `Curve` にある。

### 決定6. `Curve` の入口を2つに絞り、`setCurve` を private にする

`Curve` の正しい利用は2種類しかない。

- **種類A: 解析サンプラ。** 曲線が t の閉じた式で書けるとき。初期頂点列は t の等分で足りる。
- **種類B: 数値サンプル列 + エルミート補間。** 曲線が離散サンプルとしてしか手に入らないとき。
  節点の位置と接線から3次エルミートでサンプラを組み、節点自身の位置を初期頂点にする。

`Curve` が作られた当初はどちらも1箇所ずつ（`OrbitLine` と `TrajectoryLine`）だったので、
責務のない関数を避けて個別に実装されていた。本計画の完了時点で種類Aは3箇所、種類Bは3箇所に
増えるので、重複を `Curve` 自身のメソッドへまとめる。

```
setAnalyticCurve(sample: CurveSampler, opts: SetCurveOptions): void
setHermiteCurve(knots: CurveKnots, opts: SetCurveOptions): void
sampleAt(t: number, out: THREE.Vector3): void   // いま描いている曲線を評価する
private setCurve(...)                            // 上の2つだけが呼ぶ
```

- `SetCurveOptions` から `initialTs` を外す。種類Aの初期区間数は
  `SetCurveOptions.initialSegments`（省略時 `INITIAL_SEGMENTS`）、種類Bの初期頂点は節点そのもの。
- `CurveKnots` は `{ count, at(i), position(i, out), tangent(i, out) }`。節点の格納形は
  呼び出し側ごとに違う（`Float32Array` のストライド・`KinematicState[]`・`Vec3[]`）ので、
  配列そのものではなくアクセサを受け取り、呼び出し側に詰め替えを強いない。
- 予算検査（節点数 ≤ `maxVertices`、決定1）は `setHermiteCurve` の中で閉じる。
- `sampleAt` は直近に渡されたサンプラをそのまま評価する。**進行方向マーカーと右クリックの
  当たり判定が、描かれている線と同じ曲線を読むための入口。** これが無いと、種類Bのエルミート
  補間を呼び出し側でもう一度書くことになる。

`setCurve` を private にするのは、最後の呼び出し側が移り終わる手順7。それまでは移行のため
public のまま残す。

**ヘルパー関数がオプションを返す形は採らない。** 中間の `{ sample, initialTs }` を呼び出し側に
持たせると、そこで組み替えられてしまい「2種類しかない」が型で保証されない。`setCurve` を
private にすれば、**任意のサンプラと任意の初期頂点列の組み合わせを外から作れなくなる** —
再発防止が規約ではなく型の性質になる。

**ラッパーモジュールは新設しない。** 種類A/種類Bは用途が紛らわしく、モジュールに分けると
薄いラッパーになる。`Curve` の契約そのものなので `curve.ts` の中に置く。

→ 覆した場合: 手順3のメソッド新設と手順7が消え、各呼び出し側が個別にエルミート補間を書く。
残る問題は、同じ誤用が次の利用者でまた起きること — 正しい使い方が名前を持たないままになる。

## 達成目標

全手順の実施後、以下がすべて満たされること。

1. `grep -rn "initialTs" src/` が `src/render/curve.ts` の1ファイルだけになる
   （初期頂点列は `Curve` の外へ出ない）。
2. `grep -rn "INITIAL_SEGMENT_BUDGET_RATIO|seedStride" src/` が 0 件。
3. `grep -rn "REFERENCE_ORBIT_SAMPLES|LISSAJOUS_POINTS_PER_CYCLE|LISSAJOUS_VERTEX_BUDGET" src/`
   が 0 件。
4. `grep -rn "initialTsCache" src/` が 0 件。
5. 点列を線形補間する `CurveSampler` が `src/` から無くなる。`Curve` へ渡されるサンプラは
   すべて、解析関数（種類A）かエルミート補間（種類B）のどちらかである。
6. `grep -rn "revision = {}" src/game/celestial/` が、サンプラが差し替わる箇所だけになる
   （色・不透明度の変更では呼ばれない）。
7. `src/render/curve.ts` のモジュール先頭コメントに、「Curve が決めること」と
   「サンプラが満たすべきこと」が分けて書かれている。
8. 3次エルミート補間の実装が `src/render/curve.ts` の `setHermiteCurve` の1箇所だけになる
   （`src/physics/kinematic-state.ts` の `hermiteInterpolate` は `KinematicState` 用の別物として
   残る）。t を等分した初期頂点列を組むコードも `Curve` の中の1箇所だけになる。
9. `Curve` の公開された曲線の入口が `setAnalyticCurve` / `setHermiteCurve` の2つだけになり、
   `setCurve` が private になっている。**サンプラと初期頂点列を任意に組み合わせた呼び出しが、
   型として書けない。**
10. `Curve` の境界を越えるのは、サンプラ・節点アクセサ・初期区間数・頂点予算だけになる。
    「周回数」「サンプル数」といった、サンプラの内部で決まるべき数が漏れていない。
11. 表示パネルの軌道ガイドタブで、模式図 → realistic を往復したあとガイド線の色が元へ戻る。
12. マップビューでモルニヤ軌道の近点へズームインしたとき、近点が多角形に割れない。
13. `npm run typecheck` / `npm run test:physics` / `npm run render-lab:shot` が通る。

## 前提(実施済みの手順が確定させたこと)

- `GuideCurve` は `setSampler(origin, sample)` / `clear()` / `samplePoints(count)` を持ち、
  `Curve` へ `initialTs` を渡さない。曲線の中身は呼び出し側が組む。
- 点列の線形補間は `guide-curve.ts` の `polylineSampler(points, origin, closed)` 1箇所だけに
  ある。**手順5・手順6 で両方の呼び出し側がエルミートへ移ったら、この関数ごと削除する。**
- `OrbitGuideLines.visibleLines(sampleCount)` は当たり判定用の点列を曲線から引き直す。
  輪を閉じるかどうかは `GuideLoop.closed` が決める。
- 線のマテリアル色は `styleFor` が毎フレーム組む。頂点カラー(`colorAt`)を持つのは族の
  グラデーション線だけで、単色の線は `colorAt` を渡さない。

## 手順

### 手順3. `Curve` の契約を確定させ、2種類の利用をヘルパーとして提供する

**目的**

呼び出し側が渡した `initialTs` を間引くのをやめ、Curve の責務分担
（何を Curve が決め、何をサンプラが満たすべきか）をモジュールコメントに書く。併せて、
正しい2種類の利用（種類A / 種類B）に名前を与え、以降の手順が寄せる先を作る。
**再発防止の本体はこの手順にある。** この時点では呼び出し側を移さないので、
**描かれる形は変わらない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/curve.ts` | `INITIAL_SEGMENT_BUDGET_RATIO`(67行目) と `seedStride`(344-347行目) を削除。`rebake`(352行目) は初期頂点列の全点を頂点として積む。モジュール先頭コメント(1-5行目)・`CurveSampler`(22行目) のコメントを下記の内容へ書き直す |
| `src/render/curve.ts` | `setAnalyticCurve(sample, opts)` を新設。`SetCurveOptions` から `initialTs`(40行目) を外し、代わりに `initialSegments?: number`（省略時 `INITIAL_SEGMENTS`）を持たせる。初期頂点列は t の等分で内部に組む（区間数ごとのキャッシュを持ち、`DEFAULT_INITIAL_TS`(61-63行目) もこれに寄せる） |
| `src/render/curve.ts` | `setHermiteCurve(knots, opts)` を新設。`CurveKnots` は `{ count, at(i), position(i, out), tangent(i, out) }`。`at` は昇順かつ [0,1] の両端を含むこと、`count <= maxVertices` であることを事前条件とし、破れば throw する |
| `src/render/curve.ts` | `sampleAt(t, out)` を新設し、直近に渡されたサンプラをそのまま評価する。`setCurve`(381行目) は private にせず残す（手順7で閉じる） |

書くべき内容（責務の内側だけを書く。呼び出し側の事情は書かない）:

- **Curve が決めること**: 頂点を t のどこに何個置くか。画面上のサジッタ・折れ角の目標、
  ズーム／視線変化に対する焼き直しの要否、f32 の量子化を避ける基準点。
  **呼び出し側はこれらに一切関与しない。**
- **サンプラが満たすべきこと**: t∈[0,1] で連続かつ滑らか（少なくとも C¹）であること。
  **サンプラが折れ線を返せば、描かれるのも折れ線である** — 適応分割は入力を超える精度を
  作らない。**線が角ばるときに直すのはサンプラであって、初期分割数ではない。**
- **入口が2つしかないこと**: 解析関数を渡す（`setAnalyticCurve`）か、節点の位置と接線を渡す
  （`setHermiteCurve`）か。**どちらにも当てはまらないサンプラを書いているなら、それは
  間違っている。**
- **`initialSegments` の意味**: 適応分割は弦の中点しか見ないので、1区間に何周ぶんも入る曲線では
  中点がたまたま曲線上に乗り、分割済みと誤判定して区間まるごとが直線に化ける。
  **これを防ぐためだけの値で、細かさを決めるためではない。** 1周ぶんの曲線なら省略してよい。
- **初期区間数の決め方はサンプラ側の話であること**: 種類Aなら「1区間が曲線の半周を超えない」
  下限、種類Bなら節点そのもの。**どちらも「何 px 曲がって見えるか」とは無関係で、
  そこは Curve が決める。**

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -rn "INITIAL_SEGMENT_BUDGET_RATIO|seedStride" src/` が 0 件。
- 着手前に `grep -rn "initialTs" src/game/` が `trajectory-line.ts` だけであることを確認する。
- `setHermiteCurve` に、節点が2個・節点間隔が不均等・パラメータが降順（throw する）・
  `count > maxVertices`（throw する）の4ケースを当てて手元で1度確認する
  （`src/render/` は THREE 依存でテスト対象外なので、テストファイルは残さない）。
- `npm run render-lab:shot` が通る（`tools/render-lab/cases.ts:111` の円が今までどおり出る）。
- マップビューで自艦の予測線を 28 日表示にし、線が途中で直線に化けないことを目で見る
  （`trajectory-line.ts` の `initialTs` が間引かれずに効くようになる箇所）。

### 手順4. 参照軌道4種とリサジューを解析サンプラへ移す

**目的**

`elementsLoop` と `lissajousLoop` は解析関数を固定点数へ焼いてから渡している。点列を経由せず
解析関数をそのままサンプラにし、サンプル数の定数を消す。ここが `49441125` / `cbda467d` と
同じ回帰の最も起きやすい箇所である。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/orbit-guide.ts` | `GuideLoop`(22-30行目) から `points` / `times` を外し、`sample: CurveSampler`（u は周期に対する経過時刻の割合）・`initialSegments`・`closed` / `period` / `jacobi` / `stability` を持つ形にする。`elementsLoop`(275-286行目) の `REFERENCE_ORBIT_SAMPLES` ループを廃止し、`positionOnOrbit(el, trueAnomalyFromMean(2πu, e))` を直に返す（`initialSegments` は省略でよい）。`lissajousLoop`(235-267行目) の `samples` 引数とループを廃止し、`richardsonState` を u から直に評価する。**`initialSegments` は `ceil(cycles * 2)`** — 1区間が半周を超えないための下限であって、細かさではない |
| `src/game/celestial/orbit-guide-lines.ts` | `LISSAJOUS_POINTS_PER_CYCLE`(27行目) / `LISSAJOUS_VERTEX_BUDGET`(29行目) を削除し、頂点予算は `CATALOG_LINE_VERTEX_BUDGET` へ統一する。`computeLoop`(287-320行目) の `lissajousLoop` 呼び出しから `samples` 引数を外す（`cycles` は既に渡しているので、初期頂点数は `orbit-guide.ts` 側で閉じる） |
| `src/game/celestial/direction-markers.ts` | `placeMarker`(116-135行目) の `times` 二分探索を廃止し、`GuideCurve.pointAt(phase)` と `pointAt(phase ± ε)` から位置と接線を取る（**描かれている曲線そのものを読む**）。`addLoop`(96行目) は `GuideLoop` ではなく `GuideCurve` と描き方を受け取る。`MANY_MARKER_STRIDE`(17行目) は点数から個数を導いているので、固定個数（現状と同じ 4〜8 個相当）へ置き換える |
| `src/game/celestial/guide-curve.ts` | `setSampler` の隣に `setAnalytic(origin, sample, initialSegments?)` を足し、リサジュー・参照軌道はこちらを通す。`samplePoints` を `Curve.sampleAt` 経由の `pointAt(u, out)` + `samplePoints(count)` にする（当たり判定とマーカーが同じ曲線を読む） |
| `tests/physics/orbit-catalog.test.ts` | `loop.points.length`(120行目) を使う検査を、`GuideLoop` の新しい形（解析サンプラ / 節点）に合わせて書き換える |

描画サンプラは**離心近点角 E で媒介変数化する**（`src/game/orbit-line.ts:65-77` と同じ形）。
`trueAnomalyFromMean` は Newton 反復を含むので、頂点1つごとに解かせない。時刻の割合が要るのは
マーカー（1本あたり最大12個）だけなので、Kepler を解くのはそちらだけになる。

**達成条件と検証**

- `npm run typecheck` / `npm run test:physics` が通る。
- `grep -rn "REFERENCE_ORBIT_SAMPLES|LISSAJOUS_POINTS_PER_CYCLE|LISSAJOUS_VERTEX_BUDGET" src/`
  が 0 件。
- `npm run render-lab:shot` が通る。
- マップビューで参照軌道の「モルニヤ」を ON にし、近点へズームインして**多角形に割れないこと**
  を目で見る（達成目標9）。リサジューを ON にし、周回数スライダーを最大にしても線が角ばらない
  ことを目で見る。進行方向マーカーが近点で速く・遠点で遅く動くことを目で見る
  （`times` を廃止したあとも保たれること）。

### 手順5. 焼き込みカタログに速度を持たせ、エルミートサンプラへ移す

**目的**

カタログの点列は本当に離散データだが、焼き込み時には速度が手元にある。これを持たせて
エルミート補間で埋め、点数を半分にする。これで4種類のガイド線すべてが C¹ のサンプラになる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/cr3bp.ts` | `sampleOrbitByArcLengthWithTime`(133-157行目) が位置・時刻に加えて速度も返すようにする（`path` に6次元状態を持ち、辺の内分で速度も内挿する）。返り値の型 `Vec3TimeTuple`(127行目) を差し替える |
| `tools/export-lagrange-orbits.mjs` | `SAMPLES_DEFAULT`(26行目) を 96→48、`SAMPLES_FALLBACK`(27行目) を 64→32。`bakeMember`(79行目) / `bakeSystem`(99行目) の `chunk` を1点7値で書く |
| `src/physics/orbit-catalog.ts` | `CATALOG_STRIDE`(54行目) を 4→7。`CatalogFamily.points`(33行目) のコメントを `[x, y, z, tFrac, vx, vy, vz]` へ直す |
| `src/physics/orbit-guide.ts` | `catalogLoop`(176-215行目) が `CurveKnots` を返すようにする（`GuideLoop` は解析サンプラか節点かの直和になる）。節点アクセサは焼き込みの `Float32Array` をストライド 7 で直に読む（詰め替えない）。パラメータは tFrac、接線は 速度 × 周期。メンバー間の内分(`mix`)は速度成分にも掛ける |
| `src/game/celestial/guide-curve.ts` | `setHermite(origin, knots)` を足し、焼き込み族の線はこちらを通す |
| `src/assets/orbits/*.json` | `npm run export-lagrange-orbits` で全6ファイルを焼き直す |
| `tests/physics/orbit-catalog.test.ts` | `CATALOG_STRIDE` 依存の添字(57 / 70-73 / 89-102行目)を 7 前提へ直し、速度成分の健全性（有限・非ゼロ）を検査に足す |

**達成条件と検証**

- `npm run typecheck` / `npm run test:physics` が通る。
- `npm run export-lagrange-orbits` の出力ログで、バンドル2系が `BUNDLE_SIZE_TARGET`(4.9MB) 以内
  かつ「点数を落として焼き直す」の警告が出ないこと。
- `ls -la src/assets/orbits/` で `lagrange-orbits.json` が 4.14MB → 3.6〜3.8MB になっていること。
- `npm run render-lab:shot` が通る。
- マップビューで地球-月系のハロー軌道族を ON にし、線へズームインして**角ばらないこと**を
  目で見る（`49441125` が 128→512 で対処しようとした症状）。

### 手順6. ゼロ速度曲線を種類Bへ移し、頂点予算を実データ量から決める

**目的**

ゼロ速度曲線は滑らかな関数 2Ω の等位集合であり、マーチングスクエアの出力はその数値サンプルに
すぎない。手順2で残した線形補間サンプラを、隣接点の中心差分を接線とするエルミート補間へ移す。
これで `Curve` へ渡るサンプラが**すべて種類Aか種類Bのどちらか**になる（達成目標5）。
併せて `VERTEX_BUDGET = 2000` を実点数から決める。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/zero-velocity-lines.ts` | `reembed`(186-211行目) で組むサンプラを、`GuideCurve.setHermite` へ `points3d` の節点アクセサを渡す形へ置き換える。パラメータは点の添字を [0,1] へ正規化した値、接線は隣接点の中心差分（`closed` なら端は巻き戻して取る、開いた成分の端は片側差分） |
| `src/game/celestial/zero-velocity-lines.ts` | `VERTEX_BUDGET`(40行目) を削除し、`rebuildShapes`(143-183行目) で `GuideCurve` を作るときに `shape.points2d.length` から予算を決める |
| `src/game/celestial/zero-velocity-lines.ts` | `RESOLUTION`(29行目) のコメントから「見た目」の根拠を落とす。エルミート補間へ移したあと、この値が決めるのは連結成分の判定（ネックが偽って閉じないか）だけになる |
| `src/game/celestial/zero-velocity-lines.ts` | 67-69行目の孤児コメント（共通化後に取り残された「読み取り専用ファイルにある実装をここで複製している」）を削除する |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -n "VERTEX_BUDGET" src/game/celestial/zero-velocity-lines.ts` が 0 件。
- `grep -n "複製している" src/game/celestial/zero-velocity-lines.ts` が 0 件。
- マップビューでゼロ速度曲線を ON にし、ヤコビ定数を臨界値付近（地球-月系で L1 のネックが
  開閉するあたり）へ動かして、ネックの形が今までどおり出ることを目で見る。
  **ネックの尖った角が丸まっていないこと**を併せて確認する（中心差分の接線が角を1格子ぶん
  丸めるため。丸まるなら、その成分だけ接線を片側差分へ落とすか、`RESOLUTION` を上げる）。

### 手順7. 元祖2つを新しい入口へ寄せ、`setCurve` を閉じる

**目的**

種類A・種類Bの元祖である2つが、まだ個別実装のまま残っている。新しい入口へ寄せて、
3次エルミートと等分初期頂点列の実装を1箇所ずつにする（達成目標8）。すべての呼び出し側が
移り終わるので、**`Curve.setCurve` を private にして入口を2つに閉じる**（達成目標9）。
**この時点で描かれる形は変えない** — 同じ多項式・同じ節点なので、頂点は一致する。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/trajectory-line.ts` | `sampler`(104-115行目) と `buildInitialTs`(170-183行目) を `setHermiteCurve` の呼び出しへ置き換える。節点は bake 済みの座標系相対状態のうち描画区間 `[startTime, endTime]` に入るもの（両端は区間端でクランプした節点を1つずつ足す）。パラメータは時刻を [0,1] へ写した値、接線は速度 × (end − start)。`StateQueue`(85行目/149行目) は描画のためには不要になるので、`combined` を座標系相対へ写した平配列を持つ形にする |
| `src/game/orbit-line.ts` | `sampler`(65-77行目) は解析式のままでよい。`setCurve`(107行目) を `setAnalyticCurve` へ差し替える（`initialSegments` は省略 = 1周ぶんの閉曲線）。`samplePoints`(136-148行目) は `Curve.sampleAt` 経由にし、当たり判定が描かれている線と一致するようにする |
| `src/game/celestial/guide-curve.ts` | 手順2で入れた暫定の `setSampler` を削除する（残る呼び出し側は `setAnalytic` / `setHermite` だけ） |
| `tools/render-lab/cases.ts` | `setCurve`(112行目) を `setAnalyticCurve` へ差し替える |
| `src/render/curve.ts` | `setCurve` を private にする |
| `src/physics/state-queue.ts` | 変更しない（`DynamicTrajectory` が引き続き使う） |

**達成条件と検証**

- `npm run typecheck` / `npm run test:physics` が通る。
- `grep -rn "\.setCurve(" src/ tools/` が 0 件（外から呼べる曲線の入口が2つだけになったこと）。
- `grep -rn "hermiteInterpolate" src/game/` が 0 件（描画側の3次エルミートが
  `setHermiteCurve` に一本化されたこと）。
- `grep -n "StateQueue" src/game/trajectory-line.ts` が 0 件。
- マップビューで自艦の予測線・過去線を出し、**手順6 の時点と線が一致している**ことを目で見る。
  28日表示で線が途中で直線に化けないこと、回転座標系（月固定など）へ切り替えても線が
  歪まないことを確認する。

## 見積り

**アセットのサイズ**（決定3、実測から導出）

現状 `src/assets/orbits/lagrange-orbits.json` = 4,139,359B、うち `points` の base64 が
3,934,208 文字（95.0%）、69族・1921メンバー。

- 現状: 1921 × 96点 × 4値 × 4B = 2,950,656B → base64 3,934,208 文字（実測と一致）
- 変更後: 1921 × 48点 × 7値 × 4B = 2,581,824B → base64 3,442,432 文字
- 差 −491,776 文字 ≒ **−0.47MB**。バンドル全体は 4.14MB → **約 3.67MB**
- 遅延ロード5系（合計 8.757MB）も同率 0.875 倍で **約 7.66MB**

**焼き直し1回あたりの Kepler 反復**（手順4）

`Curve` は焼き直し1回で最大 `maxVertices` 回サンプラを呼ぶ。参照軌道は
`CATALOG_LINE_VERTEX_BUDGET = 256`、線は4本。離心近点角で媒介変数化すれば描画側の Kepler 反復は
0回。マーカーは1本あたり最大12個なので 12 × 4本 × 約5反復 = **240 反復／焼き直し**。
焼き直しはカメラが 5° 回るかスケールが 1.2 倍動いたときだけで、毎フレームの負荷にはならない。

**カタログのエルミート評価**（手順5）

1サンプルあたり tFrac の二分探索 log2(48) ≒ 6 回 + 3次多項式1回。焼き込み族の線は最大
40本／種類 × 系7 なので、焼き直し1回で 256頂点 × 線数。線数280本の最大構成で
256 × 280 = 71,680 評価。1評価 100ns として **約 7ms／焼き直し**。現状の線形補間（二分探索なし）
より重いので、実測して 10ms を超えるなら tFrac の単調増加を使った線形走査
（前回の添字から進める）へ落とす。この最適化は `setHermiteCurve` の中で閉じるので、
呼び出し側は影響を受けない。

**削減される重複**（決定6）

3次エルミートで節点間を埋める実装は、完了時点で `setHermiteCurve` の1箇所になる。移行前の
実装箇所は `src/physics/state-queue.ts` の `at`（`TrajectoryLine` 経由、手順7）と、
手順5・手順6 で新たに書く2箇所 — 入口を絞らなければ **3実装** になっていた。
t を等分した初期頂点列も同様に、`DEFAULT_INITIAL_TS` / `guide-curve.ts` の `initialTsFor` /
リサジュー用の3実装が `Curve` の中の1箇所へ寄る。曲線上の点を引く経路（進行方向マーカー・
右クリックの当たり判定）も `Curve.sampleAt` の1本になり、**描かれている線と当たり判定が
食い違わない**ことが構造から従う。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `Curve.setColors` を足したが、焼き直しの直後に色を書かないと色属性が 0 のまま束縛される | ガイド線が全て黒くなる。`setCurve` が焼き直したフレームだけで起きるので、カメラを止めていると気付かない | 手順1。カメラを回しながら色を変えて確認する |
| 模式図で書き換えたマテリアル色を realistic で戻し忘れる | 模式図を一度でも通した線だけが暗いまま残り、以後に作られた線（白）と食い違う | 手順1。達成目標8 |
| `setSampler` へ渡すクロージャが古い点列を掴んだままになる | 設定を変えても線が古い形のまま残る。`revision` が変われば焼き直しは走るので、**新しいサンプラが古い配列を読む**という形でだけ起きる | 手順2。設定スライダーを動かして線が追従するか見る |
| 初期頂点列の間引きを外したが、間引きに助けられていた呼び出しが残っている | 節点数が予算を超えて throw し、線が1本も出なくなる | 手順3。手順2で先に外しておくことが前提。着手前の grep で確認する |
| `GuideLoop` から `times` を外したことで、進行方向マーカーが等速で動くようになる | 「近点で速く・遠点で遅く」が失われる。マーカーは動き続けるので注意して見ないと気付かない | 手順4。モルニヤを ON にして近点付近でマーカーが加速するか見る |
| 参照軌道の描画を離心近点角で媒介変数化したのに、マーカーの位相も同じ E で渡してしまう | マーカーの速度分布が逆（近点で遅く）になる | 手順4。同上 |
| `pointAt` の接線を有限差分で取るときの ε が小さすぎ、f64 でも桁落ちする | マーカーの向きが揺れる、または NaN になって三角形が消える | 手順4。マーカーが向きを失わないか見る |
| `CATALOG_STRIDE` を 7 にしたが、添字計算のどこかが 4 のまま残る | 点列が斜めにずれた別の曲線として出る。族によっては「それらしい」形に見えてしまう | 手順5。`tests/physics/orbit-catalog.test.ts` の隣接点距離の検査が拾う |
| 48点へ落としたことで、周期の短い族や近点通過の速い族（DRO の一部）でエルミートが曲率を表しきれない | その族だけが角ばる。ズームインしないと分からない | 手順5。地球-月系の DRO を族範囲の端まで振ってズームインする |
| アセット再焼き込みで6ファイル約13MB の差分が出る | レビューが実質不可能になり、意図しない変更が紛れても気付けない | 手順5。`tools/export-lagrange-orbits.mjs` は同じ入力から常に同じ出力を書くので、**アセットの再焼き込みだけを単独の commit にする**（ツールとスキーマの変更と混ぜない） |
| ゼロ速度曲線の予算を実点数に合わせたことで、点数の多い成分の頂点バッファが大きくなる | `RESOLUTION = 300` の格子で1成分が長いとき、線1本あたりの確保が跳ね上がる | 手順6。ヤコビ定数を最大本数（`MAX_ZERO_VELOCITY_CURVES = 20`）× 断面4つで ON にして、メモリと fps を見る |
| `CurveKnots` のアクセサ形にしたことで、呼び出し側が節点のスクラッチ `Vector3` を使い回して壊す | 全節点が同じ位置になり、線が1点へ潰れる。または一部の節点だけがずれる | 手順3。`Curve` 側は受け取った `out` にだけ書く契約にし、手順5・6・7 の各移行直後に線の形を見る |
| 節点がそのまま初期頂点になるので、節点数が `maxVertices` を超えると手順3で入れた throw に当たる | その線が1本も出ない。カタログ48点・ゼロ速度は成分長ぶんなので、予算を実点数から決める手順6と噛み合っていないと落ちる | 手順5・手順6。頂点予算を節点数以上に取ること。最大本数構成で全断面 ON にして例外が出ないか見る |
| `Curve.sampleAt` が焼き直し前の古いサンプラを返す | マーカーと当たり判定だけが1フレーム古い曲線を読む。線とわずかにずれるが、動いていると気付かない | 手順4。`sampleAt` は `setAnalyticCurve` / `setHermiteCurve` が受け取ったサンプラを即座に差し替える（焼き直しの有無と無関係）契約にする |
| `setCurve` を private にしたとき、移行し損ねた呼び出しが `tools/` に残る | `npm run render-lab:shot` が型エラーで落ちる（無言の失敗にはならない） | 手順7。`grep -rn "\.setCurve(" src/ tools/` で先に洗う |
| 節点の接線を「位置の差」ではなく「速度」で入れる際に、パラメータのスケール（× 周期、× 区間長）を掛け忘れる | 曲線が節点の間で膨らむ・へこむ。節点自身は通るので、ズームインしないと分からない | 手順5・手順7。節点の中間（tFrac の中点）で曲線が軌道から外れないかを、族の端まで振って見る |
| ゼロ速度曲線の中心差分の接線が、臨界ヤコビ定数のネックの尖りを丸める | 物理的に意味のある尖りが丸い曲線に化ける。滑らかになったぶん「良くなった」ようにも見えるので気付きにくい | 手順6。達成条件に明記済み |
| 手順7 で `TrajectoryLine` の節点を区間端でクランプする際、区間端の節点の接線を元の速度のまま入れる | 区間端だけ曲線が伸びる（クランプで区間が縮んだぶん、接線のスケールが合わない） | 手順7。表示期間のスライダーを動かしながら線の端が跳ねないか見る |
