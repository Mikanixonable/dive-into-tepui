# Dive into Tepui UI Design Reference 第四版

## 0. リファレンスの役割

本書は、Dive into Tepuiの文字、色、面、操作物、3D背景、記号、モーションを定義するデザインの正本である。
画面設計、実装、レビュー、AIによる生成は、本書と対応する静的標本だけを参照して同じ美学へ到達できる。

対応する標本:
[Dive into Tepui UI Design Reference 04](ui-design-reference-v4.html)

デザイン言語は、古典的な文字の気配、ニュートラルな情報設計、理論科学の記法、電子楽器の物質感、
生成的な3D空間を一つの静かなシステムへ統合する。

---

## 1. 基本原則

### 1.1 Scientific poise

科学記法は装飾と実用の両方を担う。単位、添字、上付き文字、演算子、集合、場、軌道、分子構造を
正しい形で組み、情報が実在するときは意味を保つ。意味を持たない表示用の組み合わせには
MOTIF、INDEX、PLATEなどの役割名を与え、実測値と明確に分離する。

### 1.2 Neutral core, anomalous edge

本文、数値、操作名はニュートラルなゴシック体と等幅体で安定させる。ロゴ、記号、章扉は、
楔形文字、点字、数式、構造式、分解されたストロークを局所的に重ね、静かな異形感を作る。

### 1.3 Material controls

トグル、レバー、ノブ、パッドは、電子楽器とシーケンサーを思わせるプラスチックの立体感を持つ。
形状は単純で、光沢、エッジの丸み、押下量、影、LEDの点灯が状態を伝える。物質感は操作可能性を
明確にするために使う。

### 1.4 Scene first, interface legible

タイトル、章扉、選択画面ではトゥーン3Dと大きな文字が一つの場面を作る。設定、HUD、表、Consoleは
不透明面またはGlass面へ収め、背景の動きから読み取りを保護する。

### 1.5 Full-spectrum control

配色トークンは0〜360°の全色相を編集できる。各変更は即時に画面へ反映され、HEX、RGB、HSLを常時表示する。
背景色から反対色を導出し、文字、3Dアウトライン、焦点表示へ利用する。

---

## 2. 書体

### 2.1 書体セット

| 役割 | ラテン・数字 | 日本語 | 追加文字体系 | ウェイト | ライセンス |
| --- | --- | --- | --- | --- | --- |
| Neutral Sans | Arimo | Zen Kaku Gothic Antique | フランス語 | 400 / 500 / 600 / 700 | SIL OFL 1.1 |
| Editorial Serif | Cormorant Garamond | Zen Old Mincho | — | 300 / 400 / 500 | SIL OFL 1.1 |
| Console Mono | IBM Plex Mono | Zen Kaku Gothic Antique fallback | 科学式、座標、CUI | 400 / 500 / 600 | SIL OFL 1.1 |
| Cantonese Display | — | — | Noto Serif HK | 900 | SIL OFL 1.1 |
| Cuneiform Display | — | — | Noto Sans Cuneiform | 400 | SIL OFL 1.1 |
| Braille Pattern | Arimo fallback | — | Noto Sans Symbols 2 | 400 | SIL OFL 1.1 |
| Symbol | 独自SVG | 独自SVG | 数式・構造式モチーフ | 1.5 / 2px stroke | プロジェクト資産 |

### 2.2 CSSファミリー

~~~css
--font-neutral:
  "Arimo", "Zen Kaku Gothic Antique",
  "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;

--font-editorial:
  "Cormorant Garamond", "Zen Old Mincho",
  "Hiragino Mincho ProN", "Yu Mincho", serif;

--font-console:
  "IBM Plex Mono", "Zen Kaku Gothic Antique",
  "Hiragino Kaku Gothic ProN", "Yu Gothic", monospace;

--font-cantonese:
  "Noto Serif HK", "Source Han Serif HC", serif;

--font-cuneiform:
  "Noto Sans Cuneiform", sans-serif;

--font-braille:
  "Noto Sans Symbols 2", "Apple Braille", sans-serif;
~~~

標本ではGoogle Fontsを表示確認に使う。本番ではWOFF2、OFL本文、著作権表示を自己配信する。

### 2.3 文字ロール

| ロール | サイズ | 書体 | ウェイト | 行高 |
| --- | --- | --- | --- | --- |
| Brand XL | clamp(64px, 12vw, 176px) | Neutral Sans | 400 | 0.72–0.82 |
| Brand Index | 12–18px | Console Mono / Cuneiform | 400 / 500 | 1 |
| Subtitle | clamp(24px, 3vw, 44px) | Editorial Serif | 300 / 400 | 1.0–1.15 |
| Display Cantonese | clamp(42px, 8vw, 112px) | Noto Serif HK | 900 | 0.95 |
| Display Braille | clamp(28px, 5vw, 72px) | Braille Pattern | 400 | 1 |
| Display Cuneiform | clamp(36px, 6vw, 88px) | Noto Sans Cuneiform | 400 | 1 |
| Window | 15px | Neutral Sans | 600 / 500 | 1.3 |
| Body | 15px | Neutral Sans | 400 | 1.55 |
| Auxiliary | 12px | Neutral Sans | 400 | 1.6 |
| Label | 11px | Neutral Sans / Console | 600 / 500 | 1.3 |
| Console | 13px | Console Mono | 400 | 1.55 |

### 2.4 フランス語

フランス語はNeutral Sansで表示し、ロゴの小行、ナビゲーション、操作名、状態、単位説明に使う。
アクセント記号、合字、句読点を正しく保持する。

~~~text
Séquence orbitale
Réglage fin
Vitesse angulaire
Fréquence de coupure
Résonance
Verrouillage
Activer la rotation
Niveau de sortie
~~~

UIにはlang="fr"を付ける。日本語の補足をアクセシブルネームへ加える場合も、画面上のフランス語を
省略しない。

### 2.5 広東語

広東語はlang="yue-Hant-HK"を付け、Noto Serif HK 900で章扉または背景の大きな文字へ使う。
極太の明朝体を面として扱い、通常UIの小サイズには使わない。

~~~text
喺軌道之外，訊號仲係好清楚。
撳掣啟動序列。
~~~

### 2.6 楔形文字

楔形文字はNoto Sans Cuneiformで表示し、Unicode Cuneiformブロックの実在する文字を使う。

~~~text
𒀭 𒂍 𒆠 𒈗 𒌋
U+1202D / U+1208D / U+121A0 / U+12217
~~~

楔形文字は章番号、背景の索引、分割記号として使う。現代語の翻訳として扱わず、装飾列には
読み上げ用の説明を付ける。

### 2.7 点字

点字はUnicode Braille Patternsを使い、点の構造をピクセルグリッド、シーケンサー、状態列へ接続する。

~~~text
⠞⠑⠏⠥⠊  = TEPUI
⠕⠗⠃⠊⠞  = ORBIT
~~~

点字を視覚装飾に使う場合も、通常文字のラベルとアクセシブルネームを併記する。点字だけを操作名にしない。

---

## 3. カラーシステム

### 3.1 編集対象

| トークン | 初期HSL | 初期HEX | 役割 |
| --- | --- | --- | --- |
| Background | hsl(228 24% 4%) | #08090D | ページ、Three.js場面 |
| Surface | hsl(225 15% 11%) | #181A20 | Solid、Glass内部面 |
| Accent | hsl(12 100% 56%) | #FF4B1F | 副題、選択、現在位置 |
| Signal | hsl(166 92% 53%) | #19F5C2 | LED、通電、同期完了 |

Accentはブランド色、Signalは電子機器の状態色である。SignalはLED、メーター、短い状態表示だけへ使い、
通常のCTAや見出しには使わない。

### 3.2 Full-spectrum Palette Lab

各トークンは次の入力を持つ。

- Hue: 0–360°、1°刻み。
- Saturation: 0–100%、1%刻み。
- Lightness: 0–100%、1%刻み。
- Native color input: HEXの直接選択。

変更結果は次を同時表示する。

~~~text
HEX   #FF4B1F
RGB   rgb(255 75 31)
HSL   hsl(12 100% 56%)
CSS   --v4-accent: #FF4B1F;
~~~

Palette Labは全トークンのHEX一覧、選択中トークンのRGB/HSL、背景から導出した反対色、コピー用CSSを持つ。

### 3.3 反対色

背景の色相Hbgから、文字の色相を次で導出する。

~~~text
Hopp = (Hbg + 180°) mod 360°
Sopp = clamp(Sbg × 0.85, 32%, 92%)
Lopp = 92%  if Lbg < 50%
       8%   if Lbg ≥ 50%
~~~

これは補色色相と可読明度を組み合わせたReadable Complementである。診断用にRGB各成分を
255 − channelで反転したRGB Inverseも表示する。画面上のタイトルにはReadable Complementを使い、
HEXコードを場面内へ表示する。

本文は背景またはSurfaceの相対輝度から白系・黒系を選ぶ。AccentとSignalの上の文字も同じ方法で
コントラストの高い色を自動選択する。

### 3.4 色の面積

- BackgroundとSurfaceが画面の大部分を構成する。
- Accentは副題、選択、現在位置、主要な一操作を担当する。
- Signalは点灯部、再生位置、同期状態を担当する。
- 物理軸、危険、温度、圧力には意味色を割り当て、ブランド色と区別する。
- 色は形、文言、位置、点灯状態のいずれかと組み合わせる。

---

## 4. 科学記法

### 4.1 単位

数値と単位の間には改行しない細い空白を置く。積は中点、商は負の指数、桁の大きな値は×10ⁿを基本とする。

~~~text
12.48 m·s⁻¹
420 km
1.01325×10⁵ Pa
5.670374419×10⁻⁸ W·m⁻²·K⁻⁴
2.71 g·cm⁻³
0.84 mol·m⁻³·s⁻¹
~~~

HTMLでは意味のある添字と指数にsub / sup要素を使う。短い表示用断片ではUnicodeの₀、⁺、⁻¹を許可する。
更新値はIBM Plex Monoとtabular figuresで組む。

### 4.2 集合論

~~~text
x ∈ Ω
A ∩ B = ∅
℘(X)
∀x ∈ X, ∃y ∈ Y
f: X → Y
{x ∈ ℝ³ | ‖x‖ < R⊕}
~~~

集合記号はフィルター、選択範囲、対象群、可視集合の説明に使える。∅は空状態の短い補助記号として使い、
必ず通常文字の説明を併記する。

### 4.3 解析力学

~~~text
L(qᵢ, q̇ᵢ, t) = T − V
δS = 0
H(qᵢ, pᵢ, t)
{f, g} = Σᵢ(∂f/∂qᵢ · ∂g/∂pᵢ − ∂f/∂pᵢ · ∂g/∂qᵢ)
ω = dqᵢ ∧ dpᵢ
~~~

qᵢ、pᵢ、δSは制御軸、状態空間、最適化の章扉モチーフになる。実ゲームの状態表示では、
物理量の意味と座標系を明記する。

### 4.4 熱力学

~~~text
dU = T dS − p dV + μᵢ dNᵢ
G = H − TS
η = 1 − T₍c₎/T₍h₎
q̇″ = −k∇T
Re = ρvL/μ
Pr = cₚμ/k
Nu = hL/k
~~~

熱、流体、再突入UIでは、温度K、熱流束W·m⁻²、動圧Pa、密度kg·m⁻³を値の直後へ置く。
色だけで安全域を表さず、数値、単位、状態語を揃える。

### 4.5 理論物理

~~~text
S = ∫ℒ d⁴x
Gμν + Λgμν = 8πG Tμν / c⁴
iℏ ∂ψ/∂t = Ĥψ
∇²Φ = 4πGρ
⟨ψ|Ô|ψ⟩
~~~

場、波、作用、テンソルの記号は、背景軌道、ロゴ索引、ローディング、記号シルエットへ展開する。

### 4.6 化学工学

~~~text
N₍A₎ = −D₍AB₎∇c₍A₎ + c₍A₎v
kₗa
Da = kC₍A0₎ⁿ⁻¹τ
Pe = uL/D
Δp = f(L/Dₕ)ρu²/2
~~~

下付き文字は成分、相、位置、初期状態を明確にする。装飾用の添字はMOTIFとして隔離し、
実在する工程値と同じ行へ置かない。

### 4.7 有機化学構造式

ベンゼン環、縮合環、カルボニル、アミド、分岐鎖、反応矢印をSVG記号の骨格に使う。
化学物質として表示する構造式は結合次数、原子記号、電荷、置換位置を正確にする。造形のために
再構成した図形はSTRUCTURAL MOTIFと表示し、物質名を付けない。

~~~text
Ph—C(=O)—NH—R
R¹—CH=CH—R²
CO₂ / O₂ / Fe³⁺ / SO₄²⁻
~~~

### 4.8 地学

~~~text
M₍w₎ 6.8
δ¹⁸O = −2.4‰
⁸⁷Sr/⁸⁶Sr = 0.7042
σ₁ ≥ σ₂ ≥ σ₃
N35°E / 42°SE
ρ = 2.71 g·cm⁻³
P–T = 1.2 GPa / 780 °C
~~~

地質、地震、同位体、応力、走向傾斜の記号は、地球表示、軌道環境、素材分類のUIへ使う。

---

## 5. ロゴタイプ

### 5.1 Primary silhouette

~~~text
DIVE                    ∫ℒ d⁴x
    INTO                 qᵢ ∈ Ω
        TEPUI            μ⊕ / 𒀭
The Orbit Is the Battlefield
L’orbite devient le champ de bataille
~~~

- 大文字本体はArimo 400、負の字間、狭い行高で一つのシルエットを作る。
- 各行は左揃えを維持し、段階的なインデントで斜めの輪郭を作る。
- 数式、楔形文字、添字はIBM Plex Monoまたは専用書体で小さく配置する。
- 英語副題はCormorant Garamond 300、フランス語小行はArimo 400で表示する。
- 背景上の本体文字はReadable Complementを使う。

### 5.2 Multiscript plate

~~~text
𒀭 𒂍 𒆠 𒈗
⠞⠑⠏⠥⠊ / ⠕⠗⠃⠊⠞
喺軌道之外，訊號仲係好清楚。
Séquence orbitale · réglage fin
~~~

四つの文字体系は同じ文を翻訳する目的ではなく、時間、触覚、声、操作という異なる質感を担当する。

---

## 6. マテリアル操作物

### 6.1 Plastic material

操作物は成形プラスチック、塗装面、ゴム、半透明LEDの四素材で構成する。

| 素材 | 表現 |
| --- | --- |
| Matte plastic | 上側の弱いハイライト、下側の広い影、低彩度面 |
| Gloss cap | 狭い鏡面ハイライト、丸いエッジ、押下時の沈み |
| Rubber grip | 細いリブ、低い反射、濃い面 |
| LED resin | 半透明の色、中心の明点、短い拡散光 |

外周線は使わず、面差、ハイライト、キャストシャドウ、押下量で形を定義する。

### 6.2 Toggle

Toggleはネイティブcheckboxを正本とし、上にプラスチックのレバーとLEDを描く。ONではレバー位置、
LED、状態語が同時に変わる。

~~~text
MARCHE / ARRÊT
SYNCHRO / LIBRE
VERROU / OUVERT
~~~

### 6.3 Lever

Leverは三位置−1 / 0 / +1を持ち、クリック、Enter、Spaceで順番に切り替わる。位置は角度、
刻印、数値で示す。用途例は速度方向、変調極性、時間ワープである。

### 6.4 Knob

Knobはネイティブrange入力を正本とし、円形キャップ、指標線、弧状メーターで表示する。
Arrow keys、Page Up/Down、Home/Endを利用できる。

~~~text
FRÉQUENCE  2.40 kHz
RÉSONANCE  42 %
GAIN       −6.0 dB
ENVELOPPE  180 ms
~~~

### 6.5 Step sequencer

16個のパッドはaria-pressedを持つbuttonで構成する。選択パッドはAccent、現在ステップはSignal、
無効パッドはSurface差で示す。再生、停止、テンポ変更を操作できる。

---

## 7. Three.jsトゥーン背景

### 7.1 Scene

Three.jsの場面は、低ポリゴンの多面体、トーラス、軌道リング、分子状ノードから構成する。
MeshToonMaterial、段階化したgradient map、Directional Light、背面拡大型アウトラインを使い、
滑らかな写実表現ではなく明快なトゥーン面を作る。

### 7.2 Palette connection

- BackgroundトークンがThree.js場面とDOMステージの背景を決める。
- Accentトークンが主要形状を決める。
- Signalトークンが小ノードと現在位置を決める。
- Readable Complementがタイトル、アウトライン、診断コードを決める。
- Palette Labの変更はCustomEventでThree.jsへ通知する。

### 7.3 Interaction

Activer la rotationで自動回転を切り替え、Changer la formeで形状構成を切り替える。Pointer移動は
小さな視差だけを与える。prefers-reduced-motion: reduceでは自動回転を停止し、ボタン操作による
状態変更だけを残す。

### 7.4 Fallback

Three.jsまたはCDNが利用できない場合は、CSSの放射グラデーションと幾何形状を背景として残す。
文字、色コード、Palette Lab、シーケンサーは独立して動作する。

---

## 8. 面とレイアウト

### 8.1 角丸

| トークン | 値 | 用途 |
| --- | --- | --- |
| Control | 14px | 入力、パッド、小ボタン |
| Card | 22px | 記号セル、Console、操作群 |
| Window | 34px | Palette Lab、設定、標準ウィンドウ |
| Feature | 48px | Three.js場面、章扉、Material Lab |
| Instrument | 56px | シンセサイザー本体 |
| Pill | 999px | 状態、短い切替 |

### 8.2 面

- SolidはSurface色と背景色の差で境界を作る。
- Glassは半透明Surface、backdrop-filter: blur(24px)、広い影で境界を作る。
- Instrumentは成形プラスチックのグラデーション、内側のくぼみ、広い影で物質感を作る。
- ウィンドウ外周の常設線は使わない。
- Focus ringは操作中だけ表示し、AccentまたはReadable Complementを使う。

### 8.3 余白

~~~text
4 / 6 / 10 / 14 / 20 / 28 / 42 / 64 px
~~~

ウィンドウ内側は14〜20px、操作群は6〜10px、セクション間は42〜64pxを基本とする。
操作領域は44px以上を保つ。

---

## 9. Scientific Symbol System

### 9.1 造形

記号は32×32グリッド、1.5pxまたは2pxのストローク、最大三つの幾何要素で構成する。
ニュートラルな輪郭へ、次の科学図像を一つだけ混ぜる。

- ベンゼン環または分子結合。
- 位相空間の軌道。
- ポテンシャル井戸。
- ベクトル場。
- Feynman vertex。
- 結晶格子。
- 応力軸σ₁。
- 波束ψ²。
- 集合Ωと境界∂Ω。
- 流束q̇″。

### 9.2 脱構築

閉じた輪郭の一部を切り、別のストロークを少し外へずらす。中心を意図的に偏心させ、添字または
上付き記号を小さなアンカーとして加える。全体のシルエットは一目で区別できる単純さを保つ。

### 9.3 実用性

- 操作には可視ラベルまたはaria-labelを付ける。
- 色は状態の補助に使い、形状変化または文言を併用する。
- 危険、削除、閉じる、再生、停止は慣習的な意味を維持する。
- 科学的に特定の意味を持つ記号は、実データと装飾モチーフを区別する。
- 16px版では添字を省略し、主輪郭を残す。

### 9.4 記号ファミリー

| 名称 | 発想 | 用途 |
| --- | --- | --- |
| Orbit set Ω₀ | 集合境界 + 軌道 | 対象集合、軌道表示 |
| Phase qᵢ/pᵢ | 位相空間 | 状態、計画 |
| Aromatic C₆ | ベンゼン環 | 構造、モジュール |
| Flux q̇″ | 熱流束 | 加熱、流量 |
| Field ∇Φ | ベクトル場 | 重力、場 |
| Vertex S³ | Feynman vertex | 分岐、接続 |
| Lattice a₀ | 結晶格子 | グリッド、配置 |
| Wave ψ² | 波束 | 信号、確率 |
| Stress σ₁ | 主応力軸 | 圧力、破壊 |
| Reaction k₁ | 反応経路 | 実行、遷移 |
| Manifold Mⁿ | 曲面と切断 | Map、空間 |
| Isotope δ¹⁸O | 同位体表記 | 地学、地層年代 |

---

## 10. モーション

| 対象 | 時間 | 動き |
| --- | --- | --- |
| Button press | 80–120ms | 1–2px沈む、影が短くなる |
| Toggle | 160–220ms | レバー移動、LED点灯 |
| Lever | 180–260ms | 三位置の回転、軽いovershoot |
| Knob | 入力追従 | 指標線と値が連続更新 |
| Step sequencer | Tempo同期 | 現在位置だけSignal点灯 |
| Window | 180–260ms | opacity + 6–10px移動 |
| Three object | 16–40s/rev | 低速回転、弱い視差 |

Reduced Motionでは自動回転、overshoot、連続視差を止め、状態の即時切替と短い色変化だけを残す。

---

## 11. アクセシビリティ

- 本文は4.5:1、大文字表示と主要図形は3:1以上を確保する。
- Palette Labは現在のコントラスト比を表示する。
- 色の意味はラベル、形、位置、点灯のいずれかと組み合わせる。
- Toggleはcheckbox、Knobはrange、Padはbuttonを正本とする。
- 楔形文字、点字、構造式SVG、Three.js canvasには代替説明を付ける。
- フランス語はlang="fr"、広東語はlang="yue-Hant-HK"を付ける。
- 数式の重要な意味は周辺の通常文でも説明する。
- 360px幅、200%ズーム、キーボード操作、Touch操作で構造を維持する。

---

## 12. 静的標本の契約

DEVELOP/ui-design-reference-v4.htmlは、次を一ページで表示し、操作できる。

1. 全色相0〜360°に対応するBackground / Surface / Accent / Signalエディター。
2. 各色のHEX、RGB、HSL、コピー用CSS。
3. 背景から導出したReadable ComplementとRGB Inverse。
4. Three.js MeshToonMaterialによる抽象3D背景。
5. 背景色と反対色のタイトル文字。
6. 英語、日本語、フランス語、広東語、楔形文字、点字の文字標本。
7. 集合論、解析力学、熱力学、理論物理、化学工学、地学、有機化学の記法。
8. 操作可能なプラスチックボタン、Toggle、三位置Lever、Knob、16-step sequencer。
9. 科学図像から構成する12種類以上の独自SVG記号。
10. Reduced Motion、Three.js fallback、キーボード操作。
11. CSSトークン、書体ライセンス、機械可読JSON manifest。

標本は通常UIを外部ライブラリなしで動作させる。Three.jsだけをversion-pinned CDNから読み込み、
本番では同梱資産へ置き換える。

---

## 13. 実装トークン

~~~css
:root {
  --v4-background: #08090d;
  --v4-surface: #181a20;
  --v4-accent: #ff4b1f;
  --v4-signal: #19f5c2;
  --v4-opposite: #f1efe4;

  --v4-radius-control: 14px;
  --v4-radius-card: 22px;
  --v4-radius-window: 34px;
  --v4-radius-feature: 48px;
  --v4-radius-instrument: 56px;

  --v4-plastic-highlight: rgb(255 255 255 / 0.16);
  --v4-plastic-shadow: rgb(0 0 0 / 0.42);
  --v4-glass-blur: 24px;
}
~~~

JavaScriptのPalette stateを色の正本とし、CSS custom properties、コード表示、Three.js materialを
同じイベントから更新する。

---

## 14. 適合条件

- [ ] Background / Surface / Accent / Signalを0〜360°で編集できる。
- [ ] 全色のHEX、RGB、HSLが表示される。
- [ ] Readable ComplementとRGB Inverseの色コードが表示される。
- [ ] 文字色が背景色の反対色へ即時更新される。
- [ ] Three.jsのトゥーン3D場面が表示され、回転と形状を操作できる。
- [ ] Three.jsなしでも文字とUIが成立する。
- [ ] フランス語が装飾と操作UIの両方に存在する。
- [ ] 広東語がNoto Serif HK 900で表示される。
- [ ] 楔形文字と点字がUnicode文字として表示される。
- [ ] 科学分野ごとの記法とSI単位がHTMLのsub / sup要素を使って表示される。
- [ ] Toggle、Lever、Knob、Pad、Buttonを操作できる。
- [ ] 操作時に色、位置、影、アニメーションが変わる。
- [ ] 科学図像から構成した12種類以上の記号がある。
- [ ] ウィンドウ外周の常設線がない。
- [ ] Reduced Motion、キーボード、Touchに対応する。
- [ ] 書体が自己配信可能なOFL書体で構成される。
- [ ] JSON manifestと画面上の初期値が一致する。

---

## 15. 参考資料

### Three.js

- [Three.js Materials](https://threejs.org/manual/en/materials.html)
- [Three.js MeshToonMaterial](https://threejs.org/docs/#api/en/materials/MeshToonMaterial)
- [Three.js ToonOutlinePassNode](https://threejs.org/docs/pages/ToonOutlinePassNode.html)

### Unicodeと文字

- [Unicode Character Code Charts](https://www.unicode.org/charts/)
- [Unicode Cuneiform U+12000–U+123FF](https://www.unicode.org/charts/PDF/U12000.pdf)
- [Unicode Cuneiform Numbers and Punctuation](https://www.unicode.org/charts/PDF/U12400.pdf)

### 書体

- [Arimo](https://github.com/googlefonts/Arimo)
- [Zen Kaku Gothic Antique](https://github.com/googlefonts/zen-kakugothic)
- [Cormorant Garamond](https://github.com/CatharsisFonts/Cormorant)
- [Zen Old Mincho](https://github.com/googlefonts/zen-oldmincho)
- [IBM Plex](https://github.com/IBM/plex)
- [Noto Serif CJK](https://github.com/notofonts/noto-cjk/tree/main/Serif)
- [Noto font use and OFL](https://github.com/notofonts/noto-docs/blob/main/docs/website/use.md)
- [SIL Open Font License 1.1](https://openfontlicense.org/)
