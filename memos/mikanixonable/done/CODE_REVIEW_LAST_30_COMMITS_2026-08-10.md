# 過去30コミットのコードレビュー

レビュー日: 2026-08-10  
対象: `HEAD~30..HEAD`（マージコミットで取り込まれた変更も含む）  
対象範囲: 表示設定・カメラ/ビュー・計画軌道・天体/環レンダリング・セーブ/ロード・テスト

## 結論

静的な品質ゲートは通っている。

- `npm run typecheck`: 成功
- `npm run test:physics`: 成功（382件）
- `npm run build`: 成功（Webpack の asset size warning のみ）
- `npm run verify:source`: 成功
- `npm run smoke:browser`: 失敗（`shield: false`, `backgroundDim: false`）

したがって「コンパイルできる」「物理の既存テストが通る」だけでは、この30コミットの完成条件になっていない。特に、表示設定の状態モデルと計画軌道の予測モデルが別々に拡張され、UIが宣言している意味と実際に制御している対象が一致していない。個別の if を追加していくより、表示ポリシーと予測対象を一つの正本へ集約する方針に変えるべきである。

以下の P1 はマージ前に解消したい。P2 は直ちにクラッシュするとは限らないが、機能を増やす前に設計を直しておかないと同種の不具合が増殖する項目である。

## P1-1: モーダルの入力遮断が実装されておらず、ブラウザスモークも失敗する

### 根拠

- `src/game/hud/dom.ts:39` の `#hud-modal-shield` が `pointer-events: none`。
- `src/game/hud/dom.ts:941` でシールドを notify layer に置いているが、`overlay-layer.ts:9-11` の親 layer も `pointer-events: none`。
- `tools/browser-smoke.mjs:234-242` はモーダル表示中に `pointer-events: auto` を要求しており、実行結果は `shield: false` だった。
- 同じスモークは `#hud-combat-shelf` の opacity を見て dim を判定しているが、実装は opacity ではなくシールドの背景色で覆う方式であるため、検査対象も実装方式と一致していない。

### 影響

ヘルプ、設定、セーブブラウザを開いている間も背後のゲームへポインタ入力が通る。タッチ入力は CSS で隠しているが、マウス/ポインタの入力ゲートは閉じていない。さらに、テストが失敗している状態を CI の成功条件として扱えない。

### 根本修正方針

モーダルを「見た目の panel」と「入力ゲート」に分けず、`ModalController` のような単一状態機械にする。

1. モーダルが一つでも開いている間は、専用シールドを `pointer-events: auto` にする。
2. シールドはモーダル本体の背面、通常の panel/window より前に置く。モーダル本体だけ `pointer-events: auto` とする。
3. `syncHudModalState()` が DOM の computed style を読んで状態を推測するのではなく、開閉 API が `openModalCount` と入力ゲートを同時に更新する。
4. スモークは opacity のような実装詳細ではなく、背景へクリックを送ってゲーム側のハンドラが発火しないこと、シールド自身がイベントを受けることを検証する。

## P1-2: 宇宙船/敵/弾薬/基地の表示トグルが UI にあるだけで、表示系全体を制御していない

### 根拠

`56695a8 feat: add display category toggles` で entity 行が追加されたが、実装はカテゴリの状態を一部の軌道線にしか渡していない。

- UI は `src/game/camera/overview-camera-panel.ts:22-26` で entity ごとに `Visible/Icon/Label/Orbit` を提供する。
- 実際の利用箇所は `src/game/game.ts:700-716` の player/base/enemy の軌道線と、`camera-system.ts:106-112` の ammo 用の旧 `showMapAmmo` 互換処理だけである。
- `src/game/game.ts:692-699` は全 player/entity のメッシュを常に同期する。
- `src/game/game.ts:721-733` は敵マーカーを全て作る。
- `src/game/map-picker.ts:123-147` は全ての生存 player/enemy/ammo/base を候補へ追加し、entity 用トグルで除外していない。
- `src/game/object-list-panel.ts:134-175` も渡された全候補を種別ごとに表示するだけで、トグルを知らない。
- `src/game/stages/stage-utils/logistics.ts:103-121` は ammo の `showMapAmmo` だけを見ており、`ammoLabel` は使っていない。
- `rg` で確認すると、`playerIcon/playerLabel`、`shipIcon/shipLabel`、`baseIcon/baseLabel`、`ammoLabel`、`ammoOrbit`、`baseOrbit` などは宣言・既定値・UI以外の実装利用がない。

結果として、例えば「敵のカテゴリを off」にしても敵マーカー・一覧・ピック候補は残り、アイコンだけ off にしてもラベルや一覧が残る。`ammoIcon` だけが旧 `showMapAmmo` を経由して別の意味を持つため、同じ UI 行のボタンごとに意味が異なる。

### 根本修正方針

`BodyClassToggles` を単なる boolean 集合として各所に配るのをやめ、entity と celestial body を共通に解決する `MapVisibilityPolicy` を作る。少なくとも以下を一つの resolver が返す。

```ts
type MapVisibility = {
  category: boolean;
  icon: boolean;
  label: boolean;
  orbit: boolean;
  pickable: boolean;
};
```

この resolver を、次の全ての入力に使う。

- 3D メッシュ/軌道線
- 画面マーカーと方位矢印
- `FocusMarkers`
- `MapPicker` と右クリック対象
- `ObjectListPanel`
- ammo/base の専用マーカー

active player や現在フォーカス中の親天体を常時表示する例外を設けるなら、resolver 内の明示的な policy として定義する。`_hud.settings.showMapAmmo` のような第二の状態は廃止し、`ammoLabel` は実際にラベルだけを制御する。カテゴリを off にした対象は、少なくとも「見えないのに一覧/選択には残る」状態を作らない。

各カテゴリについて `Visible/Icon/Label/Orbit` の組み合わせをテーブルテストし、マーカー・一覧・ピック・軌道線の4つが同じ結果になることを回帰テストにする。

## P1-3: 計画軌道の「区間掃引」衝突判定は、広域候補抽出と交差根探索が連続衝突判定になっていない

### 根拠

- `src/game/plan/plan-arc.ts:62-79` の `refineSurfaceCrossing()` は、区間両端の clearance の符号が同じなら即座に `null` を返す。
- `src/game/plan/plan-arc.ts:88-107` は先に `sweptSphereToi()` を通すが、線分の両端が表面外で途中だけ通過するケースでは、その後の endpoint sign check によって捨てられる。
- `src/game/plan/plan-arc.ts:265-315` は start/mid の現在位置に対する `attractorsNear()` の結果だけを candidates にする。
- `src/game/simulation/attractors.ts:62-83` の broadphase は空間グリッドの 27 近傍であり、区間中に移動してくる天体の swept volume を問い合わせていない。
- `src/game/simulation/attractors.ts:20-22` の `gravityBodiesAt()` は `mu !== 0` だけを残す。太陽系データには `mu: 0` の天体が多数あるため、計画軌道の表面衝突対象から意図せず落ちる。

`stepDt()` の接近時間制限はこの問題の発生確率を下げるヒューリスティックであって、完全な衝突保証ではない。高離心率、速く移動する小天体、遠方で大きくなった timestep、両端の外側を通過する軌道で破綻する余地がある。

### 根本修正方針

重力源と衝突体を同じ `Attractor[]` に押し込めず、少なくとも次の二つを分離する。

- `GravitySource`: `mu`、J2、SRP/影など積分に必要なもの
- `CollisionBody`: 半径/形状、時刻 `t` における位置、表示専用で `mu=0` の天体も含む

衝突判定は次の順序にする。

1. 予測区間全体の自機 sweep と各 CollisionBody の sweep から swept AABB/capsule を作る。
2. broadphase は start/mid の点ではなく、その swept volume と交差する候補を返す。
3. narrowphase は相対運動の clearance 関数の最初の根を探す。端点の符号だけを使わず、保守的な細分化または conservative advancement と固定回数の根探索を使う。
4. 全候補の最初の hit を比較し、最初の衝突で軌道を切る。

`gravityBodiesAt()` と `predictedAttractorsAt()` の命名・契約を整理し、計画表示が「重力を感じる天体だけに当たる」のか「ゲーム内の物体表面に当たる」のかを仕様として固定する。最低限、以下をテストする。

- 区間両端が表面外で、途中だけ通過するケース
- 天体自身が区間中に計画軌道へ入ってくるケース
- `mu=0` だが半径を持つ天体への衝突
- 複数天体のうち最初の衝突が選ばれるケース

## P1-4: 計画軌道が動的天体を未来時刻で予測せず、現在位置を最大1年間凍結している

### 根拠

- `src/game/plan/plan-arc.ts:243-250` は `dynamicAttractors` を「このフレームで一度だけ求めた値を全ステップで使い回す」と明記している。
- `src/game/plan/plan-path.ts:61-80` はその配列を全 arc に渡す。
- `src/game/game.ts:549-552` は `this.entities.attractors()`、つまり現在状態の動的 entity を渡している。
- 一方、`src/game/simulation/attractors.ts:29-37` には既に `predictedAttractorsAt(ephemeris, entities, t)` があり、動的 entity の `displayState(t)` を使う正しい方向の部品が存在する。

予測軌道の積分は動的 entity を現在位置に固定する一方、実シミュレーションは entity を移動させる。そのため、計画線・計画衝突・実際の軌道の間に時間が経つほど系統的な乖離が生じる。特に動的重力源や移動中の衝突体を追加するほど、表示の誤差ではなく意思決定を誤らせる問題になる。

### 根本修正方針

`readonly Attractor[]` のスナップショットを受け取る API を、次のような時刻依存 provider に変える。

```ts
type AttractorProvider = (t: number, queryPosition: Vec3) => {
  gravity: readonly Attractor[];
  collision: readonly CollisionBody[];
};
```

PlanArc の各積分 stage、broadphase、collision narrowphase が同じ provider を使う。`displayState(t)` が求まらない entity は現在位置に凍結せず、予測対象から明示的に除外する。予測を軽量化する場合も「現在位置で凍結」という暗黙の近似ではなく、`dynamicPredictionMode = ignore | linear | propagate` のように仕様として選択できるようにする。

## P1-5: 環表示のリファクタで、環データと光学計算のテスト14件を一緒に削除している

### 根拠

- `fb98d3b refactor: ring-lod を ring-view へ統合する` に伴い `tests/physics/ring.test.ts` が157行削除されている。
- 削除されたファイルには LOD だけでなく、全環データの存在・帯数・厚み・海王星の5本のアーク・フェーベ環、`ringTransmission`、Henyey-Greenstein、pixel coverage、arc optical depth、惑星影のテストが含まれていた。
- 現在の `tests/physics/index.ts:53-98` に ring test の登録はなく、`src/physics/ring-optics.ts` は残っている。
- したがって現在の「382件成功」は、削除前の環回帰14件を含まない成功である。

### 根本修正方針

テストを責務ごとに分割して戻す。

- `ring-data.test.ts`: `SOLAR_SYSTEM` の環データ契約
- `ring-optics.test.ts`: 透過、散乱、coverage、arc、惑星影
- `ring-view.test.ts`: LOD の pure helper と visual state の切替契約

`RingView` 内の `thinBandBlend()` のような計算はレンダラーから切り離した pure module に置くか、テスト可能な関数として公開する。レンダリングクラスの移動を理由に、物理データのテストを削除しない。テスト件数の減少を CI で検出する最低限のガードも追加する。

## P2-1: localStorage の JSON を TypeScript の型 assertion だけで信頼している

### 根拠

- `src/game/save/save-store.ts:31-34` は index を `JSON.parse(raw) as SaveIndex` とし、version 以外を検証しない。
- `src/game/save/save-store.ts:55-57` は snapshot 本体を `JSON.parse(raw) as GameSaveData` のまま返す。
- `src/game/save/snapshot-service.ts:43-59` は null/version/stage/context だけを検証して `game.restore(data)` を呼ぶ。
- `src/game/game.ts:322-377` は restore 開始時に既存 entity を消してから、配列、stage、camera を順に復元する。
- `src/game/camera/chase-camera.ts:148-153`、`src/game/camera/overview-camera.ts:285-298` は数値、四元数、enum、frame id を runtime 検証せず直接代入/解決する。

JSONとしては有効だが構造が壊れた localStorage、`null`/文字列/極端な数値へ改変されたデータ、将来の部分的な schema 変更で、ロードが throw するかカメラ/物理へ不正値を注入し得る。しかも restore は先に現行ゲームを破棄するため、失敗が原子操作ではない。

### 根本修正方針

runtime decoder と migration 層を導入する。decoder は全 leaf の有限性、配列長、id の重複、enum、四元数の長さ、camera distance の上下限、frame/body id の存在、stage と active player の整合性を検証する。検証済みの内部型だけを `Game.restore()` に渡し、decode 失敗時はゲーム状態を変更しない。

ロードは `decode -> build temporary state -> validate cross references -> commit` の二段階にする。旧形式は decoder の外で暗黙に吸収せず、version ごとの明示的 migration としてテストする。破損 index/snapshot、欠損 camera、未知 frame id、重複 entity id、`null`/文字列/範囲外数値を含む fixture を追加する。

## P2-2: 天体カタログの拡張に対して、参照線生成とラベル衝突判定がスケールしない

### 根拠

- `src/game/celestial/environment-scene.ts:44-47` は恒星以外の registry 全件を参照線対象にする。
- `src/game/celestial/environment-scene.ts:91-99` は初期化時に全対象へ `OrbitLine` と GPU resource を作る。非表示の対象も同じリソースを持つ。
- `src/game/camera/focus-markers.ts:164-183` は表示ラベル間の衝突を二重ループで比較する。
- `src/game/camera/focus-markers.ts:168-171` と `:189` で同じラベルの遮蔽判定を複数回行う。

現在の天体数では見逃しにくいが、衛星・小天体・Lagrange 点・将来の cislunar catalog を足すと、非表示でも常駐する GPU resource と毎フレームの O(N²) ラベル判定が効いてくる。`FocusMarkers` は Icon と Label を別トグルとして公開しているのに、`hiddenByPriority` では `:194-196` で marker 全体を hide するため、ラベルの衝突がアイコンまで消す意味の不一致もある。

### 根本修正方針

参照線は lazy creation または共有 geometry/instancing にし、表示対象・距離・太さに応じた LOD を GPU resource の所有単位にも反映する。ラベルは画面をセル分割した spatial hash で候補を絞り、遮蔽計算を一度の frame cache にする。Label の優先度解決と Icon の表示可否を分離し、ラベルだけを隠す。カタログサイズを段階的に増やす性能テストを追加する。

## P2-3: 軌道線の身体除外が semimajor axis 近似と乱数ジッターに依存している

### 根拠

- `src/render/orbit-line.ts:126-134` は GPU 更新を促すため、原点にある線へ毎フレーム `Math.random()` のジッターを加える。
- `src/render/orbit-line.ts:181-186` は天体の見かけ角を `el.a / radius` で近似する。離心軌道では現在の局所半径は `a(1-e^2)/(1+e cos(nu))` であり、天体を除外すべき角幅は一定ではない。
- `src/render/orbit-line.ts:189-196` は隣接頂点の fade と角度符号だけでセグメントを落とす。

乱数はリプレイ/スクリーンショット/差分検証を非決定的にし、根本原因である WebGPU buffer invalidation を隠す。高離心率の参照線では、惑星の直上に線が残るか、逆に必要以上の空白ができる。

### 根本修正方針

Transform の変更で buffer upload を誘発するのではなく、`BufferAttribute.needsUpdate` と renderer 側の更新経路を確認し、明示的な dirty/version 通知を使う。どうしても回避が必要なら固定 epsilon とする。身体除外は楕円上の各セグメントを実座標へ展開して sphere/ellipsoid intersection を行い、弧長と局所速度を用いた fade width を求める。離心率の大きい人工ケースを OrbitLine の pure geometry テストへ追加する。

## 推奨する実装順序

1. モーダル入力ゲートを修正し、ブラウザスモークを「クリックが背後へ通らない」契約へ直す。
2. `MapVisibilityPolicy` を導入して entity/celestial の表示・選択・一覧の正本を統合する。
3. `GravitySource` と `CollisionBody` を分離し、時刻依存 `AttractorProvider` と swept broadphase/narrowphase を設計する。
4. 削除された環テストを責務分割して復元する。
5. セーブ decoder/migration/atomic restore を導入する。
6. catalog scalability と OrbitLine の deterministic update を改善する。

## コミット単位での要点

- `c8ca2a5`: overlay layer 移行で modal shield の入力契約を再検証できていない。
- `56695a8`, `939d634`: 表示カテゴリの UI は拡張されたが、entity への伝播が未完了。
- `562241a`: endpoint collision から掃引へ進んだ方向は正しいが、候補抽出と根探索がまだ連続衝突ではない。
- `fb98d3b`: `ring-lod` の統合と無関係な環物理テストまで削除されている。
- `a066f0d`, `f6a8513`: セーブ対象が増えたタイミングで runtime schema validation を導入する好機を逃している。

このレビューでは、指定どおり `dev.md` は変更していない。コード本体にも修正を入れず、指摘と方針だけを本ファイルへ記録した。
