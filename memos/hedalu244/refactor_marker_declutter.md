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

**手順1 は実施済み。** 間引きは `src/game/marker/label-declutter.ts`(103行)にあり、
`MarkerManager` は表示中のレコードを集めて `LabelDeclutter.compute` を呼び、返った
キー集合で `priority-hidden` をトグルし、`prevLabelHidden` を書き戻す形になっている。
`marker-manager.ts` は 599 行。`npm run typecheck` / `npm run test:game`(175件)通過。

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

### 手順2. 反発と引き出し線を `label-layout.ts` へ移す

**目的:** `marker-manager` から「残ったラベルをどこへ置くか」を抜く。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/marker/label-layout.ts`(新規) | `LabelLayout` クラス。`marker-manager.ts` から `ActiveLabel`(74-82)、`COLLISION_BUCKET_SIZE` / `COLLISION_PADDING`(126-129)、`activeScratch` / `activeCount` / `candidateStamp` / `candidatesScratch` / `collisionBuckets` / `bucketPool` / `bucketRowPool` / `svgLinePool`(143-152)、`relaxLabelRects`(501-635)、`applyLabelOffsets`(639-669)を移す。コンストラクタで `svgOverlay: SVGSVGElement` を受ける。公開するのは `sync(targets, hiddenLabels)` と `dispose()`。入力インターフェース `LayoutTarget` は `key` / `x` / `y` / `fixedLabel` / `lbl: HTMLElement` / `root: HTMLElement` を読む(`root` は引き出し線の不透明度合わせ 655 行のため)。 |
| `src/game/marker/marker-manager.ts` | 上記を削除。コンストラクタ(161-167)で `LabelLayout` を組み、`svgOverlay` の保持をそちらへ譲る(`MarkerManager` は `svgOverlay` を持たなくなる)。`dispose()`(413-421)の `svgLinePool` の後始末(419-420)を `labelLayout.dispose()` の呼び出しへ置き換える。`resolveCollisions` は `labelLayout.sync(active, hiddenLabels)` を呼ぶ。 |

**達成条件と検証**

- `npm run typecheck` が通る。
- `npm run test:game` が通る。
- `grep -n 'COLLISION_BUCKET_SIZE\|COLLISION_PADDING\|svgOverlay\|svgLinePool\|SVGLineElement'
  src/game/marker/marker-manager.ts` が 0 件。
- `wc -l src/game/marker/marker-manager.ts` が 500 未満。
- **目視(マップビュー):** ラベルが重なる位置までズームし、押し出しと引き出し線が現状と同じに
  出ること。マップビューを抜けて入り直しても引き出し線が増えていかないこと。

### 手順3. `relaxLabelRects` を 100 行未満の関数へ割る

**目的:** 規約 1.2 の「関数は 100 行」を満たす。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/marker/label-layout.ts` | 「決めたこと 3」の表のとおり、`relaxLabelRects` を4つの private メソッドへ割る。反復ごとのグリッド再構築は**反復の内側に置いたまま**にする(ラベルが前の反復で別セルへ移るため、反復をまたいでバケットを再利用できない)。候補の添字昇順ソート(610行)も**残す**(押し出しが累積するので処理順に結果が依存する)。対象外のラベルへ `transform = 'translateX(-50%)'` を書く副作用(508行)は矩形収集側に残す。 |

**達成条件と検証**

- `npm run typecheck` が通る。
- `src/game/marker/` の全関数が 100 行未満
  (`awk` などで測るか、`label-layout.ts` を目で読んで最長のメソッドを数える)。
- **目視(マップビュー):** ラベルが重なる位置で押し出しの結果が現状と同じで、フレームごとに
  位置が揺れないこと。混雑が解けたあとにラベルが元の位置へ戻ること。

### 手順4. 「40px」を3つの所有者へ分ける

**目的:** `MARKER_CLUSTER_PX` は現在、間引きの近接半径(472行)と `GroupedMarkers` のクラスタ半径
(165行)を兼ねている。MAP.md 上は別々の挙動なので、たまたま同じ値なだけである(規約 1.6「たまたま
同時に切り替わるフラグは別個にする」)。**値は変えないので挙動は変わらない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/marker/label-declutter.ts` | 間引きの近接半径として `MARKER_CLUSTER_PX` / `MARKER_CLUSTER_RELEASE_PX` を持つ(手順1で移設済み)。名前を責務に合わせて見直す。 |
| `src/game/marker/grouped-markers.ts` | クラスタ半径 40px を自前の定数として持ち、コンストラクタ引数 `clusterRadiusPx`(62-65)を落とす。参照は `isNear`(184-186)と天体ラベル近接判定(164行)の2箇所のみで、どちらもクラス内。 |
| `src/game/marker/marker-manager.ts` | `new GroupedMarkers(this, MARKER_CLUSTER_PX)`(165行)から第2引数を落とす。 |

`celestial-markers.ts` の `LABEL_CROWDING_PX = 40`(22行)は既に所有者の側にあるので触らない。

**達成条件と検証**

- `npm run typecheck` が通る。
- `npm run test:game` が通る。
- `grep -rn '= 40;' src/game/marker/` が 3 件(`label-declutter.ts` / `grouped-markers.ts` /
  `celestial-markers.ts`)で、`marker-manager.ts` に現れない。
- **目視(マップビュー):** 敵機を3隻以上近づけて代表マーカーに "×N" が出ること。

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
