# UIデザインシステム改修案 第三版（再構築版）

## 文書の位置づけ

本書は[第二版](TYPOGRAPHY_LOGOTYPE_SYMBOL_PROPOSAL_V2.md)の書体、色階層、記号体系を基礎に、
タイポグラフィ以外のUIパターン、生成背景、グラス表面、モーションまで対象を広げた実装前仕様である。
初回の第三版案は使わず、本書と対応する静的HTMLを第三版の正本とする。

対応する標本:
[UIデザインシステム標本 第三版](typography-logotype-symbol-ui-mockup-v3.html)

この第三版で確定することは次のとおりである。

1. 第二版のArimo / Zen Kaku Gothic Antique、Cormorant Garamond / Zen Old Mincho、
   IBM Plex MonoというOFL書体構成を維持する。
2. 第二版の細い古典的なセリフ副題を復帰し、高彩度の赤橙を与える。
3. ウィンドウ外周の枠線を廃止し、面色の差または背景ぼかしで境界を示す。
4. 余白を第二版より詰め、角丸は第二版と初回第三版案より大きくする。
5. 文字の背後に抽象的な3D風生成背景を置き、ぼけ、ピクセルノイズ、モザイクを動的に構成する。
6. 表示用文字へ特殊記号、上付き・下付き文字、変則的な改行とインデントを導入する。
7. 単一の赤寄りオレンジをアクセントとし、HTML上のHSLスライダーで微調整してHEXを取得できるようにする。

本書はゲーム本体への即時適用を指示するものではない。標本で検証後、確定した規則だけを
`theme.ts`、HUD、ウィンドウ管理へ段階的に移す。

---

## 1. 参照サイトから抽出する構成原理

### 1.1 調査範囲

Lusion、nk.studio、Locomotiveの公式サイトと公式事例記事を参照した。3サイトの素材、ロゴ、
レイアウトを複製せず、次の抽象的な原理だけを取り込む。

- 少数の書体と少数の色で、文字と映像の優先順位を明確にする。
- 3D、WebGL、粒子、ぼけを装飾ではなくページの空間として使う。
- 背景の動きは強くても、本文と操作UIには競合させない。
- 大きな文字を均等な矩形へ収めず、改行、空き、インデントでシルエットを作る。
- ロゴを単なる文字列にせず、斜線、軌道、粒子、特殊記号を反復可能な語彙にする。
- 明暗が変わる背景では、difference合成や局所的な面を使って文字のコントラストを保つ。

### 1.2 Lusionから取り込む要素

Lusionの公式紹介は3D visual storytellingを中心に据えている。Oryzoの公式制作記事では、
Houdiniによる手続き的な形状、ノイズ、微視的な背景、3D空間内のタイポグラフィを説明し、同時に
書体と色数を絞ってUIが体験と競合しないようにしている。

本案では次へ変換する。

- ヒーロー背景を低解像度Canvasで生成し、抽象的な球、カプセル、軌道線、粒子を重ねる。
- 低解像度の描画面を拡大してモザイクを作り、その上へ弱いぼけとノイズを加える。
- 表示文字は3D場面の前景に置き、一部を場面へ重ねるが、操作部品は静かな面へ隔離する。
- 色はニュートラル面と単一アクセントへ制限する。

### 1.3 nk.studioから取り込む要素

nk.studioの公式記事は、WebGL背景を没入的にしながらコンテンツと競合させないこと、ネオンの斜線と
粒子をウェブから空間へ展開したことを説明している。

本案では次へ変換する。

- ロゴマークの軌道斜線を、区切り、進行方向、背景粒子の流れに反復する。
- 暗色面上の赤橙は広い塗り面ではなく、短い副題、現在位置、細い軌道に限定する。
- 粒子はランダムに散らすだけでなく、同じ軌道方向と速度場に従わせる。
- 生成背景のフレームレートが低下した場合も、文字と操作は独立して読める構造にする。

### 1.4 Locomotiveから取り込む要素

Locomotiveの公式事例には、書体標本自体を没入的なページにする構成、古典性を持つセリフと現代的な
可変文字を動かす構成、大きな文字と抽象形状を交差させる構成がある。

本案では次へ変換する。

- Cormorant Garamond / Zen Old Minchoを、通常UIではなく副題と章扉の変化に使う。
- 大見出しの各行に異なるインデントを与え、左揃えを保ったまま不均一な輪郭を作る。
- `∴`、`⌁`、`Ω`、`Δv`、`₀`、`⁺`などを表示用の小さな記号として組み込む。
- 本文、表、数値は意匠文字から分離し、意味を持つ記号を装飾目的で改変しない。

### 1.5 ユーザー観察を正本とする項目

参照ページの更新や閲覧環境によって直接確認できない表現は、要件として提示された次の観察を正本とする。

- 文字の背景に抽象的な3Dモデルまたは映像が存在する。
- 背景へぼけ、ピクセルノイズ、モザイクが生成的に適用される。
- タイトルと副題へSVG、Unicodeの特殊記号、マイナーな文字、上付き・下付き記号を美学的に使う。
- 左揃えを基準に、変則的な改行と配置で文字群のシルエットを作る。
- すりガラスのぼけが、外周線の代わりにウィンドウ境界を示す。

---

## 2. デザイン原則

### 2.1 Scene first, interface quiet

タイトル画面、章扉、選択画面では生成背景と大きな文字を主役にする。プレイ中のHUD、設定、ログ、
警告では背景表現を弱め、情報密度と即読性を優先する。派手な場面と静かなUIを同じ部品へ混在させない。

### 2.2 One accent, many neutral states

ブランドアクセントは赤寄りのオレンジ一色とする。選択、フォーカス、現在位置、短い副題へ同じ色を使い、
部品ごとに別のブランド色を作らない。危険、軌道3軸、物理状態の色は意味色として別系統に保つ。

### 2.3 Shape by type, not by boxes

表示部では文字の行長、改行、インデント、上付き・下付き記号によってシルエットを作る。箱を増やして
画面を分割しない。操作部では逆に不規則な文字組を使わず、整列、表形式数字、一定の行高を守る。

### 2.4 Boundary without outline

ウィンドウの外周へ`border`を設定しない。境界は次のどちらか、または組み合わせで示す。

1. 背景と十分に異なる不透明面。
2. 半透明面、`backdrop-filter`、柔らかな面の影によるGlass面。

ウィンドウ周囲へ1pxの疑似要素を置く、内側へ線を描く、常時発光させることも行わない。

---

## 3. 書体

| 役割 | ラテン文字・数字 | 日本語 | ウェイト | ライセンス |
| --- | --- | --- | --- | --- |
| Neutral Sans | Arimo Variable | Zen Kaku Gothic Antique | 400 / 500 / 600 / 700 | SIL OFL 1.1 |
| Editorial Serif | Cormorant Garamond | Zen Old Mincho | 300 / 400 / 500 | SIL OFL 1.1 |
| Console Mono | IBM Plex Mono | Zen Kaku Gothic Antique | 400 / 500 / 600 | SIL OFL 1.1 |
| Symbols | 独自SVG | 独自SVG | 1.5px基本線 | プロジェクト資産 |

Helveticaそのものは組み込み条件を満たさないため、第二版どおりArimoを主Sansとする。日本語は
Zen Kaku Gothic Antiqueを使い、太く大ぶりなUD系の印象を避ける。クラシックな副語彙には
Cormorant GaramondとZen Old Mincho、機械的な語彙にはIBM Plex Monoを使う。

```css
--font-ui:
  "Arimo", "Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN",
  "Yu Gothic", sans-serif;

--font-editorial:
  "Cormorant Garamond", "Zen Old Mincho", "Hiragino Mincho ProN",
  "Yu Mincho", serif;

--font-console:
  "IBM Plex Mono", "Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN",
  "Yu Gothic", monospace;
```

本番ではWOFF2を自己配信し、各書体のOFL本文と著作権表示を同梱する。標本のGoogle Fonts読込は
確認用に限る。

---

## 4. 文字ロール

| ロール | サイズ | 書体 | ウェイト | 用途 |
| --- | --- | --- | --- | --- |
| Brand XL | `clamp(56px, 11vw, 156px)` | Neutral Sans | 400 | ヒーロー、章扉 |
| Brand Ornament | `clamp(12px, 1.5vw, 18px)` | Console Mono | 500 | 上付き・下付き記号 |
| Brand Subtitle | `clamp(22px, 3vw, 42px)` | Editorial Serif | 300 / 400 | 第二版型の英日副題 |
| Display L | `clamp(34px, 5vw, 72px)` | Neutral / Editorial | 400 | セクション題名 |
| Window | 15px | Neutral Sans | 600 / 500 | ウィンドウ題名 |
| Body | 15px | Neutral Sans | 400 | 通常文 |
| Auxiliary | 12px | Neutral Sans | 400 | 補助説明 |
| Label | 11px | Neutral Sans | 600 / 500 | 短いラベル |
| Console | 13px | Console Mono | 400 | 座標、ログ、CUI |

### 4.1 第二版へ戻す副題

- 英語副題はCormorant Garamond 300、非イタリック、短い一文とする。
- 日本語副題はZen Old Mincho 400、英語とは別行にする。
- 基本色は高彩度の赤橙である。
- 通常のUI面では固定色、映像へ重なるヒーローだけdifference合成を許可する。
- 長文、ボタン、警告、ConsoleにはEditorial Serifを使わない。

### 4.2 補助説明

本文より2〜3px小さく、Muted色、行高1.55〜1.7で表示する。操作に不可欠な情報を補助説明だけへ
置かない。透明度を下げるのではなく専用のMuted色を使い、背景が透けるGlass面でも値を安定させる。

### 4.3 太字

本文内の強調は600までとし、一段落に一箇所程度へ抑える。700は危険警告または短い状態名だけに使う。
太字、アクセント色、大文字化を同時に重ねない。

### 4.4 斜体

- Editorial Serifの斜体: 引用、章扉の一語、静かな叙述。
- IBM Plex Monoの斜体: コメント、推定値、未確定値。
- Neutral Sansの斜体: 原則使わない。

日本語へCSSの疑似斜体を適用しない。対応する実グリフがない場合は通常体を使う。

---

## 5. 表示用ロゴタイプ

### 5.1 Primary silhouette

```text
DIVE                 ∴03
    INTO              ECI₀
        TEPUI         Ω⁺
The Orbit Is the Battlefield
軌道が戦場になる
```

- 全行は左揃えを基準とし、2行目と3行目だけ段階的にインデントする。
- 大文字本体はArimo 400、狭い行高、負の字間で一つの輪郭として扱う。
- `∴03`は上付き、`ECI₀`は下側、`Ω⁺`は上付きへ置き、本文より十分小さくする。
- 英語副題はCormorant Garamond 300、日本語副題はZen Old Mincho 400へ戻す。
- 背景との重なりを前提とし、白のdifference合成でタイトルを反転させる。

### 5.2 特殊記号の語彙

表示用に許可する文字は、採用書体で字形を確認した次の集合を起点とする。

```text
∴  ⟡  ⌁  ⌖  Ω  Δ  μ  Σ  №  ·  /  +  −  ×
⁰  ¹  ²  ³  ⁺  ⁻  ₋  ₊  ₀  ₁  ₂  ₃
Δvₙ  Ω⁺  ECI₀  μ⊕  CO₂  O₂  Fe³⁺
```

化学式や数式に見える装飾は、ヒーロー、章扉、標本に限る。HUDの実データへ装飾文字を混ぜず、
`Δv`、`Ω`、`μ`などが実際の物理量を示す場合は通常の数式表記として扱う。

### 5.3 SVG mark

24×24または48×48グリッド上で、Tの縦画、傾斜した軌道面、中心点から構成する。favicon、Compactロゴ、
ローディング、現在位置へ同じ形を使えるようにする。文字グリフをアウトライン化しただけのマーク、
ロケットや惑星へ文字を置換したマークは使わない。

---

## 6. Adaptive Contrast Display

映像または生成背景へ直接重なるBrand XLとBrand Subtitleにだけ適用する。

```css
.adaptive-title {
  color: #fff;
  mix-blend-mode: difference;
}

.adaptive-subtitle {
  color: var(--accent);
  mix-blend-mode: difference;
}
```

白いタイトルは明背景で暗く、暗背景で明るくなる。赤橙の副題は背景に応じて補色方向へ変化する。
本文、ボタン、値、Console、警告には使わない。差の合成が利用できない環境では、背景へ薄い暗色Scrimを
置いてTitle色とAccent色を固定する。

`mix-blend-mode`だけでWCAGコントラストを保証しない。量産画面では背景輝度をサンプルしてDark/Lightの
クラスを切り替える方式を優先し、differenceはヒーローの演出として扱う。

---

## 7. カラーシステム

### 7.1 初期値

| トークン | Dark | Light | 役割 |
| --- | --- | --- | --- |
| Page | `#07080A` | `#F0EEE9` | 最背面 |
| Surface 1 | `#101217` | `#E6E2DC` | 不透明ウィンドウ |
| Surface 2 | `#181B21` | `#D9D4CD` | 選択、内側の面 |
| Title | `#EEEAF5` | `#17141B` | 見出し、重要値 |
| Body | `#C3BEC9` | `#514C56` | 通常文 |
| Muted | `#89838F` | `#746E78` | 補助説明 |
| Faint | `#5F5A65` | `#AAA2AD` | 無効、非選択 |
| Accent | `#FF4B1F` | `#CC2900` | 副題、選択、現在位置 |

Dark Accentの初期値は`hsl(12 100% 56%)`、HEXでは`#FF4B1F`である。第二版の`#FF5A00`より
色相を赤側へ寄せる。Light面用は同じ色相・彩度で明度40%を初期値とし、小さい文字のコントラストを
確保する。

### 7.2 調整UI

静的HTMLは次のスライダーを持つ。

- Hue: 0〜35°。
- Saturation: 60〜100%。
- Dark surface lightness: 40〜70%。
- Light surface lightness: 24〜50%。

変更は`--accent`と`--accent-on-light`へ即時反映し、双方のHEX、HSL、背景とのコントラスト比を表示する。
「Copy CSS」でハードコード用の2トークンを取得できる。初期値へ戻すResetも備える。

### 7.3 アクセント予算

- 通常画面の色面積は10%未満を目安にする。
- アクセント色の大きな塗りボタンを複数並べない。
- 選択状態は色だけでなく、位置、形、文言のいずれかを併用する。
- 危険は赤、軌道3軸は青・緑・赤という意味色を維持する。
- 生成背景はアクセントの同系色を弱く含めてもよいが、彩度を主文字より下げる。

---

## 8. 生成背景

### 8.1 レイヤー

```text
Text / SVG mark / controls
Frosted glass window
Soft scrim and local blur
Pixel noise / mosaic
Abstract 3D-like bodies and orbit lines
Page color
```

Canvasは低解像度で描画し、CSS上で拡大する。球状の放射グラデーション、回転するカプセル、軌道線、
同一速度場に従う粒子を合成し、3Dモデルを読み込まずに空間感を作る。数秒ごとに完全に構図を変えず、
ゆっくりした漂流と位相差だけを与える。

### 8.2 ノイズ、モザイク、ぼけ

- モザイク: Canvas内部解像度を表示寸法の1/4〜1/8へ下げて拡大する。
- ピクセルノイズ: 毎フレーム全画素を書き換えず、低密度の明暗セルを位相に応じて更新する。
- ぼけ: Canvas自体に4〜8px、Glass面の背後に18〜30pxを目安とする。
- 色収差、走査線、グローは常設しない。

### 8.3 性能と縮退

- Device Pixel Ratioは1.5以下に制限する。
- ページが非表示なら更新を止める。
- `prefers-reduced-motion: reduce`では一枚だけ描画し、粒子とカプセルを動かさない。
- Canvasが使えない場合も背景色、ロゴ、操作UIが成立する。
- ゲーム本体へ移す際はWebGPUの場面とDOMのCanvasを二重描画せず、既存のレンダー結果を利用する。

---

## 9. ウィンドウと面

### 9.1 角丸

| トークン | 値 | 用途 |
| --- | --- | --- |
| Control | `14px` | 入力、ボタン、短い行 |
| Card | `22px` | カード、メニュー、Console |
| Window | `34px` | 標準ウィンドウ、設定 |
| Feature | `48px` | ヒーロー内Glass、章扉 |
| Pill | `999px` | 状態、タブ、短い操作 |

内側の角丸は外側より8〜14px小さくする。小さな四角形へ大きすぎる丸みを強制せず、アイコン枠など
24px以下の要素は6〜10pxを許可する。

### 9.2 Solid Window

- 背景との差は明度4〜8%程度を確保する。
- 外周線は持たない。
- 影は`0 18px 60px rgb(0 0 0 / 0.24)`程度の広く弱い一層にする。
- Header、Body、Footerを線で区切らず、面色、空き、グループ背景で分ける。

### 9.3 Glass Window

```css
.window-glass {
  background: rgb(13 15 19 / 0.58);
  border-radius: 34px;
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.3);
  backdrop-filter: blur(24px) saturate(115%);
}
```

Glassは背景に情報がある場所で使う。空白面にGlassを置いても境界が成立しないため、その場合はSolidを
使う。透明度を上げすぎず、文字の直下はScrimまたは内側のSolid rowで安定させる。

### 9.4 密度の高い余白

基本単位は4pxとし、次を推奨する。

```text
4 / 6 / 10 / 14 / 20 / 28 / 42 px
```

- ウィンドウ内側: 14〜20px。
- Headerの上下: 10〜14px。
- 行間: 6〜10px。
- セクション間: 42〜72px。
- ボタンの上下: 8〜10px、左右: 12〜16px。

余白を狭めても、44pxのポインタ領域、11pxの最小補助文字、フォーカス表示は維持する。

---

## 10. UIパターン

### 10.1 Navigation

上部ナビゲーションは背景ぼけだけを持つ薄いGlass帯とし、下線を置かない。現在位置はアクセント色の
小点または短いPillで示す。狭い画面では横スクロールを許可し、項目を二段に折らない。

### 10.2 Buttons

- Primary: Title色の明面と暗い文字。アクセント大面積を避ける。
- Accent: 選択確定や現在位置に一つだけ。背景はAccent、文字はコントラストで決める。
- Secondary: Surface 2の面色差。外周線なし。
- Quiet: 背景なし。Hover時だけSurface 2を出す。
- Icon button: 44px操作領域、24px図形、PillまたはControl radius。

### 10.3 Inputs and selection

入力欄はSurface 2で沈める。枠線を使わず、Focus時は周囲の面をAccentの低彩度面へ変えるか、2pxの
外側focus ringだけを表示する。Focus ringはウィンドウ枠ではなく一時的な操作状態なので例外とする。

### 10.4 Lists and tables

各行を弱い面色の丸いrowにするか、十分な列間隔だけで分ける。常時の縦横罫線を作らない。更新値は
IBM Plex Monoとtabular figures、ラベルはNeutral Sansを使う。

### 10.5 HUD and overlays

照準、マーカー、軌道線は従来のSVG体系を維持する。文字の背後へ最小限の局所Scrimを置き、広いGlass
カードを量産しない。アクセントはターゲット、lead、maneuver、BURN、弾薬へ限定する。

### 10.6 Console

ConsoleはIBM Plex Mono、13px、行高1.55。コメントと推定値だけ実イタリック、重要値は600。背景は
不透明に近いSolidまたは低透過Glassとし、生成背景のノイズを直接読ませない。

### 10.7 Empty, loading, unavailable

空状態は短い説明と次の操作を一つ示す。LoadingはSVG markまたは軌道点のゆっくりした位相移動とし、
点滅文字や無限の高彩度グローを使わない。UnavailableはMuted色と理由を併記する。

---

## 11. 記号体系

第二版の「実体=塗り、方向=矢または中心、軌道点=中空、予測=開形または破線、危険=交差」を維持する。
正本は`viewBox="0 0 24 24"`の独自SVGとする。

| 族 | 形 | 例 |
| --- | --- | --- |
| UI action | 1.5px線、square cap | menu、save、filter、dock |
| Entity | 塗りまたは中心を持つ形 | ship、body、ammo |
| Direction | 鏃・軸・回転対 | prograde、retrograde、target |
| Orbit point | 中空の閉形 | apsis、AN/DN、maneuver |
| Prediction | 開形・破線 | ghost、preview |
| Hazard | 交差・欠損 | impact、reentry、occlusion |

標本は12個のUI iconと15個のWorld marker、合計27個を一覧表示する。選択はAccent、危険はDanger、
無効はMuted/Faintとし、色だけに意味を依存させない。

---

## 12. 静的HTML標本の契約

`DEVELOP/typography-logotype-symbol-ui-mockup-v3.html`は、他のAIと実装者が一ページで参照できる
動作資料とする。次を必ず含める。

1. 低解像度Canvasによる生成背景、ぼけ、ピクセルノイズ、モザイク。
2. 変則改行、インデント、上付き・下付き記号を持つPrimaryロゴタイプ。
3. 第二版へ戻した英語・日本語副題。
4. Dark/Lightの色、全採用書体、文字ロール、太字、斜体、補助説明。
5. 外周線のないSolid / Glass / Frosted window。
6. 密度の高いボタン、タブ、入力、表、HUD、Console、通知。
7. 27個のSVG記号。
8. HSLスライダー、Dark/LightのHEX、コントラスト比、Reset、Copy CSS。
9. CSSトークン、書体ライセンス、機械可読JSON manifest。

標本は外部ライブラリを必要としない単一HTMLとする。フォントだけ確認用にGoogle Fontsから読み込む。
JavaScript無効時も初期色、全標本、JSON manifestを閲覧できる。

---

## 13. 本番への移行計画

### Phase 1 — tokens and font assets

1. OFL書体のWOFF2とライセンスを自己配信する。
2. 色、角丸、余白、面、文字ロールを`theme.ts`の型付きトークンへ移す。
3. 標本で調整したHEXを`ACCENT` / `ACCENT_ON_LIGHT`へ固定する。

### Phase 2 — typography and symbols

1. HUD本文、ウィンドウ、Consoleを新しいfamilyへ置換する。
2. SVG記号を一つのspriteまたはTypeScript moduleへ統合する。
3. 文字欠落、全角混在、表形式数字を確認する。

### Phase 3 — borderless surfaces

1. 既存ウィンドウの外周線を除き、SolidとGlassの二系統へ分類する。
2. 余白を新スケールへ詰め、角丸を34px基準へ広げる。
3. 画面上のGlass重複を最大二層に制限する。

### Phase 4 — display scenes

1. タイトル、ステージ選択、結果画面へ不規則なロゴタイプを導入する。
2. 既存WebGPU場面を背景として使い、DOM側の重複描画を避ける。
3. Adaptive Contrastを背景サンプル方式で実装し、differenceを演出用fallbackとして残す。

### Phase 5 — verification

1. 360px幅、通常desktop、4K、200%ズームで確認する。
2. キーボード操作、Focus表示、Reduced Motion、Canvasなしを確認する。
3. Dark/Light面で本文4.5:1、主要な大文字3:1以上を確認する。
4. 実ゲーム中のフレーム時間とDOM更新量を計測する。

---

## 14. 完了条件

- [ ] すべてのウィンドウ外周に常設の枠線がない。
- [ ] Solid面またはGlassのぼけだけで境界が判別できる。
- [ ] 第二版のEditorial Serif副題が復帰している。
- [ ] 初期アクセントが`#FF4B1F`で、スライダーからHEXを取得できる。
- [ ] 余白が4 / 6 / 10 / 14 / 20 / 28 / 42pxを中心に構成される。
- [ ] Window radiusが34px、Feature radiusが48pxである。
- [ ] 生成背景に抽象形状、粒子、ぼけ、ピクセルノイズ、モザイクがある。
- [ ] Reduced Motionで生成背景が静止する。
- [ ] タイトルに変則改行、インデント、上付き・下付き記号がある。
- [ ] 通常UIの本文へ意匠記号が混入していない。
- [ ] 12 UI icon + 15 World markerが揃う。
- [ ] すべての採用書体がOFL 1.1で自己配信可能である。
- [ ] JSON manifestがHTMLの表示と一致する。

---

## 15. 参考資料

### 参照サイトと公式事例

- [Lusion](https://lusion.co/)
- [Oryzo — 3D Design and Motion Graphics](https://blog.lusion.co/oryzo-bts-part-2-7-3d-design-and-motion-graphics)
- [Oryzo — Website UX/UI and Illustrations](https://blog.lusion.co/oryzo-bts-part-3-7-website-ux-ui-and-illustrations)
- [nk.studio](https://www.nk.studio/)
- [An office born from our website](https://www.nk.studio/news/an-office-born-from-our-website/)
- [A new website, the best way to celebrate these 15 years](https://www.nk.studio/news/a-new-website-the-best-way-to-celebrate-this-15-years/)
- [Locomotive](https://locomotive.ca/)
- [PP Fragment](https://locomotive.ca/en/work/pp-fragment)
- [Editorial New](https://locomotive.ca/en/work/editorial-new)

### 書体とライセンス

- [Arimo](https://github.com/googlefonts/Arimo)
- [Zen Kaku Gothic Antique](https://github.com/googlefonts/zen-kakugothic)
- [Cormorant Garamond](https://github.com/CatharsisFonts/Cormorant)
- [Zen Old Mincho](https://github.com/googlefonts/zen-oldmincho)
- [IBM Plex](https://github.com/IBM/plex)
- [SIL Open Font License 1.1](https://openfontlicense.org/)
