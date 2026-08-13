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
  - game.update(dt) // dt = 実経過秒。game 側で 0.1s に clamp される
  - snapshotControls.handleInput(game.input, game) // このフレームで game.update が消費しなかった入力エッジだけを見る。K.clipSnapshot/K.openSnapshots(Esc は扱わない — 一覧を閉じる Esc は overlayManager 経由で game.handleInput 側が既に消費している)
    - [K.clipSnapshot] [!activeStage.isPlaying] hud.hint() // 決着後は拒否。それ以外は snapshotService.capture(game, 'manual', null, true) + hud.hint()
    - [K.openSnapshots] browser の open()/close() をトグル // open() 前に pauseMenu.toggle(false)。open() が game.pause()、close() が game.resume() を呼ぶ
  - autoSave.update(game) // 前回撮影から AUTOSAVE_INTERVAL_REAL_SEC(実時間60秒)経っていれば snapshotService.capture(game, 'auto', null, false) // game.isPaused または !activeStage.isPlaying なら何も撮らない
  - game.sync()
  - game.render()
  - perf.record() // 負荷確認ウィンドウが開いている間(perf.on)だけ。500ms ごとに Game.perfCounts() を読んで PropertyWindow の行へ流す

---

## game.update(dtRaw)

`update` は一本の線形フローで、艦の有無やステージの決着状態は経路の分岐ではなく `advanceSimulation`/
`handleMapPointerInput` 内部の条件付きブロックとして表現される(4経路の重複はない)。

- game.update(dtRaw)
  - sections.enter(SECTION.input)
  - input.update() // pending キュー(キー/クリック/マウス)を今フレーム分に確定し、次フレーム用にクリア
  - handleInput() // 担当モジュールへ先着順に配る。処理した側が input からそのキーを消費する。ポーズ判定より前に置く(Esc・ヘルプ等はポーズ中・決着後も効かせる)
    - [input.takeKey(K.pauseMenu)] hud.overlayManager.closeTopmostOnEscape() // 開いている登録済みオーバーレイ(ドック/一覧/ヘルプ/一時ウィンドウ/ポップアップ)のうち最前面かつ closeOnEscape なもの1枚を閉じる。閉じるものが無ければ pauseMenu.toggle(true)
    - input.takeKeys(code => hud.overlayManager.dispatchShortcut(code)) // 今フレームの未消費キーを1つずつ試す。テキスト入力へフォーカス中なら即 false。最前面から順に handle.handleShortcut?.(code) を呼び、true を返した1枚で打ち切る(ContextMenu/PropertyWindow/ShipPlacerPanel のみ実装 — クリップ中の PropertyWindow は常に false を返して1つ下へ通す)
    - hud.handleInput() // K.help → helpPanel.handleInput() → toggle()
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
    - editor.handleInput()
      - clearPlanByKey() // K.deleteNode
        - [editMode] deleteSelected() → deleteNode()
          - plan.removeNode() / closeMenu() / simSpeedManager.cancelAutoWarp() / hud.hint() // 下流ノードも一緒に消える
        - [!editMode] plan.clear() + simSpeedManager.cancelAutoWarp() + hud.hint() // ノードがある場合のみ
    - [K.togglePerfWindow] perfMeter?.toggle()
  - sections.exit(SECTION.input)
  - [!game.isPaused] advanceSimulation(dt) // ポーズ中は丸ごと飛ばす(HP自動回復などをポーズ中に汲み出せないようにする)
  - displayWindowManager.resolve(simulator.simTime, player) // advanceSimulation を飛ばした(ポーズ中の)フレームでもここで確定させる。ポーズ中・決着後もカメラ更新だけは飛ばせない — 飛ばすと視点だけが絶対 ECI に取り残され、軌道速度で遠ざかる原点(自機)から残骸が即座にフレームアウトする
  - updateMapPresentation(dt)
  - sections.enter(SECTION.pointer)
  - handleMapPointerInput(dt)
  - sections.exit(SECTION.pointer)

### advanceSimulation(dt)

自機の行動 → ステージ → 積分 → 予測 → エフェクトの順に1フレーム進める。艦がいない場合、または艦は
いてもステージが決着済みの場合は player.behave の段だけを落として残りは進める(残骸・弾の epoch は
どの状況でも進め続ける)。`game.update` からは `!isPaused` のときだけ呼ばれる。

- advanceSimulation(dt)
  - 以下の player は毎回その場で読む game.player(= activePlayers.current)。[playing] は activeStage.isPlaying の略
  - sections.enter(SECTION.player)
  - [player && playing] nanWatchdog.checkPlayer('frameStart')
  - [player && playing] player.behave()
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
    - throttle.updateTorque() → player.torque へ代入(マップビュー中も手動回転は常時有効)
      - onProgradeHoldReleased() → hud.hint() // ホールド中に手動回転入力があった場合のみ
      - autoAlignTorque() // ホールド中 かつ 手動回転入力なしの場合のみ
    - radiator.update() // 展開度のみ。THREE には触れない
    - sunlitFactor() // 地球影による日照率
    - thermal.setRadiatorLoad(radiator.radiatingArea(), radiator.solarLoad())
      // このフレームの全サブステップの updateThermal がこの値を使う
    - power.update() // sunlit/sunDir は radiator と共有。THREE には触れない
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
  - [player && playing] entities.updatePassivePlayers(dt, player) // 操作対象以外の自機に、表示フレーム基準のベルト・HP回復だけを1回ずつ進める(熱・電力・ラジエータは Simulator が全艦を substep ごとに stepEnvironment する)
  - [player && playing] nanWatchdog.checkPlayer('player.behave')
  - [player && !playing] player.clearTransientCommands() // behave が呼ばれなくなるので、次のフレームへ持ち越してはならない連続指令を畳む
  - sections.exit(SECTION.player)
  - sections.enter(SECTION.stage)
  - activeStage.update() // 具体ステージへディスパッチ。各具体ステージが isPlaying/艦の有無を自分で見て内部で即 return する
    - behaveAllEnemies() // 敵を配置する具体ステージ(Stage0/00/1/2)が先頭で呼ぶ。CreativeStage は player があるときに限り、logistics.updateLogistics の直後で呼ぶ(既存敵の AI は waveAttackEnabled トグルの有無によらず常に進む)
      - enemy.behave() // 生存中の敵ごと(canEnemyFire・距離・バースト状態の判定は behave 内部)
        - firePlasma() → entities.addBullet()
    - [Stage0 訓練スコアアタック] logistics.updateLogistics(simSpeed, respawnOnDespawn=false)
    - [Stage0 訓練スコアアタック] timer.update()
      - setPhase('timeup') + showScoreAttackResultScreen() // 制限時間到達フレームのみ
    - [Stage00 無限サバイバル] logistics.updateLogistics(simSpeed, respawnOnDespawn=true)
      - absorbNearbyAmmo()
        - player.onPickup() + sfx.pickup() + hud.hint() // 範囲内の補給ごと
      - despawnFarAmmo() // 消滅そのものは投入可否によらず常に走る
        - spawnForPlayer() // 遠方消滅した数だけ再投入。投入可(resupplyEnabled かつ canResupplyAmmo)のときだけ。生存数が MAX_AMMO に達したら打ち切る
      - spawnForPlayer() // 投入可のとき、LOGISTICS_CHECK_INTERVAL ごと、かつ低弾薬・上限未満のみ。投入不可の間は次回判定時刻を進めない
    - [Stage00 無限サバイバル] waveAttack.update(dt, player, entities.enemies, simTime, this, addEnemy) // stage-utils/wave-attack.ts の WaveAttack(Stage00/CreativeStage 共用)。waiting_for_ammo→spawning_enemies→active_combat のフェーズ機械
      - [waiting_for_ammo] 弾薬確保でフェーズ遷移 → hud.toast()
      - [spawning_enemies] カウントダウン満了で spawnWave() → active_combat へ
      - [active_combat] despawnOutOfRangeEnemies() → enemy.despawn() // 圏外の敵ごと(alive=false + recordEnemyDeath(cause='despawn'))
        - 間隔・同時展開上限を満たす場合のみ spawnWave() + hud.toast()
      - spawnWave: generateWave() → addEnemy() → entities.addEnemy() + scoreCounter.recordSpawnEnemy()
        - generateWave: pickWaveCenter() → makeFlybyVelocity() → limitFlybyDv() → waveShipPosition() ×機数
    - [Stage1 / Stage2 キャンペーン] logistics.updateLogistics(simSpeed, respawnOnDespawn=false)
    - [CreativeStage] player があれば: logistics.updateLogistics(simTime, player, simSpeed, respawnOnDespawn=true) → behaveAllEnemies()(上記) → [waveAttackEnabled] waveAttack.update(...)(Stage00 と同じ WaveAttack。トグルが制御するのは新規ウェーブの発生のみで、OFF の間も既存敵はそのまま残り AI は進む)
    - [CreativeStage] placerPanel.isOpen なら getForm() を1回だけ呼び、computePreview(form)/computeFieldIssues(form) へ共有する
    - [CreativeStage] entities.players ごとに ship.planExecutor.update(ship, dt, simTime, simSpeed) // planExecution!=='powered' なら idle へ戻すだけ。'powered' なら姿勢整列(idle/slew/armed)、または燃焼中(burn/trim)の出力段選択・燃料消費・ship.thrust の書き直しを進める。ノード時刻に対する猶予窓(NODE_APPROACH_LEAD+見積り燃焼時間+見積り姿勢転回時間)を外れている間は何もしない。死亡していれば停止。点火・遮断そのものはここでは行わない。Simulator.advance より前に呼ばれるので、操作艦で player.behave がこのフレーム player.thrust を null にしていても、積分に渡る前にここで確実に上書きされる
  - sections.exit(SECTION.stage)
  - nanWatchdog.checkPlayer('activeStage.update')
  - simSpeedManager.update() // 自動ワープ中のみ実効。残り時間が C.NODE_APPROACH_LEAD 以下なら autoWarpUntil=null + levelIdx=0 で即 return
  - [!simSpeedManager.canOperatePlayer] entities.clearTransientCommands() // 操作できないワープ倍率の間、全自機の連続指令を畳む。ship ごとに thrust=null / torque=0 / throttle.clearTransientState()(噴射ラッチ・二度押し時刻)/ fire.stopFiring()。behave と planExecutor の両方より後、積分より前に置くので、どちらが書いた指令も積分へ渡らない
  - simDt = dt × simSpeedManager.simSpeed
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
          - SpatialGrid 構築(1回、以後の反復で使い回す) // セル一辺 = 2×max(半径+|区間変位−参加者平均変位|)、退化時のみ CONTACT_GRID_CELL_SIZE_FLOOR
          - collectCandidates()(1回だけ) // 27近傍のエンティティ間ペア(少なくとも一方が attacker)+ 全 attacker×天体ペアのうち、双方の contactsWith が true のものを候補列へ詰める。接触しない組み合わせも response=null の候補として残す
          - [解決1件ごと、最大 CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP 回] earliestContact() // 候補列を1パス走査し、未解決かつ TOI 最小の1件を返す。直前の解決で状態が変わった当事者を含む候補だけ resolveSphereCollision(collision-response.ts)で response を引き直す
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
  - sections.exit(SECTION.integrate)
  - displayWindowManager.resolve(simulator.simTime, player) // 積分後の状態でこのフレームの表示窓を確定させ、以降の消費者へ共有する
  - nanWatchdog.checkAll('simulator.advance', player, entities, simTime, dt, simDt) // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る
  - targeter.updateBoardMarks(dt, player, entities) // 既存マークの経過時間を進め、寿命切れを捨てる。自機もターゲットも居なければ全消し
    - boardMarks.push() // 通常弾が的の面を自機側から通過した場合のみ
  - activePlayers.reclaimDead() // 喪失艦を配列・操作対象から回収する。全ステージ共通で毎フレーム無条件に呼ぶ(喪失した自機も他のエンティティと同じく速やかに取り除く)
    - entities.players のうち !alive な艦ごと → activePlayers.remove(lost) → navTarget.clearIfTargeting(lost.id) / targeter.clearIfTargeting(lost) / mapActions.close() / overviewCamera.clearFocusIf(lost.id) / entities.removePlayer(lost)
    - 掃引で操作対象そのものを失った場合だけ reclaimAfterLoss() → 生存艦が居れば activePlayers.set(次の艦)、居なければ setOrNull(null)(cameraSystem/editor の操作対象を null に + sfx.setRcs(false)。ビューはここでは切り替えない)。元から操作対象が居ない状態(手動解除・未配置)では何もしない
  - docking.checkProximity() // 内部で viewManager.current==='dock' なら即 return。それ以外は全 base × 全生存艦を見て、距離・相対速度が閾値内の艦を収容(EntityManager.parkPlayer で破棄せず除去。alive には触れない)
    - [収容した艦が操作対象だった] activePlayers.setOrNull(次の生存艦、居なければ null) → [game.player===null] viewManager.setView('map') // 操縦できる艦が無くなれば戦闘ビューに映すものが無いためマップへ
  - sections.enter(SECTION.predict)
  - predictor.update(simTime, player, displayWindowManager.current.duration, mode) // simulator.advance 内の substep cleanup 後に呼ぶ(死んだ個体を予測しない・積分後の実状態と突き合わせる)。horizon = displayWindowManager.current.duration(直前の displayWindowManager.resolve() が確定させた窓を読むだけ)。mode は 'map'(entities.all() 全対象・PREDICT_STEP_BUDGET)/'combat'(自機のみ・PREDICT_COMBAT_STEP_BUDGET)、cameraSystem.overviewMode で選ぶ
    - discardPredictionIfDiverged(simTime, attractors) // entities.all() のうち predictsFuture=true の対象のみ、毎フレーム無条件。attractors は simTime ぶんを1回だけ classifyAttractors し、対象ごとに attractorsNearInto でその位置の近傍へ絞ったもの(advanceBudget とは別のスクラッチ配列)
      - invalidatePrediction() // predicted.at(simTime) が実位置から許容量を超えて乖離、または区間外のときのみ。許容量は PREDICT_RESET_DIST を下限に、保持サンプルの間引きが粗いぶんの補間誤差まで広げる
    - advanceBudget(player, ...) // 予算 PREDICT_STEP_BUDGET を操作対象の艦優先で消費。ループごとに predictedAttractorsAt(ephemeris, entities, tip.t)(先端の時刻 tip.t で他の重力天体の displayState(tip.t) を引き直す — まだその時刻に達していない天体はその回だけ落とす)→ classifyAttractors → attractorsNear で重力源を決め、dt(localOrbitPeriod / PREDICT_STEPS_PER_REV、horizon / PREDICT_MAX_STEPS で下限、horizon そのもので上限)も Predictor 側が持つ(stepActual に対する substep と同じ分担)。predictsFuture=false の個体は消費 0 で即 return
      - player.stepPredicted(attractors, simTime, dt, horizon) // ホライズン超過・打ち切り済みのいずれかで false を返すまで、dt・attractors を都度計算し直しながら1ステップずつ繰り返し呼ぶ(噴射中でも伸ばす)
        - predictedTrajectory.step() // 呼び出し側が確定させた attractors で1ステップ積分
    - advanceBudget(entity, ...) // 残り予算を entities.all() 上のカーソル位置から1周ぶん配る(player は優先枠で処理済みなのでここでは飛ばす)。1体の取り分は max(PREDICT_MIN_ENTITY_STEPS, floor(残額 / 残り訪問数)) を残額で頭打ちにした値で、使い残しは次の個体へ回る。entity.stepPredicted() が最初から false(predictsFuture=false/truncated)なら消費 0 で次へ即進む
  - sections.exit(SECTION.predict)
  - sections.enter(SECTION.effects)
  - effects.update(dt, simulator.simTime) → flashEffectManager.updateFlashEffects() // フラッシュの寿命と、各エフェクトの時刻から simTime までの移流。playing/player を問わず常に進める(決着直後の爆発を止めないため)
  - sections.exit(SECTION.effects)
  - sections.enter(SECTION.plan)
  - guide.update(player, simTime, editMode, ephemeris.attractorsAt(simTime)) // ここの player は reclaimDead / docking.checkProximity による引き継ぎ後の操作対象。null でも呼ぶ(内部の `editMode || !player` で、操作できない間(未配置・計画編集中)は何も消化せず通知もしない)
    - player.plan.consumeNodesUpTo(simTime - C.NODE_EXPIRE_GRACE, player.state) // 期限切れノードをまとめて落とし、自機の実状態を新しいアンカーに据える
    - [player かつ直近ノードが実行の窓(node.t - C.NODE_APPROACH_LEAD)に入っている場合のみ]
      - notifyApproach() → hud.hint() // ノードごとに最初の1回のみ(approachNotified との同一性比較)
      - notifyAchieved() // orbitalElementsClose(自機軌道要素, 目標軌道要素) が真の場合のみ。player.plan.consumeNodesUpTo(node.t, player.state) で達成ノードを消化し、残り件数は消化後の実数を読む
        - hud.hint() + sfx.warp() // ノードごとに最初の1回のみ(achievedNotified との同一性比較)
  - [player] player.plan.trackAnchor(player.state) // ノードが0件のときだけ実効(1件目を置くとアンカーは凍結される)
  - sections.exit(SECTION.plan)

### updateMapPresentation(dt)

計画表示、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。ポーズ中・未配置・決着後を問わず
`game.update` から毎フレーム1回呼ぶ(4経路の重複はもう無い)。

- updateMapPresentation(dt)
  - displayWindow = displayWindowManager.current
  - environment.update(displayWindow.displayTime, cameraSystem.overviewMode) // 小惑星帯・トロヤ群点群の位置再評価。editor.update より前
  - sections.enter(SECTION.plan)
  - excludedIds = player ? [player.id] : []
  - planProvider = planAttractorProvider(ephemeris, entities, excludedIds, planSourceRevision(entities, excludedIds, editor.plan?.revision ?? 0, editor.lastPlanEnd, simulator.simTime)) // editor.update より前に組む。今フレームの計画終端は editor.update がこれから決めるので、revision の量子化は前フレームの終端(PlanPath.timeRange().max)を基準にする
  - editor.update(displayWindow, planProvider) // 計画折れ線の再積分とアプシスアイコン(赤道交点の更新/mapPickables.refresh より前)。planProvider.revision が前回と同じで起点・終端・基準天体も動いていない区間は再積分せず前回の積分結果を使う
    - path.update() // plan の corners を区間へ分解。表示座標系と un-bake 時刻もここで確定。buildSegments は末尾区間の起点時刻の天体窓を1回だけ引き、区間長(segmentDurationFrom)と基準天体(strongestAttractor → Segment.apsisCenter)の両方をそこから決める
      - [区間ごと] arc.represents(state0, end, sourceRevision, apsisCenterId, tracksLiveAnchor) // 既存 arc が今フレームの区間をそのまま表せるか。sourceRevision/apsisCenterId の不一致・積分済みサンプル間隔の粗さのいずれかで false
        - [false、または対応する arc がまだ無い] new PlanArc(state0, end, provider, apsisCenter) // constructor が end まで同期的に DynamicTrajectory で RK4 積分(重い)。刻み幅ごとの重力源は classifyAttractors(mergeAttractors(gravityBodiesAt(ephemeris, t), dynamicAttractors)) → attractorsNear — 実積分・予測と同じ組み立て。dynamicAttractors は provider が entities.attractors() を1回だけ求めて渡す(区間長は最大1年に及び、そのあいだの位置を EntityManager には問えないので現在の実状態で固定する)。末尾区間だけ apsisCenter(区間起点の重力源スナップショット)が渡り、積分の各ステップ対で apsisCrossing による近地点/遠地点検出が走る
        - [true] arc.setEnd(end) // 終端だけ動かす。積分先端が要求終端にサンプル間隔未満まで届いていなければ integrateTo() で先端から継ぎ足す(区間を作り直さない)。届いていれば何もしない
    - ghostAt(displayTime) // 折れ線が displayTime に届かなければ null
    - apsisIconsOf() // path.finalSegment() の periapsis/apoapsis(末尾 arc が積分中に見つけた値)と apsisCenter(検出時と同じ基準天体)を読み、その天体の位置だけを ephemeris.positionOf(center.id, 極値の時刻) で引き直して距離を出す。両方あるとき (遠地点距離-近地点距離)/(遠地点距離+近地点距離) < APSIS_MIN_ECC なら空、片方のみ(双曲線等)ならそのまま出す
    - player.equatorNodes.update(displayWindow.frame, displayWindow.displayTime, ephemeris, finalSegment.state0, finalSegment.samples) // 操作艦の EqAN/EqDN。代表軌道は計画の最終区間なので、交点は解析楕円ではなく積分折れ線の上に載る
  - targeter.updateEquatorNodes(displayWindow, ephemeris) // 戦闘ターゲット(aliveTarget)の EqAN/EqDN
  - entities.updateBaseEquatorNodes(displayWindow, ephemeris) // 生存中の全基地の EqAN/EqDN(選択の有無によらず常に出す)
  - sections.exit(SECTION.plan)
  - sections.enter(SECTION.mapPick)
  - mapPickables.refresh(displayWindow) // 内部で !cameraSystem.overviewMode なら即 return(戦闘ビューではクリック対象を別経路で処理するため、マップを表示している時だけ更新する)。物理積分の後に組む — 積分前だと同フレームで sync されるメッシュと被選択物の座標が1ステップずれる。MapVisibilityPolicy もここで1つだけ組み、sync フェーズは mapPickables.visibilityPolicy を読むだけ
    - focusMarkers.update(displayTime, overviewCamera.focus, cameraSystem.bodyClassToggles, activeCameraPos) // MapVisibilityPolicy が admits しない天体は座標計算ごと飛ばす
    - navTarget.update(player, entities, ephemeris, displayWindow) // 自機軌道要素 + navTarget.id から相対 AN/DN を求め直す。ポーズ・決着に関わらず毎フレーム。対象が実体(敵・自機・基地)なら、その equatorNodes.update も併せて呼ぶ
    - mapPickables.pickables に反映 // 天体ラベル + 生存中の entities.players('player')・敵船('ship')(displayState 基準)+ navTarget.mapPickables() + planDisplay.apsisMarkers + entities.all() の各 equatorNodes?.mapPickables() を集約 → [overviewMode] isOccluded(cameraSystem.activeCameraPos, item.pos, ephemeris.attractorsAt(simTime)) で天体に遮蔽された候補を除外
  - sections.exit(SECTION.mapPick)
  - sections.enter(SECTION.camera)
  - cameraSystem.update(player, simTime, input, dt, mapPickables.pickables, displayWindowManager.attractorsAt(simTime)) // 追従カメラの基準を積分後の自機位置に合わせるため、物理積分の後に呼ぶ。ポーズ中・決着後も呼ぶ(飛ばすと視点が絶対 ECI に取り残される)
    - combatCamera.toggleFollowAttitude() // K.followAttitudeToggle。カメラ自身の状態なのでここで消費する
    - keyYaw/keyPitch/keyRoll をキー入力からまとめる // cameraRollLeft/Right は Numpad0/Numpad1
    - overviewCamera.update(..., mapPickables.pickables, attractors) // cameraSystem.overviewMode のみ。focus を mapPickables から引き直し、結果を自身の view へ書く。attractors は frameTransformAt の回転解決(登録天体/生存中の重力天体の2経路)に渡す
    - combatCamera.update() // !overviewMode のみ
      - zoomActive = K.gunsightZoom 押下 // combatCamera 自身のフィールドへ書く(overviewMode 中はこの update 自体が呼ばれないため更新されない — CameraSystem.zoomActive の !overviewMode ガードが読み替えを担保する)
      - gunsightCamera.update() // player !== null && zoomActive。結果を自身の view へ書く
      - chaseCamera.update() // それ以外。!target なら即 return。camFollowAttitude のときだけ target.att.q を rot に合成し、鍵/ドラッグ/ロール入力を回転として適用。結果を自身の view へ書く
      - 選ばれた view.fovDeg から combatCamera 自身の view.fovDeg を指数補間
  - sections.exit(SECTION.camera)

### handleMapPointerInput(dt)

マップ/戦闘のポインタ操作を優先順位順(=呼ぶ順)に配る。`updateMapPresentation` の後(=
`cameraSystem.update` の後)に呼ぶ。決着後は配らず、ポーズ中は ESC メニュー等が開いていないときだけ
配る(背景の誤操作を防ぐ)。

- handleMapPointerInput(dt)
  - [!activeStage.isPlaying] 即 return
  - [isPaused && hud.overlayManager.isOverlayOpen('pause-menu')] 即 return
  - [editor.editMode] 計画編集モード。マーカー(handleRightClick/handleLeftClick/handleDoubleClick)→ ノード(editor.handleMapPointer)→ 空域(handleEmptySpaceRightClick)の優先順は呼び出し順そのもの — 上流が消費した右クリックは下流に届かない
    - mapActions.handleRightClick(input, simTime) // マーカーへの右クリックだけを消費する。外れれば消費せず editor.handleMapPointer() のノード右クリックへ読み進む
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
          - cameraSystem.setActivePlayer(ship) → combatCamera.setActivePlayer(ship) → chaseCamera.setTarget(ship) // rot/dist は据え置き
          - editor.setActivePlayer(ship) → ship 差し替え / selectedNodeIdx = null / closeMenu() // 以後 editor.plan は ship.plan を指す
          - targeter.clearTargets() // 切替前の艦が握っていたロックを持ち越さない
        - act='planExecCycle' → entities.findPlayer(target.id) → ship.planExecution = nextPlanExecution(ship.planExecution) // 'player' のみ。OFF→瞬間移動→自動操縦→OFF
        - act='delete' → entities.findPlayer(target.id) → entities.removePlayer(ship) → dispose() // 'player' のみ。操作対象の艦にはこの項目自体がメニューに出ない(MapContextActions.itemsFor)
    - mapActions.handleLeftClick(input) // 自機/基地マーカーへの左クリックを選択として消費する。外れれば消費せず editor.handleMapPointer() のノード配置/選択解除に読み進む
      - selectPickable() // 'player' → activePlayers.set() / 'base' → docking.selectBase()(遷移はしない)
    - mapActions.handleDoubleClick(input) // pickables 全種別への最寄りダブルクリックで overviewCamera.setFocus()
    - editor.handleMapPointer(input) // [艦なし] 即 return。右クリック → 左クリックの順に受ける
      - handleNodeRightClick() // 右クリックごと。ノードをヒットしたぶんだけ消費する
        - selectedNodeIdx = ヒットしたノードの idx + nodeGizmo.openMenu() // ヒット時。true を返して消費
      - handleMapClick() // 左クリックごと。常に消費する
        - selectedNodeIdx = idx + sfx.warp() // 既存ノードをヒットした場合
        - planDisplay.path.nearestSample() // 直近の sync でキャッシュした cameraPos/attractors で isOccluded な点を候補から除外してから最寄りを探す → plan.addNode() + sfx.warp() // 計画軌道上をヒットした場合
        - selectedNodeIdx = null // どちらにも当たらなかった場合
      - dragNodeToNearestSample() // ノードを incoming arc の最寄り点へ移し、元のΔv成分を保ったまま新しいノード状態へ焼き直す
    - mapActions.handleEmptySpaceRightClick(input, simTime) // マーカーにもノードにも当たらなかった右クリックだけが届く。ContextMenu<MapPickable> で「オブジェクトリストウィンドウを表示」/(クリエイティブのみ)「オブジェクトを配置」/「設定メニューを開く」
    - editor.updateEditing(dt, input)
      - applyHeldDv() ×6方向 // WASDQE または dvButtons(長押しボタン)が held の間、ホールド秒数からランプするレートで dt 秒分を積分
      - applyDv() // nodeGizmo.latch がある間、ラッチ超過量に比例したレートで dt 秒分を積分(アームドラッグが DV_DRAG_LATCH_PX を超えて入る)
  - [!editor.editMode && !isPaused && player]
    - combatTargets = entities.getCombatTargets(player) // 敵 + 自機以外の生存中の全自機
    - targeter.handleTargetSelectKey(input, combatTargets, project) // [T] キー。右クリックとは無関係、独立の即時選定・順送り
    - navTarget.updateCombatBasePicking(entities, input, project) // mapActions より先に呼ぶ。基地に当たった右クリックだけを消費し、外れは false を返して mapActions へ回す
      - pickNearest(entities.bases) → baseMenu.open() // 当たった場合のみ。航法ターゲット設定/解除メニュー(ContextMenu のまま)
    - mapActions.handleCombatRightClick(input, combatTargets, project, simTime) // マップの handleRightClick の戦闘ビュー版(同じ対象は常に同じ窓)
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
  - floatingOrigin = new FloatingOrigin(cameraSystem.activeCameraPos, player?.state.v ?? v3()) // r=アクティブカメラのECI位置(update フェーズの cameraSystem.update() で確定済み)、v=自機速度(艦が無ければゼロ)。以降の sync 系はこの fo だけを参照する
  - { displayTime, simTime } = displayWindow // displayTime は未来ゴーストのスライダーが立っている間だけ先の時刻、simTime は積分後の simulator.simTime と一致する値
  - attractors = displayWindowManager.attractorsAt(simTime) // 解析天体 + 重力を持つ生存中の GameEntity(小惑星)の合流窓。EntityManager.cleanup へ渡す表面到達判定用の配列(解析天体のみ)とは別物
  - cameraSystem.sync(floatingOrigin) // 最初に呼ぶ: 後続の sync とマーカー投影が今フレームのカメラ行列を読む
    - syncCameraToViewpoint(active.camera, active.viewpoint, fo) // active = overviewMode ? overviewCamera : combatCamera。両カメラの viewpoint→THREE.PerspectiveCamera 反映はここ一箇所
    - viewOptionsPanel.setVisible(overviewMode) + setBodyClassToggles(bodyClassToggles) // 表示パネル。点灯反映は overviewMode のみ(天球グリッドセクションはボタン自身が押されるたび自分の on を反転するので、per frame の押し出しは無い — Navball.setGridVisibility() は construct 時に1回だけ)
    - focusMarkers.syncLabels() → markerManager.setPosition() // ラベルごと。overviewMode のみ
    - focusMarkers.hideLabels() // !overviewMode のみ
  - project = cameraSystem.activeCameraProjection / overviewMode = cameraSystem.overviewMode // 以降の sync 系へ配る共通値
  - visibilityPolicy = overviewMode ? mapPickables.visibilityPolicy : null // ここでは組まず、update フェーズの mapPickables.refresh() が確定させた同じ MapVisibilityPolicy を読む。environment.sync / entities.syncPlayers・applyVisibility・syncMarkers / activeStage.sync / targeter.sync・syncTargetMarkers がすべてこれを受け取る
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
    - syncStars() // starsMesh をカメラへ追従、overviewMode でさらに拡大
    - syncReferenceLines(simTime, fo, overviewMode, focus, toggles) → geoLine.sync() + [referenceLines の各 OrbitLine ごと] showsReferenceLine(id, focus, toggles) が true のときだけ line.sync(orbitElementsFor(id, simTime), …)、false なら null 渡しで非表示 // !overviewMode では全線 null。惑星線は常時、衛星線は focus がその衛星系(地球系除く)を指すときだけ show
    - celestialGrid.sync() // navball.gridVisibility の6トグルと overviewMode に応じたスケールを反映
  - entities.syncPlayers(player, fo, cameraSystem, activeStage.isPlaying, isPaused, displayTime, ephemeris, attractors, visibilityPolicy) // 全自機ごとに ship.syncPlayer(...) を呼ぶ。方向マーカー・ボアサイト・ガンサイトズームの隠れは isActive(=ship===player)の艦だけ
    - ship.syncPlayer(fo, cameraSystem, phasePlaying, paused, displayTime, isActive, ephemeris, attractors, visibilityPolicy?.entity('player', isActive))
      - displayState(displayTime) // current.at または predicted.at。null なら obj.visible=false のみで以下は現在状態のまま
      - obj の position / quaternion / visible // displayState 基準(未来ゴースト表示中は将来位置)。ガンサイトズームで隠れるのは isActive の艦だけ
      - thrustEffects.sync(this.thrust, maxAccel, ...) → sfx.setThrust(firing)(isActive のみ) + core/outer の sync() or hide() // this.thrust は PlayerThrottle/PlanExecutor どちらが立てても同じ。displayState(displayTime) ?? this.state。displayState が null なら visible=false 扱いで呼び自分で隠れる
      - rcsEffects.sync() → sfx.setRcs(rotating) + puff の sync() or hide() ×4 // 同上
      - belt.sync() // 引数なし。各リンクの position/quaternion を平行移動+ツイストから導出するだけで、表示可否は playerObj(obj.visible)の可視性に従う
      - radiator.sync() // ヒンジ Group の rotation.y へ展開角を書く
      - reentryEffects.sync() // qdyn が REENTRY_GLOW_MIN_Q 未満、または !visible なら隠すだけ
      - [isActive] markers.sync(currentState, displayState, ..., project, scale) // 自機由来の HUD マーカー(方位・ボアサイト・▲)。操作対象の艦だけが出す
        - [overviewMode] 戦闘用7キーを hide + displayState があれば headingDeg(displayState.r, displayState.v) → markerManager.setPosition('self', 'mk-self', '▲', rotationDeg) / 無ければ hide('self')
        - [!overviewMode] hide('self') + syncOrbitAxes(currentState) // pro/retro/nrm/anm/radout/radin。常に現在状態
        - [!overviewMode] syncBoresight(currentState) → setDirection('bore') // 常に現在状態、無条件に描画
      - orbitLine.sync() → regenerate() // 中心天体は毎フレーム strongestAttractor(state.r, ephemeris.attractorsAt(state.t)) で導出(地球固定ではない)。要素が閾値以上ドリフト or 推力中(force) or 初回のみ再生成。現在状態基準(要素は時刻に依らない)
  - entities.sync(fo, displayTime) → entity.sync(fo, displayTime) // 敵・弾・薬莢・デブリ・補給それぞれ(Bullet は速度方向を向く別実装)。自機(全隻)は含まない — 各艦は syncPlayers() が個別に同期済み。
    displayState が null(predictsFuture=false の種別が未来表示中、または予測ホライズン超過)なら visible=false
    - 続けて弾本体/弾ハロー/プラズマ弾/薬莢/破片(fragment、バリアントごとに1本)の各 InstancedPool を beginFrame → (bullets/casings/debris ごとに obj.visible を見て push) → endFrame。Group(本体+ハロー)を持つ通常弾は obj.updateMatrixWorld() で子まで連鎖更新してから両プールへ push。fragment は debrisFragmentPools[fragmentVariant] へ fragmentColor(per-instance color)付きで push
  - entities.applyVisibility(visibilityPolicy, player, overviewMode, fo, camera, attractors) // 天体クラス別トグルに応じた自機・敵・弾薬・基地のメッシュ表示/軌道線表示。visibilityPolicy が null(戦闘ビュー)のときは非表示扱いを一切かけない
    - [visibilityPolicy] 自機・敵・弾薬・基地それぞれ、その種別の category が admit しなければ obj.visible=false
    - 自機・敵・基地それぞれ orbitLine.setDisplayEnabled(!overviewMode || visibilityPolicy が admit する orbit) // マップビューのみトグルの対象、戦闘ビューは常に表示
    - [entities.bases ごと] base.syncOrbitLine(overviewMode, fo, camera, attractors) // 中心天体は strongestAttractor(base.state.r, attractors)。マップビューのみ、それ以外は null を渡して線を消す
  - entities.syncMarkers(project, scale, displayTime, overviewMode, player?.state.r ?? null, visibilityPolicy) // ammos/bases の各 marker?.sync。displayState(displayTime) → [overviewMode] headingDeg(ds.r, ds.v) → set('entity-<id>', 'mk-ammo'|'mk-base', '▲', rotationDeg) / [!overviewMode] set('entity-<id>', 種別ごとの字形) + setBearing('entity-<id>-bearing')。ラベルは name + viewerPos があれば距離
  - effects.sync(fo, camera) → flashEffectManager.syncFlashEffects()
    - pool.beginFrame() → (生存中のフラッシュごとに transform へ位置/スケール/カメラ正対回転を書き、color = baseColor×opacity で push) → pool.endFrame() // 寿命・移流は update フェーズで済んでいる
  - [player] targeter.sync(fo, player, combatTargets, overviewMode, project, camera, attractors, visibilityPolicy) // ターゲットに紐づく表示物をまとめて
    - syncOrbitLine(fo, player, combatTargets, overviewMode, camera, attractors, visibilityPolicy) // 各線の中心天体は対象ごとに strongestAttractor(target.state.r, attractors) で導出
      - [combatTargets ごと] t.syncOrbitLine(showGray, fo, camera, attractors) // showGray = overviewMode かつ生存かつ第一・第二どちらでもない かつ visibilityPolicy が admit する orbit
      - orbitLine.sync() // 第一ターゲット軌道線(オレンジ)。visibilityPolicy が admit しなければ null を渡して消す
      - secondaryOrbitLine.sync() // 第二ターゲット軌道線(シアン)。同上
    - syncBoardMarkers(project) // 的通過マークの表示(スロットごと)。第一ターゲットのみ
    - syncTargetDirMarkers(player, overviewMode, project) // ◇/◆ tgtdir/atgdir。overviewMode or 第一ターゲット無しなら hide。第一ターゲットのみ
  - targeter.syncTargetMarkers(player, combatTargets, displayTime, simTime, overviewMode, project, cameraSystem.activeCameraScale, visibilityPolicy) // 位置は機体メッシュと同じ displayState 基準
    - [combatTargets ごと] displayState(displayTime) → visibilityPolicy が admit する pickable のみ → markerItem(role, viewerPos, pos, vel, overviewMode) // role は第一/第二/なし。overviewMode で hpMarkerSvg()/headingHpMarkerSvg() を切り替え。displayState が null な対象はここで除外(マーカーごと落とす)。visibilityPolicy が icon/label を落としていれば sym/name/detail を空にする
    - markerManager.combatMarkers.sync(items, project, overviewMode, scale) // 生存かつ displayState を持つ対象の markerItem() 集合を受ける(まとめは1体では決まらない)
      - groupNearby() // 画面上で近接するものをクラスタ化し、代表以外のラベルを落とす
      - [overviewMode] headingDeg(item.pos, item.vel) → rotationDeg // 対象ごと。円軌道での進行方向を示す
      - markerManager.set() + markerManager.setBearing() // 対象ごと。overviewMode 以外で画面外なら画面端の方位マーカー▲へ
      - retire() // 前フレームに出したキーのうち集合から消えたものを remove(対象ごとに増えるキーなので DOM ごと捨てる)
    - [player] markerManager.leadMarkers.sync(player, aliveScratch, aliveTarget, aliveSecondaryTarget, simTime, overviewMode, project) // 対象ごとの LEAD マーカー。overviewMode なら全 remove して return
      - trackTargeted() // 最終ロック時刻を生存中の対象ぶんだけ作り直す
      - leadPoint() → markerManager.setPosition('lead-<name>') // LEAD_HOLD_SEC 以内 かつ 解がある対象ごと
  - navTarget.sync(project, overviewMode, cameraSystem.activeCameraPos) // ▲/▽ nav-an/nav-dn マーカー。navTarget.update() が求めた位置があれば表示、無ければ hide。[overviewMode かつ isOccluded] も hide
  - entities.syncEquatorNodes(project, overviewMode, cameraSystem.activeCameraPos) // all() を回して各 equatorNodes?.sync。△/▽ eqan-*/eqdn-* マーカー。show=overviewMode。sync は置いた交点を捨てるので、このフレームに update されなかったペアは自動的に隠れる。[show かつ isOccluded] は hide
  - displayWindowManager.sync(player) // PREDICT パネル(期間ピル/スクラバー/目盛り)の表示/内容を押し出す。自機の predictedTrajectory.state.t が current(simTime, duration)のどこまで届いているかの割合(0..1、自機/予測/表示期間のいずれかが無ければ 1)も内部で求めて渡す
    - panel.render(state) // visible(=!forceCurrent)・期間ピル・スクラバー(段階数/つまみ位置/未予測区間の減光)・絶対日時/T+ラベル・目盛りを1回でまとめて押し出す。編集中(任意期間フォーム・T+ジャンプフォームを開いている)行は再描画をスキップし、入力中の値を壊さない
  - editor.sync(cameraSystem.overviewCamera.dist, simTime, fo, project, cameraSystem.activeCameraScale, overviewMode, cameraSystem.activeCameraPos, cameraSystem.activeCamera)
    - [visiblePlan !== null] planDisplay.sync(fo, project, scale, overviewMode, cameraPos)
      - path.setVisible(plan.nodes.length > 0) // ノードの無い計画は自機の現在軌道そのものを描くだけなので折れ線を隠す
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
    - [visiblePlan === null] planDisplay.hide()
    - [plan !== null かつ editMode] syncGizmo(plan) → nodeGizmo.sync() // ノードハンドル + 選択中ノードの Δv アーム6個
      // ↑ planDisplay.sync の後で呼ぶ: ノードの画面座標は path の今フレームの表示文脈を通す
    - [plan !== null かつ editMode] syncPanel(plan, simTime) // ノード一覧・選択中ノードの Δv と噴射後要素を組み立て、panel.sync(nodes, selEl, localDv, ...) → PlanPanel.sync() で軌道計画パネルの HTML へ反映(HoldButton ×6 は PlanPanel.dvButtons、updateEditing がここ経由で読む)
  - mapActions.sync(simTime, attractors, player) // 軌道オブジェクトウィンドウ。overviewMode は引数ではなく内部で cameraSystem.overviewMode を読む。overviewMode の間は常設表示で mapPickables.pickables を行として書き出す
    - objectListPanel.sync(pickables, focusId, parentOf) // 区画の選別・並べ替え・親子構造(Section.order)は、それを決める入力が変わったフレームか、保持している順序が今フレームの値で整列条件を満たさなくなったフレーム(距離順)にだけ組み直す。行の値(距離・詳細)と見出しの件数は毎フレーム書く
    - 開いている各プロパティウィンドウ // isTargetGone(target) が真なら closeWindow()(player は findPlayer(id)===undefined、すなわち entities.players からの存在有無で見る。ship/ammo/base は実体の alive を直接見る。displayState が null なだけの休止フレームでは実体自体は残るので閉じない。天体/アプシス/AN-DN は mapPickables.pickables に載っているかで判定) — 残れば target を pickables の最新値へ更新し、buildRows() → w.syncRows() / windowItems() → w.syncItems()
  - frameControls.sync(mapPickables.pickables, cameraSystem.activeCameraPos, attractors, simTime, overviewMode) // 座標系パネル。!overviewMode なら非表示にして return
    - [overviewMode] members = systemMembersAt(ephemeris.registry, cameraPos, attractors) // 4ゾーン共通の「いまカメラがいる系の天体列」を1回だけ導出
    - [overviewMode] cameraZone.setItems(pickables) / setNearby(members, pickables) / setSelected(focusTargetId(overviewCamera.focus)) // カメラの固定先(全候補プルダウン + いまいる系のクイックボタン)
    - [overviewMode] cameraRotationZone.setNearby(members) / setSelected(overviewCamera.cameraFrame.rotatingWith)
    - [overviewMode] translationZone.setItems(pickables) / setNearby(members, pickables) / setSelected(displayWindow.frame.center) // 未来表示(計画折れ線・予測軌道線・交点マーカー)の描画座標系の原点
    - [overviewMode] planRotationZone.setNearby(members) / setSelected(displayWindow.frame.rotatingWith)
  - entities.syncPlayerTrajectoryLines(player, displayWindow, overviewMode, ephemeris, fo, cameraSystem.activeCamera, attractors) // 計画折れ線と同じ座標系(displayWindow.frame)で bake する
    - [entities.players ごと] ship.syncTrajectoryLine(ship === player, frame, simTime, ephemeris, fo, camera, attractors) // 操作対象艦だけ show=true。それ以外は trajectory=null で畳む
      - trajectoryLine.syncGeometry(show ? predictedTrajectory : null, simTime, null, frame, ...) // predictedTrajectory.samplesOldestFirst() を frame で bake(点列の参照が変わらない限り再bakeしない)。simTime は描画区間の下限で sampler の時刻写像だけを動かす — 線の先頭は predictedTrajectory を simTime で補間した点になる。上限は null(先端まで無制限)
      - trajectoryLine.syncTransform()
      - trajectoryLine.sync(camera) // 頂点2未満なら curve.clear()
    - [entities.players ごと] ship.orbitLine.setSuppressed(ship.supersedesAnalyticEllipse(simTime, duration, overviewMode)) // overviewMode: 予測が表示ホライズンを覆いきったときだけ解析楕円を抑制。!overviewMode: 予測線が描かれてさえいれば抑制
  - [player] touchControls?.syncModeButtons(rcsDamp, fineAttitude, progradeHold) // タッチデバイスのみ。制動/微動/ホールドの点灯
  - activeStage.sync(player, fo, project, scale, displayTime, overviewMode, visibilityPolicy, camera) // player は Creative の未配置状態で null
    - syncStatusPanel(player, overviewMode) // hudSubStatus() が文字列を返すステージだけ表示。player が null または overviewMode(showsStatusInOverview を宣言していないステージ)なら隠す
    - [CreativeStage] syncPreview(fo, project) // update が求めた preview の軌道線 + ▷ PREVIEW マーカー。preview が null なら両方隠す
    - [CreativeStage] placerPanel.setIssues(issues) // update が求めた issues を渡すだけ。前回と同内容なら panel 側が DOM に触らず即 return
  - hud.globalStatusBar.sync(game) // #hud-globalstatus。Game インスタンスを直接読む(narrow ctx を介さない常設パネル群の1つ)。MET は毎フレーム、時間加速/NODE WARP 残りは約10Hz(SYNC_INTERVAL_MS)にスロットル
  - hud.mapScaleBadge.sync(game) // #hud-map-scale。overviewMode のみ表示、フォーカス対象の深度における meters-per-pixel から縮尺バーを毎フレーム求め直す(スロットル無し)
  - hud.statusPanel.sync(game) // #hud-status。自機不在なら隠す(表示/非表示の切替は毎フレーム)。行の値(RCS制動/並進出力/微調整/進行方向ホールド/視点のRCS追従/弾薬)は約10Hzにスロットル
  - hud.orbitPanel.sync(game, attractors) // #hud-orbit。自機不在なら隠す、overviewMode でも畳む(切替は毎フレーム)。orbitInfo 由来の行(基準天体/高度/速度/AP/PE/INC/PRD/動圧/機体温度)は約10Hzにスロットル
  - hud.targetPanel.sync(game, attractors) // #hud-target。ロック中ターゲットの有無による表示切替は毎フレーム。relativeInfo 由来の行(名前/装甲/距離/接近速度/相対速度)は約10Hzにスロットル。軌道要素・相対傾斜角はここには無く、右クリックのプロパティウィンドウが持つ
  - hud.contactsPanel.sync(game) // #hud-enemies。自機不在なら隠す、overviewMode でも畳む(切替は毎フレーム)。撃墜数バッジ・waveId 集約済みの敵一覧は約4Hz(250ms)にスロットル
  - hud.tick() // ヒント/トーストのフェードアウト
  - guide.sync(player, simTime, editMode, project) // player の有無をここで問わず毎フレーム呼ぶ。内部で player.plan から引く
    - markerManager.hide('nd') + hide('burn') // player 不在・editMode・または直近ノードが無い場合
    - markerManager.setPosition('nd') + setDirection('burn') // 直近ノードがある場合
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
  `advance` の内部で `resolveCollision = simSpeed.canResolvePhysicalCollisions` が false になるため、
  `contactPhysics.resolveSubstep()`/`resolveBelt()` は丸ごとスキップされる(接触判定・弾命中を
  含む)。substep が長大になる高ワープでは弾もすり抜けるが、`canPlayerFire` が同じ閾値で発砲自体を
  止めているので実害は無い。
- **計画軌道 RK4 の作り直し**は `PlanPath.update` が区間ごとに問う
  `PlanArc.represents(state0, end, sourceRevision, apsisCenterId, tracksLiveAnchor)` で決まる。
  `sourceRevision`(重力源プロバイダの revision)/`apsisCenterId` が食い違えば即座に作り直す
  (`new PlanArc(...)` — constructor 内で end までの同期的な RK4 積分)。一致していても、積分済みの
  間引き間隔が今回の要求区間の求める間引き間隔([表示期間]を大きく縮めた直後など)を
  `PLAN_ARC_MAX_SAMPLE_COARSENING` 倍を超えて上回っていれば作り直す(クリック候補が飛び飛びの点に
  なるのを避けるため)。`state0` が同一参照(ノードを置いた後の区間の通常のフレーム。`end` だけが
  動く編集も含む)なら represents は真 — 実際に `end` が動いていれば `arc.setEnd(end)` が終端だけを
  動かす: 積分先端が要求終端にサンプル間隔未満まで届いていれば継ぎ足さず、届いていなければ現在の
  積分先端から続きを刻む(区間全体は作り直さない)。`tracksLiveAnchor`(計画が空のあいだの唯一の
  区間)では `state0` が自機を毎フレーム追従するため厳密一致では判定できない —
  `anchorJumped`(別艦への切り替え・ドック発進・衝突による状態上書きなどの非連続な差し替え)を
  弾いたうえで、直近の起点からの時刻の変化がサンプル間隔未満なら同じ軌道が時間方向に進んだだけと
  みなして represents は真のまま(setEnd による継ぎ足しだけで済む)。マップモード中でも大半の
  フレームは represents が真で `line.syncTransform()`(O(1) の剛体変換)だけで済む。
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
- **重力積分が使う配列は3経路(`Simulator.substep`/`Predictor.advanceBudget`/`PlanArc` の private
  `integrateTo`)とも同じ組み立て: 合流(`gravityBodiesAt` の解析天体 + 生存中の重力天体)→
  `classifyAttractors` → `attractorsNear`(問い合わせ位置の27近傍グリッド)。**
  `substep` はサブステップ中点で1回だけ合流・分類し、その結果をそのサブステップの全エンティティへ
  使い回す(処理順に依存した誤差を避けるため)。`Predictor` は各対象の予測先端の時刻ごとに
  `predictedAttractorsAt` で他の重力天体を引き直す(その時刻に達していない天体は落とす — 現在
  位置に凍結すると「その時刻に居ない場所」から引くことになるため)。`PlanArc` は生存中の重力天体を
  `updateMapPresentation` が組む `planAttractorProvider`(内部で `entities.attractors()` を1回求める)に
  固定したまま使い回す(区間長は最大1年に及び、そのあいだの位置を `EntityManager` には問えない) —
  `integrateTo` は constructor からの初回だけでなく `setEnd` からの継ぎ足しでも呼ばれうるが、その都度
  この固定値を読み直すだけで `dynamicAttractors` 自体を更新することはない。3経路とも `Ephemeris` の
  窓を直接書き換えず、常に新しい配列へ展開する。
- **HUD マーカーは持ち主の `sync` が自分で出す**。`MarkerManager` が own するのは、1つの対象では
  決められない2集合(`combatMarkers` = 画面上のまとめ、`leadMarkers` = 自機と敵の両方に依存)だけで、
  どちらも `game.sync` から直接は呼ばれない — `targeter.syncTargetMarkers` が自機・敵の対象集合
  (`entities.getCombatTargets`)を組んでから呼ぶ。赤道交点(EqAN/EqDN)は対象ごとに1つなので
  各 `GameEntity.equatorNodes` が持ち、`entities.syncEquatorNodes` が `all()` を回して出す。
  残りのマーカーは `player.syncPlayer` / `targeter.sync` / `navTarget.sync` /
  `activeStage.sync` / `cameraSystem.sync` / `editor.sync`(→ `planDisplay`) / `guide.sync` の中にある。
  **`markerManager.resolveCollisions()` だけは全マーカーが出揃った後に一度だけ**呼ぶ必要があるため
  `game.sync` の末尾に置く。
- **`mapPickables.refresh()` は `game.sync` ではなく `game.update` → `updateMapPresentation` の中、
  `cameraSystem.update` を呼ぶ直前(物理積分の後)に呼ぶ**。積分前に組むと、被選択物や navTarget の
  AN/DN の座標が、同じフレームで `sync` されるメッシュに対して1ステップぶん古くなる(ワープ倍率が
  高いほど無視できない)。フォーカス解決(`overviewCamera.update`)も右クリック判定
  (`mapActions.handleRightClick`)もどちらも `update` フェーズの仕事なので、`sync` を待つ必要はない。
  天体ラベル(`focusMarkers`)と AN/DN(`navTarget`)、EqAN/EqDN(各エンティティの `equatorNodes` —
  出す対象を選ぶ側がそれぞれ `update` を呼ぶ: 操作艦は `editor.update`、戦闘ターゲットは
  `targeter.updateEquatorNodes`、基地は `entities.updateBaseEquatorNodes`、航法ターゲットは
  `navTarget.update`)の座標も候補列の一部なので、
  `refresh()` の先頭で両方を求め直す。`sync` 側(`focusMarkers.syncLabels` / `navTarget.sync`)は
  その値をマーカーへ置くだけで、座標を求め直さない。
- **`environment.update(displayTime, cameraSystem.overviewMode)` は `updateMapPresentation` の
  最初(`editor.update` より前)、毎フレーム1回呼ぶ**。小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・
  散乱円盤の点群(`PointFieldView`)の位置を群ごとにラウンドロビンで再評価するだけで、
  `mapPickables.pickables` には一切寄与しない(点群はピック対象でも重力源でもない表示専用)。
  `!overviewMode` では即 return するので、コンバットビューでは実質無視できるコスト。`sync` 側は
  `environment.sync` の中で `pointFieldView.sync` を呼ぶ——`update` が引き直した点も引き直して
  いない点も含め、浮動原点の移動ぶんだけ全インスタンス行列を毎フレーム書き直す。
- **`game.sync` は `dt` を受け取らない**。sync フェーズには進めるものが無い、というルールを
  シグネチャで見えるようにしてある。HUD パネルの書き換え間引きのような表示側の周期は
  `performance.now()` の期限で持つ。
