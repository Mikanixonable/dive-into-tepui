# 太陽系実装 軌道力学・天体暦・天文学的正確性レビュー(2026-08-27)

スナップショット: `8e8524d0`(branch: workspace3)

**追記(2026-08-27)**: 「1. 優先して確認すべきバグ候補」をブランチ `fix/solar-system-review-bugs`
(workspace3から分岐)で修正し、各項目に対応状況を追記した。監査の結果、1.4は誤検知と判明し
修正対象から外し、1.5はSPECを実装に合わせて更新する方針とした(いずれも根拠は各項目に記載)。

**追記(2026-09-11)**: 実装スナップショットは `60ed125e`(branch: codex/solar-system-accuracy-all-fixes)。
残っていた2節・4節の項目をすべて対応し、型検査と物理・ゲーム層の回帰テストを通過させた。文書の完了版は
`memos/mikanixonable/done/` へ移動する。

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

### 1.2 `src/physics/celestial-motion.ts` — 高精度暦パックの有効期間を実行時に一切チェックしていない

`stateOf`/`orbitFrameRotationAt` 等は `this.precise?.hasBody(id)` だけで高精度データを使うか
判定しており、評価時刻がパックの有効期間内かを見ていない。有効期間は `AbsoluteEphemeris` が
`validStartJdTdb`/`validEndJdTdb` として持つが、`HelioEphemeris` の時点でこれを転送しておらず、
`CelestialMotion` 側からは有効期間へアクセスする経路が無い(宣言だけの値になっている)。有効期間の
判定はステージ起動時に一度だけ行われ(`Stage.createCelestialSystem`)、以降は再判定されない。

シミュレーション時刻がパック期間(近未来10年 / 遠未来10年)を超えて進行すると、
`ChebyshevEphemeris.segmentOf` が区間を見つけられず `ChebyshevTimeOutOfRangeError` を投げ、
これを捕まえる catch がどこにもない。

**根拠**: CELESTIAL.md 2.2「上記いずれの高精度期間にも当たらない時代…は、高精度データを一切使わず
解析暦だけで…この場合も**例外なく**天体位置が求まる」と明記されているが、実装は期間外に出た瞬間に
未処理の例外が伝播しうる。既定ステージの開始時刻(20115-05-14T06:00:00 TDB)は遠未来データの
有効開始そのものであり、時間加速倍率に上限がない設計と合わせると、1セッション中にsimTimeが
10年を超えることは十分起こりうる。

**対応済み**(commit `fa5f0451`): `HelioEphemeris.isValidAt()` を追加し、
`CelestialMotion` 側の3箇所(`stateOf`/`orbitFrameRotationAt`/`orbitNormalAt`)に有効期間ガードを足した。
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

**対応済み**(commit `b9b88299`、CELESTIAL.md更新): `git log`で調査したところ、コミット`0d5d3906`
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

### 1.7 `src/game/celestial/orbit-guide/orbit-guide-settings.ts:189-198` — 太陽同期準回帰軌道の既定値が「約800km」というコメントと大きく食い違う

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

### 1.9 `src/game/celestial/celestial-entity/ring-view.ts` — 環の面/線切替が「実距離での見かけ幅」ではなく「帯の実幅の固定閾値」になっている

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

- **対応済み**(commit `60ed125e`) — **`src/game/celestial/orbit-guide/orbit-guide-lines.ts:31-33`**: `RECOMPUTE_INTERVAL=300秒`のコメントから
  「地球-月系が最速なので0.05°しか回らない」としているが、同じ`ALL_SYSTEMS`には火星-フォボス
  (周期7.66時間)が含まれるため、系を特定せず表示負荷と更新頻度のバランスを説明するコメントへ直した。
- **対応済み**(commit `60ed125e`) — **`src/game/celestial/orbit-guide/orbit-guide-settings.ts:219-227`**: ツンドラ軌道の既定近地点高度を
  24,000kmへ変更した。周期1恒星日・臨界傾斜角の既定軌道が現実的な高楕円軌道になる。
- **対応済み**(commit `60ed125e`) — **`src/game/celestial/solar-system/point-field.ts:163-182`**: ヒルダ群の平均運動を木星の
  2/3へ固定し、共鳴角のドリフトを除去した。3つの位相枝を明示的に混ぜ、三角形状も回帰テストで固定した。
- **対応済み**(commit `60ed125e`) — **`src/game/celestial/solar-system/point-field.ts:73-74`**: カークウッド空隙のラベル対応を
  正しい順へ揃え、`DEVELOP/SPEC/CELESTIAL.md`も同じ順へ更新した。
- **対応済み**(commit `60ed125e`) — **`src/game/celestial/solar-system/point-field.ts`**: カイパーベルトhot群を低傾斜・高傾斜の
  2モードから生成し、cold群と合わせた二峰性を回帰テストで固定した。
- **対応済み**(commit `60ed125e`) — **`src/game/celestial/solar-system/neptune-system.ts`**: 海王星の赤道半径を24,764km、
  極半径を24,341kmへ更新した。
- **対応済み**(commit `60ed125e`) — **`src/game/celestial/celestial-system.ts`**: `isPositionInFocusedSystem`も
  `NearbySystemTracker`と同じ1.2倍の加速度マージンを使い、勢力圏境界での明滅を抑える判定へ揃えた。

## 3. 修正候補・リファクタリング候補

- **`src/physics/earth-reference-orbits.ts:69`**: `criticalInclinationElements`が
  `elements.ts`の`semiMajorFromPeriod`と同一のケプラー第3法則の式を再実装している。**完了**(commit `e32d123d`) — 軌道要素側の共通変換へ統一済み。
- **`src/physics/body-orientation.ts:19-21`**: `orthogonalizedTo`が`pole`の単位ベクトル性を
  暗黙に前提しており、コメントに明記がない。**完了**(commit `ce1d85ff`) — 入力契約をコメントと回帰テストへ反映済み。

## 4. 確認事項(意図的な簡略化の可能性・ユーザー判断が必要)

- **対応済み**(commit `60ed125e`) — `src/physics/body-orientation.ts:68-76` の経度正方向をIAU北極の右手系
  (`cross(axis, meridian)`)としてコメントと回帰テストへ明記した。逆行天体でも物理的な自転方向とは独立した
  惑星地理経度規約になる。
- **対応済み**(commits `665f4e9b`, `0292d077`) — `src/physics/celestial-body-def.ts` と
  `src/physics/celestial-motion.ts` の位相評価は、構築時にIAU元期オフセットをシミュレーション時刻0へ
  折り込み、評価時は`simTime`に統一した。旧記述の`t` vs `te`の使い分けは解消済み。
- **対応済み**(commit `4aa935c3`) — 高精度暦の点が惑星本体か系重心かを
  `src/physics/ephemeris/point.ts` で明示し、系重心を惑星本体として誤結合しないようにした。
  `CelestialMotion`の最終位置は衛星質量による本体オフセットも扱うため、旧記述の確認事項は解消済み。
- **対応済み**(commit `60ed125e`) — `src/physics/dynamics.ts` のRK4各段で日照率・太陽方向・大気状態を同じ評価時刻から
  取得する環境サンプルを導入した。大気天体の位置と速度、SRP、熱収支が段時刻で整合する。
- **対応済み**(commit `60ed125e`) — `src/physics/elements.ts` の高離心率初期値の閾値`e>0.8`を定数化し、
  e=0.79/0.80/0.81/0.90/0.98と平均近点角の全域を回帰テストで覆った。
- **対応済み**(commit `60ed125e`) — `src/physics/earth-reference-orbits.ts` の太陽同期条件へJ2一次の平均運動補正を追加し、
  補正後の平均運動が要求回帰日数と一致することをテストした。
- **対応済み**(commit `60ed125e`) — `src/game/celestial/orbit-guide/zero-velocity-lines.ts` に太陽-木星・太陽-土星のXY/XZを追加し、
  4系8断面を、実際の登録天体から導く質量比・距離・半径のスケールで描けるようにした。
- **対応済み**(commit `60ed125e`) — `src/game/map/visibility-policy.ts:180-182` の常時表示例外を地球の主天体判定から
  `id === 'moon'`へ絞り、カスタムレジストリの他衛星を巻き込まないようにした。
- **対応済み**(commit `60ed125e`) — `src/game/celestial/solar-system/earth-system.ts` の地球(EM Bary)軌道長半径を
  JPL Standish表の`1.00000261 AU`へ更新し、ECI回帰基準も更新した。
- **対応済み**(commit `60ed125e`) — `src/game/celestial/solar-system/point-field.ts` の点群生成へ木星の`a/l0/lRate`を
  参照として渡せる経路を追加し、実際に構築した木星の軌道を使って生成するようにした。

---

## 5. 各グループ総評(担当ファイル群ごと)

- **軌道要素・ケプラー軌道**(elements/kepler-orbit/kepler-extrapolation/orbit-solvers/planet-orbit/
  satellite-orbit/earth-reference-orbits/orbit-catalog/celestial-body): 永年変化・周期摂動の解析的
  微分は丁寧に導かれ破綻なし。dawn/dusk符号(1.6)は対応済み。
- **天体暦**(ephemeris/absolute-ephemeris/packed-absolute-ephemeris/ephemeris-catalog/
  ephemeris-profile/ephemeris-pack/*): チェビシェフ補間・時刻系・座標変換は正しく、
  有効期間の実行時チェック欠如(1.2)も対応済み。
- **座標系・時刻・姿勢**(ecliptic/frame/time/attitude/body-orientation/vec3): 数式を手計算で
  追跡した範囲で仕様と矛盾する誤りなし。IAU経度規約はコメントとテストで明文化した。
- **制限三体問題・ラグランジュ点**(cr3bp/halo/lagrange/zero-velocity/intercept/zero-velocity-lines):
  ラグランジュ点・ヤコビ定数・CR3BP無次元化は数値検証で正しいが、halo.tsのkappa符号(1.1)が
  重大な例外。
- **軌道伝播・摂動力**(dynamics/dynamic-trajectory/kinematic-state/trajectory-features/
  state-queue/srp/shadow/thermal/atmosphere): 多体重力補正・J2/C22・SRP・食・大気・熱収支をRK4段時刻で
  整合させ、太陽同期平均運動と高離心率ソルバの回帰も追加した。
- **太陽系本体**(solar-system/orbit-guide): 98体の内訳・軌道要素・J2/C22・環データは大部分JPL/IAU
  公表値と高精度に一致する丁寧な実装。彗星核GM値(1.3)、三軸楕円体対象のSPEC更新(1.5)、海王星半径、
  EM Bary軌道長半径は対応済み、重力源体数(1.4)は誤検知として却下済み。
- **celestial表示系**(body-class/body-visibility/celestial-registry/planet-distance/earth-view/
  scale-grid-view/celestial-view/map-visibility/environment-scene/sun-view/ring-view): 可視性・参照フレーム・恒星光源の
  規則はSPEC通りで、地球の扁平表示欠落(1.8)・環の面線切替(1.9)も対応済み。
- **軌道ガイド表示系**(orbit-guide-catalog/orbit-guide-kind-ids/orbit-guide-settings/
  orbit-guide-lines/guide-curve/direction-markers): CR3BP周期軌道カタログの分類・方向マーカーを保ちつつ、地球専用参照軌道の
  既定値(1.7)とゼロ速度曲線の4系8断面を仕様へ揃えた。
- **小天体点群**(point-field/point-field-view): 点数・軌道要素範囲を保ち、ヒルダ群の共鳴ドリフトを除去、
  カークウッド空隙のラベルを修正、カイパーベルトhot群を二峰性へ更新し、木星参照を注入可能にした。

## 6. プロセス上の注記

初回のグループ分けで `point-field.ts`/`point-field-view.ts`(小天体点群、CELESTIAL.md 10節)が
どのグループの担当にも入らず漏れていたため、9体目のエージェントを追加で起動して埋めた。
