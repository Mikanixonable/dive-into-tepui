# 遮蔽・照り返し・映り込み — スクリーンスペースの二次光(計画)

**計画ファイル。** `/run-plan` で上から実施し、実施した手順はここから消す。行番号は
`de2f23595`(PR #98 を取り込んだ main)の時点のもの。作業は main から切ったブランチで行う。
**前半(手順 1〜6: 遮蔽と照り返し)と後半(手順 7〜11: 映り込み)は別の PR にする。**

---

## 目的

白い宇宙機(スペースシャトルの荷室、ISS のトラスと与圧区画)は、**同じ材質・同じ向きの面でも、
開けた外側と囲まれた内側で明るさも色も大きく変わる。** 原因は 2 つある。

1. **環境光が近くの構造に遮られる。** 凹部・隙間・付け根は、そこから見える空の一部が構造で
   塞がれているので、そのぶん天体照を受けない。
2. **日の当たった白い面が、近くの面を照らし返す。** アルベド 0.8 の面どうしが向かい合うと、
   遮られて失ったぶんに匹敵する光が返ってくる。色つきの面のそばでは、その色が移る。

加えて、宇宙機には金属の部品が多く、**薬莢や破片が機体に近接する**ので、滑らかな面に近くの物体が
映ってほしい(3 つめ。いまの天体照の映り込みだけでも絵は悪くないので優先度を下げ、後半の PR に回す)。

**この文書で「環境光」と言ったら、影マップを適用できない光源 — 天体照(スロット)と一様な環境光
(ゲームプレイのための例外)— を指す。** 太陽の直射は含まない。太陽の遮り方は影パスが半影の幅まで
物理から解いているので、そこへ遮蔽を重ねると二重に暗くなる。いまは環境光が遮られずに届き
(`src/render/pipeline/lighting/planet-light-source.ts:102` の TODO)、照り返しも映り込みも無い。

**影マップと同じ方法は採れない。** 影マップは光源ごとに要り、天体は 100 体を超え、面光源(ランバート
球)に対する影は点光源に対する影よりさらに高価である。全天体から影マップを撮る方向は採らない。
**画面に写っているもの(G バッファ)から近傍の遮りと照り返しを引く、スクリーンスペースの手法を採る。**

レンズ効果・グロー・太陽光の遮蔽はこの計画の外。

前半(遮蔽と照り返し)の仕様は `3da39b408` で `DEVELOP/SPEC/RENDERING.md` へ入れた。

### SPEC へ足す文面(後半 — 手順 7 で入れる)

**「描画パイプライン」節** — 遮蔽と照り返しのパス(4)の本文の末尾へ「映り込みを描く設定では、
滑らかな面が映す向きにある近くの物体も探す。」を足し、マテリアルパス(6)の後ろへ次の段を挿んで
13 段にする。

> 7. **映り込みパス**: マテリアルパスの絵から、滑らかな面に映る近くの物体の像を求め、その面の
>    反射率を掛けて足す。

**「地球の描画」節** — 前半で足した 3 項の後ろへ。

> - **滑らかな面には、近くの物体が映る。** 金属や艶のある面には、天体照の像と太陽のほかに、近くの
>   物体がその面の向きどおりに映り、映った物体はその向こうにあった天体照の像を隠す。粗い面ほど像は
>   ぼけ、十分に粗い面では物体の形は映らず、物体の陰で天体照の映り込みが弱まるだけになる。

**「描画品質設定」節** — 前半で足した 2 項の後ろへ。

> - **近くの物体の映り込み**: オン/オフ。オフでは滑らかな面に近くの物体が映らない(遮蔽と照り返しが
>   オフでなければ、物体の陰で天体照の映り込みが弱まることは残る)。

**「デバッグ表示」節** — 「候補は次の19種類。」とし、「照り返し」の後ろへ。

> - **映り込み**: 滑らかな面に映る近くの物体の明るさを、通常出力と同じトーンマッピングだけを通して
>   表示する。

描画品質設定で切られている段の列挙と、デバッグ情報ウィンドウの GPU の並びへ「映り込み」を足す。

---

## 決めたこと

覆すときは、見出しの括弧の中の手順が変わる。

### D1. 遮蔽・曲げた法線・照り返しを、可視ビットマスクの走査 1 本で同時に求める(手順 3・4)

- **走査の骨組みは XeGTAO**(Intel 2021、GTAO の実装)と同じ — 画素ごとに数本のスライス(画面上の
  向き)を取り、それぞれ両側へ数歩ずつ深度を引く。**スライスの中の遮りは、最大の地平線角 2 つでは
  なく 32 bit のマスク(扇形 32 個)で持ち**、引いた深度の標本を一定の厚み T の板とみなして、板が
  覆う扇形を立てる(Therrien, Levesque, Gilet 2023「Screen Space Indirect Lighting with Visibility
  Bitmask」arXiv 2301.11376)。
- **採る理由は 3 つ。**
  1. **細い遮りが、その後ろの空を全部は塞がない。** 地平線角の最大値で持つ方式(GTAO/HBAO)は、
     細い梁の後ろの空をまるごと塞ぎ、梁のまわりに暗い暈を作る。トラスはこの構図そのもの。
  2. **照り返しを「新たに塞がった扇形」からだけ足す**ので、遮りの後ろの遮りを二重に数えない
     (照り返し += popcount(今の標本の扇形 & ~これまでの扇形)/32 × 標本の放射輝度)。
  3. **遮蔽だけなら費用は GTAO と変わらない**(論文の実測で GTAO の +0.01〜0.02 ms、RTX 2080・1080p)。
- **論文から変えるところ — 扇形はスライスの中で余弦重みの測度が等しくなるよう、角度ではなく sin で
  刻む**(論文と公開実装は角度で等分し、照り返しに受け手側の余弦を掛ける)。こうすると
  popcount/32 がそのまま余弦重みの遮蔽率になり、**遮蔽率 V も照り返しの放射照度も「一様な光で満たされた
  半球 = π L」の目盛りで閉じる。** 達成目標 2・3 の期待値はこの目盛りから出す。
- **標本の放射輝度は今のフレームの直射**(D2)。論文も SSDO(Ritschel, Grosch, Seidel 2009)も、今の
  フレームの直射のバッファを読む。標本の面の向きは、受け手に背を向けた面を捨てるのにだけ使う
  (ランバート面の放射輝度は向きに依らない)。
- **環境光の相互反射は、GTAO(Jimenez, Wu, Pesce, Jarabo 2016)の多重反射の当てはめで補う** —
  `G = max(V, ((V·a + b)·V + c)·V)`、`a = 2.0404ρ − 0.3324`、`b = −4.7951ρ + 0.6417`、
  `c = 2.7552ρ + 0.6903`(アルベド 0.1〜0.9 の 3 回反射の経路追跡へ当てはめたもの)。ρ は受け手の
  (1 − 金属度)× ベース色の輝度。ρ = 0.8 で V = 0.5 → G = 0.81。**光源へ掛ける持ち上げ g = G / V**
  を可視率と一緒に持たせる。
- 採らなかった手法(同じ案を再提案しないため):

  | 手法 | 採らない理由 |
  | --- | --- |
  | HBAO / HBAO+ / SAO | 遮蔽の量しか出さず、曲げた法線と照り返しを別に組むことになる。細い遮りの暈も残る |
  | GTAO(原論文の形) | 1 画素 1 スライスを、時間方向の 6 回転で補う前提(D5 に反する) |
  | HBIL(Mayaux 2018) | 前フレームの放射輝度を写し直して読み、TAA に頼る(D5 に反する) |
  | SSDO | 画素ごとの点の標本なので同じ品質に標本数が要り、遮りの後ろの二重計上を防ぐ仕組みを持たない |

### D2. 遮蔽と照り返しのパスは影パスとライティングパスの間に置き、照り返しの光源は「遮る面が太陽の直射と自己発光で返す光」に限る(手順 3・4)

- **遮蔽はライティングパスの入力でなければならない。** 天体照と一様な環境光だけを弱め、太陽を
  弱めないためには、光源ごとに掛け分けられる場所 — 光源 1 本の描画命令の中 — で掛けるしかない。
  ライティングパスの後に置くと、照度バッファの中で太陽と環境光が足し合わされていて分けられない
  (分けるには照度バッファを光源の系統ごとに持つ必要があり、全画面 MRT の描画命令ごとの帯域が
  倍になる)。
- **そのかわり、照り返しの光源になる「遮る面の明るさ」は、ライティングパスの結果を待てない。**
  太陽の直射(影込み)と自己発光だけなら、G バッファと影パスの透過率から半解像度の前処理 1 枚で
  引ける。**太陽の直射の放射照度は太陽光源と同じ式から引く**(`SunSource` から切り出して共有する。
  重複させない)。光源モデルの設定によらず点光源の式を使う — 球光源との違いは明暗の終端の視半径
  (1 天文単位で 0.27°)ぶんだけで、照り返しの中では見えない。
- **遮る面が天体照と環境光から受けて返す光(環境光の相互反射)は、D1 の多重反射の当てはめで統計的に
  補う。** 白い宇宙機では凹部の中の面がほぼ同じアルベドを持つので、当てはめの前提(まわりの面は受け手と
  同じアルベド)が成り立ちやすい。
- **覆すなら**(環境光の相互反射も照り返しとして明示的に集める): パスをライティングパスの後ろへ
  移し、照度バッファを太陽と環境光で分ける(手順 3 の置き場と、`LightPrepass` の MRT が変わる)。

### D3. 「遮蔽」も「遮蔽と照り返し」も、遮られ方は光の来る向きによる(手順 3)

- **「遮蔽」と「遮蔽と照り返し」の違いは照り返しの有無だけにする。** 走査は V と同時に曲げた法線
  (遮られない向きの余弦重みの平均)を返す(XeGTAO の実測で費用 +25%)。光源側の経路は 1 つで済む。
- **見えている空を円錐で表す** — 軸は曲げた法線、半角 β は `cos β = √(1 − V)`(余弦重みで V になる
  円錐。GTSO と同じ換算)。
- **天体照は、この円錐と光源の球冠の重なりで弱める。** 重なりは、法線まわりの極角を
  `cos θ' = cos θ · |cos θ|` で写した球面で解く — 写した球面では余弦重みの測度が一様になるので、
  円錐は `cos β' = 1 − V`、光源の球冠は中心の極角を同じ式で写し、半径 σ' を「遮られない放射照度
  (いまの天体照が引いている Snyder の閉じた解)が写した球面の面積に一致する」大きさ
  (`1 − cos σ' = sin²σ × 地平線の係数`)に取る。**重なりは球冠 2 つの交わりの厳密式**(acos 3 つ。
  Oat & Sander 2007 / Mazonka 2012)で、弱める割合 = 交わり ÷ 光源の球冠。
  - こうすると 2 つの極限で外さない: **光源が半球を覆うとき割合は V に一致し**(一様な環境光と同じ)、
    **小さい光源は円錐の内なら 1、外なら 0。** 低軌道の地球(視半径 ≈ 70°)は前者、月(0.25°)は後者に
    あたる。月に一律の V を掛けると、開口が月を向いた凹部の底が暗くなる。
  - **交わりの smoothstep による近似は採らない** — 大きい球冠で 5〜16% 過大になり(調査で経路追跡と
    照合)、低軌道の地球がそこに当たる。厳密式でも acos 3 つで済む。
- **一様な環境光には V × g(= G)を掛ける。天体照は「重なりの割合 × g」。**
- **環境光の鏡面は GTSO(Jimenez 2016)で弱める** — 鏡面のローブを半角 α_s の円錐
  (`cos α_s = 2^(−3.32193·α²)`、α は GGX の α)とし、見えている円錐との重なり ÷ ローブの円錐。
  **粗さの小さい端では 1 へ戻す**(Filament の `SpecularAO_Cones` と同じ入れ方。鏡のような面では
  ローブの円錐が細すぎて、重なりが画素ごとに 0 と 1 を跳ぶ)。
- **テクスチャの天体照は、拡散の写しを法線の向きではなく曲げた法線の向きで、見えている円錐の幅で
  読む** — 塞がれた向きにある天体の部分の色が混ざらない。
- **覆すなら**(「遮蔽」では光の向きを問わず一律に弱める): 手順 3 の `EnvironmentOcclusion.capFactor`
  が設定の値を受け、「遮蔽」では V × g を返す。

### D4. 天体を照らし返す側から外す仕組みは足さない(手順 3・4)

- 遮蔽と照り返しの届く距離は**ワールド空間の半径 R(艦の構造の寸法、初期値 4 m)**で打ち切る。天体は
  艦から数百 km 以上離れているので、艦の画素から見て半径の内側に天体の画素は来ない — **天体照の
  光源になっている天体が照り返しに乗って二重に届くことは、半径の打ち切りだけで起きない。**
- 天体の表面を受け手にした画素は、半径が画面上で 1 画素に満たないので走査しない。1〜2 画素のあいだで
  効きを 0 から 1 へ渡し、打ち切りの境目を段差にしない。地形の凹凸による遮蔽は作らない、という
  「地球の描画」節の規則とも合う。
- **天体照をオフにしても、照り返しは天体照の代わりにならない。** 半径の外には届かず、画面の外の
  天体は数えられず、低軌道の地球は空の 140° を占めるので、画面に写った一部から引くとカメラの向きで
  明るさが変わる。天体の光は天体照だけが運ぶ。

### D5. 時間方向の蓄積を持たない(手順 3・4・9)

- 走査の向きと刻みのずれは**画素座標だけから引く blue noise**(`src/render/blue-noise.ts`、64² の
  タイル)で配り、粒は空間の均し(深度で縁を保つ)だけで消す。
- パイプラインには動きベクトルも前フレームの履歴も無く、フローティングオリジンの移動で前フレームの
  座標は今フレームと一致しない。**render-lab の撮影は同じ場所なら同じ絵になる前提**で組まれている。
- **覆すなら**(時間方向に溜めて標本を減らす): 前フレームの描画座標への写し直しから作ることになり、
  この計画の外の規模になる。

### D6. 描画設定は「方式」と「精細さ」の 2 項目、映り込みは別の 1 項目(手順 3・4・9)

| 項目(キー) | 値 | 低 / 中 / 高 プリセット |
| --- | --- | --- |
| 遮蔽と照り返し(`screenSpaceDiffuse`) | 0 オフ / 1 遮蔽 / 2 遮蔽と照り返し | オフ / 遮蔽 / 遮蔽と照り返し |
| 遮蔽と照り返しの精細さ(`screenSpaceQuality`) | 0 低 / 1 中 / 2 高 | 低 / 中 / 中 |
| 近くの物体の映り込み(`screenSpaceSpecular`、後半) | 真偽 | オフ / オフ / オン |

- 精細さの段(初期値。手順 5 で追い込む): 低 = 半解像度・スライス 2 × 片側 3 歩、中 = 半解像度・
  3 × 4、高 = 全解像度・3 × 6。**「高」は高プリセットでも選ばない切り分け用の段**(積雲の精細さの
  「精細」と同じ扱い)。
- **鏡面の遮蔽(specular occlusion)は設定にしない。** 遮蔽がオフでなければ環境光の鏡面も D3 の GTSO で
  弱める。映り込みをオンにしても、粗い面ではこれが残る。
- 値は保存された設定を読む鍵なので、段を足しても既存の値は振り直さない。

### D7. 映り込みは鏡の向きに 1 本だけ追い、粗さぶんは今のフレームの絵の縮小列でぼかし、粗さの上限でフェードする(手順 9・10)

- **追跡**: 鏡の向きに 1 本、半解像度の view 深度の上を、画面空間で透視補正した刻みで進め(McGuire &
  Mara 2014, JCGT 3(4))、一定の厚みで当たりを決める。開始点を blue noise でずらす。画面の外・空
  (深度 0)・カメラへ向かう線は外れとし、画面の縁と最大距離の手前でフェードする。
- **ぼかし**: 当たった点の色は、マテリアルパスの出力をぼかした縮小列から引く。段は、鏡面のローブの
  円錐が当たりの距離で張る円の半径で選ぶ(Uludag 2014, GPU Pro 5: `θ = acos(0.244^{1/(p+1)})`、
  円の半径 r から `段 = log2(r · max(幅, 高さ))`。Phong の指数と GGX の α は `p = 2/α² − 2`)。
- **粗さの上限**: 知覚的な粗さ 0.3 まで全量、0.6 で 0(Unreal の既定 `ScreenSpaceReflectionMaxRoughness`
  0.6 と同じ)。それより粗い面では物体の形は映さず、D3 の GTSO が天体照の映り込みを弱めるだけにする。
  - **モンテカルロで粗い面を追わない。** 時間方向に溜めない(D5)ので、1 画素数本の標本はそのまま粒と
    して残り、空間で均すと像が溶ける。物理的でないと承知でフェードする — 製品実装も粗さの上限で
    打ち切る(HDRP の既定は 0.1、Unreal は 0.6)か、縮小列でぼかす(Godot 4.6)。
- **放射輝度は今のフレームのマテリアルパスの出力**(太陽・天体照・環境光・照り返し・自己発光込み)。
  前フレームは D5 により読めない(Godot 4.6 と HDRP は前フレームを読む)。
- **環境光の鏡面との合わせ方** — 映り込みを信じる重み w(粗さのフェード × 画面の縁と距離のフェード)で、
  環境光の鏡面へ掛ける割合 = `mix(GTSO, 当たりなら 0・外れなら 1, w)`、映り込みの寄与 =
  `F0 × 像 × 当たり × w`。重なる領域で 2 つが二重に効かない。
- **追跡は遮蔽と照り返しのパスの中**(環境光の鏡面を弱めるのでライティングより前)、**像を引く解決は
  マテリアルパスの後・大気パスの前**(像がライティングの結果を要る。大気の霞は映り込みにも掛かる)。

### D8. 試験体として render-lab に荷室のケース `bay` を足す(手順 2)

- いまの自機はほぼ凸な円柱で、材質の格子は孤立した球なので、**遮蔽も照り返しも写らない。** 物体の
  配置が新しく要るので、撮影ではなくケースを足す。
- 映り込みは、材質の格子の撮影 `leo-metal`(金属の行の球に隣の球が映る)と、荷室の中の金属の板で見る。
- 部品は three の箱と `MeshStandardMaterial` で組み、`markLitOpaque` / `markShadowCaster` で実機と
  同じ経路に載せる(材質の格子と同じ作り)。薬莢は実機の表示部品
  (`src/render/dynamic/dynamic-entity/casing-view.ts`)を import して置く。実機の描画の計算は lab へ
  写さない。

---

## 達成目標

画素の位置は、手順 2 でケースのコメントに書く読みどころ(`P_in` など)で指す。値は PNG の sRGB。

1. **遮蔽が効いている。** 撮影 `bay-earthshine`(太陽は床の真下、天体照と環境光だけ)で、荷室の内隅に
   近い床 `P_in` が外側の床 `P_out`(同じ材質・同じ向き)より 20 以上暗い。設定「遮蔽と照り返し」をオフに
   した同じ撮影では差が 2 以下。
2. **遮蔽の量が幾何の期待値に合う。** 撮影 `bay` をデバッグ表示「遮蔽」で撮り、半径 R の内側に遮りの
   無い床 `P_open` が 255 ± 8、奥の壁の足元 `P_base` が 128 ± 20(壁が余弦重みの半球の半分を塞ぐ)、
   奥の壁と端の壁が床と交わる内隅 `P_corner` が 64 ± 20(4 分の 3 を塞ぐ)。
3. **照り返しの明るさが幾何の期待値に合う。** 撮影 `bay-bounce`(照り返しの較正: 太陽は奥の壁へ正対し
   床を掠める、天体照と環境光なし、1 天文単位)で、壁の足元の床 `P_base` の線形値が
   `床のアルベド × 壁の放射輝度 × 形態係数 = 0.8 × 0.8 × 0.5 = 0.32` の ±20%(133〜155)。
   「遮蔽」だけでは同じ点が 10 以下。
4. **照り返しが返す面の色を帯びる。** 撮影 `bay` で、日の当たる橙の端の壁のそばの白い床 `P_bleed` の
   R/B 比が、「遮蔽と照り返し」で「遮蔽」の 1.2 倍以上。
5. **自己発光が照り返す。** 撮影 `bay-dark`(太陽は床の真下、天体照なし)で、光る箱のそばの床 `P_glow` が
   「遮蔽と照り返し」で「遮蔽」より 10 以上明るい。
6. **太陽の直射だけが当たっている面は変わらない。** 較正の撮影 `albedo` の右下の球の最も明るい画素が
   (241, 241, 241) のまま。
7. **オフは今の絵と同じ。** 設定「遮蔽と照り返し」をオフにして撮った組が、before の 2 組に対して
   `npm run render-lab:compare` で封筒外 0 件(`bay-*` を含む全撮影)。
8. **天体と較正の撮影は動かない。** 既定の設定(高プリセット)で撮った組で、`earth*` / `leo-*` /
   材質の格子の全撮影 / `saturn*` / `march-slab` / `order` が封筒内。封筒外に出るのは艦・基地
   (`ship*` / `modular-ship-*`)・`protein-*`・`blackbody`・`bay*` の撮影だけで、差分画像の差は凹部・
   付け根・部品どうしが向かい合う面に限られる。
9. **細い遮りのまわりに暈が出ない。** 撮影 `bay-truss`(細い梁の格子を地球を背に写す)の差分画像
   (既定 − オフ)で、梁の輪郭から 4 px より外(地球の円盤・梁の向こうの床)に差が出ない。
10. **画面の縁で段差が出ない。** 撮影 `bay-edge`(荷室が画面の左端で切れる)の差分画像(既定 − オフ)で、
    画面の縁に沿った直線状の段差が見えない。
11. **負荷が収まる。** render-lab(960×540)の `bay` で、GPU の「遮蔽と照り返し」行の中央値が、同じ
    セッションで測った「マテリアル」行の中央値に対して、遮蔽・中で 4.5 倍以下、遮蔽と照り返し・中で
    9 倍以下(導出は「見積り」)。
12. `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings` が通る。

後半(映り込み)の合格条件:

13. 撮影 `leo-metal` で、金属・粗さ 0.05 の球に隣の球が映る(映り込みオフでは映らない)。
14. 撮影 `bay-metal` で、粗さ 0.05 の金属の板に白い立方体と薬莢が映って天体照の像を隠し、粗さ 0.4 の
    板では像がぼけ、粗さ 0.8 の板では形が映らない — 映り込みのオン/オフで粗さ 0.8 の板の差が 3 以下。
15. GPU の「映り込み」行の中央値が「マテリアル」行の 5 倍以下。
16. 7・8 と同じ比較が、映り込みをオンにした組でも成り立つ(封筒外に出るのは金属面を含む撮影だけ)。

---

## 手順

### 手順 2. render-lab に荷室のケースを足し、before を撮る

**目的** — 描画を変える前に、いまの問題(内外で明るさが変わらない・照り返しが無い)を撮影で再現する。
あわせて、撮影の組を描画設定の差分つきで撮れるようにする(達成目標 7 の「オフで撮った組」)。
**描画の挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/render-lab/bay-cases.ts`(新規) | 荷室のケース `bay` と撮影 7 枚。読みどころの画素座標をコメントに書く |
| `tools/render-lab/cases.ts` L163–172 | `BAY_CASES` を `CASES` へ足す |
| `tools/render-lab-shot.mjs` | 第 2 引数以降の `項目=値`(値は JSON として読む)を描画品質設定の差分として全ケースの `shoot(name, graphics)` へ渡す |

荷室の部品(寸法は m。白は線形 0.8・粗さ 0.7・金属度 0):

- **床**: 20 × 8 × 厚さ 0.2 の白い板。荷室の外へ左右 6 m ずつはみ出させる — 外側に半径 R の内側に
  遮りの無い床(`P_open` / `P_out`)を残し、内側の床 `P_in` と同じ材質・同じ向きで比べるため。
- **奥の壁**: 幅 8 × 高さ 2.5 の白。**端の壁** 2 枚: 奥行き 6 × 高さ 2.5 — 日の当たる側(ケースの恒星は
  `OBLIQUE_SUN_DIR` で −X から差すので +X 側)の内面を橙(0.8, 0.3, 0.05)、反対側を白。手前は開ける。
- **床の中央に白い立方体**(1.2)。**奥の壁の手前の床に光る箱**(0.6 角・高さ 0.3、ベース色は黒、
  自己発光の放射輝度 1.5 の青緑)— 壁に貼ると壁と同じ面になり、壁も床も照らさない。
- **トラス**: 断面 0.15 角の梁で 1 m 格子を 3 × 2 × 2 区画、立方体の右に立てる。
- **金属の板** 3 枚(1.5 × 1.5、金属度 1、粗さ 0.05 / 0.4 / 0.8)を立方体の左に、立方体と光る箱が映る
  向きに立て、手前に薬莢を数個置く。
- **地球**: 高度 420 km、荷室の真上(開口から天体照が差し込む向き)。
- 読みどころは、どの撮影でも他の部品の影と映り込みが掛からない所に取る(`P_base` は立方体・トラスの
  影を外した奥の壁の足元)。

| 撮影 | 観察の向きの差分 | 描画設定の差分 | 読む達成目標 |
| --- | --- | --- | --- |
| `bay` | 既定(斜光、地球は真上) | なし | 2(デバッグ表示「遮蔽」)・4 |
| `bay-earthshine` | 恒星を床の真下(−Y)へ — 見えている面はどれも直射を受けない | なし | 1 |
| `bay-bounce` | 恒星を奥の壁の法線(+Z)へ — 床と端の壁は直射を掠めるだけ。地球を遠ざける | `planetLightCount: 0, ambient: false` | 3 |
| `bay-dark` | 恒星を床の真下へ、地球を遠ざける | `planetLightCount: 0` | 5 |
| `bay-truss` | トラスへ寄せて上から見下ろし、地球を背にする | なし | 9 |
| `bay-edge` | カメラの方位を回し、荷室を画面の左端で切る | なし | 10 |
| `bay-metal` | 金属の板へ寄せる | なし | 前半は鏡面の遮蔽の目視、後半は 14 |

**達成条件と検証**

- `npm run typecheck`。
- `npm run render-lab:shot -- ss-before-1` と `npm run render-lab:shot -- ss-before-2` で、2 組とも
  `bay-*.png` が 7 枚出る。
- 画像を開いて問題を確かめる: `bay-earthshine` の `P_in` と `P_out` の差が 2 以下、`bay-bounce` の
  `P_base` が 10 以下(照り返しが無い)、`bay-dark` の `P_glow` が光る箱から離れた床と同じ暗さ。
- `npm run render-lab:shot -- ss-check planetLightCount=0` の `bay.png` で、荷室が天体照を失って暗く
  なる(引数が効いている)。確かめたら `.render-lab-shots/ss-check` は消す。
- commit: `feat(render-lab): 遮蔽と照り返しを読む荷室のケースを足す`。**before の 2 組はこの commit の
  コードで撮る** — 手順 3 に手を付ける前。

### 手順 3. 遮蔽を足す

**目的** — 天体照と一様な環境光を、近くの構造の塞がり方で弱める(設定「オフ / 遮蔽」)。走査・均し・
拡大の器を作り、D3 の向きつきの遮蔽と GTSO を光源へ入れ、デバッグ表示と GPU の行を足す。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/screen-space/screen-space-pass.ts`(新規) | パスの器。前処理(半解像度の view 深度 r32float)→ 走査 → 均し(縁を保つ 3×3 を 2 回)→ 拡大(全解像度の画素ごとに、2×2 の半解像度画素のうち view 深度が最も近いものを採る)。精細さ「高」は全解像度で走査し拡大を省く。オフのフレームは描画命令を出さず、オフへ切り替わった最初のフレームだけ出力を空へ戻す(残すとデバッグ表示に切る直前の像が凍る。レンズ段と同じ)。`GPU_PASS.screenSpace` で計上 |
| `src/render/pipeline/screen-space/hemisphere-scan.ts`(新規) | 可視ビットマスクの走査(D1)。スライス数・歩数は実行時の値の動的ループ。刻みは 2 乗で手前へ寄せる。画面外の標本は遮らない |
| `src/render/pipeline/screen-space/environment-occlusion.ts`(新規) | 可視率テクスチャの符号化(書く側)と、光源が読む係数(読む側)。円錐と球冠の重なり(D3)と GTSO |
| `src/render/pipeline/lighting/planet-light-source.ts` L102 / L151–191 / L234–296 | 遮蔽の有無でマテリアルを分けて持つ(キャッシュの鍵を「モデル × 遮蔽の有無」に)。遮蔽ありでは拡散に `capFactor`、鏡面に `lobeFactor`、テクスチャの拡散は曲げた法線と円錐の幅で読む。L102 の TODO は「艦の構造は遮蔽が扱い、別の天体による遮りだけが残る」へ狭める |
| `src/render/pipeline/lighting/ambient-source.ts` L20–51 | 遮蔽の有無でマテリアルを 2 枚持ち、拡散に `uniformFactor`、鏡面に `lobeFactor`(反射ベクトル・粗さ)を掛ける |
| `src/render/pipeline/render-pipeline.ts` L109–189 / L201–249 / L330–351 / L365–370 / L423–430 / L487–506 | 生成(影パスの後。`EnvironmentOcclusion` を天体照と環境光へ渡す)、`render()` で影パスの後・天体照の写しの前に走らせる、`compile()` に段「遮蔽と照り返し」、`rebuildForGraphics()` で方式・精細さ・遮蔽の有無を一箇所から配る、デバッグ表示「遮蔽」の合成材質(V をそのまま灰色で)、`dispose()` |
| `src/render/graphics-settings.ts` L159–182 | `screenSpaceDiffuse`(この手順では 0 オフ / 1 遮蔽。高プリセットも仮に 1)と `screenSpaceQuality` を「光源」群の `ambient` の後ろへ |
| `src/render/gpu-timings.ts` L6–34 | `screenSpace: 15` と表示名「遮蔽と照り返し」 |
| `src/render/pipeline/debug-target.ts` | `'occlusion'`「遮蔽」を「鏡面照度」の後ろへ |
| `tools/render-lab-measure.mjs` L14–22 / L42–70 | 測る軸の表を持たせ第 2 引数で選ぶ(既定は今の大気)。軸「遮蔽と照り返し」は `bay` の構図で オフ / 遮蔽 × 低中高 / 遮蔽と照り返し × 低中高 を巡り、「遮蔽と照り返し」と「マテリアル」の行を並べて出す |

新しい API:

```ts
// screen-space-pass.ts
export const SCREEN_SPACE_DIFFUSE = { off: 0, occlusion: 1, indirect: 2 } as const;
export const SCREEN_SPACE_QUALITY = { low: 0, medium: 1, high: 2 } as const;

export class ScreenSpacePass {
  // mode / quality は構築時点の描画設定 screenSpaceDiffuse / screenSpaceQuality の値。
  public constructor(
    renderer: WebGPURenderer, gbuffer: GBufferPass, gpu: GpuTimings, mode: number, quality: number,
  );
  public setMode(mode: number): void;
  public setQuality(quality: number): void;
  // 全解像度。rg = 曲げた法線(view 空間、oct 符号化)、b = 余弦重みの可視率 V、a = 相互反射の持ち上げ g。
  // 符号化の正本は environment-occlusion.ts。
  public get visibilityTexture(): THREE.Texture;
  public render(camera: THREE.Camera, width: number, height: number): void;
  public compile(camera: THREE.Camera, width: number, height: number): Promise<void>;
  public dispose(): void;
}

// hemisphere-scan.ts — 1 画素の半球を走査した結果。
export interface HemisphereScan {
  readonly visibility: FloatNode;  // 余弦重みの可視率 V 0..1
  readonly bentNormal: Vec3Node;   // 遮られない向きの余弦重みの平均(view 空間、正規化済み)
  readonly indirect: Vec3Node;     // 照り返しの放射照度。集めないときは 0(手順 4)
}
// 受け手(sample の位置・法線・視線)のまわりを、半解像度の view 深度 depth の上で走査する。
// radius は R を画面の走査解像度の画素へ直した値、noise は画素ごとの 0..1 の組。
export function scanHemisphere(
  sample: ShadingSample, depth: THREE.Texture, projection: Mat4Uniform,
  sliceCount: IntNode, stepCount: IntNode, radius: FloatNode, noise: Vec2Node,
): HemisphereScan;

// environment-occlusion.ts
// 走査の結果と受け手のアルベド albedo(線形 RGB)を、可視率テクスチャの 1 画素へ詰める。
export function encodeVisibility(scan: HemisphereScan, albedo: Vec3Node): Vec4Node;
export class EnvironmentOcclusion {
  public constructor(visibilityTexture: THREE.Texture);
  // 球冠の光源(軸 lightDir は view 空間の単位ベクトル、sinSigmaSqr は視半径の正弦の 2 乗、
  // horizon は遮られないときの地平線の係数 sphereIrradianceFactor)の拡散へ掛ける係数。
  // 持ち上げ込みなので 1 を超えうる。
  public capFactor(
    sample: ShadingSample, lightDir: Vec3Node, sinSigmaSqr: FloatNode, horizon: FloatNode,
  ): FloatNode;
  // 一様な環境光の拡散へ掛ける係数(= G)。
  public uniformFactor(sample: ShadingSample): FloatNode;
  // 鏡面のローブ(峰 lobe は view 空間の単位ベクトル)が遮られずに届く割合 0..1(GTSO)。
  public lobeFactor(sample: ShadingSample, lobe: Vec3Node, roughness: FloatNode): FloatNode;
  // 拡散の写しを読む向き(view 空間の単位ベクトル)と、見えている円錐の半角 β [rad]。
  public bentNormal(sample: ShadingSample): Vec3Node;
  public apertureAngle(sample: ShadingSample): FloatNode;
}

// planet-light-source.ts / ambient-source.ts
// 構築に occlusion: EnvironmentOcclusion を足し、次の口を持たせる。
// 描画設定「遮蔽と照り返し」がオフでないか。次回の material() 取得時から適用される。
public setOccluded(occluded: boolean): void;
```

走査の初期値(手順 5 で追い込む): 半径 R = 4 m、板の厚み T = 0.5 m、画面上の半径の上限は画面の
高さの 1/4、刻みの分布は 2 乗。**深度の縮小列(XeGTAO の 5 段)は最初は持たない** — 手順 5 で負荷が
キャッシュで頭打ちになっていると分かったときだけ足す。

**達成条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- `npm run render-lab:shot -- ss-off screenSpaceDiffuse=0` を before 2 組と
  `npm run render-lab:compare -- .render-lab-shots/ss-off .render-lab-shots/ss-before-1 .render-lab-shots/ss-before-2`
  で比べ、封筒外 0 件(達成目標 7)。
- `npm run render-lab:shot -- ss-ao screenSpaceDiffuse=1` を同じく比べ、達成目標 8 の範囲に収まる。
  その組の `bay-earthshine` で達成目標 1、`albedo` で 6。
- 対話の render-lab の開発者コンソールで `renderLab.setTarget('occlusion'); await renderLab.shoot('bay')`
  を撮り、達成目標 2 の 3 点を読む。
- `bay-truss` と `bay-edge` の差分画像で達成目標 9・10(この段階で外れたら手順 5 へ持ち越してよい。
  持ち越したことを commit の本文に書く)。
- デバッグ情報ウィンドウに「GPU 遮蔽と照り返し」の行が出て、設定をオフにすると 0 になる。
- commit: `feat(render): 天体照と環境光を近くの構造の塞がり方で弱める`

### 手順 4. 照り返しを足す

**目的** — 遮る面が太陽の直射と自己発光で返す光を集め、ライティングパスの光源の 1 つとして足す
(設定「遮蔽と照り返し」)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/lighting/sun-source.ts` L45–54 | 点光源としての放射照度(影込み)を `pointIrradiance` として切り出し、`pointContribution` もそれを使う(太陽の挙動は変えない) |
| `src/render/pipeline/screen-space/screen-space-pass.ts` | 構築に `sun: SunSource` を足す。照り返しのモードでは前処理を MRT にし、view 深度に加えて法線(rg16float)と放射輝度(rgba16float: `(1 − 金属度) × ベース色 / π × sun.pointIrradiance + 自己発光`)を書く。均しと拡大で照り返しも運び、`indirectTexture` を出す |
| `src/render/pipeline/screen-space/hemisphere-scan.ts` | 新たに塞がった扇形の割合 × 標本の放射輝度を積む(受け手に背を向けた標本は捨てる)。スライスの平均 × π で放射照度にする |
| `src/render/pipeline/lighting/indirect-source.ts`(新規) | 照り返しの光源。拡散 = `indirectTexture` の値、鏡面 = 0(金属の照り返しは後半の映り込みが担う)。`contributionMaterial` で包む |
| `src/render/pipeline/render-pipeline.ts` L128–137 / L201–249 / L330–351 | `IndirectSource` を光源の列の末尾へ、`rebuildForGraphics()` で有無を配る、デバッグ表示「照り返し」の合成材質(トーンマッピングを通す) |
| `src/render/graphics-settings.ts` | `screenSpaceDiffuse` へ `[2, '遮蔽と照り返し']` を足し、高プリセットを 2 にする |
| `src/render/pipeline/debug-target.ts` | `'indirect'`「照り返し」を「遮蔽」の後ろへ |

新しい API:

```ts
// sun-source.ts — 恒星を点として扱った放射照度(影込み)。拡散・鏡面の両方がこれへ BRDF を掛ける。
public pointIrradiance(sample: ShadingSample): Vec3Node;

// screen-space-pass.ts
public constructor(
  renderer: WebGPURenderer, gbuffer: GBufferPass, sun: SunSource, gpu: GpuTimings, mode: number, quality: number,
);
// 全解像度。rgb = 照り返しの放射照度(SUN_IRRADIANCE_1AU の目盛り)。照り返しを集めないフレームは読まれない。
public get indirectTexture(): THREE.Texture;

// hemisphere-scan.ts — scanHemisphere の末尾に足す引数。null なら照り返しを集めない。
source: SurfaceRadiance | null,
// 遮る面の読み口。前処理の半解像度のターゲットを読み、符号化の正本は screen-space-pass.ts が持つ。
export interface SurfaceRadiance {
  // 標本 uv に写っている面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)。
  radianceAt(uv: Vec2Node): Vec3Node;
  // 同じ面の法線(view 空間の単位ベクトル)。受け手に背を向けた標本を捨てるのに使う。
  normalAt(uv: Vec2Node): Vec3Node;
}

// indirect-source.ts
export class IndirectSource implements LightSource {
  public constructor(indirectTexture: THREE.Texture);
  // 描画設定「遮蔽と照り返し」が照り返しを集めるか。
  public setEnabled(enabled: boolean): void;
  public hasContribution(): boolean;
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial;
  public dispose(): void;
}
```

**達成条件と検証**

- `npm run typecheck` / `npm run test:render` / `npm run test:settings`。
- `npm run render-lab:shot -- ss-gi`(既定 = 高プリセット = 遮蔽と照り返し)を before 2 組と比べ、
  達成目標 8 の範囲に収まる。その組で達成目標 3(`bay-bounce`)・4(`bay`)・5(`bay-dark`、`ss-ao` の組と
  比べる)・6(`albedo`)。
- 手順 3 の `ss-off` の比較をこのコードで撮り直しても封筒外 0 件(達成目標 7)。
- commit: `feat(render): 明るい面と自己発光する面の照り返しを足す`

### 手順 5. 半径・厚み・精細さの段を追い込み、負荷を測る

**目的** — 手順 3・4 の初期値(R・T・画面上の半径の上限・刻みの分布・均しの回数・段の表)を、`bay` と
艦の撮影で追い込み、GPU の実測で段とプリセットを確定させる。見積りを実測で置き換える。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/screen-space/screen-space-pass.ts` / `hemisphere-scan.ts` | 定数と段の表 |
| `src/render/pipeline/screen-space/environment-occlusion.ts` | GTSO を 1 へ戻す粗さの範囲 |
| `src/render/graphics-settings.ts` | プリセット(負荷が収まらなければ中プリセットを「遮蔽・低」へ下げる) |
| この計画ファイル | 「見積り」を実測値へ置き換える |

追い込む順と、それぞれを決める撮影:

1. **T** — `bay-truss` で梁のまわりに暈が出ず(達成目標 9)、`bay` の `P_base` / `P_corner` が期待値に
   入る(立方体・壁のような厚い遮りの後ろへ光が漏れない)ところ。
2. **R** — `bay-bounce` の `P_base`(達成目標 3)と、`ship-selfshadow` の付け根の暗さ。R を変えると
   見え方が変わるので段ごとには変えない。
3. **段の表と均しの回数** — 低で blue noise の網目が静止画で目立たないこと、段を上げたとき濃淡が
   滑らかになることを `bay` で目視し、`node tools/render-lab-measure.mjs 3 screen-space` で達成目標 11 を
   読む。外れたら、走査の歩数 → 深度の縮小列(XeGTAO の 5 段、段 = `clamp(log2(標本までの画素数) − 3.3, 0, 5)`)
   の順に手を入れる。

**達成条件と検証**

- 達成目標 1〜11 をすべて、`npm run render-lab:shot -- ss-after` の組と before 2 組の比較で当て直す。
- 「見積り」の数字が実測値になっている(導出式は残す)。
- commit: `fix(render): 遮蔽と照り返しの半径・厚み・段を追い込む`

### 手順 6. 前後比較・点検・メモの更新をして main へ送る

**目的** — 前半を閉じる。狙っていない撮影が動いていないことを最終の組で確かめ、規約を当て、描画
パイプラインの要約を今の構成へ直して PR にする。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| 前半で触った `src/` のファイル | `/refactor` と `/comment-cleanup` を当てる |
| `memos/hedalu244/better_graphics/pipeline.md` | §2 のパスの表を 12 段にして行を足す、§2-7 の天体照の「遮蔽は受けない」を書き換える、§3 の render-lab のケースに `bay` を足す、§4 の穴の表の「AO / GI が無い」を「近くの物体が映らない」(引き取り先はこのファイル)へ、負荷の現況へ手順 5 の実測を足す |
| この計画ファイル | 手順 1〜6 と、前半にだけ掛かる達成目標・決めたことを消す |

**達成条件と検証**

- `npm run render-lab:compare -- .render-lab-shots/ss-after .render-lab-shots/ss-before-1 .render-lab-shots/ss-before-2`
  の封筒外が、達成目標 8 の範囲の撮影だけ。封筒外の撮影は差分画像を見て説明できる。
- `/send-pr` の手順(main の取り込み・全検証・PR 本文)を通る。

### 手順 7. 仕様を更新する(後半)

**目的** — 映り込みの見え方と設定・デバッグ表示を確定させる。`/modify-feature` で書き、`docs(spec):` の
単独 commit にする。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md` | 「目的」の後半の文面を、「描画パイプライン」(13 段)・「地球の描画」・「描画品質設定」・「デバッグ表示」(19 種類)・「デバッグ情報ウィンドウ」へ入れる |

**達成条件と検証**

- 後半の文面がそのまま入り、`git diff --stat` が `RENDERING.md` の 1 ファイルだけ。`12段階` / `18種類` が 0 件。
- commit: `docs(spec): 滑らかな面に近くの物体が映ることを足す`

### 手順 8. 映り込みの before を撮る

**目的** — `leo-metal` と `bay-metal` に、いま近くの物体が映っていないことを確かめ、比較の基準を撮る。
**コードは変えない。**

**達成条件と検証**

- `npm run render-lab:shot -- ssr-before-1` と `-- ssr-before-2`。`leo-metal` の金属・粗さ 0.05 の球に隣の
  球が映っていない、`bay-metal` の粗さ 0.05 の板に立方体と薬莢が映っていないことを画像で確かめる。

### 手順 9. 映り込みを追い、環境光の鏡面を映り込みで遮る

**目的** — 鏡の向きの当たり(D7 の追跡)を遮蔽と照り返しのパスの中で求め、天体照と環境光の鏡面へ
「当たりなら遮る」を掛ける。この時点では像は足さない(当たった所の天体照の像が消えるだけ)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/screen-space/reflection-trace.ts`(新規) | 鏡の向きの追跡(半解像度の view 深度の上、透視補正の刻み、一定の厚み、blue noise のずれ、外れの条件) |
| `src/render/pipeline/screen-space/screen-space-pass.ts` | 映り込みがオンなら追跡の描画命令を足し、`reflectionTexture`(当たりの uv・当たりの距離・重み w)を出す。遮蔽がオフでも追跡は走らせる |
| `src/render/pipeline/screen-space/environment-occlusion.ts` | `lobeFactor` を `mix(GTSO, 当たりなら 0・外れなら 1, w)` にする(映り込みがオフなら今のまま、遮蔽がオフなら GTSO の項を 1 とする) |
| `src/render/pipeline/lighting/planet-light-source.ts` / `ambient-source.ts` | マテリアルの鍵に映り込みの有無を足す |
| `src/render/pipeline/render-pipeline.ts` | 設定を配る |
| `src/render/graphics-settings.ts` | `screenSpaceSpecular`(真偽、低 / 中 / 高 = オフ / オフ / オン) |

```ts
// screen-space-pass.ts
public setReflection(enabled: boolean): void;
// 全解像度。rg = 当たった点の画面 uv、b = 当たりまでの view 空間の距離 [m]、a = 映り込みを信じる重み w
// (外れは 0)。符号化の正本は reflection-trace.ts。
public get reflectionTexture(): THREE.Texture;
```

**達成条件と検証**

- `npm run typecheck` / `npm run test:render` / `npm run test:settings`。
- 映り込みオンの `bay-metal` で、粗さ 0.05 の板の立方体が映るはずの領域から天体照の像が消えて暗くなり、
  粗さ 0.8 の板はオフと差が 3 以下。オフの組は `ssr-before-*` と封筒外 0 件。
- commit: `feat(render): 滑らかな面の映る向きを追い、近くの物体の陰で天体照の映り込みを弱める`

### 手順 10. 映り込みの像を足す

**目的** — 当たった点の色を、マテリアルパスの出力をぼかした縮小列から粗さぶんの段で引き、F0 を
掛けて足す(D7)。新しい段「映り込みパス」をマテリアルパスの後・大気パスの前に置く。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/reflection-pass.ts`(新規) | 共有ターゲットの写しを縮小列(ぼかし)つきで取り、`reflectionTexture` の当たりの uv から段を選んで引き、`F0 × 像 × w` を共有ターゲットへ加算で描く。`GPU_PASS.reflection` で計上 |
| `src/render/pipeline/render-pipeline.ts` L438–446 | マテリアルパスの後・大気パスの前に呼ぶ。デバッグ表示「映り込み」 |
| `src/render/gpu-timings.ts` | `reflection: 16` と表示名「映り込み」 |
| `src/render/pipeline/debug-target.ts` | `'reflection'`「映り込み」 |

写しの持ち主は、大気パスが持つマテリアルパス出力の写しと共有できるかを `/ownership` で確かめてから
決める(共有できれば写しを 2 度取らない)。

```ts
// reflection-pass.ts
export class ReflectionPass {
  public constructor(
    renderer: WebGPURenderer, gbuffer: GBufferPass, reflectionTexture: THREE.Texture,
    sharedTarget: THREE.RenderTarget, gpu: GpuTimings,
  );
  public setEnabled(enabled: boolean): void;
  // sharedTarget の絵に映り込みを足す。マテリアルパスの後、大気パスの前に呼ぶ。
  public render(width: number, height: number): void;
  public compile(width: number, height: number): Promise<void>;
  public dispose(): void;
}
```

**達成条件と検証**

- `npm run typecheck` / `npm run test:render`。
- `npm run render-lab:shot -- ssr-on` で達成目標 13・14。デバッグ表示「映り込み」で像だけが出る。
- commit: `feat(render): 滑らかな面に近くの物体の像を映す`

### 手順 11. 映り込みを追い込み、負荷を測り、main へ送る

**目的** — 粗さのフェード域・画面の縁と距離のフェード・追跡の歩数・厚みを追い込み、負荷を測り、後半を
閉じる。

**達成条件と検証**

- `npm run render-lab:compare -- .render-lab-shots/ssr-after .render-lab-shots/ssr-before-1 .render-lab-shots/ssr-before-2`
  で達成目標 16。
- `node tools/render-lab-measure.mjs 3 screen-space` に映り込みのオン/オフを足した巡りで達成目標 15。
- `memos/hedalu244/better_graphics/pipeline.md` の §2 を 13 段にし、§4 の「近くの物体が映らない」を消す。
  この計画ファイルを消す(残件があれば `lens_backlog.md` のような残件のファイルへ移す)。
- `/refactor`・`/comment-cleanup`・`/send-pr`。

---

## 見積り

**単価は XeGTAO の公開実測(Iris Xe = intel gen-12 の統合 GPU、1080p = 2.07 Mpx、全解像度、深度の縮小列と
均し 1 回込み)から取る。** render-lab の計測に使ってきた機械と同じ世代。

- 低(4 spp)1.07 ms、中(8 spp)≈ 1.6 ms、高(18 spp)2.39 ms → 標本 1 つあたりの増分 0.079〜0.13 ms/2.07 Mpx
  → **c = 0.05 ms / spp / Mpx**、固定費(縮小列・均し・出力)`1.07 − 4 × 0.1 ≈ 0.67 ms` → **f = 0.32 ms / Mpx**。
- 曲げた法線で走査が +25%(XeGTAO)。深度の縮小列を持たないぶん走査を ×1.5 と置く(手順 5 で実測に
  置き換える仮定)。照り返しは標本ごとに読むテクスチャが 1 → 3 枚(view 深度・法線・放射輝度)で走査 ×2.5。
- マテリアルパス(全画面 1 枚、6 読み)の render-lab 960×540 の実測 0.13〜0.17 ms → 1 読みあたり
  **0.048 ms / Mpx**(前処理の見積りに使う)。

render-lab 960×540(全解像度 0.52 Mpx、半解像度 0.13 Mpx)での GPU 時間:

| 段 | 導出 | 見積り | マテリアル行との比 |
| --- | --- | --- | --- |
| 遮蔽・低 | 走査 12 spp × c × 1.25 × 1.5 × 0.13 + 固定 f × 0.52 = 0.15 + 0.17 | 0.32 ms | 1.9〜2.5 |
| 遮蔽・中 | 24 spp → 0.29 + 0.17 | 0.46 ms | 2.7〜3.5 |
| 遮蔽・高 | 全解像度 36 spp × c × 1.25 × 1.5 × 0.52 + 0.17 = 1.76 + 0.17 | 1.9 ms | 11〜15 |
| 遮蔽と照り返し・中 | 走査 0.29 × 2.5 + 前処理 0.13 × 6 読み × 0.048 + 固定 0.17 × 1.5 = 0.73 + 0.04 + 0.26 | 1.0 ms | 6〜8 |

- **照り返しの突き合わせ**: 可視ビットマスクの論文の実測(半解像度・16 歩・半径 4・1080p で 1.07 ms、RTX
  2080)を、XeGTAO の RTX 2060 / Iris Xe の比 4.3 と 2080 / 2060 の比 1.3 で Iris Xe へ直すと 5.9 ms、
  960×540 で ÷4 = 1.5 ms、標本数 24/32 で 1.1 ms。上の 1.0 ms と合う。
- 達成目標 11 の上限(遮蔽・中 4.5 倍、照り返し・中 9 倍)は、この見積りの上端(3.5 倍・7.8 倍)に
  余裕を持たせた値。
- **ゲーム本体の 1080p**(解像度 100%)では画素数が 4 倍 → gen-12 で 遮蔽・中 1.8 ms / 照り返し・中 4.1 ms。
  描画の予算を置いている基準機(gen-12 のおよそ 5.4 倍速い)へ直すと 0.34 ms / 0.77 ms で、大気の予算
  1.5 ms・雲の増分の合格線 1.0 ms と釣り合う。
- **CPU**: 描画命令が前処理 1 + 走査 1 + 均し 2 + 拡大 1 + 照り返しの光源 1 = 6 本増える。レンズ段の実測
  (全画面 22 本で +1.59 ms)から 1 本 0.072 ms → **+0.43 ms**(遮蔽だけなら 5 本で +0.36 ms)。
- **GPU メモリ(1080p)**: 全解像度の可視率・照り返し rgba16float 2 枚 = 2 × 2.07 Mpx × 8 B = 33 MB、半解像度の
  view 深度 r32float 2 MB・法線 rg16float 2 MB・放射輝度 rgba16float 4 MB・走査と均しの往復 rgba16float
  2 組 × 2 枚 = 17 MB → **計 ≈ 58 MB**。
- **映り込み**: 追跡 半解像度 32 歩 × c × 1.5 × 0.13 = 0.31 ms、写しと縮小列(全解像度の 1.33 倍の書き込み ×
  4 読み × 0.048 × 0.52)≈ 0.13 ms、解決(全解像度 6 読み)0.15 ms → **0.6 ms(マテリアル行の約 4 倍)**。
  突き合わせ: McGuire & Mara の実測(1080p・25 歩で GeForce 650M 6.4 ms。Iris Xe は演算で約 3 倍、帯域で
  同程度)を、Iris Xe で 1〜2 倍速いとして半解像度・960×540 へ直すと ÷16 で 0.2〜0.4 ms と、追跡の
  0.31 ms を挟む。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 走査のループを展開してしまう、または和を左畳みで組む | 同じ絵で数倍遅い / WGSL のパーサが入れ子の上限に当たり、JS の例外なしにシェーダごと消える(コンソールに検証エラーだけ) | 手順 3・4(GPU の行、ブラウザのコンソール) |
| 深度テクスチャを補間つきで読む、半解像度の view 深度を 16 bit にする | 前者は検証エラーで画面ごと黒くなる。後者は遠い平らな面に自己遮蔽の縞が出る | 手順 3(`bay` を遠ざけた構図、デバッグ表示「遮蔽」) |
| オフの経路が今のシェーダと一致しない(マテリアルのキャッシュの鍵に遮蔽の有無が入っていない等) | オフでも絵が変わる / 設定を切り替えても古いマテリアルのまま | 手順 3・4・9(達成目標 7 の比較、設定パネルでの切り替え) |
| 遮蔽が太陽の寄与へ掛かる | 日向が二重に暗くなる | 手順 3(達成目標 6、`ship-selfshadow` の日向の面) |
| 半解像度からの拡大で縁を跨ぐ | 手前の遮蔽が奥(地球の円盤・虚空の手前の面)へ滲み、輪郭に暈が出る | 手順 3・5(達成目標 9) |
| 画面外の標本を端の値で読む | 画面の縁に沿った筋 | 手順 3(達成目標 10) |
| 画面上の半径による打ち切りが正射影(マップビュー)で効かない | 天体の縁・昼夜境界に暗い帯 | 手順 3(`earth*` の比較。マップビューは `npm run dev` で目視) |
| 扇形を角度で等分する(余弦重みでない) | V と照り返しの目盛りが系統的にずれ、較正が外れる | 手順 3・4(達成目標 2・3) |
| 厚み T が小さすぎる / 大きすぎる | 厚い区画の裏へ光が漏れる / 細い梁のまわりに暈 | 手順 5(達成目標 2 の `P_base`、9) |
| 照り返しの源に天体の画素が入る | 天体照の二重計上。地球を背にした艦の縁が明るく縁取られる | 手順 4(`leo-*` と `bay-truss` の比較) |
| 照り返しの光源を `setMRT` で描く | 加算合成が効かず、照度バッファの太陽ぶんを上書きする | 手順 4(`bay-bounce` の奥の壁が太陽の直射を失う) |
| 多重反射の持ち上げの当てはめ式を取り違える | 凹部の底が開けた面より明るくなる(白い凹部で開口が光源を向くときは起こりうるが、アルベドの低い面で起きたら式の誤り) | 手順 3(`bay-earthshine` の `P_in` ≤ `P_out`) |
| 円錐と球冠の重なりで、写した球面の地平線の下(光源の中心が地平線の下)を扱い損ねる | 昼夜境界の手前で天体照が段差で消える | 手順 3(`leo-metal-terminator` の比較) |
| 設定の値を振り直す | 保存された値が別の段として読まれる | 手順 3・4・9(値はオフ 0 / 遮蔽 1 / 遮蔽と照り返し 2 で固定) |
| render-lab の撮り直しの揺らぎを変化と読み違える | 封筒外の偽陽性 | 手順 2・6・8・11(before は 2 組、`render-lab:compare` で読む) |
| 天体照のマテリアルが「モデル × 遮蔽 × 映り込み」の数だけ増える | 設定の切り替えのたびにシェーダのコンパイルでフレームが止まる(光源モデルの切り替えと同じ性質) | 手順 3・9(設定パネルで切り替えて目視) |
| GPU の行が 1 つなので、前処理・走査・均しのどれが重いか分からない | 追い込みが当て推量になる | 手順 5(段ごとの差から走査の増分を、オフとの差から固定費を割り出す) |
| 映り込みの解決で、書き込み中の共有ターゲットを読む | WebGPU の検証エラーで画面ごと黒 | 手順 10 |
| 縮小列の段へ描く(`setRenderTarget` の段の指定)が three で効かない | 粗い面の像が鋭いまま | 手順 10(`bay-metal` の粗さ 0.4 の板) |
| 空(深度 0)への当たりを当たりとして扱う | 虚空が黒い像として映る | 手順 9(`leo-metal` の金属の球の上端) |
| 粗さのフェード域で、映り込みと GTSO の両方が効く | 中間の粗さで天体照の映り込みが二重に暗い | 手順 9・10(`bay-metal` の粗さ 0.4 の板) |
