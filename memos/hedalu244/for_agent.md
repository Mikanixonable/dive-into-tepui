# Step 2 実装手順 — Ephemeris の解体と「重力を及ぼす解析軌道天体」の追加基盤

`better_simulation_todo.md` の実装計画素案 Step2 を、現状のコードと突き合わせて具体化したもの。
素案の細部ではなく大局的な目標(= 天体を1つ足すのが宣言的な1〜2行で済み、座標系の選択が
設計の根幹から切り離されていること)を満たすことを優先し、いくつか素案から逸脱している。
逸脱は §2 に理由つきで列挙した。

作業前に `.claude/skills/refactor-fixed/SKILL.md` と `/comment` を読むこと。
**各フェーズは単独でコミットできる状態(typecheck + test:physics が通り、ゲームが起動する)で
終えること。** フェーズをまたいで壊れたまま進めない。

---

## 0. 前提と優先順位

**判断が競合したら、この順で決める。**

1. **物理的正確さ** — `physics/` では最優先。近似を入れるなら、その適用範囲と限界を
   モジュール先頭コメントに明記する(`/refactor-fixed` §4)。
2. **実装の適切さ** — 物理・ゲームの概念が自然な形でコードに現れていること。責務分割、疎結合、
   命名、数式が素直にそのまま書かれていること。
3. **実行時パフォーマンス** — 重要だが上の2つより下。**メモ化や間引きが要るかどうかは実測してから
   判断する。** まず物理的に正確で責務分割が自然な実装を書き、そのうえで測る。
   **既存構造のメモ化を維持することを前提に設計しない** — それをすると自然な実装に辿り着けない。
4. **変更コスト** — 最も低い。「今のコードがそうなっているから」は変更しない理由にならない。
   ただし一度に全部を書き換えると原因の切り分けができないので、フェーズに割って各段で確認する。

その他の前提:

- この Step ではアトラクター数に対して計算量が線形に増える形のままでよい。空間分割(素案 Step3)は
  実装しない。**「登録するのは月以上の質量の主要天体だけ」という運用ルールで N を抑える** —
  コードによる質量フィルタは書かない(要求されていない一般化)。
- **衛星(月)の軌道は解析近似で完結させる。積分にはしない。** 積分誤差が蓄積しないことが
  解析近似を選ぶ理由。太陽摂動は永年項(歳差)と周期項の両方を軌道モデルへ組み込む(§2-1)。
- **入れる摂動の判断基準は「1000 年のオーダーではっきり差が出るか」。** 具体的な判定表は
  §2-1 にある。基準を満たすのに今回入れないもの(分点歳差)は、理由とともに報告する。

---

## 1. 到達点

現状、地球が円軌道、月がケプラー軌道で簡易的に表現されてしまっているところから、比較的正確な太陽系モデルの実現を目指す。

「重力を及ぼし、かつ固定の楕円軌道を動くもの」を容易に追加できるようにし、木星などの惑星や、タイタンなどの大型衛星を追加しやすくするための基盤を作り、テストとして実際に木星を追加して運用してみる。「太陽と月」を前提にハードコードしているEphemerisの解体、再構成と、太陽基準座標系の追加がこのステップの肝となる。

具体的には、§4のフェーズ群を終えたとき、次が成り立っていること。

1. **天体を1つ増やす手順が決まっている。** `PlanetId`(または `SatelliteId`)に id を
   1つ足すと、コンパイラが「軌道モデルの登録」と「見た目の登録」の2箇所を要求してくる。
   それ以外のコード(フォーカス候補・座標系リスト・ラグランジュ点・航法ターゲット・
   クリエイティブの基準天体)はすべてレジストリ由来になっていて、手で足す場所がない。
2. **`ephemeris.ts` に「太陽」「月」という固有名の分岐が1つも残っていない。**
   残っているのは**恒星/惑星/衛星という分類の分岐**だけで、これは物理的主張なので残ってよい。
3. **衛星の太陽摂動が軌道モデルの一部として表現されている。** `satellite-orbit.ts` が
   「簡易月理論」— 永年項(昇交点逆行・近点順行)と周期項(出差・二均差・年差・視差不等)—
   を担い、月の地心位置が 1e3 km オーダーまで合っている。
4. **惑星-衛星系の共通重心がケプラー軌道を描いている。** 地球は重心のまわりを 4,673 km の
   振幅で回り、太陽の地心位置にその運動が現れている。
5. **座標系が「原点天体 × 向き」の直積で表され、太陽中心慣性系・月中心慣性系が
   カメラと軌道線の両方で選べる。**
6. **木星が実際に動いている。** 引力を及ぼし、マップに出て、木星回転系が選べ、
   クリエイティブモードで木星周回軌道に艦を置ける。

---

## 2. 素案からの設計判断(逸脱と理由)

### 2-1. 天体は「恒星 / 惑星 / 衛星」の3分類にする(深さ3で固定)

素案の「太陽・惑星・衛星の3種に大別できる?」に対する答えは **「大別する」**。これは
物理的な事実に基づく分類であって、便宜的なものではない:

| 分類 | 何がケプラー軌道を描くか | 摂動の扱い |
|---|---|---|
| **恒星**(太陽) | 動かない。日心座標系の原点 | — |
| **惑星**(地球・木星) | **その惑星と衛星の共通重心**が太陽まわりのケプラー軌道 | 他惑星による永年変化を要素の変化率として持つ |
| **衛星**(月) | 惑星まわりのケプラー軌道 **+ 太陽摂動** | **無視できない。永年項(歳差)と周期項(出差・二均差・年差…)の両方を補正項として持つ** |

**太陽の質量が支配的すぎるため、素のケプラー軌道で表せるのは惑星だけである。** 衛星は惑星に
束縛されていても太陽から強い摂動を受ける。**`satellite-orbit.ts` は「簡易月理論」を表現する
モジュールとして設計する** — ケプラー二体解に、太陽摂動由来の永年項(昇交点の逆行 18.61 年 /
近点の順行 8.85 年)と周期項(出差・二均差・年差・視差不等)を加算補正として重ねる。
**積分誤差が蓄積しないことがこの解析近似を選ぶ理由**なので、精度が足りなければ項を足す方向で
解決し、積分へは逃げない。

**惑星のケプラー軌道は「惑星そのもの」ではなく「惑星-衛星系の共通重心」の軌道である。**
地球は月に対して十分軽くない(質量比 1:81)ので、地球は重心のまわりを月と逆位相で 4,673 km の
振幅で回っている。惑星本体をケプラー軌道に乗せるとこの運動が消える。JPL の低精度惑星暦の
地球の行が "EM Bary"(地球-月重心)であるのも同じ理由。したがって:

```
重心の日心位置 = planetOrbit(t)                                  ← ケプラー軌道を描くのはこちら
惑星の日心位置 = 重心 − Σ_衛星 (μ_衛星 / (μ_惑星 + Σμ_衛星)) · r_衛星(惑星相対)
衛星の日心位置 = 惑星の日心位置 + r_衛星(惑星相対)
```

衛星の軌道評価には惑星の平均近点角・平均黄経が要る(太陽の方向がそこから決まる)が、
それは**重心のケプラー軌道の角度**から取れるので循環しない。合成は上から下へ1回で済む。

**任意の深さを持つ木にはしない。** 太陽系に安定した二重衛星は存在しないので、
「衛星の衛星」を表現できる必要がない。深さを 3 に固定すれば、**型で
「衛星の親は必ず惑星」を強制でき**、再帰的な木の探索も要らなくなる。

これにより現行の2つのハードコードが消える:

- 太陽の見かけの公転は「地球の日心軌道の符号反転」として導かれる。専用の `sunPosition` は不要。
- 月の歳差込みモデルは、衛星クラスの一事例になる。

**ECI への変換は1箇所だけ**(`日心位置(body) − 日心位置(earth)`)。地球は差が厳密に 0 に
なるので原点固定は保たれ、地球近傍の数値精度は今と変わらない。「あとから全部を太陽基準に
する」と決めた場合の変更は、この引き算1箇所になる。

#### 分類を型に出す

```ts
export type StarId = 'sun';
export type PlanetId = 'earth';               // Phase 7 で 'jupiter' を足す
export type SatelliteId = 'moon';
export type AttractorId = StarId | PlanetId | SatelliteId;
```

`SatelliteBodyDef.planet: PlanetId` と書けば、**衛星の衛星は型として表現できない。**
物理的事実(安定な二重衛星がない)が型に現れる。天体を足すときも、どの分類に足すかを
先に決めることになる。

#### どこまで入れるかの判断基準: 「1000 年のオーダーではっきり差が出るものは入れる」

| 項目 | 大きさ | 判定 |
|---|---|---|
| 月・出差 evection(周期 31.8 d) | 黄経 1.274° ≒ 8,500 km | **入れる** |
| 月・二均差 variation(14.77 d) | 0.658° ≒ 4,400 km | **入れる** |
| 月・年差 annual equation(1 年) | 0.186° ≒ 1,250 km | **入れる** |
| 月・視差不等 parallactic inequality | 約 125″ ≒ 230 km | **入れる** |
| 惑星-衛星系の共通重心(地球で 1 恒星月周期) | 地球の日心位置に 4,673 km | **入れる** |
| 惑星要素の永年変化(地球 ϖ̇ = 0.323°/世紀) | 1000 年で 3.2°(黄道傾斜は 0.13°) | **入れる** |
| 月の潮汐永年加速(≈6″/世紀²) | 1000 年で 0.08° ≒ 560 km | 入れない(閾値以下)。コメントに残す |
| 月軌道長半径の潮汐増大(3.8 cm/年) | 1000 年で 38 m | 入れない |
| **分点歳差・黄道傾斜変化**(25,772 年周期) | **1000 年で赤道の向きが約 5.6°** | **基準は満たすが今回の範囲外 → 下記** |

**分点歳差は「軌道」ではなく「地球の自転軸」の問題**で、ECI の定義そのもの(Y = 北極、
X = 春分点)が時刻に依存するかどうかという別の設計判断になる。J2 の対称軸、大気の共回転、
地球メッシュの自転軸、天球グリッドがすべて巻き込まれる。**今回は固定(J2000 相当)のままにし、
`ecliptic.ts` の先頭コメントに「黄道傾斜は固定。分点歳差は扱わない」と明記する。**
1000 年基準を満たすので、**独立した検討事項としてユーザーへ報告すること。**

上記の判定と、採用したモデルの適用範囲・限界は `planet-orbit.ts` / `satellite-orbit.ts` /
`ecliptic.ts` の先頭コメントに書く(`/refactor-fixed` §4)。

### 2-2. `Ephemeris` は `physics/` に残す。`game/` へ行くのは「天体の見た目」だけ

素案は「太陽・月クラスが THREE 依存を持つので Ephemeris ごと game/ へ」としているが、
**天体暦は「天体がいつどこにいるか」という物理的概念そのものであり、メッシュの所有とは
無関係である。** 両者を1つのクラスに束ねると、その物理的概念がコード上に単独では現れなくなる。
既存の `OrbitEntity`(physics: 状態と履歴)と `GameEntity`(game: メッシュ・HP)の分け方が
まさにこの原則で、敵艦の軌道モデルだけを physics に置き直したりはしていない。天体も同じ形にする。

- `physics/ephemeris.ts` … 位置・速度・回転基準系を返す純粋なサンプラ。**THREE 非依存を維持する。**
- `game/celestial/*.ts` … 天体1つぶんのメッシュ・ラベル・表示距離圧縮を持つ「見た目」。

素案の狙い(EntityManager と Ephemeris が並列になる)は、**game 側の天体ビュー配列と
`EntityManager` の配列が並列になる**ことで満たす。将来 `attractors()` と `integrables()` を
1つのインターフェイスへ寄せるときも、この分け方のまま統合できる。

副次的な帰結として、`physics/frame.ts` `physics/halo.ts` と `tests/physics/*` が
`Ephemeris` を使い続けられる(テストは THREE を読み込めない)。これは判断の理由ではなく、
判断が正しいことの傍証として扱う。

### 2-3. `Frame` は「原点天体 × 向き」の直積にする

現在の `Frame` は**向きしか持たない**(原点は常に ECI 原点)。一方 `attractor.ts` の
`relativeTo`/`toAbsolute` は**原点しか動かさない**。素案の言う「移動する中心、回転する向きの
座標系との相互変換の統一基盤」はこの2つの合流そのものなので、合流させる。

```ts
// 座標系 = 「どの天体を原点に置くか」×「どの天体の公転に合わせて回すか(null = 回さない)」。
export type Frame = {
  readonly center: AttractorId;
  readonly rotatingWith: AttractorId | null;
};
```

- `{center:'earth', rotatingWith:null}` = 現 `'inertial'`(恒等変換)。
- `{center:'earth', rotatingWith:'moon'}` = 現 `'moonRotating'`。
- `{center:'earth', rotatingWith:'earth'}` = 現 `'sunRotating'`。**回転は「公転している側の
  天体」に属する** — 太陽は根で自身の公転を持たないので `rotatingWith:'sun'` は存在しない。
  これで「地球の公転に固定した系」と「太陽の見かけの公転に固定した系」が同じものを
  二重に名乗る状態が消える。
- `{center:'sun', rotatingWith:null}` = 太陽中心慣性系(素案の「太陽基準座標系」)。
  `{center:'moon', rotatingWith:null}` も同時に手に入る。

**文字列 id(`'moonRotating'` のような)にはしない。** 「原点天体」と「回転」は独立な2軸で、
1つの名前に畳むとその独立性が読めなくなるうえ、`moonRotating` という名前からは
**原点が地球であることが読み取れない**(月の親を辿って初めて分かる)。文字列にすると
そのたびにパースが要る。構造体なら `frameTransformAt` は「`center` から原点、`rotatingWith` から
回転」を組むだけになり、分岐もパースも消える。

**`FRAMES` は `SOLAR_SYSTEM` から生成した正準インスタンスの配列にする** — 全天体の
`{center: X, rotatingWith: null}` と、公転している全天体の
`{center: 中心天体(X), rotatingWith: X}`(`rotatingWith` の型は `OrbitingId`)。
UI も含め **`Frame` 値は必ずこの配列から取る**ことにすれば、参照同一性が保たれ、
`sampled-line.ts` の `frame === lastFrame` によるキャッシュ判定もそのまま動く(→ §5-10)。
`SegmentedControl<T extends string>` の `string` 制約は外す(`Map<T, HTMLElement>` は
参照同一性で引けるので実装は変えなくてよい)。`isFrame`(外部文字列の型ガード)は
使われていないので削除する。

### 2-4. 「点」と「方向」を型で分ける

原点が動くようになった瞬間、**位置(アフィン変換: 回転 + 原点平行移動)と方向・変位
(線形変換: 回転のみ)を取り違えるバグが生きる。** 現在 `OverviewCamera` は視点オフセット・
パン・上方向という**3つとも「方向」**を `RelativeVec3` で持っており、そのまま原点移動を
足すと確実に壊れる。

`RelativeVec3` を **`FramePoint` / `FrameDir` の2つの branded type に割る。** これが素案の
「brandedType で型安全に明示」の最小かつ最も効く形。全 `Vec3` に座標系ブランドを付けるのは
やらない(`vec3.ts` のヘルパ群がジェネリック汚染される割に、実際のバグは ECI と
天体相対の取り違えに集中している)。

### 2-5. 系(ラグランジュ点・halo)は「副天体 id」で表す

`'earthMoon' | 'sunEarth'` と `'em-l1' | 'se-l1'` という2系統の列挙をやめ、**副天体の id 1つで
系を指す**。中心天体は分類から決まる(惑星なら太陽、衛星ならその惑星)。

- `em-l1` → `moon-l1`、`se-l1` → `earth-l1`、新設 `jupiter-l1`。
- `LibrationSystem` 型は削除し、`AttractorId`(副天体)を渡す。

表示名は「中心天体の名 - 自分の名 L1」(`地球-月 L1` / `太陽-地球 L1` / `太陽-木星 L1`)を
レジストリから組む。

### 2-6. `AttractorId` は閉じた union のまま

木星を足すのに1行の編集が要るが、その1行が **`Record<AttractorId, …>` のレジストリ2つに
「実装漏れ」をコンパイルエラーとして出させる**トリガーになるので、閉じている価値の方が大きい。

**ただし新規コードで `AttractorId` に対する網羅的 `switch` を書かないこと。** 常に
「レジストリを引く鍵」として扱う。素案 Step3(無数の小惑星)ではこの union は必ず開く必要が
あるので、**そのときに型の変更だけで済み、ロジックの変更が要らない状態を保つ**ことが
この制約の目的。閉じているのは今の実装漏れを検出するためだけであって、「天体の集合は有限で
ある」という主張ではない。

例外は `CelestialBodyDef` の判別 union に対する `kind` の `switch` — こちらは
**分類が3つで閉じているという物理的主張そのもの**なので、網羅性の検査が働く方が正しい。

---

## 3. 完成後のモジュール構成

### `physics/`(THREE 非依存・テスト対象)

| ファイル | 責務 |
|---|---|
| `ecliptic.ts` **新規** | 黄道基底と ECI の関係。`Q_ECL_TO_ECI`(Z上向き黄道→ECI、既存)、`Q_ECLY_TO_ECI`(Y上向き黄道→ECI、新規)、`ECL_POLE_ECI`、`eclToEci` |
| `kepler-orbit.ts` **新規** | 中心天体まわりのケプラー軌道(要素 + 角度の永年変化率)の評価。中心相対の状態・回転基準系・軌道法線。**恒星/惑星/衛星のどれとも無関係な、純粋な軌道の数学** |
| `planet-orbit.ts` **新規** | 惑星の軌道。**惑星-衛星系の共通重心**が描く太陽まわりのケプラー軌道 + 惑星間摂動由来の永年変化率。衛星モデルが要る太陽方向の角度(平均近点角・平均黄経)もここが供給する |
| `satellite-orbit.ts` **新規** | **簡易月理論。** 惑星まわりのケプラー軌道 + 太陽摂動の永年項(歳差)と周期項(出差・二均差・年差・視差不等)。歳差の向きの符号もこのモジュールが決める |
| `solar-system.ts` **新規** | 天体の静的事実の表。`CelestialBodyDef`(恒星/惑星/衛星の判別 union)と `SOLAR_SYSTEM: Record<AttractorId, CelestialBodyDef>` |
| `lagrange.ts` **新規** | 共線点 γ の求解と、回転系での5点の無次元座標(現 `ephemeris.ts` の `collinearGamma` / `lagrangePoints`) |
| `shadow.ts` **新規** | `sunlitFactor`(現 `ephemeris.ts` から移動。天体暦ではない) |
| `ephemeris.ts` **書き直し** | 恒星→重心→惑星/衛星の合成(重心補正を含む)で任意時刻の ECI 位置・速度・`Attractor[]`・回転基準系・ラグランジュ点を返すサンプラ。**固有名の分岐なし** |
| `frame.ts` **書き直し** | `Frame`(原点天体 × 回転)、`FRAMES`、`FrameTransform`、点/方向/状態の順逆変換。**`Ephemeris` を import しない**(変換値を受け取るだけ) |
| `halo.ts` **改修** | 副天体 id で一般化。系の分岐を削除 |
| `elements.ts` **追記** | 平均近点角 → 離心近点角/真近点角(ニュートン法)。`timeSincePeriapsis` の逆で、現在ここに欠けている |
| `attractor.ts` **改修** | `relativeTo`/`toAbsolute` を削除(frame.ts の天体中心系変換へ寄せる) |

### `game/celestial/`(新規フォルダ、THREE 依存)

| ファイル | 責務 |
|---|---|
| `celestial-body.ts` | 抽象 `CelestialBody`。id・メッシュ所有・`sync(fo, displayTime, cameraSystem, ephemeris)` |
| `earth-body.ts` | 地球(`render/earth.ts` のシェーダ地球・自転・オーロラ) |
| `sun-body.ts` | 太陽(ビルボード + `DirectionalLight`) |
| `planet-body.ts` | 月・木星など「テクスチャ球 + 表示距離圧縮」で済む天体 |
| `celestial-registry.ts` | `Record<AttractorId, { name: string; create(): CelestialBody }>`。**表示名の唯一の定義元** |
| `environment-scene.ts` | `render/environment-scene.ts` から**移動**。天体ビュー配列 + 星球 + 天球グリッド + 参照軌道線 + 環境光 |

`render/` に残すのは THREE のビルダーだけ(`earth.ts` `stars.ts` `billboard.ts` `celestial-grid.ts`
`orbitline.ts` `sampled-line.ts`)。**`environment-scene.ts` は現時点ですでに `game/camera/`・
`game/floating-origin`・`game/const` を import しており `render/` の規約に違反している** ので、
この移動はその是正でもある。

---

## 4. フェーズ別手順

### Phase 1 — 軌道モデル(physics のみ、まだ配線しない)

**1-1. `physics/elements.ts` に逆ケプラーを足す。**

```ts
export function eccentricAnomalyFromMean(m: number, e: number): number   // 楕円のみ、ニュートン法
export function trueAnomalyFromMean(m: number, e: number): number
```

級数近似(equation of the center)ではなく**反復解**にする。理由は速度ではなく正確さ —
`physics/` に勝手な近似を持ち込まないという規約であり、反復解はケプラー方程式の厳密解に
機械精度で到達する。現行の月モデルが使っている2項の中心差近似は、ここで捨てる。
これは `timeSincePeriapsis`(真近点角→時刻)の逆方向で、`elements.ts` に**現在欠けている**。

**1-2. `physics/ecliptic.ts` を作る。** 現 `ephemeris.ts` の `stdToEci` / `eclToEci` /
`ECL_POLE` / `ECL_POLE_ECI` / `Q_ECL_TO_ECI` / `EPS` をここへ移す。加えて:

```ts
// Y 上向きの黄道基底(X=春分点, Y=黄道北極)→ ECI。stateFromElements が Y=極 前提なので、
// 黄道基準の軌道要素から組んだ状態はこの回転で ECI へ移す。
export const Q_ECLY_TO_ECI: Quat;   // = qFromAxisAngle(v3(1,0,0), EPS)
```

**符号は思い込みで書かず、テストで固定すること。** 検証すべき不変条件は
`qRotate(Q_ECLY_TO_ECI, v3(0,1,0)) ≈ ECL_POLE_ECI = v3(0, cos EPS, sin EPS)`。

**1-3. `physics/kepler-orbit.ts` を作る(3分類に共通の軌道の数学)。**

```ts
// 中心天体まわりの軌道を、黄道基準の固定ケプラー要素と角度の永年変化率で表したもの。
// 周期的な摂動項は持たない。分類(恒星/惑星/衛星)には関与しない — 変化率が何に由来するかは
// planet-orbit.ts / satellite-orbit.ts の責務。
export type KeplerOrbit = {
  readonly a: number;          // 軌道長半径 [m]
  readonly e: number;          // 離心率
  readonly inc: number;        // 黄道に対する傾斜 [rad]
  readonly raan0: number;      // t=0 の昇交点黄経 [rad]
  readonly raanRate: number;   // 昇交点の変化率 [rad/s]
  readonly lonPeri0: number;   // t=0 の近点黄経 ϖ [rad]
  readonly lonPeriRate: number;// 近点の変化率 [rad/s]
  readonly l0: number;         // t=0 の平均黄経 L [rad]
  readonly lRate: number;      // 平均黄経の変化率 [rad/s](= 2π/公転周期)
};

// 中心天体中心・ECI 軸での状態。mu は中心天体の重力定数。
export function keplerOrbitState(orbit: KeplerOrbit, t: number, phaseOffset: number, mu: number): OrbitState;

// この軌道に固定した回転基準系(x̂ = 中心→自分, ẑ = 軌道面法線)。
export function keplerOrbitRotation(orbit: KeplerOrbit, t: number, phaseOffset: number): FrameRotation;

// 軌道面の法線(単位ベクトル, ECI)。
export function keplerOrbitNormal(orbit: KeplerOrbit, t: number, phaseOffset: number): Vec3;
```

実装の要点:

- 角度は現行 `moonAngles` と同じ順序で組む。**平均黄経 L は公転周期でちょうど1周し、
  平均近点角 M = L − ϖ、昇交点からの緯度引数 u = ν + (ϖ − Ω)。**
  現行コードのコメント(歳差ぶん公転が遅速する罠)がそのまま効くので、同じ注意書きを
  このモジュールの先頭コメントへ移すこと。
- `keplerOrbitState` は **既存の `stateFromElements(t, a, e, inc, raan, argp, nu, mu)` を再利用する。**
  黄道基準の角度をそのまま渡すと「Y = 黄道極」の基底で状態が出るので、`r`/`v` の両方を
  `qRotate(Q_ECLY_TO_ECI, …)` で ECI へ移す。位置と速度を別実装にしない。
- `keplerOrbitRotation` の `omega` は **「黄道極まわりの昇交点歳差」+「軌道面法線まわりの公転」**
  の和(現行 `moonOrbitRotation` と同じ形)。`u` の変化率は
  `u̇ = ν̇ + (ϖ̇ − Ω̇)`、`ν̇ = Ṁ (1 + e cos ν)² / (1 − e²)^{3/2}`。級数展開ではなく
  この閉形式を使う。
- `q` は `qMul(Q_ECL_TO_ECI, Rz(Ω)·Rx(inc)·Rz(u))`(現行 `moonOrbitRotation` と同じ)。
  こちらは Z 上向き黄道基底なので `Q_ECL_TO_ECI` の方を使う。**2つの黄道→ECI 回転が
  用途で使い分けられることを `ecliptic.ts` のコメントに明記すること。**

**1-4. `physics/planet-orbit.ts` を作る。**

```ts
// 惑星: 「その惑星と衛星の共通重心」が描く太陽まわりのケプラー軌道。惑星本体ではなく重心が
// ケプラー軌道に乗る(地球は月に対し 1:81 と十分に重くはなく、重心のまわりを 4,673 km の
// 振幅で回っている)。要素の永年変化は他惑星からの摂動由来で、世紀あたりの値で与える。
export type PlanetOrbit = KeplerOrbit;

export function planetOrbit(p: {
  a; e; incDeg; raanDeg; lonPeriDeg; l0Deg; periodSec;
  raanRateDegPerCentury; incRateDegPerCentury; lonPeriRateDegPerCentury; eRatePerCentury;
}): PlanetOrbit;

// 衛星モデルが要る「太陽の方向」を決める角度。重心のケプラー軌道から取れる。
export function planetAngles(orbit: PlanetOrbit, t: number, phaseOffset: number):
  { meanAnomaly: number; meanLongitude: number; meanAnomalyRate: number; meanLongitudeRate: number };
```

- **`≈0` で済ませない。** 地球の ϖ̇ = 0.323°/世紀 は 1000 年で 3.2° になり、判断基準を満たす
  (§2-1)。`KeplerOrbit` が持たない `inc`/`e` の変化率が要るなら `KeplerOrbit` 側を拡張する。

**1-5. `physics/satellite-orbit.ts` を作る(簡易月理論)。**

```ts
// 衛星: 惑星まわりのケプラー軌道 + 太陽摂動。太陽の質量が支配的なため摂動は無視できず、
// 永年項(昇交点の逆行・近点の順行)と周期項(出差・二均差・年差・視差不等)の両方を持つ。
// 周期項は黄経・黄緯・動径への加算補正として、基本角の線形結合を引数に持つ正弦項の和で表す
// (Brown の月理論を主要項で切り詰めた形)。
export type SatelliteOrbit = {
  readonly kepler: KeplerOrbit;               // 二体部分。永年歳差は raanRate/lonPeriRate が担う
  readonly lonTerms: readonly PerturbationTerm[];   // 黄経補正 [rad]
  readonly latTerms: readonly PerturbationTerm[];   // 黄緯補正 [rad]
  readonly distTerms: readonly PerturbationTerm[];  // 動径補正 [m]
};

// 引数は基本角の線形結合。d = 太陽からの平均離角、m = 衛星の平均近点角、
// mp = 惑星の平均近点角、f = 昇交点からの緯度引数。
export type PerturbationTerm = {
  readonly d: number; readonly m: number; readonly mp: number; readonly f: number;
  readonly amp: number;
};

export function satelliteOrbit(p: {
  a; e; incDeg; raan0Deg; lonPeri0Deg; l0Deg; periodSec;
  nodePeriodSec;    // 昇交点歳差の周期。逆行(raanRate < 0)
  perigeePeriodSec; // 近点歳差の周期。順行(lonPeriRate > 0)
  lonTerms; latTerms; distTerms;
}): SatelliteOrbit;

// 惑星中心・ECI 軸での状態。太陽の方向は planetAngles 経由で入る。
export function satelliteState(
  orbit: SatelliteOrbit, planetAngles: PlanetAngles, t: number, phaseOffset: number, mu: number,
): OrbitState;
```

実装と設計の要点:

- **符号を呼び出し側に書かせない。** `satelliteOrbit` が `raanRate = −2π/nodePeriodSec`、
  `lonPeriRate = +2π/perigeePeriodSec` を組む。これが「衛星クラスが太陽摂動を担う」ことの
  実体で、データ表に `−` を書くのとは意味が違う(データ表の符号は書き間違えても誰も気付かない)。
- **歳差周期は実測値で与える。** 一次の摂動論から導くと近点歳差が実測の約半分になる
  (ニュートンを悩ませ Clairaut が二次項で解決した有名な問題)。**正確さが最優先なので、
  導出値ではなく実測周期を使う。** その旨をモジュール先頭コメントに書く。
- **二体部分は厳密ケプラー解、周期項はその上への加算。** したがって
  **中心差(equation of the center)に相当する項 — 引数が `m` のみの項 — を周期項の表に
  入れてはいけない。** ケプラー解が既に出しているので二重計上になる。同様に、黄緯の
  主傾斜項(引数が `f` のみ)も軌道傾斜の幾何が出すので入れない。**表を出典から写すときの
  最大の事故ポイントなので、テストで押さえること**(Phase 3-2)。
- **周期項の数値表は出典を確認して埋めること。** Meeus『Astronomical Algorithms』第47章
  (Brown の月理論の切り詰め)が標準的な出典。**この文書に書いてある振幅は検証の目安であって
  出典ではない。** 主要項の目安は 出差 1.274°·sin(2D−M)、二均差 0.658°·sin(2D)、
  年差 −0.186°·sin(M′)、視差不等 −0.0347°·sin(D)。**判断基準(§2-1)に従い、黄経で
  0.01°(≒70 km)を超える項までを入れる。** 採用した閾値と到達精度を先頭コメントに書く。
- **速度も解析式で出す。** 各項の時間微分は `amp · arġ · cos(arg)`、`arġ` は基本角の変化率の
  同じ線形結合。**中心差分を使わない**(位置と速度で別実装にしない)。
- **回転基準系(`keplerOrbitRotation`)と軌道法線は「平均要素」から組む。** 周期項を混ぜると
  角速度が滑らかでなくなり、ラグランジュ点も揺れる。**その結果、衛星の実位置は回転系の
  +X 軸から最大 1.4° ほどずれる。** これは意図した設計なのでコメントに書き、テストの
  不変条件もそれに合わせる(§5-12)。
- 二体部分の評価は `kepler-orbit.ts` を共有する。**評価器を2つ作らない。**

**1-6. `physics/solar-system.ts` を作る。**

```ts
export type CelestialBodyDef =
  | { readonly kind: 'star';      readonly id: StarId;      readonly mu: number; readonly radius: number }
  | { readonly kind: 'planet';    readonly id: PlanetId;    readonly mu: number; readonly radius: number;
      readonly orbit: PlanetOrbit }                                   // 中心は必ず恒星
  | { readonly kind: 'satellite'; readonly id: SatelliteId; readonly mu: number; readonly radius: number;
      readonly planet: PlanetId;  readonly orbit: SatelliteOrbit };   // 中心は必ず惑星

// 宣言順が attractorsAt の返す配列順になる。地球を先頭に置く(ECI 原点であることが読めるように)。
export const SOLAR_SYSTEM: Record<AttractorId, CelestialBodyDef>;
```

`AttractorId` を `StarId | PlanetId | SatelliteId` に割るのは `physics/attractor.ts`(§2-1)。

数値(いずれも黄道基準・J2000 相当):

| 天体 | 分類 | ケプラー軌道を描くもの | a | e | inc | Ω | ϖ | 周期 |
|---|---|---|---|---|---|---|---|---|
| sun | star | — | — | — | — | — | — | — |
| earth | planet | **地球-月重心** | 1.495978707e11 m | 0.01671123 | ≈0 | 0 | 102.93768° | 恒星年 365.25636 d |
| moon | satellite | 月(地球中心) | 3.844e8 m | 0.0549 | 5.145° | 0 | 0 | 恒星月 27.321661 d |

- 地球の永年変化率(JPL 低精度惑星暦の "EM Bary" 行、世紀あたり):
  ϖ̇ = 0.32327364°、i̇ = −0.01294668°、ė = −0.00004392、Ω̇ = 0、ȧ = 0.00000562 au。
  **`≈0` で潰さない**(§2-1 の 1000 年基準)。
- 月の歳差周期: 昇交点 18.612958 年(逆行)/ 近点 8.85 年(順行)。**符号は
  `satelliteOrbit` が付けるので、表には正の周期を書く。**
- 月の周期摂動項は Phase 3 で埋める。Phase 1 の時点では空配列でよい。
- `μ_sun = 1.32712440018e20`、`R_sun = 6.957e8`、`μ_moon = 4.9048695e12`、`R_moon = 1.7374e6`
  (現 `ephemeris.ts` の定数をそのまま移す)。地球は `orbital-state.ts` の `MU_EARTH` / `R_EARTH`
  を読む(定数の複製を作らない)。**重心補正の重み `μ_moon/(μ_earth+μ_moon)` はここの値から
  導く**(0.0121506… — 定数として書かない)。
- **`earth.l0` は「t=0 で太陽の ECI 方向が +X」になる値にする。** これは物理定数ではなく
  **ゲーム側の初期条件の選択**(開始時刻を昼側に置く)で、`SIM_EPOCH_UTC` と同じく実暦とは
  無関係な表示上のアンカー。ϖ≠0 なので `l0 = π` ではない — 「重心の真黄経が π」から
  `ν → E → M → L` と戻して求めた値を定数として書き、**`|sunDirAt(0) − (1,0,0)| < 1e-4` を
  テストで固定する**(重心補正ぶん厳密には +X からわずかにずれるので、Phase 1 の 1e-6 より
  緩い許容にする)。「ゲームの初期位相であって J2000 の実値ではない」ことをコメントに書く。
- `MOON_DIST` / `SUN_DIST` は `SOLAR_SYSTEM` の `a` に一本化し、独立した export は消す
  (テストが参照しているので同時に直す)。

**1-7. `physics/lagrange.ts` を作る。** 現 `ephemeris.ts` の `collinearGamma` と
`lagrangePoints` をそのまま移す(質量比 `mu` と `place` を受ける形は良い設計なので変えない)。
`LagrangePoints` 型もここへ。

**1-8. テストを足す。** `tests/physics/kepler-orbit.test.ts` と
`tests/physics/satellite-orbit.test.ts` を新設し、`tests/physics/index.ts` へ登録する。

- `trueAnomalyFromMean` ⇄ `timeSincePeriapsis` の往復が機械精度で戻ること(e = 0 / 0.0549 / 0.3)。
- `keplerOrbitState` / `satelliteState` の速度が、位置の中心差分と一致すること(相対 1e-6)。
  **これが「速度の解析式と位置の式が別物になっていない」ことの担保。周期項を足しても
  成り立つ必要がある**(Phase 3 でも再確認する)。
- `keplerOrbitRotation` の `omega` が、基底の中心差分と一致すること
  (`assertOmegaMatchesBasis` が `ephemeris.test.ts` にあるのでヘルパを共有する)。
- **`satelliteOrbit` が歳差の符号を正しく組むこと** — 月で昇交点が逆行(18.61 年で1周)、
  近点が順行(8.85 年で1周)。**分類の物理的内容そのものなので、必ずテストで固定する。**
- **周期項の表に「引数が `m` のみ」「引数が `f` のみ」の行が無いこと**(二重計上の検出)。
  Phase 1 では空表なので自明に通るが、Phase 3 で効くのでここで書いておく。
- 月の軌道: 赤道傾斜が 18.3°〜28.6° を交点周期で掃くこと、法線が位置と直交すること
  (現 `ephemeris.test.ts` の月の検査をこちらへ移してよい)。

**検証:** `npm run typecheck` / `npm run test:physics`。この時点でゲームの挙動は変わらない。

---

### Phase 2 — `Ephemeris` の再構築と呼び出し側の移行

**2-1. `physics/ephemeris.ts` を書き直す。** 新しい公開 API:

```ts
export class Ephemeris {
  // phaseOffsets は天体ごとの平均黄経の初期オフセット。既定は月のみ乱数(現行の挙動)。
  constructor(phaseOffsets?: Partial<Record<AttractorId, number>>);

  attractorsAt(t: number): readonly Attractor[];      // SOLAR_SYSTEM 宣言順、地球は原点で厳密に 0
  stateOf(id: AttractorId, t: number): OrbitState;     // ECI
  positionOf(id: AttractorId, t: number): Vec3;        // ECI
  orbitRotationAt(id: OrbitingId, t: number): FrameRotation;          // 恒星は受け付けない
  orbitNormalAt(id: OrbitingId, t: number): Vec3;                     // 同上
  lagrangeAt(secondary: OrbitingId, t: number): LagrangePoints;       // 中心天体は分類から決まる
  sunDirAt(t: number): Vec3;                           // 照明用。恒星が1つであることは固有名でよい
  frameTransformAt(frame: Frame, t: number): FrameTransform;          // Phase 5 で追加
}

// 公転している天体 = 惑星 + 衛星。回転基準系・軌道法線・ラグランジュ点は恒星には存在しない。
export type OrbitingId = PlanetId | SatelliteId;
```

- 内部の合成は §2-1 の3行そのまま:
  ①各惑星の**重心**の日心状態を `PlanetOrbit` から出す →
  ②各衛星の惑星相対状態を `SatelliteOrbit` + その惑星の `planetAngles` から出す →
  ③`惑星 = 重心 − Σ(μ_衛星/(μ_惑星+Σμ_衛星))·r_衛星`、`衛星 = 惑星 + r_衛星` →
  ④最後に全体から地球のぶんを引いて ECI 化。
  **再帰も親ポインタの探索も要らない** — 深さが 3 で固定なので `kind` の2分岐で素直に書ける。
  `earth` は自分自身を引くので厳密に `v3(0,0,0)` になる。
- **重心補正は位置と速度の両方に効く。** 地球の ECI 速度は 0 のままだが、**太陽の ECI 速度**は
  重心補正ぶん変わる(月周期で ±12 m/s 程度)。片方だけ直すと `Elements` や
  `relativeTo` 経由の表示が静かにずれる。
- **`orbitRotationAt` / `orbitNormalAt` / `lagrangeAt` は `null` を返さない。** 引数の型を
  `OrbitingId` に絞れば「恒星には公転がない」が型で表現でき、呼び出し側の `null` 分岐が消える。
- **削除するもの:** `sunPosition` / `moonPosition` / `moonAngles` / `sunAngles` /
  `sunOrbitRotation` / `moonOrbitRotation` / `moonOrbitNormal` / `emLagrangePoints` /
  `seLagrangePoints` / `sunPosAt` / `moonPosAt` / `sunVelAt` / `moonVelAt` /
  `sunOrbitRotationAt` / `moonOrbitRotationAt` / `moonOrbitNormalAt` / `emLagrangeAt` / `seLagrangeAt`。
  **旧名のエイリアスを残さない**(規約)。旧名を全文検索して 0 件にすること。
- **速度は中心差分でなく解析式で位置と同時に出る。** `attractorsAt` が組む `Attractor.state` の
  `v` はそのまま解析値になる。
- **メモ化は入れない。** 現行の `sunMemoT`/`moonMemoT`/`attractorsMemo`(リング長2)と
  `LazyVelAttractor` はすべて削除し、**毎回素直に軌道を評価する実装にする。**
  既存のメモ化を前提に設計すると、「メモが当たる呼び出し順」という隠れた制約が
  そのまま新実装へ持ち越され、自然な形に辿り着けない。**まず正しく素直な実装を置く。**
  (現行コードのコメントには「メモなしは 850 体 × 64 substep で +20 ms/frame」という
  過去の実測が残っているが、構造が変わる以上その数字は当てにしない。測り直す。)

**2-1b. 実測する。** 2-1 を入れた直後に `?perf=1` で **update フェーズの ms** を測り、
Phase 0 時点の値と比較して記録する。エンティティ数を稼ぐためステージ00(無限サバイバル)を
使い、時間加速を上げて substep 数も稼ぐこと。**測定値をこの文書に追記してから次へ進む。**

判断は測ってから:

- 実用上問題ない → **そのまま。メモ化を入れない。**
- 問題がある → **何が重いのかを特定してから**対処を選ぶ。候補は(a)`attractorsAt(t)` の
  結果配列のメモ化、(b)`Simulator` が substep ごとに1回だけ引いて `stepSim` へ配列を渡す形
  (隠れたキャッシュがなくなるぶん (a) より素直だが、全エンティティが同じ epoch を持つという
  構造的に保証されていない前提に乗る)、(c)ケプラー反復の初期値改善。
  **(a) を反射的に選ばない。** どれを選ぶにせよ、選んだ理由と実測値をコメントに残す。
- **物理的正確さや責務分割を犠牲にする案しか残らない場合は、実装せずユーザーに報告する。**

**実測結果(2026-08-08 時点):** ステージ00・`?perf=1` をヘッドレス Chrome で起動できることと、
新しい `Ephemeris`(メモ化なし)でも実行時例外が出ないことは確認した。ただし
`,`/`.` キーでの時間加速・敵ウェーブ発生をヘッドレス上で確実に誘発できず、
Phase 1 時点(メモ化あり)との厳密な before/after 比較(高エンティティ数・高 substep 数での
update フェーズ ms)は取得できなかった — **測定不能。** 単発観測では `sim`(update 相当)
0.39ms/frame・敵/弾/デブリ 0 体という低負荷状態の値のみ得られており、比較材料にならない。
メモ化は追加していない(指示どおり)。厳密な比較が必要になったら、`SimSpeedManager` を
直接操作してウォームアップ後に警告なく段階加速させるドライバスクリプトを別途用意すること。

**2-2. `sunlitFactor` を `physics/shadow.ts` へ移す。** 天体暦ではない。シグネチャは
現状のまま(地球の円柱影)にし、他天体の影への一般化はまだやらない。
import 元は `render/environment-scene.ts` と `game/player/player.ts`。

**2-3. 呼び出し側の移行。** 機械的な置換(§ 呼び出し一覧は下記):

| 旧 | 新 |
|---|---|
| `ephemeris.moonPosAt(t)` | `ephemeris.positionOf('moon', t)` |
| `ephemeris.sunPosAt(t)` | `ephemeris.positionOf('sun', t)` |
| `ephemeris.moonVelAt(t)` | `ephemeris.stateOf('moon', t).v` |
| `ephemeris.moonOrbitNormalAt(t)` | `ephemeris.orbitNormalAt('moon', t)` |
| `ephemeris.moonOrbitRotationAt(t)` | `ephemeris.orbitRotationAt('moon', t)` |
| `ephemeris.sunOrbitRotationAt(t)` | `ephemeris.orbitRotationAt('earth', t)` ※ |
| `ephemeris.emLagrangeAt(t)` | `ephemeris.lagrangeAt('moon', t)` |
| `ephemeris.seLagrangeAt(t)` | `ephemeris.lagrangeAt('earth', t)` |

※ **`earth` の回転基準系は現 `sunOrbitRotation` と x̂ が 180° 反対を向く**(新定義の x̂ は
親→自分 = 太陽→地球)。ẑ は同じ。影響を受けるのは `frame.ts` の `'sunRotating'`、
`nav-target` の面法線(ẑ なので影響なし)、`halo.ts`(Phase 4 で書き直す)、
`OverviewCamera` に保存された視点オフセット(初回だけ 180° 回った位置になるが、
ドラッグで直せる表示上の一過性)。**この反転を承知の上でやること。**

対象ファイル(Phase 1 のサーベイ結果):
`game/camera/focus-markers.ts`、`game/nav-target.ts`、`game/stages/creative-stage.ts`、
`render/environment-scene.ts`、`game/player/player.ts`、`physics/halo.ts`、`physics/frame.ts`、
`tests/physics/{ephemeris,frame,halo,attractor,dynamics,orbit-entity,plan}.test.ts`。

**2-4. 自由関数 `sunPosition` の直接呼び出しを潰す。**
`game/player/player-fire.ts:248` と `game/game-entity/enemy.ts:265` が
`sunPosition(simTime, 0)` を共有インスタンス経由せずに呼んでおり、位相が非ゼロになった
瞬間に太陽方向が食い違う。**`Ephemeris` の参照を受け取って `sunDirAt(simTime)` を呼ぶ形に直す。**
(自機側と敵側は別実装のままでよい — `/refactor-fixed` §12。共有するのは天体暦だけ。)

**2-5. `render/environment-scene.ts` の月軌道線。** `moonOrbitElements` が
`moonPosAt` の 2 点差分で疑似 `r,v` を作っているが、`stateOf('moon', t)` が速度を直接返すので
差分は不要になる。差し替えること。

**検証:** `npm run typecheck` / `npm run test:physics` / ゲームを起動して
太陽方向・月位置・照明・マップの月軌道線が今までどおりであること。

テストの更新点:

- 太陽距離が定数ではなくなる(地球軌道が離心率 0.0167 の楕円になるため
  1.471e11〜1.521e11 m を振る)。距離を定数で固定しているアサーションは範囲チェックへ直す。
- 太陽-地球 L1/L2 の無次元比(0.00997 / 0.01004)は無次元なのでそのまま通るはず。
- **重心の不変条件を新しく足す:**
  `(μ_e·r_earth + μ_m·r_moon)/(μ_e+μ_m)` が `PlanetOrbit` から出した重心位置と機械精度で
  一致すること(位置・速度とも)。**これが重心補正が入っていることの直接の証明。**
- **太陽の ECI 位置が、地球を完全なケプラー軌道に置いた場合と 4,673 km 前後ずれ、
  そのずれが月の位相と逆相関で 1 恒星月周期で振れること。** 実装が入っていなければ 0 になる。

---

### Phase 3 — 簡易月理論(衛星の周期摂動項)

**独立したフェーズにしてある理由:** ここは数値表の写し間違いと二重計上が最も起きやすく、
かつ月の位置がずれても他はすべて動いてしまうので、**単独で切り出さないと原因の切り分けが
できない。** Phase 2 まで終わっていればゲームが動くので、目視でも確認できる。

**3-1. `SOLAR_SYSTEM.moon.orbit` の `lonTerms` / `latTerms` / `distTerms` を埋める。**

- 出典を確認して写す(Meeus『Astronomical Algorithms』第47章 = Brown の月理論の切り詰めが標準)。
  **この文書の数値は検証の目安であって出典ではない。**
- **黄経で 0.01°(≒70 km)を超える項までを入れる**(§2-1 の判断基準)。
- **引数が `m` のみの行(中心差)と `f` のみの行(主傾斜)は入れない。** ケプラー解と
  軌道傾斜の幾何が既に出している。**ここが最大の事故ポイント。**
- 採用した閾値・項数・到達精度を `satellite-orbit.ts` の先頭コメントに書く。

**3-2. テスト**(`tests/physics/satellite-orbit.test.ts` に追加):

- **各主要項の振幅**: 引数を分離して振幅を測り、出差 1.274° / 二均差 0.658° /
  年差 0.186° / 視差不等 0.0347° と一致すること。**再現できないなら実装か表が間違っている。**
- **ケプラー解との差の最大値が黄経で 1.3°〜1.5° に収まること。** これを大きく超えるなら
  中心差を二重に足している。
- **速度が中心差分と一致し続けること**(周期項の微分が入っても)。
- **歳差周期が変わっていないこと** — 昇交点 18.61 年 / 近点 8.85 年。周期項は永年項を
  動かしてはいけない。
- 月の地心距離が 3.564e8〜4.067e8 m の範囲に収まること(近地点〜遠地点の実測範囲)。

**検証:** `npm run test:physics` / ゲームを起動し、マップで月が飛ばないこと・
月軌道線が破綻しないこと。**Phase 2 と比べて月の位置が最大 1e4 km 動くのが正常。**

---

### Phase 4 — ラグランジュ点・halo の一般化と id 体系

**4-1. `Ephemeris.lagrangeAt(secondary, t)`。** 分類から中心天体を決め
(惑星なら太陽、衛星ならその惑星 — `SOLAR_SYSTEM[secondary].kind` の2分岐)、
`primaryPos = positionOf(primary, t)`、`R = |positionOf(secondary,t) − primaryPos|`、
`q = orbitRotationAt(secondary, t).q`、`mu = μ_sec / (μ_pri + μ_sec)` を組んで
`lagrange.ts` の `lagrangePoints(mu, place)` へ渡す。`place` は

```
p_eci = primaryPos + qRotate(q, v3(R * x, R * y, 0))
```

の1本だけ。**現行 `seLagrangePoints` にある `(1 − x, −y)` の符号操作は不要になる**
(x̂ を中心→自分に統一したため)。同時に、太陽-地球系の `R` が定数 `SUN_DIST` ではなく
瞬時の離心距離になり、精度が上がる。

**4-2. `physics/halo.ts` の一般化。**

- `LibrationSystem` 型を削除。`collinearFrame(secondary: OrbitingId, point, t, ephemeris)` にする。
- `earthMoon` / `sunEarth` の分岐(現 64-81 行)を、分類から中心天体を決める汎用コードへ:
  `primaryPos = positionOf(primary)`、`secondaryPos = positionOf(secondary)`、
  `omega = orbitRotationAt(secondary).omega`、`normal = orbitNormalAt(secondary)`、
  `mu = μ_sec/(μ_pri+μ_sec)`、`origin = lagrangeAt(secondary, t)[point]`。
  **現行の `sunEarth` 分岐が `normal = norm(omega)` としているのは「太陽側は歳差がないから
  omega がそのまま黄道法線」という個別事情に依存している。** 汎用版は常に `orbitNormalAt`
  を使う(歳差の有無に依らず正しい)。
- `HaloParams` / `LissajousParams` の `system` フィールドは `secondary: OrbitingId` に改名。

**4-3. ラグランジュ点 id を `${secondary}-l${n}` に統一。**
`em-l1..5` → `moon-l1..5`、`se-l1..5` → `earth-l1..5`。影響:

- `game/camera/focus-markers.ts` … `LABEL_NAMES` と `positions` の2つのハードコード表を
  **両方削除**し、`SOLAR_SYSTEM` と `celestial-registry` から組み立てる。
  1天体につき「天体本体のラベル」と「公転しているなら L1〜L5」を生成する。
- `game/nav-target.ts:97-107` `resolvePlaneNormal` … `id === 'moon'` /
  `startsWith('em-l')` / `startsWith('se-l')` の3分岐を、
  「id が公転天体なら `orbitNormalAt(id, t)`」「id が `${b}-l${n}` 形式なら
  `qRotate(orbitRotationAt(b,t).q, Z_HAT)`」の2分岐に畳む。
  地球も `orbitNormalAt` が扱えるので、**副産物として地球も航法ターゲットにできるようになる**
  (現在は `null` で弾かれている)。これは改善なので受け入れる。太陽は恒星なので
  `OrbitingId` に含まれず、今までどおり弾かれる — **型で弾かれるので実行時の分岐が要らない。**
- `game/creative/ship-placer-panel.ts` … `LIBRATION_SYSTEM_ITEMS` をレジストリ由来にする。
  `ReferenceBody = 'earth' | 'moon'` も `AttractorId` へ広げる(§Phase 7 と同時でよい)。
- `game/stages/creative-stage.ts` … `buildLibrationState` は `form.librationSystem` を
  そのまま副天体 id として渡すだけになる。

**4-4. `creative-stage.ts` の `'earth' | 'moon'` 分岐を畳む。**
`buildElementsState`(219/220/241 行)・`updatePreview`(98/99/107 行)・
`assertValidElementsForm`(250/252 行)に**同じ二分岐が3回**書かれている。
基準天体の `Attractor` を1つ引けば、μ・半径・ECI 化がすべてそこから出る:

```
const body = ephemeris.attractorsAt(simTime).find(b => b.id === form.body)!;
// mu = body.mu, radius = SOLAR_SYSTEM[form.body].radius,
// ECI 化 = 相対状態 + body.r / body.v(Phase 4 後は frame.ts の天体中心系変換で)
```

**検証:** `npm run typecheck` / `npm run test:physics`(`halo.test.ts` の
ISEE-3 halo の振幅検証、`ephemeris.test.ts` の共線点距離 0.15093/0.16783/0.00997/0.01004 が
そのまま通ること — 通らなければ §4-1 の写像が間違っている)。マップでラグランジュ点ラベルが
すべて出ること、クリエイティブで halo 軌道が置けること。

---

### Phase 5 — `Frame` の拡張(太陽基準座標系)

**5-1. `physics/frame.ts` を書き直す。**

```ts
// 座標系 = 原点天体 × 回転(§2-3)。値は必ず FRAMES の正準インスタンスを使う。
export type Frame = { readonly center: AttractorId; readonly rotatingWith: AttractorId | null };
export const FRAMES: readonly Frame[];   // SOLAR_SYSTEM から生成

// ある時刻の座標系の剛体運動。origin/originVel は ECI での原点の位置・速度、
// q は「系相対 → ECI」の姿勢、omega は ECI 成分の角速度。
export type FrameTransform = {
  readonly origin: Vec3; readonly originVel: Vec3;
  readonly q: Quat; readonly omega: Vec3;
};

// 位置(アフィン: 回転 + 原点移動)
export function toFramePoint(tf: FrameTransform, p: Vec3): FramePoint;
export function toInertialPoint(tf: FrameTransform, p: FramePoint): Vec3;
// 方向・変位(線形: 回転のみ)
export function toFrameDir(tf: FrameTransform, d: Vec3): FrameDir;
export function toInertialDir(tf: FrameTransform, d: FrameDir): Vec3;
// 状態
export function toFrameState(tf: FrameTransform, s: OrbitState): FrameOrbitState;
export function toInertialState(tf: FrameTransform, t: number, s: FrameOrbitState): OrbitState;
```

- **`Ephemeris` を import しない。** 変換に要るのは `FrameTransform` の値だけ。
  `Frame` → `FrameTransform` の解決は `Ephemeris.frameTransformAt(frame, t)` の責務にする。
  これで `frame.ts` は純粋な変換モジュールになり、循環依存もなくなる。
- 状態の変換式は原点移動を含む形へ:
  `r_rel = R⁻¹(r − o)`、`v_rel = R⁻¹(v − ȯ − ω×(r − o))`、逆はその逆。
- `RelativeVec3` を `FramePoint` / `FrameDir` に割る(§2-4)。`RelativeOrbitState` は
  `FrameOrbitState` へ改名。
- `frameTransformAt` は分岐を持たない: 原点は `stateOf(frame.center, t)`、回転は
  `frame.rotatingWith === null ? 恒等 : orbitRotationAt(frame.rotatingWith, t)`。
  **これが §2-3 で構造体を選んだ効果** — 文字列だったらここにパースと switch が入る。

**5-2. `attractor.ts` の `relativeTo` / `toAbsolute` を削除する。**
天体中心系への変換は `frameTransformAt({center: id, rotatingWith: null}, t)` + `toFrameState`
に一本化。
`elementsAround(s, body)` は `Attractor` から直接 `FrameTransform` を組む小さなヘルパ
(`frameOfAttractor(body)`)を使って書き直す。呼び出し側は
`plan-editor.ts:518,620` と `creative-stage.ts`。

**5-3. 呼び出し側の移行。**

- `render/sampled-line.ts` … `syncGeometry` は `toFrameState` を `FrameTransform` を受ける形へ。
  `syncTransform` は **`line.position` を `fo.RtoThreeV3(EARTH_CENTER)` から
  `fo.RtoThreeV3(tf.origin)` へ**変える(これだけで原点移動に対応する。剛体変換なので
  毎フレーム O(1) のままであることが重要)。定数 `EARTH_CENTER` は消える。
- `game/camera/overview-camera.ts` … `offset_r` / `pan_r` / `up_r` は**すべて `FrameDir`**。
  `toFramePos`/`toInertialPos` を `toFrameDir`/`toInertialDir` へ置換する。
  **ここを `Point` 側にすると原点移動ぶんだけ視点が飛ぶ。型で守られるが、意味を理解して置くこと。**
- `game/plan/plan-trajectory.ts:119` `toDisplay` … 点なので `toFramePoint`(サンプル時刻の
  変換)→ `toInertialPoint`(表示時刻の変換)。`FrameTransform` を2つ引く形になる。
- `game/hud/frame-labels.ts` … `FRAME_ITEMS` を定数表から **`FRAMES` を回す生成関数**へ。
  表示名は `rotatingWith === null` なら `${天体名}中心慣性系`、そうでなければ
  `${親名}-${天体名}回転系`。**`Frame` 値は `FRAMES` の要素をそのまま渡す**(新しく
  オブジェクトを作らない — 参照同一性が壊れる)。
- `game/camera/overview-camera-panel.ts` / `game/plan/plan-display.ts` … `FRAME_ITEMS` の
  参照方法だけ変わる。

**検証:** `npm run typecheck` / `npm run test:physics`
(`frame.test.ts` の往復テストを、原点が動く系 — `{center:'sun'}` / `{center:'moon'}` — にも
広げること。**「月が `{center:'moon', rotatingWith:null}` で常に原点にいる」
「月が `{center:'earth', rotatingWith:'moon'}` で **+X から 1.5° 以内**にいる」
「太陽が `{center:'sun', rotatingWith:null}` で常に原点にいる」**が効く不変条件。
**回転系は平均要素から組むので、月の実位置は周期摂動ぶん +X 軸からずれる** — 厳密な
+X 一致を要求するテストを書かないこと(§5-12))。
ゲーム側は、マップの座標系セレクタに太陽中心系・月中心系が現れ、
選ぶと視点と計画軌道線がその系に貼り付くことを目視で確認する。

---

### Phase 6 — 天体の見た目を `game/celestial/` へ

**6-1. `render/environment-scene.ts` を `game/celestial/environment-scene.ts` へ移動。**
すでに `game/` に依存しているので、これは規約違反の是正。import パスを直すだけ。

**6-2. `CelestialBody` を作る。**

```ts
// 天体1つぶんの見た目。位置・速度は持たない(Ephemeris が唯一の正本)。
export abstract class CelestialBody {
  abstract readonly id: AttractorId;
  abstract build(scene: THREE.Scene): void;
  abstract sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void;
}
```

- `EarthBody` … 現 `syncEarth`(自転角・`earth.tick`・`setSunDir`)。
- `SunBody` … 現 `syncSkyBodies` の太陽ビルボード部分 + `DirectionalLight` の向き。
  日照率による強度調整は自機位置に依存する**表示上の演出**なので、`EnvironmentScene` が
  `sunlitFactor` を計算して `SunBody` へ渡す形を維持する(`physics/` の値を `game/` で歪める
  という既存の切り分けどおり)。
- `PlanetBody` … 現 `placeCombatMoon` の表示距離圧縮を持つテクスチャ球。月と木星が共有する。
  スケール式(`visDist * radius / trueDist` で真の視直径を保つ)はここに1つだけ置く。

**6-3. `game/celestial/celestial-registry.ts`。**

```ts
export const CELESTIAL_VIEWS: Record<AttractorId, { name: string; create(): CelestialBody }>;
```

**表示名(`地球`/`月`/`太陽`/`木星`)の定義元はここ1箇所にする。**
`focus-markers.ts` / `frame-labels.ts` / `ship-placer-panel.ts` / `camera-system.ts` の
`PANEL_FOCUS_IDS` はすべてここを読む(日本語の表示文字列を `physics/` に置かないこと)。

**6-4. `EnvironmentScene` は天体ビューの配列を持つ形へ。** `sync` は
`for (const b of this.bodies) b.sync(...)` になり、星球・天球グリッド・参照軌道線・環境光だけが
直接の持ち物として残る。

**6-5. `camera-system.ts` の `PANEL_FOCUS_IDS`** をレジストリ由来にする
(天体本体のみ。ラグランジュ点は今までどおり右クリックメニュー経由)。

**検証:** `npm run typecheck` / ゲーム起動。地球・太陽・月の見た目、戦闘視点での月の
視直径、マップでの実スケール表示が今までどおりであること。

---

### Phase 7 — 木星の追加(受入テスト)

**7-1.** `physics/attractor.ts` の **`PlanetId`** に `'jupiter'` を足す
(`AttractorId` は `StarId | PlanetId | SatelliteId` から自動で広がる)。
**この時点でコンパイルエラーになる箇所が、天体追加に必要な作業の全量。**
`SOLAR_SYSTEM`(physics)と `CELESTIAL_VIEWS`(game)の2つの `Record` だけが赤くなるのが
正解。それ以外が赤くなったら、そこはまだレジストリ由来になっていない。

**「どの分類に足すか」を最初に決めることになる**のがこの型設計の狙い。木星は惑星なので
`PlanetId`。仮に将来ガニメデを足すなら `SatelliteId` + `planet: 'jupiter'` になる。

**7-2.** `SOLAR_SYSTEM.jupiter`(`kind: 'planet'`, 中心は太陽):

| 項目 | 値 |
|---|---|
| kind | `'planet'` |
| mu | 1.26686534e17 m³/s² |
| radius | 6.9911e7 m(平均半径) |
| a | 7.78340821e11 m (5.20288700 au) |
| e | 0.04838624 |
| inc | 1.30439695° |
| Ω | 100.47390909°、Ω̇ = 0.20469106°/世紀 |
| ϖ | 14.72847983°、ϖ̇ = 0.21252668°/世紀 |
| L0 | 34.39644051° |
| 公転周期 | 11.862 年 → `lRate = 2π/(11.862 × 365.25 × 86400)` |

**7-3.** `CELESTIAL_VIEWS.jupiter` は `PlanetBody`。**テクスチャは用意しない** —
既存の月テクスチャを流用せず、単色マテリアル(帯模様なし)で置く。見た目の作り込みは
この Step の目的ではないので、ここで時間を使わないこと。

**7-4. 受入確認**(すべて手で確認する):

1. マップに `木星` ラベルと `太陽-木星 L1〜L5` が出る。
2. 座標系セレクタに `木星中心慣性系` と `太陽-木星回転系` が出る。選ぶと木星が静止する。
3. クリエイティブモードの基準天体に `木星` が出て、木星周回軌道に艦が置ける。
   置いた艦の軌道線が木星を中心に描かれる(`Elements.center` 経由)。
4. 木星を航法ターゲットにできる。
5. **`?perf=1` で update フェーズの ms を、Phase 2-1b で記録した値と比べる。**
   重力源が 3 → 4 になり、`attractorAccel` は全エンティティ × RK4 4 段 × substep 数ぶん回る
   最内ループなので、+30% 程度の増加が出うる。**この増加は物理的に必要な計算であって、
   無駄ではない** — 減らすには「遠方天体を無視する」という近似(素案 Step3)を入れるしかない。
   許容できないほど悪化した場合は**その場で空間分割を作らず、測定値を添えてユーザーに報告し、
   判断を仰ぐこと。**

---

### Phase 8 — 文書の更新(同じ変更セットに含める)

- **`CLAUDE.md`** … Architecture 節の `physics/ephemeris.ts` / `physics/frame.ts` /
  `physics/attractor.ts` / `render/environment-scene.ts` の記述を全面的に書き直す。
  新設モジュール(`ecliptic` / `kepler-orbit` / `planet-orbit` / `satellite-orbit` /
  `solar-system` / `lagrange` / `shadow` / `game/celestial/*`)を追加。
  **恒星/惑星/衛星の3分類とその物理的根拠**、**ケプラー軌道を描くのは惑星本体ではなく
  惑星-衛星系の共通重心であること**、**1000 年基準で何を入れ何を入れなかったか**を
  Architecture 節に散文で書く。`test:physics` のカバー範囲の記述も更新する。
  **古い記述は消す。「かつては〜」を書かない。**
- **`DEVELOP/OWNERSHIP.md`** … `Ephemeris` の所有と、`EnvironmentScene` が持つ天体ビュー配列。
- **`DEVELOP/CALLSTACK.md`** … `sync` フェーズの天体まわりの呼び出し順。
- **`DEVELOP/SPEC.md`** … 選べる座標系が増えたこと、木星が存在すること、
  ラグランジュ点の表示名が変わったこと。
- **`.claude/skills/refactor-fixed/SKILL.md`** … §3(独自 `Vec3` と `THREE.Vector3` の境界)を
  **座標系の規約へ拡張する。** 素案が「refactor_fixed に反映すべき重要事案」と書いている点。
  書くべき内容:
  - 独自 `Vec3` / `OrbitState` は **ECI(地球中心慣性系)** を表す。これが既定であり、
    シミュレーションはすべてこの系で回る。
  - ECI 以外の座標系の値は **`frame.ts` の branded type**(`FramePoint` / `FrameDir` /
    `FrameOrbitState`)でしか持たない。生の `Vec3` に「実は月中心」の値を入れない。
  - **点と方向を混ぜない。** 位置は `FramePoint`、オフセット・速度差・上方向などの変位は
    `FrameDir`。原点が動く系ではこの取り違えが静かに壊れる。
  - 変換は必ず `Ephemeris.frameTransformAt` で引いた `FrameTransform` を通す。
    天体位置を自分で引き算して座標系を作らない。
  - 天体の静的事実は `physics/solar-system.ts`、表示名と見た目は
    `game/celestial/celestial-registry.ts`。**`AttractorId` に対する網羅的 `switch` を書かない**
    (常にレジストリを引く鍵として扱う)。
- **`memos/hedalu244/better_simulation_todo.md`** … Step2 を消し、Step3 の記述に
  「この時点で何が済んでいるか」を反映する(経緯は残さない)。
- 大きな変更なので、最後に **`/comment-cleanup`** で新旧コメントを一括点検する。

---

## 5. 落とし穴チェックリスト

実装中に必ず引っかかる/引っかかったことに気づきにくい点。

1. **`{center:'earth', rotatingWith:'earth'}` の x̂ が現 `'sunRotating'` と 180° 逆。**
   新定義の x̂ は中心→自分(太陽→地球)、現行は地心→太陽。ẑ は同じなので
   ラグランジュ点も航法面法線も正しいまま、**視点の初期向きだけがひっくり返る**。
   バグではないので直そうとしないこと。
2. **`OverviewCamera` の3つの保存値は「方向」であって「点」ではない。**
   Phase 5 で `Point` 側に置くと、系を切り替えた瞬間にカメラが天体の位置ぶん飛ぶ。
3. **`sampled-line.ts` は頂点をフレーム相対で焼き、毎フレームは剛体変換だけを更新する。**
   原点移動を「頂点の書き換え」で実装すると毎フレーム全頂点を触ることになり、
   設計意図(O(1))が壊れる。**必ず `line.position` で表現すること。**
4. **地球の ECI 位置は厳密に 0 でなければならない。** 日心位置から地球ぶんを引く実装なら
   自動的に 0 になるが、地球だけ別経路で組むと 1e-5 m 程度の origin drift が入り、
   `attractorAccel` の原点補正項が壊れる。
5. **`attractorsAt(t)` は毎回新しい配列・新しい `Attractor` を返してよい。**
   `GameEntity.elementsAround` のメモは `state` の参照同一性と **`body.id`(文字列)** に
   載っていて、配列やオブジェクトの参照同一性には依存していない(`game-entity.ts:32-36`)。
   メモ化を外しても壊れない。**性能が問題になるかどうかは Phase 2-1b の実測で決める。**
6. **`Elements.center` は `Attractor` そのものを持つ = その時刻の位置のスナップショット。**
   `elementsAround` のメモが `body.id` だけで無効化されるので、**`state` が変わらないまま
   時刻だけ進むエンティティ(死んだ艦など)は `center.r` が古いまま返る。**
   既存の性質だが、`center` がオブジェクトになったぶん表面化しやすい。軌道線の中心が
   ずれて見えたらここを疑う。
7. **太陽距離が定数でなくなる。** 距離を等号で見ているテスト・表示があれば範囲へ直す。
   `SUN_DIST` を「1 au の定数」として参照している箇所は `SOLAR_SYSTEM.earth.orbit.a` に寄せる。
8. **`Q_ECL_TO_ECI`(Z 上向き)と `Q_ECLY_TO_ECI`(Y 上向き)の取り違え。**
   前者は回転基準系の姿勢、後者は `stateFromElements` の出力の移送に使う。
   両方 `ecliptic.ts` に置き、コメントで用途を書き分けること。
9. **Phase 2 の時点では月の位置が「今より正確」とは限らない。** 中心差近似が厳密ケプラー解に
   なるぶんは改善するが、周期摂動項が入るのは Phase 3。**「新実装の方が正しいはず」を根拠に
   テストの期待値を緩めないこと。** 現行値と食い違ったら、まず実装の誤りを疑う。
11. **歳差の符号は `satelliteOrbit` の中だけに書く。** データ表に `−2π/18.6yr` と書いてしまうと、
    「昇交点は逆行する」という物理的主張がただの数値に埋もれ、他の衛星を足すときに
    符号を間違えても誰も気付かない。データ表には**正の周期**を書く。
12. **回転基準系と軌道法線は平均要素から組む。周期摂動項を混ぜない。** 混ぜると角速度が
    滑らかでなくなり、ラグランジュ点も揺れ、`toFrameState` の `ω×r` 項が壊れる。
    **代償として、月の実位置は `moonRotating` の +X 軸から最大 1.4° ずれる。**
    これは意図した設計。テストの不変条件を「厳密に +X」で書かないこと。
13. **周期摂動項の表に中心差(引数が `m` のみ)を入れると二重計上になる。** 出典の表は
    ケプラー解を使わない形式で書かれているので、そのまま写すと必ずこれを踏む。
    黄緯の主傾斜項(引数が `f` のみ)も同様。**Phase 3 のテストで機械的に検出すること。**
14. **重心補正は位置だけでなく速度にも入れる。** 片方だけ直すと `Elements` や
    天体中心系変換を通した表示が静かにずれ、位置だけ見ていても気付けない。
10. **`Frame` は構造体になるので、値をその場で作らない。** `{center:'earth', rotatingWith:null}`
    をリテラルで書くと `sampled-line.ts` の `frame === lastFrame` が毎フレーム偽になり、
    軌道線の全頂点が毎フレーム焼き直される(静かに重くなるだけで、見た目は壊れない)。
    **必ず `FRAMES` の要素を参照する。** 既定値も `FRAMES` から取る。

---

## 6. この Step でやらないこと

- 空間ハッシュ・質量による重力源のカリング(素案 Step3)。**質量フィルタのコードも書かない。**
- **衛星の積分軌道化。** 衛星は解析近似(ケプラー + 太陽摂動の永年項 + 周期項)で完結させる。
  **積分誤差が蓄積しないことが解析近似を選ぶ理由**なので、精度不足を感じても積分へ逃げない —
  足すなら項を足す。
- **分点歳差・黄道傾斜変化**(1000 年で赤道の向きが約 5.6°)。判断基準は満たすが、
  これは軌道ではなく**地球の自転軸**の問題で、ECI の定義そのものを揺らす(J2 の対称軸・
  大気の共回転・地球メッシュ・天球グリッドが巻き込まれる)。**今回は固定のままにし、
  独立した検討事項としてユーザーへ報告する。**
- 月の潮汐永年加速(1000 年で 0.08°)と軌道長半径の増大(1000 年で 38 m)。閾値以下。
- 4段目以降の階層(衛星の衛星)。**型として表現できない形にするのが正解。**
- 小惑星のような「積分軌道 + アトラクター」の中間種。`EntityManager` と
  `EnvironmentScene` の統合もまだやらない — **並べられる形にするところまで**が Step2。
- **メモ化・軽量化の先回り。** 測ってからにする(§0 の優先順位 3、Phase 2-1b)。
- `sunlitFactor` の他天体への一般化(木星の影)。移動だけして中身は触らない。
- 木星のテクスチャ・大気・環などの見た目の作り込み。
- 天体の自転(地球以外)。`PlanetBody` は自転を持たない。
- `Elements` / `OrbitLine` の変更。`center` 経由でどの天体中心の楕円も描けるので、
  Step1 の成果だけで木星周回軌道の描画は通るはず。**通らなければそこにバグがある。**

### Step3 へ渡す設計上の約束

Step3 で入るのは「重力を及ぼし、かつ重力の影響を受けるもの」= **小惑星**(衛星ではない)。
そのとき今回の成果が邪魔にならないよう、次を守ること。

1. **`Ephemeris` の公開 API は「id と時刻を渡すと状態が返る」形に保つ**
   (`stateOf(id, t)` / `attractorsAt(t)`)。**「解析軌道である」ことが API に漏れないこと。**
   Step3 の小惑星は `physics/orbit-entity.ts` の `OrbitEntity`(過去の `history` と未来の
   `predicted` を持ち `at(t)` に答える)側から来るが、**重力源の一覧を引く口が
   `attractorsAt(t)` 1つのままなら**、解析天体と積分天体を同じ配列に混ぜるだけで済む。
   `KeplerOrbit` / `PlanetOrbit` / `SatelliteOrbit` を `Ephemeris` の外へ露出させない。
2. **分類の判別 union は「恒星/惑星/衛星」で閉じたままにする。** 小惑星はこの union に
   足すのではなく、`OrbitEntity` 側の存在として `attractorsAt` に合流させる
   (小惑星は解析軌道で表せないから小惑星なのであって、4つ目の分類ではない)。
3. **`game/celestial/` の `CelestialBody`(見た目)は位置を持たない。** 位置は常に
   `Ephemeris` から引く。ここで座標をキャッシュすると、正本が2つになる。
4. **`attractorAccel` の原点補正項に手を入れない。** ECI 原点(地球)が月・太陽に引かれて
   加速することは既にこの項が表現しており、天体暦モデルの粗さとは独立している。

---

## 7. フェーズごとの検証コマンド

```
npm run typecheck          # 全フェーズで必ず
npm run test:physics       # Phase 1〜5(physics/ を触るフェーズ)で必ず
npm run dev                # Phase 2 以降、目視確認
npm run dev + ?perf=1      # Phase 0(基準)・Phase 2-1b・Phase 7-4 の3点で測って記録
```

`/verify`(ヘッドレス実行)は Phase 7 の受入確認でだけ使う。

**着手前に Phase 0 の基準値を測っておくこと。** ステージ00 で時間加速を上げ、
エンティティが増えた状態の update フェーズ ms を記録する。これがないと Phase 2-1b の
判断ができない。
