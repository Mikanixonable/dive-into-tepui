# 雲場を視点中心の正射影で焼く

行番号はすべて `origin/main` = `713755b1` 時点のもの。**この計画は fix_PR72.md の手順 1〜7 を
終えてから着手する**(fix_PR72.md の手順 8 がこの計画を指す)。着手時には fix_PR72.md の手順で
行がずれているので、行番号は目安にして関数名・識別子で当たり直す。地表 LOD の後始末
(fix_surface_lod.md)は保留中で、この計画の前提には入らない。

## 目的

地球の生成雲場は全球の正距円筒(`EquirectProjection(512)`、1024×512 texel)で焼かれている。

- 1 texel は赤道で π/512 rad ≈ 39 km。高緯度ほど経度方向だけが無駄に細かくなり、極で退化する。
  経度 ±180° には継ぎ目がある。
- 見えている範囲に関係なく、全球を同じ細かさで焼いている。細かさの不足を補うために、雲場の
  ミップ・読み手ごとの明示段(`lodForWidth`)・殻の段のヒステリシス・中間場の粗焼き
  (`coarsenessFor`)が積み重なっている。雲の品質が落ちた一因がそこにあり、仕組みが絡み合って
  いてデバッグできない。
- 雲場の読み手のうち大気(`cloud-atmosphere-renderer.ts:114`)と影(`cloud-shadow-renderer.ts:44`)は、
  雲場のテクスチャだけを受け取り、既定の uv(`sphereMeshUv`)で読んでいる。雲殻が使う投影の
  `uvAt` とは別の式である。u は両者で一致するが、v は `sphereMeshUv` が北極で 1、
  `equirectUvFromDirection` が北極で 0 と逆向きになっている。描画先テクスチャの行の向き次第で、
  実際に影と大気の雲が南北の鏡映しになっているかは**未確認**。

これを、**カメラの直下点を中心とする正射影の cap**(`OrthographicCap`)で焼く形に替える。
cap の半径は、見えている雲頂の地平線に余白を足した角にする。

- 極にも日付変更線にもアーティファクトが出ない。
- 見えている範囲だけを焼くので、texel は高度に応じて自ずと細かくなる。LOD の仕組みは要らない。
- 読むときの座標変換が `dot` 2 回で済む。

**LOD の仕組みは cap へ移る前に一度すべて潰し、素朴な実装にする。** 変な LOD が残っていると
デバッグできない。調整は cap の上で別の方向から行う(末尾の「調整の todo」)。

修正後の状態:

- 地球の生成雲場と実写の雲場は、どちらも同じ 512×512 の cap に焼かれる。
- 雲殻・大気・影の読み手は、同じ cap の置き方(中心・東・北・半径)で読む。cap の外は「雲なし」になる。
- 雲場のテクスチャはミップを持たない。読み手は段を選ばない。
- 全球の正距円筒は cloud-lab の左の面(全球の雲の動きを確かめる面)にだけ残る。

### SPEC に足す文面

`DEVELOP/SPEC/RENDERING.md`「雲の描画」節の「どの距離からでも破綻しない」の項を次のように直し、
その直後に 1 項を足す。

> - **どの距離からでも破綻しない。** 太陽系を見渡す距離では雲は地表の模様として分布だけが見え、
>   近づくほど層・起伏・細部が現れる。近づいたときにだけ現れる要素が、遠ざかるときに跳んで
>   消えてはならない。**細かさは視点の高さに応じて連続に変わり、段が切り替わる瞬間は見えない。**
> - **雲の分布に、極や経度 180° の線に沿った継ぎ目・放射状の筋が立たない。**

## 決めたこと

**すべて覆せる。** 覆したときにどの手順が変わるかを併記する。

### 1. cap の中心は直下点、半径は雲頂の地平線 + 余白で、π/2 で止める

中心は、天体中心から見たカメラの向き(殻の空間 — 天体固定へ回して半軸で割った単位球の空間。
雲殻・影・大気の読み手が方向を取るのと同じ空間)。

半径は `θ = min(π/2, acos(1/ρ) + acos(1/(1 + h/R)) + M)`。

- ρ はカメラの中心距離を殻の空間で測った値(地表が 1)。ρ < 1 にはならないが、念のため 1 で止める。
- h は雲頂の上限 `CLOUD_TOP_SPAN` = 15 km、R は赤道半径。第2項 ≈ 3.9° は、雲頂が地面の地平線より
  先まで見える分。
- M は外周の余白(→ 決めたこと 8)。

**上限が π/2 なのは、正射影の半径 sin θ が θ ≤ π/2 でしか単調でないから。** それを越えると `uvAt`
は裏側の半球を表側と同じ uv へ写す(`OrthographicCap.aim` の前提も `0 < radius ≤ π/2`)。そのため
遠方では余白が取れない。高度 20,000 km で地平線は 76° なので、余白は最大 14° になる。

cap の中心は視線の向きではなく直下点に置く。見える円板は直下点を中心にしているため。

**覆されたら**: 遠方の縁でアーティファクトが許せない場合は、半径が大きいときだけ別の方位図法
(正距方位など)へ切り替える。手順 3 の field-projection.ts・cloud-field-sampler.ts が変わる。

### 2. cap の大きさは 512×512 に固定する

| | texel 数 | 中心の 1 texel |
| --- | --- | --- |
| 今の正距円筒 1024×512 | 524,288 | π/512 rad ≈ 39 km(赤道) |
| cap 512²、遠方(θ = 90°) | 262,144 | 2 sin90° / 512 = 3.9e-3 rad ≈ 25 km |
| cap 512²、高度 400 km(θ = 19.8° + 3.9° + 5° ≈ 28.7°) | 262,144 | 2 sin28.7° / 512 = 1.9e-3 rad ≈ 12 km |

焼く量が半分のまま、どの高度でも今より細かくなる。

**覆されたら**: 1024² にすると texel 数は 4 倍。手順 3 の `CLOUD_CAP_SIZE` を変えるだけ。

### 3. 潰す LOD と、残すフィルタの線引き

**潰すのは「雲場のテクスチャをどの細かさで読むかを読み手が選ぶ仕組み」と、「構築時の図法の細かさに
縛られた最適化」。** 標本化定理から来るフィルタと、雲場と関係のない仕組みは残す。

| 仕組み | 扱い | 理由 |
| --- | --- | --- |
| 雲場の写しのミップ(`BakedField` の `generateMipmaps`) | 潰す | 読み手が段を選ぶ前提そのもの |
| 読み手の明示段(`lodForWidth`・`fieldTexelWidth`・`sampleCloud` の `lod` 引数) | 潰す | 同上 |
| 段の上限・固定段(`maxMipLevel`・`fixedLod*`・`setLodSampling`・`CloudLodMode`) | 潰す | 同上 |
| 雲殻の段のヒステリシス(`sphereLodLevelWithHysteresis`) | 潰す | 雲だけが持つ段の切り替え規則 |
| 青色ノイズの切り替え(`setCloudBlueNoiseEnabled`) | 潰す | ミップ・固定 LOD と見比べるための診断つまみ。刻みずらしは常にオン |
| 中間場の粗焼き(`coarsenessFor` と `BakedField` の `coarseness` 引数) | 潰す | 構築時の `texelAngleValue` で解像度が決まり、cap の半径が動くと食い違う |
| ノイズの段のフェード(`CirculatingNoise` の振幅) | **残す** | texel より細かい段を消すフィルタ。cap が縮むほど細部が連続に現れる — これが「適応」の本体 |
| 粒の画素フェード(雲殻の `grainAmplitudeAt`、影の `grainAmplitudeForWidth`) | **残す** | 手続きの粒のモアレを消すフィルタで、雲場の読み方ではない |
| 積雲の精細さ(描画設定) | **残す** | レイマーチの刻み数。品質設定 |
| 雲殻の球メッシュの分割段(`sphereLodLevel`) | **残す** | 天体の表面と共通の段。雲殻はレイマーチの入口にすぎない |

**覆されたら**(フィルタも潰す場合): 手順 2 に `circulating-noise.ts` と粒の振幅を足す。
モアレが出ることは受け入れる。

### 4. 実写の雲も同じ cap へ焼き直す

読み手の契約を cap 1 つにするため。実写の画像(正距円筒)は、cap の置き方が変わるたびに同じ cap の
写しへ焼き直す。**画像のどの段を読むかは、焼くときに1回だけ決める** —
`max(0, log2(cap の texel 角 / 画像の texel 角))`。画像の texel 角は π / 画像の高さ。
画面微分に任せると、経度の巻き目(u が 1 → 0 へ跳ぶ列)で最も粗い段が選ばれ、日付変更線に線が出る。

**覆されたら**: 実写を全球の画像のまま読むなら、読み手に 2 通りの uv と画像のミップが要る。
手順 3 の cloud-field-sampler.ts が分岐を持つ。

### 5. 読み手は cap の置き方を毎フレーム写し取る

雲場を出す側(`CloudPresentation`)は、テクスチャと cap の置き方(中心・東・北の単位ベクトルと
sin 半径・cos 半径)の組を毎フレーム公開する。名前は仮に `CloudFieldBinding` とし、実施時に
CODING-RULE で決め直す。

読み手(雲殻・大気・影)は自前の `CloudFieldSampler` を持ち、その uniform へ値を写す。グラフは一度
組めば済み、出どころを切り替えても組み直さない(両方の出どころが同じ cap に焼くため)。
cap の外(`dot(方向, 中心) < cos θ`)は「雲なし」の標本を返す。

1フレームの順序は次のとおりで、すべて同じフレームの中で揃う。

1. `CelestialSystem.sync` の天体ビューのループ(celestial-system.ts:388-391)→
   `PointCelestialView.syncResolved` が cap を置く。
2. 同じ `sync` の `illumination.sync`(399 行)が影と大気へ置き方を渡す。
3. `game.ts:544` の `bakeClouds` が焼く。

### 6. cap は毎フレーム置き直し、格子へ吸着させない

素朴な実装を先に置く。中心が動くたびに texel の格子が動き、texel 程度の細かさが這うように揺らぐ
可能性がある(低軌道 7.7 km/s で 1 フレーム 128 m、texel 12 km の約 1%)。手順 4 で見て、吸着は
「調整の todo」へ回す。

### 7. 全球の正距円筒は cloud-lab にだけ残し、本番に切り替えの設定は置かない

rendering-workflow の方針(置き換える前の簡易実装を描画設定で選べるように残す)の例外にする。
全球の正距円筒は全球の雲の動きを確かめるための面で、設計の筋が悪く、本番に投入すべきものではない。
軽い代わりには「雲の分布: 実写」が既にある。

**覆されたら**: 描画設定に「雲場の図法」を足す。読み手は 2 通りの uv を持つことになり、手順 3 の
cloud-field-sampler.ts が分岐する。

### 8. 外周の余白は M = 5° で入れ、手順 4 で測って決める

外周が崩れる原因は、風上へ遡って中間場を読む処理が cap の外へ出ること。遡る距離の見積りは次のとおり
(距離 = 風速 × 時間 / R)。

| 遡る処理 | 時間 | 風速の仮定 | 距離 |
| --- | --- | --- | --- |
| 気団の追跡(`air-mass.ts:20` `TRACE_SECONDS`) | 36 h | 地表付近 20 m/s | 2,590 km ≈ 23° |
| 上層の湿度の移流(`weather-transport.ts:48, 52`、重み 1 の半周期) | 10 h × 1.6 | 上層 40 m/s | 2,300 km ≈ 21° |
| 対流の移流(`weather-transport.ts:50`) | 10 h × 1.3 | 20 m/s | 940 km ≈ 8.5° |

余白 5° では、崩れが縁だけでなく円板の内側まで届く可能性がある。手順 4 で崩れの届く角を測る。
余白で覆えないときは、中間場だけを広い cap で焼く(手順 5)。

## 達成目標

1. 地球の生成雲場と実写の雲場が、`CloudPresentation` の持つ 512×512 の `OrthographicCap` へ焼かれる。
   `git grep -n "EquirectProjection" -- src` が field-projection.ts の定義だけになる。
2. 次が **0 件**。
   `git grep -nE 'maxMipLevelOf|maxAvailableMipLevelOf|lodForWidth|fieldTexelWidth|CloudLodMode|setLodSampling|setCloudLodSampling|setCloudBlueNoiseEnabled|sphereLodLevelWithHysteresis|coarsenessFor' -- src tools tests`
3. `src/render/cloud/baked-field.ts` と `observed-cloud-field.ts` の写しが `generateMipmaps: false`。
4. 次が **0 件**(読み手がテクスチャだけを受け取らない)。
   `git grep -n "readonly field: THREE.Texture" -- src/render`
5. `git grep -n "sphereMeshUv" -- src/render/cloud src/render/pipeline` が **0 件**。
6. **目視**(`npm run dev`)で次を確かめる。
   - 高度 400 km から地平線を見ると、地平線まで雲がある。
   - マップビューの遠方からは、地球の見えている円板の全体に雲がある。
   - 極を見下ろしても放射状の筋が無く、経度 180° に継ぎ目が無い。
   - 雲影が雲の真下に落ちる。
7. 雲の生成の GPU 時間を手順 2 の前と手順 3 の後に測り、「見積り」の欄が実測で置き換わっている。
8. `npm run typecheck`・`npm run test:render`・`npm run test:game` が通る。

## 手順

### 手順 2. 雲場まわりの LOD を潰す

**目的**: 決めたこと 3 の「潰す」をすべて外し、素朴な実装にする。図法はまだ全球の正距円筒のまま。
遠方で雲場を 0 段で読むため、遠くの雲が細かく揺らぐ(エイリアス)可能性がある。特に実写の 8k 画像は、
手順 3 で cap へ焼き直すまでエイリアスが出る。

| ファイル | 何をするか |
| --- | --- |
| `src/render/cloud/baked-field.ts:10-25, 35-64` | `maxMipLevelOf`・`maxAvailableMipLevelOf` を消す。描画先を `generateMipmaps: false`・`LinearFilter` にする。`coarseness` 引数を消し、写しは常に投影と同じ大きさにする。`GPU_PASS.cloudBake`(73 行)は残す |
| `src/render/cloud/cloud-field-sampler.ts` | `fieldWidth`・`maxMipLevel`・`fixedLodMode`・`fixedLod`・`setLodSampling`・`CloudLodMode`・`lodForWidth`・`fieldTexelWidth` と、`sample`/`sampleCloud` の `lod` 引数を消す |
| `src/render/cloud/circulating-noise.ts:29-32` | `coarsenessFor` を消す |
| `src/render/cloud/weather-transport.ts:78-94` | 粗焼きをやめ、ノイズの texel 角は `projection.texelAngle` をそのまま渡す |
| `src/render/cloud/convective-activity.ts:47-51` | 同上 |
| `src/render/cloud/weather-model.ts:186-187`、`air-mass.ts:55-56`、`cloud-field.ts:21` | `BakedField` の `coarseness` 引数を消したのに合わせる |
| `src/render/cloud/cumulus-shape.ts:14-18` | `EMPTY_CLOUD_FIELD` の `minFilter` を `LinearFilter` にする。グラフは差し込んだテクスチャのフィルタで組まれるので、本物とフィルタを揃える |
| `src/render/cloud/observed-cloud-field.ts:26-32` | `prepare` の「読める mip 段を寸法から引き直す」をやめる。世代の追跡が `setTexture` の張り替えにまだ要るかを確かめ、要らなければ消す |
| `src/render/cloud/cloud-presentation.ts:9, 60-63` | `setLodSampling` を消す |
| `src/render/opaque-cloud-surface-renderer.ts:12, 17-19, 106-109, 111-112, 135-142` | `setLodSampling` を消し、`sphereLodLevel` で段を選ぶ |
| `src/render/celestial/screen-lod.ts:70-` | `sphereLodLevelWithHysteresis` を消す |
| `src/render/pipeline/cloud-atmosphere-renderer.ts:11, 142-144, 182-190` | `setLodSampling` を消し、`fieldAt` は段を渡さずに読む。`footprint` がほかで使われていなければ、`scatteredAt` とその呼び手(atmosphere-cloud-layers.ts)から外す |
| `src/render/pipeline/atmosphere-cloud-layers.ts:7, 63-64` | `setLodSampling` を消す |
| `src/render/pipeline/atmosphere-integrator.ts:17, 168-175`、`atmosphere-pass.ts:17, 114-119` | `setCloudBlueNoiseEnabled`・`setCloudLodSampling` と、それが立てる uniform を消す |
| `src/render/pipeline/shadow/shadow-pass.ts:18, 122-123` | `setCloudLodSampling` を消す |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts:8, 74-76, 105-110, 118, 147-157, 162-165` | `setLodSampling`・`fieldLod` を消し、`fieldAt`・`receiverFloorAltitude` から `lod` を外す。`sampleWidth` は粒の振幅にだけ使う |
| `src/render/pipeline/render-pipeline.ts:105-112` | 2 つの口を消す |
| `tools/render-lab/lab.ts:225-227`、`cases.ts:132, 641, 702, 737, 756, 785, 869`、`main.ts` | 同上の口とつまみを消す |
| `tools/render-lab-cloud-sampling-compare.mjs` | 削除 |
| `package.json` | `render-lab:cloud-sampling` を消す |
| `tests/render/cloud-mip-contract.test.ts` | 削除(GPU 計測のテストは fix_PR72.md 手順 7 で `gpu-timings.test.ts` へ移してある) |
| `tests/render/cloud-lod-comparison.test.ts` | 削除 |
| `tests/render/screen-lod.test.ts:19-90` | ヒステリシスのテストを消す。11・91 行のテストはヒステリシス API を使っていれば直す |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`、`npm run test:game`。
- 達成目標 2 の検索が 0 件。
- 着手前に render-lab の地球で `measure()` を取り、「雲の生成」「表面雲」「大気(雲あり)」「雲影」を
  控える(手順 3 との比較の基準)。
- `npm run render-lab:shot` の地球で雲殻・雲影・大気の雲が出る。

### 手順 3. 本番の雲場を視点中心の cap にする

**目的**: 図法・読み手の契約・実写の焼き直しを一度に切り替える。途中の状態が成り立たないため
(置き方を知らない読み手は cap を読めず、全球の画像は cap の読み手が読めない)。

| ファイル | 何をするか |
| --- | --- |
| `src/render/cloud/field-projection.ts`(`OrthographicCap`) | 置き方(中心・東・北の値と sin 半径・cos 半径)を読み手向けに公開する。単位方向で置く口を足す(緯度・経度へ直して既存の `aim` を呼ぶ — 極で東向きが退化しないため)。uv の式(`uvAt`)を、読み手と共有できる関数へ出す |
| `src/render/cloud/cloud-cap.ts`(新規) | 決めたこと 1 の半径の式を純関数で持つ(`capRadiusFor(ρ, h/R, M)`)。`CLOUD_CAP_SIZE = 512` と `CLOUD_CAP_MARGIN = 5°` |
| `src/render/cloud/cloud-field-sampler.ts` | cap の読み手にする。uniform に中心・東・北・sin 半径・cos 半径とテクスチャを持ち、`bind(binding)` で写す。uv は field-projection.ts と共有する式で引き、cap の外では「雲なし」を返す。`uvAt` の注入と `sphereMeshUv` の既定を消す |
| `src/render/cloud/cloud-presentation.ts` | `OrthographicCap(CLOUD_CAP_SIZE)` を1つ持ち、両方の出どころへ渡す。`aim(直下点の向き, ρ)` で半径を決めて置き直す。テクスチャと置き方の組(`CloudFieldBinding`)を公開する。`CloudFieldSource` から `sampler` を外す |
| `src/render/cloud/generated-cloud-field.ts` | 投影を受け取る形は変えない。置き方の版が変わると焼き直す(既存の `revision`) |
| `src/render/cloud/cloud-field.ts` | `at(direction)` は自分の投影の `uvAt` でテクスチャを直に読む(cloud-lab 用)。パイプラインの読み手は使わない |
| `src/render/cloud/observed-cloud-field.ts` | 画像を同じ cap の `BakedField` へ焼き直す(決めたこと 4)。画像の世代か cap の版が変わったときだけ焼き、`GPU_PASS.cloudBake` へ計上する |
| `src/render/opaque-cloud-surface-renderer.ts:65-67, 111-117, 288-291` | 自前の `CloudFieldSampler` を持ち、presentation の組を毎フレーム `bind` する。`setFieldSampler` を消す |
| `src/render/atmosphere.ts:88-94` | `AtmosphereClouds.field: THREE.Texture` を `CloudFieldBinding` にする |
| `src/render/pipeline/cloud-atmosphere-renderer.ts:130-135` | `bind` で写す |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts:15-25, 60-69` | `ShadowCumulus.field` を `CloudFieldBinding` にし、`bind` で写す |
| `src/render/celestial/celestial-entity/point-celestial-view.ts:110-139, 143-169` | `syncResolved` で、カメラの位置から天体中心を引いて天体固定へ回し(`group.quaternion` の逆)、半軸で割って直下点の向きと ρ を求め、`cumulus.aim` へ渡す。`cumulusShadowAt`・`atmosphereCloudsAt` は組を返す |
| `src/game/celestial/solar-system/earth-system.ts`(`earthGeneratedCloudField` と `earthSystem`) | `earthGeneratedCloudField(projection)` は投影を必須にする(実験環境と本番が同じ工場で組む口として残す)。地球の `CloudPresentation` は、cap を1つ作って生成と実写の両方へ渡す工場で組む |
| `tools/render-lab/cases.ts:634-700`(`earthAt`) | 同じ工場で組み、ケースのカメラ(原点)から見た直下点の向き(`-center` を `spin` の逆で回したもの)で `aim` する。`clouds`・`cumulus` は組を渡す |
| `tools/cloud-lab/lab.ts:82-88`、`pane.ts`、`views.ts` | 左の面は `earthGeneratedCloudField(new EquirectProjection(VIEW_HEIGHT))`、右は `earthGeneratedCloudField(this.capProjection)` で組む。面は `sampler` ではなく `CloudField.at` で読む |
| `src/render/graphics-settings.ts:80-83` | 「実写は焼かないぶん軽い」のコメントを直す(実写も cap へ焼き直す) |
| `tests/render/cloud-field-sampler.test.ts` | 注入のテストと楕円体のテストを消す |
| `tests/render/cloud-cap.test.ts`(新規) | 半径の式を固定する。高度 400 km で 19.8° + 3.9° + M、遠方で π/2 に止まる、ρ = 1 でも正 |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`、`npm run test:game`。
- 達成目標 1・3・4・5 の検索。
- `npm run cloud-lab:shot` で左右の面の見え方が手順 2 のあとと変わらない。
- `npm run render-lab:shot` の地球の俯瞰・斜視の両ケースで、雲殻の真下に雲影が落ち、大気の中の雲が
  雲殻と重なる。「雲の分布: 実写」でも同じ。
- `npm run dev` で達成目標 6 を確かめる。
- render-lab の `measure()` を取り、手順 2 で控えた値と並べて「見積り」を実測で置き換える。

### 手順 4. 外周の崩れと置き直しの揺れを測り、余白を決める

**目的**: 決めたこと 8 の余白 M を実測で決め、中間場を広げる要があるか(手順 5)を判定する。
コードは変えない(撮影と集計は scratchpad の自前スクリプトで行い、リポジトリへ入れない)。

| 対象 | 何をするか |
| --- | --- |
| cloud-lab(`aimCap` を CDP から叩く自前スクリプト) | 高度 400 km の半径で cap を置き、同じ表示時刻で左の全球の面と右の cap の面を撮る。同じ方向の被覆率の差を、cap の縁からの角距離ごとに平均する。差が円板の中心付近の値まで落ちる角を「崩れの届く角」とする。表示時刻を 0・6・12・18 h の 4 通りで取る |
| `npm run dev` | 高度 400 km・時間加速 1 倍で直下点付近の雲を 10 秒見て、texel 程度の這う揺らぎが見えるかを記録する。マップビューの遠方から、地球の縁に崩れが見えるかを記録する |

**判定**:

- 崩れの届く角 ≤ 5° → `CLOUD_CAP_MARGIN` をその角の切り上げにして終わる。手順 5 は飛ばす。
- 崩れの届く角 > 5° → 手順 5 を行う。

**達成条件と検証**: 4 通りの時刻の崩れの届く角と、揺らぎ・縁の観察結果が、この計画の「見積り」の
欄に書き込まれている。

### 手順 5. (手順 4 で要ると判定したときだけ)中間場を広い cap で焼く

**目的**: 風上へ遡って読まれる中間場だけを、見えている cap より広い cap で焼き、外周の崩れを
円板の外へ追い出す。最終の雲場は見えている cap のまま。

| ファイル | 何をするか |
| --- | --- |
| `src/render/cloud/weather-model.ts:176-191` | 中間場の投影と、雲場の投影を別に受け取る |
| `src/render/cloud/weather-transport.ts`、`air-mass.ts`、`convective-activity.ts` | 中間場の投影で焼く |
| `src/render/cloud/cloud-presentation.ts`、`cloud-cap.ts` | 広い cap(半径 `min(π/2, θ + 遡る距離)`)を持ち、同じ直下点へ同時に置く |
| `tests/render/cloud-cap.test.ts` | 広い cap の半径の式を足す |

**トレードオフ**: 広い cap は texel が粗い。半径 45° で 512² なら 2 sin45° / 512 = 2.8e-3 rad ≈ 18 km で、
対流の最細の段(24 km、`weather-transport.ts:29`)は Nyquist(36 km)より細かく、フェードで消える。
対流の源は遡る距離が短い(≈ 8.5°)ので、見えている cap に残して余白を 8.5° 以上に取るか、中間場の
cap を 1024² にするかを、ここで決める。

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`。
- 手順 4 の測定をやり直し、崩れの届く角が `CLOUD_CAP_MARGIN` 以下になる。

### 手順 6. 規約とコメントを点検する

**目的**: 雲場の契約が変わり、LOD の説明が残るコメントが多い。規約からの逸脱と焼け残ったコメントを
消す。**この時点で挙動は変えない。**

| 対象 | 何をするか |
| --- | --- |
| 手順 2〜5 で触ったファイル | `/refactor` と `/comment-cleanup` を通す。特に「mip 段」「lod」「画面微分で段を選ぶ」を説明するコメント(cloud-field-sampler.ts:1-2・57-58、cloud-shadow-renderer.ts:85・147-154、cloud-atmosphere-renderer.ts:182-184、opaque-cloud-surface-renderer.ts:171-172、cumulus-shape.ts:2) |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`。
- `git grep -nE 'mip 段|ミップ段|lod を|明示 LOD' -- src/render/cloud src/render/pipeline src/render/opaque-cloud-surface-renderer.ts`
  が 0 件。

## 見積り

**雲の生成の GPU 時間**(焼く費用 ∝ texel 数 × 1 texel の式の重さ。1 texel の式の重さは図法によらない
と仮定):

- 今: render-lab の地球(既定=高、Intel iGPU)で 9.4〜14.4 ms。1024×512 = 524,288 texel。
- cap 512²: 262,144 texel なので 0.5 倍の 4.7〜7.2 ms。ただし次の 2 つで増える。
  - 中間場の粗焼きをやめる分は、今の 1024×512 では 0。湿度(最細 64)・対流(266)・不安定度(25)の
    どれも `coarsenessFor` の式(`max(1, 2^floor(log2(0.25 / (最細 × π/512))))`)で 1 になる。
    粗焼きが効き始めるのは、cap が縮んで texel 角が小さくなってから。
  - 実写の焼き直し。1 texel あたり画像を 1 回読むだけで、天気の式に比べて桁で軽い。
- 手順 3 で実測に置き換える。

**編集の量**(ファイル数は「変更が必要な箇所」の表から):

| 手順 | 編集 | 削除 | 新規 |
| --- | --- | --- | --- |
| 1 | 1 | — | — |
| 2 | 約 22 | 3(ツール 1・テスト 2) | — |
| 3 | 約 18 | — | 2(cloud-cap.ts・テスト) |
| 4 | — | — | —(scratchpad のスクリプト) |
| 5 | 約 6 | — | — |
| 6 | 手順 2〜5 で触ったもの | — | — |

**手順 4 の実測**(実施時に書き込む):

| 表示時刻 | 崩れの届く角 | 直下点の揺らぎ | 遠方の縁 |
| --- | --- | --- | --- |
| 0 h | | | |
| 6 h | | | |
| 12 h | | | |
| 18 h | | | |

## 調整の todo

この計画では行わない。素朴な実装で問題が見えてから、cap の上で調整する。

- 中心を約 1 texel の格子へ吸着させ、半径を段階で刻む(決めたこと 6 の揺らぎ)。`aim` は経度から
  東向きを組むので、極の近くを通ると格子が中心のまわりで速く回る。これも吸着で抑える。
- 大きさ(512²)を描画設定の段にする。
- 低軌道から地平線を見るとき、円板の半分はカメラの背後になる。中心を視線の側へ寄せる。
- ノイズの段のフェードは中心の texel 角で決めている。遠方(θ → π/2)の縁では半径方向の texel が
  1/cos θ 倍に粗くなり、縁でエイリアスが出うる。texel 角を位置ごとに取る。
- 遠方で π/2 を越える余白が要るなら、別の方位図法を検討する(決めたこと 1)。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| cap の外を読んだときに「雲なし」を返さない | 縁の値が外へ伸びる。裏側の半球では表側の雲を鏡映しに読み、影と大気に存在しない雲が出る | 手順 3 |
| 読み手が置き方を写す前に cap を置き直す(同期の順序を入れ替える) | そのフレームだけ、テクスチャと置き方が1フレームずれ、雲影と大気の雲が置き直しの量だけ跳ぶ。順序は `sync` のビューのループ → `illumination.sync` → `bakeClouds` | 手順 3 |
| 直下点の向きを殻の空間ではなく天体固定のまま取る | 扁平のぶん(最大 0.19°)中心がずれる。半径 25° の cap では目立たないが、読み手の空間と食い違う | 手順 3 |
| `coarsenessFor` を残したまま cap にする | 構築時の半径で中間場の解像度が決まり、半径が縮んでも粗いまま。型検査は通る | 手順 2 |
| `EMPTY_CLOUD_FIELD` のフィルタを、ミップを持たない本物と揃えない | グラフがミップ付きのフィルタで組まれ、差し替えた本物の読みに格子か黒が出る | 手順 2 |
| 実写の焼き直しで画像の段を画面微分に任せる | 経度の巻き目で最も粗い段が選ばれ、日付変更線に 1 本の線が出る | 手順 3 |
| cap の置き直しが毎フレーム焼き直しを起こす | 時間を止めていてもカメラが動く間は毎フレーム焼く(今は表示時刻が同じなら焼かない)。一時停止中の負荷が増える | 手順 3 |
| uv の式を field-projection.ts と cloud-field-sampler.ts に 2 つ書く | 片方だけ直すと、cloud-lab の右の面とゲームの雲がずれる | 手順 3 |
| cloud-lab と render-lab を、本番と別の組み立てで cap にする | 実験環境が本番を映さなくなる。地球の雲場の組み立て口は `earthGeneratedCloudField` だけにする | 手順 3 |
| render-lab の `earthAt` で `aim` し忘れる | cap が既定の向きに残り、ケースに雲が出ない(目で分かる) | 手順 3 |
| 遠方では余白が取れない(θ = π/2) | 移流の崩れが地球の縁に出る。縁は真横から見るので潰れて見えるが、消えはしない | 手順 4 |
| 遡る距離(20〜25°)が余白を大きく越える | 崩れが縁だけでなく円板の内側まで入り込む | 手順 4、5 |
| 中間場の cap を広げて texel が粗くなる | 対流の最細の段が消え、積雲の粒が失われる | 手順 5 |
| render-lab:shot で撮る | 撮影の副作用で memos の baseline.json が書き換わる | 手順 2、3 |
| cloud-lab の撮影を幅 1024 で読む | 行送りがずれ、半球の非対称などの偽の結果が出る。全球面を数値化する行送りは png.width(1536) | 手順 4 |
| fix_surface_lod.md 手順 5 の revert が、この計画の earth-system.ts・generated-cloud-field.ts・cloud-lab・render-lab の変更と衝突する | 保護ブランチでこの計画の形を崩して解くと、cap がそこでだけ巻き戻る | fix_surface_lod.md 手順 5 |
