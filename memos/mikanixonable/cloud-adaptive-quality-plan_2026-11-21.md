# 雲の軽量化: 品質を保った自動適応

## 目的

地球方向を映したときに fps が落ちるのを、**ユーザーの選んだ品質を上限として**、
状況に応じて雲の描画費用を自動で下げることで緩和する。下げるのは「積雲の精細さ」
「巻雲の精細さ」の実効段だけで、雲そのものを消したり、オン/オフの設定に触れたりはしない。

根拠の実測(`npm run render-lab:measure`、apple / metal-3、earth 構図、2026-11-21 計測):

| 段 | 表面雲 [ms] | 大気(雲あり) [ms] | 雲影 [ms] | 3 パス計 [ms] |
| --- | --- | --- | --- | --- |
| 積雲粗 × 巻雲粗 | 0.775 | 3.118 | 1.638 | 5.531 |
| 積雲標準 × 巻雲標準 | 1.903 | 4.008 | 2.749 | 8.660 |
| 積雲精細 × 巻雲精細 | 3.697 | 4.871 | 4.562 | 13.130 |

- 60fps の枠 16.7ms に対し、標準で 52%、精細で 79% を雲 3 パスが占める。地球を向いた
  ときの fps 低下の主因はこれ。
- 精細 → 標準で −4.47ms、標準 → 粗で −3.13ms 取り戻せる。
- 巻雲の段の差は大気パスへ +0.2〜0.4ms 程度と小さい。主な効くつまみは積雲の段。
- 大気パス単体(雲なし)は約 2.5ms なので、大気内の雲の寄与は 0.6〜2.4ms。
- 計測対象外だが sync 側にも雲のコストが載る: 雲場の焼成(`bakeClouds`)の投入は
  `GamePresentation.syncWorld` の中で行われ、CPU 側の sync 時間に含まれる。

## 決めたこと

1. **描画品質設定の精細さは「上限」になる。** 実効の段 = min(設定値, フットプリント上限,
   予算上限)。設定値を超える方向には決して動かず、「粗」より下(雲を消す)にも行かない。
   SPEC RENDERING.md の「描画品質設定」節へこの規定を書く(手順 0)。
2. **上限は2種類ある。**
   - **フットプリント上限** — 画面の最小画素実寸(span_min、直下点)から、その段の追加
     オクターブが全部 `fadeOf` で 0 になる段を算出する。既に画素で解像できない段は
     無料で削れる(絵は同一)。細かい段が要るのは直下付近だけなので、span の最小値で決める。
   - **予算上限** — フレーム時間の実績が枠を超え、かつ雲 3 パスの GPU 合計がフレームの
     4 分の 1 以上を占めるときだけ 1 段下げる(雲以外が原因のフレーム超過で雲を削らない
     ため)。余裕が続けば段を戻す。GPU 時刻印が取れない環境では予算上限は働かせない
     (フットプリント上限だけが効く)。
3. **段の切替はマテリアルの参照交換にする。** march/refine はシェーダへ展開される定数で、
   `setSampling` → `rebuildMaterial` はコンパイルヒッチを伴う。3 段ぶんのマテリアルを
   起動時(warmUp)に組んで保持し、切替は `mesh.material` の差し替えにする。
   却下した案: march/refine の uniform 駆動。ループ上限を最大値で固定して条件で打ち切る
   形になるので GPU 費用が最悪値へ張り付き、意味をなさない。残る問題: march を動的に
   できる形へ将来書き直せば事前構築は要らなくなる。
4. **往復を防ぐ。** 下げは直近 0.5s の連続超過、戻しは 5s の連続余裕、各変更後は 2s の
   冷却。ポーズ・マップビュー・時間加速中は判定を止める(フレーム時間が歪むため)。
5. **sync の内訳を計測へ足す**(ユーザー指示で計画へ含めた)。update と同じ仕組みで
   sync を区間へ分け、デバッグ窓へ「sync 内訳」グループを出す。雲焼成の投入が sync の
   どの区間に載るかを観測できるようにする。
6. **適応の状態をデバッグ窓へ出す。** 実効段と上限の出どころ(設定/フットプリント/予算)
   を1行で見せる。適応が効いているか・なぜ効いたかを窓から読める。

## 変えない挙動

SPEC `DEVELOP/SPEC/RENDERING.md` から確定した保存対象:

- 「雲の描画」節の全不変条件 — 広い尺度の濃さ・被覆は細部で変えない、視点を動かしただけで
  雲の形は変わらない、カメラ/大気/雲影の 3 経路は同じ立体分布から決まる(一貫性)、
  立体的・多層的・動的であること。**同じ実効段なら絵は従来と同じ** でなければならない。
- 「描画品質設定」節 — 「雲」「積雲」「巻雲」「雲の影」のオン/オフは引き続きユーザー
  だけが触る。自動適応が雲を消したり現したりしない。プリセットの既定値も変えない。
- 「画面上の大きさに基づく詳細度(LOD)」節 — 球体メッシュ LOD など既存の規則はそのまま。
  フットプリント上限はその延長として実効の精細さを制限するだけ。
- 「デバッグ情報ウィンドウ」節 — 開いている間だけ計測、閉じている間は負荷に影響しない。
  sync 内訳も FrameSections と同じ「窓が開いている間だけ時計を読む」経路に載せる。
  GPU の常時集計(手順 2)はタイムスタンプ解決が従来から毎フレーム走っている経路へ
  パス4個ぶんの Map 挿入を足すだけで、新たな GPU 問い合わせは増やさない。

直してよい挙動(意図的に変えるもの — 手順 0 で SPEC へ書く):

- 「積雲の精細さ」「巻雲の精細さ」が描画へそのまま効く値から「上限」へ変わる。
- デバッグ窓の計測タブに「sync 内訳」グループと「雲の実効段」の行が増える。

## 達成目標

全手順の実施後、以下を1つずつ当てる。

1. `?perf=1` の計測タブに sync 内訳の行が出て、区間の合計が sync 行の ±10% に収まる。
2. デバッグ窓を閉じていても雲 4 パス(雲の生成・表面雲・大気(雲あり)・雲影)の GPU
   時間が集計されている(実効段の判定材料として読める)。
3. render-lab で同じ実効段を強制したショットが、適応導入の前後で見た目変わらない。
4. render-lab:measure の 3 パス計が、実効段ごとに基線値 ±10% を再現する
   (粗 ≈ 5.5ms / 標準 ≈ 8.7ms / 精細 ≈ 13.1ms)。
5. 予算を意図的に狭めた検証条件で実効段が下がり、戻したら段が復帰する。往復は冷却期間
   分より速く起きない。
6. `npm run typecheck` と `npm run test:render` `npm run test:game` が通る。

## 手順

### 手順 0. SPEC 更新(docs(spec) commit)

**目的** — 「精細さは上限」「sync 内訳を出す」「実効段を窓に出す」を挙動の正本へ書く。
コードより先行させるため最初にやる。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md` | 「描画品質設定」節の積雲/巻雲の精細さの項へ「実効の段は設定値を上限として、画素が解像できない尺度と描画負荷の超過に応じて自動で下がり、余裕が戻れば戻る。雲自体の表示/非表示は変えない」を書く。「デバッグ情報ウィンドウ」節へ「sync 内訳」グループ(update 内訳と同形式)と、雲の実効段・上限の出どころを出す行を書く |

**達成条件と検証** — `docs(spec):` の単独 commit。`npm run typecheck`(文書のみだが手順の検査系として必ず走す)。節内の記述が既存の不変条件(保存対象)と矛盾しないことを目で読む。

### 手順 1. sync 内訳の計測と表示

**目的** — sync フェーズを区間へ分けて計測し、雲焼成の投入を含む重さの所在を見えるようにする。
この後の削減の観測口でもある。GamePresentation.sync は既に syncCamera / syncWorld /
syncEffectsAndTargets / syncPanelsAndMarkers と自然な区切りを持つ。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/frame-sections.ts` | sync 用の区間表(SYNC_SECTION + SYNC_SECTION_LABELS)を足す。FrameSections 本体は区間数依存なので、update と同じ仕組みの第2インスタンスとして使える形にする(ラベル表を外から渡せる形への汎用化はこの手順で行い、update 側の挙動は変えない) |
| `src/game/game-presentation.ts` | sync() 内の呼び出しへ enter/exit を挿す。区切り: カメラ(syncCamera) / 天体(celestialSystem.sync + bakeClouds の投入を含む syncWorld 冒頭〜illumination まで) / 建造(shipConstruction + view) / 動的物体(dynamicSystem) / 標識(playerMarkers・equatorNodes・orbitSlots) / 演出・照準(syncEffectsAndTargets) / 窓・パネル(syncPanelsAndMarkers) / その他(残余) |
| `src/game/hud/windows/debug-info-window.ts` | 「sync 内訳」グループの行を足す(update 内訳と同じ barText 形式。通らなかった区間も 0.0ms で出す) |
| `src/run/run.ts` | sections 配線。sync 区間計測の有効化は debugInfo の開閉に連動させる(sections.enabled と同じ経路) |

**達成条件と検証** — `npm run typecheck`、`npm run test:game`。`?perf=1` で起動して
計測タブに sync 内訳の行が並び、区間合計が sync 行と ±10% で一致することを目で見る。

### 手順 2. 雲パス GPU 時間の常時集計

**目的** — 予算上限の判定材料(雲パスの GPU 合計・フレームに占める割合)を、デバッグ窓を
開いていなくても読めるようにする。現状 `enabled` が偽だと `beginPass` の宣言が捨てられ
帰属されないので、雲 4 パスだけは常時帰属・加算する。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/render/gpu-timings.ts` | 常時帰属するパス集合(GPU_PASS.cloudBake/cloudSurface/cloudAtmosphere/cloudShadow)を持たせ、`beginPass`/`onBeginRender`/`collectTimestamps` で enabled の有無に関わらずその集合だけ帰属・積算する。`msOf` はそのまま使える。`resolve()` は既に毎フレーム呼ばれている(run.ts:168)ので新たな問い合わせは増えない |

**達成条件と検証** — `npm run typecheck`、`npm run test:render`。窓を閉じた状態で
`gpu.msOf(GPU_PASS.cloudSurface)` が 0 より大きいことを、render-lab の CDP 口から
`gpu.snapshot().elapsedMs` を読んで確認(render-lab-measure と同じ窓口を使う)。

### 手順 3. 積雲マテリアルの段別事前構築

**目的** — 段替えをコンパイルヒッチなしでできるようにする。**この時点で挙動は変えない**
(実効段はまだ設定値のまま、マテリアルを3本持つだけ)。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/render/opaque-cloud-surface-renderer.ts` | `material` 1本保持を `materials: Map<CumulusDetail, Material>` へ。`setDetail` は sampling と octaves を置き、`mesh.material = materials.get(detail)` に交換するだけにする。`rebuildMaterial` は撤去。`dispose` は3本ぶん。構築時に3段ぶん組む |
| `src/game/game-presentation.ts` または `src/render/scene.ts` | warmUp/compile で3段ぶんのコンパイルを済ませる(既存の compile 経路に載せる) |

**達成条件と検証** — `npm run typecheck`、`npm run test:render`。
`npm run render-lab:shot` で earth のショットを撮り、設定パネルで積雲の精細さを切り替えても
従来どおり段が変わること、同じ段ではショットが変わらないことを見る。

### 手順 4. 品質ガバナ — 実効段の決定と3経路への配線

**目的** — 実効の積雲・巻雲の精細さを min(設定, フットプリント上限, 予算上限) で毎フレーム
決め、表面雲・大気・雲影の3経路へ同じ値を届ける(3経路が同じ段を読まないと SPEC の
一貫性を崩す)。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/render/earth-weather/cloud/cloud-quality-governor.ts` (新規) | 予算上限の状態(EMA/連続超過窓/冷却)を持つガバナと、見かけ直径からフットプリント上限段を返す純関数。判定は「フレーム p95 が 16.7ms 枠を超え、かつ雲3パスの GPU 合計がフレームの 25% 以上」で1段下げ、余裕が 5s 続けば戻す、変更後 2s 冷却。ポーズ・マップ・加速中は窓を回さない |
| `src/render/earth-weather/cloud/cloud-presentation.ts` | `syncGraphics` で実効段を決めて `setDetail(effective)`。`renderInput` へ実効の octaves を載せる(CloudRenderInput 拡張) |
| `src/render/earth-weather/cloud/cloud-render-input.ts` | 実効 octaves のフィールドを足す |
| `src/render/celestial/celestial-illumination.ts` | `syncCloudShadow` が caster(雲の源の天体)の実効 octaves を kinds へ使う。`cloudShadowKinds` の形を実効値を受ける形へ変える |
| `src/render/pipeline/shadow/shadow-select.ts` | `cloudShadowKinds` を実効 octaves を引数に取る形へ |
| `src/render/pipeline/cloud-atmosphere-renderer.ts` / `atmosphere-pass.ts` | 巻雲の実効 octaves を per-body の雲入力(clouds.cloud)から読む形へ。rebuild 時の `setCirrusDetail` は上限として残す |
| `src/render/scene.ts` | `syncFrame` など毎フレームの入口でガバナを更新(gpu snapshot + フレーム時間) |

**達成条件と検証** — `npm run typecheck`、`npm run test:render`。
`npm run render-lab:measure` を再測して実効段ごとの3パス計が基線 ±10% に収まること。
`render-lab:shot` の earth で、同じ実効段なら導入前のショットと絵が変わらないこと。
目視するのは render-lab の earth 構図(雲頂の起伏と縁、雲影、大気越しの雲)の3画面。

### 手順 5. デバッグ窓へ実効段の表示

**目的** — 適応が効いているか・なぜ効いたかを窓から読めるようにする。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/perf-counts.ts` | 実効段(積雲・巻雲)と上限の出どころ(設定/フットプリント/予算)を PerfCounts へ載せる |
| `src/game/hud/windows/debug-info-window.ts` | 「雲」グループ(または描画グループ内)に実効段の行を足す |

**達成条件と検証** — `npm run typecheck`、`npm run test:game`。`?perf=1` で行が見え、
予算を狭めた検証条件で値が動くことを見る。

## 見積り

実測値による導出:

- 効果の上限 — 標準 → 粗で 3 パス計 −3.13ms、精細 → 標準で −4.47ms(基線表より)。
  16.7ms 枠で標準を維持したまま他の費用が 8.0ms を超える構図では、粗への降格で
  枠内へ戻せる見込み。
- フットプリント上限の効果 — 地球が遠く(見かけ直径が小さい)ほど早く段が下がる。
  低軌道の常用構図では span_min が小さいので段は据え置かれ、削減は予算上限側が担う。

作業量:

| 手順 | 見積り | 根拠 |
| --- | --- | --- |
| 0. SPEC | 0.5h | 節2箇所の追記 |
| 1. sync 内訳 | 1.5h | 区間表1本 + enter/exit 約8箇所 + 窓1グループ |
| 2. GPU 常時集計 | 0.5h | gpu-timings の条件分岐と器1つ |
| 3. マテリアル事前構築 | 1h | 保持の持ち方と dispose/warmUp 配線 |
| 4. ガバナ | 2.5h | 新規1本 + 配線6箇所 + ヒステリシス調整 |
| 5. 実効段の表示 | 0.5h | PerfCounts 2項目 + 行1つ |
| 計 | 約 6.5h | |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| マテリアル3本の事前構築で起動時コンパイルが増える | 起動(warmUp)が伸びる | 手順3 — compile 経路の所要を warmUp の進捗表示/時間で見る |
| GPU 時刻印が取れない環境 | 予算上限が働かない。フットプリント上限のみ効く(既定の設定値がそのまま出るので無害) | 手順4 — `gpu.supported` 偽の分岐 |
| ヒステリシス不足で段が往復する | 細部が明滅し、SPEC「視点を動かしただけで雲の形は変わらない」の精神に反する | 手順4 — 連続窓・冷却の条件、手順5の実効段行で往復回数を見る |
| マップ遷移・ワープ・ロードでフレーム時間が歪む | 誤降格 | 手順4 — ポーズ/マップ/加速中は判定を止める条件 |
| 3経路で実効段が食い違う | 表面と影・大気の細部がずれ、SPEC の一貫性を崩す | 手順4 — CloudRenderInput に実効値を載せ、全経路が同じ値を読む |
| フットプリント上限の閾値が強すぎる | 近景で見えるはずの細部が消える(品質を損なう) | 手順4 — render-lab:shot の近景で比較。閾値は fadeOf の 0 側(FADE_ZERO_RATIO=2)に揃える |
| sync 区間の境界ずれ | 区間和と sync 行が乖離し、計測自体が嘘になる | 手順1 — 達成条件の ±10% チェック |
| 常時集計の帰属が他パスへ漏れる | 雲以外のパス時間が雲へ計上され判定を歪める | 手順2 — 雲パスだけが集合に入ること、 render-lab:measure の表が基線と一致すること |

## 対象外

- 雲場の焼成(cloudBake)間隔の適応 — 焼成は既に表示時刻の刻みで駆動されている。sync 内訳で
  投入コストを見てから別計画へ。
- 大気品質(低/中/高)自体の適応 — 雲とは別の設定で、本計画は雲の精細さだけを対象にする。
- 地球以外の天体の雲(SPEC 未確定の案)。
