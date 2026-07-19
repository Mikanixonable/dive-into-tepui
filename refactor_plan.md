# リファクタリング計画: 現状分析

refactor_instruction.md の方針(モジュール化・データ構造・命名)に照らして、現状のコードベースを
「長大なファイル」「過密な依存関係」「重複した実装」「責務の分散」の4観点で洗い出した結果
(4番目は調査計画の指摘を受けた追加調査)。

対象は `src/` 配下。行数・依存数は本分析時点の実測値。

---

## 1. 長大なファイル

モジュール200行・関数100行という基準に対する超過状況。

### ファイル単位(200行超)

| ファイル | 行数 | 備考 |
|---|---:|---|
| [src/game/game.ts](src/game/game.ts) | 1684 | 突出。詳細は次項 |
| [src/game/combat.ts](src/game/combat.ts) | 541 | 発射/AI/被弾/撃破/デブリ生成が同居 |
| [src/game/planner.ts](src/game/planner.ts) | 505 | ノード管理/入力編集/ガイド表示/整形が同居 |
| [src/render/ships.ts](src/render/ships.ts) | 485 | 全メッシュ種の生成が1ファイルに集約 |
| [src/game/markers.ts](src/game/markers.ts) | 447 | 方向/敵/AMMO/ノード/PIP/パネル更新が同居 |
| [src/game/audio.ts](src/game/audio.ts) | 416 | SFX個々の合成処理とBGMシーケンサが同居 |
| [src/game/hud.ts](src/game/hud.ts) | 394 | |
| [src/game/stages.ts](src/game/stages.ts) | 389 | |
| [src/game/hud/dom.ts](src/game/hud/dom.ts) | 379 | |
| [src/game/mapgizmo.ts](src/game/mapgizmo.ts) | 296 | |
| [src/main.ts](src/main.ts) | 261 | PIPカメラ操作が肥大化(後述) |
| [src/game/belt.ts](src/game/belt.ts) | 245 | |
| [src/game/const.ts](src/game/const.ts) | 235 | 定数のみのため許容範囲 |
| [src/render/earth.ts](src/render/earth.ts) | 232 | |

### game.ts の内部構造(最重要)

1つのクラス `Game` に以下がすべて同居しており、200行/関数100行の基準を大幅に超過している。

- コンストラクタ: 約250行(シーン初期化・HUDコールバック配線・マップギズモ配線・自機/敵生成・ステージ別トースト)
- `update()` : 約150行(ポーズ・ターゲット自動選択・右クリックロック・ステージタイマー呼び出し)
- `handleEdgeInput()` : 約150行、1つの `switch` に十数個の無関係なキー操作(RCS制動/微調整/プログレードホールド/視点追従/スロットル/タイムワープ/マップ切替/自動ワープ/計画破棄/ヘルプ/ポーズ/リロード)が同居
- `simulate()` : 約150行(自動ワープ制御・射撃・弾切れ判定・推力構築・軌道積分サブステップ・熱/動圧判定・弾薬ロジスティクス・剛体衝突・姿勢積分)
- `syncRender()` : 約200行 + 補助メソッド群(`syncRenderMapCamera` / `syncRenderCombatCamera` / `syncRenderCombatMoon` / `syncRenderMapOrbitReferences` / `updateRcsEffects` / `updateTrajLineAndMarkers` / `rebuildTrajLineGeom` / `project` / `setObjAttitude`)を合わせると500行規模の「描画同期」責務

これらは `combat.ts` / `stages.ts` / `environment.ts` / `markers.ts` / `planner.ts` / `mapview.ts` / `belt.ts` と同様、
**すでに確立されている「Ctx注入で切り出す」パターンに沿って独立モジュール化できる責務**である
(例: 描画同期一式を `rendersync.ts` へ、弾薬/ベルト給弾ロジスティクスを `ammo.ts` へ、キー入力の switch を意味のある単位に分割)。

### 関数単位(100行超、game.ts以外)

- [src/game/combat.ts](src/game/combat.ts) 内 `fireGun` 相当の発射処理、`checkBulletHits` 系
- [src/game/planner.ts](src/game/planner.ts) 内のノード編集(`updateEditing` 系)
- 上記は個別に要再確認だが、ファイル行数から見て100行超の関数が複数存在する可能性が高い

---

## 2. 過密な依存関係

### import数(ファイル先頭の `import ... from` 文数)

| ファイル | import数 |
|---|---:|
| [src/game/game.ts](src/game/game.ts) | 20 |
| [src/render/ships.ts](src/render/ships.ts) | 14 (アセットJSON 13種 + THREE) |
| [src/game/planner.ts](src/game/planner.ts) | 9 |
| [src/game/markers.ts](src/game/markers.ts) | 8 |
| [src/game/stages.ts](src/game/stages.ts) | 8 |
| [src/game/combat.ts](src/game/combat.ts) | 7 |
| [src/game/mapview.ts](src/game/mapview.ts) | 7 |
| [src/game/environment.ts](src/game/environment.ts) | 6 |

### "Ctx注入" パターンによる暗黙の結合

`combat.ts` / `stages.ts` / `markers.ts` / `planner.ts` はそれぞれ `game.ts` を import しない設計になっており、
一見疎結合に見える。しかし実際には以下の理由で **データ構造としての結合度が高い**:

- `CombatCtx`(combat.ts）・`StageCtx`（stages.ts）・`MarkersCtx`（markers.ts）・`PlannerCtx`（planner.ts）という
  4つの類似インターフェースが存在し、いずれも `player` / `enemies` / `scene` / `simTime` / `mapMode` など
  Game の同じ実体を指すフィールドを重複して宣言している。
- `game.ts` 側は `combatCtx()` / `stageCtx()` / `markersCtx()` / `plannerCtx()` という4つのほぼ同型のスナップショット
  組み立てメソッドを毎フレーム呼び出しており、Game の1つのフィールド(例: `simTime`)を変更・追加するたびに
  4箇所前後のCtx定義とビルダーを同時に触る必要がある。
- これは refactor_instruction.md の「悪いデータ構造: 正データが複数箇所に分散、重複しているデータ」
  「複数箇所が一定の整合性を保つことが要求されるデータ」に該当する。
- `roundsInMag` / `magsLeft` / `magsConsumedSinceReload` / `reloadTimer` は `CombatCtx` 経由で値渡しされ、
  呼び出し側 (`game.ts`) が戻り値を自分のフィールドへ手動で書き戻す運用になっており(コメントで明示されている)、
  正データの所在が実質的に `game.ts` と `CombatCtx` の両方に一時的に存在する状態を生んでいる。

### main.ts と Game のカプセル化違反

[src/main.ts](src/main.ts) の `animate()` 内で、PIP(ズームウィンドウ)描画のために
`game.activeCamera`(公開ゲッターで生の `THREE.PerspectiveCamera` を返す)の `position` / `quaternion` / `fov` /
`aspect` を直接書き換えてから戻す、という処理を行っている。カメラの操作は本来 `game.ts` 側
(`syncRenderCombatCamera` 等)の責務であり、`main.ts` が `Game` の内部状態(カメラ姿勢)を直接いじる形に
なっているのは責務境界の逸脱。PIPカメラの一時的な姿勢変更は `Game` 側にメソッドとして持たせるべき。

### markers.ts という名前の2ファイル

[src/game/markers.ts](src/game/markers.ts)(`MarkersSystem` — ゲーム状態からマーカー座標/表示内容を算出するドメインロジック)と
[src/game/hud/markers.ts](src/game/hud/markers.ts)(`MarkerManager` — DOM要素の生成・スタイル適用・ラベル衝突回避)は
責務としては分離できているが、同名ファイル・似た名前のクラス(`MarkersSystem` / `MarkerManager`)が
異なるディレクトリに存在するため、参照時に混同しやすい。命名の見直し(例: `hud/markerDom.ts`)が望ましい。

### Ctxフィールドの重複度(調査結果)

調査計画の指摘どおり、4つの Ctx を実際にフィールド単位で比較すると **一様に密結合なのではなく、
2つの Ctx が異常に肥大化しているだけ** だと分かった。

| Ctx | フィールド数 | 備考 |
|---|---:|---|
| `PlannerCtx` ([planner.ts](src/game/planner.ts)) | 7 | `simTime`/`playerR`/`playerV`/`sunPhase0`/`moonPhase0`/`mapMode`/`mapFrameRotating` のみ。**予測計算に必要な最小限**に絞られており、疎結合の模範に近い |
| `StageCtx` ([stages.ts](src/game/stages.ts)) | 13 | `phase`/`player`/`enemies`/`enemyOrbitLines`/`scene`/`shots`/`hits`/`kills`/`magsLeft`/`roundsInMag`/`setPhase()` |
| `CombatCtx` ([combat.ts](src/game/combat.ts)) | 21 | 上記に加え `target`/`stage`/`zoomActive`/`glowTex`/`bullets`/`plasmaBullets`/`casings`/`debris`/`effects`/`boardMarks`/`lostReason`/`magsConsumedSinceReload`/`reloadTimer`/`setLostReason()` |
| `MarkersCtx` ([markers.ts](src/game/markers.ts)) | 29 | 上記に加え `mapLabelIds`/`activeCamera`/`touchControls`/`solveLeadTime()`/`warp`/`paused`/`rcsDamp`/`throttleIdx`/`fineAttitude`/`progradeHold`/`camFollowAttitude`/`alt`/`altDescending`/`qdyn`/`hullTemp`/`totalEnemies`/`stage00WaveCount`/`stage0TimeLeft` |

`PlannerCtx` が小さいまま保てているのは、`MapPlanner` が「予測計算」という**単一責務**しか持たないため。
一方 `MarkersCtx` が29フィールドまで膨らんでいるのは、`MarkersSystem` が実際には

1. スクリーン投影マーカーの算出(`updateMarkers`/`updateNodeMarkers`/`updateBoardMarkers`/`updatePipOverlay` — 必要なのは `player`/`enemies`/`target`/`activeCamera`/`simTime`/`solveLeadTime`程度)
2. ステータスパネルの同期(`updateHudPanels` — `warp`/`paused`/`rcsDamp`/`throttleIdx`/`fineAttitude`/`progradeHold`/`camFollowAttitude`/`alt`/`altDescending`/`qdyn`/`hullTemp`/`stage00WaveCount`/`stage0TimeLeft` 等、マーカー算出とは無関係なテレメトリ)

という**互いに無関係な2つの責務**を1クラス・1Ctxに同居させているためである。これは
refactor_instruction.md の「責務が大きすぎるモジュール」に該当し、Ctx注入という仕組み自体の問題ではなく、
**責務分割が先に必要**というケースの実例といえる(調査計画で懸念されていた通り)。

また `roundsInMag`/`magsLeft`/`reloadTimer` は `CombatCtx`(書き込み可能な正データ)と `MarkersCtx`
(表示専用の読み取りコピー)の両方に現れる。これは「同じ弾薬状態を2つのCtx形状で使い回している」だけで、
本来は `game.ts` 側に `AmmoState` のような1つの小さなデータ構造を置き、`CombatCtx`/`MarkersCtx`
の双方がそれを参照する形にすれば、フィールドの重複宣言自体は消せる。

---

## 3. 重複した実装

### (a) `randSym` / `randVec` / `randPerp` の三重・二重コピペ

以下は変数名まで完全一致するコピペ実装:

- `randSym` / `randVec`: [src/game/game.ts](src/game/game.ts) (L89-95), [src/game/combat.ts](src/game/combat.ts) (L35-41), [src/game/stages.ts](src/game/stages.ts) (L39-45) の **3箇所**に同一定義。
- `randPerp`(fwd に直交するランダム単位ベクトル): [src/game/combat.ts](src/game/combat.ts) (L44-50) と
  [src/game/stages.ts](src/game/stages.ts) (L48-54) の **2箇所**に同一定義。
  combat.ts 側のコメントには「game.ts の randPerp と同一実装」と書かれているが、現在の game.ts には
  該当関数が存在せず、コメントが実装とズレている(過去の切り出し漏れ、または削除時の消し忘れ)。

→ `src/physics/vec3.ts` またはゲーム専用の小さな共有ユーティリティ(例: `src/game/rand.ts`)に一本化すべき。

### (b) 「前進方向+天頂方向 → 姿勢クォータニオン」の基底構築ロジックの三重コピペ

`zAxis = norm(fwd)` → `yAxis = norm(up)` → `xAxis = cross(yAxis, zAxis)` →
`THREE.Matrix4().makeBasis(...)` → `Quaternion().setFromRotationMatrix(m)` という同一の手順が、
**微妙に異なる変数名・追加処理を伴いつつ** 以下の3箇所に存在する:

1. [src/game/game.ts](src/game/game.ts) `progradeAttitude()` (L461-472) — 初期姿勢の生成。
2. [src/game/game.ts](src/game/game.ts) `autoAlignTorque()` (L1174-1192) — PDトルク計算用の目標姿勢生成
   (コメントで明示的に「progradeAttitude と同じ基底の作り方」と書かれている＝重複が自覚されている)。
3. [src/game/stages.ts](src/game/stages.ts) (L417-426) — ステージ00 ウェーブ敵の初期姿勢生成。

→ `src/physics/attitude.ts` に `attitudeFromForwardUp(fwd: Vec3, up: Vec3): Quat` のような
純関数を1つ追加し、3箇所ともそれを呼ぶ形に統一すべき。

### (c) 距離の文字列整形が2つの流儀で重複

- `fmtDist()` in [src/game/hud.ts](src/game/hud.ts) (L60-65): m / km / Mm の3段階。
- `fmtMarkerDist()` in [src/game/markers.ts](src/game/markers.ts) (L19-21): m / km の2段階。
- [src/game/planner.ts](src/game/planner.ts) (L365) では `(alt / 1000).toFixed(0)}km` を直接インラインで記述しており、
  上記2関数のどちらも使わず3種類目の即席実装になっている。

→ 用途(HUDステータスパネル向け／スクリーンマーカー向け)で表示桁数の要求が違うなら、
最低限「m⇔km変換」の共通部分だけでも1箇所にまとめ、少なくとも新規のインライン整形を増やさない方針にすべき。

### (d) `simulate()` と `predictTrajectory()` の重複度(調査結果: 低い)

調査の結果、この2つは **懸念したほどには重複していない**。両者とも実際の数値積分は
[physics/orbital.ts](src/physics/orbital.ts) の `stepOrbitRK4` 純関数を共通で呼んでおり、J2・第三体摂動も
同じ `j2AccelInto` / `thirdBodyAccelAdd` を使っている。積分本体のコピペは無い。

しかし、関与している力の列挙、積分の呼び出し自体が、共通化できるはず。
逆に、弾薬の更新などsimulateのみにあってpredictにない処理は、simulateというより別の関数に存在するべき処理なのではないか。整理しながら注意深く見るべき。

「J2 + 第三体(+大気抵抗)を1つの `ExtraAccel` 関数へ合成する」という
**組み立てパターン自体**が、[physics/predict.ts](src/physics/predict.ts) の `envAccel()`(J2 + 第三体のみ)と
[game/environment.ts](src/game/environment.ts) の `makeEnvAccel()`(大気抵抗 + J2 + 第三体)の2箇所で
別々に書かれている。抵抗項の有無自体が意図しないバグである可能性。

---

## 4. 責務の分散: 計算・Three.js描画・DOM操作の混在(調査結果)

調査計画で懸念されていた「計算・Three.js描画・DOM操作が1ファイルに混在」は、game.ts に限らず
**ほぼすべての `*System`/`*Director`/`MapPlanner` モジュールに共通する問題**であることが分かった。
`this.hud.marker(...)` / `this.hud.hint(...)` / `this.hud.toast(...)` / `this.sfx.*(...)` の呼び出しが、
ベクトル演算・軌道計算のロジックと同じ関数内に直接書かれている箇所が広範囲に存在する:

- [src/game/markers.ts](src/game/markers.ts): `updateMarkers`/`updateNodeMarkers`/`updateBoardMarkers`/`updatePipOverlay` は
  スクリーン座標を計算した直後、その場で `this.hud.marker(...)` を呼んで DOM 側へ反映している(15箇所以上)。
  計算結果を返り値のデータ構造(マーカーの位置・シンボル・ラベル一覧)として返し、DOM への反映は呼び出し側
  (または Hud 自身)に委ねる形になっていない。
- [src/game/combat.ts](src/game/combat.ts): `fireGun`/`checkBulletHits`/`destroyShip` 等、弾道計算・命中判定と
  同じ関数内で `this.sfx.fire()`/`this.sfx.hit()`/`this.sfx.explosion()`/`this.hud.hint(...)` を直接呼んでいる。
- [src/game/stages.ts](src/game/stages.ts) / [src/game/environment.ts](src/game/environment.ts) / [src/game/mapview.ts](src/game/mapview.ts) / [src/game/planner.ts](src/game/planner.ts) にも同様の
  `hud.hint`/`hud.toast`/`hud.marker`/`sfx.*` 直接呼び出しがある。

この結果、各システムは Hud/Sfx への副作用呼び出しのためだけに `Hud`/`Sfx` をコンストラクタ注入されており、
Ctx にも「表示に必要な生データ」まで詰め込まれる誘因になっている(前項の `MarkersCtx` 肥大化はその典型例)。

調査計画にある「計算結果を一旦データ構造にまとめてから描画系に渡す」方向で改善できる見込みが高い。
例えば `MarkersSystem.updateMarkers` を「マーカー記述子(`{key, sym, x, y, visible, label, ...}[]`)を返す純関数」に
変え、DOM反映(`hud.marker` の呼び出し)は Hud 側または専用の適用関数にまとめれば、
`MarkersSystem` は `Hud` への依存自体を持たなくなり、`MarkersCtx` も「マーカー算出に必要な生データ」だけに
縮小できる。同様に `combat.ts` の SFX/HUD呼び出しも「発生イベント一覧」を返す形にできれば、
発音・トースト表示は呼び出し側(または専用のプレゼンテーション層)に委譲できる。

---

## 調査計画　私が改善の余地がある可能性が高い点。追加調査が必要

- simulateとpredictの重複度調査。

- ctx注入パターンの見直し。
ctx注入パターンはそもそも密結合を生む原因に見える。
まず、必要以上のctxを注入してしまっていないかを確認する。
ctxか微妙に重複し、微妙に異なるフィールドを持つ場合、そもそも責務の方が密結合になっていて、過剰にフィールドを要求しないようなより最適な分割が可能なのではないか。
それでもなおほとんどのctxに共通のフィールドはデータとしての関連性が高いためまとめて扱うべきではないか。

- 責務の分散
計算、Three.js描画、DOM操作、が一つのファイルに混在するのは責務の分割が不十分で、好ましくない。
計算結果を直ちに描画系に回すのではなく、計算結果を一旦データ構造にまとめてから描画系に渡すことができないか。また、そうすることで要求しているctxを減らすことができないか。

## 実装計画　実行することで「確実に」コードが改善される点。勝手に書き足さないでください

- simulate/predictなど、100行を超えるすべての長大関数から、サブルーチンを切り出して関数化する。例えば
```ts
    // 弾切れチェック(空撃ちクリックは押し直しごとに 1 回)
    const hasAmmo = this.roundsInMag > 0 || this.magsLeft > 0;
    if (rawWantFire && !hasAmmo && this.player.alive && !this.wasEmptyClick) {
      this.sfx.emptyClick();
      this.hud.hint('弾薬切れ — 軌道上の補給マガジン ▣ を回収せよ', 3000);
    }
    this.wasEmptyClick = rawWantFire && !hasAmmo;
```
は
```ts
    // 弾切れチェック
    this.checkPlayerAmmoEmpty(rawWantFire);
```
などとし、実装は別のメソッドに切り出すこと。コメントと空行で区切られた数行のブロックはすべて適切に関数化できるはず。

- この時点で重複実装、類似実装を適切に共通化する。randVec は `src/physics/vec3.ts` に、姿勢基底構築は `src/physics/attitude.ts` に、距離整形は `src/game/hud/utils.ts` などにまとめる。
  - simulateとpredictの重複部分については、サブステップ解像度と空気抵抗を加味するかなどを引数とする関数にまとめ、再利用する。
  - 完全に共通していなくても、単一責務について、類似の実装が複数あるべきでない。多少のバリエーションであれば引数で吸収する。

- 関数としてそもそもそのクラス・モジュールに存在すべきでないものは、適切なモジュールに移動する。
  - たとえば、物理演算に関連する事物がGameにあるべきでない。
  - プレイヤーの挙動はplayer.tsを新設し、playerクラスにまとめる。
  - ステージの初期設定、説明文などのデータはコード内に埋め込むのではなく、データベース化・定数化する。
  - その他、まとめるべき事象はどんどん新規モジュールを作成し、まとめる

- DOM操作を行う箇所は、DOM操作ユーティリティを作って共通化する？

- TS内のCSSをCSSファイルに切り出し
- innerHTMLなどの操作の共通化。（簡易的なDOM操作ユーティリティを作る）