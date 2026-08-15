# OrbitLine の表示条件が3軸に散っている

`TrajectoryLine` 側は「線を持っているか(`predictedLine !== null`)」へ一元化した
(`showPredictedLine()`/`hidePredictedLine()` が生成と破棄を持ち、`syncTrajectoryLines` は
描くかを判定しない)。**`OrbitLine` には同じ方針を適用できていない。** その理由と、
将来是正するときに踏んではいけない地雷を記録する。

## いまの状態

`OrbitLine` の「描くか」は4つの独立した入力で決まる。

| 入力 | 持ち主 | 変わる頻度 |
|---|---|---|
| `orbitLine !== null` | 各エンティティ(`Player`/`Enemy`/`Base` が constructor で生成) | 生成・破棄時のみ |
| `displayEnabled` | `EntityManager.applyVisibility`(天体クラス別トグル) | プレイヤー操作時 |
| `suppressed` | `EntityManager.syncPlayerTrajectoryLines`(積分線が代替できるか) | **毎フレーム反転しうる** |
| `snap !== null` | `OrbitLine` 自身(有効な軌道要素を得ているか) | 毎フレーム |

加えて `GameEntity.syncOrbitLine(show, ...)` が **5つ目**の `show` 引数を取る
(`Targeter` はここへ別の条件を渡す)。`TrajectoryLine` で排除したのと同じ
「同じ判断を2経路で注入する」形が、こちらには残っている。

## 生成/破棄へ一元化できない理由

### 理由1: `snap` を捨てると1フレーム線が消える

`src/game/orbit-line.ts` の `setSuppressed` のコメントが、この設計の理由をそのまま書いている:

> 抑制を解いたフレームでそのまま描き戻せるよう、直近の sync が有効な軌道要素を得ていた場合
> (snap がある)に限って表示へ戻す — 次の sync を待つと、抑制が解ける原因になった線が
> 既に消えている1フレームのあいだ、どの線も出ない。

**生成し直した `OrbitLine` は `snap` を持たない。** つまり生成/破棄へ移すと、
このコメントが避けている「どの線も出ないフレーム」がそのまま復活する。
`suppressed` は「積分線が代替できるか」なので、解除される瞬間とは
**積分線が消える瞬間**であり、まさに端境期にあたる。

### 理由2: `suppressed` は毎フレーム反転しうるので、GPU 資源の生成/破棄が毎フレームになる

`entity-manager.ts` の

```ts
ship.orbitLine.setSuppressed(ship.supersedesAnalyticEllipse(simTime, duration, overviewMode));
```

は毎フレーム評価される。`supersedesAnalyticEllipse` はマップビューでは
「予測が表示期間を覆っているか」で答えるので、予測の伸長・破棄に追随して反転する。

そして 2026-08-16 の計測では、高ワープのマップビューで
**予測が毎フレーム全個体破棄され、1体も完成していない**(`pred-discard=6, pred-complete=0`、
`memos/hedalu244/improve_plan_predict_performance_v2.md` の A-4)。
この状態で生成/破棄へ移すと、**毎フレーム THREE の geometry と material を作っては捨てる**
ことになる。`OrbitLine` は内部に `Curve` を持ち、`Curve` は固定容量の
`Float64Array`/`Float32Array` と `THREE.LineSegments` を確保するので、
現行の「表示フラグを倒すだけ」より確実に重い。

## 是正するときの筋

**2つの軸を混ぜないこと。**

- 「この物体が概念として軌道線を持つか」— めったに変わらない。
  ここは生成/破棄(所有者の責任)へ移してよい。
- 「いま積分線に代替されているか」— 毎フレーム反転する。
  ここは表示フラグのまま残すべきで、資源の寿命を結びつけてはいけない。

順序としては、**先に A-4(予測の予算破綻)を直して `suppressed` の反転頻度を落とす**のが本筋。
反転が「予測が伸び切るまでの数フレーム」に収まれば、この軸自体が
毎フレームの問題ではなくなり、選べる設計が広がる。

`syncOrbitLine` の `show` 引数の排除は、上の2軸の整理とは独立に先行できる
(`Targeter` が渡している条件の持ち主を決めるだけ)。
