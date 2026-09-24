# 遮蔽・照り返し・映り込み — スクリーンスペースの二次光（立て直し計画）

**計画ファイル。** `/run-plan` で上から実施し、完了した手順はこの文書から消す。この版は
`b4b586fcd` 時点のコードと履歴を監査して書いた。**前半（手順 1〜9: 拡散の遮蔽と照り返し）と後半
（手順 10〜13: 局所反射）は別の PR** とし、まず前半だけを実施する。

後半の局所反射はまだ実装されていない。現存する鏡面遮蔽は局所反射の原型ではなく、前半へ誤って
入った GTSO 風の別機能である。履歴から復元できるので退避ブランチは作らず、前半で削除する。

---

## 目的

前半では、画面に写った近傍の構造が拡散照度へ与える補正だけを求める。

```text
E_diffuse
  = E_sun
  + E_far
  - E_blocked_far
  + E_near_bounce

ΔE_screen = -E_blocked_far + E_near_bounce
```

- `E_sun`: 太陽の直射。既存の影パスとライティングパスが求め、スクリーンスペース処理は触らない。
- `E_far`: 遮られていない天体照と一様な環境光。ライティングパスが従来どおり求める。
- `E_blocked_far`: 近傍の構造に塞がれた方向から届くはずだった拡散照度。
- `E_near_bounce`: その方向にある近傍面の自発光と一回反射から届く拡散照度。

スクリーンスペースパスは最後の二項を符号付きの `ΔE_screen` として先に焼き、ライティングパスが
拡散照度へ一度だけ加える。**鏡面照度には一切掛けない。** 環境光・天体照の数やモデルが変わっても、
深度・法線をたどる幾何走査は画素ごとに一度だけとする。

狙いは次の4点である。

1. 地球を動かすと向きどおりに動く、現在の良好な拡散の影を極力保つ。
2. 鏡面の不自然な影、照り返し源側の地平線の線、粒状ノイズを除く。
3. 固定厚み、独立したフェード開始、最小天体角、最小鏡面ローブ角という調整値をなくし、公開する
   長さの設定を走査半径だけにする。
4. 中間値とパス別負荷をそのまま観察できる状態を先に作り、帯域・描画命令・遠方画素の無駄を減らす。

レンズ効果、グロー、太陽光の遮蔽、時間方向の蓄積は前半の対象外。局所反射は後半だけで扱う。

---

## 履歴とコードの監査で確定した前提

- 報告の表現とは異なり、現状も幾何走査の dispatch と深度ループは画素ごとに1回である。同じループで
  ambient、planet 0 / 1、鏡面ローブの遮蔽と照り返しを積んでおり、GIを光源ごとに重複加算してはいない。
  是正対象は、光源別・鏡面用の計算と3枚MRTを走査層へ持ち込んだ境界、および後段の帯域である。
- 現状は照り返し源、走査、深度だけの3×3 blur 2回、upsample の5本の全画面描画を使う。GPU計測は
  これらを `screenSpace` 1行へまとめるため、どこが重いか人間向けUIから切り分けられない。
- 鏡面遮蔽は `f6db628ef` から入り、`7318b2946` と `d48d348de` で拡張された前半の追加機能で、後半の
  局所反射は未実装である。履歴から戻せるため退避ブランチは作らない。
- デバッグ「遮蔽」は ambient の可視率だけを表示し、天体方向の遮蔽を隠す。raw走査結果も後段の
  ping-pongで上書きされ、通常像に出ている方向性を中間値として検査できない。
- 走査ループ内には既に1 px未満の early-out と1〜2 pxのfadeがあるが、照り返し源と後処理の固定費は
  省けていない。固定厚み、独立fade開始、最小天体角、最小鏡面ローブ角も現在の算法へ残っている。

従って「光源ごとの走査を1回へまとめる」のではなく、**既に1回である走査を光源非依存の
`-E_blocked_far + E_near_bounce` へ畳み、MRTと後段を減らす**のが手順6の意味である。

---

## 変えるもの・変えないもの

### 変えないもの

- 設定「遮蔽と照り返し」がオフの絵。
- 太陽直射と影マップの結果。
- 拡散照度に出ている地球照の方向性。地球を左右へ動かしたとき、凹部の暗い側も同じ向きへ動く。
- 明るい面の色と自己発光が近傍へ一回だけ返ること。
- 設定は「方式（オフ / 遮蔽 / 遮蔽と照り返し）」と「精細さ（低 / 中 / 高）」だけ。半径、厚み、
  フェード開始、標本数を人間向け設定へ増やさない。
- 同じ入力を同じフレームで描けば同じ画像になること。時間履歴は持たない。

### 意図して変えるもの

- 遮蔽設定を変えても鏡面照度は 1 px も変えない。
- 天体の見かけの角を最低角まで広げない。小さく弱い天体の拡散影は自然に消える。
- 深度標本を一定メートルの板として奥へ押し出さない。
- 距離減衰は `d / R` だけで決まり、独立した `fadeStart` を持たない。
- 照り返しだけに送り手側の余弦 `max(dot(n_source, -ω), 0)` を掛ける。遮蔽には掛けない。
- 深度だけの 3×3 均し2回を、法線と再構成位置を案内にする joint bilateral の復元へ替える。
- デバッグ表示をパイプライン順へ並べ、実在する各中間ターゲットを直接見せる。

---

## 先行研究から採る範囲

| 論文・実装 | この計画で採るもの | 採らないもの |
| --- | --- | --- |
| [HBAO](https://rdimitrov.twistedsanity.net/HBAO_SIGGRAPH08.pdf) | 半径だけから決まる compact な距離窓、画面内スライスの走査 | 鏡面への流用 |
| [Scalable Ambient Obscurance](https://research.nvidia.com/publication/2012-06_scalable-ambient-obscurance) | 深度階層・低解像度化を使うなら、距離に合う LOD を読む考え方 | SAO の式を現在の扇形積分へそのまま移植すること |
| [SSDO](https://phaazon.net/media/uploads/SSDO.pdf) | 照り返しの送り手余弦と、遮蔽・照り返しで重みを分けること | 遮りの後ろを二重に足す点標本のままの実装 |
| [SSILVB](https://arxiv.org/abs/2301.11376) | 新たに塞いだ方向だけから照り返しを集めること | 単層深度から一定の物体厚みを仮定すること |
| [GTAO / GTSO](https://www.activision.com/cdn/research/PracticalRealtimeStrategiesTRfinal.pdf) / [XeGTAO](https://github.com/GameTechDev/XeGTAO) | スライス数を優先する標本配分、空間ノイズとフィルターの評価方法 | GTSO。鏡面遮蔽は前半に入れない |
| [MSSAO](https://www.comp.nus.edu.sg/~lowkl/publications/mssao_visual_computer_2012.pdf) | 遠い帯を低解像度、近い帯を高解像度で扱う候補と、深度・法線による拡大 | scalar AO 用の octave 合成を符号付き RGB 補正へ流用すること |
| [blue-noise sampling](https://perso.liris.cnrs.fr/david.coeurjolly/publication/heitz-19/) | 時間蓄積なしの空間標本を高周波へ寄せること | フレームごとに模様を動かしてちらつきを作ること |
| [stochastic bilateral filter](https://doi.org/10.1109/TIP.2017.2777182) | 大きい窓を固定本数の疎な標本で近似する候補 | 「8×8だから64 spp相当」という品質の断定 |

`thickness` や独立した falloff 幅を持つ既存実装はあるため、それらが一般に存在しないとは主張しない。
今回削る理由は、単層深度から真の厚みを得られず、1.1 m と 2 m が絵合わせの自由度になっていること、
そしてこの場面では半径だけのモデルで十分かを先に検証すべきことにある。

---

## 設計判断

### D1. 前半は diffuse-only とし、鏡面遮蔽を削除する

`src/render/pipeline/screen-space/hemisphere-scan.ts:117-119,152-153` の鏡面ローブ、
`screen-space-light.ts:52` の `specularVisibility`、`ambient-source.ts:68` と
`planet-light-source.ts:204` の乗算を削除する。粗さ・視線・反射ベクトルを必要とする GTSO は、拡散の
遮蔽の副産物ではない。後半で局所反射を作るときも、今回の一つのローブ可視率は復帰させない。

### D2. 光源別可視率ではなく、符号付き拡散照度補正を層境界にする

現在の `ScreenSpaceLight` は ambient / planet 0 / planet 1 / specular の可視率と正の照り返しを持ち、
具体的な `AmbientSource` / `PlanetLightSource` と相互に依存している。これを次へ替える。

```ts
// screen-space/diffuse-correction.ts
export class DiffuseCorrection {
  // 全解像度 rgba16float。rgb = ΔE_screen、a = 使用しない。
  public readonly texture: THREE.Texture;
  public at(sample: ShadingSample): Vec3Node;
  public dispose(): void;
}

// lighting/diffuse-correction-source.ts
export class DiffuseCorrectionSource implements LightSource {
  // diffuse へ ΔE_screen、specular へ 0 を加算する。
}
```

まず既存 estimator の出力から同じ `ΔE_screen` を組んで消費側だけを移し、拡散画像が変わらないことを
確認する。その後に走査側を一枚の符号付き補正へ置き換える。この二段階により、層境界のバグと算法の
変化を同じ差分へ混ぜない。

負値を `colorNode` へ書かない。`mrtNode` と `RGBA16F` が負値を保持し、ライトプリパスの加算合成を通して
負の拡散補正を保てることを、`-1 / 0 / +1` の GPU probe と raw debug 表示で先に確認する。保てなければ
マテリアルパスで `lightPrepass.diffuse + ΔE_screen` を行う。正負を別テクスチャへ恒久化して問題を隠さない。

### D3. 一回の幾何走査で `-blocked + bounce` を積む

画面上の各スライス・各歩で深度と法線を一度読み、遮蔽は方向領域、照り返しは面積領域として同じ
ループの別 accumulator へ積む。両者の測度を混ぜない。

```text
blocked += W(d/R)
         * ∫newly-blocked L_far(ω) max(dot(n_receiver, ω), 0) dω

bounce  += W(d/R) * L_source
         * max(dot(n_receiver,  ω), 0)
         * max(dot(n_source,   -ω), 0)
         * A_patch / d²
         * f_new

ΔE_screen = -blocked + bounce
```

- `L_far(ω)` は一様環境光と有効な天体照をその方向で合成した放射輝度。有限の扇形を中央の一点で
  評価しない。一様環境光は扇形の余弦重みつき立体角を解析的に掛ける。各天体は、既存ライティングと
  同じ拡散用の代表放射輝度（uniform / textured の設定を含む）を受光点ごとに一度だけ求め、その値を
  天体球冠と新規扇形の fractional overlap へ掛ける。走査中の planet texture fetch は増やさない。
  これにより、1扇形より小さい天体も総エネルギーが球冠の立体角に比例し、最低角を必要としない。
- `L_source` は太陽直射（影込み）、天体照、一様環境光で照らされた面の一回反射と自己発光を、走査前の
  1枚へ焼いた放射輝度。現在フレームの天体光源テクスチャを使えるよう、その bake を走査より前へ移す。
- `A_patch` は標本画素が表す有限の面積、`f_new = μ(newly covered) / μ(patch footprint)` はその patch の
  余弦重みつき角 footprint のうち、手前の標本がまだ塞いでいなかった割合。扇形マスクは `f_new` と
  前後関係だけを決め、bounce の form factor そのものには使わない。比の分子・分母に共通する角投影は
  相殺されるので、送り手余弦と `1/d²` を二重計上しない。
- 遮蔽は方向の可視性なので送り手余弦を掛けない。照り返しは面の投影面積なので掛ける。
- 手前の標本が既に覆った方向は、奥の遮蔽にも照り返しにも再加算しない。

`A_patch` と角 footprint は次の一意な規則で作る。標本中心の view-space 位置と法線から接平面を作り、
その標本が代表する full-resolution G バッファ画素領域の四隅の ray を接平面へ交差させる。得た四角形を
受け手中心・半径 `R` の球で clip し、非有限またはカメラ後方の交点は捨てる。この四角形の面積が
`A_patch`、受け手の半球へ投影した範囲が角 footprint になる。隣接標本を閾値で同一面へ連結しないので、
新しい depth threshold は生まれない。

角 footprint の各扇形に対する被覆率は 0〜1 の連続値で求める。端の扇形は固定2D blue-noise で確率的に
bit へ量子化し、期待値を被覆率へ一致させる。**単独標本へ最低1扇形を与えない。** 32 / 64 sector の
収束を測り、平均照度と細い梁の差が許容内になる小さい方を固定する。sector 数は品質設定や人間向けの
ノブにしない。

`hemisphere-scan.ts:19-35` の `FADE_START_DISTANCE` / `SLAB_THICKNESS` / `MIN_CAP_ANGLE` /
`MIN_LOBE_ANGLE` は削除する。距離窓だけを HBAO から借り、`W(t) = max(0, 1 - t)`、`t = d/R` として
半径の外を0にする（estimator 全体が HBAO と同じという意味ではない）。`STEP_DISTRIBUTION_EXPONENT` は
削除し、各層化標本 `u = (step + jitter) / stepCount` を線形窓の正規化 CDF の逆
`t = 1 - sqrt(1 - u)` で距離へ写す。自己遮蔽を避ける深度 bias とゼロ除算回避 epsilon はバッファ精度
と full-resolution pixel footprint から導き、`MIN_ELEVATION` の固定値を残さない。`MAX_SCREEN_RADIUS` の固定0.25も
削除し、投影半径は viewport 境界で実際に読める距離だけに幾何的に clip する。

### D4. 一つの放射量を一つの target に持ち、すべての target を直接見せる

最終構成は次の3段とする。

```text
照り返し源 rgba16f（「遮蔽」では作らない）
        ↓
一回の走査 → raw ΔE_screen rgba16f
        ↓
joint bilateral 復元 → full-resolution ΔE_screen rgba16f
```

同じ段に光源別・鏡面用の MRT を足さない。raw と full-resolution は算法上別の中間段なので各1枚を
持つ。フィルター用の一時 target が必要なら、それもデバッグ表示へ出し、寿命を上書きで隠さない。

符号付き値の表示は、負の成分を赤、正の RGB をその色、ゼロを黒に写す。これは値の符号と表示レンジを
見える形へ写すだけで、別の遮蔽を再計算したり、ambient だけを代用品として表示したりしない。
「遮蔽」設定で raw / 復元後を見れば負項だけになり、地球を動かしたときの方向性を直接確認できる。

### D5. デバッグ表示と GPU 行はパイプライン順にする

`通常` だけを先頭の例外とし、残りは生成順に並べる。

```text
通常
Gバッファ
→ 影マップ / 影
→ 天体照の光源テクスチャ
→ 照り返しの源
→ raw拡散補正 / 復元後の拡散補正
→ 拡散照度 / 鏡面照度
→ マテリアル / 大気 / レンズ
```

この順序が依存関係のトポロジカル順であることを `debug-target.ts` の配列直前へコメントする。GPU の行も
`screenSpace` を末尾へ足す形をやめ、実行順に「照り返し源」「近傍拡散走査」「近傍拡散復元」へ分ける。

render-lab の人間向け UI には「負荷」節と明示的な「計測」ボタンを置く。既存の `LabView.measure()` を
再利用し、現在のケース・角度・描画設定をウォームアップ後30回測って CPU 描画時間と全 GPU 行の
median / p95 を表示する。自動更新はせず、計測中だけボタンを無効にする。

### D6. 背景と1画素未満の受け手は expensive work の前で棄却する

走査解像度での投影半径 `r_px` を使う。背景は即座に中立値、`r_px <= 1` は `ΔE_screen = 0` として
深度走査と照り返し源の評価を行わない。`1 < r_px < 2` の `smoothstep(1, 2, r_px)` は **raw correction を
確定するときに一度だけ**掛ける。source は仕事を省くだけ、復元段はフェードを掛け直さない。復元後は
中心画素の `r_px <= 1` を再確認して厳密に0へ戻し、近隣からの漏れを残さない。1〜2 px は画素 footprint
に由来する内部規則で、品質設定へ露出しない。

現在も `hemisphere-scan.ts:173` に走査ループだけの early-out はある。立て直しでは背景・照り返し源・
復元段まで同じ中立条件を共有し、半解像度と全解像度を取り違えないこと、境界をカメラが横切っても
pop しないこと、実際に走査時間が減ることまでを完了条件にする。

### D7. blue noise と joint bilateral は単一スケールを先に完成させる

時間蓄積は足さない。固定した2D blue-noise でスライスの方位と歩幅だけを散らし、同じ入力では同じ模様に
する。復元の重みは次とし、合計が小さいときだけ中心標本へ戻る。

```text
w = w_spatial
  * exp(-ln(2) * δ_plane²)
  * exp(-ln(2) * δ_normal²)

δ_plane  = abs(dot(p_sample - p_center, n_center))
           / worldPixelFootprint_fullres(center)
δ_normal = (1 - dot(n_center, n_sample)) / (1 - cos(30°))
```

位置差は中心画素の full-resolution world-space footprint で無次元化し、half / full resolution で同じ
境界を表す。法線の30°は filter の固定 half-weight であり、人間向けのノブにはしない。疎な filter は
center tap を必ず含み、weight sum が数値 epsilon 以下なら center へ戻す。

まず dense 5×5 を品質の基準にし、その後に8本の stochastic taps が、平均 bias、RMSE、接触影の contrast
と edge spread、bounce 色の平均エネルギー、法線・深度境界の漏れ、静止・camera pan の frame difference、
GPU時間で同等かを比較する。満たす場合だけ疎な8本へ替える。「8標本の走査×8標本の復元」を64標本と
同等とは呼ばない。blue noise は誤差を高周波へ寄せるために使い、分散自体が減るとは仮定しない。

精細さは解像度・スライス数・歩数・復元 tap 数をまとめた内部 profile であり、個別ノブを作らない。
低設定は少なくとも現在の低設定より粒径・bias・camera pan 時の泳ぎを悪化させない。half-resolution と、
full-resolution のまま slice / step / tap を減らす候補を両方測り、情報を失う低解像度化を前提にしない。
最終の profile 値は候補行列を実測して固定し、コードコメントには理論値でなく実測から選んだことを書く。

### D8. multi-scale は今回の前半へ入れない

MSSAO の scalar AO は octave 間を max / average で混ぜるが、`-blocked RGB + bounce RGB` へ同じ合成を
すると二重計上や色ずれを起こす。近帯と遠帯を独立走査すると、近帯に隠れた遠帯の bounce を遠帯が
再加算し、距離窓の和を1にしても first-hit visibility は保存できない。さらに depth mip は、選んだ面と
同じ normal / radiance payload を運ぶ conservative hierarchy がなければ、実在しない面を作る。

従って前半は単一スケール＋early rejection＋joint bilateral で閉じる。達成目標を満たさなければ main へ
送らず、次の別計画で、近帯の sector occupancy を遠帯へ渡す構造と depth / normal / radiance を一体で
選ぶ階層を先に設計する。今回の計画の中で試作を足したり、隠れた帯 target を作ったりしない。

---

## SPEC と作業規則へ先に入れる内容

`/modify-feature` で `DEVELOP/SPEC/RENDERING.md` をコードより先に直す。前半の実装範囲だけでなく、既に
決まっている後半の局所反射まで先行して書き、どちらを実施しても嘘にならない振舞いを確定する。

- 近傍構造の遮蔽と照り返しは拡散照度を変える。鏡面ではこの遮蔽量を流用せず、滑らかな面が反射方向に
  ある近くの物体を映し、その像が奥にあった天体照・環境光の像を置き換える。粗いほど像はぼけ、十分に
  粗ければ局所像は見えない。拡散近傍光輸送と局所反射は別のパス・別のアプローチとして扱う。
- 太陽直射とその影は、拡散近傍光輸送でも局所反射でも二重に遮らない。
- 遮蔽の方向性は天体照の方向に従い、照り返しは返す面の明るさ・色・向かい合い方に連続的に従う。
- デバッグ表示は候補数や全候補の一覧を仕様化しない。`通常` を除いて生成順に並び、そのフレームで
  実際に作られた中間バッファを必要に応じて可能な限り直接選べる。表示のための復号、トーンマッピング、
  深度のレンジ変換、符号付き値の0を0.5へ持ち上げるような可視化変換は許すが、再計算や一部成分の
  代用はしない。
- 描画設定で無効な段は、デバッグのために実行せず黒を表示する。
- render-lab で現在の構図と設定の CPU / GPU パス別負荷を、人が操作して計測できる。

`DEVELOP/CODING-RULE.md` §4.3 には「中間データを要求されたデバッグ表示は、そのフレームで本番経路が
作ったデータを直接読み、別計算・一部成分の代用・デバッグ時だけの本番段の再実行をしない」を足す。

`.claude/skills/rendering-workflow/SKILL.md` には、新しい描画段を作るとき、各永続中間ターゲットを生成順に
デバッグ表示へ出し、raw / filter / upsample の上書きで観測不能にしないことを足す。表示用の復号と
トーンマッピングは許すが、表示のための算法再実行は許さない。

---

## 達成目標

### 正しさ

1. 同一フレームのデバッグ「鏡面照度」は、設定「オフ」「遮蔽」「遮蔽と照り返し」の相互比較で
   max absolute pixel difference が0。`leo-metal` と `bay-metal` でも一致する。
2. `bay-earth-overhead` / `bay-earth-open` / `bay-earth-corner` で、地球を左右へ動かすと raw と復元後の
   負の拡散補正が同じ方向へ動く。指定座標の 5×5 sRGB 平均を PBR Neutral から線形へ戻した輝度比
   `P_in / P_out` は、before の同じ撮影に対して大きい天体で ±0.06、小天体で ±0.10 を超えて退行しない。
3. `bounce-cosine` の同じ面積・距離・放射輝度で、実際の source 面を `cos θ = 1 / 0.5 / 0` にした3組の
   線形照り返し輝度が `1 / 0.5 / 0` の ±0.10。環境光と天体照は切り、emissive の一回反射だけで測る。
   角度 sweep は単調で、照り返し源側の地平線に直線状の境界が残らない。遮蔽 accumulator が source
   normal を参照しないことは estimator test でも固定する。
4. `FADE_START_DISTANCE` / `SLAB_THICKNESS` / `MIN_CAP_ANGLE` / `MIN_LOBE_ANGLE` /
   `STEP_DISTRIBUTION_EXPONENT` / `MIN_ELEVATION` / `MAX_SCREEN_RADIUS` と同義の見た目調整定数・uniform・設定が0件。
   人間が調整する長さは半径だけ。
5. 天体照の数とモデルを変えても、走査の dispatch 数、深度・法線の標本数、raw 補正 target の枚数が
   変わらない。小さな天体の角度を広げず、天体の視半径 sweep で blocked energy が立体角に対して単調、
   かつ32 / 64 sector の線形輝度差が2%以下。
6. `bay-truss` で梁から4 pxより外へ暗い暈が出ず、`bay-edge` で画面端に直線状の段差が出ない。
7. オフの組は before 2組に対する `render-lab:compare` の封筒外が0件。太陽直射だけの `albedo` の
   既存基準と、天体・材質の既存撮影も意図しない封筒外が0件。

### 観測可能性

8. デバッグボタンは D5 の順で、順序の意図を固定するテストとコメントがある。照り返し源、raw補正、
   フィルター一時値（存在する場合）、復元後補正をそれぞれ選べる。ambient visibility を方向性遮蔽の
   代用品として表示しない。
9. render-lab の「負荷」で、操作中のケースと設定について CPU 描画時間と GPU の
   「照り返し源 / 近傍拡散走査 / 近傍拡散復元」を median / p95 で読める。未対応環境は「未対応」と出る。

### 品質と負荷

10. `r_px <= 1` の画素は raw と復元後の両方が厳密に0で、1〜2 px の距離スイープに空間的・時間的な
    段差がない。1〜2 px の fade を複数段で累乗しない。
11. 低・中・高の各設定で、`bay` の平坦な5×5領域について、dense 5×5 filter と高 profile を基準にした
    mean bias / RMSE、標準偏差、接触影の contrast / edge spread、bounce 色の平均エネルギー、法線・深度
    境界の漏れ、camera pan の frame difference が before の同じ設定以下。低設定でも現在より大きな粒を
    目視できない。
12. 同じ render-lab セッション（960×540、`bay`、3回計測の中央値）で、最終の「遮蔽と照り返し・中」の
    GPU 合計が修正前の70%以下かつ「マテリアル」の5倍以下。「遮蔽・中」は4倍以下。各内訳の増減を
    説明できる。各回は warmup 後30 frame の中央値とする。1080p の中間 target は一時 target 込みで、
    中設定32 MiB以下、高設定64 MiB以下。
13. `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings` が通る。

---

## 手順 — 前半（この PR）

### 手順 1. 拡散近傍光輸送・局所反射・観測可能性の仕様を先行させる

**目的** — 実装より先に前半と後半を通した見え方とデバッグの約束を確定する。アルゴリズムや中間target
の名前・枚数ではなく、表現される結果と観測可能性を書く。現在のユーザー指示をこのSPEC差分への合意と
し、差分提示による待機は省略して単独commit後に手順2へ進む。

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md:5-47` | 拡散の近傍遮蔽・照り返しと、鏡面の局所反射を別の段として位置づけ、後半実施後も真であるパイプラインにする |
| `DEVELOP/SPEC/RENDERING.md:208-223` | 拡散近傍光輸送の方式・精細さに加え、近くの物体の映り込みを選べることを書く |
| `DEVELOP/SPEC/RENDERING.md:225-262` | 候補数と網羅一覧を削り、実在する中間バッファを生成順に可能な限り直接見せる一般契約へ置き換える。表示用の復号・レンジ変換は許す |
| `DEVELOP/SPEC/RENDERING.md:264-284` | GPU各段の負荷とrender-labの現在条件を人が計測できる振舞いを書く。固定のパス一覧は書かない |
| `DEVELOP/SPEC/RENDERING.md:417-426` | 近傍構造による拡散の方向性・照り返しの向かい合い方と、鏡面へ映る近傍物体の見え方を明確にする |

**完了条件**

- SPEC だけのdiffで、候補数・target名・AO算法を書かず、後半の局所反射まで矛盾なく先行している。
- `docs(spec): 近傍光輸送と局所反射の役割を分ける` の単独commitになる。

### 手順 2. デバッグ作業規則へ再発防止を足す

**目的** — 中間値の代用品を表示した今回の失敗を、コード規約と描画 workflow の両方で防ぐ。

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/CODING-RULE.md:734-748` | 本番経路が作った中間値を直接読む規則と、再計算・一部成分の代用・デバッグ時だけの再実行の禁止を追記 |
| `.claude/skills/rendering-workflow/SKILL.md:26-40,69-103` | 永続中間 target の全表示、生成順、上書きで観測不能にしない確認を工程へ追記 |

**完了条件と検証**

- 二文書が同じ原則を違う言葉で矛盾なく示す。SPEC の見え方を workflow 側へ重複転記しない。
- `npm run typecheck`。
- commit: `docs(dev): 描画の中間バッファを直接観測する規則を足す`

### 手順 3. 再現画像とパス別負荷の基準を固定する

**目的** — 良い拡散影、悪い鏡面影、照り返しの地平線、品質別ノイズ、遠方棄却の境界を修正前に残し、
以降の各段で比較できるようにする。同時に、算法を変えずに負荷の内訳を人間が見られるようにする。

| ファイル | 変更 |
| --- | --- |
| `tools/render-lab/bay-cases.ts:254-327` | 既存 `bay` へ地球左右、天体視半径 sweep、投影半径1〜2 px、低/中/高の撮影を追加 |
| `tools/render-lab/bounce-cosine-case.ts`（新規）/ `cases.ts` | 同じ world-space 面積・距離・emissive radiance で実際の面を `cos θ = 1 / 0.5 / 0` にした3組と対称な受け手を置く。新しい配置が必要なので較正専用ケースにする |
| `tools/render-lab/lab-case.ts:54-60` / `lab.ts:350-389` | `LabShot.debugTarget` を足し、撮影ごとに通常像・拡散照度・鏡面照度・各中間 target を指定して自動撮影できるようにする |
| `src/render/gpu-timings.ts:6-37` | `screenSpace` 1行を source / scan / reconstruct に分け、値とラベルを実行順へ並べる |
| `src/render/pipeline/screen-space/screen-space-pass.ts:213-225` | 現在の prepass、scan、2回の blur、upsample を上の3行へ正しく計上する。算法は変えない |
| `tools/render-lab/lab.ts:301-342` | sampling 本体を共有し、CLI用 `measure(case, angles)` は保ったまま、ケース・角度・設定を変えない `measureCurrent()` を足す |
| `tools/render-lab/index.html:57-95` / `main.ts:180-260` | 既存 `Button` とテーマ token で「負荷」節、計測ボタン、median / p95 の行を足す。撮影適用時は debug target のボタンも同期する |
| `tests/render/gpu-timings.test.ts:6-18` | IDとラベルの一対一に加え、実行順と3内訳を固定する |

**完了条件と検証**

- `/ui-design` に従い、既存 widget / token だけを使う。計測しない間に毎フレームの追加処理をしない。
- `npm run typecheck` / `npm run test:render` / `npm run verify:ui-style`。
- `npm run render-lab:shot -- ss-repair-before-1` と `-- ss-repair-before-2` を撮り、全追加撮影を目視する。
- render-lab UI と `node tools/render-lab-measure.mjs 3 screen-space` の中央値が許容誤差内で一致する。
- commit: `feat(render-lab): 近傍光輸送の再現撮影と負荷内訳を足す`

### 手順 4. 鏡面遮蔽だけを除去する

**目的** — 前半の責務を拡散へ戻す。拡散 estimator はまだ変えず、良い部分が不変かを単独で確認する。

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/hemisphere-scan.ts:117-119,152-153` | specular range、`occluded.w`、`extent.z`、`MIN_LOBE_ANGLE` を削除 |
| `src/render/pipeline/screen-space/screen-space-pass.ts:269-299` | roughness / view / reflection から作る `specularLobe()` と入力を削除 |
| `src/render/pipeline/screen-space/screen-space-light.ts:12-73` | alpha の鏡面可視率と `specularVisibility()` を削除 |
| `src/render/pipeline/lighting/ambient-source.ts:61-69` | 鏡面は従来の環境放射輝度をそのまま返す |
| `src/render/pipeline/lighting/planet-light-source.ts:180-205` | 天体照の鏡面へ近傍可視率を掛けない |

**完了条件と検証**

- `npm run typecheck` / `npm run test:render`。
- 同一セッションで「オフ / 遮蔽 / 遮蔽と照り返し」のデバッグ「鏡面照度」が pixel diff 0。
- before との比較で拡散照度・遮蔽・照り返しの撮影が封筒内。
- commit: `fix(render): 近傍の遮蔽を鏡面照度から外す`

### 手順 5. 消費側を符号付き拡散補正へ移す

**目的** — estimator の数値を変えずに D2 の層境界へ移し、光源別の可視率をライティング source へ
注入する循環を解く。

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/diffuse-correction.ts`（新規） | 全解像度の signed `ΔE_screen` target と読み口。負値 probe を含む |
| `src/render/pipeline/lighting/diffuse-correction-source.ts`（新規） | diffuse にだけ補正を加える `LightSource` |
| `src/render/pipeline/screen-space/screen-space-pass.ts:252-374` | 現行 visibility と indirect、通常 lighting と同じ ambient / planet diffuse irradiance から、upsample 時に同値の `-blocked + bounce` を出す |
| `src/render/pipeline/lighting/ambient-source.ts` / `planet-light-source.ts` | `ScreenSpaceLight` 依存と occluded variant を削除し、uniform / textured を含め通常 lighting と同じ diffuse irradiance の読み口を screen pass へ公開 |
| `src/render/pipeline/lighting/indirect-source.ts` | `DiffuseCorrectionSource` に置換して削除 |
| `src/render/pipeline/screen-space/screen-space-light.ts` | 移行後に削除 |
| `src/render/pipeline/render-pipeline.ts:138-153,357-365,459-465` | 構築を環境光源→screen pass→補正 source の一方向へ直し、planet-light bake を screen pass より前へ移す |
| `src/render/pipeline/debug-target.ts:2-28` / `render-pipeline.ts:218-271` | ボタンを生成順へ並べ、最終 signed correction を実 target から直接表示する。raw は手順6で足す |
| `tests/render/screen-space-correction.test.ts`（新規） | off の中立値、モード、signed encode、鏡面0の契約を固定 |
| `tests/render/debug-target.test.ts`（新規） | `通常` の例外、トポロジカル順、最終 correction の対応を固定 |

**完了条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render`。
- 遮蔽と照り返しの全 before 撮影が封筒内。鏡面は手順4の基準と pixel diff 0。
- GPU probe と raw readback で負値が0へ clamp されない。NaN / Inf がない。
- `AmbientSource` / `PlanetLightSource` から screen-space への import が0件。
- estimator を変える前の最終 correction debug で、地球方向の負項と照り返しの正項を直接確認できる。
- commit: `refactor(render): 近傍光輸送を符号付き拡散補正として渡す`

### 手順 6. 走査を一枚の拡散補正へ畳み、不要ノブを削る

**目的** — D3/D4 の式へ置き換え、固定2天体・鏡面ローブ用 MRT、厚み、独立フェード、最低角をなくす。
ここでデバッグ表示も新しい中間 target へ直接つなぎ、以後の品質調整を観察可能にする。

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/lighting/diffuse-environment.ts`（新規） | ambient radiance と、各 planet の cap＋既存ライティングと同じ代表 diffuse radiance を受光点ごとに組み、指定した有限角領域との fractional integral を返す境界 |
| `src/render/pipeline/lighting/planet-light-source.ts:152-278` / `planet-light-image.ts:74-103` | uniform / textured の代表 diffuse radiance を lighting と correction で共有する読み口を作る。texture は受光点・天体ごとに一度評価し、走査標本ごとに読まない |
| `src/render/pipeline/render-pipeline.ts:459-465` | 手順5で確定した planet-light bake → screen-space source / scan の順を保つ |
| `src/render/pipeline/screen-space/hemisphere-scan.ts:19-35,83-173,259-263` | D3 の方向積分と patch form factor、接平面 footprint、fractional sector、半径だけの距離窓、signed RGB 1出力へ書き換える |
| `src/render/pipeline/screen-space/screen-space-pass.ts:62-157,252-374` | source 1枚、raw correction 1枚、full correction 1枚へ target と段を減らす |
| `src/render/pipeline/screen-space/diffuse-correction.ts` | raw / final の直接 debug access を公開 |
| `src/render/pipeline/debug-target.ts:2-28` | 手順5の生成順へ raw を足し、配列順の不変条件をコメントする |
| `src/render/pipeline/render-pipeline.ts:218-271` | 既存 target を直接読む debug composite。signed の表示変換以外をしない |
| `tests/render/screen-space-estimator.test.ts`（新規） | 小天体 cap の fractional energy、patch form factor、partial sector の期待値、32/64 sector の収束を CPU reference で固定 |
| `tests/render/debug-target.test.ts` | raw を加え、各 persistent target の対応を固定 |

**完了条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render`。
- 達成目標2〜6、8。特に「遮蔽」で地球方向の raw / final が移動し、鏡面は不変。
- `rg 'FADE_START_DISTANCE|SLAB_THICKNESS|MIN_CAP_ANGLE|MIN_LOBE_ANGLE|STEP_DISTRIBUTION_EXPONENT|MIN_ELEVATION|MAX_SCREEN_RADIUS|specularVisibility' src` が0件。
- 走査 shader は光源数にかかわらず1 dispatch。scan / filter target は1 attachmentずつ。
- commit: `refactor(render): 遮蔽と照り返しを一回の拡散補正走査へ畳む`

### 手順 7. 遠方・背景画素を処理の手前で棄却する

**目的** — 画面の大半を占める背景と、4 m が1 px未満になる遠方天体へ高価な仕事をしない。

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/hemisphere-scan.ts:173` | 既存の走査内判定を共通の projected-radius 判定へ抽出 |
| `src/render/pipeline/screen-space/screen-space-pass.ts` | source と scan は `r_px <= 1` で仕事を省き、raw 確定時だけ1〜2 px fade を掛ける。reconstruct は fade を再適用せず、最終の `r_px <= 1` を0へ戻す |
| `tools/render-lab/bay-cases.ts` | 手順3の1〜2 px距離スイープを回帰撮影として残す |

**完了条件と検証**

- `npm run typecheck` / `npm run test:render`。
- 達成目標10。境界の連続性を静止画差分とカメラ距離スイープで確認する。
- 遠景の多いケースで scan GPU median が手順6より下がり、近景だけの `bay` は画像が封筒内。
- commit: `perf(render): 近傍補正が1画素未満の画素を早期棄却する`

### 手順 8. joint bilateral 復元と品質 profile を決める

**目的** — D7 に従って粒を減らし、低設定でも大粒にせず、2回3×3 blur の帯域を減らす。

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/screen-space-pass.ts` | depth-only blur 2回を、位置・法線・空間距離で重みづける denoise + upsample へ置換 |
| `src/render/pipeline/screen-space/hemisphere-scan.ts` | 固定2D blue-noise の方位・歩幅への使い方を整理 |
| `src/render/pipeline/screen-space/quality-profile.ts`（必要なら新規） | 低/中/高の解像度・slice・step・tap の組を1箇所に置く |
| `tools/render-lab-screen-space-metrics.mjs`（新規） | 逆 tone-map 後の mean bias / RMSE / 分散、contrast / edge spread、色エネルギー、edge 漏れ、連続 frame 差を報告 |

固定 dense 5×5 と8本 stochastic taps を同じ source / scan 結果で比較し、達成目標11・12を両方満たす
最小の方を採る。視覚だけで標本数を増やさない。

**完了条件と検証**

- `npm run typecheck` / `npm run test:render`。
- `npm run render-lab:shot -- ss-repair-filter` を撮り、達成目標3、6、10、11を確認。
- render-lab UI で source / scan / reconstruct のどこが減ったかを記録し、達成目標12を満たす。
- commit: `perf(render): 近傍拡散補正をバイラテラル復元する`

### 手順 9. 前半を監査し、比較して main へ送る

**目的** — 意図しない見た目・不要な調整値・隠れた中間 target を残さず前半を閉じる。

- `/refactor` と `/comment-cleanup` を、前半で触った `src/` へ適用する。
- `DEBUG_TARGETS`、`GPU_PASS`、screen-space の全 target と全設定を列挙し、D4/D5 と一対一か監査する。
- `npm run render-lab:shot -- ss-repair-after` と
  `npm run render-lab:compare -- .render-lab-shots/ss-repair-after .render-lab-shots/ss-repair-before-1 .render-lab-shots/ss-repair-before-2`。
- 封筒外は達成目標で意図した撮影だけで、差分画像をすべて説明できること。
- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- main へ送るなら `/send-pr` の全検証と PR 本文作成を行う。
- 前半に関する達成目標・判断・手順をこの文書から消し、後半だけを次の作業用に残す。

---

## 手順 — 後半（別 PR: 局所反射）

前半が main へ入った後に再監査して実施する。前半で削除した GTSO 風 `specularVisibility` は復帰させず、
局所反射自身が「近傍へ当たった像」と「その向こうの遠方鏡面光を置き換える重み」を所有する。

### 後半で維持する設計

- **追跡**: 鏡の向きに1本、半解像度の view depth 上を画面空間で透視補正した刻みで進める
  （McGuire & Mara 2014）。開始点を blue noise でずらし、画面外・空・カメラへ向かう ray は miss。
  画面の縁と最大距離の手前で confidence を0へフェードする。
- **ぼかし**: 当たった点の色は、マテリアルパス出力の縮小列から読む。LOD は鏡面ローブが当たり距離で
  張る円の半径から選ぶ（Uludag 2014）。
- **粗さの上限**: 知覚的粗さ0.3まで全量、0.6で0。それより粗い面では局所反射を足さず、前半完了時の
  遠方鏡面をそのまま残す。前半のAOから鏡面遮蔽を復帰させない。
- **放射輝度**: 今のフレームのマテリアルパス出力（太陽・天体照・環境光・照り返し・自己発光込み）。
  前フレームの履歴は使わない。
- **遠方鏡面との合成**: `w = roughness fade × edge fade × distance fade × hit confidence` とし、hit 部分の
  遠方鏡面を `1 - w` で弱め、`F0 × local image × w` を足す。miss では遠方鏡面を変えない。
- **パス位置**: trace は遠方鏡面を弱めるのでライティングより前。像の resolve はマテリアルパス後・
  大気パス前。
- **設定**: `screenSpaceSpecular`（真偽、低 / 中 / 高 preset = オフ / オフ / オン）。既存の
  `screenSpaceDiffuse` / `screenSpaceQuality` の値は振り直さない。

### 後半の合格条件

1. `leo-metal` の金属・粗さ0.05の球に隣の球が映り、オフでは映らない。
2. `bay-metal` の粗さ0.05の板に白い立方体と薬莢が映って遠方の天体照像を置き換える。粗さ0.4では
   像がぼけ、粗さ0.8ではオン/オフ差が3 LSB以下。
3. オフのデバッグ「鏡面照度」は前半完了時と pixel diff 0。
4. GPU の「映り込み」median が同じ session の「マテリアル」の5倍以下。
5. `ssr-after` と `ssr-before-1/2` の比較で、封筒外は局所反射が出る金属面に限られる。

### 手順 10. 局所反射の before を2組撮る

**目的** — `leo-metal` と `bay-metal` に近くの物体がまだ映っていないことを確認し、比較基準を残す。
コードは変えない。

- `npm run render-lab:shot -- ssr-before-1` と `-- ssr-before-2`。
- `leo-metal` の粗さ0.05の球に隣の球、`bay-metal` の粗さ0.05の板に立方体と薬莢が映っていないことを
  画像で確認する。

### 手順 11. 鏡の向きへ追跡し、遠方鏡面との置換重みを作る

**目的** — 反射 ray の hit uv / 距離 / confidence を求め、像を足す前に、hit 部分の遠方鏡面だけを
`1 - w` で弱める。

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/reflection-trace.ts`（新規） | 半解像度 view depth の透視補正追跡、blue-noise jitter、hit / miss、画面端・距離・粗さ confidence。ray thickness の単位と根拠をここに閉じる |
| `src/render/pipeline/screen-space/screen-space-reflection.ts`（新規） | 全解像度 target。`rg = hit uv`、`b = view-space hit distance [m]`、`a = w` の符号化と、遠方鏡面を置換する読み口 |
| `src/render/pipeline/screen-space/screen-space-pass.ts` | 映り込みオン時だけ trace を追加。拡散補正の走査とは別 dispatch / target / GPU timing にし、遮蔽オフでも動く |
| `src/render/pipeline/lighting/ambient-source.ts` / `planet-light-source.ts` | 局所反射オン時だけ miss confidence を遠方鏡面へ掛ける。前半のAOは参照しない |
| `src/render/graphics-settings.ts` / `render-pipeline.ts` | `screenSpaceSpecular` を配る |
| `src/render/pipeline/debug-target.ts` / `render-pipeline.ts` | hit uv / distance / confidence の実 target を生成順に直接表示する |

```ts
export class ScreenSpaceReflection {
  public readonly texture: THREE.Texture;
  public farSpecularWeight(sample: ShadingSample): FloatNode; // off/miss は 1、hit は 1-w
  public dispose(): void;
}
```

**完了条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- 映り込みオンの `bay-metal` で、粗さ0.05の板の立方体が映るはずの領域から遠方天体照の像が消える。
  まだ局所像は足さないので、その領域は暗く見える。粗さ0.8はオフと差が3以下。
- オフの組は `ssr-before-*` と封筒外0件。
- commit: `feat(render): 滑らかな面の映る向きを追い遠方鏡面を置き換える`

### 手順 12. 当たった像を粗さに応じて足す

**目的** — 当たった点の色をマテリアルパス出力の縮小列から粗さに応じて読み、`F0 × image × w` を
マテリアル後・大気前へ足す。

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/reflection-pass.ts`（新規） | 共有 target のcopyと縮小列、roughness LOD、hit uv 解決、加算。GPU「映り込み」へ計上 |
| `src/render/pipeline/render-pipeline.ts` | マテリアルパス後・大気前に呼び、像だけのデバッグ表示を生成順へ足す |
| `src/render/gpu-timings.ts` | 前半完了時の実行順に「映り込み」を追加。数値IDはその時点で採番する |
| `src/render/pipeline/debug-target.ts` | `'reflection'`「映り込み」を追加 |

写しの持ち主は、大気パスが持つマテリアル出力のcopyと共有できるかを `/ownership` で確かめて決める。
共有 target を書きながら読まない。

**完了条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render`。
- `npm run render-lab:shot -- ssr-on` で後半合格条件1〜3。デバッグ「映り込み」は像だけを表示する。
- commit: `feat(render): 滑らかな面に近くの物体の像を映す`

### 手順 13. 後半を追い込み、比較して main へ送る

**目的** — 粗さ・画面端・距離のフェード、追跡歩数と hit tolerance を追い込み、意図しない画像差と負荷を
確認して後半を閉じる。

- `npm run render-lab:shot -- ssr-after`。
- `npm run render-lab:compare -- .render-lab-shots/ssr-after .render-lab-shots/ssr-before-1 .render-lab-shots/ssr-before-2` で後半合格条件5。
- `node tools/render-lab-measure.mjs 3 screen-space` に映り込みオン/オフ軸を足し、合格条件4。
- `memos/hedalu244/better_graphics/pipeline.md` のパス表と残件を更新する。
- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- `/refactor` / `/comment-cleanup` / `/send-pr`。
- 残件がなければこの計画ファイルを削除する。

---

## 見積り

### 前半

| 手順 | 中央見積り | 根拠 |
| --- | ---: | --- |
| 1. SPEC | 1.5 h | 5節の整合確認とレビュー |
| 2. 規則 | 0.5 h | 2文書の局所修正 |
| 3. 基準・計測UI | 5 h | 撮影5群、cosine較正ケース、GPU3行、既存 measure の UI 接続 |
| 4. 鏡面遮蔽削除 | 2 h | 5ファイル、画像不変確認 |
| 5. 層境界移行 | 6 h | signed target / source、同値な天体拡散入力、循環解消、probe |
| 6. 一回走査 | 16 h | fractional角積分、patch form factor、planet bake 順、footprint、debug |
| 7. 棄却 | 2 h | 3段共通条件と距離スイープ |
| 8. 復元 | 8 h | bilateral 2候補、品質profile、画像指標 |
| 9. 最終監査 | 4 h | 前後比較、規約、関連検証 |

**合計 45 h**。最大の不確実性は、fractional sector と接平面 footprint を TSL で組む費用、天体の
representative radiance を correction と lighting で共有する境界、負の MRT 加算が backend で保持されるか
である。最後の点は手順5の probe で早期に判定する。

### 後半

追跡 7 h、置換境界 3 h、縮小列と像 6 h、品質・負荷・比較 6 h、before と最終監査 3 hで **25 h**。
前半完了後の target / timing 構成を再監査してから更新する。

負荷の初期予算は、前半の修正前に得た 960×540 の実測単価を引き継ぐ。半解像度の深度標本1回を
マテリアル行の約0.1倍として、32歩の追跡3.2倍、全解像度の写しと5段の縮小列1.0倍、全解像度の
解決1.0倍、合計約5.2倍を出発点とする。これは採用値ではなく、手順10で同じ機材・sessionの before を
撮り直すための仮説である。合格条件の5倍以下へは、画を見ずに歩数だけ削らず、hit率・miss率・
edge fade と内訳を合わせて追い込む。

---

## リスクと検出場所

| リスク | 影響 | 検出・対処 |
| --- | --- | --- |
| signed RGB が `colorNode` や blend で0へ切られる | 遮蔽が消え、照り返しだけ残る | 手順5の -1/0/+1 probe。`mrtNode` を使い、raw debug と readback を照合 |
| textured planet の bake が前フレームになる | 地球を動かすと遮蔽と光源色が1フレームずれる | 手順6で bake→source→scan の順を timing / debug 両方で確認 |
| `L_far` と lighting の天体モデルが違う | 塞いだ分以上に引く、色が変わる | 同じ `DiffuseEnvironment` を両者が使い、uniform/textured 切替の差分を撮る |
| source cosine を遮蔽にも掛ける | 薄い面を掠めると環境光が不自然に透ける | 手順6の送り手角度スイープ。blocked は不変、bounce だけ連続変化 |
| footprint が深度不連続をつなぐ | 梁・輪郭の外に暈が出る | `bay-truss` と法線/深度 edge 指標。連続判定は pixel footprint から導く |
| radius の端または1px棄却で pop | カメラ移動中に輪が走る | `bay-edge` と距離スイープ。補正全体へ同じ窓を一度だけ掛ける |
| bilateral が符号の違う補正を混ぜる | 接触部が明滅・色漏れする | raw/final の直接表示、position/normal edge 指標、重み不足はcenter fallback |
| blue noise をフレームごとに動かす | 静止画は良いが動画がちらつく | 固定2D pattern、連続フレーム readback の一致 |
| debug のために段を再実行する | 見ている値と通常フレームが違う | 手順2の規則、手順6/9の target↔debug 一対一監査 |
| raw を ping-pong で上書きする | 問題の発生段を見分けられない | 各 persistent target の寿命と debug getter を同じ表でレビュー |
| GPU 行の順が実行順でない / 複数段が同じ行 | 重い場所を誤認する | `gpu-timings.test.ts` で順序と3行を固定、render-lab UI と CLI を照合 |
| 小天体を扇形中央の一点で評価する | 影が全量か0になり、最低角を消しても energy を保存しない | coverage-premultiplied な角領域積分と視半径 sweep、32/64 sector 比較 |
| footprint と source cosine を同じ角測度へ二重に入れる | 掠める面の bounce が過剰に弱る | sector は first-hit 比率、bounce は `cos_r cos_s A/d²` と役割を分離 |
| multi-scale を occupancy の引き継ぎなしで足す | 近帯に隠れた遠帯を再加算する | 前半では禁止。別計画で near occupancy と整合する payload hierarchy を先に設計 |
| 後半が削除した GTSO に再依存する | 不自然な鏡面影が復活する | 後半の entry review で `specularVisibility` 0件を確認し、LR所有の confidence だけを使う |
| 局所反射の解決で書き込み中の共有 target を読む | WebGPU validation error で画面全体が失敗する | 手順12で copy / ownership を先に確定し、同じ描画命令の read-write を禁止 |
| 縮小列の特定 mip へ描けない | 粗い面でも像が鋭いままになる | 手順12の最小プローブで各 mip を別色にし、LOD と実 target を照合 |
| 空の深度を hit として扱う | 虚空が黒い像として映る | 手順11で空・画面外・カメラ向き ray を明示的に miss とし、`leo-metal` 上端を確認 |
| 粗さ fade と遠方鏡面の置換を二重適用する | 中間粗さだけ天体照の映り込みが過剰に暗くなる | 手順11/12で同じ `w` を置換と像に一度ずつ使い、`bay-metal` の粗さ sweep を測る |
