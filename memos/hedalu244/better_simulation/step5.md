# Step 5 実装手順 — 剛体衝突シミュレーションの改善

`goal.md` の§目標が明言する最後の未着手の柱、「衝突シミュレーションを
弾・デブリ・小惑星の別なく剛体シミュレーションとして一般化する」を実装する。
着手前に、必ず `goal.md` の§目標を参照し、目的を理解しながら行うこと。

作業前に `.claude/skills/refactor-fixed/SKILL.md` と `/comment` を読むこと。
**各フェーズは単独でコミットできる状態(typecheck + test:physics が通り、ゲームが起動する)で
終えること。** フェーズをまたいで壊れたまま進めない。

---

## 0. 前提と優先順位

**判断が競合したら、この順で決める(`/refactor-fixed` §5)。**

1. **物理的正確さ** — `physics/` では最優先。
2. **実装の適切さ** — 責務分割・疎結合・命名・数式が素直にそのまま書かれていること。
3. **実行時パフォーマンス** — 重要だが上2つより下。
4. **変更コスト** — 最も低い。

その他の前提:

- 分点歳差と月理論の数値表に残る未検証項目は本書のスコープ外のまま `backlog.md` に残す。
- **万有引力側の残タスク(`relevantAttractors` の削除、空間インデックスの要否判断、
  `SOLAR_SYSTEM_PLAN2_2026-08-09.md` の前提の同期)は `step4.md` の担当範囲。** 本書は重力の
  **計算経路**に一切触れない。両者とも `src/physics/attractor.ts` を触るが、触る関数が別
  (`step4.md` は `relevantAttractors` の削除、本書は `hitAttractor`/`hitCelestialBody` の移動)
  なので、どちらを先に進めてもよい(同時並行だけ避ける)。
- **`feature_todo.md`「衝突判定の統一化」の4つの `hit` 語彙統一(弾の被弾/剛体接触/画面ピック/
  命中までの時間)は、今回まとめて行わない。** 同メモ自身が「実装より先に名前だけ動かさない —
  統合と同じ変更セットで4つまとめて決める」と明言しており、本書が統合するのは4つのうち
  **剛体接触(2)だけ**である(§1)。弾の被弾判定(1)・画面ピック(3)・命中までの時間(4)は
  今回動かさないので、命名統一もまだ行わない。**ただし天体表面接触(`hitAttractor`/
  `hitCelestialBody`)はこの4つの一覧に含まれていない**。本書はこれをモジュールごと移す
  (Phase 0)のだから、移した先の名前を決めることは避けられない — 新しい名前に `hit` を使わない
  ことで、残る4つの語彙統一の判断を先取りしない(§2-6)。

---

## 1. 到達点(成功基準)

1. **剛体接触(自機・敵機・薬莢・デブリ・補給・小惑星・ベルトリンク)の撃力(impulse)計算が、
   `physics/` の純関数1つに一本化されている。** 現状 `game/simulation/collision.ts` の
   `resolveCollisionPair` に埋め込まれているベクトル演算(めり込み補正・法線・力積・
   反発後速度)を、質量・位置・速度・半径・反発係数だけを引数に取る純関数として
   `physics/` へ切り出す。`game/simulation/collision.ts` 側はこの関数を呼び、結果を
   `KinematicState` へ書き戻す(mutate)側だけを残す。
2. **接触ダメージが、閉じた速度のしきい値ではなく力積(質量×速度変化)から決まる。**
   現状の `Ship.applyCollisionDamage(speed)` は接触相手の質量を一切見ない — 薬莢
   (`CASING_MASS`)が衝突しても機体(`10000`kg級)が衝突しても、閉じた速度さえ同じなら
   同じ割合のダメージになる。力積(=質量×速度変化)を根拠にすることで、軽い物体との
   高速接触と重い物体との低速接触が物理的に正しく区別される。
3. **接触ダメージが、`Player`⇔`Enemy` の組だけでなく、`collides` を立てた任意の `Ship` と
   任意の相手の組で発生する。** 現状 `game.ts` の `onHighSpeedImpact` コールバックは
   `a === player && b instanceof Enemy` の形でしか撃力を消費しておらず、薬莢・デブリ・
   小惑星(Step3 で新設)が艦に衝突しても一切ダメージが発生しない
   (`game.ts:461-469` で実機確認済み)。艦が小惑星に高速で突っ込んでも今日は無傷という
   欠落を埋める。
4. **既存のゲームバランスが変わらないことを確認できている。** `COLLISION_DAMAGE_MIN_SPEED`/
   `_FULL_SPEED` を力積ベースの定数へ置き換える際、**艦同士の衝突(既存で唯一ダメージが
   発生していた組)のダメージカーブが従来と一致する**ことを回帰的に確認する(質量が
   ほぼ対等な相手同士の力積は速度にほぼ比例するので、艦同士に限れば旧式・新式は
   ほぼ同じ値になるはずであることを検算する)。
5. **天体表面への接触判定が、重力の関心事(`physics/attractor.ts`)から接触の関心事へ移っている。**
   `Attractor` とは「GM を持つもの」であって、接触判定を持つかどうかとは無関係である —
   接近・接触したときに何が起きるかは接触シミュレーションの関心事。`hitAttractor`/
   `hitCelestialBody` は接触の幾何を扱うモジュールへ移り、引数の型も `Attractor[]` ではなく
   「位置と半径を持つ球」になっている(§2-6)。**判定モデル(しきい値による二値判定と
   高度マージン)は一切変えない** — 変えるのは置き場所と引数の型だけ。
6. **弾の被弾判定(`HitSystem`/`Bullet.damage`)と、天体表面接触の判定モデル自体は、
   意図的にこの統合の対象外のまま残る。** 理由は §2-1 に明記する。

---

## 2. 設計判断

### 2-1. 統合するのは「剛体接触の撃力計算」だけ。弾の被弾判定と天体表面接触のモデルは対象外

`feature_todo.md`「衝突判定の統一化」は「弾にせよデブリにせよ小惑星にせよ、剛体シミュレー
ションとして一般化してから、大気やガス惑星、プラズマ弾といった非剛体を後から考慮する」
という順序を明言している(`goal.md` の§目標にも同じ一文がある)。この順序に従い、本書は
**剛体どうしの接触**(自機・敵機・薬莢・デブリ・補給・小惑星・ベルトリンク — いずれも球で
近似され、`GameEntity.collides`/`radius`/`mass` を持つ)だけを対象にする。次の2つは意図的に対象外。

- **弾の被弾判定(`HitSystem.checkBulletHits` → `Ship.attacked`)。** 弾のダメージ
  (`Bullet.damage`)は撃った側の武器の性能値であり、弾自身の運動エネルギーから物理的に
  導かれる量ではない(現に軽いプラズマ弾と重い実体弾が同じダメージテーブルに乗る)。
  これは**ゲームデザイン上の武器バランス**であって物理量ではないので、剛体接触の力積に
  混ぜると武器バランスの数値的根拠が消える。統合するなら「弾のダメージを武器スペックから
  力積ベースへ置き換える」という独立した、影響の大きいゲームデザイン判断が要る —
  本書はそれを勝手に決めない。
- **天体表面接触の判定モデル(`hitCelestialBody` → 大気再突入・小惑星表面への沈み込み)。** これは
  §目標が明示する「非剛体」(大気)の領域そのものであり、しきい値ベースの二値判定
  (めり込んだら即座に消滅/再突入)を今回力積ベースへ置き換えると、大気圏突入の物理モデル
  (`thermal.ts` の動圧・空力加熱)まで踏み込むことになる。**§目標の順序どおり、非剛体は
  後回しにする。** ただし**この判定が重力のモジュールに置かれていることは別の問題**であり、
  そちらは Phase 0 で直す(§2-6)。この2つは混同しやすいが別個の論点で、**置き場所の修正は
  モデルを一切変えない**のでここの対象外宣言と矛盾しない。

したがって本書が扱う「衝突」は、`game/simulation/collision.ts` の `CollisionPhysics.resolve`
が既に一元的に扱っている集合(`collides` を立てた全 `GameEntity`)と完全に一致する —
**新しい参加者を増やすのではなく、既に参加している者たちの撃力の使われ方を直す。**

### 2-2. 撃力計算そのものは既に `physics/` 的に純粋な形をしている — 抽出するだけでよい

`game/simulation/collision.ts:112-142`(`resolveCollisionPair` の反発計算部分)を読むと、
質量比を正しく使った撃力計算(めり込み補正・`sweptSphereToi` 併用・反発係数付き力積・
両者の速度更新)が**既にほぼ物理として正しい形**で実装されている。現状の問題は2つだけ:

1. この計算が `GameEntity`(`state` の get/set を持つクラス)を直接読み書きする形で
   `game/simulation/` に置かれており、`physics/` の他の純関数(`swept-sphere.ts` の
   `sweptSphereToi` など)のようにテスト(`test:physics`)対象になっていない。
2. 戻り値が「法線方向の閉じた相対速度の絶対値」(`speed`)だけで、**力積そのもの
   (`j = -((1+restitution)*vn)/invM`、既に関数内部で計算済み)を呼び出し側へ返していない。**
   `Ship.applyCollisionDamage` はこの `speed` だけを受け取り、相手の質量を一切知らずに
   ダメージ率を決めている。

**方針: 内部で計算済みの力積を追加の戻り値として公開し、位置・速度の更新ロジックそのものを
`physics/collision-response.ts` へ抽出する。** 新しい物理モデルは何も足さない —
今日 `collision.ts` が計算している式をそのまま、入出力の型だけ整理して移す。

```ts
// physics/collision-response.ts
// 2球の剛体接触(めり込み補正 + 反発係数つき力積)。resolveOverlap/resolveSweptContact のうち
// 実際に接触した経路の結果を返す。mass はどちらも有限かつ正であること(0 質量は呼び出し側で
// 排除する — collides を立てない、が既存の規約)。
export interface CollisionResponse {
  readonly rA: Vec3; readonly rB: Vec3;       // 補正後の位置
  readonly vA: Vec3; readonly vB: Vec3;       // 反発後の速度(離反中に反発しなければ元の値のまま)
  readonly normal: Vec3;                       // a→b の接触法線
  readonly impulse: number;                    // 力積の大きさ [kg·m/s]。反発しなければ 0
}
export function resolveCollision(
  aState: KinematicState, aPrevState: KinematicState | null, aMass: number, aRadius: number,
  bState: KinematicState, bPrevState: KinematicState | null, bMass: number, bRadius: number,
  restitution: number,
): CollisionResponse | null   // 接触していなければ null
```

`game/simulation/collision.ts` の `resolveCollisionPair` はこの関数を呼び、
`a.state = kinematicState(a.state.t, res.rA, res.vA)` のように書き戻すだけの薄いラッパに
縮む。**`resolveCollisionPairs`(全ペア総当たり・薬莢/ベルトの特例・O(n²) の判断)は
`game/simulation/` に残る** — どのペアを調べるか、ベルトをどう特別扱いするかは
ゲームのエンティティ管理の都合であり、`physics/` の関心事ではない。

### 2-3. ダメージは「力積 / 自分の質量」(= 自分が受ける速度変化)を根拠にする

力積 `impulse`(単位 kg·m/s)をそのままダメージのしきい値にすると、質量が違う艦
(`Player` 1000kg / `Enemy` 10000kg)の間で同じ物理的な「痛み」が違う数値になってしまう
(重い側は同じ力積でも速度変化が小さい = 同じ力積でもダメージが違って見えるべき)。
そこで **各エンティティが実際に受ける速度変化** `Δv = impulse / mass`(自分の質量で割った
もの)をダメージのしきい値に使う。これは「力積を質量で割ったもの」という教科書どおりの
量であり、`collision.ts` 側で `a` にも `b` にもそれぞれ別の値として計算できる
(`impulse / aMass` と `impulse / bMass`)。

```ts
// 各側が受けた速度変化 [m/s] を単位に、ダメージ率としきい値を張り直す。
// 質量の異なる相手との接触が物理的に正しく区別される(軽い薬莢がかすっても Δv は小さい
// = ほぼ無傷、重い小惑星に低速でぶつかっても Δv は大きくなりうる)。
export const COLLISION_DAMAGE_MIN_DV = …; // [m/s]
export const COLLISION_DAMAGE_FULL_DV = …; // [m/s]
```

**既存の `COLLISION_DAMAGE_MIN_SPEED`(50 m/s)/`_FULL_SPEED` は、艦同士(質量が同程度)の
衝突でしか発生していなかったので、艦同士の質量比を使って `MIN_DV ≈ MIN_SPEED × (相手側の
質量比の実効値)` を逆算し、**艦同士の衝突ダメージカーブが従来と数値的に一致する**ように
新定数を決める(Phase 2 の受入条件)。

### 2-4. `game.ts` のコールバックを「衝突した Ship 側全員」へ一般化する

現状の `game.ts:461-469`:

```ts
(a, b, speed) => {
  if (a === player && b instanceof Enemy) { … }
  else if (b === player && a instanceof Enemy) { … }
},
```

これを、ペアの**両側それぞれ**について「自分が `Ship` かつ相手からの `Δv` が閾値を超えて
いれば、その `Δv` でダメージを受ける」という対称な形に一般化する:

```ts
(a, b, impulse) => {
  if (a instanceof Ship) a.collidedByImpulse(impulse / a.mass, this.simulator.simTime, this.activeStage);
  if (b instanceof Ship) b.collidedByImpulse(impulse / b.mass, this.simulator.simTime, this.activeStage);
},
```

`collidedAtSpeed`(`Player`/`Enemy` に別々の実装がある)は `Ship` 基底の1本
(`collidedByImpulse` — 名前は「撃力から呼ばれる」ことを表す。既存の `attacked`(弾)との
語彙衝突を避けるため、`hit`/`impact` は使わない)へ統合できるか検討する — `Player`固有の
処理(`SimSpeedManager` 経由の警告等)があれば基底に共通部分だけを引き上げ、残りは
オーバーライドする。**`Player` 専用の呼び出し(自機が撃たれたときの警告等)がもし
`collidedAtSpeed` にしか無いなら、そこは残したうえで `Ship` 基底に共通ロジックを持たせる
形にする**(実装時に既存の2実装の差分を確認してから決める)。

`Enemy` 同士・`Enemy`⇔小惑星・薬莢⇔小惑星のように「どちらも `Ship` でない」組は、これで
自動的にダメージ対象外のまま残る(`Ship` でなければ HP という概念自体が無いため)。

### 2-5. `Asteroid`(Step3)・`Base`・`Ammo` は「衝突される側」の質量供給者としてだけ関わる

`Asteroid`/`Base`/`Ammo` は `Ship` を継承しないので `collidedByImpulse` を持たない —
これらに艦がぶつかっても、これら自身は今までどおり無傷(ダメージという概念を持たない)
のまま、**相手の `Ship` 側にだけ**ダメージが生じる。これは意図した非対称であり
(小惑星は撃墜されないが、艦は小惑星に当たれば壊れる)、新しい分岐は要らない —
§2-4 の一般化コールバックが `a instanceof Ship`/`b instanceof Ship` をそれぞれ独立に
判定する時点で自動的にこの非対称性になる。

### 2-6. 天体表面接触は「重力源の一覧」ではなく「表面を持つ球の一覧」に対する判定にする

`physics/attractor.ts` の `hitAttractor`/`hitCelestialBody` は、**引数が `Attractor[]` である
という一点だけで重力のモジュールに置かれている。** しかし `Attractor` とは GM を持つものの
ことであり、表面に触れたかどうかとは無関係な概念である(現に `mu` は判定式に一度も現れない —
読んでいるのは `state.r` と `radius` だけ)。判定が実際に必要としているのは
**「位置と半径を持つ球」**であって、それが重力を及ぼすかどうかは問われていない。

したがって次のように直す:

1. **`physics/swept-sphere.ts` を `physics/sphere-contact.ts` へ改名する。** 同モジュールは既に
   「2球の接触の幾何」(`sweptSphereToi`)を持っており、そこへ「点が球の表面より内側に沈み込んで
   いるか」を加えると、責務は**球の接触判定の幾何**そのものになる。新しいモジュールを別に作ると
   接触の幾何が2ファイルに割れるので、既存側を改名して寄せる。テストも
   `tests/physics/swept-sphere.test.ts` → `sphere-contact.test.ts` へ改名し `index.ts` を直す。
2. **引数の型は構造的な制約で書く。** `map-pick.ts` の `pickNearest<T extends {pos: Vec3}>` と
   同じ形にすれば、新しい型・新しいモジュールを増やさずに済み、呼び出し側は今持っている
   `Attractor[]` をそのまま渡せる(`Attractor` は構造的にこの制約を満たす)。

   ```ts
   // physics/sphere-contact.ts
   // 点 p が、半径 + margin の球の内側に入っている球。無ければ null。margin(大気圏突入高度など)は
   // ゲーム側の判断なので呼び出し側から受け取る。
   export function sphereContaining<T extends { readonly radius: number; readonly state: KinematicState }>(
     p: Vec3, spheres: readonly T[], margin: number,
   ): T | null;
   export function isInsideAnySphere(
     p: Vec3, spheres: readonly { readonly radius: number; readonly state: KinematicState }[], margin: number,
   ): boolean;
   ```

   **名前に `hit` を使わない**(§0 — 残る4つの `hit` の語彙統一を先取りしないため)。
   **`Attractor`/`CelestialBody` も名前に含めない** — 重力源にも天体にも限定されない幾何だから。
3. **`physics/occlusion.ts` の `isOccluded` も同じ制約へ揃える。** あちらも `Attractor[]` を
   受けながら読んでいるのは `state.r` と `radius` だけで、同じ「球であればよい」という要求。
   型注釈の変更だけで済み、実引数は現状のまま通る。

**`Attractor` から `radius` フィールドを外すことまでは行わない。** `OrbitalElements.center.radius`
経由の高度算出(`elements.ts` の `apsisAltitudes`、`hud/orbit-info.ts`)が既に依存しており、
そちらは「天体の実体としての `Attractor`」の使われ方で、今回の指摘(接触判定という**処理**が
重力モジュールに居ること)とは別の論点。**この判断は `DEVELOP/SPEC.md` §16 に残す**(Phase 3)。

---

## 3. 完成後のモジュール構成

| ファイル | 変更内容 |
|---|---|
| `src/physics/sphere-contact.ts`(`swept-sphere.ts` を改名) | `sweptSphereToi` に加え、`attractor.ts` から移す点対球の沈み込み判定(`sphereContaining`/`isInsideAnySphere`、§2-6)を持つ。責務は「球の接触判定の幾何」 |
| `src/physics/attractor.ts` | `hitAttractor`/`hitCelestialBody` を削除(上記へ移動)。`Attractor` は重力だけの型へ戻る |
| `src/physics/occlusion.ts` | `isOccluded` の引数を `Attractor[]` から「位置と半径を持つ球」の構造的制約へ(§2-6、3.)。実引数は現状のまま |
| 接触判定の全呼び出し元(`game-entity.ts`・`player.ts`・`enemy.ts`・`bullet.ts`・`debris-piece.ts`・`plan-arc.ts`) | import 先と関数名の差し替えのみ。渡す配列もマージン定数も変えない |
| `tests/physics/swept-sphere.test.ts` → `sphere-contact.test.ts` | 改名し `tests/physics/index.ts` の登録を直す。沈み込み判定のテスト(表面上/下/margin 境界)を追加 |
| `src/physics/collision-response.ts`(新規) | `resolveCollision(...)`(§2-2)。`game/simulation/collision.ts` の `resolveCollisionPair` から反発計算部分を抽出した純関数。`Vec3`/`KinematicState` のみに依存 |
| `src/game/simulation/collision.ts` | `resolveCollisionPair` を `resolveCollision` の呼び出し + `state` 書き戻しだけの薄いラッパへ縮小。`resolveCollisionPairs`(総当たり・薬莢/ベルト特例)は現状のまま。戻り値を `speed` から `impulse` へ変更し、`onHighSpeedImpact` へ渡す |
| `src/game/game-entity/ship.ts` | `applyCollisionDamage(speed)` を `applyCollisionDamage(dv)`(自分が受けた速度変化基準、§2-3)へ書き換え、`collidedByImpulse(dv, simTime, activeStage)` を基底に追加(`Player`/`Enemy` の既存 `collidedAtSpeed` を統合できる範囲で統合) |
| `src/game/player/player.ts`・`game-entity/enemy.ts` | `collidedAtSpeed` を削除(基底の `collidedByImpulse` に統合)、または `Player` 固有処理だけを残したオーバーライドにする |
| `src/game/game.ts` | `simulator.advance` の `onHighSpeedImpact` コールバックを §2-4 の対称形へ書き換え |
| `src/game/const.ts` | `COLLISION_DAMAGE_MIN_SPEED`/`_FULL_SPEED` を `COLLISION_DAMAGE_MIN_DV`/`_FULL_DV`(§2-3)へ置き換え |
| `tests/physics/collision-response.test.ts`(新規) | `resolveCollision` の単体テスト(§4 Phase 1 に列挙) |
| `memos/hedalu244/better_simulation/step5.md` | Step5 完了の記録 |

---

## 4. フェーズ別手順

### Phase 0 — 天体表面接触判定を重力の関心事から接触の関心事へ移す

後続のフェーズとは独立している(撃力計算に一切触れない)ので、単独でコミットしてよい。

**0-1.** `physics/swept-sphere.ts` を `physics/sphere-contact.ts` へ改名する(§2-6)。
`tests/physics/swept-sphere.test.ts` も `sphere-contact.test.ts` へ改名し、
`tests/physics/index.ts` の登録を直す。**旧名のエイリアスを残さない**。

**0-2.** `physics/attractor.ts` から `hitAttractor`/`hitCelestialBody` を削除し、
`sphere-contact.ts` へ `sphereContaining`/`isInsideAnySphere` として移す(§2-6 の型)。
**判定式は一切変えない** — `len(sub(p, sphere.state.r)) < sphere.radius + margin` のまま。

**0-3.** 呼び出し元(`GameEntity.checkLoss`/`stepPredicted`、`Player.checkLoss`、`Enemy.checkLoss`、
`Bullet.checkLoss`、`DebrisPiece.checkLoss`、`PlanArc` の積分打ち切り)の import と関数名を差し替える。
**渡す配列(`Ephemeris` の天体一覧)もマージン定数(`PLAYER_MIN_ALT`/`REENTRY_ALT`/
`DEBRIS_REENTRY_ALT`)も変えない。**

**0-4.** `physics/occlusion.ts` の `isOccluded` を同じ構造的制約へ揃える(§2-6、3.)。

**0-5.** `sphere-contact.test.ts` に沈み込み判定のテストを追加する: 表面の内側/外側/
`margin` 境界上、複数球のうち最初に見つかったものを返すこと、`Attractor` をそのまま
渡せること(構造的適合の確認)。

**0-6.** `grep -rn "hitAttractor\|hitCelestialBody\|swept-sphere" src tests` が 0 件。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で、再突入による喪失・
デブリの消滅・計画軌道の `✕` マーカー・マップのアイコン遮蔽が従来どおり動くこと。

---

### Phase 1 — 撃力計算を `physics/collision-response.ts` へ抽出

**1-1.** `game/simulation/collision.ts` の `resolveCollisionPair`(`:82-141`)を読み、
めり込み補正・`sweptSphereToi`(Phase 0 後は `physics/sphere-contact.ts`)併用・法線・
反発後速度・力積の計算部分をそのまま
`physics/collision-response.ts` の `resolveCollision(...)` へ移す(§2-2 の型)。
**数式は一切変えない** — 移動のみ。

**1-2.** `game/simulation/collision.ts` の `resolveCollisionPair` を、`resolveCollision` を
呼んで結果を `a.state`/`b.state` へ書き戻すだけの薄いラッパへ書き換える。戻り値を
`speed: number | null` から `impulse: number | null` に変える(`resolveCollision` が返す
`CollisionResponse.impulse`、反発しなかった場合は `null`)。

**1-3.** `resolveCollisionPairs`・`resolve` の `onHighSpeedImpact` の型注釈を
`(a: GameEntity, b: GameEntity, impulse: number) => void` へ変える。呼び出し条件
(`speed >= COLLISION_DAMAGE_MIN_SPEED`)は Phase 2 で `Δv` ベースへ直すまで一時的に
`impulse` に対する暫定しきい値のままでよい(Phase 2 で正式なしきい値に差し替える)。

**1-4.** `tests/physics/collision-response.test.ts` を新設し `tests/physics/index.ts` へ
登録する:

- **運動量保存:** 反発後の `mA·vA + mB·vB` が反発前と一致する(浮動小数点誤差の範囲で)。
- **エネルギー損失と反発係数の関係:** `restitution = 1`(完全弾性)で運動エネルギーが
  保存され、`restitution < 1` では単調に損失することを確認する。
- **力積の質量依存性:** 同じ閉じた相対速度でも、質量比が違えば `impulse` は同じだが
  `impulse / mass` (Δv) は質量に反比例して変わることを確認する(§2-3 の根拠そのものの検算)。
- **既存 `swept-sphere.test.ts` との整合:** `sweptSphereToi` を内部で使う経路(高速接触)が
  既存のテストと矛盾しないこと。
- **回帰:** `resolveCollision` を直接呼んだ結果が、Phase 1 着手前の `resolveCollisionPair`
  をその場でモンキーパッチして得た結果(または着手前にコミットした値)とビット単位で
  一致することを一時的なテストコードで確認してから削除する(数式を変えていないことの
  最終検算 — 恒久テストとしては残さない)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で既存ステージ
(0/1/2/00)を触り、艦同士・薬莢・デブリ・補給の反発が今までどおり(見た目上)動くことを
確認する。

---

### Phase 2 — ダメージを `Δv` ベースへ一般化し、`Ship` 全般へ配線する

**2-1.** `game/const.ts` の `COLLISION_DAMAGE_MIN_SPEED`/`_FULL_SPEED`(`:419` 付近)を
`COLLISION_DAMAGE_MIN_DV`/`_FULL_DV` へ置き換える(§2-3)。値は「艦同士(質量比 ≈ 1000:10000)
の衝突で、旧しきい値 50 m/s と同じ閾値になる」ように逆算する — 艦同士の場合
`Δv = impulse/mass` は旧来の `speed = |vn|`(閉じた相対速度)と一致しないので、旧テストの
シナリオ(艦2隻がその速度で正面衝突)を再現して数値を合わせる。

**2-2.** `Ship.applyCollisionDamage(speed: number)`(`ship.ts:96-102`)を
`applyCollisionDamage(dv: number)` へ書き換え、`COLLISION_DAMAGE_MIN_DV`/`_FULL_DV` を使う
形にする。

**2-3.** `Player.collidedAtSpeed`(`player.ts:297`)/`Enemy.collidedAtSpeed`
(`enemy.ts:186`)を読み比べ、共通部分を `Ship` 基底の `collidedByImpulse(dv, simTime,
activeStage)` へ引き上げる。`Player` 固有の処理(存在すれば)は基底呼び出し後に追加で行う
薄いオーバーライドとして残す。

**2-4.** `game.ts:458-470` の `onHighSpeedImpact` コールバックを §2-4 の対称形へ書き換える:

```ts
(a, b, impulse) => {
  if (a instanceof Ship) a.collidedByImpulse(impulse / a.mass, this.simulator.simTime, this.activeStage);
  if (b instanceof Ship) b.collidedByImpulse(impulse / b.mass, this.simulator.simTime, this.activeStage);
},
```

`Ship` は `player.ts`/`enemy.ts` の両方が import 済みの基底なので、`game.ts` 側の import は
`Enemy` から `Ship` へ差し替わる(あるいは両方使うならそのまま追加)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で:

- **既存の艦同士の衝突ダメージが従来と同程度であること**(2-1 の逆算が効いているかの
  実地確認 — 数値ログを一時的に仕込んで前後比較してもよい)。
- **薬莢・デブリ・小惑星(Step3 の `StageDebug` 配置)が艦に高速で衝突すると、艦がダメージを
  受けること**(§1 の到達点3 — 現状無かった挙動)。
- **薬莢どうし・デブリどうしの接触では相変わらずダメージが発生しない**こと(`Ship` でない
  もの同士は HP という概念自体を持たないため、当然の帰結であることを確認するだけ)。
- 排莢直後の薬莢が自機のダメージ原因にならない程度の低速であること(`Δv` が
  `COLLISION_DAMAGE_MIN_DV` を十分下回ること)。

---

### Phase 3 — 設計文書の更新

同じ変更セットに含める(`/develop-docs`):

- **CLAUDE.md** — `game/simulation/collision.ts` の項に `physics/collision-response.ts` への
  分割を反映。`Ship` の項に `collidedByImpulse`/`applyCollisionDamage(dv)` を反映し、
  `collidedAtSpeed`(旧名)の記述を置き換える。`physics/` の一覧に
  `collision-response.ts` を追加。**さらに Phase 0 分**: `physics/attractor.ts` の項から
  `hitAttractor`/`hitCelestialBody` の記述を削除し、`sphere-contact.ts` の項(旧
  `swept-sphere.ts`)へ移す。「表面接触は `attractor.ts` の `hitCelestialBody` が唯一の
  答え」という既存の記述(`kinematic-state.ts` の項など複数箇所)を全部直す。
- **DEVELOP/CALLSTACK.md** — `Simulator.advance` → `CollisionPhysics.resolve` →
  `onHighSpeedImpact` の呼び出し形が `speed` から `impulse` へ変わったことを反映。
- **DEVELOP/OWNERSHIP.md** — 変更なしのはず(状態の所有構造は変わらない)だが、念のため
  確認する。
- **DEVELOP/SPEC.md** — §16「実装される可能性のある機能」に、今回対象外とした3点
  (弾の被弾ダメージを武器スペックから力積ベースへ置き換えること、天体表面接触の力積化
  = 非剛体の大気圏突入モデルへの統合、`Attractor` から `radius` を外して天体の形状を
  重力と別の型へ分けること — §2-6)を追記する。
- **`memos/hedalu244/feature_todo.md`** — 「衝突判定の統一化」の記述を、剛体接触分は
  完了したことが分かるよう書き直す(経緯は残さない)。弾の被弾判定・画面ピック・命中までの
  時間の統一(hit 語彙の統一含む)は、まだ未着手の残タスクとして明記して残す。
- **`.claude/skills/refactor-fixed/SKILL.md`** — 剛体接触の撃力計算が `physics/` に
  切り出されたことと、**接触判定は重力の関心事ではない(§2-6)** という境界を、
  §4(`physics/`/`render/`/`game/` の境界)の実例として追記する
  (既存の記述と重複しないように整合させる)。
- **`memos/hedalu244/better_simulation/step5.md`** — 本書の記述を「実装済み」に書き直す。
- 大きな変更なので、最後に `/comment-cleanup` で新旧コメントを一括点検する。

**検証:** `npm run typecheck`。

---

### Phase 4 — 変更セットの `/refactor`・`/refactor-fixed` 違反点検

1. **`resolveCollision` が本当に `Vec3`/`KinematicState` だけに依存し、`GameEntity`/`Ship`
   を import していないか。** `physics/` から `game/` への依存が紛れ込んでいないか。
2. **`impulse`/`dv` の単位・向きの取り違えがないか。** `impulse`(力積、両者共通の1つの
   スカラー)と `dv`(各側がそれぞれ受ける速度変化、質量で割った後の値なので `a` と `b` で
   別の値)を混同していないか — `game.ts` のコールバックで `impulse / a.mass` /
   `impulse / b.mass` を正しく別々に計算しているか。
3. **`COLLISION_DAMAGE_MIN_SPEED`/`_FULL_SPEED` という名前がコード中に一件も残っていないか**
   (`grep -rn "COLLISION_DAMAGE_MIN_SPEED\|COLLISION_DAMAGE_FULL_SPEED" src`)。
4. **`collidedAtSpeed` という名前が残っていないか**(`grep -rn "collidedAtSpeed" src`)。
5. **`Asteroid`/`Base`/`Ammo` に誤って `collidedByImpulse` やダメージ概念が生えていないか**
   (§2-5 — これらは `Ship` を継承しないので、艦にぶつかっても自分自身は無傷のままが正しい)。
6. **弾の被弾判定(`HitSystem`/`Ship.attacked`)・天体表面接触の**判定モデル**に、
   今回の力積計算が混入していないか**(§2-1 で明示的に対象外とした境界 — Phase 0 で
   移したのは置き場所と引数の型だけであり、しきい値ベースの二値判定はそのまま)。
7. **`hit` 語彙のリネームが混入していないか**(§0 — 今回名前を決めるのは Phase 0 で移す
   天体表面接触だけで、`HitSystem`/`hitRadius`/画面ピック/`timeToHit` の4つには触れないはず)。
8. **Phase 0 で移した判定に、重力固有の概念(`mu`・`degree2`・`isStar`)が残っていないか。**
   残っているなら、移した意味が無い。
9. §3 の表にある全ファイルの diff を見て、コメントの過不足(`/comment` 基準)を個別に点検する。

レビューで見つかった問題はこの変更セットの中で修正する。修正後、
`npm run typecheck` / `npm run test:physics` が green であることを再確認して完了とする。

---

## 5. 落とし穴チェックリスト

1. **`impulse` と `dv`(Δv)を同じ変数名・同じ意味で扱ってしまうと、質量の違う相手との
   接触が物理的に区別されなくなる**(§2-3 の根拠そのものが失われる)。`game.ts` の
   コールバックで必ず `impulse / a.mass` / `impulse / b.mass` と、受け取る側の質量で
   個別に割ること。
2. **`resolveCollision` の抽出時、`sweptSphereToi` を使う経路(高速接触)と、めり込み補正
   経路のどちらか片方だけを移してしまわないこと。** 両方が同じ関数内で分岐している
   (`collision.ts:103-127`)。
3. **`COLLISION_DAMAGE_MIN_DV`/`_FULL_DV` を「旧 `_MIN_SPEED`/`_FULL_SPEED` と同じ数値」に
   単純コピーしないこと。** `dv = impulse/mass` は `speed`(閉じた相対速度そのもの)とは
   次元は同じでも値が違う(質量比・反発係数に依存する)。艦同士の衝突シナリオで実際に
   逆算すること(Phase 2-1)。
4. **`Ship.collidedByImpulse` を艦以外(`Asteroid`/`Base`/`Ammo`/`DebrisPiece`)に生やさない
   こと。** これらはダメージという概念を持たない(HP フィールドが無い)ので、
   `instanceof Ship` の判定より内側に何かを追加する必要はない。
5. **弾の被弾ダメージ(`Bullet.damage`)や天体表面接触のしきい値(マージン定数)を、
   今回の力積計算に合わせて変更しないこと。** §2-1 で明示的に対象外とした。
6. **Phase 0 を「ついでだから」と言って判定モデルまで触らないこと。** 移すのは置き場所と
   引数の型だけで、マージン定数も判定式も呼び出し元の条件も変えない(§2-6)。
7. **Phase 0 で `Attractor` から `radius` を外しに行かないこと。** `OrbitalElements.center.radius`
   経由の高度算出が依存しており、別の論点として SPEC §16 へ残す(§2-6)。

---

## 6. このステップでやらないこと

- **弾の被弾判定(`HitSystem`/`Ship.attacked`)を力積ベースへ置き換えること。** §2-1 —
  武器ダメージはゲームデザイン上の数値であり、置き換えるなら独立したバランス調整の判断が要る。
- **天体表面接触の**判定モデル**を力積ベース・非しきい値の判定へ一般化すること。** §2-1 —
  §目標が「非剛体は後で」と明言している大気圏突入モデルの領域そのもの。Phase 0 で行うのは
  判定の**置き場所**の修正だけで、モデルは一切変えない。
- **`Attractor` から `radius` を外すこと。** §2-6 — 別の論点なので SPEC §16 へ残す。
- **`hit`/`collision` 命名の統一(feature_todo.md が挙げる4つの意味の統合)。** 剛体接触
  以外の3つ(被弾・画面ピック・命中までの時間)を今回統合しないため、命名もまだ動かさない
  (Phase 0 で名前を付け直すのは、その4つに含まれない天体表面接触だけ — §0)。
- **万有引力側の残タスク**(`relevantAttractors` の削除、空間インデックスの要否判断、
  `SOLAR_SYSTEM_PLAN2_2026-08-09.md` の前提の同期)。`step4.md` の担当範囲。
- **分点歳差の導入と、月理論の数値表に残る未検証項目。** `backlog.md` に残したままにする。
- **`refactoring_todo.md` の他の項目**(sfx/bgm 分離、belt-physics の変換処理見直し、
  const.ts 解体等)。今回の変更セットとは無関係。

---

## 7. フェーズごとの検証コマンド

```
npm run typecheck          # 全フェーズで必ず
npm run test:physics       # physics/ を触る Phase 1 で必ず
npm run dev                # Phase 1 以降、目視確認
```
