# タイポグラフィ・ロゴタイプ・記号体系 改修案 第二版

## 文書の位置づけ

本書は、[第一版](TYPOGRAPHY_LOGOTYPE_SYMBOL_PROPOSAL.md)を次の決定に基づいて改訂した実装前の
デザイン仕様である。

1. 本番へ組み込む書体は、自己配信・ソフトウェア同梱が可能なSIL Open Font License 1.1の書体に限る。
2. CUI、ログ、技術値にはIBM Plex Monoを使う。
3. タイトル、サブタイトル、通常文、補助ラベルの色を役割として定義する。
4. 他のAIと実装者が一ページで全規則を参照できる静的HTML標本を正規の補助資料として持つ。

この第二版は書体候補を比較する文書ではなく、最初の実装と標本作成に使う採用案である。実装後に
確定した規則は `DESIGN-RULES.md` と `theme.ts` へ移す。

対応する標本:
[タイポグラフィ・ロゴタイプ・UI標本 第二版](typography-logotype-symbol-mockup-v2.html)

---

## 1. 採用する書体

| 役割 | ラテン文字・数字 | 日本語 | ライセンス | 用途 |
| --- | --- | --- | --- | --- |
| Neutral Sans | Arimo Variable | Zen Kaku Gothic Antique | SIL OFL 1.1 | ロゴ本体、通常UI、本文、見出し |
| Editorial Serif | Cormorant Garamond | Zen Old Mincho | SIL OFL 1.1 | 副題、章扉、静かな説明 |
| Console Mono | IBM Plex Mono | Zen Kaku Gothic Antique | SIL OFL 1.1 | CUI、ログ、座標、技術値 |
| Symbols | 独自SVG | 独自SVG | プロジェクト資産 | UIアイコン、マーカー、照準 |

### 1.1 Arimo Variable

HelveticaそのものはOFLではないため採用しない。主Sansには、Arialとメトリクス互換で画面可読性を
意図して設計され、OFLで公開されているArimoを使う。Helveticaと同一ではないが、ネオグロテスクの
中立性、文字幅、数字の扱いやすさという本プロジェクトが必要とする部分を満たす。

- ロゴ・大見出し: 400。背景が単純な場合だけ軽く見える400のまま字間で調整する。
- ウィンドウ題名: 600。
- 本文・HUD: 400。
- 小ラベル: 600。
- 更新値: `font-variant-numeric: tabular-nums lining-nums`。

ウェイト100や300のような極細を求めない。OFL版の範囲内で、色、余白、字間、サイズによって
クラシックな静けさを作る。

### 1.2 Zen Kaku Gothic Antique

通常の日本語にはZen Kaku Gothic Antiqueを使う。古典的でオーソドックスな字形を持ち、
大ぶりで均一なUD書体の印象を主役にしない。

- 通常文: 400。
- ウィンドウ題名・短い強調: 500。
- 太い警告が必要な場合: 700。ただし色とアイコンを先に使う。
- 日本語へ欧文と同じ広いletter-spacingを適用しない。

### 1.3 Cormorant Garamond / Zen Old Mincho

Apple Garamondを直接再現する商用書体は使わず、古典的な副語彙としてCormorant Garamondと
Zen Old Minchoを採用する。

- Cormorant Garamond Light 300: 24px以上の英語副題、章扉。
- Cormorant Garamond Regular 400: 小さめの短い副題。
- Zen Old Mincho 400: 日本語副題、短い叙述。
- Zen Old Mincho 500: 明るい背景や細線が痩せる環境。

明朝・セリフは通常HUD、ボタン、ログ、警告、長い操作説明には使わない。

### 1.4 IBM Plex Mono

機械、端末、研究、診断の文脈はIBM Plex Monoに統一する。JetBrains MonoとHackGenは第二版の
採用書体から外す。

- Console本文: 400。
- Console見出し・入力プロンプト: 500。
- 診断コード・強調値: 600。
- 斜体: コメント、推定値、未確定値にだけ使う。

IBM Plex Monoは日本語グリフを担当しない。混在文ではZen Kaku Gothic Antiqueへフォールバックする。
この組み合わせはCUIの視覚表現用であり、半角2文字=全角1文字の厳密な端末グリッドを契約しない。
将来本物の固定桁端末を実装する場合は、その機能だけの別要件として日本語等幅書体を選定する。

---

## 2. CSSファミリー

```css
--font-ui:
  "Arimo Variable", Arimo,
  "Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Yu Gothic",
  sans-serif;

--font-editorial:
  "Cormorant Garamond",
  "Zen Old Mincho", "Hiragino Mincho ProN", "Yu Mincho",
  serif;

--font-console:
  "IBM Plex Mono",
  "Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", "Yu Gothic",
  monospace;
```

ラテン書体を先に置き、その書体が持たない日本語グリフだけ和文書体へ落とす。記号の欠落時に
絵文字フォントへ落ちることを避け、操作記号はSVG、数式記号は対応グリフを実測して使う。

---

## 3. 色の役割

文字色を単なる明度段階ではなく、情報階層として定義する。タイトルと通常文は同じわずかな色相を共有し、
サブタイトルだけに高彩度の蛍光色を与える。

### 3.1 Dark surface

| トークン | 値 | 役割 |
| --- | --- | --- |
| `INK_TITLE_DARK` | `#eeeaf5` | わずかに紫を含むモノトーン級タイトル |
| `INK_BODY_DARK` | `#c3bec9` | 同じ色相を灰色へ寄せた通常文 |
| `INK_MUTED_DARK` | `#89838f` | 補助情報、小ラベル |
| `INK_FAINT_DARK` | `#5f5a65` | 非選択、無効、罫線近傍 |
| `INK_BRIGHT_DARK` | `#ffffff` | 選択中の値、重要な数値 |
| `FLUORESCENT_DARK` | `#ff5a00` | サブタイトル、現在位置、短い注目語 |

### 3.2 Light surface

| トークン | 値 | 役割 |
| --- | --- | --- |
| `INK_TITLE_LIGHT` | `#17141b` | わずかに紫を含む黒系タイトル |
| `INK_BODY_LIGHT` | `#514c56` | 同じ色相を灰色へ寄せた通常文 |
| `INK_MUTED_LIGHT` | `#7b7480` | 補助情報、小ラベル |
| `INK_FAINT_LIGHT` | `#aaa2ad` | 非選択、無効、薄い罫線 |
| `INK_BRIGHT_LIGHT` | `#08070a` | 選択中の値、重要な数値 |
| `FLUORESCENT_LIGHT` | `#e94700` | 白地でも輪郭を失わない蛍光オレンジ |

### 3.3 運用規則

- タイトルはほぼ白またはほぼ黒で、彩度を目立たせない。色味は白黒と並べて初めて分かる程度にする。
- 通常文はタイトルと同じ色相を保ち、明度差と灰色化で階層を作る。
- 暗色面では白系、明色面では黒系を使う。背景と文字を同時に中間灰色へ寄せない。
- 蛍光色は副題、選択中の短語、現在位置に限り、一画面の文字面積の10%未満にする。
- 蛍光色を小さい本文、長文、無効状態、危険状態の唯一の符号に使わない。
- 危険は既存の赤系、軌道3軸は青・緑・赤を維持し、ブランド蛍光色と意味を混ぜない。
- タイトルと副題の色関係はフォントの関係より優先する。副題がSansでも蛍光、Serifでも蛍光とする。

---

## 4. サイズと文字組

| ロール | サイズ | 書体 | ウェイト | 色 |
| --- | --- | --- | --- | --- |
| Brand XL | `clamp(44px, 8vw, 88px)` | Arimo | 400 | Title |
| Brand Subtitle | `clamp(18px, 2.4vw, 28px)` | Cormorant / Zen Old Mincho | 300 / 400 | Fluorescent |
| Display L | `clamp(28px, 4.5vw, 48px)` | Arimo / Editorial | 400 | Title |
| Window | 15px | Arimo / Zen Kaku | 600 / 500 | TitleまたはBody |
| Body | 16px | Arimo / Zen Kaku | 400 | Body |
| HUD | 14px | Arimo / Zen Kaku | 400 | Body / Bright |
| Label | 12px | Arimo / Zen Kaku | 600 / 500 | Muted |
| Micro | 11px | Arimo / Zen Kaku | 600 / 500 | Muted |
| Console | 13px | IBM Plex Mono | 400 | Body / Bright |

- 9pxと10pxを使わない。11pxは操作を持たない補助情報の下限とする。
- 英大文字のLabelは`0.06em`〜`0.10em`、Brandの小行は最大`0.16em`。
- `TEPUI` は`-0.03em`〜`0`から実寸で決める。
- 日本語本文とConsoleは`letter-spacing: 0`。
- 数字が更新されるHUDは表形式数字、文章中は比例数字を許可する。
- `−`、`×`、`Δv`、`Ω`、`ω`、`μ`、`m/s²`を採用フォントで確認する。

---

## 5. ロゴタイプ

### 5.1 Primary

```text
DIVE INTO
TEPUI
THE ORBIT IS THE BATTLEFIELD
```

- `TEPUI`: Arimo 400、Title色。文字高の主役。
- `DIVE INTO`: Arimo 600、Title色、`0.16em`前後の字間。
- 英語副題: Cormorant Garamond 300、Fluorescent色。
- 日本語副題: Zen Old Mincho 400、Fluorescent色。英語副題とは別行にする。
- オレンジは副題と短い基準線だけに使い、`TEPUI`本体を着色しない。

### 5.2 Compact

144px未満では`TEPUI`だけを表示する。faviconやアプリアイコンに文字を押し込まず、ロゴ確定後に
軌道面とTの縦画を抽象化した専用シンボルを設計する。

### 5.3 禁止

- 蛍光色のグローを正式ロゴへ焼き込む。
- 文字を切断して疑似宇宙書体にする。
- `E`を三本線、`I`をロケット、`O`を惑星へ置き換える。
- Arimoを横圧縮してApple Garamond風に見せる。
- タイトルと副題を同じウェイト、同じ彩度、同じ大きさにする。

確定ロゴはOFLの条件と予約名を確認し、SVGパスとして同梱できる。フォントファイルを改変して再配布する
場合だけでなく、未改変ファイルを同梱する場合もOFL本文と著作権表示を残す。

---

## 6. 記号体系

第一版の「実体=塗り、方向=矢、軌道点=中空」という分類を維持する。Unicode記号ではなく、
`viewBox="0 0 24 24"`のSVGを正本とする。

### 6.1 UI icon

- 24pxグリッド、基本線幅1.5。
- 直線はsquare cap、幾何形はmiter join。
- 16px版は細部を減らした別パスを許可する。
- 選択は蛍光色、危険は赤、無効はMuted/Faintで示す。
- SVGは原則`aria-hidden`、操作要素に可視名または`aria-label`を付ける。
- 見た目24pxとタッチ領域44pxを分ける。

### 6.2 World marker

| 族 | 形 | 例 |
| --- | --- | --- |
| Entity | 塗りまたは中心を持つ形 | 船、天体、弾薬 |
| Direction | 鏃・軸・回転対 | prograde、retrograde、target |
| Orbit point | 中空の閉形 | apsis、AN/DN、maneuver node |
| Prediction | 開いた形・破線 | ghost、preview |
| Hazard | 交差・欠損 | impact、reentry、occlusion |

マーカーの色はモノトーンを既定とし、注目対象だけ蛍光オレンジ、軌道3軸だけ青・緑・赤とする。
蛍光オレンジを「副題」と「ゲーム中の現在注目」の共通ブランド語彙として使う。

---

## 7. 静的HTML標本の契約

`DEVELOP/typography-logotype-symbol-mockup-v2.html` は、画像ではなく動作するデザイン資料である。
次を一ページに含める。

1. Dark / Light両面のPrimary・Compactロゴ。
2. 全5書体、全採用ウェイト、ラテン・数字・日本語・軌道記号の見本。
3. Brand / Subtitle / Window / Body / HUD / Label / Micro / Consoleの実寸。
4. タイトル、通常文、Muted、Bright、Fluorescentの色見本。
5. パネル、ボタン、タブ、入力、メーター、通知、HUD値、Consoleログ。
6. UI iconとWorld markerのSVG一覧。
7. 良い組み方・避ける組み方。
8. CSSトークンと、AIが読めるJSON形式のdesign-system manifest。
9. 書体名、役割、OFLライセンス、上流URL。

標本は比較UIではない。第二版の一つの決定を実装し、画面内のすべての例が同じ規則に従う。
標本のGoogle Fonts読込は確認用であり、本番ゲームはFontsourceまたは上流配布物からWOFF2を自己配信する。

---

## 8. 本番への組み込み

### Phase 1 — フォント資産

1. Arimo Variable Latin、IBM Plex Mono LatinをWOFF2で自己配信する。
2. Zen Kaku Gothic AntiqueとZen Old Minchoは使用ウェイトと文字集合を決める。
3. `public/fonts/`または専用asset moduleにOFL本文と著作権表示を置く。
4. 外部CDNを本番から除く。
5. 旧JetBrains Mono/HackGen依存は全画面移行後に削除する。

### Phase 2 — 意味トークン

`theme.ts`へ次を追加する。

```text
FONT_FAMILY_UI
FONT_FAMILY_EDITORIAL
FONT_FAMILY_CONSOLE
INK_TITLE / INK_BODY / INK_MUTED / INK_FAINT / INK_BRIGHT
FLUORESCENT
TYPE_BRAND_XL / TYPE_BRAND_SUBTITLE / TYPE_DISPLAY_L
TYPE_WINDOW / TYPE_BODY / TYPE_HUD / TYPE_LABEL / TYPE_MICRO / TYPE_CONSOLE
```

Dark/Lightテーマを導入する場合も、コンポーネントが色値を直接持たず、同じ意味トークンを参照する。

### Phase 3 — UI移行

1. ローディング、ステージ選択、結果画面からPrimaryロゴを適用する。
2. HUDとウィンドウをNeutral Sansへ移す。
3. ログ、診断、技術値だけにConsole classを付ける。
4. 9〜10pxの文字をLabel/Microへ統合する。
5. 記号をUnicodeからSVGへ族単位で置き換える。

### Phase 4 — 検証

- `document.fonts.check()`で3ファミリーと使用ウェイトを確認する。
- `font-synthesis: none`で不足ウェイトを検出する。
- 375×667、667×375、768×1024、1280×720、1440×900を確認する。
- Dark / Light双方でタイトル、本文、蛍光副題のコントラストを確認する。
- 初期フォント5ファイル以下、3.5MB以下を目標とする。
- 記号は16 / 24 / 32px、高DPI、モノクロ、色覚差で確認する。

---

## 9. 完了条件

- 本番に組み込むすべての書体がSIL OFL 1.1で、ライセンス本文を同梱している。
- 通常UIがArimo / Zen Kaku Gothic Antique、技術文脈がIBM Plex Monoへ明示的に分かれている。
- タイトルは低彩度、サブタイトルは蛍光色、通常文はタイトルと同色相の灰色という関係を守る。
- 9〜10pxの操作・判断用文字がない。
- ロゴがDark / Light / Compactで同じ構造を持つ。
- UI iconとWorld markerがUnicode字形へ依存しない。
- 静的HTML標本とdesign-system manifestが実装済みの規則に一致している。
- 確定規則が `DESIGN-RULES.md` と `theme.ts` に移されている。

---

## 10. 参考資料

- [Arimo — 公式GitHub](https://github.com/googlefonts/Arimo)
- [IBM Plex — IBM公式GitHub](https://github.com/IBM/plex)
- [Cormorant — 公式GitHub](https://github.com/CatharsisFonts/Cormorant)
- [Zen Kaku Gothic Antique — Google Fonts](https://fonts.google.com/specimen/Zen+Kaku+Gothic+Antique)
- [Zen Old Mincho — Google Fonts](https://fonts.google.com/specimen/Zen+Old+Mincho)
- [SIL Open Font License 1.1](https://openfontlicense.org/open-font-license-official-text/)

