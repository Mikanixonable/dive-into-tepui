# Step 5 — 接触シミュレーションの統一(実装済み)

**Phase 0〜9 まで全て実装済み。** §0〜4 は設計判断そのものとして今も有効、§5 のフェーズ別手順は
実施した変更の記録として残す。未確認のまま残った調査対象は `backlog.md` を参照。

`goal.md` の§目標が明言していた、

> 衝突シミュレーションについては、現時点では弾であるか、天体であるか、大気再突入であるかと
> いった区別になっているが、基本的には弾にせよデブリにせよ小惑星にせよ、剛体シミュレーション
> として一般化してから、大気やガス惑星、プラズマ弾といった非剛体を後から考慮する形にしたい。

を実装する。着手前に必ず `goal.md` の§目標を参照し、目的を理解しながら行うこと。

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

- **本書は `step4.md` の完了後に着手する。** 両者とも `game/simulation/collision.ts` の
  ペア列挙を触る(`step4.md` Phase 7 が全ペア走査を27近傍の空間ハッシュへ差し替え、本書
  Phase 4 がその列挙を掃引(swept)対応へ広げる)。並行させると衝突する。
- Step2 の残タスク(分点歳差、月理論数値表の未検証項目)は本書のスコープ外のまま `step2.md` に残す。
- 万有引力の**計算経路**には一切触れない(`step4.md` の担当範囲)。本書が `physics/attractor.ts`
  を触るのは `hitAttractor`/`hitCelestialBody` を**そこから追い出す**ためだけである。

---

## 1. 現状に埋まっている4つの思い込み

本書は新機能を足すのではなく、**接触という1つの現象が別々の仕組みへ割れている**のを1つに
束ねる。現状のコードに残る思い込みを名指ししておく。

**(1) 「重力源に触れる = 再突入して死ぬ」。**
`physics/attractor.ts` の `hitCelestialBody(r, attractors, margin)` が、全エンティティの
`checkLoss` と積分打ち切りの唯一の表面接触判定になっている。しかし `Attractor` とは
「GM を持つもの」の型であって、触れたら何が起きるかとは無関係である(現に判定式に `mu` は
一度も現れず、読んでいるのは `state.r` と `radius` だけ)。
さらにこの1本の関数が、**性質の違う2つの現象を1つにまとめてしまっている**:

- **大気による焼失**(地球にしか無い。`REENTRY_ALT`=80km / `DEBRIS_REENTRY_ALT`=95km /
  `PLAYER_MIN_ALT`=45km という「高度マージン」の正体はこれ)
- **固体表面への接触**(大気の有無と無関係。月にも小惑星にもある)

月や小惑星に「再突入高度 95km」のマージンが適用されているのは、この混同の直接の帰結である。

**(2) 「接触の結果は種別ごとに別々の仕組みで決まる」。**
今日、同じ「2つの物体が触れた」に対して3つの別々の経路が走っている:

| 触れたもの | 経路 | 結果 |
|---|---|---|
| 弾 ⇔ 艦 | `simulation/hit.ts` の `HitSystem`(substep ごと・線分vs球でトンネル防止) | 武装ダメージ・弾は消滅 |
| 薬莢/デブリ/補給/小惑星/ベルト ⇔ 何か | `simulation/collision.ts` の `CollisionPhysics`(フレームに1回・重なり判定 + TOI フォールバック) | 弾かれるだけ。ダメージは自機⇔敵機の組にしか発生しない |
| 何か ⇔ 天体 | `checkLoss` の `hitCelestialBody` | 即消滅 |

**相対速度が十分に大きければデブリも凶器であり、十分に小さければ天体には着地できる。**
どちらも今日は表現できない。回収もタッチダウンもできない。

**(3) 「被弾判定半径と剛体接触半径は別々でよい」。**
`Ship.hitRadius`(被弾)と `GameEntity.radius`(剛体接触)が別のフィールドとして共存し、
`Player` だけ両者が食い違っている(`hitRadius` は放熱板の展開に応じて `PLAYER_RADIUS`=5m
から `RADIATOR_TIP_DISTANCE` まで伸びるが、`radius` は `PLAYER_HULL_RADIUS`=2.6m に固定)。
これは**「放熱板を展開すると当たりやすくなる」を、剛体としての形を変えずに被弾半径だけ
膨らませるという簡易実装で先に作ってしまった**結果である。物理的な球としては成立しない
(伸びた放熱板は弾には当たるのに薬莢はすり抜ける)。
**放熱板は、自機の半径を膨らませるのではなく、ベルトと同じく「自機にくっついた、実体として
広がった物体」として持たせなければならない。**

**(4) 「a と b が接触したとき何が起きるかを、接触を検出した側が決める」。**
`game.ts:464-472` に被弾分岐が漏れている:

```ts
(a, b, speed) => {
  if (a === player && b instanceof Enemy) { … }
  else if (b === player && a instanceof Enemy) { … }
},
```

`a` と `b` が接触したときに `a` と `b` に何が起きるかは、**接触検出(`collision.ts`)の責務でも、
ましてオーケストレータ(`game.ts`)の責務でもなく、`a` と `b` 自身の責務である。**
この分岐が `game.ts` にあるせいで「自機⇔敵機」以外の組でダメージが発生せず、艦が小惑星に
高速で突っ込んでも今日は無傷である。

なお **弾の被弾ダメージ(`HitSystem` → `Ship.attacked`)は実機で正しく働いている。**
壊れているのは剛体接触の側で、ダメージが自機⇔敵機の組にしか配線されていないことである。

---

## 2. 到達点(成功基準)

1. **接触の検出・剛体としての解決・接触の帰結の3つが分離され、それぞれ1箇所にある。**
   - 検出と剛体解決 = `physics/`(純関数、`test:physics` 対象)
   - どのペアをいつ調べるか = `game/simulation/`
   - 接触して自分に何が起きるか = **接触した当事者(`GameEntity` の各サブクラス)**
2. **`game.ts` から接触の分岐が消えている。** `onHighSpeedImpact`/`onPlayerCasingImpact` の
   両コールバックが廃止され、`Simulator.advance` の引数からも消えている。
3. **弾の命中が剛体接触と同じ基盤に乗っている。** `HitSystem` の線分vs球判定は掃引接触検出へ
   吸収され、「弾が艦に当たってダメージを与え、弾自身は消える」は `Bullet`/`Ship` それぞれの
   接触反応として書かれている。
4. **接触の結果が、種別と力積の両方で決まる。** 力積だけで決めない(§3-5)。
   - 高相対速度のデブリは艦を傷つける(現状は無害)
   - 低相対速度なら天体表面に接地できる(現状は即消滅)
   - 弾のダメージは撃った武装のスペックのまま(力積で置き換えない)
5. **被弾半径と剛体接触半径が1つになっている。** `Ship.hitRadius` が消え、放熱板は
   ベルトと同じ「自機に取り付いた剛体の集合」として接触に参加する。
6. **天体表面接触が、重力の関心事から接触の関心事へ移り、かつ大気による焼失と分離されている。**
   `physics/attractor.ts` から `hitAttractor`/`hitCelestialBody` が消え、「大気で焼ける」は
   大気の関心事として別に立つ。
7. **ステップ内の複数の接触が、発生時刻(TOI)順に解決されている。** 全ペアに掃引判定が
   掛かり、めり込みが原理的に発生しない。
8. **全ペア掃引化のコストが実測されている。** `step4.md` Phase 7 の高負荷デバッグステージ
   (`stage-debug-load.ts`)で前後を測る。「定数倍だから問題ない」を測らずに書かない(§3-8)。
9. **`hit` の4つの意味が全部決着している**(§3-10)。統合後に残る `hit` は、スコアの
   命中率だけである。
10. **薬莢の接触音と至近通過音が、どちらも当事者の責務になっている**(§3-11)。
   鳴り方は意図的に雑なままで、マイク導入(`feature_todo.md`)へ引き継ぐ。
11. **有限値ガードが、参加者の段階で位置・速度・半径・質量のすべてを見る形で機能している**
   (§3-12)。非有限値が接触経路を通って他の物体へ伝播しないことがテストで固定されている。

---

## 3. 設計判断

### 3-1. 接触を3層に割る

今日は「検出」「剛体解決」「帰結」が `HitSystem`/`CollisionPhysics`/`game.ts` の3箇所に
**バラバラの組み合わせで**混ざっている。層で割り直す。

| 層 | 置き場所 | 知っていること |
|---|---|---|
| **検出** | `physics/sphere-contact.ts` | 2球の掃引接触(TOI・接触点・法線)。ゲームを知らない |
| **剛体解決** | `physics/collision-response.ts`(新規) | 逆質量・反発係数から撃力と反発後の状態を出す。ゲームを知らない |
| **列挙と順序** | `game/simulation/contact.ts`(`collision.ts` を改名) | どのペアを調べ、どの順に解決するか |
| **帰結** | `GameEntity.collideWith`(各サブクラス) | 自分がその接触から何を受けるか |

**列挙の層は「何が起きるか」を一切知らない。** ペアを見つけて剛体解決を通し、両当事者に
`collideWith` を渡すだけで、ダメージも音もエフェクトも消滅も見ない。

### 3-2. 帰結は当事者の責務 — `collideWith` を順不同で両側に呼ぶ

```ts
// GameEntity
// この接触で自分に何が起きるかを記述する。相手に何が起きるかは書かない(相手の責務)。
collideWith(other: GameEntity, contact: Contact): void
```

`a.collideWith(b, …)` と `b.collideWith(a, …)` を順不同で呼ぶ。順序に結果が依存しないためには、
**先に呼ばれた側の反応が、後に呼ばれた側の読む値を変えていない**必要がある。

当初案は `a_ = a.clone()` でスナップショットを取る形だったが、**このコードベースではコピーは
既に無料で手に入る。** `KinematicState` は不変で、`step`/`reset` のたびに新しい参照へ
差し替わる(CLAUDE.md「基本データ型は例外なく不変」)。よって**接触時点の状態を `Contact` に
持たせておけば、反応が `entity.state` を書き換えても `Contact` の中身は変わらない。**
`GameEntity` は `THREE.Object3D` とシーン登録と `DynamicTrajectory` を所有するので、
`clone()` は重いうえに複製の破棄まで面倒を見ることになる — 採らない。

```ts
// game/simulation/contact.ts
// 1回の接触を、受け手から見た形で記述する。self/other は受け手ごとに入れ替えて組み直す
// (normal も向きが反転する)ので、同じ解決結果から a 用と b 用の2つを作る。
export interface Contact {
  readonly t: number;                    // 接触時刻(TOI)[sim s]
  readonly point: Vec3;                  // 接触点(ECI)
  readonly normal: Vec3;                 // self → other 向きの単位法線
  readonly selfState: KinematicState;    // 接触直前(反応前)の自分
  readonly otherState: KinematicState;   // 接触直前(反応前)の相手
  readonly impulse: number;              // 剛体解決で生じた力積の大きさ [N·s]。離反中なら 0
}
```

相対速度は `sub(otherState.v, selfState.v)` で求まるので**保持しない**
(CLAUDE.md「軽微な計算で求まるものをステートとして持つな」)。

**`other` から読んでよいのは、接触の反応では変わらない値だけ**という規約を置く
(質量・半径・種別・`Bullet.damage`/`shooter` のような不変フィールド)。
`state`・`alive`・`hp` は `Contact` 側から読むか、そもそも読まない。
この規約は Phase 6 のレビュー項目にする。

### 3-3. どのペアが接触しうるかも、当事者が答える

今日 `collision.ts` にはペアの特例が直書きされている(ベルト同士を飛ばす・自機とベルトを
飛ばす)し、`HitSystem` にも別の特例がある(プラズマ弾は自機しか狙わない・自弾は発射直後
`SELF_HIT_GRACE` の間は自機に当たらない)。これらは**接触検出の都合ではなく、当事者の性質**である。

```ts
// GameEntity
// 自分がこの相手と接触しうるか。既定 true。どちらか一方でも false なら接触しない。
contactsWith(_other: GameEntity, _simTime: number): boolean { return true; }
```

両側に問い、AND を取る(順不同・対称)。`BeltSection` は「他のベルト節」「自分を吊っている艦」を
自分で断る。**列挙側の特例分岐は全廃する。**

**弾の接触可否は、弾種(`BulletType`)ではなく射手(`Shooter`)で判断する。** 今日は自機が
`normal`、敵が `plasma` を撃つので両者が一致しているが、**一致は現在の装備構成の偶然であって、
弾種が増えれば崩れる。射手は崩れない。** `Bullet.contactsWith` の規則は3つ:

1. **弾同士は接触しない**(射手にも弾種にも依らない)。
2. **`shooter === 'enemy'` の弾は `Enemy` と接触しない**(敵は同士討ちしない)。
   今日これは `HitSystem` の「プラズマ弾は自機のみを狙う」と `Enemy.attacked` 冒頭の
   `if (bullet.shooter === 'enemy') return;` の**2箇所が同じ規則を別の言い方で述べている**。
   統合で1箇所(`Bullet.contactsWith`)へ寄せ、`Enemy` 側の早期 return は消す。
3. **弾は自陣営の艦に対して、発射後 `SELF_CONTACT_GRACE` の間は接触しない**(§3-10 で
   `SELF_HIT_GRACE` から改名)。

**規則2と3の非対称は意図的である** — 敵は同士討ちしないが、自機は猶予を過ぎた自弾に当たる
(`Player.attacked` の「自弾の被弾により機体を喪失した」がその経路)。射手で書き直しても
この非対称は保つこと。**「対称にした方が綺麗だから」で規則2を自陣営にも広げない。**

### 3-4. 天体は「触れると死ぬ重力源」ではなく「質量無限の接触相手」

`hitCelestialBody` を廃し、天体を接触の参加者として扱う。ただし2つを分ける。

- **固体表面への接触** — 天体の `radius` の球への接触。マージンは 0。相対速度によって
  結果が変わる(§3-5)。大気の有無と無関係なので、月にも小惑星にも同じく効く。
- **大気による焼失** — 地球にしか無い現象。高度しきい値(`REENTRY_ALT`/`DEBRIS_REENTRY_ALT`/
  `PLAYER_MIN_ALT`)はこちらの数値であって、表面接触のマージンではない。
  **判定モデルは今回変えない**(しきい値による二値判定のまま)が、**置き場所と名前を大気側へ移す。**
  `physics/atmosphere.ts` が既に大気の密度モデルを持っているので、そこへ寄せる。

天体側の質量は有限値を入れない — **逆質量 0(無限質量)**として剛体解決に渡す
(`collision-response.ts` は `invMass` を引数に取り、0 を受け付ける)。これで
「艦が天体に跳ね返される」が正しく片側だけに効く。

これにより **低相対速度での接地(タッチダウン)が原理的に可能になる。** ただし、
**静止接触(resting contact)の安定化は本書の範囲外。** 撃力ベースの解決だけでは接地した
物体が毎ステップ微小な反発を繰り返す。今回は「めり込みを戻し、法線方向の相対速度を
反発係数ぶんに落とす」までを到達点とし、摩擦・スリープ処理は `DEVELOP/SPEC.md` §16 へ残す。

### 3-5. 力積は判断材料の1つ。種別ごとの判定は残す

**質量と相対速度だけでダメージを計算するのは早急な一般化である。** 力積はダメージ量の
判断材料になりうるというだけで、それ自体がダメージ関数ではない。

- **弾のダメージは撃った武装のスペック(`Bullet.damage`)のまま。** 軽いプラズマ弾と重い
  実体弾が同じダメージテーブルに乗るのは、それがゲームデザイン上の武器バランスだからで、
  力積へ置き換えると数値的根拠が消える。
- **剛体接触のダメージは、自分が受けた速度変化 `Δv = impulse / mass` を根拠にする。**
  力積そのもの(kg·m/s)をしきい値にすると、質量の違う艦の間で同じ物理的な「痛み」が
  違う数値になる。自分の質量で割った量が、その物体が実際に受けた衝撃である。
- **天体表面への接触も同じ `Δv` を使う。** 逆質量 0 の相手との接触では
  `Δv ≒ (1+e)·|法線相対速度|` になるので、軌道速度(~7.8 km/s)なら当然破壊され、
  数 m/s の接地なら無傷になる。しきい値を別に持つ必要はない。

`Ship.collideWith` は**意図的に2分岐**になる:

```ts
// 弾は武装のダメージを、それ以外は接触の速度変化を根拠にする。
// 前者はゲームバランス、後者は物理量で、統合すると前者の根拠が消える。
collideWith(other: GameEntity, contact: Contact): void {
  if (other instanceof Bullet) { /* 既存 attacked 相当 */ }
  else { /* Δv = contact.impulse / this.mass によるダメージ */ }
}
```

この2分岐を1本にまとめようとしないこと。**それが早急な一般化にあたる。**

### 3-6. 被弾半径を廃し、放熱板を実体として持たせる

`Ship.hitRadius` を削除し、`GameEntity.radius` に一本化する。
影響は**実質 `Player` だけ**である — `Enemy` は既に `hitRadius === radius`
(どちらも `visualSphere.radius`)で、食い違っているのは `Player` だけ。

`Player` の放熱板は、**ベルトと同じ形**で接触に参加させる:

- `player/belt-physics.ts` の `BeltSection extends GameEntity`(ベルト1リンクぶんの接触代理)
  と同じ構造の代理エンティティを、放熱板の蛇腹の折りごとに置く。
- ベルトと違い Verlet 解法は要らない — 蛇腹の各折りの位置・姿勢は艦の姿勢と
  `RadiatorSystem.foldThetas(side)` から一意に決まる剛体の取り付けなので、
  毎フレームその変換で置き直すだけでよい。
- **どの放熱板に当たったかは「どの代理が接触したか」が答える。** `RadiatorSystem.sideHitBy`
  (被弾点の機体座標 X 符号から side を逆算していた関数)は不要になるので削除する。
- `RadiatorSystem.hitRadius()` も削除する。

**これは挙動の変化を伴う**(展開した放熱板が薬莢を弾くようになる、被弾判定の形が球から
蛇腹の集合へ変わる)。これは簡易実装の是正であって回帰ではない、という判断を明示的に置く。

`PLAYER_RADIUS`(5m、自弾の自己命中判定用)と `PLAYER_HULL_RADIUS`(2.6m、剛体接触用)の
二重化も同時に解消する — 自弾の自己命中は既に `SELF_HIT_GRACE` の時間猶予で防いでおり
(§3-3 で `Bullet.contactsWith` へ移る)、半径を別に持つ理由が無い。`PLAYER_HULL_RADIUS`
だけを残す。

### 3-7. 全ペアに掃引接触判定を掛け、ステップ内を時刻順に解く

今日、トンネル防止が厳密なのは弾⇔艦の組だけ(`HitSystem` の線分vs球)で、剛体接触側は
「最終位置が重なっていたら補正、離れていたら TOI をフォールバックとして見る」という
非対称な形になっている。**掃引判定を全ペアの一次手段にする。**

- 接触の瞬間を常に捉えるので、**めり込みが原理的に発生しない。** 重なり補正
  (`pen/invM*0.8` の位置補正)は「初期配置がすでに重なっている」等の異常時のフォールバック
  としてだけ残り、緩和反復の回数は減らせる。
- **1ステップ内に複数の接触があるときは TOI の昇順で解決する。** 解決するたびに以降の
  ペアの TOI は変わりうるので、解決後に残りのペアを引き直す。
  これは定数倍のコストだが、**接触の順序は物理的な事実であって近似の対象ではない**ので、
  §0 の優先順位(物理的正確さ > パフォーマンス)により実施する。
- 上限反復回数を置いて発散を防ぐ(1ステップあたりの解決件数に上限)。上限に達したら
  残りは次ステップへ持ち越す。

### 3-8. 接触は substep ごとに走らせる。ただしベルトは例外

今日、弾の命中判定は substep ごと、剛体接触はフレームに1回(`Simulator.advance` の
substep ループの**外**)という非対称がある。統一する以上、**接触は substep ごと**にする
(掃引判定が意味を持つ刻みがそこだから)。

2つの例外を明示的に置く:

- **ベルトはフレーム単位のまま。** ベルトは実時間 `dt` で解く艦にくっついた局所シミュレーション
  であって軌道運動ではない(`BeltPhysics` が実 `dt` を要求する)。substep へ持ち込むと
  タイムワープ時に破綻する。フレーム末尾で1回だけ、今まで通りに解く。
- **タイムワープ時のゲートは維持する。** `SimSpeedManager.canResolvePhysicalCollisions`
  (×4 以下)より上では substep が最大 20 秒に達し、剛体接触の解決自体が無意味になる。
  ゲートはそのまま接触全体に掛ける。上のワープでは飛行中の弾も貫通するが、
  そもそも `canPlayerFire` が同じ閾値で発砲を止めているので実害は無い。

**実測を必須にする。** `step4.md` Phase 7 が用意する `stage-debug-load.ts`(高負荷デバッグ
ステージ)で、全ペア掃引化・TOI 順序化の前後で sim フェーズの所要時間を測り、本書 §8 に記録する。
定数倍に収まっていることを主張するなら測って裏付ける。**測って定数倍に収まらなかった場合でも、
判定モデルを緩めるのではなく列挙の絞り込み(`step4.md` の空間ハッシュ)側で解決する。**

### 3-9. 空間ハッシュは掃引に対応させる必要がある

`step4.md` Phase 7 が入れる27近傍列挙は、**エンティティの終端位置のセル**で登録している。
掃引判定はステップ中の移動区間全体を見るので、そのままでは高速な物体のペアを取りこぼす。
どちらかで対応する:

1. セルサイズを「1 substep での最大移動距離 + 半径和」以上に取る、または
2. 各エンティティを移動区間が跨ぐ全セルへ登録する(掃引登録)。

**1 を既定とする**(実装が単純で、セルサイズは既に定数)。substep 上限
(`SUBSTEP_MAX_DT`)と軌道速度から必要なセルサイズを逆算し、`step4.md` が置いた
`GRAVITY_GRID_CELL_SIZE` とは別の接触用の定数を置く(重力と接触で必要なセルサイズは
別の理由で決まるので、共有しない)。取りこぼしが出る条件を Phase 4 のテストで固定する。

### 3-10. `hit` の4つの意味を、ここで全部決める

`feature_todo.md`「衝突判定の統一化」は「**実装より先に名前だけ動かさない** — 統合と同じ
変更セットで4つまとめて決める」と明言している。**本書がその統合の変更セットである**以上、
4つとも本書で決着させる。(1)(2) は統合の副産物としてほぼ自動的に解消し、(3)(4) は中核の関数が
既に `hit` を含んでいない(`pickNearest`/`solveLeadTime`)ためローカル変数名を揃えるだけで済む。
**4つのうち2つだけ動かして残りを次へ送ると、`hit` がどの意味で残っているのかが今より
分かりにくくなる** — 統合が済んだ後の `hit` は「まだ手が付いていない語」ではなく
「なぜか残っている語」になるので、まとめて片付ける。

| # | 今の意味 | 統合後 | 根拠 |
|---|---|---|---|
| (1) | 弾丸の命中・被弾 | **`contact` へ吸収**。`HitSystem`/`checkBulletHits`/`Ship.attacked`/`hitRadius` は消える | 弾の命中は剛体接触の一種になる(§3-1) |
| (2) | 剛体同士の接触 | **`contact`**。`SweptSphereHit` → `SphereContact`、`collision.ts` の `const hit` → `const contact` | 統合後の唯一の「触れた」の語 |
| (3) | 画面上のクリック当たり判定 | **`pick`**。`nav-target.ts`/`plan-editor.ts`/`targeter.ts` の `const hit` → `const picked` | 中核が既に `pickNearest`/`nearestSample`。ローカル変数だけが取り残されている |
| (4) | 命中までの時間 | **`leadTime`**。`enemy.ts` の `timeToHit` → `leadTime` | 中核が `intercept.ts` の `solveLeadTime`。呼び出し側だけが別語を使っている |

**`hit` を残す唯一の場所は、スコアの「命中率」である。** `ScoreCounter.recordHit`(発砲数に対する
命中数)と `Sfx.enemyHit` は、接触の一般化とは無関係なゲーム用語としての「命中」であり、
これを `contact` へ寄せると「薬莢が艦に触れた」まで命中率に混ざる。**接触したかどうかと、
それを命中として数えるかどうかは別の問い**なので、ここだけは意図的に `hit` のまま残す。

`const.ts` の `*_HIT_*` 十数語は、中身が3種類に割れているので一律には動かせない:

- **弾のダメージ量** — `PLAYER_HIT_DAMAGE`/`ENEMY_HIT_DAMAGE`/`RADIATOR_HIT_DAMAGE`。
  統合後は「弾によるダメージ」と「接触の `Δv` によるダメージ」が別物として並ぶ(§3-5)ので、
  前者であることが名前で分かる必要がある → **`*_BULLET_DAMAGE`**。
- **着弾エフェクト** — `BULLET_HIT_FLASH_*`/`PLASMA_HIT_FLASH_*`/`HIT_FRAG_*`/
  `COLOR_BULLET_HIT_FLASH`/`COLOR_PLASMA_HIT_FLASH` → **`*_IMPACT_*`**。
  `impact` は `onHighSpeedImpact` が消える(§2-2)ことで空くので、衝突しない。
- **接触の可否を決める値** — `SELF_HIT_GRACE` → **`SELF_CONTACT_GRACE`**(§3-3 で
  `Bullet.contactsWith` へ移る)、`RADIATOR_HITTABLE_DEPLOY` → **`RADIATOR_CONTACT_DEPLOY`**
  (§3-6 で「接触代理を出す展開度」になる)。
- `COLOR_MARKER_BOARDHIT` は的板を弾が**通過**した点の色であって命中ではない
  → **`COLOR_MARKER_BOARDPASS`**(CSS クラス `mk-boardhit` も併せて直す)。

### 3-11. 接触音・至近通過音はどちらも当事者の責務。ただし本来の解はマイクなので雑に置く

音に関わる2つが、どちらも当事者ではないところに置かれている:

- **薬莢の接触音**(`Sfx.clank`)は `CollisionPhysics.resolve` の `onPlayerCasingImpact`
  コールバック経由で、**操作艦だけ**が鳴らしている。接触音は接触した当事者のものである。
- **敵弾の至近通過音**(`Sfx.magneticInterference`)は `HitSystem` の中で、被弾判定の
  ついでに `hitRadius + 15m` の球で判定されている。**これは接触ですらなく最接近のイベント**で、
  接触判定が担っていること自体が責務違反である。持ち主は弾自身。
  **鳴らす条件は射手基準**(`shooter === 'enemy'` の弾が艦の至近を通った)にする(§3-3)。
  ただし**どの音を鳴らすかは弾種基準のままでよい** — 磁気干渉音はプラズマ弾が物理的に
  何であるかに由来するもので、誰が撃ったかとは関係がない。

`feature_todo.md`「sfx が鳴る位置を sfx に伝える」がこの2つを名指ししており、**本来の解は
マイクの概念の導入**(マイクからの距離と向きで音量と定位を決める)である。それは本書とは別の、
それ自体で大きな改修なので、本書は**責務の移動だけを行い、鳴り方は雑なまま**にする。

- **薬莢の接触音は `DebrisPiece.collideWith` が鳴らす**(`kind === 'casing'` かつ相手が艦のとき)。
  `onPlayerCasingImpact` コールバックは消える。相手を「操作艦」に限らず `Player` 全般にする —
  「今どれが操作艦か」を薬莢が知る筋合いは無いため。ステージモードでは自機は1隻なので
  従来と同一の挙動になり、クリエイティブで複数艦を置いたときだけ、遠くの艦の薬莢も
  同じ音量で鳴る。**これがこちらの「雑」の中身**で、距離減衰はマイクの仕事。
- **至近通過音は `Bullet` 自身が持つ。** 弾は `checkLoss` で既に `playerPos` を
  受け取っているので、そこで「まだ鳴らしていない && 距離がしきい値未満」なら鳴らす。
  `Sfx` はコンストラクタ引数で受け取る(生成元の `Enemy.behave` は既に `_sfx` を持っている)。
  **線分での最接近距離は取らない** — substep ごとの位置だけを見るので、高速なプラズマ弾が
  substep 間で通り抜けると鳴り損ねる。**これが意図的な劣化である**(マイク導入時に
  最接近距離ごと作り直すので、ここで精度を作り込むと二度手間になる)。
- **`backlog.md` へ2行残す** — 薬莢音の距離減衰と操作艦以外の扱い、至近通過音の判定精度。
  どちらもマイク導入で作り直す。

判定を消してしまう案は採らない — 音が1つ黙って消えるのは、後で気付いたときに原因の特定が
難しい種類の劣化だから。

### 3-12. 有限値ガードは消してはならない。そのうえで、今のガードには穴がある

`collision.ts:96` の `if (!Number.isFinite(distSq)) return null;` は**この変更で最も慎重に
扱うべき1行**である。非有限値の比較は常に false になるため、ガードが無いと汚染された物体が
**すべての物体と「接触中」と判定され**、毎フレーム反発と衝突音を発生させながら
**接触した相手全員へ NaN を伝播させる**。`nan-watchdog.ts` が存在する経緯そのものがこれで、
同モジュールの冒頭コメントにも記録されている。**本書は接触の参加者を弾・天体まで広げ、
判定を掃引へ変え、解決を `physics/` へ移す — ガードが落ちる経路が4つ増える。**

そのうえで、**現在のガードには実際に穴が3つある**(コードを読んで確認した):

1. **速度を見ていない。** `distSq` は位置だけから作られるので、位置が有限で速度が非有限の
   物体はガードを素通りする。その先で `vn`(法線方向相対速度)が NaN になり、
   **`if (vn >= 0)` は NaN に対して false なので離反判定に引っかからず**、そのまま撃力の
   分岐へ落ちて **両者の速度に NaN が書き込まれる。** 有限値ガードを実装したのに
   `NanWatchdog` が稀に発火する、という報告の**最有力の説明はこれ**である。
2. **質量が 0 だと NaN を生む。** `invMa = 1/a.mass` が `Infinity` になり、
   `j = -((1+e)·vn)/invM` が `-0`、`jA = j * invMa` が `-0 × Infinity` = **NaN**。
   今日は `mass = 0` の `DebrisPiece.fragment` が `collides = false` なので露出していないが、
   **Phase 3 で弾を参加者にするとき質量を 0 のままにすると即座に踏む。**
3. **半径が非有限だと素通りする。** `distSq < minD*minD` が false になり、掃引側の分岐へ
   落ちる(そちらは §後述のとおり安全に null を返すので実害は小さいが、ガードが
   効いているわけではない)。

**対策は3層に置く。**

- **参加者の段階で落とす(主たるガード)。** 接触の列挙に入る前に、
  「位置・速度・半径・質量がすべて有限で、質量が正」でないエンティティを参加者から外す。
  ペアごとではなくエンティティごとなので **O(n²) ではなく O(n)** であり、今のペア単位の
  ガードより**安いうえに強い**(速度も質量も半径もまとめて見る)。
  `step4.md` の空間ハッシュへ載せる前に落とすこと — NaN 座標は `Math.floor(NaN/cell)` が
  NaN になってセル添字が壊れるので、**ハッシュに入れてはいけない。**
- **`physics/` の純関数は非有限入力に対して「何も起きない」を返す。** `sweptSphereToi` は
  既にそうなっている — 全ての分岐が `if (!(c > 0)) return null` の形で書かれており、
  **NaN に対して条件が false になることで自動的に null へ落ちる。**
  この書き方は意図的なので、`!(x > 0)` を `x <= 0` へ「読みやすく」書き換えてはいけない
  (NaN の扱いが反転する)。同じ規約を `collision-response.ts` にも課す。
- **逆質量を引数に取ることで、割り算そのものを `physics/` から無くす**(§3-4・Phase 1)。
  `invMass` を受け取る形なら `physics/` 側に `1/mass` が現れないので、穴 2 は構造的に
  消える。**逆質量を作るのは `game/` 側**なので、そちらで `mass > 0` を保証する。

**残る調査対象:** 上記1が唯一の原因だったのかは、直してみるまで分からない。接触以外にも
発生源はありうる(姿勢積分・ベルトの Verlet・天体表面の至近での RK4 の発散・推力/抵抗)。
Phase 6 で、**接触経路については再現テストで塞いだことを確定させ**、それでも `NanWatchdog` が
発火するなら発生源は接触の外であると切り分けられる状態にする。

---

## 4. 完成後のモジュール構成

| ファイル | 変更内容 |
|---|---|
| `src/physics/sphere-contact.ts`(`swept-sphere.ts` を改名) | 責務を「球の接触判定の幾何」に確定。`sweptSphereToi` に加え、点/球が球の内側にあるかの判定(`attractor.ts` から移す)を持つ。引数は `Attractor` ではなく「位置と半径を持つ球」の構造的制約(§3-4) |
| `src/physics/collision-response.ts`(新規) | 2球の剛体接触の解決。逆質量(0 = 無限質量)・半径・反発係数だけを引数に取る純関数。撃力の大きさと補正後の位置/速度を返す |
| `src/physics/attractor.ts` | `hitAttractor`/`hitCelestialBody` を削除。`Attractor` は重力だけの型へ戻る |
| `src/physics/atmosphere.ts` | 大気による焼失の高度判定を受け入れる(`hitCelestialBody` が担っていた高度マージンの片方。判定モデルは不変) |
| `src/physics/occlusion.ts` | `isOccluded` の引数を `Attractor[]` から「位置と半径を持つ球」の構造的制約へ。実引数は現状のまま |
| `src/game/simulation/contact.ts`(`collision.ts` を改名) | ペア列挙・掃引判定・TOI 順序解決・両当事者への `collideWith` 呼び出し。ペアの特例分岐は全廃(§3-3)。参加者段階の有限値ガード(§3-12)。`Contact` 型の定義 |
| `src/game/simulation/hit.ts` | **削除。** 弾の命中は上記に吸収、至近通過音は `Bullet` へ移す(§3-11) |
| `src/game/simulation/simulator.ts` | 接触解決を substep ループ内へ移す。`onHighSpeedImpact`/`onPlayerCasingImpact`/`bulletCollision` を引数から削除。ベルトのフレーム単位パスは残す(§3-8) |
| `src/game/game-entity/game-entity.ts` | `collideWith`/`contactsWith` の既定実装を追加。`radius`/`mass` の意味をコメントで確定 |
| `src/game/game-entity/ship.ts` | `hitRadius` を削除。`attacked`/`collidedAtSpeed` を `collideWith` へ統合。`applyCollisionDamage(dv)` へ書き換え |
| `src/game/game-entity/bullet.ts` | `collides = true`・`mass`・`radius` を持つ。`collideWith`(自分は消える)と `contactsWith`(弾同士・敵弾の対象・自陣営への猶予 — **すべて `Shooter` 基準**、§3-3)を実装。至近通過音を持つ(§3-11) |
| `src/game/game-entity/enemy.ts` | `collidedAtSpeed`/`attacked` を `collideWith` へ統合。`shooter === 'enemy'` の早期 return は `Bullet.contactsWith` へ寄せて削除(§3-3) |
| `src/game/game-entity/debris-piece.ts` | `collideWith`。薬莢の接触音の持ち主になる(§3-11)。`fragment` の `mass = 0` を見直す |
| `src/game/nan-watchdog.ts` | `phase` の粒度が `simulator.advance` の内訳まで切れているかを確認し、足りなければ境界を足す(§3-12・Phase 6-5) |
| `tests/physics/collision-response.test.ts`(前掲) | 非有限入力(位置/速度/半径/質量)と質量 0 の伝播テストを追加(§3-12・Phase 6-4) |
| `src/game/player/player.ts` | 同上。`hitRadius` の代入と `radiator.hitRadius()` の呼び出しを削除 |
| `src/game/player/radiator.ts` | `hitRadius()`/`sideHitBy()` を削除。蛇腹の折りごとの接触代理を出す口を追加(§3-6) |
| `src/game/player/belt-physics.ts` | `BeltSection` の特例を `contactsWith` の実装へ移す |
| `src/game/game.ts` | 接触コールバックを削除。`Enemy` の import が不要になれば落とす |
| `src/game/const.ts` | `COLLISION_DAMAGE_MIN_SPEED`/`_FULL_SPEED` を `Δv` 基準へ置き換え。`PLAYER_RADIUS` を削除。弾の質量・半径、接触用セルサイズ、至近通過距離を追加。`REENTRY_ALT` 系のコメントを「大気による焼失」と明記。`*_HIT_*` 十数語の改名(§3-10) |
| `src/game/nav-target.ts`・`plan/plan-editor.ts`・`targeter.ts`・`stages/stage-utils/score-counter.ts`・`hud/dom.ts` | `hit` 語彙の整理(§3-10)。ローカル変数の `hit` → `picked`、CSS クラス `mk-boardhit` → `mk-boardpass`。`ScoreCounter.recordHit` は**そのまま残す** |
| `tests/physics/sphere-contact.test.ts`(改名) | 掃引接触に加え、球内判定・`Attractor` の構造的適合 |
| `tests/physics/collision-response.test.ts`(新規) | 運動量保存・反発係数とエネルギー損失・逆質量 0 の片側解決・力積の質量依存性 |
| `DEVELOP/*` / `CLAUDE.md` / `feature_todo.md` / `refactor-fixed` | Phase 7 |

---

## 5. フェーズ別手順

### Phase 0 — 天体表面接触を重力から引き剥がし、大気と分ける(実施済み)

撃力計算に触れないので単独でコミットできる。

**0-1.** `physics/swept-sphere.ts` → `physics/sphere-contact.ts` へ改名。テストも
`tests/physics/sphere-contact.test.ts` へ改名し `tests/physics/index.ts` を直す。
**旧名のエイリアスを残さない。**

**0-2.** `physics/attractor.ts` の `hitAttractor`/`hitCelestialBody` を削除し、
「点が半径 + margin の球の内側にあるか」を `sphere-contact.ts` へ移す。
引数は `map-pick.ts` の `pickNearest<T extends {pos: Vec3}>` と同じ構造的制約
(`T extends { radius: number; state: KinematicState }`)にし、呼び出し側は今持っている
`Attractor[]` をそのまま渡せるようにする。**名前に `hit`・`Attractor`・`CelestialBody` を
使わない**(重力源にも天体にも限定されない幾何だから)。**判定式は変えない。**

**0-3.** 呼び出し元(`GameEntity.checkLoss`/`stepPredicted`、`Player.checkLoss`、
`Enemy.checkLoss`、`Bullet.checkLoss`、`DebrisPiece.checkLoss`、`PlanArc` の積分打ち切り)で、
**渡していたマージンの意味を分ける**:

- `REENTRY_ALT`/`DEBRIS_REENTRY_ALT`/`PLAYER_MIN_ALT` を使う判定は**大気による焼失**。
  `physics/atmosphere.ts` 側の関数として呼び直す。大気を持たない天体には掛からないようにする
  (現状の唯一の大気は地球なので、判定対象を地球に限る)。
- 表面そのものへの接触はマージン 0 の球内判定として残す(Phase 2 で `collideWith` へ移るまでの
  つなぎとして `checkLoss` に置いたままでよい)。

**0-4.** `physics/occlusion.ts` の `isOccluded` を同じ構造的制約へ揃える。

**0-5.** `sphere-contact.test.ts` に球内判定のテストを追加(表面の内外・margin 境界・
複数球・`Attractor` の構造的適合)。

**0-6.** `grep -rn "hitAttractor\|hitCelestialBody\|swept-sphere" src tests` が 0 件。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で、再突入による喪失・
デブリの消滅・計画軌道の `✕` マーカー・マップのアイコン遮蔽が従来どおり動くこと。
**月・小惑星の近傍で 95km 相当のマージンが掛からなくなっている**ことを確認する
(これは意図した挙動変化)。

---

### Phase 1 — 剛体解決を `physics/collision-response.ts` へ抽出(実施済み)

**1-1.** `game/simulation/collision.ts` の `resolveCollisionPair`(`:84-145`)から、
めり込み補正・法線・反発後速度・力積の計算を `physics/collision-response.ts` へ移す。
**数式は変えない。** ただし引数は質量ではなく**逆質量**にし、`0`(無限質量)を受け付ける
(§3-4 の天体側で必要になる)。

```ts
// physics/collision-response.ts
export interface CollisionResponse {
  readonly rA: Vec3; readonly rB: Vec3;   // 補正後の位置
  readonly vA: Vec3; readonly vB: Vec3;   // 反発後の速度(離反中なら元のまま)
  readonly normal: Vec3;                  // a → b の接触法線
  readonly impulse: number;               // 力積の大きさ [N·s]。反発しなければ 0
}
```

**1-2.** `collision.ts` 側は `collision-response.ts` を呼んで `state` を書き戻すだけの
薄い層に縮める。**この時点では外部インタフェース(`onHighSpeedImpact` 等)を変えない** —
このフェーズは純粋な抽出。

**1-3.** `tests/physics/collision-response.test.ts` を新設し `tests/physics/index.ts` へ登録:

- **運動量保存:** 反発後の `mA·vA + mB·vB` が反発前と一致する。
- **反発係数:** `e = 1` で運動エネルギーが保存され、`e < 1` で単調に損失する。
- **逆質量 0:** 片側の逆質量が 0 なら、その側の速度・位置が一切変わらず、もう片側の
  法線方向速度が `-e` 倍になる。
- **力積の質量依存性:** 同じ法線相対速度でも、`impulse` は換算質量に比例し、
  `impulse / mass`(各側の Δv)は質量に反比例する(§3-5 の根拠の検算)。
- **抽出の等価性(一時テスト):** 抽出前の `resolveCollisionPair` の結果とビット一致する
  ことを一時的なコードで確認し、確認後に削除する(恒久テストにはしない)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で艦同士・薬莢・
デブリ・補給の反発が見た目上今までどおりであること。

---

### Phase 2 — 帰結を当事者へ移し、`game.ts` から分岐を消す(実施済み)

**2-1.** `GameEntity` に `collideWith(other, contact)` / `contactsWith(other, simTime)` の
既定実装(何もしない / `true`)を追加する。`Contact` 型を
`game/simulation/contact.ts` に定義する(§3-2)。

**2-2.** `collision.ts` を `contact.ts` へ改名し、解決後に両当事者へ `collideWith` を呼ぶ形へ
変える。`onHighSpeedImpact`/`onPlayerCasingImpact` を削除し、`Simulator.advance`・`game.ts`
から対応する引数とコールバックを消す。**ペアの特例分岐(ベルト同士・自機とベルト)を
`BeltSection.contactsWith` へ移す**(§3-3)。

**2-3.** `Ship.applyCollisionDamage(speed)` を `applyCollisionDamage(dv)` へ書き換え、
`const.ts` の `COLLISION_DAMAGE_MIN_SPEED`/`_FULL_SPEED` を `Δv` 基準の定数へ置き換える。
値は**艦同士の衝突(既存で唯一ダメージが発生していた組)のダメージカーブが従来と一致する**
ように逆算する — `Δv = impulse/mass` は旧来の `speed`(法線相対速度そのもの)と次元は同じでも
値が違う(質量比・反発係数に依存する)ので、旧来のシナリオを再現して数値を合わせる。

**2-4.** `Player.collidedAtSpeed`/`Enemy.collidedAtSpeed` を `collideWith` へ統合する
(§3-5 の2分岐のうち、弾でない側)。薬莢の接触音は `DebrisPiece.collideWith` が鳴らす
(`kind === 'casing'` かつ相手が `Player` のとき。操作艦に限定しない — §3-11)。

**2-5.** **有限値ガードを参加者の段階へ移す**(§3-12)。`contact.ts` の参加者リストを組む
段階で、位置・速度・半径・質量のいずれかが非有限、または質量が正でないエンティティを外す。
`resolveCollisionPair` にあった `distSq` のガードはここへ吸収される
(**消すのではなく、より広く効く場所へ移す**)。この時点で速度の穴(§3-12 の1)が塞がる。

**2-6.** 天体を接触の参加者として `contact.ts` の列挙へ加える(逆質量 0)。
Phase 0-3 で `checkLoss` に残していた表面接触のつなぎを削除し、`Ship.collideWith` の
`Δv` 判定へ載せ替える。**大気による焼失の判定は `checkLoss` に残したまま触らない。**

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で:

- 艦同士の衝突ダメージが従来と同程度であること(2-3 の逆算の実地確認)。
- **薬莢・デブリ・小惑星が艦に高速で衝突すると艦がダメージを受ける**こと(現状に無い挙動)。
- **低相対速度で天体表面に接地しても即座に喪失しない**こと(現状に無い挙動)。
  軌道速度のまま突っ込めば従来どおり破壊されること。
- 排莢直後の薬莢が自機のダメージ原因にならない程度の低速であること。
- 薬莢どうし・デブリどうしの接触では相変わらずダメージが発生しないこと
  (`Ship` でないものは HP という概念を持たないので当然の帰結、の確認)。

---

### Phase 3 — 弾を接触の参加者にし、`HitSystem` を廃止する(実施済み)

**3-1.** `Bullet` に `collides = true`・`mass`・`radius` を与える(`const.ts` に定数を追加)。
`contactsWith` に既存の特例を **`Shooter` 基準で**移す(§3-3。`BulletType` で書かない —
今日の弾種と射手の対応は偶然の一致):
弾同士は接触しない / `shooter === 'enemy'` の弾は `Enemy` と接触しない /
弾は自陣営の艦と発射後 `SELF_CONTACT_GRACE` の間は接触しない。
**`Enemy.attacked` 冒頭の `if (bullet.shooter === 'enemy') return;` は、同じ規則の二重記述に
なるので消す**(規則は `contactsWith` の1箇所に置く)。

**3-2.** `Bullet.collideWith` を実装する — **自分は消える**(`alive = false`)。
相手に与えるダメージは書かない(相手の責務)。

**3-3.** `Ship.collideWith` に「相手が `Bullet` なら武装ダメージ」の分岐を足す(§3-5)。
`Player` 側は熱の加算・被弾部位の決定・破壊エフェクトを含む既存の `attacked` 相当を、
`Enemy` 側は `recordHit`/`recordEnemyDeath` を含む既存の `attacked` 相当をここへ移す。
**被弾部位は「どの接触代理が当たったか」で決まる**(§3-6。Phase 5 で放熱板代理が入るまでは
機体本体の1球だけなので、部位は従来どおり無作為)。

**3-4.** デブリへの命中(ガスパフを出して弾が消える)を `DebrisPiece.collideWith` へ移す。

**3-5.** 敵弾の至近通過音(`Sfx.magneticInterference`)を `Bullet` へ移す(§3-11)。
発火条件は `shooter === 'enemy'`(弾種ではない)、鳴らす音は弾種で選ぶ。
`Bullet` のコンストラクタで `Sfx` を受け取り(生成元の `Enemy.behave` は既に `_sfx` を持つ)、
`checkLoss` が既に受け取っている `playerPos` との距離だけで鳴らす。**線分での最接近は取らない
— 意図的に雑にする。** 距離のしきい値は `const.ts` へ定数として置く(今の `hitRadius + 15m` は
消える `hitRadius` に依存しているので、そのままは使えない)。
その後 `simulation/hit.ts` を削除する。

**3-6.** `backlog.md` へ引き継ぎを2行残す — 至近通過音の判定精度(substep 間の通り抜け)と、
薬莢の接触音の距離減衰・操作艦以外の扱い(Phase 2-4)。どちらも `feature_todo.md`
「sfx が鳴る位置を sfx に伝える」のマイク導入で作り直す。

**3-7.** `Simulator.advance` から `bulletCollision` 引数を削除する(接触に一本化されるため)。

**検証:** `npm run typecheck`。`npm run dev` で:

- 弾が艦に当たってダメージを与え、弾が消えること(既存の挙動の維持)。
- 高速弾がトンネリングしないこと(至近距離での射撃)。
- 自弾が発射直後に自機へ当たらず、猶予を過ぎれば当たること(既存の非対称の維持 — §3-3)。
- 敵弾が敵機に当たらないこと。
- 敵弾の至近通過音が鳴ること(至近を通す必要があるので、敵の正面に停止して確認する)。
- 弾がデブリに当たるとガスパフが出て弾が消えること。

---

### Phase 4 — 全ペア掃引化と TOI 順序解決、実測(実施済み)

**4-1.** `contact.ts` の接触検出を、掃引判定(`sphere-contact.ts` の `sweptSphereToi`)を
一次手段とする形へ変える。重なり補正は異常時のフォールバックとしてだけ残す(§3-7)。

**4-2.** 1 substep 内の接触を TOI 昇順で解決する。解決するたびに残りのペアの TOI を
引き直す。1 substep あたりの解決件数に上限を置き、超えた分は次 substep へ持ち越す。

**4-3.** 接触の解決を `Simulator.advance` の substep ループ**内**へ移す。
**ベルトのフレーム単位パスは substep の外に残す**(§3-8)。
ワープゲート(`canResolvePhysicalCollisions`)は接触全体に掛ける。

**4-4.** `step4.md` Phase 7 の空間ハッシュを掃引に対応させる(§3-9)。接触用のセルサイズ
定数を `const.ts` へ追加し、substep 上限と軌道速度から逆算した値にする。
**取りこぼしが出ない条件をテストで固定する**(最大移動距離を超える相対移動で
ペアが列挙されなくなる境界)。

**4-5.** **実測する。** `step4.md` Phase 7 の `stage-debug-load.ts` で、Phase 4 着手前後の
sim フェーズ所要時間を `?perf=1` で計測し、本書 §8 に記録する。定数倍に収まらなかった場合は
判定モデルを緩めず、列挙の絞り込み側で解決する(§3-8)。

**検証:** `npm run typecheck` / `npm run test:physics`。`npm run dev` で高負荷ステージを含む
全ステージが従来どおり動き、めり込み(物体同士がめり込んだまま押し合う)が発生しないこと。

---

### Phase 5 — 放熱板を実体化し、被弾半径を廃止する(実施済み)

**5-1.** `RadiatorSystem` に、蛇腹の折りごとの接触代理を出す口を追加する
(`BeltPhysics.collisionSections` と同じ形。ただし Verlet 解法は不要で、艦の姿勢と
`foldThetas(side)` から一意に決まる剛体の取り付けとして毎フレーム置き直すだけ)。
`contact.ts` の参加者へ加える。

**5-2.** 放熱板代理の `collideWith` が、その側の放熱板パーツへダメージを入れる。
`RadiatorSystem.sideHitBy()` と `hitRadius()` を削除する。

**5-3.** `Ship.hitRadius` を削除し、全参照を `GameEntity.radius` へ寄せる。
`Player` の `radius` は `PLAYER_HULL_RADIUS` のまま(放熱板は代理が持つ)。
`const.ts` の `PLAYER_RADIUS` を削除する(§3-6)。

**5-4.** `grep -rn "hitRadius\|PLAYER_RADIUS\|sideHitBy" src` が 0 件。

**検証:** `npm run typecheck`。`npm run dev` で:

- 放熱板を展開すると弾が当たりやすくなること(従来の挙動の維持)。
- 当たった側の放熱板パーツの HP が減り、全損時に破片エフェクトが出ること(同上)。
- **展開した放熱板が薬莢やデブリを弾くこと**(現状に無い挙動 — 簡易実装の是正)。
- 収納状態では従来どおり機体本体の判定だけになること。

---

### Phase 6 — 有限値ガードの再確立と、NaN 発生源の切り分け(実施済み)

構造が出揃ったところで、ガードが本当に効いていることを固定する(§3-12)。
**Phase 2-5 で移したガードの「確認」フェーズであって、ここで初めて実装するのではない。**

**6-1.** 参加者フィルタのガードが、位置・速度・半径・質量の**4つすべて**を見ていることを
確認する。1つでも欠けていると、そこが伝播経路として残る。

**6-2.** `physics/collision-response.ts` と `sphere-contact.ts` の条件式が
`if (!(x > 0)) return null` 形で書かれていることを確認する(§3-12)。
`x <= 0` 形へ「読みやすく」書き換えられていたら戻す — **NaN に対する真偽が反転する。**
この意図をコメント1行で残す(消えると次に必ず書き換えられる)。

**6-3.** 逆質量の生成側(`game/`)が `mass > 0` を保証していることを確認する。
特に **Phase 3 で与えた弾の質量が 0 でないこと**(§3-12 の穴2)。

**6-4.** **伝播テストを `tests/physics/` へ追加する。** 片側の位置/速度/半径/質量を
それぞれ非有限にした4通り + 質量 0 の1通りについて、`collision-response.ts` が
「何も返さない/相手側の値を一切書き換えない」ことを固定する。
`sweptSphereToi` についても同じ入力で `null` を返すことを固定する。
**この5通りは今日どれも本番で踏みうる経路なので、恒久テストとして残す。**

**6-5.** **接触の外の発生源を切り分ける。** ここまでで接触経路は塞がっているので、
それでも `NanWatchdog` が発火するなら発生源は接触の外である。`NanWatchdog` の `phase`
文字列が、今の呼び出し位置(`player.behave` / `activeStage.update` / `simulator.advance`)
より細かく切れているかを確認し、`simulator.advance` の内訳(積分・姿勢積分・接触・
ベルト)が区別できないなら、その粒度まで境界を足す。**再現手段が無い以上、次に起きたときに
一発で切り分けられる状態を作ることが唯一できる対策**であり、これは調査のための恒久的な
計装であってデバッグ用の仮設ではない。

**6-6.** 疑わしい残りの発生源を `backlog.md` へ列挙して引き継ぐ(姿勢積分の発散・
ベルトの Verlet・天体表面至近での RK4 の発散・極端な高度での抵抗/推力)。
**「直った」と書かない** — 接触経路について塞いだ、とだけ書く。

**検証:** `npm run typecheck` / `npm run test:physics`。

---

### Phase 7 — `hit` 語彙の一括整理(実施済み)

構造の変更が全部済んでから、機械的な改名だけをまとめて行う(§3-10)。**構造のフェーズと
混ぜないこと** — 改名と設計変更が同じ diff に載ると、どちらのレビューもできなくなる。

**7-1.** `const.ts` の `*_HIT_*` を3種類に分けて改名する:
`PLAYER_HIT_DAMAGE`/`ENEMY_HIT_DAMAGE`/`RADIATOR_HIT_DAMAGE` → `*_BULLET_DAMAGE`、
`BULLET_HIT_FLASH_*`/`PLASMA_HIT_FLASH_*`/`HIT_FRAG_*`/`COLOR_*_HIT_FLASH` → `*_IMPACT_*`、
`SELF_HIT_GRACE` → `SELF_CONTACT_GRACE`、`RADIATOR_HITTABLE_DEPLOY` → `RADIATOR_CONTACT_DEPLOY`、
`COLOR_MARKER_BOARDHIT` → `COLOR_MARKER_BOARDPASS`(`hud/dom.ts` の CSS クラス
`mk-boardhit` → `mk-boardpass` と、それを付ける側も併せて直す)。

**7-2.** `SweptSphereHit` → `SphereContact`。`collision.ts`(改名後 `contact.ts`)の
`const hit` → `const contact`。

**7-3.** 画面ピックのローカル変数を揃える —
`nav-target.ts:119`・`plan-editor.ts:304,345,367`・`targeter.ts:224,237` の
`const hit` → `const picked`。**`pickNearest`/`nearestSample` 自体は既に `pick` 語彙なので
触らない。**

**7-4.** `enemy.ts:270-275` の `timeToHit` → `leadTime`(`intercept.ts` の `solveLeadTime` に
合わせる)。

**7-5.** **`ScoreCounter.recordHit` と `Sfx.enemyHit` は改名しない**(§3-10 — スコアの
命中率はゲーム用語としての「命中」で、接触の一般化とは別概念)。この2つを `contact` へ
寄せると、薬莢が艦に触れただけで命中率が動く。

**7-6.** `grep -rn "hit" src --include=*.ts -i` を通し、残った `hit` が
`recordHit`/`enemyHit`/`hits` とその周辺だけであることを目視で確認する。

**検証:** `npm run typecheck`。`npm run dev` で的板通過マーク・被弾エフェクト・命中率表示が
従来どおりであること(改名だけなので挙動は変わらないはず)。

---

### Phase 8 — 変更セットの `/refactor`・`/refactor-fixed` 違反点検(実施済み)

1. **`collision-response.ts`/`sphere-contact.ts` が `Vec3`/`KinematicState` だけに依存し、
   `GameEntity`/`Ship`/`game/` を import していないか。**
2. **`game.ts` に接触の分岐が残っていないか**(§1-(4) — `grep -n "instanceof Enemy" src/game/game.ts`)。
3. **`contact.ts`(列挙側)が「何が起きるか」を知っていないか。** ダメージ・音・エフェクト・
   `alive` の書き換えが列挙側に残っていたら、当事者へ移す。
4. **`collideWith` の順不同性が守られているか**(§3-2)。`other` から接触の反応で変わる値
   (`state`/`alive`/`hp`)を読んでいないか。読んでいるなら `Contact` へ移す。
5. **`impulse` と `Δv` を取り違えていないか。** `impulse` は両者共通の1つのスカラー、
   `Δv` は各側が自分の質量で割った別々の値。
6. **弾のダメージが力積へ置き換わっていないか**(§3-5 — 置き換えてはいけない)。
   `Ship.collideWith` の2分岐が1本にまとめられていないか。
7. **大気による焼失と固体表面接触が混ざり直していないか**(§3-4)。
   大気を持たない天体に高度マージンが掛かっていないか。
8. **消えるべき名前が残っていないか:** `HitSystem` / `hitRadius` / `hitCelestialBody` /
   `hitAttractor` / `collidedAtSpeed` / `onHighSpeedImpact` / `onPlayerCasingImpact` /
   `PLAYER_RADIUS` / `sideHitBy` / `COLLISION_DAMAGE_MIN_SPEED` / `swept-sphere` /
   `SELF_HIT_GRACE` / `timeToHit` / `mk-boardhit`。
9. **`hit` がスコアの命中率以外に残っていないか**(§3-10、Phase 7-6)。逆に、
   `recordHit`/`enemyHit` まで `contact` へ寄せてしまっていないか(寄せてはいけない)。
10. **至近通過音が `contact.ts` へ紛れ込んでいないか**(§3-11 — 接触ではないので、
    接触判定側が最接近距離を報告する形にしてはいけない。持ち主はプラズマ弾)。
    薬莢の接触音が `contact.ts` や `game.ts` に残っていないか(持ち主は薬莢)。
11. **有限値ガードが、参加者フィルタで位置・速度・半径・質量の4つとも見ているか**(§3-12)。
    `physics/` 側の条件式が `!(x > 0)` 形のままか(`x <= 0` に書き換わっていたら NaN が通る)。
    伝播テスト(Phase 6-4)が `tests/physics/index.ts` に登録されているか。
12. **弾の接触可否が `BulletType` ではなく `Shooter` で書かれているか**(§3-3)。
    `grep -n "'plasma'\|'normal'" src/game/game-entity/bullet.ts` に接触可否の分岐が
    出てこないこと(弾種を見てよいのはメッシュ・音・エフェクトの選択だけ)。
    `Enemy.attacked` の `shooter === 'enemy'` 早期 return が消えているか(二重記述)。
13. §4 の表にある全ファイルの diff を見て、コメントの過不足(`/comment` 基準)を個別に点検する。

レビューで見つかった問題はこの変更セットの中で修正する。

---

### Phase 9 — 設計文書の更新(実施済み)

同じ変更セットに含める(`/develop-docs`):

- **CLAUDE.md** — `game/simulation/collision.ts` → `contact.ts` の項を書き直し、3層分割
  (§3-1)と `collideWith`/`contactsWith` の規約(§3-2・§3-3)を反映。`hit.ts` の項を削除。
  `physics/` の一覧に `collision-response.ts` を追加し、`swept-sphere.ts` を
  `sphere-contact.ts` へ差し替え。`attractor.ts` の項から `hitAttractor`/`hitCelestialBody`
  を削除。**「表面接触は `hitCelestialBody` が唯一の答え」という記述は複数箇所にあるので
  全部直す**(`kinematic-state.ts` の項・各エンティティの項)。`Ship` の項から `hitRadius` を
  削除し、放熱板の項を実体化後の形へ書き直す。
- **DEVELOP/CALLSTACK.md** — 接触が substep ループ内へ移ったこと、`HitSystem` が消えたこと、
  ベルトがフレーム単位の例外であることを反映。
- **DEVELOP/OWNERSHIP.md** — 放熱板の接触代理の所有(`RadiatorSystem`)を追加。
- **`src/game/nan-watchdog.ts` の冒頭コメント** — 「`collision.ts` の距離判定は NaN を
  弾けず」という記述が、参加者段階のガード(§3-12)の導入で事実と食い違う。
  **消すのではなく現状に合わせて書き直す** — この経緯こそがガードを二度と落とさないための
  一次情報であり、`/comment` 基準でも「相当に非自明な実装の理由」にあたる。
- **DEVELOP/SPEC.md** — 相対速度によって結果が変わる接触(接地・デブリの凶器化)を仕様として
  記述する。§16「実装される可能性のある機能」へ、今回対象外とした3点を追記:
  静止接触の安定化(摩擦・スリープ、§3-4)、大気を持つ天体の一般化(現状は地球のみ、§3-4)、
  弾のダメージを武装スペックから物理量へ置き換えること(§3-5 — 独立したゲームバランス判断)。
- **`memos/hedalu244/feature_todo.md`** — 「衝突判定の統一化」の節を**丸ごと削除する**
  (統合も4つの `hit` の語彙決着も本書で完了するため。経緯は残さない)。
  「sfx が鳴る位置を sfx に伝える」の節には、至近通過音が `Bullet` へ移り精度を落としたまま
  であること(マイク導入で作り直す対象であること)を1行足す(§3-11)。
- **`.claude/skills/refactor-fixed/SKILL.md`** — 確定した責務境界として §4 へ追記:
  **接触判定は重力の関心事ではない**(§3-4)、**a と b の接触の帰結は a と b の責務であって
  検出側やオーケストレータの責務ではない**(§3-2)。既存の記述と整合させる。
- **`memos/hedalu244/better_simulation/step5.md`** — 本書の記述を「実装済み」に書き直し、
  §8 に実測値を記録する。残った未確認事項は `backlog.md` へ移す。
- 大きな変更なので、最後に `/comment-cleanup` で新旧コメントを一括点検する。

**検証:** `npm run typecheck`。

---

## 6. 落とし穴チェックリスト

1. **「統一する」を「1つの式にまとめる」と読み違えないこと。** 質量と相対速度だけで
   ダメージを計算するのは早急な一般化である(§3-5)。弾は武装スペック、剛体接触は `Δv`、
   という2分岐は**意図的に残す**。
2. **`collideWith` の中に相手への作用を書かないこと。** 自分が受けるものだけを書く。
   相手への作用は相手の `collideWith` が書く。両方書くと順序で結果が二重に入る。
3. **`other.state`/`other.alive`/`other.hp` を `collideWith` の中で読まないこと**(§3-2)。
   先に呼ばれた側の反応で変わっている。接触時点の値は `Contact` にある。
4. **`impulse`(両者共通)と `Δv = impulse/mass`(各側で別)を同じ変数名で扱わないこと。**
5. **大気による焼失の高度マージンを、固体表面接触のマージンとして使い回さないこと**(§3-4)。
   月や小惑星に 95km のマージンが掛かるのが今日の症状である。
6. **天体の質量を巨大な有限値で近似しないこと。** 逆質量 0 を受け付ける形にする(§3-4)。
   有限値だと `1/mass` の丸めで天体側がわずかに動き、`Ephemeris` の解析位置と食い違う。
7. **`mass = 0` のエンティティを接触へ参加させないこと**(§3-12 の穴2)。`invM` が `Infinity`
   になり `j * invMa` が `-0 × Infinity` = **NaN** になって両者へ書き込まれる。`DebrisPiece` の
   `fragment` は `collides = false` なので今は露出していないが、**Phase 3 で `Bullet` に
   質量を与えるとき 0 のままにすると即座に踏む。**
8. **有限値ガードを、より広く効く場所へ移す以外のことをしないこと**(§3-12)。
   これが落ちると、汚染された1体が全物体と接触判定され、接触した相手全員へ NaN が伝播する
   (`nan-watchdog.ts` が存在する経緯そのもの)。接触の参加者が弾・天体へ広がり、判定が掃引へ
   変わり、解決が `physics/` へ移る — **ガードが落ちる経路が4つ増える変更である。**
9. **`physics/` の `if (!(x > 0))` を `if (x <= 0)` へ「読みやすく」書き換えないこと**(§3-12)。
   NaN に対する真偽が反転し、非有限入力が判定を通り抜ける。`sweptSphereToi` が非有限入力に
   耐えているのは、全分岐がこの形で書かれているからである。
10. **放熱板の実体化を「半径を伸ばす」で済ませないこと**(§3-6)。それが今日の症状そのもの。
11. **ベルトを substep へ持ち込まないこと**(§3-8)。実 `dt` を要求する局所シミュレーションで、
    ワープ時に破綻する。
12. **音を「精度を上げる方向で」作り直さないこと**(§3-11)。至近通過音に接触判定から
    最接近距離を報告させるのも、薬莢音に距離減衰を付けるのも間違い — どちらもマイク導入で
    捨てる。当事者へ移して雑なまま置き、`backlog.md` へ送る。黙って消すのも駄目。
13. **改名を構造のフェーズに混ぜないこと**(Phase 7)。同じ diff に載ると両方のレビューが
    できなくなる。
14. **`recordHit`/`enemyHit` まで `contact` へ寄せないこと**(§3-10)。命中率が
    「薬莢が触れた回数」を数え始める。
15. **実測せずに「定数倍だから問題ない」と書かないこと**(§3-8)。測って §8 に記録する。
16. **弾の接触可否を `BulletType` で書かないこと**(§3-3)。今日は自機=`normal`/敵=`plasma` で
    一致しているので**書けてしまう**が、弾種が増えた瞬間に壊れる。射手で書く。
17. **`step4.md` と並行して `collision.ts` を触らないこと**(§0)。

---

## 7. このステップでやらないこと

- **静止接触(resting contact)の安定化。** 摩擦・スリープ処理は入れない(§3-4)。
  接地は「跳ね返らずに済む」ところまでで、SPEC §16 へ残す。
- **大気を持つ天体の一般化。** 大気は地球のみのまま。判定モデルも変えない(§3-4)。
  変えるのは置き場所と、大気を持たない天体に掛からなくすることだけ。
- **弾のダメージを武装スペックから物理量へ置き換えること。** ゲームバランスの独立した
  判断が要る(§3-5)。SPEC §16 へ残す。
- **非剛体(大気・ガス惑星・プラズマ弾)の接触モデル。** §目標が明言する順序どおり、
  剛体の一般化が済んでから考える。
- **`sfx` のマイク概念の導入**(`feature_todo.md`「sfx が鳴る位置を sfx に伝える」)。
  それ自体で大きな改修であり、本書がやるのは**薬莢の接触音と至近通過音を当事者へ移す**
  ところまで(§3-11)。距離減衰・定位・最接近の精度はそちらで作る。
- **接触の外の NaN 発生源の追跡**(姿勢積分・ベルトの Verlet・天体表面至近での RK4 の発散・
  極端な高度での抵抗/推力)。本書は接触経路を塞ぎ、次に起きたときに切り分けられる状態を
  作るところまで(§3-12・Phase 6-5/6-6)。**「NaN が直った」と主張しない。**
- **`Attractor` から `radius` を外すこと。** `OrbitalElements.center.radius` 経由の高度算出
  (`elements.ts` の `apsisAltitudes`、`hud/orbit-info.ts`)が依存している。
  本書の指摘は「接触判定という**処理**が重力モジュールに居ること」であって、天体が半径を
  持つこと自体ではない。SPEC §16 へ残す。
- **`refactoring_todo.md` の他の項目**(sfx/bgm 分離、belt-physics の変換処理見直し、
  const.ts 解体等)。今回の変更セットとは無関係。

---

## 8. フェーズごとの検証コマンドと実測の記録

```
npm run typecheck          # 全フェーズで必ず
npm run test:physics       # physics/ を触る Phase 0・1・4・6・7 で必ず
npm run dev                # Phase 0 以降、目視確認
```

**実測(Phase 4-5 で埋める):**

| 計測点 | sim フェーズ [ms] | 備考 |
|---|---|---|
| Phase 4 着手前(`stage-debug-load`) | 132.6(8サンプル平均、132.05〜134.38の範囲) | `?stage=debug-load&perf=1`。asteroid 300 + debris 500、predict 301/301、ヘッドレス Chrome、`git stash` で Phase 4 前へ退避して計測 |
| 全ペア掃引化 + TOI 順序解決後(4-1〜4-4 まとめて計測) | 131.8(8サンプル平均、130.63〜132.50の範囲) | 同条件。差は誤差範囲内(むしろ僅かに速い)。sim フェーズは `Predictor`/重力積分が支配的で(800体の軌道予測)、接触解決(近接ペアのみ)のコストは全体に対して無視できるほど小さいため |
| 解決済みペアの除外 + グリッド使い回し前(通常戦闘、`stage=1`) | 15.73(定常状態12サンプル平均、11.77〜23.31の範囲) | `?stage=1&perf=1`。Space長押しで継続発砲、bullets 355〜427・casings 96(上限)・debris 24(上限)で定常状態、ヘッドレス Chrome |
| 解決済みペアの除外 + グリッド使い回し後 | 15.70(定常状態12サンプル平均、13.67〜19.48の範囲) | 同条件。bullets 261〜303・casings 96(上限)・debris 24(上限)。差は誤差範囲内 |

**結論:** `stage-debug-load` に続き、通常戦闘の継続発砲(弾数百発規模)でも sim フェーズは接触解決ではなく `Predictor`/重力積分が支配的で、解決済みペア除外・グリッド使い回しの前後で計測誤差の範囲を超える差は出なかった。掃引化・TOI順序解決・空間ハッシュの拡張いずれも sim フェーズを悪化させておらず、列挙の絞り込み側の追加対応は不要と判断した。
