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
  - game.sync()
  - game.render()
  - perf.record() // `?perf=1` のときのみ(PerfMeter が DOM にフレーム時間・エンティティ数を出す)

---

## game.update(dtRaw)

- game.update(dtRaw)
  - input.update() // pending キュー(キー/クリック/マウス)を今フレーム分に確定し、次フレーム用にクリア
  - handleInput() // 担当モジュールへ先着順に配る。処理した側が input からそのキーを消費する
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
    - docking.handleInput() // ドック表示中の [ESC] を先に消費する(設定画面と二重に効かせない)
    - viewManager.handleInput() // ビュー遷移はすべて setView() を通る
      - setView('combat') // !isPlaying のみ(死亡/終了時にドック・マップを強制的に閉じる)
      - [current==='dock'] 何もせず return // [M] は消費もしない
      - setView(current==='map' ? 'combat' : 'map') // [M]。canToggleView かつ isPlaying のみ
        - [出るビューが dock] docking.leaveDock() → dockView.close() + game.resume()
        - [3D 側ビューが map→他] editor.onMapClosed() / editor.closeMenu() / mapPicker.close()
          - onMapClosed: hidePanel / hideGizmo / plan.removeNode(末尾の Δv 微小ノードを間引く) / selectedNodeIdx=null
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
  - [game.isPaused] 以降を実行せず return するポーズ経路 // 決着後の簡略経路より前。ポーズ中は決着後も完全に止まる
    - editor.update(simTime, displayTime) // 計画折れ線の再積分とアプシスアイコン(mapPicker.refresh より前)
    - mapPicker.refresh() // 天体ラベルと AN/DN を求め直してからこのフレームの被選択物一覧を組む
      - focusMarkers.update(displayTime) // 地球・月・太陽・両系のラグランジュ点の座標を表示時刻で求め直す
      - navTarget.update() // 自機軌道要素 + navTarget.id から相対 AN/DN を求め直す。ポーズ・決着に関わらず毎フレーム
      - mapPicker.pickables に反映 // 天体ラベル + 生存中の entities.players('player')・敵船('ship')(displayState 基準)+ navTarget.mapPickables() + planDisplay.apsisMarkers を集約
    - [editor.editMode] editor.handleMapPointer() // [!hasPlan(=ship===null)] 内部で即 return(艦のいない detachedPlan は編集させない) / mapPicker.handleRightClick() / editor.updateEditing()
    - cameraSystem.update(..., mapPicker.pickables) // ポーズ中も視点更新は続ける
  - [game.player === null] 以降を実行せず return する未配置経路 // Creative の開始直後・全艦喪失時。残骸や弾の epoch は進め続ける
    - simSpeedManager.update() / applyWarpCommandPolicy()
    - simulator.stepSimulation(player=null)
    - predictor.update(player=null)
    - activeStage.update(player=null) // Creative の配置プレビューはここで求め直す(艦が無い間こそ配置中なので飛ばせない)
    - effects.update(dt, simDt)
    - editor.update() / mapPicker.refresh() / cameraSystem.update() // 内容は上記ポーズ経路と同じ
    - [editor.editMode] mapPicker.handleRightClick() / editor.handleMapPointer() / editor.updateEditing()
  - [!activeStage.isPlaying] 以降を実行せず return する簡略経路
    - player.thrust = null / player.torque = v3() // 勝敗確定時の推力を凍結させない
    - simulator.stepSimulation(bulletCollision=false, resolveCollision=false, doSubstep=false) // simSpeed は ×MAX_PHYS_SIM_SPEED で打ち止め
      - simulationSubStep() ×1 → entity.stepSim() エンティティごと + player.thermal.updateThermal()
      - stepAttitudes()
    - nanWatchdog.checkAll('stepSimulation(決着後)') // 通常経路と同じく積分の直後に一度
    - entities.cleanup() // 決着後もワープで時間は進むので、通常経路と同じ位置で回収する
      // Enemy.checkLoss/Player.checkLoss 経由で recordEnemyDeath/recordPlayerLost が走り得るが、
      // 両方とも isPlaying でガードされているので決着後に既存の phase を上書きすることはない
    - effects.update(dt, simDt) // 決着直後の爆発を止めないため、簡略経路でも寿命を進める
    - editor.update(simTime, displayTime) // 内容は上記ポーズ経路と同じ
    - mapPicker.refresh() // 内容は上記ポーズ経路と同じ
    - cameraSystem.update(..., mapPicker.pickables) // 決着後も追従を続ける(sync は止まらないため、飛ばすと視点が絶対 ECI に取り残される)
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
    - throttle.updateTorque() → player.torque へ代入。!alive なら即ゼロ
      - onProgradeHoldReleased() → hud.hint() // ホールド中に手動回転入力があった場合のみ
      - autoAlignTorque() // ホールド中 かつ 手動回転入力なしの場合のみ
    - radiator.update() // 展開度のみ。THREE には触れない
    - sunlitFactor() // 地球影による日照率
    - thermal.setRadiatorLoad(radiator.radiatingArea(), radiator.solarLoad())
      // このフレームの全サブステップの updateThermal がこの値を使う
    - player.radius = radiator.hitRadius() // 展開度に応じて被弾判定が広がる
    - power.update() // sunlit/sunDir は radiator と共有。THREE には触れない
    - [!player.alive] player.thrust = null して return
    - hpRegen()
    - [editor.editMode] fire.tickMapMode() → tickReloadTimer() / player.thrust = null して return
    - fire.updateFireState()
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
    - throttle.updateThrustState() → player.thrust へ代入
      - sfx.setThrust(false) // 推力入力なし or !canPlayerThrust
      - sfx.setThrust(true) // 推力あり
    - invalidatePrediction() // player.thrust !== null のときのみ(自機の噴射結果を即座に予測へ反映)
  - nanWatchdog.checkPlayer('player.behave')
  - activeStage.update() // 具体ステージへディスパッチ。!isPlaying / 艦が無ければ即 return
    - behaveAllEnemies() // 敵を配置する具体ステージ(Stage0/00/1/2)が先頭で呼ぶ
      - enemy.behave() // 生存中の敵ごと(canEnemyFire・距離・バースト状態の判定は behave 内部)
        - firePlasma() → entities.addBullet()
    - [Stage0 訓練スコアアタック] logistics.updateLogistics(respawnOnDespawn=false)
    - [Stage0 訓練スコアアタック] timer.update()
      - setPhase('timeup') + showScoreAttackResultScreen() // 制限時間到達フレームのみ
    - [Stage00 無限サバイバル] logistics.updateLogistics(respawnOnDespawn=true)
      - absorbNearbyAmmo() // player.alive のみ
        - player.onPickup() + sfx.pickup() + hud.hint() // 範囲内の補給ごと
      - despawnFarAmmo()
        - spawnForPlayer() // 遠方消滅した数だけ再投入。生存数が MAX_AMMO に達したら打ち切る
      - spawnForPlayer() // LOGISTICS_CHECK_INTERVAL ごと、かつ低弾薬・上限未満のみ
    - [Stage00 無限サバイバル] updateWaitingForAmmoPhase() → hud.toast() // 弾薬確保でフェーズ遷移した時のみ
    - [Stage00 無限サバイバル] updateSpawningEnemiesPhase() → spawnWave() // カウントダウン満了時のみ
    - [Stage00 無限サバイバル] updateActiveCombatPhase()
      - despawnOutOfRangeEnemies() → enemy.despawn() // 圏外の敵ごと(alive=false + recordEnemyDeath(cause='despawn'))
      - spawnWave() + hud.toast() // 間隔・同時展開上限を満たす場合のみ
      - spawnWave: generateWave() → addEnemy() → entities.addEnemy() + scoreCounter.recordSpawnEnemy()
        - generateWave: pickWaveCenter() → makeFlybyVelocity() → limitFlybyDv() → waveShipPosition() ×機数
    - [Stage1 / Stage2 キャンペーン] logistics.updateLogistics(respawnOnDespawn=false)
    - [CreativeStage] advanceFollowPlan() // entities.players のうち followPlan=true な艦ごと。plan.dropNodesBefore(simTime) が期限切れノードをまとめて取り除いて返す最後のノードへ state を置き換える(複数ノードを跨いだフレームも dropNodesBefore 内部の while で一括消費)
  - nanWatchdog.checkPlayer('activeStage.update')
  - simSpeedManager.update() // 自動ワープ中のみ実効。残り時間が C.NODE_APPROACH_LEAD 以下なら autoWarpUntil=null + levelIdx=0 で即 return
  - simulator.stepSimulation(bulletCollision=true, resolveCollision=canResolvePhysicalCollisions, doSubstep=true)
    // 弾命中・剛体接触・姿勢積分はいずれもこの中。simulator が hitSystem / collisionPhysics を所有する
    - [サブステップごと] ×ceil(simDt / SUBSTEP_MAX_DT) // 分割数は simDt のみで決まる(実 fps に依存しない)
      - simulationSubStep()
        - entity.stepSim() → ephemeris.attractorsAt(state.t + dt/2) → current.step() → stepDynamicsRK4()(history 記録)
          // 自機(全隻)・敵・弾・薬莢・デブリ・補給・基地それぞれ、個体ごと。alive のみ実行。全天体重力 + J2 + 大気抵抗(bcInv)+ 自身の thrust
        - player.thermal.updateThermal() // 操作対象のみ(HUD 警告を出すため)
      - hitSystem.checkBulletHits() // bulletCollision=true のときだけ。サブステップごと
      - target.attacked() // 弾が命中した対象ごと
        - [Enemy.attacked]
          - scoreCounter.recordHit()
          - hitEffect() // 被弾後も hp>0
            - sfx.hit() / fx.spawnPlasmaFlash() or fx.spawnBulletFlash() / fx.scatterFragments()
          - activeStage.recordEnemyDeath(cause='killed') // hp<=0
            - scoreCounter.recordKill() + hud.hint()
            - unlockManager.reportClear() // isPlaying かつ checkWin() が true になった場合のみ
            - onWin() → showWinScreen() // 同上(Stage0/00 は no-op override)
          - destroyEffect() → sfx.explosion() + fx.spawnShipDestroyEffect() // hp<=0
        - [Player.attacked]
          - thermal.addImpactHeat() // 常に
          - radiator.damageFromHit() → radiatorBreakEffect() // このフレームで新たに全損したパネルがあれば
          - hitEffect() // hp>0
          - activeStage.recordPlayerLost() → showResultScreen() // hp<=0
          - destroyEffect() // hp<=0
    - collisionPhysics.resolve() // resolveCollision のみ(高ワープ時はスキップ)。サブステップ後に1回、実 dt で
      - player.belt.collisionSections() // player.alive && dt>1e-6
      - resolveCollisionPairs()
        - resolveCollisionPair() → 双方の state へ代入 // 貫入している衝突ペアごと
        - onPlayerCasingImpact() → sfx.clank() // 自機-薬莢の接触時のみ
        - onHighSpeedImpact() // 反発した接触速度が COLLISION_DAMAGE_MIN_SPEED 以上のペアのみ
          - player.collidedAtSpeed() / enemy.collidedAtSpeed() // game.ts が自機-敵機のペアだけを通す
            - applyCollisionDamage() → hp へ代入
            - sfx.clank() + fx.spawnGasPuff() // hp>0
            - activeStage.recordPlayerLost() / recordEnemyDeath(cause='killed') + destroyEffect() // hp<=0
      - player.belt.applyCollisionSections() // player.alive && dt>1e-6
    - stepAttitudes() → stepAttitude() → entity.att へ代入 // 自機(全隻。simDt をそのまま使う)・敵・薬莢・デブリ・補給(attDt = min(simDt, 0.12))それぞれ
    - lastSimDt = simDt
  - nanWatchdog.checkAll('simulator.stepSimulation') // 全エンティティ走査。検出済みなら何もしない
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
  - predictor.update(simTime, player, canGrow, horizon) // cleanup の後(死んだ個体を予測しない・積分後の実状態と突き合わせる)。canGrow = simSpeedManager.canGrowPrediction、horizon = displayTimeManager.durationSec(game.currentOrbitPeriod())。currentOrbitPeriod() は自機の現在軌道を strongestAttractor 周りで求めるだけの純計算(自機なしなら NaN)。視点/モードによる分岐なし
    - resyncPrediction(simTime, attractors, horizon) // entities.all() の全対象、毎フレーム無条件(canGrow が false でも省略しない — 実状態は動き続けるので、乖離した予測列を放置すると無関係な軌道が描かれ続ける)。attractors は simTime ぶんを1回だけ引いて全対象で使い回す
      - invalidatePrediction() // predicted.at(simTime) が実位置から許容量を超えて乖離、または区間外のときのみ。許容量は PREDICT_RESET_DIST を下限に、保持サンプルの間引きが粗いぶんの補間誤差まで広げる
    - [canGrow] advanceBudget(player, ...) // 予算 PREDICT_STEP_BUDGET を操作対象の艦優先で消費。ループも dt・重力源の決定(ephemeris.attractorsAt(tip.t) → localOrbitPeriod / PREDICT_STEPS_PER_REV、horizon / PREDICT_MAX_STEPS で頭打ち)も Predictor 側が持つ(stepSim に対する simulationSubStep と同じ分担)。predictsFuture=false の個体は消費 0 で即 return
      - player.stepPrediction(attractors, simTime, dt, horizon) // ホライズン超過・打ち切り済み・推力中のいずれかで false を返すまで、dt・attractors を都度計算し直しながら1ステップずつ繰り返し呼ぶ
        - predicted.step() // 呼び出し側が確定させた attractors で1ステップ積分
    - [canGrow] advanceBudget(entity, ...) // 残り予算を entities.all() 上のカーソル位置から1周ぶん配る(player を除外しないので同じフレームで二重に予算が付き得る)。entity.stepPrediction() が最初から false(predictsFuture=false/推力中/truncated)なら消費 0 で次へ即進む
  - effects.update(dt, simDt) → flashEffectManager.updateFlashEffects() // フラッシュの寿命と移流。ポーズ中は呼ばれない(=止まる)
  - guide.update(plan, player, simTime, editMode, ephemeris.attractorsAt(simTime)) // trackAnchor より前に置く: 最後のノードが落ちたフレームからアンカーを自機へ追従させるため
    - [editMode または !player.alive] 即 return
    - plan.dropNodesBefore(simTime - C.NODE_EXPIRE_GRACE) // 期限切れノードをまとめて落とし、最後に落ちたノードを新しいアンカーに据える
    - [直近ノードが実行の窓(node.t - C.NODE_APPROACH_LEAD)に入っている場合のみ]
      - notifyApproach() → hud.hint() // ノードごとに最初の1回のみ(approachNotified との同一性比較)
      - notifyAchieved() // orbitClose(自機軌道要素, 目標軌道要素) が真の場合のみ
        - hud.hint() + sfx.warp() // ノードごとに最初の1回のみ(achievedNotified との同一性比較)
  - editor.plan.trackAnchor() // ノードが0件のときだけ実効(1件目を置くとアンカーは凍結される)
    - editor.update(simTime, displayTime) // 被選択物候補にアプシスアイコンが入るので mapPicker.refresh より前
    - planDisplay.update(plan, simTime, displayTime, show) // show = hasPlan(=ship!==null) && (editMode || plan.nodes.length > 0)
      - traj.update() // plan の corners を区間へ分解し、区間ごとに PlanArc を再積分。表示座標系と un-bake 時刻もここで確定
        - arc.update() // 区間ごと。(state0, end) が変わったときだけ OrbitEntity で RK4 積分し直す(重い)
      - ghostAt(displayTime) // 折れ線が displayTime に届かなければ null
      - apsisIconsOf() // 最終区間の起点要素から解析的に算出。離心率 < APSIS_MIN_ECC なら空、双曲線なら Pe のみ
  - mapPicker.refresh() // 物理積分の後に組む — 積分前だと同フレームで sync されるメッシュと被選択物の座標が1ステップずれる
    - focusMarkers.update(displayTime) / navTarget.update() // 内容は上記ポーズ経路と同じ
  - cameraSystem.update(mapPicker.pickables) // 追従カメラの基準を積分後の自機位置に合わせるため、物理積分の後に呼ぶ
    - combatCamera.toggleFollowAttitude() // K.followAttitudeToggle。カメラ自身の状態なのでここで消費する
    - keyYaw/keyPitch/keyRoll をキー入力からまとめる // cameraRollLeft/Right は Numpad0/Numpad1
    - overviewCamera.update(..., mapPicker.pickables) // cameraSystem.overviewMode のみ。focus を mapPickables から引き直し、結果を自身の view へ書く
    - combatCamera.update() // !overviewMode のみ
      - zoomActive = K.gunsightZoom 押下 // combatCamera 自身のフィールドへ書く(overviewMode 中はこの update 自体が呼ばれないため更新されない — CameraSystem.zoomActive の !overviewMode ガードが読み替えを担保する)
      - gunsightCamera.update() // player.alive && zoomActive。結果を自身の view へ書く
      - chaseCamera.update() // それ以外。camFollowAttitude && player.alive のときだけ player.att.q を rot に合成し、鍵/ドラッグ/ロール入力を回転として適用。結果を自身の view へ書く
      - 選ばれた view.fovDeg から combatCamera 自身の view.fovDeg を指数補間
  - [editor.editMode] 計画編集モード
    - editor.handleMapPointer() // [!hasPlan] 即 return。右クリック → 左クリックの順に受ける
      - handleNodeRightClick() // 右クリックごと。ノードをヒットしたぶんだけ消費する
        - selectedNodeIdx = ヒットしたノードの idx + nodeGizmo.openMenu() // ヒット時。true を返して消費
      - handleMapClick() // 左クリックごと。常に消費する
        - selectedNodeIdx = idx + sfx.warp() // 既存ノードをヒットした場合
        - planDisplay.traj.nearestSample() → plan.addNode() + sfx.warp() // 計画軌道上をヒットした場合
        - selectedNodeIdx = null // どちらにも当たらなかった場合
      - dragNodeToNearestSample() // ノードを incoming arc の最寄り点へ移し、元のΔv成分を保ったまま新しいノード状態へ焼き直す
    - mapPicker.handleRightClick() // ノードに消費されずに残った右クリックだけが届く
      - pickNearest(mapPicker.pickables) // MAP_PICK_PX_SQ 以内の被選択物(天体/自機/敵船/nav-AN・DN/アプシス)を最寄りで拾う。候補列は mapPicker.refresh() が組んだ1本
      - mapPicker のメニューを開く // 拾えた場合のみ消費。選択結果は MapPicker.run(act, target) へ
        - act='focus' → overviewCamera.focus 代入
        - act='navTarget' → navTarget.toggleTarget()
        - act='warp' → simSpeedManager.startAutoWarpTo(navTarget.passTimeOf(target.id))
        - act='addNode' → editor.addNodeAt(planDisplay.apsisTimeOf(target.id) または navTarget.passTimeOf(target.id))
        - act='activate' → entities.findPlayer(target.id) → setActivePlayer(ship) // 'player' のみ。id が現存する艦を指さなくなっていたら何もしない
          - player = ship / cameraSystem.setActivePlayer(ship) → combatCamera.setActivePlayer(ship) → chaseCamera.setPlayer(ship) // rot/dist は据え置き
          - editor.setActivePlayer(ship) → ship 差し替え / selectedNodeIdx = null / closeMenu() // 以後 editor.plan は ship.plan を指す
          - targeter.clearTargets() // 切替前の艦が握っていたロックを持ち越さない
        - act='followToggle' → entities.findPlayer(target.id) → ship.followPlan を反転 // 'player' のみ
        - act='delete' → entities.findPlayer(target.id) → entities.removePlayer(ship) → dispose() // 'player' のみ。操作対象の艦にはこの項目自体がメニューに出ない(MapPicker.itemsFor)
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
  - viewBadge.sync(activeStage.selectLabel, canToggleView) // タイトル・Mode・View ドロップダウンの表示反映
  - floatingOrigin = new FloatingOrigin(player.state.r, player.state.v) // 以降の sync 系はこの fo だけを参照する
  - displayTime を確定 // displayTimeManager.resolveDisplayTime(simTime, game.currentOrbitPeriod()): 未来ゴーストのスライダーが立っている間だけ先の時刻
  - cameraSystem.sync() // 最初に呼ぶ: environment.sync とマーカー投影が今フレームのカメラ行列を読む
    - syncCameraToViewpoint(active.camera, active.viewpoint, fo) // active = overviewMode ? overviewCamera : combatCamera。両カメラの viewpoint→THREE.PerspectiveCamera 反映はここ一箇所
    - overviewCameraPanel.setVisible(overviewMode) + setFocus()/setFrame() // MAP VIEW パネル。点灯反映は overviewMode のみ
    - focusMarkers.syncLabels() → markerManager.setPosition() // ラベルごと。overviewMode のみ
    - focusMarkers.hideLabels() // !overviewMode のみ
  - project / overviewMode / simTime / attractors(= ephemeris.attractorsAt(simTime)) / target(= targeter.aliveTarget)を確定 // 以降の sync 系へ配る共通値
  - environment.sync()
    - sunBody.setSunlit(lit) // lit = sunlitFactor(playerPos, ephemeris.sunDirAt(displayTime), …)。overviewMode では 1.0 固定
    - [bodies(= CELESTIAL_BODIES 登録順の CelestialBody[])ごと] body.sync(fo, displayTime, cameraSystem, ephemeris)
      - EarthBody.sync() → earth.group.position / earth.setRotation() / earth.setSunDir() / earth.tick()
      - SunBody.sync() → billboard 位置(カメラ相対の圧縮距離)+ sunLight.position・intensity(setSunlit の lit 反映)
      - SphereBody.sync()(月・木星) → overviewMode なら実 ECI 位置、!overviewMode ならカメラ相対の圧縮距離。mesh.lookAt() は常に
    - ambient.intensity 更新 // lit から導出
    - syncStars() // starsMesh をカメラへ追従、overviewMode でさらに拡大
    - syncReferenceLines() → geoLine.sync() + moonLine.sync() // !overviewMode では両方 null 渡しで非表示
    - celestialGrid.sync() // navball.gridVisibility の6トグルと overviewMode に応じたスケールを反映
    - [entities.players ごと] ship.syncPlayer(displayTime, isActive = ship===player)
    - displayState(displayTime) // current.at または predicted.at。null なら obj.visible=false のみで以下は現在状態のまま
    - obj の position / quaternion / visible // displayState 基準(未来ゴースト表示中は将来位置)。ガンサイトズームで隠れるのは isActive の艦だけ
    - thrustEffects.sync() → core/outer の sync() or hide() // displayState(displayTime) ?? this.state。displayState が null なら alive=false 扱いで呼び自分で隠れる
    - rcsEffects.sync() → sfx.setRcs(rotating) + puff の sync() or hide() ×4 // 同上
    - belt.sync() // 各リンクの position/quaternion を平行移動+ツイストから導出。同上
    - radiator.sync() // ヒンジ Group の rotation.y へ展開角を書く
    - reentryEffects.sync() // qdyn が REENTRY_GLOW_MIN_Q 未満、または !alive なら隠すだけ
    - [isActive] markers.sync(currentState, displayState) // 自機由来の HUD マーカー(方位・ボアサイト・▷)。操作対象の艦だけが出す
      - [overviewMode] 戦闘用7キーを hide + displayState があれば markerManager.setPosition('self') / 無ければ hide('self')
      - [!overviewMode] hide('self') + syncOrbitalDirections(currentState) // pro/retro/nrm/anm/radout/radin。常に現在状態
      - [!overviewMode] syncBoresight(currentState) → setDirection('bore') or hide('bore') // player.alive で分岐。常に現在状態
    - orbitLine.sync() → regenerate() // 中心天体は毎フレーム strongestAttractor(state.r, ephemeris.attractorsAt(state.t)) で導出(地球固定ではない)。要素が閾値以上ドリフト or 推力中(force) or 初回のみ再生成。現在状態基準(要素は時刻に依らない)
  - entities.sync(displayTime) → entity.sync(displayTime) // 敵・弾・薬莢・デブリ・補給それぞれ(Bullet は速度方向を向く別実装)。自機(全隻)は含まない — 各艦は syncPlayer() が個別に同期済み。
    displayState が null(predictsFuture=false の種別が未来表示中、または予測ホライズン超過)なら visible=false
  - effects.sync() → flashEffectManager.syncFlashEffects()
    - billboard.sync() // 生存中のフラッシュごと(寿命・移流は update フェーズで済んでいる)
  - targeter.sync(attractors) // ターゲットに紐づく表示物をまとめて
    - syncOrbitLine(attractors) // 各線の中心天体は対象ごとに strongestAttractor(target.state.r, attractors) で導出
      - enemy.orbitLine.sync() // 敵ごと。overviewMode かつ生存かつ第一・第二どちらでもないときだけ表示
      - orbitLine.sync() // 第一ターゲット軌道線(オレンジ)
      - secondaryOrbitLine.sync() // 第二ターゲット軌道線(シアン)
    - syncBoardMarkers() // 的通過マークの表示(スロットごと)。第一ターゲットのみ
    - syncTargetDirMarkers() // ◇/◆ tgtdir/atgdir。overviewMode or 第一ターゲット無しなら hide。第一ターゲットのみ
  - navTarget.sync() // ▲/▽ nav-an/nav-dn マーカー。navTarget.update() が求めた位置があれば表示、無ければ hide
  - navball.sync(player.state, player.att, player.alive, target?.state ?? null) // 常に自機の現在状態(表示時刻ではない)。ターゲット系モードのままターゲット消失ならモードを自機基準へ戻す
  - [敵ごと] displayState(displayTime) → markerItem(role, viewerPos, pos) // role は第一/第二/なし。displayState が null の敵はここで除外(マーカーごと落とす)
  - enemyMarkers.sync() // 生存かつ displayState を持つ敵の markerItem() 集合を受ける(まとめは1体では決まらない)
    - groupNearby() // 画面上で近接するものをクラスタ化し、代表以外のラベルを落とす
    - markerManager.set() + markerManager.setBearing() // 対象ごと。画面外なら画面端の方位マーカー▲へ
    - retire() // 前フレームに出したキーのうち集合から消えたものを remove(敵ごとに増えるキーなので DOM ごと捨てる)
  - leadMarkers.sync() // 敵ごとの LEAD マーカー。overviewMode or !player.alive なら全 remove して return
    - trackTargeted() // 最終ロック時刻を生存中の敵ぶんだけ作り直す
    - leadPoint() → markerManager.setPosition('lead-<name>') // LEAD_HOLD_SEC 以内 かつ 解がある敵ごと
  - displayTimeManager.sync(game.currentOrbitPeriod()) // PREDICT パネル(期間/未来位置スライダー/目盛り/手動レンジ)の表示/内容を押し出すだけ
    - panel.setVisible(!forceCurrent) / setDuration() / setManualVisible() / setSliderLabel() / setTicks() // ラベルは自己完結の "T+" 表記のみ
  - editor.sync(mapDist, simTime, fo, project)
    - [hasPlan かつ(editMode または plan.nodes.length > 0)] planDisplay.sync(fo, project, editMode)
      - traj.setVisible(true)
      - traj.sync(fo, project) // 区間の折れ線メッシュ。表示座標系と un-bake 時刻は update フェーズで確定済み
        // 区間の終端はノードの t。末尾区間だけは起点の解析軌道1周期ぶん(plan.ts の orbitPeriodOf)
        // ノードの t は Plan.nodeTimeRange の制約で起点から1周期以内なので、どの区間も1周を超えない
        - arc.setVisible(true) + arc.sync() // 有効な区間ごと
          - sampled.syncGeometry() // 点列 or frame が変わったときのみ頂点を bake
          - sampled.syncTransform() // 毎フレーム(剛体 un-bake + フローティングオリジン補正)
        - arc.setVisible(false) // 区間が減って余った PlanArc ごと
      - syncGhost() → markerManager.setPosition('plannedPlayer') or hide() // update が求めた ghost が null なら hide
      - syncApsisMarkers() → markerManager.setPosition('apsisPe'/'apsisAp') or hide() // update が求めたアイコンごと
      - panel の表示 = showPanel(= editMode) / setSelected() // TRAJECTORY パネル(表示座標系)。戦闘ビューでは出さない
    - [!hasPlan、または(!editMode かつ plan.nodes.length === 0)] planDisplay.hide()
    - [hasPlan かつ editMode] syncGizmo() → nodeGizmo.sync() // ノードハンドル + 選択中ノードの Δv アーム6個
      // ↑ planDisplay.sync の後で呼ぶ: ノードの画面座標は traj の今フレームの表示文脈を通す
    - [hasPlan かつ editMode] syncPanel(simTime) // MANEUVER PLAN パネルの HTML(ノード一覧・選択中ノードの Δv と噴射後要素)
  - mapPicker.sync(overviewMode) // 軌道オブジェクトウィンドウ。objectListVisible かつ overviewMode のときだけ pickables を行として書き出す
  - touchControls?.syncModeButtons() // タッチデバイスのみ。制動/微動/ホールドの点灯
  - activeStage.sync(player, fo, project, displayTime, overviewMode) // player は Creative の未配置状態で null
    - syncStatusPanel() // hudSubStatus() が文字列を返すステージだけ表示。player が null なら隠す
    - [CreativeStage] syncPreview(fo, project) // update が求めた preview の軌道線 + ▷ マーカー。preview が null なら両方隠す
    - logistics.syncMarkers(displayTime) → ammo.displayState(displayTime) → markerManager.set('mg<i>') + setBearing('mg<i>-bearing')
      // player が null の間はすべて隠す(ラベルの距離表示が自機基準のため)
      // マーカーを出せる補給ごと(i = 生存かつ displayState が非 null な個体だけを詰めた配列の添字)
      - hide() // 前フレームよりその数が減ったぶんの、余った添字だけ
    - [CreativeStage] syncBaseMarkers(displayTime) → base.displayState(displayTime) → markerManager.set('base<i>', 'mk-poi', '●') // ラベルは player があれば距離付き
      - [!overviewMode] markerManager.setBearing('base<i>-bearing', ...) // 画面外の基地への方位矢印。overviewMode 中は隠す
      // entities.bases の添字ごと(logistics.syncMarkers と同じ、前フレームより減った添字だけ hide())
  - hud.panels.sync(game, attractors) // Game インスタンスを直接読む(narrow ctx を介さない唯一の消費者)
    - setStats() + setTarget() // 約10Hz にスロットル
    - setEnemyList() // 約4Hz にスロットル
  - hud.tick() // ヒント/トーストのフェードアウト
  - guide.sync(plan, player, simTime, editMode, project)
    - markerManager.hide('nd') + hide('burn') // editMode または !player.alive、あるいは直近ノードが無い場合
    - markerManager.setPosition('nd') + setDirection('burn') // 直近ノードがある場合
  - debugHistoryLine.sync() // ?debugLines=1 のときのみ実効。対象(既定: 自機+ターゲット)ごとに
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
- **高ワープ時**(`simSpeed > MAX_PHYS_SIM_SPEED`)は `simulationSubStep()` が1フレームに最大64回走り、
  `hitSystem.checkBulletHits()` もその回数呼ばれる。一方 `collisionPhysics.resolve()` は
  `canResolvePhysicalCollisions` が false になり `resolveCollision=false` で渡るため、
  `stepSimulation` の中で丸ごとスキップされる。
- **計画軌道 RK4 の再計算**は `PlanArc.update` が per-arc に持つ `(state0, end)` の変化検出だが、
  `tracksLiveAnchor` 引数(計画が空のあいだの唯一の区間だけ true — その区間は anchor が自機の
  現在状態を毎フレーム追従する)で判定基準が変わる。false(ノードを置いた後の区間)なら
  `state0`/`end` の同一性・値の変化そのものが再積分の合図で、編集していないフレームでは一切
  再積分されない。true の間は `state0.t` も区間長(≒ 自機の接触周期。[PREDICT] パネルが「1周」
  のとき J2・大気抵抗で毎フレーム連続的に変化する)も厳密には毎フレーム変わるため、直近の
  再積分からの変化が描画解像度のサンプル間隔(区間長 / `PLAN_ARC_MAX_SAMPLES`)未満の間だけ
  再積分をスキップする。ただし `state0` の同一性が変わっていて `t` が前進していない(別艦への
  切り替え・ドック発進・衝突による状態上書きなどの非連続な差し替え)ときはこの閾値を無視して
  即座に再積分する。マップモード中でも大半のフレームは `sampled.syncTransform()`(O(1) の
  剛体変換)だけで済む。
- **過去 state の記録・prevState の更新は `physics/orbit-entity.ts` の `OrbitEntity`(`GameEntity.current`)の
  `step`/`reset` が行う**ので、この木には独立ノードとして現れない。`entity.stepSim()` /
  `resolveCollisionPair()` / 反動など、state へ代入するすべての経路が記録契機になる
  (前者は `current.step` 経由、後者は `current.reset` 経由)。`hitSystem.checkBulletHits()` と
  `targeter.updateBoardMarks()` が読む「直前サブステップ位置」(`entity.prevState.r`)は
  history の間引き対象とは別フィールドなので、`historyDuration = 0` の弾でも常に供給される。
- **`TouchControls` は per-frame の update を持たない**。DOM の pointer イベントから
  `input.setVirtualKey()` を呼ぶだけで、per-frame の接点は `game.sync` からの
  `syncModeButtons()`(トグル点灯)だけ。
- **`Ephemeris` は per-frame の状態更新もキャッシュも持たない**。各所が `stateOf`/`positionOf`/
  `attractorsAt` などを呼ぶたび、恒星→惑星-衛星系重心→惑星/衛星の合成をゼロから評価する。
  更新順序の制約が無いのはこのため。
- **HUD マーカーは持ち主の `sync` が自分で出す**。`game.sync` に並ぶのは「1つの対象では決められない」
  ものだけ(`enemyMarkers` = 画面上のまとめ、`leadMarkers` = 自機と敵の両方に依存)で、残りは
  `player.syncPlayer` / `targeter.sync` / `navTarget.sync` / `activeStage.sync` / `cameraSystem.sync` /
  `editor.sync`(→ `planDisplay`) / `guide.sync` の中にある。**`markerManager.resolveCollisions()` だけは
  全マーカーが出揃った後に一度だけ**呼ぶ必要があるため `game.sync` の末尾に置く。
- **`mapPicker.refresh()` は `game.sync` ではなく `game.update` の中、4経路それぞれで
  `cameraSystem.update` を呼ぶ直前(物理積分の後)に呼ぶ**。積分前に組むと、被選択物や navTarget の
  AN/DN の座標が、同じフレームで `sync` されるメッシュに対して1ステップぶん古くなる(ワープ倍率が
  高いほど無視できない)。フォーカス解決(`overviewCamera.update`)も右クリック判定
  (`mapPicker.handleRightClick`)もどちらも `update` フェーズの仕事なので、`sync` を待つ必要はない。
  天体ラベル(`focusMarkers`)と AN/DN(`navTarget`)の座標も候補列の一部なので、`refresh()` の
  先頭で両方を求め直す。`sync` 側(`focusMarkers.syncLabels` / `navTarget.sync`)はその値を
  マーカーへ置くだけで、座標を求め直さない。
- **`game.sync` は `dt` を受け取らない**。sync フェーズには進めるものが無い、というルールを
  シグネチャで見えるようにしてある。HUD パネルの書き換え間引きのような表示側の周期は
  `performance.now()` の期限で持つ。
