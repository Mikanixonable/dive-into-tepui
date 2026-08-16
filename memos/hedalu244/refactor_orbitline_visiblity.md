# OrbitLine の表示条件が5経路に散っている

`TrajectoryLine` 側は「線を持っているか(`predictedLine !== null`)」へ一元化した。
`OrbitLine` には同じ方針が入っていないどころか、**「積分線が代替できるか」という
TrajectoryLine 固有の判断が GameEntity と EntityManager まで漏れ出している。**

## 1. 認識の訂正 — 正常系と異常系が逆だった

このメモの前版は「概念として軌道線を持つ物体が、積分線に代替される」と書いていた。これが誤り。
実際に画面で起きているのは

> **積分線を出したい物体が、積分線を出せないときに OrbitLine へフォールバックする**

であって、正常系は積分線、異常系(縮退表示)が楕円。前版は正常系と異常系を取り違えていたので、
「楕円の側に抑制フラグを立てる」という、原因と結果が逆向きの API を正当化してしまっていた。

正しい向きで見ると責務は自明で、**「フォールバックするか」は積分線の側の事象**。それが

```
TrajectoryLine.visible / predictionTruncated / predicted.state.t
  → GameEntity.supersedesAnalyticEllipse(simTime, horizon, overviewMode)
    → EntityManager.syncPlayerTrajectoryLines
      → OrbitLine.setSuppressed
```

と3モジュールを貫いて別クラスのフィールドへ書き込まれている。**整合性保持責務の漏洩**
(`/refactor` データ構造節)。

前版が挙げた「一元化できない理由」(生成し直すと1フレーム消える/GPU 資源が毎フレーム churn する)は
どちらも **「表示フラグを畳む先は生成/破棄しかない」という誤った前提**の上に立っていた。成立しない。

## 2. 「ケプラー外挿は物理に混入するから駄目」は撤回する

このメモの2版目は「`at()` は計画積分の重力源を作っているので、外挿を入れると近似が物理へ混入する」
と書いた。**これは誤り。** 現行の実装を読むと、比較対象を取り違えている。

### 2-1. いまは「近似で置く」のではなく「丸ごと落として」いる

```ts
// plan-attractors.ts:148-152
for (const e of this.entities.attractors()) {
  const state = e.displayState(t);
  if (state === null) continue;          // ← その天体の引力を 100% ゼロにする
  gravity.push({ ... });
}
```

`simulation/attractors.ts:29-30` のコメントは

> 動的重力天体も t の状態で組み、t の状態が得られない天体は落とす —
> **現在位置で凍結すると「その時刻に居ない場所」から引くことになる**

と書いている。これは**「現在位置で凍結する」ことへの反論**であって、外挿への反論ではない。
二体ケプラー外挿は、まさにその反論に答える手段 — 当時の選択肢に無かっただけ。

**落とす = その天体の寄与が 100% 誤り。二体外挿 = 摂動ぶんの誤差。** 後者が確実に良い。
「積分できていない未来において現実的に可能な最も正確な近似」というご指摘のとおり。

### 2-2. むしろキャッシュ鍵の歪みの根が消える

`plan-attractors.ts:30-33, 57-61` の `predictionCoverage`(`NO_PREDICTION` / `PREDICTION_SHORT` /
`PREDICTION_COVERS_PLAN` の3値)は、**天体が途中から現れる不連続**を `planSourceRevision` へ
どう載せるかという問題のために存在している。外挿すれば「不在」という状態自体が消える。

ただし**タダではない**: 外挿しても、先端が伸びるにつれ同じ t の答え(外挿値 → 積分値)は動く。
つまり鍵の設計は依然として必要。それでも

- 現行: 安定した鍵 + **天体まるごと欠落**という誤差
- 外挿後: 安定した鍵 + **有界な二体近似**の誤差

で後者が優る。`predictionCoverage` を単純化できるかは別途の判断
(perf memo v2 の B-2「`COVERS`↔`SHORT` の往復で `planSourceRevision` が毎フレーム動く」の根に触る)。

### 2-3. `PlanArc` の件は明示オプトインで解ける

天体貫入で `truncated` した計画区間を外挿すると ✕ マーカーを出しながら線が天体を突き抜ける
— これは**暗黙フォールバックへの反論**であって、実装場所への反論ではない。
ご提案の `at(t, allowExtrapolation = false)` 形(既定は現行動作、欲しいときだけ明示)で解ける。
そもそも `plan-arc.ts:246-251` の `at` は `t > tip.t` を自前で弾いているので、現状のままでも影響しない。

## 3. 本当の制約 — 中心天体をどう決め、どこから引くか

残る論点はここだけ。4つに分解できる。

### 3-1. 中心天体の位置は「2つの時刻」で要る

- **先端時刻**: 軌道要素を作るため(`orbitalElementsOf(tip, center)` は
  `frameOfAttractor(center)` で中心相対へ落とすので、中心の位置と速度が要る)
- **問い合わせ時刻 t**: 中心相対の結果を ECI へ戻すため
  (`positionOnOrbit` が返すのは中心相対)

**片方で兼ねることはできない。** 月周回で問い合わせ時刻の中心位置を先端時刻にも使うと、
月が動いた距離ぶんまるごと外れる。

### 3-2. 先端時刻ぶんは、既に毎ステップ払われている

```ts
// predictor.ts:80-94
const currentClassified = classifyAttractors(
  predictedAttractorsAt(this.ephemeris, this.entities, tipState.t),   // ← 先端時刻の天体窓
);
const currentAttractors = attractorsNearInto(tipState.r, currentClassified, …);
…
localOrbitPeriod(tipState.r, currentAttractors) / C.PREDICT_STEPS_PER_REV,
```

`localOrbitPeriod` は中で `strongestAttractor` を呼んでいる(`attractor.ts:90-93`)。
つまり **「先端位置で最も強く引く天体を、先端時刻の窓から選ぶ」処理は、予測1ステップごとに
既に走っている。** ここで選ばれた `Attractor` をそのまま `DynamicTrajectory` へ持たせれば
**追加コストはゼロ**。むしろ `strongestAttractor` の結果を `localOrbitPeriod` と共有すれば
現状より減る。

### 3-3. 問い合わせ時刻ぶんは、呼び出し側でコストが違う

- **物理側**(`plan-attractors.resolveAt(t)` / `predictedAttractorsAt(t)`)は、
  **同じ t の解析天体窓を既に引いている**(`ephemeris.attractorsAt(t)` /
  `gravityAttractorsAt(t)`)。中心はその配列から取れるので**追加の暦引きはゼロ。**
  `predictedAttractorsAt` は動的天体のループが先に来ているが、解析窓を先に引くよう
  順序を入れ替えるだけでよい。
- **表示側**(`TrajectoryLine` の外挿サンプル)は、サンプルごとに t が違うので
  `ephemeris.positionOf(centerId, t)` がサンプル数ぶん要り、`Ephemeris` の時刻リングキャッシュ
  (32スロット、完全一致キー)を全ミスする。**実コストが乗るのはここだけ。**

### 3-4. 中心天体の候補集合を解析天体に限る

`strongestAttractor` は `Asteroid` 由来の重力源も選びうる。その位置は結局 `displayState(t)` 経由に
なり、再帰と処理順依存が生まれる。**これは「外挿しない」で回避するのではなく、
中心天体の候補集合から非解析天体を外すことで回避する。**

- **常に中心が得られる**(レジストリが空でない限り)。「中心が決まらないから外挿できない」という
  縮退そのものが消える。
- **再帰が消える** — 中心の位置は必ず `ephemeris.positionOf(id, t)` で引ける。型ではなく
  構成として保証される。
- **処理順依存も消える** — どのエンティティが居合わせ、どこまで予測が伸びているかで
  中心の選択が変わらなくなる。

判定は `id in ephemeris.registry`。これは既にこのコードベースの定型で、`ephemeris.ts:454`
(`frameTransformAt` の回転天体解決)と `:474`(`frameCenterState` の「登録されていない id は
attractors から拾う」)が同じ形を使っている。

**近似の質は落ちない。** 小惑星が局所的に最強でも μ は極小(1e12 kg なら μ ≈ 0.067、
1 km 高度の周回速度が 8 mm/s)で、支配的な運動は日心/惑星中心の二体運動そのもの。
その二体運動を中心に外挿するのは妥当な近似で、「何も出さない」より確実に良い。

残る縮退は2つだけになる:

- **e ≥ 1** — `eccentricAnomalyFromMean`/`trueAnomalyFromMean` が楕円前提。
  ただし順方向(ν → t)は `timeSincePeriapsis` が既に双曲線を扱っている(`elements.ts:128-133`)ので、
  欠けているのは逆方向の双曲線ソルバだけ。既存の `timeSincePeriapsis` を往復テストのオラクルに
  使える、境界の明確な追加作業(**恒久的な制限ではない**)。当面の具体的な影響は
  「地球離脱中の艦は、地球が最強であるうちは外挿されない」。
- **`truncated`** — 再突入・貫入で以後伸びない列。落ちた先を延々と描くことになる。
  `GameEntity` 側の情報なので、オプトインの判断もそこで行う。

### 3-5. 結論

**`DynamicTrajectory` に置ける。** 条件は4つ:

1. **暗黙フォールバックにせず、明示オプトイン**(`at(t, center?)` / `allowExtrapolation`)。
   `PlanArc` と既存の全呼び出し側は既定のまま無変更。
2. **中心天体の候補集合は解析天体に限る。** これで中心は必ず決まり、必ず `positionOf` で引ける。
3. **先端時刻の中心天体は `DynamicTrajectory` が保持**し、`Predictor` が既に払っている
   `strongestAttractor` の結果を渡す。
4. **問い合わせ時刻の中心位置は呼び出し側が渡す。** これで `Ephemeris` 依存を
   `DynamicTrajectory` へ持ち込まずに済む(物理側はタダ、表示側だけが実コストを払う)。

外挿できないのは e ≥ 1 と `truncated` のときだけ。どちらも呼び出し側が判別できる。

## 4. 「描くか」を決める5経路(現状の記録)

| # | 経路 | 書き手 | 対象 | 外挿導入後 |
|---|---|---|---|---|
| 1 | `orbitLine !== null` | 各エンティティの ctor | Player/Enemy/Base | Player から消える |
| 2 | `displayEnabled` | `EntityManager.applyVisibility` | 自機・敵・基地 | 敵・基地に残る |
| 3 | `suppressed` | `EntityManager.syncPlayerTrajectoryLines` | 自機のみ | **消える** |
| 4 | `snap !== null` ← `syncOrbitLine(show, …)` の `show` | `Player.syncPlayer`(常に true)/ `Targeter`(`showGray`)/ `applyVisibility`(基地、`overviewMode`) | 全部 | 敵・基地に残る |
| 5 | `line.visible` の直書き | `Enemy` ctor(復元時の死亡艦) | 敵 | 残る |

経路2と経路4は**同じ問い**(この物体の軌道を見せたいか)を別の綴りで答えている。
`visibilityPolicy?.…orbit` の既定値も呼び出し側ごとに違う
(`applyVisibility` は `?? false`、`syncPlayerTrajectoryLines` と `Targeter` は `?? true`)。

## 5. 経路4の二重書き込みが実害を出している(外挿導入で自動的に消える)

`Game.sync` の順序:

```
477 entities.syncPlayers        → 全 Player が syncOrbitLine(true, …)   ← 1回目
484 entities.applyVisibility    → setDisplayEnabled / base.syncOrbitLine
491 targeter.sync               → 全 combatTarget が syncOrbitLine(showGray, …) ← 2回目
511 entities.syncPlayerTrajectoryLines → setSuppressed
```

`getCombatTargets(activePlayer)` は**操作対象艦だけを除く**ので、**非操作艦の `orbitLine` は
1フレームに2回、食い違う `show` で sync される。** 後勝ちで `Targeter` の判断が通る。
CLAUDE.md の「同じ要素に2人目の書き手が後から上書きしない」原則に正面から反する。

**毎フレームの完全再ベイク:** `OrbitLine.sync(null, …)` は `snap = null` を置いて
`setCurve` の手前で早期 return する。次フレームの `sync(el, …)` は `needsRegen`
(`snap === null` → true)で `revision` を差し替えるので、`Curve.setCurve` は
**4096頂点予算の適応分割をやり直す。** `showGray` が false になるのは
「戦闘ビュー」「その艦がターゲット」「死亡」「orbit トグル off」で、非操作艦はこのいずれでも
`syncPlayer` が焼いて `Targeter` が捨てるサイクルに入る。とくに

- **戦闘ビューでは非操作艦が常にこの状態**(CREATIVE で艦を並べるとその数だけ乗る)
- **マップビューで orbit トグルを off にしても止まらない** — `displayEnabled=false` で隠れるだけで
  焼く処理は毎フレーム走る。**1ピクセルも描かない線に全コストを払う。**

敵と基地は呼び出し側が1つなので出ない(`snap` が null に据え置かれ早期 return が効く)。
**症状は Player 固有**で、原因は二重書き込みそのもの。→ `Player.orbitLine` が消えれば根ごと消える。

**同じ楕円の2重描画:** ターゲットにされたエンティティは自分の `orbitLine` を `showGray=false` で
消され、代わりに `Targeter` が同じ軌道要素から同じ楕円を自分のインスタンスで描く。
違いは色と `renderOrder` だけで、`OrbitLine.setColor` は既にある。これは外挿とは独立に残る。

## 6. 計画

前版の W1 → W2(composite)→ W3 を破棄。**ケプラー外挿を土台として先に置き、
そのうえで表示と物理の両方をそこへ寄せる。** composite は不要になる
(フォールバックが「2本の線を切り替える」ではなく「1本の線の末尾を解析で継ぐ」になるため)。

### E1: ケプラー外挿を `DynamicTrajectory` へ置く(土台・単独では挙動不変)

- `at(t, …)` に明示オプトインの外挿を足す。既定は現行どおり `null`。
- 先端時刻の中心天体を保持する。`Predictor` が `localOrbitPeriod` の中で既に求めている
  `strongestAttractor` の結果を共有する(`localOrbitPeriod` の呼び出しと重複計算しない形へ)。
  ただし候補は解析天体に限るので、絞り込み済み配列に対する無フィルタの最強天体をまず取り、
  それが解析天体ならそのまま採用(ほぼ常にこちら)、非解析だったときだけ解析限定でもう1パス
  — という速い経路にする。
- 縮退(e ≥ 1 / `truncated`)は外挿せず `null` を返す。
- 純関数部分(先端の状態 + 中心 + 目標時刻 → 中心相対の状態)は `physics/` のテスト対象にする。

**この段階では誰も使わないので挙動は変わらない。** `npm run test:physics` の対象。

### E2: 表示を外挿へ寄せる(`OrbitLine` の抑制がここで消える)

`TrajectoryLine.syncGeometry(trajectory, from, to, frame, ephemeris, attractors)` は
`ephemeris` も `attractors` も既に受け取っている。`EntityManager` が `to` に `null` ではなく
`simTime + duration` を渡し、bake 済み区間が `to` に届いていなければ末尾を外挿で継ぐ。

`truncated` は `to` の値で表現する(`to = ship.predictionTruncated ? null : simTime + duration`)
— **「どこまで描いてほしいか」という要求値**であって「どちらの線を出すか」という実装選択ではないので、
外へ出しても漏洩にならない。

消えるもの:

- `GameEntity.supersedesAnalyticEllipse`
- `OrbitLine.setSuppressed` / `suppressed` フィールド / `applyVisible` の該当項
- `EntityManager.syncPlayerTrajectoryLines` の `setSuppressed` 行と `overviewMode` 引数
  (この引数は `supersedesAnalyticEllipse` にしか使われていない)
- `Player.orbitLine` の生成・sync・dispose、`Player.syncPlayer` の `syncOrbitLine` 呼び出し
- **戦闘ビュー/マップビューの分岐そのもの**(「覆っているか」で規則を変える必要がなくなり、
  どちらのビューでも「表示期間ぶん描く」で統一される)

非操作艦も同じ機構に乗る: 予測を持たない艦に `actual` を渡せば
`actual.state.t === simTime` なので `[simTime, simTime + horizon]` は 100% 外挿 =
解析楕円の弧そのもの。**「予測が1歩も進んでいない」は「予測が足りない」の極限。**
残る `OrbitLine` 利用者は `Enemy` / `Base` / `Targeter`×2 なのでクラス自体は残る。

### E3: 物理を外挿へ寄せる(計画軌道の形が変わる・独立した合意が要る)

`plan-attractors.resolveAt` と `predictedAttractorsAt` の `if (state === null) continue;` を、
外挿ありの問い合わせへ置き換える。天体まるごとの欠落が二体近似の誤差に変わる。
あわせて `predictionCoverage` の3値を残すか単純化するかを判断する(2-2)。

**E2 とは独立**。E2 だけでも `setSuppressed` の漏洩は消える。

### W1': 残る `OrbitLine` 経路の整理(独立・後でよい)

E2 後に残るのは `Enemy` / `Base` / `Targeter`×2。経路2・4・5 を1つの可視フラグへ畳む。
`Targeter` の2本を廃してエンティティ自身の線を役割で塗り替えれば
(`Curve` に `renderOrder` の setter を足す)、`Targeter` は可視を書かなくなり、
書き手は `applyVisibility` 1つになる:

```
見せる = overviewMode ? policy.orbit(entity) : (役割 !== 'none')
```

あわせて `Enemy` ctor の `line.visible` 直書きを規則の `alive` へ畳み、
`applyVisibility`(可視適用のメソッド)の中にある `base.syncOrbitLine(...)` を sync 側へ移す。

## 7. 実装で決める必要がある点

1. **外挿区間の刻み方(E2)。** 案A: 外挿サンプルを生成して bake に混ぜる。案B: sampler が
   bake 済み区間を超えた t で解析評価へ切り替える(サンプル生成なし)。
   **案Bは却下に近い** — sampler は frame 相対を返す契約なので `Curve` の適応分割が叩くたびに
   `ephemeris.frameTransformAt(frame, t, attractors)` が要り、各 t がユニークなので
   時刻キャッシュを全ミスする。案Aを推すが、**等時間刻みだと近点付近が粗くなる**
   (`OrbitLine` が適応分割を使っているのはこれを避けるため)。**真近点角で等分**して生成するのが
   よさそう — `TrajectoryLine` の sampler は時刻の二分探索なので非等間隔サンプルで問題ない。
2. **表示側の `positionOf` コスト(3-3)。** サンプル数ぶんの暦引きが乗る。
   ご指摘のとおり、`Ephemeris` の引く順序・キャッシュ構造の見直しと合わせて測る必要がある。
   中心天体の位置だけを粗い時刻で引いて補間する余地もあるが、先に測ってから判断する。
3. **双曲線ソルバを E1 に含めるか(3-4)。** 含めなければ「地球離脱中の艦は外挿されない」が残る。
   追加は平均近点角 → 双曲線離心近点角の Newton 法だけで、往復テストのオラクルは
   既存の `timeSincePeriapsis` がそのまま使える。
4. **`predictionCoverage` を残すか(E3)。** 外挿後も答えは先端の伸長に伴って動くので、
   何を鍵にするかは別途決める。
4. **非操作艦に `TrajectoryLine` を持たせるコスト(E2)。** `TrajectoryLine` は 16384 頂点、
   `OrbitLine` は 4096。容量を種別ごとに変えられるようにするかは検討。
5. **`Enemy`/`Base` は当面 `OrbitLine`(閉じた楕円)のまま**なので、自機だけが
   「表示期間ぶんの前向きの弧」になる。既定プリセット(1周期)では一致するが、期間を変えると
   揃わない。許容するか、いずれ全エンティティを E2 の機構へ寄せるか。

なお perf memo v2 の A-4(高ワープのマップビューで予測が毎フレーム全個体破棄され1体も完成しない)は
未解決。**E1/E2 の前提条件ではない**が、A-4 が残っていると外挿区間が毎フレーム大きく揺れる形で
見えるので、視覚の評価は A-4 の後がよい。

## 8. 更新が必要な文書(実施時)

- `CLAUDE.md` — `dynamic-trajectory.ts` / `game-entity.ts`(`supersedesAnalyticEllipse`)/
  `entity-manager.ts`(`syncPlayerTrajectoryLines`/`applyVisibility`)/ `trajectory-line.ts` /
  `plan-attractors.ts` の記述
- `DEVELOP/CALLSTACK.md` — 445-446 / 451-452 / 507 行
- `DEVELOP/OWNERSHIP.md` — 214 行と付録 607 行(自機 `OrbitLine` の表示抑制)
- `DEVELOP/SPEC.md` — 予測が表示期間に届かないときの見え方(視覚仕様の変更)
- `memos/hedalu244/fix_lines/for_agent.md` — 26 / 99 行の suppress 前提の記述
- `memos/hedalu244/improve_plan_predict_performance_v2.md` — B-2 の前提が変わる
