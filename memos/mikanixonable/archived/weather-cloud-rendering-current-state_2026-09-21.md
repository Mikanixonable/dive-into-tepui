# 現在の天気・雲生成・描画システムの全体像

## 0. この文書の位置づけ

この文書は、2026 年 9 月 21 日時点のコードを読み、現在実際に動く天気、雲の生成、雲を含む描画システムの構造を記録したものである。対象スナップショットは `git rev-parse --short HEAD` が `d8b261a40` となるコミットであり、コードの現状を説明するための資料である。将来の仕様や未実装の計画を正本として扱うものではないため、`DEVELOP/SPEC/` に記載された理想状態ではなく、`src/` の実装と、それを検証する `tests/` の内容を基準にしている。

## 1. 概要

現在の天気と雲は、ゲームプレイの気圧や飛行物理から直接生成されるシミュレーションではなく、描画層の中で扱われる視覚表現である。生成雲を選んだ場合は描画層の `WeatherModel` が決定論的に時系列を作り、観測雲を選んだ場合は画像を雲場へ変換する。入口は `GamePresentation.syncWorld()` であり、ここから `CelestialSystem.sync()` が天体と大気の描画入力を更新し、`CelestialSystem.bakeClouds()` が必要な雲の GPU テクスチャを更新する。その後 `RenderPipeline.render()` が、影、G-buffer、光、マテリアル、大気、雲の各表現を順序どおりに合成して画面を作る。

このシステムは、地球の `earth-climate.png` から温度、平均雲量、標高を得る静的な気候層、その気候を初期条件として風、圧力、移流、前線、熱帯収束帯、低気圧、地形上昇を計算する `WeatherModel`、そこから雲の被覆率・高度・光学的な薄さを作る `condense()`、生成雲または観測雲を GPU のフィールドとして供給する `CloudPresentation` に分かれている。生成経路では `GeneratedCloudField` が時間を受け取り、`WeatherModel` の結果を `CloudField` のテクスチャへ焼き込む。観測経路では `ObservedCloudField` が `cloud-field.png` を雲の基底表現へ変換する。

雲は一つの描画方法だけで表現されない。地表付近の立体感と雲頂の輪郭は `OpaqueCloudSurfaceRenderer` が不透明な球殻として描き、遠方の大気中の雲と薄い雲は `CloudAtmosphereRenderer` および `AtmosphereCloudLayers` が大気積分に解析的な球殻イベントとして挿入する。太陽光が雲を通過する効果は `CloudShadowRenderer` が別の影経路で計算する。これら三つは同じ `CloudFieldSampler`、`CloudShapeEvaluator`、雲の基底値を共有するため、輪郭、影、大気中の透過が同じ雲場を参照する。

一方、見た目の大気そのものは雲とは別に `AtmosphereIntegrator` が計算する。`src/physics/atmosphere.ts` にある `Atmosphere`、`atmosphericDensity()`、`dragAccel()` などは飛行・物理シミュレーション用であり、`src/render/atmosphere.ts` の `AtmosphereOptics` や `AtmosphereIntegrator` は画面上の散乱・透過用である。現在の雲や天気は物理層の密度、抗力、風圧と接続していない。この分離を曖昧にすると、「天気が機体の飛行へ作用する」と誤って読んでしまうため、現在の実装を説明するうえで最も重要な境界の一つである。

## 2. 1 フレームの大きな流れ

一つの表示フレームでは、まずゲーム状態から表示用時刻とカメラが決まり、その時刻に対する天体、大気、雲の入力が準備され、最後に描画パスが GPU 上で実行される。上位の順番を追うと、`GamePresentation.syncWorld()` が `displayTime` を確定し、カメラを同期し、`this.devices.celestialSystem.sync(...)`、`this.devices.celestialSystem.bakeClouds(this.devices.scene.renderer, displayTime, this.devices.scene.gpu)` を呼び、その後に動的オブジェクトの同期を行う。雲の焼き込みは、少なくとも表示状態が描画される前に実施される。

`CelestialSystem.build(scene, illuminationTargets)` は天体ビューを登録し、`CelestialSystem.sync(...)` は各 `CelestialView.sync(...)` を呼んだあと、`CelestialIllumination.sync(...)` によって太陽、環境光、惑星光、影の入力、大気の draw リストを組み立てる。`CelestialSystem.bakeClouds(...)` は登録された天体のうち、雲の機能を持つビューに対して `body.view.bakeClouds(...)` を呼ぶ。したがって雲の生成は `RenderPipeline` の内部で偶然始まるのではなく、天体同期の段階で明示的に準備される。

`src/render/celestial/celestial-illumination.ts` の `CelestialIllumination.syncCumulusShadow()` は `castsCumulusShadow(graphics)` で影機能の有効性を判定し、`source.view.cumulusShadowAt(...)` から最初の雲影候補を選んで `targets.cumulusShadow.set(...)` に渡す。同じクラスの `syncAtmosphere()` は各 `source.view.atmosphereCandidateAt(...)` を収集し、`atmosphereDraws(candidates, graphics.atmosphere)` でサンプル数と描画対象を決定し、`targets.atmosphere.setDraws(...)` に設定する。ここで大気 draw は雲を含む `AtmosphereBody` を持ち、後段で `bakeClouds()` が同じクラウドフィールドの GPU テクスチャを更新するという関係になる。

その準備が終わると `RenderPipeline.render(...)` が実行される。通常の realistic スタイルでは、まず `ShadowPass` のための影入力、`GBufferPass`、光の前計算、マテリアル、雲を含む大気、通常のワールド描画、レンズ効果、合成、オーバーレイ、アンチエイリアスが順に走る。雲は「雲専用の一枚の絵」として最後に貼られるのではなく、G-buffer の不透明面、大気中の散乱、影の透過という複数の物理的な接点に分散して描画される。

## 3. 地球で何が構成されるか

地球の具体的な構成は `src/game/celestial/solar-system/earth-system.ts` の `earthSystem(...)` と `earthCloudPresentation()` に集約されている。地球は `PointCelestialView` と `CloudPresentation` を持ち、月は `SphereCelestialView` として作られる。地球の大気には `EARTH_ATMOSPHERE_OPTICS` が与えられ、月には現在この雲・大気構成は与えられない。

`earthCloudPresentation()` は `EARTH_CLOUD_FIELD_HEIGHT = 512` を使って `new EquirectProjection(EARTH_CLOUD_FIELD_HEIGHT)` を作る。したがって現在の地球の雲場は、幅 1024、高さ 512 の正距円筒図法である。`OrthographicCap` も `src/render/cloud/field-projection.ts` に実装されているが、現在の地球の通常経路がそれを使っているわけではない。地球の生成雲は `earthGeneratedCloudField(projection)` によって `new GeneratedCloudField(AnnualClimateMap.fromDeferredUrl(climateTextureUrl), projection, R_EARTH, SIDEREAL_DAY)` として作られ、観測雲は `new ObservedCloudField(cloudFieldUrl, projection)` として作られる。`SIDEREAL_DAY = 86164.0905` は生成雲の自転周期として `WeatherModel` に渡される。

地球の入力アセットは少なくとも三種類に分かれる。`earth-climate.png` は `AnnualClimateMap` が読む気候画像で、赤が平均温度、緑が年間平均雲量、青が標高を表す。`cloud-field.png` は `ObservedCloudField` が読む観測雲画像であり、赤が雲の被覆、緑が雲頂高度の代理値、青が薄い雲の光学的厚さとして解釈される。地表テクスチャや海面などは地球の通常の `SurfaceRenderer` 系で使われ、雲場の生成そのものとは別である。

`PointCelestialView.syncResolved(...)` は `graphics.clouds` が有効なら `setCloudsVisible(true)`、`setSource(graphics.cloudFieldSource)`、`setDetail(graphics.cumulusDetail)`、`syncLod(apparentDiameterPx)` を順に適用する。生成雲と観測雲の切り替えはこの `graphics.cloudFieldSource` で行われる。また `setAtmosphereCloudsVisible(graphics.clouds && graphics.cirrus, graphics.clouds && graphics.translucentCumulus)` により、地表に見える不透明雲と、大気内の巻雲・半透明積雲が別々に制御される。

## 4. 気候マップから気象の初期条件へ

気候層は静的な地理条件を提供し、そこから直ちに最終的な雲のアルファ値を返すものではない。`src/render/cloud/climate-map.ts` の `ClimateData` インターフェースは、`temperatureK(direction)`、`meanCloudiness(direction)`、`elevation(direction)`、`landFraction(direction)`、`slope(direction, landHeight, surfaceRadius)`、`request()`、`dispose()` を持つ。`AnnualClimateMap` はこのインターフェースを実装し、`AnnualClimateMap.load()`、`AnnualClimateMap.fromDeferredUrl()`、`AnnualClimateMap.request()` で画像のロードと GPU 利用準備を行う。

`AnnualClimateMap` の `sample()` は球面方向を正距円筒 UV に変換し、線形フィルタされた `THREE.Texture` から RGB を取得する。温度はおおむね -40 から 40 ℃を 0 から 1 に対応させ、`temperatureK()` が Kelvin に直す。緑の値は `meanCloudiness()` の 0 から 1 の年間平均雲量、青は `elevation()` の 0 から 8000 m の標高である。`LAND_ELEVATION = 100` を境に `landFraction()` が陸らしさを返し、`slope()` は東西・南北の有限差分と陸高度を組み合わせる。有限差分の刻みには `SLOPE_STEP = 0.02` が使われる。

`geographicForcingPrior(latitude, meanCloudiness, landFraction)` はこの気候値を気象の事前分布へ変換する。この関数は `stormTrack`、`marineStratocumulus`、`itcz`、`drySubsidence` を返す。ここで `meanCloudiness` はその地点の雲量を最終結果として固定する値ではなく、前線、熱帯収束帯、海洋性層積雲、乾燥沈降などの候補を重み付けする気候的な事前条件である。実際の雲の被覆率は、後述する `WeatherModel.weatherAt()` と `condense()` の計算結果になる。

## 5. `WeatherModel` の責務と更新周期

生成天気の中心は `src/render/cloud/weather-model.ts` の `WeatherModel` である。`WeatherModel` は直接雲を描かず、方向ごとの `WeatherSample` を返す。`WeatherSample` には `forcing`、`pressure`、`surfaceWind`、`lift`、`surfaceHumidity`、`upperHumidity`、`convection`、`convectiveActivity`、`compression`、`band`、`warmth`、`anvil`、`meanCloudiness`、`landFraction`、`tropopause`、`temperatureK`、`environment` が含まれる。これらは後段の `condense(weather)` が雲の種類と形へ圧縮するための中間表現である。

`WeatherModel` の主な所有物は、`AtmosphericWindField atmosphericWind`、`Circulation surfaceCirculation`、`Circulation upperCirculation`、`RossbyWave rossbyWave`、`Cyclones cyclones`、`CirculatingNoise pressureNoise`、`WeatherTransport transport`、圧力を焼く `BakedField pressure`、対流活動を焼く `ConvectiveActivity convectiveActivity`、空気塊を追跡する `AirMass airMass`、そして日周位相の `dailyPhase` である。コンストラクタはこれらを組み立て、`syncTime(0)` を呼んで初期時刻を設定する。

時間の進行は `WeatherModel.syncTime(seconds)` が受け持つ。このメソッドは `surfaceCirculation.syncTime(...)`、`upperCirculation.syncTime(...)`、`rossbyWave.syncTime(...)`、`cyclones.syncTime(...)`、`transport.syncTime(...)` を更新し、`splitSimulationTime` によって `dailyPhase` を設定する。実際に GPU の中間テクスチャを作るのは `WeatherModel.bake(renderer, gpu)` であり、ここで `pressure.render(...)`、`airMass.bake(...)`、`transport.bake(...)`、`convectiveActivity.bake(...)` が呼ばれる。

生成フィールド側の `GeneratedCloudField.prepare(renderer, displayTime, gpu)` は、最初に `climate.request()` を待ち、`climate.generation` と `projection.revision` を読み取る。その後、`displayTime`、気候生成番号、投影リビジョンが `lastBakedDisplayTime`、`lastBakedClimateGeneration`、`lastBakedProjectionRevision` とすべて一致する場合だけ処理を省略する。一致しなければ `model.syncTime(displayTime)`、`model.bake(renderer, gpu)`、`field.render(renderer, gpu)` を実行し、`generationValue` を増加させる。現在のキャッシュ判定は表示時刻の一致を基準にしており、生成結果を粗い時間間隔で間引く temporal throttle ではない。

`GeneratedCloudField.prepare()` が更新後に設定する `stateValue` は `{ absoluteTimeSeconds: displayTime, seed: Math.trunc(displayTime / (24 * 60 * 60)) }` である。この `CloudStateBinding` はシェーダーやサンプリング側へ、現在の絶対時刻と日単位の決定論的シードを伝える。`GeneratedCloudField` は `texture`、`generation`、`state`、`at`、`stateAt`、`weatherModel`、`climateMap`、`fieldProjection` を公開し、`dispose()` では所有する `CloudField`、`WeatherModel`、`ClimateData` を破棄する。

## 6. `WeatherModel.weatherAt()` の計算の流れ

`WeatherModel.weatherAt(direction)` は球面上の一方向について、静的気候、圧力、風、移流、熱帯・温帯の組織化要因を合成して一つの `WeatherSample` を返す。最初に緯度、東向き基底、北向き基底を取り、正距円筒の東方向位相と `dailyPhase` から日周湿度の小さな揺らぎを作る。その後 `pressureFieldAt(direction)` から圧力場を読み、`rossbyWave.perturbationAt(...)` と `atmosphericWind.sampleNode(...)` を地表付近の 1 km と上層の 10 km で評価する。

局所的な風は `balancedWind(...)` によって組み立てられる。この関数は気圧勾配、コリオリ項、曲率、摩擦を考慮した勾配風を解く。`WeatherModel` は地表用・対流用・上層用の風を作り、`composeWind(...)` で背景風と局所摂動を合成する。`wind-law.ts` の `isobarAt(...)`、`windStep(...)`、`coreCrossingAngle(...)` も、この風や低気圧中心を扱うための補助関数である。

風による輸送は `transport.advectedAt(direction)` と `moistureGradientAt(...)` から得られる。`WeatherTransport` は地表湿度、対流、上層湿度を別のノイズ場として保持し、時間の二位相 `phaseA` と `phaseB = fract(phaseA + 0.5)` を使って補間する。`advectedAt()` は `windStep` を使い、地表風、上層風、対流風に異なる倍率を掛けて、過去位置から現在位置へ値を逆追跡する。これにより単純な座標ノイズではなく、風に流される湿度場を作る。

空気塊の履歴は `airMass.at(direction, latitude)` で読み取る。`AirMass` は `TRACE_SECONDS = 36h`、`GRADIENT_STEP = 0.025`、穏やかな風の速度 3、強い風の速度 7 を使って、方向を過去へ追跡したときの圧縮と暖気・寒気の情報を返す。緯度 20° から 35° の範囲では `extratropicalWeight` が遷移し、`airMass.warmth` にこの重みを掛けた `warmth` が温帯前線の組織化に利用される。

緯度と気候を使った大域的な組織化は `geographicForcingPrior(...)` が担当する。そこへ、温度勾配・湿度勾配・気圧上昇流から `frontForcing(...)`、低気圧の雨帯・巻雲・目から `cycloneForcing(...)`、熱帯の緯度帯から `itczForcing(...)`、風と地形勾配から `orographicForcing(...)` が加わる。`orographicForcing(wind, slope, landFraction)` は風と斜面の内積から上昇流を求め、陸面係数を掛けて `lift`、湿度、組織化、風の摂動を返す。下り風では湿度を乾燥させ、上り風では雲の組織化を強める。これらを合成する共通の値型は `src/render/cloud/weather-forcing-field.ts` の `WeatherForcingField` であり、`blendWeatherForcing()` は気候的な prior と異常成分を混ぜるための関数である。

前線は `frontForcing(...)` の `FRONT_ONSET = 1.45`、幅 `.35`、湿度勾配の開始 `.12` と幅 `.28`、雨帯の開始 5 と幅 4 などのしきい値で作られる。気圧由来の上昇流と前線の重みは、`FRONT_LATITUDE_START = 20°` から `FRONT_LATITUDE_END = 35°` の温帯遷移で強くなる。熱帯側では `compression` から雨帯を作り、`band` は前線成分と熱帯雨帯成分の最大値として求められる。`bandLift = band * .06` が全体の `lift` に加わる。

低気圧は `Cyclones` が管理する。`LOW_COUNT = 8` の温帯低気圧と、一つの熱帯低気圧を持ち、`Cyclones.syncTime()` がそれぞれの配置を更新する。温帯低気圧は `lowPlacementAt(index, seconds, surfaceRadius)` で決まり、低気圧の寿命はおよそ 4 から 6.5 日、周期は 7 日である。熱帯低気圧は `tropicalPlacementAt(seconds)` で決まる。`Trough.place()`、`Trough.pressureAt()`、`Trough.eyeAt()`、`Trough.anvilAt()` は一つの低気圧の圧力、目、巻雲を返し、`eyeStrengthOf()` と `coreCrossingAngle()` で中心付近の構造を作る。

最終的な湿度と上昇流は、移流場、暖気、雨帯、目の乾燥、巻雲、熱帯収束帯、前線、地形を合成して作られる。地表湿度には `dailyHumidity`、`band`、`warmth`、`anvil`、低気圧の目による乾燥、`drySubsidence` による乾燥が入り、上層湿度には上昇流、巻雲、目の乾燥、上層の沈降が入る。`ConvectiveActivity.at(direction, lift, warmth, landFraction, band)` が対流活動を読み、最後に `weatherForcingField(...)` が湿度、上昇、組織化、風摂動を `WeatherForcingField` としてまとめる。

## 7. 風、ノイズ、移流の内部構造

天気の空間的な連続性は、複数種類のノイズを単純に重ねるのではなく、緯度帯の循環、惑星波、圧力ノイズ、風に沿う移流を組み合わせて作られている。`AtmosphericWindField` は地表高度 `SURFACE_HEIGHT = 1000` と雲上層 `UPPER_CLOUD_HEIGHT = 10000` で風を評価し、貿易風、偏西風、極域風を緯度プロファイルとして連続的に補間する。CPU 用の `sample()` と TSL 用の `sampleNode()` は同じ風則を異なる実行場所で利用する。

`Circulation` は緯度 -75、-45、-15、15、45、75 度付近の六つの帯を持ち、`BLEND_WIDTH = 1` の範囲で隣接帯を混ぜる。`syncTime()` は帯の自転・公転位相と、7 日周期の `BREATH_AMPLITUDE = .05` の呼吸変動を更新する。`carry(direction, sample)` は最大二つのフローバンドを参照して値を運ぶため、帯の境界で不連続な流れになりにくい。

圧力や湿度の微細構造は `CirculatingNoise` と `gradientNoise` が作る。`CirculatingNoise` は複数オクターブを持ち、`texelAngle` に応じて解像度をフェードさせる。`pairAt()` は同じ `gradientNoise` から滑らかな値とセル状の値を返すため、大規模な気圧の流れと局所的な組織化を同じ決定論的座標系で作れる。`WeatherModel` の圧力源では `PRESSURE_NOISE = [{ frequency: 1.2, amplitude: 1 }]` に全体の 18 hPa の振幅を掛け、圧力帯、ノイズ、低気圧の圧力を足し合わせる。

`WeatherTransport` の湿度ノイズは、地表が周波数 2、8、16、32、64、対流が 133 と 266、上層が 3.75、8、16、32、64 のオクターブを持つ。地表の基礎値は `.405`、振幅は `.5625`、対流の振幅は `.30`、上層の基礎値は `.42`、振幅は `.65625` である。`ADVECTION_PERIOD = 20h`、`CONVECTION_ADVECTION = 1.3`、`UPPER_ADVECTION = 1.6`、巻き込み量 2.5 によって、地表・対流・上層の場に違う時間スケールと風の影響が与えられる。

`RossbyWave` は波数 `WAVE_NUMBER = 5`、位相速度 3 度/日、南北速度 8 m/s を持つ大規模な惑星波である。`syncTime()` が時間位相を更新し、`streamfunctionAt()` と `perturbationAt()` が流線関数と風の摂動を返す。包絡線はおおよそ 10 から 35 度と 55 から 80 度の緯度帯にあるため、温帯の前線や風の組織化に影響するが、局所雲の粒を直接描くものではない。

## 8. 気象から雲の基底値へ変換する `condense()`

`src/render/cloud/condensation.ts` の `condense(weather: WeatherSample): CloudSample` が、気象の中間表現を雲場の基底値へ変換する。返される `CloudSample` は `basis`、`coverage`、`cloudTop`、`translucent` を持ち、`basis` は `low`、`middle`、`convective`、`inSitu` の四つの連続値である。これは「低い雲」「中層雲」「対流雲」が排他的な種類として一つだけ選ばれる構造ではなく、同じ柱の中に複数成分が混ざる表現である。

まず `weather.forcing` の `moisture`、`lift`、`organization`、`windPerturbation` を使い、対流の横方向の組織化とセル粒度を湿度で混ぜる。`CONVECTION_GAIN = 1.2`、`BAND_GRAIN_FADE = .8` などを使って `peak = convection * organization` と `granularity` を作る。海上で湿潤、沈降気味、陸面が少なく、組織化が弱い場合には `marineStratocumulus` を加えるため、気候の雲量は海洋層積雲の事前分布として機能する。

雲頂は低い層状雲、上昇流、暖気、雨帯、対流の緩和を組み合わせた `layeredTop` から始まる。基本雲底は `1000 m`、層の幅は `6000 m` であり、さらに湿潤な上昇流では `tower` が層の上へ伸び、`weather.anvil` が `tropopause` までの金床雲を加える。雲量は湿度、粒度、海洋性層積雲の幅から `moistened` を作り、開始 `COVERAGE_ONSET = .50`、幅 `COVERAGE_WIDTH = .22`、分散 `COVERAGE_DISPERSION = 2` の一般化有理尾で clear fraction を計算する。最終的な `coverage` は `1 - clear` であり、単純な線形しきい値ではない。

雲の上端は `coverage` に応じて雲底から持ち上げられ、上層湿度から半透明の薄雲も作られる。薄雲の開始値は `TRANSLUCENT_HAZE_ONSET = .38`、強度は `.49`、筋状成分は開始 `.48`、強度 `1.75`、膝値 `.25`、上限 `.63` などで制御される。最後に `cloudTemperatureKAtAltitude()` と `cloudPhaseWeights()` を使って液体水と氷の割合を高度で分け、低層・中層・対流の基底を雲頂位置に応じて分配する。

雲の垂直形状を表す補助関数として `cloudVerticalProfileAt()` と `verticalProfileSupport()` があり、雲のライフサイクルには `cloudLifecycleAt(absoluteSeconds, seed, forcing)` がある。ただし、現在の `CloudField` の主経路で `condense(model.weatherAt(direction))` が直接呼び出しているのは `condense()` であり、`cloudLifecycleAt()` や `cloudVerticalProfileAt()` がその場で時間発展を駆動しているわけではない。これらは契約・評価・テスト用の純粋関数として存在するため、現在の実行経路と将来のモデル部品を混同しない必要がある。

## 9. 生成雲と観測雲の共通インターフェース

生成雲と観測雲は、`src/render/cloud/cloud-presentation.ts` の `CloudFieldSource` インターフェースを通じて同じ描画システムへ入る。`CloudFieldSource` は `texture`、`state`、`generation`、`prepare(renderer, displayTime, gpu)`、`dispose()` を持つ。`CLOUD_FIELD_SOURCE_KIND` は `observed` と `generated` を識別し、`GraphicsSettings.cloudFieldSource` が現在どちらを選ぶかを表す。

`GeneratedCloudField` は `WeatherModel` と `CloudField` を所有する。`CloudField` のコンストラクタは `new BakedField(...)` を作り、ソース関数として `condense(model.weatherAt(direction))` と `cloudFieldTexelFromSample` を接続する。`CloudField.render(renderer, gpu)` はこの TSL グラフを `BakedField.render(...)` へ渡し、`CloudField.texture` は生成された RGBA テクスチャを返す。`CloudField.at(direction)` はフィールドテクスチャを方向で読むサンプラーであり、`CloudField.stateAt(direction, absoluteTimeSeconds, seed)` は気象値とフィールド値から `cloudStateAt(...)` を評価する。

観測経路の `ObservedCloudField` は、遅延ロードされる `cloud-field.png` と `BakedField` を所有する。`prepare()` は画像の `request()` を行い、画像生成番号と `FieldProjection.revision` を比較して、必要なときだけ `BakedField.render(...)` を実行する。CPU 側の `observedCloudBasisFromRgba(red, cloudTop, translucent, alpha = 1)` は `observed-cloud-adapter.ts` にあり、赤から被覆、緑から雲頂の代理、青から薄雲を作る。観測画像だけから対流相を推定する仕様にはなっておらず、`observedCloudBasisFromRgba()` は明示的に phase inference を行わない。

観測雲の基底は `smoothstep(0.45, 0.88, observed.g)` を対流成分、`smoothstep(0.12, 0.58, observed.g) * (1 - convective)` を中層成分、その残りを低層成分として分配し、`observed.b` を `inSitu` に使う。生成側も観測側も最終的には `CloudBasis` の `low`、`middle`、`convective`、`inSitu` を持つため、光学、影、表面、雲大気のコードは入力の出所を意識せずに扱える。

`CloudPresentation` は、複数の `CloudFieldSource` を `sources` レコードに保持し、現在の `source` を切り替える高位オーナーである。`renderInput` は `{ field: { texture, state }, generation, topAltitude, state }` を返し、`setSource()` は `OpaqueCloudSurfaceRenderer.bind(this.renderInput)` も更新する。`setDetail()` は不透明雲の詳細度、`setCloudsVisible()` は不透明雲全体、`setAtmosphereCloudsVisible()` は巻雲と半透明積雲の可視性、`syncLod(apparentDiameterPx)` は球殻メッシュのレベルを更新する。`fieldContributes()` は、どの表示経路にも寄与しない場合に不要な準備を抑えるための判定である。

## 10. フィールド投影、サンプリング、焼き込み

雲場の GPU テクスチャを方向から参照する規約は `FieldProjection` で統一されている。`FieldProjection` は `width`、`height`、`wrapS`、`wrapT`、`texelAngle`、`texelAngleValue`、`revision`、`directionAt(screenUV)`、`uvAt(direction)`、`insideAt(direction)` を持つ。共通の `equirectUvFromDirection()` は球面方向を経度・緯度の UV に変換し、東西方向の繰り返しと南北方向の端の扱いを定義する。

`EquirectProjection(height)` は幅を `2 * height` とし、`texelAngleValue = PI / height`、S 方向を repeat、T 方向を clamp にする。地球の現在の `EARTH_CLOUD_FIELD_HEIGHT = 512` では 1024 x 512 となる。`OrthographicCap(size, latitude, longitude, radius)` は局所キャップ用の別の実装で、`aim()`、`aimAt()`、`placement()`、`orthographicCapUv()`、リビジョン更新を持つが、地球の現在の通常経路では使われていない。

`BakedField` は `THREE.RenderTarget`、`MeshBasicNodeMaterial`、`QuadMesh` を所有する。コンストラクタの `source(projection.directionAt(screenUV))` が各ピクセルの方向を気象・観測ソースへ渡し、MRT で RGBA のフィールド値を出力する。`render(renderer, gpu)` が焼き込み、`texture` が結果のテクスチャ、`at(direction)` が `projection.uvAt(direction)` による参照を返し、`dispose()` が GPU リソースを破棄する。

描画中の各経路は `CloudFieldSampler` を使う。`CloudFieldBinding` は `texture` と `state` を持ち、`CloudFieldSampler.bind(...)` が `CloudPresentation.renderInput.field` を結び直す。`sampleCloud(direction)` は共有の `equirectUvFromDirection()` を使って U を `fract` し、V をテクスチャの wrap 規則に合わせてクランプし、`cloudSampleFromTexel()` で `CloudSample` に戻す。入力テクスチャの所有権は `CloudFieldSampler` にないため、サンプラーはバインドされたテクスチャを破棄しない。

`cloudSampleFromTexel()` は `coverage = clamp(low + middle + convective, 0, 1)` を計算し、`cloudTop` を各層の高度の重み付き平均として求める。低層は 1000 m、中層は 6000 m、対流層は `CLOUD_TOP_SPAN` の範囲を使い、`inSitu` と対流量から `translucent = min(inSitu + convective * .25, 1)` を得る。これが、気象モデルが出した連続基底を三つのレンダリング経路で使える共通の意味に変換する場所である。

## 11. 雲の形状評価と光学モデル

雲場の数値をそのままアルファ値として使うのではなく、`CloudShapeEvaluator` が粒状感、雲頂、被覆の不透明部分を共通の形状へ変換する。コンストラクタは `grainFrequency` を受け取り、`grainAt(direction, amplitude)` で `gradientNoise(direction * grainFrequency)` を評価する。`opaqueFraction(coverage, grain)` は粒度を被覆へ加え、`CUMULUS_DITHER_KNOB = { center: uniform(0.34), halfWidth: uniform(0.12) }` を使った dither へ変換する。coverage がない柱から雲を作らないこともここで保証される。

`cloudTop(fieldTop, grain)` は粒度による雲頂の揺らぎを加え、`cloudTopRadius(cloudTop, groundRadius)` は球殻内の半径へ変換する。`grainAmplitudeForWidth(width)` は `CUMULUS_GRAIN_SIZE = 6000` m を基準に、画面上で十分に小さい幅では粒度を弱める。`cloudTopUncertainty = .15 + 1 / 256` は表面の二分探索や境界判定が雲頂の数値誤差で壊れないための余裕である。

雲の光学は `cloud-optics.ts` の CPU 参照実装と `cloud-optics-node.ts` の TSL 実装で共有される。`columnOpticalDepthFromCoverage(coverage)` は `-log1p(-clamp(coverage, 0, .99))`、`transmittanceFromColumnOpticalDepth(tau, airmass)` は `exp(-tau * airmass)` を使う。地平線近くで球殻の空気量が発散しないよう、`shellAirmass(cosine, thickness, radius)` は接線付近で `sqrt(thickness / (2 * radius))` を使う有限な近似になる。

`cloudBasisOptics(low, middle, convective, inSitu, liquidWeight, iceWeight)` は液体雲の柱を `low + middle + .8 * convective` から作り、`liquidTauScale = 15` を掛ける。氷・薄雲側は `inSitu + .25 * convective` に `iceTauScale = 1` と、液体・氷の温度重みを掛ける。複数イベントを画面へ合成するときは `composeCloudEvents(events, backgroundTransmittance, backgroundRadiance)` が前から後ろへ進み、背景透過を一度だけ適用する。`tests/render/cloud-optics.test.ts` は光学的厚さ、接線空気量、イベント合成、背景の二重適用がないことを検証する。

## 12. 不透明な雲表面

近距離で見える積雲の塊と雲頂の輪郭は `src/render/opaque-cloud-surface-renderer.ts` の `OpaqueCloudSurfaceRenderer` が担当する。このクラスは `CloudShapeEvaluator`、`BlueNoise`、`CloudFieldSampler`、`groundRadius`、`grainFrequency`、`gradientAngle`、球メッシュの `SPHERE_LOD_LADDER`、現在の `activeLevel` を所有する。コンストラクタは `shellScale = 1 + CLOUD_TOP_SPAN / bodyRadius`、`groundRadius = 1 / shellScale`、`grainFrequency = bodyRadius / 6000` を計算し、球メッシュを `shellScale` で拡大して `markLitCloudShell` により `LIT_CLOUD_SHELL_LAYER = 5` へ置く。

詳細度は `CUMULUS_DETAIL = { off: 0, coarse: 1, standard: 2, fine: 3 }` とサンプリング表で決まる。粗い設定は 1 回の march と 5 回の refinement、標準は 6 回の march と 3 回の refinement、細かい設定は 12 回の march と 3 回の refinement を使う。`setDetail()` が設定を反映し、`syncLod(apparentDiameterPx)` が画面上の天体直径に合わせて `SPHERE_LOD_LADDER` のレベルを選ぶ。`hide()` はメッシュを隠すが、雲大気や影のトグルとは別経路である。

実際の交差判定は `marchedSurface()` が行う。視線と外側の雲殻の交点から開始し、`clearanceAt()` で方向の `CloudSample`、粒度、`opaqueFraction()`、雲頂半径を読み、雲殻の内側に入る最初の区間を探す。雲底へ抜ける場合には空の柱を雲として扱わないようにし、内側区間を見つけたら二分探索で境界を詰める。最終的な `hitPoint` から視線方向の深度と雲の法線を求める。

`buildMaterial()` は `material.depthNode = marched.w`、`normalNode = marched.xyz`、`colorNode = vec3(CLOUD_ALBEDO)` を設定する。`CLOUD_ALBEDO = .8` が不透明面の基本色であり、実際の色や光は後段の G-buffer、`LightPrepass`、`MaterialPass` から与えられる。空の柱は `Discard(hit < .5)` で破棄されるため、メッシュ全体を白い球として描くことにはならない。

## 13. 大気内の雲と巻雲

遠方の雲や大気の縁に見える雲は、厚いボリュームを何百回もレイマーチするのではなく、`src/render/pipeline/cloud-atmosphere-renderer.ts` の `CloudAtmosphereRenderer` が厚みのない球殻イベントとして扱う。`CLOUD_SHELL_DEFINITIONS` には `cirrus` と `cumulus` があり、巻雲は底 15 km・上 16 km、積雲は底 0 m・上 2 km の球殻である。巻雲の光学柱は `inSitu + .25 * convective`、積雲の光学柱は `cloudBasisColumnOpticalDepthNode(...)` から作る。

`CloudAtmosphereRenderer.set(clouds)` は `AtmosphereClouds` の入力を受け、`setShellEnabled(species, enabled)` で雲種ごとの表示を切り替える。`present()` は現在の入力と可視性を確認し、`scatteredAt(...)` は `CloudFieldSampler` で方向の雲をサンプルする。太陽放射、雲の被覆、局所の上向き法線と太陽方向の内積、アルベドから雲の局所放射を作り、`MAX_SHELL_OPTICAL_DEPTH = 5`、`MIN_SHELL_THICKNESS = 1` で不安定な極端値を抑える。

`src/render/pipeline/atmosphere-cloud-layers.ts` の `AtmosphereCloudLayers` は大気と雲殻をつなぐ。`setClouds()` と `setShellEnabled()` が入力を保持し、`transmittanceAt()` が雲殻だけの透過を求め、`build()` が各種の球殻交差を `CloudShellEvent` として作る。イベントの順番は外側から内側、退出側は逆順であり、`compose()` は `composeCloudEvents()` と同じ前後合成規約でイベントを一度ずつ適用する。大気本体の背景透過も `backgroundTransmittance` として別に渡されるため、雲の透過を二重に掛けない。

`src/render/pipeline/atmosphere-integrator.ts` の `AtmosphereIntegrator` は本体の大気散乱と雲殻を一つのレイ評価にまとめる。`write(body, steps, cutoffRadius)` が `BodySlot` と雲入力を更新し、`contribution(rayOrigin, rayDir, opaqueDist)` が球体または扁球体を球空間へ変換する。内部の `toSphereSpace()`、`sphereSpaceRay()`、`crossingsOf()`、`raySegment()` が交差区間を作り、`integrated()` が Chapman 近似の外向き深度、Rayleigh 位相、Henyey-Greenstein の Mie 位相を使って散乱を積分する。その区間へ `cloudGeometry()` と `AtmosphereCloudLayers.build()` が雲イベントを挿入する。

`src/render/pipeline/atmosphere-pass.ts` の `AtmospherePass` はフルスクリーンクアッドでこの大気結果を合成する。`composeLayers()` は近い draw を遠い順に扱い、現在の共有 HDR target を `backdropTarget` へコピーしてから `drawLayer()` を実行する。描画パスは `GPU_PASS.atmosphere` または `GPU_PASS.cloudAtmosphere` を使い、`setCloudShellEnabled()`、`setDraws()`、`inspectBackdrop()`、`inspectScattered()`、`compile()`、`render()`、`dispose()` を持つ。

## 14. 雲の影

雲が地面や物体へ落とす影は `src/render/pipeline/shadow/cloud-shadow-renderer.ts` の `CloudShadowRenderer` が担当する。入力型 `ShadowCumulus` は天体中心、表面半径、長軸・短軸、`bodyFromWorld`、`CloudRenderInput` を持つ。`set(cumulus)` が現在の候補を設定し、`casts()` が実際に影を投げられるかを返し、`transmittance(worldPos, footprint)` が受光点から太陽方向へ通過する雲の透過を計算する。

`CloudShadowRenderer` は `bodyFromWorld` と天体の軸を使ってワールド位置と太陽方向を雲殻空間へ変換する。`toShellSpace()` で球殻座標を作り、雲殻の出口までの光線を追跡し、`SHADOW_TAPS = 6` の中点サンプルを取る。`MAX_LIGHT_PATH = 300 km`、`STEP_BLUR = 2` を使ってサンプル間を積分し、各区間が雲頂より下にある割合を `CloudShapeEvaluator.opaqueFraction()` と組み合わせて光学的な減衰にする。

受光点が雲自身の上端近くにある場合に自分自身を過剰に遮蔽しないよう、`receiverFloorAltitude()` が受光点側の下限高度を決める。雲影と不透明表面は同じ `CloudFieldSampler` と `CloudShapeEvaluator` を使うため、画面で見える雲の穴や雲頂の粒度と、地面に落ちる影の濃淡が別の雲データからずれることを避けている。`ShadowPass` は本体、リング、メッシュ、積雲の影を乗算透過として蓄積し、`cumulusFootprint` は画素角、視距離、光線の入射角から決まる。

## 15. 大気本体と雲を含む描画パイプライン

`RenderPipeline` は `GBufferPass`、`ShadowPass`、`CloudShadowRenderer`、`LightPrepass`、`MaterialPass`、`AtmospherePass`、`OverlayPass`、`AntialiasPass`、`LensPass`、`SunLight`、`Exposure`、HDR の `target`、表示用の `displayTarget` を所有する。描画前の `compile(...)` は各パスの TSL グラフをコンパイルし、`rebuildForGraphics(...)` はレンズ、影品質、露出、太陽モデル、惑星光の数、アンチエイリアス、大気の雲殻、フィルム LUT を設定に合わせて再構成する。

`RenderPipeline.render(...)` の realistic 経路は、まず `DeferredTexture.publishOne`、ターゲットのリサイズ、視覚効果 LUT の更新を行う。続いて `flushProteinMotionComputes`、`shadowMaps.render`、`gbuffer.render`、`shadowPass.render`、`lightPrepass.render` の順で、動的計算、影、G-buffer、光の前計算を実施する。`GBufferPass` は法線、粗さ、深度、ベースカラーとメタルネス、発光を格納し、不透明な雲表面もここへ参加する。

その後 `materialPass.render` が共有 HDR target へ BRDF の結果を書き、必要なら大気デバッグのキャプチャを取り、`atmospherePass.render` が大気本体と雲殻を合成する。ワールド描画は `renderer.autoClear = false` で同じ target に続けて描かれ、必要なら `lensPass` がブルーム、ゴースト、回折などを付加する。最後に composite quad が HDR target を `displayTarget` へ移し、`overlayPass.render` が非物理的な 3D UI を足し、`antialiasPass.render` が FXAA、SMAA、または無効設定で最終画像を作る。

schematic スタイルでは、物理的な `MaterialPass`、`AtmospherePass`、ワールド、レンズ経路を通常どおりには通さず、`SchematicComposite` を使う。したがって realistic と schematic では、同じ天体や同じ雲場を持っていても、雲の光学や大気散乱が画面へ反映される経路が異なる。

描画レイヤーは `src/render/pipeline/lit-layer.ts` で定義される。`LIT_OPAQUE_LAYER = 1` は通常の不透明物、`WORLD_BACKGROUND_LAYER = 2` は背景、`OVERLAY_LAYER = 3` は UI、`SHADOW_CASTER_LAYER = 4` は影の供給元、`LIT_CLOUD_SHELL_LAYER = 5` は照明される雲殻である。`OpaqueCloudSurfaceRenderer` はこの `LIT_CLOUD_SHELL_LAYER` を使うため、不透明雲は通常の背景やオーバーレイと同じ深度・光の規約に埋め込まれる。

## 16. 設定、品質、LOD、GPU コスト

雲の見え方は `src/render/graphics-settings.ts` の `clouds`、`cloudFieldSource`、`cirrus`、`translucentCumulus`、`cumulusDetail`、`cumulusShadow`、`atmosphere`、`airglow` と品質プリセットで決まる。`clouds` を無効にすると `PointCelestialView.syncResolved()` が不透明雲を隠し、雲影候補も出さない。`cumulusDetail = off` は `OpaqueCloudSurfaceRenderer` の不透明表面と雲影を止めるが、`cirrus` と `translucentCumulus` の大気殻トグルは別に扱われるため、設定値を一つの「雲オン・オフ」と解釈してはいけない。

不透明雲の詳細度はサンプリング回数と球殻 LOD の両方に影響する。`syncLod(apparentDiameterPx)` は画面上の天体サイズに応じてメッシュ段階を選び、`grainAmplitudeForWidth()` は画面微分 `dFdx`、`dFdy` から粒度を抑える。大気側は `AtmosphereOptics` の品質に応じて 0、8、16、24 サンプル程度を割り当て、`allocateSamples()` が最大 `MAX_ATMOSPHERE_BODIES = 4` の候補へ最小・最大数を配分する。候補は `screenImpact()` のスコアで選ばれ、近いものから描画される。

GPU の計測名は `src/render/gpu-timings.ts` にあり、`GPU_PASS.cloudBake = 11`、`GPU_PASS.cloudSurface = 12`、`GPU_PASS.cloudAtmosphere = 13`、`GPU_PASS.cloudShadow = 14` である。`CLOUD_GPU_MEASUREMENTS` はこれらを人間向けの計測名としてまとめる。生成経路では `pressure`、`airMass`、`WeatherTransport`、`ConvectiveActivity` の焼き込みも発生するため、雲表面だけを測っても生成天気全体のコストにはならない。

## 17. 所有権と破棄

所有権は、地球の `PointCelestialView` が `CloudPresentation` を持ち、`CloudPresentation` が `OpaqueCloudSurfaceRenderer` と生成・観測の `CloudFieldSource` を管理し、生成ソースが `WeatherModel`、`CloudField`、`BakedField`、`AnnualClimateMap` を下へ持つという方向で構成される。描画時に `CloudFieldSampler` や `CloudAtmosphereRenderer` が入力を参照するが、これらは入力テクスチャのオーナーではない。したがって切り替えや終了時は、上位の `CloudPresentation.dispose()`、各 `CloudFieldSource.dispose()`、`BakedField.dispose()` の責務を守る必要がある。

`PointCelestialView.cumulusShadowAt(...)` は毎回新しい大きな雲データを作らず、`bodyFromWorld` などの再利用可能な行列を書き換えて `ShadowCumulus` を返す。一方、`atmosphereCloudsAt(...)` は後段で読むため、`writeBodyFromWorld(...)` の結果を新しい `Matrix4` として返す。`PointCelestialView.bakeClouds(...)` は `this.cumulus?.cloudsVisible` が真のときだけ `this.cumulus.bake(...)` を呼ぶ。この差は、フレーム同期中の一時的な再利用と、後から参照される描画入力の寿命を分けるためにある。

## 18. 現在のコードで確認できるテストと制約

雲モデルの純粋関数は `tests/render/cloud-model-contracts.test.ts` で検証されている。このテストは `cloudLifecycleAt()` の決定性、温度・相・垂直プロファイルの範囲、観測雲アダプターが画像から対流相を推定しないこと、地形パターン、サブグリッド表現を確認する。`tests/render/cloud-optics.test.ts` は前述の光学合成を、`tests/render/cloud-cap.test.ts` は `capRadiusFor` と `CLOUD_CAP_SIZE = 512` を確認する。

気象の時間と配置については `tests/render/cyclone-tracks.test.ts`、`tests/render/cyclones.test.ts`、`tests/render/atmospheric-wind.test.ts`、`tests/render/weather-time.test.ts` がある。低気圧トラックの決定性と連続性、`LOW_COUNT = 8`、熱帯低気圧の周期、風場の範囲、時間同期の契約が主な対象である。`tests/render/atmosphere.test.ts` は大気モデル、`tests/render/gpu-timings.test.ts` は GPU パスの計測識別子を確認する。ゲーム側では `tests/game/earth-system.test.ts` が地球データの範囲を確認する。

ただし、現在確認できたテストは純粋な気象・光学・データ範囲の契約を中心としており、地球の生成雲を実際の WebGPU パイプラインで一フレーム描き、画面上の表面・大気・影が同一フィールドを参照していることを一つの統合テストで保証するものではない。実際の見た目を確認する場合は、リポジトリの `npm run cloud-lab`、`npm run cloud-lab:shot`、`npm run cloud-lab:compare`、`npm run render-lab`、`npm run render-lab:shot` が用意されている。これらはコード上の契約テストとは別の実機確認である。

## 19. 現在の実装上の重要な境界と読み方

第一の境界は、気候、天気、雲、描画の境界である。`AnnualClimateMap` は静的な気候の入力、`WeatherModel` は時刻と気候から方向ごとの気象中間値を作るモデル、`condense()` は中間値を雲基底へ変換するモデル、`CloudPresentation` は供給元を切り替える描画アダプター、三つの雲レンダラーはその基底を画面へ異なる投影で表す層である。どの層も前の層の意味を少しずつ圧縮するため、`meanCloudiness` と `coverage`、`cloudTop` と実際の不透明交差点を同一視してはいけない。

第二の境界は、現在使われる経路と補助・契約コードの境界である。`cloudLifecycleAt()`、`cloudVerticalProfileAt()`、`orographicPattern()`、`orographicPatternForcing()`、`CloudState` と `CloudField.stateAt()` などは、テストや将来のモデル拡張を支えるコードとして存在する。しかし現在の生成焼き込みの主経路を説明するときは、`GeneratedCloudField.prepare()` から `WeatherModel.bake()`、`CloudField.render()`、`condense()` へ至る経路を中心にし、補助関数が毎フレーム最終アルファを決めているとは書かない方が正確である。

第三の境界は、物理大気と描画大気の境界である。`src/physics/atmosphere.ts` の `Atmosphere`、`ellipsoidAltitude()`、`atmosphericDensity()`、`atmosphericScaleHeight()`、`airspeed()`、`airflow()`、`dragAccel()` は物理計算であり、`src/render/atmosphere.ts` の `AtmosphereOptics`、`AtmosphereIntegrator`、`AtmospherePass` は視覚計算である。現在の `WeatherModel` の `surfaceWind` や `pressure` を物理機体へ戻す呼び出しは、この雲・描画経路にはない。

## 20. コード参照の短い地図

全体の入口は `src/game/game-presentation.ts` の `GamePresentation.syncWorld()`、天体と照明の接続は `src/game/celestial/celestial-system.ts` の `CelestialSystem` と `CelestialIllumination`、地球固有の構成は `src/game/celestial/solar-system/earth-system.ts` の `earthSystem()` と `earthCloudPresentation()` である。生成天気の中心は `src/render/cloud/weather-model.ts` の `WeatherModel.weatherAt()`、`syncTime()`、`bake()`、雲への変換は `src/render/cloud/condensation.ts` の `condense()` である。

フィールド供給は `src/render/cloud/generated-cloud-field.ts` の `GeneratedCloudField`、`src/render/cloud/observed-cloud-field.ts` の `ObservedCloudField`、共通接続は `src/render/cloud/cloud-presentation.ts` の `CloudPresentation`、投影は `src/render/cloud/field-projection.ts` の `EquirectProjection` と `OrthographicCap`、GPU 焼き込みは `src/render/cloud/baked-field.ts` の `BakedField` である。共通の数値意味は `cloud-field-sample.ts`、共通の参照は `cloud-field-sampler.ts`、形状は `cloud-shape-evaluator.ts`、光学は `cloud-optics.ts` と `cloud-optics-node.ts` にある。

画面への三つの接続は、近距離の `OpaqueCloudSurfaceRenderer`、大気中の `CloudAtmosphereRenderer`・`AtmosphereCloudLayers`・`AtmosphereIntegrator`、光の `CloudShadowRenderer` である。全体の順序は `src/render/pipeline/render-pipeline.ts` の `RenderPipeline.render()`、設定は `src/render/graphics-settings.ts`、レイヤーは `src/render/pipeline/lit-layer.ts`、GPU 計測は `src/render/gpu-timings.ts` を見ると追える。

この地図の読み順に従えば、まず `GamePresentation.syncWorld()` から始めて `earthCloudPresentation()` を確認し、次に `GeneratedCloudField.prepare()`、`WeatherModel.weatherAt()`、`condense()`、`CloudField.render()` を読む。その後 `CloudPresentation.renderInput` が `OpaqueCloudSurfaceRenderer`、`CloudAtmosphereRenderer`、`CloudShadowRenderer` へどう渡るかを追い、最後に `RenderPipeline.render()` で三つの表現が G-buffer、影、HDR、大気、最終合成へどう組み込まれるかを確認できる。
