# マップカメラのフォーカス振動 修正計画

対象コミット: `a39d0d55`(ブランチ `workspace3`)

## 目的

タイムワープ倍率が高いとき、マップビューでフォーカスした船が注視点から離れて画面上で振動する。
原因は `MapCamera.resolveFocus`(`src/game/camera/map-camera.ts:395-433`)が機体の位置を
`MapPickables.pickables` という候補配列経由で読んでおり、その配列は **前フレームの
`mapPickables.refresh` が書いたもの** だからである(`src/game/game.ts:328` のカメラ更新が
`game.ts:336` の `refresh` より前に呼ばれる)。低軌道・高倍率ワープでは1ステップの位置変化が
100km 超になり、フォーカスの注視点だけがその分だけ遅れて船体メッシュから外れ、位相とともに
振動して見える。

天体・役割トークン(`@activeShip` 等)は既に `ephemeris.positionOf` / `frameAnchors.stateOf` で
その場で直接解決しており、遅延の影響を受けない。機体だけが候補配列という「もう1フレーム古い
スナップショット」を経由しているのが根本原因である。

修正後に期待される状態:

1. フォーカス中の機体(自艦・敵・基地・弾薬)の注視点は、候補配列を経由せずその場で解決され、
   前フレームの位置を読むことがなくなる。
2. `update()` と `sync()` が同一フレーム内で読む表示窓(`DisplayWindow`)が、同一の
   `resolve()` 呼び出し結果(同一インスタンス)に揃う。冗長な再計算をしない。
3. `mapPickables.refresh` とカメラ更新の順序制約が、フォーカス解決に関する限り不要になったことを
   コード上のコメントで明示する(無理に入れ替えはしない)。

## 変更が必要な箇所

- `src/game/camera/focus-target.ts`
  - `resolveFocus` の判定ロジックを、`MapCamera` から独立した純粋関数として追加する
    (詳細は手順1)。
- `src/game/camera/map-camera.ts`
  - `resolveFocus`(395-433行)の本体を `focus-target.ts` の新関数へ委譲する形に書き換える。
  - `update()`(407行台、`candidates` を受け取っている引数)のシグネチャ・呼び出しは変えない
    (候補配列は apsis/relnode/eqnode/ラグランジュ点のフォールバックに引き続き要る)。
- `src/game/display-window-manager.ts`
  - 変更なし(`resolve()` のシグネチャ・`_current` の意味は変えない)。
- `src/game/game.ts`
  - `advanceSimulation` 内の `displayWindowManager.resolve(...)` 呼び出し(387行、戻り値を
    捨てている箇所)を削除する。
  - `update()` の `displayWindowManager.resolve(...)` 呼び出し(304行)はそのまま残し、これを
    1フレーム内で唯一の `resolve()` 呼び出しにする。
  - `sync()` の `displayWindowManager.resolve(...)` 呼び出し(464行)を
    `this.displayWindowManager.current` の読み出しへ置き換える。
  - `game.ts:333-334` の順序制約コメント(「カメラ更新の後に置く: 候補集合と表示可否は
    カメラ位置から出るので…」)を、フォーカス解決には効かなくなった旨へ書き直す(手順3)。
- `tests/physics/focus-target.test.ts`(新規)
  - 新しい純粋関数の単体テスト。`tsconfig.test.json` の `include` へ
    `src/game/camera/focus-target.ts` を追加する(`tests/physics/**/*.ts` は既に入っている)。
    **`src/game/map-pickable.ts` は絶対に include へ入れない。**
- `tests/physics/index.ts`
  - 新テストの `register` を import・呼び出しに追加する。

## resolveFocus の書き換え設計

### 新しい純粋関数(`focus-target.ts` に追加)

```ts
// 注視点の候補。MapPickable はこの形を構造的に満たすので、呼び出し側はそのまま渡せる。
// **MapPickable 型そのものを受け取ってはいけない** — map-pickable.ts は camera-system.ts を
// 型 import しており、それが three/webgpu を引き込む。tsconfig.test.json の include へ
// map-pickable.ts が入ると型検査が DOM 定義を要求して 887 件のエラーになる(実測)。
export interface FocusCandidate {
  readonly id: string;
  readonly pos: Vec3;
}

export interface FocusResolveState {
  readonly missingFocusFrames: number;
  readonly lastResolvedFocus: Vec3;
}

export interface FocusResolveResult {
  readonly pos: Vec3;
  readonly missingFocusFrames: number;
  readonly lastResolvedFocus: Vec3;
  // true なら焦点そのものを origin へ差し戻す(2フレーム連続の解決失敗)。
  readonly fallToOrigin: boolean;
}

// 注視点を解決する。候補配列(candidates)は「機体でも天体でも役割トークンでもない」種別
// (apsis/relnode/eqnode マーカー、ラグランジュ点)のためだけのフォールバックとして残る。
export function resolveFocusTarget(
  focus: FocusTarget,
  candidates: readonly FocusCandidate[],
  displayTime: number,
  frameAnchors: FrameAnchorSource,
  ephemeris: Ephemeris,
  state: FocusResolveState,
): FocusResolveResult
```

`ephemeris` は `Ephemeris` をそのまま受ける。`focus-target.ts` は既に
`import type { Ephemeris } from '../../physics/ephemeris'` を持っており、physics 層なので
テスト側の型検査を壊さない。最小インターフェースを別に切ると、構造的部分一致で実物と
食い違ったまま typecheck を通す余地を作るだけで、得るものがない。

判定順序(現行の395-433行から、機体分岐だけを差し替える):

1. `focus.kind === 'point'` → 現行どおり `frameTransformAt` で焼き込み位置を解決。
2. `focus.id === ephemeris.originId` → 現行どおり原点固定。
3. `focus.id in ephemeris.registry` → 現行どおり `ephemeris.positionOf` で天体を解決。
4. **(変更点)** 上記のどれでもなければ、`frameAnchors.stateOf(focus.id, displayTime)` を
   直接呼ぶ。`FrameAnchors.stateOf`(`src/game/frame-anchors.ts:41-45`)は内部で
   「役割トークン → `targets.entityState`(生存中の全エンティティ、自艦・敵・基地・弾薬を
   含む)→ 天体」の順に自分で解決するので、役割トークン分岐(現行413-419行)と機体分岐を
   1本にまとめられる。`state !== null` ならそれを注視点にして `missingFocusFrames` を 0 に戻す。
5. 4 が `null`(=機体でも役割トークンでもない — apsis/relnode/eqnode マーカー、ラグランジュ点)
   なら、現行どおり `candidates.find((c) => c.id === focus.id)` にフォールバックする。
6. 4・5 とも解決できなければ `missingFocusFrames` を進め、2フレーム連続なら
   `fallToOrigin: true` を返す(呼び出し側が `setFocusTarget({ kind: 'object', id: originId })`
   する)。

`MapCamera.resolveFocus` はこの関数を呼び、返ってきた `missingFocusFrames` /
`lastResolvedFocus` を自分のフィールドへ書き戻すだけの薄いラッパーになる
(`fallToOrigin` が true なら `setFocusTarget` を呼ぶ)。

### 対象種別ごとの解決経路(変更後)

| 種別 | 解決経路 | 変更前との違い |
| --- | --- | --- |
| 天体 | 手順3(`ephemeris.positionOf`) | 変更なし |
| 役割トークン(`@activeShip` 等) | 手順4(`frameAnchors.stateOf` の内部で役割解決) | 変更なし(経路の呼び出し位置が統合されるだけ) |
| 自艦・敵・基地・弾薬(`kind: 'player'\|'ship'\|'base'\|'ammo'`) | 手順4(`frameAnchors.stateOf` → `targets.entityState` → `entities.all().find(...).displayState(t, ephemeris)`) | **変更点。今まで候補配列(1フレーム遅延)経由だったのが、`displayState(displayTime)` をその場で直接呼ぶ経路になる** |
| apsis/relnode/eqnode マーカー | 手順5(候補配列) | 変更なし(この経路にしか実体が無い) |
| ラグランジュ点(`kind: 'body'` だが `ephemeris.registry` には無い id) | 手順5(候補配列) | 変更なし。`frameRoleOf` が `null` を返し `entityState` も見つけられないため手順4は `null` を返し、手順5へ落ちる |

`missingFocusFrames` の猶予は関数のシグネチャに `state`/戻り値として明示的に持たせているので、
機体・役割トークン・候補配列のどの経路で解決/失敗しても同じカウンタを共有し続ける
(現行の433行までの挙動をそのまま保つ)。

## 表示窓の一本化設計

現状 `displayWindowManager.resolve()` は1フレームに3回呼ばれるが、同一の `simTime` /
`activeControllableEntity` を渡しているため常に同値を返す(検証済み)。これを1回にする。

- `advanceSimulation()`(`game.ts:387`)の `resolve()` 呼び出しは **削除**する。この呼び出しは
  戻り値を使っておらず、`_current` を書き換える副作用だけを期待していたが、その副作用は
  同じ `update()` 呼び出しの中で直後に走る 304行目の `resolve()` が肩代わりする
  (advanceSimulation → 304行目の resolve、の順序は変わらない)。
- `update()` の304行目の `resolve()` はそのまま残す。これが1フレームで唯一の `resolve()` 呼び出しになる。
- `sync()`(464行目)は `resolve()` を呼ばず `this.displayWindowManager.current` を読む。
  `sync()` は `update()` と同じ animate() 呼び出し内で、`update()` の後に同期的に呼ばれる
  (`src/main.ts:64,78`)。JS はシングルスレッドで、DOM イベント(スライダー操作等)は
  `animate()` の実行中には割り込まないため、`update()` が確定させた `_current` が `sync()` の
  時点でも変わっていないことが保証される。

### `_current` を読む既存箇所への影響

`grep` で洗い出した `displayWindowManager.current` の読者は2箇所のみ:

- `game.ts:354`(`advanceSimulation` の先頭、`entities.requestHistoryDuration(...)`)。
  コメントに明記されている通り「表示窓は前フレームの確定値でよい」という設計。
  呼び出し順は「advanceSimulation の先頭(354行、_current 読み出し)→ advanceSimulation の
  末尾(387行、削除する resolve 呼び出し)→ update() の304行目(唯一の resolve 呼び出し)」で
  あり、354行目は変更前後を通じて常に **前フレームの304行目が確定させた値** を読む。
  387行目の削除はこの読者の入力を変えない。
- `game.ts:576`(`perfCounts()` の `displayDurationSec`)。デバッグ用の任意タイミング読み出しで、
  常に「直近の `resolve()` 確定値」を読めればよい。304行目が1フレームに1度確実に更新するので
  問題ない。

他に `displayWindowManager` を読むファイルは無い(`game.ts` 以外に import している箇所なし)。
`sync()` 内部で使う `displayWindowManager.sync(player)`(527行)は元々 `this._current` を
直接読んでいるメソッドで、`resolve()` の呼び出し回数とは無関係(変更不要)。

## 順序制約の再検討(手順3)

`game.ts:333-334` の現行コメント:

> カメラ更新の後に置く: 候補集合と表示可否はカメラ位置から出るので、先に組むと
> このフレームの sync が1フレーム古いカメラ位置基準の判定を読むことになる。

これは `mapPickables.refresh` がカメラ位置(`cameraSystem.activeCameraPos`)を読む2箇所
(`map-pickables.ts:98` の `nearbyTracker.membersAt`、`map-pickables.ts:184` の
`isOccluded`)と `focusMarkers.update` に対する制約であり、正しく残る制約である。手順1の変更は
「カメラがフォーカス解決のために候補配列を読む」逆方向の依存を切るだけで、この順方向の依存
(refresh がカメラ位置を読む)には触れない。

よってコメントを次のように書き直す(意味を変えず、フォーカス解決には効かないことを明示する):

```
// カメラ更新の後に置く: mapPickables.refresh が読む近傍系抽出・遮蔽判定・可視マーカー更新は
// cameraSystem.activeCameraPos を使うので、先に組むとこのフレームの sync が1フレーム古い
// カメラ位置基準の判定を読むことになる。フォーカス解決(候補配列を機体の位置として読むこと)
// はこの順序に依存しない — resolveFocusTarget が機体・役割トークンを frameAnchors.stateOf
// で直接解決するため、mapPickables.refresh を先に呼んでも遅延は生じない。
```

**この計画では順序の入れ替え自体は行わない。** 制約はカメラ位置→refresh の一方向で実在し続けるため、
入れ替える理由がない。

## 達成目標

1. `MapCamera.resolveFocus` の機体分岐(自艦・敵・基地・弾薬)が `MapPickables.pickables` を
   参照しなくなる — `map-camera.ts` から `mapPickables` 型・候補配列への機体 id 一致を目的に
   した参照が消え、`candidates.find` は apsis/relnode/eqnode/ラグランジュ点の id にしか
   ヒットしなくなる(コードレビューで確認)。
2. `tests/physics/focus-target.test.ts` に「候補配列に古い位置しか無くても、
   `frameAnchors.stateOf` が新しい位置を返せばそちらを注視点として返す」ケースが存在し、
   通る。**このテストは、修正前のコード(候補配列を先に見る順序)では落ちなければならない** —
   落ちないならバグを当てていない。着手時に一度確認する。
3. `npm run test:physics` の FAIL が
   「ephemeris: celestialBodiesAt は SOLAR_SYSTEM の宣言順で、positionOf と整合する」の
   **1件だけ**になる。これは本計画の着手前から存在する既知の失敗で、本計画では直さない。
   「green になる」を完了条件にすると永久に判定できない。
4. マップビューでワープ倍率を上げても、フォーカス中の機体の注視点と機体メッシュの位置が
   一致する。判定は次の等式で行う: 同一フレームにおいて
   `resolveFocusTarget(...).pos` が `entity.displayState(displayTime, ephemeris).r` と一致する
   (単体テストで当てる)。実機では倍率 1024 でフォーカス対象が画面中心に静止する。
5. `displayWindowManager.resolve()` の呼び出し箇所が `src/game/game.ts` 内に1箇所だけになる
   (`grep -n "displayWindowManager.resolve" src/game/game.ts` の結果が1行)。
6. `npm run typecheck` が通る。
7. `game.ts:333-334` 相当のコメントが、フォーカス解決とは無関係であることに触れている
   (レビューで確認)。

## 手順

### ステップ1: `resolveFocusTarget` を `focus-target.ts` へ抽出し、単体テストを追加する

- `src/game/camera/focus-target.ts` に `resolveFocusTarget` 純粋関数を追加(設計は上記)。
- `src/game/camera/map-camera.ts` の `resolveFocus`(395-433行)を、この関数へ委譲する薄い
  ラッパーへ書き換える。`missingFocusFrames` / `lastResolvedFocus` フィールドの読み書き、
  解決失敗時の `setFocusTarget` 呼び出しはラッパー側に残す。
- `tsconfig.test.json` の `include` に `src/game/camera/focus-target.ts` を追加。
- `tests/physics/focus-target.test.ts` を新規作成。最低限含めるケース:
  - 天体 id → `ephemeris.positionOf` の戻り値を返す。
  - 役割トークン → `frameAnchors.stateOf` の戻り値を返す。
  - 機体 id(候補配列に古い位置のダミーを1件仕込む)→ **候補配列の値ではなく**
    `frameAnchors.stateOf` の返す値を返す(振動再現の回帰テスト本体)。
  - 機体でも天体でも役割トークンでもない id(候補配列にのみ存在)→ 候補配列の位置を返す
    (ラグランジュ点・apsis/relnode/eqnode の回帰)。
  - 2フレーム連続で全経路が `null` → `fallToOrigin: true`。
  - 1フレームだけ解決失敗 → `lastResolvedFocus` を保つ(`fallToOrigin: false`)。
- `tests/physics/index.ts` に `register` を追加。
- 完了条件: `npm run test:physics` と `npm run typecheck` が green。

### ステップ2: 表示窓の `resolve()` 呼び出しを1本化する

- `game.ts` の `advanceSimulation()` 末尾(387行)の `this.displayWindowManager.resolve(...)`
  呼び出しを削除する。
- `game.ts` の `sync()`(464行)の `const displayWindow = this.displayWindowManager.resolve(...)`
  を `const displayWindow = this.displayWindowManager.current;` へ置き換える。
- `advanceSimulation` 末尾のコメント(「積分後の状態でこのフレームの表示窓を確定させ、
  以降の消費者へ共有する。」)を削除する(その役割は304行目の呼び出しに一本化されたため)。
- 完了条件: `npm run typecheck` が green。`grep -c "displayWindowManager.resolve" src/game/game.ts`
  が `1` を返す。

### ステップ3: 順序制約コメントを書き直す

- `game.ts:333-334` のコメントを上記の書き直し文へ差し替える。
- 完了条件: コメントのみの変更、`npm run typecheck` が green。

## 見積り

工数の時間見積りは導出できないので置かない。代わりに**変更の大きさ**を数える。

- ステップ1: `resolveFocus` の本体は `map-camera.ts:395-433` の 39 行。これを純粋関数へ移し、
  機体分岐(現行 421-425 行の 5 行)を `frameAnchors.stateOf` 呼び出しへ差し替える。
  ラッパー側に残るのはフィールドの読み書きと `setFocusTarget` で 10 行前後。
  新規テストは 6 ケース(達成目標2の1本 + 天体・役割・候補配列フォールバック・
  2フレーム失敗・1フレーム失敗)。**移動 39 行 + 新規 15 行 + テスト 6 ケース。**
- ステップ2: 削除1箇所(`game.ts:387` の呼び出しとその直前コメント2行)、
  置換1箇所(`game.ts:464`)。**差分 5 行以内。**
- ステップ3: コメント 2 行 → 5 行の書き換え。**差分 5 行。**

検証の実行回数: `npm run typecheck` が各ステップ1回(計3回)、`npm run test:physics` が
ステップ1で修正前・修正後の2回とステップ2で1回(計3回)。

## リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| `entities.all()` に基地・弾薬が含まれていない、または `alive` フィルタの意味が候補配列側と違う | 基地・弾薬をフォーカスしたとき `frameAnchors.stateOf` が `null` を返し続け、候補配列にフォールバックして今まで通り遅延が残る(無言で直らない) | `resolveFocusTarget` の単体テストで基地・弾薬 id を明示的にケース化していないと気付かない。実機では「フォーカスしても直らない」としてしか現れない |
| ラグランジュ点の id が偶然 `frameRoleOf` にマッチしてしまう命名(将来 id 命名規則が変わった場合) | ラグランジュ点フォーカスが役割トークン扱いされ `frameAnchors.stateOf` が `null` を返し、候補配列へ正しくフォールバックはするが `missingFocusFrames` の増減パターンが変わりうる | 通常の使用では気付きにくい。ラグランジュ点を2フレーム以上連続でフォーカスし続ける手動確認でしか出ない |
| `advanceSimulation` 末尾の `resolve()` 削除により、`_current` の更新タイミングが1呼び出し分だけ遅れる副作用に依存したコードが他にある | 見つかっていない依存があれば、削除後にその消費者だけが古い値を読み続ける(型エラーにならず無言で壊れる) | `grep -rn "displayWindowManager"` は本計画作成時点で `game.ts` 以外に無いことを確認済みだが、今後追加された参照は typecheck では検知できない |
| `sync()` が `resolve()` を呼ばなくなることで、`update()` と `sync()` の間に(将来)非同期処理や別スレッドの介入が入った場合に古い `_current` を読む | 現時点では JS シングルスレッド・同一 `animate()` 呼び出し内のため安全だが、将来 `sync()` が `requestAnimationFrame` を跨ぐ呼び出しに変わると同じ保証が崩れる | 将来のリファクタリングでしか露見しない。コード上のコメントで前提(同一 animate() 呼び出し内であること)を明記しておく必要がある |
| 純粋関数の候補配列の型に `MapPickable` を使ってしまう | `map-pickable.ts` が `camera-system.ts` を型 import し、それが `three/webgpu` を引き込むため、`tsconfig.test.json` の型検査が DOM 定義を要求して壊れる。**実測で 887 件のエラー** | `npm run test:physics`(`tsc -p tsconfig.test.json`)。`npm run typecheck` は本体の tsconfig を使うので**通ってしまい、気付けない** |
| ステップ1のテストを、修正後のコードだけで書いて通して満足する | 候補配列と `frameAnchors.stateOf` が同じ位置を返すスタブを書くと、順序をどちらにしても通る。バグを当てないテストが残り、同じ退行を将来素通りさせる | 着手時に修正前のコードで落ちることを確認しないと、どこにも現れない |

## 未確定の案(戦闘ビュー)

戦闘ビューの追従カメラ(`src/game/camera/chase-camera.ts:121`)は `target.state.r`(現在状態)を
直接読み、マップと同種の「候補配列経由の1フレーム遅延」問題を持たない。マップ以外では
`forceCurrent` により `displayTime === simTime` に固定される(`view-manager.ts:203`、
`display-window-manager.ts:184`)ため、現状ずれは生じない。ただし戦闘ビューでも将来
`forceCurrent` を外して未来表示を許すような変更があれば、`chase-camera.ts` 側が
`displayState(displayTime)` ではなく `state.r`(現在時刻)を読んでいる点が新たな不整合の
種になりうる。今回の計画には含めない。
