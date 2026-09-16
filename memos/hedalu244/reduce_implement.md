# 無駄に複雑な挙動を作っている実装 — 削除・修正の候補

調査時点: `restructure-architecture` @ `042596fc`(段 1・2 実施後)。`path:line` はこの時点のもの。

**残すか消すかはユーザーが判断する。** この文書は候補の一覧と疑いの順位だけを持つ。挙動変化を伴うので、
実施する分は refactor とは別の PR にする。

## 読み方

- **確度** — 「レガシーで、維持する理由がない」という疑いの強さ。高=ほぼ意図されていない、中=判断が要る、低=擬陽性寄り。
- **確認** — `自分で確認` はコード・git 履歴で裏を取ったもの。`報告のみ` はサブエージェントの報告を統合しただけで、
  実施前に現地確認が要る。
- **仕様** — SPEC に書かれていれば消すべきでない疑いが上がる。ただし SPEC にも場当たりの追記があるので、
  **第4群**には「仕様ごと消す/直す」ものを分けた。
- **計画** — `memos/hedalu244/restructure-architecture.md` が既に手を付ける予定のものは段・手順を添えた。
  重複して着手しないための印で、そこに載っていること自体は「消してよい」の根拠にならない。
- **範囲** — この文書は**挙動を変える候補だけ**を持つ。洗い出しで出た依存の向きと mutable の置き場の問題
  (目視できる範囲で挙動が変わらないもの)は、2026-09-16 に `restructure-architecture.md` の **K6** と
  各手順(2-3・3-1/3-3・4-3・5-4・7-6)へ移した。ここには残さない。

## 検出の方法と、例の再現

ユーザーが挙げた3例が機械検査で捕まることを確認してから配った。

| 例 | 捕まえた検査 | 現状 |
| --- | --- | --- |
| BGM を再出撃・タイトルで止めない | `grep -rn "bgm|Bgm|BGM" src` で呼び出し元6ファイルへ絞る | 段 1-6 の宣言化でほぼ解消。残りは **R15** |
| ランごとの項目がラン跨ぎ設定に載る | `grep -rn localStorage src` → 保存鍵の全量は `src/settings/user-settings.ts` の11項目 | 項目ごとの判定は **R23** |
| 自転が乱数・地球を名指し | `grep -rn "Math.random" src`(57件)→ `game.ts:170`、`grep -rniE "'(earth|moon|sun)'" src` | **R16**・**R17** |

これに加えて、未参照 export の全量走査(`export` 宣言を1件ずつ `src`/`tests`/`tools` へ突き合わせ)と、
`Date.now()`/`performance.now()` の層別走査、`undefined` を明示的に渡している引数の走査を通した。
範囲を7つに分けたサブエージェント(音 / 永続 / 天体 / HUD / 戦闘 / カメラ・計画・入力 / ラン寿命)の報告を統合した。

---

# 第1群 — 挙動が意図されていないもの(最優先)

仕様に反している、または誰も要求していない副作用が出ているもの。

### R17. 地球・月の名指しが一般の仕組みの隣に残っている(6箇所)
- 症状: 天体を一般に扱う仕組みがあるのに、地球・月・太陽を文字列で名指しする分岐が並んでいる。
  1. 軌道要素の基準が `'auto'|'earth'|'moon'|'target'` の固定2択。架空星系でもボタンが出て、押すと無言で自動選択のまま(`src/game/orbit-reference.ts:12,70-77`、`src/game/hud/orbit/orbit-panel.ts:14-19`)
  2. カメラの基準面が `findMotion('earth')`/`findMotion('moon')`。月が無い星系で「月軌道面」を選ぶと無言で黄道面に落ちる。赤道面は `?? motionOf(originId)` を併記していて二重決定(`src/game/camera/focus-camera.ts:271-284`)
  3. 近点/遠点の和名が `'earth'/'moon'/'sun'` の if 連鎖。火星・木星では一般名「近点」に落ちる(`src/game/hud/orbit/orbit-labels.ts:12-14`、`src/game/creative/placement-validation.ts:27-28` は `?? 'earth'` まで名指し)
  5. 「地球専用」参照軌道(静止・太陽同期・モルニヤ・ツンドラ)。物理側 `src/physics/earth-reference-orbits.ts:28-55` は mu・J2・自転周期を `CelestialBody` から読む完全に一般の実装(`src/game/celestial/orbit-guide/orbit-guide-model.ts:330-360`、`src/game/pickable/line-pickables.ts:55`)
  6. CR3BP の系→天体の固定表。系 id が「主-副」そのままで、表の `[0]`(主天体)は誰も読まない(`src/physics/orbit-guide.ts:40-55`)
  7. スケールグリッドが `findMotion('moon')`(`src/game/celestial/scale-grid-view.ts:41`)
- 疑う理由: どれも「地球-月しか無かった時期」の名残。一般の判定(`CelestialClass`・親子関係・`motion.primary.id`)が同じファイルの隣にある。
- 仕様: 1 は ORBIT.md に、5 は MAP.md に書かれている → **第4群**。3・6・7 は記述なし
- 減るもの: 名指し分岐6箇所と、無言で落ちる選択肢が消える。天体を増やしたときに HUD・カメラを触らなくて済む。/ 確度: 高(3・6・7)/ 中(1・2・5)/ 確認: 名指しの存在は自分で確認、一般化可能性は報告のみ

### R20. 接触代理の置き直しが履歴キューに毎サブステップ積み続ける
- 症状: 放熱板の折り 12 個とベルト節点 18 個が毎サブステップ `proxy.state = world` で置き直され、setter が `DynamicTrajectory.reset()` → `StateQueue.push()` を通る。間引きも切り捨ても無いので 30 本のキューが無制限に伸びる。
- 場所: `src/game/player/radiator.ts:193`、`src/game/player/belt-physics.ts:246`、`src/game/dynamic/dynamic-motion.ts:225-228`、`src/physics/state-queue.ts:55-62`
- 疑う理由: `state` setter は「不連続な飛び」のための口で、毎歩の再配置用ではない。代理の履歴は誰も `at()` で引かない。
- 仕様: SPEC に記述なし
- 減るもの: 長い戦闘での漸進的なフレーム落ちが無くなる。/ 確度: 中 / 確認: 報告のみ

---

# 第2群 — レガシーの名残で、消すと単純になる(挙動が小さく変わる)

### R28. 視点リセットが2種類あり、マップ側は仕様の半分しかしない
- 症状: 同じ「視点リセット」で、戦闘ビューはフォーカスと基準フレームまで戻すが、マップはロールとパンだけ。さらに `/` と `_` の同時押しで、押している間ずっと `mapCamera.reset()` が走る隠し操作がある。
- 場所: `src/game/camera/camera-system.ts:61-70,188-194`、`src/game/camera/focus-camera.ts:398-409,513-527`
- 疑う理由: `reset()` と `resetToInitial()` の2経路が並立し、ヒント文も別々。同時押しはエッジ判定でなく、同じ操作が中クリックとボタンで既に届く。
- 仕様: CAMERA.md「**視点リセット**は、フォーカスを操作対象へ、基準フレームをそのビューの既定へ、視点を既定の後方見下ろしへ戻す」— ビューによる差は書かれていない。CONTROLS.md に同時押しの記述なし
- 減るもの: リセット経路が1つになり、ヒント文の二重管理とビュー分岐が消える。/ 確度: 中 / 確認: 報告のみ

### R30. 折りたたみの初期値が4箇所で「畳む」になっている
- 症状: 初回起動時、左右レール・Orbit パネル・Enemies パネル・表示パネルが畳まれて始まる。`hud-root.ts:269` だけ `isCompactViewport()` を構築時に1度評価するので、画面回転で再評価されない。
- 場所: `src/game/hud/hud-root.ts:72,170,269`、`src/game/hud/panels/view-options-panel.ts:208`
- 疑う理由: 仕様が既定を1つに定めているのに、既定が4箇所へ散って別々の条件を持っている。
- 仕様: UI-DESIGN.md §5「折りたたみの選択がまだ保存されていない…ときの既定値は**展開**とする」
- 減るもの: `defaultCollapsed` の分岐と関数版/値版の二形が消える。/ 確度: 中 / 確認: 報告のみ

### R31. BGM 音量の初期値が4重に配られ、消音ボタンの復帰音量だけ保存されない
- 症状: 同じ初期音量が `Bgm`・`PauseMenu`・`SettingsView` の3コンストラクタへ渡され、直後に購読の初回通知で上書きされる。消音してから再読込すると「消音」解除で 100% に戻る。
- 場所: `src/main.ts:135,138`、`src/hud/windows/pause-menu.ts:50,130,207`、`src/settings/stored-setting.ts:80`
- 疑う理由: `StoredSetting.subscribe` は登録時に現在値で必ず1回呼ぶ。`lastVol` だけが保存されない隠れステートで、音量スライダーが 0 にできるのでボタン自体が無くても消音はできる。
- 仕様: AUDIO.md「設定画面の BGM 欄で、全体の音量調整と…ができる」/ UI-DESIGN.md の一時停止タブの一覧に消音ボタンの記述なし
- 減るもの: コンストラクタ引数3つ、ステート1つ、ボタン1つと `toggleMute`/`updateMuteState`。/ 確度: 中 / 確認: 報告のみ

---

# 第3群 — 死んだコード・到達不能な分岐(挙動不変、消すだけ)

### R35. 到達不能な分岐と、使われない選択肢が型に残っている
- 症状: 以下がすべて生成・到達されないまま型と分岐に残っている。
  - `SnapshotKind` の `'checkpoint'`(ラベル「決着」。`capture()` は `'auto'`/`'manual'` の2箇所だけ)— `src/launcher/save/slot-data.ts:9`
  - `LEGACY_PANEL_COLLAPSED_KEY` のビュー別移行(`f43e1973` の1回限り)— `src/settings/user-settings.ts:25,68-72`、`src/game/hud/hud-selection.ts:44-58`
  - `generateCluster` の `groupCount`/`perGroup`、`generateWave` の `forcedPattern`、`BoosterStack.step` の `fuelRate === 0` 無限燃焼、`WeaponPart.weaponType` の `'cannon'|'missile'`、`generatePointField` の既定引数2つ(片方は元期を畳む前の生の要素という誤った値)— `src/game/stages/spawner/enemy-spawner.ts:37-38`、`src/game/stages/stage-utils/wave-attack.ts:78`、`src/game/player/booster-stack.ts:189-192`、`src/game/celestial/solar-system/point-field.ts:231-234`
  - `BGM_TRACKS` が空のときのガード2箇所(リテラル定数で空になりえない)— `src/audio/bgm/bgm.ts:131`、`src/audio/bgm/conductor.ts:49`
  - 敵弾の弾種の二重判定(敵は `'plasma'` しか撃たない)— `src/game/dynamic/dynamic-entity/bullet-reaction.ts:61`
  - ラグランジュのヤコビ定数の二重既定値と、3つ目の質量比の正本 — `src/game/celestial/orbit-guide/orbit-guide-catalog.ts:38-45`
  - `crypto` 不在のフォールバック(WebGPU 必須=secure context なので到達しない)— `src/launcher/stage-select.ts:59-67`
- 仕様: いずれも該当の記述なし(無限燃焼は FLIGHT.md が「燃料が尽きるまで燃える」と明言)
- 減るもの: 省略可能引数6つ以上、分岐10本以上。挙動は変わらない。/ 確度: 高 / 確認: 報告のみ

### R36. 未配線の足場が4モジュールある
- 症状: 定義だけがあり、どこからも import されていない。
  - `src/game/input/{game-input-router,game-actions,game-commands}.ts` — `claimedCodes` による先着消費という同じ仕組みが `src/input/input.ts:446-498` に既にある
  - `src/game/pickable/entity-inspection.ts` — `InspectedObject` と `MenuAction` が同じ役目を果たしており、語彙がほぼ丸写しで手で同期されている
  - `src/game/dynamic/{dynamic-presenter,entity-lifecycle}.ts`
- 疑う理由: 未参照 export の全量走査で確定。mikanixonable が 2026-09-11 に追加したもの。
- 仕様: CONTROLS.md は優先順位の結果だけを定め、port/router という仕組みを要求していない
- 減るもの: 約200行と型10以上。「入力の優先順位はどこで決まるか」の答えが1経路になる。/ 確度: 高 / 確認: 自分で確認(未参照を走査)/ 計画: K5 — **消すときは作者の合意を得る**。採否は手順 3-6・5-3・5-4 で決める

### R37. どこからも参照されていない export が9つある
- 場所: `src/physics/cr3bp.ts:63`(`cr3bpPropagate`)、`:117`(`sampleOrbitByArcLengthWithTime`)、`src/physics/sphere-contact.ts:42`(`sweptSagitta`)、`src/physics/ephemeris/pack-format.ts:221`(`encodeFloat64Payload`)、`src/physics/player-shape.ts:27,30`(`MAG_THICKNESS`/`MAG_WIDTH`)、`src/game/protein/protein-asset-loader.ts:128`(`isProteinAssetReady`)、`src/game/loading-progress.ts:9`(`LOADING_PHASE_WEIGHTS`)、`src/game/camera/focus-camera.ts:20`(`FOCUS_CAMERA_MIN_DIST`)
- 疑う理由: 機械検査で確定。`tests/physics` が `src/physics` を直接コンパイルすることを織り込んで `tests`/`tools` も走査対象に入れたので、「src に呼び出し元が無い」だけの誤検出ではない。
- 仕様: 該当なし
- 減るもの: 関数5つ・定数4つ。挙動不変。/ 確度: 高 / 確認: 自分で確認
- 付記: 同じ走査で「定義ファイル内でしか参照されない export」が約40件出た(多くは `interface`)。これは `export` の外し忘れで、挙動の話ではない。必要なら別途。

### R38. 索引に書くだけで誰も読まないフィールドが3つある
- 症状: スナップショットを撮るたびに `maxHp`/`magazines` が索引へ書かれるが一覧カードは表示しない。`StageHistoryMeta.clearCount` は常に 0 で、実際のクリア回数は `tepui.clearCounts`(UnlockManager)が全スロット横断で持っている。
- 場所: `src/launcher/save/slot-data.ts:24-25,35`、`src/launcher/save/snapshot-service.ts:45-46`、`src/launcher/save/save-slots.ts:170`、`src/launcher/unlock-manager.ts:6,45`
- 疑う理由: 同じ概念(クリア回数)の置き場が2つあり、片方だけが生きている。索引は全スナップショット分が1キーに載るので、容量超過の剪定頻度にも効く。
- 仕様: GAME.md「クリア回数は保存され、新たにアンロックされたステージがあればトースト通知される」— どこに属するかは書かれていない
- 減るもの: フィールド3つ。「解放は歴史線を跨ぐ」という現状の挙動が型からも読めるようになる。/ 確度: 高 / 確認: 報告のみ

### R73. 試聴の曲番号にだけ効かないクランプが掛かっている
- 症状: `Conductor.start(trackIdx?)` が、明示された曲番号を `Math.max(0, Math.min(BGM_TRACKS.length - 1, Math.floor(trackIdx)))` で丸める。番号を明示する経路は試聴の1本だけで、渡ってくるのは `BGM_TRACKS.entries()` の添字そのもの。範囲外も非整数も届かない。
- 場所: `src/audio/bgm/conductor.ts:52`(呼び手は `src/audio/bgm/bgm.ts:134` ← `src/hud/panels/bgm-settings-panel.ts:151,85`)
- 疑う理由: 省略時に無作為へ落ちる引数そのものは、送る線(ゲーム中)と送らない線(試聴)の違いなので要る。効いていないのはクランプだけ。
- 仕様: 記述なし
- 減るもの: クランプ1つ。挙動は変わらない。/ 確度: 高 / 確認: 自分で確認(`.start(`・`playAudition` の呼び出しを全量で見た)
- 付記: 同じ関数の空ガード(**R35** の `conductor.ts:49`)と一緒に外すのが早い。2026-09-16、曲の選択の乱数(旧 R26。保持と決めて節ごと削除)を調べたときに見つけた

---

# 第4群 — 仕様ごと消す/直す候補

**仕様に書かれているが、実装を十分に無駄に複雑にしているもの。** 修正するなら `/modify-feature` で SPEC を先に直し、
`docs(spec):` の単独 commit にする。

| # | 挙動 | 仕様の位置 | 提案 |
| --- | --- | --- | --- |
| R17-1 | 軌道基準を地球・月・ターゲットに固定できる | ORBIT.md | 登録天体から候補を引く形へ。ORBIT.md「未確定の案」の「基準天体とマップの参照フレームの統合」と合わせて進める |
| R17-5 | 参照軌道は地球専用 | MAP.md「いずれも地球専用の軌道なので系の軸を持たない」 | 物理側は既に一般。仕様を実装の一般性へ進める |
| — | 一巡という長さを持たない曲ではシークできない | AUDIO.md | antipode も厳密な周期曲で、`kind==='antipode'` の case を書いていないだけ(`src/audio/bgm/track-cycle.ts:29,38`)。実装の穴を追認した文なので、仕様ごと消して全曲シーク可にする |
| — | 決着済みセーブから結果を組み立て直す | SAVE.md が自己矛盾(「決着後は保存できない」と「保存された勝敗から組み立て直す」) | 片側を落とせば `fallbackResult` と「結果の記録がありません」画面が消える(`src/launcher/launcher.ts:41-45,164-165`)/ 確度: 低 |
| — | T: RCS 回転制動の ON/OFF | CONTROLS.md の表 | 実キーは `P`。仕様と実装の両方が食い違っている(`src/input/key-mapping.ts:29`)/ 確度: 中 |

---

# 第5群 — 擬陽性寄り・判断が要るもの

確度が低い、または「無駄な複雑さ」ではなく別の種類の問題。一応挙げる。

- **R44. タイトル画面で配色を変えても 3D 背景だけ追随しない。** `TitleScene` は `palette` を構築時に焼き込んで購読しない。ラン中の 3D は毎フレーム読む。UI-DESIGN.md「選択は画面へ即座に反映される」に反する。`src/launcher/title-scene.ts:333-349`。/ 確度: 中
- **R49. 被弾音が非操作の自艦の被弾でも鳴る。** 減衰が単艦前提の尺度。AUDIO.md の明文の対象は連続音だけ。`src/game/player/player.ts:466,494`。/ 確度: 低
- **R72. ページを読み込み直すと、最後の自動保存より後に選んだ状態が消える。** 再開は最新のスナップショットから組み直す
  (`src/launcher/launcher.ts:186-192`)が、自動保存は実時間60秒ごと(`src/launcher/save/autosave.ts:5`、SAVE.md が明記)で、
  離脱時に撮る経路が無く(`pagehide` を聞くのは入力だけ)、一時停止中は撮らない(`autosave.ts:26-27`)。いまもカメラの視点・
  基準面・画角が最長60秒ぶん戻る。INVARIANTS §6「ページを読み込み直しても直前の状態で開く」と SAVE.md の間隔が噛み合って
  いない。**何をスナップショットに入れるか(R23)とは直交する** — R23 で表示をセーブへ移すと戻る対象が増えるだけで、
  問題の形は変わらない。2026-09-16 に R23 から分けた。/ 確度: 中
- **R74. 撃破された対象の名前が Target 欄に出続ける。** `NavTarget.sync` は対象が生存しなくても `targetId`/`targetName` を
  消さず、マーカーを退役させるだけ(`src/game/nav-target.ts:161-163`)。`resolveCombatTarget` は null を返すのに、
  `view-badge.ts:133` は保持中の名前を出す。消える経路は `toggleTarget` と `Controllable` の除去の2つだけ。
  意図かどうかは未判断。2026-09-16 に R69 から分けた(R69 の「id と表示名を統合しない」という判断そのものは
  `restructure-architecture.md` の K6 へ移した)。/ 確度: 中

---

## 計画との重なり

`restructure-architecture.md` が既に手を付ける予定のもの: R1・R2(段 3)、R11(K3-1 / 手順 3-5)、R14・R53(K2 / 手順 6-5)、
R16・R32(K2 / 手順 6-4)、R18(K2)、R36(K5 — 作者の合意が要る)。

**これらは「リファクタリングで置き場が変わる」予定であって、「挙動を消す」判断は別である。** 置き場を動かす前に
消すと決めたものは、動かす手間が丸ごと省ける(特に R32 は 9 系の構築関数の引数が消える)。

## 再現コマンド

```sh
grep -rn "Math.random" src --include=*.ts --include=*.tsx          # 57件
grep -rn "localStorage" src --include=*.ts                          # 保存鍵の全量は src/settings/user-settings.ts
grep -rniE "findMotion\('(earth|moon)'\)" src --include=*.ts
grep -rn "Date.now()\|performance.now()" src --include=*.ts | grep -vE "^src/(render|launcher)/"
grep -rnE "\(\s*[^)]*,\s*undefined\s*[,)]" src --include=*.ts       # 省略可能引数が不要な徴候

# 未参照 export の全量走査(数分かかる)
grep -rnoE "^export (async )?(function|class|const|let|interface|type|enum) [A-Za-z0-9_]+" \
     src --include=*.ts --include=*.tsx \
  | while IFS= read -r l; do f="${l%%:*}"; n="${l##* }"; \
      [ "$(grep -rlwF "$n" src tests tools --include=*.ts --include=*.tsx | grep -v "^$f$" | wc -l)" -eq 0 ] \
        && echo "$l"; done
```
