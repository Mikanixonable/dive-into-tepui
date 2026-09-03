# 論点23 — カメラの回転追従の再編

## 目的

「視点の向きを何に固定するか」(慣性系・公転・自転・姿勢)を扱う実装が6モジュールに散っていて、
次の3つが同時に起きている。

1. **選択の正本が2箇所に割れている。** 姿勢追従かどうかは `CameraOrientation.following`(bool)、
   公転・自転かどうかは `FocusCamera._cameraFrame.rotatingWith` にあり、`FocusCamera.rotationFollow`
   の getter が毎回この2つを合成して1つの型に戻している。同じ合成式が `serialize()` にも
   もう一度書かれている。
2. **表示名の実装が重複し、一部は利用者から見える欠陥になっている。**
   同じ書式の文字列を2箇所が別々に組んでおり、片方だけが機体の主語を落とし、
   要約行は未登録 id をそのまま画面へ出す(下の「症状」)。
3. **極軸まわりのオイラー往復が非可逆で、「真上」を押すと画面が上下反転する。**(実測済。下記)

再編後に期待する状態:

- 回転追従の選択は `FocusCamera` の1フィールドが正本で、合成式はどこにも無い。
- 「何に追従するか」という値(型・照合キー・セーブ変換・選択肢の導出・表示名)が1モジュールに
  集まり、HUD はカメラの実装を import せずにその値だけを扱える。
- 同じ状態を指す日本語が1箇所でだけ組まれる。
- 極軸と視線が一致しても向きが跳ばない。

---

## 症状 — 実測して分かったこと

`memos/hedalu244/refactor_modules.md` の論点23 が挙げた表は、一部が現状と合っていない。
**着手前に前提を置き換える。**

### 論点23 の記述のうち、誤っているもの

論点23 は「公転と自転が要約行では同じ『回転系』に潰れる」と書いているが、
`src/game/hud/frame/frame-labels.ts:16` は自転に対して `〈天体名〉自転系` を返しており、
要約行でも公転と自転は区別されている。**この行は症状ではない。**

### 実在する食い違い(すべてコードで確認)

| # | 症状 | 場所 |
| --- | --- | --- |
| S1 | **同じ文字列式が2箇所にある。** `〈主星〉-〈天体〉回転座標系` と `〈天体〉自転座標系` を、軌道フレーム区画とカメラ区画が別々に組んでいる。`CelestialSystem.nameOf(id)` は登録天体では `find(id).name` と同値なので、式まで完全に一致する | `hud/frame/rotation-zone.ts:51,58`(軌道側)と `:114,117`(カメラ側) |
| S2 | **カメラ区画だけ主語が消える。** 機体・役割を追従対象にすると、ボタンのラベルが `公転` `自転` の2文字だけになる。軌道フレーム区画の同じ選択は `操作対象の船の公転` と出る | `hud/frame/rotation-zone.ts:113` と `:64` |
| S3 | **要約行が機体を生 id で出す。** `rotationSourceLabel` は `nameOf(id)` を使い、未登録 id はそのまま返る。マップビューで敵艦にフォーカスして公転追従を選ぶと `enemy-7回転系` と表示される | `hud/frame/frame-labels.ts:18` → `celestial-system.ts:210` |
| S4 | **姿勢追従の語が5通りある。** `姿勢追従` / `視点追従` / `視点のRCS追従` / `視点RCS追従` / `視点の姿勢追従`。うち「RCS追従」は姿勢追従を指しておらず、名前として誤り | `frame-labels.ts:25`, `rotation-zone.ts:111`, `panels/vessel-panel.ts:117,118`, `hud/hud-root.ts:199`, `camera/camera-system.ts:296` |
| S5 | **「id → 表示名」が3つの網羅度で3箇所に書かれている。** 役割→被選択物→エンティティ→天体 と辿るもの1つと、役割→天体だけのもの2つ。S3 はこの差が表に出たもの | `hud/view-badge.ts:127-137`(網羅的)、`hud/frame/camera-frame-panel.ts:108-111`、`hud/frame/trajectory-frame-panel.ts:60-62` |

### S6 — 「真上」でオイラー往復が 180° 反転する(実測)

`src/math/polar-euler.ts` の `eulerFromRotation` / `rotationFromEuler` は、視線が極軸と一致すると
往復が恒等でなくなる。極軸を `(0,0,1)` に取り、視線 = 極軸のまま up を8方位で回して測った値:

```
up 方位 0°  : up ずれ 179.943°   forward ずれ 0.057°
up 方位 45° : up ずれ 179.959°   forward ずれ 0.057°
up 方位 90° : up ずれ 180.000°   forward ずれ 0.057°
up 方位 135°: up ずれ 179.959°   forward ずれ 0.057°
(180°/225°/270°/315° も同様。真下 = 視線が -極軸 のときは 0.057° 以下で反転しない)
```

forward の 0.057° は `POLAR_PITCH_LIMIT`(π/2 − 1e-3)によるクランプそのもので、これは意図された
挙動。問題は **up が 180° 反転すること**。

原因: `eulerFromRotation` は roll の基準に `projectOntoPlane(polar, offset)` を使い、offset が polar と
一致するとこれが 0 になってフォールバック `projectOntoPlane(basis.reference, offset)` へ落ちる。
`rotationFromEuler` 側はクランプ後の offset(極から 1e-3 rad)で同じ式を評価するのでフォールバックへ
落ちず、roll の基準が 180° 食い違う。

再現経路: `FocusCamera.setReferenceView('above')` は offset を基準面法線ちょうどに置く
(`focus-camera.ts:387`)。`eulerPolarAxis()` が返す極軸(`referenceUpAxisEci()`)と
`framePlaneNormal(referencePlane)` は、**カメラが地球近傍(1e9 m 以内)で基準面が「赤道面」(既定)なら
どちらも地球の自転軸**、**カメラが遠方で基準面が「黄道面」ならどちらも黄道極**になり、必ず一致する。
そのまま次フレームの `update()` が `usesEuler`(既定はオイラー操作)で `restoreFromEuler()` を通り、
往復が起きる。

**「オイラー角を正データにしているのでは」という疑いへの回答:** 正データはクォータニオン
(`CameraOrientation.rotation`)で、セーブされるのもこちら。オイラー角は
`mode === 'euler'` かつ姿勢追従していないときだけ1フレームの作業表現として使われる
(`restoreFromEuler` → `turn` → `rebase`)。自由度が落ちる意味でのジンバルロックは
`POLAR_PITCH_LIMIT` のクランプで避けているが、**そのクランプが往復を非可逆にしていて、
症状はロックではなく反転として出る。** 直感は当たっている。

---

## 決めたこと

ユーザーが覆せる。覆したときに変わる手順を各項に書く。

### D1. ボタンの正式名と要約行の短縮形は、2系統のまま残す(承認済・SPEC 反映済)

再編前の `MAP.md` が両方を持っていた — ボタンの書式(`〈主星〉-〈天体〉回転座標系` /
`〈天体〉自転座標系`)と、要約行の例(`カメラ: 地球・慣性系 / 計画: 地球・月回転系`)。
**2つの語彙があること自体は SPEC が支持している。** 畳むのは書式ではなく、
「同じ書式を2箇所で組んでいること」(S1)。

**正本は `DEVELOP/SPEC/CAMERA.md`「3.1 画面に出す名前」の表。** 実装はこの表に合わせる。

| 固定先 | 正式名(ボタン) | 短縮形(サマリ) |
| --- | --- | --- |
| 慣性系 | 慣性系 | 慣性系 |
| 天体の公転 | 〈主星〉-〈天体〉回転座標系 | 〈天体〉回転系 |
| 天体の自転 | 〈天体〉自転座標系 | 〈天体〉自転系 |
| 機体・役割の公転 | 〈対象名〉の公転 | 公転系 |
| 機体・役割の姿勢 | 〈対象名〉の姿勢 | 姿勢追従 |

併せて決めたもの:

| 対象 | 旧名 | 新名 |
| --- | --- | --- |
| 回転ゾーンの先頭項目 | `解除` | **`慣性系`**(他の選択の否定ではなく並列な選択肢のため) |
| 基準ゾーンの解除 | `固定を解除` / `解除` | **`固定を解除`**(プルダウン・クイックボタンとも) |
| 基準が固定点である表示 | `固定なし` / `固定点` | **`固定点`** |
| 回転ゾーンの見出し | `回転追従` / `回転フレーム` | **`回転`**(両区画とも。基準ゾーンの `基準` と対にする) |
| 姿勢追従の状態語 | `視点追従` / `視点のRCS追従` / `視点RCS追従` / `視点の姿勢追従` | **`姿勢追従`** |
| 回転モード | `クオータニオン操作` / `クォータニオン` | **`クォータニオン`**(表記を揃える) |

**到達不能な分岐が2本ある。** `rotation-zone.ts:113` の `'自転'`(機体に対する自転)と `:118` の
`〈天体〉回転座標系`(主星を持たない天体の公転)は、`availableRotationFollows` が
そもそもその組み合わせを出さないので通らない。手順3で消す。

### D2. 姿勢追従を `ReferenceFrame` の第3の回転種別にはしない

`ReferenceFrame` は軌道線・計画折れ線・交点マーカーが共有する表示座標系で、
`FrameRotationSource` に `'attitude'` を足すと軌道フレーム区画の回転ゾーンにも姿勢が現れる。
`SPEC/MAP.md` L67-75 は計画区画の選択肢を「公転・自転・役割の公転」の3種と定めており、姿勢は無い。
加えて `ReferenceFrames.frameRotationAt` が機体の姿勢と角速度を要求するようになり、
`FrameAnchorSource` を姿勢まで広げることになる。

→ **2つの実装(座標系の差し替え / 向きへの合成)は残す。畳むのは「選択の正本」だけ。**

→ 覆すなら: 手順5 が「1フィールド化」から「`FrameRotationSource` の拡張」へ変わり、
`physics/frame.ts`・`reference-frames.ts`・`frame-anchors.ts` が変更範囲に入る。規模は約3倍。

### D3. 選択の正本は `FocusCamera` の1フィールドにする

いま `CameraOrientation.following`(bool)と `_cameraFrame.rotatingWith` に割れていて、
`focus-camera.ts:487` の getter と `:700` の `serialize()` が同じ合成式を2度書いている。
`FocusCamera` が `_follow: CameraRotationFollow | null` を1つ持てば、
`CameraOrientation` 側は `attitude: Quat | null` だけを残せる(`attitude !== null` が
「生の値が対象姿勢からの相対値である」印になる)。`following` フィールドと `restoreFollow()` は消える。

「追従したいが姿勢がまだ引けていない」(ロード直後)の状態は、
`_follow?.kind === 'attitude' && orientation.attitude === null` として表現できる。
いまこの状態のために `following` と `attitude` の2つが要っているのは、
**選択(何に追従するか)と基準(相対値の基準姿勢)が1つのクラスに同居しているから。**

### D4. 新モジュール `src/game/camera/rotation-follow.ts` を作る

移すもの: `CameraRotationFollow` 型 / `rotationFollowKey` / セーブ変換2本 /
選択肢の導出(`availableRotationFollows` を純関数へ)/ 表示名2本(正式名・短縮形)。

根拠2つ:

- **HUD がカメラの実装を import している。** `hud/frame/rotation-zone.ts:10` は
  `rotationFollowKey` を**値として** `camera/focus-camera` から import しており、
  `focus-camera.ts:7` の `import * as THREE from 'three/webgpu'` を実行時グラフへ引き込む。
  `hud/frame/frame-labels.ts:3` は型 import なので実行時には効かないが、型グラフには入る。
  `camera/focus-target.ts:26-29` が**まさにこの危険をコメントで警告している**
  (`tsconfig.test.json` の include に入れると DOM 定義を要求して型検査が壊れる)。
- **`availableRotationFollows` はカメラの状態をほとんど使っていない。**
  読んでいるのは `this._focus` / `this.celestialSystem` / `this.frameAnchors` /
  `this.config.attitudeOf` の4つで、後ろ3つは注入された依存。規約 1.4 の
  「クラス外から情報をもらいまくっていて、クラス内の情報に全然手を付けていない関数」。

**新モジュールは `CelestialSystem` を型として受け取ってはいけない** —
`celestial-system.ts:2` が `three/webgpu` を import しているため。
`focus-target.ts` の `FocusCandidate` と同じく、必要な口だけの構造的インターフェースで受ける。
そうすれば `tsconfig.test.json` の include へ入れられ、選択肢の導出に回帰テストを書ける。

### D5. `RotationZone` と `CameraRotationZone` を1クラスへ畳む

`rotation-zone.ts` の2クラスは骨格(キー→選択肢の Map + `SegmentedControl` + キー関数 +
`setSelected`)が同一で、違うのは選択肢の出所とラベル関数だけ。
規約 1.5 の判断: 共通化した側(回転の選択 UI)が変わったら両方が変わるべきなので、共通化する。

### D6. `focus-camera.ts` の500行超過は、この計画では解消しない

手順2・5・6 の後の見通しは約 555 行(下の見積り)。さらに削るなら注視対象の解決
(`_focus` / `missingFocusFrames` / `lastResolvedFocus` / `_focusVelocity` / `setFocusTarget` /
`clearFocusIf` / `minDist` / `resolveFocus`、約60行)を `focus-target.ts` へ移す案があるが、
`resolveFocus` の `fallToOrigin` 経路が `setFocusTarget` を呼び、`setFocusTarget` が回転追従の
妥当性検査を呼ぶので、切り出すと `FocusCamera` への呼び戻しが2本残る。
**約50行のために、たらい回しを2本増やすことはしない**(規約 1.2)。
手順6 まで終えてから測り直し、なお切る線が見えたらそのとき決める。

### D7. 基準面まわりは、この計画では**仕様待ちで保留**

**コードの切り出しは行わない**(理由は下)。加えて、**基準面の仕様そのものが未確定**なので、
手順7(極軸まわりのオイラー往復の修正)は仕様が決まるまで着手しない。
`DEVELOP/SPEC/CAMERA.md` の「未確定の案」に積んである。

現状の要点(実測・コード確認済):

- 「面」の概念が2つあり、利用者が選べるのは片方だけ。**極軸**(`referenceUpAxisEci`、
  ドラッグの天頂とロールリセットの基準)は最寄り天体の自転軸/黄道極から**自動で**決まり、
  **基準面**(`framePlaneNormal`、プルダウン)は「真上/真横」のジャンプにしか効かない。
- `framePlaneNormal` は `'earth'` と `'moon'` を id で直書きしている。火星の近くでも
  「赤道面」は地球の赤道面を指す。
- パネルの面の一覧(黄道面/赤道面/月軌道面)が、天球・縮尺グリッドの一覧
  (黄道/赤道/月軌道面/**月赤道面**)と揃っていない。
- `focus-camera.ts:373` のコメント「セーブ対象ではなく」は誤り。`:706` が書き出し `:204` が復元する。

**切り出さない理由(仕様が決まっても変わらない部分).**

`eulerPolarAxis`(4行)と `referenceUpAxisEci`(17行)は `update()` / `reset()` /
`setRotationBasis()` が毎フレーム使い、`viewpoint.position` / `_cameraFrame` / `frameAnchors` /
`displayTime` に依存する。外へ出すと引数が4つ増える。残る約50行だけを出しても、
`setReferenceView` が private の `setRotationBasis` と `resetPan` と `_hud.hint` を呼ぶので
呼び戻しが残る。規約 1.2「診断せずに『長いから』というだけの理由で小さな関数を外へ出してはならない」。

### D8. 「モジュールの数が多い」という見立てへの回答

数えた結果は次のとおりで、**多いのはモジュールではなく「同じ値を別の名前で運ぶ層」のほう。**

| ディレクトリ | モジュール数 | 行数 | 判定 |
| --- | --- | --- | --- |
| `src/game/camera/` | 6 | 1411 | `focus-camera.ts` 709行が単独で違反。他5つは責務がある |
| `src/game/hud/frame/` | 6 | 612 | `frame-labels.ts` 27行だけが短すぎる。他5つは自分の DOM と差分状態を持つ |
| 座標系の基盤(`physics/frame.ts` / `celestial/reference-frames.ts` / `frame-anchors.ts`) | 3 | 391 | いずれも責務が明確。触らない |

`focus-camera.ts` の内訳を実測すると、回転追従が 138 行、基準面/極軸が 74 行。
**切り方がずれているのは `focus-camera.ts` の中であって、モジュールの数ではない。**
この計画はモジュールを1つ足し(`rotation-follow.ts`)、1つ消す(`frame-labels.ts`)ので、
総数は変わらない。

---

## 達成目標(手順2〜6 の実施後に確認した結果)

`ff302d60` 時点。手順7 は未実施なので 10 だけが残っている。

| # | 目標 | 結果 |
| --- | --- | --- |
| 1 | `followingAttitude` が 0件 | **言い換えて達成**。`CameraOrientation` からは消えた。`FocusCamera` に同名の getter が残るが、これは手順5 が「姿勢へ追従しているかを答える口を1つ置く」と指示したもので、`_follow` から導かれる唯一の出所 |
| 2 | 合成式が 0件 | **達成**(getter と `serialize()` の重複が消えた) |
| 3 | 座標系の綴りが2ファイルだけ | **言い換えて達成**。grep はコメントと物理側の用語まで拾う(`physics/cr3bp.ts` の「回転フレーム」は CR3BP の座標系)。**画面に出る文字列**を組んでいるのは `rotation-follow.ts` と `help-content.ts` だけ |
| 4 | 旧語が 0件 | **達成** |
| 5 | HUD の `focus-camera` import が1ファイル | **言い換えて達成**。**値として** import しているのは `camera-frame-panel.ts` だけ。`frame-controls.ts` は型 import、`hud-root.ts` はコメント中の言及 |
| 6 | `frame-labels.ts` が無い | **達成** |
| 7 | `rotation-zone.ts` の `export class` が1つ | **達成**(125 → 53行) |
| 8 | `cameraFrame` が `_cameraFrame` だけ | **達成** |
| 9 | 敵艦フォーカスで要約行に艦名 | **実装済・実機未確認**。`objectName` が役割 → 候補 → エンティティ → 天体名 の順で引く。生 id が出る経路は無くなった |
| 10 | 「赤道面・真上」で上下反転しない | **未着手**(手順7)。`memos/hedalu244/camera_control_spec.md` 2.5 で、真上をクォータニオン操作へ移せば到達経路ごと消えると決めた。同 U5 参照 |
| 11 | typecheck / test:game / test:math / test:render | **達成**(`npm run test` で 680/680) |

**併せて実施したもの(この計画の外).** `memos/hedalu244/fix_camera_control.md` の S2
(不変条件A — ドラッグした向きへ視点が動く)を `a698f95d` で通した。オイラー操作の
`turn()` がロールと仰角のぶんを打ち消していなかった欠陥で、この計画とは独立。

## 手順

### 手順1. SPEC を再編して語彙を確定させる(**実施済**)

**目的.** 表示名は利用者から見えるので、実装を触る前に `DEVELOP/SPEC/` で語彙を決める。
着手して分かったのは、**カメラの仕様を書く場所が無かった**こと — `CONTROLS.md`(視点カメラ・
基準フレーム・ガンサイトズーム)と `MAP.md`(カメラのフォーカス・座標系パネル)と
`RENDERING.md`(近平面・遠平面)へ散り、相互参照で往復していた。`CAMERA.md` を新設して集めた。
**コードは1行も触っていない。**

**実施した内容.**

| ファイル | 何をしたか |
| --- | --- |
| `DEVELOP/SPEC/CAMERA.md`(**新規** 143行) | 視点カメラ / フォーカス / 視点の回転の固定先(+3.1 画面に出す名前)/ 向きの操作 / 注視距離・パン・画角・投影 / ガンサイトズーム / カメラ位置から導かれるもの / 未確定の案 |
| `DEVELOP/SPEC/README.md` | 分野表に `CAMERA.md` を追加。`CONTROLS.md` の範囲から「視点操作」を落とす |
| `DEVELOP/SPEC/CONTROLS.md`(250→208行) | 「カメラ操作」節(視点カメラ・基準フレーム・ガンサイトズーム)を CAMERA.md へ。キー表には中クリックのリセットを追加し、仕様値は CAMERA.md 参照へ。**[G] が「戦闘ビューでのみ読み取られる」という誤記を削除**(表・本文の2箇所と矛盾していた) |
| `DEVELOP/SPEC/MAP.md`(648→612行) | 2節「カメラのフォーカス」を CAMERA.md へ。3節「座標系パネル」をパネルの構成だけに縮め、2節へ繰り上げ。**3〜13節を1つずつ繰り上げ**、自己参照9箇所と `UI-DESIGN.md` からの `MAP.md 7.1` を追随 |
| `DEVELOP/SPEC/PLAN.md`(308→331行) | 軌道計画区画の選択肢と「カメラの基準に追随」トグルを MAP.md から引き取り、5.1 節を新設 |
| `DEVELOP/SPEC/RENDERING.md` | 近平面・遠平面の具体値を CAMERA.md へ。デバッグ深度表示の記述は参照へ |
| `DEVELOP/SPEC/UI-DESIGN.md` | 視点リセットの中身を CAMERA.md 参照へ(戻すものが CONTROLS.md と食い違っていた)。「追従視点/広範囲視点」の語を廃止。「視点のRCS追従」→「姿勢追従」 |
| `DEVELOP/SPEC/GAME.md` | 未確定の案2件(戦闘ビューの座標系パネル・戦闘ビューのダブルクリックフォーカス)を CAMERA.md へ。喪失時のカメラ挙動の丸写しを参照へ |
| `DEVELOP/SPEC/CELESTIAL.md` / `COMBAT.md` / `SAVE.md` | 参照先を CAMERA.md へ。「照準ズーム」→「ガンサイトズーム」。セーブの「カメラの視点」に内訳の参照を追加 |

**コードで決着させた SPEC の矛盾3件.**

| 矛盾 | 実装 | 採った側 |
| --- | --- | --- |
| [G] は両ビューか戦闘ビューだけか | `camera-system.ts:292-298` がビューに関係なく読む | **両ビュー** |
| 視点リセットが戻すもの | `camera-system.ts:188-195` — マップは ロールとパン、戦闘は フォーカス・追従・向き・画角・パン | **ビューごとに違う**(両記述とも不完全だった) |
| カメラは1つか2つか | 同じ `FocusCamera` の2インスタンス。状態独立・セーブも別 | **同じ仕組みのカメラをビューごとに1つずつ** |

**残っている SPEC の仕事(D7 の判断待ち).** `CAMERA.md` の「未確定の案」に積んである —
**画角・透視/平行投影・基準面の操作の仕様**。操作は実装されているが SPEC に記述が無く、
`CONTROLS.md` の空振り参照が指していた穴がこれにあたる。**方針が決まるまで書かない。**

**達成条件と検証(達成済).**

- `grep -rn "CONTROLS.md「視点カメラ」\|CONTROLS.md「基準フレーム」\|MAP.md「カメラのフォーカス」\|基準フレーム\|RCS追従\|追従視点\|広範囲視点" DEVELOP/SPEC/` が **0件**。
- `DEVELOP/SPEC/*.md` の相互リンクがすべて実在するファイルを指す。
- `MAP.md` の節参照(`N節` / `N.M 参照`)がすべて実在する見出しを指す。
- `npm run typecheck` が通る(コード無変更)。

---

### 手順2. `camera/rotation-follow.ts` を新設し、値と選択肢の導出を移す(**実施済** `32fcb747`)

**移したもの.** `CameraRotationFollow` / `rotationFollowKey` / セーブ変換2本 /
`availableRotationFollows`(純関数化)。天体レジストリは `CelestialRegistry` という
必要な口だけの構造的インターフェースで受け、`tsconfig.test.json` の include へ入れた。
`tests/game/rotation-follow.test.ts` に6ケース。`hud/frame/rotation-zone.ts` と
`frame-labels.ts` の import 元を差し替え、**HUD から `camera/focus-camera` への辺は消えた**
(残る3ファイルは `FocusCamera` の実体を扱うので正しい)。

**セーブ形の型を save-data.ts から import しなかった。** `save-data.ts` は装備・ステージまで
型グラフへ引き込むので、`tsconfig.test.json` へ入れると壊れる。受け口を構造的な型として
モジュール内に置き、`FocusCameraSaveData` からは構造的に代入される。

**行数の見込みは外れた** — `709 → 675`(見込み 586)。見積りが使った「回転追従 138行」には
`setRotationFollow` / `toggleAttitudeFollow` / `applyInitialFrame` / `dropStaleRotationFollow` /
`refreshAttitude` / `setCameraRotation` の約90行が入っていたが、これらはカメラの状態を書き換える
**振る舞い**なので手順2 の移送対象ではない(手順5 で正本を1フィールドへ寄せるだけで、置き場は
`FocusCamera` のまま)。**達成条件の「600行未満」は導出が誤っていたので取り下げる** —
`focus-camera.ts` が 500 行を超えたままであることは D6 で既に許容している。

**実機確認は行っていない。** 選択肢の導出は純粋な移送で、`tests/game/rotation-follow.test.ts` が
天体・恒星・周回中の機体・漂流中の機体・姿勢の引けない機体・固定点の6ケースを固定している。

---

### 手順3. 表示名を1本にし、`frame-labels.ts` を消す(**実施済** `8bf993e5`)

**置き場は2つに分かれた.**

| どこ | 何を |
| --- | --- |
| `camera/rotation-follow.ts` | `rotationFollowName`(正式名)と `rotationFollowShortName`(短縮形) |
| `hud/object-name.ts`(**新規**) | `frameRoleName` と `objectName`(id → 表示名) |

`objectName(id, celestialName, ...candidates)` は候補一覧を可変長で受ける。`ViewBadge` は
マップ候補と生存中のエンティティを、フレーム区画はマップ候補だけを渡す(戦闘ビューに区画が無く、
マップ候補は常に最新なので)。**R7 の穴はこの形で閉じた** — 候補が引けなくても天体名へ落ちる。

**`frame-labels.ts` は削除。** `view-badge.ts` の `frameRoleOf` 直参照も `objectName` の中へ入った。

**残った重複が1つ.** 回転ゾーン2クラスの `SegmentedControl` 初期化に `'慣性系'` の直書きが
各2箇所(計4)ある。**手順4 で1クラスへ畳めば1箇所になる**ので、そこで消す。

**達成目標の grep 2本は導出が誤っていたので言い換える.**

- 目標3(座標系の綴り)は `慣性系` などを**コメントや物理側の用語**まで拾う。`physics/cr3bp.ts` の
  「回転フレーム」は CR3BP の座標系そのもので、UI の語ではない。**画面に出る文字列**に限れば、
  綴りを組んでいるのは `rotation-follow.ts` と `help-content.ts` だけになった(確認済)。
- 目標5(HUD から `camera/focus-camera` への import)は 3ファイル残るが、`frame-controls.ts` は
  型 import へ変えたので実行時グラフには乗らず、`hud-root.ts` はコメント中の言及だけ。
  **値として import しているのは `camera-frame-panel.ts` の1つ**(`FocusCamera` の実体を持つので正しい)。

**ユーザーへの確認事項 — 短縮形の主語.** `SPEC/CAMERA.md` 3.1 の表は「機体・役割の公転」の
短縮形を `公転系`(主語なし)としているが、その根拠は「機体をフォーカスしているときの固定先は必ず
フォーカス対象自身なので、サマリの基準欄と重複する」というカメラ側の事情。**軌道計画区画では
役割の公転が基準ゾーンの選択と独立に決まる**(PLAN.md 5.1)ので、主語を落とすと
`基準: 地球・公転系` が誰の公転か読めなくなる。

→ **カメラ区画は主語を落とし、軌道計画区画は残す**ように実装した(`rotationFollowShortName` の
`omitSubject`)。SPEC の記述はカメラ側の条件付きの規則として読める形になっているが、
**表だけ見ると両区画に同じ短縮形を課しているように読める。** 3.1 に一言足すかどうかは判断待ち。

---

### 手順4. `RotationZone` と `CameraRotationZone` を1クラスへ畳む(**実施済** `ac5a420c`)

選択肢を外から受ける1クラス `RotationZone<T extends CameraRotationFollow>` にした。姿勢を
選べない軌道計画区画は `RotationZone<FrameRotationSource>` として型で絞る。**125 → 53行**
(見込み 75)。`'慣性系'` の直書きもモジュール内の1定数になった。

`setNearby` が持っていた導出は `availableFrameRotations` として `rotation-follow.ts` へ。
**カメラ側の導出とは畳まなかった** — 入力が違い(フォーカス対象 vs 系のメンバー+役割)、
選ぶ基準そのものが別だから(SPEC/MAP.md 2節)。置き場だけを揃えた。

---

### 手順5. 追従の選択の正本を `FocusCamera` の1フィールドへ(**実施済** `b7bde019`)

`FocusCamera._follow` が正本になり、合成式は getter からも `serialize()` からも消えた。
`CameraOrientation` からは `following` / `restoreFollow` / `followingAttitude` / `usesEuler` が
落ち、姿勢の基準 `attitude` だけが残る。代わりに `clearAttitude()` を1つ足した —
向きをこの後まるごと置き直す `resetToInitial` が、基準の姿勢だけを捨てるために要る。

**`vessel-panel.ts` の3段掘りは `FocusCamera.followingAttitude` で置き換えた。**

**テストの入れ替え.** `restoreFollow` と `usesEuler` を見ていた2つのケースは、どちらも
`FocusCamera` へ移った判断なのでこの層では書けない。代わりに **R4(ロード直後に視点が跳ぶ)を
直接突くケース**へ置き換えた — 姿勢を持たない間は生の値がそのまま実効回転になり、初めて姿勢が
引けた瞬間にも跳ばないこと。**R5(姿勢追従中にオイラー経路へ入る)の判定は `FocusCamera` 側へ
移ったので、回帰テストは無い**(`FocusCamera` は `CelestialSystem` を要求するため
`tsconfig.test.json` へ入れられない)。実機で [G] を ON にしたまま船を回頭させて確かめる。

**行数.** `camera-orientation.ts` 150 → **139**(見込み 125)。`clearAttitude` と
不変条件A のコメントぶん超えた。`focus-camera.ts` は 675 → **682** — `_follow` と
`followingAttitude` を足したぶん、合成式2箇所を消したぶんを上回った。

---

### 手順6. 死んだ口と再送出の段を落とす(**実施済** `ff302d60`)

`FocusCamera.cameraFrame` を削除。`onSelectCenter` の3段を2段にし、`FrameControls` の
コールバックを `CameraFramePanel` のコンストラクタ引数として受けて `AnchorZone` へ直に繋いだ。
`_cameraFrame` を「setter」と呼んでいた古いコメント2箇所も直した。

---

### 手順7. 極軸まわりのオイラー往復を可逆にする(**基準面の仕様が決まるまで着手しない**)

**目的.** S6。「真上」で画面が 180° 反転するのを止める。
**論点23 の範囲外だが、同じ極軸まわりの欠陥で、利用者から見える。**

**先に基準面の仕様(D7)を決める必要がある。** 反転が起きるのは「選んだ面の法線」と
「自動で決まる極軸」が一致するときだけで、この2つの関係をどうするかが仕様の判断そのものだから。
仕様しだいでは、下の「フォールバック基準を一致させる」ではなく別の直し方になる
(たとえば選んだ面が極軸も決めるなら、「真上」は同じオイラー系の仰角上限の姿勢になり、
クランプの扱いを決める問題に変わる)。以下は仕様が現状のまま据え置かれた場合の手順。

**変更が必要な箇所.**

| ファイル | 何をするか |
| --- | --- |
| `src/math/polar-euler.ts:36-38`(`eulerFromRotation`)と `:53-54`(`rotationFromEuler`) | roll の基準ベクトルのフォールバック条件を両関数で一致させる。いまは前者だけが `projectOntoPlane(polar, offset)` の縮退でフォールバックへ落ち、後者はクランプ後の offset で評価するので落ちない |
| `tests/math/polar-euler.test.ts` | 往復が恒等であることをケースで固定する。**極ちょうど(視線 = +極軸)**、**極から 1e-6 / 1e-4 / 1e-3 rad**、**真下(視線 = −極軸)** の各点で、`rotationFromEuler(eulerFromRotation(q, polar), polar)` の forward / up が元の q からずれないこと。forward は `POLAR_PITCH_LIMIT` ぶん(0.057°)までのずれを許し、**up は 1° 以内**を要求する |

**達成条件と検証.**

- `npm run test:math` が通る(新規ケースを含む)。
- `npm run typecheck` が通る。
- `npm run dev` でマップビューを開き、地球にフォーカスした既定状態(基準面「赤道面」、
  オイラー操作 ON)でカメラパネルの角度プルダウンを「赤道面・真上」にして「セット」を押す →
  **画面の上下が反転しない**。同じ操作を「黄道面・真上」でも行う。
- 極から遠い通常の視点で、ドラッグ・矢印キー・ロールの感触が変わっていないこと
  (下のリスク表 R6)。

---

## 見積り

行数で見積もる。導出は「実測した現行の行数 ± 移送量」。

| 手順 | 変更行数の導出 | 結果 |
| --- | --- | --- |
| 1 | **実施済**。CAMERA.md 新規143行、他10ファイルで正味 −59行(CONTROLS −42 / MAP −35 / PLAN +23 / RENDERING −5 / GAME −3 / README +1 / CELESTIAL +1 / SAVE +1 / UI-DESIGN ±0 / COMBAT ±0) | SPEC 正味 +84行(3803→3887)、文書数 14→15 |
| 2 | 移送 138行 − 委譲で消える重複 約20行 = 新規モジュール約120行。`focus-camera.ts` は −138 + 委譲メソッド約15 = **709 → 586行**。HUD 2ファイルの import 各1行。新規テスト約60行 | +180 / −138 |
| 3 | `frame-labels.ts` −27行、表示名2本 +30行(`rotation-follow.ts` へ)、「id → 表示名」新規 +18行、`rotation-zone.ts` −22行、`camera-frame-panel.ts` −4行、`trajectory-frame-panel.ts` −3行、`view-badge.ts` −9行、文言4箇所 ±4行 | +48 / −65 |
| 4 | `rotation-zone.ts` **125 → 約75行**(−50)、導出の移送先へ +25行 | +25 / −50 |
| 5 | `camera-orientation.ts` **150 → 約125行**(−25)、`focus-camera.ts` −12行(合成式2箇所 + `_follow` の導入で差し引き)、テスト追随 ±12行 | −37 |
| 6 | `focus-camera.ts` −4行、`camera-frame-panel.ts` −3行、`frame-controls.ts` ±1行、コメント −1行 | −8 |
| 7 | `polar-euler.ts` ±6行、テスト +30行 | +36 |

**終了時の主要モジュール:**

| ファイル | 現在 | 終了時(見込み) |
| --- | --- | --- |
| `src/game/camera/focus-camera.ts` | 709 | **約 555**(500 は超える。D6 のとおり許容する) |
| `src/game/camera/camera-orientation.ts` | 150 | 約 125 |
| `src/game/camera/rotation-follow.ts` | — | 約 150(新規) |
| `src/game/hud/frame/rotation-zone.ts` | 125 | 約 75 |
| `src/game/hud/frame/frame-labels.ts` | 27 | **0(削除)** |
| `src/game/hud/frame/object-name.ts` | — | 約 18(新規) |
| モジュール総数(この範囲) | 16 | **16**(+2 新設、−1 削除、−1 は `object-name.ts` を既存へ入れた場合) |

---

## リスクと落とし穴

**無言で間違う壊れ方だけを挙げる。**

| # | リスク | 影響 | それが露見する場所 |
| --- | --- | --- | --- |
| R1 | **旧セーブ形式の受け口を移送で落とす。** `FocusCameraSaveData.rotatingWith` は `CameraRotationFollowSaveData \| string \| null` で、旧セーブは公転対象の id を**文字列**で持っていた(`save-data.ts:327` と `focus-camera.ts:111-115`)。`FocusTargetSaveData` の `'point'` も同じ(`save-data.ts:321`) | 旧セーブのカメラが慣性系に戻る。**型エラーにならず、例外も出ない** | **手順2**(セーブ変換の移送)。検証は、`rotatingWith` を文字列にしたセーブを1つ作って読ませる |
| R2 | **照合キーの文字列が変わる。** `SegmentedControl` は値を参照同一性で比べるため、`rotationFollowKey` / `rotationSourceKey` が返す文字列がキーそのもの(`rotation-zone.ts:17-19` のコメント)。キーの綴りが1文字でも変わると Map 引きが外れる | 選択中の項目がハイライトされない / 選んでも何も起きない。**例外は出ない** | **手順2**(キー関数の移送)と**手順4**(2クラスの統合)。検証は「選んだ項目が反転表示になる」を目で見る |
| R3 | **`ReferenceFrame` をリテラルで組む。** `physics/frame.ts:19-21` が禁じている — `frames.frameOf` を通さないと参照同一性が崩れ、`trajectory-line.ts` の `frame === lastFrame` キャッシュが毎フレーム外れる | 描画が黙って重くなる。**絵は正しいままなので気付かない** | **手順2**(`rotation-follow.ts` が座標系に触れる場合)。検証は `grep -n "rotatingWith:" src/game/camera/rotation-follow.ts` が オブジェクトリテラルを `ReferenceFrame` として組んでいないこと |
| R4 | **「追従中だが姿勢未解決」の状態が表現できなくなる。** いま `following=true, attitude=null` で表しているのはロード直後の1フレーム(`camera-orientation.ts:41-42,146-147`)。`following` を落とすとき、この状態を `FocusCamera._follow` 側で引き受け損ねる | ロード直後に視点が跳ぶ、または姿勢追従が復元されない。**セーブ→リロードでしか出ない** | **手順5**。検証は「姿勢追従のままセーブ→リロード」を実際に通す |
| R5 | **姿勢追従中にオイラー経路へ入る。** `usesEuler` の判定を `CameraOrientation` から `FocusCamera` へ移すとき条件を落とすと、姿勢追従中に `restoreFromEuler` が走る。姿勢追従中は極軸が座標系の幾何で定まらない(`camera-orientation.ts:60-61,92` のコメント) | 視点がゆっくり回り続ける / 操作方向が合わなくなる。**例外は出ない** | **手順5**。検証は戦闘ビューで [G] を ON にしたまま船を回頭させ、視点が船に貼り付いたままであること |
| R6 | **roll の基準を変えると、極から遠い通常の視点の roll も変わる。** `eulerFromRotation` はセーブされた向きの読み替え(`set` / `rebase` / `setMode`)にも使われる | 全視点で up が傾く。既存セーブを開いたときにだけ出る | **手順7**。検証は極から遠い点での往復テスト(既存ケース)が通ること + 実機でドラッグの感触 |
| R7 | **「id → 表示名」を1本にするとき、`pickables` 依存が広がる。** `view-badge.ts:132` は `viewManager.activeView.pickables` を引くが、戦闘ビューではマップ候補が更新されていない(`:125-126` のコメントがまさにその理由でフォールバックを積んでいる) | 戦闘ビューや一時的に非表示の対象で名前が空欄/生 id になる。**マップビューだけ見ていると気付かない** | **手順3**。検証は戦闘ビューの ViewBadge の Focus 欄に艦名が出続けること |
| R8 | **worktree で `npm run test:*` が `three/webgpu` の TS2307 で落ちる。** `tsconfig.test.json` の `paths` が tsconfig からの相対で解決され、親を辿らない | 触っていない層の問題に見え、自分の変更を疑って時間を溶かす。`npm run typecheck` は通ってしまう | **全手順**。着手前に `New-Item -ItemType Junction -Path <worktree>\node_modules -Target <repo>\node_modules`。**片付けは逆順** — 先にジャンクションを外してから `git worktree remove` |

---

## 補足 — この計画が触らないと決めたもの

再検討しないための記録。

| 対象 | 残す理由 |
| --- | --- |
| `src/physics/frame.ts`(160行) | 座標系の型と純変換。責務が明確で、`tests/physics/frame.test.ts` が48箇所で固定している |
| `src/game/celestial/reference-frames.ts`(129行) | 「どの座標系があるか」と「その剛体運動」。参照同一性のキャッシュも含めて単一の責務 |
| `src/game/frame-anchors.ts`(102行) | 未登録 id(機体・役割)の状態解決と2フレームの猶予。`tests/game/frame-anchors.test.ts` がある |
| `FocusCamera` の `projectionMode` / `rotationMode` の2値 union | 論点20 で実測して「残す」で決着済み |
| `src/game/hud/frame/anchor-zone.ts`(98行) | 上段プルダウンと下段クイックボタンの2つを持ち、自分の DOM を持つ。回転ゾーンとは選ぶ軸が違う(中心 vs 回転)ので畳まない |
| 「解除 / 固定を解除 / 固定なし / 固定点」の表記ゆれ | **基準ゾーン(中心)の語**で、「解除 / 慣性系」は**回転ゾーンの語**。別の軸なので1つに畳まない。ただし手順3で、同じ軸の中での表記(`固定なし` と `固定点`)は揃える |
| `game.ts:141-148` の `attitudeOf` 解決式 | `FrameAnchors` の3つの口(`entityState` / `activeShipState` / `navTargetState`)と同じ場合分けを、猶予なしでもう一度書いている。**規約 1.2 の「game.ts に判断を書かない」に反するが、直すと `FrameAnchors` に姿勢の口を足すことになり、D2 で否定した方向へ寄る。** この計画では触らず、論点として別に積む |
