# Step 3 実装手順 — 重力を及ぼしかつ受ける天体(小惑星・自由な多体系)の導入

`better_simulation_todo.md` の実装計画素案 Step3 を、現状のコード(Step1/Step2 完了後)と
突き合わせて具体化したもの。素案は「無数の小惑星」「自由な星系」「座標系の脱却」「命名の再検討」
など論点が広く、かつ「未決事項」「〜かもしれない」という書き方が多い。本書はそれを検討し、
**Step3 が実際に到達すべき最小十分な範囲**を再設定した上でフェーズ分けしている。素案からの
逸脱は §2 に理由つきで列挙した。

作業前に `.claude/skills/refactor-fixed/SKILL.md` と `/comment` を読むこと。
**各フェーズは単独でコミットできる状態(typecheck + test:physics が通り、ゲームが起動する)で
終えること。** フェーズをまたいで壊れたまま進めない。

---

## 0. 前提と優先順位

**判断が競合したら、この順で決める(`/refactor-fixed` §5)。**

1. **物理的正確さ** — `physics/` では最優先。近似を入れるなら適用範囲・限界をモジュール
   先頭コメントに明記する。
2. **実装の適切さ** — 責務分割・疎結合・命名・数式が素直にそのまま書かれていること。
   **同じ概念に2つの型・2つの名前を与えない。** 本書はこの観点から、当初の素案(既存の
   `Attractor` とは別に `gravitySource` という新しい型を導入する案)を破棄し、`GameEntity`
   自身が `Attractor` と同じ形を直接持つ設計に差し替えている(§2-1)。同じ観点から、
   `SOLAR_SYSTEM` レジストリ・ECI 原点・恒星(主星)の解決についても、「地球・太陽が
   常に存在する」という前提をコードのあちこちに個別にハードコードしたまま「自由な星系」の
   見た目だけを作ることはしない — レジストリそのものを差し替え可能にする(§2-4)。
3. **実行時パフォーマンス** — 重要だが上2つより下。**空間ハッシュによる軽量化は、
   軽量化なしの実装で実測してから要否を判断する。** 先に最適化を作り込まない。
4. **変更コスト** — 最も低い。ただし一度に全部書き換えず、フェーズごとに確認しながら進める。
   **設計の良さは変更コストの大きさより優先される。** 影響範囲が広いことは、その一般化を
   見送る理由にはならない — 見送るなら、見送るだけの物理的・設計的な理由が要る。

その他の前提:

- Step2 の残タスク(分点歳差の扱い、月理論の数値表の未検証項目)は本書のスコープ外。
  `better_simulation_todo.md` に残したままにする。
- **`feature_todo.md`「衝突判定の統一化」(実体弾・剛体・天体表面への接触を、種別でなく
  質量と相対速度から求まる力積へ1実装に統合する予定)とは、今回意図的に密結合させない。**
  この統合が実際にどちらの形に転んでも今回の変更が邪魔にならないよう、Asteroid は
  既存の衝突経路(`radius` を持つ全エンティティが対等に参加する `CollisionPhysics`)へ
  そのまま乗せるだけにし、`mu` の値によって衝突の扱いを分岐させる新しいコードを
  一切書かない(§2-7)。

---

## 1. 到達点(成功基準)

素案が Step3 に掲げた目標は次の2つ:

1. 無数の小惑星を追加してもパフォーマンス的に O(NM) で爆発しないこと。
2. 太陽が存在しない3連星系といった自由な星系を表現できるようにすること。

本書終了時に、次が成り立っていること:

1. **`id`/`radius`(旧 `collideRadius`)/`mu`/`state` という共通の形が `GameEntity` の
   ネイティブフィールドとして揃い、`GameEntity` が変換なしに構造的に `Attractor` として
   扱える。** `mu: number` は `0` が「重力を及ぼさない」を意味する(重力の式がその天体の
   寄与を係数0倍するのと数学的に同義な、既定・無効を表す数値)。`radius: number | null` は
   `null` が「剛体接触に参加しない」を意味し、`0` はそれ自体が「半径0の質点として参加する」
   という有効な値である(半径 a の物体と半径 b の物体は距離 a+b 以下で接触すべきで、これは
   a・b のどちらかが0であっても成り立つべきだから)。**`mu` と `radius` は無効値の表し方が
   異なる**(`mu` は0が無効、`radius` は`null`が無効)— 「重力を持つかどうか」と「剛体接触に
   参加するかどうか」は独立な話であり、たまたま同じ0という数値に無効の意味を重ねると、
   半径0の点物体を表現できなくなる(§2-1)。
2. **「重力を及ぼし、かつ重力の影響を受ける」物体(小惑星)が実装され、`GameEntity` の
   通常の積分経路(`DynamicTrajectory`/`stepActual`)にそのまま乗る。** 新しい解析軌道の
   分類は増えない(素案の「星/惑星/衛星」3分類は変えない)。
3. **複数の小惑星どうし、および小惑星と自機/敵/デブリの間で相互重力が正しく働く。**
   二体の場合の周期・全運動量保存がテストで検証されている。
4. **小惑星の個数が数百〜数千に増えても、1体あたりの計算量が近傍のものだけに抑えられる**
   (空間ハッシュによる軽量化。ただし §2-11 のとおり、実測してから要否を判断した上で入れる)。
5. **「自由な星系」が、物理的性格の異なる2つの機能の組み合わせとして実現されている。**
   (a) 質量が比較可能な複数天体が相互に複雑な軌道を描く状況は、閉じた解析解を持たないので
   `GameEntity`(小惑星)の数値積分でしか表現できない — これは目標1の小惑星機構がそのまま
   担う(§2-8)。(b) 現実の太陽系(地球・月・木星・太陽)とは異なる天体の集合・階層・原点で
   進行するステージ(恒星が1つも無い系、木星が原点の系など)は、解析的な天体暦のままで
   表現できるが、`Ephemeris` が読む天体レジストリそのものが**ステージごとに差し替え可能**で
   なければならない。**`SOLAR_SYSTEM` を `Ephemeris` インスタンスへ注入可能にし、ECI 原点・
   主星(ラグランジュ点や惑星の軌道基準)の解決を「現在使われているレジストリ」から動的に
   引くよう一般化する(§2-4)。** 両方がそれぞれ独立したデモとして示されている(Phase 7)。
6. **MAP VIEW のカメラ座標系選択・TRAJECTORY の計画軌道座標系選択・天体名表示・艦艇配置
   パネルの基準天体選択が、いずれも「現在アクティブな `Ephemeris` が実際に持っている天体」
   から動的に組み立てられる。** 登録済み太陽系天体(地球・月・木星・太陽)に加えて生存中の
   重力天体(`mu !== 0` の `GameEntity`)も回転系の基準に選べ、かつ地球・月・木星・太陽の
   いずれかを欠く(あるいは全く異なる)レジストリでも GUI がクラッシュしたり地球中心
   固定のまま動かなくなったりしない(§2-4・Phase 6)。これが無いと、項目5の(b)は
   コード上存在してもプレイヤーが実際に選んで眺める手段が無い空虚な機能になる。
7. **既存のゲームプレイ(自機・敵・地球・月・木星の挙動)が一切変わらない。** 小惑星が
   1体も存在せず、ステージが既定のレジストリ(現実の太陽系・地球原点)を使っている限り、
   新しいコード経路は旧コード経路とビット単位で同じ結果を返す(既存の `test:physics` が
   無改造で通ることで確認する)。

---

## 2. 設計判断(素案からの逸脱と理由)

### 2-1. `GameEntity` に `id`/`radius`/`mu`/`degree2` をネイティブフィールドとして持たせ、
    変換なしで `Attractor` と構造的に一致させる

**最初に立てた「`GameEntity` に `gravitySource: {id, mu, radius} | null` という新しい
オプショナルフィールドを追加する」という案は撤回する。** 既存の `Attractor` 型
(`{id, mu, radius, state, degree2, isStar}`)とほぼ同じ形の型を並べて作ることになり、
「同じものに別の名前を与えない」「類似の型を二重に実装しない」という原則に反していたため。
以下の気づきに基づいて設計をやり直した。

**`id` と `radius` はそもそも重力とは無関係の、`GameEntity` 一般の概念である。**

- `radius`(旧 `collideRadius`)は現在 `GameEntity` に既にある。「未設定 = 剛体接触に
  参加しない」という**オプショナル値**として実装されている。この無効値の表し方を
  `undefined` から明示的な `null` へ変える(型は `number | undefined` から `number | null`
  へ)。**`0` へは変えない。** 半径 `a` の物体と半径 `b` の物体は距離 `a+b` 以下まで
  近づいたら弾かれるべきで、これは `a`・`b` のどちらかが `0` であっても成り立つべきだから
  である。すなわち「半径0の質点として剛体接触に参加する」(`radius === 0`)と「剛体接触に
  一切参加しない」(`radius === null`)は区別されるべき別の状態であり、前者を後者の意味に
  奪われてはならない。**一方 `mu` は事情が異なる。** `mu === 0` のとき万有引力の式が
  その天体の寄与を係数0倍するので、「重力源として扱わない」ことと「`mu = 0` として扱う」
  ことは数学的に同義であり、`0` を無効値に使っても意味を奪う対象がない(計算を省くための
  軽量化に過ぎない)。**したがって `radius` は `null` を無効値、`mu` は `0` を無効値とする、
  意図的に異なる形の既定値になる**(両者を同じ形に揃えることが目的ではない)。
- `id` は今日すでに `Player.id`/`Enemy.id?`/`Ammo.id`/`Base.id` としてクラスごとに
  バラバラに(場当たり的に)実装されている(§2-2 で詳述)。重力天体のためだけに
  5つ目の id 概念を作るのではなく、この場当たり性自体を先にリファクタリングし、
  `GameEntity` が最初から `id: string` を持つようにする。

**`state` の get/set は既存コードが既に満たしている。** `GameEntity` は今すでに

```ts
get state(): KinematicState { return this.actualTrajectory.state; }
set state(s: KinematicState) { this.actualTrajectory.reset(s); }
```

を持っており、「積分の場合は set されたら軌道を更新する」を実装済み。ここは変更しない。

**結論として、`GameEntity` に次の4フィールドをネイティブに持たせる:**

```ts
// game-entity.ts
readonly id: string; // 一意な識別子。表示名(Ship.name 等)とは別の概念(§2-2)
radius: number | null = null; // 物理的半径 [m]。null = 剛体接触に参加しない(既定)。
                               // 数値(0を含む)= その半径で参加する。mu !== 0 のときは、
                               // この値がその重力源の表面半径にもなる(altitude 表示等)。
                               // radius と mu は独立なフィールドなので、radius === null の
                               // まま mu !== 0 になる(表面を持たない重力源)ことも型の上
                               // では許される — Step3 では Asteroid が常に両方へ実数を
                               // 設定するので実際には生じないが、物理関数側の扱いは
                               // Phase 4(4-2)で決める。
protected mu = 0; // 重力定数 GM [m^3/s^2]。0 = 重力を及ぼさない(既定)。0以外なら重力源になる。
readonly degree2: null = null; // GameEntity は2次重力場(J2/C22 のような非球対称項)を
                                // モデル化しない。不整形な小天体のそれは無視できるほど
                                // 小さく、ゲームプレイ上考慮しない。
```

`state`(既存の getter)と合わせて、この4つで `GameEntity` は変換関数なしに構造的に
`Attractor` 型と一致する(TypeScript の構造的型付けにそのまま乗る — `degree2: null` は
`Degree2Gravity | null` の部分型なので問題なく代入できる)。**ただしこの一致には
`physics/attractor.ts` 側の型変更が1つ要る:** 現行の `Attractor.radius: number`(非null)
のままでは `GameEntity.radius: number | null` を代入できない。`Attractor.radius` も
`number | null` へ広げ、`radius` を読む物理・表示側の関数が `null` を「表面を持たない
(高度・表面接触判定の対象外)」として扱うよう直す必要がある — 変更箇所と扱いの詳細は
Phase 4(4-2)にまとめた。`Attractor` はこれとは別に `isStar: boolean`(§2-4)という
フィールドも持つが、これは `GameEntity` が常に `false` を返せば足りる不変の事実
(小惑星が「主星」になることはない)なので、Phase 5(§2-4)で `readonly isStar: false =
false;` として同じ場所に追加する — `degree2` と全く同じ理由・同じ形の追加であり、
本フェーズではまだ追加しない(`isStar` が実際に必要になるのは Phase 5 からなので、
そこでまとめて追加する)。

`EntityManager` が重力源一覧を作る処理は変換ではなく**フィルタだけ**になる:

```ts
// entity-manager.ts
// 重力を持つ(mu !== 0 かつ生存中の)エンティティを、変換なしに Attractor として返す。
// GameEntity は id/radius/mu/degree2/state を直接持つので、Attractor 型への変換コードは要らない。
// フィルタ条件が mu だけであることに注意 — radius(剛体接触の可否)は重力の可否と無関係
// なので、radius === null の重力源が将来現れてもここには影響しない。
attractors(): readonly Attractor[] {
  return this.all().filter((e) => e.alive && e.mu !== 0);
}
```

**これに伴い、既存の `radius`/`collideRadius` まわりの命名衝突を1つ解消する。**
`Ship`(`Player`/`Enemy` の基底)は既に `radius: number` というフィールドを持っているが、
これは**被弾判定半径**(弾丸との命中判定用)であり、剛体接触の `collideRadius` とは
意図的に別物(`ship.ts:17` の既存コメント: 「被弾判定半径 [m](剛体接触の collideRadius
とは別)」)。実際 `Player` は「剛体接触は実機体サイズのまま、被弾判定半径だけ放熱板の
展開に応じて広がる」という**意図的な乖離**を持っている(`player.ts:87` のコメント:
「剛体接触は実機体サイズ。被弾判定半径(radius)を使うと排莢直後の薬莢を弾いてしまう」)。
この2つを1つの `radius` フィールドへ統合することはできない(統合すると Player のこの
挙動が壊れる)。そこで **`Ship.radius`(被弾判定半径。常に定義される値であり `null` は
扱わない)を `Ship.hitRadius` に改称し**、`GameEntity.radius`(剛体接触 + 重力源の表面
半径。`null` を無効値とする)と名前が衝突しないようにする。影響は `ship.ts`・
`enemy.ts`・`player.ts`・`simulation/hit.ts` の4ファイル程度で、機械的な改名
(意味は一切変えない)。

この改名を今回一度に行う根拠は、`collideRadius`(未設定=無効)というオプショナル値と
`Ship.radius`(被弾判定半径、常に必須)という**名前だけが衝突する無関係な2つのフィールド**
が、今回 `mu`/`radius` という共通のネイティブフィールド一式を `GameEntity` に導入する
ことでより紛らわしくなるため。無効値の表し方(`mu` は `0`、`radius` は `null`)は
それぞれの物理的な意味に従って意図的に別のままにする。

### 2-2. `id` の場当たり性をこの変更セットで解消する

現状を調べると、識別子の持ち方がクラスごとに4通りに分かれている:

| クラス | 識別子の実装 | 備考 |
|---|---|---|
| `Player`(`entity-id: string`) | 必須。`entityId = name` を既定値に、コンストラクタ引数で明示指定も可 | **既に `name`(重複可の表示名)と `id`(マップ選択用の不変キー)を分離済み**(`player.ts:44-45` の既存コメント) |
| `Enemy`(`id?: string`) | 省略可能。セーブデータ復元時のみ設定され(`enemy.ts:322`)、生存中の実運用では**代わりに `name` を識別子として使っている** | `map-picker.ts`/`nav-target.ts` に `entities.enemies.find(e => e.name === target.id)` という形の検索が7箇所ある — `name`(表示名、重複しうる)を識別子に使っているのは `Player` が既に卒業した設計の古い形 |
| `Ammo`(`id: string`) | 自己生成(`ammo-${counter}`)。復元 id を渡されたら採用し、カウンタをその番号より先へ進める(将来の自動採番と衝突しないため) | |
| `Base`(`id: string`) | `Ammo` と同じパターンを独立に再実装(`base-${counter}`) | `Ammo` と実装が重複している |

**`Player` が既に到達している「`name`(重複可の表示名)と `id`(不変な識別キー)を分離する」
形を、`GameEntity` の基底に引き上げて全クラスへ揃える。** `GameEntity` に `readonly id: string`
を追加し、コンストラクタで明示的な id を受け取らなければ自動採番する。`Ammo`/`Base` が
それぞれ持っている「採番 + 復元 id によるカウンタ追い越し」ロジックは、共通のヘルパへ
一本化して両方から使う(重複実装の解消)。`Enemy` は `id` を必須にし(`Player` と同じ形)、
`name` は表示専用に純化する。

**`map-picker.ts`/`nav-target.ts` の `entities.enemies.find(e => e.name === target.id)`
という形の検索(7箇所)を `e.id === target.id` に直す**(`MapPickable` を組み立てている
`map-picker.ts:106` の `{ id: enemy.name, name: enemy.name, ... }` も `{ id: enemy.id, name:
enemy.name, ... }` に直す)。これにより「同名の敵が複数存在すると片方が選択できない」という
既存の潜在的な不具合も副次的に直る。

### 2-3. `Attractor.id` は `AttractorId` を経て後で `string` へ開く

`/refactor-fixed` は「素案 Step3 ではこの union は必ず開く必要がある」としていた。調査の結果、
`Attractor` を消費する関数(`attractorAccel`/`strongestAttractor`/`localOrbitPeriod`/
`hitAttractor`/`frameOfAttractor`/`orbitalElementsOf`/`stepDynamics`)は元々 `Attractor` 型
そのものを引数に取っており `AttractorId` を直接要求していないので、`Attractor.id` の型を
広げること自体はロジック側を無改造のまま通せる。

ただし、**この型変更を単独で先に行うことはしない。** `Attractor.id` だけを広げても、
`AttractorId`(および `StarId`/`PlanetId`/`SatelliteId`/`OrbitingId`)や `SOLAR_SYSTEM` 自体は
今なお単一のグローバルなレジストリに固定されたままで、実際に「登録されていない天体」が
`Attractor.id` に現れる状況(小惑星が重力の中心になる、レジストリがステージごとに異なる)は
まだコード上どこにも作られていない — 型だけ広げても実質的な意味を持たない。

そこで `Attractor.id`(および `AttractorId` そのものの型定義)の変更は、`SOLAR_SYSTEM` の
レジストリ化・ECI 原点・主星解決の一般化とまとめて **Phase 5(§2-4)で1度に行う。** 影響範囲
(`bodyDef(x)` や `Record<AttractorId, …>` の添字に、`strongestAttractor`/`orbitalElementsOf`
経由で得た「もう `AttractorId` の元の閉じた集合には絞り込めない」id を渡している箇所)は
Phase 5 の節で洗い出す。

### 2-4. `SOLAR_SYSTEM` レジストリ・ECI 原点・主星解決・回転系フォーカスを一般化する

これが素案の「太陽系のハードコードからの脱却」「ECI 前提の座標系からの脱却」「自由な星系」に
直接対応する、本書で最も範囲の広い設計判断なので詳しく書く。

**現状のハードコードは3箇所ある(実際にコードで確認した):**

1. `SOLAR_SYSTEM`(`physics/solar-system.ts`)がモジュールレベルの `const` であり、
   `Ephemeris` はコンストラクタでは受け取らず、常にこの1つのグローバルな登録内容
   (地球・月・木星・太陽)を読む。ステージごとに天体の集合を変えられない。
2. `Ephemeris.stateOf` が ECI 化のために `helioStateOf('earth', t)` を無条件に引く。
   ECI の原点が地球だとハードコードされている。
3. `Ephemeris.lagrangeAt`(および `solar-system.ts` の `primaryOf`、`physics/halo.ts`、
   `game/camera/focus-markers.ts`、`game/creative/ship-placer-panel.ts` に同型のコードが
   合計5箇所)が、惑星の主星を文字列リテラル `'sun'` 固定で扱う
   (`def.kind === 'planet' ? 'sun' : def.planet` という三項演算子が5箇所に重複している)。

**方針: `SOLAR_SYSTEM` を「既定のレジストリ」として残しつつ、`Ephemeris` インスタンスが
自分の使うレジストリ・原点天体を持てるようにする。** 既存の呼び出し元
(`game.ts:114` の `new Ephemeris()`)は引数を渡さなければ今までどおり現実の太陽系・地球原点で
動く — 挙動もコンパイル結果も変えない。ステージがカスタムのレジストリ・原点を使いたいときだけ、
コンストラクタへ渡す。

1. **`AttractorId` を `string` に開く。** `StarId`/`PlanetId`/`SatelliteId` は削除する
   (「クローズドな文字列 union のキー」という役目しか持っておらず、レジストリが複数
   存在しうる以上その役目自体が成立しない)。`OrbitingId` は `AttractorId` の別名として残す
   (`export type OrbitingId = AttractorId;`) — 強制力は無くなるが、「恒星ではなく公転する
   天体を渡すべき引数」であることをシグネチャ上で示す注釈としての価値は残るため、
   呼び出し側のシグネチャを一律 `AttractorId` へ変えるより変更が小さい。`bodyDef` の
   `KindOf<T>`/`BodyDefOf<T>` という、id の型引数から具体的な kind を絞り込む型レベルの
   仕掛けは、レジストリが実行時に決まる以上もう機能しないので削除し、`bodyDef` は
   `CelestialBodyDef`(判別 union そのもの)を返す素直な関数にする。呼び出し側は
   `.kind` の実行時判定で絞り込む(`ephemeris.ts` の `helioStateOf` が既にやっている形)。
2. **`solar-system.ts` に `CelestialRegistry`(`= Readonly<Record<AttractorId,
   CelestialBodyDef>>`)という型を新設し、`bodyDef`/`primaryOf` をレジストリ引数を取る
   形に直す。** `SOLAR_SYSTEM` は「現実の太陽系」という名前つきのデータとして今までどおり
   `solar-system.ts` に残る(既定値)。`primaryOf(registry, id)` は、5箇所に重複していた
   `def.kind === 'planet' ? 'sun' : def.planet` という三項演算子を置き換える**唯一の**
   実装になる — レジストリの中から `kind: 'star'` の天体を探して返す(0個または複数個
   見つかったら例外。**「主星がちょうど1つ、または0個」の星系のみサポートする** —
   相互に公転しあう連星系(2個以上の恒星が互いの重心を回る)は対象外とし、コメントで
   明記する。理由は §2-8 参照)。この変更だけで、halo.ts・focus-markers.ts・
   ship-placer-panel.ts に重複していた同型の三項演算子3箇所も、この1つの実装を呼ぶ形に
   置き換わる(重複実装の解消という副産物)。
3. **`Ephemeris` のコンストラクタが `registry: CelestialRegistry = SOLAR_SYSTEM` と
   `originId: AttractorId = 'earth'` を受け取るようにする。** どちらも省略可能で、
   省略時は今までどおりの挙動になる。`ATTRACTOR_IDS`(モジュールレベル定数)は
   `this.ids = Object.keys(registry)`(コンストラクタで1回だけ計算するインスタンスフィールド)
   に置き換わる。`stateOf` の ECI 化は `helioStateOf(this.originId, t)` を引く形へ一般化する
   (地球以外を原点にできる — 木星周回ステージなら木星を基準にしたい、という素案の要求に
   そのまま対応する)。**恒星の解決も一般化する:** `starId: AttractorId | null` を
   コンストラクタで1回だけ `primaryOf` と同じロジックで確定し(見つからなければ `null`
   — 恒星の無い系を表現できる)、`sunDirAt`/`lagrangeAt` はこの `this.starId` を読む
   (`sunDirAt` は `starId === null` のとき、影・輻射圧の計算がそもそも無意味になるので
   その旨コメントし、呼び出し側が影響を無視できる無害なフォールバック方向を返す)。
4. **`ReferenceFrame.center`/`rotatingWith` の型を `AttractorId`/`OrbitingId` に広げ、
   `physics/frame.ts` から `FRAMES`/`INERTIAL_FRAME`(モジュールレベル定数)を削除して
   `Ephemeris` インスタンスへ移す。** これは単なる置き場所の変更ではない —
   `frame.ts` は自身の先頭コメントで「Ephemeris を import しない」ことを明言しているにも
   関わらず、`FRAMES` を組み立てるためだけに `solar-system.ts` の `SOLAR_SYSTEM`/`bodyDef`
   を直接読んでいた(登録済み太陽系という1つのグローバルな存在を前提にした、
   frame.ts 自身の設計原則違反)。「どの座標系が選べるか」は「今どのレジストリが
   使われているか」という `Ephemeris` の実行時状態そのものなので、`Ephemeris` が
   持つのが正しい置き場所である。`Ephemeris` は起動時(コンストラクタ)に
   `this.inertialFrame: ReferenceFrame = { center: originId, rotatingWith: null }` を
   まず1つ作り、`this.frames: readonly ReferenceFrame[]` をこれを再利用しながら組み立てる
   (`INERTIAL_FRAME` と `frames` の該当要素が同一参照になるようにする — 後述の参照同一性
   契約のため)。`rotatingFrameCenterOf`(旧 frame.ts)はレジストリを引数に取る形で
   `ephemeris.ts` 側へ移す(唯一の呼び出し元がここになるため)。`frame.ts` に残るのは
   `ReferenceFrame`/`FrameTransform`/`FramePoint`/`FrameDir`/`FrameKinematicState` の型定義と、
   点・方向・状態の順変換/逆変換関数だけになる — 「座標系の中身は Ephemeris が組む、
   frame.ts は変換するだけ」という自身のコメントに実装が追いつく。
5. **`Ephemeris.frameTransformAt(frame, t, attractors)` に、その瞬間の `Attractor` 一覧
   `attractors: readonly Attractor[]`(§2-5 の `attractorsAt` が返すものと同じ形)を引数として
   追加し、回転の解決を2経路に分ける。**
   - `center`/`rotatingWith` が**現在のレジストリに登録されている** id(`id in this.registry`)
     のとき: 従来どおり `orbitFrameRotationAt`(解析的・分点歳差込みの滑らかな回転)。
     **挙動もコンパイル結果も変えない**(既定レジストリでの月/地球回転系など既存の座標系は
     一切変わらない)。「登録されているかどうか」は型では判定できない(id が `string` に
     開いているため)ので実行時の `in` 判定になる — Phase 5・6 で必ずこの判定を通すこと。
   - 登録されていない id(=生存中の `GameEntity`)のとき: `attractors` から一致する
     `Attractor` を探し、その `state` と `center` 側の `state` の相対位置・相対速度から、
     その瞬間の(骨組みの)基底を組む — x̂ = 中心→対象の方向、ẑ = 相対角運動量方向
     (`kinematic-state.ts` の `orbitAxes` が状態ベクトル単体から軌道基底を作るのと
     同じ考え方を、相対状態に適用する)。これは解析的な長期基底の近似ではなく、
     **そもそも保存された解析軌道が存在しない自由な多体系にとって唯一妥当なモデル**で
     あることをコメントに明記する。
6. **登録済みでない(=生存中の重力天体の)`ReferenceFrame` は、`Ephemeris` が持つ
   キャッシュ `Map<AttractorId, ReferenceFrame>` から引く(`frameFor(id)`)。** 一度作った
   参照を使い回す(見つからなければ `{center: id, rotatingWith: null}` を新規に作って
   キャッシュへ登録する — 小惑星のような重力天体を回転系の中心にすることはあっても、
   小惑星自身の自転に座標系を合わせて回すことはしない、という Step3 のスコープに合わせて
   `rotatingWith` の変種は作らない)。`this.frames`(レジストリぶん)と同じ「値は必ず
   安定した参照を使う」契約をこのキャッシュにも適用する — `render/sampled-line.ts` の
   `frame === lastFrame` というキャッシュ判定がこの契約の上に乗っている。
7. **呼び出し側(`OverviewCamera.update`/`PlanPath.update`・`toDisplay`)へ `attractors: readonly
   Attractor[]` を引数で通す。** `Game`/`PlanEditor` が §2-5 の `attractorsAt` が返すのと
   同じ値を(すでに1フレーム1回求めている値を再利用するか、同じ安価な関数をもう一度呼ぶかは
   実装時に選んでよい)両方へ配る。
8. **GUI 側は、`Ephemeris` が実際に持つレジストリ・重力天体から動的に組み立てる。**
   モジュールレベルの定数として組まれていた `CELESTIAL_BODIES`(見た目レジストリ)・
   `ATTRACTOR_NAMES`/`FRAME_ITEMS`(表示名)・艦艇配置パネルの基準天体一覧は、いずれも
   「登録済みの4天体が常に存在する」という前提の上に成り立っていた(=これ自体が
   ハードコードの一部)。これらをすべて `Ephemeris` インスタンスから導出する関数に
   置き換え、地球・月・木星・太陽の一部または全部を欠くレジストリでも壊れずに動くように
   する。手作りビューを持たない天体には汎用のフォールバック(単色球)を用意する。
   詳細な対象ファイルは §3・Phase 6 に列挙する。

**このレジストリ一般化がサポートしないもの(意図的な境界):**

- **恒星が2つ以上、相互に公転しあう連星系。** `primaryOf`/`starId` は「主星0または1つ」を
  前提にする。相互に比較可能な質量が複雑な軌道を描く状況は、そもそも解析的な
  ケプラー軌道では表現できない(§2-8) — Asteroid の数値積分の役目であり、レジストリの
  問題ではない。
- **衛星の衛星のような、3階層を超える公転階層。** `CelestialBodyDef` の `kind: 'star' |
  'planet' | 'satellite'` という3分類自体は変えない(素案の要求どおり)。
- **地球の大気圏熱管理・機体初期配置・エネミー生成式(`atmosphere.ts`/`thermal.ts`/
  `player.ts` の `makeInitialState`/`stages/spawner/enemy-generator.ts`)を天体非依存に
  一般化すること。** これらは「このゲームで大気を持つのは地球だけ」という既存の意図的な
  簡略化(CLAUDE.md 既述)であり、レジストリ・GUI の柔軟化とは別の、桁違いに大きい
  作業になる。今回はレジストリに地球以外の天体しか無いステージでもクラッシュしないこと
  (該当機能を静かに使わない)までを保証し、それらの物理モデル自体を一般化はしない
  (§6 に明記)。
- **静止軌道高度・太陽同期傾斜角のプリセット(`ship-placer-panel.ts`)を任意の天体へ
  一般化すること。** これらは天体の自転周期という、現状のレジストリのスキーマ
  (`CelestialBodyDef`)に無いデータを要求する。地球以外の天体では単にプリセットが
  出ない(既存コードが既にこの形で動いている)ままにする。

### 2-5. `Attractor` 一覧は `Simulator`/`Predictor` が一元的に組み、`GameEntity` は
    受け取るだけにする

現状 `GameEntity.stepActual(dt, ephemeris)` は各エンティティが自分で
`ephemeris.attractorsAt(this.state.t + dt/2)` を呼んでいる(`Simulator.substep()` は
7つの配列(`players`/`enemies`/`bullets`/`casings`/`debris`/`ammos`/`bases`)それぞれに
`stepActual(dt, this.ephemeris)` を呼ぶだけで、`Attractor` 配列そのものは組み立てていない)。
これは重力源が解析天体(`Ephemeris`)だけだった間は問題なかったが、**小惑星どうしが
相互に重力を及ぼすには、同じ substep 内の全エンティティが同じ瞬間の1つの `Attractor` 一覧を
参照する必要がある。** ある小惑星が別の小惑星より先に積分されて位置が動いた後、
その動いた後の位置を「今この瞬間の重力源」として次の小惑星が読んでしまうと、
本来対称であるべき相互作用に処理順依存の誤差が入る(性能の問題ではなく**正しさ**の問題)。

そこで `GameEntity.stepActual` の引数を `ephemeris: Ephemeris` から
`attractors: readonly Attractor[]` へ変える(`stepPredicted` は元々この形をしているので、
2つのメソッドのシグネチャが揃う副産物もある)。`Simulator.substep()` が **substep の
先頭で1回だけ** `Attractor` 一覧を組み、その1つの配列をこの substep 内の全エンティティへ渡す。

集める処理自体は場当たり的な寄せ集めではなく、上記のとおり「同じ瞬間の1つの配列を
全エンティティで使い回さないと相互作用が処理順に依存する」という具体的な理由を持つ
意味のある操作なので、関数として残す。名前は「どう集めたか」ではなく「何を集めているか」
(`Attractor[]`)で呼ぶ:

```ts
// game/simulation/attractors.ts (新規)
// このステップぶんの Attractor 一覧 = 解析天体(Ephemeris) + 重力を持つ生存中の GameEntity。
// 呼び出し側(Simulator/Predictor)が「いつの瞬間か」を決めて1回だけ呼び、同じ配列を
// このステップの全エンティティに使い回す — 重力天体どうしの相互作用を処理順に依存させないため。
export function attractorsAt(ephemeris: Ephemeris, entities: EntityManager, t: number): Attractor[] {
  return [...ephemeris.attractorsAt(t), ...entities.attractors()];
}
```

`Simulator.substep()` の7本の別ループ(`stepActual` を呼ぶ部分だけ)は、これを機に
`entities.all()` を使った1本のループへまとめる。7回とも呼んでいる内容(`stepActual` の
引数)に型ごとの違いが無いための単純化であり、目的そのものではない。**`stepAttitudes()` は
型ごとに `alive` 判定の有無が異なる本物の分岐を持つので、こちらは統合しない。**

新しく `entities.asteroids: Asteroid[]` を `EntityManager` に追加し、`otherEntities()`/`all()`/
`cleanup()`/`sync()` へ他の配列(`debris`/`ammos` と同じ扱い、`addAsteroid` で上限付き追加)
と同列に組み込む。これだけで `CollisionPhysics.resolve()`(`entities.all()` を丸ごと受け取り
`radius !== null` で参加者を絞る、Phase 2 で改称済みの実装)にも自動的に参加する(§2-7)。

`Predictor` 側は `update()` の再同期パス(`this.ephemeris.attractorsAt(simTime)`)と
`advanceBudget()` の1ステップごとのパス(`this.ephemeris.attractorsAt(tipState.t)`)の
両方に `entities.attractors()` を合流させる。ただし §2-6 の近似により、後者は
`tipState.t` ごとに呼び直す必要はなく、**`update()` の先頭で1回だけ求めて `advanceBudget` へ
引数で渡す。**

### 2-6. `Predictor` における重力天体どうしの相互作用は「現在の実状態で静止」とみなす近似にする

`Predictor` は個体ごとに非同期(ラウンドロビンの予算制)で未来へ伸びるので、複数の小惑星の
予測列が互いに「今どの時刻まで伸びているか」を揃える保証がない。真に相互無矛盾な予測を
組もうとすると予算配分と循環依存が生じ、表示補助の予測に見合わない複雑さになる。

そこで **`Asteroid.predictsFuture = false` にする**(小惑星自身は未来ゴーストを持たない
— 弾・デブリと同じ扱い)。これにより「小惑星どうしの相互予測」という問題自体が消える。
一方、艦や敵が小惑星の近くを飛ぶ場合、その艦の予測軌道は小惑星の重力で曲がって見えるべき
なので、`Predictor` が組む重力源一覧には小惑星の**現在の実状態**(`entities.attractors()`、
毎フレーム1回評価)を含める。小惑星は艦の予測ホライズン(最大でも `DISPLAY_DURATION_MAX` =
1年)の間、実質的に動かないとみなす近似であり、典型的な小惑星の公転周期はそれよりずっと
長いので実用上妥当である。この近似は `predictor.ts`(または `attractors.ts`)の
コメントに明記する。

### 2-7. 小惑星との衝突は既存の `CollisionPhysics`(剛体接触)にそのまま乗せ、`mu` によって
    衝突の扱いを分岐させる新しいコードを書かない

`Asteroid` に `radius > 0` を設定すれば、艦・弾・デブリとの接触は既存の剛体接触(反発・
ダメージ)がそのまま扱う — これは今日の `Enemy`/`Base`/`Ammo`(重力を持たないが衝突は
する物体)と全く同じ扱いであり、`radius` フィールドを共有している以上、追加の分岐は
一切要らない。

一方 `EntityManager.cleanup()` が `checkLoss` へ渡す `attractors`(= `hitCelestialBody` が
「表面に沈み込んだので再突入死する」を判定する対象)は、**`Simulator` が
`this.ephemeris.attractorsAt(this.simTime)` から組んだものを変えず**、`attractors()`
を合流させない。理由は2つ: (1) 同じ接触に対して剛体接触(跳ね返り)と再突入死(消滅)が
二重に発生する余地を作らないため、(2) `feature_todo.md`「衝突判定の統一化」で
「実体弾・大気を持たない天体・薬莢などへの接触はすべて質量と相対速度から求まる力積
1つに統合する」ことが既に構想されており、**今回 `mu` の有無で衝突の扱いを分岐する
コードを新たに書くと、その統合の妨げになる可能性がある。** 今回はどちらの統合の形にも
影響しない、最小の選択(既存の `CollisionPhysics` にそのまま乗せるだけ)を取る。

艦が小惑星に飛び込んだ結果どうなるかは、剛体接触のダメージ量だけで決まる — 今日の
艦-敵艦衝突と同じ扱いであり、一貫している。

### 2-8. 「自由な星系」は相互重力(Asteroid)とレジストリの一般化という独立した2つの機能で実演する

「太陽が存在しない3連星系」のような「自由な星系」は、実は物理的性格の異なる2つの状況を
指しうる。混同すると設計を誤るので、明確に分けて考える。

1. **質量が比較可能な複数天体が相互に複雑な(カオス的な)軌道を描く状況。** 3体以上の
   comparable mass が互いに引き合う一般の多体問題は閉じた解析解を持たない —
   `physics/satellite-orbit.ts` のような「支配的な主星のまわりの二体 + 摂動項」という
   解析モデルは原理的に適用できない。これは**数値積分でしか表現できない**。
2. **現実の太陽系(地球・月・木星・太陽という特定の4天体・特定の階層・地球原点)とは
   異なる天体の集合・階層・原点で進行するステージ。** 恒星が1つも無い系、木星が原点の系、
   架空の天体だけで構成された系など。こちらは各天体の運動が(その系の中では)階層的で
   あれば、既存の解析的な天体暦モデル(ケプラー軌道 + 摂動)でそのまま表現できる —
   必要なのは**どの天体をレジストリに載せるか、どれを原点にするかを差し替えられること**
   であり、数値積分は要らない。

**(1) は目標1の小惑星機構(`Asteroid`、§2-1・2-5・2-6、Phase 3/4)がそのまま担う。**
`Asteroid` どうしの相互重力は数値積分で正しく解かれる(Phase 4 のテストで二体周期・
全運動量保存を検証する)ので、太陽系から十分離れた場所に質量が比較可能な複数の `Asteroid`
を置けば、それがそのまま閉じた解を持たない自由な多体系のデモになる — `strongestAttractor`
が距離の2乗に反比例して減衰する `attractorAccel` を比較する既存の関数のおかげで、
その場所での地球・太陽からの寄与は無視できるほど小さく、実質的にその複数体だけが
互いを支配する系として振る舞う。太陽や地球は ECI 座標系の中にデータとしては存在し続けるが、
ゲームプレイ上・表示上「そこには存在しない」のと区別がつかない。

**(2) は §2-4 で一般化した `Ephemeris` のレジストリ注入・原点一般化・主星解決が担う。**
`Ephemeris` に現実とは異なるレジストリ(あるいは同じレジストリで異なる原点)を渡した
ステージを1つ用意し、GUI(天体名表示・座標系選択・艦艇配置の基準天体選択・カメラの
既定フォーカス)がそのレジストリの実際の中身に追従することを実演する(Phase 7)。

**(1)と(2)は互いの代用にならない。** (1)を(2)の代わりに使う(=常に現実の太陽系の中で、
場所を離すことでしか「自由な星系」を表現しない)と、`SOLAR_SYSTEM`/`Ephemeris`/GUI 側の
「地球・太陽が常に存在する」という前提そのものは温存されたままになり、木星周回ステージや
地球の無い系を作りたいという具体的な要求に応えられない。逆に(2)を(1)の代わりに使う
(=レジストリを差し替えるだけで済ませる)ことはできない — 解析的な天体暦は原理的に
チャオス的な多体系を表現できないため。両方を実装して初めて、目標2「自由な星系」の
物理的な意味が満たされる。

### 2-9. `game/celestial/` の見た目クラス群の改名は見送る

素案は「`CelestialBody` 系を `CelestialEntity` 系へ寄せるか、統合と同じ変更セットで判断する」
としていた。これは `Ephemeris` の解析天体を `GameEntity` のような「1個のライブオブジェクト」
に作り替えることを前提にした議論だが、**その前提は本書では採用しない。**

`GameEntity.state` は「今この瞬間の1つの値」で済むのに対し、`Ephemeris` の天体は
**1フレームの中で複数の異なる時刻に問い合わせられる**(`simTime` での重力計算、
`displayTime` での未来ゴースト表示、`Predictor` が各エンティティの予測先端ごとに違う時刻で
問い合わせる、`plan-arc` の積分ステップ時刻…)。これは `GameEntity.displayState(t)` が
既に持っている「任意時刻を引ける」という発想と同種の要求であり、単一の get/set フィールド
には収まらない。したがって `Attractor` は今までどおり「ある瞬間の値」として
両者が共有する**形**にとどめ(`Ephemeris` は毎回この形を新しく作って返す、`GameEntity` は
§2-1 のとおりネイティブフィールドとしてこの形を常に体現している)、`Ephemeris` 自体を
状態を持つ `GameEntity` 的なクラスへ作り替えることはしない。

改名が意味を持つ前提(「解析天体と積分天体のインターフェースを統一し、`CelestialBody` が
状態を持つ側になる」)が今回発生しないため、`game/celestial/` の各クラス名は変更しない。
素案自身も「名前だけを先に動かすことはしない」としており、その条件に従った結果である。

### 2-10. 計画軌道(`plan/plan-arc.ts`)は小惑星の重力を考慮しない(既知の制約として残す)

マニューバ計画の予測線(`PlanArc`)は独自に `ephemeris.attractorsAt(t)` を呼んで積分している。
これに `entities.attractors()` を合流させて**積分**に反映するのは技術的には可能だが、
「マニューバ計画中に小惑星帯を飛ぶ」という具体的な使用状況が現時点でどのステージにも
無い。**Step3 では対応しない既知の制約とする。**

**Phase 6 で `PlanPath`(`plan-path.ts`)へその瞬間の `Attractor` 一覧を引数として通すように
なるが、これは `toDisplay` が使う座標系(`ReferenceFrame`)の解決専用であり、`plan-arc.ts` の
`PlanArc.update` が呼ぶ積分(`ephemeris.attractorsAt(t)`)とは別の呼び出しである。** 表示座標系が
小惑星を基準に選べるようになったからといって、計画軌道の積分自体が小惑星の重力を考慮する
ようにはならない — 両者を混同しないこと。小惑星の近くで軌道計画を編集する機能が
要求された時点で、この制約自体を再検討する(`DEVELOP/SPEC.md` §16 へ記録は Phase 9 の
文書更新でまとめて行う)。

### 2-11. 空間ハッシュによる軽量化は独立フェーズにし、実測してから作る

素案が提案する「質量 M・半径 R を決め打ちして、軽い天体は近傍のみ計算する」空間ハッシュは、
**具体的な性能問題が実測で確認されてから**実装する(`/refactor-fixed` §5 の優先順位どおり)。
まず小惑星数体〜十数体で相互重力の正しさを確立し(Phase 4)、次に小惑星を数百〜数千に
増やした状態で `?perf=1` の update フェーズ ms を実測し(Phase 8 冒頭)、それを見てから
空間ハッシュを組む。

しきい値(質量 M・半径 R)は**性能とのトレードオフを含む近似の閾値**であり、物理法則その
ものではないので、`physics/` 側のモジュールに埋め込まない。既存の `hitAttractor` の
`margin` 引数(「ゲーム側の判断なので呼び出し側から受け取る — physics/ はその値自体を
知らない」)と全く同じ形にする: 空間分割の**幾何**(グリッドへの登録・27近傍の列挙)は
`physics/spatial-grid.ts` に汎用的な純関数として置き、しきい値そのもの(`game/const.ts` の
定数)は `game/simulation/` 側が持って `physics/` の関数へ引数として渡す。

素案が触れている「M・R を決め打ちの定数でなく動的にできないか」という論点は、**この Step の
範囲では採用しない。** 固定定数の方式(素案の Step2 相当の簡易さ)で目的(O(NM) の回避)は
十分達成できるので、動的なしきい値は早すぎる一般化にあたる。将来必要になったら
`DEVELOP/SPEC.md` §16 に記録してから検討する。

---

## 3. 完成後のモジュール構成

### 変更(§2-1・2-2 — id/radius/mu の整理、Asteroid 追加前の前提)

| ファイル | 変更内容 |
|---|---|
| `src/game/game-entity/game-entity.ts` | `id: string`(自動採番)/`radius`(旧 `collideRadius`、`number \| undefined` → `number \| null`、既定 `null`。`0` は有効な値のまま)/`mu: number = 0`/`degree2: null = null` を追加。`_memoCenterId` の型を `string \| null` へ |
| `src/game/game-entity/entity-id.ts`(新規) | `Ammo`/`Base` が個別に持っていた「プレフィックス付き採番 + 復元idによるカウンタ追い越し」を1つのヘルパへ統合 |
| `src/game/game-entity/ship.ts` | `radius`(被弾判定半径)を `hitRadius` へ改称(`GameEntity.radius` との名前衝突回避) |
| `src/game/game-entity/enemy.ts` | `collideRadius` 代入を `radius` へ、被弾判定半径の代入を `hitRadius` へ。`id?: string` を必須の `id`(基底の自動採番)に統一、`name` は表示専用に純化 |
| `src/game/game-entity/ammo.ts` / `base.ts` | 独自のカウンタ実装を `entity-id.ts` 経由に置き換え |
| `src/game/player/player.ts` | `collideRadius` 代入を `radius` へ。既存の `id`/`displayName` 分離はそのまま(基底の仕組みに載せ替えるだけ) |
| `src/game/game-entity/debris-piece.ts`・`belt-physics.ts` | `collideRadius` 代入を `radius` へ(既定 `undefined` → `null`、意味は変わらない) |
| `src/game/simulation/collision.ts`・`simulation/hit.ts` | `collideRadius !== undefined` → `radius !== null`。被弾判定側の `target.radius` は `target.hitRadius` へ |
| `src/game/map-picker.ts` | `entities.enemies.find(e => e.name === target.id)` 形の検索(7箇所)を `e.id === target.id` へ。`{id: enemy.name, ...}` を `{id: enemy.id, ...}` へ |
| `src/game/nav-target.ts` | 同上の `e.name === id` 検索を `e.id === id` へ |

### 新規(小惑星本体)

| ファイル | 責務 |
|---|---|
| `src/game/game-entity/asteroid.ts` | `Asteroid extends GameEntity`。`radius`/`mu` に実際の値を設定、`predictsFuture=false`・`bcInv=0`・`srpCoeff=0` |
| `src/game/simulation/attractors.ts` | `attractorsAt(ephemeris, entities, t)`: このステップの `Attractor` 一覧 = 解析天体(`Ephemeris.attractorsAt`) + 重力を持つ生存中 `GameEntity`(`EntityManager.attractors()`)。Phase 8 で空間ハッシュによる近傍限定を内部に追加(呼び出し側のシグネチャは変えない) |
| `src/physics/spatial-grid.ts` | 位置を持つ任意の要素に対する一様グリッドの構築・27近傍列挙(汎用・純関数、Phase 8) |
| `tests/physics/n-body.test.ts` | 相互重力(二体周期・全運動量保存)のテスト(Phase 4) |
| `tests/physics/spatial-grid.test.ts` | グリッド近傍列挙が全数探索と一致することのテスト(Phase 8) |

### 変更(天体レジストリ・ECI原点・主星解決の一般化 — §2-4、Phase 5)

| ファイル | 変更内容 |
|---|---|
| `src/physics/attractor.ts` | `AttractorId = string` へ。`StarId`/`PlanetId`/`SatelliteId` 削除、`OrbitingId = AttractorId` の別名に。`Attractor` に `isStar: boolean` を追加 |
| `src/physics/solar-system.ts` | `CelestialRegistry` 型を新設。`bodyDef(registry, id)`/`primaryOf(registry, id)` をレジストリ引数を取る形へ(`KindOf`/`BodyDefOf` の型レベル絞り込みは削除)。`SOLAR_SYSTEM` は既定レジストリとして残す |
| `src/physics/frame.ts` | `ReferenceFrame.center`/`rotatingWith` の型を `AttractorId`/`OrbitingId` へ。`FRAMES`/`INERTIAL_FRAME`/`rotatingFrameCenterOf` を削除(`Ephemeris` へ移す) |
| `src/physics/ephemeris.ts` | コンストラクタに `registry: CelestialRegistry = SOLAR_SYSTEM`・`originId: AttractorId = 'earth'` を追加。`this.ids`/`this.starId`/`this.inertialFrame`/`this.frames`/`frameFor(id)`(動的キャッシュ)を持つインスタンスに。`stateOf` の ECI 化・`sunDirAt`・`lagrangeAt` が `this.originId`/`this.starId` を読むよう一般化。`frameTransformAt` に `attractors` 引数を追加し、登録済み/未登録で解決経路を分岐 |
| `src/physics/dynamics.ts` | `totalAccel` 内の `attractor.id === 'sun'` を `attractor.isStar` へ(既存コメント「固有名の分岐は現れない」を実態に合わせる) |
| `src/game/game-entity/game-entity.ts` | `readonly isStar: false = false;` を追加(§2-1 と同じ理由・同じ形) |

### 変更(GUI をレジストリ・重力天体へ適応させる — Phase 6)

| ファイル | 変更内容 |
|---|---|
| `src/game/hud/frame-labels.ts` | `ATTRACTOR_NAMES`(Record)を `celestialBodyName(ephemeris, id)` 関数へ、`FRAME_ITEMS`(定数)を `frameLabel(frame, ephemeris)` 関数へ。いずれもレジストリに無い天体・生存中の重力天体に対するフォールバック名を持つ |
| `src/game/celestial/celestial-registry.ts` | `CELESTIAL_BODIES` を手作りビューを持つ天体だけの部分表へ縮小。レジストリにあってここに無い id 向けの汎用フォールバックビュー(恒星なら `SunBody` 相当、それ以外なら単色球)を追加 |
| `src/game/celestial/sun-body.ts` | `id` をコンストラクタ引数に(`SphereBody` と同じ形、`'sun'` 固定をやめる)。`ephemeris.positionOf('sun', t)` を `ephemeris.positionOf(this.id, t)` へ |
| `src/game/celestial/environment-scene.ts` | `sunBody: SunBody \| null` へ(`ephemeris.starId` で検索、無ければ `null`)。`EARTH_ATTRACTOR`/`GEO_ELEMENTS` の手組みハードコードを、レジストリに `'earth'` がある場合だけ `bodyDef`/`ephemeris.stateOf('earth', t)` から動的に組む形へ。GEO/月の参照線は地球・月がレジストリに無ければ非表示にする |
| `src/game/camera/overview-camera.ts` | 既定フォーカスの `'earth'` 決め打ち(4箇所)を `ephemeris.originId`(または `ephemeris.starId`)へ |
| `src/game/camera/camera-system.ts` | `PANEL_FOCUS_IDS` の組み立て元を `CELESTIAL_BODIES` から `ephemeris` の実際の天体一覧へ |
| `src/game/creative/ship-placer-panel.ts` | `LAGRANGE_SYSTEM_ITEMS` の主星解決を `primaryOf(ephemeris.registry, id)` 呼び出しへ。`LAGRANGE_DEFAULT_AMPLITUDE_KM` の Record 添字にフォールバックを追加(レジストリが開いたことで網羅性チェックが効かなくなるため) |
| `src/game/creative/duplicate-form.ts` | 恒星が strongest のときのフォールバック先 `'earth'` 決め打ちを `ephemeris.originId` へ |
| `src/game/map-picker.ts` | `itemsFor('body')` の `if (id==='earth') ... else if ('moon') ...` 分岐に、手作りサブタイトルを持たない天体向けの汎用フォールバックを追加。ラグランジュ点id のサフィックス解析(`moon-l*`/`earth-l*` 決め打ち)を、`focus-markers.ts` が実際に生成する全公転天体ぶんの `-l[1-5]` サフィックスへ一般化(木星のラグランジュ点など、今日すでに存在するのに素通りしていた欠落も同時に直る) |
| `src/game/simulation/entity-manager.ts` | `attractors()` 追加(§2-5 と同じ変更セット、Phase 4 で先に入る) |
| `render/sampled-line.ts` | 変更なし(参照同一性キャッシュ判定 `frame === lastFrame` はそのまま — 4./6. で参照安定性を保つのはこちら側の責務) |

### 変更(配線・実演 — Phase 4・7)

| ファイル | 変更内容 |
|---|---|
| `src/game/simulation/entity-manager.ts` | `asteroids: Asteroid[]` 追加、`addAsteroid`、`otherEntities()`/`all()`/`cleanup()`/`sync()` へ組み込み、`attractors()` 追加(§2-1、Phase 4-3) |
| `src/physics/attractor.ts` | `Attractor.radius` を `number` から `number \| null` へ。`hitAttractor` が `radius === null` の天体をスキップ(Phase 4-2) |
| `src/physics/elements.ts` | `apsisAltitudes` が `el.center.radius === null` のとき `{pe: NaN, ap: NaN}` を返す(Phase 4-2) |
| `src/game/hud/orbit-info.ts`・`src/game/map-picker.ts`・`src/game/plan/plan-display.ts`・`src/game/stages/creative-stage.ts` | `center.radius` を直接引いて高度を出している箇所(計7箇所)を、`radius === null` のとき `NaN` を返す形に直す(Phase 4-2) |
| `src/game/simulation/simulator.ts` | `substep()` が `attractorsAt(...)` を1回呼び、7本の別ループを `entities.all()` の1ループへ統合 |
| `src/game/simulation/predictor.ts` | `update()`/`advanceBudget()` の重力源一覧に `entities.attractors()` を合流(§2-6 の近似どおり、フレームに1回だけ評価) |
| `src/game/const.ts` | 小惑星の質量/半径の試験値、空間ハッシュのしきい値定数(Phase 8) |
| `src/game/stages/stage-debug.ts` | 相互重力の実演用に `Asteroid` を数体配置(Phase 4) |
| `src/game/stages/stage-dictionary.ts` | `StageClass` インターフェースに任意の静的 `ephemerisConfig?: {registry, originId}` を追加。`Game` がステージ選択から `Ephemeris` を構築する前に引ける `ephemerisConfigFor(launch)` を追加(Phase 7) |
| `src/game/game.ts` | コンストラクタの `new Ephemeris()` 呼び出しの前で `ephemerisConfigFor(launch)` を解決し、`new Ephemeris(config.registry, config.originId)` へ(Phase 7) |
| `src/game/stages/stage-debug-alt-system.ts`(新規) | 現実の太陽系とは異なる小さなレジストリ・原点で進行する、選択画面に出ないデバッグ専用ステージ。「自由な星系」の(2)を実演する(Phase 7) |

---

## 4. フェーズ別手順

### Phase 1 — 準備・計測

**1-1.** 着手前に `npm run typecheck` / `npm run test:physics` が green であることを確認する。

**1-2.** `npm run dev` を実機で起動し `?perf=1` を付け、ステージ00(無限サバイバル)で
時間加速を上げた状態の update フェーズ ms を記録する(Step2 で未完了のまま残っていた
基準測定と同じやり方 — ヘッドレスでは高負荷まで駆動できないため、実機での実施が必須)。
この値は Phase 8 で空間ハッシュの効果を測るときの「小惑星0体の基準値」として使う。

**検証:** 上記の記録のみ。コード変更なし。

---

### Phase 2 — `id`/`radius`/`mu` の整理(前提のリファクタリング)

**このフェーズは小惑星そのものを一切導入しない。** `GameEntity` を「後から `Attractor` に
なれる形」へ均すだけの、既存クラスの整理。

**2-1.** `game/game-entity/entity-id.ts` を新設し、`Ammo`/`Base` が個別に持つ
「`${prefix}-${counter}` 形式で採番し、復元 id を渡されたらそれを採用しつつカウンタを
その番号より先へ進める」ロジックを1つの共有ヘルパへ統合する。

**2-2.** `game/game-entity/game-entity.ts` に `id: string`(コンストラクタで明示指定が
無ければ 2-1 のヘルパで自動採番)/`radius: number | null = null`(型を
`number | undefined` から `number | null` へ、無効値は `undefined` から `null` へ。
`0` は「半径0の質点として参加する」という有効な値のままなので `0` へは変えない)/
`mu = 0`/`degree2: null = null` を追加する。既存の `collideRadius` という名前をこの
`radius` に統合する(§2-1)。

**2-3.** `Ship`(`game-entity/ship.ts`)の被弾判定半径フィールドを `radius` から
`hitRadius` へ改称する(§2-1 の名前衝突回避)。コンストラクタ引数名も合わせて改称する。

**2-4.** `collideRadius` を代入している全箇所(`enemy.ts`・`base.ts`・`ammo.ts`・
`debris-piece.ts`・`belt-physics.ts`・`player.ts`)を `radius` の代入に書き換える。
`enemy.ts` は被弾判定半径の代入(`this.radius = visualSphere.radius` だった箇所)を
`this.hitRadius = visualSphere.radius` に書き換える。

**2-5.** `collideRadius` を参照している `simulation/collision.ts`・`simulation/hit.ts` を
書き換える: `!== undefined` 判定を `!== null` へ、`x.collideRadius!` を `x.radius!`
(非nullアサーションはそのまま残る — フィルタ述語に型ガードを与えない限り TypeScript は
`.filter` 越しの絞り込みを保持しないため、既存と同じ形)。`hit.ts` の被弾判定側
(`target.radius` だった箇所)は `target.hitRadius` へ。

**2-6.** `Enemy` の `id?: string`(セーブ復元専用、生存中は未設定)を、`GameEntity` の
自動採番される `id: string`(必須)に統一する。`name` は表示専用のまま残す(`Player` が
既に持っている「`displayName`/`id` の分離」と同じ形に揃える)。

**2-7.** `map-picker.ts`・`nav-target.ts` の `entities.enemies.find(e => e.name ===
target.id)` 形の検索(7箇所)を `e.id === target.id` に書き換える。`map-picker.ts` が
`MapPickable` を組み立てている箇所(`{id: enemy.name, name: enemy.name, kind: 'ship'}`)も
`{id: enemy.id, name: enemy.name, kind: 'ship'}` に直す。

**検証:** `npm run typecheck` / `npm run test:physics`(すべて無改造で green のはず —
このフェーズは同じ意味を保ったままの改名・統合のみで、シミュレーションの挙動は一切
変えていない)。`npm run dev` で以下を確認する:

- 既存ステージ(0/1/2/00)で、敵の被弾・自機と敵の衝突・薬莢/デブリの衝突が今までどおり
  動くこと。
- 同名の敵を複数出すシナリオ(あれば)で、マップの右クリックメニュー・航法ターゲット
  設定が name の重複によらず正しく個別の敵を指すこと。

---

### Phase 3 — `Asteroid` クラスの追加(未配線)

`GameEntity` が既に `id`/`radius`/`mu`/`degree2`/`state` を備えているので、`Asteroid` は
これらに実際の値を設定するだけで済む。

**3-1.** `game/game-entity/asteroid.ts` を新設し `Asteroid extends GameEntity` を書く。
コンストラクタで `radius`(物理半径)と `mu`(重力定数)に試験用の値を設定する
(実際の小惑星帯の値である必要はなく、Phase 4 の相互重力デモで見た目に分かる速さで
動く程度の値でよい — 具体的な数値は `game/const.ts` に定数として置き、実装時に調整する)。
`predictsFuture = false`・`bcInv = 0`・`srpCoeff = 0`・`historyDuration`(軌道線を描きたい
ので `SHIP_HISTORY_DURATION` 程度)を設定する。メッシュは `/add-feature` の手順で既存の
破片/デブリ系のビルダー(`render/ships.ts`)が転用できないか確認してから、無ければ
簡易な不定形岩ジオメトリを追加する。

**3-2.** `EntityManager` に `asteroids: Asteroid[]` と `addAsteroid`、`otherEntities()`/
`all()`/`cleanup()`/`sync()` への組み込みを追加する(`debris`/`ammos` と同じパターン)。

**3-3.** `StageDebug` に、テスト用の `Asteroid` を数体、離れた位置に静止(または適当な
初期速度で)配置するコードを足す(既存の `StageDebug` が敵をテスト配置しているのと
同じ形)。この時点では重力配線がまだ無いので、小惑星はただの「重力を受けない浮遊物体」
として見える(通常のデブリと同じ、直進または既存重力源(地球等)の影響下で動くだけ)。

**検証:** `npm run typecheck` / `npm run test:physics`(全て無改造で green のはず — この
フェーズは新クラスの追加のみで、既存の積分経路には一切触れていない)。`npm run dev` で
`StageDebug` を開き、配置した `Asteroid` が描画され、既存のデブリと同様に(まだ重力源には
ならずに)存在することを目視確認する。

---

### Phase 4 — 相互重力の配線と物理的検証

**4-1.** `game/simulation/attractors.ts` を新設し `attractorsAt(ephemeris, entities, t)`
を実装する(§2-5 のコード)。

**4-2.** `physics/attractor.ts` の `Attractor.radius` を `number` から `number | null` へ
広げる(§2-1 末尾のとおり、4-1 より前で必要になる `GameEntity.radius: number | null`
との構造的一致のため)。`radius` を読んでいる2つの物理関数を直す:

- `hitAttractor`(`hitCelestialBody` の内部実装)— ループ内で `attractor.radius === null`
  の天体は「表面を持たないのでその表面には沈み込めない」として、判定対象から外す。
- `physics/elements.ts` の `apsisAltitudes(el)` — `el.center.radius === null` のとき
  `{ pe: NaN, ap: NaN }` を返す(`orbit-info.ts` が双曲線軌道など「要素が求まらない」
  場合に既に使っている「NaN = 値が求まらない」という規約に合わせる)。

同じ理由の波及が `center.radius` を直接引いて高度を計算している箇所にもある
(実際に確認できたのは `game/hud/orbit-info.ts`(`orbitInfo` の `alt`)・
`game/map-picker.ts`(プロパティウィンドウの高度表示)・`game/plan/plan-display.ts`
(ゴースト位置・Pe/Ap ラベルの高度、4箇所)・`game/stages/creative-stage.ts`
(艦艇配置プレビューの高度、3箇所)— これ以外は typecheck が指し示す)。いずれも
`center.radius === null` のとき高度を `NaN` にする、同じ形の一行修正で足りる。

**Step3 の範囲では `mu !== 0` のエンティティ(Asteroid)は必ず実数の `radius` を設定する
(§2-7 が既存の `CollisionPhysics` にそのまま乗せる前提そのもの)ので、上記の `null` 分岐は
実行時には一度も通らない。** それでも型を正直に広げるのは、「重力を持つかどうか(`mu`)と
表面を持つかどうか(`radius`)は独立」という §2-1 の設計をそのまま裏付けるためで、
`radius` が非null であることを `mu !== 0` から不当に仮定した非nullアサーションをどこにも
書かないで済む(§2-1 の `attractors()` フィルタが `mu` だけを見る形のまま保てる)。
既存の `tests/physics/attractor.test.ts`・`elements.test.ts` に、この `radius === null`
分岐(`hitAttractor` がスキップすること、`apsisAltitudes` が `NaN` を返すこと)のテストを
1件ずつ足す。

**4-3.** `EntityManager.attractors()` を実装する(§2-1 のコード — 変換なしの
フィルタのみ)。

**4-4.** `GameEntity.stepActual` の引数を `(dt: number, ephemeris: Ephemeris)` から
`(dt: number, attractors: readonly Attractor[])` に変える。メソッド本体から
`ephemeris.attractorsAt(...)` の呼び出しを削除し、引数の `attractors` をそのまま
`this.actualTrajectory.step(...)` へ渡す。**このメソッドの直前にある「attractorsAt は
メモ化されている」という趣旨のコメントを削除し、事実(毎回素直に評価される — Step2 で
`Ephemeris` のメモ化は削除済み)に即して書き直す。**

**4-5.** `Simulator.substep()` を書き直す:

```ts
private substep(simTime: number, dt: number): number {
  const attractors = attractorsAt(this.ephemeris, this.entities, simTime + dt / 2);
  for (const e of this.entities.all()) e.stepActual(dt, attractors);
  return simTime + dt;
}
```

7本の別ループを `entities.all()` の1本にまとめる(§2-5 の理由)。`stepAttitudes()` は
型ごとに `alive` 判定が異なる本物の分岐を持つので変更しない。

**4-6.** `Predictor.update()`/`advanceBudget()` に `entities.attractors()` を合流する。
`update()` の先頭で1回だけ `entities.attractors()` を求め、`advanceBudget` へ
引数として渡す(§2-6 のとおり、予測ステップごとに呼び直さない)。`advanceBudget` 内の
`this.ephemeris.attractorsAt(tipState.t)` の結果と渡された小惑星ぶんの `Attractor[]` を
結合してから `e.stepPredicted(...)` へ渡す。この近似(重力天体は現在の実状態で静止と
みなす)をコメントで明記する。

**4-7.** `EntityManager.cleanup()` の呼び出し(`Simulator.advance` 内の2箇所)は変更しない
(§2-7 — `hitCelestialBody` の対象は解析天体のみのまま)。

**4-8.** `tests/physics/n-body.test.ts` を新設する。`tests/physics/index.ts` へ登録する。

- **二体の相互周期:** 質量 `mu1 = mu2`(便宜上等しくする)の2点を、共通重心
  (原点)を挟んで対称に距離 `d` だけ離して置き、それぞれに重心まわりの円軌道速度を
  互いに逆向きに与える。解析天体を一切含まない `attractors = [attractor1, attractor2]`
  のみで `stepDynamics` を1公転周期分(`T = 2π√(d³/(mu1+mu2))`)積分し、両者が
  出発位置へ戻ること(相対誤差を緩めに、RK4 の刻み幅由来の誤差を許容)を確認する。
  **これは既存の `keplerPeriod` を使わない独立した解析解による検算**であり、実装の
  誤りを検算式の誤りと取り違えないための最も重要なテスト。**この時点の `Attractor` には
  まだ `isStar` フィールドが無い(Phase 5 で追加される)ので、`attractor1`/`attractor2` の
  組み立てには `isStar` を含めない。** Phase 5 でこのテストの `Attractor` リテラルに
  `isStar: false` を足す必要がある(typecheck が検出する)ことを Phase 5 側で見込んでおくこと。
- **全運動量保存:** 上記の二体系、および3体(質量がまちまちな3点、初期速度は任意)の
  系を一定時間積分し、`Σ mu_i · v_i`(ベクトル和)が時間について一定に保たれることを
  緩めの許容誤差で確認する(`mu = G·m` なので `Σ mu_i v_i = G·Σ m_i v_i` であり、
  後者が保存すれば前者も保存する — G の値を知らなくても検証できる)。
- **既存天体との共存:** 解析天体(地球)1つ + 小惑星1つを重力源に含めて艦を積分し、
  小惑星の質量をゼロに近づけた極限で、小惑星を含めない場合の積分結果に収束することを
  確認する(結合の実装自体が解析天体側に副作用を持ち込んでいないことの確認)。
- **回帰:** 既存の `dynamics.test.ts` の「手書きの旧実装との一致(機械精度)」を含む
  全既存テストが無改造のまま通ること(小惑星が1体も無い今日の全ステージの経路が
  ビット単位で変わっていないことの確認 — `attractorsAt` が小惑星ゼロのとき
  `ephemeris.attractorsAt(t)` とまったく同じ配列を返すことから保証されるはずだが、
  必ずテストで確認する)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で Phase 3 の
`StageDebug` シナリオを開き、配置した複数の `Asteroid` が互いに引き合って動く様子を目視確認する
(適切な初期速度を与えていれば、緩やかに周回するように見えるはず)。既存ステージ
(0/1/2/00)を一通り触り、艦・敵の挙動が今までどおりであることを確認する。

---

### Phase 5 — 天体レジストリ・ECI原点・主星解決の一般化(物理コア)

**このフェーズはまだどのステージにもカスタムのレジストリ・原点を使わせない。** `Ephemeris`
とその周辺の型を「後からカスタムのレジストリ・原点を渡せる形」へ一般化するだけで、
すべての呼び出し元(`game.ts:114` の `new Ephemeris()`)は今までどおり引数無しで呼び、
今までどおり現実の太陽系・地球原点で動く。§2-4 の設計方針に従う。

**5-1.** `physics/attractor.ts` を書き換える: `AttractorId = string` にし、`StarId`/
`PlanetId`/`SatelliteId` を削除する。`OrbitingId = AttractorId` の別名として残す。`Attractor`
型に `readonly isStar: boolean;` を追加する。

**5-2.** `physics/solar-system.ts` を書き換える: `CelestialRegistry` 型を新設する。
`bodyDef(registry: CelestialRegistry, id: AttractorId): CelestialBodyDef` へシグネチャを
変える(`KindOf<T>`/`BodyDefOf<T>` の型レベル絞り込みは削除 — 呼び出し側は `.kind` の
実行時判定で絞り込む)。`primaryOf(registry: CelestialRegistry, id: AttractorId):
AttractorId` へシグネチャを変え、実装を「`registry` の中から `kind: 'star'` の天体を
1つ探して返す(0個または複数個なら例外を投げる)」に書き換える(§2-4 の2点目)。
`SOLAR_SYSTEM` の宣言・データ自体は変更しない。

**5-3.** `physics/frame.ts` から `FRAMES`/`INERTIAL_FRAME`/`rotatingFrameCenterOf` を削除し、
`ReferenceFrame.center`/`rotatingWith` の型を `AttractorId`/`OrbitingId` へ広げる。
`solar-system.ts`/`SOLAR_SYSTEM` への依存(import)もここで消える — 残るのは型定義と
点・方向・状態の変換関数だけになる。

**5-4.** `physics/ephemeris.ts` を書き換える(§2-4 の3〜6点目):

```ts
export class Ephemeris {
  private readonly ids: readonly AttractorId[];
  readonly starId: AttractorId | null;
  readonly inertialFrame: ReferenceFrame;
  readonly frames: readonly ReferenceFrame[];
  private readonly dynamicFrames = new Map<AttractorId, ReferenceFrame>();

  constructor(
    private readonly registry: CelestialRegistry = SOLAR_SYSTEM,
    private readonly originId: AttractorId = 'earth',
    private readonly phaseOffsets: Partial<Record<AttractorId, number>> = { moon: Math.random() * 2 * Math.PI },
  ) {
    this.ids = Object.keys(registry);
    this.starId = /* primaryOf と同じロジックで registry 内の kind:'star' を1つ探す。0個なら null */;
    this.inertialFrame = { center: originId, rotatingWith: null };
    this.frames = /* this.ids を辿り、慣性系ぶん(origin は inertialFrame を再利用)+ 回転系ぶんを組む */;
  }

  frameFor(id: AttractorId): ReferenceFrame {
    const registered = this.frames.find((f) => f.center === id && f.rotatingWith === null);
    if (registered) return registered;
    let dyn = this.dynamicFrames.get(id);
    if (!dyn) { dyn = { center: id, rotatingWith: null }; this.dynamicFrames.set(id, dyn); }
    return dyn;
  }
  // ...
}
```

`ATTRACTOR_IDS`(旧・モジュールレベル定数)を `this.ids` に、`bodyDef(id)` を
`bodyDef(this.registry, id)` に、`stateOf` の `helioStateOf('earth', t)` を
`helioStateOf(this.originId, t)` に、`sunDirAt` の `positionOf('sun', t)` を
`this.starId === null ? /* 無害なフォールバック方向、コメントで明記 */ : positionOf(this.starId, t)` に、
`lagrangeAt` の `def.kind === 'planet' ? 'sun' : def.planet` を
`primaryOf(this.registry, secondary)` の呼び出しに、それぞれ書き換える。
`rotatingFrameCenterOf` は private メソッドとしてこのファイルへ移す(5-3 で frame.ts から
削除した実装をそのまま持ってくる)。

**5-5.** `frameTransformAt` に `attractors: readonly Attractor[]` 引数を追加し、解決ロジックを
2経路に分ける(§2-4 の5点目): `center`/`rotatingWith` が `id in this.registry` のとき
従来どおり `orbitFrameRotationAt`、そうでないとき `attractors` から一致する `Attractor` を
探して相対状態から骨組みの基底を組む(x̂ = 中心→対象方向、ẑ = 相対角運動量方向。
自由な多体系にとって唯一妥当なモデルであることをコメントに明記する)。

**5-6.** `physics/dynamics.ts` の `totalAccel` を書き換える: `attractor.id === 'sun'` を
`attractor.isStar` に、ローカル変数名 `sun` を `radiant`(または同趣旨の一般的な名前)に
改める。これにより、この関数の直前にある「天体の同定は Attractor が自分で持つ degree2 に
委ねるので、ここに固有名の分岐は現れない」というコメントが、初めて実態と一致する
(従来は `degree2` の話をしながら直後で `'sun'` という固有名分岐を書いており、コメントと
実装が矛盾していた)。

**5-7.** `Ephemeris.attractorsAt` が返す各 `Attractor` に `isStar: def.kind === 'star'` を
追加する。

**5-8.** `game-entity/game-entity.ts` に `readonly isStar: false = false;` を追加する
(§2-1 の続き。`degree2: null` と全く同じ理由・同じ形)。

**5-9.** typecheck が指し示す全ての赤い箇所を機械的に直す(§2-3 と同じ方法論 — 「この変更が
及ぼす影響は typecheck を走らせると全部リストアップされる」)。想定される内訳:

- `tests/physics/attractor.test.ts`・Phase 4 で追加した `n-body.test.ts` などが組み立てる
  生の `Attractor` リテラルに `isStar: false` を足す。
- `physics/frame.ts` の `FRAMES`/`INERTIAL_FRAME` を直接 import していた箇所(この時点では
  まだ存在しないはず — `FRAMES`/`INERTIAL_FRAME` の実消費者である `frame-labels.ts` 等は
  Phase 6 で書き換えるので、Phase 5 の時点で赤くなる場合は Phase 6 の作業を先取りして
  直すのではなく、赤いままいったんこのフェーズを終えず Phase 6 へ進めてよい —
  ただしその場合 Phase 5 単独では typecheck が green にならないので、5-9 の検証を
  満たすためには 6-1〜6-2(`frame-labels.ts` の書き換え)を Phase 5 の変更セットへ
  前倒しで含めること。実装時にどちらが自然か判断してよい)。

**検証:** `npm run typecheck` / `npm run test:physics`(`frameTransformAt`/`bodyDef`/
`primaryOf` の引数変更に伴う既存呼び出し箇所の更新を含む)。`npm run dev` で既存ステージ
(0/1/2/00)を一通り触り、太陽・地球・月・木星の見た目・軌道線・照明・輻射圧が今までと
一切変わっていないことを確認する(このフェーズはレジストリ・原点ともに既定値しか
使わないので、挙動はビット単位で不変のはず)。

---

### Phase 6 — GUI をレジストリ・重力天体の両方へ適応させる

**Phase 4(`attractorsAt`/`entities.attractors()`)と Phase 5(レジストリを持つ Ephemeris)の
両方に依存する。**
このフェーズが終わるまでは、まだどのステージも既定と異なるレジストリ・原点を使わない
(Phase 7 で初めて使う)が、**GUI 側は「使われたら正しく追従する」形になっている**ことを
このフェーズの中で(仮のレジストリをテストコードやその場のデバッグ出力で与えて)確認する。

**6-1.** `hud/frame-labels.ts` を書き換える: `ATTRACTOR_NAMES`(`Record<AttractorId, string>`)を
`celestialBodyName(ephemeris: Ephemeris, id: AttractorId): string` 関数へ置き換える
(`CELESTIAL_BODIES` に手作りの名前があればそれを、無ければ生存中の `GameEntity` の表示名、
それも無ければ `id` そのものをフォールバックとして返す)。`FRAME_ITEMS`(定数)を
`frameLabel(frame: ReferenceFrame, ephemeris: Ephemeris): string` 関数へ置き換える
(`primaryOf(ephemeris.registry, ...)` 経由で回転系の親を解決する — §2-4 の2点目で
1箇所化した実装をここが呼ぶ)。

**6-2.** `game/celestial/celestial-registry.ts` を書き換える: `CELESTIAL_BODIES` を
手作りビューを持つ天体だけの部分表(`Partial<Record<AttractorId, {...}>>`)へ縮小する
(地球・月・木星・太陽の4エントリはそのまま)。この表に無い、しかしアクティブな
`Ephemeris` のレジストリには存在する id 向けに、汎用フォールバックを返す関数
(`celestialViewFor(ephemeris, id)` のような形)を追加する: `isStar` な天体は
`SunBody` 相当(ビルボード + 方向光)、それ以外は `SphereBody` + 単色球メッシュ
(半径はレジストリの `radius` から、表示距離は仮の固定値でよい)。

**6-3.** `game/celestial/sun-body.ts` を書き換える: `readonly id = 'sun' as const;` を
コンストラクタ引数 `constructor(readonly id: AttractorId)`(`SphereBody` と同じ形)に
変える。`sync()` 内の `ephemeris.positionOf('sun', displayTime)` を
`ephemeris.positionOf(this.id, displayTime)` に直す(方向光の向きは `ephemeris.sunDirAt(t)`
のまま — Phase 5 の 5-4 で `starId` 経由に一般化済みなので、こちらは直さなくてよい)。

**6-4.** `game/celestial/environment-scene.ts` を書き換える:

- `this.sunBody = this.bodies.find((b): b is SunBody => b.id === 'sun')!` を
  `this.sunBody = this.bodies.find((b): b is SunBody => b.id === ephemeris.starId) ?? null;`
  へ(フィールドの型も `SunBody | null` へ)。`sync()` 内の `this.sunBody.setSunlit(lit)`
  呼び出しに `if (this.sunBody !== null)` ガードを足す。`lit` の計算も `ephemeris.starId
  === null` のとき(輻射源が無い)は日照率計算をスキップして固定値(例えば常時「明るい」
  扱いの `1.0`)を使う。
- `EARTH_ATTRACTOR`/`GEO_ELEMENTS` の手組みハードコード(`MU_EARTH`/`R_EARTH` を直接埋め込み、
  `state` を無条件に原点固定している)を削除する。GEO リング・月の参照線は、レジストリに
  `'earth'`(それぞれ `'moon'`)が実在するときだけ、`bodyDef(ephemeris.registry, 'earth')`
  と `ephemeris.stateOf('earth', t)` からその場で組んだ `Attractor` を使って描く
  (`state` を原点固定で決め打ちしない — `originId` が `'earth'` でないレジストリでは
  地球が原点に無いので、これを直すことは同時に「地球が原点でない場合に GEO リングが
  ズレたまま描かれる」という潜在的な不具合の是正でもある)。存在しなければ両方とも
  非表示にする(`syncReferenceLines` を1本の overviewMode 判定から、天体ごとの存在判定へ
  分岐させる)。

**6-5.** `game/camera/overview-camera.ts` の既定フォーカスのハードコード4箇所
(`private _focus = 'earth'`、`clearFocusIf`、`resolveFocus` の2箇所)を、`ephemeris.originId`
(または将来的な意味の近さで `ephemeris.starId ?? ephemeris.originId`)を読む形へ直す。
`OverviewCamera` はコンストラクタか `update` 経由で `ephemeris`(または解決済みの既定
フォーカス id)を受け取れるようにする。

**6-6.** `game/camera/camera-system.ts` の `PANEL_FOCUS_IDS`(`Object.keys(CELESTIAL_BODIES)`
から組んでいた)を、アクティブな `ephemeris` の実際の天体一覧(`ephemeris.registry` の
キー)から組む形へ直す。

**6-7.** `game/creative/ship-placer-panel.ts` の `LAGRANGE_SYSTEM_ITEMS` にある
`def.kind === 'planet' ? 'sun' : def.planet` を `primaryOf(ephemeris.registry, id)` の
呼び出しへ置き換える。`LAGRANGE_DEFAULT_AMPLITUDE_KM`(`Record<OrbitingId, {ax,az}>`)は、
`OrbitingId` が開いたことで網羅性チェックが効かなくなる(コンパイルは通るが、レジストリに
無い天体のキーはランタイムで `undefined` になる)ので、参照箇所に `?? GENERIC_DEFAULT`
のフォールバックを足す。`GEO_ALT_KM`/太陽同期傾斜角のプリセット・`PRESETS_BY_BODY`・
基地配置を月に限定するルールは、§2-4 の境界どおり**変更しない**(既に `?? []` などで
「そのレジストリにその天体が無ければ何も出さない」という安全な形になっている)。

**6-8.** `game/creative/duplicate-form.ts` の `attractors.find((a) => a.id === 'earth') ??
strongest` を `attractors.find((a) => a.id === ephemeris.originId) ?? strongest` へ直す。

**6-9.** `game/map-picker.ts` の `itemsFor('body')` を書き換える: `if (id === 'earth')`
等の分岐に、`CELESTIAL_BODIES` に手作りサブタイトルを持たない天体向けの汎用フォールバック
(`kind`・`mu`・距離などレジストリから引ける値だけで組む説明文)を追加する。ラグランジュ点
id のサフィックス解析を `target.id.replace(/-l[1-5]$/, '')`(prefix を正規表現で切り出し、
その prefix を `bodyDef`/`celestialBodyName` へ渡す)へ一般化し、`moon-l*`/`earth-l*`
決め打ちの2分岐を削除する。これにより、`focus-markers.ts` が既に生成している
木星のラグランジュ点(`jupiter-l1`〜`l5`)などの、今日既に存在するのに素通りしていた
欠落も同時に直る(既存の潜在的な表示漏れの是正 — 本フェーズの本題ではないが、同じ
分岐を触るこの変更セットで直すのが自然)。

**6-10.** `game/plan/plan-path.ts`(`PlanPath.update`/`toDisplay`)・
`game/camera/overview-camera.ts`(`OverviewCamera.update`)に `attractors: readonly
Attractor[]` 引数を追加し、5-5 の `frameTransformAt` 呼び出しへ中継する。`Game`
(`CameraSystem.update` の呼び出し元)・`PlanEditor.update` が、Phase 4 で `Predictor`
用に求めているのと同じ `entities.attractors()` 相当の値を1フレーム1回求めて
両方へ配る。

**6-11.** `overview-camera-panel.ts`/`plan-display.ts` の `SegmentedControl<ReferenceFrame>`
を、6-10 の `attractors` を含めて求めた「今選べる `ReferenceFrame` の一覧」(登録済み天体ぶんの
`ephemeris.frames` + 生存中の重力天体ぶんの `ephemeris.frameFor(id)`)へ `setItems` で
差し替える — 既に `ship-placer-panel.ts` の基準天体選択が使っているのと同じパターン。
ラベルは 6-1 の `frameLabel` を使う。

**6-12.** `render/sampled-line.ts` の `frame === lastFrame` という参照同一性キャッシュ判定は
変更しない(5-4/6-11 で「フレーム値は必ず安定した参照を使う」契約(`Ephemeris.frames`/
`frameFor` のキャッシュ)を保っているので、動的なフレームでも成立する)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で:

- 既存ステージ(0/1/2/00)で、MAP VIEW/TRAJECTORY のフレーム選択肢が今までどおり
  (登録天体ぶんだけ)であること、天体名の表示・座標変換の挙動が一切変わっていないこと。
- Phase 3/4 の `StageDebug` 小惑星配置を開き、小惑星を回転系フォーカスの選択肢に選んで
  (MAP VIEW パネル)実際にその天体へカメラがロックされ、回転が止まって見えることを
  目視確認する(旧・回転系フォーカス一般化の実演)。
- (Phase 7 で実際にカスタムレジストリのステージを作るまでは確認できないが)このフェーズの
  時点で `celestialViewFor`/`celestialBodyName`/`frameLabel`/`itemsFor('body')` のフォール
  バック経路を、単体テストまたはその場のデバッグ用コードで最低1回はレジストリに無い id を
  渡して動かし、クラッシュしないことを確かめておく(Phase 7 で本番のカスタムステージを
  作ってから初めて欠陥に気づくと手戻りが大きいため)。

---

### Phase 7 — カスタムレジストリの実演と「自由な星系」の実演

**7-1.** `game/stages/stage-dictionary.ts` の `StageClass` インターフェースへ、任意の
静的プロパティ `ephemerisConfig?: { readonly registry: CelestialRegistry; readonly
originId: AttractorId }` を追加する。既存の `Stage00`/`Stage0`/`Stage1`/`Stage2`/
`StageDebug`/`CreativeStage` はいずれもこれを宣言しない(=既定のレジストリ・地球原点の
まま)。`ephemerisConfigFor(launch: LaunchSelection): { registry: CelestialRegistry;
originId: AttractorId }` という小さな関数を追加し、`launch.mode === 'stage'` なら対応する
`StageClass.ephemerisConfig`、`launch.mode === 'creative'` なら `CreativeStage` の同名の
静的プロパティを見て、無ければ `{ registry: SOLAR_SYSTEM, originId: 'earth' }` を返す。

**7-2.** `game/game.ts` のコンストラクタで、`this.ephemeris = new Ephemeris();`
(現在の114行目)の直前に `const ephemerisConfig = ephemerisConfigFor(launch);` を挿入し、
`new Ephemeris(ephemerisConfig.registry, ephemerisConfig.originId)` へ書き換える。
`launch` は既にコンストラクタの先頭で受け取っている引数なので、この並べ替えに他の初期化
順序への影響は無い。

**7-3.** `game/stages/stage-debug-alt-system.ts` を新設する。`StageDebug` と同じ
「選択画面に出ない(`hiddenFromSelect`)、`?stage=` で直接開くデバッグ専用ステージ」の形。
`static readonly ephemerisConfig` に、現実の太陽系とは異なる小さな `CelestialRegistry`
(例: 固定された原点の天体1つ + それを回る天体1〜2つ、架空の名前・架空の `mu`/半径)を
`originId` にその原点天体を指定して宣言する。`init(player, entities)` で、`bootstrapPlayer`
が既定で構築した地球 LEO 相当の初期状態(このステージのレジストリでは無意味な値になる)を、
その架空天体を周回する適当な軌道の `KinematicState` で上書きする(`CreativeStage` が
既に艦の初期状態を任意の軌道要素から組み立てているのと同じ変換関数(`elements.ts` の
`stateFromOrbitalElements`)を使えばよい)。

**7-4. 受入確認(手で確認する):**

1. `stage-debug-alt-system` を開くと、地球・月・木星・太陽ではなく、宣言した架空の天体
   だけが見える(現実の太陽系のデータは ECI のどこかに存在し続けているが、原点から
   十分離れているため画面には映らない — これは意図どおりで、§2-8 の「データとしては
   存在するが表示上・ゲームプレイ上は存在しないのと区別がつかない」と同じ扱い)。
2. HUD の ORBIT パネル・MAP VIEW の座標系選択・艦艇の性質パネルが、架空天体の名前
   (`CELESTIAL_BODIES` に手作りエントリが無いのでフォールバック名になっているはず)で
   表示され、クラッシュしないこと。
3. MAP VIEW でその架空天体・その回転系フォーカスへカメラをロックできること。
4. 既存の地球・月・木星・太陽を使うステージ(0/1/2/00/debug/creative)を一通り触り、
   挙動・見た目が一切変わっていないこと(`ephemerisConfig` を宣言していないステージは
   今までどおり `SOLAR_SYSTEM`/地球原点を使うため)。

**7-5.** `StageDebug`(既存、Phase 3/4 で複数の `Asteroid` を配置済み)で、それらの
`Asteroid` が互いの重力だけで複雑に絡み合う軌道を描くこと(目標2(a)の実演)を、
本フェーズの受入確認としてもう一度確認する — Phase 4 の確認と同じシナリオだが、
「自由な星系」の目標達成をこのフェーズで(a)(b)両方揃った状態として通しで確認する
意味で、ここでも確認項目に含める。

**7-6.** `DEVELOP/SPEC.md` §16「実装される可能性のある機能」へ、§2-4 の末尾に挙げた
一般化しない境界(連星系、3階層を超える公転階層、地球以外の大気/熱/初期配置/エネミー
生成式の一般化、静止軌道高度・太陽同期傾斜角プリセットの他天体への一般化)と、§2-10の
計画軌道への小惑星重力の反映を記録する。

**検証:** `npm run typecheck` / `npm run test:physics` / 上記の手動受入確認。

---

### Phase 8 — 空間ハッシュによる軽量化(計測ゲート)

**8-1. 計測する。** `StageDebug`(または専用のデバッグシナリオ)に `Asteroid` を
数百〜数千体、ランダムに散らして配置する一時的なコードを書き、`npm run dev` の実機で
`?perf=1` の update フェーズ ms を計測し、Phase 1 の基準値と比較する。

- **有意な悪化が無ければ、空間ハッシュを実装せずここで打ち切る。** 素案の目標
  (「O(NM) で爆発しない」)は、悪化が無いという実測そのものによって満たされたとみなし、
  この判断と実測値を本書と `better_simulation_todo.md` に記録する。
- **有意な悪化がある場合のみ**、以降を実施する。

**8-2.** `physics/spatial-grid.ts` を新設する。位置を持つ任意の要素に対する一様グリッド
(セルサイズは呼び出し側が渡す)への登録と、ある点の27近傍セルに属する要素の列挙を行う
純関数群(`buildSpatialGrid`/`nearby` 等、具体的な名前は実装時に決める)。`Attractor` にも
`GameEntity` にも依存しない汎用実装にする。

**8-3.** `game/const.ts` に、重力源を「常に計算するもの(重い)」と「近傍のみ計算するもの
(軽い)」に分けるしきい値定数(質量 `mu` の下限)と、空間ハッシュのセルサイズ(=軽い重力源を
計算する半径 R)を追加する。既存の重い天体(太陽・地球・木星)は必ずしきい値を超えるように、
典型的な小惑星の質量は下回るように選ぶ。

**8-4.** `game/simulation/attractors.ts` を書き換える。**呼び出し側
(`Simulator.substep`/`Predictor`)のシグネチャは変えない** — `attractorsAt` が
「ある1点における重力源一覧」を返す関数(点ごとに結果が変わる形)に寄せる必要がある場合は、
Phase 4 の「substep 全体で1つの配列を使い回す」形から「重い天体の配列 + グリッドを
substep で1回だけ作り、エンティティごとに `heavy.concat(nearby(grid, entity.state.r))`
を問い合わせる」形へ変える。グリッド自体は同じ substep 内の全エンティティで使い回すので、
構築コストは1回で済む。

**8-5.** `tests/physics/spatial-grid.test.ts` を新設し、ランダムに配置した点群に対して
グリッド経由の近傍列挙が全数探索によるフィルタと一致することを検証する。

**検証:** `npm run typecheck` / `npm run test:physics`。8-1 と同じ配置・同じ実機で
`?perf=1` を再計測し、改善を確認して記録する。既存の近距離(地球近傍)シナリオでの
挙動が完全に変わっていないこと(重い天体は常に含まれるので、小惑星が存在しない・
少数しか存在しない既存ステージでは空間ハッシュの有無で結果が変わらないはず)を
`test:physics` の回帰と目視の両方で確認する。

---

### Phase 9 — 設計文書の更新

同じ変更セットに含める(`/develop-docs`):

- **CLAUDE.md** — Architecture 節に `game/game-entity/asteroid.ts`・`game/game-entity/
  entity-id.ts`・`game/simulation/attractors.ts`・`game/stages/stage-debug-alt-system.ts`・
  `physics/spatial-grid.ts`(実装した場合)を追加。`GameEntity` の説明に `id`/`radius`/`mu`/
  `degree2`/`isStar` を追記し、旧 `collideRadius` の記述を置き換える。`Ship` の被弾判定半径が
  `hitRadius` に改称されたことを反映。`Simulator`/`Predictor` の重力源の扱いの記述を更新。
  **`physics/ephemeris.ts`(`registry`/`originId`/`starId`/`frames`/`frameFor` を持つ
  インスタンスへの一般化)・`physics/frame.ts`(`FRAMES`/`INERTIAL_FRAME` が `Ephemeris` へ
  移ったこと)・`physics/solar-system.ts`(`bodyDef`/`primaryOf` がレジストリ引数を取ること)・
  `game/celestial/celestial-registry.ts`(手作りビュー + 汎用フォールバックの2段構成)・
  `game/hud/frame-labels.ts`(動的な天体名/フレームラベル関数)の説明を、この一般化を
  反映して書き直す。** **この機会に、CLAUDE.md 中に残っている `OrbitState`/`Elements`/
  `OrbitEntity`/`current` 等の旧命名(過去のリネーム計画で置き換わったはずの名称)が
  重複して残っていないか確認し、見つかったら削除する**(本書執筆時の調査で、CLAUDE.md 内に
  新旧の記述が重複している箇所が見つかっている — Step3 本来の変更点ではないが、同じ
  ドキュメント更新の手番で気づいたものは直す)。
- **DEVELOP/OWNERSHIP.md** — `GameEntity.id`/`radius`/`mu`/`isStar` が構築時に固定される値で
  あることを反映(Ship 等の他の固定値と同列)。`EntityManager.asteroids`/`attractors()`
  の追加。`Ephemeris` が `registry`/`originId`(構築時に固定)と `frames`/`dynamicFrames`
  (構築時 + 実行時に伸びるキャッシュ)を所有することを反映。
- **DEVELOP/CALLSTACK.md** — `Simulator.substep()` 内の `Attractor` 一覧の構築(`attractorsAt`)が
  追加されたこと、`Predictor`・`OverviewCamera`・`PlanPath` への小惑星ぶんの合流を反映。
- **DEVELOP/SPEC.md** — 小惑星(重力を持つ物体)の存在、Phase 7 のデモが示す「自由な系」の
  2つの実演内容、§16 への記録(Phase 7-6 で先行して書いていなければここで書く)。
- **`.claude/skills/refactor-fixed/SKILL.md`** — §11(`body`/`ship`/`attractor` の使い分け)に、
  `AttractorId`/`Attractor.id` が登録天体とは限らない一般の `string` になったこと、
  `Ephemeris` がレジストリ・原点をインスタンスごとに持つことを追記する。天体レジストリ・
  ECI 原点・回転系フォーカスの一般化(§2-4)は「今回一般化したもの」なので、
  §15(一般化しないと決めたもの)ではなく CLAUDE.md 側の Architecture 記述に置く —
  §15 には §2-11 の空間ハッシュしきい値固定と、§2-4 末尾に挙げた境界(連星系、
  3階層を超える公転階層、地球以外の大気/熱/初期配置/エネミー生成式の一般化、
  静止軌道高度・太陽同期傾斜角プリセットの他天体への一般化)だけを追記する
  (既に書かれている「一般化しない」項目と重複しないように、全体を整合させて書き直す —
  追記の羅列にしない)。
- **`memos/hedalu244/better_simulation_todo.md`** — Step3 の記述を消し、
  「実装済み」であることが分かるよう書き直す(経緯は残さない)。Step2 の残タスク
  (分点歳差・perf 未測定・月理論の数値表)はこの Step の対象外なので、判断せずそのまま残す。
- 大きな変更なので、最後に `/comment-cleanup` で新旧コメントを一括点検する。

**検証:** `npm run typecheck`(文書のみの変更でも、直前のフェーズの状態が壊れていないことの
最終確認として走らせる)。

---

### Phase 10 — 変更セットの `/refactor`・`/refactor-fixed` 違反点検(最終フェーズ、必須)

**大規模な変更の後には必ずこの点検を行う。** Phase 2〜9 で変更した箇所(§3 の表に挙げた
新規・変更ファイル一式)を対象に、`/refactor` と `/refactor-fixed` の基準に照らして
レビューする。特に次の観点を重点的に見ること:

1. **`GameEntity` が本当に変換なしで `Attractor` と構造的に一致しているか。** どこかに
   `asAttractor()` のような変換関数や、`id`/`radius`/`mu`/`isStar` を再度ラップする
   オブジェクトが紛れ込んでいないか(§2-1 の意図はそれを作らないことだった)。
2. **`radius`/`hitRadius` の改称が漏れなく行われ、`collideRadius`という名前が
   コード中に一件も残っていないか**(`grep -rn "collideRadius" src` で 0 件になること)。
3. **`id` の統一が `Enemy`/`Ammo`/`Base` すべてに及んでいるか**、`map-picker.ts`/
   `nav-target.ts` の `e.name === target.id` という形の検索が残っていないか。
4. **`Simulator.substep()` の統合ループが `stepAttitudes()` の型ごとの分岐を誤って
   一緒くたにしていないか**(Phase 4-5 で明示的に「変更しない」とした箇所)。
5. **`attractors.ts` が `physics/` と `game/` の境界(`/refactor-fixed` §4)を
   守っているか** — しきい値定数(調整値)が `game/const.ts` 側に留まり、
   `physics/spatial-grid.ts` 側に紛れ込んでいないか。
6. **`Predictor` の近似(§2-6)がコメントとして明記されているか**、かつ
   `physics/` ではなく `game/simulation/` 側(表示・予測というゲーム側の関心)に
   書かれているか。
7. **`mu` の有無で衝突判定(`collision.ts`/`hit.ts`)を分岐させる新しいコードが
   追加されていないか**(§2-7 で明示的に禁止した箇所)。
8. **`'sun'`/`'earth'` の文字列リテラルによる分岐が、§2-4 で意図的に一般化しないと
   決めた範囲(大気/熱/初期配置/エネミー生成式、静止軌道・太陽同期プリセット、
   基地配置ルール)の外に残っていないか。** `grep -rn "'sun'" src` / `grep -rn
   "=== 'earth'" src` で拾い、それぞれが §2-4 末尾の境界内の正当な残存か、直し忘れかを
   1件ずつ判定する。
9. **`bodyDef`/`primaryOf` の呼び出し箇所が、すべて `registry` 引数を明示的に渡す
   形になっているか**(モジュールレベルの `SOLAR_SYSTEM` を無条件に読む古い呼び方が
   残っていないか)。
10. **`Ephemeris.frames`/`frameFor` の動的フレームが `FRAMES` の旧・参照同一性契約と
    同じ強さで守られているか。** 生存中の重力天体ぶんの `ReferenceFrame` を毎フレーム
    新しいオブジェクトとして作っていないか(`render/sampled-line.ts` の `frame ===
    lastFrame` キャッシュが常に外れて描画コストが跳ね上がっていないか)確認する。
11. **登録済み天体の回転系解決経路(解析的・分点歳差込み)が、誤って骨組み(osculating)
    経路に巻き込まれていないか。** 月/地球回転系など既存の座標系の挙動・見た目が
    一切変わっていないことを目視で確認する。
12. **`stage-debug-alt-system.ts` 以外のステージの `ephemerisConfig` が undefined の
    ままであることを確認する** — 意図せず既存ステージの原点・レジストリを変えてしまって
    いないか。
13. **`game-entity.ts` の「メモ化されている」という古いコメントが本当に消えているか**
    (Phase 4-4 で指摘した既存の矛盾コメントの是正が漏れていないか)。同様に
    `dynamics.ts` の「固有名の分岐は現れない」というコメントが、Phase 5-6 の修正後に
    実態と一致しているか。
14. `Asteroid`/`entity-id.ts`/`stage-debug-alt-system.ts` が既存クラスと比べて過不足の
    ないフィールド・メソッドになっているか(不要な汎用化・書きすぎたコメントが無いか)。
15. 200行/100行の目安(モジュール/関数)を超えているファイル・関数が無いか
    (特に `entity-manager.ts`・`simulator.ts`・`predictor.ts`・`game-entity.ts`・
    `ephemeris.ts`・`map-picker.ts`・`ship-placer-panel.ts` は既存でもそれなりの行数が
    あるので、今回の追記で超えていないか確認する)。
16. §3 の表にある全ファイルの diff を見て、コメントの過不足(`/comment` 基準)を
    個別に点検する。
17. **`Attractor.radius`/`GameEntity.radius` が `number | null` に広がったことで、
    `center.radius`/`attractor.radius` を読む箇所が `null` を暗黙に `0` として扱って
    いないか(JavaScript の `null + x` が `x` になる、`null` を距離から素朴に引き算
    している等)。** Phase 4-2 に列挙した箇所(`hitAttractor`・`apsisAltitudes`・
    `orbit-info.ts`・`map-picker.ts`・`plan-display.ts`・`creative-stage.ts`)がすべて
    `=== null` の明示チェックを経由しているか確認する(§2-1、落とし穴チェックリスト3)。

レビューで見つかった問題はこの変更セットの中で修正する。修正後、
`npm run typecheck` / `npm run test:physics` が green であることを再確認して完了とする。

---

## 5. 落とし穴チェックリスト

1. **substep 内で `Attractor` 一覧を使い回さず、各エンティティが自分で
   `attractorsAt`/`entities.attractors()` を呼び直すと、処理順に依存した非対称な誤差が
   混入する。** これは性能の問題ではなく正しさの問題(§2-5)。実装時に「1回だけ呼んで
   引数で配る」形になっているか必ず確認すること。
2. **`radius`(旧 `collideRadius`)の無効値の表し方を `undefined` から `null` へ揃える際、
   `!== undefined` の判定を `!== 0` に直してしまうと、半径0の点物体(有効な値)が剛体接触に
   参加しなくなる。** 正しくは `!== null` へ直すこと。`collision.ts`/`hit.ts` の判定を
   すべて洗い出して直すこと(§2-1 のとおり最終的に `grep -rn "collideRadius"` が
   0 件になることで確認する)。
3. **`Attractor.radius` を `number | null` へ広げた際、`center.radius === null` を
   「高度0」と誤って扱う(`null` が数値演算で `0` に暗黙変換されるのを見落とす)と、
   表面を持たない重力源を中心にした距離計算が実際の距離をそのまま高度として表示して
   しまう、静かに間違った値のバグになる。** `hitAttractor`/`apsisAltitudes`/HUD の高度
   表示(Phase 4-2 に列挙した箇所)は必ず `=== null` を明示的にチェックしてから使うこと。
   Step3 の範囲ではこの分岐は実行時に一度も通らないが(§2-1・Phase 4-2)、チェック漏れは
   将来 `radius === null` の重力源が追加された瞬間に顕在化する。
4. **`Ship.radius`(被弾判定半径)を `hitRadius` に改称する際、`RadiatorSystem.hitRadius()`
   という既存のメソッド名と紛らわしくなる**(`player.ts:200` の
   `this.radius = this.radiator.hitRadius();` が `this.hitRadius = this.radiator.hitRadius();`
   になる — 意味は「ship の被弾判定半径 = radiator が寄与する被弾判定半径」で正しいが、
   読み違えないようコメントを確認すること)。
5. **`Asteroid.id` は `EntityManager.attractors()` が呼ばれるたびに同じ文字列を
   返す必要がある**(生成時に固定した1つの id を使い回す。呼ぶたびに新しい id を発行しない
   — 基底の自動採番はコンストラクタで1回だけ行われるので、通常はここを誤る余地はない)。
   `GameEntity.orbitalElementsAround` の要素メモが `center.id` をキーの一部にしているため、
   id がフレームごとに変わるとメモが常に外れて無駄な再計算が発生する(壊れはしないが
   性能が悪化する)。
6. **`Predictor` の近似(§2-6)は艦の予測が小惑星の重力で曲がることは保証するが、
   小惑星自身の未来位置は予測しない(`predictsFuture=false`)。** 「小惑星が
   将来どこに行くか」を画面に表示する機能を後から足したくなったら、この設計を
   見直す必要がある(§2-6 に明記した制約)。
7. **`hitAttractor`/`hitCelestialBody` に渡す `attractors` に小惑星を含めてしまうと、
   艦が小惑星に近づいただけで「再突入」判定されるようになる。** §2-7 の判断どおり、
   `EntityManager.cleanup` へ渡す配列は解析天体のみのまま変えないこと。
8. **`AttractorId` を `string` へ開いた後、`registry[id]` のような添字アクセスをコンパイラが
   検出できなかった場合**(例えば `as AttractorId` で型を強制的に通してしまっている
   既存コードがあれば、そこはノーチェックのまま実行時に壊れうる)、typecheck だけに
   頼らず `grep` で `as AttractorId` の既存箇所も洗い直すこと。
9. **`Ephemeris.frames`/`frameFor` の動的フレームは、毎回リテラルで作らずキャッシュから
   同じ参照を返さないと、`sampled-line.ts` のキャッシュが常に外れて描画コストが
   跳ね上がる**(壊れはしないが性能が悪化する)。`frames`(登録天体ぶん)と同じ「値は
   必ず安定した参照を使う」契約を、動的フレームにも適用すること。
10. **登録済み天体の回転系解決(解析的・分点歳差込み)と、生存中の重力天体の回転系解決
    (骨組み・その瞬間の相対状態から組む)は別の経路であり、混同すると既存の月/地球回転系が
    突然ブレて見えるようになる。** `Ephemeris.frameTransformAt` の分岐が「id がアクティブな
    レジストリに実在するかどうか」で正しく振り分けられているか確認すること(§2-4)。
11. **`Asteroid` の `bcInv`/`srpCoeff` を 0 にし忘れると**、`dynamics.ts` の
    `dragAccel`/`srpAccel` が(どの天体からどれだけ離れていても)ゼロでない抵抗・輻射圧を
    計算しようとする — 実害は乏しい(遠方では両方ともほぼゼロになる式ではある)が、
    無駄な計算と意図のわかりにくさを避けるため明示的に 0 にする。
12. **空間ハッシュ(Phase 8)を実装した場合、しきい値(重い/軽いの境界)を
    誤って既存の月や木星より下に設定すると、既存の近距離シナリオの重力計算が
    突然「軽い天体」として近傍限定になり、遠く離れた木星の寄与が消える**
    — 既存挙動が変わってしまうので、しきい値は既存の重い天体全てを確実に上回る
    ように選び、テスト(8-5)だけでなく実際の既存ステージでの回帰確認(Phase8末尾)を
    省略しないこと。
13. **`primaryOf` は「主星がちょうど1つ、または0個」を前提にする(§2-4)。** カスタム
    レジストリに `kind: 'star'` の天体を2つ以上入れてしまうと、`Ephemeris` の構築時
    (`starId` の解決)またはコンストラクタで例外になる — 連星系はこの Step のスコープ外
    (§2-8)であることをコメント・エラーメッセージで明確にしておくこと。
14. **`game.ts` のコンストラクタ内で `Ephemeris` の構築(`ephemerisConfigFor` の解決)を
    `bootstrapPlayer`/`initStage` より前に置き忘れると**、`Ephemeris` が既定のレジストリ・
    地球原点のまま構築されてしまい、ステージの `ephemerisConfig` が無視される
    (Phase 7-2 の並べ替えが正しい位置に入っているか確認すること)。
15. **`stage-debug-alt-system.ts` のようなカスタムレジストリのステージでは、
    `bootstrapPlayer` の既定初期状態(地球 LEO)がそのレジストリでは無意味な値になる。**
    `Stage.init` で確実に上書きすること — 上書きを忘れると、艦がそのレジストリの原点
    近傍で「地球の `MU_EARTH`/`R_EARTH` を使った LEO」という無関係な軌道に乗ったまま
    始まってしまう(クラッシュはしないが、デモとして意味を成さない)。

---

## 6. このステップでやらないこと

- **恒星が2つ以上、相互に公転しあう連星系。** §2-4 のとおり `primaryOf`/`starId` は
  「主星0または1つ」を前提にする。相互に比較可能な質量が複雑な軌道を描く状況(真の連星)は
  解析的なケプラー軌道モデルの適用範囲外であり、レジストリの一般化では表現できない。
- **3階層(恒星/惑星/衛星)を超える公転階層(衛星の衛星など)。** `CelestialBodyDef` の
  分類自体は変えない(素案の要求どおり)。
- **地球の大気圏熱管理・初期配置(`makeInitialState`)・エネミー生成式を、天体非依存に
  一般化すること。** §2-4 の境界どおり、地球以外の天体しか無いレジストリでもクラッシュ
  しないことまでを保証し、これらの物理モデル自体は一般化しない。
- **静止軌道高度・太陽同期傾斜角のプリセットを任意の天体へ一般化すること。** 自転周期という
  現状のレジストリのスキーマに無いデータを要求するため、地球以外の天体では単にプリセットが
  出ない(既存コードが既にこの形で動いている)ままにする。
- **`game/celestial/` の `CelestialBody` 系のクラス名の見直し。** §2-9 の判断により、
  改名の前提(解析/積分の統合)が今回発生しないため見送る。
- **`feature_todo.md`「衝突判定の統一化」そのもの。** §2-7 のとおり、今回は既存の
  `CollisionPhysics`/`hitCelestialBody` の分岐をそのまま使い、どちらの方向にも
  統合を先取りしない。
- **計画軌道(`plan/plan-arc.ts`)への小惑星重力の反映(積分自体への影響)。**
  §2-10(`DEVELOP/SPEC.md` §16 へ記録)。回転系フォーカス(§2-4)が `PlanPath` の表示座標系
  を小惑星基準に選べるようにするのとは別物であることに注意。
- **小惑星自身の未来予測(`predictsFuture=true` 化)。** §2-6。
- **クリエイティブモードの艦艇配置パネル(`ship-placer-panel.ts`)からの小惑星配置 UI、
  および小惑星を基準にした新規オブジェクトの配置(ラグランジュ点を含む)。**
  回転系フォーカス(§2-4)は既存の重力天体を眺める機能であり、新しい天体をそれ基準に
  配置する機能とは別。Phase 4/7 の受入確認は `StageDebug` への直接配置で行う。UI化は
  別途要求が出てから `/add-feature` の手順で検討する。
- **動的(相対的)なしきい値による空間ハッシュ。** §2-11。固定のグローバル定数で十分。
- **分点歳差・月理論の数値表の未検証項目など、Step2 の残タスク。** 本書のスコープ外
  (`better_simulation_todo.md` に残す)。

---

## 7. フェーズごとの検証コマンド

```
npm run typecheck          # 全フェーズで必ず
npm run test:physics       # 物理層を触る Phase 2〜8 で必ず
npm run dev                # Phase 2 以降、目視確認
npm run dev + ?perf=1      # Phase 1(基準)・Phase 8 冒頭(計測)・Phase 8 末尾(効果測定)の
                            # 3点で実機測定して記録する(ヘッドレスでは高負荷まで駆動できない)
npm run dev + ?stage=<id>  # Phase 7 の stage-debug-alt-system を含む、選択画面に出ない
                            # デバッグ専用ステージを開くときに使う
```

**着手前に Phase 1 の基準値を実機で測っておくこと。** これが無いと Phase 8 の
「悪化しているか」の判断ができない。
