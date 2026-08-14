# Dive into Tepui UI Design Reference 第五版

## 0. リファレンスの役割

本書は、Dive into Tepuiのタイポグラフィ、ロゴタイプ、記号、色、面、操作、HUD、物語画面、
ネットワーク表示、3D背景、モーションを定義するデザインの正本である。画面設計、実装、レビュー、
AIによる生成は、本書と対応する静的標本だけを参照して同じ美学へ到達できる。

対応する標本:
[Dive into Tepui UI Design Reference 05](ui-design-reference-v5.html)

デザイン言語は、古典的な文字の声、ニュートラルな計測表示、静かなガラス面、限定された意味色、
光沢のある抽象的な立体を一つの系として扱う。画面の大部分はモノトーンで保ち、色と運動は状態、
危険、物理軸、焦点だけへ割り当てる。

---

## 1. 基本原則

### 1.1 Monochrome field, semantic sparks

背景、通常面、本文、非選択状態は黒、白、灰色の系列で構成する。有彩色はブランド装飾ではなく、
次の意味を伝える信号として使う。

- 現在選択されている対象。
- 危険、損傷、限界値。
- Δvの物理軸。
- 第二ターゲット、計画軌道、味方拠点など同時識別が必要な対象。
- 一瞬だけ現れる弾薬、推進、熱、プラズマなどの世界内現象。

一画面に常時現れる強い有彩色の面積は5%以下を基準とする。色だけで意味を表さず、形、位置、記号、
文言のいずれかを必ず併用する。

### 1.2 Classic voice, machine measure

通常UIと物語の語りは、古典的で癖の小さいSansとSerifが担う。座標、ログ、診断、コマンド、
固定桁の計測だけをIBM Plex Monoへ切り替える。数字を含むだけでは機械書体へ変更しない。

- Classic voice: 章扉、タイトル、副題、静かな叙述、固有名。
- Neutral voice: 本文、操作名、メニュー、一般値、フランス語UI。
- Machine measure: ECI座標、Δv成分、時刻、通信遅延、ログ、CUI。

### 1.3 Glass without outlines

ウィンドウの境界は枠線で囲まず、背景との明度差、透明度、ぼかし、重なり、丸みで示す。Glass面は
情報を背景の運動から保護しながら、世界との連続性を残す。Solid面は長文、表、設定、結果画面で使う。

### 1.4 Plastic scene, flat instruments

タイトル背景には、プラスチックのような光沢を持つ多数の3D造形を置く。操作部はフラットに保ち、
影や疑似立体より、面色、短い変位、点灯、速度で状態を伝える。物質感は世界側へ、精度はUI側へ置く。

### 1.5 Fiction is system copy

世界観は長い説明だけで語らない。任務名、警告、資源名、時刻、通信遅延、軌道名、セーブ地点、
選択肢の文言そのものが設定を伝える。フレーバーテキストと実用情報は視覚階層を分け、数値の意味を
曖昧にしない。

### 1.6 Sentence case by default

通常の画面名、ボタン、タブ、ラベル、通知はsentence caseまたは自然な日本語で表示する。
全て大文字の文言は、端末、診断、警報電文、固定幅のCUI表示だけに限定する。固有の略語であるUI、
ECI、NRHO、LEO、L1、L2、RCS、Δvは通常文中でも維持する。

### 1.7 No stripes

走査線、横縞、反復線形グラデーション、帯状ノイズを装飾に使わない。情報の区切りには余白、面差、
点、単一のストローク、文字階層を使う。生成背景の粒子やボケは局所的で非周期にする。

---

## 2. コードベース対応表

### 2.1 Runtime font audit

ゲーム本体は`src/main.ts`からJetBrains Mono Latin 400とHackGenを読み込み、`src/game/theme.ts`の
`FONT_FAMILY`をHUD全域へ適用している。ラテン文字はJetBrains Mono、日本語はHackGen、最後に
OSの等幅書体へフォールバックする。現在の画面は一貫したCUIルックを持つ一方、物語、通常操作、
章扉まで同じ機械声になる。

デザイン書体ロールは、機械声を専門用途へ限定し、Neutral SansとEditorial Serifを通常の表示へ割り当てる。
ゲーム本体への適用単位は画面ではなくロールとし、CUIに属する既存の等幅表示を維持する。

### 2.2 Runtime HUD inventory

実装済みの主要パターンを次の系へ整理する。

| 系 | 現行実装 | 第五版での役割 |
| --- | --- | --- |
| 常設情報 | Vessel status、Orbit、Target、Contacts | Glassの小型パネル、短い行、右揃え数値 |
| 全体状態 | MET、時間加速、Node warp | 画面上辺の細いGlassバー |
| マップ | 軌道オブジェクト、座標系、予測時刻、縮尺 | レール、シェルフ、折りたたみ、物理軸 |
| 計画 | マニューバノード、Δv、Burn guide | 三軸意味色、ノード、残差、実行時刻 |
| 操作 | Button、Hold button、Toggle、Segment、Tab、Slider、Input、Meter | フラットな共通ウィジェット |
| 一時表示 | Context menu、Property window、Object picker、Toast | Glassポップアップと可動ウィンドウ |
| システム | Help、Pause、Result、Save browser、Stage select | Solidまたは強いGlassのモーダル |
| 基地 | Dock、艦一覧、部品、倉庫、ショップ | 高密度の表、カード、状態メーター |

### 2.3 Runtime semantic colors

`src/game/theme.ts`と`src/game/const.ts`、描画コードには次の有彩色がある。第五版ではこれらを
同時に強く見せず、対象の意味が現れた瞬間だけ彩度を戻す。

| Source token / 対象 | 現行HEX | 意味 |
| --- | --- | --- |
| Accent | `#FF6A00` | 選択、主要ターゲット、計画、注目 |
| Accent secondary | `#00C8FF` | 第二ターゲット |
| Danger | `#FF4F5E` | 危険、低装甲、警告 |
| Axis prograde | `#3B82F6` | Δvの進行・逆行軸 |
| Axis normal | `#10B981` | Δvの法線・反法線軸 |
| Axis radial | `#EF4444` | Δvの動径内外軸 |
| Planned marker | `#8FD0FF` | 計画位置、予測軌道 |
| Target direction | `#FF7AB0` | ターゲット方向 |
| Ally marker | `#00FFFF` | 味方識別 |
| Base orbit | `#4F8F7D` | 味方拠点の軌道 |
| Ammo beacon | `#4DE8FF` | 弾薬補給物 |
| Engine core / outer | `#AEE6FF` / `#4F9FFF` | 推進噴射 |
| Thermal / destruction | `#FFB36B` / `#FFFBE8` | 熱、発光、破壊 |
| Enemy identity variants | `#FF4A3D` / `#3DC6FF` / `#3DFF8F` / `#FFE23D` / `#BF3DFF` | 集団・個体の一時識別 |

天体表面や船体材料の色は世界内材料であり、UIトークンとは分離する。

---

## 3. 書体システム

### 3.1 採用書体

すべて組み込み可能なSIL Open Font License 1.1の書体を使う。本番ではWOFF2とライセンス本文、
著作権表示を同梱し、自己配信する。

| ロール | ラテン・数字 | 日本語・追加文字 | ウェイト | 用途 |
| --- | --- | --- | --- | --- |
| Neutral Sans | Arimo | Zen Kaku Gothic Antique | 400 / 500 / 600 / 700 | 通常UI、本文、主要タイトル、フランス語 |
| Editorial Serif | Cormorant Garamond | Zen Old Mincho | 300 / 400 / 500 / 700 | 副題、章扉、叙述、引用 |
| Machine Mono | IBM Plex Mono | Zen Kaku Gothic Antique fallback | 400 / 500 / 600 | CUI、座標、ログ、固定桁 |
| Cantonese Display | — | Noto Serif HK | 900 | 広東語の章扉と背景文字 |
| Cuneiform Display | — | Noto Sans Cuneiform | 400 | 索引、装飾列、古層の記号 |
| Symbol / Braille | Arimo fallback | Noto Sans Symbols 2 | 400 | 点字、記号、数学補助 |

Helveticaそのものは組み込み条件を満たさないため、主SansにはArimoを使う。Helvetica系の
ニュートラルなシルエットを方向性とし、丸みを強調した新しいUI書体の印象は避ける。

### 3.2 CSSファミリー

```css
--font-neutral:
  "Arimo", "Zen Kaku Gothic Antique",
  "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;

--font-editorial:
  "Cormorant Garamond", "Zen Old Mincho",
  "Hiragino Mincho ProN", "Yu Mincho", serif;

--font-machine:
  "IBM Plex Mono", "Zen Kaku Gothic Antique",
  "Hiragino Kaku Gothic ProN", "Yu Gothic", monospace;

--font-cantonese:
  "Noto Serif HK", "Source Han Serif HC", serif;
```

### 3.3 サイズと文脈

| 表示級 | サイズ | 標準書体 | 代替する文脈 | 行高 |
| --- | --- | --- | --- | --- |
| Title XL | `clamp(68px, 13vw, 184px)` | Neutral Sans 400 | 古典章扉はEditorial 300 | 0.76–0.88 |
| Title L | `clamp(38px, 7vw, 92px)` | Neutral Sans 400 | 広東語はCantonese 900 | 0.9–1.0 |
| Subtitle | `clamp(24px, 3.4vw, 48px)` | Editorial 300 / 400 | 技術副題はMachine 400 | 1.0–1.15 |
| Window | 14–16px | Neutral Sans 500 / 600 | Console窓だけMachine 500 | 1.25–1.35 |
| Body | 14–16px | Neutral Sans 400 | 物語の短い引用はEditorial 400 | 1.55–1.7 |
| Auxiliary | 11–13px | Neutral Sans 400 | 推定値コメントはMachine italic | 1.5–1.65 |
| Label | 10–12px | Neutral Sans 500 / 600 | 固定列・キーはMachine 500 | 1.25–1.4 |
| Console | 12–14px | Machine 400 | — | 1.45–1.6 |

### 3.4 文字種による選択

- ラテンアルファベット: Arimoを標準とし、物語の章扉、副題、固有名にCormorant Garamondを使う。
- 数字: 一般値はArimoのtabular figures、固定桁の座標とログはIBM Plex Monoを使う。
- 漢字・かな: Zen Kaku Gothic Antiqueを標準とし、章扉と静かな説明にZen Old Minchoを使う。
- 広東語: Noto Serif HK 900を大きく使い、通常UIの小サイズには使わない。
- フランス語: Arimoでニュートラルに表示し、アクセント、合字、句読点を正しく保持する。
- 楔形文字と点字: 意味が保証できない列は装飾としてラベル付けし、読み上げ用説明を添える。

### 3.5 Classic voice, machine measureの比較

同じ内容を三つの声で比較して採用文脈を判断する。

| Voice | 標本 | 採用文脈 |
| --- | --- | --- |
| Neutral | Séquence orbitale — 420 km / 7.67 km·s⁻¹ | 通常UI、本文、数値説明 |
| Classic | La Terre n’est pas morte. Elle attend sous la glace. | 章扉、副題、静かな叙述 |
| Machine | `ECI R = +6.778e6 m · NODE T−00:42:18` | CUI、ログ、座標、診断 |

### 3.6 補助説明、太字、斜体

- 補助説明は本文より2–3px小さく、明度を一段落とし、行高を広めにする。
- Neutral Sans 600は操作名、選択中の行、重要な短語へ使う。長文全体を太字にしない。
- Editorial Serif italicは引用、章扉の一語、記憶、人物の声へ使う。
- IBM Plex Mono italicは推定、補間、未確定、コメントへ使う。
- 警告は太字だけに依存せず、記号、文言、位置、Danger色を組み合わせる。

### 3.7 フランス語の例

```text
Séquence orbitale
Réglage fin
Vitesse angulaire
Énergie disponible
Fenêtre d’éclipse
Mémoire cristalline
Trajectoire prévue
Retour à la Terre
```

UIには`lang="fr"`を付ける。`é`、`à`、`ç`、`œ`、`â ê î ô û`を代用文字へ置換しない。

---

## 4. ロゴタイプと記号

### 4.1 タイトルの組み方

タイトルはNeutral Sansの大きな文字を主役にし、行頭位置と改行位置を変えて一つのシルエットを作る。
大文字ロゴを使えるのはタイトル固有名とCUIであり、通常のUI見出しには展開しない。

```text
Dive into
      Tepui
```

副題は細いEditorial Serifで重ねる。添字、上付き、軌道記号、装飾記号は主字形の20–35%で置き、
読ませるタイトルと装飾層を分ける。

### 4.2 アスタリスク族と星形

次の字形を章番号、焦点、注釈、接続点へ使う。

```text
*  ⁕  ⁎  ∗  ✱  ✳  ✻  ✼  ✽
六芒星  ✡ / geometric hexagram
七芒星  custom heptagram
八芒星  ✴ / geometric octagram
```

- `*`は一般注記、`⁕`と`⁎`は小見出し、`∗`は演算子へ使う。
- 六芒星、七芒星、八芒星は幾何学SVGとして用途ごとに設計する。
- `✡`には宗教的意味があるため、文化的意味を意図する場合に限る。中立な接続記号には独自の六芒星を使う。
- 星形は同じ画面で一種類を基本とし、頂点数を状態コードとして混在させる場合は凡例を付ける。

### 4.3 アクセント記号と音楽記号

フランス語のアキュートとアクサン・シルコンフレックスを、正書法と装飾の両方へ使う。

```text
é É · â ê î ô û · ◌́ · ◌̂
accent > · marcato ^ · tenuto — · staccato •
```

音楽のアクセント、マルカート、テヌート、スタッカートは、操作応答の強さや時間特性を説明する
補助記号として使える。実用UIでは名称を併記し、記号だけで状態を伝えない。

### 4.4 科学記法

数値と単位の間には改行しない空白を置き、更新値はtabular figuresで揃える。意味のある添字と指数には
HTMLの`sub`と`sup`を使う。

```text
Δvₚ = +12.48 m·s⁻¹
q = 31.2 kPa
Tₕᵤₗₗ = 1.42×10³ K
ρ(h) = ρ₀ exp[−(h−h₀)/H]
H = p²/2m + V(q)
δS = 0
dU = T dS − p dV + Σ μᵢ dNᵢ
Fe₂O₃ + 2 Al → Al₂O₃ + 2 Fe
CH₄ + 2 O₂ → CO₂ + 2 H₂O
A ⊂ B · x ∈ ℝ³ · f: X → Y
```

有機化学の構造式は、原子ラベル、結合角、二重結合、添字を持つ単純な線図へ再構成する。実測値と
装飾式を混同しないよう、装飾にはMotif、Plate、Indexなどの役割名を添える。

### 4.5 異形感のあるアイコン

アイコンはニュートラルなゴシック体と並べても崩れない輪郭を保ち、内部に科学記法の小さな異物を置く。

- 基本骨格は円、直線、120°の結合角、孤立点、短い弧で作る。
- 一つのアイコンに主輪郭、補助ストローク、添字または上付きの三層までを許可する。
- 分子図の結合、軌道の接線、場のベクトル、ノードのポートを形態語彙にする。
- 24pxでは1.5px、32px以上では2pxを基準にし、線端と線結合を丸める。
- 太い塗りつぶしと細線を同時に増やさず、縮小時に一つの美しいシルエットへ収束させる。
- 汎用アイコンの意味を壊さない。閉じる、再生、戻るなどは見慣れた主輪郭を残す。

---

## 5. カラーシステム

### 5.1 基本面

| Token | Dark | Light | 役割 |
| --- | --- | --- | --- |
| Background | `#090A0C` | `#F2F1ED` | ページ、3D場面 |
| Surface | `#15171A` | `#FFFFFF` | Solid面 |
| Glass | `rgba(22, 24, 28, .66)` | `rgba(255, 255, 255, .68)` | 浮遊ウィンドウ |
| Text strong | `#F7F6F2` | `#141516` | タイトル、重要値 |
| Text | `#E4E2DE` | `#292B2E` | 本文、一般値 |
| Text muted | `#A6A5A2` | `#6B6D70` | 補助説明、非選択 |
| Hairline | `rgba(247, 246, 242, .14)` | `rgba(20, 21, 22, .12)` | 必要な単線、区切り |

### 5.2 Accent

ブランドAccentの基準は赤へわずかに寄ったオレンジ`#FF5A24`とする。現行ゲームの`#FF6A00`を
Source値として併記し、実装時はPalette Labで比較する。Accentは選択、現在位置、主要な一操作、
短い副題だけへ使う。通常本文、全カード、全ボタンをAccentで塗らない。

### 5.3 意味色の彩度予算

現行HEXは識別の正本として保存し、UI表示ではChroma budgetを掛ける。既定値は34%とする。

```text
Sdisplay = Ssource × chromaBudget
```

危険の臨界状態、選択直後、着弾、点火など短いイベントでは100%へ近づけてよい。通常状態では
明度差と形を主にし、色相差は補助にする。

### 5.4 色コードの読み方

- HEX `#RRGGBB`: 赤、緑、青を00–FFの16進数で記述する。`#FF5A24`はR=255、G=90、B=36。
- RGB `rgb(255 90 36)`: 各チャンネルを0–255で記述する。計算や外部ツールとの交換に向く。
- HSL `hsl(14 100% 57%)`: 色相0–360°、彩度0–100%、明度0–100%。人が色味を調整しやすい。
- Alpha `rgb(22 24 28 / 66%)`: 透明度を0–100%で加える。Glassの透過に使う。
- Semantic token: `--color-danger`のように意味で命名する。画面コードへHEXを直接散在させない。
- Source HEX: 現行ゲームで識別に使う正本。Preview HEX: Chroma budgetとテーマ変換後の表示値。

Palette Labは各トークンのHue、Saturation、Lightness、Chroma budgetを操作でき、Source HEX、
Preview HEX、RGB、HSL、CSS custom propertyを同時表示する。全色相を編集でき、結果をコピーして
後からハードコードできる。

### 5.5 反対色タイトル

タイトルと副題は背景の代表色からReadable oppositeを導出する。

```text
Hopp = (Hbg + 180°) mod 360°
Sopp = min(36%, Sbg × 0.55)
Lopp = 94%  if Lbg < 50%
       9%   if Lbg ≥ 50%
```

補色色相を使いながら彩度を抑え、本文に近い可読明度を優先する。写真や3D背景では、文字の背後を
局所的にぼかすGlass veilを併用する。

---

## 6. 面、余白、レイアウト

### 6.1 角丸と密度

| Role | Radius | Padding | Gap |
| --- | --- | --- | --- |
| Micro control | 8px | 5–8px | 4px |
| Button / input | 12px | 7–12px | 6px |
| HUD panel | 18px | 10–14px | 8px |
| Window | 24px | 14–18px | 10px |
| Hero glass | 32px | 18–28px | 12px |

全体は高密度に保つ。大きな角丸は広い余白を意味しない。パネル内の情報は整列し、セクション間だけに
余白の段差を作る。

### 6.2 Glass面

Glass面は次を組み合わせる。

```css
background: rgb(20 22 26 / 62%);
backdrop-filter: blur(20px) saturate(80%);
border: 0;
border-radius: 24px;
box-shadow: 0 14px 46px rgb(0 0 0 / 18%);
```

- Glass quiet: 常設HUD。ぼかし12–18px、透明度55–70%、影は極弱。
- Glass focus: プロパティ、ノード編集。ぼかし20–28px、透明度68–82%。
- Glass modal: 物語選択、確認。ぼかし28–36px、背後にScrimを追加する。
- Glass label: マーカー名、単位、短い値。小さなピル面で文字だけを保護する。

枠線は通常使わない。区切りが必要な表やグラフでは、Hairlineを内部に一度だけ使える。

### 6.3 Light mode

ライトモードは白い紙ではなく、わずかに暖かい灰白色を背景にする。Glassは白68%、本文は黒に近い
中立色、影は短く薄くする。Accentと意味色はDarkより明度を下げ、白背景上で輪郭が消えないようにする。
色の役割、階層、レイアウトはDarkと一致させる。

### 6.4 レスポンシブ

- Wide: 左右レール、下部シェルフ、中央の世界表示を同時に使う。
- Medium: レール幅を縮め、常設パネルを水平方向のシェルフへ移す。
- Compact: 一覧とプロパティをボトムシートへ変え、中央照準と主要状態を優先する。
- Coarse pointer: 見た目を膨らませすぎず、透明な余白を含め44px以上のヒット領域を確保する。

---

## 7. タイトル背景の3D

タイトル背景には、一つの巨大物ではなく、多数の幾何学的な文字片、枝、結節、リング、カプセル、
板、ビーズを奥行き方向へ分布させる。

### 7.1 造形語彙

- T、Y、K、Asteriskを連想する分岐したカプセル。
- 120°の結合角を持つ分子模型状の枝。
- 開いた文字カウンターのようなトーラス片。
- 添字のように親形状へ付く小球と短い棒。
- 六芒、七芒、八芒の頂点構造を立体化した節点。
- 文字として完全には読めず、遠目では一つの静かな群れに見える形。

### 7.2 材質と色

材質はGlossy plasticとし、`roughness 0.16–0.28`、`metalness 0–0.06`、`clearcoat 0.7–1.0`を
基準にする。大半は乳白、煙色、黒、薄い暖灰色で構成し、Accentまたは意味色を持つ物体は群れ全体の
5%以下にする。強い鏡面反射は形の縁を示すために使い、背景を騒がせない。

### 7.3 動き

- 個体ごとに異なる極小速度で漂わせる。
- 回転周期は24–90秒、移動周期は18–60秒を基準とする。
- カメラは呼吸する程度に移動し、入力への追従は小さく遅らせる。
- 物体は画面端で急に反転せず、視野外で循環させる。
- `prefers-reduced-motion`では移動を止め、初期配置だけを表示する。
- WebGL / WebGPUが使えない場合は、CSSの非周期なぼけ形状へフォールバックする。

タイトル文字の背後には透明なVeilを置き、3Dのハイライトが文字へ直接重ならないようにする。

---

## 8. Plastic tactility, digital precision

この項目の操作部は視覚的にフラットにする。電子楽器の精密さは、彫りの深い疑似3Dではなく、
短い応答、明確なノブ位置、均一な寸法、点灯、数値同期で表す。

### 8.1 状態

- Rest: 中立面。枠線なし。文字はText muted。
- Hover: 面の明度を一段上げ、文字をTextへ移す。
- Pressed: 1px沈め、面を一段暗くする。長い影を付けない。
- On / selected: Accentまたは意味色の薄膜を敷き、点または短線を追加する。
- Disabled: 彩度を0へ寄せ、opacity 35–45%、カーソルとaria-disabledを同期する。
- Focus visible: 2pxの外側リング。マウスクリックでは不要に残さない。

### 8.2 操作部

- Button: 角丸12px、最小高32px、主操作だけAccent薄膜。
- Toggle: 34×18pxを基準にし、状態をノブ位置と点灯の両方で示す。
- Lever: 連続値ではなく3–5段階の離散値へ使う。
- Knob: 円周位置、数値、単位を同時表示する。ドラッグと矢印キーを提供する。
- Slider: トラックは単色、充填部は中立色。焦点値だけ意味色を許可する。
- Meter: 通常は灰色。注意域で意味色、臨界域でDangerへ移る。
- Hold button: 押下中だけ継続する動作を表し、離した瞬間に必ず解除する。

---

## 9. Dive into Tepui UIパターン

### 9.1 常設HUD

#### Global status

MET、時間倍率、Node warp、Pauseを細いGlassバーへ置く。値はMachine、説明はNeutralを使う。

```text
MET 003:18:42 · 時間加速 ×4 · Node warp T−00:42:18
```

#### Vessel status

RCS制動、並進出力、微調整、進行方向ホールド、視点追従、弾薬、HP、温度、電力を短い行で表示する。
一般ラベルは日本語またはsentence case、内部の固定値だけMachineにする。

#### Orbit

基準天体、高度、速度、遠地点、近地点、傾斜角、周期、動圧、機体温度を表示する。単位を省略せず、
危険値は色だけでなく`高温`、`動圧限界`などの文言を追加する。

#### Target and contacts

Targetは距離、接近速度、相対速度、装甲を表示する。Contactsは距離順で集約し、第一ターゲット、
第二ターゲット、波、味方を形と意味色で区別する。

### 9.2 マップと計画

- Object list: 検索、カテゴリ、距離順、階層、フォーカス、折りたたみ。
- View: 注視対象、カメラ座標系、軌道描画座標系、視点リセット。
- Predict: 予測期間、任意時刻、ゴースト位置、絶対時刻と経過時刻。
- Maneuver plan: 複数ノード、実行時刻、三軸Δv、残差、Burn guide、削除、Auto warp。
- Map scale: 単位付きの単線ルーラー。
- Markers: Boresight、Prograde、Retrograde、Normal、Antinormal、Radial、Node、Burn、Ammo、Lead。

### 9.3 ウィンドウと一時表示

- Property window: 可動Glass、タイトル、ピン留め、改名、主要値、折りたたみ詳細、操作。
- Context menu: 対象名、補足、操作、ショートカット。画面端へ収める。
- Object picker: 選択値、検索、グループ見出し、空状態。
- Toast: 一行の結果。短時間で消え、操作を奪わない。
- Modal: Help、Pause、Result、Save browser。Scrimと強いGlassを使う。

### 9.4 保存と基地

- Save browser: セーブスロット、クリップ済みスナップショット、自動履歴、時刻、中心天体、艦、敵残数。
- Dock: 格納艦、発進、詳細、搭載部品、倉庫、修理、換装、燃料、ショップ、所持金。
- Stage select: ステージ名、短い説明、解放状態、キー。タイトル固有名以外はsentence caseにする。
- Result: 結果、原因、記録、再出撃、タイトルへ戻る。勝敗だけを大文字CUIへしない。

---

## 10. 物語世界に基づくUI用例

### 10.1 章扉

```text
公暦20115年
地球は最も深いダンジョンになった。

La Terre n’est pas morte.
Elle refuse seulement notre retour.
```

章扉はNeutral Sansの大見出しとEditorial Serifの副題を組み、日付、軌道、地点はMachineの小行へ置く。

### 10.2 オープニング任務

```text
任務: アオテアロア近地点
減速ステージへドッキングし、上層大気を掠めて近地点速度を落とす。

高度 162 km · q = 18.6 kPa · Tₕᵤₗₗ = 1,284 K
次の事象: Tepui遊弋種の捕捉  T−00:03:42
```

### 10.3 執政官結晶

```text
執政官結晶 · Site 03
推論用紫外光 72% · 保存可能 · 通信窓 00:18:12

La mémoire demeure, même lorsque le vaisseau disparaît.
```

セーブ画面は「ロード」だけでなく、結晶の光量、通信窓、保存された人物と船団の状態を見せる。

### 10.4 NRHOの周期脅威

```text
地球側接近まで 02日 14:08:31
遊弋種遭遇率 18% → 43%
防衛砲座 5/6 · ラジエーター 82% · 窒素備蓄 14.2 t
```

周期的脅威をクエスト文ではなく、軌道と資源の状態として提示する。

### 10.5 L1農場と化学プラント

```text
L1 Heliostat Farm 07
光子束 Φγ = 1.31 kW·m⁻²
NH₃  8.4 t · CH₄  2.1 t · N₂  14.2 t · H₂O  31.8 t
次の停止要因: 窒素不足 18時間後
```

### 10.6 L2と有限光速

```text
L2 Magnetotail Array
命令送信 14:22:08 · 到達予測 14:22:11 · 不確かさ ±0.8 s

Jupiter convoy 04
命令予約 6件 · 片道遅延 00:41:16 · 現地時刻との差 +00:41:16
```

### 10.7 低軌道環境

```text
オーロラ帯へ進入
光学照準の信頼度 64% · 誘導兵器 使用不可 · 実体弾 使用可能

蝕まで 00:07:18
電池 62% · 推定持続 00:18:43 · ラジエーター収納を推奨
```

### 10.8 Tepui攻囲

```text
Tepui 12 · Palace remnant
周回高度 318 km · 防衛節点 7 · 光学干渉 28%
目的: ロトベーター接続点を確保する

帰ってきた子らの匂いを、番犬はもう覚えていない。
```

### 10.9 資源循環

敵から得た窒素と硫黄は、火薬、肥料、ヒドラジン、樹脂の同じ循環へ流れる。資源UIは産地、在庫、
用途、競合、次の停止要因を一つのグラフで示す。

```text
遊弋種 → N / S / P → 肥料 → 農場 → 人口 → 操縦士
                  ↘ 火薬 → 防衛 → 遊弋種
```

---

## 11. ネットワークグラフとノードエディタ

### 11.1 戦略ネットワーク

ノードは拠点、船団、資源源、Tepui、結晶サイト、輸送窓を表す。エッジは物資、電力、命令、軌道遷移、
脅威のいずれかである。

- ノードの面はGlass、選択時だけ意味色の薄膜を使う。
- エッジは通常灰色、選択した経路だけMeaning colorへ移す。
- エッジの粒子アニメーションは流量を示す場合だけ使い、装飾として常時流さない。
- 距離と通信遅延を同一線上へ表示しない。物理距離、輸送時間、情報遅延を別の値として示す。
- 混雑、切断、未確定を色だけでなく線種、記号、文言で区別する。

### 11.2 結合グラフ式造船

船体は固定グリッドではなく、原子価と結合角を持つ部品ノードの関係から作る。

- Port: 構造、推進剤、電力、冷却、弾薬、データ。
- Valence: 接続可能数。
- Bond angle: 60°、90°、109.5°、120°、180°などの許容角。
- Constraint: 質量中心、推力軸、熱経路、弾薬経路、ドッキング規格。
- Feedback: 有効接続、未接続、過負荷、循環、競合を即時に示す。

ノードはドラッグでき、選択すると右側のGlass inspectorに質量、強度、温度、電力、ポート、接続制約が
現れる。追加、接続、切断はUndo可能にし、破壊的操作には確認または回復経路を持たせる。

---

## 12. モーション、音、アクセシビリティ

### 12.1 モーション

- Hover / press: 120–160ms。
- Toggle / meter: 160–260ms。
- Glass window open: 220–360ms、4–10pxの短い移動。
- Story transition: 600–1200ms。
- 3D drift: 18–90秒。

位置変化は`transform`、透明度は`opacity`を基本とする。情報更新のたびにパネル全体を揺らさない。

### 12.2 音

クリックは短い乾いたパルス、Toggleは二値の音程差、Holdは開始と解除、危険は反復間隔の変化で伝える。
音楽記号のaccent、marcato、tenuto、staccatoをモーションと音の共通語彙として文書化する。

### 12.3 アクセシビリティ

- 本文は通常4.5:1以上、大文字級は3:1以上を基準とする。
- キーボードフォーカスを表示し、Tab順を視覚順と一致させる。
- 色だけで状態を示さない。
- Glass面で文字が背景へ溶ける場合は透明度を自動的に上げる。
- 点字、楔形文字、装飾SVGには読み上げ用ラベルを付ける。
- Canvas / Three.jsの重要情報はDOMでも提供する。
- `prefers-reduced-motion`と`prefers-contrast`に対応する。

---

## 13. 実装トークン

```css
:root {
  --color-bg: #090a0c;
  --color-surface: #15171a;
  --color-glass: rgb(22 24 28 / 66%);
  --color-text-strong: #f7f6f2;
  --color-text: #e4e2de;
  --color-text-muted: #a6a5a2;
  --color-accent: #ff5a24;
  --color-danger-source: #ff4f5e;
  --color-info-source: #00c8ff;
  --color-axis-prograde-source: #3b82f6;
  --color-axis-normal-source: #10b981;
  --color-axis-radial-source: #ef4444;
  --chroma-budget: 0.34;

  --radius-control: 12px;
  --radius-panel: 18px;
  --radius-window: 24px;
  --radius-hero: 32px;

  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-5: 12px;
  --space-6: 16px;
  --space-7: 24px;
}
```

HTML標本のPalette Labは、調整結果をSource HEXと区別したPreview HEXとして表示する。採用値を
ハードコードするときは、意味名を保ったままプロジェクトの唯一のトークン定義へ移す。

---

## 14. レビュー用チェックリスト

- [ ] 画面の大部分がモノトーンで、有彩色は意味を持つ箇所だけに現れる。
- [ ] Accentの常時面積が5%以下である。
- [ ] 通常UIがNeutral Sans、章扉がEditorial Serif、CUIがIBM Plex Monoに分かれている。
- [ ] 全て大文字の文言がCUI、警報電文、固有ロゴに限定されている。
- [ ] 日本語が古典寄りのニュートラルなゴシック体または明朝体で表示されている。
- [ ] 補助説明、太字、斜体の役割が本文と区別されている。
- [ ] フランス語のアクセントと合字が保持されている。
- [ ] アスタリスク族、星形、科学記法が意味または明示した装飾役割を持つ。
- [ ] ウィンドウの境界が枠線ではなく、面差、ぼかし、重なり、丸みで示されている。
- [ ] 縞模様と反復走査線がない。
- [ ] 操作部がフラットで、Hover、Pressed、On、Disabled、Focusを確認できる。
- [ ] Light modeがDarkと同じ情報階層を保つ。
- [ ] Runtime HUDの常設、マップ、計画、ウィンドウ、保存、基地パターンを参照できる。
- [ ] 現行コードの非オレンジ意味色をPalette Labで編集できる。
- [ ] HEX、RGB、HSL、Alpha、Source / Previewの説明と値が表示される。
- [ ] ネットワークグラフと結合グラフ式ノードエディタの例がある。
- [ ] 3D背景に多数の光沢プラスチック造形がゆっくり漂う。
- [ ] 3D運動は本文の可読性を損なわず、Reduced motionへ対応する。
- [ ] 世界観の用例が実用値と明確に分離されている。
- [ ] 色、記号、Canvasだけに依存せず、DOMと文言で同じ意味へ到達できる。

---

## 15. 書体配布元

- [Arimo](https://github.com/googlefonts/Arimo)
- [Zen Kaku Gothic Antique](https://github.com/googlefonts/zen-kakugothic)
- [Cormorant](https://github.com/CatharsisFonts/Cormorant)
- [Zen Old Mincho](https://github.com/googlefonts/zen-oldmincho)
- [IBM Plex](https://github.com/IBM/plex)
- [Noto Serif CJK](https://github.com/notofonts/noto-cjk/tree/main/Serif)
- [Noto Cuneiform](https://github.com/notofonts/cuneiform)
- [Noto Symbols](https://github.com/notofonts/symbols)
