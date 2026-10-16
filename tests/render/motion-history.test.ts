import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  markMotionHistoryKey, markMotionRejected, MOTION_NO_HISTORY, MotionHistory, PoolMotionHistory,
  useRecordedPreviousModel,
} from '../../src/render/pipeline/motion-history';
import { test } from '../harness';

export function register(): void {
  test('motion history: 同じ番号の更新は前を保って modelWorldMatrix だけを上書きする', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    const object = new THREE.Object3D();
    camera.updateMatrixWorld(true);

    history.setFrame(8, camera);
    object.position.x = 1;
    object.updateMatrixWorld(true);
    history.read(object, camera);
    assert.ok(history.read(object, camera)?.previous.equals(zeroMatrix()));
    const frame8 = object.matrixWorld.clone();

    history.setFrame(9, camera);
    object.position.x = 2;
    object.updateMatrixWorld(true);
    history.read(object, camera);
    assert.ok(history.read(object, camera)?.previous.equals(frame8));
    object.position.x = 3;
    object.updateMatrixWorld(true);
    const sameFrame = history.read(object, camera);
    assert.ok(sameFrame?.previous.equals(frame8));
    assert.ok(sameFrame?.current.equals(object.matrixWorld));
    const frame9 = object.matrixWorld.clone();

    history.setFrame(10, camera);
    object.position.x = 4;
    object.updateMatrixWorld(true);
    assert.ok(history.read(object, camera)?.previous.equals(frame9));
  });

  test('motion history: 初回・カメラ交換では前 model と前 view-projection が零', () => {
    const history = new MotionHistory();
    const firstCamera = new THREE.PerspectiveCamera();
    const secondCamera = new THREE.PerspectiveCamera();
    const object = new THREE.Object3D();
    firstCamera.updateMatrixWorld(true);
    secondCamera.updateMatrixWorld(true);
    object.updateMatrixWorld(true);

    history.setFrame(2, firstCamera);
    assert.ok(history.read(object, firstCamera)?.previous.equals(zeroMatrix()));
    assert.ok(history.cameraRecord(firstCamera)?.previous.equals(zeroMatrix()));

    history.setFrame(3, secondCamera);
    assert.ok(history.read(object, secondCamera)?.previous.equals(zeroMatrix()));
    assert.ok(history.cameraRecord(secondCamera)?.previous.equals(zeroMatrix()));
    assert.strictEqual(MOTION_NO_HISTORY, 1e4);
  });

  test('motion history: 射影の深度行は view offset と反転深度を保つ', () => {
    for (const reversedDepth of [false, true]) {
      for (const viewOffset of [false, true]) {
        const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
        camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
        if (reversedDepth) Reflect.set(camera, '_reversedDepth', true);
        if (viewOffset) camera.setViewOffset(1920, 1080, 120, 80, 960, 540);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);

        const history = new MotionHistory();
        history.setFrame(0, camera);
        const recorded = history.cameraRecord(camera)!.current;
        const expected = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
        for (const index of [2, 3, 6, 7, 10, 11, 14, 15]) {
          assert.ok(Math.abs(recorded.elements[index]! - expected.elements[index]!) < 1e-12);
        }
        if (!viewOffset) assert.ok(recorded.equals(expected));
      }
    }
  });

  test('motion history: 射影行列を保ち、記録へ別の P×V を持つ', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 1000);
    camera.position.set(3, 2, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const projection = camera.projectionMatrix.clone();

    history.setFrame(0, camera);
    assert.ok(camera.projectionMatrix.equals(projection));
    history.setFrame(1, camera);

    const current = history.cameraRecord(camera)!.current;
    const expected = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
    assert.ok(camera.projectionMatrix.equals(projection));
    assert.notStrictEqual(current, camera.projectionMatrix);
    assert.ok(current.equals(expected));
  });

  test('motion history: 番号が飛んだ物体更新でも最後の未変更 model を前として保つ', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    const object = new THREE.Object3D();
    camera.updateMatrixWorld(true);
    object.updateMatrixWorld(true);

    history.setFrame(4, camera);
    history.read(object, camera);
    const frame4 = object.matrixWorld.clone();

    // frame 5 と 6 では更新 callback が走らなかった想定。更新された番号 7 では frame 4 の model を前として使う。
    history.setFrame(7, camera);
    object.position.x = 3;
    object.updateMatrixWorld(true);
    const frame7 = history.read(object, camera);
    assert.strictEqual(frame7?.frame, 7);
    assert.ok(frame7?.previous.equals(frame4));

    // 番号が 8 へ進んでも物の uniform が更新されなければ、シェーダは記録済み前 model を選ばない。
    assert.strictEqual(useRecordedPreviousModel(history.modelFrameFor(object, camera), 8), false);
    assert.ok(frame7?.current.equals(object.matrixWorld));
  });

  test('motion history: lab の列で番号が戻っても未変更 model を次の番号の前として使う', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    const object = new THREE.Object3D();
    camera.updateMatrixWorld(true);
    object.position.x = 4;
    object.updateMatrixWorld(true);

    history.setFrame(8, camera);
    history.read(object, camera);
    const previousSequence = object.matrixWorld.clone();

    // 列の frame 0 では matrixWorld が同じなので、物の onObjectUpdate は走らない想定。
    history.setFrame(0, camera);
    history.setFrame(1, camera);
    object.position.x = 5;
    object.updateMatrixWorld(true);
    const frame1 = history.read(object, camera);
    assert.strictEqual(frame1?.frame, 1);
    assert.ok(frame1?.previous.equals(previousSequence));
  });

  test('motion history: reset logical frame uses monotonic serial', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    const staticObject = new THREE.Object3D();
    const updatedObject = new THREE.Object3D();
    camera.updateMatrixWorld(true);
    staticObject.updateMatrixWorld(true);
    updatedObject.updateMatrixWorld(true);

    history.setFrame(0, camera);
    history.read(staticObject, camera);
    const recordedStaticSerial = history.modelFrameFor(staticObject, camera);

    history.setFrame(1, camera);
    history.read(updatedObject, camera);
    history.setFrame(0, camera);
    history.read(updatedObject, camera);
    const currentSerial = history.modelFrameFor(updatedObject, camera);
    history.setFrame(0, camera);
    assert.strictEqual(history.modelFrameFor(updatedObject, camera), currentSerial);
    assert.notStrictEqual(recordedStaticSerial, currentSerial);
    assert.strictEqual(useRecordedPreviousModel(recordedStaticSerial, currentSerial), false);
  });

  test('motion history: 分割段は親を鍵にして履歴を共有する', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    const parent = new THREE.Group();
    const firstLevel = new THREE.Mesh();
    const secondLevel = new THREE.Mesh();
    camera.updateMatrixWorld(true);
    parent.add(firstLevel, secondLevel);
    markMotionHistoryKey(firstLevel, parent);
    markMotionHistoryKey(secondLevel, parent);

    history.setFrame(0, camera);
    parent.position.x = 2;
    parent.updateMatrixWorld(true);
    history.read(firstLevel, camera);
    const firstModel = firstLevel.matrixWorld.clone();

    history.setFrame(1, camera);
    parent.position.x = 5;
    parent.updateMatrixWorld(true);
    const secondRecord = history.read(secondLevel, camera);
    assert.ok(secondRecord?.previous.equals(firstModel));
  });

  test('motion history: 同じ材質の物体は別々の前 model を受け取る', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    const first = new THREE.Object3D();
    const second = new THREE.Object3D();
    camera.updateMatrixWorld(true);
    first.position.x = -2;
    second.position.x = 3;
    first.updateMatrixWorld(true);
    second.updateMatrixWorld(true);

    history.setFrame(0, camera);
    history.read(first, camera);
    history.read(second, camera);
    const firstPrevious = first.matrixWorld.clone();
    const secondPrevious = second.matrixWorld.clone();

    history.setFrame(1, camera);
    first.position.x = -1;
    second.position.x = 4;
    first.updateMatrixWorld(true);
    second.updateMatrixWorld(true);
    const firstRecord = history.read(first, camera);
    const secondRecord = history.read(second, camera);
    assert.ok(firstRecord?.previous.equals(firstPrevious));
    assert.ok(secondRecord?.previous.equals(secondPrevious));
    assert.notDeepStrictEqual(firstRecord?.previous.elements, secondRecord?.previous.elements);
  });

  test('motion history: 棄却印の予約番号は常に記録 model を選ぶ', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    const object = new THREE.Object3D();
    camera.updateMatrixWorld(true);
    object.updateMatrixWorld(true);
    markMotionRejected(object);

    history.setFrame(5, camera);
    const rejectedFrame = history.modelFrameFor(object, camera);
    assert.strictEqual(rejectedFrame, 0xffff_ffff);
    assert.strictEqual(useRecordedPreviousModel(rejectedFrame, 5), true);
    assert.ok(history.previousModelFor(object, camera).equals(zeroMatrix()));
  });

  test('motion history: プールの積み順を変えても実体ごとの前 model を枠順へ書く', () => {
    const history = new MotionHistory();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const first = positionedObject(1);
    const second = positionedObject(2);
    const newObject = positionedObject(3);
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2);
    const pool = new PoolMotionHistory(mesh, 2);
    const previous = pool.previousMatrices;
    try {
      pool.beginFrame();
      pool.place(first);
      pool.place(second);
      history.setFrame(0, camera);
      first.position.x = 4;
      first.updateMatrixWorld(true);
      second.position.x = 5;
      second.updateMatrixWorld(true);
      pool.beginFrame();
      pool.place(second);
      pool.place(first);

      history.setFrame(1, camera);
      assert.equal(previous.array[12], 2);
      assert.equal(previous.array[28], 1);

      first.position.x = 8;
      first.updateMatrixWorld(true);
      history.setFrame(1, camera);
      assert.equal(previous.array[12], 2);
      assert.equal(previous.array[28], 1);

      pool.beginFrame();
      pool.place(newObject);
      pool.place(first);
      history.setFrame(2, camera);
      assert.deepEqual(Array.from(previous.array.slice(0, 16)), Array.from(zeroMatrix().elements));
      assert.equal(previous.array[28], 8);

      history.setFrame(4, camera);
      assert.deepEqual(Array.from(previous.array.slice(0, 32)), [
        ...zeroMatrix().elements, ...zeroMatrix().elements,
      ]);
    } finally {
      pool.dispose();
      mesh.dispose();
    }
  });

  test('motion history: プールの同じフレームの2つの枠へ同じ個体を置けない', () => {
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2);
    const pool = new PoolMotionHistory(mesh, 2);
    const object = positionedObject(1);
    try {
      pool.beginFrame();
      pool.place(object);
      assert.throws(() => pool.place(object));
      pool.beginFrame();
      pool.place(object);
    } finally {
      pool.dispose();
      mesh.dispose();
    }
  });
}

function positionedObject(x: number): THREE.Object3D {
  const object = new THREE.Object3D();
  object.position.x = x;
  object.updateMatrixWorld(true);
  return object;
}

function zeroMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}
