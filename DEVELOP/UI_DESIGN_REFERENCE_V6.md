# Dive into Tepui UI Design Reference 第六版

## 0. リファレンスの役割

本書は、Dive into Tepuiの文字、ロゴタイプ、色、記号、数式、ウィンドウ、3D背景、操作、HUD、
物語画面、ネットワーク表示を定義するデザインの正本である。画面設計、実装、レビュー、AIによる生成は、
本書と対応する静的標本だけを参照して同じ美学へ到達できる。

対応する標本:
[Dive into Tepui UI Design Reference 06](ui-design-reference-v6.html)

デザイン言語は、古典的な文字の声、ニュートラルな情報設計、三色の限定された発光、Borderless Glass、
ウィンドウの内部に存在する抽象3D、TeXによる科学記法を一つの静かな系として扱う。

---

## 1. 基本原則

### 1.1 Quiet system 80, rich field 20

画面の80%は、低彩度のタイトル色、同色相の本文、ニュートラルなSans、簡潔な記号、Solid面で構成する。
残る20%に、Glass、Signal、3D、アニメーション、数式の色、変則的な文字配置を置く。

Richな要素は全画面を覆わず、タイトルウィンドウ、選択中のパネル、短い章扉、重要な物理表示へ集中させる。

### 1.2 Three-color chromatic language

主要な有彩色は三色だけで構成する。

1. Accent — 最も強い発光色。副題、選択、現在位置、主要操作。
2. Near accent — Accentと同型色で、色相または明度がわずかに異なる色。補助副題、ホバー、二段目の焦点。
3. Secondary accent — Accentと明確に異なるSignal色。同期、第二対象、通電、完了、外部入力。

危険、物理軸、陣営色などの意味色は必要な場面に限り、三色より狭い面積で使う。通常画面の視覚的な主役に
しない。

### 1.3 Classic voice, machine measure

- Neutral voice: Arimo / Zen Kaku Gothic Antique。通常UI、本文、主要タイトル、フランス語。
- Classic voice: Cormorant Garamond / Zen Old Mincho。副題、章扉、引用、静かな説明。
- Machine measure: IBM Plex Mono。CUI、座標、ログ、固定桁、診断。

数字を含むだけではMachineへ切り替えない。一般の高度、速度、日時、HPはNeutral Sansのtabular figuresを使う。

### 1.4 Window as a view into matter

タイトル級の3Dはページ背景ではなく、角丸ウィンドウの内部に置く。ウィンドウは別の空間を覗く窓として見え、
その内部に抽象立体、光、霧、タイトル、TeX、短い状態表示が存在する。

### 1.5 Recognizable symbol, controlled deconstruction

操作記号は80%を意味の取りやすい既知の骨格、20%を独自の分解、欠損、添字、接線、非対称で構成する。
最初の一秒で意味の方向が分かり、二秒目に独自性が見える形を基準とする。

### 1.6 Sentence case by default

通常の画面名、ボタン、タブ、ラベル、通知はsentence caseまたは自然な日本語で表示する。全て大文字の文言は、
端末、診断、警報電文、固定幅のCUI表示だけに限定する。UI、ECI、NRHO、LEO、L1、L2、RCS、Δvなどの略語は
通常文中でも維持する。

### 1.7 No stripes, no decorative noise field

走査線、横縞、反復線形グラデーションを使わない。背景の粒子とボケは非周期かつ低コントラストにする。
区切りには余白、面差、単一線、点、文字階層を使う。

---

## 2. レイアウトと寸法

### 2.1 サイト幅

デスクトップのコンテンツ幅は`1160px`を上限とする。ナビゲーション、タイトルウィンドウ、本文、HUD標本、
Palette Labは同じ中央軸へ揃える。

```css
--site-max: 1160px;
--reading-max: 760px;

.site-shell {
  width: min(calc(100% - 24px), var(--site-max));
  margin-inline: auto;
}
```

広い画面では要素そのものを拡大せず、外側の静かな余白を増やす。1600px以上でもタイトル、パネル、本文の
文字サイズを増やさない。

### 2.2 ブレークポイント

| View | 幅 | 構成 |
| --- | --- | --- |
| Wide | 1184px以上 | コンテンツ1160px、2–3列、タイトルウィンドウ560px高 |
| Medium | 760–1183px | 2列、HUDレール縮小、タイトルウィンドウ500px高 |
| Compact | 759px以下 | 1列、ボトムシート、タイトルウィンドウ460px高 |
| Narrow | 479px以下 | 1列、ナビ簡略、タイトル最大64px |

### 2.3 角丸と密度

| Role | Radius | Padding | Gap |
| --- | --- | --- | --- |
| Micro control | 8px | 5–8px | 4px |
| Button / input | 11px | 7–11px | 5px |
| HUD panel | 16px | 9–12px | 7px |
| Window | 22px | 13–17px | 9px |
| Rich title window | 30px | 18–26px | 12px |

角丸を維持しながら、広すぎるカード余白を作らない。

---

## 3. 書体システム

### 3.1 採用書体

すべて組み込み可能なSIL Open Font License 1.1の書体を使う。本番ではWOFF2、OFL本文、著作権表示を
自己配信する。

| ロール | ラテン・数字 | 日本語・追加文字 | ウェイト | 用途 |
| --- | --- | --- | --- | --- |
| Neutral Sans | Arimo | Zen Kaku Gothic Antique | 400 / 500 / 600 / 700 | 通常UI、本文、主要タイトル、フランス語 |
| Editorial Serif | Cormorant Garamond | Zen Old Mincho | 300 / 400 / 500 | 副題、章扉、叙述、引用 |
| Machine Mono | IBM Plex Mono | Zen Kaku Gothic Antique fallback | 400 / 500 / 600 | CUI、座標、ログ、固定桁 |
| Cantonese Display | — | Noto Serif HK | 900 | 広東語の章扉と背景文字 |
| Cuneiform / Symbol | — | Noto Sans Cuneiform / Noto Sans Symbols 2 | 400 | 索引、点字、特殊記号 |

Helveticaそのものは組み込み条件を満たさないため、主SansにはArimoを使う。Helvetica系のニュートラルな
輪郭を方向性とし、丸みを強く押し出した新しいUI書体の印象を避ける。

### 3.2 文字ロール

| 表示級 | サイズ | 書体 | ウェイト | 行高 |
| --- | --- | --- | --- | --- |
| Title XL | `clamp(48px, 8vw, 104px)` | Neutral Sans | 400 | 0.78–0.9 |
| Title L | `clamp(34px, 5.4vw, 68px)` | Neutral Sans | 400 | 0.9–1.0 |
| Subtitle | `clamp(20px, 2.8vw, 34px)` | Editorial Serif | 300 / 400 | 1.0–1.15 |
| Window | 14–15px | Neutral Sans | 500 / 600 | 1.25–1.35 |
| Body | 14–16px | Neutral Sans | 400 | 1.55–1.7 |
| Auxiliary | 11–12px | Neutral Sans | 400 | 1.5–1.65 |
| Label | 10–11px | Neutral Sans / Machine | 500 / 600 | 1.25–1.4 |
| Console | 12–13px | IBM Plex Mono | 400 | 1.45–1.6 |

タイトル級はウィンドウ内へ収め、デスクトップでも104pxを超えない。タイトルを大きさだけで成立させず、
改行、位置、背景立体、Accentの副題で階層を作る。

### 3.3 広東語

広東語のDisplayは`clamp(32px, 4.2vw, 56px)`とする。Noto Serif HK 900の密度を保ちながら、通常の
ラテンタイトルを圧倒しない。使用場所は章扉、背景語、短い文化索引に限定する。

```text
軌道之外
訊號清楚
```

### 3.4 フランス語

フランス語はNeutral Sansを基本とし、章扉と短い引用ではEditorial Serifを使う。アクセントと合字を保持する。

```text
Séquence orbitale
Énergie disponible
Fenêtre d’éclipse
Mémoire cristalline
Trajectoire prévue
```

### 3.5 Runtime font bridge

ゲーム本体のHUDは`src/main.ts`でJetBrains Mono Latin 400とHackGenを読み込み、`src/game/theme.ts`の
`FONT_FAMILY`をUI全域へ適用する。これは戦闘、座標、時刻、診断を扱うMachine measureとして維持する。

起動時のタイトルとステージ選択はNeutral、Classic、Machineの三声を使用する。本番配信では次の書体を
WOFF2として自己配信し、OSフォールバックだけに依存しない。

| Runtime context | Primary | Japanese | Design role |
| --- | --- | --- | --- |
| Combat HUD / map / console | JetBrains Mono | HackGen | 既存のMachine measure |
| Title / stage / general UI | Arimo | Zen Kaku Gothic Antique | Neutral voice |
| Subtitle / story / quotation | Cormorant Garamond | Zen Old Mincho | Classic voice |
| Diagnostic console | IBM Plex Mono | Zen Kaku Gothic Antique | 正式なCUI voice |

JetBrains MonoとHackGenは既存HUDの互換性を保つ。新しい一般UIをすべて等幅へ寄せず、Machineとして意味の
ある表示に限定する。

---

## 4. 三色カラーシステム

### 4.1 Default palette

| Token | HEX | 役割 |
| --- | --- | --- |
| Background | `#07080A` | ページ外側、静かな余白 |
| Surface 0 | `#08090C` | 3D窓、深い面 |
| Surface 1 | `#0E1014` | 通常カード、Solid window |
| Surface 2 | `#15171C` | 入力、選択前の面 |
| Title | `#EEEAF5` | タイトル、重要値 |
| Body | `#C3BEC9` | 本文、一般値 |
| Muted | `#89838F` | 補助説明、非選択 |
| Accent | `#FF5A00` | 副題、選択、現在位置、主要操作 |
| Near accent | `#FF8B52` | 補助副題、Hover、二段目の焦点 |
| Secondary accent / Signal | `#19F5C2` | 同期、第二対象、通電、完了 |

### 4.2 三色の関係

AccentとNear accentは同じ暖色族に属する。Near accentはAccentの代用品ではなく、同じ情報群の二段目を
担当する。Secondary accentは色相距離を取り、異なる種類の信号だけを示す。

```text
Accent        H≈21°   strongest / selected
Near accent   H≈21°   softer / adjacent
Secondary     H≈166°  signal / synchronized
```

一画面の有彩色面積は10%以下を基準とする。

- Accent: 4–6%。
- Near accent: 2–3%。
- Secondary accent: 1–2%。
- その他の意味色: 合計1%前後。

### 4.3 Preset library

| Preset | Background | Accent | Near accent | Secondary | 性格 |
| --- | --- | --- | --- | --- | --- |
| Orbital orange | `#07080A` | `#FF5A00` | `#FF8B52` | `#19F5C2` | 標準。暖色の主役とエメラルドSignal |
| Red / lime | `#08090B` | `#FF334E` | `#FF6A78` | `#C7FF38` | 赤とライムの蛍光対比 |
| Red orange / emerald | `#080A0B` | `#FF4B1F` | `#FF7652` | `#19E6B3` | 赤寄りオレンジと深いエメラルド |
| Red orange / turquoise | `#070A0C` | `#FF4A20` | `#FF8060` | `#1EE7D2` | 暖色と青緑の明快なSignal |
| Fluorescent red / blue | `#08090D` | `#FF3155` | `#FF6B82` | `#3478FF` | 赤と青の強い電気的対比 |
| Repository mono | `#0D1117` | `#C9D1D9` | `#8B949E` | `#58A6FF` | ダークグレーと白。Signal使用を最小化 |
| Matte red | `#D9D7D2` | `#A3463F` | `#C07369` | `#666B70` | グレー、白、マットな赤 |

Presetは背景、Surface、Title、Body、三色、Glass透明度を一括で切り替える。個別のHue、Saturation、
Lightness編集後はCustomとして扱い、HEX、RGB、HSL、CSSを表示する。

### 4.4 Light mode

Light modeは暖かい灰白を背景にし、Accentの明度をDarkより下げる。Near accentは白地でAccentとの差が
消えないよう、明度または彩度を12%以上離す。Secondary accentは面でなく点、短線、状態語へ使う。

### 4.5 色コード

- HEX `#RRGGBB`: 実装値とPresetの保存。
- RGB `rgb(255 90 0)`: チャンネル計算とAlphaの指定。
- HSL `hsl(21 100% 50%)`: 色相関係と明度差の調整。
- Alpha `rgb(14 16 20 / 72%)`: Glass面の透明度。
- Semantic token: `--accent-near`のように値でなく役割で命名する。

### 4.6 Runtime semantic exceptions

ゲーム世界の物理軸、危険、予測、識別は三色へ統合しない。これらは意味が現れる瞬間だけ使用し、通常のUI面、
タイトル、副題へ流用しない。静的標本では各Source HEXをHSL編集器で個別に選択し、テーマ上の見え方を確認する。

| Runtime token | Source HEX | 意味 |
| --- | --- | --- |
| Danger | `#FF4F5E` | 危険、低装甲、警報 |
| Axis prograde | `#3B82F6` | Δvの進行・逆行軸 |
| Axis normal | `#10B981` | Δvの法線・反法線軸 |
| Axis radial | `#EF4444` | Δvの動径内外軸 |
| Planned marker | `#8FD0FF` | 計画位置、予測軌道 |
| Target direction | `#FF7AB0` | ターゲット方向 |

現行UIトークン`#FF6A00`、`#FF9040`、`#00C8FF`は、それぞれAccent、Near accent、Secondaryへ
意味を保ったまま対応する。ゲーム世界の弾光、推進炎、天体表面、敵個体色はMaterial colorであり、UIの
主要三色とは分離する。

---

## 5. Rich title window

### 5.1 構造

冒頭のタイトルは、サイト幅内に収まる一つの大きな角丸ウィンドウへ置く。

```text
Page background
└─ Rich title window
   ├─ 3D scene / fog / lighting
   ├─ readable veil
   ├─ title + subtitle + TeX
   ├─ small status glass
   └─ motion selector: Drift / Still
```

ウィンドウ外側は静かなページ背景であり、内側だけが奥行きを持つ。境界は枠線ではなく、角丸、クリッピング、
面差、弱い影で示す。

### 5.2 3D造形

内部には、光沢プラスチックの文字片、枝、結節、リング、カプセル、短い板を18–28体配置する。全画面背景より
個体数を減らし、形の読める余白を増やす。

- 乳白、煙色、黒、薄い暖灰色が80%以上。
- Accent物体は1–2体、Near accent物体は1–2体、Secondary物体は1体まで。
- `roughness 0.16–0.28`、`metalness 0–0.06`、`clearcoat 0.7–1.0`。
- 主タイトルの背後はVeilでコントラストを保護する。

### 5.3 Motion / Still

- Drift: 回転周期30–100秒、移動周期24–80秒。カメラ入力追従は4px相当以下。
- Still: 初期配置、照明、霧だけを維持し、時間による移動を完全に止める。
- `prefers-reduced-motion`ではStillを既定にする。
- UIの切替は同じシーンの時間更新だけを停止し、配置を飛ばさない。

### 5.4 タイトル

- Title XLは最大104px、Neutral Sans 400。
- AccentのEditorial subtitleは20–34px。
- Near accentは日本語副題、注釈、章番号へ使う。
- Secondary accentは同期点、Signal dot、短い状態表示だけ。
- 背景色からReadable oppositeを導出し、タイトルの明度を自動決定する。

---

## 6. TeX数式言語

### 6.1 描画方式

科学記法はTeXソースを正本とし、KaTeXまたは同等のTeXレンダラーでHTMLとMathMLへ描画する。画像化した
数式を本文へ貼らない。ソースは`data-tex`または構造化データとして保持する。

```html
<div class="math" data-tex="\Delta v_p = +12.48\,\mathrm{m\,s^{-1}}"></div>
```

数式は装飾であってもTeX文法として成立させる。実測値と装飾式は`measurement`、`motif`、`chapter`などの
役割で区別する。

### 6.2 表示級

| Role | サイズ | 用途 |
| --- | --- | --- |
| Math title | `clamp(40px, 6vw, 78px)` | 章扉、3D title window |
| Math subtitle | `clamp(22px, 3vw, 36px)` | 副題、物理原理、場面転換 |
| Math display | 20–28px | Glass window、説明図、計画 |
| Math body | 15–18px | 本文、表、注釈 |
| Math micro | 11–13px | ラベル、添字説明 |
| Math console | 13–16px | CUI内の機械出力 |

### 6.3 有彩色

数式全体の通常色はTitleまたはBodyとする。項、ベクトル、境界条件を強調するときだけ三色を使う。

```tex
\color{accent}{\Delta v_p}
+ \color{near}{\Delta v_n}
+ \color{secondary}{\Delta v_r}
```

実装では色名をCSS tokenから解決し、TeXソースへHEXを散在させない。

### 6.4 半透明

推定、過去軌道、参照式、背景Motifは数式ラッパーへ`opacity: .36–.68`を適用する。個別グリフのAlphaを
ばらばらにしない。透明な式にも読み上げ用テキストを残す。

### 6.5 アニメーション

数式のアニメーションは項の出現、係数の更新、位相の移動に限定する。

- 係数更新: 160–260msで数値を補間。
- 項の出現: opacityと4px以下の移動。
- 位相: `e^{i\omega t}`など意味のある変数だけを穏やかにPulse。
- 式全体の常時回転、Wave、文字Morphを行わない。
- Reduced motionでは静止値を表示する。

### 6.6 ウィンドウ別の用例

- Solid window: 軌道要素、熱力学、化学反応の長い説明。
- Glass window: `\Delta v`、Burn residual、推定誤差。
- Rich 3D window: タイトル級のHamiltonian、場の方程式、章番号。
- CUI: TeX数式とIBM Plex Monoの時刻、座標、状態語を同居させる。

### 6.7 標準用例

```tex
\Delta v_p = +12.48\,\mathrm{m\,s^{-1}}

\rho(h)=\rho_0\exp\left[-\frac{h-h_0}{H}\right]

H(q,p,t)=\frac{p^2}{2m}+V(q,t),\qquad \delta S=0

dU=T\,dS-p\,dV+\sum_i\mu_i\,dN_i

\mathrm{Fe_2O_3 + 2Al \rightarrow Al_2O_3 + 2Fe}

\mathcal{G}=(V,E),\qquad A\subset B,\quad x\in\mathbb{R}^3
```

---

## 7. 記号とアイコン

### 7.1 形態比率

```text
80%  recognizability
20%  deconstruction
```

既知の輪郭を骨格にし、次の操作を一つだけ加える。

- 円弧を一箇所だけ欠損させる。
- 矢印の軸と先端を分離する。
- 接線を少し外へずらす。
- 中心点を添字の位置へ移す。
- `n`、`p`、`r`、`Δ`を小さな上付き・下付きとして加える。
- 左右対称の一部だけを短縮する。

複数の分解操作を同時に重ねない。

### 7.2 軌道マニューバ

| 意味 | 基本シルエット | 独自処理 |
| --- | --- | --- |
| Prograde | 円 + 中心点 | 進行側の円弧を短く切る |
| Retrograde | 円 + × | ×の一辺を中心から離す |
| Normal | 上向き矢印 + 軌道弧 | 矢印先端を分離し`n`を添える |
| Antinormal | 下向き矢印 + 軌道弧 | 同じ文法で上下反転 |
| Radial | 同心円 + 外向き短線 | 一方向だけ長くし`r`を添える |
| Maneuver node | 菱形 + 接線 | 一角を開き`Δ`を添える |
| Burn | 短い矢印 + 残差弧 | 矢印軸を二分する |
| Apoapsis / Periapsis | 楕円 + 一点 | 点を外側へずらしAp / Peを添える |

色は形の補助であり、記号の意味を色だけに依存させない。Δv三軸はラベルと方向で識別し、選択中の軸だけ
AccentまたはSecondaryを使う。

### 7.3 一般UIアイコン

閉じる、再生、保存、戻る、検索、ピン留めなどは一般的な主輪郭を保つ。独自性はストロークの欠損、短い接線、
添字一つまでに限定する。24pxでは1.5px、32px以上では2pxを基準にする。

### 7.4 アスタリスクと星形

`* ⁕ ⁎ ∗ ✱ ✳ ✴`、六芒、七芒、八芒を章番号、注釈、同期点へ使う。一画面では一種を基本とし、頂点数を
状態コードにする場合は凡例を付ける。

---

## 8. 面とウィンドウ

### 8.1 Borderless Glass

Glass windowは背景との色差、透明度、ぼかし、重なり、角丸で境界を示す。

```css
.glass-window {
  background: rgb(14 16 20 / 72%);
  backdrop-filter: blur(20px) saturate(82%);
  border: 0;
  border-radius: 22px;
  box-shadow: 0 16px 48px rgb(0 0 0 / 18%);
}
```

- Quiet Glass: 常設HUD。blur 12–16px、Alpha 56–68%。
- Focus Glass: Property、Node editor、TeX display。blur 18–24px、Alpha 68–80%。
- Rich Glass: 3D title window内の状態カード。blur 24–32px、Alpha 52–68%。
- Modal Glass: Story choice、Save、Result。Scrimを併用する。

### 8.2 Solid面

長文、表、設定、ライセンス、詳細な数式説明はSolid面へ置く。SolidとGlassを同一階層で混ぜず、主役を一つにする。

### 8.3 Flat controls

ボタン、Toggle、Slider、Knob、Segmentはフラットに表示する。操作感は面差、1px以下の変位、点灯、数値同期で作る。
Near accentはHover、AccentはSelected、Secondaryは外部Signalまたは完了へ使う。

---

## 9. UIパターン

### 9.1 常設HUD

- Global status: MET、時間倍率、Node warp、Pause。
- Vessel status: RCS、並進出力、微調整、Hold、弾薬、温度、電力。
- Orbit: 中心天体、高度、速度、遠地点、近地点、傾斜角、周期、動圧。
- Target: 距離、接近速度、相対速度、装甲。
- Contacts: 第一対象、第二対象、波、味方。

通常値とラベルはモノトーン。第一対象をAccent、隣接状態をNear accent、第二対象または同期対象をSecondaryへ
割り当てる。

### 9.2 軌道計画

Object list、View、Predict、Maneuver plan、Map scale、Markerを同じ記号文法で表示する。軌道記号は形と文字が
先に意味を伝え、色は選択中の一軸だけに現れる。

### 9.3 保存、基地、物語

- Save browser: 執政官結晶、固定記録、自動履歴、船団状態。
- Dock: 艦、部品、倉庫、修理、燃料、ショップ。
- Story: 任務、人物、通信遅延、資源循環、環境、章扉。
- Result: 再出撃、別の艦、結晶記録、文明の継続。

### 9.4 ネットワークと結合グラフ

戦略網と結合グラフ式造船は、ノード、ポート、エッジ、Inspectorを共通化する。通常線は灰色、選択経路はAccent、
隣接候補はNear accent、外部Signalや同期済み接続はSecondaryで表示する。

---

## 10. 物語UI用例

### 10.1 Rich title window

```text
Dive into Tepui
La Terre n’est pas morte.

H(q,p,t)=p²/2m+V(q,t)
Public year 20115 · Aotearoa perigee
```

### 10.2 任務

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

### 10.4 L1農場

```text
L1 Heliostat Farm 07
Φγ = 1.31 kW·m⁻²
NH₃ 8.4 t · CH₄ 2.1 t · N₂ 14.2 t · H₂O 31.8 t
次の停止要因: 窒素不足 18時間後
```

### 10.5 Tepui攻囲

```text
Tepui 12 · Palace remnant
周回高度 318 km · 防衛節点 7 · 光学干渉 28%
目的: ロトベーター接続点を確保する

帰ってきた子らの匂いを、番犬はもう覚えていない。
```

---

## 11. モーションとアクセシビリティ

### 11.1 モーション

- Hover / press: 120–160ms。
- Toggle / meter: 160–240ms。
- Glass open: 220–320ms、4–8pxの移動。
- TeX term: 180–360ms。
- 3D drift: 24–100秒。

情報更新でパネル全体を揺らさない。Rich title window以外の常時アニメーションは一画面に一つまでとする。

### 11.2 アクセシビリティ

- 本文4.5:1以上、タイトル3:1以上を基準とする。
- 色だけで意味を示さない。
- TeXはMathMLまたは読み上げ用テキストを持つ。
- Canvas内の重要情報をDOMでも提供する。
- 点字、楔形文字、装飾SVGにアクセシブルネームを付ける。
- `prefers-reduced-motion`では3DをStill、数式を静止状態にする。
- Glassの文字コントラストが不足する場合はAlphaを自動的に上げる。

---

## 12. 実装トークン

```css
:root {
  --site-max: 1160px;
  --reading-max: 760px;

  --page: #07080a;
  --surface-0: #08090c;
  --surface-1: #0e1014;
  --surface-2: #15171c;
  --title: #eeeaf5;
  --body: #c3bec9;
  --muted: #89838f;

  --accent: #ff5a00;
  --accent-near: #ff8b52;
  --accent-secondary: #19f5c2;

  --radius-control: 11px;
  --radius-panel: 16px;
  --radius-window: 22px;
  --radius-rich: 30px;

  --font-neutral: "Arimo", "Zen Kaku Gothic Antique", sans-serif;
  --font-editorial: "Cormorant Garamond", "Zen Old Mincho", serif;
  --font-machine: "IBM Plex Mono", "Zen Kaku Gothic Antique", monospace;
}
```

```json
{
  "palette": {
    "accent": "#FF5A00",
    "nearAccent": "#FF8B52",
    "secondaryAccent": "#19F5C2"
  },
  "layout": {
    "siteMaxPx": 1160,
    "titleMaxPx": 104,
    "richWindowRadiusPx": 30
  },
  "symbolLanguage": {
    "recognizability": 0.8,
    "deconstruction": 0.2
  }
}
```

---

## 13. レビュー用チェックリスト

- [ ] デスクトップのコンテンツ幅が1160px以下である。
- [ ] タイトルが104px以下で、Rich title window内に収まっている。
- [ ] 3D背景がページ全体ではなく角丸ウィンドウ内部にある。
- [ ] DriftとStillの両方を確認できる。
- [ ] Accent、Near accent、Secondary accentの三色が明確に存在する。
- [ ] Near accentがAccentと同型色の二段目として使われている。
- [ ] Secondary accentが同期、第二対象、通電、完了に限定されている。
- [ ] 七つの配色Presetを切り替えられる。
- [ ] Preset変更後にHEX、RGB、HSL、CSSが表示される。
- [ ] Defaultが`#FF5A00`、`#FF8B52`、`#19F5C2`である。
- [ ] 広東語Displayが56px以下である。
- [ ] TeX数式が実際のレンダラーで描画されている。
- [ ] 数式の有彩色、半透明、アニメーション、Title、Subtitle、Body、CUI、Glass、3D用例がある。
- [ ] 軌道記号が一秒で意味を推測できる。
- [ ] 記号に20%程度の独自な欠損、分離、添字が残っている。
- [ ] 軌道三軸が色だけでなく形とラベルで識別できる。
- [ ] 通常UIがNeutral、物語副題がEditorial、CUIがIBM Plex Monoに分かれている。
- [ ] 全て大文字の文言がCUI、警報電文、固有ロゴに限定されている。
- [ ] Glassウィンドウが枠線でなく面差とぼかしで区切られている。
- [ ] 縞模様と反復走査線がない。
- [ ] Light modeでも三色の役割が変わらない。
- [ ] Reduced motionで3DとTeXが静止する。

---

## 14. 配布元

- [Arimo](https://github.com/googlefonts/Arimo)
- [Zen Kaku Gothic Antique](https://github.com/googlefonts/zen-kakugothic)
- [Cormorant](https://github.com/CatharsisFonts/Cormorant)
- [Zen Old Mincho](https://github.com/googlefonts/zen-oldmincho)
- [IBM Plex](https://github.com/IBM/plex)
- [Noto Serif CJK](https://github.com/notofonts/noto-cjk/tree/main/Serif)
- [Noto Cuneiform](https://github.com/notofonts/cuneiform)
- [Noto Symbols](https://github.com/notofonts/symbols)
- [KaTeX](https://github.com/KaTeX/KaTeX)
