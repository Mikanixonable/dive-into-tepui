// ship-modules.glb の template から module 境界ごとの表示インスタンスを作る。
// production ではバイナリを asset/resource として別ファイルへ出し、起動時に一度だけ取得する。
// tsc/node テストではローカルファイルを直接読み込み、同じ同期 factory を使える。
import type * as THREE from 'three/webgpu';
import shipModulesSource from '../../../assets/models/ship-modules.glb';
import { loadBakedGlb } from '../baked-glb';
import { prepareStaticModel } from '../../static-model';

let parsedShipModules: THREE.Group | null = null;
let loadPromise: Promise<void> | null = null;
// modelId → 下ごしらえを済ませた template の複製。読み込んだ template は手付かずで残す。
const preparedTemplates = new Map<string, THREE.Object3D>();

// production の外部 asset を先読みする。複数の起動経路から呼ばれても fetch/parse は一度だけ。
export function loadShipModuleModels(): Promise<void> {
  if (parsedShipModules !== null) return Promise.resolve();
  if (loadPromise !== null) return loadPromise;
  loadPromise = loadBakedGlb(shipModulesSource)
    .then((scene) => {
      const templates = (scene.children.find(
        child => child.name === 'ship-modules' || child.userData?.name === 'ship-modules',
      ) ?? scene) as THREE.Group;
      parsedShipModules = templates;
    });
  return loadPromise;
}

// 読み込んだ全 module の template の親。loadShipModuleModels が済む前に呼ぶと投げる。
export function getShipModuleTemplates(): THREE.Group {
  if (parsedShipModules === null) {
    throw new Error('ship module models are not loaded; call loadShipModuleModels() during startup');
  }
  return parsedShipModules;
}

// object の semantic anchor 名を返す。userData.semanticAnchor を優先し、'anchor:' 接頭辞の
// object.name も同名として扱う。anchor でなければ null。anchor は module の外から動かされ、
// 位置を引かれる節である。
export function semanticAnchorName(object: THREE.Object3D): string | null {
  const value = object.userData.semanticAnchor;
  if (typeof value === 'string') return value;
  if (object.name.startsWith('anchor:')) return object.name.slice('anchor:'.length);
  return null;
}

// modelId の下ごしらえ済み template。初回に、anchor を境界として下ごしらえした複製を作る。
function preparedTemplateFor(modelId: string): THREE.Object3D {
  const cached = preparedTemplates.get(modelId);
  if (cached !== undefined) return cached;
  const template = getShipModuleTemplates().children.find(
    child => child.userData.moduleModelId === modelId,
  );
  if (template === undefined) throw new Error(`unknown ship module model: ${modelId}`);
  const prepared = template.clone(true);
  prepareStaticModel(prepared, (object) => semanticAnchorName(object) !== null);
  preparedTemplates.set(modelId, prepared);
  return prepared;
}

// modelId の module model を返す。geometry と material は全個体の共有物で、個体の持ち物は
// 変換・表示状態・熱の状態だけである。
export function buildShipModuleModel(modelId: string): THREE.Object3D {
  const model = preparedTemplateFor(modelId).clone(true);
  model.traverse((child) => {
    child.userData.ownsGeometry = false;
    child.userData.ownsMaterial = false;
  });
  return model;
}
