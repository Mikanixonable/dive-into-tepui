# 上昇流源の風下プルーム(島嶼雲道・地形性・平地の過渡源)— 実装計画

要求: チェジュ島スケールの島で地形性上昇が観察できるようにし、上昇流の源の風下へ
持続的に残るテーパー状の雲(島嶼雲道 cloud trails)を気象システムへ組み込む。
テーパーは地形がなくても起きる — 平地でも一時的な上昇流源が一定時間持続し、
発生した雲が風下へ移流しながら発達して先細りの帯になる。島・山の雲道も
**この平地の過渡源と同じ原理で**実装する(地理に錨づいた源 + 移流 = テーパー)。

文献の裏付け(調査済み):

- Nordeen et al. 2001(ナウル島): 雲プルームは午後に成長、平均 125 km・最大 425 km、
  発生率は午後 63%。貿易風の風下へ伸びる。
- Cloud Trails Past the Lesser Antilles (MWR 2016): 各島で観測日の 30–40%。
  **午後・島の日射加熱が駆動**(平らな島でも発生)。貿易風 6–10 m/s と強い貿易
  逆転層でよく組織化。
- Yang & Xie(IPRC, ハワイ): 昼の雲道は夜に消える → 機械的収束だけでは足りず、
  日射加熱が必須。
- Banner clouds(マッターホルン等): 山頂の風下に貼り付く三角旗状の雲は
  機械的(lee vortex)で、昼夜に関係なく出る。
- 平地では中規模対流系(MCS)が数時間〜1日持続し、その雲・湿りが風下へ
  流れて発達する — 源が消えても帯は残り、風上に尖る形になる。

## 現状(調査済み・2026-11-16 時点)

- `weather-model.ts:221` の `terrainLift = dot(surfaceWind, slope) × TERRAIN_LIFT_GAIN` は
  あるが、斜面は `climate.slope`(SLOPE_STEP=0.02 rad ≈ 127 km の中心差分)を
  512×256(≈78 km/px)の `earth-climate.png` から取る — チェジュ島(約 73 km)は
  解像されない。lift が生む湿りは**移流後にその場で足すだけ**(`SURFACE_LIFT_HUMIDITY`
  /`UPPER_LIFT_HUMIDITY`)なので、風下へ残らない。
- 湿度源 `humiditySourceAt` は基底+循環ノイズのみで地理的項なし。
- **`CirculatingNoise` は circulation に運ばれる** — 模様が風と一緒に流れるので、
  「定点の源」にはならずテーパーは出ない(源が空気と共に動くと尾は出来ない)。
  ただし**エポック機構**(実現の混ぜ替え、18 h 移行)が既にあり、低周波段は
  その場で発達・衰退する — 過渡源の「一定時間持続して消える」性質はこの機構で
  出せる。`at(direction)` は時刻引数を取らず uniform 束縛(発射時刻評価は不可)。
- 気候テクスチャは `tools/export-climate.mjs` が **GEBCO 21600×10800(≈0.6 km/px)**
  から焼く(標高は σ=200 km でぼかして出力)。高解像データは `assets-src/climate/`
  に既にある(`fetch-climate-source.mjs` が取り込む)。
- ベイク順は `pressure → airMassTrace → transportSource → cloud+environment MRT → motion`。
  `transportSource` ベイク時点では気圧の写しが焼けているので `winds.at` が読める。
- `BakedField` は Vec4Node[] の MRT 対応済み。`at(direction, output)` で出力番号を読む。
- 移流は 2 位相(位相差 0.5)で、遡る秒数は `phaseA/B × (−ADVECTION_PERIOD=20h)` の
  **フィールド共通 uniform** — texel ごとではなく全体で 1 つの発射時刻を持つ。
- 自転位相は `eciPole` + `w0Deg=190.147+90`(IAU W、J2000 元期)。ゲームの昼夜は
  実暦の太陽方向から来る。経度は `atan(direction.x, direction.z)/2π`(経度 0 が +Z、
  東が +X — `equirectUvFromDirection` と同じ規約)。
- モデルに日変化はない(気候は平年のみ)。

## 設計 — 統一原理

**地理に錨づいた上昇流源を移流の前段の源場へ注入する**。源は島・山・平地の
過渡点で、その場に限って立つ → 風下の点は「風上を遡って源に届いた」ときだけ
湿る → 既存の 2 位相移流が風下へ伸ばし、遡りが届かない遠方では 0 へ落ちる。
**風上に尖るテーパーと、風速×20 h(≈600 km)までの有限の伸びは移流から無料で出る。**

3 種の源はすべてこの 1 機構を共有し、発火条件だけが違う:

| 源 | 式 | 時間性 |
| --- | --- | --- |
| 平地の過渡源 | `fineLandFraction × transient` | エポックの混ぜ替えで数時間〜日単位で生滅 |
| 島・陸の日射加熱 | `fineLandFraction × diurnalGate(地方時)` | 毎日の昼だけ(発射時刻でゲート) |
| 地形性上昇 | `max(dot(surfaceWind, fineSlope), 0)` | 常時(banner cloud 相当) |

### 1. 高解像地形入力: `earth-terrain.png`(新規アセット)

`export-climate.mjs` に第 2 出力を追加し、同じ GEBCO 源から焼く。

- 解像度: **4096×2048(≈10 km/px)**。チェジュ島(73 km)を約 7 px で解像。
  不採用: 2048×1024 — チェジュ島で 3.5 px しかなく、島の風上/風下の勾配が潰れる。
- 内容(RGB8): **R = 東向き勾配、G = 北向き勾配 [m/m]、B = 細かい陸らしさ 0..1**。
  勾配は GEBCO 原画像から σ≈15 km でぼかした標高の差分で事前計算して焼く
  (シェーダ内の差分より良質で、読みは 1 tap になる)。勾配の符号化レンジは
  ±0.06 m/m(8 bit ≈ 4.7e-4/段)。陸らしさは標高 0..100 m の smoothstep を
  σ≈10 km でぼかしたもの — 湖・小島も 10 km 級なら入る。
- ぼかしの σ は 15 km 前後で見えを確認して決める(大きすぎると島が沈む)。
- `cloud-field.png` 等と同じく `src/assets/` へ。PNG は滑らかな場なので圧縮が効く。
  (実測して 10 MB を大きく超えるなら 2048×1024 へ下げる判断を報告する。)

### 2. `TerrainMap` — 地形の細かい面の入力

`climate-map.ts` とは別に `src/render/earth-weather/terrain-map.ts` を新設する
(気候 = 低周波の年季節平均・地形 = 静的な高周波面、という責務の違いから分ける)。

```ts
export interface TerrainMap {
  readonly generation: number;
  // 単位方向における勾配(東向き・北向き成分)[m/m]。
  slope(direction: Vec3Node): Vec2Node;
  // 単位方向における陸らしさ 0..1(10 km 級まで解像)。
  landFraction(direction: Vec3Node): FloatNode;
  request(): void;
  dispose(): void;
}
```

`TerrainMap.fromDeferredUrl(url)` — `AnnualClimateMap` と同じ DeferredTexture 経路。
`earthGeneratedCloudField` が `terrainTextureUrl` を受けて WeatherModel へ渡す。
既存の `climate.slope`(LAND_HEIGHT_BIAS 込み・山脈級)は**そのまま残す** —
`terrainLift` は下記「置き換え」で役割を変える(下記「保留」参照)。

### 3. 地方時

`src/render/earth-weather/` に小さな関数(weather-model.ts 内の純粋関数で可):

```ts
// 単位方向における地方時 [時 0..24)。表示時刻 seconds と経度からの近似 —
// 平均太陽日で回る架空の日周だが、場は表示時刻の純関数のまま。
localSolarHour(direction, seconds) =
  fract(seconds / MEAN_SOLAR_DAY + longitude(direction) / 2π + SOLAR_EPOCH) × 24
```

- `MEAN_SOLAR_DAY = 86400`。`SOLAR_EPOCH` はゲームの実暦と位相を合わせる定数で、
  **実装時に実測で較正する**: displayTime=0 でゲームの太陽直下点経度を
  既存の暦(軌道要素)から評価し、`SOLAR_EPOCH` を決める(雲の昼夜が地表の
  昼夜境界と視覚的にずれないため)。lab では displayTime がそのまま効く。
- 正確な暦(傾斜・均時差)は入れない — 数十分のずれは雲道の見えに効かない。

### 4. 上昇流源 — transportSource へ注入(本設計の核心)

`WeatherTransport` の `source` BakedField を **MRT 2 出力**へ:

- out0(既存): `vec4(humiditySource.xy, convectionSource.zw)` — 不変。
- out1(新規): `vec4(upliftA, upliftB, 0, 0)`。
  - `upliftA = upliftSource(direction, seconds + phaseA × (−ADVECTION_PERIOD))`
  - `upliftB = upliftSource(direction, seconds + phaseB × (−ADVECTION_PERIOD))`
  - 発射時刻のゲートをチャンネルごとに焼き分ける — **昼だけ立つ源が、夜にも
    風下へ残る**ようにするため(発射された湿りは昼に島を出て、夜に風下へ
    着いても湿ったまま)。current-time ゲートではプルーム全体が瞬時に消灯して
    不連続になる(不採用案)。
- `advectedAt` は同じ displaced 位置で out1 も読み、地表湿度へ足す:

  ```
  uplift = mix(out1.y @B-point, out1.x @A-point, weightA)
  surfaceHumidity = 既存の値 + uplift
  ```

- `syncTime` が `seconds` を uniform として保持する(発射時刻の計算に要る)。

`upliftSource(direction, emissionSeconds)`(WeatherModel が供給、transport は
関数として受け取る):

```
transient = fineLandFraction(d) × TRANSIENT_GAIN × transientField(d)
thermal   = fineLandFraction(d) × diurnalGate(localSolarHour(d, emission)) × LAND_HEATING_GAIN
oro       = max(dot(surfaceWindAt(d), fineSlope(d)), 0) × OROGRAPHIC_GAIN
upliftSource = transient + thermal + oro
```

- `diurnalGate(hour) = smoothstep(9, 12, hour) × (1 − smoothstep(16, 19, hour))`
  — 午前中に立ち上がり夕方に降りる窓。定数で固定(文献: 午後ピーク)。
- `transient`(平地の過渡源)は昼夜を問わない — MCS は夜にも持続する。
  ゲートを掛けるのは日射加熱項だけ。
- `transientField` は**地理に錨づいたノイズ**(下記 §5)。発射時刻評価は
  uniform 束縛のため不可なので**現在時刻で評価** — 実現が変わるのは 18 h
  スケールで、発射時刻(≤20 h 前)とのずれは実用上許容(「曖昧・保留」)。
- `oro` は昼夜を問わない(banner cloud 相当の機械的上昇)。wind はその点の
  `winds.at(d).surfaceWind` — ベイク時に圧力の写しが焼けているので読める。
  風は発射時刻ではなく**現在時刻**で評価する(気団追跡 `traceFlowAt` と同じ
  近似 — 源の位置を風上へ遡る経路の風も現在時刻の場で引いているので一貫)。
- `LAND_HEATING_GAIN`/`OROGRAPHIC_GAIN`/`TRANSIENT_GAIN` は CLOUD_TUNING へ
  (lab スライダー化)。湿度源は 0..1 系なので、島で 0.2–0.5 程度が目安(実装時に調整)。

### 5. `EpochNoise` — 地理に錨づいた過渡源

`CirculatingNoise` から**エポックの混ぜ替え + オクターブ評価**を `epoch-noise.ts`
へ切り出し、共有する:

```ts
export class EpochNoise {
  // octaves・texelAngle・epochMaxFrequency は CirculatingNoise と同じ。
  // transitionSeconds は混ぜ替え 1 周期 [s](既定 18 h — 過渡源なら短くしてもよい)。
  public constructor(octaves, texelAngle, epochMaxFrequency?, transitionSeconds?);
  // 3D 位置での値 −1..1(エポックを現在の 2 実現で混ぜた値)。
  public at(position: Vec3Node): FloatNode;
  public syncTime(seconds: number): void;
}
```

- `CirculatingNoise` は `circulation.carry(direction, (p) => epochNoise.at(p))`
  の形へ内部を差し替えるだけ(振る舞い不変 — carry はそのまま、実現の
  混ぜ替えも従来どおり)。
- `transientField` は `EpochNoise` を **`circulation.carry` を通さず `direction`
  をそのまま位置として評価**する — 模様は球面へ固定され、エポックの混ぜ替え
  (既定 18 h、過渡源なら `transitionSeconds` を 6–9 h にしてもよい)だけで
  発達・衰退する。**循環に運ばれないからこそ定点の源になり、移流でテーパーが出る。**
- オクターブ: 中規模対流系相当の周波数(f ≈ 32–96、波長 200–400 km 級)を
  複数段重ねる。源の寿命は移行時間と模様の時間相関で決まる。
- `transientField` は WeatherModel が持ち `syncTime` で同期させる
  (源の式を束ねるのが model の責務なので、ノイズも model 側へ)。

### 6. 既存項の置き換え(二重実装の回避)

- **`SURFACE_LIFT_HUMIDITY` を削除** — 「正の地形リフトが移流後にその場へ湿りを
  足す」既存項は、transportSource へ注入した `oro` 項が**同じ物理を上游注入で
  果たす**ため不要になる(その点自身も lag≈0 の位相で源を拾うので、山の直上の
  即応答は保たれる)。`cloud-tuning.ts` の `surfaceLiftHumidity` キーも消す。
- `UPPER_LIFT_HUMIDITY`・`SUBSIDENCE_DRYING`・`LIFT_ACTIVITY` は残す —
  上層の湿り・沈降乾燥・対流活動への入力は別の責務(上層の雲道は今回の
  スコープ外)。
- `LAND_ACTIVITY` は残す — 活動度の陸の補正は湿りの源ではない。
- `transientField` と既存の `convectionNoise` は**責務が違うので両方残す** —
  対流ノイズは流れに運ばれて動く対流セル(その場の対流度)、過渡源は定点で
  湿りを出し続ける発生源(尾を引く雲道)。前者を源の代わりに使うと模様が風と
  一緒に流れて尾が出ない。

### 7. SPEC 更新(docs(spec) 単独 commit)

「雲の描画」節へ追加:

- 島や山脈の風上側に立った雲は風下へ続き、源に向かって先細る帯(雲道)になる。
- 島の雲道は日射で温まる昼間に立ち、夜には縮んで消える(日変化)。
- 山の地形性の雲は昼夜を問わず風下へ伸びる。
- 平地でも一時的な対流の源が数時間持続し、その雲が風下へ移流して先細る帯を
  作ることがある(源の発生・衰退はその場で起きる)。

### 8. lab/検証

- 生成パラメータに 3 キー(LAND_HEATING_GAIN / OROGRAPHIC_GAIN / TRANSIENT_GAIN)
  を追加。
- 目視: `cloud-lab` の cap をチェジュ島(33.5°N, 126.5°E)・半径 5–10° に向け、
  午前/午後/夜で shot。風下へのテーパー・昼夜の消長を確認。アンデス(20°S, 70°W)
  で地形性の伸び、大陸の平地(中央アジア・北米大陸)で過渡源の帯も確認。
  `observedComposite`/`composite` との見比べ。
- `surfaceHumidity` ビューでプルームの分布も確認できる(診断用に十分なので
  専用ビューは足さない)。

## 実装手順

1. `docs(spec):` 「雲の描画」に雲道・日変化・平地の過渡源の記述を追加(単独 commit)。
2. `tools/export-climate.mjs` に `earth-terrain.png` 出力を追加し、
   `npm run export-climate` 相当で `src/assets/earth-terrain.png` を生成
   (GEBCO が assets-src に無い環境では `fetch-climate-source.mjs` 先)。
   勾配の符号化レンジは試行して決める。
3. `terrain-map.ts` 新設 + `earthGeneratedCloudField`/`earthCloudPresentation` の
   引数へ terrain テクスチャを足し、`earth-system.ts` と全 lab 呼び出し箇所
   (cloud-lab main・motion-lab・weather-probe・synoptic 等のフィールド構築)を
   追従させる。WeatherModel の constructor に terrain を追加。
4. `epoch-noise.ts` 切り出し — `CirculatingNoise` のエポック+オクターブ評価を
   `EpochNoise` へ抽出し、既存側は carry で包むだけにする(振る舞い不変の
   リファクタとして先に commit してもよい)。
5. `WeatherTransport` を MRT 2 出力 + uplift チャンネルへ拡張し、
   `advectedAt` で地表湿度へ加算。constructor に `upliftSource` 関数を足す。
6. `WeatherModel` に `transientField`(EpochNoise)と `upliftSourceAt` を実装
   (fineSlope・fineLandFraction・surfaceWind・localSolarHour・transient を束ねる)。
   `SOLAR_EPOCH` を暦で較正して定数化。
7. **`SURFACE_LIFT_HUMIDITY` の削除** — `weatherAt` の正のリフト加湿項と
   `cloud-tuning.ts` の `surfaceLiftHumidity` キーを消す(§6「置き換え」)。
8. `cloud-tuning.ts`・`generation-params.ts` へ 3 キー追加。
9. 検証: typecheck / test:render / check:boundaries / cloud-lab:shot。
   `localSolarHour` を採るなら src/math ではなく earth-weather 内の関数なので
   test:render 側で振る舞いを確認する。

ベイクのパス数は 5 のまま(MRT で同じ 1 パスが 2 出力になるだけ)。評価コストは
transportSource の texel あたり winds・地形・日周ゲート・過渡源の評価が +2 回
増える分。

## 不採用案

- **current-time ゲート(発射時刻ではなく今の地方時で源をゲート)**:
  プルームが昼夜の切れ目で全域瞬時に消灯する不連続。2 位相の発射時刻ゲートを
  採ることで混ぜ合いによる漸消が無料で得られる。
- **過渡源を循環に運ばせる(既存 convectionNoise や humidityNoise を源に使う)**:
  模様が風と一緒に流れると定点の源にならず、風下へ尾を引かない — テーパーの
  条件(源は地理に固定、出た雲だけが流れる)を満たさない。EpochNoise を carry
  なしで評価するのが正しい。
- **過渡源を恒常的な固定模様にする(epoch 混ぜ替えなし)**:
  源が恒常化してしまい「平地で一時的に立つ」性質を失う。エポック機構で
  発生・衰退を入れる。
- **earth-climate.png を高解像化**: 気候全チャンネルを 4096 化すると数 MB 級の
  無駄(気温・雲量は低周波)。地形だけ別テクスチャへ。
- **チェジュ島等の島を点データとして別注入**: 実在の地形ではなくなる。
  GEBCO 実地形からの勾配で統一する。
- **`climate.slope` の細粒化(LAND_HEIGHT_BIAS 込みの既存項まで置き換え)**:
  海風収束の代用斜面は 800 m の人工件で、細かい陸らしさと掛けると海岸の
  ノイズに化ける。今回は触らない(保留参照)。
- **発射パケットを厳密に追跡する水質量モデル**: SPEC の到達点には水の質量
  運搬があるが今回のスコープ外。発射時刻ゲートで見えは実用上十分。

## 曖昧・保留

- `SOLAR_EPOCH` の較正: 実装時に displayTime=0 の太陽直下経度を暦から測って
  定数へ落とす。lab と game で同じ displayTime 系なので一発で合う。
- `transientField` の発射時刻評価: uniform 束縛のため現在時刻で評価する近似。
  実現が変わる時間(18 h 既定)は発射時刻の lag(≤20 h)と同程度なので、
  源の強さ履歴は粗いが、生滅そのものは出る。精度が要るなら発射時刻ごとの
  実現を混ぜる拡張が別途要る(スコープ外)。
- `transientField` の移行時間: 既定 18 h のまま使うか、過渡源向けに短くするか
  (`transitionSeconds` 引数を用意しておく)は見えを見て決める。
- プルーム → `convectiveActivity` への連結(雲道の中で粒を立たせる):
  surfaceHumidity だけでは板になる可能性。実装して見て物足りなければ
  `convectiveActivity.at` の land 項へプルーム量を混ぜる(stretch 項目)。
- `LAND_HEIGHT_BIAS` の既存 terrainLift と細かい地形斜面の併用:
  `SURFACE_LIFT_HUMIDITY` は消すが、沈降乾燥・対流活動には粗い斜面を
  使い続ける。気持ち悪い重なりが見えたら粗い項の LAND_HEIGHT_BIAS を再検討。
- `earth-terrain.png` の B(細かい陸らしさ)は今回は島の加熱にしか使わないが、
  湖沼(Q1 で挙がった未実装の水域加湿)の土台にもなる — ここでは足さない。
- `fetch-climate-source.mjs` が取り込むデータが手元に無い環境では
  terrain テクスチャの再生成ができない — 生成物は assets へ commit するので
  実用上は問題ない。
