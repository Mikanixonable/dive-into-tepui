# 無駄に複雑な挙動を作っている実装 — 削除・修正の候補

調査時点: `restructure-architecture` @ `1772c935`(規約点検・コメント点検まで済ませた時点)。
`path:line` と現存はこの時点で1件ずつ確かめ直してある。

**残すか消すかはユーザーが判断する。** この文書は候補の一覧と疑いの順位だけを持つ。挙動変化を伴うので、
実施する分は refactor とは別の PR にする。

## 読み方

- **確度** — 「レガシーで、維持する理由がない」という疑いの強さ。高=ほぼ意図されていない、中=判断が要る、低=擬陽性寄り。
- **仕様** — SPEC に書かれていれば消すべきでない疑いが上がる。ただし SPEC にも場当たりの追記があるので、
  **第4群**には「仕様ごと消す/直す」ものを分けた。
- **計画** — `memos/hedalu244/restructure-architecture.md` が既に手を付ける予定のものは段・手順を添えた。
  重複して着手しないための印で、そこに載っていること自体は「消してよい」の根拠にならない。
- **範囲** — この文書は**挙動を変える候補だけ**を持つ。洗い出しで出た依存の向きと mutable の置き場の問題
  (目視できる範囲で挙動が変わらないもの)は `restructure-architecture.md` の **K6** と各手順にある。ここには残さない。

## このブランチで片付いたもの

洗い出し時にあった候補のうち、以下は `042596fc`〜`1772c935` の作業で消えたので、この文書から落とした。

| 消えたもの | どの作業で |
| --- | --- |
| BGM を再出撃・タイトルで止めない(R15)、退役を実時刻タイマーで待つ | 段 1 の宣言化と `98e29b40` |
| 記録の由来タグ `SnapshotKind`(`'checkpoint'` を含む) | `213d6274` |
| セーブの旧い版からの変換 | `a459c999` |
| 折りたたみ保存のビュー別移行(`hud-selection.ts` 側) | 段 2 |
| 軌道ガイドの選択がブラウザに残る | `962db128` |
| 予測を読む者のフラグ3種 | `9bef624f` |
| 計画ノードの消化がビューに依存する | `a01d9c36` |
| エンティティ id の採番器がランを跨ぐ / 復元 id と衝突する | `a566fc45`・`66896940` |
| 衛星軌道線の月の例外 | `5ad80e30` |
| 天体の位置・自転位相が構築時の乱数に依る | `80c63542` |
| `generatePointField` の効かない省略可能引数、ラグランジュのヤコビ定数の二重既定値 | 規約点検(`cc583aa1`) |
| `generateWave` の `forcedPattern`(擬陽性。stage00 が `'random'` を渡している) | — |

---

# 第1群 — 挙動が意図されていないもの(最優先)

仕様に反している、または誰も要求していない副作用が出ているもの。

### R17. 地球・月の名指しが一般の仕組みの隣に残っている(6箇所)
- 症状: 天体を一般に扱う仕組みがあるのに、地球・月・太陽を文字列で名指しする分岐が並んでいる。
  1. 軌道要素の基準が `'auto'|'earth'|'moon'|'target'` の固定2択。架空星系でもボタンが出て、押すと無言で自動選択のまま(`src/game/orbit-reference.ts:12,54-60`、`src/game/hud/orbit/orbit-panel.ts:16-18`)
  2. カメラの基準面が `findMotion('moon')`/`findMotion('earth')`。月が無い星系で「月軌道面」を選ぶと無言で黄道面に落ちる(`src/game/camera/focus-camera.ts:261-265`)
  3. 近点/遠点の和名が `'earth'/'moon'/'sun'` の if 連鎖。火星・木星では一般名「近点」に落ちる(`src/game/hud/orbit/orbit-labels.ts:12-24`、`src/game/creative/placement-validation.ts:27-28` は `?? 'earth'` まで名指し)
  5. 「地球専用」参照軌道(静止・太陽同期・モルニヤ・ツンドラ)。物理側 `src/physics/earth-reference-orbits.ts:28,60` は mu・J2・自転周期を `CelestialBody` から読む完全に一般の実装(`src/game/celestial/orbit-guide/orbit-guide-model.ts:331-332`、`src/game/pickable/line-pickables.ts:55`)
  6. CR3BP の系→天体の固定表。系 id が「主-副」そのままで、表の `[0]`(主天体)は誰も読まない — 読み手は `:54` の `[1]` だけ(`src/physics/orbit-guide.ts:40-50`)
  7. スケールグリッドが `findMotion('moon')`(`src/game/celestial/scale-grid-view.ts:41`)
- 疑う理由: どれも「地球-月しか無かった時期」の名残。一般の判定(`CelestialClass`・親子関係・`motion.primary.id`)が同じファイルの隣にある。
- 仕様: 1 は ORBIT.md に、5 は MAP.md に書かれている → **第4群**。3・6・7 は記述なし
- 減るもの: 名指し分岐6箇所と、無言で落ちる選択肢が消える。天体を増やしたときに HUD・カメラを触らなくて済む。/ 確度: 高(3・6・7)/ 中(1・2・5)

### R20. 接触代理の置き直しが履歴キューに毎サブステップ積み続ける
- 症状: 放熱板の折り 12 個とベルト節点 18 個が毎サブステップ `proxy.state = world` で置き直され、setter が `DynamicTrajectory.reset()` → `StateQueue.push()` を通る。間引きも切り捨ても無いので 30 本のキューが無制限に伸びる。
- 場所: `src/game/player/radiator.ts:193`、`src/game/player/belt-physics.ts:246`、`src/game/dynamic/dynamic-motion.ts:209`、`src/physics/state-queue.ts:54`
- 疑う理由: `state` setter は「不連続な飛び」のための口で、毎歩の再配置用ではない。代理の履歴は誰も `at()` で引かない。
- 仕様: SPEC に記述なし
- 減るもの: 長い戦闘での漸進的なフレーム落ちが無くなる。/ 確度: 中

---

# 第2群 — レガシーの名残で、消すと単純になる(挙動が小さく変わる)

### R28. 視点リセットが2種類あり、マップ側は仕様の半分しかしない
- 症状: 同じ「視点リセット」で、戦闘ビューはフォーカスと基準フレームまで戻すが、マップはロールとパンだけ。さらに `/` と `_` の同時押しで、押している間ずっと `mapCamera.reset()` が走る隠し操作がある。
- 場所: `src/game/camera/camera-system.ts:62-68,186-190`、`src/game/camera/focus-camera.ts:378,489`
- 疑う理由: `reset()` と `resetToInitial()` の2経路が並立し、ヒント文も別々。同時押しはエッジ判定でなく、同じ操作が中クリックとボタンで既に届く。
- 仕様: CAMERA.md「**視点リセット**は、フォーカスを操作対象へ、基準フレームをそのビューの既定へ、視点を既定の後方見下ろしへ戻す」— ビューによる差は書かれていない。CONTROLS.md に同時押しの記述なし
- 減るもの: リセット経路が1つになり、ヒント文の二重管理とビュー分岐が消える。/ 確度: 中

### R30. 折りたたみの初期値が4箇所で「畳む」になっている
- 症状: 初回起動時、左右レール・Orbit パネル・Enemies パネル・表示パネルが畳まれて始まる。`hud-root.ts:269` だけ `isCompactViewport()` を構築時に1度評価するので、画面回転で再評価されない。
- 場所: `src/game/hud/hud-root.ts:72,170,269`、`src/game/hud/panels/view-options-panel.ts:208`
- 疑う理由: 仕様が既定を1つに定めているのに、既定が4箇所へ散って別々の条件を持っている。
- 仕様: UI-DESIGN.md §5「折りたたみの選択がまだ保存されていない…ときの既定値は**展開**とする」
- 減るもの: `defaultCollapsed` の分岐と関数版/値版の二形が消える。/ 確度: 中

### R31. BGM 音量の初期値が3重に配られ、消音ボタンの復帰音量だけ保存されない
- 症状: 同じ初期音量が `Bgm`・`PauseMenu`・`SettingsView` の3コンストラクタへ渡され、直後に購読の初回通知で上書きされる。消音してから再読込すると「消音」解除で 100% に戻る。
- 場所: `src/main.ts:137,140,157`、`src/hud/windows/pause-menu.ts:49,124,127,206-211`
- 疑う理由: `StoredSetting.subscribe` は登録時に現在値で必ず1回呼ぶ。`lastVol` だけが保存されない隠れステートで、音量スライダーが 0 にできるのでボタン自体が無くても消音はできる。
- 仕様: AUDIO.md「設定画面の BGM 欄で、全体の音量調整と…ができる」/ UI-DESIGN.md の一時停止タブの一覧に消音ボタンの記述なし
- 減るもの: コンストラクタ引数3つ、ステート1つ、ボタン1つと `toggleMute`/`updateMuteState`。/ 確度: 中

---

# 第3群 — 死んだコード・到達不能な分岐(挙動不変、消すだけ)

### R35. 到達不能な分岐と、使われない選択肢が型に残っている
- 症状: 以下がすべて生成・到達されないまま型と分岐に残っている。
  - `LEGACY_PANEL_COLLAPSED_KEY` からの移行読み(`f43e1973` の1回限り)— `src/settings/user-settings.ts:23,61`。**消すと既存ユーザーの折り畳み状態が失われる**ので、そこだけは判断が要る
  - `generateCluster` の `groupCount`/`perGroup`(唯一の呼び手 `stage0.ts` が渡さない)— `src/game/stages/spawner/enemy-spawner.ts:44-45`。畳むと並行する `COLOR_STAGE0_GROUP_ACCENTS`/`STAGE0_GROUP_LABELS` の対応付けも一緒に整理することになる
  - `BoosterStack.step` の `fuelRate === 0` 無限燃焼 — `src/game/player/booster-stack.ts:165,180`
  - `WeaponPart.weaponType` の `'cannon'|'missile'`(生成は `'gatling'` だけ)— `src/game/dynamic/dynamic-entity/parts.ts:51`
  - `BGM_TRACKS` が空のときのガード2箇所(リテラル定数で空になりえない)— `src/audio/bgm/bgm.ts:131`、`src/audio/bgm/conductor.ts:49`
  - 敵弾の弾種の二重判定(敵は `'plasma'` しか撃たない)— `src/game/dynamic/dynamic-entity/bullet-reaction.ts:66`
  - 質量比の正本が2つ(`CATALOG_SYSTEM_SCALES` の計算値と、索引に無い系のリテラル)— `src/game/celestial/orbit-guide/orbit-guide-catalog.ts:17,23,43`
  - `crypto` 不在のフォールバック(WebGPU 必須=secure context なので到達しない)— `src/launcher/stage-select.ts:59-63`
- 仕様: いずれも該当の記述なし(無限燃焼は FLIGHT.md が「燃料が尽きるまで燃える」と明言)
- 減るもの: 省略可能引数と分岐が十数本。挙動は変わらない。/ 確度: 高

### R36. 未配線の足場が6ファイルある(計 229 行)
- 症状: 定義だけがあり、互いを import し合うだけで**外から1本も参照されていない。**
  - `src/game/input/{game-input-router,game-actions,game-commands}.ts`(88 + 15 + 8 行)— `claimedCodes` による先着消費という同じ仕組みが `src/input/input.ts` に既にある
  - `src/game/pickable/entity-inspection.ts`(59 行)— `InspectedObject` と `MenuAction` が同じ役目を果たしており、語彙がほぼ丸写しで手で同期されている
  - `src/game/dynamic/{dynamic-presenter,entity-lifecycle}.ts`(19 + 40 行)
- 疑う理由: 未参照 export の全量走査で確定。mikanixonable が 2026-09-11 に追加したもの。
- 仕様: CONTROLS.md は優先順位の結果だけを定め、port/router という仕組みを要求していない
- 減るもの: 229 行と型10以上。「入力の優先順位はどこで決まるか」の答えが1経路になる。/ 確度: 高 / 計画: K5 — **消すときは作者の合意を得る**。採否は手順 3-6(入力)・5-3・5-4(表示担当)で決める

### R37. どこからも参照されていない export
- 場所(`src`/`tests`/`tools` の全量走査で確定):
  - `src/physics/sphere-contact.ts` の `sweptSagitta`
  - `src/game/camera/focus-camera.ts:20` の `FOCUS_CAMERA_MIN_DIST`
  - `src/game/loading-progress.ts:9` の `LOADING_PHASE_WEIGHTS`
  - `src/game/protein/protein-asset-loader.ts` の `isProteinAssetReady`
  - `src/physics/time/index.ts` の `ttToTdb`/`tdbToTt`/`utcToTdb`/`tdbToUtc`/`convertJulianDate`
  - `src/render/` の地表まわり: `celestialSurfaceViewport`、`climateSlope`、`createEarthSurface`、`decodeEarthSurfaceNormalNode`、`srgbColorToLinear`、`EARTH_SURFACE_CAPTURE_CASE_SET`、`requireEarthSurfaceBaseUrl`、`requireEarthSurfaceDatasetId`
- 疑う理由: 機械検査で確定。`tests/physics` が `src/physics` を直接コンパイルすることを織り込んで `tests`/`tools` も走査対象に入れてある。
  地表まわりは実験環境で使うつもりで置かれた口の可能性があるので、消す前に `tools/` の用途を確かめる。
- 減るもの: 関数13・定数3。挙動不変。/ 確度: 高(physics/game)/ 中(render の地表)
- 付記: 同じ走査で「定義ファイル内でしか参照されない export」が約120件出た(多くは `interface`)。これは `export` の外し忘れで、挙動の話ではない。

### R38. 索引に書くだけで誰も読まないフィールドが4つある
- 症状: スナップショットを撮るたびに `maxHp`/`magazines`/`phase` が索引へ書かれるが一覧カードは表示しない。`StageHistoryMeta.clearCount` は常に 0 で、実際のクリア回数は `tepui.clearCounts`(UnlockManager)が全スロット横断で持っている。
- 場所: `src/launcher/save/slot-data.ts:23,24,28,34`、`src/launcher/save/snapshot-service.ts`、`src/launcher/unlock-manager.ts:6,34`
- 疑う理由: 同じ概念(クリア回数)の置き場が2つあり、片方だけが生きている。索引は全スナップショット分が1キーに載るので、容量超過の剪定頻度にも効く。
- 仕様: GAME.md「クリア回数は保存され、新たにアンロックされたステージがあればトースト通知される」— どこに属するかは書かれていない
- 減るもの: フィールド4つ。「解放は歴史線を跨ぐ」という現状の挙動が型からも読めるようになる。`SAVE_INDEX_VERSION` は既に 2 なので互換の問題はない。/ 確度: 高

### R73. 試聴の曲番号にだけ効かないクランプが掛かっている
- 症状: `Conductor.start(trackIdx?)` が、明示された曲番号を `Math.max(0, Math.min(BGM_TRACKS.length - 1, Math.floor(trackIdx)))` で丸める。番号を明示する経路は試聴の1本だけで、渡ってくるのは `BGM_TRACKS.entries()` の添字そのもの。範囲外も非整数も届かない。
- 場所: `src/audio/bgm/conductor.ts:52`(呼び手は `src/audio/bgm/bgm.ts` ← `src/hud/panels/bgm-settings-panel.ts`)
- 疑う理由: 省略時に無作為へ落ちる引数そのものは、送る線(ゲーム中)と送らない線(試聴)の違いなので要る。効いていないのはクランプだけ。
- 仕様: 記述なし
- 減るもの: クランプ1つ。挙動は変わらない。/ 確度: 高
- 付記: 同じ関数の空ガード(**R35** の `conductor.ts:49`)と一緒に外すのが早い

---

# 第4群 — 仕様ごと消す/直す候補

**仕様に書かれているが、実装を十分に無駄に複雑にしているもの。** 修正するなら `/modify-feature` で SPEC を先に直し、
`docs(spec):` の単独 commit にする。

| # | 挙動 | 仕様の位置 | 提案 |
| --- | --- | --- | --- |
| R17-1 | 軌道基準を地球・月・ターゲットに固定できる | ORBIT.md | 登録天体から候補を引く形へ。ORBIT.md「未確定の案」の「基準天体とマップの参照フレームの統合」と合わせて進める |
| R17-5 | 参照軌道は地球専用 | MAP.md「いずれも地球専用の軌道なので系の軸を持たない」 | 物理側は既に一般。仕様を実装の一般性へ進める |
| — | 一巡という長さを持たない曲ではシークできない | AUDIO.md | antipode も厳密な周期曲で、`kind === 'antipode'` の case を書いていないだけ(`src/audio/bgm/track-cycle.ts:13,26,34`)。実装の穴を追認した文なので、仕様ごと消して全曲シーク可にする |
| — | 決着済みセーブから結果を組み立て直す | SAVE.md が自己矛盾(「決着後は保存できない」と「保存された勝敗から組み立て直す」) | 片側を落とせば `fallbackResult` と「結果の記録がありません」画面が消える(`src/launcher/launcher.ts:43-44,176`)/ 確度: 低 |
| — | T: RCS 回転制動の ON/OFF | CONTROLS.md:38 の表 | 実キーは `P`。仕様と実装の両方が食い違っている(`src/input/key-mapping.ts:29` の `rcsDampToggle`)/ 確度: 中 |

---

# 第5群 — 擬陽性寄り・判断が要るもの

確度が低い、または「無駄な複雑さ」ではなく別の種類の問題。一応挙げる。

- **R44. タイトル画面で配色を変えても 3D 背景だけ追随しない。** `TitleScene` は `palette` を構築時に焼き込んで購読しない。ラン中の 3D は毎フレーム読む。UI-DESIGN.md「選択は画面へ即座に反映される」に反する。`src/launcher/title-scene.ts:325-348`。/ 確度: 中
- **R49. 被弾音が非操作の自艦の被弾でも鳴る。** 減衰が単艦前提の尺度。AUDIO.md の明文の対象は連続音だけ。`src/game/player/player.ts:756,786`。/ 確度: 低
- **R72. ページを読み込み直すと、最後の自動保存より後に選んだ状態が消える。** 再開は最新のスナップショットから組み直す
  (`src/launcher/launcher.ts:185-188`)が、自動保存は実時間60秒ごと(`src/launcher/save/autosave.ts:4,20`、SAVE.md が明記)で、
  離脱時に撮る経路が無く(`pagehide` を聞くのは入力だけ)、一時停止中は撮らない。いまもカメラの視点・
  基準面・画角が最長60秒ぶん戻る。INVARIANTS §6「ページを読み込み直しても直前の状態で開く」と SAVE.md の間隔が噛み合って
  いない。**何をスナップショットに入れるか(R23)とは直交する** — 表示をセーブへ移すと戻る対象が増えるだけで、
  問題の形は変わらない。/ 確度: 中
- **R74. 撃破された対象の名前が Target 欄に出続ける。** `NavTarget.sync` は対象が生存しなくても `targetId`/`targetName` を
  消さず、マーカーを退役させるだけ(`src/game/nav-target.ts:161-163`)。`aliveCombatTarget` は null を返すのに、
  `src/game/hud/view-badge.ts:133` は保持中の名前を出す。消える経路は `toggleTarget` と `Controllable` の除去の2つだけ。
  意図かどうかは未判断。/ 確度: 中

---

## 計画との重なり

`restructure-architecture.md` が同じ場所を通る予定のもの。

| ここの項 | 計画のどこ |
| --- | --- |
| R36(未配線の足場) | K5。採否は手順 3-6(入力)・5-3・5-4(表示担当)で決める — **消すときは作者の合意を得る** |
| R17-2(カメラの基準面)・R28(視点リセット)・R37 の `FOCUS_CAMERA_MIN_DIST` | 手順 4-3 がカメラを `game/viewer/` へ移す |
| R17-5・R17-6・R17-7(参照軌道・CR3BP の表・スケールグリッド) | 手順 6-3 が天体の見た目と UI を分ける |
| R38(索引の死にフィールド) | 手順 7-6 が launcher の面を絞る |

**これらは「リファクタリングで置き場が変わる」予定であって、「挙動を消す」判断は別である。** 置き場を動かす前に
消すと決めたものは、動かす手間が丸ごと省ける。

## 再現コマンド

```sh
grep -rn "Math.random" src --include=*.ts --include=*.tsx          # 55件
grep -rn "localStorage" src --include=*.ts                          # 19件。保存鍵の全量は src/settings/user-settings.ts
grep -rniE "findMotion\('(earth|moon)'\)" src --include=*.ts
grep -rn "Date.now()\|performance.now()" src --include=*.ts | grep -vE "^src/(render|launcher)/"
grep -rnE "\(\s*[^)]*,\s*undefined\s*[,)]" src --include=*.ts       # 省略可能引数が不要な徴候

# 未参照 export の全量走査(数分かかる)
grep -rnoE "^export (async )?(function|class|const|let|interface|type|enum) [A-Za-z0-9_]+" \
     src --include=*.ts --include=*.tsx \
  | while IFS= read -r l; do f="${l%%:*}"; n="${l##* }"; \
      [ "$(grep -rlwF "$n" src tests tools --include=*.ts --include=*.tsx --include=*.mjs | grep -v "^$f$" | wc -l)" -eq 0 ] \
        && echo "$l"; done
```
