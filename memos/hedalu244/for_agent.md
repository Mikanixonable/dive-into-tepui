# Step 4 実装手順 — 剛体衝突の一般化(質量と相対速度からの撃力算出)と Step3 の後始末

`better_simulation_todo.md` の§目標が明言する最後の未着手の柱、「衝突シミュレーションを
弾・デブリ・小惑星の別なく剛体シミュレーションとして一般化する」を実装する。
着手前に、必ず `better_simulation_todo.md` の§目標を参照し、目的を理解しながら行うこと。

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

- Step2 の残タスク(分点歳差、月理論数値表の未検証項目)は本書のスコープ外のまま
  `better_simulation_todo.md` に残す。
- **`feature_todo.md`「衝突判定の統一化」の4つの `hit` 語彙統一(弾の被弾/剛体接触/画面ピック/
  命中までの時間)は、今回まとめて行わない。** 同メモ自身が「実装より先に名前だけ動かさない —
  統合と同じ変更セットで4つまとめて決める」と明言しており、本書が統合するのは4つのうち
  **剛体接触(2)だけ**である(§1)。弾の被弾判定(1)・画面ピック(3)・命中までの時間(4)は
  今回動かさないので、命名統一もまだ行わない。

---

## 0.5. 直前ステップ(Step3)の後始末 — 本書に含める2つの実務

Step3(`for_agent.md` 旧版、8コミット `c9525c0..a2e37f0`)は完了しているが、
2つの未決事項を残している。**両方とも本書のフェーズに含める(Phase 1)。**

1. **空間インデックス(Phase 8)の要否がまだ実測されていない。** Step3 の `relevantAttractors`
   による位置依存の絞り込みは入ったが、`physics/spatial-grid.ts` は存在せず、ヘッドレス環境
   では高負荷状態まで駆動できず判断材料が無いまま止まっている
   (`better_simulation_todo.md` Step3 節)。**実測してから判断する、が結論を出さないまま
   放置してよい理由にはならない。** 本書の Phase 1 で実機計測を行い、決着させる。
2. **`memos/mikanixonable/SOLAR_SYSTEM_PLAN2_2026-08-09.md` の前提が Step3 で変わった。**
   同文書の EP0(重力窓の位置依存化)は Step3 が肩代わり済みだが、実装の中身が同文書の設計
   (`influenceRadius` という静的フィールド)とは異なる形(`relevantAttractors` — 実際の寄与
   そのものによる判定、静的半径を持たない)になった。C-2(`AttractorId` は閉じた union)・
   E-9(レジストリの記述量)の前提も、`AttractorId` が `string` へ開かれ `SolarSystemId` が
   `keyof typeof SOLAR_SYSTEM` から自動生成される形に変わったことで揺らいでいる。
   **`SOLAR_SYSTEM_PLAN2_2026-08-09.md` は mikanixonable のものなので、書き換えてよいかを
   ユーザーに確認したうえで行う。** 提案する修正内容は §4 Phase 1-B に具体的に書いた。

---

## 1. 到達点(成功基準)

1. **Step3 が残した空間インデックスの要否判断に決着がついている。** 実測して「悪化なし」なら
   `spatial-grid.ts` を作らないと明記して打ち切る。悪化があれば実装する。どちらでも
   `better_simulation_todo.md` から「未実測」という記述が消えている。
2. **剛体接触(自機・敵機・薬莢・デブリ・補給・小惑星・ベルトリンク)の撃力(impulse)計算が、
   `physics/` の純関数1つに一本化されている。** 現状 `game/simulation/collision.ts` の
   `resolveCollisionPair` に埋め込まれているベクトル演算(めり込み補正・法線・力積・
   反発後速度)を、質量・位置・速度・半径・反発係数だけを引数に取る純関数として
   `physics/` へ切り出す。`game/simulation/collision.ts` 側はこの関数を呼び、結果を
   `KinematicState` へ書き戻す(mutate)側だけを残す。
3. **接触ダメージが、閉じた速度のしきい値ではなく力積(質量×速度変化)から決まる。**
   現状の `Ship.applyCollisionDamage(speed)` は接触相手の質量を一切見ない — 薬莢
   (`CASING_MASS`)が衝突しても機体(`10000`kg級)が衝突しても、閉じた速度さえ同じなら
   同じ割合のダメージになる。力積(=質量×速度変化)を根拠にすることで、軽い物体との
   高速接触と重い物体との低速接触が物理的に正しく区別される。
4. **接触ダメージが、`Player`⇔`Enemy` の組だけでなく、`collides` を立てた任意の `Ship` と
   任意の相手の組で発生する。** 現状 `game.ts` の `onHighSpeedImpact` コールバックは
   `a === player && b instanceof Enemy` の形でしか撃力を消費しておらず、薬莢・デブリ・
   小惑星(Step3 で新設)が艦に衝突しても一切ダメージが発生しない
   (`game.ts:461-469` で実機確認済み)。艦が小惑星に高速で突っ込んでも今日は無傷という
   欠落を埋める。
5. **既存のゲームバランスが変わらないことを確認できている。** `COLLISION_DAMAGE_MIN_SPEED`/
   `_FULL_SPEED` を力積ベースの定数へ置き換える際、**艦同士の衝突(既存で唯一ダメージが
   発生していた組)のダメージカーブが従来と一致する**ことを回帰的に確認する(質量が
   ほぼ対等な相手同士の力積は速度にほぼ比例するので、艦同士に限れば旧式・新式は
   ほぼ同じ値になるはずであることを検算する)。
6. **弾の被弾判定(`HitSystem`/`Bullet.damage`)と天体表面接触(`hitCelestialBody`)は、
   意図的にこの統合の対象外のまま残る。** 理由は §2-2 に明記する。

---

## 2. 設計判断

### 2-1. Phase 8 ゲート — 空間インデックスは実測してから判断する(Step3 からの継続方針)

Step3 の `for_agent.md` §2-11 が定めた判断手順(位置依存の絞り込み導入後に大量配置で実測 →
悪化があれば実装、なければ打ち切り)をそのまま踏襲する。**新しい判断基準は導入しない** —
基準を変えると Step3 の実装が何を検証したことになるのか分からなくなる。実測方法・実装内容が
必要になった場合の設計(`physics/spatial-grid.ts` の形)は旧 `for_agent.md`(git 履歴、
コミット `a2e37f0` 時点のもの)の §2-11・Phase 8 にそのまま残っているので、悪化が見つかった
場合はそこを参照して実装する(本書では再掲しない — 既に一度書かれた設計を複製しない)。

### 2-2. 統合するのは「剛体接触の撃力計算」だけ。弾の被弾判定と天体表面接触は対象外

`feature_todo.md`「衝突判定の統一化」は「弾にせよデブリにせよ小惑星にせよ、剛体シミュレー
ションとして一般化してから、大気やガス惑星、プラズマ弾といった非剛体を後から考慮する」
という順序を明言している(§目標にも同じ一文がある)。この順序に従い、本書は**剛体どうしの
接触**(自機・敵機・薬莢・デブリ・補給・小惑星・ベルトリンク — いずれも球で近似され、
`GameEntity.collides`/`radius`/`mass` を持つ)だけを対象にする。次の2つは意図的に対象外。

- **弾の被弾判定(`HitSystem.checkBulletHits` → `Ship.attacked`)。** 弾のダメージ
  (`Bullet.damage`)は撃った側の武器の性能値であり、弾自身の運動エネルギーから物理的に
  導かれる量ではない(現に軽いプラズマ弾と重い実体弾が同じダメージテーブルに乗る)。
  これは**ゲームデザイン上の武器バランス**であって物理量ではないので、剛体接触の力積に
  混ぜると武器バランスの数値的根拠が消える。統合するなら「弾のダメージを武器スペックから
  力積ベースへ置き換える」という独立した、影響の大きいゲームデザイン判断が要る —
  本書はそれを勝手に決めない。
- **天体表面接触(`hitCelestialBody` → 大気再突入・小惑星表面への沈み込み)。** これは
  §目標が明示する「非剛体」(大気)の領域そのものであり、閾値ベースの二値判定
  (めり込んだら即座に消滅/再突入)を今回力積ベースへ置き換えると、大気圏突入の物理モデル
  (`thermal.ts` の動圧・空力加熱)まで踏み込むことになる。**§目標の順序どおり、非剛体は
  後回しにする。**

したがって本書が扱う「衝突」は、`game/simulation/collision.ts` の `CollisionPhysics.resolve`
が既に一元的に扱っている集合(`collides` を立てた全 `GameEntity`)と完全に一致する —
**新しい参加者を増やすのではなく、既に参加している者たちの撃力の使われ方を直す。**

### 2-3. 撃力計算そのものは既に `physics/` 的に純粋な形をしている — 抽出するだけでよい

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

### 2-4. ダメージは「力積 / 自分の質量」(= 自分が受ける速度変化)を根拠にする

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
衝突でしか発生していなかったので、艦同士の質量比を使って ` MIN_DV ≈ MIN_SPEED × (相手側の
質量比の実効値)` を逆算し、**艦同士の衝突ダメージカーブが従来と数値的に一致する**ように
新定数を決める(Phase 3 の受入条件)。

### 2-5. `game.ts` のコールバックを「衝突した Ship 側全員」へ一般化する

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

### 2-6. `Asteroid`(Step3)・`Base`・`Ammo` は「衝突される側」の質量供給者としてだけ関わる

`Asteroid`/`Base`/`Ammo` は `Ship` を継承しないので `collidedByImpulse` を持たない —
これらに艦がぶつかっても、これら自身は今までどおり無傷(ダメージという概念を持たない)
のまま、**相手の `Ship` 側にだけ**ダメージが生じる。これは意図した非対称であり
(小惑星は撃墜されないが、艦は小惑星に当たれば壊れる)、新しい分岐は要らない —
§2-5 の一般化コールバックが `a instanceof Ship`/`b instanceof Ship` をそれぞれ独立に
判定する時点で自動的にこの非対称性になる。

---

## 3. 完成後のモジュール構成

| ファイル | 変更内容 |
|---|---|
| `src/physics/collision-response.ts`(新規) | `resolveCollision(...)`(§2-3)。`game/simulation/collision.ts` の `resolveCollisionPair` から反発計算部分を抽出した純関数。`Vec3`/`KinematicState` のみに依存 |
| `src/game/simulation/collision.ts` | `resolveCollisionPair` を `resolveCollision` の呼び出し + `state` 書き戻しだけの薄いラッパへ縮小。`resolveCollisionPairs`(総当たり・薬莢/ベルト特例)は現状のまま。戻り値を `speed` から `impulse` へ変更し、`onHighSpeedImpact` へ渡す |
| `src/game/game-entity/ship.ts` | `applyCollisionDamage(speed)` を `applyCollisionDamage(dv)`(自分が受けた速度変化基準、§2-4)へ書き換え、`collidedByImpulse(dv, simTime, activeStage)` を基底に追加(`Player`/`Enemy` の既存 `collidedAtSpeed` を統合できる範囲で統合) |
| `src/game/player/player.ts`・`game-entity/enemy.ts` | `collidedAtSpeed` を削除(基底の `collidedByImpulse` に統合)、または `Player` 固有処理だけを残したオーバーライドにする |
| `src/game/game.ts` | `simulator.advance` の `onHighSpeedImpact` コールバックを §2-5 の対称形へ書き換え |
| `src/game/const.ts` | `COLLISION_DAMAGE_MIN_SPEED`/`_FULL_SPEED` を `COLLISION_DAMAGE_MIN_DV`/`_FULL_DV`(§2-4)へ置き換え |
| `tests/physics/collision-response.test.ts`(新規) | `resolveCollision` の単体テスト(§4 Phase 2 に列挙) |
| `memos/hedalu244/better_simulation_todo.md` | Phase 1 の実測結果と判断(§0.5-1)、Step4 完了の記録 |
| `memos/mikanixonable/SOLAR_SYSTEM_PLAN2_2026-08-09.md` | **ユーザーの許可を得てから**、EP0/C-2/E-9/E-13 の前提を Step3 の実装結果に合わせて書き直す(§0.5-2、§4 Phase 1-B) |

---

## 4. フェーズ別手順

### Phase 1 — Step3 の後始末(空間インデックスの実測判断 + PLAN2 への提案)

**1-A. 空間インデックスの実測判断(§0.5-1)。**

1. `StageDebug` に一時的なデバッグコードで `Asteroid` を数百〜数千体、ランダムに散らして
   配置する。
2. `npm run dev` を実機で起動し `?perf=1` を付け、update フェーズ ms を計測する。
3. **有意な悪化が無ければ**、`physics/spatial-grid.ts` を実装せずここで打ち切り、
   `better_simulation_todo.md` の該当記述を「実測済み・空間インデックス不要と判断」に
   書き換える。実測値を記録として残す。
4. **有意な悪化がある場合のみ**、旧 `for_agent.md`(コミット `a2e37f0` の内容、`git show
   a2e37f0:memos/hedalu244/for_agent.md` で参照できる)§2-11・Phase 8 の設計
   (`physics/spatial-grid.ts` の一様グリッド + 27近傍列挙、判定式は変えず前段の候補削減
   だけを行う)をそのまま実装する。

**1-B. `SOLAR_SYSTEM_PLAN2_2026-08-09.md` への提案(§0.5-2)。**

**まずユーザーに、この文書を書き換えてよいか確認する。** 許可が得られたら、次の3点を
Step3 の実装結果に合わせて修正する(許可が得られなければ、このフェーズは実施せず
`for_agent.md` に「ユーザー未許可のため保留」と記録して次フェーズへ進む):

- **EP0 の状態を「完了(Step3 が肩代わり)」に更新**し、実装が採った設計
  (`influenceRadius` という静的フィールドではなく、`physics/attractor.ts` の
  `relevantAttractors` が `attractorAccel` の実際の値としきい値 `GRAVITY_NEGLIGIBLE_ACCEL`
  を比較する動的な絞り込みであること)を反映する。
- **C-2「天体IDは閉じた文字列リテラル union」の前提を更新**する。`AttractorId` は
  `string` に開かれ、`SOLAR_SYSTEM`(具体レジストリ)側が `keyof typeof SOLAR_SYSTEM` で
  27個のリテラル union を自己生成する形に変わった。第2次計画が86体へ拡張する作業は、
  この形のままレジストリにエントリを足すだけで良いことを明記する。
- **E-9・E-13 の記述を、`influenceRadius` を前提にした部分だけ更新**する
  (E-13 が要求する「3経路が同一の重力源集合を選ぶ」という正しさの要件そのものは
  `relevantAttractors` で既に満たされているので、要件は変えず実装手段の記述だけ直す)。

**検証:** 1-A はコード変更を伴う場合のみ `npm run typecheck`/`test:physics`。1-B は文書のみ。

---

### Phase 2 — 撃力計算を `physics/collision-response.ts` へ抽出

**2-1.** `game/simulation/collision.ts` の `resolveCollisionPair`(`:82-141`)を読み、
めり込み補正・`sweptSphereToi` 併用・法線・反発後速度・力積の計算部分をそのまま
`physics/collision-response.ts` の `resolveCollision(...)` へ移す(§2-3 の型)。
**数式は一切変えない** — 移動のみ。

**2-2.** `game/simulation/collision.ts` の `resolveCollisionPair` を、`resolveCollision` を
呼んで結果を `a.state`/`b.state` へ書き戻すだけの薄いラッパへ書き換える。戻り値を
`speed: number | null` から `impulse: number | null` に変える(`resolveCollision` が返す
`CollisionResponse.impulse`、反発しなかった場合は `null`)。

**2-3.** `resolveCollisionPairs`・`resolve` の `onHighSpeedImpact` の型注釈を
`(a: GameEntity, b: GameEntity, impulse: number) => void` へ変える。呼び出し条件
(`speed >= COLLISION_DAMAGE_MIN_SPEED`)は Phase 3 で `Δv` ベースへ直すまで一時的に
`impulse` に対する暫定しきい値のままでよい(Phase 3 で正式なしきい値に差し替える)。

**2-4.** `tests/physics/collision-response.test.ts` を新設し `tests/physics/index.ts` へ
登録する:

- **運動量保存:** 反発後の `mA·vA + mB·vB` が反発前と一致する(浮動小数点誤差の範囲で)。
- **エネルギー損失と反発係数の関係:** `restitution = 1`(完全弾性)で運動エネルギーが
  保存され、`restitution < 1` では単調に損失することを確認する。
- **力積の質量依存性:** 同じ閉じた相対速度でも、質量比が違えば `impulse` は同じだが
  `impulse / mass` (Δv) は質量に反比例して変わることを確認する(§2-4 の根拠そのものの検算)。
- **既存 `swept-sphere.test.ts` との整合:** `sweptSphereToi` を内部で使う経路(高速接触)が
  既存のテストと矛盾しないこと。
- **回帰:** `resolveCollision` を直接呼んだ結果が、Phase 2 着手前の `resolveCollisionPair`
  をその場でモンキーパッチして得た結果(または着手前にコミットした値)とビット単位で
  一致することを一時的なテストコードで確認してから削除する(数式を変えていないことの
  最終検算 — 恒久テストとしては残さない)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で既存ステージ
(0/1/2/00)を触り、艦同士・薬莢・デブリ・補給の反発が今までどおり(見た目上)動くことを
確認する。

---

### Phase 3 — ダメージを `Δv` ベースへ一般化し、`Ship` 全般へ配線する

**3-1.** `game/const.ts` の `COLLISION_DAMAGE_MIN_SPEED`/`_FULL_SPEED`(`:419` 付近)を
`COLLISION_DAMAGE_MIN_DV`/`_FULL_DV` へ置き換える(§2-4)。値は「艦同士(質量比 ≈ 1000:10000)
の衝突で、旧しきい値 50 m/s と同じ閾値になる」ように逆算する — 艦同士の場合
`Δv = impulse/mass` は旧来の `speed = |vn|`(閉じた相対速度)と一致しないので、旧テストの
シナリオ(艦2隻がその速度で正面衝突)を再現して数値を合わせる。

**3-2.** `Ship.applyCollisionDamage(speed: number)`(`ship.ts:96-102`)を
`applyCollisionDamage(dv: number)` へ書き換え、`COLLISION_DAMAGE_MIN_DV`/`_FULL_DV` を使う
形にする。

**3-3.** `Player.collidedAtSpeed`(`player.ts:297`)/`Enemy.collidedAtSpeed`
(`enemy.ts:186`)を読み比べ、共通部分を `Ship` 基底の `collidedByImpulse(dv, simTime,
activeStage)` へ引き上げる。`Player` 固有の処理(存在すれば)は基底呼び出し後に追加で行う
薄いオーバーライドとして残す。

**3-4.** `game.ts:458-470` の `onHighSpeedImpact` コールバックを §2-5 の対称形へ書き換える:

```ts
(a, b, impulse) => {
  if (a instanceof Ship) a.collidedByImpulse(impulse / a.mass, this.simulator.simTime, this.activeStage);
  if (b instanceof Ship) b.collidedByImpulse(impulse / b.mass, this.simulator.simTime, this.activeStage);
},
```

`Ship` は `player.ts`/`enemy.ts` の両方が import 済みの基底なので、`game.ts` 側の import は
`Enemy` から `Ship` へ差し替わる(あるいは両方使うならそのまま追加)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で:

- **既存の艦同士の衝突ダメージが従来と同程度であること**(3-1 の逆算が効いているかの
  実地確認 — 数値ログを一時的に仕込んで前後比較してもよい)。
- **薬莢・デブリ・小惑星(Step3 の `StageDebug` 配置)が艦に高速で衝突すると、艦がダメージを
  受けること**(§1 の到達点4 — 現状無かった挙動)。
- **薬莢どうし・デブリどうしの接触では相変わらずダメージが発生しない**こと(`Ship` でない
  もの同士は HP という概念自体を持たないため、当然の帰結であることを確認するだけ)。
- 排莢直後の薬莢が自機のダメージ原因にならない程度の低速であること(`Δv` が
  `COLLISION_DAMAGE_MIN_DV` を十分下回ること)。

---

### Phase 4 — 設計文書の更新

同じ変更セットに含める(`/develop-docs`):

- **CLAUDE.md** — `game/simulation/collision.ts` の項に `physics/collision-response.ts` への
  分割を反映。`Ship` の項に `collidedByImpulse`/`applyCollisionDamage(dv)` を反映し、
  `collidedAtSpeed`(旧名)の記述を置き換える。`physics/` の一覧に
  `collision-response.ts` を追加。
- **DEVELOP/CALLSTACK.md** — `Simulator.advance` → `CollisionPhysics.resolve` →
  `onHighSpeedImpact` の呼び出し形が `speed` から `impulse` へ変わったことを反映。
- **DEVELOP/OWNERSHIP.md** — 変更なしのはず(状態の所有構造は変わらない)だが、念のため
  確認する。
- **DEVELOP/SPEC.md** — §16「実装される可能性のある機能」に、今回対象外とした2点
  (弾の被弾ダメージを武器スペックから力積ベースへ置き換えること、天体表面接触の力積化
  = 非剛体の大気圏突入モデルへの統合)を追記する。
- **`memos/hedalu244/feature_todo.md`** — 「衝突判定の統一化」の記述を、剛体接触分は
  完了したことが分かるよう書き直す(経緯は残さない)。弾の被弾判定・画面ピック・命中までの
  時間の統一(hit 語彙の統一含む)は、まだ未着手の残タスクとして明記して残す。
- **`.claude/skills/refactor-fixed/SKILL.md`** — 剛体接触の撃力計算が `physics/` に
  切り出されたことを、§4(`physics/`/`render/`/`game/` の境界)の実例として追記する
  (既存の記述と重複しないように整合させる)。
- **`memos/hedalu244/better_simulation_todo.md`** — Step4 の記述を「実装済み」に書き直す。
- 大きな変更なので、最後に `/comment-cleanup` で新旧コメントを一括点検する。

**検証:** `npm run typecheck`。

---

### Phase 5 — 変更セットの `/refactor`・`/refactor-fixed` 違反点検

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
   (§2-6 — これらは `Ship` を継承しないので、艦にぶつかっても自分自身は無傷のままが正しい)。
6. **弾の被弾判定(`HitSystem`/`Ship.attacked`)・天体表面接触(`hitCelestialBody`)に、
   今回の力積計算が混入していないか**(§2-2 で明示的に対象外とした境界)。
7. **`hit` 語彙のリネームが混入していないか**(§0 — 今回は剛体接触だけの統合であり、
   4つの `hit` 概念のうち他の3つの名前には触れないはず)。
8. §3 の表にある全ファイルの diff を見て、コメントの過不足(`/comment` 基準)を個別に点検する。

レビューで見つかった問題はこの変更セットの中で修正する。修正後、
`npm run typecheck` / `npm run test:physics` が green であることを再確認して完了とする。

---

## 5. 落とし穴チェックリスト

1. **`impulse` と `dv`(Δv)を同じ変数名・同じ意味で扱ってしまうと、質量の違う相手との
   接触が物理的に区別されなくなる**(§2-4 の根拠そのものが失われる)。`game.ts` の
   コールバックで必ず `impulse / a.mass` / `impulse / b.mass` と、受け取る側の質量で
   個別に割ること。
2. **`resolveCollision` の抽出時、`sweptSphereToi` を使う経路(高速接触)と、めり込み補正
   経路のどちらか片方だけを移してしまわないこと。** 両方が同じ関数内で分岐している
   (`collision.ts:103-127`)。
3. **`COLLISION_DAMAGE_MIN_DV`/`_FULL_DV` を「旧 `_MIN_SPEED`/`_FULL_SPEED` と同じ数値」に
   単純コピーしないこと。** `dv = impulse/mass` は `speed`(閉じた相対速度そのもの)とは
   次元は同じでも値が違う(質量比・反発係数に依存する)。艦同士の衝突シナリオで実際に
   逆算すること(Phase 3-1)。
4. **`Ship.collidedByImpulse` を艦以外(`Asteroid`/`Base`/`Ammo`/`DebrisPiece`)に生やさない
   こと。** これらはダメージという概念を持たない(HP フィールドが無い)ので、
   `instanceof Ship` の判定より内側に何かを追加する必要はない。
5. **弾の被弾ダメージ(`Bullet.damage`)や天体表面接触の閾値(`hitCelestialBody` の
   `margin`)を、今回の力積計算に合わせて変更しないこと。** §2-2 で明示的に対象外とした。
6. **Phase 1-A の実測を省略して Phase 8 の要否を「たぶん要らない」で済ませないこと。**
   Step3 が実測できずに持ち越した理由(ヘッドレスでは高負荷を再現できない)は今回も
   変わらないので、実機での計測が必須。
7. **`SOLAR_SYSTEM_PLAN2_2026-08-09.md` をユーザーの許可なく書き換えないこと。** §0.5-2・
   Phase 1-B のとおり、まず確認を取ってから行う。

---

## 6. このステップでやらないこと

- **弾の被弾判定(`HitSystem`/`Ship.attacked`)を力積ベースへ置き換えること。** §2-2 —
  武器ダメージはゲームデザイン上の数値であり、置き換えるなら独立したバランス調整の判断が要る。
- **天体表面接触(`hitCelestialBody`)を力積ベース・非閾値の判定へ一般化すること。** §2-2 —
  §目標が「非剛体は後で」と明言している大気圏突入モデルの領域そのもの。
- **`hit`/`collision` 命名の統一(feature_todo.md が挙げる4つの意味の統合)。** 剛体接触
  以外の3つ(被弾・画面ピック・命中までの時間)を今回統合しないため、命名もまだ動かさない。
- **空間インデックスの実装そのもの。** Phase 1-A の実測で悪化が確認された場合のみ実装する
  (判断が先、実装は条件付き)。
- **`memos/mikanixonable/SOLAR_SYSTEM_PLAN2_2026-08-09.md` の EP1〜EP8(天体86体化・形状・
  環・点群の拡張)。** あちらの担当範囲であり、本書は EP0 の前提更新(ユーザー許可制)
  だけを扱う。
- **`refactoring_todo.md` の他の項目**(sfx/bgm 分離、belt-physics の変換処理見直し、
  const.ts 解体等)。今回の変更セットとは無関係。

---

## 7. フェーズごとの検証コマンド

```
npm run typecheck          # 全フェーズで必ず
npm run test:physics       # physics/ を触る Phase 2 で必ず
npm run dev                # Phase 2 以降、目視確認
npm run dev + ?perf=1      # Phase 1-A の実測(実機必須、ヘッドレスでは高負荷を再現できない)
```

**着手前に Phase 1-A の実測を済ませておくこと。** これが無いと空間インデックスの要否が
いつまでも「未決」のまま Step5 以降へ持ち越されてしまう。
