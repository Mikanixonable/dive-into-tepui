# モジュール分割の再点検 — 検出と修正計画

PR #48(enemy の多態化)をモデルケースとして、**同じ病気が他所に無いか**を `src/` 全体で
探した結果と、論点ごとの修正方針。

コード計測はすべて **53071459** 時点。行数・参照数を根拠にしているので、着手前に測り直す。
**論点1・7・16 の実施(`57ffe943`)で `pickable/` `marker/` `camera/` の数字は大きく動いている。**
再測して更新した節には、その旨を書いてある。

---

## モデルケースが示した形(PR #48)

| | 前 | 後 |
| --- | --- | --- |
| enemy.ts | 528 | 412 |
| protein-enemy.ts | — | 251 |
| metal-enemy.ts | — | 77 |
| enemy-dictionary.ts | — | 13 |
| enemy-kind / -formation / -marker / -render / -save / -sun-glare | 43 / 21 / 35 / 27 / 29 / 17 | 削除 |
| **合計** | **700 行 / 7 モジュール** | **753 行 / 4 モジュール** |

**行数はほぼ変わっていない。** 変わったのは、「`kind` を見て振る舞いを選ぶ分岐が、6つの小さな
ファイルと本体に散っていた」状態が「型が振る舞いを持つ」状態になったこと。**これが判定基準で
あって、行数の増減ではない。**

同時に確認しておくべき裏返し: 統合の結果として `enemy-dictionary.ts`(13行)は**新設**された。
規約 1.6「クラス辞書は独立したモジュールに置く」が要求する形なので、これは短くても正しい。
**短いモジュールを一律に潰す作業ではない。**

---

## 検査の方法(再実行できるように)

### 何を「怪しい」とするか

**分岐の数ではなく、「その値を固定したときに通らなくなる行がどれだけあるか」で疑う。**
識別子が `kind` である必要はない — `*Type` / `*Mode` / `is*` / 素の `boolean` / `instanceof`、
どれも同じ病気を運ぶ。実際、この節の 1〜3 は当初 `kind` だけを見ていて、
論点15〜20 を丸ごと取り逃していた。

判定の目盛りは3段階:

- **on/off を表す boolean は容認する。** `visible` は 22 モジュールの署名に現れるが、
  「出す/出さない」以上のことを言っていないので、どこにあっても読める。
- **on/off でない2分を疑う。** 「AとBのどちらか」を boolean や別名の型で表しているもの。
  `overviewMode`(戦闘ビュー/マップビュー)がこれで、23 モジュールの署名を横断している。
- **3値以上は原則として疑う。** 1箇所でディスパッチする状態機械(`WaveState`)なら正しい形だが、
  分岐が複数のメソッド・複数のモジュールへ散っていれば多態の候補。

### 走査の手順

1. `src/**/*.ts` の import を静的に解決して**参照グラフ**を作り、各モジュールの行数と
   「何モジュールから import されているか」を出した。
2. 参照元が1つのモジュール(167件)を、行数と**参照元の行数**で並べた。
   「単一参照 × 参照元が500行超」に当たるものを抽出。
3. **文字列リテラル union の型別名を全部集め(97件)、その値に対する分岐
   (`=== 'x'` / `!== 'x'` / `case 'x'`)をモジュール別に集計した。** 型名では絞らない。
4. **クラスのフィールドのうち boolean / union / nullable のものについて、そのクラスの
   何本のメソッドが読んでいるか**を数え、`読むメソッド数 / 全メソッド数 × 分岐行数` で並べた。
5. **`boolean` 引数の名前を集め、何モジュールの署名に現れるかを数えた**
   (`overviewMode` はこれで出た)。
6. **`instanceof` の出現を、判定対象のクラス別に集計した。** 規約 1.3 が
   「当事者の型を分岐するコードは境界が破れているサイン」と名指ししている形。
7. 疑わしいものだけ中身を読み、**規約 1.2「長いモジュールは、まず原因を診断する」の4分類**
   (手続きの切り出し / 多態 / そのままでよい / 単に多い)へ振り分けた。

### 数え方の癖(再実行するときの注意)

- **バレル(`index.ts`)越しに export されているモジュールは、参照数が 1 と出る。**
  `hud/widgets/` `hud/windows/` はこの理由で単一参照に見えるだけで、実際は多数から使われている。
  手順 2 の結果を読むときはここを外すこと。
- **手順 3 は値で数えるので、値を共有する型どうしが混線する。** `MapPickKind` と
  `DynamicEntityKind` と `ObjectType` は `'player'` を共有しているので、互いの分岐を数え込む。
  **この混線自体が論点16 の発見につながった**ので、潰さずに残してある。

---

## 判定の要約

| # | 論点 | 診断 | 規模 | 優先 |
| --- | --- | --- | --- | --- |
| 1 | `MapPickable.kind` の 10 値 union | **多態で分ける** | 7モジュール 2,177行 / 分岐65箇所 | **実施済** |
| 2 | BVH・三角形衝突の重複実装 | **重複の解消 + 置き場所** | 2モジュール 825行 | **実施済** |
| 3 | `base-station-model.ts` の 845 行 1 関数 | **手続きの切り出し** | 852行 | **実施済** |
| 4 | `game/const.ts` の 104 定数 | **所有者へ戻す** | 319行 / 参照76モジュール | **実施済** |
| 5 | `hud/style/` の 22 ファイルと結合ハブ | **短すぎるモジュールの多数** | 22モジュール 1,980行 | 中 |
| 6 | `marker-manager.ts` のラベル間引き同居 | **手続きの切り出し** | 659行 | 中 |
| 7 | `camera/focus-markers.ts` の4責務 | **分割 + 置き場所** | 609行 | **実施済** |
| 8 | Player のブースター運用が正本割れ | **責務の集約** | 818 + 201行 | 中 |
| 9 | `plan-editor.ts` の5責務 | **分割** | 726行 | 中 |
| 10 | 「ラベル付き入力行」の重複 | **共通化(要判断)** | 4箇所 | 中 |
| 11 | `view-hud-controller.ts` | **たらい回し。畳む** | 32行 | **実施済** |
| 12 | `partFromSaveData` の8分岐 | **全腕同一。畳む** | parts.ts:79-90 | **実施済** |
| 13 | `overviewMode` が23モジュールの署名に漏れる | **要判断(保留)** | 署名23 / 分岐28 | 要相談 |
| 14 | `DynamicSystem` の種別手展開 | **要判断(保留)** | 575行 | 要相談 |
| 15 | 「戦闘/マップ」の軸に**5つの語彙** | **型の重複。1つに畳む** | 型4 + boolean 1 | **実施済**(型4→1。boolean は論点13) |
| 16 | エンティティ種別の語彙が**5つ** | **型の重複。1つに畳む** | 型5 | **実施済** |
| 17 | `OrbitAnalysisWindow` のタブが**半分だけ切り出し** | **多態で分ける** | 466行 / 分岐約30 | 中 |
| 18 | `Player`/`Base` を消費側が `instanceof` で判別し直す | **多態の復元** | 26箇所 / 11モジュール | 中 |
| 19 | その他の重複 union(`L1..L3` 等) | **型の重複。1つに畳む** | 3組 | **実施済** |
| 20 | `MapCamera` の2つの非 on/off 2分 | **要検討** | 531行 / 分岐12 | 低 |

---

## 論点1 — `MapPickable.kind` の 10 値 union(実施済)

論点7・16 と合わせて1つの計画として実施した(`a77c1cc4` ‥ `57ffe943` の10手順)。
`npm run typecheck` / `npm run test` 653件 通過。**実行時の目視確認は未実施。**

- `MapPickKind`(10値)は消えた。`MapPickable` は identity / 位置 / 可視 / 一覧 / 操作の口を持つ
  interface になり、`Player` / `Enemy` / `Base` / `AmmoPickup` / `RcsFuelPickup` /
  `CelestialEntity` と、新設した `ApsisMarker` / `RelativeNodeMarker` / `EquatorNodeMarker` /
  `LagrangePointMarker` / `EmptySpacePickable` が実装する。冒頭の表の 86 箇所の `kind` 分岐は 0 件。
- `pickable/map-pickable-menu.ts`(463)/ `map-property-rows.ts`(233)/ `marker/pick-glyphs.ts`(48)/
  `camera/focus-markers.ts`(517)は削除。天体ラベルは `marker/celestial-markers.ts` +
  `celestial-sub-labels.ts` へ移り、`camera/` から天体ラベルの知識が消えた(論点7)。
- 操作の受け口は `pickable/map-commands.ts` の `MapCommands`。実体は `Docking` / `PlanEditor` /
  `Hud` を値 import できない(実行時循環)ので、この口だけを見る。
- 候補列のキャッシュ(`itemRecords` / `cachedBodyPickables` / `syncVisibility`)は全廃した。
  「画面に出ているか」の正本は `MarkerManager.shows(key)` 1つ。
- ピックは「マーカー → 本体」の2段になった(SPEC/MAP.md §11)。`MapPickable.hitBodyByRay` と
  `math/ray.ts` を新設。

行数(下の是正まで含めた現在値): `map-context-actions.ts` 687→556、`map-pickables.ts` 262→117、
`focus-markers.ts` 517→0、`player.ts` 625→777、`base.ts` 376→512。**実体側が伸びるのは
織り込み済み**(1ファイルが1つの物体を言い切る形になるための増加)。
`map-context-actions.ts` だけが見込み(350前後)を外し、`MapCommands` の実装21メンバーが
残って 550 行台で止まっている。

### 実施後に `/refactor` / `/comment-cleanup` で直したもの

- **軌道上の点マーカー3種の共通形を抽出。** `ApsisMarker` / `EquatorNodeMarker` /
  `RelativeNodeMarker` は `runMapMenu` が一字一句同じで、`MapPickable` の定型フィールド・
  `mapPosAt` / `hitBodyByRay` / `mapVisibility` / `shownOnMap` / `gone` / `sync` / `list*` も
  同形だった。`marker/orbit-point-marker.ts` の `OrbitPointMarker` へ寄せて 391→297 行。
- `MapPickables` の `items` が `candidateItems` と常に同一参照で、`refresh` 末尾が自己代入
  だった(規約 1.6)。フィールドごと削除。
- `LineOcclusion`(`cameraPos`/`celestialBodies`/`pivot` を束ねるだけの型、参照1箇所)を廃し、
  3引数を直接渡す形に(規約 1.6「情報をまとめるためだけの型を作らない」)。
- `EquatorNodeMarkerPair.updateOnPath` が同一シグネチャの private `update` を呼ぶだけの
  ラッパーだった。`MapContextActions.windowKey(target) => target.id` も同じ。どちらも畳んだ。
- 残骸: `focus-target.ts` のコメントが削除済みの `apsis`/`relnode`/`eqnode` を指していた。
  `marker-manager.ts` の `mk-relnode` / `mk-eqnode` はどこからも出力されない CSS クラス名。
- コメント: `runMapMenu` の説明が5クラスで `MapPickable` の宣言と一字一句同じ(規約 3.3-12)。
  `line-pickable.ts` の命名の弁明(3.4)、`combat-pick.ts` の他モジュールとの対比(3.3-8)、
  モジュール冒頭の「〜は X が持つ」「〜だけを持つ」(3.3-2/8)を除去。

### 宿題 — この再編が残した問題

**(a) `MapContextActions` に `instanceof` が9箇所残っている**(うち `Player`/`Base` が7、
`CelestialEntity` が1、`Base` の台帳判定が1)。`handleLeftClick` の候補絞り込み・
`selectPickable`・`relatedItemsFor` / `relatedTitleFor` で、「被選択物自身が答える」形の手前で
止まっている。`MapPickable` に口を足す仕様変更を含むので `/modify-feature` 案件。
**論点18 と同じ形なので、そちらと1回で見る。**

**(b) `PhysicalObjectListOrder.matches` が `instanceof LagrangePointMarker` /
`instanceof CelestialEntity` で絞り込んでいる。** `PhysicalObjectListFilter` と
`ObjectPickerGenre` がほぼ並行な軸を二重に持っている状態。これも (a) と同じ回で。

**(c) `AmmoPickup` と `RcsFuelPickup` の `MapPickable` 実装がほぼ全同。**
`mapMenuItems` / `runMapMenu` / `listCounted` / `listSearchText` / `mapPropertyRows` が
半径と補給量以外は同じ。旧 `switch (kind)` を多態へ開いた副作用。共通の `Pickup` 基底は
作れるが、規約 1.5 の判断(今後個別に調整されうるか)がコードからは決まらず、
`SPEC/MAP.md` に「未確定の案」節も無い。**着手前にユーザーへ問う。**

**(d) `MapContextActions.setDocking` は二段初期化**(規約 1.11)。`Docking` の生成順に依存する
ので、`Game` の配線を触らないと直らない。

**(e) クロージャ注入が2つ**(規約 1.12)。`OrbitLineWindows` の `openOwnerWindow` と
`CelestialSubLabels.sync` の `labelStateOf`。どちらも循環依存の回避策で、解くには所有関係の
見直しが要る。あわせて `MapContextActions` のコンストラクタ引数は16個(規約 1.4)。

**(f) 自ファイル内でしか使われていない `export`(実施済)。** `src/` 全体を走査し、他ファイル
(`src/` `tests/` `tools/` `public/`、コメント中の言及は除く)から一度も参照されない宣言 259 件の
`export` を落とした(117 ファイル)。うち自ファイル内でも参照が無かった 6 件は宣言ごと削除し、
連鎖で不要になった `collinearBarycentricX` も落とした — `setProteinAnchorPosition` /
`cr3bpJacobi` / `sampleOrbitByArcLength` / `collinearLocalToBarycentric` /
`RADIATOR_OBJECT_NAMES` / `isCoarsePointer`。`export` を残した例外が2組ある。
`sphere-contact.sweptSagitta` はモジュール冒頭が名指しで「消してはならない」としている枠。
`theme.SIGNAL` は `ACCENT_SECONDARY` の `@deprecated` が移行先として指している。

**(f') 残った判断 — `physics/time/index.ts` の TDB 変換一式。** `convertJulianDate` /
`utcToTdb` / `tdbToUtc` / `ttToTdb` / `tdbToTt` と `TdbOffsetProvider` /
`AstronomicalTimeOffsetProvider` は、どこからも参照されていない。落とすと連鎖で全部が死に、
モジュール冒頭が「leap second が要るなら SPICE/offset adapter を渡せ」と文書化している
provider 拡張点ごと消える。**capability を消すかどうかの判断なので、機械的な (f) からは外した。**

**(g) 戦闘ビューの古い候補列(実施済)。** `MapPickables.refresh` はマップ視点でない回に
`candidateItems` を空にするようになった。`perfCounts` の `mapItems` にあった `overviewMode`
ガードは冗長になったので外した。これに伴う表示上の帰結が2つ — 戦闘ビューで開いた
プロパティウィンドウの関連項目は、古い列ではなく空になる。`Game.objectName` は候補列に
無い対象を実体・天体・id の順に落とすので、アプシス/交点/ラグランジュ点にフォーカスした
まま戦闘ビューへ移ると、ビューバッジの Focus が名前ではなく id になる(同メソッドの
コメントが元から想定している経路)。

---

## 論点2 — BVH・三角形衝突の重複実装(実施済)

`math/triangle-mesh.ts` を新設し、`Triangle` / `RayHit` / `SphereHit` / `BVHNode` と、BVH 構築・
レイキャスト・球衝突・AABB 判定を集約した。base 側と protein 側の二重実装は消え、両者はこの
モジュールを呼ぶだけになった。

- **BVH の分割は中央値ソートへ統一した。** 構築は生成時の1回だけで毎フレームの費用にならない
  ため、偏りに強い側を実測を待たずに採った。葉16枚・深さ12 は名前付き定数にした。
  **基地側の木の形は変わるが、返る最近交差・最深接触は同じ。**
- `BVHNode` を葉と枝の union にしたので、`left` / `right` の `?` と `!` は消えた。
- `base-collision.ts` は「基地の当たり形状を組む」だけに戻した。OBB は箱の集合という基地固有の
  形なのでここに残し、LOD1 / LOD2 の箱表を定数へ出し、読まれていなかった三角形配列を消した。
  `base.ts` の隣にあるのでモジュール名はそのまま、`OBB` は非 export にした。
- `protein-ribbon-collision.ts` のローカル再定義 `lenSq` は `math/vec3` のものへ寄せた。
- 型の import 元は `base.ts` / `dynamic-entity.ts` / `entity-contact-response.ts` /
  `protein-ribbon-collision.ts` の4モジュールを `math/triangle-mesh` へ差し替えた。

825行 → math 218 + base 259 + protein 158。`npm run typecheck` / `test:math` 42件 /
`test:game` 161件 通過。

---

## 論点3 — `render/base-station-model.ts` の 845 行 1 関数(実施済)

区画コメントの切り目をそのまま関数名にして、部位ごとの `buildXxx(): THREE.Group` へ分けた。
`buildBaseModel` は各部を組み立てて `markLitOpaque` / `markSunShadowCaster` を掛けるだけの
29行になった。**ファイルは1本のまま**(852行 → 884行 / 1関数 → 26関数、最長は
`buildHabitatShell` の 77行)。

- **マテリアルと各部の Z 位置をモジュール定数へ出した。** 全部位が共有するので引数で配れない。
  副産物として、貨物モジュールの造形が呼び出しごとに `MeshStandardMaterial` を作り直していた
  のが消えた(貨物は 112 個ある)。
- **8種類の貨物造形は、`case` ごとの関数へ分けた**(`buildReeferCargo` /
  `buildTankCargo` / …)。`buildCargoModule` は `typeIdx % 8` を配るだけの 10行になった。
- **到達不能だった `habJunctionGroup`(45行)を削除した。** 分節式居住モジュールと4基の
  多面体タンクを組んでいるが、`g.add` されないまま捨てられていた。**繋ぐと見た目と
  焼き込みの当たり判定が変わる**ので、挙動保存の側に倒して消してある。復活させるなら
  `buildCargoJunction()` を書き足して `buildBaseModel` から呼ぶ。
- **太陽電池パドルのジンバルは、`paddleGroup` ではなくルートへ、位置指定なしで入っている。**
  結果として左右2個が原点に重なっていて、居住区の中に埋まっている。挙動保存のため
  そのままにした。直すなら見た目の変更として別に扱う。

分割前後のモデルをワールド座標の頂点・index・材質・レイヤーで突き合わせ、**1856 個の描画物が
すべて一致**することを確認した。`npm run typecheck` / `test:render` 18件 / `test:game` 161件 通過。

---

## 論点4 — `game/const.ts` の 104 定数(実施済)

`src/game/const.ts` を削除した。104 定数すべてを、その値が意味を持つ規則の持ち主へ移し、
参照が1モジュールに閉じる 21 件は export をやめた。**残置はゼロ** — 当初案は
「本当に複数フォルダから参照されるもの」を 20〜30 件残すとしていたが、どれも所有者が決まった。

主な移動先:

| 移した先 | 定数 |
| --- | --- |
| `dynamic-entity/dynamic-entity.ts` | 比量モデルの係数・外殻の輻射率と環境温度・小破片の材質一式 |
| `dynamic-entity/ship.ts` | 艦の弾道係数/SRP/材質・外殻温度限界・自機の質量と慣性・既定武装 |
| `dynamic-entity/debris-piece.ts` | 砲身の比熱・放熱面積(`BARREL_MAX_TEMP` の隣) |
| `dynamic/time-step.ts` | サブステップ上限・抗力の刻み上限・弧の刻み下限 |
| `dynamic/predicted-arc.ts` / `predictor.ts` | 弧の刻み・保持サンプル数 / 予測予算 |
| `dynamic/sim-speed-manager.ts` | ワープ段階と物理が有効な上限 |
| `player/player-throttle.ts` | スロットル段階・表示名・角加速度 |
| `player/player-fire.ts` / `belt.ts` / `radiator.ts` / `power.ts` / `aero-load.ts` | 弾薬・ベルト・放熱板・蓄電・動圧限界 |
| `marker/marker-identity.ts`(旧 `marker-glyphs.ts`) | 陣営・対象の識別色 |
| `marker/marker-manager.ts` / `crowding.ts` | マーカー優先度・方向距離 / 間引きのしきい値 |
| `camera/camera-system.ts` / `chase-camera.ts` / `map-camera.ts` | キー回転速度 / 画角 / 広範囲視点の距離・画角 |
| `plan/plan.ts` / `plan-axis-drag.ts` / `display-window-manager.ts` | ノード実行の窓 / Δv 調整速度 / 表示期間 |
| `stages/spawner/enemy-spawner.ts` / `stage-utils/logistics.ts` | stage0 の編成・色 / 補給の配置 |
| `celestial/lagrange-id.ts` / `hud/panels/guide-kind-def.ts` | 共線点を持たせる下限 / ガイド色の既定 |

### 所有者を決めた基準

**`const.ts` は葉モジュールだったので、誰がモジュール評価時にその値を読んでも安全だった。**
解体するとそれが崩れる — 循環 import の中で評価時に読むと、評価順によっては未初期化の値を掴む。
typecheck にも型テストにも出ない。そこで TypeScript の AST で「モジュール評価時に読まれる参照」
を全部洗い出し(関数本体とインスタンスプロパティ初期化子は除外、static と top-level は対象)、
**その読み手へ実行時 import で到達しないモジュールを所有者に選んだ。**

これで決まった、素直でない置き場:

- **砲身の熱定数は `player-fire.ts` ではなく `debris-piece.ts`。** 砲身の温度モデルは
  player-fire にあるが、`debris-piece` が材質表を評価時に組み立てており、player-fire は
  `player.ts` → `effects-system` 経由で debris-piece へ到達する。逆向きにはできない。
- **自機の質量・慣性は `player.ts` ではなく `ship.ts`。** `Ship` の既定パーツがこの2つから
  推力とトルクを決めており、`Player extends Ship` なので ship.ts → player.ts の import は
  `class Player extends Ship` を壊しうる。艦の弾道係数・比熱・かさ密度が既にここに居るので、
  質量と慣性はその族として収まる。
- **拠点の識別色は `marker/marker-identity.ts`。** マーカーの CSS(`hud/style/marker-style.ts`)と
  軌道線(`lines/entity-line-manager.ts`)の両方が評価時に読み、両者は互いに到達する。
  葉に置くしかない。マーカーと軌道線で共有しているので `COLOR_BASE` へ改名した。
- **弧の刻み下限 `ARC_MIN_STEP_DT` は `predicted-arc.ts` ではなく `time-step.ts`。**
  `predicted-arc` → `arc-celestial-bodies` の向きがあり、後者もこの下限を読む。

### ついでに直したもの

- **`help-content.ts` の `HELP_ENTRIES` を `helpEntries()` にした。** 説明文がゲーム側の定数を
  埋め込むが、その所有者(player-fire / player-throttle / sim-speed-manager)はいずれも
  `hud/hud` 経由でこのモジュールへ到達する。**どの所有者を選んでも評価時参照が循環に乗る**ので、
  組み立てを呼び出し時へ遅らせて断った。読み手は `help-panel.ts` の4箇所だけで、いずれも
  ユーザー操作時の `render()` から呼ばれる。
- **矢印キーの視点回転を `camera-system.ts` で角度にしてから渡すようにした。**
  `chase-camera` と `map-camera` が同じ `keyYaw * RATE * dt` を計5箇所で書いており、両者は
  互いを import しないので定数の置き場が無かった。camera-system が既にロール・パンで
  採っている渡し方に揃え、重複は5→1、両カメラの `update` から `dt` が落ちた。
- **`DynamicEntity` の `HISTORY_DURATION_MAX`(表示期間上限の別名)を畳んだ。**
  評価時に読んでおり、`display-window-manager` は `predict-panel` 経由でここへ到達する。
- `marker-glyphs.ts` を `marker-identity.ts` へ改名(字形だけを指す名前で色を持てないため)。
- physics の試験(`window-agreement`)と perf の土台(`tests/perf/common.ts`)は、走査条件に
  `Player` を持ち込まないよう局所定数にした。予測予算の3定数だけは `exp4` が値そのものを
  検証対象にしているので `predictor.ts` から export している。

### 残っている評価時参照

解体後に残る「循環の中の評価時参照」は8組あるが、**どれも既存の `extends` が同じ評価順を
既に要求している**組で、新しい壊れ方は増えていない:
`debris-piece`(`extends DynamicEntity`)が小破片の材質を、`enemy` / `player`
(`extends Ship`)が初速と慣性を読むもの。基底が未初期化ならクラス定義の側が先に落ちる。

検証: `npm run typecheck` / `npm run test` 653件 / `npm run build` 通過。

---
## 論点5 — `hud/style/` の 22 ファイルと 2 つの結合ハブ

### 症状

`game/hud/style/` は **22ファイル 1,980行**。中身は全部 CSS のテンプレート文字列。
組み立てはハブ2枚を通る:

- `panel-content-style.ts`(21行) — **import 14本 + 連結式1つだけ。** 責務ゼロ。
- `skeleton-style.ts`(50行) — 3つを連結 + レスポンシブの追記。半分はハブ。
- `hud-root.ts:35` が `LAYOUT_TOKENS_STYLE + SKELETON_STYLE + PANEL_CONTENT_STYLE
  + COMBAT_VIEW_STYLE + MAP_VIEW_STYLE` を注入。

`panel-content-style.ts` にぶら下がる 14 枚のうち **10枚が 41行以下**
(`view-options`18 / `object-placer`20 / `result-screen`22 / `navball`23 /
`frame-controls`28 / `stage-controls`28 / `stage-status`29 / `orbit-guide`35 /
`pause-menu`38 / `plan-panel`40)。うち6枚は **TypeScript 側の値を1つも参照していない**
純粋な CSS 文字列(`view-options` / `object-placer` / `orbit-guide` / `frame-controls` /
`stage-controls` / `combat-panel-rows`)。

### 診断

規約 1.2「短すぎるモジュールが多数あることは、長すぎるモジュールと同格の違反」+
「不要なたらい回しをするだけの薄すぎるラッパー」。`panel-content-style.ts` は後者そのもの。

**CSS を TS の文字列で持つこと自体は論点にしない。** webpack には `css-loader` が入っているが
`.css` ファイルは1枚も無く、トークンやブレークポイントを TS 側から差し込んでいる箇所がある
(`marker-style` 13箇所、`map-view-style` 6箇所)。**移行するなら別の判断が要るので、ここでは
ファイル数だけを問題にする。**

### 修正

`panel-content-style.ts` を消し、14枚を **画面のまとまりで4枚**へ統合する。統合先は
`hud-root.ts` が直接連結する:

| 統合先(案) | 元 | 行数 |
| --- | --- | --- |
| `panel-rows-style.ts` | combat-panel-rows / navball / predict / plan-panel | 約220 |
| `map-panel-style.ts` | view-options / orbit-guide / object-placer / stage-controls / frame-controls | 約130 |
| `screen-style.ts` | pause-menu / result-screen / stage-status | 約90 |
| `settings-view-style.ts` / `help-panel-style.ts` | そのまま(167 / 146) | — |

`skeleton-style.ts` も同様に、`hud-layout-style` / `hud-badge-style` / `marker-style` を
畳めるか見る(3枚で380行なので、統合すると1枚が430行。**500行の上限内には収まるが、
`marker-style` はマーカー意匠という独立した関心なので残してよい**)。

**目標は 22 → 10 前後。** 0にはしない。

---

## 論点6 — `marker-manager.ts` にラベル間引きが同居

### 症状

`game/marker/marker-manager.ts`(659行)は2つの関心を持っている。

| 関心 | 範囲 | 行数 |
| --- | --- | --- |
| マーカー DOM のレジストリ | `set` / `setPosition` / `setNodePosition` / `setDirection` / `setBearing` / `hide` / `fadeOut` / `remove` / `dispose`(134-416) | 約280 |
| ラベルの間引き・反発の解決 | `resolveCollisions` / `collectActiveMarkerRecords` / `thinByPriority` / `relaxLabelRects` / `applyLabelOffsets`(420-658)+ 先頭の優先度ヘルパ | 約260 |

`relaxLabelRects` は **490-624 の 134 行 1 メソッド**(規約 1.2 違反)。

### 診断

規約 1.2「独立した意味を持つ手続きが直に書かれている」。
間引きと反発は **「画面上のラベルの混雑をどう解くか」という、それ自身の名前で呼べる責務。**
入力は `MarkerRecord[]`(位置・優先度・距離・ラベル矩形)だけで、DOM の生成にも
マーカーの登録にも触らない。

### 修正

`game/marker/label-declutter.ts`(仮)へ、`thinByPriority` / `relaxLabelRects` /
`applyLabelOffsets` と優先度ヘルパ(`defaultPriorityForClass` / `canHideIconByPriority` /
`NEVER_HIDE_ICON_CLASSES` / `COLLISION_BUCKET_SIZE` / `COLLISION_PADDING`)を移す。
`MarkerManager.resolveCollisions` は集めて渡すだけになる。

`relaxLabelRects` は移した先で**さらに分ける**(矩形の初期配置 / 反発の反復 / 収束後の適用)。

### 前提(論点7 の完了で更新)

**ラベル混雑の解決は依然として3箇所にある**が、置き場所は動いた:
`marker-manager.thinByPriority`、`marker/crowding.ts` の `CrowdingGrid`(論点7 で
`focus-markers.ts` から移設。`marker/celestial-markers.ts` が名前用とアイコン用に2つ持つ)、
`marker/grouped-markers.ts`。3つを1つにできるかは**先に SPEC/MAP.md 7.2 を読んで、
「別々の挙動であるべきか」を確かめる。** 別々であるべきなら統合しない。

`crowding.ts` は 31 → 122 行になっており、ヒステリシス(前フレームの隠し集合)を持つ。
`marker-manager` から間引きを切り出すとき、**そこへ寄せられるかを先に見る。**

---

## 論点7 — `camera/focus-markers.ts` の4責務(実施済)

**実施済。論点1 と同じ計画で対処した。**

---

## 論点8 — Player のブースター運用が正本割れ(実施済)

「接続中のブースター段」の正本を `PlayerBoosters`(`player/player-boosters.ts`、261行)へ
1つにまとめた。`PlayerFire` と同じ形で `Player` 本体・`Hud`・`WorldSfx`・`Scene`・
`EffectsSystem` を受け取り、段スタック・既定諸元・模型・プルーム・質量慣性・分離・HUD 文言を
全部持つ。`Player` は 818 → 625 行。

- `Player` に委譲メソッドは残していない(規約 1.2)。`game.ts` / `hud.ts` は
  `player.fire` / `player.throttle` と同じく `player.boosters` を直接呼ぶ。
- `attach` / `toggleIgnition` / `decouple` の `boolean` は `game.ts` でも
  `handleEdgePress` でも読まれていなかったので `void` にした。
- `combinedThrust` は移さず `updatePlayerControls` へ畳んで消した。RCS と合成するのは
  `Player` の関心なので。
- `booster-id.ts`(8行)は `booster-stack.ts` へ畳んだ。`BoosterStage.id` を定義する
  モジュールが採番の所有者になる。`detached-booster.ts` はそこから引く。
- `booster-separation.ts`(28行)も `booster-stack.ts` へ畳んだ。**`player-boosters.ts` では
  なく** — `SPEC/FLIGHT.md`「分離速度は船と段へ質量比で配り、並進運動量を保存する」は仕様に
  明言された振る舞いで、規約 4.1 の「テストを書くもの」に当たる。`player-boosters.ts` は
  `Player` 経由で `Hud`(DOM)を引くので node のテストから import できず、そこへ畳むと
  テストを消すことになる。`booster-stack.ts` は THREE / `Player` 非依存で、同種の自由関数
  `boosterAverageAcceleration` を既に持っている。テスト2件は `booster-stack.test.ts` へ移した。
- `BoosterStack` クラスは数値の段スタックのまま。セーブ形式の単位として残る。

`Player` は 500行を超えたままだが、残りは「同じ関心の実装が単に多い」(規約 1.2 の第4分類)。

---

## 論点9 — `plan-editor.ts` の5責務

### 症状

`game/plan/plan-editor.ts`(726行)。

| 関心 | メンバー |
| --- | --- |
| ノードの当たり判定・選択 | `nodeScreenPos` / `pickNodeAt` / `handleMapClick` / `handleNodeRightClick` / `selectNewNode` / `isEmptyNode` / `removeSelectedIfEmpty` |
| ノードの編集 | `addNodeAt` / `deleteNode` / `deleteSelected` / `setSelectedNodeTime` / `rebuildDraggedNode` / `dragNodeToNearestSample` / `applyDv` / `setNodeDvLocal` / `nodeDv` |
| ギズモの配線と同期 | `wireNodeGizmo`(31行) / `syncGizmo`(61行) / `hideGizmo` |
| パネルの同期 | `syncPanel`(39行) |
| 入力の受け口 | `handleInput` / `handleMapPointer` / `updateEditing` / `clearPlanByKey` |

加えて `PlanDisplay`(424) / `NodeGizmo`(302) / `PlanPanel`(201) / `PlanGizmo3D`(106) /
`PlanAxisDrag`(103) を**すべて単独で所有**している(`plan/` は10ファイル 2,755行)。

### 診断

「独立した意味を持つ手続きが直に書かれている」。ただし**論点1 ほど明快ではない。**
編集操作(Δv の適用・時刻の変更・ドラッグでのノード再構築)は
**「計画ノードを編集する」という名前で呼べる責務**で、当たり判定・入力の受け口とは別物。

### 修正(案。着手前に再検討する)

`plan/plan-node-edit.ts`(仮)へ、`addNodeAt` / `setSelectedNodeTime` /
`rebuildDraggedNode` / `applyDv` / `setNodeDvLocal` / `nodeDv` / `isEmptyNode` /
`relativeToBody` / `bodyState` を移す。`PlanEditor` は「入力を受けて、選択を管理して、
編集を呼び、表示を同期する」だけになる。

**単独では優先度が低い。** 論点1〜4 を終えてから、`plan/` 全体(`plan-path.ts` 508行を含む)
をまとめて見るほうが効率がよい。

---

## 論点10 — 「ラベル付き入力行」の重複

### 症状

`w-group` + 見出し + `ValueInput`(+ `Slider`)という**同じ形の行**が、少なくとも4箇所で
別々に組まれている。

| 場所 | 行数 | 参照 |
| --- | --- | --- |
| `creative/slider-field.ts` | 149 | `object-placer-panel.ts` のみ |
| `hud/panels/guide-value-field.ts` | 240 | 軌道ガイドのみ |
| `hud/panels/bgm-settings-panel.ts` | 178 | `new Slider` × 2 |
| `hud/frame/camera-frame-panel.ts` | 161 | `new Slider` × 1 |

`new ValueInput(` は 10 モジュールに散っている。

### 診断

規約 1.4「類似した形の式、類似した形の処理が異なるモジュールに分散」。
ただし**規約 1.5 の分かれ目(「共通化した側が変更されたとき、参照側の挙動も変更されるべきか」)
を先に決めないと一般化してよいか判定できない。**

- `slider-field` と `bgm-settings-panel` / `camera-frame-panel` の行は
  **同じ見た目であるべき**(UI-DESIGN の一貫性)なので共通化の対象。
- `guide-value-field` は `ValueMapping`(対数振幅・位相ラジアン・族範囲の写像)を持つ
  ので**別物**。共通の行部品の上に写像を載せる形になら分けられる。

### 修正

`hud/widgets/` は規約 1.12 が認める「公開境界として意図的に設計したディレクトリ」なので、
そこへ `LabeledField` / `SliderField` を置く。`creative/slider-field.ts` は移動して消える。
`guide-value-field.ts` は `ValueMapping` を残したまま、行の組み立てだけ差し替える。

**先に SPEC/UI-DESIGN.md を見て、行の見た目が「個別に調整されうる要素」でないことを
確認する。** 調整されうるなら共通化しない(規約 1.5)。

---

## 論点11 — `hud/view-hud-controller.ts` は純粋なたらい回し(実施済)

`Hud` へ `syncPanels(view: HudWorldView, game: Game): void` を1本足し、`view-hud-controller.ts`
(32行・2クラス)を削除した。`game.ts` の分岐2行は
`this._hud.syncPanels(this.viewManager.current, this)` の1行になった — ビューの正本は
`ViewManager` なので、`isMapView` から `'map'` / `'combat'` を組み直さず `current` をそのまま渡す。

- 2つの `sync` が共有していた4呼び出し(バーン管理・トップバー・軌道パネル・軌道分析)は1本に
  寄せた。ビューで違うのは `orbitPanel.sync` の `hideInOverview`(戦闘 true / マップ false)と、
  戦闘だけの vessel / target / enemies、マップだけの mapScaleBadge の3つだけ。
  **戦闘ビューでの呼び出し順が「軌道パネル → 艦」へ入れ替わるが、各パネルは自分の DOM しか
  触らないので表示は変わらない。**
- 呼び出し元が消えて1行のラッパーになった `syncOrbitAnalysis` は `syncPanels` へ畳み込んだ。
  `syncBurnManagement` も同じく消し、残る唯一の呼び出し元(`game.ts` の後始末)は
  `burnManagementPanel.sync(null)` を直接呼ぶ — 隣の `setHandlers({})` と同じ形になった。

`npm run typecheck` / `test:game` 161件 通過。

---

## 論点12 — `partFromSaveData` の8分岐は全腕が同一(実施済)

`return createPart(data.type, data);` の1行にした。8つの `case` は消えた。

**アサーションは要らなかった。** `TType` が `PartType` 全体へ推論され、`Partial<ExtractPart<PartType>>`
は準同型マップ型なので union へ分配されて `Partial<AnyPart>` になり、`data: AnyPart` がそのまま通る。
戻り値も `ExtractPart<PartType>` = `AnyPart` で一致する。`createPart` の署名は触っていない。

`npm run typecheck` / `test:game` 161件 通過。

---

## 論点13 — `overviewMode` が23モジュールの署名に漏れている(要判断)

### 症状

「マップビューか戦闘ビューか」を表す `overviewMode: boolean` が、引数として層を横断している。
**boolean 引数の名前を全部集めて署名の出現モジュール数で並べたとき、これが単独で首位。**
2位の `visible`(22モジュール)は純粋な on/off なのでどこにあっても読めるが、
`overviewMode` は「AとBのどちらの画面か」という**on/off でない2分**を boolean で表している。

| 引数 | 署名に現れるモジュール | 分岐箇所 | 判定 |
| --- | --- | --- | --- |
| `overviewMode` | 23 | 28 | **疑わしい** — on/off でない2分 |
| `visible` | 22 | 9 | 容認 — 純粋な on/off |
| `on` | 10 | 2 | 容認 |
| `enabled` | 5 | 1 | 容認 |

モジュール別の出現(識別子の全出現):

| モジュール | 行数 | 出現 |
| --- | --- | --- |
| `game/targeter.ts` | 279 | 26 |
| `game/camera/camera-system.ts` | 293 | 18 |
| `game/plan/plan-display.ts` | 424 | 14 |
| `game/pickable/map-context-actions.ts` | 687 | 12 |
| `game/game.ts` | 638 | 12 |
| `game/celestial/celestial-system.ts` | 555 | 9 |
| `game/marker/marker-manager.ts` | 659 | 8 |
| `game/lines/entity-line-manager.ts` | 158 | 7 |

`targeter.ts` は特に露骨で、`handleTargetSelectKey` は `if (overviewMode) return;` で始まり、
`updateEquatorNodes` は `if (!overviewMode) return;` で始まり、`syncTargetDirMarkers` は
`if (overviewMode || …) return;` で始まる。**値を固定すると通らない行が半分近くある。**

### 判断が要る点

- これは**エンティティの種別ではなく、実行時に切り替わる画面モード。**
  多態にすると `CombatTargeter` / `MapTargeter` の2インスタンスを持ち、
  ビュー切替のたびに使い分けることになる。**両者が共有する状態
  (`aliveTarget` / `boardMarks` / マーカーレジストリ)をどちらが持つかを先に決めないと、
  正本が割れて論点8 と同じ病気になる。**
- `ViewManager` が既にビューの正本を持っているので、**「モードを引数で配る」のをやめて
  「モードごとに違う同期経路を通す」形**(論点11 の `Hud.syncPanels` と同じ発想)なら、
  多態にしなくても分岐は減る。
- **論点15 と同じ軸なので、先に型を1つに畳んでから考える。** `boolean` のままにするか
  `WorldView` を渡すかは、型が1つになった後でないと議論できない。

**この論点は、修正方針をユーザーへ問うてから着手する。** 保留。

---

## 論点14 — `DynamicSystem` の種別手展開(要判断)

`game/dynamic/dynamic-system.ts`(575行)は 9 本の型付き配列
(`enemies` / `bullets` / `casings` / `debris` / `detachedBoosters` / `players` / `bases` /
`ammoPickups` / `rcsFuelPickups`)を持ち、種別ごとに `addX` / `findX` / `updateX` / `syncX` と
上限定数(`MAX_BULLETS` / `MAX_CASINGS` / `MAX_DEBRIS` / `MAX_DETACHED_BOOSTERS`)を
手で並べている。

**しかし、これを1つのレジストリへ畳むのは規約 1.5 の「早急な一般化」に当たる恐れが強い。**
`players: Player[]` は `Player` 固有の API(`updatePlayerControls` / `syncPlayer`)で
使われていて、型を落とすと呼び出し側にキャストが増える。

**判断材料が足りないので保留。** `SPEC/` の「未確定の案」に、エンティティ種別が今後増えるか
(増えるなら畳む価値がある)の記述があるか確認してから決める。

---

## 論点15 — 「戦闘ビュー / マップビュー」の軸に5つの語彙(実施済)

同じ2値を指していた4つの型別名を `WorldView = 'combat' | 'map'` 1つへ畳んだ。所有者は
`game/view-manager.ts` — 「どのワールドビューを表示しているかの正本」を宣言しているモジュール。

- `ViewId` / `WorldViewId`(`view-manager.ts` の8行違いに同一定義で並んでいた)を統合。
- `HudWorldView`(`hud/panel-shell.ts`)・`HelpMode`(`hud/windows/help-content.ts`)は
  ローカル定義を消し、`view-manager.ts` から `import type` で受ける。`HelpScope` は
  `WorldView | 'both'` になった。
- **エイリアスの再エクスポートは残していない**(規約 1.11)。`hud-root.ts` / `hud.ts` /
  `help-panel.ts` / `view-badge.ts` は所有者から直接 import する。旧名4つは 0 件。

`applyChrome()` にあった `map ? 'map' : 'combat'`(`worldView === 'map'` で作った boolean から
同じ2値を組み直していた)も消し、`setPanelCollapsedView` / `hud.setWorldView` へ `this.worldView`
をそのまま渡す。

**論点13 には触れていない。** `setMapMode(open: boolean)` 3箇所と `overviewMode: boolean` は
そのまま残してある — 型を `WorldView` へ置き換えるかは論点13 の判断待ち。

型定義だけの変更なので振る舞いは変わらない。`npm run typecheck` / `test:game` 161件 通過。

---

## 論点16 — エンティティ種別の語彙が5つ(実施済)

**実施済。論点1 と同じ計画で対処した。**

---

## 論点17 — `OrbitAnalysisWindow` のタブが半分だけ切り出されている

### 症状

`game/hud/orbit/orbit-analysis-window.ts`(466行)は
`AnalysisTab = 'altitude' | 'approach' | 'projection'`(3値)に対する分岐を
**9本のメソッド・約30箇所**に持っている。

```
266  if (this.tab === 'approach' && !this.approachAvailable) …
270  this.chart.element.classList.toggle('hidden', this.tab === 'projection');
271  this.projectionTab.chart.element.classList.toggle('hidden', this.tab !== 'projection');
274  if (this.tab === 'altitude') { … } else if (this.tab === 'approach' …) { … }
                                  else if (this.tab === 'projection' …) { … }
295  this.relIncRow.classList.toggle('hidden', tab !== 'approach');
296  this.yField.classList.toggle('hidden', tab === 'projection');
323  if (this.tab === 'projection') return;
331  return this.tab === 'altitude' ? 'h' : 'km';
337  if (!isScaleTab(this.tab)) return;
376  if (tab === 'altitude') { … }
430  if (this.tab === 'approach') { … }
```

`isScaleTab(tab): tab is ScaleTab` というヘルパまで生えている — **「投影タブだけ他の2つと
違う」という事実を型で言い直しただけ**で、分岐は残っている。

**そして `orbit-projection-tab.ts`(80行、単一参照)が既に存在する。** 投影タブだけが
モジュールとして切り出され、高度タブと接近タブは本体に残り、**分岐も本体に残った。**

### 診断

規約 1.2 が名指ししている形そのもの:

> **分岐の片側だけを別ファイルへ切り出しても分岐は元の場所に残る**ので、何も解決しない。

これは**ユーザーが疑った「安直に切り出しただけで構造的に整理されていない」の実例**であり、
同時に「切り出したせいでモジュールが1本増えた」例でもある。

### 修正

3つのタブを対等な具象にする。共通の口は:

```ts
interface AnalysisTabView {
  readonly id: AnalysisTab;
  readonly label: string;
  readonly element: HTMLElement;          // チャート本体
  available(game: Game): boolean;         // タブバーに出すか
  scaleFields(): ScaleFieldSpec | null;   // Y/X の入力欄。投影タブは null
  draw(game: Game, …): void;
  dispose(): void;
}
```

- `AltitudeTab` / `ApproachTab` / `ProjectionTab`(既存の `OrbitProjectionTab` が原型)。
- `isScaleTab` は `scaleFields() !== null` に置き換わって消える。
- `OrbitAnalysisWindow` は**タブの列を持ち、選択されたものへ委譲するだけ**になる。
- `orbit-chart.ts`(211) / `orbit-projection-chart.ts`(249) / `orbit-analysis-data.ts`(228)は
  そのまま各タブの下請けとして残る。

466行 → 200前後 + タブ3本。**ファイル数は増えるが、`orbit-projection-tab.ts` が
「なぜこれだけ外にあるのか」を説明できない現状より良い。**

---

## 論点18 — `Player` / `Base` を消費側が `instanceof` で判別し直している

### 症状

`instanceof` の出現をクラス別に数えると、`Player` と `Base` が突出している。両者は
`Controllable` を実装する対だが、**消費側が型を判別し直している。**(論点1 の完了後に再測。
調査時は 26 箇所、いま 29 箇所)

| モジュール | 箇所 |
| --- | --- |
| `hud/panels/vessel-panel.ts` | 8 |
| `pickable/map-context-actions.ts` | 7 |
| `hud/windows/resource-transfer-dialog.ts` | 5 |
| `docking/docking.ts` | 3 |
| `targeter.ts` / `hud/orbit/orbit-panel.ts` / `dynamic/entity-contact-response.ts` / `dynamic-entity/debris-piece.ts` / `dynamic-entity/bullet.ts` / `camera/combat-camera-system.ts` | 各1 |

`map-context-actions.ts` の7箇所は論点1 の宿題 (a) と同じもの。被選択物を多態にしたのに、
「自艦・基地だけ左クリックで掴める」「自艦のときだけ搭載部品を関連項目に出す」の2つが
`instanceof` のまま残っている。

`vessel-panel.ts` の `sync`(98行)が典型で、同じ1つのパネルを描くために8回判別する:

```ts
const throttleObj = target instanceof Player ? target : (target instanceof Base ? target : null);
const hasQdyn = target instanceof Player;                       // 動圧は Player だけ
const fineAtt = target instanceof Player ? target.fineAttitude : false;
if (target instanceof Player) { currentFuel = target.totalFuel; … }
else if (target instanceof Base) { currentFuel = target.fuel; … }
if (target instanceof Player) { ammo.textContent = fmtAmmoStatus(…); }
else if (target instanceof Base) { ammo.textContent = `Fuel: …`; }
```

`target-panel.ts` はさらに露骨で、`target instanceof Ship ? target.hp : BASE_ARMOR_PLACEHOLDER`
— **型が合わないので定数で埋めている。**

原因は `Controllable`(24行)が公開しているのが 13 メンバーだけで、
`fuel` / `maxFuel` / `hp` / 状態読み値を含まないこと。

### 診断

規約 1.3:

> **検出側やオーケストレータで当事者の型を分岐するコードは、この境界が破れているサインである。**

規約 1.6「多態を保存し、復元する」と同じ発想で、**当事者が自分の分を答えるべき。**

### 修正

`Hud` が既に `BurnManagementViewModel` でこの形を持っている
(`game.player?.boosterManagementViewModel()` — HUD は `Player` 型を知らない)。同じ形に揃える。

1. `Controllable` に `vesselStatus(): VesselStatusView` を足し、`Player` と `Base` が
   それぞれ自分の燃料・弾薬(または燃料)・動圧の有無・微調整状態を詰めて返す。
   **「動圧を持たない」は `qdyn: number | null` で表す**(規約 1.6「不在は `T | null`」)。
   `BASE_ARMOR_PLACEHOLDER` のようなダミー値は消す。
2. `resource-transfer-dialog.ts` の5箇所も同じ経路にする。
3. `docking.ts` / `entity-contact-response.ts` の `instanceof Base` は**接触の帰結**を
   見ているので別件。規約 1.3「a と b の接触の帰結は a と b の責務」に照らして
   別途見る(この文書では扱わない)。

### 注意

規約 1.5 が「**自機と敵の戦闘挙動は一般化しない**」と決めているが、**これは `Player` と
`Base` の話で、しかも表示だけなので抵触しない。** 戦闘挙動(射撃・散布界・被弾判定)には
触れないこと。

---

## 論点19 — その他の重複 union(実施済)

ラグランジュ点の呼び名を `physics/lagrange.ts` 1箇所へ集めた。**この語を所有しているのは
ラグランジュ点そのもののモジュール**で、ハロー軌道(`halo.ts`)にもゼロ速度曲線
(`zero-velocity.ts`)にも属していない。

- `LagrangeLabel`(5値)を `zero-velocity.ts` から移し、隣へ
  `CollinearPoint = Extract<LagrangeLabel, 'L1' | 'L2' | 'L3'>` を置いた。`halo.ts` の
  `CollinearPoint` と `orbit-guide.ts` の `GuidePoint` は消え、旧名 `GuidePoint` は 0 件。
- **同じ集合を書き写していた残り2つも畳んだ。** `LagrangePoints` は
  `Readonly<Record<LagrangeLabel, Vec3>>` になり、`collinearGamma` の引数に直書きされていた
  3値は `CollinearPoint` になった。`keyof LagrangePoints` で受けていた `lagrangeStateOf` と
  `nav-target.ts` の断言も `LagrangeLabel` へ。
- **再エクスポートは置いていない**(規約 1.6「同じ値へ入口を2つ作らない」)。
  `zero-velocity-section.ts` / `orbit-guide-catalog.ts` / `object-placer-panel.ts` /
  `orbit-guide-lines.ts` とテスト2本は `physics/lagrange` から直接受ける。

`predict-panel.ts` の `FixedDurationKey` / `FixedPastDurationKey` は
`Exclude<DisplayDurationKey, 'custom'>` / `Exclude<DisplayPastDurationKey, 'custom'>` になった。
5値・6値を書き写していたのが消え、期間キーの正本は `display-window-manager.ts` だけになる。

型定義だけの変更なので振る舞いは変わらない。`npm run typecheck` / `test:physics` 432件 /
`test:game` 161件 / `test:math` 42件 通過。

**畳まなかったもの。** `EphemerisScale`(`'TT' | 'TDB'`)⊂ `TimeScale` は
`JulianDate<EphemerisScale>` のように**型引数の制約**として使われていて、「この口は UTC を
受け取らない」という主張そのもの。値の写しではない。`SolarSide` / `RadiatorSide`(ともに
`'up' | 'down'`、`player/power.ts` / `player/radiator.ts`)は別部品で、片方だけ枚数が
変わりうる — 規約 1.6 の「たまたま同時に切り替わるものは別個にする」に従う。

---

## 論点20 — `MapCamera` の2つの非 on/off 2分(要検討)

`game/camera/map-camera.ts`(ファイル625行、`MapCamera` クラス531行・36メソッド)は
2値の union を2本持っている。

| フィールド | 型 | 分岐 |
| --- | --- | --- |
| `projectionMode` | `ProjectionMode = 'perspective' \| 'orthographic'` | 8 |
| `rotationMode` | `CameraRotationMode = 'quaternion' \| 'euler'` | 4 |

どちらも on/off ではなく「**2つの違うやり方のどちらか**」。とくに `rotationMode` は
ドラッグ処理(508行・532行)で**別々の積分方式**に分かれる。
`perspectiveCamera` と `orthographicCamera` の実体も両方保持している。

### 判断が要る点

- 投影方式は THREE の2クラスに対応しているので、**両方保持すること自体は避けにくい。**
  分岐8箇所のうち「どちらのカメラを返すか」は1箇所に閉じているので、実質の分岐は
  ズーム操作(522-525)と縮尺計算(578)。**大きくはない。**
- `rotationMode` のほうが本命。回転の積分だけを2つの実装に分けられるなら、
  `MapCamera` から 100 行前後が抜ける。
- **625行のうちどれだけが実際に片方だけの経路か**を測ってから決める。
  この文書の時点では測っていない。

**優先度は低い。** 論点1〜4 を終えてから測り直す。

---

## 分割が正しいと判定したもの(再検討しないための記録)

作業中に「単一参照」「短い」で引っかかるが、**触ってはいけない**もの。

| 対象 | 行数 | 残す理由 |
| --- | --- | --- |
| `hud/widgets/index.ts` / `hud/windows/index.ts` | 21 / 16 | 規約 1.12 が認める「公開境界として意図的に設計したディレクトリ」のバレル。widgets は 45 モジュールから参照されている |
| `hud/widgets/*`(index.ts を除く15枚, 13〜102行) | 835 | 各々が再利用される UI 部品。バレル越しなので参照数が1に見えるだけ |
| `dynamic-entity/enemy-dictionary.ts` | 13 | 規約 1.6「クラス辞書は独立したモジュールに置く」。基底へ入れると実行時循環で落ちる |
| `render/radiator-hinge.ts` / `render/rcs-nozzles.ts` | 4 / 20 | `tools/export-models.mjs` が TypeScript のまま単体で transpile する。import を持てない |
| `hud/windows/property-window-{rows,related-items,rename,items}.ts` | 156/110/67/63 | 各々が自分の DOM 要素と差分状態(`lastItemsKey` 等)を持つ。合成であって切り出しではない |
| `marker/crowding.ts` | 31 | 3モジュールから参照される実責務。引数が多いのはホットパスの意図的な選択で、コメントに理由がある |
| `player/aero-load.ts` / `altitude-alarm.ts` / `reentry-effects.ts` / `player-markers.ts` | 41/67/56/69 | いずれも自分の状態(動圧・EMA・ビルボード・マーカーキー)を持つ |
| `render/pipeline/sun-occlusion-select.ts` / `lighting/planet-light-select.ts` | 78/62 | 「このフレームに何を光源/遮蔽器として扱うか」という独立した判断。参照元が `celestial-system.ts` 1つでも責務がある |
| `dynamic-entity/debris-piece.ts` の `DebrisKind` | 192 | `kind` で切り替わるのはメッシュ・材質・寿命・効果音の**値**が中心。6具象へ割ると責務の無いクラスが6つ増える。規約 1.2 の第3分類「そのままでよい」 |
| `celestialClassVisible` 等の `CelestialClass` switch | — | 規約 1.8 が明示的に許可(分類が3種で閉じているという主張そのもの) |
| `hud/hud.ts` | 155 | パネル群の所有と DOM ルートの切替。パネルが単一参照なのは所有関係であって切り出しではない |
| `game/game.ts` | 638 | 500行超だが中身はオーケストレーション(規約 1.2 が `game.ts` に許している唯一のもの) |
| `hud/{map-scale,layout,sync-throttle}.ts` | 39/19/17 | DOM 非依存の純関数/状態。複数から参照されている |

第2次走査(分岐の形で探した分)で引っかかったが、**正しい形だったもの**。

| 対象 | 形 | 残す理由 |
| --- | --- | --- |
| `WaveState`(3値、`stage-utils/wave-attack.ts`) | 3値 union | **ディスパッチが1箇所**(`update` が3本の phase メソッドへ振るだけ)で、遷移も1クラスに閉じている。**3値 union の正しい形の見本。** 78行 |
| `ProteinPhase`(4値、`protein/protein-schema.ts`) | 4値 union | `recomputePhase` の1箇所でだけ決まり、他モジュールはデータとして読むだけ。振る舞いが切り替わっていない |
| `visible: boolean`(22モジュールの署名) | boolean | 純粋な on/off。「出す/出さない」以上のことを言っていない |
| `RenderStyle`(`'realistic' \| 'schematic'`、23モジュール) | 2値 union | 分岐は12モジュールに散るが**各所1〜2箇所**で、いずれも局所的な値の選択(色・線種)。振る舞いを分けていない |
| `instanceof OrbitingMotion`(13箇所) | 型の絞り込み | 8箇所が `if (!(x instanceof OrbitingMotion)) return/throw` のガードで、**能力の有無**を絞っている。`instanceof Player`/`Base` と違い、分岐の先で別の振る舞いを書いていない |
| `CelestialClass`(5値)/ `CelestialKind`(3値) | 分類 union | 規約 1.8 が明示的に許可。分類が閉じているという主張そのもの。粒度が違うので2つあってよい |
| `SolarSide` / `RadiatorSide`(ともに `'up' \| 'down'`) | 値が一致 | 別部品。片方だけ枚数が変わりうるので畳まない(論点19 参照) |
| `MenuAction`(22値) | 22値 union | メニュー項目の識別子。分岐は**項目ごとの処理**であって、同じ処理が種別で分岐しているのではない。論点1 で各被選択物の `runMapMenu` へ分配済み |

---

## 実施順序

**実施済: 論点1 / 2 / 3 / 4 / 7 / 8 / 11 / 12 / 15 / 16 / 19。** 残りは 5 / 6 / 9 / 10 /
13 / 14 / 17 / 18 / 20。

**論点1・7・16 の完了で、それを条件にしていた論点18 と論点13 の前提が揃った。**
論点15 の完了で、ビューの型は `WorldView` 1本になっている。

1. **論点18**(`Player`/`Base` の `instanceof`)— **論点1 の完了で着手可能になった本命。**
   調査時 26 箇所 → 現在 29 箇所(再編で `map-context-actions.ts` 側が増えた)。
   `vessel-panel` / `resource-transfer-dialog` / `target-panel` に加えて、
   **論点1 の宿題 (a)(b) も同じ形なので1回で見る。** `Controllable` に
   `vesselStatus(): VesselStatusView` を足す案は論点18 の節にある。
2. **論点1 の宿題 (c)(d)(e)(f')** — **(f)(g) は実施済。** (c) は規約 1.5 の判断が要るので
   **着手前にユーザーへ問う。**(f') も同じく判断待ち — `physics/time/index.ts` の TDB 変換一式を
   capability ごと消すかどうか。(d)(e) は `Game` の配線に触るので、単独では割に合わない —
   `map-context-actions.ts` を 400 行未満へ割る判断(= `MapCommands` の実装をウィンドウ台帳から
   引き剥がすか。剥がすと台帳へのコールバックが増えるので、論点1 ではあえて同居させた)と
   同時に決める。
3. **論点6**(`marker-manager` のラベル間引き)— **論点7 の完了で前提が変わった。**
   `focus-markers.CrowdingGrid` は `marker/crowding.ts`(122行)へ移り、間引きの実装は
   `marker-manager.thinByPriority` / `crowding.CrowdingGrid` / `grouped-markers` の3つ。
   `marker-manager.ts` は 670 行で `relaxLabelRects` の 134 行 1 メソッドも残っている。
   **切り出しと、3実装の統合可否(先に SPEC/MAP.md 7.2 を読む)を1回で決める。**
4. **論点17**(軌道分析タブの多態化)— 466 行のまま。**論点1 と同じ形の修正なので手本がある**
   (`orbit-projection-tab.ts` だけが外にある現状は、規約 1.2 が名指しする「片側だけ切り出し」)。
5. **論点5**(`hud/style/` 22→10)/ **論点10**(ラベル付き入力行)— 独立。手が空いたときに。
6. **論点9**(`plan-editor` 718行)— `plan/` 全体(`plan-path.ts` を含む)を見るときに。
7. **論点13 / 14 / 20** — 方針をユーザーへ問うてから。
   - **論点13** は論点15 の完了で議論の前提が揃った。ただし `overviewMode: boolean` は
     署名 23 → 25 モジュールへ広がっている(再編で `MapCommands.overviewMode` が増えた)。
     `boolean` のままにするか `WorldView` を渡すか、`ViewManager` 経由で経路ごと分けるか。
   - **論点20** は先に実測(`MapCamera` 625 行のうちどれだけが片方だけの経路か)が要る。

各段階の検証は変更箇所に対応させる(`npm run typecheck` は常に。`src/game/` を触ったら
`npm run test:game`、`src/physics/`・`src/math/` を触ったら該当層)。**main へ送る前は
必ず `npm run test` を全層回す。**
