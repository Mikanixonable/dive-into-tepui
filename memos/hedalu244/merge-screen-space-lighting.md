# screen-space-lighting を main へマージする手順

この文書は、ブランチ `screen-space-lighting` に main を取り込んでコンフリクトを解消し、PR を main へ入れるための手順書。
読み手はこのブランチの経緯を知らない作業者（エージェント）。上から順に実施し、終わったらこのファイルを消す commit を最後に積む。

**手順の正本は `/send-pr`**（`.claude/skills/send-pr/SKILL.md`）で、この文書はこのブランチに固有の事情と、決まっている判断だけを足す。
`/send-pr` と食い違うところは、この文書を優先する。

## 0. 先に知っておくこと

### ブランチの中身

このブランチは描画に 3 つの機能を足した:

1. **拡散補正項** — 近くの構造が遠方の光を塞ぐ分と照り返す分の補正（拡散反射の二次反射の近似）。
   `src/render/pipeline/screen-space/` の大半、`material-pass.ts`・`light-prepass.ts`・`render-pipeline.ts` の一部、時間方向の蓄積
   （`motion-history.ts`・`scene-change*.ts`・`temporal-accumulation.ts`、動きベクトル）。
2. **映り込み** — 近くの物体の鏡面反射（鏡面反射の二次反射の近似）。`reflection-pass.ts`・`reflection-source-pass.ts`・
   `screen-space/reflection-*.ts`。
3. **描画品質設定の 3 層化** — 全体 → 分野 → 詳細の値の階層的なプリセット。`src/render/graphics-selection.ts`（解き方）・
   `graphics-settings.ts`（表）・`legacy-graphics-settings.ts`（旧い保存値の読み替え）・`src/settings/`・設定パネル。

1・2 は描画パイプラインの中に閉じた新機能。3 は main 側でも同じ場所が大きく変わっていて、**意味の上で最も衝突する**。

残りの作業（手順24〜28）と Backlog は `memos/hedalu244/better_graphics/screenspace-diffuse_backlog.md` にある。マージでは読まなくてよい
（「守ること」の節だけは、解消で描画の契約を壊していないかの確かめに使える）。

### 履歴は書き換えてある — rebase しない・squash しない

- main は 2026-11 に履歴を書き換えている（`scratch/` と `src/assets/orbits/*.json`・`src/assets/models/shipModules.json` の 13 ファイルを全履歴から削除）。
  このブランチも同じ形に揃え、736 個のコミットを 31 個の章コミット `[要約 k/31]` に畳んで、書き換え済みの main の `ca548aacf`
  （PR #98 のマージ）の上へ載せ直した。その上に整理のコミットが数個ある。
- したがって `git merge-base screen-space-lighting origin/main` は `ca548aacf` になる。**ならなければ止めて、ユーザーに問う。**
- 章コミットは、この文書の Backlog が「試した手法の証拠」として引く。**main へは「Create a merge commit」で入れる。squash も rebase もしない**
  （章が main から辿れなくなる）。マージした後もブランチは消さなくてよい。
- 畳む前の履歴は hedalu244 の作業機のタグ `screen-space-lighting-full` にだけある。**push しない**（消した大きなファイルが戻る）。

- 消された 13 ファイルのうち `src/assets/orbits/lagrange-orbits-*.json` の 8 本は、main が後で復元した（`77acdafde`）。このブランチにも
  main と同じ内容で入れてあるので、マージでは衝突しない。`src/assets/models/shipModules.json` は旧形式で、main のコードはもう読まない。
  このブランチの `ship-module-models.ts` はまだ読むので、**マージの前のこのブランチ単体では型検査が通らない**（マージで main の版になって直る）。

### 作業木の注意

- hedalu244 の作業木には `scratch/`（手元の試し書き）が未追跡で残っている。main では `.gitignore` の対象なので、マージの後は無視される。
  消さない。**`git add -A` / `git add .` / ディレクトリ指定の `git add` をしない。** 足すファイルはパスで指定する。

### 決まっている判断（ユーザーが 2026-11-22 に決めた）

- **描画品質設定は、ブランチの 3 層の構造を正にする。** 全体 → 分野 → 詳細の値。カスタムは選んだ状態そのもので、値から推し量らない
  （main の「値がプリセットと一致したらそのプリセットを点灯する」形 `matchingGraphicsPreset` は採らない）。
  main で足された項目は 3 層のどこか（分野の詳細の値か「表示する要素」か「好み」）へ割り振って移す（下の 3.2）。
- **全体のプリセットは main の 4 段（低 / 中 / 高 / 最高）に揃える。** 全体は 低 / 中 / 高 / 最高 / カスタム。main が各項目に決めた段の値と、
  初回の既定（中。主ポインタが粗い端末は低）を引き継ぐ。分野の段は 低 / 中 / 高 のままで、遮蔽と照り返し・映り込みの分野は全体の
  「最高」で各分野の「高」を選ぶ。main の旧「高」→「最高」、旧「中」→「高」、新しい「中」は軽い構成、という意味の付け替えも引き継ぐ。

これ以外で、どちらの側の意図を採るか決められないものが出たら、推し量らずにユーザーに問う。

## 1. 準備

```bash
git fetch origin
git switch screen-space-lighting
git status                      # 追跡済みのファイルに変更が無いこと
git merge-base HEAD origin/main # ca548aacf... であること
npm ci                          # main 側の依存の変更を取り込む（package.json は衝突しない）
```

## 2. main を取り込む

```bash
git merge origin/main   # コンフリクトで止まる。解消は 3 で行い、全部解消してから 1 つのマージコミットにする
```

マージコミットの中で SPEC（`DEVELOP/SPEC/`）と `src/` を一緒に解消するのは、コンフリクトの解消として例外的に許す
（CLAUDE.md の「`docs(spec):` を単独 commit に」の規則は、解消の後に足す変更から守る）。

## 3. コンフリクトを解消する

`git merge-tree --write-tree HEAD origin/main` で数えたコンフリクトは下の一覧（2026-11-22 時点の main `e06df4213`）。main が進んでいれば増減する。
**群ごとに、上から順に**解消する。各群の終わりで型検査（`node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit`）を通す
必要は無いが、3.6 の終わりには通っていること。

### 3.1 文書と規約

| ファイル | 種類 | 解消 |
| --- | --- | --- |
| `CLAUDE.md` | 種類の違い（main ではシンボリックリンク → `AGENTS.md`） | main のシンボリックリンクを採る。ブランチが CLAUDE.md の SKILL の表に足した 1 行（`/approximation-tradeoff` の行。`.claude/skills/approximation-tradeoff/SKILL.md` はブランチで追加）を `AGENTS.md` の同じ表の `/rendering-workflow` の行の上に足す。|
| `DEVELOP/SPEC/RENDERING.md` | 内容 | 描画品質設定の節は 3.2 の判断で書き直す: ブランチの 3 層の記述（全体・分野・詳細の値・カスタム・好み・表示する要素）を正にし、全体の段を 低/中/高/最高 にし、main が足した項目の振る舞い（フレームレート上限・UI の背景ぼかし・テクスチャ解像度・建造の作業灯・夜側の観察・雲の体積/簡易・巻雲の細かさ・雲の品質の自動適応・初回の既定）の記述は残して分野へ置き直す。「どのプリセットとも一致しなければ、どのプリセットも選ばれていない状態として示す」は消す（ブランチの「カスタムは値から推し量らない」と矛盾する）。それ以外の節（パイプライン・雲・大気など）は両方の追記を残す。|
| `DEVELOP/SPEC/UI-DESIGN.md` | 内容 | 両方の追記を残す。描画タブの並び（好み → 全体 → 分野 → 詳細）はブランチの記述を正に。|
| `eslint-suppressions.json` | 内容 | 両側の項目を残し、同じ規則の count は大きいほうにする。全部の解消の後（4 の前）に `npx eslint --prune-suppressions --suppressions-location eslint-suppressions.json src tests tools` で要らなくなった分を落とす。新しい違反を抑制へ足して通さない — コードを直す。|

### 3.2 描画品質設定（最も重い。`/modify-feature` と `/ui-design` を通す）

| ファイル | 種類 |
| --- | --- |
| `src/render/graphics-settings.ts` | 内容 |
| `src/hud-kit/panels/graphics-panel.ts`（main で `src/hud/panels/` から移動） | 内容 |
| `src/hud-kit/panels/settings-view.ts`（main で `src/hud/windows/` から移動） | 内容 |
| `src/hud/windows/pause-menu.ts`（main で `src/hud-kit/windows/pause-menu.ts` へ移動・作り直し） | 変更/削除 |
| `src/settings/user-settings.ts`・`tests/settings/user-settings.test.ts` | 内容 |
| `src/main.ts` | 内容 |

両側の形:

- **main**: `graphics-settings.ts` の `GRAPHICS_OPTIONS` が項目ごとの表（群 basic / element / light / shadow、各項目が 低/中/高/最高 の値を持つ）。
  保存は鍵 `tepui.settings.graphics` に項目ごとの平らな JSON。`matchingGraphicsPreset` で値の一致からプリセットを点灯する。
  main で足された項目: `frameRateCap`・`uiBlur`・`textureResolution`・`hitShake`・`nightObservation`・`constructionWorkLight`・
  `cumulus`/`cirrus` の独立したトグル・`cirrusDetail`・雲の体積/簡易・露出補正の ±0.5 段。プロテインの揺らぎは消えた。
- **ブランチ**: `graphics-settings.ts` が分野の表（画面・光源・影・雲・大気・遮蔽と照り返し・映り込み）と詳細の値、
  `graphics-selection.ts` が選び方 `GraphicsSelection` を解いて平らな値一式 `GraphicsSettingsData` を返す（選び方が変わらない限り同じ参照）。
  保存は鍵 `tepui.settings.graphics.v2` の選び方。旧鍵 `tepui.settings.graphics` は `legacy-graphics-settings.ts` が旧い意味で読み替える。

解消の方針:

1. 先に SPEC（3.1 の RENDERING.md）を書き終える。項目の割り振りは、main の群と意味から決める。目安: `frameRateCap`・`textureResolution` は
   「画面」の分野の詳細の値、`uiBlur`・`hitShake` は品質と負荷の引き換えか好みかで決める（`hitShake` は好みに近い。迷えば問う）、
   `nightObservation`・`constructionWorkLight` は「光源」の分野か「表示する要素」、雲の体積/簡易・`cirrusDetail`・`cumulus`/`cirrus` は「雲」の分野。
2. 全体の段を 4 段にする: `graphics-selection.ts` の全体のプリセットの型と表に `max` を足し、各分野の段（低/中/高）を全体の 4 段からどう
   選ぶかを、main の各項目のプリセット値から逆算して決める（分野の段の値の中で表せない組み合わせが出たら、その分野の段の値を main の値に
   合わせて直す。それでも表せなければ問う）。遮蔽と照り返し・映り込みは、全体の 最高 → 分野の 高。
3. 初回の既定を main に合わせる（保存が無いとき: 全体「中」、主ポインタが粗い端末は「低」）。ブランチは「高」だった。
4. **旧い保存値の読み替えを、main の最新の平らな形式に合わせて直す**（`legacy-graphics-settings.ts`）。main の利用者は鍵 `tepui.settings.graphics` に
   main の最新の形（上の新しい項目を含む）で保存しているので、その値から 3 層の選び方へ読み替える。項目ごとの値を、まず分野の段と一致するかで
   分野のプリセットに、一致しなければその分野のカスタムに写す（読み替えは一度きりの変換なので一致で判定してよい — 点灯の判定とは別）。
   旧い値に main の旧い 3 段の意味（4 段にする前）が混ざる可能性は、main の `parseGraphics` の扱いに倣う。実在の文字列を読むテストを足す。
5. 設定パネルは main の `src/hud-kit/` の部品と様式（計器シートの構成、`hud-kit/widgets/`）の上へ、ブランチの 3 層の振る舞いを載せる。
   ブランチの `src/hud/panels/graphics-panel.ts` の差分（+214 −87）を main の `src/hud-kit/panels/graphics-panel.ts` へ移す形になる。
   ESC メニュー（`pause-menu.ts`）は main の作り直しを採り、ブランチの 2 行の変更（設定の型の付け替え）だけを当て直す。
6. main で消えたタンパク質に関わるもの（`proteinVibration` の項目、`legacy-graphics-settings.ts` の 34・153 行）は消す。

確かめ: `npm run test:settings`・`npm run test:render`（`graphics-selection.test.ts`・`legacy-graphics-settings.test.ts`、main の
`graphics-settings.test.ts` はブランチの形に合わせて書き直すか、重なるものを消す）。

### 3.3 描画パイプライン（機能 1・2。ブランチの描画を壊さず、main の変更を全部残す）

| ファイル | 種類 | main 側で入っていたもの（手がかり） |
| --- | --- | --- |
| `src/render/pipeline/render-pipeline.ts` | 内容 | デバッグ合成の切り出し（`4ee00d125`）、テクスチャ解像度、雲パスの GPU 時間、影オフで影マップを省く、タンパク質の除去 |
| `src/render/pipeline/debug-composites.ts` | 両側で追加 | main も同名のファイルを `composite.ts` と一緒に切り出した。**main の分け方（`composite.ts` + `debug-composites.ts`）を採り**、ブランチのデバッグ表示（screen-space の中間 target・`signedCorrectionMaterial`・映り込みの段）をその中へ足す。ブランチの `composite-material.ts` が main の `composite.ts` と同じ責務なら畳む。|
| `src/render/pipeline/material-pass.ts`・`light-prepass.ts`・`exposure.ts`・`sun-light.ts` | 内容 | フィルムのルックの色空間・表示値への掛け方、雲の影を大気の散乱光へ |
| `src/render/pipeline/lighting/{ambient-source,planet-light-source,planet-light-subject,sun-source}.ts` | 内容 | **天体照を受け手と光源天体の間の天体で遮る**（`51051146d`）。ブランチの拡散補正項は天体照の照度 E_p に「近くの構造に塞がれた割合」を掛けて引くので、main の遮りを掛けた後の E_p を使う形にする（二重に掛けない・掛け忘れない）。|
| `src/render/pipeline/shadow/{body-shadow,shadow-select}.ts`・`src/physics/shadow.ts`（衝突なし）・`tests/physics/shadow.test.ts` | 内容 | 同上の天体どうしの遮り |
| `src/render/gpu-timings.ts` | 内容 | 雲パスの行（main）と screen-space・映り込みの行（ブランチ）を両方残す。行は実行順に並ぶこと |
| `src/render/blue-noise.ts`・`instanced-pool.ts`・`atmosphere.ts` | 内容 | 両方を残す（ブランチ: ブルーノイズの読み方・プールの前フレームの行列、main: 大気の品質） |
| `src/render/celestial/{celestial-illumination,celestial-surface}.ts`・`tests/render/celestial-illumination.test.ts` | 内容 | テクスチャ解像度に連動した地表詳細タイル |
| `tests/render/tsl-node-evaluator.ts` | 内容 | 両方の評価器の追加を残す |

- ブランチが変更し main が移動したファイル: `src/render/cloud/cloud-presentation.ts` → `src/render/earth-weather/cloud/cloud-presentation.ts`、
  `src/render/opaque-cloud-surface-renderer.ts` → `src/render/earth-weather/cloud/opaque-cloud-surface-renderer.ts`。git は削除と追加として扱うので、
  ブランチの差分（`git diff ca548aacf screen-space-lighting -- <旧パス>`、どちらも 10〜60 行ほど）を移動先へ当て直し、旧パスは消す。
  ブランチの差分は主に描画品質設定の値の読み方と、動きベクトル（時間方向の蓄積の T17「雲殻は交点で写す」）。
- ブランチが変更し main が消したファイル: `src/render/protein/protein-enemy-ship.ts`（タンパク質の引退）→ 消す。ブランチの時間方向の蓄積の
  タンパク質向けの扱い（T20 タンパク質の画素は動きベクトルを棄却の印にする）は、タンパク質ごと消してよい。
- main の 2026-11-21 の一括改名（`a54d7c582`・`3908b4fad`・`66f79ba87`・`a216e0a5e`・`a46dae290`・`43ac5a66f`）で、ブランチの新しいファイル
  （`src/render/pipeline/screen-space/` ほか）の import が古いパスを指して型検査で落ちうる。型検査の誤りから 1 つずつ直す。
- **描画の契約を壊していないかの確かめ**（Backlog の「守ること」から）: 補正を切ると補正の前の絵に戻る、映り込みは時間方向の蓄積と走査の
  代表のジッターを使わない、蓄積は `screen-space/` の中に閉じる、動きベクトルにジッターを含めない。

### 3.4 ゲーム

| ファイル | 種類 | 解消 |
| --- | --- | --- |
| `src/game/camera/camera-system.ts` | 内容 | main の被弾時の視点の揺れ（`58814b273`）と、ブランチのカメラの同一性の鍵（`camera-key.ts`、時間方向の蓄積の T39・T40）を両方残す。揺れはカメラの動きなので、動きベクトルと変化量 d の「画面の滑り」で扱われる。揺れで履歴が捨てられすぎていないかは目視の確かめに回す（5）。|
| `src/game/game-presentation.ts` | 内容 | 両方を残す（ブランチ: `syncCamera` の変化量の宣言）。|

### 3.5 道具（`tools/`）

| ファイル | 種類 | 解消 |
| --- | --- | --- |
| `tools/render-lab/lab.ts`・`main.ts`・`lab-case.ts`・`cases.ts`・`earth-cases.ts` | 内容 | 両方の追加を残す（main も lab.ts を約 480 行変えている）。ブランチの lab の口（screen-space の段・seed・ジッターの源・映り込みの段の固定）は、残した道具（`tools/render-lab-screen-space-*.mjs`・`render-lab-reflection-*.mjs` ほか）が使う。|
| `tools/render-lab/protein-cases.ts` | 変更/削除 | main の削除を採る。`cases.ts` からの登録と、`tools/render-lab/motion-vector-check.ts` のタンパク質のケースの分岐（`proteinMotion`）も消す。|
| `tools/render-lab-measure.mjs`・`render-lab-shot.mjs`・`chrome-session.mjs` | 内容 | 両方を残す。設定のキーを文字列で渡しているので、3.2 で設定の形を変えたら合わせる（`git grep -n "graphics" -- tools` で当たる）。|
| `tools/cloud-lab/cloud-rendering-explainer.html` | 変更/削除 | main の削除を採る。|

### 3.6 衝突しないが壊れうるもの

- main で足されたテスト・道具が、ブランチで変えた設定の型（`GraphicsSettingsData` のキー・`QualityPreset`）を使っていれば、型検査で落ちる
  （例: `tools/mobile-probe.mjs` のプリセットの写し、`tests/render/shadow-select.test.ts`）。ブランチの形に合わせる。
- `npm run check:boundaries` は main で規則が増えている。ブランチの新しいファイルが違反したら、規則に合わせて直す（`tools/boundary-allowlist.json` へ足して通さない）。

## 4. 検証（`/send-pr` の全部）

`/send-pr` の手順どおり、変更箇所によらず全部回す: `npm run typecheck`・`npm run check:boundaries`・`npm run lint`・`npm run test`・
`npm run build`。**`tools/boundary-allowlist.json` が空であること。**

- `/send-pr` の `/refactor` と `/comment-cleanup` は、**解消で書いた行と、移動先へ当て直した差分だけ**に当てる。ブランチの既存のコードを
  整理し直さない（整理の残りは Backlog の手順28 にある）。
- メモリ 8 GB の機械では tsc・テスト・webpack を並行させない。`npm run typecheck` が落ちるときは
  `node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit`。テストは `test:build` を 1 回にして層ごとに走らせる（`test:*` は
  `tests/dist` を消し合う）。

## 5. 目で見る確かめ（ユーザーに頼む）

自動の検証は描画の見た目を見ない。push の前に、ユーザーに次を実機（`npm run dev`）で見てもらうよう頼み、返事を待つ:

- 設定タブの描画: 全体 低/中/高/最高/カスタム、分野のカスタム、main で足した項目が現れて効く。初回の既定が中（タッチ端末は低）。
  main で保存した設定（鍵 `tepui.settings.graphics`）が読み替わる。
- 遮蔽と照り返し・映り込みをオン/オフして、近くの構造の陰と照り返し、金属面の映り込みが出る。天体照が間の天体に遮られる場面
  （main の新機能）で、近くの補正が遮られた光に対して掛かっている。
- 被弾の視点の揺れで、近くの補正がちらつきすぎない。

## 6. push と PR

```bash
git push origin screen-space-lighting
```

PR はすでに開いている（このブランチから main へ。本文に変更の要約がある）。本文の「コンフリクト」の節を、解消した結果に書き換える。
マージは **「Create a merge commit」**（0 の理由）。

最後に、このファイル（`memos/hedalu244/merge-screen-space-lighting.md`）を消す commit を積んで push する。
