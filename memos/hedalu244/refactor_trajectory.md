# 軌道線の「誰がどんな線を持つか」を型から外へ出す

## 要望

**戦闘ビューでの自機の軌道は、予測軌道(`predictedLine`)ではなく解析軌道(`OrbitLine`)を描きたい。** という要望があった。

今これができないのは、`Player` が `createOrbitLine` を override していないから。つまり
**「どのビューでどんな線を出すか」という頻繁に変わる問いに、型が答えてしまっている。**
純リファクタリングで答えの持ち主を外へ移し、その後に要望へ対応する。

**このリファクタの目的は要望そのものではなく、この種の問いが今後どちらに転んでも
1箇所の変更で済むようにすること。** よって `GameEntity` とその派生は、自分の線が
「過去線を出すか / 消すか」「戦闘ビューでどう見えるか」に依存した実装を一切持たず、
**どちらにも倒せる窓口だけを残す。**

また、複数個所に乱雑に分散している表示線の管理を、 新設の **`EntityLineManager` という新モジュールに集約する**。

この文書では純リファクタのみを扱い、要望については扱わない。

## 現状の事実

### 線の所有と生成

| 場所 | 内容 |
|---|---|
| `game-entity.ts:68,70,72` | `orbitLine` / `predictedLine` / `actualLine` の3フィールド |
| `game-entity.ts:153,188,191` | `createOrbitLine` / `createPredictedLine` / `createActualLine`(既定 `null`) |
| `game-entity.ts:158-227` | `show*Line` / `hide*Line` 6メソッド。show = 「無ければ create して scene へ」、hide = 「dispose して null」 |
| `game-entity.ts:176,233` | `syncOrbitLine` / `syncTrajectoryLines` |

override しているのは**4つだけ**:

| クラス | override | 生成物 |
|---|---|---|
| `Enemy`(`enemy.ts:136`) | `createOrbitLine` | `new OrbitLine(this.orbitLineColor, 0.35, shipOrbit)` — 色は個体ごと |
| `Base`(`base.ts:297`) | `createOrbitLine` | `new OrbitLine(COLOR_BASE_ORBIT_LINE, 0.35, shipOrbit)` |
| `Player`(`player.ts:170`) | `createPredictedLine` | `new TrajectoryLine(0xbfc9d4, 0.55, predicted)` |
| `Player`(`player.ts:175`) | `createActualLine` | `new TrajectoryLine(0xbfc9d4, 0.3, predicted)` |

`Asteroid` / `Bullet` / `DebrisPiece` / `AmmoPickup` / `BeltSection` / `RadiatorFold` は一切 override しない。
**つまり「型で決めている」実体は4行しかなく、剥がす作業自体は小さい。**

### 呼び出し元は EntityManager の2メソッドだけ

- `entity-manager.ts:375` `syncPlayerTrajectoryLines` — 全 `Player` に対し
  `show = (isActive || overviewMode) && policy.orbit && ship !== primaryTarget && ship !== secondaryTarget`
- `entity-manager.ts:411` `syncOrbitLines` — 全 `Enemy`・`Base` に対し
  `show = overviewMode && alive && policy.orbit && enemy !== primaryTarget && enemy !== secondaryTarget`(基地に除外なし)

どちらも `game.ts:470` / `game.ts:498` から `targeter.aliveTarget` / `aliveSecondaryTarget` を渡されている。

### Targeter 側の重複

`targeter.ts:49-51` が `OrbitLine` を2本常駐で持ち、`syncOrbitLine`(`targeter.ts:246`)の中身は
`GameEntity.syncOrbitLine` と**完全に同じ**:

```
strongestAttractor(tgt.state.r, attractors) → tgt.orbitalElementsAround(center) → line.sync(el, ...)
```

違うのは **色・不透明度・renderOrder だけ**。線を塗り替えられないせいで丸ごと二重化している、
という見立ては正しい。

さらに `targeter.ts:54-59` に `THEME_CHANGE_EVENT` の購読があり、テーマ変更でこの2本を塗り直している。
**`src/` 内でこのイベントを購読しているのは Targeter だけ**(`theme.ts` の CSS 変数差し替えは別経路)。

### 排他処理は2箇所

`entity-manager.ts:385` と `entity-manager.ts:420` の `!== primaryTarget && !== secondaryTarget`。
Targeter 側には「EntityManager が既に描いたか」の確認は無く、一方向の運用に依存している。

### スタイルがどこで決まるか

`render/curve.ts:143` の `Curve` が唯一のマテリアル生成点。

| 項目 | 持ち主 | 後から変えられるか |
|---|---|---|
| color | `THREE.Material` | `Curve.setColor` あり。`OrbitLine.setColor` あり、**`TrajectoryLine` には無い** |
| opacity | `THREE.Material` | `Curve.setOpacity` / `OrbitLine.setOpacity` あり。`TrajectoryLine` には無い |
| dash | `THREE.LineDashedMaterial` | `Curve.setDash` / `TrajectoryLine.setDash` あり |
| renderOrder | `THREE.Object3D` | **setter が無い**(コンストラクタで一度だけ) |

`Curve.dispose()` は `this.mat.dispose()` を呼ぶ = **マテリアルは Curve の所有物**。

## 確定させたい設計

### 0. `GameEntity` に残すのは窓口だけ

3つの線それぞれについて `show*Line(style)` / `hide*Line()` / `sync*` が**対称に、無条件に**存在する。
`GameEntity` とその派生は次のいずれも**しない**:

- 自分が過去線・予測線・楕円のどれを持つべきかを決める(`create*Line` の override が該当 → 消す)
- 自分の状態(履歴保持の長さ・ビュー・ターゲットか否か)を見て線の要否を判断する
- 3本のうち2本を1つのフラグや1つのフィールドへ畳む(4通りの組み合わせが全て表現できること)

**この形が保たれている限り、下の「今回決めないこと」はどれも `EntityLineManager` の中だけで倒せる。**
それがこのリファクタの成功条件であり、要望(戦闘ビューの解析楕円)はその最初の一例にすぎない。

**逆向きの依存 —— `predictsFuture` が `predictedLine !== null` を理由に含むこと
(`game-entity.ts:108`)—— はそのまま維持する。** 「線を表示するために予測が必要だから予測する」
は正しい向きで、外から線を持たされたエンティティが自分で必要な予測を確保するという、
窓口の受け手側の当然の応答にあたる。**このリファクタで触らない。**

### 1. 外から渡すのは「マテリアル」ではなく「スタイル値」

`show～Line` の引数にマテリアルを渡して共有する案は採らない。理由:

- **所有者が消える。** `Curve.dispose()` はマテリアルを dispose する契約になっている。共有マテリアルを
  渡すと、誰が dispose するのかの答えが無くなる(最初に消えた線が他の線のマテリアルを壊す)。
- **共有できない線が最も数が多い。** `environment-scene.ts:262` の `referenceLineOpacityAt` は
  参照軌道線の不透明度を**天体ごと・毎フレーム**書き換える。`plan-path.ts` は破線間隔を**弧ごと・
  毎フレーム**書き換える。この2つは共有の対象外で、共有できるのはエンティティの線だけ。
- **節約になる量が小さい。** 大きい確保は `Curve` の頂点バッファ(`OrbitLine` 4096、`TrajectoryLine`
  16384 頂点ぶんの Float32Array + Float64Array)で、これは共有できない。マテリアル1つの節約は誤差。

**代わりに、色・不透明度・renderOrder・破線を持つただの値 `LineStyle` を渡し、既存の
`setColor`/`setOpacity`/`setDash` で適用する。** 欲しかったもの —— 外から指定できること・
後から塗り替えられること・役割ごとに1箇所で定義されること —— はこれで全部得られ、
所有権の問題は起きない。将来マテリアルを共有したくなったら、`render/curve.ts` の中に
スタイル→マテリアルの参照カウント付きキャッシュを置けばよく、この形はそれを塞がない。

### 2. 「どのエンティティにどの線を出すか」は `EntityLineManager` が答える

`EntityManager` は配列の持ち主であって表示方針の持ち主ではない。
`syncOrbitLines` / `syncPlayerTrajectoryLines` を丸ごと新モジュールへ移す。

- 置き場: **`src/game/entity-line-manager.ts` / `class EntityLineManager`**
  (`celestial/map-visibility.ts` の `MapVisibilityPolicy` が「マップに何を出すか」を答えるのと同じ位置づけ)
- 所有: `Game` が構築し、`Game.sync` から呼ぶ
- コンストラクタ参照: `EntityManager`
- 毎フレーム引数: `primaryTarget` / `secondaryTarget`、`fo`, `camera`, `displayWindow`,
  `visibilityPolicy`, `attractors`, `activePlayer`, `ephemeris`, `overviewMode`
  (`Targeter` を参照で持たないので、ターゲットは今までどおり `Game` が渡す)

### 3. Targeter は線を持たない

`EntityLineManager` が「ターゲットは除外する」のをやめ、
**ターゲット用スタイルでそのエンティティ自身の線を出す**。
`Targeter.orbitLine` / `secondaryOrbitLine` / `syncOrbitLine` / `handleThemeChange` が消え、
排他処理2箇所も消える。

前回の検討(`refactor_orbitline_visiblity.md` の「Targeter の2本は残す」)はこれを否定していたが、
その根拠は **「自機は `orbitLine` を持てない」「非操作艦には予測線が無い」= 塗り替える線が存在しない**
だった。スタイルを外部指定にすると `EntityLineManager` が**線を持たせる側に回れる**ので、
前提ごと崩れる。

### 4. テーマ追従は購読をやめ、毎フレーム読む

`theme.ts:148` の `ACCENT` は**モジュール読み込み時に1度だけ評価される `const`** で、
`applyThemePalette`(`theme.ts:353`)は `ACTIVE_THEME` を書き換えない。だから Targeter は
イベント購読でしか追従できなかった。

`theme.ts` に現在のパレットを返す関数(`currentThemePalette()`)を足し、`applyThemePalette` が
それを更新するようにする。`EntityLineManager` が毎フレーム読めば購読は不要になり、
**`THEME_CHANGE_EVENT` の 3D 側購読者はゼロになる**(`theme.ts:351-352` のコメントも要更新)。

### 5. `show*Line` は update、`sync*Line` は sync

**`show*Line` / `hide*Line` は `build` 系の操作**(構築して `scene.add` / dispose して `scene.remove`)
であって、`sync` 系(既存メッシュを毎フレーム論理状態へ合わせる)ではない。
CLAUDE.md の命名規則は `build` を「新しいメッシュ/オブジェクトをシーンへ登録する(毎フレームではない構築)」
と定義しており、エンティティ生成が update 中に `scene.add` するのと同じ扱いになる。
**よって update から呼ぶのが規則どおりで、例外ではない。**

- **`EntityLineManager.update(...)`** — どの線が存在し、どのスタイルかを決める
  (`show*Line(style)` / `hide*Line()`)。**`Game.update` の末尾、`handlePointerInput()` の後**に置く。
- **`EntityLineManager.sync(...)`** — 存在する線の形状と変換だけを合わせる
  (`syncOrbitLine` / `syncTrajectoryLines`)。**生成も破棄もしない。**

#### なぜ update の末尾か

判断材料のうち `visibilityPolicy` は `MapPickables.refresh` が作るが、これは
**`CameraSystem.update` より後**に置かれている(候補集合と表示可否がカメラ位置から出るため。
`game.ts` の該当コメント参照)。update の末尾に置けば、判断材料が**すべてこのフレームの値**になる:

| 材料 | 末尾に置いた場合 |
|---|---|
| `overviewMode` | 最新(`handleInput` で `[M]` を消化済み) |
| `displayWindow` | 最新(advanceSimulation 中に確定) |
| `visibilityPolicy` | 最新(`MapPickables.refresh` 直後) |
| `activePlayer` / ターゲット | 最新(`handlePointerInput` 後なので `[T]` や右クリックも反映) |

`advanceSimulation` の前(= `Predictor` より前)へ置く案も考えたが、そこでは `visibilityPolicy` が
1フレーム古くなる。特に**マップビューへ入った最初のフレームは前フレームの policy が `null`**
(`MapPickables.refresh` は `overviewMode` でないと何もしない)なので、敵・基地の軌道線が
`?? false` 側に倒れて1フレーム遅れて現れる。末尾配置ならこれが起きない。

#### 予測との1フレーム差は残る(が、視覚的な問題にはならない)

正直に書くと、**update へ移しても `Predictor` へ「事前に」伝わるわけではない。**
`Predictor.update` は `advanceSimulation` の中、update の**前半**にあり、
上のとおり `visibilityPolicy` は update の**後半**でしか手に入らないので、
両方を同一フレームで満たす配置は現在の順序では存在しない
(`MapPickables.refresh` を前へ動かすのは、それ自身のカメラ依存の理由で不可)。

ただし**これは視覚的な欠陥にならない**:

- 予測列は予算制で**何フレームもかけて**伸びる(`PREDICT_STEP_BUDGET`)。1フレーム遅く
  始まることは、もともと複数フレームかかる立ち上がりの中に埋もれる。
- 予測が無い間、`syncGeometry(null, ...)` は線を**単に隠す**(`Curve.clear()`)。
  壊れた形状が一瞬出るのではなく、1フレーム現れないだけ。
- 線は一度出れば持続するので、供給されないのは**最初の1フレームだけ**。

`predictsFuture` の読み手は `Predictor` と `plan-attractors.ts` の2箇所で、どちらも update 中。
どちらも上と同じ理由で1フレーム差を吸収する。

#### `show*Line(style)` は冪等でなければならない

update から**毎フレーム**呼ばれるので、スタイルを毎回書き込むと
「update で毎フレーム見た目を書く」ことになり、フェーズの境界を壊す。
**適用済みスタイルを線側に保持し、違うときだけ書く。**
これは冗長なマテリアル更新を避けることにもなる。

---

## 作業手順

各ステップは単独でコミットでき、`npm run typecheck` が通る状態で終わること。
Step 5 まで**見た目は変えない**(Step 5 の再生成タイミングだけが例外)。

### Step 1 — スタイルの適用口を揃える(挙動不変)

- `render/curve.ts`: `setRenderOrder(n)` を追加(`this.line.renderOrder = n` だけ)
- `game/trajectory-line.ts`: `setColor` / `setOpacity` を追加(`OrbitLine` と同じく `Curve` へ委譲)
- `game/orbit-line.ts`: `setRenderOrder` を委譲で追加

まだ誰も呼ばないので挙動不変。検証は typecheck のみ。

### Step 2 — `LineStyle` 型と役割ごとのスタイル表を置く(挙動不変)

```ts
type LineStyle = { color: string | number; opacity: number; renderOrder: number; dash?: DashPattern };
```

- 型の置き場: `src/render/curve.ts` に同居(`OrbitLine`/`TrajectoryLine` 両方が参照するため、
  どちらのファイルにも寄せない)
- 値の置き場: `const.ts`。色は既存の「色管理」節、renderOrder は既存の `LINE_RENDER_ORDER` を読む
- 静的なもの(`enemyOrbit` の既定 / `baseOrbit` / `playerPredicted` / `playerActual` / `shipOrbit`)
  だけを表に置く。**ターゲット系はテーマ追従が要るので表に置かず、`EntityLineManager` が毎フレーム組む**
- `Player` の `0xbfc9d4` はここで名前の付いた定数になる(現状は player.ts への直書き)

### Step 3 — `show*Line` をスタイル引数付きにし、`create*Line` を消す(挙動不変)

- `showOrbitLine(style: LineStyle)` / `showPredictedLine(style)` / `showActualLine(style)`:
  無ければ `style` で生成、**有れば `setColor`/`setOpacity`/`setRenderOrder`/`setDash` で塗り替える**
- **適用済みスタイルを線側に保持し、同じスタイルなら何も書かない**(§5 の冪等性)
- `createOrbitLine` / `createPredictedLine` / `createActualLine` を `GameEntity` から削除
- `Enemy` / `Base` / `Player` の override 4つを削除
- `Enemy.orbitLineColor` を `private` → `readonly`(`EntityLineManager` が読むため)
- 呼び出し側(`EntityManager` の4箇所)が現状と同一のスタイルを渡す

**この時点で §0 が満たされる** —— `GameEntity` とその派生は「自分がどんな線を持つべきか」を
一切知らなくなり、3本すべてが対称な窓口になる。

### Step 4 — 表示判断を `EntityLineManager` へ移す(挙動不変)

- `src/game/entity-line-manager.ts` を新設し、`EntityManager` から `syncOrbitLines` /
  `syncPlayerTrajectoryLines` を丸ごと移す。`EntityManager` からは両メソッドが消える
- 各エンティティの `orbitLine` / `actualLine` / `predictedLine` を出すか、どのスタイルで出すかを
  ここが管理する
- `Targeter` は参照で持たず、`primaryTarget` / `secondaryTarget` を引数で受け取る
- **§5 のとおり update と sync に分ける**:
  - `update(...)`: 出す/消す + スタイル決定 → `Game.update` の**末尾、`handlePointerInput()` の後**
  - `sync(...)`: 形状と変換のみ → `Game.sync` の、**現在 `syncPlayerTrajectoryLines` がある位置**
    (`editor.sync` の後)に1本化する。旧 `syncOrbitLines` の位置(`targeter.sync` より前)へ
    戻す必要は無い —— 間に挟まる `syncMarkers` / `effects.sync` / `navTarget.sync` /
    `syncEquatorNodes` はどれも軌道線を読まず、Step 5 で `targeter.sync` からも線が消えるため
- 文書更新: `DEVELOP/CALLSTACK.md`(呼び出し順)、`DEVELOP/OWNERSHIP.md`(new 位置)、`CLAUDE.md`

### Step 5 — Targeter の2本を畳む(**再生成タイミングが変わるが、視覚的には変わらない**)

- `EntityLineManager` の除外をやめ、ターゲット用スタイルを適用して **ターゲット自身が持つ線を** 出す
- `theme.ts` に `currentThemePalette()` を追加し、`applyThemePalette` が更新するようにする
- `Targeter` から `orbitLine` / `secondaryOrbitLine` / `syncOrbitLine` / `handleThemeChange` /
  `THEME_CHANGE_EVENT` 購読 / `dispose` の該当分を削除

**変わること(意図的):**

- **線の再生成がターゲット切替時に起きる。** 現状の2本は常駐で作り直されない。新方式では
  前ターゲットの線が dispose され、新ターゲット側で確保される(`OrbitLine` = 4096頂点ぶん)。
  切替はプレイヤー操作の頻度なので許容するが、**毎フレーム切り替わる経路が無いことは確認する。**

**変えてはいけないこと(見落としやすい):**

- **ターゲット線は戦闘ビューでも出ている。** `Targeter.syncOrbitLine` は `overviewMode` で
  ゲートされていない一方、`EntityManager.syncOrbitLines` は `overviewMode &&` で始まる。
  `EntityLineManager` に「**ターゲットはビューを問わず出す**」を明示的に書かないと、戦闘ビューで
  ターゲットの楕円が消える回帰になる。
- 可視性ポリシーの既定値が両者で逆(`?? true` と `?? false`)。ターゲット側は `?? true`。
- renderOrder は target=3 / secondaryTarget=2 / 通常の敵=1 のまま。

### Step 6 — 要望の実装:戦闘ビューの自機を解析楕円にする

`EntityLineManager` の規則を変えるだけ:

- 戦闘ビュー → 操作艦に `showOrbitLine(shipOrbitStyle)`、`hidePredictedLine()`
- マップビュー → 従来どおり予測線

**実装上の注意:**

- **推力中の追従。** `OrbitLine` は閾値を超えるまで楕円を焼き直さない(`orbit-line.ts:113` の
  `needsRegen`)。噴射中は要素が動き続けるので、`creative-stage.ts` の配置プレビューと同じく
  **`force = true` を渡す条件**(`ship.thrust !== null` 等)が要る。渡さないと噴射中の楕円が
  カクつく。
- `LINE_RENDER_ORDER.shipOrbit` のコメント「自機の解析楕円」が実態と一致するようになる
  (今は敵と基地が使っている)。
- 文書更新: `DEVELOP/SPEC.md`(プレイヤーから見える挙動が変わる)。

---

## 今回決めないこと(窓口を残す対象)

**下記はいずれも表示方針の問いであって、このリファクタの問いではない。**
Step 3 で §0 の窓口が揃い、Step 4 で判断が1箇所へ集まった後は、
**どれも `EntityLineManager` の中だけを書き換えれば倒せる** —— それが確かめられれば
このリファクタは成功している。今回はすべて現状維持のまま通す。

- 戦闘ビューで自機の過去線(`actualLine`)を残すか消すか
- マップビューの自機を予測線のままにするか
- 戦闘ビューでターゲットでない敵の軌道線を出すか
- `Base` にターゲットハイライトを出すか(現状 `CombatTarget = Enemy | Player` なので出せない)
- `NavTarget`(航法ターゲット)のハイライト線を足すか

## 先送りするもの

- **`equatorNodes` / `marker` も同じ形。** エンティティが表示物を持ち、外が出す/消すを決める
  構造は共通。今回は線だけに閉じる。
- **`Curve` のマテリアル共有。** §1 のとおり利得が小さいので今回はやらない。やるなら
  `render/curve.ts` 内の参照カウント付きキャッシュとして、この変更の後に。
- **`TrajectoryLine` の頂点容量 16384 の見直し**(`refactor_orbitline_visiblity.md` の残論点)。
  Step 6 で戦闘ビューの自機が予測線を持たなくなると本数は減る方向なので、実測は Step 6 の後に。
