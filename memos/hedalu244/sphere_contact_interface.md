# 2球体の接触判定器の I/F を整理する

## 1. 目的

判定器 `physics/sphere-contact.ts` が**答えを返しきっていない**ので、呼び出し側がその不足を
幾何で埋めている。埋めている場所が3つあり、いずれも判定器の責務を外へ漏らしている。

### 1-1. 判定器が「触れなかった」以外を伝えない

`sweptSphereContact` の `null` は、次の3つを区別せずに潰している。

- 区間を通して表面が触れなかった
- 区間の始点で既に重なっていた(掃引では解けないので離散判定へ委譲したい)
- 入力が非有限で判定できなかった

さらに、交差を返すときも**どちら向きに跨いだのか**(外→内なのか内→外なのか)を伝えない。
結果として `reachedBody` が `containingBody` で始点・終点の点判定を自分でやり直しており、
`reachedBody` は「判定器を回して最小 TOI を選ぶだけ」になっていない。

### 1-2. 天体の運動を、実測せずに凍らせている

掃引の相手が天体のとき、2箇所とも天体を止めている。

- `reachedBody` — 位置を区間の両端で同じにし、速度を 0 にする。
- `contact.ts` の `computeAttractorResponse` — 位置は止めるが速度は実速度を渡す。**片方だけ
  凍った半端な状態**で、三次で解くと位置が動かないのに接線だけが数十 km/s ある曲線になる。

どちらも「1ステップの間に天体は動かない」という近似だが、**その誤差も費用も測られていない。**
一方 RK4 は同じ状況を、天体自身の `state`(位置・速度)と `accel` から2次テイラーで外挿して
扱っている(`attractorPositionAt`)。同じ手を使えば、天体暦を引き直さずに区間の両端の状態が
出るので、**近似を入れる理由がない。**

凍らせてよいかどうかは、凍らせない実装の費用を測ってから決める。**測らずに粗い側へ倒さない。**

### 1-3. 読み手のいない引数 `margin`

`reachedBody` の `margin` は `src/` の4つの呼び出しすべてで `0`。`containingBody` の `margin`
も同じ。`DEVELOP/SPEC/ORBIT.md`「天体表面への到達判定」は
**「地表到達は固体表面への剛体接触であり、余裕(表面半径への上乗せ)は全天体で 0 である」**
と書いており、上乗せを持つ余地は仕様の側にも無い。

### 1-4. 修正後に期待される状態

- 判定器は「区間の始点で内側だったか」と「最初に表面を跨いだ瞬間」を返す。跨ぎの向きは
  始点の内外から決まるので、別の値として持たない。
- `reachedBody` の本体に距離・半径の比較が1つも無い。`containingBody` は消える。
- 天体は区間の間ちゃんと動く。区間の両端の状態は `attractor.ts` の外挿 I/F から出る。
- `margin` が消える。

---

## 2. 変更が必要な箇所

### `src/physics/sphere-contact.ts`

- 戻り値の型を差し替える。

```ts
// 区間内で表面を跨いだ瞬間。
export interface SurfaceCrossing {
  readonly toi: number;  // 区間内の割合 0..1
  readonly normal: Vec3; // a → b へ向く接触法線
}

// 掃引区間で2球の表面がどう交わったか。crossing の向きは startsInside で決まる
// (false なら外→内、true なら内→外)。crossing が null なら、区間を通して
// startsInside の側に留まっている。
export interface SweptSphereContact {
  readonly startsInside: boolean;
  readonly crossing: SurfaceCrossing | null;
}
```

  `sweptSphereContact` の戻り値は `SweptSphereContact | null` とし、**`null` は「入力が非有限で
  判定できない」だけを意味する。** 既存の `SphereContact` は `SurfaceCrossing` へ改名して消える。

- `linearSphereContact`: 始点が内側(`c <= 0`)のときに早期 return せず、`startsInside: true` と
  **大きい方の根**(`(-bb + sqrt(discriminant)) / (2*aa)`)を内→外の交差として返す。非有限入力は
  `null` を返す経路として分離する(いまは `!(c > 0)` が始点内側と NaN を同じ枝で潰している)。
- `cubicSphereContact`: 始点が内側のときの探索を足す。いまの `search` は「制御点の箱が球から
  離れていれば交差なし」で棄却するが、内側から始まる区間には**逆向きの棄却**が要る —
  制御点の箱が丸ごと球の内側(箱の最遠点までの距離が半径和未満)なら、その区間に交差は無い。
  `axisDistanceSq` の対になる `axisMaxDistanceSq` を足す。`refine` の不変条件を、
  「lo 側が始点と同符号・hi 側が反対符号」へ一般化する。
- `radiusSum > 0` を線形側にも先頭で課す。交差の瞬間の相対距離は必ず `radiusSum` なので、
  これを課せば法線が潰れることはなくなり、`normalized` の null 分岐が要らなくなる。
- `containingBody` を削除する(`margin` は削除済み)。

### `src/physics/attractor.ts`

- `attractorPositionAt` の隣に外挿 I/F を新設する。位置の2次テイラー式は `attractorPositionAt`
  にしか書かない(速度はその微分)。

```ts
// attractor 自身の state.t と accel から、時刻 t での位置と速度を弾道外挿する。
export function attractorStateAt(a: Attractor, t: number): KinematicState;
```

- `reachedBody`: `containingBody` の2つのフォールバックを削除し、判定器の戻り値だけで到達を
  決める。天体の区間端は `attractorStateAt(body, prev.t)` / `attractorStateAt(body, next.t)`。
  `AT_REST` を削除。
- 到達の選び方は、いまの3分岐と同じ優先順を保つ。

| 判定器の戻り値 | 到達状態 | 優先 |
|---|---|---|
| `startsInside: false`, `crossing !== null` | `toi` で補間した状態 | 最小 `toi` のもの。これがあれば下は見ない |
| `startsInside: true` | `prev` そのもの | 上が無いときだけ |
| `startsInside: false`, `crossing === null` / `null` | 到達なし | — |

### `src/physics/collision-response.ts`

- `sweptSphereContact` の戻り値から `crossing` を読む。`crossing` が無ければ、いまと同じ
  区間終端の重なり押し戻しへ落とす(`startsInside` は読まない — 押し戻しには貫入量が要り、
  そのために距離をどのみち測るので、`startsInside` を読んでも省ける計算が無い)。

### `src/game/simulation/contact.ts`

- `computeAttractorResponse`: 天体側の `SphereState.state` と掃引の始点を
  `attractorStateAt(body, eWork.t)` / `attractorStateAt(body, e.prevState.t)` にする。
  位置だけ凍って速度が実速度、という食い違いが消える。

### テスト

- `tests/physics/sphere-contact.test.ts` — ヘルパの戻り値型を追随させる。`containingBody` の
  3件は API ごと消えるので削除し、代わりに判定器の戻り値を押さえる件を足す(3-6)。
- `tests/physics/attractor.test.ts` — `containingBody` の import と 153〜154 行を削除。
- `tests/physics/collision-response.test.ts` — 変更なし(掃引の始点を渡していない)。

---

## 3. 達成目標

**実施後、次を1つずつ当てる。**

1. **`src/` に `containingBody` が無い。** `reachedBody` の本体に、距離と半径を比べる式が
   1つも無い(判定器を回して選ぶだけになっている)。
2. **判定器の戻り値だけで、呼び出し側が「始点で内側だったか」「跨いだか」「跨いだ向き」を
   判断できる。** `reachedBody` の3分岐がすべて戻り値から出ている。
3. **`margin` という識別子が `src/` に 0 件。**
4. **天体を静止させている掃引が `src/` に 0 件。** 天体の区間端の状態はすべて
   `attractorStateAt` から出ている。位置の2次テイラー式は `attractorPositionAt` の1箇所だけ。
5. `attractorStateAt` の呼び出しは `reachedBody` と `computeAttractorResponse` の2箇所。
6. **新しく足すテストが3件通る。**
   - 内→外: 始点が球の内側にある区間で、`startsInside` が真になり、脱出の `toi` が
     区間内に入る(線形・三次の両モード)。
   - 内に留まる: 区間の両端とも球の内側なら、`startsInside` が真で `crossing` が null。
   - 天体が動いて初めて当たる: 静止させると外れるが、天体の1ステップぶんの運動を入れると
     当たる配置で `reachedBody` が到達を返す。
7. **既存の挙動テストのうち、書き換わってよいのは次だけ。** これ以外が落ちたら、意図しない
   挙動変化を入れている。
   - `containingBody` を名指しする 3 + 2 件(API 削除)
   - 引数の並びが変わるだけの呼び出し(assertion は変えない)

---

## 4. 手順(着手順)

各ステップは単独で commit できる。毎ステップ `npm run typecheck` と `npm run test:physics`。

### Step 4: 天体を動かす

`reachedBody` と `computeAttractorResponse` を `attractorStateAt` へ差し替え、`AT_REST` を削除。
達成目標 6 の3件目をここで足す。**完了条件**: 達成目標 4・5 と、新規1件。

### Step 5: 判定器の戻り値を差し替える

`SurfaceCrossing` / `SweptSphereContact` を入れ、線形・三次の両方に内→外の解と
「箱ごと内側」の棄却を足す。`collision-response.ts` は `crossing` を読むだけに直す。
`reachedBody` は暫定で `crossing` だけを読み、`containingBody` のフォールバックを残したまま
通す。達成目標 6 の1件目・2件目をここで足す。**完了条件**: 新規2件と既存が通る。

### Step 6: `containingBody` を外して消す

`reachedBody` を `startsInside` を読む形へ直し、`containingBody` とそのテストを削除する。
**完了条件**: 達成目標 1・2。

---

## 5. 見積り

### 行数

| ファイル | 増減 | 内訳 |
|---|---|---|
| `sphere-contact.ts` | **+25** | 型 +12、内→外の解 +8、`axisMaxDistanceSq` と逆向き棄却 +12、`normalized` の null 分岐 −3、`containingBody` −11 |
| `attractor.ts` | **+4** | `attractorStateAt` +8、`containingBody` の2分岐 −6、`margin`・`AT_REST` の行 −2 |
| `collision-response.ts` | ±0 | 読む先が `.crossing` に変わるだけ |
| `contact.ts` | ±0 | 渡す値が変わるだけ |
| 呼び出し4箇所 | −4 | 引数1つぶん |
| テスト | **+5** | 新規3件 +30、`containingBody` 6件 −25 |

**正味 +30 行。**

### 費用(Step 4 が乗せるぶん)

`attractorStateAt` 1回 = 位置 12 演算 + 速度 6 演算 ≒ **20 演算**、および `KinematicState` 1つと
`Vec3` 2つのアロケーション。1ペアあたり2回呼ぶので **40 演算 + 6 オブジェクト**。

判定回数は「個体数 × 天体窓 × substep 数」。最高ワープ(`SUBSTEP_MAX_COUNT` = 64)で
`gravityAttractorsAt` の 65 体、`MAX_BULLETS` = 400 の弾だけを数えても

```
400 × 65 × 64 = 1.66M ペア / frame
→ 1.66M × 6 = 10M オブジェクト / frame
```

16.7ms の予算に対して明らかに過大。**この数は判定器の解法でも外挿の有無でもなく、
天体窓を総当たりしていること(65〜101 体)に比例している。** 削るなら天体側の broad phase で
候補を数体に絞るのが筋で、外挿を捨てて凍結へ戻すのは最後の手段。

**Step 4 の直後にこの数を実測し、記録する。** 実測せずに凍結へ戻さない。

---

## 6. リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
|---|---|---|
| 非有限ガードを `!(x > 0)` の否定形から `x <= 0` へ書き換える | NaN がどの比較でも false になる性質が失われ、**非有限入力が判定を通り抜けて NaN が伝播する。** 特に線形側は、始点内側の分岐を足すときに `c <= 0` と書きたくなる形をしている | `tests/physics/sphere-contact.test.ts` の非有限3件と `attractor.test.ts` の `reachedBody: 非有限な入力は到達なしとして扱う`。**始点内側と非有限を別の枝に割ること** |
| 区間が無い(`prev.t === next.t`)入力で `startsInside` を出さない | 三次側は `dt > 0` を先に見て落ちるので、**始点の内外を答えないまま「触れない」を返す。** 沈んでいる個体が消えなくなる | `attractor.test.ts` の `reachedBody: 区間の無い(prev === next)入力は点判定になる`。**始点の内外の判定を `dt` のガードより前に置く** |
| 内→外の探索で `refine` の不変条件を始点内側向きに直し忘れる | 二分法が符号の付いていない区間を詰めて、**区間内のどこでもない `toi` を返す** | 達成目標 6 の1件目。`toi` が区間内であることだけでなく、その時刻の相対距離が半径和と一致することまで当てる |
| 三次側に「箱ごと球の内側」の棄却を足さず、始点内側の区間を最大深度まで細分する | 落ちないだけに気づかない。**沈んだ個体1つにつき深さ32の再帰が丸ごと走る** | 高ワープで天体に沈んだ破片が出ているときのフレーム時間。棄却を足したうえで、内側に留まる区間(達成目標 6 の2件目)が即座に返ることを確認する |
| 天体を動かしたことで、周回中の物体の相対接線に天体の軌道速度(月 1km/s、太陽 30km/s)が乗り、三次の膨らみが変わる | いままで当たらなかった近傍通過が**偽陽性で到達と判定される**、またはその逆 | `attractor.test.ts` の `reachedBody: 表面に触れない近傍通過は検出しない`。同テストの天体は速度も加速度も 0 なので**この変化を捕まえられない** — 動く天体での近傍通過を1件足すこと |
| `computeAttractorResponse` で、掃引の始点だけ外挿して `SphereState.state` を元の `body.state` のまま残す | 位置は区間終端、速度は天体暦のエポック時刻という**別の瞬間の値が混ざる。** 撃力の符号がわずかにずれるだけなので、見た目には出ない | 両方を `attractorStateAt` から取っていることをコードで確認する。片方だけ直っていないかを Step 4 のレビューで当てる |
| `attractorStateAt` を `attractorPositionAt` の置き換えとして RK4 の重力ループへも入れる | 毎ステップ全エンティティ×全天体で `Vec3` を2つ余分に作る。**ゲーム全体で最も熱いループ** | `attractorPositionAt` の呼び出し元(`attractorAccel`、`dynamics.ts`)が変わっていないこと。位置だけが要る場所は位置だけを取る |
| 「判定器が返せるようになったから」と、誰も読まない値(脱出時刻の法線、終点の内外など)を足す | 使われない一般化が残り、読み手が何を渡すべきか判断できなくなる | 達成目標に挙げた3件以外に、新しい値の読み手が `src/` にあるかを確認する。無いなら足さない |

---

## 7. 検証

- `npm run typecheck` — 毎ステップ。
- `npm run test:physics` — 毎ステップ(`src/physics/` を直接触る)。
- Step 4 の直後、6章の費用を実測して記録する。
