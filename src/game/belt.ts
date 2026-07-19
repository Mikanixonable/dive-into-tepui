// マガジンベルトの物理演算(Verlet 積分 + 距離拘束によるチェーンのたわみ・ねじれ)。
// game.ts を import しない — 依存は BeltCtx 引数・コンストラクタ注入のみ。
import * as THREE from 'three/webgpu';
import { Attitude } from '../physics/attitude';
import { Vec3, v3 } from '../physics/vec3';
import { MAG_BELT_PITCH } from '../render/ships';
import * as C from './const';

const X_AXIS = new THREE.Vector3(1, 0, 0);

// updateBeltPhysics 専用のスクラッチ変数(毎フレーム/リンクごとの new THREE.Vector3
// 割り当てを避けるため使い回す。同一フレーム内で再入・並行使用されないことが前提)。
const beltQInv = new THREE.Quaternion();
const beltAThrustBody = new THREE.Vector3();
const beltW = new THREE.Vector3();
const beltAlpha = new THREE.Vector3();
const beltAnchor = new THREE.Vector3();
const beltRootPos = new THREE.Vector3();
const beltVel = new THREE.Vector3();
const beltAccel = new THREE.Vector3();
const beltTmpA = new THREE.Vector3();
const beltTmpB = new THREE.Vector3();
const beltNext = new THREE.Vector3();
const beltDelta = new THREE.Vector3();
const beltDir = new THREE.Vector3();
const beltTmpVX = new THREE.Vector3();
const beltDirLocal = new THREE.Vector3(); // 前リンクのローカル系に変換した辺り方向（ピッチ/ヨー制限用）
const beltQInvPrev = new THREE.Quaternion(); // beltQPrev の逆四元数局所変数
const beltQPrev = new THREE.Quaternion();
const beltQDelta = new THREE.Quaternion();
const beltQBend = new THREE.Quaternion();
const beltQTwist = new THREE.Quaternion();

export class BeltPhysics {
  // ベルトのたわみは物理演算(Verlet 積分 + 距離拘束)で行う。位置は機体座標系
  // (機体原点基準)。無重力(自由落下軌道)なので重力そのものは効かず、
  // 自機の推力加速度とスピン(角速度・角加速度)による慣性力(擬似力)だけが
  // ベルトを揺らす。
  readonly beltPos: THREE.Vector3[] = [];
  readonly beltPrevPos: THREE.Vector3[] = [];
  private beltInit = false;
  // 各リンクのチェーン軸まわりのねじれ角 [rad](機関銃ベルト同様、上下方向の
  // 折れ曲がりは距離拘束のみで自由に許容する一方、ロールはここで角度上限を掛けて
  // 制限する)。機体のロール角速度を発生源に、リンクからリンクへ位相遅れつつ
  // 伝播させ、常に ±MAG_CHAIN_MAX_ROLL_DEG に収まるよう追従・クランプする。
  readonly beltTwist: number[] = [];

  private prevBodyW = v3(); // 前フレーム的機体角速度(ベルト物理の角加速度推定用)

  constructor(private readonly beltLinks: THREE.Group[]) {}

  shiftBeltNodes(): void {
    const n = this.beltLinks.length;
    if (n < 2) return;

    // ノードを 1 つ前詰め (i=0 は消費済みマガジン、破棄)
    for (let i = 0; i < n - 1; i++) {
      this.beltPos[i]!.copy(this.beltPos[i + 1]!);
      this.beltPrevPos[i]!.copy(this.beltPrevPos[i + 1]!);
      this.beltTwist[i] = this.beltTwist[i + 1]!;
    }

    // 末尾に新ノードを追加(前の末尾から +X 方向へ PITCH 分延長)
    // このノードは直後に beltCount が 1 減って非表示になるので、
    // 位置精度はどうでもよい(次フレームで距離拘束に収束する)。
    const last = this.beltPos[n - 2]!;
    const lastPrev = this.beltPrevPos[n - 2]!;

    // 前のノードの速度ベクトルを引き継いで自然に延長
    beltTmpA.copy(last).sub(lastPrev);
    this.beltPos[n - 1]!.copy(last).add(beltTmpA).addScaledVector(X_AXIS, MAG_BELT_PITCH);
    this.beltPrevPos[n - 1]!.copy(this.beltPos[n - 1]!); // 新末尾は追加直後は速度ゼロ
    this.beltTwist[n - 1] = this.beltTwist[n - 2]!;
  }

  // マガジンベルトのたわみを物理演算(Verlet 積分 + 距離拘束)で解く。
  // 軌道上は自由落下(無重力)なので、通常の重力によるたわみは発生しない。
  // 代わりに、機体自身の推力加速度(並進)とスピン(角速度・角加速度)が
  // 生む慣性力(擬似力)——並進慣性 -a、遠心力 -ω×(ω×r)、オイラー力 -α×r、
  // コリオリ力 -2ω×v——だけがベルトを機体座標系の中で揺らす。
  // ベルトは「接合部で連結されているが曲げられる」チェーンとして、各リンクの
  // 節点を距離拘束(剛体棒)でつなぐ position-based dynamics で表現する。
  updateBeltPhysics(
    dt: number,
    beltCount: number,
    att: Attitude,
    thrustAccelVec: Vec3,
    beltFeed: number,
    playerAlive: boolean
  ): void {
    const n = this.beltLinks.length;
    if (!this.beltInit) {
      this.beltInit = true;
      for (let i = 0; i < n; i++) {
        const p = new THREE.Vector3(0.9 + (i + 1) * MAG_BELT_PITCH, 0, 0);
        this.beltPos.push(p.clone());
        this.beltPrevPos.push(p.clone());
        this.beltTwist.push(0);
      }
    }

    // 機体の角加速度を前フレームとの差分から推定(body-frame ω の差分)
    const w = att.w;
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    beltAlpha.set((w.x - this.prevBodyW.x) * invDt, (w.y - this.prevBodyW.y) * invDt, (w.z - this.prevBodyW.z) * invDt);
    this.prevBodyW = v3(w.x, w.y, w.z);

    // 推力加速度をワールド→機体座標系へ変換(擬似力は加速度と逆向き)
    beltQInv.set(att.q.x, att.q.y, att.q.z, att.q.w).invert();
    const aThrustWorld = thrustAccelVec;
    beltAThrustBody.set(aThrustWorld.x, aThrustWorld.y, aThrustWorld.z).applyQuaternion(beltQInv);

    const h = Math.min(dt, 0.05); // 積分刻みの上限(大きな dt でのはみ出し防止)
    const damping = 0.95; // 慣性を維持するため減衰を弱める
    // コリオリ力 -2ω×v の係数: beltVel = pos-prevPos = v*dt なので速度への変換に 2/dt を使う。
    // invH2(=2/h) ではなく実際の dt を使わないと dt > 0.05 のときコリオリ力が過大になる。
    const inv2Dt = invDt * 2;
    beltW.set(w.x, w.y, w.z);

    for (let i = 0; i < n; i++) {
      const pos = this.beltPos[i]!;
      const prev = this.beltPrevPos[i]!;
      beltVel.copy(pos).sub(prev); // 前フレームの変位(Verlet の速度相当)

      // 擬似力による加速度: -a_thrust - α×r - ω×(ω×r) - 2ω×v
      beltAccel.set(-beltAThrustBody.x, -beltAThrustBody.y, -beltAThrustBody.z);
      beltAccel.sub(beltTmpA.crossVectors(beltAlpha, pos));
      beltAccel.sub(beltTmpA.crossVectors(beltW, beltTmpB.crossVectors(beltW, pos)));
      beltAccel.sub(beltTmpA.crossVectors(beltW, beltVel).multiplyScalar(inv2Dt));

      beltNext.copy(pos).addScaledVector(beltVel, damping).addScaledVector(beltAccel, h * h);
      prev.copy(pos);
      pos.copy(beltNext);
    }

    // 距離拘束(剛体棒): 先頭はベルトの給弾進みに応じて動くアンカーに固定。
    // 数回反復して各リンク間隔を MAG_BELT_PITCH に収束させる。
    beltAnchor.set(0.9 - beltFeed * MAG_BELT_PITCH, 0, 0);

    // 根本(リンク0)は常に機体に対して垂直(ローカル+X方向)になるよう、
    // 揺動物理を経由させずアンカーから固定距離・固定方向の位置に毎フレーム
    // 強制する(速度もゼロにして慣性ドリフトを止める)。これにより根本の
    // 接合部は常に垂直のまま、リンク1以降だけが自由に揺れる。
    beltRootPos.copy(beltAnchor).addScaledVector(X_AXIS, MAG_BELT_PITCH);
    this.beltPos[0]!.copy(beltRootPos);
    this.beltPrevPos[0]!.copy(beltRootPos);

    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? beltAnchor : this.beltPos[i - 1]!;
        const b = this.beltPos[i]!;
        beltDelta.copy(b).sub(a);
        const dist = beltDelta.length();
        if (dist < 1e-6) continue;
        const corr = beltDelta.multiplyScalar((dist - MAG_BELT_PITCH) / dist);
        if (i <= 1) {
          // i===0: 参照点はアンカー(固定)。i===1: 参照点は根本(beltPos[0]、
          // 常に垂直固定)。どちらも a 側は動かさず b 側だけ補正する。
          b.sub(corr);
        } else {
          b.addScaledVector(corr, -0.5);
          a.addScaledVector(corr, 0.5);
        }
      }
      // かすかな直線復元力(曲げ剛性の簡易近似): 距離拘束をある程度収束させた
      // 中間で1回だけ、各リンクの継ぎ目をまっすぐ揃える方向へわずかに引き寄せる。
      // 直後に残りの距離拘束反復で生じた長さのずれを収束させ直す。

    }

    // マガジンチェーンが折りたたまれて重なっているかの判定とリセット
    // 互いに隣接していないリンク同士の距離が近すぎる場合は絡まっていると見なす
    let folded = false;
    const minSq = (MAG_BELT_PITCH * 0.5) * (MAG_BELT_PITCH * 0.5);
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 2; j < n; j++) {
        if (this.beltPos[i]!.distanceToSquared(this.beltPos[j]!) < minSq) {
          folded = true;
          break;
        }
      }
      if (folded) break;
    }

    if (folded) {
      for (let i = 0; i < n; i++) {
        const p = beltRootPos.clone().addScaledVector(X_AXIS, i * MAG_BELT_PITCH);
        this.beltPos[i]!.copy(p);
        this.beltPrevPos[i]!.copy(p);
        this.beltTwist[i] = 0;
      }
    }

    // 表示: 各リンクをその節点の手前(アンカー or 前リンクの節点)に置き、
    // 節点への方向へ向ける(ローカル +X = ベルト方向)。
    // 向きは「平行移動(parallel transport)」で求める: 前リンクの姿勢を基準に、
    // その進行方向(ローカル+X)を新しい節点方向へ向ける最小回転だけを加える。
    // 各つなぎ目で許容するピッチ/ヨーの角度上限を tan クランプで適用し、
    // クランプ後の方向を beltPos へ書き戻して物理とビジュアルを一致させる。
    // そこへ、機体のロールに由来する有限のねじれ角(this.beltTwist)を
    // 追加で載せることで、ロールにも独立した上限を課す。
    const maxRoll = (C.MAG_CHAIN_MAX_ROLL_DEG * Math.PI) / 180;
    // tan(最大角度) = ローカル座標系での横ずれ/前進量の上限
    const tanMaxPitch = Math.tan((C.MAG_CHAIN_MAX_PITCH_DEG * Math.PI) / 180);
    const tanMaxYaw = Math.tan((C.MAG_CHAIN_MAX_YAW_DEG * Math.PI) / 180);
    const rollLerp = Math.min(1, dt * C.MAG_CHAIN_ROLL_RATE);
    let prevPoint: THREE.Vector3 = beltAnchor;
    beltQPrev.identity(); // アンカー(機体)側の基準姿勢: ベルトは+X方向へ伸びる
    let prevTwist = att.w.z * C.MAG_CHAIN_ROLL_GAIN; // ねじれの発生源: 機体のロール角速度
    for (let i = 0; i < n; i++) {
      const link = this.beltLinks[i]!;
      link.visible = playerAlive && i < beltCount;
      const pos = this.beltPos[i]!;
      link.position.copy(prevPoint);

      beltDir.copy(pos).sub(prevPoint);
      const segLen = beltDir.length(); // このリンクの実長(距離拘束で ≒ MAG_BELT_PITCH)
      if (segLen > 1e-6) {
        beltDir.multiplyScalar(1 / segLen); // 正規化

        // ---- ピッチ / ヨー クランプ ----
        // 前リンクのローカル座標系(+X = 進行方向)に変換し、
        // Y 成分(ヨー方向の横ずれ)と Z 成分(ピッチ方向の上下ずれ)を
        // それぞれ tan(上限角度) でクランプする。
        // 「X 成分 = 1 固定でロジカルに考えると tan θ = 横ずれ/前進量」
        // となるので、正規化ベクトルをローカル系に変換後 X を 1 として
        // Y/X と Z/X をクランプし、再正規化してワールドへ戻す。
        beltQInvPrev.copy(beltQPrev).invert();
        beltDirLocal.copy(beltDir).applyQuaternion(beltQInvPrev);
        // beltDirLocal.x は cos(折れ角) ≈ 1(小角度近似で正のはず)。
        // ゼロ割を避けるため最低 0.001 に制限。
        const lx = Math.max(beltDirLocal.x, 0.001);
        beltDirLocal.y = Math.max(-tanMaxYaw * lx, Math.min(tanMaxYaw * lx, beltDirLocal.y));
        beltDirLocal.z = Math.max(-tanMaxPitch * lx, Math.min(tanMaxPitch * lx, beltDirLocal.z));
        beltDirLocal.normalize();
        // クランプ後の方向をワールドへ戻す
        beltDir.copy(beltDirLocal).applyQuaternion(beltQPrev);
        // beltPos[i] を「前点 + クランプ済み方向 × 元の長さ」に更新して
        // 物理とビジュアルを一致させる(次フレームの Verlet 積分に反映)。
        // 【重要】beltPrevPos[i] も同量だけ平行移動して Verlet の速度 (pos - prevPos) を保つ。
        // 移動前の pos を beltNext に退避(物理ループ終了後なので安全に再利用できる)。
        beltNext.copy(pos);                                       // 移動前の pos を退避
        pos.copy(prevPoint).addScaledVector(beltDir, segLen);     // クランプ後の pos
        this.beltPrevPos[i]!.add(pos).sub(beltNext);             // prevPos += (pos_new - pos_old)

        beltTmpVX.copy(X_AXIS).applyQuaternion(beltQPrev); // 前リンクの進行方向(ワールド)
        beltQDelta.setFromUnitVectors(beltTmpVX, beltDir);  // 曲げぶんの最小回転
        beltQBend.copy(beltQDelta).multiply(beltQPrev);
      } else {
        beltQBend.copy(beltQPrev);
      }

      if (i === 0) {
        // 根本はロール方向も含めて完全固定(ねじれ0)。伝播用シード(prevTwist)
        // は機体のロール角速度由来のまま変えず、ねじれはリンク1から始める。
        this.beltTwist[0] = 0;
      } else {
        // ねじれ角を目標へ追従させつつ ±maxRoll にクランプ(常に上限内)
        const target = Math.max(-maxRoll, Math.min(maxRoll, prevTwist));
        const twist = this.beltTwist[i]! + (target - this.beltTwist[i]!) * rollLerp;
        this.beltTwist[i] = Math.max(-maxRoll, Math.min(maxRoll, twist));
        prevTwist = this.beltTwist[i]!; // 次のリンクへ位相遅れつつ伝播
      }

      beltQTwist.setFromAxisAngle(X_AXIS, this.beltTwist[i]!);
      link.quaternion.copy(beltQBend).multiply(beltQTwist);

      beltQPrev.copy(beltQBend);
      prevPoint = pos;
    }
  }
}
