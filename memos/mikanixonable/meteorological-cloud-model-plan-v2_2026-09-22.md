# 気象学的な雲モデルへの改修計画（第二版）

- 作成日: 2026-09-22
- 状態: 検査待ち
- 対象: 地球の生成雲、観測雲との互換層、雲の地表・大気・影描画、雲ラボと描画ラボ

## 1. 目的

宇宙から低軌道までの地球描画で、数百 km の気象構造と数 km の雲塊・穴・塔状発達・巻雲フィラメントが同時に読め、時間を進めても雲が世界座標上で連続して移流・発達・消散する雲モデルへ改修する。

見た目の変化を生まない内部置換は完了条件にしない。独立した光学成分、鉛直構造、局所ディテール、時間発展を、地表・大気・影の三つの描画経路が同じ状態から評価する。標準品質を基準に視覚品質、時間連続性、GPU 時間、メモリ量を測定し、性能のために要求したディテールを無効化して合格扱いにしない。

## 2. 設計上の決定

### 2.1 雲柱を四つの独立した光学成分で表す

生成雲の論理データは、既存テクスチャの空きチャンネルへ意味を詰め込むのではなく、次の二つの RGBA16F リソースとして保持する。

| リソース | R | G | B | A |
| --- | --- | --- | --- | --- |
| optical basis | 下層液水雲の鉛直光学的厚さ | 層状・中層・混相雲の鉛直光学的厚さ | 深い対流雲の鉛直光学的厚さ | 上層氷晶・かなとこ・巻雲の鉛直光学的厚さ |
| vertical profile | 下層雲頂高度 | 層状雲底高度 | 層状雲頂高度 | 対流雲頂高度 |

四つの光学成分は生成、格納、サンプリング、補間、描画まで独立させる。物理的な論理値は光学的厚さとし、必要なら格納時だけ対数符号化する。符号化と復号は一か所に集約し、各描画器が独自解釈を持たない。

### 2.2 数 km の形状は専用ディテール場で表す

気象場の低解像度テクスチャを高周波ノイズで飾るだけにはしない。可視範囲を覆う world-anchored な RGBA8 ディテール場を設け、次を独立に保持する。

| チャンネル | 意味 |
| --- | --- |
| R | 浅いセル状雲の密度変調 |
| G | 層積雲の open/closed cell と穴の変調 |
| B | 対流塔・雲頂バーストの変調 |
| A | 上層氷晶、かなとこ、巻雲フィラメントの変調 |

ディテールは画面座標や現在の cap UV ではなく球面上の安定 ID から生成する。個々の雲セルを CPU オブジェクトとして全地球に保持せず、可視域のディテール texel ごとに疎なイベント場を手続き的に評価する。

標準品質の目標解像度は 1536² とし、現在の近距離 cap では約 2.5 km/texel を狙う。粗品質は 768²、精細品質は 2048² とする。最終値は Step 5 の実測で、空間周波数の合格条件を保った範囲だけ調整できる。

### 2.3 時間発展は二つのキーフレームを移流補間する

光学・鉛直場とディテール場は前後二つの時刻を保持し、風で逆移流した座標を用いて補間する。離散時刻の乱数場を単純に切り替えたり、全域を同時にクロスフェードしたりしない。

- ディテール場の通常更新間隔: 2〜5 分
- 大規模場の通常更新間隔: 10〜20 分
- 高速時間進行時の更新上限: 実時間あたり 4 回
- 発生・成長・成熟・消散は連続した寿命曲線で表す
- 組織化対流だけは親イベントから娘イベントを派生させる
- cap の移動、更新 epoch、LOD 切替の境界に guard band と重複区間を設ける

### 2.4 三つの描画経路で密度と光学を共有する

CloudColumnField と CloudDetailField から、位置、高度、時刻、品質を入力として消散係数、単散乱アルベド、位相関数用パラメータを返す共通 CloudDensityEvaluator を設ける。

- 地表側の厚い雲面は高速化のための表現であり、雲の真値にはしない。
- 大気・低軌道側は短い 2.5D 密度積分で同じ雲を評価する。
- 雲影も同じ密度とディテールを粗い mip で積分する。
- 光学的厚さによる連続ブレンドを使い、三種類の描画器を閾値で切り替えない。
- 固定高度 shell に雲を貼らず、vertical profile の雲底・雲頂を使う。

### 2.5 気象形態は連続した重みで混合する

浅い海洋雲、層状雲、前線雲、深い対流、かなとこ、巻雲を排他的な enum で選ばない。安定度、湿度、収束、鉛直シア、対流強度、海陸・地形条件から連続した成分重みを作り、境界を滑らかに混合する。

最初から全形態を同時に実装せず、浅い海洋雲と深い対流の二つを縦切りで完成させてから、前線・上層氷晶へ拡張する。

## 3. 維持する振る舞い

- 雲表示のオン・オフ。
- 生成雲と観測雲の選択。
- 巻雲および半透明雲の表示設定。
- 積雲ディテールの off/coarse/standard/fine 設定。ただし内部では解像度、march、更新頻度の品質束へ写像する。
- 同一表示時刻、同一入力、同一 seed に対する決定性。
- 地表、大気、影が共通の雲状態を参照すること。
- 既存の大気散乱、照明、地球の昼夜表現との統合。
- 観測雲を選択した場合の外観と静止性。新しい論理契約へは adapter で接続する。
- 球面上の継ぎ目、cap の境界、カメラ移動で雲が破綻しないこと。

## 4. 全体の合格条件

### 4.1 固定評価シーン

次の三系列を固定し、参照画像、カメラ、太陽、露出、表示時刻、seed、品質設定を manifest に記録する。

1. 海洋の浅いセル状雲・層積雲。
2. 熱帯の深い対流・雲頂バースト・かなとこ。
3. 中緯度の前線帯・多層雲・巻雲。

各系列は約 6 時間、10 分間隔とする。参照は出典、取得日時、利用条件、切り出し範囲、再投影方法を記録した小さな crop とし、生成画像と同じ地上解像度、投影、カメラ、太陽、露出へ合わせてから比較する。参照の可視画像から光学的厚さを直接推定したとは扱わない。

参照解像度の根拠には、ひまわり 8/9 AHI の可視 0.5〜1 km、赤外 2 km、全球観測 10 分間隔を用いる。

- JMA AHI 観測仕様: https://www.data.jma.go.jp/mscweb/en/himawari89/space_segment/spsg_ahi.html
- Himawari Standard Data User's Guide: https://www.data.jma.go.jp/mscweb/en/himawari89/space_segment/fig/HS_D_users_guide_en_v13.pdf

### 4.2 画像・時間統計

生成結果と参照について次を測る。

- 雲量。
- 2〜8 km、8〜32 km、32〜256 km の空間帯域パワー。ただし再標本化後に 4 pixel 未満となる帯域は評価対象外とする。
- 連結成分の面積、等価直径、穴率、周長対面積比。
- 輝度および不透明度のヒストグラム。
- optical flow の速度と方向。
- 10、30、60、180 分 lag の時間相関。

各指標の距離は次で正規化する。

~~~text
D_m = |generated_m - median(reference_m)| / max(IQR(reference_m), epsilon)
~~~

- Step 2 の縦切り完了時: 対象二系列で中央値 D が基準実装の 70% 以下。
- 全体完了時: 三系列の集約中央値 D が基準実装の 70% 以下。
- どの系列も基準実装より 10% を超えて悪化しない。
- 数値指標を満たしても、代表画像と動画で数 km の構造が読めなければ不合格。

### 4.3 時間連続性と座標安定性

- epoch 境界のフレーム差分 p95 は、同じ時間間隔を持つ通常区間の差分中央値の 1.5 倍以下。
- 同じ世界位置・時刻を cap またはカメラ移動の前後で評価した差は、正規化値 2e-3 以下、または採用フォーマットの量子化誤差以下。
- 全地球同期の明滅、boiling、screen-space swimming がない。
- 高速時間進行でも移流方向と発達方向が逆転しない。

### 4.4 チャンネル独立性

- optical basis の eR、eG、eB、eA と混合入力を GPU で encode、sample、decode する round-trip テストを持つ。
- 非対象チャンネルへの漏れは 1e-3 以下、または RGBA16F の測定量子化誤差以下。
- alpha は定数であってはならず、上層氷晶成分だけを変えた入力が大気、地表、影へ独立に反映される。
- debug view で各 basis、各 profile、各 detail channel、最終密度を単独表示できる。

### 4.5 性能とメモリ

60 fps のフレーム予算を 16.67 ms、雲を無効にした GPU 時間を B0 とし、標準品質の雲予算を次とする。

~~~text
headroom = max(0, 16.67 ms - B0)
Bcloud = min(3.0 ms, 0.5 * headroom)
Bupdate = min(2.0 ms, 0.25 * headroom)
~~~

- Bcloud は安定フレームにおける cloudSurface、cloudAtmosphere、cloudShadow の合計 p95。
- Bupdate は cloudBake/detail 更新があるフレームの追加 GPU 時間 p95。
- standard は対象デバイスで Bcloud と Bupdate の両方を満たす。
- WebGPU timestamp-query が使えない環境は性能合格に数えず、「未計測」と記録する。これは WebGPU で optional feature である。
- GPU 時間を満たすために standard のディテール場、四成分、時間補間のいずれかを無効化してはならない。
- 雲所有の永続 GPU メモリは、気象中間場を含め standard 48 MiB 以下、fine 72 MiB 以下を目標とする。

最終場の概算は、optical basis と vertical profile を 512² RGBA16F の二時刻で約 8 MiB、detail RGBA8 の二時刻と mip を coarse 約 6 MiB、standard 約 24 MiB、fine 約 43 MiB とする。実装時は実アロケーションを列挙し、中間場を含めて上限を判定する。

WebGPU 仕様: https://www.w3.org/TR/webgpu/

## 5. 実施手順

各 Step は単独で commit でき、記載した検証に合格してから次へ進む。描画を変更する Step では、追加した再現 shot を残し、変更前を 2 回撮影して基準を固定し、変更後を同じ条件で撮影して render-lab の比較を行う。許容 envelope を外れた shot は理由を説明してから進む。

### Step 1. 仕様、参照系列、基準値を固定する

#### 目的

数 km ディテール、時間連続性、独立チャンネル、共有密度、性能予算を「実装したつもり」で終わらせない検査対象にする。実行時は SPEC の変更案を先に提示し、合意を得た独立 commit のあとでコード変更へ進む。

#### 変更場所

| 場所 | 変更内容 |
| --- | --- |
| DEVELOP/SPEC/RENDERING.md | 雲の観測距離別の可読スケール、時間連続性、四成分、共通密度、性能上限を要求として追記 |
| tools/cloud-lab/ | 固定した三つの気象系列、時刻、seed、品質設定を選べるようにする |
| tools/render-lab/earth-cases.ts | 地表、limb、低軌道、低い太陽高度の固定 shot を追加 |
| tools/cloud-lab-shot.mjs | 二時刻だけでなく固定時系列を取得できるようにする |
| tools/cloud-lab-compare.mjs | 参照と同一 GSD へ再投影・再標本化して統計を出す |
| tools/render-lab-shot.mjs | 雲の固定 shot を二回ずつ採取できるようにする |
| tools/render-lab-compare.mjs | before/after と許容 envelope の差分を保存する |
| tools/cloud-reference/manifest.json | 参照 crop の出典、時刻、投影、GSD、利用条件を新規定義 |
| tests/render/cloud-reference-metrics.test.ts | 距離式、帯域除外、時系列統計を固定入力で検査 |

#### 合格条件と検証

- ユーザーが RENDERING.md の変更を確認し、仕様 commit が独立している。
- 三系列を同じコマンドで再生成でき、manifest にない参照を比較へ混ぜられない。
- 雲変更前の shot を各ケース 2 回取得し、決定的なケースは画素差が量子化誤差内に収まる。
- 基準実装の画像・時間統計、B0、各雲 pass の GPU 時間、GPU メモリ推定を保存する。
- npm run typecheck と npm run test:render が通る。

### Step 2. 独立した雲柱契約を縦切りで導入する

#### 目的

浅い海洋雲と深い対流について、生成から全 consumer まで四つの光学成分と鉛直 profile が混ざらず届く最小の完成形を作る。RGBA の alpha を定数にしたり、四成分を既存三値へ再集約したりしない。

#### 変更場所

| 場所 | 変更内容 |
| --- | --- |
| src/render/cloud/cloud-field-sample.ts | 旧三値サンプルを廃止し、光学 basis と profile の型、単位、encode/decode を定義。必要なら cloud-column-sample.ts へ改名 |
| src/render/cloud/cloud-field.ts | CloudColumnField の契約へ置換し、二つの RGBA16F 出力を公開 |
| src/render/cloud/generated-cloud-field.ts | dedicated MRT で optical basis と vertical profile を同時生成し、浅い雲と深い対流を実装 |
| src/render/cloud/condensation.ts | 湿度、安定度、対流から四成分の独立重みと雲底・雲頂を算出 |
| src/render/cloud/cloud-presentation.ts | consumer へ二つの論理リソースを渡す。旧 alias を残さない |
| src/render/cloud/observed-cloud-field.ts | 観測雲を新契約へ変換する adapter を実装し、選択可能な状態を保つ |
| src/render/opaque-cloud-surface-renderer.ts | 縦切り対象二形態の basis/profile を直接読む |
| src/render/pipeline/cloud-atmosphere-renderer.ts | 縦切り対象二形態の profile を使い、固定 shell 依存を外し始める |
| src/render/pipeline/shadow/cloud-shadow-renderer.ts | 四成分の総消散へ接続し、alpha の独立寄与を検査可能にする |
| tools/cloud-lab/ | basis/profile の単独 debug view を追加 |
| tests/render/cloud-column-field.test.ts | unit basis、混合、MRT round-trip、半精度誤差、決定性を検査 |

#### 合格条件と検証

- eR/eG/eB/eA と混合入力の cross-talk が 4.4 の上限内で、A が非定数である。
- 浅い海洋雲と深い対流を debug view と最終画像で明瞭に区別できる。
- 対象二系列の画像統計の中央値 D が基準の 70% 以下で、見た目にも数 km の構造改善へ向かう差がある。
- 生成雲・観測雲の切替、雲表示設定、同一時刻の決定性が維持される。
- before/after を同一条件で比較し、地表・大気・影のどれか一つだけに成分が欠落していない。
- npm run typecheck と npm run test:render が通る。

### Step 3. world-anchored ディテールと連続した寿命を実装する

#### 目的

2〜20 km の雲塊、穴、対流塔、上層フィラメントを、カメラや cap に追従せず世界上で移流・発達させる。単一 6 km ノイズへの依存と epoch 境界の pop を除く。

#### 変更場所

| 場所 | 変更内容 |
| --- | --- |
| src/render/cloud/cloud-detail-field.ts | RGBA8、二時刻、mip 付きの可視域 detail field を新設 |
| src/render/cloud/generated-cloud-field.ts | column field と detail field の更新時刻、guard band、世代を管理 |
| src/render/cloud/weather-transport.ts | 風による逆移流座標と前後時刻補間を提供 |
| src/render/cloud/atmospheric-wind.ts | 高度帯ごとの風と鉛直シアを detail event へ供給 |
| src/render/cloud/circulating-noise.ts | sphere-space の安定 ID、疎な event seed、親子派生を提供。画面座標 seed を禁止 |
| src/render/cloud/cumulus-shape.ts | 単一 gradient noise を detail channel と寿命曲線へ置換 |
| src/render/cloud/cloud-shape-evaluator.ts | 時刻、風、basis/profile/detail を受ける形状評価へ変更 |
| src/render/cloud/cloud-cap.ts | detail 解像度、snapped origin、guard band、球面継ぎ目を扱う |
| tools/cloud-lab/ | detail channel、event age、移流ベクトル、前後 keyframe の表示を追加 |
| tests/render/cloud-detail-field.test.ts | world anchor、epoch 境界、cap 移動、時間加速、seed 決定性を検査 |

#### 合格条件と検証

- 2〜8 km と 8〜32 km の帯域パワーが参照 IQR へ近づき、standard で 2〜8 km 帯が解像可能である。
- cap とカメラを動かした同一世界位置の差が 4.3 の上限内。
- epoch 境界の差分 p95 が通常区間中央値の 1.5 倍以下。
- 10、30、60、180 分の動画で移流、発達、消散が連続し、全域同期 fade がない。
- 高速時間進行で更新上限を超えず、同じ時刻へ戻した結果が決定的である。
- before/after shot と時系列比較を保存する。
- npm run typecheck と npm run test:render が通る。

### Step 4. 共通密度・光学評価を全描画経路へ通す

#### 目的

地表、limb、低軌道、影で同じ雲形状と鉛直構造を読み、固定 shell、固定 albedo、consumer ごとの別形状を解消する。

#### 変更場所

| 場所 | 変更内容 |
| --- | --- |
| src/render/cloud/cloud-density-evaluator.ts | basis/profile/detail から高度別密度、消散、散乱、氷水相を返す共通 evaluator を新設 |
| src/render/cloud/cloud-shape-evaluator.ts | 密度 evaluator の共通補助へ整理し、consumer 固有の形状判断を除く |
| src/render/cloud/cloud-optics.ts | 光学的厚さ、透過、単散乱、位相パラメータを一貫した単位で定義 |
| src/render/cloud/cloud-optics-node.ts | cloud-optics.ts と同じ単位の TSL/WGSL 側関数を提供 |
| src/render/opaque-cloud-surface-renderer.ts | 厚い雲面を共通密度の高速近似へ変更し、連続ブレンドを使用 |
| src/render/pipeline/cloud-atmosphere-renderer.ts | profile 範囲を短い 2.5D march で積分し、固定 shell を撤去。氷水相も連続化 |
| src/render/pipeline/shadow/cloud-shadow-renderer.ts | 同じ密度を粗い mip と低サンプル数で積分 |
| tools/render-lab/earth-cases.ts | limb、低軌道、薄明、低い太陽高度、雲頂の parallax ケースを追加 |
| tests/render/cloud-density-evaluator.test.ts | 三 consumer の support、高度範囲、透過率、極端値を検査 |

#### 合格条件と検証

- 単一の test column について、地表・大気・影の非ゼロ support が同じ緯度経度と profile 高度に一致する。
- 雲底・雲頂を変えると limb と parallax が対応して変わり、固定 0〜2 km または 15〜16 km shell が残らない。
- 薄雲から厚雲への変化で表現が pop せず、光学的厚さに対して透過率が単調に変わる。
- 低い太陽高度で detail に整合した影が出て、影だけが別形状にならない。
- 追加した全 shot の before/after と差分を保存し、envelope 外を説明する。
- npm run typecheck と npm run test:render が通る。

### Step 5. 更新、LOD、GPU 予算を成立させる

#### 目的

全場の毎フレーム再生成を避け、視覚要件を保ったまま標準品質を性能・メモリ予算へ収める。

#### 変更場所

| 場所 | 変更内容 |
| --- | --- |
| src/render/cloud/generated-cloud-field.ts | macro/detail、前後時刻、cap 移動を別 dirty flag とし、必要 pass だけ更新 |
| src/render/cloud/cloud-cap.ts | snapped reuse、guard band、品質別 detail 解像度を確定 |
| src/render/graphics-settings.ts | off/coarse/standard/fine を解像度、march、shadow mip、更新頻度の束へ写像 |
| src/render/opaque-cloud-surface-renderer.ts | 空領域 skip、適応 march、早期終了を導入 |
| src/render/pipeline/cloud-atmosphere-renderer.ts | profile 範囲制限、適応 march、早期終了を導入 |
| src/render/pipeline/shadow/cloud-shadow-renderer.ts | coarse mip、更新間引き、時間再利用を導入 |
| src/render/gpu-timings.ts | bake、detail update、surface、atmosphere、shadow を別計測し p50/p95 を出す |
| tools/render-lab-measure.mjs | B0、Bcloud、Bupdate、品質、GPU 情報、feature を manifest 化 |
| tests/render/cloud-quality-settings.test.ts | 各品質で必須機能が消えず、設定束が単調であることを検査 |

#### 合格条件と検証

- standard が 4.5 の Bcloud、Bupdate、48 MiB を満たす。
- timestamp-query 非対応は未計測と表示され、成功扱いにならない。
- カメラ静止、カメラ移動、通常時間、高速時間で、更新された pass と理由が確認できる。
- standard で四 basis、detail、二時刻補間が有効なまま、Step 3 と Step 4 の画像・時間条件を維持する。
- coarse/standard/fine の帯域パワーと GPU 時間が単調に変化し、fine も 72 MiB 以下。
- npm run typecheck と npm run test:render が通る。

### Step 6. 前線、多層雲、上層氷晶へ形態を拡張する

#### 目的

縦切りで成立した共通基盤へ、中緯度前線、多層層状雲、かなとこ、巻雲を連続重みとして追加し、気象スケールと数 km スケールを接続する。

#### 変更場所

| 場所 | 変更内容 |
| --- | --- |
| src/render/cloud/weather-model.ts | 湿度、安定度、収束、シア、対流から形態重みを算出 |
| src/render/cloud/condensation.ts | 層状・混相・上層氷晶の basis/profile を追加 |
| src/render/cloud/circulation.ts | 前線帯の幅、傾斜、多層構造へ使う大規模循環と移流を提供 |
| src/render/cloud/cyclones.ts | 低気圧の wrap、収束帯、乾燥スロットを basis と detail event へ接続 |
| src/render/cloud/cyclone-tracks.ts | 低気圧の寿命、移動、発達を連続化 |
| src/render/cloud/rossby-wave.ts | 中緯度の大規模配置と移動を前線場へ供給 |
| src/render/cloud/climate-map.ts | 緯度帯・海陸・標高・斜面の prior を basis/profile/detail へ供給 |
| src/render/cloud/atmospheric-wind.ts | 地形性上昇、風下消散、鉛直シアに必要な風を供給 |
| src/render/cloud/cloud-detail-field.ts | 上層フィラメント、open/closed cell、前線内セルの kernel を追加 |
| tests/render/cloud-morphology.test.ts | 形態重みの連続性、極端入力、seed 決定性、境界の非発散を検査 |

#### 合格条件と検証

- 三つの固定系列で異なる形態が現れ、単一ノイズの閾値違いに見えない。
- 形態重みの境界に線状 seam や hard switch がない。
- 中緯度系列で前線雲と上層氷晶が鉛直 profile と移流方向の両方で分離して読める。
- 三系列の集約中央値 D が基準の 70% 以下で、個別系列の悪化が 10% 以内。
- 保留していた別時刻を held-out frame として評価し、調整に用いた frame だけの改善でない。
- before/after と 6 時間動画を保存する。
- npm run typecheck と npm run test:render が通る。

### Step 7. 全回帰、整理、引き渡しを行う

#### 目的

観測雲、全品質、全視点、設定切替まで通したうえで、旧契約と暫定経路を除去し、検証可能な完成状態にする。

#### 変更場所

| 場所 | 変更内容 |
| --- | --- |
| src/render/cloud/ | 旧 CloudSample、固定 alpha、固定 shell、重複 optics、暫定 debug 分岐を除去 |
| tools/cloud-lab/ | 最終 basis/profile/detail/密度 view と三系列の再現入口を整理 |
| tools/render-lab/ | 最終 shot matrix と性能計測入口を整理 |
| tests/render/ | 雲の契約、時間、形態、品質、consumer 整合の回帰を最終構成へ整理 |
| DEVELOP/SPEC/RENDERING.md | 実装後の追記は行わず、Step 1 で確定した仕様に対する未達項目だけを報告 |

#### 合格条件と検証

- 生成雲と観測雲、off/coarse/standard/fine、地表/limb/低軌道、昼/薄明、通常/高速時間の matrix を完走する。
- 4.2〜4.5 の全条件を満たし、結果 manifest、画像、動画、GPU 計測、メモリ内訳を保存する。
- 旧三値の識別子、定数 alpha、固定高度 shell、consumer 固有の雲形状評価が検索で残らない。
- 描画の大変更として refactor と comment cleanup を行い、規約からの例外があれば理由と影響を報告する。
- npm run typecheck と npm run test:render が通る。
- main へ送る場合だけ、send-pr の手順に従って全テスト、build、PR 本文まで実施する。

## 6. 工数見積もり

| Step | 内訳 | 見積もり |
| --- | --- | ---: |
| 1 | SPEC 2h + fixture/参照 6h + metrics 4h + baseline 4h | 16h |
| 2 | MRT/resource 8h + 契約/encode 8h + 生成/観測 adapter 6h + test/lab 6h | 28h |
| 3 | event/detail 12h + 時間/移流 10h + cap/LOD 4h + test/動画 6h | 32h |
| 4 | surface 10h + atmosphere 12h + shadow 8h + visual/regression 6h | 36h |
| 5 | 更新 cadence 6h + cap reuse 4h + quality/timing 4h + 最適化/計測 6h | 20h |
| 6 | 形態 kernel 12h + 連続混合 6h + 地理/地形 4h + tuning 6h | 28h |
| 7 | 全 matrix 6h + 最終最適化 6h + 整理 4h | 16h |
| 合計 | 実装・検証の正味工数。対象実機の利用待ちを除く | 176h |

Step 2 の縦切り後に、実測した pass 数、GPU 時間、リソース量から Step 3〜6 の残工数を再見積もりする。工数を削る場合も、最初に削るのは対象形態の追加数であり、独立四成分、world anchor、時間補間、共通密度、standard の視覚条件は削らない。

## 7. リスクと露出箇所

| リスク | 影響 | 露出・検出する Step |
| --- | --- | --- |
| 四 basis が途中で三値や総雲量へ再集約される | 外見がほぼ変わらず、上層氷晶を独立制御できない | Step 2 の unit basis、round-trip、debug view |
| detail が地表面だけに現れる | limb、低軌道、影が別の雲に見える | Step 4 の三 consumer support と固定 shot |
| cap/カメラ基準の seed が混ざる | 移動時に swimming や pop が出る | Step 3 の同一世界位置差分 |
| epoch 切替が見える | 高速時間進行で全域が脈動する | Step 3 の境界 p95 と動画 |
| 時間補間が細部をぼかす | 数 km 帯域が静止画では存在しても動画で消える | Step 3 の optical flow、帯域、lag 相関 |
| mip/LOD が細部を早く落とす | 低軌道で要求した構造が見えない | Step 3 と 5 の品質別帯域測定 |
| 固定 shell が残る | 雲頂高度、parallax、影が不自然 | Step 4 の profile view、limb、低太陽 shot |
| 性能のため detail を無効化する | 数値だけ合格して目的を失う | Step 5 の必須 feature manifest と画像 gate |
| timestamp-query 非対応を成功扱いする | GPU 予算を検証できない | Step 5 の feature 記録と未計測判定 |
| 二時刻保持でメモリが膨張する | fine で端末上限を超える | Step 5 の全 allocation 内訳 |
| MRT/format 制約が端末で異なる | 一部 GPU で生成不能 | Step 2 の capability probe。必要時は独立性を保つ複数 pass fallback |
| 低サンプル影が banding/alias を出す | 朝夕の雲影が破綻する | Step 4 の低太陽 shot、Step 5 の品質別比較 |
| 参照 frame へ過学習する | 別時刻・別地域で破綻する | Step 6 の held-out frame |
| 観測雲 adapter が外観を変える | 既存の観測モードが回帰する | Step 2 と 7 の source 切替 matrix |

## 8. 完了の定義

この計画は、コードが新しい型へ置き換わった時点では完了しない。固定した三系列と描画 matrix で、数 km ディテール、時間連続性、四成分の独立性、鉛直整合、三 consumer の一致、標準品質の GPU・メモリ予算がすべて測定可能で、4 節の条件に合格した時点を完了とする。
