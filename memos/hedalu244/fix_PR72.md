# PR #72 の描画パイプライン変更の後始末(雲・大気)

行番号はすべて `origin/main` = `713755b1`(PR #75 のマージ)時点のもの。
PR #72 の前の main は `b9b6f9d8`、PR #72 のマージは `db090876`。

**地表 LOD にかかる手順は fix_surface_lod.md へ切り出し、保留にした**(旧手順 0・1・5・6・12)。
この計画は雲・大気だけを扱う。両者の跨りは「fix_surface_lod.md との関係」に3点だけある。

## 目的

PR #72(workspace3、346 commit)は、地球の詳細 LOD 地表タイル・雲の描画の作り替え・大気の追加表現を
UI・入力・太陽系精度の更新とまとめて main へ入れた。描画パイプラインの変更に、採用できないもの・
直せば採用できるもの・採用するものが混ざっている。そのうち雲・大気にあたるのは次の3つ。

- **本番の地球から海のサングリントが消えている**(仕様 RENDERING.md:308 に反する後退)。
- 雲は、sin 波で焼いた架空の月別気候から生成されている。極と日付変更線で破綻する。
- 雲の品質が #72 前より明らかに落ちている。一因は雲場の LOD にある。さらにその下には、PR #69 が
  雲場を全球の正距円筒で焼く形で実機へつないだという、図法の選び方の問題がある。

PR #73 が #72 の上で大規模な移動・改名をしたため、#72 の commit を個別に `git revert` するとほぼ全部が
衝突する(試した結果は「決めたこと 2」)。**git 操作で済むところは git 操作で、残りは機能ごとに1つの
撤去 commit で片付ける。**

修正後の状態:

- 地球の昼側の海にサングリントが戻り、雲殻は #72 前と同じディザで縁を描く。
- 地球の雲は平年の気候画像(`earth-climate.png`)から生成される。月別気候は main から消える
  (保護先は fix_surface_lod.md のブランチ)。
- 雲場の LOD はすべて潰れ、雲場は視点中心の正射影の cap で焼かれる(fix_cloud_projection.md)。
- エアグローは描画設定で切れ、オーロラは太陽に対して昼夜が決まり、GPU 計測は表面雲を
  G バッファから分けて読める。

### 項目ごとの判定

| 項目 | 主な commit | 判定 | 扱い | 手順 |
| --- | --- | --- | --- | --- |
| 本番の地球のサングリント消失 | 893e6700 | 退行 | 修正 | 1 |
| 雲場の楕円体投影 | a6c8d68d / 812783a3、4e7e1ff0 / 7eadb49c | 不採用 | 撤去 | 2 |
| 月別気候(sin 波の架空気候) | 5055f0e1、3f7245b7、893e6700、1991b243、6efe3b9e、#75 の c16347e0・0e4a1eb1 | 不採用(保護) | 平年の気候へ戻す | 3 |
| 雲殻のディザ撤去・雲頂の連続化 | bcc70bee、b4215af6(最終形は 3d1f43bf) | 不採用 | ディザを戻す | 4 |
| オーロラの磁極中心化 | 0ad70886、3527658f | 採用 + 修正 | 太陽の子午線を渡す | 5 |
| エアグロー | cefd42aa | 採用 + 追加 | 描画設定で切れるようにする | 6 |
| GPU 計測の雲の行 | 13090f9a のうち計測部分、#75 の 0308e4c8 | 採用 + 追加 | 表面雲を分ける | 7 |
| 雲場のミップ化 | 13090f9a のうちミップ部分 | 不採用 | 撤去 | 8(fix_cloud_projection.md 手順 2) |
| 雲の画面 LOD のヒステリシス | 6ff95106、0ff8c8d1、d12817fb | 不採用 | 撤去 | 8(同上) |
| 青色ノイズの切り替え・固定 LOD の診断 | 6ef4b264 | 不採用 | 撤去 | 8(同上) |
| 雲場の全球正距円筒(PR #69 の実機への接続) | dc9c5292 ほか | 不採用 | 視点中心の正射影の cap へ | 8(fix_cloud_projection.md 手順 3〜5) |

**fix_surface_lod.md が扱うもの**(保留中): CI の地表バンドル配置、詳細 LOD 地表タイル、
天体表面の汎用化、地表タイル側の欠陥(eventLog・初期法線)、月別気候の保護先。

**触らないもの**: 天気モデルの再編(weather-transport・atmospheric-wind・ロスビー波・前線)、
描画設定パネルの 2 列配置(a39e2b9d)、#72 の描画以外の変更(UI・入力・太陽系精度・物理)。
#75 の「雲の分布」(ea68a875)、雲場を投影自身の uv で読む修正(74ad20f1)、実験環境が本番と同じ
工場で雲場を組むこと・投影の版(781043e0)、GPU 行の「雲の生成」(0308e4c8)。

## fix_surface_lod.md との関係

両計画は独立に進む。跨るのは次の3点だけで、いずれも **この計画が先** になる。

| 跨る点 | なぜ先か |
| --- | --- |
| 手順 1(サングリント) | 撤去 commit に修正を混ぜないため(決めたこと 6)。先に入れておけば、地表タイルの撤去 commit を保護ブランチが revert しても、退行だけが戻ることはない |
| 手順 2(楕円体投影) | `src/render/cloud/field-projection.ts` が、地表タイルの撤去で消える `earth-surface-coordinate.ts` を import している |
| 手順 3(月別気候) | 月別気候の実データは地表タイルの配信物に入っているので、保護先は fix_surface_lod.md のブランチ。同計画の手順 5 がこの commit を revert する |

地表タイルは main に残ったままこの計画を進める。手順 3 のあと
`EarthSurfaceSource.climateMapUrls` は呼び手 0 になるが、地表タイルごと消えるのを待つので
main 側では消さない。

## 決めたこと

**すべて覆せる。** 覆したときにどの手順が変わるかを併記する。

### 1. 地表 LOD にかかる手順は fix_surface_lod.md へ分け、保留する

地表 LOD は別ブランチで動きがありそうなので、そちらの形が決まるまで撤去へ着手しない。雲・大気の
後始末は地表タイルが main にあっても進められる(「fix_surface_lod.md との関係」の3点を守る限り)。

**覆されたら**(地表 LOD も今やる場合): fix_surface_lod.md の手順を、この計画の手順 1 のあと・
手順 4 の前に差し込む。PR の区切りは「PR-A → 地表の撤去 → PR-B → PR-C」になる。

### 2. main の履歴は書き換えない。撤去は機能ごとに1つの commit にする

#72〜#75 はマージ済みで、release は main から CI が作る。rebase・force push はしない。

個別 revert は、次の試し(`origin/main` の上で `git revert --no-commit`)のとおり使えない。

| 対象 | 結果 |
| --- | --- |
| c16347e0(#75、単月の ClimateMap を消す) | **クリーン** |
| 3f7245b7(月別補間の時計) | **クリーン** |
| cefd42aa(エアグロー。採用なので revert はしない) | クリーン |
| 6ef4b264 / 6ff95106 / 13090f9a / a6c8d68d / 4e7e1ff0 / 0e4a1eb1 / 74ad20f1 / 1991b243 / 893e6700 / 6efe3b9e / 5055f0e1 | 衝突 |
| ディザ: `git diff b4215af6^ bcc70bee` を改名後のパスへ書き換えて `git apply -R --3way` | 3 ファイルとも衝突 |
| ミップ: 13090f9a の baked-field.ts・cloud-field-sampler.ts だけを `git apply -R --3way` | 2 ファイルとも衝突 |

そこで、**保護する機能の撤去はそれぞれ1つの commit に閉じ、修正を混ぜない。** 月別気候の撤去
(手順 3)は、fix_surface_lod.md の保護ブランチがその commit を revert すれば取り戻せる。

### 3. 雲場の LOD はすべて潰し、雲場の図法ごと作り直す

雲場のミップ・読み手の明示段・ヒステリシス・固定 LOD・中間場の粗焼きは、全球の正距円筒で細かさが
足りないのを補うために積み重なったもので、どれも調整の方向が見当違い。13090f9a のうち GPU 計測の
部分だけを残し(手順 7)、ほかは fix_cloud_projection.md の手順 2 でまとめて潰す。そのうえで
同じ計画の手順 3 以降で、雲場を視点中心の正射影の cap へ移す。潰す範囲と残すフィルタの線引きは
fix_cloud_projection.md の「決めたこと 3」。

**覆されたら**(図法は変えず LOD の撤去だけにする場合): 手順 8 では fix_cloud_projection.md の
手順 1〜2 だけを行う。

### 4. 青色ノイズの切り替えは消す

固定 LOD と対で入った、ミップの有無を見比べるための診断つまみで、呼んでいるのは render-lab だけ。
ミップを消せば比べる相手が無くなる。大気の積分の刻みずらしは常にオンのまま。

**覆されたら**: fix_cloud_projection.md 手順 2 で `setCloudBlueNoiseEnabled` の経路だけを残す。

### 5. 平年の気候は c16347e0 の revert で戻し、復元したクラスを `AnnualClimateMap` と呼ぶ

0e4a1eb1 が気候入力の契約(interface)を `ClimateMapLike` から `ClimateMap` へ改名した。c16347e0 の
revert は git 上はクリーンに当たるが、同じ名前の class が戻ってきて型検査で衝突する。契約は
`ClimateMap` のまま残す。保護ブランチで月別気候(`MonthlyClimateMap`)が同じ契約を実装し直すため。

**覆されたら**(契約を畳んで class 1つにする場合): 手順 3 で interface を消し、fix_surface_lod.md
手順 5 の revert で契約を作り直す衝突を解く。

### 6. サングリントの修正は地表タイルの撤去より前の、独立した commit にする

撤去 commit に混ぜると、保護ブランチがそれを revert したときに退行も戻る。地表 LOD を保留にした
いま、この計画の手順 1 が先に入るので順序は自然に満たされる。

### 7. エアグローのオフは発光の項だけを落とす。打ち切り高度は変えない

**オンオフで切り替わる内容はアトミックにする** — それが問題の切り分けの条件である。オフで
打ち切り高度(約 127 km → 115 km)と刻みまで動かすと、オンオフの差が発光由来か積分の粗さ由来かを
分けられなくなる。#72 前の積分へ戻すことは目的ではない。

これは実装のうえでも素直に通る。`airglowCutoffAltitude`(airglow.ts:17-18)は `altitude` と
`scaleHeight` だけで決まり `strength` を見ない。`verticalOpticalDepth`(atmosphere.ts:74-77)は
エアグローを含まない。したがって **`strength` を 0 にするだけなら、打ち切り高度もサンプル点の
配分も一切変わらず、発光の項だけが消える。**

**覆されたら**(#72 前の積分へ戻す場合): 手順 6 で `optics.airglow` を `undefined` にする経路へ
替え、達成目標 5 のテストを「オフの打ち切り高度がエアグローを持たない光学定数の値と一致する」へ
戻す。

### 8. 表面雲は G バッファを 2 回の render() に分けて計る。「雲大気」は分けずに名前を直す

表面雲は G バッファの1回の `render()` に含まれている(gbuffer.ts:104-110)。雲殻を専用のレイヤーへ
置き、同じ描画先へ2回目の `render()` として描けば、時刻印が分かれる。

「雲大気」は大気の積分器が雲を同じシェーダの中で解くので、雲だけの時間は取れない。行の名前を
「大気(雲あり)」へ改め、雲だけの時間と読み違えないようにする。

手順 8 より前に行う。LOD を潰す前後と cap へ移す前後で、表面雲の費用を比べるため。

**覆されたら**(雲大気も分ける場合): 積分器を雲あり/なしの2パスに割る設計が別途要る。この計画
では扱わない。

### 9. 雲場の図法の作り直しは fix_cloud_projection.md に分け、手順 8 として挿入する

大きな計画なので別ファイルに書く。手順 2 の着地点(球の正距円筒)は仮のもので、手順 8 で視点中心の
cap に替わる。それでも手順 2 は要る — cap の投影は球の契約を前提にしており、楕円体投影と
`earth-surface-coordinate.ts` への依存を先に消しておく必要がある(後者は fix_surface_lod.md の
手順 3 の前提でもある)。

## 達成目標

1. main で次が **0 件**。
   `git grep -nE 'MonthlyClimateMap|monthly-climate|createDevelopmentClimateMap|climateEpochUnixSec|replaceUrls|EllipsoidEquirectProjection' -- src tools tests`
2. `earthGeneratedCloudField` が引数なしで組め、雲の気候が `earth-climate.png` から読まれる。
3. fix_cloud_projection.md の達成目標がすべて満たされている(雲場の LOD が 0 件、雲場が視点中心の
   cap で焼かれる)。
4. **目視**: `npm run dev` で地球の昼側を見ると、太陽直下点のまわりの海にサングリントが出る。
   雲殻の縁は点描(ディザ)で、被覆の薄いところで雲頂が地表側へ下がらない。
5. 描画設定に「エアグロー」があり、**オフでもオンでも地球の大気の打ち切り高度が同じ値になる**
   (テストで固定)。オフで変わるのは発光の項だけ。
6. デバッグ情報ウィンドウの GPU 行に「表面雲」が出る。表面雲を描いている間、「Gバッファ」の値には
   雲殻が含まれない。
7. オーロラの昼夜の変調が太陽の方向で決まる(テストで固定)。
8. main で `npm run typecheck`・`npm run test`・`npm run build` が通る。

## 手順

main へは `/send-pr` で送る。区切りは次の 3 つ。**マージは merge commit で行い、squash しない**
(fix_surface_lod.md の手順 5 が手順 3 の commit の hash を revert するため)。

- PR-A(退行と気候): 手順 1〜3
- PR-B(小さな修正と計測): 手順 4〜7
- PR-C(雲場の作り直し): 手順 8

### 手順 2. 雲場の楕円体投影を外す

**目的**: 雲場の契約を回転楕円体の地理座標にすると、描画側が方向ベクトルの `dot` で読む正射影と
噛み合わない。球の正距円筒(`EquirectProjection`)へ戻す。この着地点は仮で、手順 8 で視点中心の
cap に替わる。fix_surface_lod.md 手順 3 で消える `earth-surface-coordinate.ts` を
field-projection.ts が import しているので、そちらより先に行う。

| ファイル | 何をするか |
| --- | --- |
| `src/render/cloud/field-projection.ts` | `EllipsoidEquirectProjection` と `earthSurfaceUvFromRadialNode` の import、`normalize` の import を消す。`revision`(781043e0)は `OrthographicCap` が使うので残す |
| `src/game/celestial/solar-system/earth-system.ts:425-433` | `earthGeneratedCloudField` の既定の投影を `new EquirectProjection(EARTH_CLOUD_FIELD_HEIGHT)` にし、コメント「気候図と同じ楕円体の正距円筒」を直す。`EARTH_CLIMATE_AXES`(229 行)は呼び手が手順 3 と合わせて 0 になるので消す |
| `tests/render/cloud-field-sampler.test.ts:20` | 楕円体投影のテストを消す |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`。
- `git grep -n EllipsoidEquirectProjection -- src tools tests` が 0 件。
- `npm run cloud-lab:shot` で、全球の雲場に経度 ±180° の継ぎ目が出ない。

### 手順 3. 雲の気候を平年の気候画像へ戻す(月別気候の撤去)

**目的**: 月別気候は、配信物が ready のときだけ実データへ差し替わり、それ以外は sin 波の架空大陸で
焼かれる。本番は常に後者で、極と日付変更線で破綻する。実データの入手の目途が立つまでは、
`earth-climate.png` だけを読む形へ戻す。保護ブランチは fix_surface_lod.md 手順 5 でこの commit を
revert する。

| 操作 / ファイル | 何をするか |
| --- | --- |
| `git revert --no-commit c16347e0` | 単月の `ClimateMap` class を climate-map.ts へ戻す(クリーンに当たる) |
| `git revert --no-commit 3f7245b7` | `monthly-climate-clock.ts` とそのテストを消す(クリーンに当たる) |
| `src/render/cloud/climate-map.ts` | 戻った class を `AnnualClimateMap implements ClimateMap` へ改名する(決めたこと 5)。月別の値域定数 `CLIMATE_*`(9-16 行)に呼び手が残らなければ消す |
| `src/render/cloud/generated-cloud-field.ts:25-28, 46-49` | 気候を `MonthlyClimateMap` から契約 `ClimateMap` へ戻す。`climateEpochUnixSec` と `monthlyClimateClockAt`・`setMonth` を消す。世代による焼き直しと投影の版は残す |
| `src/render/cloud/monthly-climate-map.ts`、`monthly-climate-fixture.ts` | 削除 |
| `tests/render/monthly-climate-map.test.ts` | 削除 |
| `src/game/celestial/solar-system/earth-system.ts:419-434, 445-448` | `earthGeneratedCloudField` は `bootstrap` を受けず、`AnnualClimateMap.fromDeferredUrl(climateTextureUrl)`(`../../../assets/earth-climate.png`)で気候を組む。`createDevelopmentClimateMap` を消す。`earthSystem` の `climateEpochUnixSec` 引数を消す。`bootstrapEarthSurface` は地表タイル側に残るので消さない |
| `src/game/celestial/solar-system/solar-system.ts:71` | `earthSystem` へ渡す気候の元期を消す(893e6700 で足されたもの) |
| `src/render/cloud/weather-model.ts`、`cloud-presentation.ts`、`tools/cloud-lab/views.ts` | 型の参照を `ClimateMap` 契約へ合わせる(0e4a1eb1 が触った箇所) |
| `tools/cloud-lab/lab.ts:8-9, 63, 86-87` | `bootstrapEarthSurface` の import と `CLIMATE_EPOCH_UNIX_SEC` を消し、`earthGeneratedCloudField()` / `earthGeneratedCloudField(this.capProjection)` で組む |
| `tools/render-lab/cases.ts:15-17, 653` | 同上 |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`、`npm run test:game`。
- 達成目標 1 の検索が 0 件。
- `npm run cloud-lab:shot` の全球ビューで、極の放射状の筋と経度 ±180° の継ぎ目が消え、大陸の形が
  実際の地球になる(サハラ・アマゾン・インド洋の雲の粗密が読める)。

### 手順 4. 雲殻の縁をディザへ戻し、雲頂の連続化を外す

**目的**: 被覆率の中間を青色ノイズの点描で描く方式を、線形補間 + 0.5 で捨てる方式に置き換えた変更を
戻す。薄い柱で雲頂を地表側へ下げる処理も外す。雲頂の高さは生成側の責務で、描画側で混ぜない。

撤去の対象は `git diff b4215af6^ bcc70bee -- src/render/cumulus-shell.ts src/render/cloud/cumulus-shape.ts src/render/pipeline/cloud-scattering.ts`
(248 行)の差分。3-way の逆適用は3ファイルとも衝突するので、`b4215af6^` の
`src/render/cumulus-shell.ts` を手本に手で戻す。

| ファイル | 何をするか |
| --- | --- |
| `src/render/opaque-cloud-surface-renderer.ts:216-258` | 雲頂の締め込みを青色ノイズのディザ判定へ戻し、`clearanceAt` の被覆率による雲頂の引き下げを外す。3d1f43bf が戻した構造(cloud-optics・cloud-shape-evaluator)と、#75 の出どころの張り替え(`setSource`)は残す |
| `src/render/cloud/cumulus-shape.ts` | bcc70bee が変えた雲頂の連続化(被覆に応じて雲頂を下げる部分)を戻す |
| `src/render/pipeline/cloud-atmosphere-renderer.ts` | bcc70bee が cloud-scattering.ts へ入れた 1 行ぶんの対応を戻す |
| `tools/render-lab/index.html`、`tools/render-lab/main.ts` | 「被覆率」のつまみを「ディザ」のつまみへ戻す |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`。
- `b9b6f9d8` の worktree で `npm run render-lab:shot` を撮り、同じ視点の今の撮影と並べる。雲殻の縁が
  同じ粒度の点描になり、薄い雲の縁で雲頂が段状に落ちない。

### 手順 5. オーロラの昼夜を太陽で決める

**目的**: `aurora.sync(phase)`(point-celestial-view.ts:190)が太陽の子午線を渡していない。昼夜の変調
(aurora-field.ts:42-43)が天体固定の経度 0 を基準にしており、仕様の「磁気地方時」
(RENDERING.md:322)が効いていない。

| ファイル | 何をするか |
| --- | --- |
| `src/render/celestial/celestial-entity/point-celestial-view.ts:128, 186-191` | `syncAuroras` へ `motion` と `star` を渡す。太陽の方向を天体固定へ写し、aurora-field.ts:27 の `frameAt` が `solarMeridianRad` に期待する基準(磁気経度か地理経度か、0 がどちら向きか)へ直してから `aurora.sync(phase, solarMeridianRad)` へ渡す |
| `tests/render/aurora-field.test.ts` | 太陽の子午線を回すと、昼側で弱まる区間が同じだけ回るテストを足す |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`。
- `npm run dev` で地球の北極を見下ろし、時刻を早送りすると、オーロラの濃淡が地球と一緒に回らず、
  太陽に対して止まって見える。

### 手順 6. エアグローを描画設定で切れるようにする

**目的**: エアグローは採用する。ただし見え方を大きく変える描画は描画設定で切れるようにする方針
なので、問題の切り分けのためにオフできるようにする。**切り替わるのは発光の項だけ**(決めたこと 7)。
仕様が先行するので `/modify-feature` から入る。

**これは負荷を下げる設定ではない。** 積分区間も刻みも、発光の項の計算そのものも、オフのまま残る。
オフで消えるのは絵だけで、そこが切り分けに要る性質でもある。

SPEC に足す文面(RENDERING.md「描画品質設定」節、「大気」の項の後):

> - **エアグロー**: 夜側の地球の縁に淡く光る大気発光を描くかどうか。オフでも大気の積分の範囲と
>   刻みは変わらず、発光の項だけが消える。

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md:155-` | 上の文面を足す |
| `src/render/graphics-settings.ts` | `airglow` を足す(`kind: 'toggle'`、`group: 'element'`、ラベル「エアグロー」、プリセットは低・中・高すべて true — 今の見え方を既定に保つ) |
| `src/render/atmosphere.ts` | `withAirglowEnabled(optics, enabled)` を足す。オンか `optics.airglow === undefined` なら optics をそのまま返し、オフなら `airglow.strength` だけを 0 にした光学を返す。**`altitude` と `scaleHeight` は残す** — `cutoffAltitude` がそれだけを見るので、打ち切り高度がオンのときと一致する |
| `src/render/celestial/celestial-entity/celestial-view.ts:114` | `optics` を `withAirglowEnabled(optics, graphics.airglow)` にする。1 行下の `clouds: graphics.clouds ? … : null` と同じ、候補を組む時点での描画設定の適用 |
| `tests/render/atmosphere.test.ts` | オフの光学の打ち切り高度がオンのときと一致し、かつ `airglow.strength` が 0 になるテストを足す。既存の 2 本(16-28 行)は光学の契約を見ているので残す |

`atmosphere-integrator.ts:192-202` と `celestial-illumination.ts:190` は触らない。強さ 0 は既存の
`else` の枝をそのまま通り、`atmosphereDraws` の入力(打ち切り高度・天頂光学的厚み)はどちらも
エアグローで変わらないので、サンプル点の配分も同じになる。

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`。
- `npm run dev` で夜側の地球の縁を見て、描画設定の「エアグロー」を切ると緑の帯が消え、入れると戻る。
  **帯以外は変わらない** — 縁の外側の大気の裾の切れる位置も、昼側の空の色も動かない。

### 手順 7. 表面雲の GPU 時間を G バッファから分ける

**目的**: 表面雲も雲影と同じくレイマーチで、G バッファの値に混ざっていると重さを読めない。手順 8 で
LOD を潰す前後と cap へ移す前後の費用を比べる物差しにもなる。仕様が先行するので `/modify-feature`
から入る。

SPEC の直し(RENDERING.md:246 の GPU パスの列挙): 「雲の生成/雲大気/雲影」を
「雲の生成/表面雲/大気(雲あり)/雲影」にする。

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md:246` | 上の直し |
| `src/render/gpu-timings.ts:6-46` | `GPU_PASS.cloudSurface` と表示名「表面雲」を足す。「雲大気」を「大気(雲あり)」へ改める。`CLOUD_GPU_MEASUREMENTS.surface` を `{ pass: GPU_PASS.cloudSurface, scope: 'exact' }` にし、その上のコメントを直す |
| `src/render/pipeline/lit-layer.ts` | 雲殻用のレイヤー定数と、そこへ置く関数を足す。`LIT_OPAQUE_LAYER` と同じくチャンネル 0 から外す |
| `src/render/opaque-cloud-surface-renderer.ts:83` | `markLitOpaque` を雲殻用のものへ替える |
| `src/render/pipeline/gbuffer.ts:100-125` | `render()` を2回に分ける — `LIT_OPAQUE_LAYER` を `GPU_PASS.gbuffer` で描き、雲殻のレイヤーを**クリアせずに**同じ描画先へ `GPU_PASS.cloudSurface` で描く。`compile()` も両方のレイヤーを事前コンパイルする |
| `tests/render/cloud-mip-contract.test.ts:24-` | GPU 計測のテストを `tests/render/gpu-timings.test.ts`(新規)へ移し、表面雲の計測範囲を `exact` へ直す。ミップのテスト(10 行)はこのファイルに残し、手順 8 でファイルごと消す |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`。
- `git grep -n "gbuffer aggregate" -- src tests` が 0 件。
- render-lab の地球で `measure()` を取り、変更前と比べて「Gバッファ」が減り、「表面雲」が 0 でなく、
  2 つの和が変更前の「Gバッファ」とほぼ等しい。`render-lab:shot` の絵が変更前と変わらない。

### 手順 8. 雲場の LOD を潰し、雲場を視点中心の正射影で焼く

**目的**: 雲場の LOD をすべて潰して素朴な実装にし、雲場を視点中心の正射影の cap へ移す。全球の正距円筒
という図法の選び方が、LOD の積み重ねと極・日付変更線の破綻の根にある。**計画の本体は
fix_cloud_projection.md。** ここではその全手順を実施する。

| 対象 | 何をするか |
| --- | --- |
| `memos/hedalu244/fix_cloud_projection.md` | 手順 1〜6 を上から実施する。#72 のミップ・ヒステリシス・診断つまみ(6ef4b264・6ff95106・13090f9a のミップ部分)の撤去は、その手順 2 に含まれる |

**達成条件と検証**: fix_cloud_projection.md の達成目標がすべて満たされている。

## 見積り

行数はすべて PR #72 の差分(`git diff --stat b9b6f9d8 04963d5d`)と、`origin/main` の実測から。

| 手順 | 削除(git 操作) | 手作業で編集するファイル |
| --- | --- | --- |
| 1 | — | 1〜2(数行) |
| 2 | — | 3(field-projection.ts の約 40 行、ほか数行) |
| 3 | revert 2 本(+81 行 / −55 行)、削除 3 ファイル(約 450 行) | 約 9 |
| 4 | — | 5(手本の差分 248 行を手で戻す) |
| 5 | — | 2 |
| 6 | — | 5(SPEC を含む。積分器と照明は触らない) |
| 7 | — | 7(SPEC を含む。テスト 1 本を新規へ移す) |
| 8 | fix_cloud_projection.md の「見積り」 | 同左 |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| PR を squash でマージする | 手順 3 の撤去 commit の hash が変わり、fix_surface_lod.md 手順 5 の revert が別の変更まで巻き戻す | 手順 3 |
| 撤去 commit に修正を混ぜる(サングリント) | 保護ブランチがその commit を revert したとき、修正も一緒に戻る | 手順 1、3 |
| fix_surface_lod.md 手順 5 の revert 対象に手順 3 を含め忘れる | 保護ブランチから月別気候が消える。タグ `pr72-merged` からは読めるが、追随した形では失われる | 手順 3 |
| c16347e0 の revert がクリーンに通ったのを完了と見なす | 戻った class `ClimateMap` が、0e4a1eb1 で改名された同名の interface と衝突する。typecheck で初めて落ちる | 手順 3 |
| 平年の気候画像を楕円体の uv のまま読む | 緯度が最大 0.19° ずれ、気候と雲がわずかに食い違う。絵ではほぼ見分けられない | 手順 2、3 |
| 月別の値域定数 `CLIMATE_*` を「使われているかもしれない」と残す | 呼び手 0 の定数が残る。typecheck は通る | 手順 3 |
| 手順 3 で `EarthSurfaceSource.climateMapUrls` まで消す | 地表タイルは main に残っているので、その配信物の契約とテストが壊れる。呼び手 0 のまま残すのが正しい | 手順 3 |
| サングリントを render-lab で確かめる | render-lab は自前の地球で滑らかさマップを使い続けている(cases.ts:656)ので、直っていなくても光る | 手順 1 |
| `b9b6f9d8` の worktree で render-lab を撮るとき、node_modules をジャンクションで借りる | ビルドは通るが、worktree を消すときに先にジャンクションを外さないと本体の node_modules まで消える | 手順 4 |
| render-lab:shot を撮る | 撮影の副作用で memos の baseline.json が書き換わる。stash pop も黙って失敗する | 手順 4、7、8 |
| render-lab の撮影が単色に写る | テクスチャの読み込みを待たないため。壊れた印ではない。待つなら `capture()` で撮る | 手順 4、7、8 |
| 太陽の子午線を地理経度のまま渡す | 磁極の偏り(北緯 80.65°・西経 72.68°)のぶん昼夜の境が回ってずれる。目では気付きにくい | 手順 5 |
| エアグローのオフで `optics.airglow` を `undefined` にする | 打ち切り高度(約 127 km → 115 km)と刻みまで一緒に動く。オンオフの差が発光由来か積分の粗さ由来か分けられず、切り分けにならない | 手順 6 |
| エアグローのオフを「軽くなる設定」として測る | 積分区間も刻みも発光の項の計算も残るので、GPU 時間はほぼ変わらない。負荷の切り分けには使えない | 手順 6 |
| 2 回目の G バッファの `render()` がクリアする | 1 回目に描いた地表・艦艇が消え、雲だけが写る | 手順 7 |
| 雲殻を別レイヤーに移したあと、`compile()` が雲殻のレイヤーを含めない | 初めて雲が出たフレームでシェーダのコンパイルが走り、止まる | 手順 7 |
| 手順 7 で GPU 計測のテストを移さずに、手順 8 で cloud-mip-contract.test.ts を消す | 雲の計測範囲を固定するテストが黙って消える | 手順 7、8 |
