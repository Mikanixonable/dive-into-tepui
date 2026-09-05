# simulation「衝突」の軽量化

対象コミット: `a9eb1993`(この文書の行番号・実測はすべてこの時点)

## 目的

負荷確認ウィンドウの「接触」区間が、物が増えると 60fps の予算を食い潰す。実測(下記)では
弾・破片が 2000 体いる状態で 1 フレームあたり **9.6 ms**、16.7 ms 予算の 58% に達する。

内訳は3つの別々の仕事の合算で、値段の付き方も、効く倍率も違う。

- **物体どうしの接触** 4.37 ms/frame — 倍率 ≤4 でしか走らない(`MAX_PHYS_SIM_SPEED = 4`)。
- **ベルトの接触** 4.72 ms/frame — 参加者は 18 節点しかないのに、物体どうしの接触とほぼ同額。
- **天体との接触** 0.51 ms/substep — 倍率に依らず走り、高倍率では 1 フレームに最大 64 substep。

球1組の判定そのものは既に十分速い(掃引つき `resolveSphereCollision` 1 組で **0.1 µs**)。
削るべきなのは、判定へ辿り着くまでの土台 — 空間グリッドの組み直し、`Map`/`Set` の索き直し、
そして絞り込みで作っている一時 `Vec3` である。

### 実測(すべて node で `tests/dist/` の実装をそのまま呼んだ値)

**物体どうしの接触**(弾を 1/3 混ぜた半径 250 km の雲、dt = 1/60 s)

| N | `resolveEntityContacts` | `resolveBelt`(参加者 18 節点) |
| --- | --- | --- |
| 500 | 0.97 ms | — |
| 1000 | 1.91 ms | — |
| 2000 | 4.37 ms | 4.72 ms |

部品単体(N = 500):`SpatialGrid` の reset + insert **242 µs** / `neighborsInto` ×500 **167 µs** /
`Map<entity, state>` の構築 **24 µs**・get ×500 **10 µs** / `resolveSphereCollision` 1 組 **0.1 µs**。

`--prof`(N = 2000, 600 回):`collectCandidates` 35% / `resolveInOrder` 14% /
`FindOrderedHashMapEntry` 14% / `SpatialGrid.reset` 13% / `contactCellSize` 5%。

**天体との接触**(天体 95 体、LEO 殻に散らした参加者)

| N | `narrow` | `into` ×N | 計 |
| --- | --- | --- | --- |
| 1 | 7 µs | 1 µs | 8 µs |
| 50 | 17 µs | 14 µs | 31 µs |
| 500 | 45–108 µs | 76–117 µs | 121–225 µs |
| 2000 | 190–204 µs | 316–329 µs | 約 510 µs |

**メッシュの衝突**(タンパク質の衝突用リボン。三角形数は `backboneSecondary` から run を数えて算出)

| アセット | 残基 | 衝突用三角形 | `buildBVH` | 球1回 | 掃引1組(最大 56 回) |
| --- | --- | --- | --- | --- | --- |
| myoglobin 1MBN | 153 | 約 17,000 | 250 ms | 4.1 µs | 0.23 ms |
| PDB 5I4R | 1,123 | 約 146,000 | 4.0 s | 33 µs | 1.9 ms |
| rubisco 8RUC | 2,360 | 約 375,000 | (12 s 相当) | — | — |
| ATP synthase 6N2Y | 4,713 | 約 647,000 | 21 s | 185 µs | 10.4 ms |

`MAX_BVH_DEPTH = 12` で葉は最大 4096 個しか作れないので、647,000 枚では葉に 159 枚残る
(`LEAF_TRIANGLE_COUNT = 16` は満たされない)。そして `ProteinRibbonCollisionGeometry` は
**タンパク質敵の生成ごとに** 組み直される。

## 決めたこと

依頼の 0〜5 について、コードと実測から次のように判断した。覆されたときにどの手順が変わるかも書く。

### 1. Celestial のキャッシュの pivot — **既に substep あたり1種類。手順にしない**

`SubstepCelestialBodies.reset` が `simTime + dt/2` を1つ決め、重力源の分類・大気天体の選択・
表面の窓・RK4 の各段の外挿まで、その substep のすべてが同じ pivot を受け取る
(`simulator.ts:127`, `surface-contact-physics.ts:42`, `dynamic-entity.ts:444`)。
substep が変われば pivot も変わるが、それは本当に別の時刻なので、統一しようがない。
`TimeRing` は直近ヒット段を先に見るので、substep 内の連続参照は1回の比較で当たる。

→ **削る余地はここに無い。** 手順1で足す `timeCacheMisses` が「天体数 × substep 数」を大きく
超えていたら、予測・計画・表示が同じ天体を別の時刻で叩いてキャッシュを追い出している
ことになるので、そのときだけ見直す。

### 2. `sharedIntervalScratch` — **顔ぶれの絞り込みではない。誤解**

これは「この substep を1歩で渡った個体」の集まりで、絞り込みとは無関係
(`simulator.ts:54`, `:217`)。濃い大気で区間を内側で割った個体は歩ごとに `resolveOne` で解き終えて
いるので、区間が揃っている残りだけをまとめて解くための仕分けである。二重に解くと反発が
二度当たるので、この仕分け自体は消せない。

### 3. 一体ごとの絞り込み — **`narrow` は効いている。O(N·M) は当面起きない**

`SurfaceCandidates` は二段構えで、`into`(`surface-candidates.ts:89`)が**既に一体ごと**に
測っている。`narrow`(:70)はその前段で、参加者全体を覆う球で候補を落とす。

実測では、全員が地球圏にいるとき 95 体 → **1 体**。地球圏と木星圏に二分しても **2 体**。
`narrow` を掛けないと `into` ×N は N = 500 で 76 µs → **492 µs**(6.5 倍)。
つまり `narrow` は逆効果どころか、いまの `into` の安さを支えている当人である。

指摘のとおり「地球圏と木星圏に散る」構図では覆う球が太り、原理的には両方が残る。しかし
そのときでも `into` が一体ごとに落とすので、余分に払うのは残った天体数ぶんの距離比較
だけで、判定器は呼ばれない。実測の 500 µs/substep は `reachable = 1` で出た値であり、
**支配しているのは候補天体の数ではなく、参加者1体ごとに作っている一時 `Vec3`** である
(`intervalReach` が参加者あたり 8 個以上作る)。

→ 天体側にグリッドを組むのは**しない**。同じ実測で、天体を 27 近傍グリッドへ載せた場合の
問い合わせは1体あたり 0.33 µs で、いまの `narrow` + `into`(1体あたり 0.25 µs)より高い。
代わりに **手順4** で割り当てを落とす。手順1の `surfaceCandidates`(延べ候補天体数)が
参加者数の数倍を超え続けるなら、この判断を覆して天体側の索引を入れる。

### 4. Dynamic 同士の spatialGrid — **既にある。退化条件は倍率で塞がれている**

`EntityContactPhysics` は既に一様グリッドを組んでいる(`entity-contact-physics.ts:148`)。
一辺は「参加者集合に共通する変位を差し引いた到達量」の最大値の2倍
(`contactCellSize`, :53)で、これは依頼の「衝突実効半径」そのものである。

密集で退化するかを測った: 半径 2 km に 500 体・相対 ±100 m/s・dt = 20 s では全員が1セルへ
入り **29 ms/substep** へ落ちる。ただしこの条件は起きない — 物体どうしの接触は倍率 ≤4 で
しか走らず、そこでの substep 幅は 1/15 s 以下。相対 1 km/s の弾が混じっても
|Δ−Δ̄| ≤ 1000 × 0.067 = 67 m、一辺は 134 m にしかならない。破片が互いに 134 m 以内へ
密集しない限り 27 近傍は空になる。

→ **セル一辺の決め方は変えない。** 手順1で足す `contactPairs`(候補ペア数)が参加者数の
数倍を超えたら、この判断を覆して二階層グリッドを検討する。
削るのは土台の値段 — **手順2**(ベルトが全物体を走査している)と
**手順3**(`Map`/`Set` を添字配列へ)。

### 5. メッシュの衝突 — **外接球の事前棄却はある。分割数が過大**

外接球の棄却は静止球・掃引球のどちらにも入っている
(`protein-ribbon-collision.ts:33`, `:54` の `segmentSphereInterval`)。基地側も同じ
(`entity-contact-response.ts:22`)。ここは問題ない。

問題は**衝突用リボンを表示と同じ細かさで組んでいる**こと。残基あたり縦 12 分割
(`RIBBON_SUBDIVISIONS = 12`)、coil の管は放射 12 分割(`protein-collision-ribbon.ts:225`)。
結果が上表の 17,000〜647,000 枚で、`buildBVH` に 250 ms〜21 s、しかもそれを敵1体ごとに払う。

→ ベルトと同じ「球の数珠つなぎ」へ置き換えるのは**しない**。残基 4,713 のタンパク質では
球も 4,713 個必要で、球列の総当たりは BVH より遅くなる。同じ狙い(残基あたり数個の
プリミティブ)は、**リボンの分割数を判定用の値へ落とす**ことで、形を変えずに達成できる
(**手順6**)。加えて `buildBVH` 自体が三角形配列のコピーとソートを節ごとに繰り返していて
遅いので、これも直す(**手順5**、基地にも効く)。

なお SPEC/PROTEIN.md 42 行が縛っているのは「表示形態を変えても衝突形状は静止したリボン形状」
という**形**であって分割数ではないので、この変更は SPEC の更新を要さないと判断した。
掠め当たりの粒度が変わるのが許容できないなら、手順6 を落として手順5 だけを実施する。

### 6. スケール別のグリッド — **重力側と天体接触側は既に別。物体側も既にある**

重力は `attractors.ts` が mu の重い順 15 体 + 引力が 1e-8 m/s² まで落ちる距離のセルで分類。
天体接触は `SurfaceCandidates` が区間の到達距離で別に絞る。物体どうしは `contactCellSize`。
3つとも別スケールで、既に依頼の形になっている。

## 達成目標

全手順の実施後、次がすべて満たされること。

1. 負荷確認ウィンドウの「update内訳」に **「天体接触」「物体接触」「ベルト」の3行**が独立して
   出る。合算の「接触」1行は無い。
2. 弾・破片が合計 2000 体前後(高負荷デバッグステージ + 連射)、倍率 ×1 で
   - 「ベルト」が **0.5 ms 以下**
   - 「物体接触」が手順1で控えた値の **60% 以下**
3. 破片 600 体・最高倍率で「天体接触」が手順1で控えた値の **60% 以下**。
4. タンパク質敵を含むステージで、衝突形状の構築による停止が **0.1 s を超えない**。
   同じアセットの2体目以降の生成では衝突形状を組み直さない。
5. `npm run typecheck` が通り、`npm run test:game` `test:math` `test:physics` が通る。
   絞り込みが判定器の答えを変えないことを固定するテストが、**ベルトの絞り込みにも**ある。

## 手順

### 手順 1. 「接触」区間を3つへ割り、候補の件数を数える

#### 目的

いまの「接触」は天体接触・物体接触・ベルトの合算なので、どれを削れば効くのかが決められない。
以降の手順の達成条件がすべてこの3行を参照するので、最初に置く。
併せて件数を2つ数える — 時間だけでは「参加者が多い」のか「候補が爆発している」のかが
分かれないため。`contactPairs` が参加者数の数倍で収まっているかが、決めたこと 4 の判断が
まだ成り立っているかの唯一の証拠になる。**この時点で挙動は変えない。**

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/game/frame-sections.ts:5-32` | `contact: 5` を `celestialContact` / `entityContact` / `beltContact` の3つへ置き換え、以降の値を繰り下げる。`SECTION_LABELS`(:25)へ「　天体接触」「　物体接触」「　ベルト」を字下げして並べる |
| `src/game/frame-sections.ts:71` | `otherMs()` の除外へ3つとも入れる(いまは `contact` 1つ) |
| `src/game/dynamic/simulator.ts:118-131` | `beginSubstep`(:127)を `orbit` から出して `celestialContact` へ入れる — 候補の下ごしらえは天体接触の値段そのもので、いまの位置では天体接触の行が実際より小さく出る |
| `src/game/dynamic/simulator.ts:215` | `substep()` の中の `resolveOne` も `celestialContact` へ入れる(いまは `orbit` に混ざっている) |
| `src/game/dynamic/simulator.ts:137-139` | `resolveShared` を `celestialContact` へ |
| `src/game/dynamic/simulator.ts:144-152` | `collisionFolds` の収集(:144-148)と `resolveEntityContacts` を `entityContact` へ |
| `src/game/dynamic/simulator.ts:164-168` | `resolveBelt` を `beltContact` へ |
| `src/game/dynamic/surface-contact-physics.ts` | 延べ候補天体数を数える。`resolveAgainstCandidates`(:67)が `candidates.into` の戻り長を足し込む |
| `src/game/dynamic/entity-contact-physics.ts` | 候補ペア数を数える。`collectCandidates`(:176)の戻り値を控える |
| `src/game/dynamic/simulator.ts:222` | 上2つをフレーム頭で 0 に戻し、`perfCounts()` へ載せる |
| `src/game/perf-counts.ts:9-19` | `PerfCounts` へ `surfaceCandidates: number` と `contactPairs: number` を足す |
| `src/launcher/perf-meter.ts:20-32` | `RATE_COUNTS` へ2行足す(group は `'衝突'`) |

#### 達成条件と検証

- `npm run typecheck`、`npm run test:game`。
- `npm run dev` → F3。「update内訳」に「天体接触」「物体接触」「ベルト」の3行が出て、
  「接触」が無い。`SECTION_LABELS` の並びが `SECTION` の値と1つずつ対応していることを目で確かめる
  (添字がずれると別の区間の時間が別のラベルで出る)。
- 次の3条件で3行と2件数を控え、この文書の実測欄の下へ**測定日と倍率を添えて**書き足す。
  以降の手順の達成条件はこの値を基準にする。
  1. creative、自機のみ、倍率 ×1
  2. 高負荷デバッグステージ(`DEBUG(高負荷)`、破片 500)+ 連射、倍率 ×1
  3. 同ステージ、最高倍率

### 手順 2. ベルトは相手を絞ってから解く

#### 目的

ベルトの参加者は 18 節点しかないのに、`resolveInOrder` が全物体ぶんのグリッド構築と
27 近傍問い合わせを払っている。実測 N = 2000 で **4.72 ms/frame** — 物体どうしの接触
(4.37 ms)とほぼ同額を、フレームに1回、倍率 ≤4 では常に払っている。

#### 変更が必要な箇所

2つ変える。(a) は通常の substep 経路の意味を変えない整理で、(b) がベルト経路の削減。

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/entity-contact-physics.ts:176` | `collectCandidates` を **attackers だけの走査**にする。`all` は `attackers ++ others` の並びなので「添字 < attackerCount ⟺ attacker」で判定でき、ペアの重複除去は「相手も attacker なら添字が大きい側だけ採る」で足りる |
| `src/game/dynamic/entity-contact-physics.ts:79,137` | 上記により `attackerSetScratch`(`Set<DynamicEntity>`)と `attackerSet` の受け渡しが不要になるので消す |
| `src/game/dynamic/entity-contact-physics.ts:95-109` | `resolveBelt` が `others` を艦まわりの1球で先に落とす。落とす条件は下記 |
| `src/game/dynamic/contact-participant.ts` | 区間の到達距離を両解決器の共有規則として置く(下記 `intervalReach`)。ここは「表面接触と物体どうしの接触が同じ規則で読まなければならないもの」を持つ場所なので、置き場所はここ |
| `src/game/dynamic/surface-candidates.ts:24-33` | 自前の `chordDeviationBound` / `intervalReach` を捨て、`contact-participant.ts` のものを使う |
| `tests/game/contact-narrowing.test.ts`(新規) | ベルトの絞り込みを通したときと通さないときで、成立する接触が一致することを固定する。`tests/game/surface-candidates.test.ts` と同じ組み方 |

新規 API:

```ts
// src/game/dynamic/contact-participant.ts
// 区間 [prev, next] を渡る間に、その中心が始点からどれだけ離れうるか [m]。
// 判定器が解くのは三次曲線なので、弦の長さに「曲線が弦から離れうる上限」を足す。
// **弦だけで測ると、速い相手の通過を落とす。**
export function intervalReach(prev: KinematicState, next: KinematicState): number;

// src/game/dynamic/entity-contact-physics.ts
// 艦まわりで、この区間に belt のどれかへ触れうる相手だけを out へ写す。
// out は呼び出し側が所有する。
private collectBeltNeighbors(
  ship: KinematicState,
  sections: readonly DynamicEntity[],
  source: readonly DynamicEntity[],
  out: DynamicEntity[],
): void;
```

落とす条件(すべて艦の区間始点 `ship.prevState.r` から測る):

```
beltReach = max over sections of
    ( |section.prevState.r − ship.prevState.r| + section.radius + intervalReach(section) )
otherReach = other.radius + intervalReach(other)
落としてよい ⟺ |other.prevState.r − ship.prevState.r| > beltReach + otherReach
```

#### 達成条件と検証

- `npm run typecheck`、`npm run test:game`(新規テストを含む)。
- 手順1の条件2(破片 500 + 連射、倍率 ×1)で「ベルト」が手順1で控えた値の **1/5 以下**、
  かつ「物体接触」の行が手順1と**変わらない**(この手順は通常経路を速くしない)。
- `grep -rn "attackerSet" src/` が 0 件。

### 手順 3. 接触解決の作業集合を `Map` / `Set` から添字配列へ

#### 目的

プロファイルで `FindOrderedHashMapEntry` が 14%、`SpatialGrid.reset` が 13%。
`working` / `changed` は `all` の添字で引けるのに `Map` / `Set` を通しており、グリッドが
既に添字を持ち回っているので、索き直す理由が無い。**挙動は変えない。**

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/entity-contact-physics.ts:80-81` | `workingScratch: Map<DynamicEntity, KinematicState>` を `KinematicState[]`、`changedScratch: Set<DynamicEntity>` を添字の配列へ |
| `src/game/dynamic/entity-contact-physics.ts:53` | `contactCellSize` の第2引数を `readonly KinematicState[]` に |
| `src/game/dynamic/entity-contact-physics.ts:42` | `replaceIfMoved` を添字で受ける形へ |
| `src/game/dynamic/entity-contact-physics.ts:26-31` | `Candidate` へ `ai` / `bi`(`all` 上の添字)を持たせる |
| `src/game/dynamic/entity-contact-physics.ts:123,176,217,236` | `resolveInOrder` / `collectCandidates` / `earliestContact` / `applyCandidate` の `working.get(x)` を添字参照へ。`earliestContact` の dirty 判定も添字の比較へ |

```ts
// 書き換え後の署名
private collectCandidates(
  all: readonly DynamicEntity[],
  attackerCount: number,
  simTime: number,
  working: readonly KinematicState[],
  grid: SpatialGrid<number>,
): number;

private earliestContact(
  count: number, dirtyA: number, dirtyB: number,   // 無いときは -1
  working: readonly KinematicState[],
): Candidate | null;
```

#### 達成条件と検証

- `npm run typecheck`、`npm run test:game`(`contact.test.ts` が通ること)。
- 手順1の条件2で「物体接触」が手順1で控えた値の **60% 以下**、
  かつ `contactPairs` が手順1と**同じ値**(候補の顔ぶれが変わっていない証拠)。
- `grep -n "Map<DynamicEntity\|Set<DynamicEntity" src/game/dynamic/entity-contact-physics.ts` が 0 件。

### 手順 4. 天体候補の絞り込みから `Vec3` の割り当てを落とす

#### 目的

`narrow` と `into` は毎 substep、全個体ぶん走る。中身は距離比較だけなのに、
`sub` / `len` / `add` / `scale` で参加者1体あたり 10 個以上の `Vec3` を作っている。
実測 N = 2000 で `narrow` 190 µs + `into` 316 µs = **506 µs/substep**。倍率が高いと
1 フレームに最大 64 substep 走るので、破片 600 体でも 64 × 150 µs ≈ **9.6 ms/frame** になる。
`sphere-contact.ts:106` が同じ理由で既に「棄却されるところまでは `Vec3` を1つも作らない」形を
採っているので、規則としても揃う。**判定の答えは変えない。**

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/contact-participant.ts` | 手順2で移した `intervalReach` と `chordDeviationBound` を、`Vec3` を作らないスカラー演算へ書き換える |
| `src/game/dynamic/surface-candidates.ts:70` | `narrow` の重心と margin をスカラーで求める(`sum = add(sum, ...)` の累積をやめる) |
| `src/game/dynamic/surface-candidates.ts:89` | `into` は既に距離をスカラーで測っているので、`intervalReach` の書き換えだけで済む。参加者の `reach` を1度で求めていることを確認する |

非有限の扱いは `!(x <= y)` の否定形で書く — `x > y` と書くと NaN が絞り込みを素通りする
(`sphere-contact.ts:75` と同じ規則)。

#### 達成条件と検証

- `npm run typecheck`、`npm run test:game`。
  **`tests/game/surface-candidates.test.ts`(総当たりとの一致)が通ることが、この手順の砦。**
  絞り込みが1体でも落とすと、判定器はそもそも呼ばれないので、判定器のテストでは見えない。
- 手順1の条件3(破片 600・最高倍率)で「天体接触」が手順1で控えた値の **60% 以下**、
  かつ `surfaceCandidates` が手順1と**同じ値**。

### 手順 5. BVH の構築を三角形配列のコピーから添字の分割へ

#### 目的

`buildBVH` が節ごとに `[...triangles]` と `.sort()` と `.slice()` を繰り返していて、
17,000 枚で **250 ms**、650,000 枚で **21 s** かかる。加えて `MAX_BVH_DEPTH = 12` が
`LEAF_TRIANGLE_COUNT = 16` より先に効いてしまい、650,000 枚では葉に 159 枚残って
球1回が 185 µs になる。基地とタンパク質の両方が同じ器を使うので、ここを直すと両方に効く。
**判定の答えは変えない**(同じ中央値分割の木を、コピーせずに組む)。

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/math/triangle-mesh.ts:99-113` | 三角形の添字配列を1本だけ持ち、各節は `[begin, end)` の区間として分割する。`sort` は区間内の添字だけを並べ替える |
| `src/math/triangle-mesh.ts:41` | `MAX_BVH_DEPTH` を三角形数から決める(`ceil(log2(n / LEAF_TRIANGLE_COUNT))` を下回らない上限)。固定の 12 では葉が `LEAF_TRIANGLE_COUNT` に届かない |
| `src/math/triangle-mesh.ts:15-30` 付近 | `BVHNode` の `triangles: Triangle[]` は、添字区間を指す形へ寄せる(葉の走査順は現状と同じにする) |
| `tests/math/` | 木の形を変えても、同じ球・同じレイに対して同じ接触が返ることを固定する回帰を足す |

#### 達成条件と検証

- `npm run typecheck`、`npm run test:math`、`npm run test:game`
  (`protein-ribbon-collision.test.ts` が通ること)。
- 手元の計測スクリプトで、17,000 枚の `buildBVH` が **30 ms 以下**、
  葉あたりの三角形が `LEAF_TRIANGLE_COUNT` 以下になること。
- `grep -n "\[\.\.\.triangles\]" src/math/triangle-mesh.ts` が 0 件。

### 手順 6. タンパク質の衝突形状を判定用の粗さで組み、アセットごとに1つだけ持つ

#### 目的

衝突用リボンを表示と同じ細かさ(残基あたり縦 12 分割・管の放射 12 分割)で組んでいるため、
三角形が 17,000〜647,000 枚になる。しかもそれを **タンパク質敵1体ごとに** 組み直している
(`protein-enemy.ts:106-108`)。衝突形状は姿勢もスケールも引数で受ける読み取り専用の構造なので、
個体ごとに持つ理由が無い。

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/render/protein-collision-ribbon.ts:7,225` | 判定用の分割数を表示用と別に持つ。`COLLISION_SUBDIVISIONS = 1`(残基あたりの縦分割)、`COLLISION_RADIAL_SEGMENTS = 6`(coil の管の放射分割)。`buildProteinCollisionRibbon` の中だけがこれを読む |
| `src/game/protein/protein-enemy-registry.ts:19,38-41` | `ProteinEnemyDefinition` の `buildCollisionObject: () => THREE.Object3D` を、組み上げた `collisionGeometry: ProteinRibbonCollisionGeometry` へ置き換える。定義は id ごとに1つしか作られない(`proteinEnemyDefinitionCache`)ので、これで自然にアセットあたり1つになる |
| `src/game/dynamic/dynamic-entity/protein-enemy.ts:105-108,122` | 自分で組むのをやめ、`definition.collisionGeometry` を受け取って持つだけにする。`disposeOwnedRenderResources` の呼び出しは registry 側へ移る |

```ts
// src/game/protein/protein-enemy-registry.ts
export interface ProteinEnemyDefinition {
  // ...
  // 表示形態に依らない衝突形状。アセットごとに1つで、個体は姿勢と中心を引数で渡すだけ。
  readonly collisionGeometry: ProteinRibbonCollisionGeometry;
}
```

三角形数の見積り(ATP synthase, 4,713 残基):
ribbon 側は縦 12 → 1 で 12 分の1(残基あたり 96 → 8 枚)、coil 側は 12×12 → 1×6 で
24 分の1(残基あたり 288 → 12 枚)。合計 647,000 → **約 43,000 枚**。
手順5 と合わせて `buildBVH` は 21 s → **約 50 ms**、アセットあたり1回だけ。

#### 達成条件と検証

- `npm run typecheck`、`npm run test:game`。
- タンパク質敵を 4 体置いたステージを `npm run dev` で開始し、
  2体目以降の生成で停止が起きないこと(F3 の update 合計に 0.1 s 級の跳ねが1回も出ない)。
- 弾がタンパク質へ当たる・掠める・外れるの3通りを目で確かめ、当たり判定が成立すること。
- `grep -rn "buildCollisionObject" src/` が 0 件。

## 見積り

弾・破片 2000 体、60fps 予算 16.7 ms、倍率 ×1 を基準にする。

| 手順 | 導出 | 効果 |
| --- | --- | --- |
| 現状 | 物体接触 4.37 + ベルト 4.72 + 天体接触 0.51 | **9.6 ms/frame**(予算の 58%) |
| 手順2 | ベルト = グリッド構築 1.0 + 27近傍 ×18 = 0.006 + 艦まわり走査 2000 × 10 ns = 0.02 → 約 0.2 ms(艦まわりで落ちた後は下流もほぼ空) | **−4.5 ms** |
| 手順3 | 物体接触 4.37 のうち `Map`/`Set` 由来が 14%(`FindOrderedHashMapEntry`)+ `SpatialGrid.reset` の一部 13% → 4.37 × 0.65 ≈ 2.8 ms | **−1.5 ms** |
| 手順4 | 天体接触 = `narrow` + `into`。参加者1体あたり 10 個以上の `Vec3` 生成を落とすと、残るのは距離比較だけ → 506 µs → 約 200 µs/substep | 倍率 ×1 で **−0.3 ms**、最高倍率・破片 600 体では 64 × (150 → 60 µs) で **−5.8 ms** |
| 手順5+6 | 三角形 647,000 → 43,000(縦 12→1、放射 12→6)、`buildBVH` は添字分割で三角形あたり約 1 µs → 43 ms。個体ごと → アセットごとで N 体目以降 0 | 生成時 **21 s → 0.05 s**、掃引1組 **10.4 ms → 約 0.2 ms** |
| 合計(倍率 ×1) | 9.6 → 約 3.2 ms | **予算の 58% → 19%** |

手順ごとの作業量は、手順1〜4 が既存ファイルの内部書き換え(新規ファイルはテスト1本のみ)、
手順5 が `src/math/triangle-mesh.ts` 1 ファイルの作り直し、手順6 が3ファイルの受け渡しの
付け替え。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 区間番号を繰り下げたときに `SECTION_LABELS` の並びがずれる | 別の区間の時間が別のラベルで出る。以降の全手順が誤った所を削る | 手順1。`SECTION` の値と `SECTION_LABELS` の添字を1つずつ突き合わせる |
| `otherMs()` の除外に3つとも入れ忘れる | 「その他」が二重計上ぶん小さく出て、合計が合わなくなる | 手順1。合計と `update` の実測が一致するかを見る |
| ベルトの絞り込み半径が足りない | 触れるはずの当たりが**無言で**消える。判定器は呼ばれもしない | 手順2。総当たりとの一致テスト(`contact-narrowing.test.ts`)で固定する |
| 弦の長さだけで到達距離を測り、三次曲線が弦から離れる分を足し忘れる | 速い相手だけがベルトを通り抜ける。低速では絶対に出ない | 手順2・手順4。`intervalReach` を1箇所に置き、両解決器が同じものを読む |
| 添字化で `all` の並びとグリッドの中身がずれる | 別の個体の状態で反発を解く。NaN ではなく「もっともらしく間違う」ので watchdog にも掛からない | 手順3。`contactPairs` が手順1と同値であることを確認する |
| スカラー化で非有限の扱いが変わる | NaN が絞り込みを素通りし、判定器の側で落ちる | 手順4。比較を `!(x <= y)` の否定形で書く(`sphere-contact.ts:75` と同じ規則) |
| BVH の葉に入る三角形の並びが変わる | 同じ深さで複数枚に当たるとき、返る接触点が変わりうる | 手順5。`tests/math` の新規回帰と `protein-ribbon-collision.test.ts` |
| アセットで共有した衝突形状を、どれかの個体が書き換える | 全個体の当たりが同時に狂う | 手順6。`ProteinRibbonCollisionGeometry` に可変フィールドを持たせない |
| 分割数を落とすと掠め当たりの成否が変わる | 当たると思った弾が抜ける(逆も) | 手順6。SPEC/PROTEIN.md 42 行は「形」だけを縛っていると解釈した。許容できないなら手順6 を落として手順5 だけ実施する |
| 手順2・3 の効果は倍率 ≤4 でしか出ない(`MAX_PHYS_SIM_SPEED = 4`) | 最高倍率で測って「効かない」と誤判定する | 手順1で倍率ごとに値を控えておく。高倍率の重さに効くのは手順4だけ |

### 却下したが、条件が変われば戻ってくるもの

- **物体どうしのグリッドの二階層化。** いまのセル一辺の決め方は、密集(半径 2 km に 500 体)
  かつ大きな刻み(dt = 20 s)で退化し、実測 29 ms/substep まで落ちる。ただしその刻みは倍率
  300 以上でしか出ず、そこでは物体どうしの接触は走らない。倍率 ≤4 では一辺が 134 m 以下に
  なるので退化しない。**手順1 の `contactPairs` が参加者数の数倍を超え続けたら、この判断が
  崩れている。**
- **天体側の空間グリッド。** 実測では 27 近傍の問い合わせ(1体 0.33 µs)がいまの
  `narrow` + `into`(1体 0.25 µs)より高く、割り当てを落とせば差はさらに開く。
  **手順1 の `surfaceCandidates` が参加者数の数倍を超え続けたら**(= `narrow` が候補を
  絞れていない構図が実際に起きているなら)、この判断が崩れている。
- **掃引メッシュ判定の標本数 48**(`protein-ribbon-collision.ts:62`)。手順5・6 で1回あたりが
  50 分の1 になるので、まず触らない。触ると当たり判定の精度が直接変わる。
