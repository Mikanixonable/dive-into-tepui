# Step 4 実装手順 — 万有引力シミュレーションの真の完成

`goal.md` の§目標が掲げる「一般化された(正確で、拡張性があり、パフォーマンス的にも問題のない)
万有引力シミュレーター」は概ね形になっているが、現状調査とユーザーのフィードバックで、
**モデルの表現力が固定値で狭められており、重力源の判定基準が二重で、予測経路が物理的に不正確で、
性能のためだけの絞り込みが重力経路に残っており、オーダーを下げる手当てが入っておらず、実際にパフォーマンス上の問題が出ている**ことが
分かった。本書はそれらすべてと、文書の同期を決着させる。
**本書の完了をもって万有引力シミュレーターが理想形として完成していることが到達目標となる。**
衝突判定シミュレーションの改善は `step5.md` の担当範囲であり、本書では原則触れないが、空間ハッシュの導入で部分的に改善される。
着手前に、必ず `goal.md` を参照し、目的を理解しながら行うこと。

**フェーズは作業範囲と変更リスクの小さい順に並べてある。** Phase 1 → 10 の順で進めること。
**Phase 10 で本書自身を削除する** — 完了済みステップの残骸を保守しないための運用(§4 Phase 10)。

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

- **完了したステップの指示書は保守しない。** 本書も Phase 10 で削除し、次ステップ以降で対処する
  予定の無い残タスクだけを `backlog.md` へ移す(§4 Phase 10)。したがって**本書は他ステップの
  指示書を参照しない** — 参照先が消えるため。生き続ける一次情報は `goal.md`・`backlog.md`・
  `CLAUDE.md`・`DEVELOP/` だけである。
- **剛体衝突シミュレーションの一般化(接触の判定式・撃力の解決)と、天体表面への接触判定
  (`hitAttractor`/`hitCelestialBody`)を重力の関心事から接触の関心事へ移す作業は `step5.md` の
  担当範囲。** 本書が `game/simulation/collision.ts` に入れるのは **ペア候補の列挙を全ペア走査から
  空間ハッシュへ置き換えること**だけで、接触したかどうかの判定式にも、その結果の解決にも触れない
  (§2-7)。`src/physics/attractor.ts` も両書が触るが、触る関数が別(本書は `relevantAttractors` の
  削除、`step5.md` は `hitAttractor`/`hitCelestialBody` の移動)。**同じファイルを触るので、本書と
  `step5.md` は同時並行にしない** — 本書を先に終える。
- **ユーザーのフィードバックで対象外と確定したもの**(解析天体への反作用、外乱のプラグイン化)は
  §6 に列挙してある。

---

## 1. 到達点(成功基準)

1. **`GameEntity` が `degree2`/`isStar` を派生クラスで指定できる。** `Attractor` として通すためだけの
   `readonly` 固定値が消えている(Phase 1)。
2. **質量から μ を導く配線が `GameEntity` 側にあり、`Asteroid` はその利用者の1つでしかない。**
   「動的な重力源であること」がクラスに縛られていない(Phase 2)。
3. **小惑星が扁平重力(`degree2`)を持てる。** 自転極は自身の姿勢から導かれている(Phase 3)。
4. **`relevantAttractors` がコードから消えている。** 3つの重力積分経路(実積分・予測・軌道計画)は、
   `Ephemeris` の天体一覧(と小惑星の合流結果)をそのまま `stepDynamics` へ渡す。
   `grep -rn "relevantAttractors" src tests` が0件(Phase 4)。
   `GRAVITY_NEGLIGIBLE_ACCEL` も Phase 4 の時点では0件になり、**Phase 7 で空間ハッシュの
   軽重分類のために1箇所だけ再導入される**(§2-7)。位置ごとの絞り込みとしては復活しない。
5. **`gravitySource` がコード・文書から完全に消え、「重力源か」の判定が `mu !== 0` に一本化されている。**
   `Ephemeris` の重力窓と全天体窓が1つになっている。
   `grep -rn "gravitySource" src tests memos DEVELOP CLAUDE.md` が0件(Phase 5)。
6. **予測経路が動的重力天体を凍結しない。** 予測先端の時刻の状態を引き、得られなければ
   その天体を重力源から落とす(Phase 6)。
7. **27近傍の空間ハッシュ(`physics/spatial-grid.ts`)が存在し、万有引力の重力源列挙と衝突判定の
   ペア列挙の両方がそれを通っている。** 高負荷を常時再現できるデバッグステージが配線され、
   実装前後の実測値が §8 に記録されている(Phase 7)。
8. **`memos/mikanixonable/SOLAR_SYSTEM_PLAN2_2026-08-09.md` の前提が、現在の実装と一致している。**
   ユーザーの許可が得られなかった場合は、`backlog.md` に「ユーザー未許可のため保留」と
   記録することをもって完了とする(Phase 8)。
9. **設計文書(`CLAUDE.md` / `DEVELOP/`)が実装結果に同期している**(Phase 9)。
10. **残タスクが `backlog.md` へ移り、本書が削除されている**(Phase 10)。

---

## 2. 設計判断

### 2-1. `GameEntity` の `degree2`/`isStar` は固定値を持たない(Phase 1)

`readonly degree2: null = null` / `readonly isStar = false` は、`Attractor` として通すためだけの
固定値であってモデル上の根拠が無く、**不必要に表現力を狭めている**。型を
`Degree2Gravity | null` / `boolean` へ広げる(既定値は据え置きなので挙動不変)。

動的な恒星は将来の3連星系のために**可能性だけ残し、今は配線しない**。`isStar` を立てる
派生クラスは本書では作らない。

### 2-2. 「動的な重力源であること」はシミュレーションの形式であって、小惑星であることではない(Phase 2)

質量から `mu = G·mass` を導く配線が `Asteroid` のコンストラクタに埋まっているので、
`GameEntity` 側へ移す。任意の派生クラス(将来の基地・大型艦・動的な恒星など)が重力源になれる。

**ただし既定は `mu = 0` のままにする。** 全エンティティが自動的に重力源になると
`EntityManager.attractors()` が薬莢の数だけ膨らみ、重力の加算そのものが O(N·M) で N = M = 全
エンティティ数、つまり O(n²) になる。「質量を持つこと」と「重力源として配列に載ること」を
別の宣言のままにし、後者を `setGravitatingMass` の呼び出しで明示する。
**判定そのものは `mu !== 0` の一本のまま。**

### 2-3. 小惑星の扁平重力の極は、小惑星自身の姿勢から導く(Phase 3)

小惑星が球でないのは自然なので、`degree2` を持てるようにする。極は `att.q` でモデル +Y を
回した向き、長軸は +Z を回した向き(`body-orientation.ts` の `spinOrientation` と同じ約束)。
**新しい数式は書かない** — `attitude.ts` の `qRotate` を使うだけにする。

小惑星は `Simulator.stepAttitudes` の対象に含まれていない(players/enemies/casings/debris/ammos のみ)
ため、姿勢は構築時から変わらない。したがって `degree2` は**構築時に1度組んでフィールドに格納する**
(getter にすると RK4 の各ステージ × 全エンティティで極ベクトルを組み直すことになる)。

### 2-4. `relevantAttractors` を削除する — 定数倍の高速化のために重力経路を長大化させない(Phase 4)

天体数を N、エンティティ数を M とすると、重力の加算そのものが O(N·M)、`relevantAttractors` に
よる絞り込みも各エンティティごとに全天体の寄与を評価するので O(N·M)。しかも絞り込みが評価する
`attractorAccel` は、加算で使う式そのものと同じ重さである。**絞り込みは加算のオーダーを下げて
いない** — 下げているのは加算側の定数倍だけで、万有引力の式はそもそも特段重い計算ではない。
この定数倍のために重力経路の実装が長大化するのは割に合わない(§0 の優先順位: 実装の適切さ >
実行時パフォーマンス)。**オーダーを実際に下げるのは空間ハッシュだけであり、それは Phase 7 で
実装する**(§2-7)。

削除によって、次の3点が同時に解消する:

- **しきい値による不連続が消える。** 現在は天体が候補を出入りする瞬間に加速度が
  `GRAVITY_NEGLIGIBLE_ACCEL`(1e-10 m/s²)まで跳ぶ。RK4 の打ち切り誤差に埋もれるという前提で
  選ばれた値だが、近似が1つ減るので §0 の第1優先(物理的正確さ)にも沿う。
- **`Simulator.substep` の2相構造が不要になる。** 「全エンティティぶんの絞り込みを先に確定してから
  積分する」という前段(`attractorsPerEntity`)は、絞り込みがなければ発生しない。相互重力の対称性
  (処理順依存の排除)は、重力源配列を基準時刻で1回だけ組むことが引き続き担う。
- **`strongestAttractor` に空配列が渡る経路が消える。** 絞り込み結果が空になると
  `attractors[0]!` が `undefined` になる。

**絞り込んだ配列は重力の加算だけでなく、刻み幅とサンプル間隔の決定
(`localOrbitPeriod` → `strongestAttractor`)にも流れている**(`GameEntity.sampleInterval`、
`Predictor.advanceBudget`、`PlanArc.stepDt`)。削除するとこれらは絞り込み前の完全な配列を
見ることになるが、最も強く引く天体は定義上しきい値を下回らないので、結果は変わらないか
より正しくなる。

一方で、**絞り込みが消えても「3経路が同一の重力源集合を見る」という要件は消えない** — 集合を
決めるのが `Ephemeris` の天体一覧と `game/simulation/` の合流規則だけになる。実積分・予測は
小惑星を合流させ、`PlanArc` は合流させないという既存の差もそのまま残る(本書では変えない)。

### 2-5. `gravitySource` は廃止し、`mu !== 0` へ一本化する(Phase 5)

`gravitySource` は概念として `attractor` の同義語であり、**「同じものを別の名前で表さない」
原則に反する**。また、このフラグのせいで「重力源か」の判定基準がレジストリ天体(静的フラグ)と
`GameEntity`(`mu !== 0`)で二重になっている。廃止し、**全て `mu !== 0` で判定する**。

これにより `Ephemeris.gravityAttractorsAt` は `attractorsAt` と完全に同じものになるので、
**重力窓を削除して全天体窓に一本化する。** 重力積分が見る天体は5体から27体へ増えるが、
これは Phase 4 と同じ判断(性能のためだけの絞り込みを重力経路に持たない)の帰結である。
天体数の増加そのものへの答えは Phase 7 の空間ハッシュが担う(§2-7)。

GUI 用途(座標系一覧・基準天体一覧)の絞り込みは物理とは別の問いなので、フラグ自体は残すが
実態に合う名前(`navigationReference` — 「プレイヤーが軌道の基準・座標系として選べる天体」)へ
改める。値の集合は現行の `gravitySource` と同じ(earth/moon/jupiter/saturn/sun)で、GUI の見え方は
変わらない。`lagrangeLabels` とは別フラグのままにする(sun のぶんだけ対象が違う)。

重力窓という区別が消えるので、`game/simulation/gravity-attractors.ts` のモジュール名・関数名からも
`gravity` を落とす(`game/simulation/attractors.ts` の `attractorsAt(ephemeris, entities, t)`)。

### 2-6. 予測経路は「凍結」をやめ、「知らないなら足さない」形へ(Phase 6)

現状 `Predictor.update` は動的重力天体を**現在の実状態に固定**して予算パス中使い回している。
1年先の予測先端に対しても小惑星が今の位置に静止していることになり、**物理的に不正確**。

予測先端の時刻 `t` に対して各動的重力天体の `displayState(t)` を引き、**得られなければその天体を
重力源から落とす**。遠い未来ほど重力源が減るという別の近似になるが、**こちらは物理的に嘘を
つかない**(知らないから足さない)ので採る。

**実積分(`Simulator.substep`)はこの形にしない。** あちらの `t` はサブステップ中点で現在時刻の
直後なので、`displayState(t)` はまだ伸びていない予測列を引きに行ってしまい、小惑星が
自分のシミュレーションから落ちる。実積分用と予測用で別の関数に分ける。

`PlanArc` は元から動的重力天体を混ぜない(=考慮しない)ので、この形と整合する — **変更しない。**

### 2-7. 27近傍の空間ハッシュを、万有引力と衝突判定の共有モジュールとして実装する(Phase 7)

**実測できるかどうかに関わらず実装する。** 万有引力は引力を受けるものを M、及ぼすものを N として
O(N·M)、剛体接触のペア走査は参加エンティティ n に対して O(n²) であり、これは実測を待つまでもなく
構造から読める。**構造上明らかに予測できるオーダー改善は、実測の可否を条件にしない**
(`/refactor-fixed` の判断基準)。実機では既に、重力源となる小惑星を多数配置した時点で重くなることが
確認されている。

**ただし実装するにしても、実測と効果の確認は行う。** そのために**高負荷を常時再現できる環境を
先に整える**(Phase 7 の手順 1・2)。

#### モジュール — `physics/spatial-grid.ts`(汎用)

位置を持つ任意の要素に対する一様グリッドへの登録と、ある点の27近傍セルに属する要素の列挙を行う
純関数群。**`Attractor` にも `GameEntity` にも依存しない** — セルサイズは呼び出し側が引数で渡す。
万有引力と衝突判定の両方が使うので、どちらかの都合(重力の寄与、接触半径)をモジュールに
持ち込まない。`physics/` に置くのは `physics/deque.ts` と同じ理由 — 物理そのものではない汎用の
データ構造だが、純粋・DOM 非依存で `test:physics` の対象になるものはここに集める。

#### 万有引力側 — 軽い天体をグリッドに載せ、重い天体は常に含める

セルサイズ(= 近傍とみなす半径)を R とすると、**27近傍だけを候補にするということは、R 以上
離れた天体を無視するということ**である。したがって分類の問いは1つしかない:
**その天体は、R 離れた地点で無視してよいほど軽いか。**

**分類は `mu` だけで決める。配列の出自(解析天体か動的重力天体か)は一切見ない。**

```
mu >= GRAVITY_NEGLIGIBLE_ACCEL * R²   → 常に含める(グリッドに載せない)
それ以外                              → グリッドに載せ、27近傍のときだけ含める
```

左辺と右辺は「距離 R における引力 `mu / R²` がしきい値を超えるか」を書き換えただけで、
**新しい判定基準を発明していない**。出自で分類してはならない理由は2つあり、どちらも将来ではなく
今日の要件である: **レジストリ天体の個数は可変で軽い天体が登録されうる**(`SOLAR_SYSTEM` は既に
彗星核・小惑星まで抱えており、第2次計画は86体へ拡張する)し、**動的重力天体が十分に重いことも
ありうる**(`GameEntity` が `setGravitatingMass` で任意の質量を持てるのが §2-2 の目的そのもの)。

したがって `game/const.ts` の定数は2つ:

- `GRAVITY_GRID_CELL_SIZE`(= R)
- `GRAVITY_NEGLIGIBLE_ACCEL` — **Phase 4 で削除したものを、ここで1つだけ再導入する。**
  値も名前も同じ(1e-10 m/s²)で、**別名を与えない**。Phase 4 が消したのは「各エンティティの
  位置で全天体の寄与を評価する」という*使い方*(O(N·M) の前段で、加算のオーダーを下げないまま
  実装だけを長大化させていた)であって、「何を無視してよいか」という判断そのものではない。
  ここでの使い方は1天体につき1回の分類であり、O(N·M) を O(M·k)(k = 近傍セル内の天体数)へ
  落とす。**オーダーを下げる対価があるかどうかが両者の分かれ目**であり、§0 の優先順位を
  破っていない。

**「R より遠い軽い天体の引力は足さない」という近似であることを、分類を行う関数のコメントに
限界として明記する。** 判定が押さえているのは直達項 `mu / R²` であり、落とした天体の ECI 原点
補正項 `mu / d²`(d = その天体の原点からの距離)は d > R である限りそれより小さい。

**グリッドは substep ごとに、合流済みの重力源配列から1回だけ組む。** 全エンティティが同じグリッドを
読むことが、重力天体どうしの相互作用が処理順に依存しないことを引き続き担保する(§2-4)。
軽い天体どうしの相互作用は27近傍が対称なので(A が B の27近傍にあるなら B も A の27近傍にある)
食い違わない。重い天体と軽い天体の間は非対称になる(軽い側は常に重い側を感じ、重い側は R の外の
軽い側を落とす)が、**落としているのはしきい値以下と判定した量そのもの**なので、これは近似の
定義であって取りこぼしではない。

#### 衝突判定側 — 同じモジュールでペア候補を列挙する

`CollisionPhysics.resolveCollisionPairs` の全ペア二重ループを、グリッドの27近傍列挙へ置き換える。
**こちらのセルサイズは近似ではなく、列挙の結果は全ペア走査と完全に一致させる。** そのために
セルサイズは次の2つの和の最大値以上を、参加者を1度舐めて毎フレーム求めて渡す:

- **`radius` の最大値の2倍** — 重なり判定(`distSq < (rA+rB)²`)が拾う距離。
- **`state.r - prevState.r` の長さの最大値の2倍** — `resolveCollisionPair` は最終位置が離れていても
  直前 substep の線分どうしで `sweptSphereToi` を引く。**現在位置だけをグリッドに登録するので、
  移動ぶんを足さないと、線分では接触しているのに現在位置が27近傍の外にあるペアを取りこぼす。**
  高速な薬莢・弾片ほど効く項なので、`radius` だけでセルサイズを決めない。

接触の判定式・撃力の解決は一切変えない(そこは `step5.md` の担当 — §0)。ペアを二重に処理しない
よう、列挙側で片方向だけを扱う。

参加者の1体だけが極端に大きい/速いとセルサイズがそれに引きずられ、グリッドが事実上1セルへ
縮退して今日と同じ O(n²) に戻る。**これは劣化ではなく現状維持**なので、そのために分類を
持ち込まない。

`collision.ts` に残っている「O(n²) の総当たりは実測でボトルネックではないため空間分割は行わない」
というコメントは削除する(**経緯は残さない** — `/comment`)。

### 2-8. `SOLAR_SYSTEM_PLAN2_2026-08-09.md` の前提が現在の実装と食い違っている(Phase 8)

同文書の EP0(重力窓の位置依存化)は、同文書の設計(`influenceRadius` という静的フィールド)
ではなく実際の寄与そのものによる判定(`relevantAttractors`)として実装されており、
**さらに本書 Phase 4 でその絞り込み自体を削除する**(§2-4)。加えて **Phase 5 で
`gravitySource` が消え、重力窓と全天体窓が1つになる**。C-2(`AttractorId` は閉じた union)・
E-9(レジストリの記述量)の前提も、`AttractorId` が `string` へ開かれ `SolarSystemId` が
`keyof typeof SOLAR_SYSTEM` から自動生成される形に変わったことで揺らいでいる。

**`SOLAR_SYSTEM_PLAN2_2026-08-09.md` は mikanixonable のものなので、書き換えてよいかを
ユーザーに確認したうえで行う。** 提案する修正内容は §4 Phase 8 に具体的に書いた。

---

## 3. 完成後の変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/game/game-entity/game-entity.ts` | `degree2`/`isStar` の `readonly` 固定を外す(§2-1)。質量→μ の配線 `setGravitatingMass` を追加(§2-2) |
| `src/game/game-entity/asteroid.ts` | `mu` の導出を `setGravitatingMass` の呼び出しへ。`j2`/`c22` 引数と `degree2` の組み立てを追加(§2-3)。`predictsFuture = true`(§2-6) |
| `src/physics/attractor.ts` | `relevantAttractors` を削除(§2-4) |
| `src/game/const.ts`(Phase 4 ぶん) | `GRAVITY_NEGLIGIBLE_ACCEL` を削除(Phase 7 で軽重分類のために再導入する — §2-7) |
| `src/game/simulation/simulator.ts` | `substep` の前段(`attractorsPerEntity`)を削除し、重力源配列を全エンティティへそのまま渡す |
| `src/game/simulation/predictor.ts` | `advanceBudget` で合流後の配列をそのまま `localOrbitPeriod`/`stepPredicted` へ渡す。動的重力天体の凍結をやめ、先端時刻で引き直す(§2-6) |
| `src/game/plan/plan-arc.ts` | 刻み幅用・積分用の2箇所の絞り込みを削除(評価時刻の違いは維持) |
| `src/game/simulation/gravity-attractors.ts` → `attractors.ts` | 重力窓という区別が消えるのでモジュール名・関数名から `gravity` を落とす。予測用の `predictedAttractorsAt` を追加(§2-5・§2-6)。動的重力天体をグリッドに載せ、位置ごとの重力源列挙を返す形にする(§2-7) |
| `src/game/simulation/entity-manager.ts` | `attractors()` の戻り値型を `readonly GameEntity[]` へ(§2-6) |
| `src/physics/solar-system.ts` | `GravitySourceFlag` を `navigationReference` へ改名し、重力判定から切り離す(§2-5) |
| `src/physics/ephemeris.ts` | `gravityAttractorsAt`/`gravityIds`/`gravityAttractorsCache` を削除し、`attractorsAt` に一本化(§2-5) |
| `src/game/hud/frame-labels.ts` / `src/game/creative/ship-placer-panel.ts` / `src/game/stages/stage-debug-alt-system.ts` | `gravitySource` の参照を `navigationReference` へ |
| `tests/physics/n-body.test.ts` | `relevantAttractors` の3件を削除。「3経路が同じ重力源集合を見る」要件は合流規則だけの形で書き直せるかを判断(§4 Phase 4-5) |
| `src/physics/spatial-grid.ts`(新規) | 位置を持つ任意の要素の一様グリッド登録と27近傍列挙(汎用・純関数、セルサイズは引数)(§2-7) |
| `tests/physics/spatial-grid.test.ts`(新規) | 27近傍列挙が全数探索と一致すること・同じ要素を二重に返さないことの検証(§4 Phase 7) |
| `src/game/simulation/collision.ts` | ペア候補の列挙を全ペア走査から27近傍列挙へ。判定式・撃力の解決は不変(§2-7) |
| `src/game/stages/stage-debug-load.ts`(新規) | 高負荷を常時再現するデバッグ専用ステージ(`hiddenFromSelect`)(§4 Phase 7) |
| `src/game/stages/stage-dictionary.ts` | `stage-debug-load` の登録 |
| `src/game/const.ts`(Phase 7 ぶん) | `GRAVITY_GRID_CELL_SIZE` を追加、`GRAVITY_NEGLIGIBLE_ACCEL` を軽重分類用に再導入(§2-7)。`MAX_ASTEROIDS`/`MAX_DEBRIS` を高負荷ステージの配置数まで引き上げる(§4 Phase 7) |
| `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` | 絞り込み・重力窓・予測の凍結に関する記述を実装結果へ同期 |
| `memos/hedalu244/better_simulation/backlog.md` | 残タスク(§6 の項目のうち次ステップで扱う予定の無いもの、実測できなかったもの)を追記(§4 Phase 10) |
| `memos/hedalu244/better_simulation/step4.md` | §8 に実測値を記録したうえで、**最後に削除する**(§4 Phase 10) |
| `memos/mikanixonable/SOLAR_SYSTEM_PLAN2_2026-08-09.md` | **ユーザーの許可を得てから**、EP0/C-2/E-9/E-13 の前提を現在の実装に合わせて書き直す(§2-8、§4 Phase 8) |

---

## 4. フェーズ別手順

### Phase 1 — `GameEntity` の `degree2`/`isStar` の固定解除

**1-1.** `game/game-entity/game-entity.ts` の
`readonly degree2: null = null` → `degree2: Degree2Gravity | null = null`、
`readonly isStar = false` → `isStar = false` へ広げる。`Degree2Gravity` の import を足す。

**1-2.** `Attractor` の側は `readonly` のままでよい(readonly プロパティは非 readonly を受け入れる)。
コメントは「何を表す値か」だけにする — **「以前は固定だった」という経緯は書かない。**

既定値を据え置くので**挙動は一切変わらない**。

**検証:** `npm run typecheck` / `npm run test:physics`。

---

### Phase 2 — 質量→μ の配線を `GameEntity` へ移す

**2-1.** `game/game-entity/game-entity.ts` に protected メソッドを追加する:

```ts
// 質量から剤体接触の換算質量と重力定数 μ を同時に定める。別々に書くと引力の強さと
// 衝突の重さが食い違う。
protected setGravitatingMass(mass: number): void {
  this.mass = mass;
  this.mu = GRAVITATIONAL_CONSTANT * mass;
}
```

**2-2.** `Asteroid` のコンストラクタの `this.mass = mass; this.mu = GRAVITATIONAL_CONSTANT * mass;` を
`this.setGravitatingMass(mass);` へ置き換え、`GRAVITATIONAL_CONSTANT` の import を落とす。

**2-3.** 既定の `mu = 0` は変えない(§2-2)。**全エンティティのコンストラクタを `setGravitatingMass`
に巻き取らないこと** — 質量だけを持つエンティティは `this.mass = ...` のまま。

**検証:** `npm run typecheck`。挙動不変(`Asteroid` の mu は同じ値)。

---

### Phase 3 — 小惑星の扁平重力(`degree2`)の配線

**3-1.** `Asteroid` のコンストラクタに `j2`/`c22`(いずれも既定 0 = 質点)を追加する。

**3-2.** `j2 !== 0 || c22 !== 0` のときだけ `degree2` を組む:

- `refRadius` = `radius`
- `pole` = `qRotate(att.q, v3(0, 1, 0))`
- `tesseral` = `c22 === 0 ? null : { c22, longAxis: qRotate(att.q, v3(0, 0, 1)) }`

`body-orientation.ts` の「モデル +Y = 自転軸、+Z = 本初子午線」と同じ約束に揃える。
**新しい数式は書かない**(§2-3)。

**3-3.** 組んだ値は**フィールドに格納**する(getter にしない — §2-3)。

**3-4.** 物理式(`degree2Accel`)は既に任意の `pole` を取る一般形で、`dynamics.test.ts`/
`body-orientation.test.ts` で検算済み。**新規の物理テストは不要** — 本フェーズが追加するのは
配線だけであり、新しい式を導入しないから。

**検証:** `npm run typecheck` / `npm run test:physics`。`j2` を持つ小惑星の周回軌道に昇交点歳差が
出ることを実機で見る(`StageDebug` に一時的な配置を書いて確認し、確認後に削除する)。

---

### Phase 4 — `relevantAttractors` の削除

**1-1.** `physics/attractor.ts` から `relevantAttractors` を削除し、`game/const.ts` から
`GRAVITY_NEGLIGIBLE_ACCEL` を削除する。

**1-2.** `game/simulation/simulator.ts` の `substep` を、重力源配列を基準時刻で1回だけ組んで
全エンティティに同じ配列を渡す形へ縮める(前段 `attractorsPerEntity` は不要になる)。
**コメントは「なぜ1回だけ組むのか(相互重力の対称性が処理順に依存しないこと)」だけを残し**、
絞り込みを前段で確定させていた理由の記述は削除する(歴史的経緯を残さない)。

**1-3.** `game/simulation/predictor.ts` の `advanceBudget` で、tip ごとに引いた合流後の配列を
そのまま `localOrbitPeriod` と `stepPredicted` へ渡す。

**1-4.** `game/plan/plan-arc.ts` の積分ループから `sizingAttractors`/`stepAttractors` の絞り込みを
外し、`ephemeris.gravityAttractorsAt(t)` の結果をそのまま使う。**刻み幅用(t)と積分用(t + dt/2)で
評価時刻が違うことは維持する** — これは絞り込みとは無関係な、積分側の判断。

**1-5.** `tests/physics/n-body.test.ts` の `relevantAttractors` の3件を削除する。うち2件
(しきい値 0 で全件通る、落とした分の合計がしきい値×件数以下)は削除する関数そのものの検算なので
意味を失う。残る1件(3経路が同じ重力源集合を見る)は、**要件自体は削除後も残る**(§2-1)ので、
合流規則(`Ephemeris.gravityAttractorsAt` と `gravity-attractors.ts` の `mergeAttractors`)だけを
検算する形へ書き直せるかを判断する。書き直せるなら書き直し、検算すべき中身が残らないなら
削除する — **どちらの場合も、絞り込みを前提にした記述をテスト名・コメントに残さない。**

**1-6.** `grep -rn "relevantAttractors\|GRAVITY_NEGLIGIBLE_ACCEL" src tests` が 0 件であることを
確認する。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で既存ステージ(0/1/2/00)を
触り、軌道・予測線・計画軌道の描画が変わらないことを確認する。

---

### Phase 5 — `gravitySource` の廃止と `mu !== 0` への一本化

**5-1.** `physics/solar-system.ts` の `GravitySourceFlag` を `NavigationReferenceFlag`
(`navigationReference: boolean`)へ改名する。**値は全体そのまま移す**(earth/moon/jupiter/saturn/sun
だけが true)。コメントは「プレイヤーが軌道の基準・座標系として選べる天体か」という
**表示上の問い**であることだけを書く — 重力には一切関与しない。

**5-2.** `physics/ephemeris.ts` から `gravityAttractorsAt` / `gravityIds` / `gravityAttractorsCache` を
削除し、`setPhaseOffsets` のキャッシュクリアからも該当行を落とす。**重力窓と全天体窓の区別が
消え、`attractorsAt` が唯一の窓になる。**

**5-3.** `game/simulation/gravity-attractors.ts` を `game/simulation/attractors.ts` へ改名し、
`gravityAttractorsAt(ephemeris, entities, t)` を `attractorsAt(ephemeris, entities, t)` へ改名する。
中身は `mergeAttractors(ephemeris.attractorsAt(t), entities.attractors())`。

**5-4.** `plan/plan-arc.ts` の2箇所を `ephemeris.attractorsAt(...)` へ差し替える。

**5-5.** GUI 3箇所(`hud/frame-labels.ts`、`creative/ship-placer-panel.ts`、
`stages/stage-debug-alt-system.ts`)の参照を新フラグ名へ差し替える。**GUI の見え方は変わらない。**

**5-6.** `grep -rn "gravitySource" src tests memos DEVELOP CLAUDE.md` が 0 件であることを確認する。
**残った記述は歴史的経緯ごと削除するか、`attractor` へ統一する**(旧名のエイリアスを残さない)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で、地球周回軌道の軌道要素・
予測線・MAP VIEW の座標系一覧・艦艇配置の基準天体一覧が変わらないことを確認する。

---

### Phase 6 — 予測経路の凍結の是正

**6-1.** `EntityManager.attractors()` の戻り値型を `readonly GameEntity[]` へ変える。
`GameEntity` は `Attractor` を構造的に満たすので、`readonly Attractor[]` を要求する既存の
呼び出し側は無変更で通る。

**6-2.** `game/simulation/attractors.ts` に予測用の関数を追加する:

```ts
// 時刻 t での重力源一覧(予測用)。動的重力天体も t の状態で組み、t の状態が得られない
// 天体は落とす — 現在位置で凍結すると「その時刻に居ない場所」から引くことになる。
export function predictedAttractorsAt(ephemeris: Ephemeris, entities: EntityManager, t: number): readonly Attractor[]
```

各天体は `e.displayState(t)` を引き、`null` ならスキップする。

**6-3.** `Predictor.update` から `const dynamic = this.entities.attractors();` とそれを使い回す
コメント(「予測ホライズンの間ほぼ動かないとみなし」)を削除し、`advanceBudget` が毎ステップ
`predictedAttractorsAt(this.ephemeris, this.entities, tipState.t)` を引く形にする。
`dynamic` 引数は不要になるので削除する。

**6-4.** `Asteroid.predictsFuture` を `true` にする。これが無いと `displayState(未来)` が常に `null` に
なり、動的重力天体が予測から丸ごと消える。

**6-5.** `Simulator.substep` は `attractorsAt`(現在の実状態で組む方)のままにする(§2-6)。
`PlanArc` は変更しない。

**検証:** `npm run typecheck` / `npm run test:physics`。`StageDebug` に一時的なデバッグコードで
自機の近くを通る大質量の `Asteroid` を置き、時間を進めたときの予測線が実軌道と一致すること
(従来は凍結のせいでずれていたこと)を確認し、確認後にデバッグコードを削除する。

---

### Phase 7 — 高負荷環境の整備と、27近傍空間ハッシュの実装・配線

**Phase 1〜6 を終えてから行う** — 絞り込みを残したまま測ると、測っているのが O(N·M) の本来の
コストなのか定数倍を削った後の混合なのかが分からないし、天体数 N も Phase 5 で 5 → 27 へ変わる。

**手順 1 → 5 を順に行う。分岐は無い** — 手順 2 の実測が取れても取れなくても、手順 3 以降は行う。

**7-1. パフォーマンス低下を再現できる環境を整える。**

- `src/game/stages/stage-debug-load.ts` に `StageDebugLoad` を新設する。`stage-debug-alt-system.ts` と
  同じ `hiddenFromSelect` のデバッグ専用ステージで、`checkWin()` は常に `false`
  (結果画面で計測が中断されない)。`stage-dictionary.ts` に登録し、`?stage=debug-load` で開く。
- `init` で **引力を及ぼす側と受ける側の両方**を配置する: `Asteroid` を定数個、`DebrisPiece` を
  定数個、自機周辺の軌道へランダムに散らす。**片方だけを増やしても N·M は増えない**
  (下記のユーザー指摘)。
- `game/const.ts` の `MAX_ASTEROIDS`(現在 20)と `MAX_DEBRIS`(現在 160)を配置数まで引き上げる。
  **これを忘れると `EntityManager.addCapped` が古いものから捨てるので、配置しても数が増えない。**
- **デバッグコードは `CLAUDE.md` の規約どおり、頼まれた形をそのまま書く**: 件数は定数直書き、
  URL クエリや環境変数による分岐・有効/無効の切り替え・パラメータ化を足さない。
  このステージは**削除せず残す** — 高負荷をいつでも再現できることが手順 5 と将来の回帰確認の前提。

**7-2. 実際に重くなることを確認する。** `?stage=debug-load&perf=1` で起動し、`PerfMeter` の
update フェーズ ms とエンティティ数を記録する。比較対象として通常ステージの値も記録する。
実機で駆動できない場合はその旨を記録して手順 3 へ進む — **手順 3 以降は測れたかどうかに依らず行う**
(§2-7)。

**7-3. `physics/spatial-grid.ts` を新設する。** 位置を持つ任意の要素に対する一様グリッドへの登録と、
ある点の27近傍セルに属する要素の列挙。セルサイズは呼び出し側が引数で渡す。`Attractor` にも
`GameEntity` にも依存させない(§2-7)。モジュール先頭コメントには**何をするモジュールか**だけを書く
(近似の限界は、近似をしている呼び出し側 — 万有引力側 — に書く)。

`tests/physics/spatial-grid.test.ts` を新設し、ランダムに配置した点群に対して、27近傍列挙が
全数探索(距離 ≤ セルサイズ)を1つも取りこぼさないこと・同じ要素を二重に返さないことを検証する。

**7-4. 万有引力と衝突判定の双方から使う。**

- `game/const.ts` に `GRAVITY_GRID_CELL_SIZE`(= R)を追加し、`GRAVITY_NEGLIGIBLE_ACCEL` を
  Phase 4 と同じ名前・同じ値(1e-10 m/s²)で再導入する(§2-7)。
- `game/simulation/attractors.ts`(Phase 5 で改名済み)で、合流済みの重力源配列を
  **`mu >= GRAVITY_NEGLIGIBLE_ACCEL * R²` かどうかだけで**「常に含める天体」と「グリッドに載せる
  天体」に分ける。**解析天体か動的重力天体かで分けない**(§2-7)。グリッドは substep ごとに1回だけ
  組み、全エンティティで使い回す。**「R より遠い軽い天体は足さない」という近似の限界を、分類を
  行う関数のコメントに明記する。**
- `game/simulation/collision.ts` の `resolveCollisionPairs` の二重ループを27近傍列挙へ置き換える。
  セルサイズは §2-7 のとおり **`radius` の最大値の2倍 + 直前 substep の最大移動距離の2倍**を
  毎フレーム求めて渡す(`sweptSphereToi` の取りこぼしを防ぐため)。**接触の判定式・撃力の解決には
  触れない**(§0・§2-7)。同じペアを二重に処理しないこと。既存の「空間分割は行わない」という
  コメントを削除する。

**7-5. 同じ条件で実測し、効果を記録する。** 7-2 と同じステージ・同じ実機で `?stage=debug-load&perf=1`
を再計測し、update フェーズ ms の変化を本書 §8 の表に記録する。既存ステージ(0/1/2/00)を触り、
軌道・予測線・計画軌道・衝突の挙動が変わっていないことを確認する。

**検証:** `npm run typecheck` / `npm run test:physics` / `npm run dev`。

> 計算量オーダーとして、万有引力は万有引力を受けるものの数をN、及ぼすものの数をMとして、O(NM)の計算量になります。「敵を追加しても高負荷にならない」のは当たり前で、片方しか増やしていないからです。
> 小惑星や多数の惑星、衛星を追加したシーンではAttractorの数が数十～数百個になり、その状態でデブリなどの数が数百個あれば、毎stepで数万～数十ペア以上の万有引力を解くことになります。これが数msで終わるわけがない。
>
> 高負荷状態を確認できていないのは計算量オーダーの認識不足と、適切に高負荷にするための配線不足にあるはずです。CLAUDEがいつでも高負荷テストを再現できるよう、配線と環境、検証手順の整備をしてください。

---

### Phase 8 — `SOLAR_SYSTEM_PLAN2_2026-08-09.md` への提案(ユーザー許可制)

**まずユーザーに、この文書を書き換えてよいか確認する。** 許可が得られたら、次の3点を
実装結果に合わせて修正する(許可が得られなければ、このフェーズは実施せず
`backlog.md` に「ユーザー未許可のため保留」と記録して終える — Phase 10):

- **EP0 の状態を更新する。** 位置依存の重力窓は `influenceRadius` という静的フィールドでは
  実装されず、さらに本書 Phase 4 で絞り込み自体を削除し、Phase 5 で重力窓自体も消えたことを
  反映する — 絞り込みは加算のオーダーを下げないため(§2-4)。オーダーを下げているのは Phase 7 で
  入れた27近傍の空間ハッシュ(`physics/spatial-grid.ts`)であることを明記する。
- **C-2「天体IDは閉じた文字列リテラル union」の前提を更新**する。`AttractorId` は
  `string` に開かれ、`SOLAR_SYSTEM`(具体レジストリ)側が `keyof typeof SOLAR_SYSTEM` で
  27個のリテラル union を自己生成する形に変わった。第2次計画が86体へ拡張する作業は、
  この形のままレジストリにエントリを足すだけで良いことを明記する。
- **E-9・E-13 の記述を、`influenceRadius` と絞り込みを前提にした部分だけ更新**する。
  E-13 が要求する「3経路が同一の重力源集合を選ぶ」という正しさの要件そのものは変えず、
  それを決めているのが `Ephemeris` の重力窓と `gravity-attractors.ts` の合流規則だけに
  なったことを反映する。

**検証:** 文書のみ。

---

### Phase 9 — 設計文書の同期

- `/develop-docs` に従い、**CLAUDE.md**(`physics/attractor.ts`・`ephemeris.ts`・`solar-system.ts`・
  `physics/spatial-grid.ts`・`game-entity.ts`・`asteroid.ts`・`attractors.ts`・`simulator.ts`・
  `predictor.ts`・`plan-arc.ts`・`collision.ts`・`stage-debug-load.ts` の各項)と
  **DEVELOP/CALLSTACK.md**(重力源絞り込み経路 — L188/189/243/260/482/486 付近)・
  **DEVELOP/OWNERSHIP.md** を更新する。削除するのは絞り込み・重力窓・予測の凍結に関する記述と、
  `collision.ts` の「空間分割は行わない」という記述。追記するのは `degree2`/`isStar` が派生可能に
  なったこと、`setGravitatingMass` の存在、そして空間ハッシュが重力源列挙とペア列挙の両方を
  通っていること。

**検証:** `npm run typecheck`。

---

### Phase 10 — `backlog.md` への引き継ぎと本書の削除

**完了したステップの指示書は保守しない。** 本書は Phase 1〜9 を終えた時点で役目を終えるので、
残るものだけを `backlog.md` へ移して削除する。

**10-1.** `backlog.md` に、次の3種類だけを追記する。**「何をやったか」は書かない** — それは
`CLAUDE.md`/`DEVELOP/` とコードが持っている一次情報であり、複製すると二重管理になる。

- **§6「このステップでやらないこと」のうち、次ステップ以降で対処される予定の無いもの。**
  `step5.md` が引き取るもの(剛体衝突の一般化、天体表面接触判定の責務移動)は**書かない** —
  引き取り手のあるタスクは backlog の対象ではない。
- **やってみてできなかったこと。** §8 の実測が実機で取れなかった場合はその旨と試した手段。
- **Phase 8 が未許可で保留になった場合**は、その旨。

**10-2.** §8 の実測値のうち残す価値のあるもの(実装前後の update ms)を `backlog.md` か
`CLAUDE.md` の該当箇所へ移す。**どこにも移らない値は移さない** — 記録のための記録を残さない。

**10-3.** `memos/hedalu244/better_simulation/step4.md`(本書)を削除する。

**検証:** `grep -rn "step4\.md" memos src DEVELOP CLAUDE.md` が0件であることを確認する
(本書を指す参照を残さない)。

---

## 5. 落とし穴チェックリスト

1. **フェーズを飛ばさないこと。** 順番は変更リスクの小さい順に並べてある。特に Phase 7 の実測は
   Phase 1〜6 を終えてからでないと、何を測ったことになるのかが定まらない。
2. **Phase 1 で `degree2`/`isStar` の既定値を変えないこと。** 広げるのは型だけで、挙動は一切変わらない。
3. **Phase 2 で全エンティティを重力源にしないこと。** 既定は `mu = 0` のまま(§2-2)。
4. **Phase 3 で `degree2` を getter にしないこと。** RK4 の各ステージで読まれる(§2-3)。
5. **絞り込みの削除を「性能が心配だから」で見送らないこと。** オーダーへの答えは Phase 7 の
   空間ハッシュであって絞り込みではない。定数倍の高速化を根拠に実装を残すことは §0 の優先順位に反する。
6. **削除のついでに重力源配列をエンティティごとに組み直す形にしないこと。** 基準時刻で
   1回だけ組むことが相互重力の対称性を保っている(§2-4)。前段で消すのは絞り込みだけ。
7. **Phase 6 で `Simulator.substep` まで時刻指定の形にしないこと。** サブステップ中点で
   `displayState(t)` を引くと、小惑星が自分のシミュレーションから落ちる(§2-6)。
8. **実測が取れないことを理由に Phase 7 の実装を止めないこと。** 構造上明らかに予測できる
   オーダー改善は実測の可否を条件にしない(§2-7)。逆に、**N と M の片方だけを増やして
   「高負荷にならない」と結論しないこと**(Phase 7 のユーザー指摘)。
9. **`MAX_ASTEROIDS`/`MAX_DEBRIS` の引き上げを忘れないこと。** `EntityManager.addCapped` が
   古いものから捨てるので、上限のまま配置しても数が増えず、高負荷にならない(Phase 7-1)。
10. **高負荷ステージ(`stage-debug-load.ts`)は削除しないこと。** Phase 3・6 の一時的なデバッグ
    コードとは別物で、いつでも再現できることがユーザーの要求(Phase 7 のユーザー指摘)。
    一方で、**Phase 3・6 の一時的なデバッグコードは判断がついた時点で削除する。**
11. **衝突判定側のセルサイズを `radius` だけで決めないこと。** `resolveCollisionPair` は直前
    substep の線分で `sweptSphereToi` を引くので、**最大移動距離の2倍**を足さないと、線分では
    接触しているのに現在位置が27近傍の外にあるペアを取りこぼす(§2-7)。
12. **重力側と衝突側でグリッドを共用しないこと。** セルサイズの意味が違う(片方は無視距離、
    もう片方は最大接触距離)。共用するのは `physics/spatial-grid.ts` という実装であって、
    そのインスタンスではない。
13. **空間ハッシュの軽重分類を、天体の出自(解析天体か動的重力天体か)で行わないこと。**
    レジストリには軽い天体が登録されうるし、`GameEntity` は十分に重くなれる(§2-2)。
    判定は `mu >= GRAVITY_NEGLIGIBLE_ACCEL * R²` の一本だけ(§2-7)。
14. **`GRAVITY_NEGLIGIBLE_ACCEL` の再導入を、`relevantAttractors` の復活にしないこと。**
    Phase 7 で戻るのは「何を無視してよいか」という定数1つで、位置ごとに全天体の寄与を評価する
    前段は戻らない(§2-4・§2-7)。再導入時に別名を与えないこと — 同じ量である。
15. **`SOLAR_SYSTEM_PLAN2_2026-08-09.md` をユーザーの許可なく書き換えないこと。** §2-8・Phase 8。
16. **`hitAttractor`/`hitCelestialBody` と、接触の判定式・撃力の解決に手を出さないこと。**
    前者は `attractor.ts`、後者は `collision.ts` にあり本書も同じファイルを触るが、
    どちらも接触の関心事で `step5.md` の担当(§0)。
17. **Phase 10 の `backlog.md` へ「何をやったか」を書かないこと。** backlog に載せるのは
    **残っているもの**だけ。実装した内容は `CLAUDE.md`/`DEVELOP/` とコードが持つ(§4 Phase 10)。
18. **引き取り手のあるタスクを backlog に載せないこと。** `step5.md` が扱うものは `step5.md` が
    持つ。backlog は「どのステップも予定していない残り」の置き場(§4 Phase 10)。

---

## 6. このステップでやらないこと

- **剛体衝突シミュレーションの一般化(接触の判定式・撃力の解決)と、天体表面接触判定の責務移動。**
  `step5.md` の担当範囲。本書が `collision.ts` で触るのはペア候補の列挙だけ(§0・§2-7)。
- **`GameEntity` から解析天体への反作用。** 反作用を入れた時点でその天体は解析天体でなくなるので、
  **意図的に考慮しない**。
- **外乱のプラグイン化(`totalAccel` の固定引数リストの解体)。** `physics/` 側に巨大な継承ツリーを
  作らない方針のため、**固定長引数のままとする**。
- **`atmosphere.ts`/`shadow.ts` の地球固有性の解消。** `goal.md` の順序どおり、「任意天体の大気」は
  万有引力が整った次の段階。
- **動的な恒星の配線。** `isStar` の固定を外すだけで、実際に立てる派生クラスは作らない(§2-1)。
- **空間ハッシュの適用先を、万有引力とペア接触の2箇所より広げること。** 弾のヒット判定
  (`hit.ts` の線分×球)は本書では触らない — そちらは弾1発あたり全参加者を舐める形であり、
  同じ機構が効くとしても別の変更セットで判断する。
- **`memos/mikanixonable/SOLAR_SYSTEM_PLAN2_2026-08-09.md` の EP1〜EP8(天体86体化・形状・
  環・点群の拡張)。** あちらの担当範囲であり、本書は EP0 の前提更新(ユーザー許可制)だけを扱う。
- **分点歳差の導入と、月理論の数値表に残る未検証項目。** `backlog.md` に既に載っており、
  そのまま backlog に残す。
- **`refactoring_todo.md` の他の項目**(sfx/bgm 分離、belt-physics の変換処理見直し、
  const.ts 解体等)。今回の変更セットとは無関係。

---

## 7. フェーズごとの検証コマンド

```
npm run typecheck                        # 全フェーズで必ず(コードを触った場合)
npm run test:physics                     # Phase 1・3・4・5・6・7 で必ず
npm run dev                              # Phase 3・5・6・7 の目視確認
npm run dev + ?stage=debug-load&perf=1   # Phase 7-2(実装前)と Phase 7-5(実装後)の実測。
                                         # 同じステージ・同じ実機で2回測り、§8 に記録する
```

---

## 8. 実測の記録(Phase 7)

高負荷ステージの構成(`stage-debug-load.ts` の配置数)と、`?stage=debug-load&perf=1` で読んだ
update フェーズ ms を記録する。**この表が埋まっていることが Phase 7 の完了条件**(§1 の到達点 7)。

| 計測点 | 小惑星数 | デブリ数 | update [ms] | 備考 |
|---|---|---|---|---|
| 通常ステージ(比較用) | | | | |
| Phase 7-2(空間ハッシュ実装前) | | | | |
| Phase 7-5(空間ハッシュ実装後) | | | | |

本書は Phase 10 で削除するので、**この表は作業中の一時的な記録である。** 残す価値のある値は
Phase 10-2 で `backlog.md` か `CLAUDE.md` へ移し、移らない値は移さない。

実機で駆動できなかった場合は、その旨と試した手段を備考に書く — **空欄のまま Phase 7 を
終えない。**
