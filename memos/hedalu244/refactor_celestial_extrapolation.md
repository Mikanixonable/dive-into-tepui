# 2次外挿を天体1体の口へ集約し、`CelestialBody` を層の間から外す

## 目的

天体の位置を「ある時刻で厳密に引き、そこから近傍時刻へ2次外挿する」計算が、いま2箇所に分かれて
いる。

- 天体1体の口(`CelestialEntity.stateAt(pivot, t)`)。時刻キャッシュを持ち、外挿はその上で走る。
- 物理層。`CelestialBody` という凍結値を受け取り、`celestialBodyPositionAt` /
  `celestialBodyStateAt` を**呼び出し側が直接**当てる(RK4 の各段・掃引接触・到達候補)。

後者があるために `CelestialBody` が層をまたいで持ち回られ、天体1体が答えるべきことを外の
モジュールが組み立てている。**外挿の口を1つにし、`CelestialBody` を口の内側のキャッシュ値へ
畳む。**

持ち回るものが凍結値から時刻へ変わることで、**「どの時刻で厳密に引き、どの時刻へ外挿して
いるか」が呼び出しの形にそのまま現れる。** いまはこれを知るのに、値がどこで組まれてどこまで
渡ったかを遡る必要がある。呼び出しの形に出れば、pivot の種類を減らす・区間を寄せるといった
軽量化の余地を、コードを読むだけで探せるようになる — これも目的の一つ(手順5)。

## 決めたこと

### A. 口の持ち主は `CelestialMotion`

`src/physics/` は `src/game/` を import できない(CODING-RULE 1.3)。`CelestialEntity` は
`src/game/` にあり THREE を引くので、物理層が名指しできない。口を物理層から呼ぶには次のどちらか。

| 案 | 形 | 代償 |
| --- | --- | --- |
| **A1(採用)** | `CelestialMotion` が `EciTransform` を結ばれ、`stateAt(pivot, t)` を答える。`CelestialEntity` はそこへ委譲する | ECI の解決とキャッシュが `CelestialMotion` へ降りる |
| A2 | `src/physics/` にインタフェースを置き、`CelestialEntity` が実装する | 依存の逆転。物理層の関数が game 層の実装を握る |

A1 を採る。ECI 化とその時刻キャッシュは THREE に依らない物理の計算で、THREE を引くクラスに
置く理由がない。原点をどの天体に置くかは系レベルの選択のままで、**構築引数ではなく
`bindEciTransform` で結ぶ**(`bindEphemeris` と同型)。

A2 へ覆すなら、手順3以降の引数の型が `CelestialMotion` からそのインタフェースへ替わり、
ECI の解決とキャッシュを `CelestialEntity` へ戻すことになる。手順の並びは変わらない。

### B. pivot は素の `number` 引数として持ち回る

pivot を天体一覧と束ねた型は作らない(CODING-RULE 1.6)。**渡すのは引数1つ。**

```ts
// いま
export function attractorAccel(r: Vec3, attractor: CelestialBody, t: number): Vec3;
// これから
export function attractorAccel(
  r: Vec3, attractor: CelestialMotion, pivot: number, t: number,
): Vec3;
```

ただし pivot は**呼び出し側で再計算できない。** サブステップの窓は区間の中点
(`simTime + dt/2`)で解決され、その1組を個体ごとの細分(`substepDivisions`)の内側でも
使い回す。細分の内側では `state.t + dt/2` は中点と一致しないので、解決した時刻そのものを
下まで渡す必要がある。

**1回の積分ステップに pivot は2つ現れる。** 重力源と大気は区間の中点で、表面と遮蔽体は区間の
開始時刻で解決されているため。値を変えないので、両方をそのまま持ち回る。

### C. `CelestialBody` は完全に消す

いま `CelestialBody` が持つものは、行き先が3つに分かれる。

| フィールド | 行き先 |
| --- | --- |
| `id` / `mu` / `radius` / `isStar` | 時刻に依らないので `CelestialMotion.def` / `kind` |
| `state` / `accel` / `degree2` / `atmosphere` | `CelestialMotion` の時刻キャッシュの中身(非公開) |

値オブジェクト(`OrbitalElements` / `SecondaryFrame` / `FrameAnchorSource`)が持っている
「天体 + その瞬間の状態」の対は、`CelestialMotion` と `KinematicState` の2フィールドへ割る。
`accel` も `degree2` も `atmosphere` もこれらは要らないので、対を共有の型にする理由がない。

### D. 手順4 までは精度を変えない。手順5 だけが近似を動かす

現在の呼び出しはすべて「解決した時刻を pivot に、そこから外挿」の形で書ける。手順4 までを
写し終えた時点で、値はビット一致していなければならない。固定値テスト
(`celestial-eci-baseline`)が合格の物差し。

**手順5 は意図的にビット一致を崩す。** 1サブステップに現れる pivot を1つへ寄せる近似で、
効果と代償が測れるのは手順4 まで終わってからなので、最後に置く。

## 達成目標

- `grep -rn "celestialBodyStateAt\|celestialBodyPositionAt" src/ tests/` が
  `src/physics/celestial-motion.ts` の内側だけになる(外挿の実装が1箇所)。
- `grep -rn "CelestialBody" src/ tests/` が 0 件(型が消えている)。
- `src/physics/celestial-body.ts` が消え、その中の自由関数が引き取り先へ移っている。
- `CelestialSystem` から `allCache`(`TimeRing<readonly CelestialBody[]>`)と
  `celestialBodiesAt` / `gravityAttractorsAt` / `atmosphereCelestialBodiesAt` の時刻引数が
  消えている — 一覧は時刻に依らず、時刻ごとの解決は天体1体が畳む。
- `npm run typecheck` / `npm run test`(全層)/ `npm run build` が通り、
  `celestial-eci-baseline` の固定値が1文字も変わらない。

## 手順

## 見積り

| 手順 | ファイル | 根拠 |
| --- | --- | --- |
| 3 | 25 | `src/physics/` 6 + `src/game/dynamic/` 14 + `src/render/pipeline/` 2 + テスト3 |
| 4 | 36 | `src/physics/` 6 + `src/game/` 30 |
| 5 | 4 | サブステップの窓と、それを呼ぶ側 |

実施済みの手順1(17ファイル・revert)と手順2(6ファイル)を含めた合計は **約 88 ファイル**(重複あり)。`CelestialBody` を参照するファイルは現状 74 で、うち 17 は
型注釈だけを通しているので機械的に写せる。

実行時コスト: `celestialBodyPositionAt` の直線コードの前に `TimeRing.get` の照合が入る。
`TimeRing` は 32 段の線形走査なので、RK4 の各段 × 天体数 × 細分 × 個体数ぶん走る。
**サブステップの中では同じ pivot が連続するので、`eciCache` の前に直前の pivot 1段の
先頭比較を置く**(手順2で入れる)。それでも実測が悪化するなら、手順4の完了時点で
`npm run dev` の負荷確認ウィンドウで `timeCacheHits` / `timeCacheMisses` を読んで判断する。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `degree2At` / `atmosphereAt` を pivot ごとに畳まないまま手順3へ進む | RK4 の各段が姿勢(三角関数と直交化)を組み直し、積分が目に見えて重くなる。**値は正しいので絵にも数値にも出ない** | 手順2。`grep` で `orientationAt` の呼び出しが `eciCache` の内側だけになっていることを見る。手順4完了時に負荷確認ウィンドウ |
| 2つの pivot(重力=中点 / 表面=開始時刻)を、手順3・4 のうちに1つへ揃えてしまう | 天体位置が半ステップぶんずれる。低軌道で数百 m、月で数十 km。**絵では気付けない。** 手順6 でやると決めた変更が、写し替えの中に紛れて評価できなくなる | 手順3・4。`window-agreement` と `celestial-eci-baseline` |
| 手順6 でトレランス判定のテストが通ったことを「値が変わっていない」と読む | 近似が動いたことが記録に残らず、次に軌道がずれたときの原因候補から外れる | 手順6。通ったテストの許容幅と、実測した差を報告に書く |
| 細分(`substepDivisions`)の内側で pivot を `state.t + dt/2` から再計算する | 再突入中の個体だけ天体位置がずれ、接触判定と加熱がずれる | 手順4。再突入を含む `surface-candidates` / `time-step` のテスト |
| `SpatialGrid` へ載せる位置を pivot でなく問い合わせ時刻で引く | 分類が問い合わせごとに変わり、1回の分類を使い回す前提が崩れて O(N log N) が毎点走る | 手順4。負荷確認ウィンドウの `gravitySources` と実測フレーム時間 |
| `OrbitalElements` の `centerState` を、要素を組んだ瞬間と違う時刻で詰める | 軌道楕円が中心天体からずれた位置に描かれる | 手順5。マップビューの参照軌道線 |
| `orbit-line.ts` の頂点ループの中で `centerState` を引き直す形にする | 頂点数ぶん暦が走り、軌道線の描画が重くなる | 手順5。マップビューで軌道線を出したときのフレーム時間 |
| `DynamicTrajectory._extrapolationCenter` の pivot がフレームを越えて古くなる | `TimeRing` から落ちて再計算になる。値は同じだが、ケプラー外挿の最大 2048 サンプルぶん暦が走る | 手順4。軌道線を長く伸ばしたときのフレーム時間 |
| `EciTransform.stateAt(t, motion)` と `FrameAnchorSource.stateOf(id, t)` を同じ口と見て巻き込む | 座標系の解決が壊れ、マップのカメラと軌道線が飛ぶ | 手順2・5。`npm run test:physics`、マップビュー |
| `celestial-body.ts` を消すとき、そこにあった自由関数の引き取り先を決めずに `celestial-motion.ts` へ全部入れる | 500行の目安を超え、運動と重力場の判定が同じファイルへ混ざる | 手順3。`wc -l src/physics/celestial-motion.ts` |
