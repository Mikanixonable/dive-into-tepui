# CALLSTACK — per-frame 呼び出し依存木

`main.ts` の `requestAnimationFrame` ループが毎フレーム `game.update(dt)` → `game.sync()` →
`game.render()` の順に呼ぶところを起点に、そこから辿れる **副作用のある** 呼び出しを木構造にまとめた
もの。**「いま何がどの順で走るか」の一次情報**であり、責務の置き場所を検討するための地図として使う。

## 読み方

- 原則として、per frame にちょうど一度だけ呼ばれるものを列挙する。
- 条件分岐で 0 回になり得る呼び出しには `// 条件` を付ける。条件が無いものは毎フレーム必ず1回。
- 値を計算して返すだけの純粋関数(副作用なし)は省略する。引数も省略する(呼び出し順だけを追う)。
- ループで複数回呼ばれるものは `// …ごと` と書く。
- **計測の印(`FrameSections` の `beginFrame`/`enter`/`exit`/`endFrame`)は木に載せない。** 負荷確認
  ウィンドウを開いている間だけ走り(`FrameSections.enabled`)、閉じていれば時計も読まない条件付きの
  呼び出しで、しかも `update` のほぼ全ての区切りに1対ずつ入るため、載せると呼び出し順そのものが
  読めなくなる。どこに区間の境界があるかは `frame-sections.ts` の `SECTION` を見る。
- 名前は `update`(論理更新)/ `sync`(既存メッシュ・DOM への反映)/ `render`(renderer.render の呼び出し)
  / `build`(生成)の規約に従う(CLAUDE.md 参照)。ここでの三大分岐もその区切りに対応する。

## 更新義務

`src/` を変更したらこの文書も同じ変更セットで更新する(`.claude/skills/develop-docs/SKILL.md`)。
全面再生成が必要な場合も同スキルに手順とプロンプトがある。

---

## main.ts / rAF ループ

- animate(now)
  - const game = launcher.current // launcher.start() が解決するまで(または周回の切り替え中)は null。null なら以下を全て飛ばし、次フレームを予約するだけで戻る
  - game.update(dt) // dt = 実経過秒。game 側で 0.1s に clamp される
  - snapshotControls.handleInput(game.input, game) // このフレームで game.update が消費しなかった入力エッジだけを見る。K.clipSnapshot/K.openSnapshots(Esc は扱わない — 一覧を閉じる Esc は overlayManager 経由で game.handleInput 側が既に消費している)
    - [K.clipSnapshot] [!activeStage.isPlaying] hud.hint() // 決着後は拒否。それ以外は snapshotService.capture(game, 'manual', null, true) + hud.hint()
    - [K.openSnapshots] browser の open()/close() をトグル // open() 前に pauseMenu.toggle(false)。open() が gameSource.current?.pause()、close() が gameSource.current?.resume() を呼ぶ(gameSource = launcher)
  - launcher.handleInput(game.input) // snapshotControls の後、このフレームでまだ消費されていない入力エッジだけを見る(引数の game は渡さない — launcher 自身が持つ this.game を読む)。[!activeStage.isPlaying] のときだけ K.restart を取る
    - restart() → endRun() → startRun(launchedStage) // 今の Game を dispose してから同じステージで new Game(...) する(未起動なら何もしない)
  - [launcher.current !== game] requestAnimationFrame(animate) して return // 直前の handleInput が周回を畳んだ(K.restart など)場合、捨てた game にはこれ以降一切触らない。perf.handleInput 以降・perf.record・gpu.resolve ともこのフレームは飛ばす
  - perf.handleInput(game.input) // [K.togglePerfWindow] toggle()
  - autoSave.update(game) // 前回撮影から AUTOSAVE_INTERVAL_REAL_SEC(実時間60秒)経っていれば snapshotService.capture(game, 'auto', null, false) // game.isPaused または !activeStage.isPlaying なら何も撮らない
  - launcher.update() // 決着した最初のフレームだけ動く(resultShown フラグで以降は即 return): worldSfx.setThrust(false) + bgm.stop() → slots.noteRunEnded(activeSlotId) → resultScreen.show(activeStage.result ?? phase からのフォールバック)
  - game.sync()
  - game.render()
  - gpu.resolve() // 窓の開閉によらず、game が存在する限り毎フレーム。renderer.resolveTimestampsAsync('render') を投げ、前フレームの GPU 時間が非同期で届く。呼ばないと時刻印クエリが溜まって上限に当たるので条件を付けない。render 区間の計測(t3)の後に置き、計測自身の費用を render へ混ぜない
  - perf.record(game, ...) // 負荷確認ウィンドウが開いている間(perf.on)だけ。counts(= game)を引数で受け取り保持しない。毎フレーム counts.perfCounts() を読み、フレームごとに数え直される個数系(RATE_COUNTS)を ms 系と同じく積む。行を組んで PropertyWindow へ流すのは 500ms ごと

---

## game.update(dtRaw)

`update` は一本の線形フローで、艦の有無は経路の分岐ではなく `advanceSimulation` 内部の条件付き
ブロックとして表現される(早期 return の重複はない)。`handlePointerInput` 自体には呼ぶ順序と
ポーズ判定しかなく、ビュー(マップ視点/編集モード)や艦の有無の判定は各受け手が自分で行う(§
handlePointerInput 参照)。ステージの決着状態(`activeStage.isPlaying`)はどちらの分岐にも現れない
— 決着後も操作艦の `updatePlayerControls`・ポインタ入力・各具体ステージ自身の `update`(§ advanceSimulation 内)
は通常どおり続く。各具体ステージの `update` は艦の有無だけを見て自分で早期 return する。

- game.update(dtRaw)
  - sections.enter(SECTION.input)
  - input.update() // pending キュー(キー/クリック/マウス)を今フレーム分に確定し、次フレーム用にクリア。takeHeld の確保集合もここでクリアする
  - handleInput(dt) // 担当モジュールへ先着順に配る。処理した側が input からそのキーを消費する。ポーズ判定より前に置く(Esc・ヘルプ等はポーズ中・決着後も効かせる)
    - [input.takeKey(K.pauseMenu)] hud.overlayManager.closeTopmostOnEscape() // 開いている登録済みオーバーレイ(ドック/一覧/ヘルプ/一時ウィンドウ/ポップアップ)のうち最前面かつ closeOnEscape なもの1枚を閉じる。閉じるものが無ければ pauseMenu.toggle(true)
    - input.takeKeys(code => hud.overlayManager.dispatchShortcut(code)) // 今フレームの未消費キーを1つずつ試す。テキスト入力へフォーカス中なら即 false。最前面から順に handle.handleShortcut?.(code) を呼び、true を返した1枚で打ち切る(ContextMenu/PropertyWindow/ShipPlacerPanel のみ実装 — クリップ中の PropertyWindow は常に false を返して1つ下へ通す)
    - hud.handleInput() // K.help → helpPanel.handleInput() → toggle()
    - simSpeedManager.handleInput()
      - shift(-1|+1) // K.warpSlower / K.warpFaster。倍率をヒントで伝える。操作できない倍率へ上げたときはその旨も併記する
        - cancelAutoWarp() // 常に(手動シフトは自動ワープを解除する)
        - uiSfx.warp() + hud.hint() // 上限/下限を超えない場合のみ
    - viewManager.handleInput(input) // ビュー遷移はすべて setView() を通る。[isDockOpen] 何もせず return([M] も消費しない)。[!K.toggleMapMode を取れた] 何もしない
      - [current==='map'] !canEnter('combat')(= activePlayers.current !== null が false)なら hud.hint('操作できる艦がいません') して return(この時点で [M] キー自体は既に消費済み)
      - setView(current==='map' ? 'combat' : 'map')
        - [出るビューが dock] docking.leaveDock() → dockView.close() + game.resume()
        - [3D 側ビューが map→他] editor.onMapClosed() / editor.closeMenu() / mapActions.close()
          - onMapClosed: hidePanel / hideGizmo / plan.removeNode(末尾の Δv 微小ノードを間引く) / selectedNodeIdx=null
          - mapActions.close(): menu.close() / 開いている全プロパティウィンドウを closeWindow()(クリップ済みも含め全て)
        - [3D 側ビューが 他→map] editor.selectedNodeIdx = null
        - [入るビューが dock] docking.enterDock() → game.pause() + dockView.open(activeBase, game.player, activeStage.freeProcurement)
        - syncDockOverlay(wasDockOpen) // isDockOpen が今回変化したフレームだけ hud.overlayManager.open('dock-view', ...)/.close('dock-view')
        - applyChrome() // map-mode/dock-mode クラス・navball 配置・touchControls・
                        // cameraSystem.overviewMode・editor.editMode・displayWindow.forceCurrent を一斉に揃える
        - hud.hint()
    - editor.handleInput(input, dt)
      - clearPlanByKey() // K.deleteNode
        - [editMode] deleteSelected() → deleteNode()
          - plan.removeNode() / closeMenu() / simSpeedManager.cancelAutoWarp() / hud.hint() // 下流ノードも一緒に消える
        - [!editMode] plan.clear() + simSpeedManager.cancelAutoWarp() + hud.hint() // ノードがある場合のみ
      - [!editMode] simSpeedManager.toggleAutoWarpToFirstNode(plan?.firstNode(), simTime) // K.autoWarpToNode。editMode 中は WASDQE と同じく Δv 編集側へ譲る
        - hud.hint() // ノード無し
        - cancelAutoWarp() + hud.hint() // 既に自動ワープ中
        - startAutoWarpTo() + hud.hint() // 未開始
      - updateEditing(input, dt)
        - [!dvEditActive(= editMode かつ selectedNodeIdx !== null)] dvHoldTime を全方向 0 に戻して return
        - applyHeldDv() ×6方向 // input.takeHeld(K.dvXxx) で6キーを先着確保し(以降 player.updatePlayerControls からは押されていないように見える)、または dvButtons(長押しボタン)が held の間、ホールド秒数からランプするレートで dt 秒分を積分
        - applyDv() // nodeGizmo.latch がある間、ラッチ超過量に比例したレートで dt 秒分を積分(アームドラッグが DV_DRAG_LATCH_PX を超えて入る)
  - sections.exit(SECTION.input)
  - [!game.isPaused] advanceSimulation(dt) // ポーズ中は丸ごと飛ばす(HP自動回復などをポーズ中に汲み出せないようにする)
  - displayWindow = displayWindowManager.resolve(simulator.simTime, player) // advanceSimulation を飛ばした(ポーズ中の)フレームでもここで確定させる。ポーズ中・決着後もカメラ更新だけは飛ばせない — 飛ばすと視点だけが絶対 ECI に取り残され、軌道速度で遠ざかる原点(自機)から残骸が即座にフレームアウトする
  - environment.update(displayWindow.displayTime, cameraSystem.overviewMode) // 小惑星帯・トロヤ群点群の位置再評価。editor.update より前
  - sections.enter(SECTION.plan)
  - editor.update(displayWindow) // 計画の区間列を組み直すだけ(積分の伸長はしない — それは後段の predictor.update の仕事)。アプシスアイコン(赤道交点の更新/mapPicker.refresh より前)
    - [activePlayers.current が前フレームと違う] closeMenu() // 前の艦のノードに対して開いたままのメニューを畳む。選択中ノードは参照解決なので自然に外れる
    - excludedIds = activePlayers.current ? [活性艦.id] : []
    - attractors.resolve(excludedIds, plan?.revision ?? 0, lastPlanEnd) // Game が生成し Predictor と参照共有する FutureAttractors へ今フレームの入力を渡す。続く path.update より前に呼ぶ。今フレームの計画終端は path.update がこれから決めるので、revision は前フレームの終端(PlanPath.plannedEnd = lastPlanEnd。表示窓でクリップしない区間列自身の終端なので simTime には依らない)を基準に畳む。値が動いたときだけ、保持していた時刻ごとの解決結果を捨てる。revision が前回と同じで起点・終端も動いていない区間は作り直さない
    - path.update() // 起点(plan.anchorOr が返す — 凍結済みならそれ、無ければ渡された自機の現在状態)とノード列を区間へ分解。表示座標系と un-bake 時刻もここで確定。buildSegments は末尾区間の起点時刻の天体窓を1回だけ引き、区間長(segmentDurationFrom)を決める
      - [区間ごと・ノード0件かつ末尾区間かつ操作対象(艦または基地)あり] arc = ship.predictedArc; arc?.apsides?.dropBefore(state0.t) // 操作対象の弧をそのまま borrow(owned: false)。積分は Predictor が伸ばす。ship.predictedArc がまだ無いフレームは何も答えない
      - [それ以外の区間] arc?.represents(state0, end, sourceRevision) // 既存の owned な弧が今フレームの区間をそのまま表せるか(あれば)。sourceRevision の不一致・積分済みサンプル間隔の粗さ・state0 の参照不一致のいずれかで false
        - [false、または対応する弧がまだ無い] new PredictedArc(state0, provider, SHIP_BCINV, SHIP_SRP_COEFF, keplerTail=false) // 空の弧を作るだけ(同期積分はしない) — 伸ばすのは後段の predictor.update
        - arc.requiredEnd = end; arc.retainFrom = state0.t // 再利用・新規のどちらでも毎フレーム書き直す
    - ghostAt(displayTime) // 折れ線が displayTime に届かなければ null
    - apsisIconsOf() // path.finalSegment() の periapsis/apoapsis(末尾の弧がこれまでに見つけた値)と apsisCenter(検出時と同じ基準天体)を読み、その天体の位置だけを ephemeris.positionOf(center.id, 極値の時刻) で引き直して距離を出す。両方あるとき (遠地点距離-近地点距離)/(遠地点距離+近地点距離) < APSIS_MIN_ECC なら空、片方のみ(双曲線等)ならそのまま出す
    - player.equatorNodes.update(displayWindow.frame, displayWindow.displayTime, ephemeris, finalSegment.state0, finalSegment.samples) // 操作艦の EqAN/EqDN。代表軌道は計画の最終区間なので、交点は解析楕円ではなく積分折れ線の上に載る
  - sections.exit(SECTION.plan)
  - sections.enter(SECTION.predict)
  - predictor.update(simulator.simTime, player, displayWindow.duration, !displayWindowManager.forceCurrent, editor.growableArcs()) // advanceSimulation の外、無条件(ポーズ中・決着後も呼ぶ — simTime が止まっている間は乖離が起きないので、予測は伸び切ったところで止まるだけ)。horizon = displayWindow.duration。第4引数は canDisplayFuture(表示時刻が現在より先へ動けるか)で、未来ゴーストが伸長理由として成り立つかを決める。growableArcs() は displayedPlan が無ければ空(表示していない計画の弧は伸ばさない)、あれば path.growableArcs()(owned な区間の弧を時刻順に)
    - discardPredictionIfDiverged(simTime, attractors) // entities.all() のうち predictsFuture=true の対象全てへ、ビューによらず毎フレーム。attractors は simTime ぶんを1回だけ classifyAttractors し、対象ごとに attractorsNearInto でその位置の近傍へ絞ったもの(advanceBudget とは別のスクラッチ配列)
      - invalidatePrediction() // predicted.at(simTime) が実位置から許容量を超えて乖離、または区間外のときのみ。許容量は PREDICT_RESET_DIST を下限に、保持サンプルの間引きが粗いぶんの補間誤差まで広げる
    - targets = entities.all().filter(e => e.hasFutureReader(canDisplayFuture)) // 伸長対象は、その個体の未来を読む消費者がいるものだけ(重力源・計画衝突体・canDisplayFuture なときのゴースト・予測線を持つもの のいずれか)。forceCurrent の戦闘ビューではゴーストが理由として立たず、操作艦にも予測線が付かない(解析楕円で描かれる)ので、通常ステージでは集合が空になる
    - interactiveShip = player !== null && player.hasFutureReader(canDisplayFuture) ? player : null // 優先枠に載せる操作艦。読む消費者がいなければ null で、優先枠ごと飛ばす
    - interactiveBudget = (targets に interactiveShip 以外がいる) ? floor(ARC_STEP_BUDGET × ARC_INTERACTIVE_RATIO) : ARC_STEP_BUDGET // 操作艦の弧 → 計画の弧(時刻順)が共有する上限枠。他に伸ばす対象が無ければ全額。1フレーム予算はビューによらず ARC_STEP_BUDGET 一本
    - [interactiveShip !== null] advanceBudget(interactiveShip, interactiveBudget, ...) // ensurePredictedArc(futureAttractors) で弧を得て(無ければ消費 0)、requiredEnd = simTime + horizon / retainFrom = simTime を書いてから grow(arc, interactiveBudget) を呼ぶ
      - interactiveShip.ensurePredictedArc(futureAttractors) // predictsFuture=false なら null。無ければ actual.state を起点に新規生成(mu≠0 なら自身の id を excludeId として渡す)
      - grow(arc, budgetSteps) // while (consumed < budgetSteps && arc.step()) consumed++
    - [interactiveBudget が残る限り、editor.growableArcs() の各弧を時刻順に] grow(arc, interactiveBudget) // requiredEnd/retainFrom は path.update が書き込み済みなので、そのまま伸ばすだけ。伸び切った弧は消費0で次の弧へ使い残しを回す — 近い区間から先に伸び切るので、線は自機側から外へ育って見える
      - arc.step() // !needsGrowth(打ち切り済み、または先端が requiredEnd に到達済み)なら即 false。中心窓は最初の1歩だけ先端時刻で解決し、以後は前歩の中点窓(carriedSources)を持ち越して rawCenter(刻み幅・重力源用、excludeId で自身を除く)/analyticCenter(外挿・アプシス中心用、解析天体だけの窓から解決)を求める。刻み幅は軌道項(keplerPeriod/ARC_STEPS_PER_REV)・粗化項(span/ARC_MAX_STEPS)・接近項(動径接近率×ARC_APPROACH_SAFETY、中心窓の衝突体を走査)の最も厳しい値を ARC_MIN_STEP_DT で下限にした値。積分の重力源は中点時刻で新たに解決した窓(mid)から attractorsNearInto で絞る
        - trajectory.step(dt, stepAttractors, bcInv, srpCoeff, null, sampleInterval, span, keplerTail ? analyticCenter : null) // 有限でなければ truncated を立てて終了。有限なら ApsisTrack.observe(prev, next) → reachedBody(prev, next, mid.collision)/burnUpBody で表面到達・焼失を判定し(collision は mu=0 天体と predictedAsPlanCollider entity を含む、excludeId で自身を除く)、mid を carriedSources として持ち越す。計画区間の own な弧は keplerTail=false なので extrapolationCenter は常に null
    - advanceBudget(entity, ...) // 残り予算(interactive の使い残し込み)を targets 上のカーソル位置から1周ぶん配る(interactiveShip は優先枠で処理済みなのでここでは飛ばす)。1体の取り分は max(ARC_MIN_ITEM_STEPS, floor(残額 / 残り訪問数)) を残額で頭打ちにした値で、使い残しは次の個体へ回る。targets には未来を読まれない個体が入らないので、残り訪問数はその個体数ぶん小さい。ensurePredictedArc が null、または arc.step() が最初から false(needsGrowth=false)の個体は、消費 0 で次へ即進む
  - sections.exit(SECTION.predict)
  - sections.enter(SECTION.plan)
  - targeter.updateEquatorNodes(cameraSystem.overviewMode, displayWindow, ephemeris) // 内部で !overviewMode なら即 return(戦闘ビューでは誰も読まないため)。マップ表示中だけ戦闘ターゲット(aliveTarget)の EqAN/EqDN を求め直す
  - entities.updateBaseEquatorNodes(cameraSystem.overviewMode, displayWindow, ephemeris) // 内部で !overviewMode なら即 return。マップ表示中だけ生存中の全基地の EqAN/EqDN を求め直す(選択の有無によらず常に出す)
  - sections.exit(SECTION.plan)
  - sections.enter(SECTION.camera)
  - cameraSystem.update(player, displayWindow.displayTime, input, dt, mapPicker.pickables, displayWindowManager.attractorsAt(displayWindow.displayTime)) // 追従カメラの基準を積分後の自機位置に合わせるため、物理積分の後に呼ぶ。ポーズ中・決着後も呼ぶ(飛ばすと視点が絶対 ECI に取り残される)。overviewCamera の座標系変換は displayTime 基準 — simTime のままだと回転系選択時に線・メッシュだけ displayTime へ動きカメラが取り残される
    - keyYaw/keyPitch をキー入力からまとめる。keyRoll は mouse.roll += keyRoll * CAM_KEY_ROLL_RATE * dt で mouse.roll へ合成する(cameraRollLeft/Right は Numpad0/Numpad1。mouse.roll には二本指ひねりの角度も直接積算済み)
    - overviewCamera.update(mouse, keyYaw, keyPitch, dt, ..., mapPicker.pickables, attractors) // cameraSystem.overviewMode のみ。focus を mapPickables から引き直し、結果を自身の view へ書く。attractors は frameTransformAt の回転解決(登録天体/生存中の重力天体の2経路)に渡す
    - combatCamera.update() // !overviewMode のみ
      - chaseCamera.toggleFollowAttitude(player) // K.followAttitudeToggle。!overviewMode のときだけ呼ばれるのでマップビューでは消費しない。player が null なら何もしない
      - zoomActive = K.gunsightZoom 押下 // combatCamera 自身のフィールドへ書く(overviewMode 中はこの update 自体が呼ばれないため更新されない — CameraSystem.zoomActive の !overviewMode ガードが読み替えを担保する)
      - gunsightCamera.update() // player !== null && zoomActive。結果を自身の view へ書く
      - chaseCamera.update(mouse, keyYaw, keyPitch, dt, player) // それ以外。!player なら即 return し viewpoint は直前の値のまま凍結。camFollowAttitude のときだけ player.att.q を rot に合成し、鍵/ドラッグ/mouse.roll を回転として適用。結果を自身の view へ書く
      - 選ばれた view.fovDeg から combatCamera 自身の view.fovDeg を指数補間
  - sections.exit(SECTION.camera)
  - sections.enter(SECTION.mapPick)
  - mapPicker.refresh(displayWindow) // 内部で !cameraSystem.overviewMode なら即 return(戦闘ビューではクリック対象を別経路で処理するため、マップを表示している時だけ更新する)。物理積分と cameraSystem.update の後に組む — 積分前だと同フレームで sync されるメッシュと被選択物の座標が1ステップずれ、カメラ更新前だと表示可否と遮蔽が1フレーム古いカメラ位置基準になる。MapVisibilityPolicy もここで1つだけ組み、sync フェーズは mapPicker.visibilityPolicy を読むだけ
    - focusMarkers.update(displayTime, overviewCamera.focus, cameraSystem.bodyClassToggles, activeCameraPos) // MapVisibilityPolicy が admits しない天体は座標計算ごと飛ばす
    - navTarget.update(player, entities, ephemeris, displayWindow) // 自機軌道要素 + navTarget.id から相対 AN/DN を求め直す。位置は通過時刻で bake し displayWindow.displayTime で un-bake して displayWindow.frame へ移す。ポーズ・決着に関わらず毎フレーム。対象が実体(敵・自機・基地)なら、その equatorNodes.update も併せて呼ぶ
    - mapPicker.pickables に反映 // 天体ラベル + 生存中の entities.players('player')・敵船('ship')(displayState 基準)+ navTarget.mapPickables() + planDisplay.apsisMarkers + entities.all() の各 equatorNodes?.mapPickables() を集約 → [overviewMode] isOccluded(cameraSystem.activeCameraPos, item.pos, ephemeris.attractorsAt(displayTime)) で天体に遮蔽された候補を除外
  - sections.exit(SECTION.mapPick)
  - sections.enter(SECTION.pointer)
  - handlePointerInput()
  - sections.exit(SECTION.pointer)
  - entityLines.update(player, targeter.aliveTarget, targeter.aliveSecondaryTarget, cameraSystem.overviewMode, displayWindow, mapPickables.visibilityPolicy) // 表示可否・ターゲット・操作艦・ビューがこのフレームの確定値になった後に判断する。艦・敵・基地それぞれへ線の出し入れとスタイルだけを決める(形状と変換は sync フェーズの entityLines.sync が担う)。ターゲット用スタイルは theme.ts の currentThemePalette() から毎フレーム組む(第一=palette.accent、第二=palette.secondary、不透明度は TARGET_LINE_OPACITY=0.9、renderOrder は LINE_RENDER_ORDER.target/.secondaryTarget) — 静的な LINE_STYLE 表には置けない(テーマ追従が要るため)
    - [entities.players ごと] asTarget = 第一・第二ターゲットのどちらかに該当すればそのスタイル、なければ null。visible = visibilityPolicy?.entity('player', isActive).orbit ?? true。showLines = (ship===player || overviewMode) && visible && asTarget === null。ownEllipse = showLines && !overviewMode(= 戦闘ビューの操作艦)
      - 軌道楕円: asTarget !== null かつ visible なら showOrbitLine(asTarget) — ビューを問わず出す。そうでなく ownEllipse なら showOrbitLine(LINE_STYLE.playerOrbit) — 戦闘ビューの操作艦は積分予測線ではなく解析楕円で軌道を描く。どちらでもなければ hideOrbitLine()
      - 予測線: showLines && !ownEllipse なら showPredictedLine(LINE_STYLE.playerPredicted)、そうでなければ hidePredictedLine()(= マップビューでのみ出る)
      - 過去線: showLines かつ pastDuration>0 なら showActualLine(LINE_STYLE.playerActual)、そうでなければ hideActualLine()(ownEllipse とは無関係で、ビューによらず同じ規則)
    - [entities.enemies ごと] asTarget = 同上。orbit = visibilityPolicy?.entity('ship').orbit。show = asTarget !== null ? (orbit ?? true) : overviewMode && 生存 && (orbit ?? false) — ターゲットはビューを問わず出し、可視性の既定も通常の線(false)と逆向き(true)。show なら showOrbitLine(asTarget ?? LINE_STYLE.enemyOrbit に個体色を載せたもの)、そうでなければ hideOrbitLine()
    - [entities.bases ごと] show = overviewMode && (visibilityPolicy?.entity('base').orbit ?? false) → show なら showOrbitLine(LINE_STYLE.baseOrbit)、そうでなければ hideOrbitLine()

### advanceSimulation(dt)

自機の行動 → ステージ → 積分 → エフェクトの順に1フレーム進める。艦の行動(`entities.updatePlayers`)
はステージの決着状態を問わず常に全自機ぶん呼ばれる — `input` が届かない艦(操作対象でない艦、
および操作できないワープ倍率では全艦)はその内部で連続指令を畳むだけになる(残骸・弾の epoch を
含め、どの状況でも他の段は進め続ける)。
`game.update` からは `!isPaused` のときだけ呼ばれる。

- advanceSimulation(dt)
  - 以下の player は毎回その場で読む game.player(= activePlayers.current)
  - sections.enter(SECTION.player)
  - nanWatchdog.checkPlayer('frameStart')
  - entities.updatePlayers(player, input, simSpeed, dt, activeStage, ephemeris) // entities.players 全隻ぶん、1隻ずつ ship.updatePlayerControls(…) を呼ぶ。input が届くのは ship===player かつ simSpeed.canShipAct の艦だけで、それ以外へは null を渡す(操作対象から外れた艦と操作できないワープ倍率は同じ状態なので、判断はここ1箇所)。simDt = dt × simSpeed.simSpeed もここで組む。ステージの決着状態は分岐条件に無い(決着後も操作艦は動く)
    - [ship ごと] ship.updatePlayerControls(input, dt, simDt, entities, activeStage, ephemeris)
      - updatePassive(dt) // belt.update() + hpRegen()。input の有無に関わらず必ず先頭で実行
        - belt.update()
          - physics.shiftBeltNodes() // リロードで給弾量が巻き戻ったフレームのみ
          - physics.update()
            - initNodesOnce() // 初回のみ
            - estimateAngularAccel() / integrateVerlet() / pinRootToAnchor() / relaxDistanceConstraints()
            - advanceOrientationConstraints() // リンクごとに角度クランプ・ツイスト更新
      - [input===null] clearTransientCommands() して return // このフレーム操作されない艦は、次のフレームへ持ち越してはならない連続指令をここで畳む
      - handleEdgeInput() → handleEdgePress() // 処理したキーは input.consumeKey() で消費する
        - throttle.toggleRcsDamp() // K.rcsDampToggle
        - throttle.enableProgradeReset() // K.progradeReset
        - toggleFineAttitude() // K.fineAttitudeToggle
        - throttle.toggleProgradeHold() // K.progradeHoldToggle
        - throttle.setThrottlePreset(0|1|2) // K.throttleLow/Mid/High
        - fire.manualReload() // K.reload。成功時のみ true(= キー消費)
          - worldSfx.playReload() + dropBarrel() → fx.spawnBarrel()
      - throttle.updateTorque(…, dt, simDt, …) → player.torque へ代入(マップビュー中も手動回転は常時有効)。出力ランプの保持時間は実時間 dt、RCS の燃料消費はシミュレーション時間 simDt で進める
        - onProgradeHoldReleased() → hud.hint() // ホールド中に手動回転入力があった場合のみ
        - autoAlignTorque() // ホールド中 かつ 手動回転入力なしの場合のみ
      - fire.updateFireState()
        - tickReloadTimer()
        - worldSfx.emptyClick() + hud.hint() // 弾切れの初回フレームのみ
        - fireCycle() // 発射キー押下 かつ残弾ありの場合のみ
          - worldSfx.spinUp() // 発射開始フレームのみ(このフレームは fireGun まで進まない)
          - consume() // 弾薬状態の更新。戻り値で以下の分岐が決まる
          - fireGun() // クールダウン明けのみ
            - spawnBullet() → entities.addBullet()
            - player.state.v に反動 Δv
            - dropCasing() → fx.spawnCasing()
            - spawnMuzzleFlash() → fx.spawnMuzzleFlash() → spawnFlash(dimsInGunsight=true)
            - activeStage.scoreCounter.recordShot()
            - worldSfx.fire()
          - spawnEjectedMagazineFrame() + worldSfx.magFeed() // 'mag-reload'
          - spawnEjectedMagazineFrame() + dropBarrel() + worldSfx.playReload() // 'barrel-reload'
      - throttle.updateThrustLatches() // WASDQE各キーの連打をエッジ検出しラッチ集合を更新。反対方向キーを押している間は相手側のラッチも解除し続ける。Δv編集中の6キーは editor.updateEditing が既に確保済みなので、ここでは押されていないように見える
      - throttle.updateThrustState(input, att, simDt, ship) → player.thrust へ代入(手動入力が無ければ null。燃料は推力が積分される simDt ぶん消費する。'powered' 中の艦がここで null になっても、後段の activeStage.update → planExecutor.update が Simulator.advance より前に正しい値へ上書きするので積分には影響しない)
        - throttle.stopThrust() // 推力入力なし(物理押下・ラッチとも無し)。thrustAccelVec(ベルト物理向け)を戻すだけ
      - invalidatePrediction() // player.thrust !== null のときのみ(自機の噴射結果を即座に予測へ反映)
      - [planExecution==='powered'] thrust!==null または throttle.hasManualRotationInput() なら planExecution='off' // 操作対象艦の手動並進・手動回転で自動実行を中断(マップモードかどうかは問わない)
  - nanWatchdog.checkPlayer('player.updatePlayerControls')
  - sections.exit(SECTION.player)
  - sections.enter(SECTION.stage)
  - activeStage.update() // 具体ステージへディスパッチ。各具体ステージが艦の有無を自分で見て内部で即 return する(決着後も進む)
    - behaveAllEnemies() // 敵を配置する具体ステージ(Stage0/00/1/2)が先頭で呼ぶ。CreativeStage は player があるときに限り、logistics.updateLogistics の直後で呼ぶ(既存敵の AI は waveAttackEnabled トグルの有無によらず常に進む)
      - enemy.behave() // 生存中の敵ごと(canShipAct・距離・バースト状態の判定は behave 内部)
        - firePlasma() → entities.addBullet()
    - [Stage0 訓練スコアアタック] logistics.updateLogistics(simSpeed, respawnOnDespawn=false)
    - [Stage0 訓練スコアアタック] timer.update() // 残り時間が尽きたフレームでのみ true を返す
      - [true のとき] decide('timeup', {win:true, title:'TIME UP', detailHtml}) // 結果画面の内容を確定させるだけ。表示は launcher.update が担う
    - [Stage00 無限サバイバル] logistics.updateLogistics(simSpeed, respawnOnDespawn=true)
      - absorbNearbyAmmo()
        - player.onPickup() + worldSfx.pickup() + hud.hint() // 範囲内の補給ごと
      - despawnFarAmmo() // 消滅そのものは投入可否によらず常に走る
        - spawnForPlayer() // 遠方消滅した数だけ再投入。投入可(resupplyEnabled かつ canResupplyAmmo)のときだけ。生存数が MAX_ACTIVE_AMMO_PICKUPS に達したら打ち切る
      - spawnForPlayer() // 投�    - 掃引で操作対象そのものを失った場合だけ reclaimAfterLoss() → 生存艦が居れば activePlayers.set(次の艦)、居なければ setOrNull(null)(sfx.setRcs(false)。カメラの追従対象は毎フレーム引数で渡り直すだけなのでここでは何もしない。ビューはここでは切り替えない)。元から操作対象が居ない状態(手動解除・未配置)では何もしない
  - docking.updateDockedPhysics() // 物理ドッキング中の艦の運動状態(位置・速度)を主天体/主艦に完全同期する
  - docking.checkProximity() // 内部で viewManager.current==='dock' なら即 return。それ以外はドッキング状態の定期更新と掃除を行う (自動収納は行わず、手動ドッキング＋手動収納へ変更)keFlybyVelocity() → limitFlybyDv() → waveShipPosition() ×機数
    - [Stage1 / Stage2 キャンペーン] logistics.updateLogistics(simSpeed, respawnOnDespawn=false)
    - [CreativeStage] player があれば: logistics.updateLogistics(simTime, player, simSpeed, respawnOnDespawn=true) → behaveAllEnemies()(上記) → [waveAttackEnabled] waveAttack.update(...)(Stage00 と同じ WaveAttack。トグルが制御するのは新規ウェーブの発生のみで、OFF の間も既存敵はそのまま残り AI は進む)
    - [CreativeStage] placerPanel.isOpen なら getForm() を1回だけ呼び、computePreview(form)/computeFieldIssues(form) へ共有する
    - [CreativeStage] entities.players ごとに ship.planExecutor.update(ship, simDt, simTime, simSpeed) // 刻み幅は simDt = dt × simSpeed.simSpeed(燃料消費を推力の積分ぶんに比例させる)。 !simSpeed.canShipAct なら先頭で idle へ戻して return(連続指令を書く主体は自分でゲートする — 姿勢整列トルクも含めて何も書かない)。planExecution!=='powered' なら idle へ戻すだけ。'powered' なら姿勢整列(idle/slew/armed)、または燃焼中(burn/trim)の出力段選択・燃料消費・ship.thrust の書き直しを進める。ノード時刻に対する猶予窓(NODE_APPROACH_LEAD+見積り燃焼時間+見積り姿勢転回時間)を外れている間は何もしない。死亡していれば停止。点火・遮断そのものはここでは行わない。Simulator.advance より前に呼ばれるので、操作艦で player.updatePlayerControls がこのフレーム player.thrust を null にしていても、積分に渡る前にここで確実に上書きされる
  - sections.exit(SECTION.stage)
  - nanWatchdog.checkPlayer('activeStage.update')
  - simSpeedManager.update() // 自動ワープ中のみ実効。残り時間が C.NODE_APPROACH_LEAD 以下なら autoWarpUntil=null + levelIdx=0 で即 return
  - simDt = dt × simSpeedManager.simSpeed // simSpeedManager.update() の後に組む(自動ワープが段を下げたフレームでは、その下げた後の倍率で積分する)
  - sections.enter(SECTION.integrate)
  - simulator.advance(dt, simDt, player, activeStage, simSpeedManager, nanWatchdog)
    // 弾命中を含む剛体接触・姿勢積分はいずれもこの中。simulator が contactPhysics(ContactPhysics)を所有する。
    // 弾も薬莢もデブリも天体も同じ ContactPhysics を通る一本の経路。resolveCollision は advance の内部で
    // simSpeed.canResolvePhysicalCollisions から求める(呼び出し側からは渡さない)
    - [サブステップごと] ×ceil(simDt / maxStep) // 分割数は simDt と刻み上限のみで決まる(実 fps に依存しない)
      - adaptiveMaxStep() → adaptiveSimulationMaxStep(生存する艦の state, R_EARTH + REENTRY_SUBSTEP_ALT, SUBSTEP_MAX_DT, REENTRY_SUBSTEP_MAX_DT)
        // 走査対象は entities.players と entities.enemies のみ。いずれかが再突入高度以下、または現在の降下率でその境界へ到達しうるとき、そのフレームの刻み上限が REENTRY_SUBSTEP_MAX_DT へ落ちる
      - nextEventTime(activeStage, passiveWarpLod) // activeStage.nextSimulationEventTime(simTime) と、エンティティ側の最小イベント時刻のうち早いものへ subDt を切り詰める
        // ステージ側は毎 substep 引き直す(艦の現在の Δv と加速度から毎回決まる生きた値のため)。エンティティ側(entityEventTime)は固定の絶対時刻なので控えを使い回し、simTime がその時刻へ到達したとき・entities.collectionRevision が変わったとき・passiveWarpLod が切り替わったときだけ全生存エンティティを走査し直す
        // passiveWarpLod 中はまとめ積分に回る個体(Bullet / DebrisPiece)を走査から外すので、その締切では substep 境界が立たない
        - [CreativeStage] ship.planExecution==='instant' なら plan.firstNode()?.t、'powered' なら ship.planExecutor.nextEventTime(ship, simTime)(ゲートが閉じている間は常に null。armed 中は点火予定時刻、burn/trim 中は射影から求めた遮断予定時刻。どちらも対象ノードが targetNode(参照)と一致する間だけ)
      - substep()
        - attractorsAt(ephemeris, entities, simTime + dt/2) // サブステップ中点で1回だけ: ephemeris.attractorsAt(t) の mu!==0 部分(gravityBodiesAt)+ entities.attractors()(mu!==0 の生存中 GameEntity)を合流
        - classifyAttractors(attractors) // 同じく1回だけ: μ の重い順 GRAVITY_ALWAYS_COUNT 本を always へ、残りを SpatialGrid へ分類。しきい値 μ(alwaysThresholdMu)もセル一辺(gridCellSize = √(最重グリッド天体 μ / GRAVITY_NEGLIGIBLE_ACCEL))もこの一覧から毎回導く
        - entity.stepActual(dt, attractorsNearInto(entity.state.r, classified, scratch, entity.id)) → actual.step() → stepDynamics()(保持サンプル列への記録)
          // 自機(全隻)・敵・弾・薬莢・デブリ・補給・基地・小惑星それぞれ、個体ごと。alive のみ実行。attractorsNearInto は always + 自身の位置の27近傍グリッドから自分自身の id を除いたもの。それらの重力 + J2 + 大気抵抗(bcInv)+ 自身の thrust
      - nanWatchdog.checkPlayer('simulator.advance(軌道積分)')
      - stepAttitudes(subDt) → stepAttitude() → entity.att へ代入 // 自機・敵・薬莢・デブリ・補給すべて同じ subDt で一律に積分する
      - nanWatchdog.checkPlayer('simulator.advance(姿勢積分)')
      - [entities.players ごと] p.stepEnvironment(subDt, ephemeris, simTime) // 熱・電力・ラジエータの受動状態
      - [resolveCollision のみ] contactPhysics.resolveSubstep(simTime, [...entities.all(), ...radiatorFolds], attractorsNow, activeStage)
        // radiatorFolds = entities.players のうち alive なものの p.collisionFolds(simTime)(艦の姿勢・展開度から毎 substep 置き直す放熱板の接触代理)
        - isFiniteParticipant() / isFiniteAttractor() でエンティティ・天体を有限値のものだけへ絞る // 空間グリッドへ入れる前に落とす(NaN セル添字を防ぐ主たるガード)
        - resolveInOrder() // 1 substep 内で TOI 昇順に最大 CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP 件解決。超過分は次回へ持ち越し
          - SpatialGrid 構築(1回、以後の反復で使い回す) // セル一辺 = 2×max(半径+|区間変位−参加者平均変位|)、退化時のみ CONTACT_GRID_CELL_SIZE_FLOOR
          - collectCandidates()(1回だけ) // 27近傍のエンティティ間ペア(少なくとも一方が attacker)+ 全 attacker×天体ペアのうち、双方の contactsWith が true のものを候補列へ詰める。接触しない組み合わせも response=null の候補として残す
          - [解決1件ごと、最大 CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP 回] earliestContact() // 候補列を1パス走査し、未解決かつ TOI 最小の1件を返す。直前の解決で状態が変わった当事者を含む候補だけ resolveSphereCollision(collision-response.ts)で response を引き直す
          - applyCandidate() → 双方(または片側、相手が天体の場合)の working state へ代入
            - [impulse > 0 のときだけ] a.collideWith(b, contact, activeStage) と b.collideWith(a, contact, activeStage) を順不同で呼ぶ // Contact は解決前の状態を保持するので呼び出し順に依らない
              - [Bullet.collideWith] alive = false // 相手への作用は相手側の collideWith が書く
              - [Ship(Player/Enemy).collideWith] other instanceof Bullet なら attackedByBullet()、それ以外なら applyCollisionDamage(contact.impulse / mass)
                - attackedByBullet(): applyDamageToParts(bullet.damage) → hp>0 なら impactEffect()(worldSfx.hit + fx.spawnPlasmaFlash/spawnBulletFlash + spawnGasPuff)、hp<=0 なら destroyEffect() + activeStage.recordEnemyDeath(cause='killed')/recordPlayerLost()
                  - [Enemy] destroyEffect() 前に scoreCounter.recordHit()(被弾のたび)
                  - [Player] thermal.addImpactHeat() は被弾のたび常に。radiator パーツへのダメージ時は radiatorBreakEffect()(全損した瞬間のみ)
                - applyCollisionDamage(): Δv=impulse/mass を COLLISION_DAMAGE_MIN_DV〜FULL_DV で maxHp へ線形マップし applyDamageToParts → hp>0 なら worldSfx.clank()+fx.spawnGasPuff()、hp<=0 なら destroyEffect() + recordEnemyDeath/recordPlayerLost()
              - [RadiatorFold.collideWith] owner.collideAtRadiator(side, other, contact, activeStage) へ委譲(パーツの割り振り先が side に固定される点だけが Ship.collideWith との違い)
              - [DebrisPiece.collideWith] other instanceof Bullet なら fx.spawnGasPuff()(弾自身の消滅は Bullet.collideWith)。kind==='casing' かつ相手が Player なら worldSfx.clank()
        - nanWatchdog.checkPlayer('simulator.advance(接触)')
      - activeStage.applySimulationEvents(simTime) // simTime がイベント境界ちょうどに到達した substep の直後、接触解決の後
        - [CreativeStage] ship.planExecution==='instant' なら node.t 到達で、simTime 以前の最後のノードを ship.state に据え、plan.consumeNodesUpTo(simTime, そのノード) で消化する(複数ノードを跨いだフレームも一括消費)
        - [CreativeStage] ship.planExecution==='powered' なら ship.planExecutor.applyIgnitionAndCutoff(ship, simTime, simSpeed) // 冒頭で !ship.alive なら stopIfActive して return。armed→burn の点火(ECI 固定の噴射方向 burnDirWorld/burnUpWorld を確定し ship.torque/ship.thrust を立てる)、射影が0を切った遮断(plan.consumeNodesUpTo(node.t, ship.state) で実到達状態へアンカーを差し替え)。噴射ゲートが閉じていれば燃焼ごと中断する
      - entities.cleanup(subDt, simTime, activeStage, playerPos, attractorsNow) // checkLoss(大気突入・天体表面への幾何的沈み込みのバックストップ)+ prune
    - [resolveCollision && player] contactPhysics.resolveBelt(dt, simTime, player, entities.all(), attractorsAt(simTime), activeStage)
      // ベルトのみサブステップループの外、フレームに1回、実 dt で解決する(BeltPhysics は実 dt を要求する局所シミュレーションで、substep へ持ち込むとワープ時に破綻するため)
      - player.belt.collisionSections(dt, ...) // BeltSection(接触代理)へ変換
      - resolveInOrder() // substep 版と同じ列挙・解決ロジックを共有
      - player.belt.applyCollisionSections(dt, ...) // 解決結果を Verlet 状態へ書き戻す
      - nanWatchdog.checkPlayer('simulator.advance(ベルト)')
    - lastSimDt = simDt
  - sections.exit(SECTION.integrate)
  - docking.updateDockedPhysics() // ドッキング中の艦の速度をドッキング相手のそれへ揃える(位置は書き換えない)。相手か自艦のどちらかが失われたペアはここで解消する
  - displayWindowManager.resolve(simulator.simTime, player) // 積分後の状態でこのフレームの表示窓を確定させ、以降の消費者へ共有する
  - nanWatchdog.checkAll('simulator.advance', player, entities, simTime, dt, simDt) // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る
  - targeter.updateBoardMarks(dt, player, entities) // 既存マークの経過時間を進め、寿命切れを捨てる。自機もターゲットも居なければ全消し
    - boardMarks.push() // 通常弾が的の面を自機側から通過した場合のみ
  - activePlayers.reclaimDead() // 喪失艦を配列・操作対象から回収する。全ステージ共通で毎フレーム無条件に呼ぶ(喪失した自機も他のエンティティと同じく速やかに取り除く)
    - entities.players のうち !alive な艦ごと → activePlayers.remove(lost) → navTarget.clearIfTargeting(lost.id) / targeter.clearIfTargeting(lost) / overviewCamera.clearFocusIf(lost.id) / entities.removePlayer(lost)
    - 掃引で操作対象そのものを失った場合だけ reclaimAfterLoss() → 生存艦が居れば activePlayers.set(次の艦)、居なければ setOrNull(null)(worldSfx.setRcs(false)。カメラの追従対象は毎フレーム引数で渡り直すだけなのでここでは何もしない。ビューはここでは切り替えない)。元から操作対象が居ない状態(手動解除・未配置)では何もしない
  - docking.checkProximity() // 内部で viewManager.current==='dock' なら即 return。それ以外は docking.updateDockedPhysics() を呼ぶだけで、収容の判定はしない(基地への収容は storeInBase を呼ぶ操作から起きる)
  - sections.enter(SECTION.effects)
  - effects.update(dt, simulator.simTime) → flashEffectManager.updateFlashEffects() // フラッシュの寿命と、各エフェクトの時刻から simTime までの移流。playing/player を問わず常に進める(決着直後の爆発を止めないため)
  - sections.exit(SECTION.effects)
  - sections.enter(SECTION.plan)
  - guide.update(player, simTime, editMode, ephemeris.attractorsAt(simTime)) // ここの player は reclaimDead / docking.checkProximity による引き継ぎ後の操作対象。null または editMode なら何もしない
    - player.plan.consumeNodesUpTo(simTime - C.NODE_EXPIRE_GRACE, player.state) // 期限切れノードをまとめて落とし、自機の実状態を新しいアンカーに据える
    - [直近ノードが実行の窓(node.t - C.NODE_APPROACH_LEAD)に入っている場合のみ]
      - notifyApproach() → hud.hint() // ノードごとに最初の1回のみ(approachNotified との同一性比較)
      - notifyAchieved() // orbitalElementsClose(自機軌道要素, 目標軌道要素) が真の場合のみ。player.plan.consumeNodesUpTo(node.t, player.state) で達成ノードを消化し、残り件数は消化後の実数を読む
        - hud.hint() + uiSfx.warp() // ノードごとに最初の1回のみ(achievedNotified との同一性比較)
  - sections.exit(SECTION.plan)

### handlePointerInput()

マップ/戦闘のポインタ操作を優先順位順(=呼ぶ順)に配る。`update` の末尾、`cameraSystem.update`
の後に呼ぶ(このフレームのカメラ行列で投影してからでないと画面上の対象をピックできない)。
各受け手は自分の出番(マップ視点/編集モード/操作艦の有無)かどうかを自分で見て自決するので、ここで
決めるのは呼ぶ順序だけ。決着状態は見ず、ポーズ中、または入力をゲートするオーバーレイ(セーブ
ブラウザ・ドック等)が開いている間は配らない(背景の誤操作を防ぐ)。

- handlePointerInput()
  - [isPaused || hud.overlayManager.isInputGated()] 即 return
  - マーカー(handleRightClick/handleLeftClick/handleDoubleClick)→ ノード(editor.handleMapPointer)→ 空域(handleEmptySpaceRightClick)の優先順は呼び出し順そのもの — 上流が消費した右クリックは下流に届かない
    - mapActions.handleRightClick(input, simTime) // [!cameraSystem.overviewMode] 即 return。マーカーへの右クリックだけを消費する。外れれば消費せず editor.handleMapPointer() のノード右クリックへ読み進む
      - pickNearest(mapPickables.pickables) // MAP_PICK_PX_SQ 以内の被選択物(天体/自機/敵船/nav-AN・DN/アプシス)を最寄りで拾う。候補列は mapPickables.refresh() が組んだ1本
      - mapActions.openPropertyWindow() // 拾えた場合のみ消費。既にその対象のウィンドウがあれば移動+最前面化のみ、なければ new PropertyWindow(root=hud.layers.window, buildContent(), hud.overlayManager, PROPERTY_WINDOW_TEMP_GROUP) // rows は空のまま開き、同フレーム後半の mapActions.sync() が埋める(items は windowItems() 経由で開いた瞬間から埋まる)。「一時ウィンドウは高々1枚」の排他自体は PropertyWindow 自身が hud.overlayManager.open()/reconfigure() 経由で宣言する(下記)
        - PropertyWindow のコンストラクタ → overlayManager.open(overlayId, this, currentSpec()) // 非クリップなら exclusiveGroup=PROPERTY_WINDOW_TEMP_GROUP を宣言し、同グループの既存メンバー(直前の一時ウィンドウ)を overlayManager 自身が closeWindow() 相当で追い出す
        - w.onSelect(act) → handlers[target.kind].run(act, target) // 選択結果はこれまでと同じ経路
          - act='delete' または !w.clipped → closeWindow() → entry.win.close() → dispose() + onClose() // 削除はクリップ有無によらず閉じる
        - clip ボタン押下 → setClipped() → overlayManager.reconfigure(overlayId, currentSpec()) // クリップ中は exclusiveGroup/closeOnEscape/closeOnOutsideClick を全て外す
        - ESC・外側クリック → overlayManager.closeTopmostOnEscape() / 内蔵の1本の pointerdown リスナ → entry.win.close()(!clipped の場合のみ発火)
        - w.onClose(✕ボタン、または close() 経由でのどの閉じ方でも同じく発火) → mapActions.forgetWindow() // 台帳から外すだけ
      - 選択結果は MapContextActions.run(act, target) へ
        - act='focus' → overviewCamera.focus 代入
        - act='navTarget' → navTarget.toggleTarget()
        - act='warp' → simSpeedManager.startAutoWarpTo(navTarget.passTimeOf(target.id))
        - act='addNode' → editor.addNodeAt(planDisplay.apsisTimeOf(target.id) または navTarget.passTimeOf(target.id))
        - act='activate' → entities.findPlayer(target.id) → activePlayers.set(ship) // 'player' のみ。id が現存する艦を指さなくなっていたら何もしない
          - targeter.clearTargets() // 切替前の艦が握っていたロックを持ち越さない
          - 以後 editor.plan は activePlayers.current.plan を返す(開いたままのノードメニューは次の editor.update() が畳む)
        - act='planExecCycle' → entities.findPlayer(target.id) → ship.planExecution = nextPlanExecution(ship.planExecution) // 'player' のみ。OFF→瞬間移動→自動操縦→OFF
        - act='delete' → entities.findPlayer(target.id) → entities.removePlayer(ship) → dispose() // 'player' のみ。操作対象の艦にはこの項目自体がメニューに出ない(MapContextActions.itemsFor)
    - mapActions.handleLeftClick(input) // [!cameraSystem.overviewMode] 即 return。自機/基地マーカーへの左クリックを選択として消費する。外れれば消費せず editor.handleMapPointer() のノード配置/選択解除に読み進む
      - selectPickable() // 'player' → activePlayers.set() / 'base' → docking.selectBase()(遷移はしない)
    - mapActions.handleDoubleClick(input) // [!cameraSystem.overviewMode] 即 return。pickables 全種別への最寄りダブルクリックで overviewCamera.setFocus()
    - editor.handleMapPointer(input) // [!editMode || 艦なし] 即 return。右クリック → 左クリックの順に受ける
      - handleNodeRightClick() // 右クリックごと。ノードをヒットしたぶんだけ消費する
        - selectedNodeIdx = ヒットしたノードの idx + nodeGizmo.openMenu() // ヒット時。true を返して消費
      - handleMapClick() // 左クリックごと。常に消費する
        - selectedNodeIdx = idx + uiSfx.warp() // 既存ノードをヒットした場合
        - planDisplay.path.nearestSample() // 直近の sync でキャッシュした cameraPos/attractors で isOccluded な点を候補から除外してから最寄りを探す → plan.addNode() + uiSfx.warp() // 計画軌道上をヒットした場合
        - selectedNodeIdx = null // どちらにも当たらなかった場合
      - dragNodeToNearestSample() // ノードを incoming arc の最寄り点へ移し、元のΔv成分を保ったまま新しいノード状態へ焼き直す
    - mapActions.handleEmptySpaceRightClick(input, simTime) // [!cameraSystem.overviewMode] 即 return。マーカーにもノードにも当たらなかった右クリックだけが届く。ContextMenu<MapPickable> で「オブジェクトリストウィンドウを表示」/(クリエイティブのみ)「オブジェクトを配置」/「設定メニューを開く」
  - [!player] 即 return
    - combatTargets = entities.getCombatTargets(player) // 敵 + 自機以外の生存中の全自機
    - targeter.handleTargetSelectKey(input, combatTargets, project, overviewMode) // [overviewMode] 即 return。[T] キー。右クリックとは無関係、独立の即時選定・順送り
    - navTarget.updateCombatBasePicking(entities, input, project, overviewMode) // [overviewMode] 即 return。mapActions より先に呼ぶ。基地に当たった右クリックだけを消費し、外れは false を返して mapActions へ回す
      - pickNearest(entities.bases) → baseMenu.open() // 当たった場合のみ。航法ターゲット設定/解除メニュー(ContextMenu のまま)
    - mapActions.handleCombatRightClick(input, combatTargets, project, simTime, overviewMode) // [overviewMode] 即 return。マップの handleRightClick の戦闘ビュー版(同じ対象は常に同じ窓)
      - targeter.pickTargetAt(click, combatTargets, project) // TARGET_LOCK_PICK_PX_SQ 以内の画面最近傍
        - [当たり] combatTargetPickable(target) → mapActions.openPropertyWindow() // kind='player'/'ship' へ変換して同じプロパティウィンドウ経路。itemsFor に combatTargetLockItems(targetPrimary/targetSecondary、overviewMode では出さない)が乗る
          - targetPrimary/targetSecondary 選択 → runTargetLock() → targeter.setPrimaryTarget()/setSecondaryTarget()
        - [外れ] mapActions.openEmptySpaceMenu() // マップの空域メニューと同じ実装(ContextMenu<MapPickable>)
      // 自動選定・自動再選択はない。target/secondaryTarget はこのメニューか [T] キーでのみ変わる

---

## game.sync()

- game.sync()
  - player = game.player(= activePlayers.current)
  - displayWindow = displayWindowManager.resolve(simulator.simTime, player) // sync フェーズの先頭で1回だけ。update フェーズ側で求めた値とは別に、sync フェーズ全体(displayTime を読む全消費者・displayWindowManager.sync 自身)がこの1回を共有する。内部はキャッシュ(simTime・revision・player・player.state のいずれも動いていなければ組み直さない)なので、update フェーズと合わせて実質的な組み直しは1フレームに数回のみ
  - viewBadge.sync(activeStage.selectLabel) // タイトル・Mode・View ドロップダウンの表示反映
  - fo = new FloatingOrigin(cameraSystem.activeCameraPos, player?.state.v ?? v3()) // sync() 冒頭のローカル変数(Game はフィールドとして持たない)。r=アクティブカメラのECI位置(update フェーズの cameraSystem.update() で確定済み)、v=自機速度(艦が無ければゼロ)。以降の sync 系はこの fo だけを参照する
  - { displayTime, simTime } = displayWindow // displayTime は未来ゴーストのスライダーが立っている間だけ先の時刻、simTime は積分後の simulator.simTime と一致する値
  - attractors = displayWindowManager.attractorsAt(simTime) // 解析天体 + 重力を持つ生存中の GameEntity(小惑星)の合流窓。EntityManager.cleanup へ渡す表面到達判定用の配列(解析天体のみ)とは別物。現在状態を数値で読ませる HUD パネル・プロパティ行・frameControls がこちらを取る
  - displayAttractors = displayWindowManager.attractorsAt(displayTime) // 同じ合流窓を表示時刻で引いたもの。画面に描く幾何(entityLines.sync の軌道線・折れ線 — ターゲットのハイライト線も含む)がこちらを取る — 天体メッシュは displayTime に置かれるので、楕円の中心天体位置や un-bake を simTime で取ると同一画面上でずれる
  - cameraSystem.sync(fo) // 最初に呼ぶ: 後続の sync とマーカー投影が今フレームのカメラ行列を読む
    - syncCameraToViewpoint(active.camera, active.viewpoint, fo) // active = overviewMode ? overviewCamera : combatCamera。両カメラの viewpoint→THREE.PerspectiveCamera 反映はここ一箇所
    - viewOptionsPanel.setVisible(overviewMode) + setBodyClassToggles(bodyClassToggles) // 表示パネル。点灯反映は overviewMode のみ(天球グリッドセクションはボタン自身が押されるたび自分の on を反転するので、per frame の押し出しは無い — Navball.setGridVisibility() は construct 時に1回だけ)
    - focusMarkers.syncLabels() → markerManager.setPosition() // ラベルごと。overviewMode のみ
    - focusMarkers.hideLabels() // !overviewMode のみ
  - project = cameraSystem.activeCameraProjection / overviewMode = cameraSystem.overviewMode // 以降の sync 系へ配る共通値
  - visibilityPolicy = mapPickables.visibilityPolicy // ここでは組まず、update フェーズの mapPickables.refresh() が確定させた同じ MapVisibilityPolicy を読む(マップビュー以外では refresh 自身が null に落とす)。environment.sync / entities.syncPlayers・applyVisibility・syncMarkers / activeStage.sync / targeter.syncTargetMarkers がすべてこれを受け取る
  - combatTargets = entities.getCombatTargets(player) // 敵 + 自機以外の生存中の全自機
  - environment.sync(player?.state.r ?? null, fo, displayTime, cameraSystem, navball.gridVisibility, visibilityPolicy)
    - lit = sunlitFactor(playerPos, ephemeris.sunDirFrom(playerPos, displayTime), …)。playerPos が null(艦がいない)のときと overviewMode では 1.0 固定
    - asteroidField.sync(fo, cameraSystem.overviewMode) // !overviewMode ならメッシュを隠して return。overviewMode では update が引き直していない点も含め全インスタンス行列を書き直す(fo が毎フレーム動くため)
    - [bodies(= CELESTIAL_BODIES 登録順の CelestialBody[])ごと] body.sync(fo, displayTime, cameraSystem, ephemeris)
      - EarthBody.sync() → earth.group.position / earth.setRotation() / earth.setSunDir(ephemeris.sunDirFrom(地球の実位置, displayTime)) / earth.syncSurfaceLod(apparentSizePx(2·R_EARTH, cameraSystem.activeCameraScale(地球の実位置))) / earth.tick()
      - SunBody.sync() → billboard 位置(カメラ相対の圧縮距離)/ 広範囲視点では実位置の球体
      - SphereBody.sync()(月・海王星・準惑星等7体・彗星核2体、および pointBrightness 未指定の惑星) → overviewMode なら実 ECI 位置、!overviewMode ならカメラ相対の圧縮距離。陰影は surface.setSunDirection(ephemeris.sunDirFrom(実 ECI 位置, displayTime))。姿勢は ephemeris.poleAt(id, displayTime) が非null なら spinOrientation(axis, spinAngle) をクォータニオンへ書き込み(lookAt は使わない)、pole モデルを持たない天体は姿勢を変更しない。rings を持つ天体(木星・土星・天王星・海王星)は続けて RingView.sync() を呼ぶ
      - PointBody.sync()(pointBrightness 指定の惑星 = 金星・木星=bright、水星・火星・土星=medium、天王星=faint) → overviewMode なら SphereBody と同じ実 ECI 位置・実半径・姿勢のメッシュ(rings があれば RingView.sync() も)を表示、!overviewMode ならそのメッシュ(と環があれば RingView.group)を隠して代わりに星シェル半径(STAR_SHELL_RADIUS)上の実方向へ billboard を置く輝点表示に切り替える(常にどちらか一方だけ visible)
      - RingView.sync()(SphereBody/PointBody から rings がある天体のみ呼ばれる)→ 環グループの位置・スケールは本体メッシュに揃え、姿勢は spinAngle=0 の spinOrientation で本体とは別個に組む(環は本体メッシュの子ではないので自転位相を継承しない)。厚み0かつ非テクスチャの細帯ごとに、その天体の実 ECI 位置での CameraSystem.activeCameraScale(metersPerPixel)と帯の実幅から thinBandBlend() で annulus/line の重み(和が1)と被覆率を求め、重みが0でない側を visible にして coverage へ掛ける
    - sunLight.position(= ephemeris.sunDirFrom(fo.r, displayTime))・intensity 更新 // 平行光は描画原点近傍の実スケール物体だけを照らす。天体は body.sync 内で自分の真の位置から陰影を計算済み
    - ambient.intensity 更新 // lit から導出
    - syncStars() // 星殻をカメラへ追従、overviewMode でさらに拡大
    - syncReferenceLines(simTime, fo, overviewMode, focus, toggles) → geoLine.sync() + [referenceLines の各 OrbitLine ごと] showsReferenceLine(id, focus, toggles) が true のときだけ line.sync(orbitElementsFor(id, simTime), …)、false なら null 渡しで非表示 // !overviewMode では全線 null。惑星線は常時、衛星線は focus がその衛星系(地球系除く)を指すときだけ show
    - celestialGrid.sync() // navball.gridVisibility の6トグルと overviewMode に応じたスケールを反映
  - entities.syncPlayers(player, fo, cameraSystem, displayTime, ephemeris, displayAttractors, visibilityPolicy) // 全自機ごとに ship.syncPlayer(...) を呼ぶ。方向マーカー・ボアサイト・ガンサイトズームの隠れは isActive(=ship===player)の艦だけ
    - ship.syncPlayer(fo, cameraSystem, displayTime, isActive, ephemeris, attractors, visibilityPolicy?.entity('player', isActive))
      - displayState(displayTime) // current.at または predicted.at。null なら renderObject.visible=false のみで以下は現在状態のまま
      - renderObject の position / quaternion / visible // displayState 基準(未来ゴースト表示中は将来位置)。ガンサイトズームで隠れるのは isActive の艦だけ
      - thrustEffects.sync(this.thrust, maxAccel, ...) → worldSfx.setThrust(firing)(isActive のみ) + core/outer の sync() or hide() // this.thrust は PlayerThrottle/PlanExecutor どちらが立てても同じ。displayState(displayTime) ?? this.state。displayState が null なら visible=false 扱いで呼び自分で隠れる
      - rcsEffects.sync() → worldSfx.setRcs(rotating) + puff の sync() or hide() ×4 // 同上
      - belt.sync() // 引数なし。各リンクの position/quaternion を平行移動+ツイストから導出するだけで、表示可否は renderObject.visible に従う
      - radiator.sync() // ヒンジ Group の rotation.y へ展開角を書く
      - reentryEffects.sync() // qdyn が REENTRY_GLOW_MIN_Q 未満、または !visible なら隠すだけ
      - [isActive] markers.sync(currentState, displayState, ..., project, scale) // 自機由来の HUD マーカー(方位・ボアサイト・▲)。操作対象の艦だけが出す
        - [overviewMode] 戦闘用7キーを hide + displayState があれば headingDeg(displayState.r, displayState.v) → markerManager.setPosition('self', 'mk-self', '▲', rotationDeg) / 無ければ hide('self')
        - [!overviewMode] hide('self') + syncOrbitAxes(currentState) // pro/retro/nrm/anm/radout/radin。常に現在状態
        - [!overviewMode] syncBoresight(currentState) → setDirection('bore') // 常に現在状態、無条件に描画
  - entities.sync(fo, displayTime) → entity.sync(fo, displayTime) // 敵・弾・薬莢・デブリ・補給それぞれ(Bullet は速度方向を向く別実装)。自機(全隻)は含まない — 各艦は syncPlayers() が個別に同期済み。
    displayState が null(predictsFuture=false の種別が未来表示中、または予測ホライズン超過)なら visible=false
    - 続けて弾本体/弾ハロー/プラズマ弾/薬莢/破片(fragment、バリアントごとに1本)の各 InstancedPool を beginFrame → (bullets/casings/debris ごとに renderObject.visible を見て push) → endFrame。Group(本体+ハロー)を持つ通常弾は renderObject.updateMatrixWorld() で子まで連鎖更新してから両プールへ push。fragment は debrisFragmentPools[fragmentVariant] へ fragmentColor(per-instance color)付きで push
  - entities.applyVisibility(visibilityPolicy, player) // 天体クラス別トグルに応じた自機・敵・弾薬・基地のメッシュ表示。visibilityPolicy が null(戦闘ビュー)のときは非表示扱いを一切かけない
    - [visibilityPolicy] 自機・敵・弾薬・基地それぞれ、その種別の category が admit しなければ renderObject.visible=false
  - entities.syncMarkers(cameraSystem, displayTime, player?.state.r ?? null, visibilityPolicy) // ammoPickups/bases の各 marker?.sync。displayState(displayTime) → [overviewMode] headingDeg(ds.r, ds.v) → set('entity-<id>', 'mk-ammo'|'mk-base', '▲', rotationDeg) / [!overviewMode] set('entity-<id>', 種別ごとの字形) + setBearing('entity-<id>-bearing')。ラベルは name + viewerPos があれば距離
  - effects.sync(fo, camera, cameraSystem.zoomActive) → flashEffectManager.syncFlashEffects()
    - pool.beginFrame() → (生存中のフラッシュごとに transform へ位置/スケール/カメラ正対回転を書き、color = baseColor×opacity で push) → pool.endFrame() // 寿命・移流は update フェーズで済んでいる。opacity には zoomActive かつ dimsInGunsight のフラッシュだけ ZOOM_MUZZLE_FLASH_SCALE が掛かる
  - targeter.sync(player, cameraSystem) // 的通過マーク・方位マーカーのみ。ターゲットのハイライト線は持たない(entityLines.update/.sync がそのエンティティ自身の orbitLine をターゲット用スタイルで出す — 上記参照)
    - syncBoardMarkers(project) // 的通過マークの表示(スロットごと)。第一ターゲットのみ
    - syncTargetDirMarkers(player, overviewMode, project) // ◇/◆ tgtdir/atgdir。overviewMode or 第一ターゲット無しなら hide。第一ターゲットのみ
  - targeter.syncTargetMarkers(player, combatTargets, displayTime, simTime, cameraSystem, visibilityPolicy) // 位置は機体メッシュと同じ displayState 基準
    - [combatTargets ごと] displayState(displayTime) → visibilityPolicy が admit する pickable のみ → markerItem(role, viewerPos, pos, vel, overviewMode) // role は第一/第二/なし。overviewMode で hpMarkerSvg()/headingHpMarkerSvg() を切り替え。displayState が null な対象はここで除外(マーカーごと落とす)。visibilityPolicy が icon/label を落としていれば sym/name/detail を空にする
    - markerManager.combatMarkers.sync(items, project, overviewMode, scale) // 生存かつ displayState を持つ対象の markerItem() 集合を受ける(まとめは1体では決まらない)
      - groupNearby() // 画面上で近接するものをクラスタ化し、代表以外のラベルを落とす
      - [overviewMode] headingDeg(item.pos, item.vel) → rotationDeg // 対象ごと。円軌道での進行方向を示す
      - markerManager.set() + markerManager.setBearing() // 対象ごと。overviewMode 以外で画面外なら画面端の方位マーカー▲へ
      - retire() // 前フレームに出したキーのうち集合から消えたものを remove(対象ごとに増えるキーなので DOM ごと捨てる)
    - [player] markerManager.leadMarkers.sync(player, aliveScratch, aliveTarget, aliveSecondaryTarget, simTime, overviewMode, project) // 対象ごとの LEAD マーカー。overviewMode なら全 remove して return
      - trackTargeted() // 最終ロック時刻を生存中の対象ぶんだけ作り直す
      - leadPoint() → markerManager.setPosition('lead-<name>') // LEAD_HOLD_SEC 以内 かつ 解がある対象ごと
  - navTarget.sync(cameraSystem) // ▲/▽ nav-an/nav-dn マーカー。navTarget.update() が求めた位置があれば表示、無ければ hide。[overviewMode かつ isOccluded] も hide
  - entities.syncEquatorNodes(cameraSystem) // all() を回して各 equatorNodes?.sync。△/▽ eqan-*/eqdn-* マーカー。show=overviewMode。sync は置いた交点を捨てるので、このフレームに update されなかったペアは自動的に隠れる。[show かつ isOccluded] は hide
  - [isMapView] displayWindowManager.sync(player) // PREDICT パネル(期間ピル/スクラバー/目盛り)の表示/内容を押し出す。自機の predicted.state.t が current(simTime, duration)のどこまで届いているかの割合(0..1、自機/予測/表示期間のいずれかが無ければ 1)も内部で求めて渡す
    - panel.render(state) // visible(=!forceCurrent)・期間ピル・スクラバー(段階数/つまみ位置/未予測区間の減光)・絶対日時/T+ラベル・目盛りを1回でまとめて押し出す。編集中(任意期間フォーム・T+ジャンプフォームを開いている)行は再描画をスキップし、入力中の値を壊さない
  - [isMapView] frameControls.sync(mapPickables.pickables, cameraSystem.activeCameraPos, attractors, simTime, overviewMode) // 座標系パネル。!overviewMode なら非表示にして return
    - [overviewMode] members = systemMembersAt(ephemeris.registry, cameraPos, attractors) // 4ゾーン共通の「いまカメラがいる系の天体列」を1回だけ導出
    - [overviewMode] cameraZone.setItems(pickables) / setNearby(members, pickables) / setSelected(focusTargetId(overviewCamera.focus)) // カメラの固定先(全候補プルダウン + いまいる系のクイックボタン)
    - [overviewMode] cameraRotationZone.setNearby(members) / setSelected(overviewCamera.cameraFrame.rotatingWith)
    - [overviewMode] translationZone.setItems(pickables) / setNearby(members, pickables) / setSelected(displayWindow.frame.center) // 未来表示(計画折れ線・予測軌道線・交点マーカー)の描画座標系の原点
    - [overviewMode] planRotationZone.setNearby(members) / setSelected(displayWindow.frame.rotatingWith)
  - mapActions.sync(simTime, attractors, player) // 軌道オブジェクトウィンドウ。overviewMode は引数ではなく内部で cameraSystem.overviewMode を読む。overviewMode の間は常設表示で mapPickables.pickables を行として書き出す
    - objectListPanel.sync(pickables, focusId, parentOf) // 区画の選別・並べ替え・親子構造(Section.order)は、それを決める入力が変わったフレームか、保持している順序が今フレームの値で整列条件を満たさなくなったフレーム(距離順)にだけ組み直す。行の値(距離・詳細)と見出しの件数は毎フレーム書く
    - 開いている各プロパティウィンドウ // isTargetGone(target) が真なら closeWindow()(player は findPlayer(id)===undefined、すなわち entities.players からの存在有無で見る。ship/ammo/base は実体の alive を直接見る。displayState が null なだけの休止フレームでは実体自体は残るので閉じない。天体/アプシス/AN-DN は mapPickables.pickables に載っているかで判定) — 残れば target を pickables の最新値へ更新し、buildRows() → w.syncRows() / windowItems() → w.syncItems()
  - editor.sync(cameraSystem, simTime, fo) // mapDist は内部で cameraSystem.overviewCamera.dist を読む
    - [displayedPlan !== null] planDisplay.sync(fo, project, scale, overviewMode, cameraPos)
      - path.setVisible(nodeCount > 0) // ノードの無い計画は自機の現在軌道そのものを描くだけなので折れ線を隠す
      - path.sync(fo, project, scale, cameraPos) // ノードの有無に関わらず毎フレーム呼ぶ(画面判定に使う視点を更新するため)。区間の折れ線メッシュ。表示座標系と un-bake 時刻は update フェーズで確定済み。cameraPos は nearestSample(DOM ポインタイベント起点)向けにここでキャッシュするだけ
        // 区間の終端はノードの t。末尾区間だけは起点の解析軌道1周期ぶん(plan.ts の orbitPeriodOf)
        // ノードの t は Plan.nodeTimeRange の制約で起点から1周期以内なので、どの区間も1周を超えない
        - [区間ごと] サンプル列中央の代表点で scale(m/px) を引き、破線のドット・隙間のピクセル指定を実距離へ換算。line = lineAt(i)(区間 index に対応する TrajectoryLine プール要素。区間数が減っても捨てず隠すだけ)
        - line.setVisible(true) + line.setDash(dashSize, gapSize) // 有効な区間ごと
          - line.syncGeometry(arc.trajectory, null, arc.end, frame, ...) // 点列 or frame or end が変わったときのみ頂点を bake。end は arc.end(積分先端が継ぎ足しで先まで伸びていても、この区間として答える範囲だけへクランプ)
          - line.syncTransform() // 毎フレーム(剛体 un-bake + フローティングオリジン補正)
          - line.sync(camera)
        - lines[i].setVisible(false) // 区間数が減って余った線ごと(index は保持し続ける)
      - syncGhost() → markerManager.setPosition('plannedPlayer') or hide() // update が求めた ghost が null なら hide
      - syncApsisMarkers(project, overviewMode, cameraPos) → markerManager.setPosition('apsisPe'/'apsisAp') or hide() // update が求めたアイコンごと。[overviewMode かつ isOccluded] も hide
    - [displayedPlan === null] planDisplay.hide()
    - [操作艦あり かつ editMode] syncGizmo(艦.plan) → nodeGizmo.sync() // ノードハンドル + 選択中ノードの Δv アーム6個
      // ↑ planDisplay.sync の後で呼ぶ: ノードの画面座標は path の今フレームの表示文脈を通す
    - [操作艦あり かつ editMode] syncPanel(艦, simTime) // ノード一覧・選択中ノードの Δv と噴射後要素を組み立て、panel.sync(nodes, selEl, localDv, ...) → PlanPanel.sync() で軌道計画パネルの HTML へ反映(HoldButton ×6 は PlanPanel.dvButtons、updateEditing がここ経由で読む)
  - entityLines.sync(displayWindow, fo, cameraSystem.activeCamera, displayAttractors, ephemeris) // 計画折れ線と同じ座標系(displayWindow.frame)で bake する。出す/消すは update フェーズの entityLines.update が決めきっているので、ここでは全個体へ一律に形状と変換だけを合わせる
    - [entities.players ごと] predictedTo = ship.predictionTruncated ? null : simTime + duration
    - [entities.players ごと] ship.syncTrajectoryLines(frame, simTime, displayTime, pastDuration, predictedTo, ephemeris, fo, camera, displayAttractors) // 描くかは線を持っているかがそのまま答えなので、ここでは判定しない
      - predictedLine.syncGeometry(predicted, simTime, predictedTo, frame, ...) // predicted.samplesOldestFirst() を frame で bake(点列の参照が変わらない限り再bakeしない)。simTime は描画区間の下限で sampler の時刻写像だけを動かす — 線の先頭は predicted を simTime で補間した点になる。上限 predictedTo に保持列の先端が届かなければ、先端を extrapolationCenter まわりの二体軌道とみなして継ぎ足す(中心天体を持たない、または軌道要素が求まらなければ先端で止まる)
      - predictedLine.syncTransform()
      - predictedLine.sync(camera) // 頂点2未満なら curve.clear()
      - actualLine.syncGeometry(actual, simTime - pastDuration, simTime, frame, ...) // 過去線は actual の保持列。下限が保持窓より古ければ TrajectoryLine 側が保持区間の先頭へクランプする。actual は extrapolationCenter を持たないので外挿は起きない
      - actualLine.syncTransform()
      - actualLine.sync(camera)
    - [entities.players ごと] ship.syncOrbitLine(fo, camera, displayAttractors, ship.thrust !== null, frame, displayTime, ephemeris) // orbitLine を持つのは第一/第二ターゲットにされている艦と、戦闘ビューの操作艦。中心天体は strongestAttractor(ship.state.r, attractors)。線を持たなければ何もしない。force には噴射中かを渡す — OrbitLine は要素が閾値を超えるまで焼き直さないので、噴射中は渡さないと楕円が追従しない
    - [entities.enemies ごと] enemy.syncOrbitLine(fo, camera, displayAttractors, enemy.thrust !== null, frame, displayTime, ephemeris) // 中心天体は strongestAttractor(enemy.state.r, attractors)。線を持たなければ何もしない
    - [entities.bases ごと] base.syncOrbitLine(fo, camera, displayAttractors, base.thrust !== null, frame, displayTime, ephemeris) // 同上
  - [player] touchControls?.syncModeButtons(rcsDamp, fineAttitude, progradeHold) // タッチデバイスのみ。制動/微動/ホールドの点灯
  - activeStage.sync(player, fo, cameraSystem, displayTime, visibilityPolicy) // player は Creative の未配置状態で null
    - syncStatusPanel(player, cameraSystem.overviewMode) → statusPanel.sync(player | null, message, kills) // hudSubStatus() が null か overviewMode なら null を渡し、パネル側が畳んで保持中の艦参照も落とす
    - [CreativeStage] syncPreview(fo, project) // update が求めた preview の軌道線 + ▷ PREVIEW マーカー。preview が null なら両方隠す
    - [CreativeStage] placerPanel.setIssues(issues) // update が求めた issues を渡すだけ。前回と同内容なら panel 側が DOM に触らず即 return
    - [CreativeStage] creativeOptionsPanel.classList.toggle('hidden', !cameraSystem.overviewMode) // 「設定」パネル(補給の自動投入・敵の波状攻撃トグル)はオーバービューでだけ出す
  - hud.simulationStatusBar.sync(game) // #hud-globalstatus。Game インスタンスを直接読む(narrow ctx を介さない常設パネル群の1つ)。MET は毎フレーム、時間加速/NODE WARP 残りは約10Hz(SYNC_INTERVAL_MS)にスロットル
  - hud.mapScaleBadge.sync(game) // #hud-map-scale。overviewMode のみ表示、フォーカス対象の深度における meters-per-pixel から縮尺バーを毎フレーム求め直す(スロットル無し)
  - hud.vesselPanel.sync(game) // #hud-status。自機不在なら隠す(表示/非表示の切替は毎フレーム)。行の値(RCS制動/並進出力/微調整/進行方向ホールド/視点のRCS追従/弾薬)は約10Hzにスロットル
  - hud.orbitPanel.sync(game, attractors) // #hud-orbit。自機不在なら隠す、overviewMode でも畳む(切替は毎フレーム)。orbitInfo 由来の行(基準天体/高度/速度/AP/PE/INC/PRD/動圧/機体温度)は約10Hzにスロットル
  - hud.targetPanel.sync(game, attractors) // #hud-target。ロック中ターゲットの有無による表示切替は毎フレーム。relativeInfo 由来の行(名前/装甲/距離/接近速度/相対速度)は約10Hzにスロットル。軌道要素・相対傾斜角はここには無く、右クリックのプロパティウィンドウが持つ
  - hud.enemiesPanel.sync(game) // #hud-enemies。自機不在なら隠す、overviewMode でも畳む(切替は毎フレーム)。撃墜数バッジ・waveId 集約済みの敵一覧は約4Hz(250ms)にスロットル
  - hud.tick() // ヒント/トーストのフェードアウト
  - guide.sync(player, simTime, editMode, project, editor.planDisplay.path) // NODE/BURN の位置と方向は path.toDisplay/toDisplayDir を通し、計画折れ線と同じ座標系へ載せる。 player の有無をここで問わず毎フレーム呼ぶ。内部で player.plan から引く
    - markerManager.hide('nd') + hide('burn') // player 不在・editMode・または直近ノードが無い場合
    - markerManager.setPosition('nd') + setDirection('burn') // 直近ノードがある場合
  - markerManager.resolveCollisions() // ラベル衝突緩和 + SVG 引き出し線の再描画。全マーカーが出揃った後に一度だけ

---

## game.render()

- game.render()
  - [viewManager.current === 'dock'] 何も描かずに return // ドックは 3D を持たない全画面ビュー
  - pipeline.render(scene, cameraSystem.activeCamera)
    - gbuffer.render(scene, camera, width, height) // Gバッファパス。camera.layers を一時的に LIT_OPAQUE_LAYER だけへ絞り、呼び出し後に元のマスクへ戻す
      - gpu.beginPass(GPU_PASS.gbuffer)
      - renderer.render(scene, camera) // 深度・法線(oct encode)・ラフネスを2枚の MRT ターゲットへ描く。debugTarget が 'off' 以外なら composite パスがこれを読む
    - lightPrepass.render(camera, width, height) // ライティングパス。G バッファと SunLight だけを読み、拡散/鏡面の照度を2枚の MRT へ描く(シーンは描かない)
      - projMatrixInverse.value = camera.projectionMatrixInverse
      - sunDirectionView.value = SunLight.direction を camera.matrixWorldInverse で view 空間へ回転した値
      - gpu.beginPass(GPU_PASS.lighting)
      - quad.render(renderer) // 内部で renderer.render() を呼ぶ
    - materialPass.render(scene, camera, target, width, height, debugTarget === 'material') // マテリアルパス。camera.layers を LIT_OPAQUE_LAYER だけへ絞り、ライティングパスの2枚の照度バッファを読んで lit-opaque メッシュを描く
      - scene.traverse(...) // 未変換の MeshStandardMaterial を MeshStandardNodeMaterial + MaterialPassLightingModel へその場で置き換える(WeakSet で二重変換を防ぐ)
      - [showDebugTarget] gpu.beginPass(GPU_PASS.material); renderer.render(scene, camera) // 自前のデバッグ表示用ターゲットへ描く。「マテリアル」表示を選んでいるときだけ払うコスト
      - gpu.beginPass(GPU_PASS.material)
      - renderer.render(scene, camera) // world パスと共有する HDR ターゲットへ描く。このパスがそこへの最初の書き込みなので autoClear で色・深度をクリアする
    - gpu.beginPass(GPU_PASS.world) // 次の renderer.render() 呼び出しが world パスの GPU 計測に属すると申告する
    - renderer.autoClear = false // マテリアルパスが書いた色・深度を残したまま重ね描きする(既定のカメラマスクなので lit-opaque 層とは自動的に重複しない)
    - renderer.render(scene, camera) // world パス。同じ HDR レンダーターゲットへ描く
    - renderer.autoClear = true // 以降の描画呼び出しへこの変更を持ち越さない
    - depthDebugNear.value = camera.near, depthDebugFar.value = camera.far // QuadMesh 自身の固定直交カメラでは TSL の cameraNear/cameraFar が実カメラの値を返さないため、深度デバッグ表示用に毎フレーム書く
    - quad.material = compositeMaterials[debugTarget] // 通常表示は HDR world 色 × 露出、それ以外は G バッファ/照度バッファ/マテリアルパス単体の中身をそのまま画面いっぱいに映すマテリアルへ差し替える
    - gpu.beginPass(GPU_PASS.composite)
    - quad.render(renderer) // composite パス。内部で renderer.render() を呼ぶ

---

## 補足

- **`update` / `sync` / `render` の三分割は main.ts のループが決めている。** `Game.update` は論理状態のみ
  (THREE.js オブジェクトに触らない)、`Game.sync` は fo を作って既存メッシュ・DOM へ反映するだけ、
  `Game.render` は `pipeline.render` を呼ぶだけ(パス構成そのものは `RenderPipeline` が持つ)、という
  切り分けになっている。
- **カメラ更新は `Game.update` の末尾**(物理積分の後)にある。`sync` で作るフローティングオリジンは
  積分後の自機位置なので、追従カメラの基準もそこに合わせる必要がある。
- **高ワープ時**(`simSpeed > MAX_PHYS_SIM_SPEED`)は `substep()` が1フレームに最大64回走るが、
  `advance` の内部で `resolveCollision = simSpeed.canResolvePhysicalCollisions` が false になるため、
  `contactPhysics.resolveSubstep()`/`resolveBelt()` は丸ごとスキップされる(接触判定・弾命中を
  含む)。substep が長大になる高ワープでは弾もすり抜けるが、`canShipAct` が同じ閾値で発砲自体を
  止めているので実害は無い。
- **計画区間の弧の作り直し**は `PlanPath.update` が owned な区間ごとに問う
  `arc.represents(state0, end, sourceRevision)` で決まる(計画が空のあいだの唯一の区間は owned
  でなく、自機の `PredictedArc` を borrow として毎フレーム答えるので、上の呼び出し木の該当箇所を
  見る)。`sourceRevision`(重力源プロバイダの revision)が食い違えば即座に作り直す
  (`new PredictedArc(...)` — 空の弧を作るだけで、同期積分はしない)。一致していても、
  積分済みのサンプルを記録したときの間引き下限が今回の要求区間の求める下限([表示期間]を大きく
  縮めた直後など)を `ARC_MAX_SAMPLE_COARSENING` 倍を超えて上回っていれば作り直す(クリック候補が
  飛び飛びの点になるのを避けるため)。比べるのは下限どうしで、実際のサンプル間隔ではない —
  間隔は刻み幅(1周 / `ARC_STEPS_PER_REV`)でも決まり、そちらは作り直しても同じ値になるので、
  間隔を下限と比べると `'orbit'` プリセット(要求下限 = 1周 / `ARC_MAX_SAMPLES`)で判定が
  恒真になり、縮めようのない粗さを理由に毎フレーム区間全体を作り直すことになる。その2つのゲートを
  抜けたら、渡された `state0` が弧自身の `state0`(生成時に決まり、以後動かない)と同一参照かどうか
  だけで判定する(ノードを置いた後の区間の通常のフレーム)。作り直し・再利用のどちらでも
  `requiredEnd`/`retainFrom` を毎フレーム書き直すだけで、実際に伸ばす(積分する)のは後段の
  `predictor.update` の予算パス — ノード設置・Δv編集の直後でも同期的な積分スパイクは起きず、
  線は数フレームかけて予算ぶんずつ伸びる。マップモード中でも大半のフレームは `represents` が真で
  `requiredEnd`/`retainFrom` の書き換えと `line.syncTransform()`(O(1) の剛体変換)だけで済む。
- **過去 state の記録・prevState の更新は `physics/dynamic-trajectory.ts` の `DynamicTrajectory`(`GameEntity.actual`)の
  `step`/`reset` が行う**ので、この木には独立ノードとして現れない。`entity.stepActual()` /
  `contactPhysics.resolveSubstep()`/`resolveBelt()` の解決結果書き戻し / 反動など、state へ代入する
  すべての経路が記録契機になる(前者は `actual.step` 経由、後者は `actual.reset`
  経由)。`game/simulation/contact.ts` の掃引接触判定と `targeter.updateBoardMarks()` が読む
  「直前サブステップ位置」(`entity.prevState.r`)は先端を含む保持サンプル列とは別フィールドなので、
  `historyDuration = 0` の弾でも常に供給される。
- **`TouchControls` は per-frame の update を持たない**。DOM の pointer イベントから
  `input.setVirtualKey()` を呼ぶだけで、per-frame の接点は `game.sync` からの
  `syncModeButtons()`(トグル点灯)だけ。
- **`Ephemeris` は per-frame の状態更新は持たないが、時刻 `t` 完全一致キーの3スロットのリング
  キャッシュを3系統(`planetHelioState`/`satelliteRelState`/`attractorsAt`)
  持つ**。キャッシュは厳密一致でしかヒットしないため、呼び出し順序に依存性はない(「直前ルック
  アップ」方式の単一メモと違い、どの順で呼んでもヒットする箇所は必ずヒットする) — 各所が
  `stateOf`/`positionOf`/`attractorsAt` などを呼ぶたび、ヒットしなければ
  恒星→惑星-衛星系重心→惑星/衛星の合成をゼロから評価する。`attractorsAt` は
  同一 `t` に対して同一の配列参照を返すため、呼び出し側は返り値やその要素を書き換えてはならない。
- **積分器へ実際に渡す重力源配列は、`Simulator.substep` だけが独自に合流(`gravityBodiesAt` の
  解析天体 + 生存中の重力天体)→ `classifyAttractors` を行い、`game/simulation/predicted-arc.ts` の
  `PredictedArc.step`(GameEntity の予測列・計画区間の own な弧のどちらもこの1本を通る)は
  `game/simulation/future-attractors.ts` の
  `FutureAttractors`(Game が生成し `Predictor`/`PlanEditor` が参照を共有)へ問い合わせて
  `.classified` を受け取る。2経路とも最後は `attractorsNearInto`(問い合わせ位置の27近傍グリッド)
  で絞る。**
  `Simulator`/`PredictedArc`(`excludeId` が渡っていれば)はここへ積分対象自身の id を渡して除く —
  重力を持つ `GameEntity`(`Asteroid`)が自分自身を引く項を作らないため。計画区間の own な弧が
  積分するのは常に `mu=0` の自機なので、この除外は渡らない(`excludeId` 省略)。
  `substep` はサブステップ中点で1回だけ合流・分類し、その結果をそのサブステップの全エンティティへ
  使い回す(処理順に依存した誤差を避けるため)。`Predictor` は各対象ごと、伸長する歩の中点時刻
  (`tip.t + dt/2`)で `FutureAttractors.at(...).classified` を1回だけ読む — 積分に渡す重力源は
  ここでしか決まらない。中心天体と刻み幅 `dt` を決める窓は別物で、最初の1歩だけ予測先端そのものの
  時刻(`tip.t`)で `FutureAttractors.at(tip.t).gravity` を分類なしのまま `strongestAttractor` へ
  渡し(`excludeId` で自分自身だけ除く。1点しか問い合わせないので分類の元が取れない)、2歩目以降は
  前の歩で解決した中点窓の `.gravity` をそのまま持ち越す(半歩ぶん古いが、そこから決まるのは `dt`
  と外挿の中心天体だけなので許容する)。`FutureAttractors.at` は引くたびに他の重力天体を引き直す
  (その時刻に届いていない天体は先端からの二体ケプラー外挿(`GameEntity.displayState` の
  `ephemeris` 引数)で継ぐ — 現在位置に凍結すると「その時刻に居ない場所」から引くことになるため。
  外挿もできない天体だけ落ちる)。`at(t)` は解決結果を保持せず毎回組むが、解析天体の窓は1回だけ
  引いて衝突体と重力源の両方をそこから組むので、同じ時刻の天体位置を二度計算することはない。
  返した配列は呼び出し側(弧の持ち越し窓)がフレームを跨いで保持してよく、書き換えない契約。
  3経路とも `Ephemeris` の窓を直接書き換えず、常に新しい配列へ展開する。
- **HUD マーカーは持ち主の `sync` が自分で出す**。`MarkerManager` が own するのは、1つの対象では
  決められない2集合(`combatMarkers` = 画面上のまとめ、`leadMarkers` = 自機と敵の両方に依存)だけで、
  どちらも `game.sync` から直接は呼ばれない — `targeter.syncTargetMarkers` が自機・敵の対象集合
  (`entities.getCombatTargets`)を組んでから呼ぶ。赤道交点(EqAN/EqDN)は対象ごとに1つなので
  各 `GameEntity.equatorNodes` が持ち、`entities.syncEquatorNodes` が `all()` を回して出す。
  残りのマーカーは `player.syncPlayer` / `targeter.sync` / `navTarget.sync` /
  `activeStage.sync` / `cameraSystem.sync` / `editor.sync`(→ `planDisplay`) / `guide.sync` の中にある。
  **`markerManager.resolveCollisions()` だけは全マーカーが出揃った後に一度だけ**呼ぶ必要があるため
  `game.sync` の末尾に置く。
- **`mapPickables.refresh()` は `game.sync` ではなく `game.update` の中、
  `cameraSystem.update` の直後(物理積分の後)に呼ぶ**。積分前に組むと、被選択物や navTarget の
  AN/DN の座標が、同じフレームで `sync` されるメッシュに対して1ステップぶん古くなる(ワープ倍率が
  高いほど無視できない)。カメラ更新の前に組むと、候補集合と一緒に確定する `MapVisibilityPolicy`
  (表示天体の集合と遮蔽)が1フレーム古いカメラ位置基準になり、フォーカスを移した直後の1フレームで
  描かれる対象と選べる対象がずれる。フォーカス解決(`overviewCamera.update`)も右クリック判定
  (`mapActions.handleRightClick`)もどちらも `update` フェーズの仕事なので、`sync` を待つ必要はない。
  天体ラベル(`focusMarkers`)と AN/DN(`navTarget`)、EqAN/EqDN(各エンティティの `equatorNodes` —
  出す対象を選ぶ側がそれぞれ `update` を呼ぶ: 操作艦は `editor.update`、戦闘ターゲットは
  `targeter.updateEquatorNodes`、基地は `entities.updateBaseEquatorNodes`、航法ターゲットは
  `navTarget.update`)の座標も候補列の一部なので、
  `refresh()` の先頭で両方を求め直す。`sync` 側(`focusMarkers.syncLabels` / `navTarget.sync`)は
  その値をマーカーへ置くだけで、座標を求め直さない。
- **`environment.update(displayTime, cameraSystem.overviewMode)` は `game.update` の中の
  `editor.update` より前、毎フレーム1回呼ぶ**。小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・
  散乱円盤の点群(`PointFieldView`)の位置を群ごとにラウンドロビンで再評価するだけで、
  `mapPickables.pickables` には一切寄与しない(点群はピック対象でも重力源でもない表示専用)。
  `!overviewMode` では即 return するので、コンバットビューでは実質無視できるコスト。`sync` 側は
  `environment.sync` の中で `pointFieldView.sync` を呼ぶ——`update` が引き直した点も引き直して
  いない点も含め、浮動原点の移動ぶんだけ全インスタンス行列を毎フレーム書き直す。
- **`game.sync` は `dt` を受け取らない**。sync フェーズには進めるものが無い、というルールを
  シグネチャで見えるようにしてある。HUD パネルの書き換え間引きのような表示側の周期は
  `performance.now()` の期限で持つ。
