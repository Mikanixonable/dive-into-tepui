# 上昇流源と風下プルームの実装計画

状態: 実施済み。仕様 `237190ba5` → 実装 `7c2cc728f`(上昇源を移流へ供給して風下へ雲道を
なす)、地形テクスチャ `6c08d41bc`、撮影スクリプト `959d77f5d`。

島嶼雲道、地形性上昇、陸上・海上の過渡的な上昇源を、共通の移流機構で扱う。

## 目的

チェジュ島程度の大きさの島でも地形性上昇を表現できるようにし、上昇流の発生源から風下へ伸びる雲の帯（雲プルーム）を気象システムに組み込む。

雲プルームは地形がなくても発生する。平地や海上に一時的な上昇源が生じ、その場所で一定時間活動した後、発生した湿りや雲が風下へ移流することでも、帯状の雲が形成される。島や山の雲道も、独立した描画機構を設けるのではなく、**地表上の位置に固定された上昇源と、その源から供給された湿りの移流**という同じ仕組みで表現する。

本計画では、上昇源の発生条件を複数用意し、それらを共通の源場に加算する。源場の評価、風下への移流、移流後の減衰は共通処理とする。

## レビューで反映した設計上の修正

- **過渡源は陸上・海上の両方に発生させる。** 過渡源に陸地マスクを掛けない。陸地マスクは、島や陸地の日射加熱と地形性上昇に使用する。
- **地形性上昇には陸地マスクを掛ける。** GEBCO の標高データには海底地形も含まれるため、海底の勾配が大気の上昇源として解釈されないようにする。
- **過渡ノイズを正の活動度に変換する。** `EpochNoise` の出力は −1〜1 なので、そのまま湿度へ加算しない。閾値と滑らかな遷移を設け、活動している領域だけを上昇源にする。
- **移流後の経過時間に応じた減衰を追加する。** 移流だけで先細りが必ず生じるわけではない。源の活動時間とは別に、風下へ運ばれた湿りが徐々に弱くなる共通の減衰を設ける。
- **過渡源は各サンプルの発生時刻で評価する。** 現在時刻のノイズを過去の発生源として流用すると、過去の源の位置や強度を正しく表せない。2位相それぞれの発生時刻を `EpochNoise` に渡せる構成を優先する。

## 文献上の参考事項

以下は、この計画の作成時に整理した参考知見である。実装時に再確認が必要な数値や解釈は、シミュレーションの定数として直接固定せず、調整の目安として扱う。

- **Nordeen et al. (2001)、ナウル島：** 雲プルームは午後に発達し、平均長は約 125 km、最大約 425 km。午後の発生率は 63%で、貿易風の風下へ伸びる。
- **Cloud Trails Past the Lesser Antilles（MWR, 2016）：** 島ごとに観測日の 30〜40%で雲道が確認された。平坦な島でも、午後の日射加熱が雲道の形成に関与する。貿易風が 6〜10 m/s で、貿易風逆転層が明瞭な条件では、雲道が組織化されやすい。
- **Yang & Xie（IPRC、ハワイ）：** 昼間の雲道が夜間に消えることから、機械的な収束だけでなく日射加熱が重要とされる。
- **Banner clouds（マッターホルンなど）：** 山頂付近の風下に旗状に形成される雲。日射に依存せず、地形による機械的な上昇・風下側の流れに関係する。
- **平地の過渡的な対流系：** 中規模対流系（MCS）などは数時間から1日程度持続することがある。発生源が弱まった後も、雲や湿りが風下へ移流して残る。

## 現状

以下は元計画書に記載されたコード構成・調査結果を前提とする。実リポジトリ上の現状をこのレビューで再調査したものではない。

- `weather-model.ts:221` に `terrainLift = dot(surfaceWind, slope) × TERRAIN_LIFT_GAIN` がある。ただし、斜面は `climate.slope` から取得している。`climate.slope` は `SLOPE_STEP=0.02 rad`（約 127 km）の中心差分で、512×256（約 78 km/px）の `earth-climate.png` を参照するため、約 73 km のチェジュ島を十分に解像できない。
- 現在の `SURFACE_LIFT_HUMIDITY` / `UPPER_LIFT_HUMIDITY` は、リフトが生じた場所で移流後に湿りを加える方式である。このため、上昇源から風下へ伸びるプルームは形成されない。
- `humiditySourceAt` は基底値と循環ノイズを中心に構成されており、地形に固定された上昇源は含まれていない。
- `CirculatingNoise` は `circulation` に沿って評価位置が移動する。したがって、ノイズ模様そのものが風とともに移動し、地表上の定点にある発生源としては使いにくい。
- 一方、既存のエポック機構には、ノイズの実現を一定時間かけて混ぜ替える仕組みがある。これを地表座標上で評価すれば、場所を固定したまま時間とともに発生・衰退する過渡源を表現できる。
- 現在の `at(direction)` は時刻を引数に取らず、時刻は uniform として束縛される。そのままでは、移流の各位相に対応する過去の発生時刻でノイズを評価できない。
- 気候テクスチャは `tools/export-climate.mjs` が GEBCO の 21600×10800（約 0.6 km/px）データから生成する。標高は σ=200 km で平滑化されている。高解像度の元データは `assets-src/climate/` にあり、`fetch-climate-source.mjs` で取得する。
- ベイク順は `pressure → airMassTrace → transportSource → cloud+environment MRT → motion`。`transportSource` のベイク時点では気圧場がベイク済みなので、`winds.at` を参照できる。
- `BakedField` は `Vec4Node[]` による MRT に対応しており、`at(direction, output)` で出力を指定できる。
- 移流は位相差 0.5 の2位相方式である。遡る時間は `phaseA/B × (−ADVECTION_PERIOD=20h)` で表し、位相はフィールド全体で共有する uniform として与えられる。
- 自転位相は `eciPole` と `w0Deg=190.147+90`（IAU W、J2000 元期）に基づく。ゲーム内の昼夜は実暦の太陽方向から決まる。経度は `atan(direction.x, direction.z) / 2π` で求め、経度 0 を +Z、東を +X とする。この規約は `equirectUvFromDirection` と一致する。
- 現在の気候モデルに日変化はなく、気候値は平年値を基礎としている。

## 設計方針：上昇源を共通の源場にまとめる

**上昇源の種類ごとに別の雲道システムを作らず、各発生条件を単一の `upliftSource` にまとめる。** `upliftSource` は地表上の位置と発生時刻から、その場所で供給される湿りの量を返す。移流側は発生源の種類を区別せず、この値を風上へ遡ってサンプリングする。

処理の流れは次のとおり。

1. 地表上の各位置で、過渡的な対流、日射加熱、地形性上昇の各項を評価する。
2. 各項を加算し、共通の `upliftSource` を得る。
3. 移流の各位相について、風上へ遡った位置と、その位置での発生時刻に対応する `upliftSource` をベイクする。
4. 現在位置から風上へ遡って源場をサンプリングし、位相を混ぜ合わせる。
5. 発生からの経過時間に応じた減衰を適用し、地表湿度に加える。

この方式なら、地形性上昇源は地形と風向によって位置が決まり、過渡源は地表上にランダムに発生して時間とともに変化する。どちらも、源場から供給された湿りだけが移流する。

### 上昇源の種類

| 種類 | 発生条件 | 時間的な性質 |
| --- | --- | --- |
| 陸上・海上の過渡源 | `transientActivity` | 地表上のランダムな位置に発生し、数時間から1日程度の時間スケールで発達・衰退する。陸地マスクでは制限しない。 |
| 陸地の日射加熱 | `fineLandFraction × diurnalGate(localSolarHour)` | 陸地で日中に発生する。発生時刻に応じて評価するため、夜になっても、昼間に生成されたプルームは移流先に残る。 |
| 地形性上昇 | `fineLandFraction × max(dot(surfaceWind, fineSlope), 0)` | 風が斜面を上るときに発生する。日射には依存しない。 |

3種類は物理的な発生条件こそ異なるが、すべて同じ `upliftSource` に加算し、同じ移流・減衰処理を通す。

なお、ここでいう「固定された源」とは、源の位置が地表座標に固定されているという意味である。過渡源は同じ場所で永続的に発生するのではなく、地表座標上のノイズ模様が時間とともに変化することで、発生・衰退を表す。

## 1. 高解像度の地形入力：`earth-terrain.png`

`export-climate.mjs` に第2の出力を追加し、既存と同じ GEBCO データから地形テクスチャを生成する。

- **解像度：** 4096×2048（赤道付近で約 10 km/px）。チェジュ島（約 73 km）を横方向に約7ピクセルで表現できる。2048×1024では約3.5ピクセルとなり、島の形状や斜面の勾配が十分に表現できない可能性がある。
- **チャンネル：** RGB8 を使用する。R は東向き勾配、G は北向き勾配（いずれも m/m）、B は陸地の重み `fineLandFraction`（0〜1）とする。
- **勾配：** GEBCO の標高を σ≈15 km で平滑化した後、東西・南北方向の差分から計算する。シェーダー内で複数回差分を取るより、生成時に計算して1回のテクスチャ参照で取得する方針とする。
- **勾配の符号化：** ±0.06 m/m を8 bitに割り当てる。量子化幅は約 4.7×10⁻⁴ m/m となる。符号化時にはゼロ勾配が中間値になるようにし、読み出し時に元の範囲へ復号する。
- **勾配の座標系：** 経緯度グリッドの東西方向の距離は緯度によって変わる。東向き・北向きの勾配は、緯度に応じた実距離へ換算したうえで計算し、局所的な東・北方向の成分として格納する。
- **陸地の重み：** 標高 0〜100 m の範囲を `smoothstep` で変換し、σ≈10 km で平滑化する。海岸線を滑らかにし、小島や湖沼も10 km級のスケールで表現する。ただし、この値は厳密な土地被覆データではなく、標高から求めた陸地の重みである。
- **平滑化の調整：** σ≈15 km を初期値とし、チェジュ島などの小島が過度に縮小しないか確認して調整する。
- **配置：** `cloud-field.png` などと同様に `src/assets/` へ配置する。滑らかなデータなので PNG 圧縮が期待できる。実測サイズが10 MBを大きく超える場合は、2048×1024への縮小を検討する。

**注意：** GEBCO の標高には海底地形も含まれる。そのため、地形性上昇の計算では `fineLandFraction` を必ず掛け、海底斜面が大気の上昇源として扱われないようにする。海上にも発生させる過渡源には、この陸地の重みを掛けない。

## 2. `TerrainMap`：高解像度地形の読み出し

気候テクスチャと地形テクスチャは役割が異なるため、`climate-map.ts` とは別に `src/render/earth-weather/terrain-map.ts` を新設する。気候テクスチャは低周波の平年・季節平均、地形テクスチャは静的な高周波地形を担当する。

```ts
export interface TerrainMap {
  readonly generation: number;

  // 単位方向における東向き・北向きの地形勾配 [m/m]。
  slope(direction: Vec3Node): Vec2Node;

  // 単位方向における陸地の重み [0..1]。
  landFraction(direction: Vec3Node): FloatNode;

  request(): void;
  dispose(): void;
}
```

`TerrainMap.fromDeferredUrl(url)` を用意し、`AnnualClimateMap` と同じ DeferredTexture の経路で読み込む。`earthGeneratedCloudField` が `terrainTextureUrl` を受け取り、`WeatherModel` へ渡す。

既存の `climate.slope`（`LAND_HEIGHT_BIAS` を含む山脈スケールの斜面）は残す。今回の高解像度地形は、主にチェジュ島などの小規模な地形性上昇を表現するために使う。既存の粗い斜面を参照する項目まで一括して置き換えない。

## 3. 地方時の計算

`src/render/earth-weather/` に地方時を計算する純粋関数を追加する。`weather-model.ts` 内に置いてもよい。

```ts
// 単位方向 direction における地方時 [0..24 h)。
// longitude は経度 0 を +Z、東を +X とする既存の規約に従う。
localSolarHour(direction, seconds) =
  fract(
    seconds / MEAN_SOLAR_DAY
    + longitude(direction) / (2 * PI)
    + SOLAR_EPOCH
  ) * 24;
```

- `MEAN_SOLAR_DAY = 86400` とする。
- `SOLAR_EPOCH` は、ゲーム内の実暦と地方時の位相を合わせるための定数である。実装時に `displayTime=0` の太陽直下点の経度を既存の暦・軌道要素から求め、地方時の正午と一致するように較正する。
- lab とゲームで同じ `displayTime` を使う前提とする。
- この段階では、太陽傾斜や均時差を含む厳密な太陽位置計算は行わない。まずは平均太陽日による近似とし、昼夜の境界がゲーム内の太陽位置と視覚的に一致することを優先する。
- 経度の符号と時間の進む向きは、複数の経度で太陽直下点と照合してテストする。特に東西方向を取り違えていないことを確認する。

## 4. 上昇源を `transportSource` へ注入する

本設計の中心となる変更である。`WeatherTransport` の `source` BakedField を MRT 2出力に拡張する。

- **out0（既存）：** `vec4(humiditySource.xy, convectionSource.zw)`。既存の意味を変えない。
- **out1（追加）：** `vec4(upliftA, upliftB, 0, 0)`。
  - `upliftA = upliftSource(direction, emissionSecondsA)`
  - `upliftB = upliftSource(direction, emissionSecondsB)`
  - `emissionSecondsA/B` は、それぞれ `seconds + phaseA/B × (−ADVECTION_PERIOD)` とする。

A/B の各チャンネルは、その位相に対応する発生時刻で源場を評価する。日射加熱のゲートも同じ発生時刻で評価する。これにより、昼間に島で生成された湿りが夜間に風下へ到達した場合でも、到達時点で一斉に消えることはない。

`advectedAt` では、既存の湿度源と同じ displaced position を使って out1 を読み出し、位相を混ぜ合わせる。

```ts
upliftA = out1.x @ A-point;
upliftB = out1.y @ B-point;
uplift = mix(upliftB, upliftA, weightA);
surfaceHumidity = saturate(existingSurfaceHumidity + uplift);
```

実際の実装では、次節の経過時間減衰を A/B それぞれに掛けてから混ぜる。`saturate` は湿度が想定範囲の 0〜1 を超えないための上限処理であり、湿りの質量保存を保証するものではない。

`syncTime` は `seconds` を uniform として保持する。`WeatherTransport` 側で A/B の発生時刻を求め、源場の評価関数へ渡す。

### 共通の移流後減衰

**移流によって風下へ伸びることと、プルームが先細りになることは別の性質である。** 固定された上昇源が一定強度で発生し続ける場合、移流だけでは一定幅・一定強度の帯が残る可能性がある。そのため、源の活動時間とは別に、源から供給された湿りを移流後の経過時間に応じて減衰させる。

各位相の経過時間を `tauA/B = phaseA/B × ADVECTION_PERIOD` とし、共通の減衰関数を適用する。

```ts
ageFade(tau) = exp(-tau / PLUME_DECAY_SECONDS);

upliftA = (out1.x @ A-point) * ageFade(tauA);
upliftB = (out1.y @ B-point) * ageFade(tauB);
uplift = mix(upliftB, upliftA, weightA);
```

`PLUME_DECAY_SECONDS` は雲プルームが風下でどの程度の距離まで残るかを調整する値とする。初期値は lab で調整し、島・山・過渡源のすべてに同じ処理を適用する。これにより、発生源の種類に応じた別々の減衰ロジックを持たずに済む。

`ADVECTION_PERIOD=20h` は、最大で約20時間前までの源を参照する設定である。風速 8 m/s なら単純計算で約 576 km に相当するが、実際の到達距離は風速や風向の変化、移流経路によって変わる。したがって「風速×20時間」は距離の目安であり、常にその長さのプルームが形成されるという意味ではない。

### `upliftSource(direction, emissionSeconds)`

`WeatherModel` が `upliftSource` の内容を構築し、`WeatherTransport` は関数として受け取る。3種類の上昇源は次の式でまとめる。

```ts
transient = TRANSIENT_GAIN * transientActivity(direction, emissionSeconds);
thermal = fineLandFraction(direction)
  * diurnalGate(localSolarHour(direction, emissionSeconds))
  * LAND_HEATING_GAIN;
oro = fineLandFraction(direction)
  * max(dot(surfaceWindAt(direction), fineSlope(direction)), 0)
  * OROGRAPHIC_GAIN;

upliftSource = transient + thermal + oro;
```

- **`transient`：** 平地や海上を含む地表上にランダムに生じる過渡源。陸地マスクは掛けない。海上の発生を許可することが今回の要件である。
- **`thermal`：** 日射で温まった陸地の上昇源。`fineLandFraction` で陸地に限定し、地方時による日周ゲートを掛ける。
- **`oro`：** 風が斜面を上るときの地形性上昇源。`fineLandFraction` を掛け、海底地形の勾配は大気の上昇源にしない。
- `surfaceWindAt` と `fineSlope` は、いずれも局所的な東・北成分であることを確認する。`fineSlope` は m/m、`surfaceWindAt` は m/s を想定するため、内積の単位は m/s となる。
- 風が斜面を下る場合は `max(..., 0)` により地形性上昇を発生させない。
- 風は現在時刻の `winds.at(direction).surfaceWind` を使う。発生時刻の風を参照できない場合の近似であり、既存の気団追跡も現在の風場を使うという実装上の前提に合わせる。風向・風速が短時間で大きく変化するケースでは誤差が生じる。

日射加熱のゲートは次のとおりとする。

```ts
diurnalGate(hour) =
  smoothstep(9, 12, hour)
  * (1 - smoothstep(16, 19, hour));
```

午前9時から正午にかけて立ち上がり、正午から午後4時までは最大値を保ち、午後4時から7時にかけて低下する。午後にピークを持つ島の雲道を表現するための初期設定であり、時刻や幅は lab で調整する。

過渡源には日周ゲートを掛けない。海上や陸上の対流源は夜間にも持続し得るためである。地形性上昇も日射には依存させない。

`LAND_HEATING_GAIN`、`OROGRAPHIC_GAIN`、`TRANSIENT_GAIN` は `CLOUD_TUNING` に追加し、lab で調整できるようにする。湿度源の値域は 0〜1 を想定するが、各ゲインの適正値は既存の湿度・雲量とのバランスを見て決める。島での加算量 0.2〜0.5 は初期調整の目安にとどめる。

## 5. `EpochNoise`：地表上に固定された過渡源

`CirculatingNoise` から、エポックの混ぜ替えとオクターブ評価を `epoch-noise.ts` へ切り出し、共通化する。

```ts
export class EpochNoise {
  // octaves、texelAngle、epochMaxFrequency は CirculatingNoise と同じ。
  // transitionSeconds は実現を混ぜ替える時間スケール [s]。
  public constructor(
    octaves,
    texelAngle,
    epochMaxFrequency?,
    transitionSeconds?,
  );

  // 地表座標 position と評価時刻 seconds における値 [-1..1]。
  public at(position: Vec3Node, seconds: FloatNode): FloatNode;

  // 既存の CirculatingNoise との互換性のため、必要なら現在時刻の同期機構も残す。
  public syncTime(seconds: number): void;
}
```

`EpochNoise.at` は、位置だけでなく評価時刻も受け取れるようにする。`transportSource` の A/B チャンネルでは異なる発生時刻を評価するため、現在時刻に固定されたノイズをそのまま共有する設計では不十分である。

`CirculatingNoise` は、従来どおり循環に沿って評価位置を移動させる。

```ts
circulation.carry(direction, (position) => epochNoise.at(position, currentTime));
```

一方、`transientField` は `circulation.carry` を通さず、`direction` をそのまま位置として評価する。これにより、ノイズの模様は地表座標に固定され、時間方向のエポック混ぜ替えによって発達・衰退する。**発生源そのものは地表に残り、そこから供給された湿りだけが風下へ移流する。**

`EpochNoise` の出力は −1〜1 なので、そのまま上昇源に使わず、正の活動度へ変換する。

```ts
transientActivity = smoothstep(
  TRANSIENT_THRESHOLD,
  TRANSIENT_THRESHOLD + TRANSIENT_SOFTNESS,
  epochNoise.at(direction, emissionSeconds),
);
```

`TRANSIENT_THRESHOLD` は過渡源の発生頻度、`TRANSIENT_SOFTNESS` は発生領域の境界の滑らかさを調整する。これらは最初から多数の調整項目にせず、必要に応じて `CLOUD_TUNING` へ追加する。

- オクターブは、中規模対流系に相当する周波数（例：f≈32〜96、波長 200〜400 km級）を複数段重ねる。
- `transitionSeconds` はノイズ模様が変化する時間スケールであり、個々の対流源の寿命を厳密に指定する値ではない。既定の18時間を出発点とし、必要なら6〜9時間程度も試す。
- 過渡源が何時間持続するかは、ノイズの空間スケール、時間相関、閾値、混ぜ替え時間の組み合わせで決まる。設定値と実際の見かけの寿命を混同しない。
- `transientField` は `WeatherModel` が保持し、`WeatherModel` が発生時刻に応じた評価を行う。

もし現在の shader node の構造上、`EpochNoise` に発生時刻を渡して A/B を別々に評価できない場合は、近似方式を採用する前に、2つの時刻での評価を実現できるか検討する。現在時刻のノイズを流用する方式では、過去の源の分布を再現できないため、雲プルームの履歴表現が粗くなる。

## 6. 既存項の整理

二重に湿りを加えることを避けるため、既存項の役割を整理する。

- **`SURFACE_LIFT_HUMIDITY` は削除する。** これまで移流後にその場へ加えていた地形リフト由来の湿りを、`transportSource` に注入した `oro` が担う。風上へ遡った源場を参照するため、山の直上でも源を拾えることを確認したうえで削除する。`cloud-tuning.ts` の `surfaceLiftHumidity` キーも削除する。
- `UPPER_LIFT_HUMIDITY`、`SUBSIDENCE_DRYING`、`LIFT_ACTIVITY` は残す。上層の湿り、沈降による乾燥、対流活動への入力は別の役割を持つ。上層の雲道は今回の対象外とする。
- `LAND_ACTIVITY` は残す。陸地の活動度を補正する項であり、今回追加する湿りの発生源とは役割が異なる。
- `transientField` と既存の `convectionNoise` は両方残す。`convectionNoise` は循環に運ばれる対流セルや局所的な対流活動を表し、`transientField` は地表上に固定された過渡的な湿りの発生源を表す。後者を前者で代用すると、源の模様自体が風とともに移動してしまう。
- 既存の `climate.slope` や `LAND_HEIGHT_BIAS` を使う項目は、今回の変更で一括して置き換えない。`SURFACE_LIFT_HUMIDITY` を削除した後も、沈降乾燥や対流活動に必要な粗い地形情報は残す。

## 7. SPEC の更新

`docs(spec)` の「雲の描画」節に、次の仕様を追加する。

- 島や山地で発生した雲は風下へ伸び、発生源から離れるにつれて弱まる帯状のプルームを形成する。
- 島の日射加熱による雲道は、日中に発生・発達し、夜間には新たな供給が弱まる。ただし、昼間に発生したプルームは移流によって夜間も風下に残り得る。
- 地形性上昇による雲は、日射の有無にかかわらず、風が斜面を上る条件で発生する。
- 平地や海上にも一時的な上昇源が発生し、その場所での活動が弱まった後も、生成された湿りや雲が風下へ移流して残ることがある。
- 上昇源の発生条件は複数あるが、風下への移流と移流後の減衰は共通の仕組みで処理する。

## 8. lab と検証

`generation-params.ts` と `cloud-tuning.ts` に、まず次の調整項目を追加する。

- `LAND_HEATING_GAIN`
- `OROGRAPHIC_GAIN`
- `TRANSIENT_GAIN`
- `PLUME_DECAY_SECONDS`

必要になった場合に `TRANSIENT_THRESHOLD` と `TRANSIENT_SOFTNESS` を追加する。

### 視覚的な検証

- **チェジュ島：** `cloud-lab` の cap をチェジュ島（33.5°N, 126.5°E）、半径5〜10°に向け、午前・午後・夜の画像を比較する。日中に島の上昇源が強まり、夜間には新規供給が弱まること、既に生成された雲が夜間も風下に残ることを確認する。
- **地形性上昇：** アンデス山脈（20°S, 70°W）などで、風が斜面を上る側に源が生じ、風向を反転すると発生位置・強度も変化することを確認する。海底地形だけで上昇源が生じていないことも確認する。
- **平地の過渡源：** 中央アジアや北米大陸の平地で、地形に依存しない過渡源が発生することを確認する。
- **海上の過渡源：** 海上でも過渡源が発生することを明示的に確認する。陸地マスクを掛けた結果、海上の過渡源が消えていないことを確認する。
- **移流と減衰：** 風下へ伸びたプルームが距離とともに滑らかに弱まり、`PLUME_DECAY_SECONDS` によって長さが調整できることを確認する。
- **静穏条件：** 風が弱い場合に、長い風下プルームが不自然に形成されないことを確認する。
- **昼夜と経度：** 同じ時刻でも経度に応じて地方時が変わり、日射加熱のゲートがゲーム内の昼夜と一致することを確認する。
- `observedComposite` / `composite` と比較する。
- `surfaceHumidity` ビューで湿りの分布を確認する。初期段階では専用ビューを追加せず、既存の診断表示を使う。

### 数値・構造の検証

- `localSolarHour` について、経度0、東経90度、西経90度などの代表点で地方時をテストする。
- 地形勾配が東・北の局所成分として正しいこと、緯度による東西方向の距離補正が入っていることを確認する。
- `fineLandFraction=0` の場所では `thermal` と `oro` が0になり、`transient` は海上でも発生し得ることをテストする。
- `EpochNoise` の負値が負の湿度源にならないことをテストする。
- A/B の各チャンネルが、それぞれの発生時刻で `EpochNoise` と日射ゲートを評価していることを確認する。
- `surfaceHumidity` が想定範囲を超えないことを確認する。
- typecheck、`test:render`、`check:boundaries`、`cloud-lab:shot` を実行する。

## 実装手順

1. `docs(spec)` の「雲の描画」に、雲プルーム、島の日変化、地形性上昇、陸上・海上の過渡源を追記し、単独の commit にする。
2. `tools/export-climate.mjs` に `earth-terrain.png` の出力を追加する。`npm run export-climate` 相当の手順で `src/assets/earth-terrain.png` を生成する。GEBCO データが `assets-src` にない環境では、先に `fetch-climate-source.mjs` を実行する。勾配の符号化範囲と平滑化幅を確認する。
3. `terrain-map.ts` を新設し、`earthGeneratedCloudField` / `earthCloudPresentation` の引数に地形テクスチャを追加する。`earth-system.ts` と lab の呼び出し箇所（cloud-lab main、motion-lab、weather-probe、synoptic など）を追従させ、`WeatherModel` の constructor に `TerrainMap` を追加する。
4. `epoch-noise.ts` を切り出す。`CirculatingNoise` のエポック混ぜ替えとオクターブ評価を共通化し、既存の循環ノイズは従来どおり `circulation.carry` を通す。過渡源の評価では発生時刻を渡せるようにする。
5. `WeatherModel` に `transientField`（`EpochNoise`）と `upliftSourceAt` を実装する。細かい地形勾配、陸地の重み、surface wind、地方時、過渡ノイズをまとめる。`SOLAR_EPOCH` を既存の暦と照合して較正する。
6. `WeatherTransport` の source BakedField を MRT 2出力へ拡張する。A/B それぞれの発生時刻で上昇源を評価し、`advectedAt` で同じ移流位置から読み出す。
7. `advectedAt` に共通のプルーム減衰を追加し、上昇源から供給された湿りを地表湿度へ加算する。A/B の経過時間に対応した減衰を適用する。
8. `SURFACE_LIFT_HUMIDITY` と `cloud-tuning.ts` の `surfaceLiftHumidity` キーを削除する。山の直上で即時の応答が失われていないことを確認する。
9. `cloud-tuning.ts` と `generation-params.ts` に各ゲインおよび `PLUME_DECAY_SECONDS` を追加する。
10. typecheck、`test:render`、`check:boundaries`、`cloud-lab:shot` を実行し、陸地・海上・島・山地で検証する。

`localSolarHour` は `src/math` ではなく `earth-weather` 内の関数とし、`test:render` 側で振る舞いを確認する。

MRT を使えばベイクのパス数は5のままで、既存の1パスから2出力を得られる見込みである。ただし、`transportSource` の texel ごとに風、地形、日周ゲート、過渡源、時間減衰用の値を評価するため、シェーダーの命令数とテクスチャ参照数を計測する。MRT の出力数が増えることだけで処理負荷を判断しない。

## 不採用とする案

- **現在時刻だけで日射ゲートを掛ける方式：** 夜になった瞬間にプルーム全体が消えるため採用しない。A/B の発生時刻でゲートを評価し、昼間に生成された湿りが夜間にも風下へ残るようにする。
- **過渡源を循環に沿って移動させる方式：** ノイズ模様自体が風とともに移動し、地表上の定点にある発生源にならない。過渡源は `circulation.carry` を通さずに評価する。
- **過渡源を時間変化しない固定ノイズにする方式：** 発生源が恒常化し、一時的に発生・衰退する性質を表せない。エポックの混ぜ替えを使う。
- **`earth-climate.png` 自体を高解像度化する方式：** 気温や雲量などの低周波チャンネルまで高解像度にする必要はない。地形だけを別テクスチャにする。
- **チェジュ島などを点データとして個別に注入する方式：** 実在の地形を反映せず、個別の例外処理が増える。GEBCO の地形勾配から一貫して生成する。
- **`climate.slope` を全面的に高解像度化する方式：** `LAND_HEIGHT_BIAS` を含む既存の粗い斜面は、海風収束の代用など別の目的にも使われる。今回の高解像度地形で一括置換しない。
- **水の質量を厳密に追跡する方式：** 最終的には水分量の保存を扱う余地があるが、今回は対象外とする。今回の方式は湿度場への加算による近似であり、質量保存モデルではない。

## 未確定事項・注意点

- **`SOLAR_EPOCH` の較正：** `displayTime=0` の太陽直下点の経度を既存の暦から求め、地方時の正午と一致させる。東西の符号と時間進行の向きを複数地点で確認する。
- **過渡源の時間評価：** A/B それぞれの発生時刻で `EpochNoise` を評価することを基本とする。shader node の制約で実現できない場合は、現在時刻評価へのフォールバックを「近似」として明示し、過去の源の分布が正確でないことを認識したうえで採否を判断する。
- **過渡源の時間スケール：** `transitionSeconds` はノイズ模様の変化の速さを決める値であり、個々の源の寿命そのものではない。6〜9時間、18時間など複数の設定を比較して、見かけの発生・衰退時間を確認する。
- **プルームの減衰：** `PLUME_DECAY_SECONDS` は上昇源の寿命ではなく、源から供給された湿りが移流後にどの程度残るかを調整する値である。過渡源の時間変化と混同しない。
- **風の時間依存性：** `surfaceWindAt` は現在時刻の風を使う近似である。過去の発生時刻の風を正確に参照するには、風場自体の履歴評価が必要になる。これは今回の範囲外とする。
- **プルームと `convectiveActivity` の連携：** `surfaceHumidity` への加算だけでは、雲が滑らかな板状に見える可能性がある。雲道内部の粒状感や対流活動が不足する場合は、`convectiveActivity.at` の land 項へプルーム量を加えることを検討する。
- **`LAND_HEIGHT_BIAS` との併用：** `SURFACE_LIFT_HUMIDITY` は削除するが、沈降乾燥や対流活動に使う粗い地形情報は残す。粗い斜面と細かい斜面の影響が不自然に重なる場合は、粗い項の `LAND_HEIGHT_BIAS` を再検討する。
- **陸地の重みの精度：** `earth-terrain.png` の B チャンネルは標高から求めた陸地の重みであり、土地被覆データではない。湖沼や湿地などの扱いは別途検討する。今回は海上の過渡源を陸地マスクで除外しないことを優先する。
- **地形勾配の量子化：** RGB8 の ±0.06 m/m で勾配の差が十分に表現できるか、実際のテクスチャを可視化して確認する。必要なら符号化範囲やビット深度を見直す。
- **元データの取得：** `fetch-climate-source.mjs` が使うデータが手元にない環境では地形テクスチャを再生成できない。生成済みの `earth-terrain.png` を assets に commit する。
