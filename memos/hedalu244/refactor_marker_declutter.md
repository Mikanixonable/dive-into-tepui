# marker-manager からラベル混雑の解決を切り出す

`src/game/marker/marker-manager.ts` は 670 行で、2つの責務を持っている。

| 責務 | 現在の位置 | 行数 |
| --- | --- | --- |
| マーカー DOM のレジストリ(生成・更新・遮蔽フェード・破棄) | 140-428 | 約 290 |
| ラベル混雑の解決(間引き・反発・引き出し線) | 40-45 / 74-82 / 84-129 / 430-669 | 約 290 |

後者のうち `relaxLabelRects`(501-635)は **134 行 1 メソッド**で、規約 1.2 の「関数は 100 行」を
超えている。

計測はすべて `a0bd179a` 時点。着手前に測り直す。

## 実施済みの前提

**手順1〜4 は実施済み。** 間引きは `src/game/marker/label-declutter.ts`(103行)、ラベルの
押し出しと引き出し線は `src/game/marker/label-layout.ts`(233行)にある。`MarkerManager` は
表示中のレコードを集めて `LabelDeclutter.compute` を呼び、返ったキー集合で `priority-hidden` を
トグルして `prevLabelHidden` を書き戻し、`LabelLayout.sync` へ渡す。`svgOverlay` は
`LabelLayout` が持つ。`marker-manager.ts` は 400 行。`label-layout.ts` の最長メソッドは
`pushApartFromNeighbors` の 61 行。同値 40px は
`label-declutter.MARKER_CROWDING_PX`(間引きの近接半径)/
`grouped-markers.CLUSTER_RADIUS_PX`(まとめの半径)/
`celestial-markers.LABEL_CROWDING_PX`(天体ラベルの名前用半径)の3つに分かれている。
`npm run typecheck` / `npm run test:game`(175件)通過。

**この worktree には `node_modules` のジャンクションが要る。** 無いと
`tsconfig.test.json` の `paths`(`./node_modules/@types/three/...`)が解決できず、
`npm run test:*` が `three/webgpu` の TS2307 で落ちる(`npm run typecheck` は親ディレクトリを
辿るので通ってしまい、気づきにくい)。**worktree を消すときは、先にジャンクションを外す** —
外さずに削除すると本体の `node_modules` ごと消える。

---

## 目的

**「マーカーをどう出すか」と「出たマーカーが混んだときどうするか」を別のモジュールにする。**

この2つは入力も、持つ状態も、参照する定数も共有していない。レジストリは DOM 要素の寿命と属性を
持ち、混雑の解決は画面座標と優先度だけを見る。同居している理由は、両方が同じ `MarkerRecord` を
触ることだけである。

混雑の解決はさらに、**「どれを消すか」(間引き)と「残ったものをどこへ置くか」(反発と引き出し線)**
に割れる。この2つの結合は、レコード1件あたり「ラベルを間引いたか」の真偽値1つしかない。

---

## 決めたこと

### 1. 画面上の混雑を解く4つの実装は、統合しない

現在、画面上で近接した対象の扱いは4箇所にある。

| 実装 | 何を決めるか | 根拠 |
| --- | --- | --- |
| `marker-manager.thinByPriority` | 全マーカー横断で、近接した組のラベル/アイコンを間引く | MAP.md 7.2 末尾「マーカー全般に働く」 |
| `celestial-markers` の `CrowdingGrid` ×2 | 天体ラベル同士を、名前用 40px・点用 16px の**別半径**で間引く | MAP.md 7.2 |
| `grouped-markers.groupNearby` 前半 | 近接した船を1つの代表へまとめ、"×N" を出す | MAP.md 7.3「近接時のまとめ表示」 |
| `grouped-markers.groupNearby` 後半 | 天体ラベルへ近接した船のラベルを落とし、サブ行の候補にする | MAP.md 7.3「天体ラベル下の省略表示」 |

**MAP.md はこの4つを別々の挙動として定めている。** 半径も、勝った側・負けた側に起きることも違う
(名前だけ消す / 点も消す / 代表へ吸収して件数にする / 天体のサブ行へ移す)。1つに畳むと、片方の
調整がもう片方へ漏れる。規約 1.5 の「個別に調整されうる要素は一般化しない」に当たる。

**勝敗の規則そのものは既に `crowding.ts` の `resolveCrowdingWinner` へ一本化されている。**
4つとも同じ関数を呼んでおり、「距離比(depth-guard)→ 優先度 → 深さ・id」の順序は共有済み。
**ここで追加でやることは無い。**

残る重複は挙動ではなく機構が2つ ——「近傍探索の仕方」(全ペア走査 / 一様グリッド / 線形探索)と
「ヒステリシスの持ち方」(レコードのフィールド / ダブルバッファ id 集合 / 単一 id 集合)。
これらは下の 4 で扱う。

**覆されたとき:** 統合するなら別の計画になる。この計画の手順はどれも統合の前提を壊さない
(むしろ間引きが独立したモジュールになるぶん、寄せ先の候補がはっきりする)。

### 2. 「混雑の解消」はモジュールとしては2つに割る

- `label-declutter.ts` — **どれを消すか。** 画面座標・優先度・カメラ距離・前フレームの間引き状態
  だけを読み、隠すラベル/アイコンの id 集合を返す。
- `label-layout.ts` — **残ったラベルをどこへ置くか。** ラベルの推定矩形を反発させ、ずれたラベルへ
  シンボルからの引き出し線を引く。優先度もカメラ距離も見ない。

**3つ目に割らない。** 反発の計算(オフセットを求める)と適用(`transform` と SVG 線を書く)を
別モジュールにすると、`ActiveLabel` 相当の構造体が境界を越えるだけで、どちらの側も独立した名前で
呼べる責務にならない。引き出し線は「ずらしたラベルとシンボルを結ぶ」ものなので、ずらした側が持つ。

### 3. `relaxLabelRects` は、関数としては4つに割る

134 行の中身は4つの意味ブロックになっている。モジュールは増やさず、`label-layout.ts` 内の
private メソッドへ割る。

| 割った先 | 現在の行 | 行数 |
| --- | --- | --- |
| 矩形の収集(対象の絞り込みと初期配置) | 505-528 | 24 |
| 反発の反復(5回。下の2つを呼ぶ) | 530-536, 634 | 8 |
| 矩形がまたがる全セルへのグリッド登録 | 537-575 | 39 |
| 近傍候補の収集と押し出し | 577-633 | 57 |

### 4. `thinByPriority` の全ペア走査(O(N²))は、そのまま残す

N = そのフレームに表示中のマーカー数。上限は天体・ラグランジュ点が約 130(登録天体 ~110 +
ラグランジュ点)、動的エンティティ・ノード・方向マーカーが多く見て 100 台なので、**N ≤ 300 程度**。
ペア数は N(N−1)/2 = 4.5 万。1ペアあたり `hypot` 1回と数回の比較で 5〜20 ns と見て
**0.2〜0.9 ms/frame**。16.6 ms 予算の 1〜5%。しかも `view === 'map'` のときしか回らない。

一様グリッドへ寄せると、`CrowdingGrid` へ「進入/離脱の別半径」「優先度が等しいときのタイブレークの
有無」「ペアごとの勝者を呼び出し元へ返す口」の3軸を足すことになる。**1人の追加利用者のために設定で
分岐する共通部品を作るのは割に合わない。**

**覆されたとき:** 負荷ウィンドウの `labels` が常時 500 を超えるなら判断が変わる。そのときは
`label-declutter.ts` に自前のグリッドを持たせる(`CrowdingGrid` を一般化するのではなく)。
手順1で間引きが独立したモジュールになっているので、後から差し替えられる。

### 5. `MARKER_PRIORITY` は `crowding.ts` へ移す(手順5・単独で落とせる)

優先度を消費する規則(`resolveCrowdingWinner`)の隣が所有者。規約 1.6「定数は概念の所有者が持つ」。
現在は 10 モジュールが `marker-manager` から import しており、**うち 6 つは `MARKER_PRIORITY`
だけのために import している** —— レジストリへの不要な依存になっている。

**覆されたとき:** 手順5を落とす。他の手順は影響を受けない。

### 6. `combatMarkers` / `leadMarkers` の所有者移動は範囲外

`marker-manager.ts` 154-158 の TODO が指す別件。`Game` の配線に触るので、単独では割に合わない。
この計画では公開フィールドのまま残す。

---

## 達成目標

1. `src/game/marker/marker-manager.ts` が **500 行未満**、かつ 100 行を超えるメソッドが **0**。
2. `grep -n 'resolveCrowdingWinner\|CLUSTER_PX\|NEVER_HIDE_ICON\|COMBAT_MARKER_CLASSES'
   src/game/marker/marker-manager.ts` が **0 件**。
3. `grep -n 'COLLISION_BUCKET_SIZE\|COLLISION_PADDING\|svgOverlay\|svgLinePool'
   src/game/marker/marker-manager.ts` が **0 件**。
4. `src/game/marker/` の全関数が 100 行未満。
5. **書かれるだけで読まれない状態が消えている** ——
   `grep -rn 'prevIconHiddenByPriority' src/` が 0 件。
6. **同値 40px の3つの用途が、それぞれの所有者の定数になっている** ——
   `grep -rn '= 40;' src/game/marker/` が 3 件で、`marker-manager.ts` には現れない。
7. `npm run typecheck` と `npm run test:game` が通る。
8. **見た目が変わらない。** マップビューで下の4点が現状と同じ:
   (a) 月と地球のラベルが近づくと名前が片方だけ消え、点は残る、
   (b) 敵機を3隻以上近づけると代表マーカーに "×N" が出る、
   (c) ラベルが重なると押し出され、シンボルへ細い引き出し線が引かれる、
   (d) タイムワープを上げても衛星のラベルが明滅しない。
9. DOM と CSS の契約が変わっていない —— `.mk` / `.sym` / `.lbl` / `priority-hidden` /
   SVG の `mk-lead` クラスの使い方は現状のまま。

---

## 手順

### 手順5. `MARKER_PRIORITY` を `crowding.ts` へ移す

**目的:** 優先度を消費する規則の隣へ定数を置き、レジストリへの不要な依存を 6 モジュールから外す。
**挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/marker/crowding.ts` | `MARKER_PRIORITY`(`marker-manager.ts` 23-38)を受け入れる。 |
| `src/game/marker/marker-manager.ts` | 定義を削除し、`defaultPriorityForClass`(86-99)のために import する。`defaultPriorityForClass` 自体は `set()` からしか呼ばれない登録時の既定値なので**移さない**。 |
| `src/game/celestial/celestial-entity/celestial-entity.ts` | import 元を差し替え(17行)。`marker-manager` への依存が消える。 |
| `src/game/celestial/celestial-entity/geostationary-overlay.ts` | 同上(13行)。依存が消える。 |
| `src/game/docking/docking-guide.ts` | 同上(12行)。依存が消える。 |
| `src/game/dynamic/dynamic-entity/base.ts` | 同上(44行)。依存が消える。 |
| `src/game/player/player.ts` | 同上(54行)。依存が消える。 |
| `src/game/marker/lagrange-point-marker.ts` | 同上(10行)。依存が消える。 |
| `src/game/dynamic/dynamic-entity/ammo-pickup.ts` | `MARKER_PRIORITY` だけ差し替え(15行)。`type MarkerManager` の import は残る。 |
| `src/game/dynamic/dynamic-entity/enemy.ts` | 同上(32行)。 |
| `src/game/dynamic/dynamic-entity/rcs-fuel-pickup.ts` | 同上(15行)。 |
| `src/game/targeter.ts` | 同上(14行)。 |

**達成条件と検証**

- `npm run typecheck` が通る。
- `npm run test:game` が通る。
- `grep -rn "MARKER_PRIORITY" src/ | grep "marker-manager'" ` が 0 件。
- `crowding.ts` がプロジェクト内のどのモジュールも import していない(最下層のまま)
  —— `grep -n "^import" src/game/marker/crowding.ts` が 0 件。

### 手順6(挙動が変わる。実施はユーザーが決める). 反発の 5 反復が 1 反復ぶんしか効いていない

**症状:** `label-layout.ts` の `relaxOverlaps` は、候補の重複除去に使う `candidateStamp` を
**5 反復の前に一度しか 0 で埋めていない。** 添字 i に対するスタンプ値は毎反復 `i + 1` で同じ
なので、反復1で候補に採った組 (i, j) は反復2以降で `candidateStamp[j] !== stamp` を満たさず、
**候補から落ちて押し出されない。** 「5反復で反発させて緩和する」という意図に対し、実際には
ほぼ1反復ぶんしか働いていない(どの組が生き残るかは、別の i' がスタンプを上書きしたかどうか
に依存するので、順序にも左右される)。

**直し方:** `candidateStamp.fill(0, 0, this.activeCount)` を反復ループの内側へ移す。
あるいはスタンプを `iter * activeCount + i + 1` のように反復をまたいで一意にする。

**なぜ別手順なのか:** 直すと押し出しが今より強く効き、**ラベルの位置と引き出し線の見た目が
変わる。** リファクタリングの手順に混ぜて黙って変えるべきではない。手順3 では現状の挙動を
そのまま保存してある。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/marker/label-layout.ts` | `relaxOverlaps` の `candidateStamp` の初期化位置を直す。 |

**達成条件と検証**

- `npm run typecheck` / `npm run test:game` が通る。
- **目視(マップビュー):** ラベルが3枚以上重なる位置で、押し出し後に重なりが残らないこと。
  反復が効くぶん押し出し量が増えるので、引き出し線が長くなる。

---

## 見積り

**行数**(現在 `marker-manager.ts` = 670 行)

| 手順 | marker-manager から出る | 呼び出しで戻る | 残り |
| --- | --- | --- | --- |
| 手順1 | 6(定数)+ 41(ヘルパ)+ 42(`thinByPriority`)= 89 | +12 | 593 |
| 手順2 | 9(型)+ 4(定数)+ 8(フィールド)+ 2(dispose)+ 172(2メソッド)= 195 | +6 | 404 |
| 手順4 | 0 | 0 | 404 |
| 手順5 | 16(`MARKER_PRIORITY`)| +1(import)| 389 |

新規モジュール:

- `label-declutter.ts` = 89(移設)+ 5(冒頭)+ 3(import)+ 12(入力インターフェース)+
  20(クラス骨格と公開メソッド)≈ **130 行**
- `label-layout.ts` = 195(移設)+ 5(冒頭)+ 3(import)+ 8(入力インターフェース)+
  15(手順3 の分割で増えるシグネチャとコメント)≈ **225 行**

合計 **670 行 / 1 モジュール → 約 745 行 / 3 モジュール**(+11%)。行数はほとんど変わらない。
変わるのは、混雑の解決が `MarkerRecord` の内部フィールドを直に触らなくなり、入力インターフェースと
返り値の集合だけで済むようになること。

**性能**

同じ処理を同じ順序で呼ぶので変わらない。ひとつだけ減る方向へ動く: 手順1 で
`NEVER_HIDE_ICON_CLASSES`(9件)と `COMBAT_MARKER_CLASSES`(7件)の `String.includes` 走査が、
衝突ペアごとからレコード生成時1回へ移る。衝突ペア数を P とすると 16P 回/frame の部分文字列探索が
0 になるが、P はせいぜい 100 台なので**誤差の範囲**。これは目標ではない。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `MarkerRecord.labelHiddenByPriority` を外したのに、矩形収集(507行)の参照を id 集合へ差し替え忘れる | 間引かれたラベルまで矩形に積まれ、生き残ったラベルが不要に押し出される | 手順1 —— **フィールドを消せば型エラーになる。残したまま新旧を併存させない。** |
| `canHideIconByPriority` / `isCombatMarker` が読む `root.className` は**生成時に固定**され、以後 `set()` では更新されない。`cls` 引数から毎フレーム求め直すと挙動が変わる | 同じ key に別の `cls` を渡す呼び出し元があった場合にだけ、アイコンの間引きが変わる。全体を見ても気づけない | 手順1 —— 生成分岐(188-198)の中でだけ確定させる |
| `prevLabelHidden` は**レコードの寿命に紐づく**。`set()` はこれをリセットしない(207-208 がリセットするのは今フレームの結果だけ)。id 集合として毎フレーム作り直すと、いったん非表示になって戻ってきたマーカーが緩い 60px ではなく厳しい 40px で判定される | タイムワープ中に一部のラベルが明滅する。MAP.md 7.2 が禁じている挙動 | 手順1 —— `prevLabelHidden` はレコード側に残し、`compute` の入力として渡す |
| `svgLinePool` の後始末は `dispose()`(419-420)にある。プールだけ移して後始末を移し忘れる | マップを閉じて開き直すたびに SVG の line 要素が残り、単調増加する | 手順2 —— 目視の「入り直しても引き出し線が増えない」で当てる |
| 矩形収集は、対象外のラベルにも `transform = 'translateX(-50%)'` を書いている(508行)。関数へ割るときにこの副作用を落とす | 一度ずれたラベルが、混雑が解けても押し出された位置に残る | 手順3 |
| 反復ごとのグリッド再構築(537-575)を「反復の外へ出せる」と見て動かす | ラベルが前の反復で別セルへ移ったときに候補から漏れ、重なったままのラベルが出る | 手順3 |
| 候補の添字昇順ソート(610行)を「不要」と見て落とす | 押し出しが累積して処理順に依存するため、セル配置に応じてラベル位置が毎フレーム揺れる | 手順3 |
| `MARKER_CLUSTER_PX` の片方だけを移す | `marker-manager` が `label-declutter` を定数のためだけに import する、逆流した依存が残る | 手順4 —— `GroupedMarkers` 側にも同時に定数を持たせる |
| `crowding.ts` は現在プロジェクト内のどのモジュールも import していない(最下層)。`MARKER_PRIORITY` を移すときに巻き込みで import を足す | 循環 import。`crowding.ts` は 4 つの実装すべてから読まれるので、影響範囲が広い | 手順5 —— 「import 行が 0 件」を達成条件に置いている |
| `combatMarkers` / `leadMarkers` を「ついでに」動かしたくなる | `Game` の配線に波及し、1手順で commit できなくなる | 全手順 —— 範囲外と決めてある |
