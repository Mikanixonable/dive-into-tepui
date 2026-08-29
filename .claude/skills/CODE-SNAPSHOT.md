# コードから引いた調査結果の出し方

`/callstack`(順方向)・`/inv-callstack`(逆方向)・`/ownership` が共通で従う、**図の形**と
**文書へ残すときの規則**。調査の手順そのものは各 SKILL.md にある。

## 1. 依存木の図の形(`/callstack` と `/inv-callstack` 共通)

**順方向と逆方向は同じ図で書く。違うのは子ノードの意味だけ。**

| | 木の根 | 子ノード | 答える問い |
| --- | --- | --- | --- |
| `/callstack` | 中心に置いた関数 | **呼び出し先**(下流) | 何を・どの順で・どんな条件で呼ぶか |
| `/inv-callstack` | 中心に置いた関数 | **呼び出し元**(上流) | 誰が・どんな条件で依存しているか |

罫線は `├─` / `│` / `└─`(同じ親の最後の子は `└─`)、1段は3桁。逆方向の例:

```
sweptSphereContact(aStart, aEnd, bStart, bEnd, radiusSum)   ← 掃引の幾何はここだけ。常に三次
├─ collision-response.ts  resolveSphereCollision
│  ├─ contact.ts  computeEntityResponse   (個体 × 個体)
│  └─ contact.ts  computeAttractorResponse(個体 × 天体 / ベルト節点 × 天体)
│     ├─ ContactPhysics.resolveSubstep …… simSpeed ≤ ×4、毎 substep
│     └─ ContactPhysics.resolveBelt ……… simSpeed ≤ ×4 かつ自機生存、フレームに1回
└─ attractor.ts  reachedBody(prev, next, bodies)   ← 幾何を持たず最小 TOI を選ぶだけ
   ├─ dynamic-entity.ts / player.ts / bullet.ts  checkLoss
   │     (`EntityManager.cleanup` から毎 substep、全生存個体)
   └─ predicted-arc.ts  checkSurfaceReach
         (`Predictor.update` から、実体の弧も計画の弧も同じ grow を通る)

linearSphereContact / curveSphereContact(次数) / sweptSagitta … src/ からの呼び出しは 0 件。
                                                                精度と費用の再検討用に残してある
```

**ノードの書き方** — モジュール関数は `ファイル名.ts  関数名`、クラスのメソッドは
`クラス名.メソッド名`。同名のものが複数の実装元に散っているなら `a.ts / b.ts  メソッド名` と
1行にまとめる。

**注記はこの3枠だけを使う。** 増やさない:

| 記号 | 書くもの |
| --- | --- |
| `← ` | そのノードの責務を一言。**結論に効くときだけ。** 全ノードには付けない |
| `…… ` | そのノードが**走る条件と頻度**(`simSpeed ≤ ×4、毎 substep`)。行末に置き、縦を揃える |
| `(…)` | そのノードが**何に対して**それをしているか(扱う対象の別) |

長い注記は次行へ字下げして置いてよい(上の `checkLoss` / `checkSurfaceReach`)。分岐は注記で
書く。同じ関数を条件違いで2ノードに割らない。

**引数は、それが結論に効くノードにだけ書く。** 根は必ず完全な署名(引数名まで)で書く — 何を
渡して何を返しているのかが、責務の置き場所を決める材料そのものになる。中間ノードは、渡している
ものが判断に効くときだけ書く。

**図の外に書くもの** — 木の下に空行を挟んで、必要な分だけ:

- 木に載らない例外(「`Enemy.checkLoss` は天体到達を見ない」「`BeltSection` は
  `EntityManager` に載らないので `cleanup` を通らない」)。
- 呼び出し 0 件の同族 API と、なぜ残っているか。**走査した範囲を明記する。**

`/ownership` の保持木もこの罫線で書く。ただし注記の中身は所有と参照の別・正本と導出値の別で、
それは `/ownership` の側にある。

## 2. 文書へ残すとき(3スキル共通)

**呼び出し主が保存先を指定したときだけ**書き出す。典型的には計画書・検討メモの md で、指定が
ないなら会話に出すだけにし、既存の文書へ勝手に書き足さない。

残すときは、図表の直前に**いつの時点のものかを必ず書く**:

```
**`e6838031` 時点のコードから引いたスナップショットであり、正本ではない。** 食い違ったら
コードを信じる。
```

hash は `git rev-parse --short HEAD` で取る。**どの commit の話なのかが書けないなら保存しない** —
いつのものか分からない依存木は、腐ったことすら判らなくなる。

`DEVELOP/` へは置かない。あそこは「どう振舞うべきか」の置き場で、これは現状の写しである。
