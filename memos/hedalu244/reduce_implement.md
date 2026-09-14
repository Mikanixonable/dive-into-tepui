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

### R5. 戦闘 HUD の「ブースター追加」が、基地も費用も要らずに満タンの段を生む
- 症状: 飛行中に燃焼管理パネルのボタンを押すだけで、既定値の段が4段まで生える。唯一のガードは段数上限。
- 場所: `src/game/hud/panels/burn-management-panel.ts:96-98`、`src/game/game.ts:292-293`、`src/game/player/attached-boosters.ts:52-62`
- 疑う理由: 手元確認用のボタンがそのまま常設 UI に残った形に見える。
- 仕様: FLIGHT.md「段は基地での船体組立で追加し、最大4段まで」— HUD から追加できるという記述はない
- 減るもの: ボタンと `onAttach` 経路が落ち、段の入手口が基地1箇所になる。/ 確度: 高 / 確認: 自分で確認

### R12. [N] 自動ワープと [X] 計画全体破棄が、仕様と逆のビューに置かれている
- 症状: [N] と「未選択の [X] で計画全体を破棄」は戦闘ビューでしか効かず、マップビューの [X] は選択ノードが無いと何も起きない。
- 場所: `src/game/view/combat-view.ts:69-84`、`src/game/plan/plan-editor.ts:178`、`src/game/view/map-view.ts:114-116`
- 疑う理由: 同じ `K.deleteNode` を2つのビューが別の意味で消費している。
- 仕様: CONTROLS.md「N … マップビュー、ノードがある場合」「X 選択中のノードを削除(未選択なら計画全体を破棄) マップビュー」
- 減るもの: `CombatView.handleInput` と `clearPlan` が消え、計画キーの窓口が `PlanEditor` 1つになる。/ 確度: 高 / 確認: 報告のみ

### R17. 地球・月の名指しが一般の仕組みの隣に残っている(7箇所)
- 症状: 天体を一般に扱う仕組みがあるのに、地球・月・太陽を文字列で名指しする分岐が並んでいる。
  1. 軌道要素の基準が `'auto'|'earth'|'moon'|'target'` の固定2択。架空星系でもボタンが出て、押すと無言で自動選択のまま(`src/game/orbit-reference.ts:12,70-77`、`src/game/hud/orbit/orbit-panel.ts:14-19`)
  2. カメラの基準面が `findMotion('earth')`/`findMotion('moon')`。月が無い星系で「月軌道面」を選ぶと無言で黄道面に落ちる。赤道面は `?? motionOf(originId)` を併記していて二重決定(`src/game/camera/focus-camera.ts:271-284`)
  3. 近点/遠点の和名が `'earth'/'moon'/'sun'` の if 連鎖。火星・木星では一般名「近点」に落ちる(`src/game/hud/orbit/orbit-labels.ts:12-14`、`src/game/creative/placement-validation.ts:27-28` は `?? 'earth'` まで名指し)
  4. 天体メニューの副題が月だけ「衛星 (月)」で、タイタンやエウロパは「天体・ラグランジュ点」(`src/game/celestial/celestial-entity/celestial-entity.ts:103-107`)
  5. 「地球専用」参照軌道(静止・太陽同期・モルニヤ・ツンドラ)。物理側 `src/physics/earth-reference-orbits.ts:28-55` は mu・J2・自転周期を `CelestialBody` から読む完全に一般の実装(`src/game/celestial/orbit-guide/orbit-guide-model.ts:330-360`、`src/game/pickable/line-pickables.ts:55`)
  6. CR3BP の系→天体の固定表。系 id が「主-副」そのままで、表の `[0]`(主天体)は誰も読まない(`src/physics/orbit-guide.ts:40-55`)
  7. スケールグリッドが `findMotion('moon')`(`src/game/celestial/scale-grid-view.ts:41`)
- 疑う理由: どれも「地球-月しか無かった時期」の名残。一般の判定(`CelestialClass`・親子関係・`motion.primary.id`)が同じファイルの隣にある。
- 仕様: 1 は ORBIT.md に、5 は MAP.md に書かれている → **第4群**。3・4・6・7 は記述なし
- 減るもの: 名指し分岐7箇所と、無言で落ちる選択肢が消える。天体を増やしたときに HUD・カメラを触らなくて済む。/ 確度: 高(3・4・6・7)/ 中(1・2・5)/ 確認: 名指しの存在は自分で確認、一般化可能性は報告のみ

### R18. 主星の決定を描画 View の `stellarLight` から引き、弾の散布界まで届いている
- 症状: 「どれが恒星か」を見た目で決め、その結果が自機・敵の太陽グレア散布界に入る。
- 場所: `src/game/celestial/celestial-system.ts:147-150`、`src/game/player/fire-control.ts:313`、`src/game/dynamic/dynamic-entity/enemy.ts:412`
- 疑う理由: 同じ問いに正本が2つある — 積分側(輻射圧・日照)は `motion.kind === 'star'` で決め、表示・射撃側は View 由来。恒星の見た目を差し替えると命中精度が変わる。
- 仕様: CELESTIAL.md §1 は恒星を登録天体として定めるだけ。見た目から主星を決めるとは書かれていない
- 減るもの: 星の同定が1箇所になり、描画層への依存が1つ減る。/ 確度: 高 / 確認: 自分で確認

### R20. 接触代理の置き直しが履歴キューに毎サブステップ積み続ける
- 症状: 放熱板の折り 12 個とベルト節点 18 個が毎サブステップ `proxy.state = world` で置き直され、setter が `DynamicTrajectory.reset()` → `StateQueue.push()` を通る。間引きも切り捨ても無いので 30 本のキューが無制限に伸びる。
- 場所: `src/game/player/radiator.ts:193`、`src/game/player/belt-physics.ts:246`、`src/game/dynamic/dynamic-motion.ts:225-228`、`src/physics/state-queue.ts:55-62`
- 疑う理由: `state` setter は「不連続な飛び」のための口で、毎歩の再配置用ではない。代理の履歴は誰も `at()` で引かない。
- 仕様: SPEC に記述なし
- 減るもの: 長い戦闘での漸進的なフレーム落ちが無くなる。/ 確度: 中 / 確認: 報告のみ

---

# 第2群 — レガシーの名残で、消すと単純になる(挙動が小さく変わる)

### R23. ラン跨ぎ設定に、1ランの中の視点であるべき項目が混ざっている
- 症状: 「対象/ガイド/軌道ガイド」タブと軌道ガイドの群タブの選択が、ブラウザを閉じても次のランへ持ち越される。
- 場所: `src/settings/user-settings.ts:44-47,73-78`、`src/game/hud/hud-selection.ts:13,18,66-82`
- 疑う理由: **ユーザーの例2。** 11項目の判定は以下。
  - ラン跨ぎで正しい: `graphics` / `renderStyle` / `bgmVolume` / `themePalette`
  - UI-DESIGN.md が跨ぎを明記: `panelCollapsed`
  - 好みに近く跨ぎで許容: `mapDisplayToggles` / `gridVisibility` / `orbitGuide`
  - **ラン内の視点に見える: `viewOptionsTab` / `orbitGuideGroupTab`**(カメラ視点や選択中ビューはスナップショット側に入っているのに、タブだけ localStorage にある)
- 仕様: MAP.md「タブは常にどれか1つが選ばれている」/ UI-DESIGN.md — どちらも persistence の記述なし
- 減るもの: 保存鍵2つと parse/format 4関数。ランを始めると既定タブから始まる。/ 確度: 中 / 確認: 項目の全量は自分で確認、意味の判定は報告のみ

### R26. 曲の選択が乱数で、時刻決定的でない
- 症状: ランごとに最初の曲が無作為に決まり、5分ごとの曲送りも「直前以外から無作為」。
- 場所: `src/audio/bgm/conductor.ts:50,125`、`src/audio/bgm/bgm.ts:103`
- 疑う理由: 作曲側は「同じ step には常に同じ音列」を約束して完全に決定的なのに、選曲だけが乱数。
- 仕様: AUDIO.md「複数の曲が用意されており、約5分ごとに次の曲へ自動的に切り替わる」— 無作為である要求は記述なし(「次の曲へ」は順送りと読める)
- 減るもの: 乱数2箇所・optional 引数1つ・クランプ1つ・重複回避1関数。/ 確度: 中 / 確認: 報告のみ

### R27. 既定名の言語プールが個体ごとに無作為で、一隻ずつ別文化の名前が混ざる
- 症状: 名前を省略して配置した艦・基地・敵に、ポリネシア語/広東語/フランス語のどれかが 1/3 で割り当たる。
- 場所: `src/game/random-name.ts:36-56`
- 疑う理由: どの文化かを誰も選べず・保存せず・表示で区別もしないので、プールを3つに割った意味が挙動に出ていない。
- 仕様: GAME.md「名前欄を空欄のまま確定すると、種類ごとの既定名が自動で付く」— 言語の記述なし
- 減るもの: `lang` 分岐と 9 本の配列が 3 本になる。/ 確度: 中 / 確認: 報告のみ

### R28. 視点リセットが2種類あり、マップ側は仕様の半分しかしない
- 症状: 同じ「視点リセット」で、戦闘ビューはフォーカスと基準フレームまで戻すが、マップはロールとパンだけ。さらに `/` と `_` の同時押しで、押している間ずっと `mapCamera.reset()` が走る隠し操作がある。
- 場所: `src/game/camera/camera-system.ts:61-70,188-194`、`src/game/camera/focus-camera.ts:398-409,513-527`
- 疑う理由: `reset()` と `resetToInitial()` の2経路が並立し、ヒント文も別々。同時押しはエッジ判定でなく、同じ操作が中クリックとボタンで既に届く。
- 仕様: CAMERA.md「**視点リセット**は、フォーカスを操作対象へ、基準フレームをそのビューの既定へ、視点を既定の後方見下ろしへ戻す」— ビューによる差は書かれていない。CONTROLS.md に同時押しの記述なし
- 減るもの: リセット経路が1つになり、ヒント文の二重管理とビュー分岐が消える。/ 確度: 中 / 確認: 報告のみ

### R29. ヘルプの「表示対象」タブが現在のビューに上書きされる
- 症状: ヘルプ内でタブを手動に切り替えても、ビューが変わった瞬間に黙って戻る。開いている間 `window` へ keydown を張っている。
- 場所: `src/game/hud/windows/help-panel.ts:120,180,220`、`src/game/hud/hud.ts:154`
- 疑う理由: `setView()` のコメント自身が「タブで手動に選んだモードもここで上書きされる」と認めている。キーボード図のハイライトという仕様外機能のために §7 の禁止事項を踏んでいる。
- 仕様: UI-DESIGN.md §8「ヘルプ — 操作の対応表を1つ持つ」/ §7-2 は画面全体への独自キー監視を禁止
- 減るもの: モード/入力方式/カテゴリの3タブ・検索・キーボード図・グローバル keydown が落ち、仕様どおりの1枚の表になる。/ 確度: 中 / 確認: 報告のみ

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

- **R43. 基地が使えない `plan`/`planExecution`/`fineAttitude` を持つ。** `fineAttitude` は `[V]` を拾わないので常に false、`planExecution` は基地のメニューに項目が無いので `'off'` 固定。それでも軌道計画パネルは基地の `plan` を編集させる。`src/game/dynamic/dynamic-entity/base.ts:62-71,167`。/ 確度: 中
- **R44. タイトル画面で配色を変えても 3D 背景だけ追随しない。** `TitleScene` は `palette` を構築時に焼き込んで購読しない。ラン中の 3D は毎フレーム読む。UI-DESIGN.md「選択は画面へ即座に反映される」に反する。`src/launcher/title-scene.ts:333-349`。/ 確度: 中
- **R45. マーカーのサブ行の字形表が `ENTITY_GLYPH` を手で写し直している。** 敵 △ が `ascendingNode`、基地 ⬡ が `burnPoint` と衝突。MARKERS.md は中空の字形を「軌道上の点」の族と明記。`src/game/marker/celestial-sub-labels.ts:21-23`。/ 確度: 中
- **R48. 入力の連打判定が実時刻ラッチ。** `performance.now()/1000` がモデル層にあり、時間加速と噛み合わない。`src/game/player/throttle.ts:145`。計画の K2 は「導出の入力解釈」へ移す予定。/ 確度: 低
- **R49. 被弾音が非操作の自艦の被弾でも鳴る。** 減衰が単艦前提の尺度。AUDIO.md の明文の対象は連続音だけ。`src/game/player/player.ts:466,494`。/ 確度: 低

---

## 計画との重なり

`restructure-architecture.md` が既に手を付ける予定のもの: R1・R2(段 3)、R11(K3-1 / 手順 3-5)、R14・R53(K2 / 手順 6-5)、
R16・R32(K2 / 手順 6-4)、R18(K2)、R36(K5 — 作者の合意が要る)、R48(K2)。

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

---

# 第6群 — 横断検査(R6 / R18 / R39 / R50 の類例)

調査時点: `restructure-architecture` @ `af997ae0`。R6・R18・R39・R50 の4件について、
**代表例を捕まえられる機械検査**を組んでから全量を絞り、1件ずつ現地で判断した。

## 検査の方法と、代表例の再現

| 類 | 検査 | 代表例が捕まるか | 全量 |
| --- | --- | --- | --- |
| R6(ECI 原点を物理の基準に使う) | ゼロベクトルのフォールバック(`?? v3()` / `?? V3_ZERO`)と、`len`/`lenSq`/`norm`/`dot`/`cross` が**絶対 ECI 位置を `sub()` 抜きで**食う行 | R6 = `simulator.ts:110,158`、R22 の旧実装 `dot(pos, sunDir)` の両方が出る | 前者5件・後者14件 |
| R18(見た目で物理を決める) | 描画層以外からの `.view.` 読み / 表示属性で実体を選ぶ `find`・`filter` / `game`・`physics` から `render/` への import | R18 = `celestial-system.ts:145` が出る | `.view.` 77件、実体選択は R18 の1件のみ |
| R39(派生値をステートに持つ) | `normalize`/`refresh`/`recompute`/`derive` が保存済みフィールドを他フィールドから上書きする形 + 全ミュータブルフィールドの分野別走査(サブエージェント4体) | R39 = `display-toggles.ts:125` と `celestial-grid.ts:73` が出る | 候補48件 → 下記へ集約 |
| R50(実時刻タイマー) | `performance.now()` / `Date.now()` / `setTimeout` / `setInterval` の全量を層別に | R50 = `conductor.ts:72,111`、R48 = `throttle.ts:145` の両方が出る | 16ファイル |

**判定の軸**は代表例に合わせず、規約から取った。

- R6 類 = **CODING-RULE 1.8**「天体の位置を自分で引き算して座標系を作らない」。原点を物理の基準に
  据えている箇所を疑う。ECI 原点はステージが選ぶ天体で、`debug-alt-system` は地球ではない。
- R18 類 = 同じ問いに正本が2つあるか。**物理量の正本が描画層にあるもの**も含めた(R18 の裏返し)。
- R39 類 = **CODING-RULE 1.6 / R5**。導出層が持ってよい mutable は5種だけなので、それに当たらない
  保存を疑う。モデル層は「軽微な計算で求まるものをステートにしない」で見る。
- R50 類 = **R5**「導出層のアニメーションは dt で積まず、開始時刻とそのフレームの実時刻から計算する。
  実時刻はフレームの先頭で1度だけ読み、入力として配る」。**時計の取り違え**(音声時刻で測った待ちを
  実時刻で待つ)と、**自分で時計を読むこと**の2つを見る。

## 検査で潰れたもの(擬陽性と確認した分)

- **R48 は擬陽性で確定。** 実時刻の全16ファイルのうち、時計の取り違えは R50 だけだった。入力
  (`input.ts`)・プロファイル(`frame-sections.ts`)・保存時刻(`save/*`)・読み込みのフレーム譲り
  (`loading-progress.ts`)・通信タイムアウト(`earth-surface-tile-queue.ts`)・BGM のポンプ
  (`bgm.ts`。タブを隠すと `AudioContext` ごと suspend されるので先読み 0.6 秒は枯れない)は、
  どれも実時刻が正しい。連打判定も同じ — ただし `throttle.ts` が**自分で** `performance.now()` を
  読んでいる点だけは R5 に反しており、そこは計画の K2 が扱う。
- **`arc-celestial-bodies.ts:51` の `len(state.r)` は正しい。** ECI 化で入る原点補正項は天体の
  原点距離だけで決まるので、原点からの距離を見るのが正。コメントもそう書いてある。
- **描画層の幾何を物理が読んでいる箇所は無い。** 当たり判定の半径・大気・アルベドはすべて
  `def`/`motion` 側から引いている。`targeter` の `siteMarkers`、`protein-motion-metrics` の
  `motionMetrics`、`line-pickables` の `lineSamples` は表示・ピック・性能計測なので対象外。
- **`camera-system.ts:235` の `focusVelocity ?? v3()` は位置ではなく速度**で、答えられない対象を
  注視している間の既定として明記されている。R6 と同型ではない。
- **R65 の `point` と差分ゲートは消せない。** `source === 'lissajous'` では `familyId` が常に `'lissajous'` で、
  `L1|L2|L3` は設定から線ごとに決まるので `point` は `familyId` から復元できない。`displayedSettings`/
  `displayedStyle` は導出値ではなくメモ鍵で、外すと `buildDisplays`・`styleFor`・`THREE.Color` の生成と
  描画側の `retainOnly` が毎フレーム走る。写しだった `count` だけを消した。
- **R64 の `frameScratch` は消せない。** `opacity` は全天体との遮蔽レイ判定の結果で再計算が安くなく、
  `labelStateOf(id)` が後から任意の id を引くので、正当なフレームキャッシュ(R5-1)。`showIcon`/`showLabel` は
  表示ポリシーの答えの写しだが、`syncSubLabels` が policy を引数に取らないので残した。同じ値を二重に
  持っていた `occluded` と `distScratch` だけを消した。

---

### R57. ステージの配置ユーティリティが「ECI 原点＝重力の中心＝地球」を前提にした幾何を持つ
- 症状: 敵の初期配置が、絶対 ECI 位置の `len()` を軌道半径、`norm()` を局所鉛直、`MU_EARTH` を
  重力定数として扱う。ECI 原点が地球でないステージ(`debug-alt-system` は zephyrus 原点)や、
  自機が月圏に居る状態で呼ぶと、共楕円軌道は共楕円にならず、大気圏クランプは地球中心の球面へ効く。
- 場所: `src/game/stages/spawner/enemy-generator.ts:25,98,101,112,129-130`、
  `src/game/stages/spawner/enemy-spawner.ts:41`、
  `src/game/stages/stage-utils/wave-attack.ts:176,278-284`、`src/game/player/player.ts:265`
- 疑う理由: 引数が `base: KinematicState` と一般の形をしているのに、中身は地球専用。いまは呼び手
  (stage1/stage2/stage00)が地球周回なので露見していないだけで、型は何も止めない。
- 仕様: CELESTIAL.md は ECI 原点をステージの選択として定める。地球であるとは書かれていない
- 減るもの: `MU_EARTH`/`R_EARTH` 依存が配置ユーティリティから落ち、`strongestAttractor` から引く
  1本になる。/ 確度: 中(いま壊れてはいない) / 確認: 自分で確認

### R58. 恒星の明るさの正本が描画層にあり、物理は別の固定値を使っている
- 症状: 「その恒星がどれだけ明るいか」に正本が2つある。描画は天体宣言が持つ
  `stellarLight.radiantIntensity`、物理(日射加熱・輻射圧)は `SOLAR_CONSTANT = 1361` の固定値。
  架空恒星の星系でも熱と輻射圧だけは太陽の値で計算される。
- 場所: `src/render/pipeline/sun-light.ts:15-19`、
  `src/game/celestial/solar-system/solar-system.ts:5,64`、`src/game/stages/stage-debug-alt-system.ts:25,81`、
  `src/physics/srp.ts:9-11`、`src/game/dynamic/dynamic-motion.ts:438`
- 疑う理由: R18 の裏返し。R18 は「物理の問いを描画から引いている」で、これは「物理量の正本が
  描画層にある」— 天体を宣言する `game/celestial/` が放射強度を `render/pipeline/` から import
  している。恒星の明るさは物理量なので、置き場が逆を向いている。
- 仕様: CELESTIAL.md §1 は恒星を登録天体として定める。明るさの正本がどちらかは書かれていない
- 減るもの: 放射強度の宣言が1つになり、`game/` → `render/` の import が1本落ちる。描画の
  露出目盛り(`SUN_IRRADIANCE_1AU = π`)は描画層に残る。/ 確度: 高 / 確認: 自分で確認

### R66. HUD パネルが、設定の現在値を鏡映しで持っている
- 症状: 表示オプションのクラス別モード・天球グリッド・軌道ガイド設定を、パネルが Map と
  フィールドで持ち直している。同じ値が設定の正本・パネルの写し・ボタンの点灯/`dataset` と
  三重に並ぶ。コメント自身が「軌道ガイド設定の鏡映し」と書いている箇所がある。
- 場所: `src/game/hud/panels/view-options-panel.ts:163,169,174,389,434-451`、
  `src/game/hud/panels/orbit-guide-tab.ts:94`
- 疑う理由: 写しが要るのは「トグルの次の値を決めるのに現在値が要る」からで、押し込み一方向の
  配線がそれを許していないだけ。R5 のどの種類にも当たらない。
- 減るもの: Map 2本とフィールド2本。ただしパネルへ設定の読み口を渡す配線が要る(**依存は悪化する**)
  ので、置き場の判断が先。/ 確度: 中 / 確認: 報告のみ
- **判断(2026-09-15): 保留。** ユーザー所見「依存の悪化は避けたい。要設計判断」。調査で分かったこと:
  - 上の「依存は悪化する」は当たらない。パネルへ設定の読み口を渡しても、同じディレクトリの
    `view-options-control.ts:13` が既に `settings/setting-value` を型 import しているので、新しい向きの辺は生まれない。
  - ただし単純な削除にはならない。写しは次の値を決める(`view-options-panel.ts:253-257`)だけでなく、patch を
    重ねる土台(`orbit-guide-tab.ts:327-329,404-414,463-485`)、兄弟値の参照(族範囲の下限・上限のクランプ `:233-241`)、
    未設定 id の既定生成(`:315-324,386-391`)にも使われている。
  - `restructure-architecture.md` の手順 2-3 の変更表はこの鏡映しをやめると書いているが、現在も残っている。
  - R67 と表裏。`Button` は `setOn` で DOM に書くだけで現在値を持たないので、点灯トグルの現在値を呼び出し側が持たされている。

### R67. DOM の状態と JS の boolean を二重に持っている
- 症状: ウィジェットの `on` / `enabled` / `minimized` / 一覧の `expanded` が、それぞれ
  `aria-checked` / `aria-disabled` / `.hidden` / `.collapsed` と同じ事実を二重に持つ。書き手は
  必ず両方を同時に書いており、読み手は同じクラスの中に居る。
- 場所: `src/hud/widgets/toggle-switch.ts:7,37-41`、`src/hud/widgets/button.ts:11,42,48,64-68`、
  `src/hud/windows/pause-menu.ts:34,224-229,252-256`、`src/hud/windows/draggable-window.ts:91`、
  `src/game/hud/panels/physical-object-list-panel.ts:39,420-423`、
  `src/game/hud/panels/physical-object-list-row-tree.ts:31,137-143,224-231`
- 疑う理由: R5-2 が許すのは DOM 資源そのもので、その状態の写しではない。`restoreSavedExpanded` は
  boolean だけ書き換えて DOM を後続の同期に任せるので、その間だけ両者がずれる。
- 減るもの: フィールド6本。/ 確度: 中(`toggle-switch`・`button` は高) / 確認: 前2件は自分で確認、
  他は報告のみ
- **判断(2026-09-15): 保留。** ユーザー所見「JS から DOM への表示を極力一方向の流れにしたい(React 的発想)が、
  要設計判断」。調査で分かったこと:
  - `toggle-switch.ts` の `on` と `button.ts` の `enabled` は、読み手がクラスの中だけ(反転と、押下・クリックを
    通すかの判定)で、外から読む getter は無い。
  - `Button` は逆に `on` を持たず、点灯の現在値を呼び出し側に持たせている(R66 の直接の原因)。状態 → DOM の
    一方向へ寄せるなら、R66 と一緒に「現在値の正本をどこに置き、ウィジェットはそれを描くだけにするか」を決めることになる。
  - 一覧の行は `savedExpanded` を正本と明記し、`restoreSavedExpanded` は boolean だけ書いて DOM を後続の同期に
    任せる(一方向の形)。同じクラスの `setAllRowsExpanded`(`physical-object-list-row-tree.ts:147-152`)は自分で
    `applyRowExpanded` を呼んでおり、2つの流儀が併存している。
  - CODING-RULE 1.13 は CSS の規則だけで、DOM と JS の状態の二重持ちについては定めていない。

### R69. id と表示名を両方持っている
- 症状: 対象の id を持ちながら表示名も保存している。名前は id から引ける(`nameOf` / roster)。
- 場所: `src/game/nav-target.ts:69`、`src/game/marker/equator-node-marker.ts:25`、
  `src/game/marker/orbit-point-marker.ts:51`
- 疑う理由: 非正規化。`ApsisMarker` は既に `centerId` だけを持つ形になっていて、同じ族の中で
  持ち方が割れている。
- 減るもの: フィールド3本。ただし `nav-target` は「撃破された対象の名前」だけ導出元が消えるので、
  そこは挙動が変わる。/ 確度: 中 / 確認: 報告のみ
- **判断(2026-09-15): 統合しない。** ユーザー所見「表示名は衝突を許し、id は衝突できない。表示は名前、検索は id と
  使い分けを徹底し、混同しているところがあれば直す」。横断検査の結果:
  - **表示名で同一性を判定している箇所は `src/` に無く、直すものは無かった。** 名前での比較は3箇所だけで、どれも
    同一性の判定ではない — `pickup.ts:262`(既定名と一致するかでセーブに書くかを決める)、
    `physical-object-list-order.ts:117`(並び替えの差分検出)、`:239-240`(利用者向けの検索文字列)。
  - 上の3箇所はどれも名前を表示にだけ使っている。`nav-target.ts` の解決は常に id。`equator-node-marker.ts` と
    `orbit-point-marker.ts` は中心の名前文字列だけを持つが、表示専用。
  - 使い分けとは別の問いが1つ残る: `nav-target.ts` は撃破された対象の名前を持ち続け、`view-badge.ts:133` の
    Target 欄に消えた敵の名前が出続ける(`resolveCombatTarget` は null を返す)。意図かどうかは未判断。

### R70. 導出層が、同じフレームに引数で来る値を写して持っている(一部を直し、残りは保留)
- 直したもの: `object-pickables` の `_lastSimTime`/`_lastDisplayTime` と `object-windows` の `simTime`。
  フレーム外のハンドラが読んでいたので、表示時刻の所有者 `DisplayWindowManager` を構築時に読み取り専用の面
  (`Pick<DisplayWindowManager, 'current'>`)で渡し、そこから読む。
- **判断(2026-09-15): 残りは直さない。**
  - `hud.ts` の `chromeView` は写しではない。`applyView` はクラスの付け替えだけでなく、パネルを左レールへ
    `insertBefore`/`appendChild` で移すので、毎フレーム行うとボタンのフォーカスやホバーが失われる。R5-5 の
    「表示を安定させるための前フレームの記憶」に当たる。`mapRoot.classList.contains('active')` の読み手も無く、二重でもない。
  - `panel-shell.ts` の `view` は、消すと main → Hud → PanelCollapse の3階層と後付けの遅延バインドが要る(依存が悪化する)。
    段 2 の手順 2-3 は実施済みで、予定済みの作業ではなく残ったもの。
  - `object-windows.ts` の `lastFocusId` は「マップを離れている間は最後のマップ注視を据え置く」が観測できる挙動で、
    戦闘中に開いたウィンドウのバッジに出る。消すならその挙動を決めるのが先。
- 類例(未着手): `frame-controls.ts:22` の `lastTime`、`plan-editor.ts:78` の `simTime`。また `ObjectWindows.sync` と
  `MapPicking.handleRightClick`/`handleEmptySpaceRightClick` の `simTime` 引数は、上の修正で `current.simTime` と同じ値を
  運ぶ2本目の経路になった(消すには `game.ts:487,597` と `view-frame.ts` に及ぶ)。

### R71. 段の質量・慣性と放熱板の摩耗が、正本からの毎フレームの写し
- 症状: `mass`/`att.inertia` は段スタックの合計から、`RadiatorSystem.wear` は放熱板パーツの
  `1 - hp/maxHp` から、毎フレーム上書きされている。
- 場所: `src/game/player/attached-booster-motion.ts:88`、
  `src/game/dynamic/dynamic-entity/detached-booster-motion.ts:36`、`src/game/player/radiator.ts:88,122`
- 疑う理由: 計算自体は軽微(段は最大4本、放熱板は2枚)で、導出元は生きている。
- 減るもの: 書き戻し2系統。ただし読み手が広く(`throttle` / `contactMass` / `base-motion` / 描画)、
  `DynamicMotion` も `RadiatorSystem` もパーツを知らないので、**供給フックを1本足す形になる**
  (依存は中程度に悪化)。置き場の判断が先。/ 確度: 低 / 確認: 報告のみ
- **判断(2026-09-15): 保留。** ユーザー所見「依存方向をどう整理するか決めかねる。要設計判断」。この回では調査していない。

## 単独では挙げないもの(軽微、または理由が書かれているもの)

- `src/render/cloud/field-projection.ts:110` `cosRadiusValue`(= `Math.cos(aimedRadius)`)、
  `src/render/curve.ts:90` `appliedStyle`、`src/game/celestial/orbit-guide/orbit-guide-catalog.ts:74` の
  `'loaded'`(= `systems[id] !== undefined`)、`src/launcher/save/slot-data.ts:36` の
  `lastPlayedAtReal`(= `snapshots[0].createdAtReal`)。どれも1フィールド。
- `src/physics/planet-system.ts:53` `offsetting` — 衛星と μ から組み直せるが、時刻キャッシュのミス
  ごとに読まれる。**性能上の理由がコメントに書かれていない**ので、書くか eager にするかの判断だけ要る。
- `src/game/dynamic/next-event-time.ts:8`、`src/physics/dynamic-trajectory.ts:25`、
  `src/launcher/save/slot-data.ts:13-30`(セーブ索引)は、いずれも理由が明記された意図的な保持。
