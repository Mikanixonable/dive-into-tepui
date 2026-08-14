# UIデザインシステム改修案 第三版

## 文書の位置づけ

本書は、[第二版](TYPOGRAPHY_LOGOTYPE_SYMBOL_PROPOSAL_V2.md)で定めたタイポグラフィ、ロゴタイプ、
記号体系を、ウィンドウ、階層、状態、入力、オーバーレイ、動きまで含むUIデザインシステムへ拡張する
実装前仕様である。

第三版では次を決定する。

1. 通常UIはモノトーンを正本とし、ブランドアクセントを一色へ限定する。
2. ウィンドウを角丸にし、用途を限定したSolid / Glass / Frostedの3表面を持つ。
3. 補助説明、太字、斜体を意味のある文字ロールとして定義する。
4. 3D、画像、明暗が変化する背景上の大見出しは、背景に応じて反転するAdaptive Contrastを使う。
5. Lusion、/nk.studio、Locomotiveから構成原理を抽出するが、書体、ロゴ、画像、固有の演出は複製しない。
6. 人間向け標本と機械可読manifestを同じ静的HTMLへ収録する。

対応する標本:
[UI・タイポグラフィ・ロゴタイプ標本 第三版](typography-logotype-symbol-ui-mockup-v3.html)

本書は提案であり、現行実装の正本は引き続き `DESIGN-RULES.md` と `src/game/theme.ts` である。
第三版を本番へ適用するときは、本書の決定を両ファイルへ段階的に移す。

---

## 1. 参照サイトの調査

### 1.1 調査方法と範囲

2026-08-14時点の次の公式サイトについて、ホーム、About / Work相当ページ、公開HTML/CSS、公式の
ソーシャルプレビュー、外部の掲載資料を照合した。

- [Lusion](https://lusion.co/)
- [/nk.studio](https://www.nk.studio/)
- [Locomotive](https://locomotive.ca/en)

調査対象は、配色、書体の役割、ロゴタイプ、表示階層、背景と文字の関係、ナビゲーション、ボタン、
カード、角丸、透過、ぼかし、状態表現、動きである。サイト内容は更新され得るため、色値や実装名は
調査時点の観察値であり、本プロジェクトの依存先にはしない。

### 1.2 Lusionから抽出する要素

[Lusion公式サイト](https://lusion.co/)は、大きなニュートラルSansと没入型3Dを主役にし、恒常UIを
白黒と小さな幾何記号へ抑えている。公開CSSではAeonik、IBM Plex Mono、独自Monoを文脈で分け、
丸いCTA、丸いトグル、角丸の映像面を組み合わせている。

抽出する原理:

- 背景が複雑でも、ロゴと大見出しの字形自体は簡素に保つ。
- 大きな表示文字と小さなMonoメタデータを対比させる。
- 十字、点、細線を位置合わせと状態の補助記号として使う。
- CTAは短い動詞、点、矢印を持つピル形とし、説明文をボタンへ入れない。
- 3Dや映像の色をUIの恒常アクセントへ持ち込まない。

本案への翻訳:

- Aeonikは採用せず、OFLのArimoへ置き換える。
- LusionのIBM Plex Monoによる技術メタデータの使い分けは継承する。
- 3D背景の色はコンテンツ色、UIはモノトーン、選択だけオレンジとする。

### 1.3 /nk.studioから抽出する要素

[/nk.studio公式サイト](https://www.nk.studio/)は、調査時点でDM Sans、近黒 `#070b0a`、オフ白
`#fdfdf9`、ミント `#00ffc2`を軸にしている。[Awwwards掲載](https://www.awwwards.com/sites/nk-studio)
でも、暗いシネマティック背景、白い大見出し、一色の発光記号という関係が確認できる。公開CSSには
10〜24px程度の角丸、6〜24pxを中心とするbackdrop blur、difference / overlay系の合成が見られる。

抽出する原理:

- ロゴの一画だけを強い色にし、本文とナビゲーションは白黒へ戻す。
- ぼかしたカードでも、縁と文字のコントラストを失わない。
- 一つのアクセントを下線、選択数、フォーカス、短い状態表示へ再利用する。
- 大見出し、短い説明、CTAの三段で第一画面を構成する。
- 曲線はウィンドウ、ピル、丸ボタンへ集中させ、本文レイアウト自体はグリッドで整える。

本案への翻訳:

- DM Sansとミントは採用せず、Arimoと既存オレンジへ置き換える。
- Glass表面は透過だけにせず、縁、blur、フォールバック不透明面を一組にする。
- アクセントの面積制限と意味の固定を強化する。

### 1.4 Locomotiveから抽出する要素

[Locomotive公式サイト](https://locomotive.ca/en)は、Helvetica Now Displayと独自Displayを使い、
黒白、赤、青をセクション単位で大胆に切り替える。大見出しとヘッダには
`mix-blend-mode: difference`が使われ、背景色が変わっても文字が反転する。大きな文字、12列グリッド、
短いナビゲーション、コンテンツごとの背景色が中心で、装飾的なパネルを大量には置かない。

抽出する原理:

- 背景を跨ぐ大見出しは、固定色ではなく反転合成で連続性を保つ。
- 画面全体の色変更と、操作UIの状態色を分ける。
- 極端に大きい見出しと通常サイズの本文の間を、中途半端な装飾で埋めない。
- ロゴ、見出し、短い単語を同一グリッド上に反復してリズムを作る。
- 角丸は小さな操作部品や一時面へ使い、全セクションをカード化しない。

本案への翻訳:

- 商用・独自書体は採用せず、ArimoとCormorant Garamondで表示階層を作る。
- Adaptive ContrastをDisplay専用機能として採用する。
- セクションごとの多色切替は採用せず、明暗の切替とオレンジ一色へ縮約する。

### 1.5 三者に共通する構成原理

| 共通要素 | 抽出した原理 | Dive into Tepuiでの採用 |
| --- | --- | --- |
| 大きなSans見出し | 背景より先に情報階層を読ませる | Arimo 400、44〜88px |
| 小さな技術文字 | 大見出しと機械情報を対比する | IBM Plex Mono、11〜13px |
| 背景追従文字 | 動画・3Dを隠さず可読性を保つ | Displayだけdifference |
| 少数色 | 色を装飾でなく状態として使う | 白黒灰 + Orange |
| 丸い操作部品 | 行為とコンテンツ面を識別する | Button / Chip / Window |
| 透明面 | 背景との連続性を残す | Glass / Frostedを限定使用 |
| 大きな余白 | 背景演出と情報を競合させない | 8px系の余白スケール |
| 控えめな恒常UI | シーンを主役にする | レール、HUD、パネルを低彩度化 |

採用しないもの:

- 参照サイトのロゴ字形、画像、3Dオブジェクト、アニメーションの模写。
- 複数のネオン色を画面ごとに切り替える運用。
- すべての文字を巨大化すること、すべての面をGlassにすること。
- スクロールサイト固有の遅いトランジションを、即応性が必要なゲーム操作へ持ち込むこと。

---

## 2. 第三版のデザイン原則

### 2.1 Scene first, interface quiet

地球、軌道、宇宙船、破片が主役であり、恒常UIは黒白灰の静かな層として置く。UIが独自の色彩風景を
作らず、ゲーム世界の色を読み取るための枠になる。

### 2.2 One accent, many neutral states

通常UIのブランドアクセントはOrange一色とする。Hover、Selected、Focus、Current、Progressを
同じOrange系の線、文字、薄膜で表す。別の状態は明度、太さ、面、線種、記号で区別する。

例外:

- Danger / destructive actionの赤。
- Prograde / Normal / Radialの物理軸色。
- 複数ターゲットなど、ゲーム意味上どうしても同時識別が必要な色。

例外色はブランドアクセントではなくDomain colorとして管理し、一般ボタンや装飾へ流用しない。
現行の `ACCENT_SECONDARY` は一般UIアクセントから外し、必要ならTarget domain tokenへ改名する。

### 2.3 Context before decoration

Glass、Italic、Mono、Accentは、見た目を変えるためではなく意味を区別するために使う。

- Glass: 背景との位置関係を残す浮遊UI。
- Italic: 引用、推定、補足、物語的な副題。
- Mono: 機械が出力する座標、時刻、ログ、コマンド。
- Accent: 現在の操作対象、進行、フォーカス。

---

## 3. カラーシステム

### 3.1 Dark theme

| Token | Value | Role |
| --- | --- | --- |
| `BG_DARK` | `#08090c` | ゲーム外周、最深面 |
| `SURFACE_SOLID_DARK` | `rgba(13,15,18,.94)` | 読み取り主体の通常窓 |
| `SURFACE_GLASS_DARK` | `rgba(13,15,18,.56)` | シーン上の浮遊窓 |
| `SURFACE_FROST_DARK` | `rgba(24,25,29,.72)` | モーダル、短時間の集中面 |
| `EDGE_DARK` | `rgba(238,235,248,.22)` | 通常縁 |
| `EDGE_GLASS_DARK` | `rgba(255,255,255,.28)` | Glassの光側縁 |
| `TEXT_TITLE_DARK` | `#eeeaf5` | 見出し、窓題名 |
| `TEXT_BODY_DARK` | `#c3bec9` | 本文、通常値 |
| `TEXT_AUX_DARK` | `#918b97` | 補助説明、メタデータ |
| `TEXT_FAINT_DARK` | `#625d68` | 非選択、装飾的な補助 |
| `TEXT_STRONG_DARK` | `#ffffff` | 現在値、最重要値 |
| `ACCENT_DARK` | `#ff6a00` | 選択、焦点、進行 |

### 3.2 Light theme

| Token | Value | Role |
| --- | --- | --- |
| `BG_LIGHT` | `#f3f0ed` | 明色の最深面 |
| `SURFACE_SOLID_LIGHT` | `rgba(250,248,245,.94)` | 通常窓 |
| `SURFACE_GLASS_LIGHT` | `rgba(250,248,245,.62)` | 明色Glass |
| `SURFACE_FROST_LIGHT` | `rgba(240,236,232,.78)` | モーダル |
| `EDGE_LIGHT` | `rgba(23,20,27,.20)` | 通常縁 |
| `EDGE_GLASS_LIGHT` | `rgba(255,255,255,.72)` | Glassの光側縁 |
| `TEXT_TITLE_LIGHT` | `#17141b` | 見出し、窓題名 |
| `TEXT_BODY_LIGHT` | `#514c56` | 本文、通常値 |
| `TEXT_AUX_LIGHT` | `#6f6873` | 補助説明、メタデータ |
| `TEXT_FAINT_LIGHT` | `#aaa2ad` | 非選択、装飾的な補助 |
| `TEXT_STRONG_LIGHT` | `#08070a` | 現在値、最重要値 |
| `ACCENT_LIGHT` | `#bd4200` | 白地で通常文字のコントラストも保つ選択色 |

### 3.3 アクセントの予算

- 通常状態の画面面積では3%以下、文字面積では8%以下を目安とする。
- Display Subtitleを常にOrangeにする第二版の規則は廃止する。通常はTitle / Body系のモノトーンとし、
  Orangeは現在の操作や短いブランド句に限る。
- 一つのコンポーネントで、Orangeの文字、縁、塗りを同時に最大強度で使わない。
- Hoverは明度と縁、SelectedはOrange、PressedはNeutral fill、FocusはOrange outlineで区別する。
- Orangeのグローは短時間のフォーカスまたはゲーム世界マーカーに限り、正式ロゴと本文には使わない。

---

## 4. タイポグラフィ

### 4.1 書体

第二版のOFL採用を維持する。

| Context | Latin / Numerals | Japanese | Main weights |
| --- | --- | --- | --- |
| Neutral UI | Arimo | Zen Kaku Gothic Antique | 400 / 600 / 700 |
| Editorial | Cormorant Garamond | Zen Old Mincho | 300 / 400 / 500 |
| Console | IBM Plex Mono | Zen Kaku Gothic Antique fallback | 400 / 500 / 600 |

本番ではWOFF2を自己配信し、OFL本文と著作権表示を同梱する。`font-synthesis: none`を指定する。

### 4.2 文字ロール

| Role | Size / weight | Color | Meaning |
| --- | --- | --- | --- |
| Display XL | 44〜88 / 400 | AdaptiveまたはTitle | 起動画面、章題 |
| Display Subtitle | 18〜28 / 300〜400 | AdaptiveまたはBody | 短い副題 |
| Window Title | 15 / 600 | Title | ウィンドウ名 |
| Body | 16 / 400 | Body | 通常説明 |
| HUD | 14 / 400 | Body / Strong | 判断に必要な値 |
| Auxiliary | 12〜13 / 400 | Aux | 補足、出典、二次説明 |
| Label | 12 / 600 | Aux | 項目名、制御名 |
| Micro | 11 / 600 | Faint / Aux | 非操作的な補助のみ |
| Console | 13 / 400〜500 | Body / Strong | ログ、座標、機械出力 |

### 4.3 Auxiliary / 補助説明

- 本文より1〜3px小さく、同色相を灰色へ寄せた `TEXT_AUX` を使う。
- 行間は1.45〜1.6、1行70字程度を上限にする。
- 操作結果、危険、唯一の入力条件をAuxiliaryだけに書かない。
- 不透明度だけで薄くせず、確定した色トークンを使う。Glass上では最低コントラストを再確認する。
- 11px未満にしない。11pxは非操作のMicro専用とする。

### 4.4 Strong / 太字

- UIの標準強調は600。700は結果画面の短い語、破壊的確認の動詞などに限定する。
- ウィンドウ題名、選択中の一語、数値の主値、短いCTAに使う。
- 一段落全体、複数行の説明、全表セルを太字にしない。
- 色と太字を同時に使うのは、現在選択中の短い要素だけとする。
- 日本語はZen Kaku 500 / 700、ラテンはArimo 600 / 700。合成太字を禁止する。

### 4.5 Italic / 斜体

- Cormorant Garamond Italic: 章副題、引用、物語的な短い注釈。
- Arimo Italic: 推定値、仮定、まだ確定していない短い補足。
- IBM Plex Mono Italic: コメント、予測、未確定の機械出力。
- 日本語をCSSで機械的に傾けない。日本語のEditorial補足はZen Old Minchoへ切り替え、傾けない。
- 警告、ボタン、長文、数値列、操作ラベルを斜体にしない。
- 斜体だけを唯一の状態符号にせず、語、記号、色またはラベルを併用する。

---

## 5. Adaptive Contrast Display

### 5.1 用途

3Dシーン、動画、明暗が連続的に変わる大きな背景の上を、タイトルまたはサブタイトルが横断するときに
使う。Locomotiveの背景反転見出しと、Lusion / /nk.studioのシーン上ロゴから抽出した規則である。

```css
.display-adaptive {
  color: #fff;
  mix-blend-mode: difference;
}
```

### 5.2 制約

- Display XL / Display Subtitle / 大きなロゴだけに使う。
- 本文、Auxiliary、小ラベル、入力値、照準、危険表示には使わない。
- 同じstacking context内でだけ背景を参照するため、親の`isolation`とz-indexを明示する。
- 反転結果が中間灰色や色付き背景で弱くなる場合は、半透明scrimまたは通常のTitle色へ切り替える。
- `mix-blend-mode`非対応、印刷、forced-colorsでは通常の高コントラスト文字へフォールバックする。
- 動きのある背景では文字自体を動かさず、背景の変化だけを受ける。

Adaptiveは色を増やす機能ではない。背景が白なら黒、黒なら白に近づけるモノトーンの可読性機構として
扱う。

---

## 6. ウィンドウと表面

### 6.1 角丸スケール

| Token | Value | Use |
| --- | --- | --- |
| `RADIUS_XS` | 4px | 細いバー、極小バッジ |
| `RADIUS_S` | 8px | 入力、通常ボタン、セル |
| `RADIUS_M` | 12px | メニュー、カード、小窓 |
| `RADIUS_L` | 18px | 通常ウィンドウ、モーダル |
| `RADIUS_XL` | 28px | ボトムシート上端、大きな紹介面 |
| `RADIUS_PILL` | 999px | CTA、状態チップ、トグル |

- ウィンドウ外周は原則18px。内部セルは8〜12pxとし、外周より大きくしない。
- 連結タブや表の各行を個別カードにしない。
- 画面端へ接するボトムシートは上角だけ28px、全画面面は角丸なしを許可する。
- 円はアイコンボタン、ノブ、点マーカーだけに使う。

### 6.2 Solid Window

用途: 軌道要素、設定、一覧、長い説明、精密な入力。

- 背景不透明度0.92〜0.96。
- 1px Neutral edge。
- blurなし。
- 長時間読む文字と細い数値を優先する。
- 影は原則なし。シーンと重なる浮遊窓だけ弱い接地影を許可する。

### 6.3 Glass Window

用途: シーン上の短い情報、ツールパレット、追従プロパティ窓、コンテキストUI。

```css
.window-glass {
  background: rgba(13, 15, 18, .56);
  border: 1px solid rgba(255, 255, 255, .28);
  border-radius: 18px;
  backdrop-filter: blur(18px) saturate(110%);
}
```

- 背景が見えること自体に位置関係の価値がある場合だけ使う。
- Glassの中へGlassを入れない。
- 本文が4行を超える、表がある、入力が連続する場合はSolidへ切り替える。
- blurは12 / 18 / 28pxの3段。コンポーネントごとの任意値を作らない。
- `backdrop-filter`非対応時は `SURFACE_SOLID` へフォールバックする。
- 輪郭は明るい上縁とNeutral edgeで作り、派手な白グローを使わない。

### 6.4 Frosted Focus

用途: Pause、Save、確認ダイアログ、短時間だけ背景から注意を切り離す面。

- Scrim + 28px blur + 0.72〜0.82の面。
- 背景全体を完全には隠さないが、操作対象を一つへ限定する。
- Frosted面の背後は操作不可にする。
- Frostedを恒常HUDへ使わない。

### 6.5 Window anatomy

```text
┌ Window header ─ title / auxiliary / actions ┐
│ optional tabs or scope                       │
├─────────────────────────────────────────────┤
│ body: groups, rows, values                   │
│ auxiliary explanation                       │
├─────────────────────────────────────────────┤
│ optional footer: secondary / primary action │
└─────────────────────────────────────────────┘
```

- Header高は44〜52px。
- TitleとAuxiliaryを同じ行へ詰めず、上下または左右の明確な領域に分ける。
- Close / Collapse / Pinは24pxの図形、44pxのヒット領域。
- Footerは行為がある場合だけ置く。閉じるだけならHeaderのCloseで足りる。

---

## 7. UIパターン

### 7.1 Navigation

- Top rail: 現在モード、主要状態、全体操作。高さ48〜56px。
- Side rail: 折りたためる道具群。幅は既存layout tokenを正本とする。
- Tabs: 一つの窓内の表示面切替。選択はOrangeの2px線か短い点で示す。
- Breadcrumbは深い階層がある管理画面だけ。戦闘HUDでは使わない。

### 7.2 Buttons

| Variant | Default | Selected / primary |
| --- | --- | --- |
| Text | Body text、透明面 | Orange text |
| Outline | Neutral edge | Orange edge |
| Solid | Title-colored fill | Orange fillは単一CTAのみ |
| Icon | 24px icon / 44px hit | Orange iconまたはedge |
| Destructive | Neutral until confirm | Danger red at final action |

ボタンは動詞または状態名で短く書く。ピル形はPrimary CTA、Filter、Status chipに限り、通常の表セルや
すべてのボタンをピル化しない。

### 7.3 Input and selection

- 入力欄は8px角丸、Neutral edge、Solid寄りの面。
- Focusで2px Orange outlineを追加し、レイアウト寸法を変えない。
- PlaceholderはAux色。入力済み値はBody / Strong。
- ErrorはDanger edge + 明示文。赤だけで示さない。
- ToggleはOnだけOrange。OffはNeutral。Disabledは色を抜き、ラベルを残す。
- Slider / MeterはトラックをNeutral、現在値だけOrange。物理軸値はDomain colorを許可する。

### 7.4 Lists, tables, and cards

- 表と密な一覧は一つのSolid面と行罫線で構成し、各行をカードにしない。
- カードは対象が独立し、選択・移動・展開できる場合だけ使う。
- HoverはNeutral fill、SelectedはOrangeの細線と弱い薄膜。
- 主値はStrong、項目名はLabel、単位・時刻・由来はAuxiliary。
- 表形式数字を使い、単位列を揃える。

### 7.5 Overlays

- Context menu: 12px角丸のGlass、短い項目、現在対象の見出し。
- Tooltip: 8px角丸のSolid、1〜2行。ホバーだけに情報を閉じ込めない。
- Toast: 12px角丸のGlass、4秒以内、重要操作の唯一の結果にしない。
- Dialog: 18px角丸のFrosted、見出し、説明、最大2行為。
- Command palette: 18px角丸のFrosted、検索入力 + 結果一覧。将来機能として予約する。

### 7.6 Empty, loading, and unavailable

- Empty: 短い見出し、原因、次の行為。大きなイラストを必須にしない。
- Loading: 既知の処理はprogress、未知の処理は静かなpulse。無限spinnerの多用を避ける。
- Unavailable: Faint化 + 理由。単にOpacityだけを下げて終わらない。
- Error: 問題、影響、回復行為を分ける。

---

## 8. ロゴタイプと記号

### 8.1 Logotype

第二版のPrimary / Compact構成を維持する。

```text
DIVE INTO
TEPUI
THE ORBIT IS THE BATTLEFIELD
```

- 安定した単色面: TEPUIはTitle、短い副題はBodyまたは限定的Orange。
- 3D / 動画 / 明暗混在面: TEPUIと副題をAdaptive Contrastへ切り替える。
- 正式ロゴへGlass、blur、glowを焼き込まない。効果は配置コンテナの責務とする。
- CompactはTEPUIだけ。144px未満の領域を基準とする。

### 8.2 Symbols

第二版の24px SVG体系を維持する。

- UI icon: 24px grid、1.5px stroke、square cap / miter join。
- Entity: 塗りまたは中心。
- Direction: 軸または矢。
- Orbit point: 中空の閉形。
- Prediction: 開いた形または破線。
- Hazard: 交差または欠損。

記号の選択状態はOrange、危険はDanger、物理軸はDomain color。記号へGlassやblend modeを直接
適用せず、所属するボタンまたはマーカーコンテナが表面とコントラストを管理する。

---

## 9. Motion

- Control response: 120〜160ms。色、縁、押下の即応。
- Overlay enter / exit: 220〜320ms。opacity + 8〜16pxの移動。
- Layout transition: 320〜480ms。レール、シート、展開。
- Ambient background: 8秒以上。ゲーム状態と競合しない低速変化。
- `backdrop-filter`値そのものを連続アニメーションしない。GPU負荷とちらつきを避ける。
- Display Adaptiveの文字は固定し、背景側だけが動く。
- `prefers-reduced-motion: reduce`では移動、parallax、ambientを止め、短いopacityだけにする。

参照サイトのスクロール演出は、情報の順序を見せる表現として研究する。ゲーム中の照準、推力、射撃、
ウィンドウ操作へ遅延や慣性を加える根拠にはしない。

---

## 10. Accessibility and resilience

- 通常本文はWCAG AA相当のコントラストを目標とする。
- Adaptive Contrastは自動的に適合を保証しない。背景の極端な中間調で実測する。
- Glass上のAuxiliaryは特に検証し、弱い場合はSolidへ切り替える。
- Focus visibleはOrange 2px + 2px offset。Hoverだけで状態を示さない。
- タップ領域は44px以上。見た目のアイコン24pxと分離する。
- 色だけで状態を示さず、形、文言、線、アイコンを併用する。
- `backdrop-filter`、`mix-blend-mode`、Web Fontが失敗しても、操作と文章が読めるフォールバックを持つ。
- `forced-colors: active`では独自背景、blur、blendを解除し、システム色へ従う。

---

## 11. 静的HTML標本の契約

`DEVELOP/typography-logotype-symbol-ui-mockup-v3.html` は次を一ページに収録する。

1. 参照3サイトから抽出した要素と、採用 / 非採用の判断。
2. Dark / Light / Adaptiveのタイトルとロゴタイプ。
3. Body / Auxiliary / Strong / Italic / Monoの文字見本。
4. Solid / Glass / Frosted Windowとフォールバック方針。
5. Top rail、Tabs、Button、Input、Toggle、Meter、List、Table。
6. Context menu、Tooltip、Toast、Dialog、Command palette。
7. Empty / Loading / Disabled / Error状態。
8. UI iconとWorld markerのSVG一覧。
9. 色、角丸、blur、余白、motionのトークン。
10. 他のAIが読めるJSON形式のdesign-system manifest。
11. OFL書体のライセンスと上流URL。

標本は参照サイトの画像やロゴを転載せず、抽出した原理をDive into Tepui固有の内容で実装する。
Google Fonts読込は確認用であり、本番では自己配信する。

---

## 12. 本番への移行計画

### Phase 1 — token vocabulary

`theme.ts`へ追加・整理する候補:

```text
SURFACE_SOLID / SURFACE_GLASS / SURFACE_FROST
EDGE_GLASS / TEXT_AUX / TEXT_FAINT
BLUR_S / BLUR_M / BLUR_L
RADIUS_XS / RADIUS_S / RADIUS_M / RADIUS_L / RADIUS_XL / RADIUS_PILL
FONT_FAMILY_UI / FONT_FAMILY_EDITORIAL / FONT_FAMILY_CONSOLE
TYPE_DISPLAY_XL / TYPE_DISPLAY_SUBTITLE / TYPE_AUXILIARY
MOTION_CONTROL / MOTION_OVERLAY / MOTION_LAYOUT / MOTION_AMBIENT
```

現行 `SURFACE_WEAK / SURFACE / SURFACE_OPAQUE` は用途名へ写像してから移行する。既存コンポーネントが
直接新値へ置換されないよう、最初に互換aliasを置く。

### Phase 2 — typography

1. Arimo / Zen Kaku Gothic Antique / Cormorant Garamond / Zen Old Mincho / IBM Plex Monoを自己配信する。
2. 現行のJetBrains Mono / HackGen全面適用を、UI / Editorial / Consoleの文脈クラスへ分ける。
3. 9px / 10pxをAuxiliary / Microへ統合する。
4. `font-weight: bold`を600 / 700トークンへ置き換える。
5. 日本語の合成斜体を禁止する。

### Phase 3 — surfaces

1. PropertyWindow / ContextMenuをGlassの試験対象にする。
2. 軌道要素、設定、Save BrowserはSolidを維持する。
3. Pause / DialogへFrostedを適用する。
4. RADIUS 3 / 4 / 8pxを新しい4 / 8 / 12 / 18 / 28px系へ段階移行する。
5. 非対応ブラウザのOpaque fallbackを実装する。

### Phase 4 — adaptive display

1. Stage selectまたはResult screenの大見出しで試験する。
2. `isolation`、背景中間調、WebGPU canvasとの合成を確認する。
3. forced-colors、screenshot、WebGPU非対応画面でfallbackを確認する。
4. 通常HUDへ適用範囲が広がっていないことを監査する。

### Phase 5 — pattern migration

1. 共有Widgetの状態語彙へNeutral / Accentの新規則を反映する。
2. ウィンドウ、メニュー、Toast、Dialogのanatomyを揃える。
3. Accent Secondaryを一般UIからDomain colorへ移す。
4. `DESIGN-RULES.md`へ確定値と禁止事項を移し、本書を設計履歴へ戻す。

---

## 13. 完了条件

- 通常画面が白黒灰を主とし、Orange以外の一般アクセントを使っていない。
- Solid / Glass / Frostedの用途がコンポーネントごとに説明できる。
- 全ウィンドウが定義済み角丸スケールを使う。
- Auxiliary / Strong / Italicが意味ロールとして実装され、単なる装飾classではない。
- Adaptive ContrastがDisplayだけに限定され、fallbackを持つ。
- Glass上の本文、Auxiliary、Focusが実画面で読める。
- 参照サイトの固有資産を複製していない。
- OFL書体とライセンス本文を自己配信している。
- 静的HTMLとmanifestが第三版の全規則を表現している。
- `DESIGN-RULES.md`と`theme.ts`へ確定規則が移されている。

---

## 14. 参考資料

### 参照サイト

- [Lusion — official](https://lusion.co/)
- [Lusion — About](https://lusion.co/about/)
- [/nk.studio — official](https://www.nk.studio/)
- [/nk.studio — Awwwards](https://www.awwwards.com/sites/nk-studio)
- [Locomotive — official](https://locomotive.ca/en)
- [Locomotive — Communication Arts Webpick](https://www.commarts.com/webpicks/locomotive)

### 書体とライセンス

- [Arimo — official GitHub](https://github.com/googlefonts/Arimo)
- [IBM Plex — official GitHub](https://github.com/IBM/plex)
- [Cormorant — official GitHub](https://github.com/CatharsisFonts/Cormorant)
- [Zen Kaku Gothic Antique — Google Fonts](https://fonts.google.com/specimen/Zen+Kaku+Gothic+Antique)
- [Zen Old Mincho — Google Fonts](https://fonts.google.com/specimen/Zen+Old+Mincho)
- [SIL Open Font License 1.1](https://openfontlicense.org/open-font-license-official-text/)
