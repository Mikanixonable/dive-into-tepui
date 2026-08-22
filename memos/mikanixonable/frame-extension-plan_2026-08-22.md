# 参照フレーム拡張計画 — 自転回転系・役割基準・改名

対象コミット: 3acc14a6

## 1. 目的

表示用の参照フレーム(座標系)で選べる中身を増やし、名前を実態に合わせる。

いま参照フレームは `{ center: 天体id, rotatingWith: 天体id | null }` の直積で、

- **回転は「公転」しか表現できない。** 自転に合わせて回す座標系が作れないため、地表の1点を
  画面上で静止させて見ることができない。
- **基準・回転とも「登録天体か、生存中の重力天体」しか指せない。** 船は重力天体ではないので、
  船を中心に据えた座標系・船の公転に合わせて回る座標系が作れない。
- **選ぶのは常に具体的な id** で、「いま操作している船」「いまのターゲット」という**役割**を
  指せない。操作対象を乗り換えたりターゲットを付け替えるたびに選び直しになる。

これを解いて、次を選べるようにする。

| ゾーン | 追加する選択肢 |
| --- | --- |
| カメラの回転追従 | 地球の自転 / 操作対象の船の公転 / ターゲットの公転 |
| 軌道フレームの基準 | 操作対象の船 / ターゲット |
| 軌道フレームの回転フレーム | 地球の自転 / 操作対象の船の公転 / ターゲットの公転 |

あわせて UI 見出し「基準天体」を「基準」へ改める — 船・基地・弾薬も選べるゾーンなので、
「天体」は既に嘘になっている。

## 2. 確定した前提

**A〜E すべて採用済み(ユーザー確定)。**

- 天体 id に `@` を含むものは無い(登録天体は小文字 ASCII、動的 id は `-` と `:` 区切り)。
  役割トークンの予約記号は `@` で確定。
- 自転回転系の基底は ẑ = 自転軸、x̂ = 本初子午線で、公転回転系(ẑ = 軌道面法線)と軸の割り当てを
  揃えた。逆行自転する天体は軸を反転せず、角速度の符号で表す。SPEC もこの規約に合わせてある。
- **本件と無関係な既存の失敗が1件ある。** `test:physics` の
  「ephemeris: celestialBodiesAt は SOLAR_SYSTEM の宣言順で、positionOf と整合する」は
  作業開始前の 3acc14a6 の時点で既に FAIL している。**本計画では直さない。**
  以降の検証では 1 件 FAIL を既知として扱い、それ以外が通ることを確認する。
- 実施済み: SPEC 更新 / `frame.ts` への型追加 / 見出しの改名。

- **(提案A・採用前提)「地球の自転」を「任意の登録天体の自転」に一般化する。** 自転モデルは
  `Ephemeris.poleAt` が全天体ぶん持っており、地球だけに絞る実装のほうがかえって分岐が増える。
  UI には「〈天体〉自転座標系」として、いまカメラがいる系の天体のうち自転モデルを持つものを並べる。
  地球低軌道なら「地球自転座標系」「月自転座標系」が出る。
- **(提案B・採用前提)「ターゲット」は航法ターゲット(`NavTarget`)を指す。** 戦闘ターゲットは
  `NavTarget` を正本として解決されるので、別に扱う必要がない。ターゲットは船とは限らず
  ラグランジュ点・基地も取りうるため、**「ターゲットの公転」は軌道が求まる対象のときだけ**有効。
- **(提案C・追加)役割の選択肢は、無効なとき出さない。** 「操作対象の船の公転」は、その船の
  軌道要素が求まりかつ離心率 < 1 のときだけ選択肢に出す。選択中に条件が崩れたら回転は慣性系へ
  落ち、選択表示も「解除」に戻る(選べてから拒否されない、という座標系パネル既定の規則に合わせる)。
- **(提案D・却下)「操作対象の船の自転(機体姿勢)にカメラを追従させる」は入れない。** 要件に無く、
  姿勢追従は座標系ではなくカメラモードの話で、混ぜると座標系パネルの意味が濁る。
- **(提案E・要判断)軌道情報パネルの `基準天体`(自動/地球/月/航法ターゲット)は改名しない。**
  こちらは座標系ではなく「軌道要素をどの重力源に対して計算するか」で、別概念。ただし
  「航法ターゲット」という選択肢を持つ点で本計画の役割トークンと重複しており、将来的には
  統合しうる。統合するかどうかは今回決めず、`DEVELOP/SPEC/ORBIT.md` の「未確定の案」へ記す。

## 3. 設計

### 3.1 回転の表現を判別可能 union にする

`ReferenceFrame.rotatingWith: OrbitingId | null` を次へ置き換える。

```ts
// src/physics/frame.ts
export type FrameRotationSource =
  | { readonly kind: 'revolution'; readonly id: FrameAnchorId }  // その天体/船の公転に合わせて回す
  | { readonly kind: 'spin'; readonly id: CelestialBodyId };     // その天体の自転に合わせて回す

export type ReferenceFrame = {
  readonly center: FrameAnchorId;
  readonly rotatingWith: FrameRotationSource | null;  // null = 慣性系
};
```

**参照同一性は死守する。** `trajectory-line.ts` / `orbit-line.ts` は `frame === lastFrame` で
再生成要否を判定しており、リテラルで組むと毎フレーム作り直しになる。`Ephemeris.frameOf` の
二段キャッシュは、第2段のキーに `rotatingWith` を文字列へ正規化したもの
(`null` → `''`、`revolution` → `id`、`spin` → `spin:${id}`)を使う。**戻り値の
`rotatingWith` オブジェクトもキャッシュ内で1個だけ作り、使い回す。**

文字列プレフィックス(`'spin:earth'` を id にそのまま入れる)案は、変更量は小さいが天体 id と
自転指定が同じ型になり取り違えが型で防げないため採らない — `frame.ts` は branded type で
この種の取り違えを潰す方針で書かれている。

### 3.2 役割トークンを基準・回転の両方で使えるようにする

```ts
// src/physics/frame.ts
export type FrameRole = 'activeShip' | 'navTarget';
export type FrameAnchorId = CelestialBodyId | `@${FrameRole}`;
```

予約 id は `@activeShip` / `@navTarget`。天体 id と衝突しないよう `@` で始める
(既存の天体 id に `@` を含むものが無いことを Step 1 で確認する)。

**物理層はゲーム層を知ってはいけない。** `Ephemeris.frameTransformAt` は現在
`celestialBodies: readonly CelestialBody[]` を受けて未登録 id を線形探索している。これを
解決役インターフェースへ一般化する。

```ts
// src/physics/frame.ts
export interface FrameAnchorSource {
  // 登録天体でない基準(生存中の重力天体・船・役割トークン)の ECI 状態。解決できなければ null。
  stateOf(id: FrameAnchorId, t: number): KinematicState | null;
  // その基準が公転している主天体。公転回転系を組めないなら null。
  attractorOf(id: FrameAnchorId, t: number): CelestialBodyId | null;
}
```

実装はゲーム層に置く(`src/game/frame-anchors.ts` を新設)。`EntityManager` /
`ActiveControllableController` / `NavTarget` / `strongestAttractor` を束ね、役割トークンと
船 id を解決する。既存の `CelestialBody[]` 探索もここへ移す。

**`attractorOf` を分けて持つ理由**: 船の公転回転系の基底は `x̂ = 主天体→船` で組む必要があり、
これは `frame.center` とは独立に決まる。いまの未登録天体パスは `frame.center` を暗黙の主天体に
していて、基準に地球・回転にターゲットの公転を選ぶと意味が壊れる。ここを直す。

### 3.3 自転回転系

`Ephemeris` に追加する。

```ts
// 天体 id の自転に固定した回転基準系(ẑ = 自転軸、x̂ = 本初子午線方向)。
// 自転モデルを持たない天体では null。
spinRotationAt(id: CelestialBodyId, t: number): FrameRotation | null
```

- 姿勢は `body-orientation.ts` の `spinOrientation(axis, spinAngle)` から組む。
  `axis` / `spinAngle` は既存の `poleAt(id, t)` が返す。
- 角速度 `omega` は `axis × 自転角速度`。自転角速度は `pole` 定義の `wRateDegPerDay` から
  `wRateDegPerDay * (π/180) / 86400` [rad/s]。同期回転天体(月)・カッシーニ則の天体も
  `poleAt` が同じ形で答えるので、角速度だけ各 pole モデルから取り出す口を
  `celestial-body.ts` 側に足す(`spinRateOf(def): number | null`)。
- **歳差ぶんの角速度は無視する。** 自転軸自体が動く速度は自転角速度の 10⁻⁷ 倍未満で、
  `omega` は速度変換にしか効かないため、表示上は差が出ない。この近似は
  `spinRotationAt` のコメントに残す。

### 3.4 UI

- `RotationZone.setNearby(members)` が組む選択肢を3種類に増やす。
  1. `[null, '解除']`(既存)
  2. 各 member の公転: `〈主星〉-〈天体〉回転座標系`(既存)
  3. 各 member の自転: `〈天体〉自転座標系`(新規。自転モデルを持つ天体だけ)
  4. `操作対象の船の公転` / `ターゲットの公転`(新規。有効なときだけ)
  4 の有効判定は `RotationZone` では行わず、呼び出し側(`frame-controls.ts`)が
  `FrameAnchorSource` に問うて可否を渡す — `RotationZone` は `Ephemeris` 以外を知らない。
- `AnchorZone` の見出しを `'基準'` にする(呼び出し2箇所の引数)。プルダウンの候補群の先頭に
  役割グループ(`操作対象の船` / `ターゲット`)を足す。**カメラ区画・軌道フレーム区画の両方に出す**
  — 要件は軌道フレームだけだが、カメラ側にだけ無いのは説明できない。
- サマリ行の `rotText` を新しい union に対応させる(`地球自転系` / `ターゲット公転系` など)。

### 3.5 セーブデータ

`map-camera.ts` の `serialize` と `save-data.ts` が `rotatingWith`(文字列 or null)と
`FocusTarget` を持つ。形が変わるので、**読み込み時に旧形式(文字列)を
`{ kind: 'revolution', id }` として受ける**変換を入れる。書き出しは新形式のみ。

## 4. 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/SPEC/CELESTIAL.md` §8 | 参照フレームの定義に「自転」と役割基準を追記 |
| `DEVELOP/SPEC/MAP.md` §3 | 座標系パネルの選択肢・見出し名・サマリ文言を改訂 |
| `DEVELOP/SPEC/ORBIT.md` 未確定の案 | 軌道情報パネルの基準天体と役割トークンの統合可否を記載 |
| `src/physics/frame.ts` | `FrameRole` / `FrameAnchorId` / `FrameRotationSource` / `FrameAnchorSource` を定義、`ReferenceFrame` を差し替え |
| `src/physics/celestial-body.ts` | `spinRateOf(def)` を追加 |
| `src/physics/ephemeris.ts` | `frameOf` のキャッシュキー正規化、`spinRotationAt` 追加、`frameTransformAt` / `frameBodyState` を `FrameAnchorSource` 経由へ |
| `src/game/frame-anchors.ts`(新規) | `FrameAnchorSource` の実装 |
| `src/game/camera/map-camera.ts` | `setCameraRotation` の引数型、`frameTransformAt` の呼び出し、`serialize` |
| `src/game/save-data.ts` | 旧形式の読み替え |
| `src/game/hud/rotation-zone.ts` | 選択肢3種の生成 |
| `src/game/hud/anchor-zone.ts` | 役割グループの追加 |
| `src/game/hud/frame-controls.ts` | 役割の有効判定、両パネルへの受け渡し |
| `src/game/hud/camera-frame-panel.ts` | 見出し `'基準'`、`rotText`、`setSelected` |
| `src/game/hud/trajectory-frame-panel.ts` | 同上 |
| `src/game/orbit-line.ts` / `trajectory-line.ts` / `nav-target.ts` | `frameTransformAt` の第3引数差し替え |
| `src/game/display-window-manager.ts` | 型の追従のみ |

## 5. 達成目標

1. カメラ・軌道フレームの回転ゾーンに「地球自転座標系」が出て、選ぶと地表の1点が画面上で
   静止する(自転周期ぶん見ても流れない)。
2. 操作対象の船が地球周回楕円軌道にあるとき、両回転ゾーンに「操作対象の船の公転」が出る。
   選ぶと船が画面上で常に同じ方向に見える。
3. 船が周回軌道にない(軌道要素が求まらない、または e ≥ 1)とき、その選択肢は**出ない**。
   選択中に条件が崩れたら慣性系へ落ち、表示も「解除」になる。
4. ターゲットについて 2・3 と同じことが成り立つ。ターゲットが基地・ラグランジュ点のときも
   軌道が求まるなら有効。
5. 軌道フレームの基準プルダウンに「操作対象の船」「ターゲット」が出て、選ぶとその対象が
   計画折れ線の中心に来る。**操作対象を乗り換えても選択が保たれ**、中心が新しい船へ移る。
6. カメラ・軌道フレーム両パネルのゾーン見出しが「基準」になっている。
   `grep -rn '基準天体' src/game/hud/` の結果が `orbit-info.ts`(別概念)だけになる。
7. 旧セーブデータを読み込んで、回転系の選択が以前と同じ状態で復元される。
8. `npm run typecheck` と `npm run test:physics` が通る。
9. 回転系を切り替えても `trajectory-line` の再生成が毎フレーム起きない
   (`frameOf` が同じ選択に同じ参照を返す)。

## 6. 手順

各ステップは独立に commit できる。上から順に着手する。

1. **`ReferenceFrame.rotatingWith` を union へ差し替える。** `frameOf` のキャッシュキー正規化と
   `frameTransformAt` の分岐(`null` / `revolution` / `spin`)。呼び出し側は最小の追従だけ。
   UI にはまだ自転の選択肢を出さない。
   完了条件: typecheck・test:physics が通り、既存の回転系の見た目が変わらない。
2. **`FrameAnchorSource` を導入する。** `src/game/frame-anchors.ts` を新設し、
   `frameTransformAt` の第3引数を `CelestialBody[]` から差し替える。役割トークンの解決と
   `attractorOf` による公転回転系の主天体決定をここで実装する。
   完了条件: 船 id を基準に選んだとき、いままで ECI 原点へ落ちていた座標系が正しく解決する。
3. **セーブデータの読み替えを入れる。** 旧形式(文字列)→ `revolution`。
   完了条件: 手元の既存スナップショットが読める。
4. **UI に選択肢を足す。** `RotationZone` の3種生成、`AnchorZone` の役割グループ、
   `frame-controls.ts` の有効判定、両パネルの `rotText` / `setSelected`。
   着手前に `/ui-design` を通す。
   完了条件: 達成目標 1〜5 を確認。
5. **仕上げ。** `/comment-cleanup` を新規・改変箇所へ通し、`npm run ci`。

## 7. 見積り

**追加される毎フレーム負荷**(自転回転系を選んだ場合):
`poleAt` 1回(IAU 一次式 = 三角関数 4 回)+ `spinOrientation` 1回(クォータニオン合成 1 回)
≒ 0.5 µs/frame。座標系は**カメラ用と軌道フレーム用の2つ**しか同時に評価されないので
合計 1 µs/frame 未満、60 fps の 16.7 ms に対して 0.006 %。無視できる。

**役割トークンの解決**: `activeControllableEntity` の getter 1 回 + `NavTarget.resolveState` 1 回
= どちらも既存の HUD が毎フレーム呼んでいるものと同じ経路で、追加は 2 回/frame。無視できる。

**`attractorOf` の `strongestAttractor`**: 登録天体数 N に対し O(N)。既定レジストリで N ≈ 20、
1 回あたり ≒ 2 µs。フレームあたり最大 2 回で 4 µs。許容範囲だが、**同一フレーム内で
カメラ用と軌道フレーム用が同じ id を問うことが多い**ので、`FrameAnchorSource` 側で
「同じ (id, t) なら直前の結果を返す」1 要素キャッシュを持たせる。

**選択肢の再生成**: `RotationZone.setNearby` は毎 sync で DOM を組み直している。選択肢が
最大 2 個 → 最大 (2N + 2) 個へ増える。N ≈ 20 なら 42 要素/sync。sync は毎フレームではなく
パネル同期時のみなので許容するが、**手順4で「選択肢の並びが前回と同じなら組み直さない」
比較を入れる**(既存の `setItems` が無条件に作り直しているため、ここで初めて効いてくる)。

## 8. リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `frameOf` が `rotatingWith` オブジェクトを毎回新規に作る | `frame === lastFrame` が常に偽になり、軌道線・計画折れ線が毎フレーム全再生成される。見た目は正しいので気付けない | `orbit-line.ts:121` `needsRegen`、`trajectory-line.ts:122`。負荷計測ウィンドウの軌道線再生成回数で確認する |
| 自転回転系の `omega` を 0 のまま放置する | 位置は正しいのに速度だけ狂う。軌道線(位置)では見えず、`toFrameState` を通る速度表示・計画バーンの $\Delta v$ だけが静かにずれる | `frame.ts:toFrameState`。地表固定点の座標系相対速度が 0 にならないことで確認 |
| 船の公転回転系の主天体に `frame.center` を使ってしまう | 基準に地球・回転にターゲットの公転を選んだとき、ターゲットが地球周回でも基底が別物になり、静止するはずの対象が回る | `ephemeris.frameTransformAt` の未登録天体パス。達成目標 4 の確認で露見 |
| 役割トークンが解決できないフレーム(乗り換え直後・ターゲット消滅)で ECI 原点へ落ちる | カメラが一瞬地球中心へ飛ぶ。1フレームなので目視では「ちらつき」にしか見えない | `frameBodyState` の fallback。**解決できないフレームは直前の解決結果を保つ**方針にし、`FrameAnchorSource` 側で実装する(MAP.md §2 の「2フレーム連続で解決できないときだけ解除」と同じ規則に揃える) |
| `@` 予約記号が既存の天体 id と衝突する | 役割トークンが天体として解決され、無言で別の座標系になる | 確認済み(`@` を含む天体 id は無い)。動的 id を増やすときに再確認する |
| 旧セーブの `rotatingWith` を union として読んで `undefined` になる | 回転系の選択だけが静かに慣性系へ戻る。エラーは出ない | `save-data.ts`。達成目標 7 |
| `spinRateOf` が同期回転天体(月)で null を返す | 月自転座標系だけ選択肢に出ない。他は動くので気付きにくい | `RotationZone` の選択肢一覧。月が出るかを目視 |
| `RotationZone` の選択肢が増えてクイックボタン列が画面幅を超える | 横スクロールが出るか、ボタンが潰れる | 座標系パネル。`/ui-design` を手順4の着手前に通す |
| 逆行自転天体(金星・天王星)で `spinOrientation` の軸向きが自転角運動量と逆になる | その天体の自転座標系だけ逆回りに見える | CELESTIAL.md §3 が「極を扱う場面では自転角運動量の向きを採る」と定めている。`spinRotationAt` でこの規則を適用したか、実施済み(逆行自転は軸を反転せず角速度の符号で表す規約に確定) |
