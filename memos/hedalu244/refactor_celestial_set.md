# 天体の集合・検索を扱うモジュールの是正

## 目的

天体の集合(配列・Map・集合)を持つ/組むモジュールを棚卸ししたところ、20 以上あった。
そのほとんどは**計算量削減のための事前絞り込み**であり、存在すること自体は正しい。問題は
集合が多いことではなく、次の2点である。

1. **`id → 天体` の対応表が 4 系統に分裂している。** `CelestialSystem.entitiesById` という正本が
   あるのに、`ReferenceFrames` は同じ表を独自に組み直し、`system-membership.motionById()` は
   呼ばれるたびに表を作り直し、残り 15 箇所以上は `Array.find((b) => b.id === …)` の線形検索で
   引いている。CODING-RULE 1.6「配列に対して外部から対応付けを行う設計を避ける」に真っ向から
   反する。
2. **星系全体への問い合わせが `CelestialSystem` の外にある。** `system-membership.ts` の全関数は
   「星系の木を辿って親・兄弟・子・祖先・所属系を答える」もので、答えは登録天体だけで決まる。
   にもかかわらず `readonly CelestialMotion[]` を毎回引数で受け取るため、id 引きの表をその場で
   組む羽目になっている(CODING-RULE 1.4「クラス外から情報をもらいまくっていて、クラス内の情報に
   全然手を付けていない関数は、置き場所が適切でない懸念がある」)。

副次的に、**ラグランジュ点 id (`${親id}-l${n}`) の判定が 8 ファイルに散り、正規表現リテラルが
5 箇所に直書きされている**。正本は HUD のグループ分け(`hud/object-groups.ts`)に置かれており、
id を作っている `camera/focus-markers.ts` とは所有関係が逆になっている。

修正後は、`id → 天体` を引く方法が `CelestialSystem` の口ただ1つになり、星系への問い合わせが
すべてそこを通る。ラグランジュ点 id の生成と解釈が1モジュールに閉じる。

## 決めたこと

### 決定1: 事前絞り込みは容認し、触らない

次のものは**参照(`CelestialMotion` そのもの)を保持していて id を持たない**ため、解決の問題が
発生しない。この計画では触らない。

`dynamic/arc-celestial-bodies.ts` / `dynamic/attractors.ts` / `dynamic/substep-celestial-bodies.ts` /
`dynamic/surface-candidates.ts` / `render/pipeline/sun-occlusion-select.ts` /
`render/pipeline/lighting/planet-light-select.ts` / `render/atmosphere.ts` /
`celestial/planet-distance.ts`

`celestial/point-field.ts` と `celestial/point-field-view.ts` は登録天体ではない点群を持つ別種の
集合なので、同じく対象外。

### 決定2: `PlanetSystem` と `solarSystem()` は正しい形として触らない

`PlanetSystem.moons` は木の内側ノードが自分の成員を持っているだけで、外部の対応表ではない。
`solarSystem()` と `CelestialSystem` は「太陽系」と「一般の星系」の棲み分けであり、
`SOLAR_SYSTEM_BODY_NAMES` / `solarSystemBodyName()` は**星系を組む前**にセーブ一覧の名前を出す
ための静的な引き先(利用は `hud/windows/save-browser.ts:193` の1箇所のみ)。
`CelestialSystem.nameOf()` との二重持ちに見えるが、成立時点が違うので統合しない。

### 決定3: `system-membership.ts` の問い合わせ群は `CelestialSystem` のメソッドへ移す

根拠は CODING-RULE 1.4。全関数が `motions` を外から受け取り、それは `CelestialSystem` の
フィールドである。移せば id 引きは `entitiesById` で O(1) になり、`motionById()` は不要になって
消える。

`NearbySystemTracker` だけは**フレームをまたぐ状態(直前フレームの勝者)を持つ呼び出し側の道具**
なので `CelestialSystem` へは入れず、単独ファイルへ残す。

**覆される場合**: `CelestialSystem` を膨らませたくない(移動後 464 → 約 550 行で CODING-RULE 1.2 の
500 行基準を超える)なら、代わりに **`system-membership.ts` を残したまま、関数の第1引数を
`readonly CelestialMotion[]` から `CelestialSystem` に変える**。`motionById` が消えて id 引きが
O(1) になる効果は同じで、変わるのは手順2だけ(移動ではなく引数の差し替えになり、呼び出し側は
`systemMembersAt(celestialSystem, …)` のままになる)。手順1・3〜6 は影響を受けない。

### 決定4: `celestialBodies: readonly CelestialMotion[]` の引数 48 箇所は一括変換しない

**配列を走査すること自体が目的の引数(重力の総和・最強引力源・遮蔽候補)は配列のままが正しい。**
置き換えるのは次の2種類だけに絞る。

- その中で `id` 引きをしている関数(手順6)。
- `game: Game` と一緒に渡されていて、`game.celestialSystem.celestialMotions` と同一の配列である
  ことが呼び出し側で自明な関数(手順5)。

### 決定5: ラグランジュ点 id の正本は `src/game/celestial/lagrange-id.ts`(新規)

id を作るのは `camera/focus-markers.ts` と `pickable/line-pickables.ts`、解釈するのは HUD・
マップ・航法の 8 ファイル。生成と解釈の両方が依存できる位置は `game/celestial/` であり、
HUD のグループ分けモジュールではない。`physics/lagrange.ts` には置かない — id の命名は
ゲーム側の識別子の規約であって力学ではない(CODING-RULE 1.3)。

## 達成目標(すべて達成を確認済み)

すべて `src/` に対する検索で判定する。

1. `motionById` が **0 件**(`grep -rn "motionById" src`)。
2. `/-l\[1-5\]\$/` の正規表現リテラルが **`lagrange-id.ts` の 1 箇所のみ**
   (`grep -rn -- "-l\[1-5\]" src` の結果がそのファイルだけになる)。
3. ラグランジュ点 id を文字列連結で組んでいる箇所が **0 件**
   (`grep -rn -- '-l\${' src` が空。現在は `focus-markers.ts` 3 件、`line-pickables.ts` 1 件)。
4. `game: Game` と `celestialBodies` を両方受け取るメソッドが **0 件**
   (`grep -rn "game: Game, celestialBodies" src` が空。現在 7 件)。
5. `CelestialSystem` を持てる文脈で天体を `find((x) => x.id === …)` している箇所が **0 件**。
   残ってよいのは `physics/`(層として `CelestialSystem` を知れない)と、`CelestialSystem` が
   まだ存在しない構築時(`solar-system.ts:79` / `stage-debug-alt-system.ts:97`)だけ。
6. `npm run typecheck` と `npm run test`(全層)が通る。
7. マップビューの見た目・選択挙動が変わらない — 天体ラベル、ラグランジュ点ラベル、
   軌道物体一覧の並びと絞り込み、右クリックメニューの項目が変更前と同じ。

## 実施結果

全手順を実施済み(`023a7b48`〜`9f5b1afb` の6コミット)。旧手順3(`alwaysFullyVisibleIds`)は
手順2 に統合した — `ancestorsOf` / `sameSystemIds` を呼ぶので、分けると通らないため。

| 手順 | コミット | 変更 |
| --- | --- | --- |
| 1. ラグランジュ点 id の正本 | `023a7b48` | 11 ファイル(新規1) +78 / −55 |
| 2. 星系への問い合わせ + `alwaysFullyVisibleIds` | `31fc27f3` | 9 ファイル(新規1・削除1) +181 / −227 |
| 4. `FrameAnchors` の id 引き | `9bf8e6b4` | 5 ファイル +30 / −20 |
| 5. HUD の二重渡し | `7062687d` | 6 ファイル +25 / −30 |
| 6. 残る線形 id 検索 | `ab7ab534` | 7 ファイル +17 / −21 |

新規 `lagrange-id.ts` 34 行 / `nearby-system-tracker.ts` 39 行、削除 `system-membership.ts` 161 行。
`celestial-system.ts` は 464 → 561 行(見積り 550 行、500 行超過はユーザーが容認済み)。

### 実行時のコスト削減(手順2)

**導出のみで、実測はしていない。** `map-pickables.ts` は候補1件ごとに
`isPositionInFocusedSystem` を呼び、その中で `motionById(motions)` が 98 体ぶんの `Map` を
組み直していた。

- 登録天体 98 体(`DEVELOP/SPEC/CELESTIAL.md` 1節)。
- 候補数 = 天体 98 + ラグランジュ点(4系 × 最大5点 = 20)+ 艦・拾得物 ≒ 130 件。
- 130 件 × 98 エントリ = **12,740 回の Map 挿入 / フレーム**、加えて `Map` オブジェクト
  130 個 / フレームの割り当てと GC 圧。
- 手順2 の後はこれが **0**(`entitiesById` を引くだけ)。

手順4 の削減は 1 フレームあたり `98 × 約10 回 = 980 回` の比較 → 10 回のハッシュ引き。
桁が2つ小さく、**手順4 は正しさの統一が目的であって速度が目的ではない。**

## リスクと落とし穴

実施後に1件ずつ当てた結果を「結果」列に記す。

| リスク | 影響 | 露見する場所 | 結果 |
| --- | --- | --- | --- |
| ラグランジュ点 id の正規表現を1本に畳むとき、`^(.+)-l([1-5])$` (アンカーあり)と `-l[1-5]$` (末尾のみ)を同一視してしまう。前者は親 id が空でないことを要求する | `-l1` という id が親 `''` のラグランジュ点として解決され、天体でない対象が天体扱いになる | 手順1 | 回避。アンカーありへ統一し、その意図を `lagrange-id.ts` のコメントに残した |
| `nav-target.ts` は「同じ形の名前を持つ船を天体として誤解決しない」ため、副天体が実在する公転天体かを別途確かめている(`:286-293` のコメント)。`lagrangePointOf` へ寄せる際にこの確認を落とす | 艦に `xxx-l1` という名前を付けると天体として解決され、航法ターゲットの法線が誤る | 手順1 | 回避。`celestialSystem.find(parentId)` + `instanceof OrbitingMotion` の二段確認は残っている |
| `alwaysFullyVisibleIds` の表示クラス取得を `celestialClassOfKind`(運動の分類)から `bodyClass`(編集上の分類)へ変える。両者は準惑星・小天体で食い違う | マップの天体ラベルが出る/出ない条件が静かに変わる | 手順2 | **前提が誤りだった。** 製品コードは以前から `celestialSystem.find(id)?.bodyClass ?? 'planet'` を注入していたので挙動は不変。`celestialClassOfKind` を使っていたのはテスト側だけで、そちらは実際の `bodyClass` へ寄って忠実になった |
| `FrameAnchors.bodies` を getter 化すると、`update()` を呼ぶ前でも非空を返すようになる。`map-camera.ts:214` は `bodies.length > 0` で初期化前を判定している | 初期化前のフレームで `bodiesPivot = 0` のまま天体を引き、カメラの注視点が 1 フレームだけ飛ぶ | 手順4 | 到達不能と確認。`frameAnchors.update()`(`game.ts:330`)は `cameraSystem.update()`(`:349`)より先に走り、MapCamera がこのインスタンスを受け取るのはその後。それまでは自前の `bodyAnchorSource([], 0)` を見る |
| `CelestialSystem` は `three/webgpu` を import する。`system-membership.ts` は THREE 非依存で、node のテストが直接読んでいた | メソッドへ移した後、テストが `CelestialSystem` 経由になる。`tests/physics/test-helpers.ts` が既に `solarSystem()` を呼んでいるので通るはずだが、通らなければ決定3を覆して代替案(第1引数を `CelestialSystem` にするだけ)へ切り替える | 手順2 | 起きず。全層 655/655 通過。決定3 は覆さずに済んだ |
| `celestial-system.ts` が 550 行になり、CODING-RULE 1.2 の 500 行基準を超える | 描画同期(`build` / `sync` / `dispose` と private 群、約 200 行)を切り出す別のリファクタリングが要る。**この計画ではやらない** — 集合・検索の統一とは別の問題なので、超えた行数を根拠に手順2を縮めない | 手順2 | 実際に 561 行。切り出しは未着手 — 別課題として残る |
| `map-pickables.ts:188` と `:200` は `??` で前段が未確定のときだけ `isPositionInFocusedSystem` を呼ぶ。メソッド化のついでに呼び出し回数を「減らそう」として条件を畳む | 選べる対象と描かれる対象が別の判定から出るようになり、クリックできるのに見えない天体が生まれる | 手順2 | 回避。`??` の条件は1文字も変えていない |
| `bodyAnchorSource` の呼び出し 5 箇所のうち 4 箇所は空配列を渡している(`bodyAnchorSource([], t)`)。Map 化しても実質何も速くならない | 手順4 の payoff を過大に見積もる。Map 化の目的は二重 `find` の除去であって速度ではない | 手順4 | 該当。5箇所中4箇所は空配列のままなので速度上の効果は無い。目的は二重 `find` の除去に留めた |
| 手順5 で HUD の引数を落とすとき、`game.celestialSystem.celestialMotions` を呼び出しのたびに引き直す | getter を毎フレーム複数回叩くが、`CelestialSystem.celestialMotions` は構築時に確定した配列を返すだけなので実害はない。**配列を作り直す実装に変えない** | 手順5 | 回避。`celestialMotions` は構築時に確定する readonly フィールドで、getter ではない |
