# 太陽系実装 軌道力学・天体暦・天文学的正確性レビュー(2026-08-27)

スナップショット: `8e8524d0`(branch: workspace3)

**追記(2026-08-27)**: 「1. 優先して確認すべきバグ候補」をブランチ `fix/solar-system-review-bugs`
(workspace3から分岐)で修正し、各項目に対応状況を追記した。監査の結果、1.4は誤検知と判明し
修正対象から外し、1.5はSPECを実装に合わせて更新する方針とした(いずれも根拠は各項目に記載)。

Sonnetサブエージェント9体に `src/physics/` の軌道力学・天体暦関連ファイルと `src/game/celestial/`
全体を分担させ、`DEVELOP/SPEC/ORBIT.md`・`DEVELOP/SPEC/CELESTIAL.md` と突き合わせてレビューした。
高確信度の指摘のうち主要なものは、担当エージェントとは独立に自分でも代数的検証・数値計算・
コード確認を行った(検証済み、と付記した項目)。

対象外: `base-collision.ts`・`collision-response.ts`・`sphere-contact.ts`・`surface-contact.ts`(衝突判定)、
`deque.ts`・`max-heap.ts`・`spatial-grid.ts`・`optimize.ts`・`random.ts`(汎用データ構造)、
`projection.ts`・`occlusion.ts`(描画投影)、`point-view.ts`・`point-field-view.ts` の描画部分・
`sphere-view.ts` など純粋描画コンポーネント。軌道力学的・天文学的正確性という評価軸から外れるため。

---

## 1. 優先して確認すべきバグ候補(高確信度)

### 1.1 `src/physics/halo.ts:59` — ハロー/リサジュー軌道の `kappa` の符号が反転している

`linearParams()` が返す `kappa` が、同ファイル `richardsonCoefficients()` 内で独立に計算される
基準値 `k` とちょうど符号違いになっている。`kappa` は面内運動の1次(線形)項にだけ使われ、
2次・3次補正項は正しい符号の `k` を使うため、線形項と高次項の符号が内的に矛盾する。

**検証済み**: 特性方程式 `λ⁴+(c2-2)λ²-(2c2+1)(c2-1)=0` から恒等式
`(λ²+1+2c2)(λ²+1-c2)=4λ²` を導き、`k=(λ²+1+2c2)/(2λ) = -2λ/(c2-1-λ²) = -kappa` を代数的に確認。
担当エージェントは太陽-地球L1で `k≈+3.229`(文献値と一致)・`kappa≈-3.229` になることも数値確認し、
さらに実際の運動方程式へRK4積分を投入して `kappa=+k` では振幅→0で周期軌道に収束、
現状の `kappa=-k` では発散することまで確認済み。

**影響範囲**: `haloState`/`lissajousState`(クリエイティブモードのハロー軌道・リサジュー軌道配置、
CELESTIAL.md 6節)が、開始直後から理論上の周期軌道に乗っていない状態を返す。

**対応済み**(commit `479a5b8d`): `kappa` の式を `richardsonCoefficients` 内の `k` と同一にした。
`halo.test.ts` の文献値検証も絶対値比較から符号込みの直接比較に強化した。

### 1.2 `src/physics/ephemeris.ts` — 高精度暦パックの有効期間を実行時に一切チェックしていない

`stateOf`/`orbitFrameRotationAt` 等は `this.precise?.hasBody(id)` だけで高精度データを使うか
判定しており、評価時刻がパックの有効期間内かを見ていない。有効期間は `AbsoluteEphemeris` が
`validStartJdTdb`/`validEndJdTdb` として持つが、`OriginCenteredEphemeris` の時点でこれを転送しておらず、
`Ephemeris` 側からは有効期間へアクセスする経路が無い(宣言だけの値になっている)。有効期間の
判定はステージ起動時に一度だけ行われ(`Stage.createEphemeris`)、以降は再判定されない。

シミュレーション時刻がパック期間(近未来10年 / 遠未来10年)を超えて進行すると、
`ChebyshevEphemeris.segmentOf` が区間を見つけられず `ChebyshevTimeOutOfRangeError` を投げ、
これを捕まえる catch がどこにもない。

**根拠**: CELESTIAL.md 2.2「上記いずれの高精度期間にも当たらない時代…は、高精度データを一切使わず
解析暦だけで…この場合も**例外なく**天体位置が求まる」と明記されているが、実装は期間外に出た瞬間に
未処理の例外が伝播しうる。既定ステージの開始時刻(20115-05-14T06:00:00 TDB)は遠未来データの
有効開始そのものであり、時間加速倍率に上限がない設計と合わせると、1セッション中にsimTimeが
10年を超えることは十分起こりうる。

**対応済み**(commit `fa5f0451`): `OriginCenteredEphemeris.isValidAt()` を追加し、
`Ephemeris` 側の3箇所(`stateOf`/`orbitFrameRotationAt`/`orbitNormalAt`)に有効期間ガードを足した。
有効期間外でも例外を投げず解析暦へ落ちることを回帰テストで確認済み。

### 1.3 `src/physics/solar-system.ts:1336, 1359` — ハレー・エンケ彗星核の `mu` が桁で誤っている

- ハレー: `mu: 1.5e1`、コメント「核質量 ~2.2e14 kg 相当」→ 正しくは `G×M ≈ 1.47e4`(約1000倍の差)
- エンケ: `mu: 4e0`、コメント「核質量 ~6e13 kg 相当」→ 正しくは `G×M ≈ 4.0e3`(約1000倍の差)

**検証済み**: `GRAVITATIONAL_CONSTANT(6.6743e-11) × コメントの質量` を計算し、両方とも
コード中の値との比が約979〜1001倍になることを確認。彗星核の重力寄与自体は他天体への影響として
無視できる量だが、脱出速度(mu=15なら約0.07m/s、mu≈14683なら約2.3m/s)など核近傍の微小重力描写に
有意な差が出る。

**対応済み**(commit `6a8dd1fb`): 両方とも `GRAVITATIONAL_CONSTANT * 質量` の形に直した。

### 1.4 `src/physics/solar-system.ts` — 重力源天体数が63体で、CELESTIAL.mdの記載(62体)と1体食い違う ※誤検知

`ephemeris.ts` の `gravityIds` は `mu !== 0` で判定しており、`solar-system.ts` 全体で `mu: 0` は
35体、残り63体が重力源になる。CELESTIAL.md 1節は「質量が実測されている**62体**だけが重力源」と
明記。**検証済み**(grepで機械的に集計)。上記1.3のハレー・エンケのように「観測が乏しい粗い推定値」と
コード自身が明記する天体が非ゼロ`mu`を持っている点が原因の一つである可能性が高い。

**誤検知として却下(修正なし)**: 当初のgrepベースの集計(`grep -c "mu: 0,"`)は、
`sun: { kind: 'star', id: 'sun', mu: MU_SUN, radius: R_SUN }` のような1行完結の定義を見落として
いた。TypeScriptの波括弧の深さを追ってトップレベルの天体エントリを正確にパースし直したところ、
太陽(sun)を除く97体中の非ゼロ`mu`はちょうど**62体**で、太陽を足すと63体になる。CELESTIAL.mdの
「このうち質量が実測されている62体」の「このうち」は恒星1+恒星公転47+衛星50=98体からの内訳を
述べる文で、太陽自身が重力源であることは自明なため、62という数字は太陽を除いた97体中の内訳を
指すと読むのが整合的。実装(sun込み63体)はこの解釈と矛盾しない。**覆す場合**: 「62体」に太陽を
含める意図だとユーザーが判断するなら、彗星核(halley/encke)など「粗い推定値」天体のmuを0にする
方向で1体減らす対応になる。

### 1.5 `src/physics/solar-system.ts` — 三軸楕円体として描く天体がCELESTIAL.md規定の6体を超え19箇所ある

CELESTIAL.md 4.1節は「ハウメア・フォボス・ダイモス・ベスタ・ケレス・イオの6体は三軸楕円体…
他の準惑星・小惑星・全衛星(上記の対象を除く)と同様に真球のまま扱う」と明記しているが、
`shape: { kind: 'triaxial', ... }` はカリクロー・ヒギエア・エロス・ベンヌ・アロコス・カイロン・
インテラムニア・ダヴィダ・プシケ・エウノミア・シルヴィア・ディディモス・カモオアレワなど
13天体に追加で設定されている(**検証済み**、grepで19箇所ヒット、うち6箇所がSPEC規定分)。
三軸データ自体(探査機実測値等)は妥当そうに見えるため、実装が先行してSPECの更新が漏れている
可能性が高い。「共通化するかどうかは今後も使う可能性で決める」の判断と同様、これは
**SPECを直すか実装を直すかの二択をユーザーに委ねるべき論点**。

**対応済み**(commit未定、CELESTIAL.md更新): `git log`で調査したところ、コミット`0d5d3906`
(EP2)で「6体」がSPECへ明記され、その後コミット`7129d3a9`(EP6、同日)で32小天体を追加した際に
13体へ三軸データが追加されたが、このコミットはCELESTIAL.mdを一切変更していない(他の簡略化
(質量測定天体5体・セドナの推定半径・キロンの環見送り)は丁寧に記録している一方、三軸shapeには
触れていない)。意図的な「6体限定」という設計判断の痕跡がなく、実装データ(探査機実測値中心)を
無効化する理由もないため、SPECを実装(19体)に合わせて更新した。

### 1.6 `src/physics/earth-reference-orbits.ts:63` — ドーンダスク軌道のdawn/dusk昇交点オフセットが逆

```ts
return sunSynchronousElements(repeatDays, revsPerRepeat, sunRaanDeg + (localTime === 'dawn' ? 90 : -90));
```
現状 dawn(朝6時)に`+90`・dusk(夕18時)に`-90`。

**検証済み**(担当エージェントの導出とは独立に確認): `elements.ts`の`orbitPlaneBasis`が使う
`rotateAxis(X, Y, raan)`をロドリゲスの回転公式で展開すると `raan=0→+X, 90°→-Z`。この回転が
Y軸(北極)の正方向から見て反時計回り=地球の自転方向と同じであることを確認したうえで、
「ある慣性系方向の地方太陽時 = 12h + (RAAN-太陽方向)/15°/h」という標準関係を当てはめると
`RAAN-太陽方向=+90°→18時(dusk)`、`-90°→6時(dawn)`となり、コードの符号(dawn→+90, dusk→-90)は
逆であることを独立に確認した。

**対応済み**(commit `1b7a7ce8`): dawn→`-90`、dusk→`+90` に直した。回帰テスト
(`tests/physics/earth-reference-orbits.test.ts`、新規)を追加。

### 1.7 `src/game/celestial/orbit-guide-settings.ts:189-198` — 太陽同期準回帰軌道の既定値が「約800km」というコメントと大きく食い違う

既定値 `repeatDays: 14, revsPerRepeat: 98`(1日7周、周期約205.7分)を
`sunSynchronousElements`(`earth-reference-orbits.ts`)の式で実際に解くと、軌道長半径は
約11,546km、高度は**約5,165km**になる。コメントは「高度約800kmの太陽同期軌道に相当する」と
主張しているが、実際に800km級(1日14.3周相当)にするには `repeatDays: 7` であるべきと見られる。

**検証済み**: `n = 2π×7/86400`、`a = cbrt(MU_EARTH/n²) ≈ 1.1546e7 m` を実際に計算し、
高度 約5,168kmを確認。

**対応済み**(commit `93bf82ad`): `repeatDays: 14` → `7` に直した(高度約894km)。
`dawnDusk` も同じ既定値を使っているため揃えて直した。

### 1.8 `src/game/celestial/earth-view.ts` — 地球だけ扁平表示されず常に真球

CELESTIAL.md 4.1節は水星・地球・火星・木星・土星・天王星・海王星の7惑星を回転楕円体として
描くと明記しているが、`EarthView`/`createEarth()`(`src/render/earth.ts:68`)は
`surfaceScale.scale.setScalar(R_EARTH)` で3軸均等スケール、地表メッシュも`SphereGeometry`の
真球のまま。地球の登録データには `equatorRadius`/`polarRadius`(差約21.5km)が既に用意されているが
未使用。**検証済み**(該当コードを確認)。他の惑星は `shapeAxes()` 経由で赤道・極半径を反映している。

**対応済み**(commit `dda51a89`): `shapeAxes(R_EARTH_EQ, SOLAR_SYSTEM.earth.shape)` 経由の
3軸スケールに揃えた。render-lab:shotで地球シーンを撮影し崩れが無いことを確認済み(扁平率
約0.34%は視覚的にはほぼ判別できない差)。

### 1.9 `src/game/celestial/ring-view.ts` — 環の面/線切替が「実距離での見かけ幅」ではなく「帯の実幅の固定閾値」になっている

CELESTIAL.md 5節は「見かけの幅が画面上で1ピクセルを割った時点で」動的に面↔線を切り替えると
規定し、フェーベ環(半径400万〜1300万km)を名指しでこの仕組みの対象としているが、実装は
`帯の実幅`(カメラ距離に依存しない定数)を`RING_LINE_WIDTH_THRESHOLD_M`(1,500km)と比較して
**コンストラクタ時点で一度だけ**annulus/lineを固定選択している。`sync()`側の見かけ幅計算は
不透明度フェードにしか使われず、ジオメトリ切替は行われない。結果、フェーベ環はどれだけ
ズームアウトしても常にannulusのまま、天王星の細い環はどれだけズームインしても常にline固定になる。
天王星環のコード中コメント自身が「視角判定(sync側)で線に落ちる」と書いており、実装と矛盾する。

**対応済み**(commit `8f719995`): 厚み0の帯は annulus/line の両方を組んでおき、`sync()` が
見かけ幅(1px判定、クランプしない生の比率)で毎フレームどちらを見せるか選び直すようにした。
`RING_LINE_WIDTH_THRESHOLD_M` は不要になったため削除。render-lab:shotでmppを人為的に拡大し、
annulus→lineへの切替を目視確認済み。

---

## 2. 中確信度の指摘

- **`src/game/celestial/orbit-guide-lines.ts:31-33`**: `RECOMPUTE_INTERVAL=300秒`の正当化コメントが
  「地球-月系が最速なので0.05°しか回らない」としているが、同じ`ALL_SYSTEMS`には火星-フォボス
  (周期7.66時間)が含まれ、300秒で約3.92°回転する。コメントの前提が誤り。
- **`src/game/celestial/orbit-guide-settings.ts:219-227`**: ツンドラ軌道の既定近地点高度がモルニヤの
  値(600km)をそのまま流用しており、ツンドラの周期(1恒星日)に当てはめると離心率0.835・
  遠地点高度約70,972kmという、現実のツンドラ軌道(近地点高度数万km・e≈0.27前後)とは
  かけ離れた極端な楕円になる。意図的な値か確認を要する。
- **`src/game/celestial/point-field.ts:163-182`**: ヒルダ群(3:2共鳴)のケプラー平均運動が木星の
  実測平均運動レートと厳密には一致せず(比が理想値1.5から約0.1%ずれる)、dσ/dt≈0.091°/年の
  残留ドリフトが生じる。コメントは「dσ/dt=0になる」と断言しているが、木星の実測要素(JPL永年項)
  との厳密な整合はない。
- **`src/game/celestial/point-field.ts:73-74`**: カークウッド空隙のラベル対応で「7:3」と「5:2」が
  入れ替わっている(天文学的に正しい順は 4:1→2.06AU, 3:1→2.50AU, 5:2→2.82AU, 7:3→2.958AU,
  2:1→3.28AU)。数値自体はそのまま使われるため機能上のバグではないが、**DEVELOP/SPEC/CELESTIAL.md
  10節の表も同じ順序で誤っている**可能性が高い。
- **`src/game/celestial/point-field.ts`**: カイパーベルトcold/hotの傾斜角分布が両方とも単純な
  一様分布で、hot群自体にピークがないため、合成しても「1山+平坦な裾」に近く、
  CELESTIAL.mdが要求する「二山」の見た目の再現度は低い。
- **`src/physics/solar-system.ts:1051`**: 海王星の極半径(24,285.3km)が広く引用される値
  (約24,341km)と1割程度大きい扁平率を示す。天王星側は正しく再現できているため、海王星側だけ
  転記の誤りがある可能性。
- **`src/game/celestial/body-visibility.ts:220-241`**: `isPositionInFocusedSystem`(艦などの
  マップ表示判定)にカメラ用のヒステリシス(1.44倍のSTICKY_MARGIN)が掛かっておらず、勢力圏境界
  付近を飛ぶ艦の表示がフレームごとに切り替わりうる。

## 3. 修正候補・リファクタリング候補

- **`src/physics/earth-reference-orbits.ts:69`**: `criticalInclinationElements`が
  `elements.ts`の`semiMajorFromPeriod`と同一のケプラー第3法則の式を再実装している。二重実装の解消を推奨。
- **`src/physics/body-orientation.ts:19-21`**: `orthogonalizedTo`が`pole`の単位ベクトル性を
  暗黙に前提しており、コメントに明記がない。

## 4. 確認事項(意図的な簡略化の可能性・ユーザー判断が必要)

- `src/physics/body-orientation.ts:68-76` の経度正方向が「自転が進む向き」基準で、IAU公式の
  惑星地理経度規約(逆行天体では自転と逆向きが正)と天体によっては食い違いうる。ゲーム内部表示の
  自己無矛盾性は保たれているため実害は小さい可能性。
- `src/physics/ephemeris.ts` の地球の自転位相評価だけが他の7惑星と異なる時刻基準(`t` vs `te`)を
  使っている。地球の初期位相はランダムなので実害は薄いと見られるが、使い分けの理由が明記されていない。
- 木星型惑星の高精度暦(DE440/441)が指すのは「惑星本体」ではなく「系重心(バリセンタ)」であり、
  ガリレオ衛星等の質量分布により本体中心から最大数百km程度周期的にずれる。CELESTIAL.md
  2.2節の「高精度な惑星本体の位置」という記述の厳密な意味を確認したい。
- `src/physics/dynamics.ts` で大気抵抗の相対速度計算時、天体位置は評価時刻へ外挿するが天体速度は
  外挿しない(非対称)。また日照率の評価がSRPはRK4段ごと、熱収支はステップ1回のみで、高時間加速時に
  両者が異なる日照/被食状態を参照しうる。影響は小さいと見積もられる。
- `src/physics/elements.ts` のケプラー方程式ソルバ(ニュートン法)の高離心率(e→0.98)での
  収束を実測検証していない。閾値`e>0.8`の根拠も定量的でない。
- `src/physics/earth-reference-orbits.ts` の太陽同期条件がJ2による平均運動の補正なしの2体近似。
  HUDガイド線用途なので実害は小さいと見られる。
- `src/game/celestial/zero-velocity-lines.ts` のゼロ速度曲線が地球-月系・太陽-地球系の2系統のみで、
  CELESTIAL.md 6節がHUD対象として挙げる太陽-木星系・太陽-土星系が含まれない(UI仕様側の意図的な
  範囲限定の可能性)。
- `src/game/celestial/map-visibility.ts:123-129` の「月だけ常時表示」の判定が `def.planet==='earth'`
  でハードコードされている。カスタムレジストリで地球に複数衛星を登録した場合、月以外も対象になる。
- `src/physics/solar-system.ts:518` の地球(EM Bary)の軌道長半径が、他の要素はJPL Standish表の値を
  精密転記している中で `a` だけ「ちょうど1AU」の定義値に置き換わっている(実用上の差は約2.6ppm)。
- `src/game/celestial/point-field.ts` の小天体点群生成が常に実太陽系(`SOLAR_SYSTEM`)の木星要素を
  参照しており、恒星ありの架空レジストリが将来追加された場合に誤動作しうる(現状は無害)。

---

## 5. 各グループ総評(担当ファイル群ごと)

- **軌道要素・ケプラー軌道**(elements/kepler-orbit/kepler-extrapolation/orbit-solvers/planet-orbit/
  satellite-orbit/earth-reference-orbits/orbit-catalog/celestial-body): 永年変化・周期摂動の解析的
  微分は丁寧に導かれ破綻なし。dawn/dusk符号(1.6)が主な指摘。
- **天体暦**(ephemeris/absolute-ephemeris/packed-absolute-ephemeris/ephemeris-catalog/
  ephemeris-profile/ephemeris-pack/*): チェビシェフ補間・時刻系・座標変換は正しいが、
  有効期間の実行時チェック欠如(1.2)が最大の懸念。
- **座標系・時刻・姿勢**(ecliptic/frame/time/attitude/body-orientation/vec3): 数式を手計算で
  追跡した範囲で仕様と矛盾する誤りなし。指摘はいずれも低確信度の確認事項。
- **制限三体問題・ラグランジュ点**(cr3bp/halo/lagrange/zero-velocity/intercept/zero-velocity-lines):
  ラグランジュ点・ヤコビ定数・CR3BP無次元化は数値検証で正しいが、halo.tsのkappa符号(1.1)が
  重大な例外。
- **軌道伝播・摂動力**(dynamics/dynamic-trajectory/kinematic-state/trajectory-features/
  state-queue/srp/shadow/thermal/atmosphere): 多体重力補正・J2/C22・SRP・食・大気・熱収支いずれも
  ORBIT.mdの要求と数式レベルで一致、実質的なバグなし。
- **太陽系本体**(solar-system/orbit-guide): 98体の内訳・軌道要素・J2/C22・環データは大部分JPL/IAU
  公表値と高精度に一致する丁寧な実装だが、彗星核GM値(1.3)・重力源体数(1.4)・三軸楕円体対象(1.5)の
  3つの具体的な不一致が見つかった。
- **celestial表示系**(body-class/body-visibility/celestial-registry/planet-distance/earth-view/
  scale-grid-view/celestial-view/map-visibility/environment-scene/sun-view/ring-view): 可視性・
  参照フレーム・恒星光源の規則はSPEC通りだが、地球の扁平表示欠落(1.8)・環の面線切替(1.9)という
  2つの描画側の実装漏れが見つかった。
- **軌道ガイド表示系**(orbit-guide-catalog/orbit-guide-kind-ids/orbit-guide-settings/
  orbit-guide-lines/guide-curve/direction-markers): CR3BP周期軌道カタログの分類・方向マーカーは
  妥当。地球専用参照軌道の既定値(1.7)に具体的な数値の誤りが見つかった。
- **小天体点群**(point-field/point-field-view): 点数・軌道要素範囲はSPEC表と完全一致。
  ヒルダ群のσドリフト・カークウッド空隙のラベル対応・カイパーベルト分布の単純化など、
  「動作はするが厳密な力学的整合性に小さな綻びがある」種類の指摘が中心。

## 6. プロセス上の注記

初回のグループ分けで `point-field.ts`/`point-field-view.ts`(小天体点群、CELESTIAL.md 10節)が
どのグループの担当にも入らず漏れていたため、9体目のエージェントを追加で起動して埋めた。
