# Step 3 実装手順 — 重力を及ぼしかつ受ける天体(小惑星)と、任意の星系を表せる天体レジストリ

`better_simulation_todo.md` の実装計画素案 Step3 を、**`origin/main` をマージした現状のコード**と
突き合わせて具体化したもの。
着手前に、必ず `better_simulation_todo.md` の§目標を参照し、目的を理解しながら行うこと。
素案は「無数の小惑星」「自由な星系」「座標系の脱却」「命名の再検討」
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
3. **実行時パフォーマンス** — 重要だが上2つより下。**空間インデックスによる軽量化は、
   それ無しの実装で実測してから要否を判断する。** 先に最適化を作り込まない。
4. **変更コスト** — 最も低い。ただし一度に全部書き換えず、フェーズごとに確認しながら進める。
   **設計の良さは変更コストの大きさより優先される。** 影響範囲が広いことは、その一般化を
   見送る理由にはならない — 見送るなら、見送るだけの物理的・設計的な理由が要る。

その他の前提:

- Step2 の残タスク(分点歳差の扱い、月理論の数値表の未検証項目)は本書のスコープ外。
  `better_simulation_todo.md` に残したままにする。
- **`feature_todo.md`「衝突判定の統一化」(実体弾・剛体・天体表面への接触を、種別でなく
  質量と相対速度から求まる力積へ1実装に統合する予定)とは、今回意図的に密結合させない。**
  この統合が実際にどちらの形に転んでも今回の変更が邪魔にならないよう、Asteroid は
  既存の衝突経路(`collides` を立てた全エンティティが対等に参加する `CollisionPhysics`)へ
  そのまま乗せるだけにし、`mu` の値によって衝突の扱いを分岐させる新しいコードを
  一切書かない(§2-7)。

---

## 0.5. main 側計画との関係 — 壊してはいけない不変条件

`origin/main` は `memos/mikanixonable/SOLAR_SYSTEM_PLAN_2026-08-09.md`(第1次計画、P0〜P8)を
完了した状態にある(登録天体 4 → **27体**、自転軸の IAU pole モデル、環、小惑星帯・トロヤ群の
表示専用点群、戦闘ビューの惑星輝点、ラベル・座標系 UI の絞り込み)。続く
`SOLAR_SYSTEM_PLAN2_2026-08-09.md`(第2次計画、EP0〜EP8。登録天体を 27 → 86 に増やし、
形状・環・点群を拡張する)は未着手で、**本書の実行後に着手される。**

両者の重心は逆を向いている — 本書は**任意の星系を表せる一般性**を、あちらは**実在の太陽系への
忠実さ**を求める。方針は「先に一般化の基盤を敷き、その上に太陽系固有の作り込みを載せる」。
したがって本書は、あちらの作業を**先取りしてもよい**が、**遠ざけてはならない。**
具体的に守る不変条件は次の7つ。各フェーズの受入条件にこれを含める。

1. **天体を1体追加したときに「必要な記述の欠落」がコンパイルエラーで止まる性質を落とさない。**
   第2次計画 E-9 は「日本語表示名だけは型で必須のまま残す。ID をそのまま表示するフォール
   バックを許すと、表示名が抜けたまま出荷される」と明言している。本書は `AttractorId` を
   `string` に開くが、**具体レジストリ側の網羅性強制は保つ**(§2-3)。
2. **二窓構成(`Ephemeris.attractorsAt` = 全天体 / `gravityAttractorsAt` = 重力源のみ)を
   壊さない。** 第1次計画 D-1 が「絞ると火星の裏のラベルが選べる/表示専用天体を艦が
   すり抜ける等4系統が同時に壊れる」として確立した分離。本書は窓を**減らさず、位置依存の
   第3段を足す**(§2-11)。
3. **`Ephemeris` のリングキャッシュの契約(同一 `t` には同一の配列参照を返す。呼び出し側は
   その配列と要素を書き換えてはならない)を守る。** 新しい配列を作って返すのは自由だが、
   受け取った配列を破壊してはならない。
4. **`PoleModel` は `CelestialBodyDef` 直下、軌道要素の基準面は `KeplerOrbit.basisToEci`。**
   どちらも `/refactor-fixed` §3・§15 で確定済みの責務境界。本書はここに触らない。
5. **`CelestialBodyDef.gravitySource` / `lagrangeLabels` フラグを消さない。** 第2次計画 F-10 は
   `gravitySource` の意味を「近傍に行きうるか」から「μ の測定値が存在するか」へ変え、
   true を5体から71体へ増やす予定。本書の §2-11 はまさにその増加を安全にするための機構
   なので、**フラグを消すのではなく、その下流に位置依存の絞り込みを足す。**
6. **UI 絞り込みの「判断」を落とさない。** `FRAME_ITEMS` が53フレームを9項目に絞る規則
   (中心・回転基準がともに `gravitySource` の系だけ選ばせる)と、`LAGRANGE_LABEL_IDS` が
   L 点ラベルを4天体に絞る規則は、動的化しても**同じ意味の述語として残す。**
7. **27体の登録データとエポック整合(`EPOCH_T_OFFSET`)には触らない。**

逆に、本書が**あちらの作業を肩代わりする**のは次の2点。完了後に第2次計画側を軌道修正する。

- **EP0(重力窓の位置依存化)を §2-11 が実装する。** あちらの `relevantAttractors` +
  静的 `influenceRadius` に相当する機構を、静的な見積り値を持たない形(§2-11)で入れる。
  これが入って初めて F-10(重力源を71体に増やす)が NF-1(性能)と両立する。
- **`def.kind === 'planet' ? 'sun' : def.planet` の5重複を `primaryOf` 1箇所へ潰す**(§2-4)。

---

## 1. 到達点(成功基準)

素案が Step3 に掲げた目標は次の2つ:

1. 無数の小惑星を追加してもパフォーマンス的に O(NM) で爆発しないこと。
2. 太陽が存在しない3連星系といった自由な星系を表現できるようにすること。

本書終了時に、次が成り立っていること:

1. **`id`/`radius`/`mu`/`state` という共通の形が `GameEntity` のネイティブフィールドとして
   揃い、`GameEntity` が変換なしに構造的に `Attractor` として扱える。** `mu: number` は
   `0` が「重力を及ぼさない」を意味する(重力の式がその天体の寄与を係数0倍するのと
   数学的に同義な、既定・無効を表す数値)。`radius: number` は既定 `0` = 半径0の点であり、
   これも有効な値である(`hitAttractor` は決してヒットせず、`isOccluded` は決して遮らない —
   どちらも半径0で正しく退化する)。「剛体接触に参加するか」は半径とは**独立した別の問い**
   なので、`collides: boolean` という別フィールドで表す(§2-1)。
2. **「重力を及ぼし、かつ重力の影響を受ける」物体(`Asteroid`)が実装され、`GameEntity` の
   通常の積分経路(`DynamicTrajectory`/`stepActual`)にそのまま乗る。** 新しい解析軌道の
   分類は増えない(素案の「星/惑星/衛星」3分類は変えない)。
3. **複数の小惑星どうし、および小惑星と自機/敵/デブリの間で相互重力が正しく働く。**
   二体の場合の周期・全運動量保存がテストで検証されている。
4. **重力積分が舐める重力源の本数が、登録天体の総数ではなく「今いる場所の混み具合」で
   決まる。** 位置依存の絞り込み(§2-11)が3つの積分経路すべてを通り、絞り込みの有無で
   結果が変わらないことがテストで確認されている。小惑星が数百〜数千に増えたときの
   空間インデックスは、実測してから要否を判断した上で入れる(§2-11)。
5. **「自由な星系」が、物理的性格の異なる2つの機能の組み合わせとして実現されている。**
   (a) 質量が比較可能な複数天体が相互に複雑な軌道を描く状況は、閉じた解析解を持たないので
   `GameEntity`(小惑星)の数値積分でしか表現できない — これは目標1の小惑星機構がそのまま
   担う(§2-8)。(b) 現実の太陽系とは異なる天体の集合・階層・原点で進行するステージ
   (恒星が1つも無い系、木星が原点の系など)は、解析的な天体暦のままで表現できるが、
   `Ephemeris` が読む天体レジストリそのものが**ステージごとに差し替え可能**でなければ
   ならない。**`SOLAR_SYSTEM` を `Ephemeris` インスタンスへ注入可能にし、ECI 原点・
   主星の解決を「現在使われているレジストリ」から動的に引くよう一般化する(§2-4)。**
   両方がそれぞれ独立したデモとして示されている(Phase 7)。
6. **座標系選択・天体名表示・艦艇配置パネルの基準天体選択が、いずれも「現在アクティブな
   `Ephemeris` が実際に持っている天体」から動的に組み立てられる。** 登録天体に加えて
   生存中の重力天体(`mu !== 0` の `GameEntity`)も回転系の基準に選べ、かつ地球・月・太陽の
   いずれかを欠く(あるいは全く異なる)レジストリでも GUI がクラッシュしたり地球中心
   固定のまま動かなくなったりしない(§2-4・Phase 6)。**同時に、既定レジストリでの
   選択肢の中身は今日と1項目も変わらない**(§0.5 の不変条件6)。
7. **既存のゲームプレイが一切変わらない。** 小惑星が1体も存在せず、ステージが既定の
   レジストリ(現実の太陽系・地球原点)を使っている限り、新しいコード経路は旧コード経路と
   ビット単位で同じ結果を返す(既存の `test:physics` が無改造で通ることで確認する)。

---

## 2. 設計判断(素案からの逸脱と理由)

### 2-1. `GameEntity` に `id`/`radius`/`collides`/`mu`/`degree2` をネイティブフィールドとして
    持たせ、変換なしで `Attractor` と構造的に一致させる

**最初に立てた「`GameEntity` に `gravitySource: {id, mu, radius} | null` という新しい
オプショナルフィールドを追加する」という案は撤回する。** 既存の `Attractor` 型とほぼ同じ形の
型を並べて作ることになり、「同じものに別の名前を与えない」「類似の型を二重に実装しない」と
いう原則に反していたため。

現状の `Attractor`(`physics/attractor.ts:41-47`)は5フィールド:

```ts
export type Attractor = {
  readonly id: AttractorId;
  readonly mu: number;                     // GM [m^3/s^2]
  readonly radius: number;                 // 表面半径 [m]
  readonly state: KinematicState;          // ECI 位置・速度
  readonly degree2: Degree2Gravity | null; // null なら質点として扱う
};
```

対する `GameEntity`(`game/game-entity/game-entity.ts`)は `state` の get/set を既に持ち、
`mass`(剛体接触の換算質量)と `collideRadius?: number`(未設定 = 剛体接触に参加しない)を
持つが、`id`/`mu`/`radius`/`degree2` は無い。

**`id` と `radius` はそもそも重力とは無関係の、`GameEntity` 一般の概念である。**

- `id` は今日すでに `Player.id`/`Enemy.id?`/`Ammo.id`/`Base.id` としてクラスごとに
  バラバラに(場当たり的に)実装されている(§2-2 で詳述)。重力天体のためだけに
  5つ目の id 概念を作るのではなく、この場当たり性自体を先にリファクタリングし、
  `GameEntity` が最初から `id: string` を持つようにする。
- **`radius` は「物理的な半径」ひとつの意味に純化し、既定を `0` にする。**
  現行の `collideRadius`(`undefined` = 剛体接触に参加しない)は、**半径という量と
  「剛体接触に参加するか」という参加可否を1つのフィールドに詰め込んでいる。**
  この2つは独立な問いである — 弾丸や破片は物理的な大きさを確かに持つが剛体接触には
  参加しない(参加させると排莢直後の薬莢を弾いてしまう、破片が跳ね回る)。したがって:

```ts
// game-entity.ts
readonly id: string;   // 一意な識別子。表示名(Ship.displayName 等)とは別の概念(§2-2)
radius = 0;            // 物理的な半径 [m]。0 = 点。Attractor.radius と同じ量。
                       // mu !== 0 のときはその重力源の表面半径にもなる。
collides = false;      // 剛体接触(CollisionPhysics)に参加するか。半径とは独立の問い。
protected mu = 0;      // 重力定数 GM [m^3/s^2]。0 = 重力を及ぼさない(既定)。
readonly degree2: null = null; // GameEntity は2次重力場(J2/C22 のような非球対称項)を
                               // モデル化しない。不整形な小天体のそれは無視できるほど
                               // 小さく、ゲームプレイ上考慮しない。
```

**この形にすると `Attractor.radius` を `number | null` へ広げる必要がなくなる。**
以前の案は「未設定」を表すために `radius` を nullable にしようとしていたが、その結果
`hitAttractor`・`apsisAltitudes`・`occlusion.ts` の `isOccluded`・`OverviewCamera.minDist`・
HUD の高度表示など、`radius` を読む全箇所が `null` を学ぶ必要が生じていた。
**半径0の質点はこれら全ての式で正しく退化する**(表面に沈み込めない/遮蔽しない/
カメラが寄れる限界が0になる/高度 = 中心からの距離)ので、`null` を導入する理由が無い。
`physics/` 側の型変更はゼロで済む。

`EntityManager` が重力源一覧を作る処理は変換ではなく**フィルタだけ**になる:

```ts
// entity-manager.ts
// 重力を持つ(mu !== 0 かつ生存中の)エンティティを、変換なしに Attractor として返す。
// GameEntity は id/radius/mu/degree2/state を直接持つので、Attractor 型への変換コードは要らない。
// フィルタ条件が mu だけであることに注意 — radius・collides(剛体接触の可否)は重力の可否と
// 無関係なので、ここには影響しない。
attractors(): readonly Attractor[] {
  return this.all().filter((e) => e.alive && e.mu !== 0);
}
```

**`mass` と `mu` の整合は `Asteroid` のコンストラクタが持つ。** `GameEntity.mass`(剛体接触の
換算質量)と `mu`(= G·質量)は同じ物理量の別表現なので、両方を別々に受け取ると食い違う。
`Asteroid` は質量を1つだけ受け取り、`mass` と `mu = GRAVITATIONAL_CONSTANT * mass` の
両方をそこから導く。`GRAVITATIONAL_CONSTANT` は物理定数なので `physics/solar-system.ts` に置く
(既存の `MU_*` は測定値としての GM を直接持つので、これらを G で割り直すことはしない)。

**これに伴い、既存の `radius` まわりの命名衝突を1つ解消する。**
`Ship`(`Player`/`Enemy` の基底)は既に `radius: number` を持っているが、これは
**被弾判定半径**(弾丸との命中判定用)であり、剛体接触の `collideRadius` とは意図的に別物
(`ship.ts:17` の既存コメント:「被弾判定半径 [m](剛体接触の collideRadius とは別)」)。
実際 `Player` は「剛体接触は実機体サイズのまま、被弾判定半径だけ放熱板の展開に応じて広がる」
という**意図的な乖離**を持っている。この2つを1つの `radius` へ統合することはできない。
そこで **`Ship.radius`(被弾判定半径)を `Ship.hitRadius` に改称し**、`GameEntity.radius`
(物理半径)と名前が衝突しないようにする。影響は `ship.ts`・`enemy.ts`・`player.ts`・
`simulation/hit.ts` の4ファイル程度で、機械的な改名(意味は一切変えない)。

### 2-2. `id` の場当たり性をこの変更セットで解消する

現状を調べると、識別子の持ち方がクラスごとに4通りに分かれている:

| クラス | 識別子の実装 | 備考 |
|---|---|---|
| `Player` | 必須の `id`。`displayName` を既定値に、コンストラクタ引数で明示指定も可 | **既に `displayName`(重複可の表示名)と `id`(マップ選択用の不変キー)を分離済み** |
| `Enemy` | `id?: string`(`enemy.ts:57`)。省略可能で、セーブデータ復元時のみ設定され、生存中の実運用では**代わりに `name` を識別子として使っている** | `game.ts:563`・`map-picker.ts:276,317,525,631`・`nav-target.ts:148` に `enemies.find((e) => e.name === …)` という形の検索が**6箇所**ある。`name`(表示名、重複しうる)を識別子に使っているのは `Player` が既に卒業した設計の古い形 |
| `Ammo` | 自己生成(`ammo-${counter}`)。復元 id を渡されたら採用し、カウンタをその番号より先へ進める | |
| `Base` | `Ammo` と同じパターンを独立に再実装(`base-${counter}`) | `Ammo` と実装が重複している |

**`Player` が既に到達している「表示名と不変な識別キーを分離する」形を、`GameEntity` の基底に
引き上げて全クラスへ揃える。** `GameEntity` に `readonly id: string` を追加し、コンストラクタで
明示的な id を受け取らなければ自動採番する。`Ammo`/`Base` がそれぞれ持っている
「採番 + 復元 id によるカウンタ追い越し」ロジックは、共通のヘルパへ一本化して両方から使う
(重複実装の解消)。`Enemy` は `id` を必須にし、`name` は表示専用に純化する。

**上記6箇所の `e.name === …` 検索を `e.id === …` に直す。** `map-picker.ts` が
`MapPickable` を組み立てている箇所の `{ id: enemy.name, … }` も `{ id: enemy.id, … }` に直す。
これにより「同名の敵が複数存在すると片方が選択できない」という既存の潜在的な不具合も
副次的に直る。`EntityManager` には `findPlayer(name)` に相当する敵版(`findEnemy(id)`)を
追加し、6箇所がそれを呼ぶ形にする — 同じ `find` を6回書き写す形は `Player` 側で既に
卒業している。

### 2-3. `AttractorId` を `string` へ開き、具体レジストリは `keyof` で自己生成する

現状(`physics/attractor.ts:10-23`)は手書きの閉じた union:

```ts
export type StarId = 'sun';                                   // 1
export type PlanetId = 'earth' | 'mercury' | … | 'encke';     // 17
export type SatelliteId = 'moon' | 'phobos' | … | 'triton';   // 9
export type AttractorId = StarId | PlanetId | SatelliteId;    // 27
export type OrbitingId = PlanetId | SatelliteId;              // 26
```

レジストリが実行時に決まる以上、この union は成立しない。**しかし単純に `string` へ開くと、
第2次計画 E-9 が「表示名が抜けたまま出荷されるのを防ぐ唯一の手段」と位置づけたコンパイル強制
(`CELESTIAL_BODIES: Record<AttractorId, {name, create}>` の網羅性)が失われる。**
これは §0.5 の不変条件1に真っ向から反する。

**解決: 汎用 API は `string` に開き、具体レジストリは自分の ID 型を自分のデータから生成する。**

```ts
// physics/attractor.ts — 汎用側。どんなレジストリでも通る
export type AttractorId = string;
export type OrbitingId = AttractorId; // 恒星を渡すべきでない引数の注釈として残す(強制力は無い)

// physics/solar-system.ts — 具体レジストリ側。宣言は今のまま(satisfies を維持)
export const SOLAR_SYSTEM = { earth: {…}, moon: {…}, /* … */ sun: {…} }
  satisfies CelestialRegistry;
export type SolarSystemId = keyof typeof SOLAR_SYSTEM;   // 27個のリテラル union が自動で出る
```

- `SOLAR_SYSTEM` は既に型注釈ではなく **`satisfies`** で書かれている(各エントリの具体型を
  保つため)。したがって `keyof typeof SOLAR_SYSTEM` が今日の `AttractorId` と**同一の
  27リテラル union** をデータから直接生成する。
- `CELESTIAL_BODIES: Record<SolarSystemId, {…}>` と書けば、**網羅性強制は今日とビット単位で
  同じまま残る。** むしろ天体を1体足すときの編集箇所が「union に足す + `SOLAR_SYSTEM` に
  足す」の2箇所から「`SOLAR_SYSTEM` に足す」の1箇所へ減り、その1箇所を足した瞬間に
  `CELESTIAL_BODIES` が赤くなる。**第2次計画の86体作業にとって純粋な改善である。**
- 恒星を除いた `SolarSystemOrbitingId` も同様にデータから導ける(`kind` が `'star'` の
  キーを除く条件付きマップ型)。太陽系専用のテーブル(`LAGRANGE_DEFAULT_AMPLITUDE_KM` 等)は
  こちらを使う。
- `bodyDef<T extends AttractorId>(id: T): BodyDefOf<T>` の型レベル絞り込みは、レジストリが
  実行時に決まる以上もう機能しないので削除し、`bodyDef(registry, id)` は
  `CelestialBodyDef`(判別 union そのもの)を返す素直な関数にする。呼び出し側は `.kind` の
  実行時判定で絞り込む(`ephemeris.ts` の `helioStateOf` が既にやっている形)。
  **太陽系固有の値を型付きで直接読みたい箇所**(`ship-placer-panel.ts:139` の
  `bodyDef('earth').orbit.lRate`、`asteroid-belt.ts:68-71` の `SOLAR_SYSTEM.jupiter.orbit`)は
  `bodyDef` を経由せず `SOLAR_SYSTEM.earth` のように直接読む — もともと太陽系固有の
  入力補助データであり、汎用 API を通す意味がない。

**この型変更を単独で先に行うことはしない。** `AttractorId` だけを広げても、実際に
「登録されていない天体」が `Attractor.id` に現れる状況(小惑星が重力の中心になる、
レジストリがステージごとに異なる)はまだコード上どこにも作られていない。
§2-4 のレジストリ化とまとめて **Phase 5 で1度に行う。**

### 2-4. レジストリ・ECI 原点・主星解決・回転系フォーカスを一般化する

これが素案の「太陽系のハードコードからの脱却」「ECI 前提の座標系からの脱却」「自由な星系」に
直接対応する、本書で最も範囲の広い設計判断なので詳しく書く。

**現状のハードコードは4箇所(実コードで確認済み):**

1. `SOLAR_SYSTEM`(`physics/solar-system.ts`)がモジュールレベルの `const` であり、
   `Ephemeris` はコンストラクタで受け取らず(`ephemeris.ts:114` は `phaseOffsets` のみ)、
   常にこの1つのグローバルな登録内容(27体)を読む。ステージごとに天体の集合を変えられない。
2. `Ephemeris.stateOf` が ECI 化のために `helioStateOf('earth', t)` を引く
   (`ephemeris.ts:223`)。ECI の原点が地球だとハードコードされている。
   `physics/frame.ts:51` の `INERTIAL_FRAME` も `f.center === 'earth'` の `.find` で決まる。
3. **`def.kind === 'planet' ? 'sun' : def.planet` という同型の三項演算子が5箇所に重複**
   (`ephemeris.ts:249` の `lagrangeAt`、`celestial/environment-scene.ts:170`、
   `camera/focus-markers.ts:34`、`creative/ship-placer-panel.ts:95`、`physics/halo.ts:60`)。
   `solar-system.ts:42` の `primaryOf` が同じことをしているのに、誰もそれを呼んでいない。
4. `Ephemeris.sunDirAt` が `positionOf('sun', t)`(`ephemeris.ts:260`)、`dynamics.ts:120` が
   `attractor.id === 'sun'` で輻射源を選ぶ、`environment-scene.ts:101` が `b.id === 'sun'` で
   `SunBody` を拾う、`asteroid-field.ts:54` が `positionOf('sun', t)` で点群を ECI 化する。

**方針: `SOLAR_SYSTEM` を「既定のレジストリ」として残しつつ、`Ephemeris` インスタンスが
自分の使うレジストリ・原点天体を持てるようにする。** 既存の呼び出し元(`game.ts:126` の
`new Ephemeris()`)は引数を渡さなければ今までどおり現実の太陽系・地球原点で動く —
挙動もコンパイル結果も変えない。ステージがカスタムのレジストリ・原点を使いたいときだけ渡す。

1. **`AttractorId` を `string` に開く**(§2-3)。
2. **`solar-system.ts` に `CelestialRegistry`(`= Readonly<Record<AttractorId,
   CelestialBodyDef>>`)を新設し、`bodyDef`/`primaryOf` をレジストリ引数を取る形に直す。**
   `SOLAR_SYSTEM` は「現実の太陽系」という名前つきのデータとして今までどおり残る(既定値)。
   `primaryOf(registry, id)` は上記5箇所の三項演算子を置き換える**唯一の**実装になる —
   レジストリの中から `kind: 'star'` の天体を探して返す(0個なら `null`、複数個なら例外。
   **「主星がちょうど1つ、または0個」の星系のみサポートする** — 相互に公転しあう連星系は
   対象外とし、コメントとエラーメッセージで明記する。理由は §2-8)。
3. **`Ephemeris` のコンストラクタが `registry`・`originId`・`epochOffsetSec` を受け取る。**
   いずれも省略時は今までどおりの挙動になる(`SOLAR_SYSTEM` / `'earth'` /
   現行の `EPOCH_T_OFFSET`)。`ATTRACTOR_IDS`/`GRAVITY_SOURCE_IDS`(現在モジュールレベル定数、
   `ephemeris.ts:47,50`)はコンストラクタで1回だけ計算するインスタンスフィールドになる。
   `stateOf` の ECI 化は `helioStateOf(this.originId, t)` へ一般化する。
   **恒星の解決も一般化する:** `starId: AttractorId | null` をコンストラクタで1回だけ
   `primaryOf` と同じロジックで確定し、`sunDirAt`/`lagrangeAt` はこれを読む
   (`starId === null` のとき `sunDirAt` は影・輻射圧の計算がそもそも無意味になる旨を
   コメントし、呼び出し側が影響を無視できる無害なフォールバック方向を返す)。
   **`EPOCH_T_OFFSET` を引数に含めるのは、これが「t=0 で地球の真黄経が π になる」ように
   逆算された太陽系固有の値だから** — 別のレジストリでは意味を持たない。
4. **`Attractor` に `readonly isStar: boolean` を追加し、`dynamics.ts:120` の
   `attractor.id === 'sun'` を置き換える。** `totalAccel` は輻射源を1体だけ選ぶのをやめ、
   **`isStar` な天体すべてについて SRP を加算する**形にする — 恒星0個なら寄与0、1個なら
   今日と同一の結果になり、「恒星はちょうど1つ」という前提が `dynamics.ts` から消える。
   これにより、この関数の直前にある「天体の同定は Attractor が自分で持つ degree2 に
   委ねるので、ここに固有名の分岐は現れない」というコメントが初めて実態と一致する。
   `GameEntity` 側は `readonly isStar = false;`(小惑星が主星になることはない)。
5. **`ReferenceFrame.center`/`rotatingWith` の型を開き、`physics/frame.ts` から
   `FRAMES`/`INERTIAL_FRAME`/`rotatingFrameCenterOf` を削除して `Ephemeris` インスタンスへ移す。**
   これは単なる置き場所の変更ではない — `frame.ts` は自身の先頭コメントで「Ephemeris を
   import しない」と明言しているにも関わらず、`FRAMES` を組み立てるためだけに
   `SOLAR_SYSTEM`/`bodyDef` を直接読んでいる(`frame.ts:15,40-51`。登録済み太陽系という
   1つのグローバルな存在を前提にした、frame.ts 自身の設計原則違反)。「どの座標系が選べるか」は
   「今どのレジストリが使われているか」という `Ephemeris` の実行時状態そのものなので、
   `Ephemeris` が持つのが正しい。`Ephemeris` はコンストラクタで
   `this.inertialFrame = { center: originId, rotatingWith: null }` をまず1つ作り、
   `this.frames: readonly ReferenceFrame[]` をこれを再利用しながら組み立てる
   (`inertialFrame` と `frames` の該当要素が同一参照になるようにする — 後述の参照同一性契約)。
   `frame.ts` に残るのは型定義と点・方向・状態の変換関数だけになる。
6. **`frameTransformAt(frame, t, attractors)` に、その瞬間の `Attractor` 一覧を引数として
   追加し、回転の解決を2経路に分ける。**
   - `center`/`rotatingWith` が**現在のレジストリに登録されている** id(`id in this.registry`)
     のとき: 従来どおり `orbitFrameRotationAt`(解析的・滑らかな回転)。**挙動もコンパイル結果も
     変えない**(既定レジストリでの月/地球回転系など既存の座標系は一切変わらない)。
     「登録されているかどうか」は型では判定できない(id が `string` に開いているため)ので
     実行時の `in` 判定になる。
   - 登録されていない id(= 生存中の `GameEntity`)のとき: `attractors` から一致する
     `Attractor` を探し、その `state` と `center` 側の `state` の相対位置・相対速度から
     その瞬間の(骨組みの)基底を組む — x̂ = 中心→対象の方向、ẑ = 相対角運動量方向
     (`kinematic-state.ts` の `orbitAxes` が状態ベクトル単体から軌道基底を作るのと同じ考え方を
     相対状態に適用する)。これは解析的な長期基底の近似ではなく、**そもそも保存された
     解析軌道が存在しない自由な多体系にとって唯一妥当なモデル**であることをコメントに明記する。
7. **登録済みでない(= 生存中の重力天体の)`ReferenceFrame` は、`Ephemeris` が持つ
   キャッシュ `Map<AttractorId, ReferenceFrame>` から引く(`frameFor(id)`)。** 一度作った
   参照を使い回す(見つからなければ `{center: id, rotatingWith: null}` を新規に作って
   キャッシュへ登録する — 小惑星を回転系の中心にすることはあっても、小惑星自身の自転に
   座標系を合わせて回すことはしないので `rotatingWith` の変種は作らない)。
   `this.frames` と同じ「値は必ず安定した参照を使う」契約をこのキャッシュにも適用する —
   `render/sampled-line.ts` の `frame === lastFrame` というキャッシュ判定がこの契約に乗っている。
8. **呼び出し側(`OverviewCamera.update`/`PlanPath.update`・`toDisplay`)へ
   `attractors: readonly Attractor[]` を引数で通す。** `Game`/`PlanEditor` が、`Game.sync` が
   既に1フレーム1回求めている共通値(§2-12)を両方へ配る。
9. **GUI 側は、`Ephemeris` が実際に持つレジストリ・重力天体から動的に組み立てる。**
   ただし **§0.5 の不変条件6のとおり、絞り込みの「判断」はそのまま述語として残す** —
   既定レジストリでの選択肢の中身が1項目も変わらないことを受入条件にする。詳細は Phase 6。

**このレジストリ一般化がサポートしないもの(意図的な境界):**

- **恒星が2つ以上、相互に公転しあう連星系。** `primaryOf`/`starId` は「主星0または1つ」を
  前提にする。相互に比較可能な質量が複雑な軌道を描く状況は、そもそも解析的なケプラー軌道では
  表現できない(§2-8) — `Asteroid` の数値積分の役目であり、レジストリの問題ではない。
- **衛星の衛星のような、3階層を超える公転階層。** `CelestialBodyDef` の
  `kind: 'star' | 'planet' | 'satellite'` という3分類自体は変えない。
- **地球の大気圏熱管理・機体初期配置・エネミー生成式(`atmosphere.ts`/`thermal.ts`/
  `player.ts` の `makeInitialState`/`stages/spawner/enemy-generator.ts`)を天体非依存に
  一般化すること。** これらは「このゲームで大気を持つのは地球だけ」という既存の意図的な
  簡略化(CLAUDE.md 既述)であり、レジストリ・GUI の柔軟化とは別の、桁違いに大きい作業になる。
  今回はレジストリに地球以外の天体しか無いステージでもクラッシュしないこと(該当機能を
  静かに使わない)までを保証し、それらの物理モデル自体を一般化はしない。
- **静止軌道高度・太陽同期傾斜角のプリセット、基地配置を月に限定するルール**
  (`ship-placer-panel.ts`/`placement-validation.ts`)。前者は天体の自転周期という現状の
  スキーマに無いデータを要求し、後者はゲームデザイン上の判断。どちらも既に「その天体が
  無ければ何も出さない」安全な形になっているので変更しない。
- **`asteroid-belt.ts`/`asteroid-field.ts` の点群を任意のレジストリへ一般化すること。**
  これは第2次計画 E-11 の担当範囲(分布定義のデータ化)であり、本書は
  `positionOf('sun', t)` を `starId` 経由に直す最小限にとどめる。

### 2-5. `Attractor` 一覧は `Simulator`/`Predictor` が一元的に組み、`GameEntity` は受け取るだけ

現状 `GameEntity.stepActual(dt, ephemeris)` は各エンティティが自分で
`ephemeris.gravityAttractorsAt(this.state.t + dt/2)` を呼んでいる(`Simulator.substep()` は
7つの配列それぞれに `stepActual(dt, this.ephemeris)` を呼ぶだけで、`Attractor` 配列そのものは
組み立てていない)。これは重力源が解析天体だけだった間は問題なかったが、**小惑星どうしが
相互に重力を及ぼすには、同じ substep 内の全エンティティが同じ瞬間の1つの `Attractor` 一覧を
参照する必要がある。** ある小惑星が別の小惑星より先に積分されて位置が動いた後、その動いた後の
位置を「今この瞬間の重力源」として次の小惑星が読んでしまうと、本来対称であるべき相互作用に
処理順依存の誤差が入る(性能の問題ではなく**正しさ**の問題)。

そこで `GameEntity.stepActual` の引数を `ephemeris: Ephemeris` から
`attractors: readonly Attractor[]` へ変える(`stepPredicted` は元々この形をしているので、
2つのメソッドのシグネチャが揃う副産物もある)。`Simulator.substep()` が **substep の
先頭で1回だけ** `Attractor` 一覧を組み、その1つの配列をこの substep 内の全エンティティへ渡す。

集める処理は「同じ瞬間の1つの配列を全エンティティで使い回さないと相互作用が処理順に依存する」
という具体的な理由を持つ意味のある操作なので、関数として残す。名前は「どう集めたか」ではなく
「何を集めているか」で呼ぶ(`/refactor-fixed` §6):

```ts
// game/simulation/gravity-attractors.ts (新規)
// このステップぶんの重力源一覧 = 解析天体(Ephemeris の重力窓) + 重力を持つ生存中の GameEntity。
// 呼び出し側(Simulator/Predictor/PlanArc)が「いつの瞬間か」を決めて1回だけ呼び、同じ配列を
// このステップの全エンティティに使い回す — 重力天体どうしの相互作用を処理順に依存させないため。
// Ephemeris 側の配列はリングキャッシュの共有参照なので、必ず新しい配列へ展開して返す(破壊しない)。
export function gravityAttractorsAt(
  ephemeris: Ephemeris, entities: EntityManager, t: number,
): readonly Attractor[] {
  const bodies = ephemeris.gravityAttractorsAt(t);
  const dynamic = entities.attractors();
  return dynamic.length === 0 ? bodies : [...bodies, ...dynamic];
}
```

**合流先が `gravityAttractorsAt`(重力窓)であって `attractorsAt`(全天体窓)ではないことが
重要**(§0.5 の不変条件2)。小惑星が0体のときは `Ephemeris` の配列をそのまま返すので、
リングキャッシュの参照同一性も既存の挙動も一切変わらない。

`Simulator.substep()` の7本の別ループ(`stepActual` を呼ぶ部分だけ)は、これを機に
`entities.all()` を使った1本のループへまとめる。7回とも呼んでいる内容に型ごとの違いが
無いための単純化であり、目的そのものではない。**`stepAttitudes()` は型ごとに `alive` 判定の
有無が異なる本物の分岐を持つので、こちらは統合しない。**

新しく `entities.asteroids: Asteroid[]` を `EntityManager` に追加し、`otherEntities()`/`all()`/
`cleanup()`/`sync()` へ他の配列(`debris`/`ammos` と同じ扱い、`addAsteroid` で上限付き追加)と
同列に組み込む。これだけで `CollisionPhysics.resolve()` にも自動的に参加する(§2-7)。

`Predictor` 側は `update()` の再同期パスと `advanceBudget()` の1ステップごとのパスの
両方で同じ関数を通す。ただし §2-6 の近似により、後者は先端時刻ごとに `entities.attractors()` を
呼び直す必要はなく、**`update()` の先頭で1回だけ求めて `advanceBudget` へ引数で渡す。**

### 2-6. `Predictor` における重力天体どうしの相互作用は「現在の実状態で静止」とみなす近似にする

`Predictor` は個体ごとに非同期(ラウンドロビンの予算制)で未来へ伸びるので、複数の小惑星の
予測列が互いに「今どの時刻まで伸びているか」を揃える保証がない。真に相互無矛盾な予測を
組もうとすると予算配分と循環依存が生じ、表示補助の予測に見合わない複雑さになる。

そこで **`Asteroid.predictsFuture = false` にする**(小惑星自身は未来ゴーストを持たない —
弾・デブリと同じ扱い)。これにより「小惑星どうしの相互予測」という問題自体が消える。
一方、艦や敵が小惑星の近くを飛ぶ場合、その艦の予測軌道は小惑星の重力で曲がって見えるべき
なので、`Predictor` が組む重力源一覧には小惑星の**現在の実状態**(毎フレーム1回評価)を含める。
小惑星は艦の予測ホライズン(最大でも `DISPLAY_DURATION_MAX` = 1年)の間、実質的に動かないと
みなす近似であり、典型的な小惑星の公転周期はそれよりずっと長いので実用上妥当である。
この近似は `game/simulation/` 側(`predictor.ts` または `gravity-attractors.ts`)の
コメントに明記する — `physics/` には書かない。

### 2-7. 小惑星との衝突は既存の `CollisionPhysics` にそのまま乗せ、`mu` によって
    衝突の扱いを分岐させる新しいコードを書かない

`Asteroid` に `radius > 0` と `collides = true` を設定すれば、艦・弾・デブリとの接触は
既存の剛体接触(反発・ダメージ)がそのまま扱う — これは今日の `Enemy`/`Base`/`Ammo`
(重力を持たないが衝突はする物体)と全く同じ扱いであり、追加の分岐は一切要らない。

一方 `EntityManager.cleanup()` が `checkLoss` へ渡す配列(= `hitCelestialBody` が
「表面に沈み込んだので再突入死する」を判定する対象)は、**`Simulator` が
`ephemeris.attractorsAt(simTime)` から組んだ解析天体のみのまま**にし、小惑星を合流させない。
理由は2つ: (1) 同じ接触に対して剛体接触(跳ね返り)と再突入死(消滅)が二重に発生する
余地を作らないため、(2) `feature_todo.md`「衝突判定の統一化」で接触をすべて質量と相対速度から
求まる力積1つに統合することが既に構想されており、**今回 `mu` の有無で衝突の扱いを分岐する
コードを新たに書くと、その統合の妨げになる可能性がある。** 今回はどちらの統合の形にも
影響しない最小の選択を取る。

艦が小惑星に飛び込んだ結果どうなるかは、剛体接触のダメージ量だけで決まる — 今日の
艦-敵艦衝突と同じ扱いであり、一貫している。

### 2-8. 「自由な星系」は相互重力(Asteroid)とレジストリの一般化という独立した2つの機能で実演する

「太陽が存在しない3連星系」のような「自由な星系」は、実は物理的性格の異なる2つの状況を
指しうる。混同すると設計を誤るので、明確に分けて考える。

1. **質量が比較可能な複数天体が相互に複雑な(カオス的な)軌道を描く状況。** 3体以上の
   comparable mass が互いに引き合う一般の多体問題は閉じた解析解を持たない —
   `physics/satellite-orbit.ts` のような「支配的な主星のまわりの二体 + 摂動項」という
   解析モデルは原理的に適用できない。これは**数値積分でしか表現できない**。
2. **現実の太陽系とは異なる天体の集合・階層・原点で進行するステージ。** 恒星が1つも無い系、
   木星が原点の系、架空の天体だけで構成された系など。こちらは各天体の運動が(その系の中では)
   階層的であれば、既存の解析的な天体暦モデルでそのまま表現できる — 必要なのは**どの天体を
   レジストリに載せるか、どれを原点にするかを差し替えられること**であり、数値積分は要らない。

**(1) は目標1の小惑星機構(`Asteroid`、§2-1・2-5・2-6、Phase 3/4)がそのまま担う。**
`Asteroid` どうしの相互重力は数値積分で正しく解かれる(Phase 4 のテストで二体周期・
全運動量保存を検証する)ので、太陽系から十分離れた場所に質量が比較可能な複数の `Asteroid` を
置けば、それがそのまま閉じた解を持たない自由な多体系のデモになる。太陽や地球は ECI 座標系の
中にデータとしては存在し続けるが、ゲームプレイ上・表示上「そこには存在しない」のと
区別がつかない。

**(2) は §2-4 で一般化した `Ephemeris` のレジストリ注入・原点一般化・主星解決が担う。**
`Ephemeris` に現実とは異なるレジストリ(あるいは同じレジストリで異なる原点)を渡したステージを
1つ用意し、GUI(天体名表示・座標系選択・艦艇配置の基準天体選択・カメラの既定フォーカス)が
そのレジストリの実際の中身に追従することを実演する(Phase 7)。

**(1)と(2)は互いの代用にならない。** (1)を(2)の代わりに使うと、`SOLAR_SYSTEM`/`Ephemeris`/GUI 側の
「地球・太陽が常に存在する」という前提そのものは温存されたままになり、木星周回ステージや
地球の無い系を作りたいという具体的な要求に応えられない。逆に(2)を(1)の代わりに使うことは
できない — 解析的な天体暦は原理的にカオス的な多体系を表現できないため。両方を実装して初めて、
目標2「自由な星系」の物理的な意味が満たされる。

### 2-9. `game/celestial/` の見た目クラス群の改名は見送る

素案は「`CelestialBody` 系を `CelestialEntity` 系へ寄せるか、統合と同じ変更セットで判断する」と
していた。これは `Ephemeris` の解析天体を `GameEntity` のような「1個のライブオブジェクト」に
作り替えることを前提にした議論だが、**その前提は本書では採用しない。**

`GameEntity.state` は「今この瞬間の1つの値」で済むのに対し、`Ephemeris` の天体は
**1フレームの中で複数の異なる時刻に問い合わせられる**(`simTime` での重力計算、`displayTime` での
未来ゴースト表示、`Predictor` が各エンティティの予測先端ごとに違う時刻で問い合わせる、
`plan-arc` の積分ステップ時刻…)。実際 main 側は、この「同じ時刻が短時間に何度も来る」性質を
逆手にとって4スロットのリングキャッシュを入れている。これは `GameEntity.displayState(t)` が
既に持っている「任意時刻を引ける」という発想と同種の要求であり、単一の get/set フィールドには
収まらない。したがって `Attractor` は今までどおり「ある瞬間の値」として両者が共有する**形**に
とどめ、`Ephemeris` 自体を状態を持つ `GameEntity` 的なクラスへ作り替えることはしない。

改名が意味を持つ前提が今回発生しないため、`game/celestial/` の各クラス名は変更しない。

### 2-10. 計画軌道(`plan/plan-arc.ts`)は小惑星の重力を考慮しない(既知の制約として残す)

マニューバ計画の予測線(`PlanArc`)は独自に `ephemeris.gravityAttractorsAt(t)` を呼んで
積分している。ここに `entities.attractors()` を合流させて**積分**に反映するのは技術的には
可能だが、「マニューバ計画中に小惑星帯を飛ぶ」という具体的な使用状況が現時点でどのステージにも
無い。**Step3 では対応しない既知の制約とする。**

ただし **§2-11 の位置依存の絞り込みには `PlanArc` も必ず通す** — 3経路(`stepActual`/
`stepPredicted`/`PlanArc.update`)が別々の重力源集合を使うと、計画線・予測線が実際の軌道と
ずれる(しかも「予測が当たらない」という形でしか現れないので発見が遅れる)。
「小惑星を合流させない」ことと「同じ絞り込み関数を通す」ことは別の話なので混同しないこと。

**Phase 6 で `PlanPath` へその瞬間の `Attractor` 一覧を引数として通すようになるが、これは
`toDisplay` が使う座標系(`ReferenceFrame`)の解決専用であり、`PlanArc.update` の積分とは
別の呼び出しである。** 表示座標系が小惑星を基準に選べるようになったからといって、計画軌道の
積分自体が小惑星の重力を考慮するようにはならない。小惑星の近くで軌道計画を編集する機能が
要求された時点で、この制約自体を再検討する(`DEVELOP/SPEC.md` §16 へ記録)。

### 2-11. 重力窓の第3段 — 位置依存の絞り込みを入れ、空間インデックスは実測してから作る

**この節は、素案の「空間ハッシュによる計算量削減」と、main 側第2次計画 EP0
(重力窓の位置依存化)を1つの機構に統合したものである。** 両者は同じ問題
(「今この場所で効かない重力源を舐めない」)を別の入口から述べており、2つの機構を
並立させると `/refactor-fixed` の重複実装の禁止に触れる。

第2次計画 F-10 は「μ が判明している全天体を重力源にする」として `gravitySource` を
5体 → 71体へ増やす予定で、EP0 はそのために `CelestialBodyDef` へ静的な `influenceRadius` を
持たせ、`relevantAttractors(r, attractors)` で距離比較による早期棄却を行う設計を立てている。

**本書はこの機構を採るが、静的な `influenceRadius` は持たせない。判定にはその天体の
実際の寄与そのものを使う:**

```ts
// physics/attractor.ts
// 位置 r において寄与が negligibleAccel 以上になる天体だけを返す。候補は呼び出し側が渡す。
// しきい値そのものはゲーム側の判断なので引数で受け取る(hitCelestialBody の margin と同じ形)。
export function relevantAttractors(
  r: Vec3, attractors: readonly Attractor[], negligibleAccel: number,
): readonly Attractor[]
```

判定は `|attractorAccel(r, attractor)| >= negligibleAccel`。静的半径の見積りを採らない理由:

- **見積りを間違える余地が無い。** 判定式が「無視しようとしている量そのもの」なので、
  保守的かどうかを別途論証する必要がない。静的半径は近似の近似であり、86体ぶんの見積り値を
  人手で維持する必要も生じる(第2次計画の規模ではこれ自体がコストになる)。
- **`GameEntity` にも無改造でそのまま効く。** 小惑星は `mu` を持つだけで `CelestialBodyDef` を
  持たない — 静的フィールド方式ではここに別経路が要る。
- **ECI 原点補正項を落とさない。** `attractorAccel` は `μ[(r_b−r)/|r_b−r|³ − r_b/|r_b|³]` の
  潮汐差分であり、第2項(ECI 原点自身がその天体へ自由落下していることの補正)を含む。
  距離だけの判定はこの項を見落とす。
- **コストは下がる。** 今日 `attractorAccel` は RK4 の4ステージ × 全エンティティで評価される。
  絞り込みを **substep ごと・RK4 の外側で1回**行えば、評価回数は 4N → N + 4·(残った本数) になる。
  これは第2次計画 E-13 が「変えるのは誰がその配列を組むかだけ、物理には手を入れない」と
  書いたのと同じ構造で、`stepDynamics` が既に配列を引数で受け取っているから成立する。

しきい値 `GRAVITY_NEGLIGIBLE_ACCEL` は**性能とのトレードオフを含む近似の値**であり物理法則
そのものではないので、`physics/` には置かず `game/const.ts` に持って引数で渡す
(既存の `hitCelestialBody` の `margin` と全く同じ形)。値は第2次計画 E-13 の判断
(SRP ~7e-8 m/s² よりさらに2桁小さい **1e-10 m/s²**。この大きさなら天体が窓に出入りする瞬間の
加速度の不連続が RK4 の打ち切り誤差に埋もれる)をそのまま採る。**不連続を消すための
フェードイン係数は掛けない** — 係数を掛けた加速度は物理的に間違った値であり、
「小さすぎて見えない不連続」を「常に少しだけ間違った重力」と引き換えにするのは割に合わない。

素案が触れている「M・R を決め打ちの定数でなく動的にできないか(上位N個まで、最も重い
Attractor の何分の一まで)」という論点は**採らない。** 相対しきい値は、遠方の1体が去った瞬間に
他の全天体の採否が変わるという非局所な振る舞いを生み、substep 境界での不連続がしきい値で
抑えられなくなる。絶対しきい値なら1天体の採否は他天体と独立に決まる。

**空間インデックス(空間ハッシュ)は、上記の絞り込みが入った状態で実測してから判断する。**
`relevantAttractors` 自体は候補数 N に対して O(N) なので、候補が数千体の小惑星になったときだけ
問題になる。そのとき初めて、`sqrt(μ/negligibleAccel)` が大きい天体を「常に含める」側へ、
小さい天体をセルサイズ R の一様グリッドへ登録し、27近傍だけを候補にする(素案の設計そのもの)。
空間分割の**幾何**(グリッドへの登録・27近傍の列挙)は `physics/spatial-grid.ts` に汎用的な
純関数として置き、しきい値とセルサイズ(`game/const.ts` の定数)は `game/simulation/` 側が
持って引数として渡す。**判断順序は Phase 8 冒頭の実測 → 悪化があれば実装、なければ打ち切り。**

### 2-12. 表示側の窓(`attractorsAt`)へ小惑星を合流させる範囲

`Ephemeris.attractorsAt(t)`(全天体窓)を読むのは、遮蔽判定(`isOccluded`)・表面到達判定
(`hitCelestialBody`)・中心天体解決(`strongestAttractor`)・積分刻み(`localOrbitPeriod`)・
クリエイティブモードの基準天体解決である。**小惑星をここへ一律に合流させることはしない**が、
**一律に排除もしない** — 用途ごとに答えが違うため。

- **中心天体解決(`strongestAttractor`)には合流させる。** 合流させないと、質量の比較可能な
  小惑星群を周回する艦の HUD が「地球中心の軌道要素」を表示することになり、目標5(a)のデモが
  そもそも読めない。`Game.sync` は既に1フレーム1回 `attractors` という共通値を求めて各 sync へ
  配っている(`DEVELOP/CALLSTACK.md` の sync 節)ので、**その1つの値を合流済みのものに
  差し替えるだけ**で表示側は一通り追従する。遮蔽判定が小惑星を遮蔽体として扱うようになるのも
  同時に得られる(小惑星は `radius` を持つので追加実装は要らない)。
- **表面到達判定(`EntityManager.cleanup` → `checkLoss`)には合流させない**(§2-7)。
  こちらは `Simulator` が別途 `ephemeris.attractorsAt(simTime)` から組んだ解析天体のみの
  配列を渡し続ける。

合流させる/させないの境目は「接触の帰結を決める判定か否か」。この2種類が同じ配列を読んでいる
現状は偶然の一致であり、`Game.sync` の共通値と `Simulator.advance` の `cleanup` 引数は元々
別の呼び出しなので、分けるのに新しい機構は要らない。

### 2-13. `Asteroid`(積分される小天体)と既存の小惑星帯点群を呼び分ける

main は `game/celestial/asteroid-belt.ts`(seed 固定の要素生成、純粋・THREE 非依存)と
`asteroid-field.ts`(`InstancedMesh` 描画、5600点、マップビュー中のみ更新)を追加している。
これらは**表示専用**で、`AttractorId` を持たず、重力・ピック・フォーカスの対象にならない
(`asteroid-belt.ts` 先頭コメントに明記)。本書が追加する `Asteroid` は積分される個別の
`GameEntity` であり、両者は別物である。

**名前は `Asteroid`(実体)/ `AsteroidField`・`asteroid-belt`(統計的な点群)のまま分ける。**
どちらも現実には小惑星なので語を奪い合わせる必要はないが、読み手が「`AsteroidField` は
`Asteroid` の集まりだ」と誤読しうるので、**両モジュールの先頭コメントに相互の区別を1行ずつ
書く。** 将来「点群の1点に接近したら実体化する」LOD が要求されたら、そのとき初めて両者の
関係を作る(現時点で先回りしない。§6 に記録)。

---

## 3. 完成後のモジュール構成

### 変更(§2-1・2-2 — id/radius/collides/mu の整理、Asteroid 追加前の前提)

| ファイル | 変更内容 |
|---|---|
| `src/game/game-entity/game-entity.ts` | `id: string`(自動採番)/`radius = 0`(旧 `collideRadius` を半径の意味に純化)/`collides = false`(剛体接触への参加可否)/`mu = 0`/`degree2: null = null` を追加。`_memoCenterId` の型を `string \| null` へ |
| `src/game/game-entity/entity-id.ts`(新規) | `Ammo`/`Base` が個別に持っていた「プレフィックス付き採番 + 復元 id によるカウンタ追い越し」を1つの共有ヘルパへ統合 |
| `src/game/game-entity/ship.ts` | `radius`(被弾判定半径、`:17`)を `hitRadius` へ改称 |
| `src/game/game-entity/enemy.ts` | `collideRadius` 代入(`:97`)を `radius` + `collides = true` へ、被弾判定半径の代入(`:103`)を `hitRadius` へ。`id?: string`(`:57`)を必須の `id`(基底の自動採番)に統一、`name` は表示専用に純化 |
| `src/game/game-entity/ammo.ts` / `base.ts` | 独自のカウンタ実装を `entity-id.ts` 経由に置き換え |
| `src/game/player/player.ts` | `collideRadius` 代入を `radius` + `collides = true` へ。既存の `id`/`displayName` 分離はそのまま(基底の仕組みに載せ替えるだけ) |
| `src/game/game-entity/debris-piece.ts`・`player/belt-physics.ts` | `collideRadius` 代入を `radius` + `collides` へ。`fragment` は `collides = false` のまま(半径は持ってよい) |
| `src/game/simulation/collision.ts`・`simulation/hit.ts` | 参加者の絞り込みを `collideRadius !== undefined` → `collides` へ。半径参照は `radius` へ。被弾判定側の `target.radius` は `target.hitRadius` へ |
| `src/game/game.ts`・`map-picker.ts`・`nav-target.ts` | `enemies.find((e) => e.name === …)` 形の検索6箇所を `EntityManager.findEnemy(id)` 経由へ。`MapPickable` 組み立ての `{id: enemy.name, …}` も `{id: enemy.id, …}` へ |
| `src/game/simulation/entity-manager.ts` | `findEnemy(id)` を追加(`findPlayer` と同じ形) |

### 新規(小惑星本体と重力窓)

| ファイル | 責務 |
|---|---|
| `src/game/game-entity/asteroid.ts` | `Asteroid extends GameEntity`。質量1つから `mass`/`mu` を導き、`radius`/`collides = true`・`predictsFuture = false`・`bcInv = 0`・`srpCoeff = 0` を設定 |
| `src/game/simulation/gravity-attractors.ts` | `gravityAttractorsAt(ephemeris, entities, t)`: このステップの重力源一覧 = `Ephemeris.gravityAttractorsAt` + 重力を持つ生存中 `GameEntity`(§2-5) |
| `src/physics/spatial-grid.ts` | 位置を持つ任意の要素に対する一様グリッドの構築・27近傍列挙(汎用・純関数、Phase 8。実測で必要と判明した場合のみ) |
| `tests/physics/n-body.test.ts` | 相互重力(二体周期・全運動量保存)と `relevantAttractors` の非破壊性のテスト(Phase 4) |
| `tests/physics/spatial-grid.test.ts` | グリッド近傍列挙が全数探索と一致することのテスト(Phase 8) |

### 変更(天体レジストリ・ECI原点・主星解決の一般化 — §2-3・2-4、Phase 5)

| ファイル | 変更内容 |
|---|---|
| `src/physics/attractor.ts` | `AttractorId = string` へ。`StarId`/`PlanetId`/`SatelliteId` 削除、`OrbitingId = AttractorId` の別名に。`Attractor` に `isStar: boolean` を追加。`relevantAttractors` を追加(Phase 4 で先に入る) |
| `src/physics/solar-system.ts` | `CelestialRegistry` 型を新設し `SOLAR_SYSTEM` を `satisfies CelestialRegistry` に。`SolarSystemId = keyof typeof SOLAR_SYSTEM`(および恒星を除いた版)を export。`bodyDef(registry, id)`/`primaryOf(registry, id)` をレジストリ引数を取る形へ(`KindOf`/`BodyDefOf` の型レベル絞り込みは削除)。`GRAVITATIONAL_CONSTANT` を追加 |
| `src/physics/frame.ts` | `ReferenceFrame.center`/`rotatingWith` の型を開く。`FRAMES`/`INERTIAL_FRAME`/`rotatingFrameCenterOf` を削除(`Ephemeris` へ移す)。`solar-system.ts` への import が消える |
| `src/physics/ephemeris.ts` | コンストラクタに `registry`・`originId`・`epochOffsetSec` を追加(いずれも既定値付き)。`this.ids`/`this.gravityIds`/`this.starId`/`this.inertialFrame`/`this.frames`/`frameFor(id)`(動的キャッシュ)を持つインスタンスに。`stateOf` の ECI 化・`sunDirAt`・`lagrangeAt` が `this.originId`/`this.starId` を読むよう一般化。`frameTransformAt` に `attractors` 引数を追加し、登録済み/未登録で解決経路を分岐。返す `Attractor` に `isStar` を載せる |
| `src/physics/dynamics.ts` | `totalAccel` の `attractor.id === 'sun'`(`:120`)を `attractor.isStar` へ。輻射源を1体選ぶのをやめ、`isStar` な全天体について SRP を加算する |
| `src/physics/halo.ts` | `def.kind === 'planet' ? 'sun' : def.planet`(`:60`)を `primaryOf` 呼び出しへ |
| `src/game/game-entity/game-entity.ts` | `readonly isStar = false;` を追加(§2-1 と同じ理由・同じ形) |

### 変更(GUI をレジストリ・重力天体へ適応させる — Phase 6)

**既定レジストリでの選択肢の中身を1項目も変えないこと**(§0.5 不変条件6)が全項目の受入条件。

| ファイル | 変更内容 |
|---|---|
| `src/game/hud/frame-labels.ts` | `ATTRACTOR_NAMES`(`CELESTIAL_BODIES` からの `Object.fromEntries` 導出)を `celestialBodyName(ephemeris, id)` 関数へ。`FRAME_ITEMS`(定数)を `frameItems(ephemeris)` 関数へ — **絞り込み述語(中心・回転基準がともに `gravitySource`)はそのまま維持**し、レジストリと生存中の重力天体から動的に組む。レジストリに無い id には表示名のフォールバックを持つ |
| `src/game/celestial/celestial-registry.ts` | `CELESTIAL_BODIES` は `Record<SolarSystemId, …>` のまま(§2-3 — **網羅性強制を維持**)。レジストリにあってここに無い id 向けの汎用フォールバックビューを返す関数を追加(`isStar` なら `SunBody` 相当、それ以外は単色球。半径はレジストリの `radius` から) |
| `src/game/celestial/sun-body.ts` | `readonly id = 'sun' as const` をコンストラクタ引数へ(`SphereBody` と同じ形)。`positionOf('sun', t)` を `positionOf(this.id, t)` へ |
| `src/game/celestial/environment-scene.ts` | `sunBody` を `SunBody \| null` へ(`:101` の `b.id === 'sun'` を `ephemeris.starId` 照合に)。`sync` の `setSunlit` 呼び出しに null ガード。`starId === null` のときは日照率計算を飛ばす。`EARTH_ATTRACTOR`(`:24`、`MU_EARTH`/`R_EARTH` 直埋め + 原点固定)を廃し、静止軌道リングはレジストリに `'earth'` が実在するときだけ `bodyDef`/`stateOf` から組む。参照軌道線の自動生成(`REFERENCE_LINE_IDS`)と衛星線のフォーカス連動(`:162` の `def.planet === 'earth'` 特例含む)は **main の実装をそのまま活かし**、`SOLAR_SYSTEM` 直読みを `ephemeris.registry` 経由へ変えるだけにする |
| `src/game/camera/overview-camera.ts` | 既定フォーカスの `'earth'` 決め打ち4箇所(`:45,67,137,150`)を `ephemeris.originId` へ。`minDist`(`:115`)の `this._focus in SOLAR_SYSTEM` もレジストリ経由へ |
| `src/game/camera/focus-markers.ts` | `Object.keys(SOLAR_SYSTEM)`(`:21`)と `LAGRANGE_LABEL_IDS`(`:23-26`)をレジストリ経由へ。**`lagrangeLabels` フラグによる絞り込みは維持。** 主星解決(`:34`)を `primaryOf` 呼び出しへ |
| `src/game/creative/ship-placer-panel.ts` | `ORBITING_IDS`(`:84`)をレジストリ経由へ(**`gravitySource` による絞り込みは維持**)。`LAGRANGE_SYSTEM_ITEMS` の主星解決(`:95`)を `primaryOf` 呼び出しへ。太陽同期プリセットの `bodyDef('earth').orbit.lRate`(`:139`)は `SOLAR_SYSTEM.earth` 直読みへ(太陽系固有の入力補助なので汎用 API を通さない)。`LAGRANGE_DEFAULT_AMPLITUDE_KM` は既に `Partial` + 比率フォールバック済みなので変更不要 |
| `src/game/creative/duplicate-form.ts` | 恒星が strongest のときのフォールバック先 `'earth'`(`:34`)を `ephemeris.originId` へ |
| `src/game/map-picker.ts` | `itemsFor('body')` のサブラベル分岐(`:293-297`)に汎用フォールバックを追加。ラグランジュ点 id のサフィックス解析(`moon-l*`/`earth-l*` 決め打ち)を `-l[1-5]` の一般形へ(木星・土星の L 点が今日すでに素通りしている欠落も同時に直る) |
| `src/game/celestial/asteroid-field.ts` | `positionOf('sun', t)`(`:54`)を `ephemeris.starId` 経由へ(恒星が無ければ点群を非表示)。分布定義のデータ化は第2次計画 E-11 の担当なので触らない |
| `src/game/save/snapshot-service.ts`・`save/legacy-save.ts` | `centerBodyId: 'earth'` のフォールバック(`:27`/`:56`)を `ephemeris.originId` へ |
| `src/game/plan/plan-editor.ts` | `center.id === 'earth'`(`:646`、パネル表記の切替)をレジストリ由来の判定へ(または表記自体を天体非依存にする) |
| `src/game/plan/plan-path.ts`・`src/game/camera/overview-camera.ts` | `frameTransformAt` へ渡す `attractors` 引数を中継(§2-4 の8点目) |
| `src/game/camera/overview-camera-panel.ts`・`src/game/plan/plan-display.ts` | `SegmentedControl<ReferenceFrame>` の項目を `frameItems(ephemeris)` から `setItems` で差し替え |
| `src/render/sampled-line.ts` | 変更なし(参照同一性キャッシュ `frame === lastFrame` はそのまま — 参照安定性を保つのは `Ephemeris` 側の責務) |

### 変更(配線・実演 — Phase 4・7)

| ファイル | 変更内容 |
|---|---|
| `src/game/simulation/entity-manager.ts` | `asteroids: Asteroid[]` 追加、`addAsteroid`、`otherEntities()`/`all()`/`cleanup()`/`sync()` へ組み込み、`attractors()` 追加 |
| `src/game/game-entity/game-entity.ts` | `stepActual(dt, attractors)` へシグネチャ変更(`ephemeris` を受け取らない)。`stepPredicted` と形が揃う |
| `src/game/simulation/simulator.ts` | `substep()` が `gravityAttractorsAt(...)` → `relevantAttractors(...)` を1回通し、7本の別ループを `entities.all()` の1ループへ統合 |
| `src/game/simulation/predictor.ts` | `update()` の先頭で1回だけ `entities.attractors()` を求め `advanceBudget` へ渡す。先端位置ごとに `relevantAttractors` を通す |
| `src/game/plan/plan-arc.ts` | 積分刻みごとの重力源に `relevantAttractors` を通す(小惑星は合流させない、§2-10) |
| `src/game/game.ts` | `Game.sync` の共通値 `attractors` を合流済みのものへ(§2-12)。コンストラクタで `Ephemeris` をステージ設定から構築(Phase 7) |
| `src/game/const.ts` | `GRAVITY_NEGLIGIBLE_ACCEL`、小惑星の質量/半径の試験値、空間グリッドのセルサイズ(Phase 8) |
| `src/game/stages/stage-debug.ts` | 相互重力の実演用に `Asteroid` を数体配置(Phase 4) |
| `src/game/stages/stage-dictionary.ts` | `StageClass` に任意の静的プロパティ `ephemerisConfig?`(下記)を追加し、`ephemerisConfigFor(launch)` を追加(Phase 7) |
| `src/game/stages/stage-debug-alt-system.ts`(新規) | 現実の太陽系とは異なる小さなレジストリ・原点で進行する、選択画面に出ないデバッグ専用ステージ(Phase 7) |

`ephemerisConfig` は `{ registry, originId, epochOffsetSec }` という**静的なデータ宣言**であり、
`/refactor-fixed` §6 が禁じている `*Ctx`(呼び出しごとに無関係な値を束ねる引数オブジェクト)
ではない。`Ephemeris` のコンストラクタ側は3つの明示的な引数として受け取る。

---

## 4. フェーズ別手順

### Phase 1 — 準備・計測

**1-1.** 着手前に `npm run typecheck` / `npm run test:physics` が green であることを確認する。

**1-2.** `npm run dev` を実機で起動し `?perf=1` を付け、ステージ00(無限サバイバル)で
時間加速を上げた状態の update フェーズ ms を記録する(ヘッドレスでは高負荷まで駆動できないため、
実機での実施が必須)。この値は Phase 4(位置依存の絞り込み)と Phase 8(空間インデックス)の
効果を測るときの「小惑星0体・絞り込み無しの基準値」として使う。**天体が27体に増えた後の
基準値はまだ誰も測っていないので、この計測は第2次計画にとっても価値がある。**

**検証:** 上記の記録のみ。コード変更なし。

---

### Phase 2 — `id`/`radius`/`collides`/`mu` の整理(前提のリファクタリング)

**このフェーズは小惑星そのものを一切導入しない。** `GameEntity` を「後から `Attractor` に
なれる形」へ均すだけの、既存クラスの整理。

**2-1.** `game/game-entity/entity-id.ts` を新設し、`Ammo`/`Base` が個別に持つ
「`${prefix}-${counter}` 形式で採番し、復元 id を渡されたらそれを採用しつつカウンタを
その番号より先へ進める」ロジックを1つの共有ヘルパへ統合する。

**2-2.** `game/game-entity/game-entity.ts` に `id: string`(明示指定が無ければ 2-1 のヘルパで
自動採番)/`radius = 0`/`collides = false`/`mu = 0`/`degree2: null = null` を追加し、
既存の `collideRadius` を `radius` + `collides` の2つへ分解する(§2-1)。

**2-3.** `Ship`(`game-entity/ship.ts:17`)の被弾判定半径フィールドを `radius` から
`hitRadius` へ改称する。コンストラクタ引数名も合わせて改称する。

**2-4.** `collideRadius` を代入している全箇所(`enemy.ts:97,103`・`base.ts`・`ammo.ts`・
`debris-piece.ts`・`belt-physics.ts`・`player.ts`)を `radius` + `collides` の代入に
書き換える。`enemy.ts:103`(被弾判定半径の代入)は `this.hitRadius = …` へ。
**`fragment` の破片は `collides = false` のまま**(半径は持ってよい — 今日 `collideRadius` を
渡していなかったのは「参加しない」の意味だった)。

**2-5.** `collideRadius` を参照している `simulation/collision.ts`・`simulation/hit.ts` を
書き換える: 参加者の絞り込みを `collides` へ、半径参照を `radius` へ。`hit.ts` の被弾判定側
(`target.radius`)は `target.hitRadius` へ。**`grep -rn "collideRadius" src` が 0 件になること。**

**2-6.** `Enemy` の `id?: string`(`enemy.ts:57`、セーブ復元専用)を、`GameEntity` の
自動採番される `id: string`(必須)に統一する。`name` は表示専用のまま残す。

**2-7.** `EntityManager` に `findEnemy(id)` を追加し、`game.ts:563`・`map-picker.ts:276,317,525,631`・
`nav-target.ts:148` の `e.name === …` 検索6箇所をこれ経由に書き換える。`map-picker.ts` が
`MapPickable` を組み立てている箇所も `{id: enemy.id, …}` に直す。

**検証:** `npm run typecheck` / `npm run test:physics`(すべて無改造で green のはず —
このフェーズは同じ意味を保ったままの改名・分解のみで、シミュレーションの挙動は一切
変えていない)。`npm run dev` で以下を確認する:

- 既存ステージ(0/1/2/00)で、敵の被弾・自機と敵の衝突・薬莢/デブリの衝突が今までどおり
  動くこと。特に**排莢直後の薬莢が弾かれないこと**(`radius`/`hitRadius` の取り違えが
  あるとここに出る)。
- 同名の敵を複数出すシナリオで、マップの右クリックメニュー・航法ターゲット設定が
  name の重複によらず正しく個別の敵を指すこと。

---

### Phase 3 — `Asteroid` クラスの追加(未配線)

**3-1.** `game/game-entity/asteroid.ts` を新設し `Asteroid extends GameEntity` を書く。
コンストラクタは**質量を1つだけ**受け取り、`mass` と `mu = GRAVITATIONAL_CONSTANT * mass` の
両方をそこから導く(§2-1)。`radius`(物理半径)・`collides = true`・`predictsFuture = false`・
`bcInv = 0`・`srpCoeff = 0`・`historyDuration`(軌道線を描きたいので `SHIP_HISTORY_DURATION`
程度)を設定する。試験用の質量・半径は `game/const.ts` に定数として置く。
メッシュは `/add-feature` の手順で既存の破片/デブリ系のビルダー(`render/ships.ts`)が
転用できないか確認してから、無ければ簡易な不定形岩ジオメトリを追加する。
**モジュール先頭コメントに、`celestial/asteroid-belt.ts` の表示専用点群との区別を1行書く**
(§2-13。あちら側にも同じ1行を足す)。

**3-2.** `EntityManager` に `asteroids: Asteroid[]` と `addAsteroid`、`otherEntities()`/
`all()`/`cleanup()`/`sync()` への組み込みを追加する(`debris`/`ammos` と同じパターン)。

**3-3.** `StageDebug` に、テスト用の `Asteroid` を数体、離れた位置に配置するコードを足す。
この時点では重力配線がまだ無いので、小惑星は「重力を及ぼさない浮遊物体」として見える。

**検証:** `npm run typecheck` / `npm run test:physics`(全て無改造で green のはず)。
`npm run dev` で `StageDebug` を開き、配置した `Asteroid` が描画されることを目視確認する。

---

### Phase 4 — 相互重力の配線・位置依存の絞り込み・物理的検証

**4-1.** `physics/attractor.ts` に `relevantAttractors(r, attractors, negligibleAccel)` を
実装する(§2-11)。しきい値は引数で受け取り、`physics/` 側は値を知らない。
`game/const.ts` に `GRAVITY_NEGLIGIBLE_ACCEL = 1e-10` を追加する。

**4-2.** `EntityManager.attractors()` を実装する(§2-1 のコード — 変換なしのフィルタのみ)。

**4-3.** `game/simulation/gravity-attractors.ts` を新設し `gravityAttractorsAt(ephemeris,
entities, t)` を実装する(§2-5 のコード)。**`Ephemeris` から受け取った配列を破壊しないこと**
(§0.5 不変条件3)。小惑星0体のときは受け取った配列をそのまま返す。

**4-4.** `GameEntity.stepActual` の引数を `(dt, ephemeris)` から
`(dt, attractors: readonly Attractor[])` に変える。メソッド本体から
`ephemeris.gravityAttractorsAt(...)` の呼び出しを削除し、引数をそのまま
`this.actualTrajectory.step(...)` へ渡す。**このメソッドの直前にあるコメントが
「重力源をどこから引くか」に言及していれば、事実に合わせて書き直す。**

**4-5.** `Simulator.substep()` を書き直す。7本の別ループを `entities.all()` の1本にまとめ、
重力源はこの1箇所で組む:

```ts
private substep(simTime: number, dt: number): number {
  const t = simTime + dt / 2;
  const all = gravityAttractorsAt(this.ephemeris, this.entities, t);
  for (const e of this.entities.all()) {
    e.stepActual(dt, relevantAttractors(e.state.r, all, C.GRAVITY_NEGLIGIBLE_ACCEL));
  }
  return simTime + dt;
}
```

`stepAttitudes()` は型ごとに `alive` 判定が異なる本物の分岐を持つので変更しない。

**4-6.** `Predictor.update()`/`advanceBudget()` を同じ形にする。`update()` の先頭で1回だけ
`entities.attractors()` を求め `advanceBudget` へ引数で渡し(§2-6 のとおり予測ステップごとに
呼び直さない)、先端位置ごとに `relevantAttractors` を通す。この近似
(重力天体は現在の実状態で静止とみなす)をコメントで明記する。

**4-7.** `PlanArc.update` の積分刻みごとの重力源にも `relevantAttractors` を通す
(§2-10 — 小惑星は合流させないが、絞り込み関数は3経路とも同じものを通す)。

**4-8.** `EntityManager.cleanup()` の呼び出し(`Simulator.advance` 内)は変更しない
(§2-7・§2-12 — `hitCelestialBody` の対象は解析天体のみのまま)。

**4-9.** `tests/physics/n-body.test.ts` を新設し `tests/physics/index.ts` へ登録する。

- **二体の相互周期:** 質量 `mu1 = mu2` の2点を共通重心(原点)を挟んで対称に距離 `d` だけ
  離して置き、それぞれに重心まわりの円軌道速度を互いに逆向きに与える。解析天体を一切含まない
  `attractors = [a1, a2]` のみで `stepDynamics` を1公転周期分(`T = 2π√(d³/(mu1+mu2))`)
  積分し、両者が出発位置へ戻ることを確認する。**これは既存の `keplerPeriod` を使わない
  独立した解析解による検算**であり、実装の誤りを検算式の誤りと取り違えないための最も重要なテスト。
  **この時点の `Attractor` にはまだ `isStar` が無い(Phase 5 で追加)**ので、リテラルには
  含めない。Phase 5 でここに `isStar: false` を足す必要があることを見込んでおくこと。
- **全運動量保存:** 上記の二体系、および質量がまちまちな3体系を一定時間積分し、
  `Σ mu_i · v_i` が保存されることを緩めの許容誤差で確認する(`mu = G·m` なので
  `Σ mu_i v_i = G·Σ m_i v_i` であり、G の値を知らなくても検証できる)。
- **`relevantAttractors` の非破壊性:** しきい値を 0 にすると全数と一致すること、
  現実的なしきい値でも「捨てた天体の寄与の総和がしきい値 × 天体数を超えない」こと。
  **さらに、3経路(`stepActual`/`stepPredicted`/`PlanArc`)が同じ位置・同じ候補集合に対して
  同じ集合を返すことを assert する**(第2次計画 E-13 が「性能ではなく正しさの話」と
  指摘した点)。
- **既存天体との共存:** 解析天体(地球)1つ + 小惑星1つを重力源に含めて艦を積分し、
  小惑星の質量をゼロに近づけた極限で、小惑星を含めない場合の積分結果に収束すること。
- **回帰:** 既存の `dynamics.test.ts` の「手書きの旧実装との一致(機械精度)」を含む
  全既存テストが無改造のまま通ること。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で Phase 3 の
`StageDebug` シナリオを開き、複数の `Asteroid` が互いに引き合って動く様子を目視確認する。
既存ステージ(0/1/2/00)を一通り触り、艦・敵の挙動が今までどおりであることを確認する。
**`?perf=1` で Phase 1 の基準値と比較し、絞り込みの導入で update フェーズが悪化していない
(むしろ改善しているはず — 27体を舐める回数が減る)ことを記録する。この数値は第2次計画 EP0 の
受入資料にもなる。**

---

### Phase 5 — 天体レジストリ・ECI原点・主星解決の一般化(物理コア)

**このフェーズはまだどのステージにもカスタムのレジストリ・原点を使わせない。** `Ephemeris` と
その周辺の型を「後からカスタムのレジストリ・原点を渡せる形」へ一般化するだけで、既存の
呼び出し元(`game.ts:126` の `new Ephemeris()`)は今までどおり引数無しで呼び、今までどおり
現実の太陽系・地球原点で動く。§2-3・§2-4 の設計方針に従う。

**5-1.** `physics/attractor.ts`: `AttractorId = string` にし、`StarId`/`PlanetId`/`SatelliteId` を
削除する。`OrbitingId = AttractorId` の別名として残す。`Attractor` に
`readonly isStar: boolean;` を追加する。

**5-2.** `physics/solar-system.ts`: `CelestialRegistry` 型を新設し、`SOLAR_SYSTEM` の
`satisfies` の対象をこれに変える(データ・27体の登録内容は一切変更しない)。
`SolarSystemId = keyof typeof SOLAR_SYSTEM` と、恒星を除いた版を export する。
`bodyDef(registry, id): CelestialBodyDef` / `primaryOf(registry, id): AttractorId | null` へ
シグネチャを変え、`primaryOf` の実装を「レジストリの中から `kind: 'star'` を1つ探して返す
(0個なら `null`、複数個なら例外)」に書き換える。`GRAVITATIONAL_CONSTANT` を追加する。

**5-3.** `physics/frame.ts` から `FRAMES`/`INERTIAL_FRAME`/`rotatingFrameCenterOf` を削除し、
`ReferenceFrame` の型を開く。`solar-system.ts` への import もここで消える。

**5-4.** `physics/ephemeris.ts` を書き換える(§2-4 の3・5・7点目):

```ts
export class Ephemeris {
  private readonly ids: readonly AttractorId[];
  private readonly gravityIds: readonly AttractorId[];
  readonly starId: AttractorId | null;
  readonly inertialFrame: ReferenceFrame;
  readonly frames: readonly ReferenceFrame[];
  private readonly dynamicFrames = new Map<AttractorId, ReferenceFrame>();

  constructor(
    private readonly registry: CelestialRegistry = SOLAR_SYSTEM,
    private readonly originId: AttractorId = 'earth',
    private readonly epochOffsetSec: number = SOLAR_SYSTEM_EPOCH_OFFSET,
    private phaseOffsets: Partial<Record<AttractorId, number>> = { moon: Math.random() * 2 * Math.PI },
  ) { … }

  frameFor(id: AttractorId): ReferenceFrame { /* frames から探し、無ければ dynamicFrames */ }
}
```

`ATTRACTOR_IDS`/`GRAVITY_SOURCE_IDS`(旧・モジュールレベル定数、`:47,50`)を `this.ids`/
`this.gravityIds` に、`bodyDef(id)` を `bodyDef(this.registry, id)` に、`stateOf` の
`helioStateOf('earth', t)`(`:223`)を `helioStateOf(this.originId, t)` に、`sunDirAt` の
`positionOf('sun', t)`(`:260`)を `this.starId` 経由に、`lagrangeAt` の三項演算子(`:249`)を
`primaryOf(this.registry, secondary)` に、それぞれ書き換える。`rotatingFrameCenterOf` は
private メソッドとしてこのファイルへ移す。**4系統のリングキャッシュはインスタンス
フィールドのままなので、レジストリごとに独立して正しく働く。**

**5-5.** `frameTransformAt` に `attractors: readonly Attractor[]` 引数を追加し、解決ロジックを
2経路に分ける(§2-4 の6点目)。

**5-6.** `physics/dynamics.ts` の `totalAccel`(`:120`)を書き換える: `attractor.id === 'sun'` を
`attractor.isStar` に。**輻射源を1体だけ選ぶループ外変数をやめ、`isStar` な天体ごとに
`srpAccel` を加算する**(恒星0個なら寄与0、1個なら今日と同一)。ローカル変数名 `sun` は
`radiant` 等の一般的な名前へ。

**5-7.** `Ephemeris.attractorsAt`/`gravityAttractorsAt` が返す各 `Attractor` に
`isStar: def.kind === 'star'` を追加する。

**5-8.** `game-entity/game-entity.ts` に `readonly isStar = false;` を追加する。

**5-9.** `physics/halo.ts:60` の三項演算子を `primaryOf` 呼び出しへ置き換える。

**5-10.** typecheck が指し示す全ての赤い箇所を機械的に直す。想定される内訳:
Phase 4 で追加した `n-body.test.ts` や既存の `attractor.test.ts` が組み立てる生の `Attractor`
リテラルへ `isStar: false` を足す、`bodyDef`/`primaryOf` の呼び出しにレジストリ引数を渡す、
`FRAMES`/`INERTIAL_FRAME` を import していた箇所を直す(実消費者である `frame-labels.ts` 等は
Phase 6 で書き換えるので、Phase 5 単独で typecheck を green にするには 6-1 を
このフェーズの変更セットへ前倒しで含めてよい。実装時にどちらが自然か判断する)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で既存ステージ
(0/1/2/00)を一通り触り、**27体の天体の見た目・軌道線・自転・環・照明・輻射圧・点群が
今までと一切変わっていないこと**を確認する(このフェーズはレジストリ・原点ともに既定値しか
使わないので、挙動は不変のはず)。

---

### Phase 6 — GUI をレジストリ・重力天体の両方へ適応させる

**Phase 4 と Phase 5 の両方に依存する。** このフェーズが終わるまでは、まだどのステージも
既定と異なるレジストリ・原点を使わない(Phase 7 で初めて使う)が、**GUI 側は「使われたら
正しく追従する」形になっている**ことをこのフェーズの中で確認する。

**§3 の表(GUI 節)の各行を実施する。** 全項目に共通する受入条件:

> **既定レジストリでのユーザーから見える選択肢・表示が1項目も変わらないこと。**
> 座標系選択は9項目のまま(5慣性系 + 4回転系)、フォーカスラベルは47個のまま
> (27天体 + 4天体 × L1〜L5)、艦艇配置の基準天体は4体のまま、基地配置は月のみのまま。

特に注意する点:

**6-1.** `frame-labels.ts` の `FRAME_ITEMS` を関数化する際、**絞り込み述語
(`center` と `rotatingWith` がともに `gravitySource`)をそのまま持ち越す。** これは
「重力積分の対象でない天体を中心に据えても、そこでの局所力学が成立していない」という
main 側の判断であり、一般化とは無関係に正しい。生存中の重力天体(`mu !== 0` の
`GameEntity`)は定義上この述語を満たすので、そのまま項目に加わる。

**6-2.** `celestial-registry.ts` の `CELESTIAL_BODIES` は **`Record<SolarSystemId, …>` のまま
残す**(§2-3・§0.5 不変条件1)。追加するのは「レジストリにあってこの表に無い id」向けの
フォールバックだけで、太陽系27体のエントリは1つも省略可能にしない。

**6-3.** `map-picker.ts` のラグランジュ点サフィックス解析の一般化
(`target.id.replace(/-l[1-5]$/, '')`)は、**今日すでに存在するのに素通りしていた欠落
(木星・土星の L 点)を同時に直す。**

**6-4.** `overview-camera-panel.ts`/`plan-display.ts` の `SegmentedControl<ReferenceFrame>` を
`setItems` で差し替える。**`camera-system.ts` の `PANEL_FOCUS_IDS` は main で既に削除済み
(フォーカスは天体ラベルのクリックとオブジェクト一覧からのみ選ぶ形に変わった)ので、
ここには何もしない** — CLAUDE.md にだけ古い記述が残っているので Phase 9 で直す。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で:

- 既存ステージ(0/1/2/00)で上記の受入条件(選択肢が1項目も変わらないこと)を目視確認する。
- Phase 3/4 の `StageDebug` 小惑星配置を開き、小惑星を回転系フォーカスの選択肢に選んで
  実際にその天体へカメラがロックされ、回転が止まって見えることを目視確認する。
- `celestialBodyName`/`frameItems`/`itemsFor('body')`/フォールバックビューの各経路に、
  単体テストまたはその場のデバッグ用コードでレジストリに無い id を最低1回は渡し、
  クラッシュしないことを確かめておく(Phase 7 で本番のカスタムステージを作ってから
  初めて欠陥に気づくと手戻りが大きいため)。

---

### Phase 7 — カスタムレジストリの実演と「自由な星系」の実演

**7-1.** `game/stages/stage-dictionary.ts` の `StageClass` へ、任意の静的プロパティ
`ephemerisConfig?: { registry, originId, epochOffsetSec }` を追加する。既存のステージは
いずれもこれを宣言しない(= 既定のレジストリ・地球原点のまま)。
`ephemerisConfigFor(launch)` を追加し、`launch.mode` に応じて対応する `StageClass` の
同名の静的プロパティを見て、無ければ既定値を返す。

**7-2.** `game/game.ts` のコンストラクタで、`this._ephemeris = new Ephemeris();`(`:126`)の
直前に `ephemerisConfigFor(launch)` の解決を挿入し、解決した3値を渡す形へ書き換える。
`launch` は既にコンストラクタの先頭で受け取っている引数なので、他の初期化順序への影響は無い。

**7-3.** `game/stages/stage-debug-alt-system.ts` を新設する。`StageDebug` と同じ
「選択画面に出ない(`hiddenFromSelect`)、`?stage=` で直接開くデバッグ専用ステージ」の形。
`static readonly ephemerisConfig` に、現実の太陽系とは異なる小さなレジストリ(例: 固定された
原点の天体1つ + それを回る天体1〜2つ、架空の名前・架空の `mu`/半径)を `originId` に
その原点天体を指定して宣言する。`init` で、既定で構築された地球 LEO 相当の初期状態
(このステージのレジストリでは無意味な値になる)を、その架空天体を周回する適当な軌道の
`KinematicState` で上書きする(`elements.ts` の `stateFromOrbitalElements` を使えばよい)。

**7-4. 受入確認(手で確認する):**

1. `stage-debug-alt-system` を開くと、現実の太陽系天体ではなく宣言した架空の天体だけが
   見える(現実の太陽系のデータは ECI のどこかに存在し続けているが、原点から十分離れている
   ため画面には映らない — §2-8 の「データとしては存在するが表示上・ゲームプレイ上は
   存在しないのと区別がつかない」と同じ扱い)。
2. HUD の ORBIT パネル・座標系選択・艦艇のプロパティウィンドウが、架空天体の名前
   (`CELESTIAL_BODIES` に手作りエントリが無いのでフォールバック名)で表示され、
   クラッシュしないこと。
3. その架空天体・その回転系フォーカスへカメラをロックできること。
4. 恒星を1体も持たないレジストリでも起動し、照明・輻射圧・日照率の各経路が
   クラッシュしないこと(§2-4 の3点目・5-6 の SRP 加算形)。
5. 既存の全ステージ(0/1/2/00/debug/creative)を一通り触り、挙動・見た目が一切
   変わっていないこと。

**7-5.** `StageDebug`(Phase 3/4 で複数の `Asteroid` を配置済み)で、それらが互いの重力だけで
複雑に絡み合う軌道を描くこと(目標2(a)の実演)を、(a)(b) 両方揃った状態として通しで確認する。

**7-6.** `DEVELOP/SPEC.md` §16「実装される可能性のある機能」へ、§2-4 末尾の境界(連星系、
3階層を超える公転階層、地球以外の大気/熱/初期配置/エネミー生成式の一般化、静止軌道高度・
太陽同期傾斜角プリセットの他天体への一般化、点群の任意レジストリ対応)と、§2-10 の
計画軌道への小惑星重力の反映、§2-13 の点群↔実体の LOD を記録する。

**検証:** `npm run typecheck` / `npm run test:physics` / 上記の手動受入確認。

---

### Phase 8 — 空間インデックスによる軽量化(計測ゲート)

**8-1. 計測する。** `StageDebug`(または専用のデバッグシナリオ)に `Asteroid` を数百〜数千体、
ランダムに散らして配置する一時的なコードを書き、`npm run dev` の実機で `?perf=1` の
update フェーズ ms を計測し、Phase 1・Phase 4 の値と比較する。

- **有意な悪化が無ければ、空間インデックスを実装せずここで打ち切る。** 素案の目標
  (「O(NM) で爆発しない」)は §2-11 の位置依存の絞り込みと、悪化が無いという実測そのものに
  よって満たされたとみなし、この判断と実測値を本書と `better_simulation_todo.md` に記録する。
- **有意な悪化がある場合のみ**、以降を実施する。

**8-2.** `physics/spatial-grid.ts` を新設する。位置を持つ任意の要素に対する一様グリッド
(セルサイズは呼び出し側が渡す)への登録と、ある点の27近傍セルに属する要素の列挙を行う
純関数群。`Attractor` にも `GameEntity` にも依存しない汎用実装にする。

**8-3.** `game/const.ts` に、重力源を「常に含めるもの」と「近傍のみ含めるもの」に分ける
セルサイズ(= 近傍を計算する半径 R)を追加する。分類自体は `sqrt(mu / GRAVITY_NEGLIGIBLE_ACCEL)`
が R を超えるかどうかで決まるので、**質量のしきい値を別に持たない**(1つの値から導く)。

**8-4.** `game/simulation/gravity-attractors.ts` を書き換え、`relevantAttractors` の前段に
グリッドを挟む。**呼び出し側(`Simulator.substep`/`Predictor`/`PlanArc`)のシグネチャは
変えない。** グリッド自体は同じ substep 内の全エンティティで使い回すので構築コストは1回で済む。
**`relevantAttractors` の判定式は変えない** — グリッドは候補を減らす前段であって、
採否の基準そのものではない(結果が変わらないことを 8-5 のテストで担保する)。

**8-5.** `tests/physics/spatial-grid.test.ts` を新設し、ランダムに配置した点群に対して
グリッド経由の近傍列挙が全数探索によるフィルタと一致することを検証する。

**検証:** `npm run typecheck` / `npm run test:physics`。8-1 と同じ配置・同じ実機で
`?perf=1` を再計測し、改善を確認して記録する。既存ステージでの挙動が完全に変わっていないことを
`test:physics` の回帰と目視の両方で確認する。

---

### Phase 9 — 設計文書の更新

同じ変更セットに含める(`/develop-docs`):

- **CLAUDE.md** — Architecture 節に `game/game-entity/asteroid.ts`・`game/game-entity/entity-id.ts`・
  `game/simulation/gravity-attractors.ts`・`game/stages/stage-debug-alt-system.ts`・
  `physics/spatial-grid.ts`(実装した場合)を追加。`GameEntity` の説明に `id`/`radius`/
  `collides`/`mu`/`degree2`/`isStar` を追記し、旧 `collideRadius` の記述を置き換える。
  `Ship` の被弾判定半径が `hitRadius` に改称されたことを反映。`Simulator`/`Predictor`/`PlanArc` の
  重力源の扱い(2窓 + 位置依存の第3段)の記述を更新。**`physics/ephemeris.ts`
  (registry/originId/starId/frames/frameFor を持つインスタンスへの一般化)・`physics/frame.ts`
  (`FRAMES`/`INERTIAL_FRAME` が `Ephemeris` へ移ったこと)・`physics/solar-system.ts`
  (`bodyDef`/`primaryOf` がレジストリ引数を取ること、`SolarSystemId` が `keyof` 由来になり
  手書き union が消えたこと)・`game/celestial/celestial-registry.ts`(太陽系分は網羅性強制の
  ままで、レジストリ外向けにフォールバックが付いたこと)・`game/hud/frame-labels.ts`
  (動的な天体名/フレームラベル関数)の説明を、この一般化を反映して書き直す。**

  **この機会に、マージで悪化した CLAUDE.md の重複記述を必ず解消する。** 調査時点で
  `attractor.ts`・`elements.ts`・`ephemeris.ts`・`predictor.ts`・`simulator.ts`・
  `plan-path.ts`・`display-time-manager.ts`・`test:physics` の各項が**新旧2版ずつ並記**され、
  旧版が存在しない名前(`OrbitState`/`Elements`/`OrbitEntity`/`stepDynamicsRK4`/`hitsAnySurface`/
  `plan-trajectory.ts`/`CELESTIAL_VIEWS`)を現役として説明している。`src/` に実在するのは
  `KinematicState`/`OrbitalElements`/`DynamicTrajectory`/`stepDynamics`/`hitCelestialBody`/
  `plan-path.ts`/`CELESTIAL_BODIES` の側だけなので、**旧版の記述を削除する。**
  併せて、実態と食い違う次の2箇所も直す: `Ephemeris` は「メモ化を持たない」→ 4系統の
  リングキャッシュを持つ、`CELESTIAL_BODIES` の消費者に挙がっている
  `camera-system.ts` の `PANEL_FOCUS_IDS` は既に存在しない。
- **DEVELOP/OWNERSHIP.md** — `GameEntity.id`/`radius`/`collides`/`mu`/`isStar` が構築時に
  固定される値であることを反映。`EntityManager.asteroids`/`attractors()`/`findEnemy` の追加。
  `Ephemeris` が `registry`/`originId`/`epochOffsetSec`(構築時に固定)と
  `frames`/`dynamicFrames`(構築時 + 実行時に伸びるキャッシュ)を所有することを反映。
- **DEVELOP/CALLSTACK.md** — `Simulator.substep()` 内の重力源一覧の構築と位置依存の絞り込みが
  追加されたこと、`Predictor`・`PlanArc`・`OverviewCamera`・`PlanPath` への波及を反映。
  `Game.sync` の共通値 `attractors` が合流済みになったこと(§2-12)も。
- **DEVELOP/SPEC.md** — 小惑星(重力を持つ物体)の存在、Phase 7 のデモが示す「自由な系」の
  2つの実演内容、§16 への記録(Phase 7-6 で先行して書いていなければここで書く)。
- **`.claude/skills/refactor-fixed/SKILL.md`** — §11 に、`AttractorId`/`Attractor.id` が
  登録天体とは限らない一般の `string` になったこと、具体レジストリ側が `keyof` で自分の ID 型を
  自己生成すること、`Ephemeris` がレジストリ・原点をインスタンスごとに持つことを追記する。
  §15(一般化しないと決めたもの)には §2-4 末尾の境界だけを追記する — 一般化した側は
  CLAUDE.md の Architecture 記述に置く。**既存の「一般化しない」項目と重複しないように
  全体を整合させて書き直す(追記の羅列にしない)。**
  併せて、**`## 15` という見出し番号が2つある**(「一般化しないと決めたもの」と
  「天体の自転軸・自転位相は…」)ので採番を直す。
- **`memos/hedalu244/better_simulation_todo.md`** — Step3 の記述を消し、「実装済み」で
  あることが分かるよう書き直す(経緯は残さない)。Step2 の残タスクはこの Step の対象外なので
  判断せずそのまま残す。
- **`memos/mikanixonable/SOLAR_SYSTEM_PLAN2_2026-08-09.md`** — **本書が肩代わりした EP0
  (重力窓の位置依存化)と、前提が変わった箇所(§1.2 の C-2「閉じた union」、E-9 の
  レジストリ記述量、E-13 の `influenceRadius`)を、本書の実装結果に合わせて書き直す。**
  §0.5 の不変条件が守られていることを確認したうえで、あちらの残フェーズ(EP1〜EP8)が
  そのまま着手できる状態にする。**あちらの文書は mikanixonable のものなので、
  書き換えてよいかをユーザーに確認してから行う。**
- 大きな変更なので、最後に `/comment-cleanup` で新旧コメントを一括点検する。

**検証:** `npm run typecheck`(文書のみの変更でも、直前のフェーズの状態が壊れていないことの
最終確認として走らせる)。

---

### Phase 10 — 変更セットの `/refactor`・`/refactor-fixed` 違反点検

**大規模な変更の後には必ずこの点検を行う。** Phase 2〜9 で変更した箇所(§3 の表に挙げた
新規・変更ファイル一式)を対象に、`/refactor` と `/refactor-fixed` の基準に照らしてレビューする。
特に次の観点を重点的に見ること:

1. **`GameEntity` が本当に変換なしで `Attractor` と構造的に一致しているか。** どこかに
   `asAttractor()` のような変換関数や、`id`/`radius`/`mu`/`isStar` を再度ラップするオブジェクトが
   紛れ込んでいないか(§2-1 の意図はそれを作らないことだった)。
2. **`collideRadius` という名前がコード中に一件も残っていないか**(`grep -rn "collideRadius" src`
   で 0 件)。かつ `collides` への分解で、**弾丸・破片が剛体接触に参加するようになっていないか**。
3. **`id` の統一が `Enemy`/`Ammo`/`Base` すべてに及んでいるか**、`e.name === …` という形の
   検索が残っていないか。
4. **`Simulator.substep()` の統合ループが `stepAttitudes()` の型ごとの分岐を誤って
   一緒くたにしていないか**(Phase 4-5 で明示的に「変更しない」とした箇所)。
5. **`relevantAttractors` が3経路すべてを通っているか**、かつ**しきい値が `physics/` 側に
   紛れ込んでいないか**(`/refactor-fixed` §4 — 調整値は `game/const.ts`)。
6. **`Predictor` の近似(§2-6)がコメントとして明記されているか**、かつ `physics/` ではなく
   `game/simulation/` 側に書かれているか。
7. **`mu` の有無で衝突判定(`collision.ts`/`hit.ts`)を分岐させる新しいコードが追加されて
   いないか**(§2-7 で明示的に禁止した箇所)。
8. **`'sun'`/`'earth'` の文字列リテラルによる分岐が、§2-4 末尾で意図的に一般化しないと決めた
   範囲の外に残っていないか。** `grep -rn "'sun'" src` / `grep -rn "'earth'" src` で拾い、
   §2-4 の一覧(調査時点で `'sun'` 16件・`'earth'` 21件)と突き合わせて1件ずつ判定する。
9. **`bodyDef`/`primaryOf` の呼び出し箇所が、すべて `registry` 引数を明示的に渡す形になって
   いるか**、かつ **`def.kind === 'planet' ? 'sun' : def.planet` という三項演算子が
   `primaryOf` の実装以外に0件になっているか**(§2-4 の3点目、調査時点で5重複)。
10. **`Ephemeris.frames`/`frameFor` の動的フレームが `FRAMES` の旧・参照同一性契約と同じ強さで
    守られているか。** 生存中の重力天体ぶんの `ReferenceFrame` を毎フレーム新しいオブジェクトと
    して作っていないか(`render/sampled-line.ts` の `frame === lastFrame` キャッシュが常に
    外れて描画コストが跳ね上がっていないか)。
11. **登録済み天体の回転系解決経路(解析的)が、誤って骨組み経路に巻き込まれていないか。**
    月/地球回転系など既存の座標系の挙動・見た目が一切変わっていないことを目視で確認する。
12. **`Ephemeris` から受け取った配列を破壊している箇所が無いか**(§0.5 不変条件3)。
    `sort`/`push`/`splice` を `attractorsAt`/`gravityAttractorsAt` の戻り値に対して
    直接呼んでいないかを grep で確認する。
13. **§0.5 の不変条件1〜7がすべて満たされているか**を1つずつ確認する。特に
    `CELESTIAL_BODIES` の網羅性強制(天体を1体足すと赤くなること)を、実際に
    `SOLAR_SYSTEM` へダミーの天体を足してコンパイルエラーが出ることで確かめ、確認後に戻す。
14. **`stage-debug-alt-system.ts` 以外のステージの `ephemerisConfig` が undefined のままである
    ことを確認する** — 意図せず既存ステージの原点・レジストリを変えてしまっていないか。
15. `Asteroid`/`entity-id.ts`/`stage-debug-alt-system.ts` が既存クラスと比べて過不足のない
    フィールド・メソッドになっているか(不要な汎用化・書きすぎたコメントが無いか)。
16. 200行/100行の目安(モジュール/関数)を超えているファイル・関数が無いか(特に
    `entity-manager.ts`・`simulator.ts`・`predictor.ts`・`game-entity.ts`・`ephemeris.ts`・
    `solar-system.ts`・`map-picker.ts`・`ship-placer-panel.ts` は既存でもそれなりの行数が
    あるので、今回の追記で超えていないか確認する)。
17. §3 の表にある全ファイルの diff を見て、コメントの過不足(`/comment` 基準)を個別に点検する。

レビューで見つかった問題はこの変更セットの中で修正する。修正後、
`npm run typecheck` / `npm run test:physics` が green であることを再確認して完了とする。

---

### Phase11 — 残りタスクと今後の展望の整理

1. `better_simulation_todo.md` の `§目標` を再読し、目的と内容を理解したうえで、次のステップで行うべきタスクを整理する。すでに実装されたことについては、この時点の実コード、 `CLAUDE.md`/`OWNERSHIP.md`/`CALLSTACK.md`/`SPEC.md` の内容を、今後実装されうる要素については、`memos/`フォルダ全体を参考にする。
2. 次に行うべきことを `for_agent.md` にまとめる。ここで整理したタスクは、次のステップで実装する際の指針となる。

## 5. 落とし穴チェックリスト

1. **substep 内で重力源一覧を使い回さず、各エンティティが自分で組み直すと、処理順に依存した
   非対称な誤差が混入する。** これは性能の問題ではなく正しさの問題(§2-5)。「1回だけ組んで
   引数で配る」形になっているか必ず確認すること。
2. **`Ephemeris` の `attractorsAt`/`gravityAttractorsAt` が返す配列は、同一 `t` に対して
   同一参照が返るリングキャッシュの中身である。** これを `push`/`sort` などで破壊すると、
   同じフレームの別の呼び出し元が壊れた配列を受け取る(しかも「たまに壊れる」形でしか
   現れない)。合流は必ず新しい配列への展開で行うこと(§2-5)。
3. **`collideRadius` を `radius` + `collides` へ分解する際、`collides` の既定を `true` に
   してしまうと、弾丸と破片が剛体接触に参加して弾け飛ぶ。** 既定は `false`(= 今日
   `collideRadius` を渡していなかった側の意味)で、明示的に参加させるクラスだけ `true` にする。
4. **`Ship.radius`(被弾判定半径)を `hitRadius` に改称する際、`RadiatorSystem.hitRadius()` と
   紛らわしくなる**(`this.radius = this.radiator.hitRadius();` が
   `this.hitRadius = this.radiator.hitRadius();` になる — 意味は「ship の被弾判定半径 =
   radiator が寄与する被弾判定半径」で正しいが、読み違えないようコメントを確認すること)。
5. **`Asteroid` の `mass` と `mu` を別々に受け取ると食い違う。** 質量を1つだけ受け取って
   両方をそこから導くこと(§2-1)。食い違うと、重力で引き合う強さと衝突で跳ね返る重さが
   別の物体のように振る舞う。
6. **`Asteroid.id` は `EntityManager.attractors()` が呼ばれるたびに同じ文字列を返す必要がある**
   (生成時に固定した1つの id を使い回す)。`GameEntity.orbitalElementsAround` の要素メモが
   `center.id` をキーの一部にしているため、id がフレームごとに変わるとメモが常に外れて
   無駄な再計算が発生する(壊れはしないが性能が悪化する)。
7. **`hitCelestialBody` に渡す配列に小惑星を含めてしまうと、艦が小惑星に近づいただけで
   「再突入」判定される。** §2-7・§2-12 のとおり、`EntityManager.cleanup` へ渡す配列は
   解析天体のみのまま変えないこと。逆に **`Game.sync` の共通値には合流させる**ので、
   2つの配列を取り違えないこと。
8. **`relevantAttractors` を3経路のうち1つでも通し忘れると、予測線・計画線が実際の軌道と
   ずれる。** しかも「予測が当たらない」という形でしか現れないので発見が遅れる。
   Phase 4-9 のテストで3経路の一致を assert すること。
9. **`AttractorId` を `string` へ開いた後、`registry[id]` のような添字アクセスをコンパイラが
   検出できなかった場合**(`as AttractorId` で型を強制的に通している既存コードがあれば、
   そこはノーチェックのまま実行時に壊れうる)、typecheck だけに頼らず
   `grep -rn "as AttractorId" src` も洗い直すこと。特に `frame-labels.ts:8-10` の
   `ATTRACTOR_NAMES` は `Object.fromEntries(...) as Record<…>` で組まれており、
   **今日でも網羅性を検査していない**(`CELESTIAL_BODIES` 側の強制に乗っているだけ)。
10. **`CELESTIAL_BODIES` を `Partial` にしたり `name` を省略可能にしたりしないこと。**
    第2次計画 E-9 が「ID をそのまま表示するフォールバックを許すと表示名が抜けたまま
    出荷される」として型で必須のまま残すことを明示的に決めている(§0.5 不変条件1)。
    レジストリ外の id 向けフォールバックを足すのと、太陽系27体の必須性を緩めるのは別の話。
11. **`Ephemeris.frames`/`frameFor` の動的フレームは、毎回リテラルで作らずキャッシュから
    同じ参照を返さないと、`sampled-line.ts` のキャッシュが常に外れて描画コストが跳ね上がる**
    (壊れはしないが性能が悪化する)。
12. **登録済み天体の回転系解決(解析的)と、生存中の重力天体の回転系解決(その瞬間の相対状態から
    組む骨組み)は別の経路であり、混同すると既存の月/地球回転系が突然ブレて見えるようになる。**
    `frameTransformAt` の分岐が「id がアクティブなレジストリに実在するかどうか」で正しく
    振り分けられているか確認すること。
13. **`Asteroid` の `bcInv`/`srpCoeff` を 0 にし忘れると**、`dynamics.ts` の
    `dragAccel`/`srpAccel` が(どの天体からどれだけ離れていても)ゼロでない抵抗・輻射圧を
    計算しようとする — 実害は乏しいが、無駄な計算と意図のわかりにくさを避けるため明示的に 0 にする。
14. **SRP の輻射源を「`isStar` な最初の1体」に絞ると、恒星0個のレジストリで `null` 参照に、
    2個以上で片方だけが効く。** §2-4 の4点目のとおり**加算**にすること。
15. **`primaryOf` は「主星がちょうど1つ、または0個」を前提にする。** カスタムレジストリに
    `kind: 'star'` を2つ以上入れると `Ephemeris` の構築時に例外になる — 連星系はこの Step の
    スコープ外(§2-8)であることをコメント・エラーメッセージで明確にしておくこと。
16. **`game.ts` のコンストラクタ内で `Ephemeris` の構築を `bootstrapPlayer`/`initStage` より
    前に置き忘れると**、既定のレジストリ・地球原点のまま構築されてしまい、ステージの
    `ephemerisConfig` が無視される(Phase 7-2)。
17. **カスタムレジストリのステージでは、既定の初期状態(地球 LEO)がそのレジストリでは無意味な
    値になる。** `Stage.init` で確実に上書きすること — 忘れると、艦が「地球の `MU_EARTH`/
    `R_EARTH` を使った LEO」という無関係な軌道に乗ったまま始まる(クラッシュはしないが
    デモとして意味を成さない)。
18. **空間インデックス(Phase 8)を実装した場合、グリッドは候補を減らす前段であって採否の
    基準ではない。** セルサイズを誤って小さく取ると、本来効くべき遠方の重い天体が
    近傍セルから漏れる。重い側は常に含める分類に入れ、テスト(8-5)だけでなく既存ステージでの
    回帰確認(Phase 8 末尾)を省略しないこと。

---

## 6. このステップでやらないこと

- **恒星が2つ以上、相互に公転しあう連星系。** §2-4 のとおり `primaryOf`/`starId` は
  「主星0または1つ」を前提にする。相互に比較可能な質量が複雑な軌道を描く状況(真の連星)は
  解析的なケプラー軌道モデルの適用範囲外であり、レジストリの一般化では表現できない。
- **3階層(恒星/惑星/衛星)を超える公転階層(衛星の衛星など)。**
- **地球の大気圏熱管理・初期配置(`makeInitialState`)・エネミー生成式を、天体非依存に
  一般化すること。** 地球以外の天体しか無いレジストリでもクラッシュしないことまでを保証し、
  これらの物理モデル自体は一般化しない。
- **静止軌道高度・太陽同期傾斜角のプリセット、基地配置を月に限定するルールの一般化。**
- **`asteroid-belt.ts`/`asteroid-field.ts` の点群の分布定義データ化と、任意レジストリ対応。**
  第2次計画 E-11 の担当範囲。本書は `positionOf('sun', t)` を `starId` 経由に直すだけ。
- **点群の1点を実体の `Asteroid` へ昇格させる LOD。** §2-13。
- **`game/celestial/` の `CelestialBody` 系のクラス名の見直し。** §2-9 の判断により、
  改名の前提(解析/積分の統合)が今回発生しないため見送る。
- **`feature_todo.md`「衝突判定の統一化」そのもの。** §2-7 のとおり、今回は既存の
  `CollisionPhysics`/`hitCelestialBody` の分岐をそのまま使い、どちらの方向にも統合を先取りしない。
- **計画軌道(`plan/plan-arc.ts`)への小惑星重力の反映(積分自体への影響)。** §2-10。
  ただし `relevantAttractors` は通す(混同しないこと)。
- **小惑星自身の未来予測(`predictsFuture=true` 化)。** §2-6。
- **クリエイティブモードの艦艇配置パネルからの小惑星配置 UI、および小惑星を基準にした
  新規オブジェクトの配置(ラグランジュ点を含む)。** 回転系フォーカスは既存の重力天体を
  眺める機能であり、新しい天体をそれ基準に配置する機能とは別。Phase 4/7 の受入確認は
  `StageDebug` への直接配置で行う。UI 化は別途要求が出てから `/add-feature` の手順で検討する。
- **動的(相対的)なしきい値。** §2-11 で採らない理由を述べた。
- **`CelestialBodyDef.gravitySource` の意味の変更(「近傍に行きうるか」→「μ の測定値が
  存在するか」)と、その true 化。** 第2次計画 F-10 の担当。本書はそれを安全にする機構
  (§2-11)を用意するだけで、フラグの立て方自体には触らない。
- **形状(扁平・三軸楕円体)・環の拡張・追加天体の登録。** 第2次計画 EP1〜EP8 の担当。
- **分点歳差・月理論の数値表の未検証項目など、Step2 の残タスク。** 本書のスコープ外
  (`better_simulation_todo.md` に残す)。

---

## 7. フェーズごとの検証コマンド

```
npm run typecheck          # 全フェーズで必ず
npm run test:physics       # 物理層を触る Phase 2〜8 で必ず
npm run dev                # Phase 2 以降、目視確認
npm run dev + ?perf=1      # Phase 1(基準)・Phase 4 末尾(絞り込みの効果)・
                            # Phase 8 冒頭(小惑星大量時の計測)・Phase 8 末尾(効果測定)の
                            # 4点で実機測定して記録する(ヘッドレスでは高負荷まで駆動できない)
npm run dev + ?stage=<id>  # Phase 7 の stage-debug-alt-system を含む、選択画面に出ない
                            # デバッグ専用ステージを開くときに使う
```

**着手前に Phase 1 の基準値を実機で測っておくこと。** これが無いと Phase 4・Phase 8 の
「悪化しているか/改善したか」の判断ができない。
