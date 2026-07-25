# CALLSTACK — per-frame 呼び出し依存木

`main.ts` の `requestAnimationFrame` ループが毎フレーム `game.update(dt)` → `game.sync(dt)` →
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
  - game.sync(min(dt, 0.1))
  - game.render()
  - perf.record() // `?perf=1` のときのみ(PerfMeter が DOM にフレーム時間・エンティティ数を出す)

---

## game.update(dtRaw)

- game.update(dtRaw)
  - input.update() // pending キュー(キー/クリック/マウス)を今フレーム分に確定し、次フレーム用にクリア
  - handleInput() // 担当モジュールへ先着順に配る。処理した側が input からそのキーを消費する
    - settingsPanel.handleInput() // Escape → toggle() → onSettingsOpenChange → game.pause()/resume()
    - hud.handleInput() // KeyH → toggleHelp()
    - activeStage.handleInput() // KeyR。isPlaying なら素通し(Player の装填へ回る)
      - restart() → location.replace(`?stage=<id>`) // 決着後のみ。同じステージで出撃し直す
    - simSpeedManager.handleInput()
      - shift(-1|+1) // Comma / Period
        - cancelAutoWarp() // 常に(手動シフトは自動ワープを解除する)
        - sfx.warp() + hud.hint() // 上限/下限を超えない場合のみ
      - toggleAutoWarpToFirstNode() // KeyN。editor.editMode 中は受け取らない
        - hud.hint() // ノード無し or !isPlaying
        - cancelAutoWarp() + hud.hint() // 既に自動ワープ中
        - startAutoWarpTo() + hud.hint() // 未開始
    - mapModeToggler.update()
      - toggle() // KeyM。!activeStage.isPlaying なら即 return
        - [開く: !cameraSystem.mapMode]
          - editor.selectedNodeIdx = null
          - touchControls?.setMapMode(true) // タッチデバイスのみ
          - cameraSystem.mapMode = true / editor.editMode = true // 独立2責務を同時に立てる唯一の箇所
          - hud.hint()
        - [閉じる: cameraSystem.mapMode]
          - editor.onMapClosed()
            - hidePanel()
            - plan.removeNode() // Δv が NODE_MIN_DV 未満のノードごと
          - editor.closeMenu() → nodeGizmo.closeMenu()
          - cameraSystem.closeFocusMenu() → focusGizmo.closeMenu()
          - touchControls?.setMapMode(false)
          - cameraSystem.mapMode = false / editor.editMode = false
          - hud.hint() // plan.nodes.length > 0 のみ
      - close(...) // !isPlaying && cameraSystem.mapMode のみ(死亡/終了時にマップを強制的に閉じる)
    - editor.handleInput()
      - clearPlanByKey() // KeyX
        - [editMode] deleteSelected() → deleteNode()
          - plan.removeNode() / closeMenu() / simSpeedManager.cancelAutoWarp() / hud.hint()
        - [!editMode] plan.clear() + simSpeedManager.cancelAutoWarp() + hud.hint() // ノードがある場合のみ
  - [!activeStage.isPlaying] 以降を実行せず return する簡略経路
    - player.thrustFn = null / player.torque = v3() // 勝敗確定時の推力を凍結させない
    - simulator.stepSimulation(hardCollision=false, doSubstep=false) // simSpeed は ×4 で打ち止め
      - simulationSubStep() ×1 → stepEntity() エンティティごと + player.thermal.updateThermal()
      - stepAttitudes()
  - [game.isPaused] 以降を実行せず return するポーズ経路
  - player.behave()
    - belt.update()
      - physics.shiftBeltNodes() // リロードで給弾量が巻き戻ったフレームのみ
      - physics.update()
        - initNodesOnce() // 初回のみ
        - estimateAngularAccel() / integrateVerlet() / pinRootToAnchor() / relaxDistanceConstraints()
        - resetIfFolded() // ベルトが折れ込んでいる場合のみ内部リセット
        - advanceOrientationConstraints() // リンクごとに角度クランプ・ツイスト更新
    - handleEdgeInput() → handleEdgePress() // 処理したキーは input.consumeKey() で消費する
      - throttle.toggleRcsDamp() // KeyT
      - throttle.enableProgradeReset() // KeyF
      - toggleFineAttitude() // KeyV
      - throttle.toggleProgradeHold() // KeyC
      - throttle.setThrottlePreset(0|1|2) // Digit1/2/3
      - fire.manualReload() // KeyR。成功時のみ true(= キー消費)
        - sfx.playReload() + dropBarrel() → fx.spawnBarrel()
    - throttle.updateTorque() → player.torque へ代入。!alive なら即ゼロ
      - onProgradeHoldReleased() → hud.hint() // ホールド中に手動回転入力があった場合のみ
      - autoAlignTorque() // ホールド中 かつ 手動回転入力なしの場合のみ
    - throttle.clampAngularVelocity() → player.att へ代入 // 常に(角速度上限)
    - [!player.alive] thrustFn = null して return
    - hpRegen()
    - [editor.editMode] fire.tickMapMode() → tickReloadTimer() / thrustFn = null して return
    - fire.updateFireState()
      - tickReloadTimer()
      - hud.hint() // 発射キー押下中 かつ !simSpeed.canPlayerFire
      - sfx.emptyClick() + hud.hint() // 弾切れの初回フレームのみ
      - fireCycle() // 発射キー押下 かつ canPlayerFire かつ残弾ありの場合のみ
        - sfx.spinUp() // 発射開始フレームのみ(このフレームは fireGun まで進まない)
        - consume() // 弾薬状態の更新。戻り値で以下の分岐が決まる
        - fireGun() // クールダウン明けのみ
          - spawnBullet() → simulator.addBullet()
          - player.state.v に反動 Δv
          - dropCasing() → fx.spawnCasing()
          - spawnMuzzleFlash() → fx.spawnFlash()
          - scoreCounter.recordShot()
          - sfx.fire()
        - spawnEjectedMagazineFrame() + sfx.magFeed() // 'mag-reload'
        - spawnEjectedMagazineFrame() + dropBarrel() + sfx.playReload() // 'barrel-reload'
    - throttle.updateThrustState() → player.thrustFn へ代入
      - sfx.setThrust(false) // 推力入力なし or !canPlayerThrust
      - sfx.setThrust(true) // 推力あり
  - activeStage.update() // 具体ステージへディスパッチ。!isPlaying なら即 return
    - behaveAllEnemies() // 全ステージ共通の先頭処理
      - enemy.behave() // 生存中の敵ごと(canEnemyFire・距離・バースト状態の判定は behave 内部)
        - firePlasma() → simulator.addBullet()
    - [Stage0 訓練スコアアタック] timer.update()
      - setPhase('timeup') + showScoreAttackResultScreen() // 制限時間到達フレームのみ
    - [Stage00 無限サバイバル] waveManager.update()
      - logistics.updateLogistics(respawnOnDespawn=true)
        - absorbNearbyAmmo() // player.alive のみ
          - player.onPickup() + sfx.pickup() + hud.hint() // 範囲内の補給ごと
        - despawnFarAmmo()
          - spawnForPlayer() // 遠方消滅した数だけ再投入
        - spawnForPlayer() // LOGISTICS_CHECK_INTERVAL ごと、かつ低弾薬・上限未満のみ
      - updateWaitingForAmmoPhase() → hud.toast() // 弾薬確保でフェーズ遷移した時のみ
      - updateSpawningEnemiesPhase() → spawnWave() // カウントダウン満了時のみ
      - updateActiveCombatPhase()
        - despawnOutOfRangeEnemies() // 圏外の敵ごと(alive=false + dispose())
        - spawnWave() + hud.toast() // 間隔・同時展開上限を満たす場合のみ
        - spawnWave: generateWave() → addEnemy() → simulator.addEnemy() + scoreCounter.recordSpawnEnemy()
    - [Stage1 / Stage2 キャンペーン] logistics.updateLogistics(respawnOnDespawn=false)
  - simSpeedManager.update() // 自動ワープ中のみ実効
    - hud.hint() // 実行点に接近して自動ワープを解除したフレームのみ
  - simulator.stepSimulation(hardCollision=true, doSubstep=true)
    - simulationSubStep() ×1〜64 // ワープ倍率が MAX_PHYS_SIM_SPEED を超えるとサブステップが増える
      - stepEntity(player) → stepOrbitRK4() → entity.state へ代入(setter が軌道要素メモ破棄 + history 記録)
        // player.alive のみ。thrustFn + 環境加速度
      - stepEntity() // 敵・弾・薬莢・デブリ・補給それぞれ、個体ごと
      - player.thermal.updateThermal()
    - hit.checkBulletHits() // サブステップごと(hardCollision=true のため)
      - target.attacked() // 弾が命中した対象ごと
        - [Enemy.attacked]
          - scoreCounter.recordHit()
          - hitEffect() // 被弾後も hp>0
            - sfx.hit() / fx.spawnPlasmaFlash() or fx.spawnBulletFlash() / fx.scatterFragments()
          - activeStage.recordEnemyDeath(byPlayer=true) // hp<=0
            - scoreCounter.recordKill() + hud.hint()
            - unlockManager.reportClear() // checkWin() が true になった場合のみ
            - onWin() → showWinScreen() // 同上(Stage0/00 は no-op override)
          - destroyEffect() → sfx.explosion() + fx.spawnShipDestroyEffect() // hp<=0
        - [Player.attacked]
          - hitEffect() // hp>0
          - activeStage.recordPlayerLost() → showResultScreen() // hp<=0
          - destroyEffect() // hp<=0
    - stepAttitudes() → stepAttitude() → entity.att へ代入 // 自機・敵・薬莢・デブリ・補給それぞれ
  - collisionPhysics.resolve() // simSpeedManager.canResolvePhysicalCollisions のみ(高ワープ時はスキップ)
    - player.belt.collisionSections() // player.alive && dt>1e-6
    - resolveCollisionPairs()
      - resolveCollisionPair() → 双方の state へ代入 // 貫入している衝突ペアごと
      - onPlayerCasingImpact() → sfx.clank() // 自機-薬莢の接触時のみ
    - player.belt.applyCollisionSections() // player.alive && dt>1e-6
  - targeter.markBoardCrossings() // ターゲットが存在する場合のみ
    - boardMarks.push() // 通常弾が的の面を自機側から通過した場合のみ
  - player.checkLoss() // !player.alive なら即 return
    - thermal.updateAltitudeAlarm()
      - hud.hint() + sfx.altAlarm() // 高度しきい値を新規に下回ったときのみ
      - checkThermalLimits() → hud.hint() // 熱/動圧が危険域に入った初回のみ
    - destroyEffect() → sfx.explosion() + fx.spawnShipDestroyEffect() // 限界超過 or 高度不足のみ
    - activeStage.recordPlayerLost() // 同上
  - simulator.cleanup()
    - checkLoss() // 敵・弾・薬莢・デブリ・補給の各個体ごと(既定は alive=false 代入のみ)
      - [Enemy.checkLoss] destroyEffect() + activeStage.recordEnemyDeath(byPlayer=false) // 再突入時のみ
        - scoreCounter.recordEnemyLoss() + hud.hint()
    - prune() ×5 → entity.dispose() // alive=false の個体ごと(scene から除去、必要なら geometry も破棄)
  - cameraSystem.update() // 物理積分の後に呼ぶ(追従カメラの基準を積分後の自機位置に合わせるため)
    - chaseCamera.toggleFollowAttitude() // KeyG。カメラ自身の状態なのでここで消費する
    - zoomActive = !mapMode && KeyZ 押下
    - mapCamera.update() // cameraSystem.mapMode のみ
    - chaseCamera.update() // !mapMode のみ
      - computeGunsightView() // player.alive && zoomActive
      - computeChaseView() // それ以外(!alive / 姿勢追従 / 軌道基準の3経路)
    - pipCamera.update() // 常に(PIP を描かないフレームも視点計算はする)
  - editor.plan.trackAnchor() // ノードが0件のときだけ実効(1件目を置くとアンカーは凍結される)
  - [editor.editMode] 計画編集モード
    - editor.handleMapPointer() // 右クリック → 左クリックの順に受ける
      - handleNodeRightClick() // 右クリックごと。ノードをヒットしたぶんだけ消費する
        - nodeGizmo.openMenu() + selectedNodeIdx = idx // ヒット時。true を返して消費
      - handleMapClick() // 左クリックごと。常に消費する
        - selectedNodeIdx = idx + sfx.warp() // 既存ノードをヒットした場合
        - traj.nearestSample() → plan.addNode() + sfx.warp() // 予測軌道上をヒットした場合
    - cameraSystem.handleMapPointer() // ノードに消費されずに残った右クリックだけが届く
      - handleFocusRightClick() → focusGizmo.openMenu() // MAP_LABEL_PICK_PX 以内にラベルがある場合のみ消費
    - editor.updateEditing()
      - plan.applyNodeDv() // ノード選択中 かつ WASDQE 入力がある場合のみ実効
      - renderPanel() // 計画パネル(MANEUVER PLAN)の HTML 更新
  - [!editor.editMode] targeter.updateCombatTargeting()
    - handleTargetLockByRightClick() // player.alive のみ。右クリックは当否に関わらず消費する
      - toggleLockedTarget() + hud.hint() // 右クリックが敵に当たった場合
      - hud.hint() // 外れ、かつ既にロックがあった場合(ロック解除)
    - autoTarget を再計算して代入

---

## game.sync(dt)

- game.sync(dt)
  - floatingOrigin = new FloatingOrigin(player.state.r, player.state.v) // 以降の sync 系はこの fo だけを参照する
  - cameraSystem.sync() // 最初に呼ぶ: environment.sync とマーカー投影が今フレームのカメラ行列を読む
    - mapCamera.sync() // mapMode のみ
    - chaseCamera.sync() // !mapMode のみ
    - pipCamera.sync() // 常に
    - mapViewPanel.setVisible(mapMode) + setFocus()/setFrame() // MAP VIEW パネル。点灯反映は mapMode のみ
  - environment.sync()
    - syncEarth() → earth.group.position / earth.setRotation() / earth.tick()
    - syncSkyBodies()
      - earth.setSunDir() / starsMesh の位置・スケール / sun.billboard.sync() / sunLight.position
      - moonMesh を実 ECI 位置へ配置 // mapMode(実スケール表示)
      - placeCombatMoon() // !mapMode(カメラ相対の圧縮距離)
      - moonMesh.lookAt() // 常に
    - syncLighting() // 自機位置の日照率で sunLight/ambient の強度を上書き
  - player.syncPlayer()
    - obj の position / quaternion / visible
    - thrustEffects.sync() → core/outer の sync() or hide()
    - rcsEffects.sync() → puff の sync() or hide() ×4
    - belt.sync() // 各リンクの position/quaternion を平行移動+ツイストから導出
  - touchControls?.syncModeButtons() // タッチデバイスのみ。制動/微動/ホールドの点灯
  - activeStage.syncStatusPanel() // hudSubStatus() が文字列を返すステージだけ表示
  - simulator.sync() → entity.sync() // 全エンティティごと(Bullet は速度方向を向く別実装)
  - effects.syncFlashEffects() → flashEffectManager.syncFlashEffects()
    - billboard.sync() // 有効なフラッシュごと
    - scene.remove() + billboard.dispose() // 寿命切れのフラッシュごと
  - syncEntityOrbitLines()
    - player.orbitLine.sync() → regenerate() // 要素が閾値以上ドリフト or 推力中(force) or 初回のみ
    - enemy.orbitLine.sync() // 敵ごと。mapMode かつ生存かつ非ターゲットのときだけ表示
    - targeter.syncOrbitLine() → orbitLine.sync()
  - syncMarkers()
    - editor.syncDisplay()
      - [!mapMode] traj.setVisible(false) + hideGizmo() → nodeGizmo.sync([], null) して return
      - traj.setVisible(true)
      - traj.update() // corners を arc へ分解し、arc ごとに PredictedLine を駆動
        - line.update() // arc ごと
          - predictTrajectory() // 入力変化 + スロットル(または force)を満たしたときのみ(重い RK4)
          - sampled.syncGeometry() // 点列 or frame が変わったときのみ頂点を bake
          - sampled.syncTransform() // 毎フレーム(剛体 un-bake + フローティングオリジン補正)
        - line.setVisible(false) // arc が減って余った B-1 ごと
      - updateGizmo() → nodeGizmo.sync() // ノードハンドル + 選択中ノードの Δv アーム6個
    - [mapMode]
      - predict.sync()
        - syncGhost() → markerManager.setPosition('plannedPlayer') or hide()
        - panel.setVisible(true) / setDuration() / setFrame() / setSliderLabel() // PREDICT パネル
      - cameraSystem.syncMapLabels() → mapMarkers.syncLabels() → markerManager.setPosition() // ラベルごと
    - [!mapMode] predict.hide() → markerManager.hide('plannedPlayer') + panel.setVisible(false)
    - environment.syncReferenceLines() → geoLine.sync() + moonLine.sync() // !mapMode では両方 null 渡しで非表示
    - markersSystem.updateMarkers()
      - updateMapModeMarkers() // mapMode なら方向系を隠して 'self' を出す、!mapMode なら逆
      - updateOrbitalDirectionMarkers() // !mapMode のみ。pro/retro/nrm/anm/radout/radin + tgtdir/atgdir
      - updateBoresightMarker()
      - updateEnemyMarkers() // 敵ごと(画面上で近接する敵はクラスタ化して代表だけラベル表示)
      - updateAmmoMarkers() // 補給スロットごと
      - updateLeadAndDirMarkers() // 敵ごとに画面外方位マーカーと LEAD マーカー
      - markerManager.hide('lead') // 旧単一 LEAD キーの後始末
      - markerManager.resolveCollisions() // ラベル衝突緩和 + SVG 引き出し線の再描画
    - markersSystem.updateNodeMarkers() // 相対 AN/DN。要素が無い/軌道面がほぼ一致なら hide
    - targeter.syncBoardMarkers() // 的通過マークの寿命更新と表示
    - markerManager.hide('burn') // mapMode のみ
    - guide.update() // !mapMode のみ
      - markerManager.hide('nd'/'burn') // ノード無し or !player.alive で return
      - [達成] plan.consumeFirstNode() + simSpeedManager.cancelAutoWarp() + hide + hud.hint() + sfx.warp()
      - [未達成] markerManager.setPosition('nd') + setDirection('burn')
  - hud.panels.update(game, dt) // Game インスタンスを直接読む(narrow ctx を介さない唯一の消費者)
    - setStats() + setTarget() // 約10Hz にスロットル
    - setEnemyList() // 約4Hz にスロットル
  - hud.tick() // ヒント/トーストのフェードアウト

---

## game.render()

- game.render()
  - renderer.render(scene, cameraSystem.activeCamera) // 通常の全画面描画
  - pipRenderer.renderPip()
    - [!renderPip = 非発砲中 or mapMode]
      - crosshair を非表示
      - updateOverlay(null) → markersSystem.updatePipOverlay() → markerManager.hide('pip-tgt'/'pip-lead')
    - [renderPip = player.isFiring && !mapMode]
      - playerShipObj.visible = false
      - setMuzzleFlashesVisible(false) → effects → billboard.mesh.visible = false // muzzle フラグ付きのみ
      - renderer.autoClearColor = false // 2度目の render で全画面の描画結果を消さないため
      - setViewport() / setScissor() / setScissorTest(true)
      - renderer.render(scene, pipCamera.camera) // PIP 矩形への2度目の描画パス
      - updateOverlay(rect) → markersSystem.updatePipOverlay()
        - markerManager.set('pip-tgt') // 有効なターゲットがある場合
        - markerManager.set('pip-lead') or hide() // 有効なリード解(t<25s)の有無で分岐
      - (finally) visible / setMuzzleFlashesVisible(true) / viewport / scissor / autoClearColor を復元
      - crosshair を表示して PIP 中心へ配置

---

## 補足

- **`update` / `sync` / `render` の三分割は main.ts のループが決めている。** `Game.update` は論理状態のみ
  (THREE.js オブジェクトに触らない)、`Game.sync` は fo を作って既存メッシュ・DOM へ反映するだけ、
  `Game.render` は renderer.render を2回まで呼ぶだけ、という切り分けになっている。
- **カメラ更新は `Game.update` の末尾**(物理積分の後)にある。`sync` で作るフローティングオリジンは
  積分後の自機位置なので、追従カメラの基準もそこに合わせる必要がある。
- **高ワープ時**(`simSpeed > MAX_PHYS_SIM_SPEED`)は `simulationSubStep()` が1フレームに最大64回走り、
  `hit.checkBulletHits()` もその回数呼ばれる。一方 `collisionPhysics.resolve()` は
  `canResolvePhysicalCollisions` が false になるため丸ごとスキップされる。
- **予測 RK4 の再計算頻度**は `PredictedLine` が per-arc に持つ入力変化検出 + スロットルで決まる。
  マップモード中でも大半のフレームは `sampled.syncTransform()`(O(1) の剛体変換)だけで済む。
- **過去 state の記録は `OrbitEntity.state` の setter が行う**ので、この木には独立ノードとして現れない。
  `stepEntity()` / `resolveCollisionPair()` / 反動など、state へ代入するすべての経路が記録契機になる。
  `hit.checkBulletHits()` と `targeter.markBoardCrossings()` が読む「直前サブステップ位置」
  (`entity.prevState.r`)はこれで供給される。
- **`TouchControls` は per-frame の update を持たない**。DOM の pointer イベントから
  `input.setVirtualKey()` を呼ぶだけで、per-frame の接点は `game.sync` からの
  `syncModeButtons()`(トグル点灯)だけ。
- **`Ephemeris` は per-frame の状態更新を持たない**(純サンプラ)。各所が `*At(t)` を呼ぶだけなので
  更新順序の制約が無い。
