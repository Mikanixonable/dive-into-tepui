# 自機喪失後の追従カメラに絵を足す(未着手)

自機を喪失しても視点は自動で切り替わらないが、**追従対象を失った `ChaseCamera` は
最後の `viewpoint` を保持したまま止まる。** 喪失した艦は積分されない
(`GameEntity.stepActual` が `!alive` で自己抑制する)ので、そもそも凍結点しか見ていない。
一方 `Player.destroyEffect()` が撒く破片11個は艦の速度を引き継ぐので、
軌道速度(LEO で約 7.6 km/s)で画面外へ出ていく。

つまり **喪失直後の3D は「凍結した1点」しか映していない。** ステージでは決着と同時に
`#hud-end`(`system` レイヤの全画面オーバーレイ)が被さるのでほぼ見えないが、
Creative では結果画面が出ないので見える。

絵が欲しくなったときのために手順を残す。**着手は任意** — 追従対象の一般化
(`ChaseCamera.target: GameEntity | null`)は済んでいるので、どちらの案も追加は配線だけ。

---

## 案1: 残骸の破片へ引き継ぐ(推奨)

破壊時に既に撒いている `DebrisPiece` を追従対象にする。破片は積分され、可視で、
寿命(再突入・地表到達)も既存の規則そのままなので、**カメラは生存期間に一切関与しない。**

手順:
1. `EffectsSystem.spawnShipDestroyEffect(state, scale, accent)` が、艦の状態そのまま
   (相対速度0)の破片を1つ余分に撒き、それを返すようにする。
   相対速度0にするのは、どれか1つの破片を追うとその破片だけ画面中央に固定されて
   他が流れるため — 重心に留まれば破片が四方へ散るのを内側から見る絵になる。
2. `Player.destroyEffect()` の呼び出し元(`checkLoss` / `attackedByBullet` /
   `collideWith` / `collideAtRadiator`)で受け取った破片を `Player` のフィールドへ控える。
3. `ActivePlayerController.remove(ship)` で、除去する艦が追従対象だったときだけ
   `cameraSystem` へその破片を渡す(`CombatCameraSystem.setActivePlayer` とは別の口が要る —
   ガンサイト視点は操作対象艦を要求するので、追従対象と操作対象は別の値になる)。
4. `ChaseCamera.camFollowAttitude` は破片の自転に追従してしまうので、引き継ぎ時に倒す。

欠点: 破片配列は `addCapped` なので、大量の破片が後から湧くと追従対象が押し出されうる。
押し出されたら追従対象喪失(=現状の凍結)に落ちるだけなので、劣化は穏当。

## 案2: カメラ自前の自由落下アンカー

`CombatCameraSystem` が `DynamicTrajectory` を1本持ち、追従対象を失った瞬間の
`KinematicState` から自由落下させる。`CameraSystem.update` は既に `attractors` を
受け取っているので材料は揃っている。

実体ゼロ・決定的・配列に依存しない。姿勢が無いので `camFollowAttitude` は自然に無効になる。
欠点は `camera/` に積分が1つ増えること(`Simulator`/`Predictor`/`PlanArc` に次ぐ4つ目)。

## 採らない案: 不可視・操作不能の代役エンティティ

- `body` は `/refactor-fixed` 11節で天体に予約されているので、その名では呼べない。
- 「視点を外したら破棄」は view 層がシミュレーション層の生存期間を決める逆転になる
  (`Predictor` に `CameraSystem` を持たせない理由と同じ)。視点を外さなければ寿命に上限も無い。
- 不可視・非衝突・非重力・マーカー無し・予測無し・セーブ対象外の実体は、
  「配列に居るが何もしない」という、いま消したばかりの特例と同型。

---

## 併せて直したくなったら

- **弾の距離カリング** — `Simulator.advance` の `entities.cleanup(..., player?.state.r ?? v3(), ...)`
  は自機がいないと基準点が ECI 原点へ落ちるので、喪失と同時に残存弾が一斉に消える。
  気になるなら `cleanup` の `playerPos` を `Vec3 | null` にし、`Bullet.checkLoss` 側で
  「基準が無いなら距離では消さない」と自決させる(`/refactor-fixed` 21bis)。
- **`Ship.parts` の持ち主** — 喪失艦は `dispose()` されるので、パーツも一緒に消える。
  パーツを艦から切り離して基地へ回収する類の話は別件。
