# CALLSTACK — per-frame 呼び出し依存木

`main.ts` の `requestAnimationFrame` ループが毎フレーム `game.update(dt)` → `game.sync()` →
`game.render()` の順に呼ぶところを起点に、そこから辿れる **副作用のある** 呼び出しを木構造にまとめた
もの。**「いま何がどの順で走るか」の一次情報**であり、責務の置き場所を検討するための地図として使う。

## 読み方

- 原則として、per frame にちょうど一度だけ呼ばれるものを列挙する。
- 条件分岐で 0 回になり得る呼び出しには `// 条件` を付ける。条件が無いものは毎フレーム必ず1回。
- 値を計算して返すだけの純粋関数(副作用なし)は省略する。引数も省略する(呼び出し順だけを追う)。
- ループで複数回呼ばれるものは `// …ごと` と書く。
- 名前は `update`(論理更新)/ `sync`(既存メッシュ・DOM への反映)/ `render`(renderer.render の呼び出し)
  / `build`(生成)の規約に従う(CLAUDE.md 参照)。ここでの三大分岐もその区切りに対応する。

## 更新義務

`src/` を変更したらこの文書も同じ変更セットで更新する(`.claude/skills/develop-docs/SKILL.md`)。
全面再生成が必要な場合も同スキルに手順とプロンプトがある。

---

## main.ts / rAF ループ

- animate(now)
  - game.update(dt) // dt = 実経過秒。game 側で 0.1s に clamp される
  - autoSave.update(game) // 前回撮影から AUTOSAVE_INTERVAL_REAL_SEC(実時間60秒)経っていれば snapshotService.capture(game, 'auto', null, false) // game.isPaused または !activeStage.isPlaying なら何も撮らない
  - game.sync()
  - game.render()
  - perf.record() // 負荷確認ウィンドウが開いている間(perf.on)だけ。500ms ごとに Game.perfCounts() を読んで PropertyWindow の行へ流す

---

## game.update(dtRaw)

- game.update(dtRaw)
  - input.update() // pending キュー(キー/クリック/マウス)を今フレーム分に確定し、次フレーム用にクリア
  - handleInput() // 担当モジュールへ先着順に配る。処理した側が input からそのキーを消費する
    - docking.handleInput() // ドック表示中の [ESC] を先に消費する(設定画面と二重に効かせない)
    - [saveBrowser?.visible] input.takeKey(K.pauseMenu) → saveBrowser.close() // 一覧の [Esc] を設定メニューより先に取る(close() 自身が game.resume() する)
    - settingsPanel.handleInput() // K.pauseMenu → toggle() → onSettingsOpenChange → game.pause()/resume()
    - hud.handleInput() // K.help → toggleHelp()
    - activeStage.handleInput() // K.restart。isPlaying なら素通し(Player の装填へ回る)
      - restart() → location.replace(`?stage=<id>`) // 決着後のみ。同じステージで出撃し直す
    - simSpeedManager.handleInput()
      - shift(-1|+1) // K.warpSlower / K.warpFaster
        - cancelAutoWarp() // 常に(手動シフトは自動ワープを解除する)
        - sfx.warp() + hud.hint() // 上限/下限を超えない場合のみ
      - toggleAutoWarpToFirstNode() // K.autoWarpToNode。editor.editMode 中は受け取らない
        - hud.hint() // ノード無し or !isPlaying
        - cancelAutoWarp() + hud.hint() // 既に自動ワープ中
        - startAutoWarpTo() + hud.hint() // 未開始
    - viewManager.handleInput() // ビュー遷移はすべて setView() を通る
      - setView('combat') // !isPlaying のみ(死亡/終了時にドック・マップを強制的に閉じる)
      - [current==='dock'] 何もせず return // [M] は消費もしない
      - setView(current==='map' ? 'combat' : 'map') // [M]。canToggleView かつ isPlaying のみ
        - [出るビューが dock] docking.leaveDock() → dockView.close() + game.resume()
        - [3D 側ビューが map→他] editor.onMapClosed() / editor.closeMenu() / mapPicker.close()
          - onMapClosed: hidePanel / hideGizmo / plan.removeNode(末尾の Δv 微小ノードを間引く) / selectedNodeIdx=null
          - mapPicker.close(): menu.close() / 開いている全プロパティウィンドウを closeWindow()(クリップ済みも含め全て)
        - [3D 側ビューが 他→map] editor.selectedNodeIdx = null
        - [入るビューが dock] docking.enterDock() → game.pause() + dockView.open(activeBase)
        - applyChrome() // map-mode/dock-mode クラス・navball 配置・touchControls・
                        // cameraSystem.overviewMode・editor.editMode・displayTimeManager.forceCurrent を一斉に揃える
        - hud.hint()
    - editor.handleInput()
      - clearPlanByKey() // K.deleteNode
        - [editMode] deleteSelected() → deleteNode()
          - plan.removeNode() / closeMenu() / simSpeedManager.cancelAutoWarp() / hud.hint() // 下流ノードも一緒に消える
        - [!editMode] plan.clear() + simSpeedManager.cancelAutoWarp() + hud.hint() // ノードがある場合のみ
    - [K.clipSnapshot] [!activeStage.isPlaying] hud.hint() // 決着後は拒否。それ以外は snapshotService.capture(this, 'manual', null, true) + hud.hint()
    - [K.openSnapshots] saveBrowser の open()/close() をトグル // open() が game.pause()、close() が game.resume() を呼ぶ
  - [game.isPaused] 以降を実行せず return するポーズ経路 // 決着後の簡略経路より前。ポーズ中は決着後も完全に止まる
    - _window = resolveWindow() // displayTimeManager.window(simTime, currentOrbitPeriod())。4経路(ポーズ/未配置/簡略/通常)それぞれの先頭で1回ずつ確定し、以降このフレームの update フェーズ全体で共有する。以下 displayTime は _window.displayTime を指す
    - environment.update(displayTime, cameraSystem.overviewMode) // 小惑星帯・トロヤ群点群の位置再評価。updateMapPresentation の先頭、editor.update より前(4経路共通)
    - planProvider = planAttractorProvider(ephemeris, entities, excludedIds, planSourceRevision(..., editor.plan.revision, editor.lastPlanEnd, simTime)) // editor.update より前に組む。今フレームの計画終端は editor.update がこれから決めるので、revision の量子化は前フレームの終端(PlanPath.timeRange().max)を基準にする
    - editor.update(simTime, displayTime, planProvider) // 計画折れ線の再積分とアプシスアイコン(mapPicker.refresh より前)。planProvider.revision が前回と同じで起点・終端・基準天体も動いていない区間は再積分せず前回の積分結果を使う
    - equatorNodeMarkers.update(equatorNodeSources(), planDisplay.planFrame, displayTime) // 操作艦(計画があれば最終区間起点)・navTarget・targeter・生存中の全基地の対象を id で重複除去して EqAN/EqDN を求め直す。mapPicker.refresh より前(候補列に畳み込むため)
    - attractors = mergeAttractors(ephemeris.attractorsAt(simTime), entities.attractors()) // updateMapPresentation(4経路共通)の1回だけ求め、mapPicker.refresh の遮蔽判定・cameraSystem.update の frameTransformAt へ配る
    - mapPicker.refresh() // このフレームの MapVisibilityPolicy を1つ組み(visibility getter で sync フェーズへ渡す)、天体ラベルと AN/DN を求め直してからそれを通した被選択物一覧を組む
      - focusMarkers.update(displayTime, overviewCamera.focus, cameraSystem.bodyClassToggles, activeCameraPos) // MapVisibilityPolicy が admits しない天体は座標計算ごと飛ばす // 地球・月・太陽・両系のラグランジュ点の座標を表示時刻で求め直す
      - navTarget.update() // 自機軌道要素 + navTarget.id から相対 AN/DN を求め直す。ポーズ・決着に関わらず毎フレーム
      - mapPicker.pickables に反映 // 天体ラベル + 生存中の entities.players('player')・敵船('ship')(displayState 基準)+ navTarget.mapPickables() + planDisplay.apsisMarkers + equatorNodeMarkers.mapPickables() を集約 → [overviewMode] isOccluded(cameraSystem.activeCameraPos, item.pos, ephemeris.attractorsAt(simTime)) で天体に遮蔽された候補を除外
    - [editor.editMode] mapPicker.handleRightClick() / mapPicker.handleLeftClick() // 自機・基地マーカーへの左クリックを選択として消費、外れれば下流へ / mapPicker.handleDoubleClick() // pickables 全種別への最寄りダブルクリックでフォーカス移動 / editor.handleMapPointer() // [!hasPlan(=ship===null)] 内部で即 return(艦のいない detachedPlan は編集させない) / editor.updateEditing()
    - cameraSystem.update(..., mapPicker.pickables, attractors) // ポーズ中も視点更新は続ける
  - [game.player === null] 以降を実行せず return する未配置経路 // Creative の開始直後・全艦喪失時。残骸や弾の epoch は進め続ける
    - _window = resolveWindow() // 内容は上記ポーズ経路と同じ
    - simSpeedManager.update() / applyWarpCommandPolicy()
    - simulator.advance(player=null)
    - predictor.update(player=null)
    - activeStage.update(player=null) // Creative の配置プレビュー・フォームのフィールド検証結果はここで求め直す(艦が無い間こそ配置中なので飛ばせない)
    - effects.update(dt, simulator.simTime)
    - environment.update() / editor.update() / equatorNodeMarkers.update() / attractors 算出 / mapPicker.refresh() / cameraSystem.update() // 内容は上記ポーズ経路と同じ
    - [editor.editMode] mapPicker.handleRightClick() / mapPicker.handleLeftClick() / mapPicker.handleDoubleClick() / editor.handleMapPointer() / editor.updateEditing()
  - [!activeStage.isPlaying] 以降を実行せず return する簡略経路
    - _window = resolveWindow() // 内容は上記ポーズ経路と同じ
    - player.thrust = null / player.torque = v3() // 勝敗確定時の推力を凍結させない
    - simulator.advance(resolveCollision=false, doSubstep=false) // simSpeed は ×MAX_PHYS_SIM_SPEED で打ち止め
      - substep() ×1 → entity.stepActual() エンティティごと
      - stepAttitudes()
      - [entities.players ごと] p.stepEnvironment() // 熱・電力・ラジエータの受動状態
    - nanWatchdog.checkAll('advance(決着後)') // 通常経路と同じく積分の直後に一度
    - entities.cleanup() // 決着後もワープで時間は進むので、通常経路と同じ位置で回収する
      // Enemy.checkLoss/Player.checkLoss 経由で recordEnemyDeath/recordPlayerLost が走り得るが、
      // 両方とも isPlaying でガードされているので決着後に既存の phase を上書きすることはない
    - effects.update(dt, simulator.simTime) // 決着直後の爆発を止めないため、簡略経路でも寿命を進める
    - environment.update() // 内容は上記ポーズ経路と同じ
    - editor.update(simTime, displayTime) // 内容は上記ポーズ経路と同じ
    - equatorNodeMarkers.update() // 内容は上記ポーズ経路と同じ
    - mapPicker.refresh() // 内容は上記ポーズ経路と同じ
    - cameraSystem.update(..., mapPicker.pickables, attractors) // 決着後も追従を続ける(sync は止まらないため、飛ばすと視点が絶対 ECI に取り残される)
  - nanWatchdog.checkPlayer('frameStart') // 検出済みなら何もしない
  - player.behave()
    - belt.update()
      - physics.shiftBeltNodes() // リロードで給弾量が巻き戻ったフレームのみ
      - physics.update()
        - initNodesOnce() // 初回のみ
        - estimateAngularAccel() / integrateVerlet() / pinRootToAnchor() / relaxDistanceConstraints()
        - advanceOrientationConstraints() // リンクごとに角度クランプ・ツイスト更新
    - handleEdgeInput() → handleEdgePress() // 処理したキーは input.consumeKey() で消費する
      - throttle.toggleRcsDamp() // K.rcsDampToggle
      - throttle.enableProgradeReset() // K.progradeReset
      - toggleFineAttitude() // K.fineAttitudeToggle
      - throttle.toggleProgradeHold() // K.progradeHoldToggle
      - throttle.setThrottlePreset(0|1|2) // K.throttleLow/Mid/High
      - fire.manualReload() // K.reload。成功時のみ true(= キー消費)
        - sfx.playReload() + dropBarrel() → fx.spawnBarrel()
    - throttle.updateTorque() → player.torque へ代入。!alive なら即ゼロ(マップビュー中も手動回転は常時有効)
      - onProgradeHoldReleased() → hud.hint() // ホールド中に手動回転入力があった場合のみ
      - autoAlignTorque() // ホールド中 かつ 手動回転入力なしの場合のみ
    - radiator.update() // 展開度のみ。THREE には触れない
    - sunlitFactor() // 地球影による日照率
    - thermal.setRadiatorLoad(radiator.radiatingArea(), radiator.solarLoad())
      // このフレームの全サブステップの updateThermal がこの値を使う
    - power.update() // sunlit/sunDir は radiator と共有。THREE には触れない
    - [!player.alive] player.thrust = null、throttle.stopThrust() して return
    - hpRegen()
    - [editor.editMode] fire.tickMapMode() → tickReloadTimer() // マップビュー中は発射不可(装填タイマーのみ進める)
    - [!editor.editMode] fire.updateFireState()
      - tickReloadTimer()
      - hud.hint() // 発射キー押下中 かつ !simSpeed.canPlayerFire
      - sfx.emptyClick() + hud.hint() // 弾切れの初回フレームのみ
      - fireCycle() // 発射キー押下 かつ canPlayerFire かつ残弾ありの場合のみ
        - sfx.spinUp() // 発射開始フレームのみ(このフレームは fireGun まで進まない)
        - consume() // 弾薬状態の更新。戻り値で以下の分岐が決まる
        - fireGun() // クールダウン明けのみ
          - spawnBullet() → entities.addBullet()
          - player.state.v に反動 Δv
          - dropCasing() → fx.spawnCasing()
          - spawnMuzzleFlash() → fx.spawnFlash()
          - scoreCounter.recordShot()
          - sfx.fire()
        - spawnEjectedMagazineFrame() + sfx.magFeed() // 'mag-reload'
        - spawnEjectedMagazineFrame() + dropBarrel() + sfx.playReload() // 'barrel-reload'
    - [dvEditActive(= editor.editMode かつ editor.selectedNodeIdx !== null)] player.thrust = null、throttle.stopThrust() して return // ノードのΔv編集中はWASDQEをそちらへ譲る。噴射音・プルームは syncPlayer 側の thrustEffects.sync が player.thrust=null を見て自分で止める
    - [simSpeed.canPlayerThrust] throttle.updateThrustLatches() // WASDQE各キーの連打をエッジ検出しラッチ集合を更新。反対方向キーを押している間は相手側のラッチも解除し続ける。canPlayerThrust が false の間は呼ばれず、押下エッジも消費されない
    - throttle.updateThrustState() → player.thrust へ代入(手動入力が無ければ null。'powered' 中の艦がここで null になっても、後段の activeStage.update → planExecutor.update が Simulator.advance より前に正しい値へ上書きするので積分には影響しない)
      - throttle.stopThrust() // 推力入力なし(物理押下・ラッチとも無し) or !canPlayerThrust。thrustAccelVec(ベルト物理向け)を戻すだけ
    - invalidatePrediction() // player.thrust !== null のときのみ(自機の噴射結果を即座に予測へ反映)
    - [planExecution==='powered'] thrust!==null または throttle.hasManualRotationInput() なら planExecution='off' // 操作対象艦の手動並進・手動回転で自動実行を中断(マップモードかどうかは問わない)
  - nanWatchdog.checkPlayer('player.behave')
  - activeStage.update() // 具体ステージへディスパッチ。!isPlaying / 艦が無ければ即 return
    - behaveAllEnemies() // 敵を配置する具体ステージ(Stage0/00/1/2)が先頭で呼ぶ
      - enemy.behave() // 生存中の敵ごと(canEnemyFire・距離・バースト状態の判定は behave 内部)
        - firePlasma() → entities.addBullet()
    - [Stage0 訓練スコアアタック] logistics.updateLogistics(simSpeed, respawnOnDespawn=false)
    - [Stage0 訓練スコアアタック] timer.update()
      - setPhase('timeup') + showScoreAttackResultScreen() // 制限時間到達フレームのみ
    - [Stage00 無限サバイバル] logistics.updateLogistics(simSpeed, respawnOnDespawn=true)
      - absorbNearbyAmmo() // player.alive のみ
        - player.onPickup() + sfx.pickup() + hud.hint() // 範囲内の補給ごと
      - despawnFarAmmo() // 消滅そのものは投入可否によらず常に走る
        - spawnForPlayer() // 遠方消滅した数だけ再投入。投入可(resupplyEnabled かつ canResupplyAmmo)のときだけ。生存数が MAX_AMMO に達したら打ち切る
      - spawnForPlayer() // 投入可のとき、LOGISTICS_CHECK_INTERVAL ごと、かつ低弾薬・上限未満のみ。投入不可の間は次回判定時刻を進めない
    - [Stage00 無限サバイバル] updateWaitingForAmmoPhase() → hud.toast() // 弾薬確保でフェーズ遷移した時のみ
    - [Stage00 無限サバイバル] updateSpawningEnemiesPhase() → spawnWave() // カウントダウン満了時のみ
    - [Stage00 無限サバイバル] updateActiveCombatPhase()
      - despawnOutOfRangeEnemies() → enemy.despawn() // 圏外の敵ごと(alive=false + recordEnemyDeath(cause='despawn'))
      - spawnWave() + hud.toast() // 間隔・同時展開上限を満たす場合のみ
      - spawnWave: generateWave() → addEnemy() → entities.addEnemy() + scoreCounter.recordSpawnEnemy()
        - generateWave: pickWaveCenter() → makeFlybyVelocity() → limitFlybyDv() → waveShipPosition() ×機数
    - [Stage1 / Stage2 キャンペーン] logistics.updateLogistics(simSpeed, respawnOnDespawn=false)
    - [CreativeStage] placerPanel.isOpen なら getForm() を1回だけ呼び、computePreview(form)/computeFieldIssues(form) へ共有する
    - [CreativeStage] entities.players ごとに ship.planExecutor.update(ship, dt, simTime, simSpeed) // planExecution!=='powered' なら idle へ戻すだけ。'powered' なら姿勢整列(idle/slew/armed)、または燃焼中(burn/trim)の出力段選択・燃料消費・ship.thrust の書き直しを進める。ノード時刻に対する猶予窓(NODE_APPROACH_LEAD+見積り燃焼時間+見積り姿勢転回時間)を外れている間は何もしない。死亡していれば停止。点火・遮断そのものはここでは行わない。Simulator.advance より前に呼ばれるので、操作艦で player.behave がこのフレーム player.thrust を null にしていても、積分に渡る前にここで確実に上書きされる
  - nanWatchdog.checkPlayer('activeStage.update')
  - simSpeedManager.update() // 自動ワープ中のみ実効。残り時間が C.NODE_APPROACH_LEAD 以下なら autoWarpUntil=null + levelIdx=0 で即 return
  - simulator.advance(resolveCollision=canResolvePhysicalCollisions, doSubstep=true)
    // 弾命中を含む剛体接触・姿勢積分はいずれもこの中。simulator が contactPhysics(ContactPhysics)を所有する。
    // 弾も薬莢もデブリも天体も同じ ContactPhysics を通る一本の経路
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
        - entity.stepActual(dt, attractorsNear(entity.state.r, classified)) → actualTrajectory.step() → stepDynamics()(history 記録)
          // 自機(全隻)・敵・弾・薬莢・デブリ・補給・基地・小惑星それぞれ、個体ごと。alive のみ実行。attractorsNear は always + 自身の位置の27近傍グリッドを合わせたもの。それらの重力 + J2 + 大気抵抗(bcInv)+ 自身の thrust
      - nanWatchdog.checkPlayer('simulator.advance(軌道積分)')
      - stepAttitudes(subDt) → stepAttitude() → entity.att へ代入 // 自機・敵・薬莢・デブリ・補給すべて同じ subDt で一律に積分する
      - nanWatchdog.checkPlayer('simulator.advance(姿勢積分)')
      - [entities.players ごと] p.stepEnvironment(subDt, ephemeris, simTime) // 熱・電力・ラジエータの受動状態
      - [resolveCollision のみ] contactPhysics.resolveSubstep(simTime, [...entities.all(), ...radiatorFolds], attractorsNow, activeStage)
        // radiatorFolds = entities.players のうち alive なものの p.collisionFolds(simTime)(艦の姿勢・展開度から毎 substep 置き直す放熱板の接触代理)
        - isFiniteParticipant() / isFiniteAttractor() でエンティティ・天体を有限値のものだけへ絞る // 空間グリッドへ入れる前に落とす(NaN セル添字を防ぐ主たるガード)
        - resolveInOrder() // 1 substep 内で TOI 昇順に最大 CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP 件解決。超過分は次回へ持ち越し
          - SpatialGrid 構築(1回、以後の反復で使い回す) // セル一辺 = 2×(参加者中の最大半径+最大移動量)、または CONTACT_GRID_CELL_SIZE_FLOOR
          - earliestContact() // 27近傍のエンティティ間ペア + 全 attacker×天体ペアから、双方の contactsWith が true かつ未解決のものだけを候補にし、resolveSphereCollision(collision-response.ts)を通して TOI 最小の1件を選ぶ
          - applyCandidate() → 双方(または片側、相手が天体の場合)の working state へ代入
            - [impulse > 0 のときだけ] a.collideWith(b, contact, activeStage) と b.collideWith(a, contact, activeStage) を順不同で呼ぶ // Contact は解決前の状態を保持するので呼び出し順に依らない
              - [Bullet.collideWith] alive = false // 相手への作用は相手側の collideWith が書く
              - [Ship(Player/Enemy).collideWith] other instanceof Bullet なら attackedByBullet()、それ以外なら applyCollisionDamage(contact.impulse / mass)
                - attackedByBullet(): applyDamageToParts(bullet.damage) → hp>0 なら impactEffect()(sfx.hit + fx.spawnPlasmaFlash/spawnBulletFlash + spawnGasPuff)、hp<=0 なら destroyEffect() + activeStage.recordEnemyDeath(cause='killed')/recordPlayerLost()
                  - [Enemy] destroyEffect() 前に scoreCounter.recordHit()(被弾のたび)
                  - [Player] thermal.addImpactHeat() は被弾のたび常に。radiator パーツへのダメージ時は radiatorBreakEffect()(全損した瞬間のみ)
                - applyCollisionDamage(): Δv=impulse/mass を COLLISION_DAMAGE_MIN_DV〜FULL_DV で maxHp へ線形マップし applyDamageToParts → hp>0 なら sfx.clank()+fx.spawnGasPuff()、hp<=0 なら destroyEffect() + recordEnemyDeath/recordPlayerLost()
              - [RadiatorFold.collideWith] owner.collideAtRadiator(side, other, contact, activeStage) へ委譲(パーツの割り振り先が side に固定される点だけが Ship.collideWith との違い)
              - [DebrisPiece.collideWith] other instanceof Bullet なら fx.spawnGasPuff()(弾自身の消滅は Bullet.collideWith)。kind==='casing' かつ相手が Player なら sfx.clank()
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
  - _window = resolveWindow() // simulator.advance 直後、predictor.update より前 — このフレームの表示時刻一式を積分後の状態で確定し、以降 update フェーズ全体(predictor/updateMapPresentation)で共有する
  - nanWatchdog.checkAll('simulator.advance') // 全エンティティ走査。検出済みなら何もしない
  - targeter.updateBoardMarks(dt) // 既存マークの経過時間を進め、寿命切れを捨てる。ターゲットが居なければ全消し
    - boardMarks.push() // 通常弾が的の面を自機側から通過した場合のみ
  - [CreativeStage] 撃沈艦を players から除去 → removeCreativePlayer() // 生存 0 隻ならアクティブ艦を差し替え/マップを開く
  - [viewManager.current !== 'dock' && entities.bases.length > 0] docking.checkProximity() // 全 base × 全生存艦。距離・相対速度が閾値内の艦を収容(EntityManager.parkPlayer で破棄せず除去)
  - entities.cleanup() // simulator.simTime・自機位置(弾は距離で消える)・ephemeris.attractorsAt(simTime)(表面到達判定)を渡す
    - checkLoss() // 敵・弾・薬莢・デブリ・補給・自機(全隻、この順)の各個体ごと(既定は alive=false 代入のみ)
      - [Enemy.checkLoss] destroyEffect() + activeStage.recordEnemyDeath(cause='reentry') // 再突入時のみ
        - scoreCounter.recordEnemyLoss() + hud.hint()
        - unlockManager.reportClear() + onWin() // 撃破と同じく checkWin() が true になった場合のみ
          // (最後の1機が自然損耗で消えた場合もここで決着する)
      - [Player.checkLoss] !alive なら即 return
        - thermal.updateAltitudeAlarm()
          - hud.hint() + sfx.altAlarm() // 高度しきい値を新規に下回ったときのみ
          - checkThermalLimits() → hud.hint() // 熱/動圧が危険域に入った初回のみ
        - destroyEffect() → sfx.explosion() + fx.spawnShipDestroyEffect() // 限界超過 or 高度不足のみ
        - activeStage.recordPlayerLost() // 同上
    - prune() ×5 → entity.dispose() // alive=false の個体ごと(scene から除去、必要なら geometry も破棄)。players は寿命判定のみで prune の対象外(喪失艦も配列に残り続ける)
  - predictor.update(simTime, player, horizon, mode) // cleanup の後(死んだ個体を予測しない・積分後の実状態と突き合わせる)。horizon = _window.duration(update 冒頭で確定済みの window から読むだけ、ここで currentOrbitPeriod() を呼び直すことはない)。mode は 'map'(entities.all() 全対象・PREDICT_STEP_BUDGET)/'combat'(自機のみ・PREDICT_COMBAT_STEP_BUDGET)
    - discardPredictionIfDiverged(simTime, attractors) // entities.all() のうち predictsFuture=true の対象のみ、毎フレーム無条件。attractors は simTime ぶんを1回だけ classifyAttractors し、対象ごとに attractorsNearInto でその位置の近傍へ絞ったもの(advanceBudget とは別のスクラッチ配列)
      - invalidatePrediction() // predicted.at(simTime) が実位置から許容量を超えて乖離、または区間外のときのみ。許容量は PREDICT_RESET_DIST を下限に、保持サンプルの間引きが粗いぶんの補間誤差まで広げる
    - advanceBudget(player, ...) // 予算 PREDICT_STEP_BUDGET を操作対象の艦優先で消費。ループごとに predictedAttractorsAt(ephemeris, entities, tip.t)(先端の時刻 tip.t で他の重力天体の displayState(tip.t) を引き直す — まだその時刻に達していない天体はその回だけ落とす)→ classifyAttractors → attractorsNear で重力源を決め、dt(localOrbitPeriod / PREDICT_STEPS_PER_REV、horizon / PREDICT_MAX_STEPS で下限、horizon そのもので上限)も Predictor 側が持つ(stepActual に対する substep と同じ分担)。predictsFuture=false の個体は消費 0 で即 return
      - player.stepPredicted(attractors, simTime, dt, horizon) // ホライズン超過・打ち切り済み・推力中のいずれかで false を返すまで、dt・attractors を都度計算し直しながら1ステップずつ繰り返し呼ぶ
        - predictedTrajectory.step() // 呼び出し側が確定させた attractors で1ステップ積分
    - advanceBudget(entity, ...) // 残り予算を entities.all() 上のカーソル位置から1周ぶん配る(player は優先枠で処理済みなのでここでは飛ばす)。1体の取り分は max(PREDICT_MIN_ENTITY_STEPS, floor(残額 / 残り訪問数)) を残額で頭打ちにした値で、使い残しは次の個体へ回る。entity.stepPredicted() が最初から false(predictsFuture=false/推力中/truncated)なら消費 0 で次へ即進む
  - effects.update(dt, simulator.simTime) → flashEffectManager.updateFlashEffects() // フラッシュの寿命と、各エフェクトの時刻から simTime までの移流。ポーズ中は呼ばれない(=止まる)
  - guide.update(plan, player, simTime, editMode, ephemeris.attractorsAt(simTime)) // trackAnchor より前に置く: 最後のノードが落ちたフレームからアンカーを自機へ追従させるため
    - [editMode または !player.alive] 即 return
    - plan.consumeNodesUpTo(simTime - C.NODE_EXPIRE_GRACE, player.state) // 期限切れノードをまとめて落とし、自機の実状態を新しいアンカーに据える
    - [直近ノードが実行の窓(node.t - C.NODE_APPROACH_LEAD)に入っている場合のみ]
      - notifyApproach() → hud.hint() // ノードごとに最初の1回のみ(approachNotified との同一性比較)
      - notifyAchieved() // orbitalElementsClose(自機軌道要素, 目標軌道要素) が真の場合のみ。plan.consumeNodesUpTo(node.t, player.state) で達成ノードを消化し、残り件数は消化後の実数を読む
        - hud.hint() + sfx.warp() // ノードごとに最初の1回のみ(achievedNotified との同一性比較)
  - editor.plan.trackAnchor() // ノードが0件のときだけ実効(1件目を置くとアンカーは凍結される)
    - environment.update(displayTime, cameraSystem.overviewMode) // 小惑星帯・トロヤ群点群の位置再評価。editor.update より前
    - editor.update(simTime, displayTime) // 被選択物候補にアプシスアイコンが入るので mapPicker.refresh より前
    - planDisplay.update(plan, simTime, displayTime, show) // show = hasPlan(=ship!==null) && (editMode || plan.nodes.length > 0)
      - path.update() // plan の corners を区間へ分解し、区間ごとに PlanArc を再積分。表示座標系と un-bake 時刻もここで確定。buildSegments は末尾区間の起点時刻の天体窓を1回だけ引き、区間長(segmentDurationFrom)と基準天体(strongestAttractor → Segment.apsisCenter)の両方をそこから決める
        - arc.update() // 区間ごと。(state0, end) が変わったときだけ DynamicTrajectory で RK4 積分し直す(重い)。刻み幅ごとの重力源は classifyAttractors(mergeAttractors(gravityBodiesAt(ephemeris, t), dynamicAttractors)) → attractorsNear — 実積分・予測と同じ組み立て。dynamicAttractors は Game.update が entities.attractors() を1回だけ求めて渡す(区間長は最大1年に及び、そのあいだの位置を EntityManager には問えないので現在の実状態で固定する)。末尾区間だけ apsisCenter(区間起点の重力源スナップショット)が渡り、積分の各ステップ対で apsisCrossing による近地点/遠地点検出が走る
      - ghostAt(displayTime) // 折れ線が displayTime に届かなければ null
      - apsisIconsOf() // path.finalSegment() の periapsis/apoapsis(末尾 arc が積分中に見つけた値)と apsisCenter(検出時と同じ基準天体)を読み、その天体の位置だけを ephemeris.positionOf(center.id, 極値の時刻) で引き直して距離を出す。両方あるとき (遠地点距離-近地点距離)/(遠地点距離+近地点距離) < APSIS_MIN_ECC なら空、片方のみ(双曲線等)ならそのまま出す
  - equatorNodeMarkers.update(equatorNodeSources(), planDisplay.planFrame, displayTime) // editor.update の後・mapPicker.refresh の前
  - mapPicker.refresh() // 物理積分の後に組む — 積分前だと同フレームで sync されるメッシュと被選択物の座標が1ステップずれる。MapVisibilityPolicy もここで1つだけ組み、sync フェーズは mapPicker.visibility を読むだけ
    - focusMarkers.update(displayTime, overviewCamera.focus, cameraSystem.bodyClassToggles, activeCameraPos) // MapVisibilityPolicy が admits しない天体は座標計算ごと飛ばす / navTarget.update() // 内容は上記ポーズ経路と同じ
  - cameraSystem.update(mapPicker.pickables, attractors) // 追従カメラの基準を積分後の自機位置に合わせるため、物理積分の後に呼ぶ
    - combatCamera.toggleFollowAttitude() // K.followAttitudeToggle。カメラ自身の状態なのでここで消費する
    - keyYaw/keyPitch/keyRoll をキー入力からまとめる // cameraRollLeft/Right は Numpad0/Numpad1
    - overviewCamera.update(..., mapPicker.pickables, attractors) // cameraSystem.overviewMode のみ。focus を mapPickables から引き直し、結果を自身の view へ書く。attractors は frameTransformAt の回転解決(登録天体/生存中の重力天体の2経路)に渡す
    - combatCamera.update() // !overviewMode のみ
      - zoomActive = K.gunsightZoom 押下 // combatCamera 自身のフィールドへ書く(overviewMode 中はこの update 自体が呼ばれないため更新されない — CameraSystem.zoomActive の !overviewMode ガードが読み替えを担保する)
      - gunsightCamera.update() // player.alive && zoomActive。結果を自身の view へ書く
      - chaseCamera.update() // それ以外。camFollowAttitude && player.alive のときだけ player.att.q を rot に合成し、鍵/ドラッグ/ロール入力を回転として適用。結果を自身の view へ書く
      - 選ばれた view.fovDeg から combatCamera 自身の view.fovDeg を指数補間
  - [editor.editMode] 計画編集モード。マーカー(handleRightClick/handleLeftClick/handleDoubleClick)→ ノード(editor.handleMapPointer)→ 空域(handleEmptySpaceRightClick)の優先順は呼び出し順そのもの — 上流が消費した右クリックは下流に届かない
    - mapPicker.handleRightClick() // マーカーへの右クリックだけを消費する。外れれば消費せず editor.handleMapPointer() のノード右クリックへ読み進む
      - pickNearest(mapPicker.pickables) // MAP_PICK_PX_SQ 以内の被選択物(天体/自機/敵船/nav-AN・DN/アプシス)を最寄りで拾う。候補列は mapPicker.refresh() が組んだ1本
      - mapPicker.openPropertyWindow() // 拾えた場合のみ消費。既にその対象のウィンドウがあれば移動+最前面化のみ、なければ new PropertyWindow(root=hud.layers.window, buildContent()) // rows は空のまま開き、同フレーム後半の mapPicker.sync() が埋める(items は windowItems() 経由で開いた瞬間から埋まる)
        - 新規かつ非クリップ → 直前の一時ウィンドウ(tempWindowKey)を closeWindow() してから差し替え
        - w.onSelect(act) → handlers[target.kind].run(act, target) // 選択結果はこれまでと同じ経路
          - act='delete' または !w.clipped → closeWindow() // 削除はクリップ有無によらず閉じる
        - w.onClipChange(clipped) → clipped なら tempWindowKey をこのキーから外し、非clip化なら既存の tempWindowKey を closeWindow() してこのキーに差し替え
        - w.onOutsideClick → !w.clipped のときだけ closeWindow()
        - w.onClose(✕ボタン、widget 側で dispose 済み) → forgetWindow() // 台帳から外すだけ
      - 選択結果は MapPicker.run(act, target) へ
        - act='focus' → overviewCamera.focus 代入
        - act='navTarget' → navTarget.toggleTarget()
        - act='warp' → simSpeedManager.startAutoWarpTo(navTarget.passTimeOf(target.id))
        - act='addNode' → editor.addNodeAt(planDisplay.apsisTimeOf(target.id) または navTarget.passTimeOf(target.id))
        - act='activate' → entities.findPlayer(target.id) → setActivePlayer(ship) // 'player' のみ。id が現存する艦を指さなくなっていたら何もしない
          - player = ship / cameraSystem.setActivePlayer(ship) → combatCamera.setActivePlayer(ship) → chaseCamera.setPlayer(ship) // rot/dist は据え置き
          - editor.setActivePlayer(ship) → ship 差し替え / selectedNodeIdx = null / closeMenu() // 以後 editor.plan は ship.plan を指す
          - targeter.clearTargets() // 切替前の艦が握っていたロックを持ち越さない
        - act='planExecCycle' → entities.findPlayer(target.id) → ship.planExecution = nextPlanExecution(ship.planExecution) // 'player' のみ。OFF→瞬間移動→自動操縦→OFF
        - act='delete' → entities.findPlayer(target.id) → entities.removePlayer(ship) → dispose() // 'player' のみ。操作対象の艦にはこの項目自体がメニューに出ない(MapPicker.itemsFor)
    - mapPicker.handleLeftClick() // 自機/基地マーカーへの左クリックを選択として消費する。外れれば消費せず editor.handleMapPointer() のノード配置/選択解除に読み進む
      - selectPickable() // 'player' → game.setActivePlayer() / 'base' → docking.selectBase()(遷移はしない)
    - mapPicker.handleDoubleClick() // pickables 全種別への最寄りダブルクリックで overviewCamera.setFocus()
    - editor.handleMapPointer() // [!hasPlan] 即 return。右クリック → 左クリックの順に受ける
      - handleNodeRightClick() // 右クリックごと。ノードをヒットしたぶんだけ消費する
        - selectedNodeIdx = ヒットしたノードの idx + nodeGizmo.openMenu() // ヒット時。true を返して消費
      - handleMapClick() // 左クリックごと。常に消費する
        - selectedNodeIdx = idx + sfx.warp() // 既存ノードをヒットした場合
        - planDisplay.path.nearestSample() // 直近の sync でキャッシュした cameraPos/attractors で isOccluded な点を候補から除外してから最寄りを探す → plan.addNode() + sfx.warp() // 計画軌道上をヒットした場合
        - selectedNodeIdx = null // どちらにも当たらなかった場合
      - dragNodeToNearestSample() // ノードを incoming arc の最寄り点へ移し、元のΔv成分を保ったまま新しいノード状態へ焼き直す
    - mapPicker.handleEmptySpaceRightClick() // マーカーにもノードにも当たらなかった右クリックだけが届く。ContextMenu<MapPickable> で「オブジェクトリストウィンドウを表示」/(クリエイティブのみ)「オブジェクトを配置」/「設定メニューを開く」
    - editor.updateEditing()
      - applyHeldDv() ×6方向 // WASDQE または dvButtons(長押しボタン)が held の間、ホールド秒数からランプするレートで dt 秒分を積分
      - applyDv() // nodeGizmo.latch がある間、ラッチ超過量に比例したレートで dt 秒分を積分(アームドラッグが DV_DRAG_LATCH_PX を超えて入る)
  - [!editor.editMode] navTarget.updateCombatBasePicking() // targeter より先に呼ぶ。基地に当たった右クリックだけを消費し、外れは false を返して targeter へ回す
    - pickNearest(entities.bases) → baseMenu.open() // 当たった場合のみ。航法ターゲット設定/解除メニュー
  - [!editor.editMode] targeter.updateCombatTargeting()
    - handleTargetContextMenu() // player.alive のみ。右クリックは当否に関わらず消費する
      - pickEnemyAt() → openMenu() // 右クリックが敵に当たった場合、第一/第二の設定・解除メニューを開く
    // 自動選定・自動再選択はない。target/secondaryTarget はメニュー選択でのみ変わる

---

## game.sync()

- game.sync()
  - _window = resolveWindow() // sync フェーズの先頭で1回だけ。update フェーズ側で求めた値とは別に、sync フェーズ全体(displayTime を読む全消費者・displayTimeManager.sync 自身)がこの1回を共有する — currentOrbitPeriod() の呼び出しは1フレームにつき update フェーズ1回・sync フェーズ1回の計2回だけになる
  - viewBadge.sync(activeStage.selectLabel, canToggleView) // タイトル・Mode・View ドロップダウンの表示反映
  - floatingOrigin = new FloatingOrigin(cameraSystem.activeCameraPos, player.state.v) // r=アクティブカメラのECI位置(update フェーズの cameraSystem.update() で確定済み)、v=自機速度。以降の sync 系はこの fo だけを参照する
  - displayTime = _window.displayTime // 未来ゴーストのスライダーが立っている間だけ先の時刻
  - cameraSystem.sync() // 最初に呼ぶ: environment.sync とマーカー投影が今フレームのカメラ行列を読む
    - syncCameraToViewpoint(active.camera, active.viewpoint, fo) // active = overviewMode ? overviewCamera : combatCamera。両カメラの viewpoint→THREE.PerspectiveCamera 反映はここ一箇所
    - overviewCameraPanel.setVisible(overviewMode) + setBodyClassToggles(bodyClassToggles) // MAP VIEW パネル。点灯反映は overviewMode のみ
    - focusMarkers.syncLabels() → markerManager.setPosition() // ラベルごと。overviewMode のみ
    - focusMarkers.hideLabels() // !overviewMode のみ
  - project / overviewMode / simTime / attractors(= ephemeris.attractorsAt(simTime)) / target(= targeter.aliveTarget)を確定 // 以降の sync 系へ配る共通値
  - mapVisibility = overviewMode ? mapPicker.visibility : null // ここでは組まず、update フェーズの mapPicker.refresh() が確定させた同じ MapVisibilityPolicy を読む。environment.sync / activeStage.sync(→ logistics.syncMarkers・creativeStage.syncBaseMarkers)/ targeter.sync とエンティティの表示・軌道線判定がすべてこれを受け取る
  - environment.sync()
    - lit = sunlitFactor(playerPos, ephemeris.sunDirFrom(playerPos, displayTime), …)。overviewMode では 1.0 固定
    - asteroidField.sync(fo, cameraSystem.overviewMode) // !overviewMode ならメッシュを隠して return。overviewMode では update が引き直していない点も含め全インスタンス行列を書き直す(fo が毎フレーム動くため)
    - [bodies(= CELESTIAL_BODIES 登録順の CelestialBody[])ごと] body.sync(fo, displayTime, cameraSystem, ephemeris)
      - EarthBody.sync() → earth.group.position / earth.setRotation() / earth.setSunDir(ephemeris.sunDirFrom(地球の実位置, displayTime)) / earth.syncSurfaceLod(apparentSizePx(2·R_EARTH, cameraSystem.activeCameraScale(地球の実位置))) / earth.tick()
      - SunBody.sync() → billboard 位置(カメラ相対の圧縮距離)/ 広範囲視点では実位置の球体
      - SphereBody.sync()(月・海王星・準惑星等7体・彗星核2体、および pointBrightness 未指定の惑星) → overviewMode なら実 ECI 位置、!overviewMode ならカメラ相対の圧縮距離。陰影は surface.setSunDirection(ephemeris.sunDirFrom(実 ECI 位置, displayTime))。姿勢は ephemeris.poleAt(id, displayTime) が非null なら spinOrientation(axis, spinAngle) をクォータニオンへ書き込み(lookAt は使わない)、pole モデルを持たない天体は姿勢を変更しない。rings を持つ天体(木星・土星・天王星・海王星)は続けて RingView.sync() を呼ぶ
      - PointBody.sync()(pointBrightness 指定の惑星 = 金星・木星=bright、水星・火星・土星=medium、天王星=faint) → overviewMode なら SphereBody と同じ実 ECI 位置・実半径・姿勢のメッシュ(rings があれば RingView.sync() も)を表示、!overviewMode ならそのメッシュ(と環があれば RingView.group)を隠して代わりに星シェル半径(STAR_SHELL_RADIUS)上の実方向へ billboard を置く輝点表示に切り替える(常にどちらか一方だけ visible)
      - RingView.sync()(SphereBody/PointBody から rings がある天体のみ呼ばれる)→ 環グループの位置・スケールは本体メッシュに揃え、姿勢は spinAngle=0 の spinOrientation で本体とは別個に組む(環は本体メッシュの子ではないので自転位相を継承しない)。厚み0かつ非テクスチャの細帯ごとに、その天体の実 ECI 位置での CameraSystem.activeCameraScale(metersPerPixel)と帯の実幅から thinBandBlend() で annulus/line の重み(和が1)と被覆率を求め、重みが0でない側を visible にして coverage へ掛ける
    - sunLight.position(= ephemeris.sunDirFrom(fo.r, displayTime))・intensity 更新 // 平行光は描画原点近傍の実スケール物体だけを照らす。天体は body.sync 内で自分の真の位置から陰影を計算済み
    - ambient.intensity 更新 // lit から導出
    - syncStars() // starsMesh をカメラへ追従、overviewMode でさらに拡大
    - syncReferenceLines(simTime, fo, overviewMode, focus) → geoLine.sync() + [referenceLines の各 OrbitLine ごと] showsReferenceLine(id, focus) が true のときだけ line.sync(orbitElementsFor(id, simTime), …)、false なら null 渡しで非表示 // !overviewMode では全線 null。惑星線は常時、衛星線は focus がその衛星系(地球系除く)を指すときだけ show
    - celestialGrid.sync() // navball.gridVisibility の6トグルと overviewMode に応じたスケールを反映
    - [entities.players ごと] ship.syncPlayer(displayTime, isActive = ship===player)
    - displayState(displayTime) // current.at または predicted.at。null なら obj.visible=false のみで以下は現在状態のまま
    - obj の position / quaternion / visible // displayState 基準(未来ゴースト表示中は将来位置)。ガンサイトズームで隠れるのは isActive の艦だけ
    - thrustEffects.sync(this.thrust, maxAccel, ...) → sfx.setThrust(firing)(isActive のみ) + core/outer の sync() or hide() // this.thrust は PlayerThrottle/PlanExecutor どちらが立てても同じ。displayState(displayTime) ?? this.state。displayState が null なら alive=false 扱いで呼び自分で隠れる
    - rcsEffects.sync() → sfx.setRcs(rotating) + puff の sync() or hide() ×4 // 同上
    - belt.sync() // 各リンクの position/quaternion を平行移動+ツイストから導出。同上
    - radiator.sync() // ヒンジ Group の rotation.y へ展開角を書く
    - reentryEffects.sync() // qdyn が REENTRY_GLOW_MIN_Q 未満、または !alive なら隠すだけ
    - [isActive] markers.sync(currentState, displayState, ..., project, scale) // 自機由来の HUD マーカー(方位・ボアサイト・▲)。操作対象の艦だけが出す
      - [overviewMode] 戦闘用7キーを hide + displayState があれば headingDeg(displayState.r, displayState.v) → markerManager.setPosition('self', 'mk-self', '▲', rotationDeg) / 無ければ hide('self')
      - [!overviewMode] hide('self') + syncOrbitAxes(currentState) // pro/retro/nrm/anm/radout/radin。常に現在状態
      - [!overviewMode] syncBoresight(currentState) → setDirection('bore') or hide('bore') // player.alive で分岐。常に現在状態
    - orbitLine.sync() → regenerate() // 中心天体は毎フレーム strongestAttractor(state.r, ephemeris.attractorsAt(state.t)) で導出(地球固定ではない)。要素が閾値以上ドリフト or 推力中(force) or 初回のみ再生成。現在状態基準(要素は時刻に依らない)
  - entities.sync(displayTime) → entity.sync(displayTime) // 敵・弾・薬莢・デブリ・補給それぞれ(Bullet は速度方向を向く別実装)。自機(全隻)は含まない — 各艦は syncPlayer() が個別に同期済み。
    displayState が null(predictsFuture=false の種別が未来表示中、または予測ホライズン超過)なら visible=false
    - 続けて弾本体/弾ハロー/プラズマ弾/薬莢/破片(fragment、バリアントごとに1本)の各 InstancedPool を beginFrame → (bullets/casings/debris ごとに obj.visible を見て push) → endFrame。Group(本体+ハロー)を持つ通常弾は obj.updateMatrixWorld() で子まで連鎖更新してから両プールへ push。fragment は debrisFragmentPools[fragmentVariant] へ fragmentColor(per-instance color)付きで push
  - [entities.bases ごと] base.syncOrbitLine(overviewMode, bodies) // 中心天体は strongestAttractor(base.state.r, bodies)。マップビューのみ、それ以外は null を渡して線を消す
  - effects.sync() → flashEffectManager.syncFlashEffects()
    - pool.beginFrame() → (生存中のフラッシュごとに transform へ位置/スケール/カメラ正対回転を書き、color = baseColor×opacity で push) → pool.endFrame() // 寿命・移流は update フェーズで済んでいる
  - targeter.sync(attractors) // ターゲットに紐づく表示物をまとめて
    - syncOrbitLine(attractors) // 各線の中心天体は対象ごとに strongestAttractor(target.state.r, attractors) で導出
      - enemy.orbitLine.sync() // 敵ごと。overviewMode かつ生存かつ第一・第二どちらでもないときだけ表示
      - orbitLine.sync() // 第一ターゲット軌道線(オレンジ)
      - secondaryOrbitLine.sync() // 第二ターゲット軌道線(シアン)
    - syncBoardMarkers() // 的通過マークの表示(スロットごと)。第一ターゲットのみ
    - syncTargetDirMarkers() // ◇/◆ tgtdir/atgdir。overviewMode or 第一ターゲット無しなら hide。第一ターゲットのみ
  - navTarget.sync(project, overviewMode, cameraSystem.activeCameraPos) // ▲/▽ nav-an/nav-dn マーカー。navTarget.update() が求めた位置があれば表示、無ければ hide。[overviewMode かつ isOccluded] も hide
  - equatorNodeMarkers.sync(project, overviewMode, cameraSystem.activeCameraPos) // △/▽ eqan-*/eqdn-* マーカー。show=overviewMode。前フレームに出ていて今フレーム出さない source のキーは remove。[show かつ isOccluded] は hide
  - navball.sync(player.state, player.att, player.alive, target?.state ?? null) // 常に自機の現在状態(表示時刻ではない)。ターゲット系モードのままターゲット消失ならモードを自機基準へ戻す
  - [敵ごと] displayState(displayTime) → markerItem(role, viewerPos, pos, vel, overviewMode) // role は第一/第二/なし。overviewMode で hpMarkerSvg()/headingHpMarkerSvg() を切り替え。displayState が null の敵はここで除外(マーカーごと落とす)
  - enemyMarkers.sync(items, project, overviewMode, scale) // 生存かつ displayState を持つ敵の markerItem() 集合を受ける(まとめは1体では決まらない)
    - groupNearby() // 画面上で近接するものをクラスタ化し、代表以外のラベルを落とす
    - [overviewMode] headingDeg(item.pos, item.vel) → rotationDeg // 対象ごと。円軌道での進行方向を示す
    - markerManager.set() + markerManager.setBearing() // 対象ごと。overviewMode 以外で画面外なら画面端の方位マーカー▲へ
    - retire() // 前フレームに出したキーのうち集合から消えたものを remove(敵ごとに増えるキーなので DOM ごと捨てる)
  - leadMarkers.sync() // 敵ごとの LEAD マーカー。overviewMode or !player.alive なら全 remove して return
    - trackTargeted() // 最終ロック時刻を生存中の敵ぶんだけ作り直す
    - leadPoint() → markerManager.setPosition('lead-<name>') // LEAD_HOLD_SEC 以内 かつ 解がある敵ごと
  - displayTimeManager.setPredictionCoverage(predictionCoverageRatio()) // 自機の predictedTrajectory.state.t が _window(simTime, duration)のどこまで届いているかの割合(0..1)。自機/予測/表示期間のいずれかが無ければ 1
  - displayTimeManager.sync(_window) // PREDICT パネル(期間ピル/スクラバー/目盛り)の表示/内容を押し出すだけ
    - panel.render(state) // visible(=!forceCurrent)・期間ピル・スクラバー(段階数/つまみ位置/未予測区間の減光)・絶対日時/T+ラベル・目盛りを1回でまとめて押し出す。編集中(任意期間フォーム・T+ジャンプフォームを開いている)行は再描画をスキップし、入力中の値を壊さない
  - editor.sync(mapDist, simTime, fo, project, cameraSystem.activeCameraScale, overviewMode, cameraSystem.activeCameraPos)
    - [hasPlan かつ(editMode または plan.nodes.length > 0)] planDisplay.sync(fo, project, scale, overviewMode, cameraPos)
      - path.setVisible(plan.nodes.length > 0) // ノードの無い計画は自機の現在軌道そのものを描くだけなので折れ線を隠す
      - path.sync(fo, project, scale, cameraPos) // ノードの有無に関わらず毎フレーム呼ぶ(画面判定に使う視点を更新するため)。区間の折れ線メッシュ。表示座標系と un-bake 時刻は update フェーズで確定済み。cameraPos は nearestSample(DOM ポインタイベント起点)向けにここでキャッシュするだけ
        // 区間の終端はノードの t。末尾区間だけは起点の解析軌道1周期ぶん(plan.ts の orbitPeriodOf)
        // ノードの t は Plan.nodeTimeRange の制約で起点から1周期以内なので、どの区間も1周を超えない
        - [区間ごと] サンプル列中央の代表点で scale(m/px) を引き、破線のドット・隙間のピクセル指定を実距離へ換算
        - arc.setVisible(true) + arc.sync(dashSize, gapSize) // 有効な区間ごと。先頭で破線パターンを書き込んでからサンプル列全体を1本の線へ同期する
          - line.syncGeometry() // 点列 or frame が変わったときのみ頂点を bake
          - line.syncTransform() // 毎フレーム(剛体 un-bake + フローティングオリジン補正)
        - arc.setVisible(false) // 区間が減って余った PlanArc ごと
      - syncGhost() → markerManager.setPosition('plannedPlayer') or hide() // update が求めた ghost が null なら hide
      - syncApsisMarkers(project, overviewMode, cameraPos) → markerManager.setPosition('apsisPe'/'apsisAp') or hide() // update が求めたアイコンごと。[overviewMode かつ isOccluded] も hide
    - [!hasPlan、または(!editMode かつ plan.nodes.length === 0)] planDisplay.hide()
    - [hasPlan かつ editMode] syncGizmo() → nodeGizmo.sync() // ノードハンドル + 選択中ノードの Δv アーム6個
      // ↑ planDisplay.sync の後で呼ぶ: ノードの画面座標は path の今フレームの表示文脈を通す
    - [hasPlan かつ editMode] syncPanel(simTime) // 軌道計画パネルの HTML(ノード一覧・選択中ノードの Δv と噴射後要素)
  - mapPicker.sync(overviewMode, simTime, bodies, player) // 軌道オブジェクトウィンドウ。overviewMode の間は常設表示で pickables を行として書き出す
    - objectListPanel.sync(pickables, focusId, parentOf) // 区画の選別・並べ替え・親子構造(Section.order)は、それを決める入力が変わったフレームか、保持している順序が今フレームの値で整列条件を満たさなくなったフレーム(距離順)にだけ組み直す。行の値(距離・詳細)と見出しの件数は毎フレーム書く
    - 開いている各プロパティウィンドウ // isTargetGone(target) が真なら closeWindow()(player/ship/ammo/base は実体の alive を直接見る。displayState が null なだけの休止フレームでは alive のまま残るので閉じない。天体/アプシス/AN-DN は pickables に載っているかで判定) — 残れば target を pickables の最新値へ更新し、buildRows() → w.syncRows() / windowItems() → w.syncItems()
  - frameControls.sync(mapPicker.pickables, cameraSystem.activeCameraPos, attractors, simTime, overviewMode) // 座標系パネル。!overviewMode なら非表示にして return
    - [overviewMode] members = systemMembersAt(ephemeris.registry, cameraPos, attractors) // 4ゾーン共通の「いまカメラがいる系の天体列」を1回だけ導出
    - [overviewMode] cameraZone.setItems(pickables) / setNearby(members, pickables) / setSelected(focusTargetId(overviewCamera.focus)) // カメラの固定先(全候補プルダウン + いまいる系のクイックボタン)
    - [overviewMode] cameraRotationZone.setNearby(members) / setSelected(overviewCamera.cameraFrame.rotatingWith)
    - [overviewMode] translationZone.setItems(pickables) / setNearby(members, pickables) / setSelected(planDisplay.planFrame.center) // 計画折れ線の原点
    - [overviewMode] planRotationZone.setNearby(members) / setSelected(planDisplay.planFrame.rotatingWith)
  - predictedTrajectoryLine.sync(predictedTargets, editor.planDisplay.planFrame, simTime, ephemeris, fo) // predictedTargets = 操作対象の自機が生存していればその1隻、いなければ空配列。計画軌道の折れ線と同じ座標系(editor.planDisplay.planFrame)で bake する。空配列を渡すと内部の pruneTo が線を畳む
    - line.syncGeometry() // entity.predictedTrajectory.samplesOldestFirst() を frame で bake
    - line.syncTransform()
  - entities.players ごとに ship.orbitLine.setSuppressed(predictedTrajectoryLine.coversHorizon(ship, simTime, _window.duration)) // 予測が表示ホライズンを覆いきったときだけ解析楕円を抑制する。overviewMode/!overviewMode どちらも同じ判定
  - touchControls?.syncModeButtons() // タッチデバイスのみ。制動/微動/ホールドの点灯
  - activeStage.sync(player, fo, project, scale, displayTime, overviewMode) // player は Creative の未配置状態で null
    - syncStatusPanel() // hudSubStatus() が文字列を返すステージだけ表示。player が null なら隠す
    - [CreativeStage] syncPreview(fo, project) // update が求めた preview の軌道線 + ▷ PREVIEW マーカー。preview が null なら両方隠す
    - [CreativeStage] placerPanel.setIssues(issues) // update が求めた issues を渡すだけ。前回と同内容なら panel 側が DOM に触らず即 return
    - logistics.syncMarkers(player, project, scale, displayTime, overviewMode) → ammo.displayState(displayTime) → [overviewMode] headingDeg(ds.r, ds.v) → markerManager.set('mg<i>', 'mk-ammo', '▲', rotationDeg) / [!overviewMode] markerManager.set('mg<i>', 'mk-ammo', '▣') + setBearing('mg<i>-bearing')
      // player が null の間はすべて隠す(ラベルの距離表示が自機基準のため)
      // マーカーを出せる補給ごと(i = 生存かつ displayState が非 null な個体だけを詰めた配列の添字)
      - hide() // 前フレームよりその数が減ったぶんの、余った添字だけ
    - [CreativeStage] syncBaseMarkers(project, scale, displayTime, overviewMode) → base.displayState(displayTime) →
      [overviewMode] headingDeg(ds.r, ds.v) → markerManager.set('base<i>', 'mk-base', '▲', rotationDeg) /
      [!overviewMode] markerManager.set('base<i>', 'mk-poi', '●') + setBearing('base<i>-bearing', 'mk-poi', '●') // ラベルは player があれば距離付き
      // entities.bases の添字ごと(logistics.syncMarkers と同じ、前フレームより減った添字だけ hide())
  - hud.panels.sync(game, attractors) // Game インスタンスを直接読む(narrow ctx を介さない唯一の消費者)
    - setText('met') + setGlobalStatus() // 自機不在でも常に実行。setGlobalStatus は約10Hz にスロットル
    - setStats() + setTarget() // 自機がいる間のみ、約10Hz にスロットル
    - setEnemyList() // 約4Hz にスロットル
  - hud.tick() // ヒント/トーストのフェードアウト
  - guide.sync(plan, player, simTime, editMode, project)
    - markerManager.hide('nd') + hide('burn') // editMode または !player.alive、あるいは直近ノードが無い場合
    - markerManager.setPosition('nd') + setDirection('burn') // 直近ノードがある場合
  - debugTrajectoryLine.sync(debugTargets, editor.planDisplay.planFrame, simTime, ephemeris, fo) // ?debugLines=1 のときのみ実効。座標系は計画軌道の折れ線と同じ editor.planDisplay.planFrame。対象(既定: 自機+ターゲット)ごとに
    history/predicted.history を1本の SampledLine へ bake + un-bake
  - markerManager.resolveCollisions() // ラベル衝突緩和 + SVG 引き出し線の再描画。全マーカーが出揃った後に一度だけ

---

## game.render()

- game.render()
  - [viewManager.current === 'dock'] 何も描かずに return // ドックは 3D を持たない全画面ビュー
  - renderer.render(scene, cameraSystem.activeCamera) // 通常の全画面描画

---

## 補足

- **`update` / `sync` / `render` の三分割は main.ts のループが決めている。** `Game.update` は論理状態のみ
  (THREE.js オブジェクトに触らない)、`Game.sync` は fo を作って既存メッシュ・DOM へ反映するだけ、
  `Game.render` は renderer.render を呼ぶだけ、という切り分けになっている。
- **カメラ更新は `Game.update` の末尾**(物理積分の後)にある。`sync` で作るフローティングオリジンは
  積分後の自機位置なので、追従カメラの基準もそこに合わせる必要がある。
- **高ワープ時**(`simSpeed > MAX_PHYS_SIM_SPEED`)は `substep()` が1フレームに最大64回走るが、
  `contactPhysics.resolveSubstep()`/`resolveBelt()` は `canResolvePhysicalCollisions` が false に
  なり `resolveCollision=false` で渡るため、`advance` の中で丸ごとスキップされる(接触判定・弾命中を
  含む)。substep が長大になる高ワープでは弾もすり抜けるが、`canPlayerFire` が同じ閾値で発砲自体を
  止めているので実害は無い。
- **計画軌道 RK4 の再計算**は `PlanArc.update` が per-arc に持つ `(state0, end)` の変化検出だが、
  `tracksLiveAnchor` 引数(計画が空のあいだの唯一の区間だけ true — その区間は anchor が自機の
  現在状態を毎フレーム追従する)で判定基準が変わる。false(ノードを置いた後の区間)なら
  `state0`/`end` の同一性・値の変化そのものが再積分の合図で、編集していないフレームでは一切
  再積分されない。true の間は `state0.t` も区間長(≒ 自機の接触周期。[表示時刻] パネルが「1周」
  のとき J2・大気抵抗で毎フレーム連続的に変化する)も厳密には毎フレーム変わるため、直近の
  再積分からの変化が描画解像度のサンプル間隔(区間長 / `PLAN_ARC_MAX_SAMPLES`)未満の間だけ
  再積分をスキップする。ただし `state0` の同一性が変わっていて `t` が前進していない(別艦への
  切り替え・ドック発進・衝突による状態上書きなどの非連続な差し替え)ときはこの閾値を無視して
  即座に再積分する。マップモード中でも大半のフレームは `line.syncTransform()`(O(1) の
  剛体変換)だけで済む。
- **過去 state の記録・prevState の更新は `physics/dynamic-trajectory.ts` の `DynamicTrajectory`(`GameEntity.actualTrajectory`)の
  `step`/`reset` が行う**ので、この木には独立ノードとして現れない。`entity.stepActual()` /
  `contactPhysics.resolveSubstep()`/`resolveBelt()` の解決結果書き戻し / 反動など、state へ代入する
  すべての経路が記録契機になる(前者は `actualTrajectory.step` 経由、後者は `actualTrajectory.reset`
  経由)。`game/simulation/contact.ts` の掃引接触判定と `targeter.updateBoardMarks()` が読む
  「直前サブステップ位置」(`entity.prevState.r`)は history の間引き対象とは別フィールドなので、
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
  `setPhaseOffsets` は3系統すべてのキャッシュをクリアする。
- **重力積分が使う配列は3経路(`Simulator.substep`/`Predictor.advanceBudget`/`PlanArc.integrate`)とも
  同じ組み立て: 合流(`gravityBodiesAt` の解析天体 + 生存中の重力天体)→ `classifyAttractors`
  → `attractorsNear`(問い合わせ位置の27近傍グリッド)。**
  `substep` はサブステップ中点で1回だけ合流・分類し、その結果をそのサブステップの全エンティティへ
  使い回す(処理順に依存した誤差を避けるため)。`Predictor` は各対象の予測先端の時刻ごとに
  `predictedAttractorsAt` で他の重力天体を引き直す(その時刻に達していない天体は落とす — 現在
  位置に凍結すると「その時刻に居ない場所」から引くことになるため)。`PlanArc` は生存中の重力天体を
  `Game.update` が1回求めた `dynamicAttractors`(現在の実状態)に固定したまま区間全体で使い回す
  (区間長は最大1年に及び、そのあいだの位置を `EntityManager` には問えない)。3経路とも `Ephemeris`
  の窓を直接書き換えず、常に新しい配列へ展開する。
- **HUD マーカーは持ち主の `sync` が自分で出す**。`game.sync` に並ぶのは「1つの対象では決められない」
  ものだけ(`enemyMarkers` = 画面上のまとめ、`leadMarkers` = 自機と敵の両方に依存、`equatorNodeMarkers` =
  操作艦・navTarget・targeter という複数の役割にまたがる source 列に依存)で、残りは
  `player.syncPlayer` / `targeter.sync` / `navTarget.sync` / `activeStage.sync` / `cameraSystem.sync` /
  `editor.sync`(→ `planDisplay`) / `guide.sync` の中にある。**`markerManager.resolveCollisions()` だけは
  全マーカーが出揃った後に一度だけ**呼ぶ必要があるため `game.sync` の末尾に置く。
- **`mapPicker.refresh()` は `game.sync` ではなく `game.update` の中、4経路それぞれで
  `cameraSystem.update` を呼ぶ直前(物理積分の後)に呼ぶ**。積分前に組むと、被選択物や navTarget の
  AN/DN の座標が、同じフレームで `sync` されるメッシュに対して1ステップぶん古くなる(ワープ倍率が
  高いほど無視できない)。フォーカス解決(`overviewCamera.update`)も右クリック判定
  (`mapPicker.handleRightClick`)もどちらも `update` フェーズの仕事なので、`sync` を待つ必要はない。
  天体ラベル(`focusMarkers`)と AN/DN(`navTarget`)、EqAN/EqDN(`equatorNodeMarkers`、`editor.update`
  の直後・`mapPicker.refresh` の直前に呼ぶ)の座標も候補列の一部なので、`refresh()` の
  先頭で両方を求め直す。`sync` 側(`focusMarkers.syncLabels` / `navTarget.sync`)はその値を
  マーカーへ置くだけで、座標を求め直さない。
- **`environment.update(displayTime, cameraSystem.overviewMode)` は `updateMapPresentation` の
  最初(`editor.update` より前)、4経路すべてで呼ぶ**。小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・
  散乱円盤の点群(`PointFieldView`)の位置を群ごとにラウンドロビンで再評価するだけで、
  `mapPicker.pickables` には一切寄与しない(点群はピック対象でも重力源でもない表示専用)。
  `!overviewMode` では即 return するので、コンバットビューでは実質無視できるコスト。`sync` 側は
  `environment.sync` の中で `pointFieldView.sync` を呼ぶ——`update` が引き直した点も引き直して
  いない点も含め、浮動原点の移動ぶんだけ全インスタンス行列を毎フレーム書き直す。
- **`game.sync` は `dt` を受け取らない**。sync フェーズには進めるものが無い、というルールを
  シグネチャで見えるようにしてある。HUD パネルの書き換え間引きのような表示側の周期は
  `performance.now()` の期限で持つ。
