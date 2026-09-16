import type { DynamicEntity } from './dynamic-entity';
import type { ProteinDisplaySettings } from '../../../render/protein/protein-display';

// クリエイティブ画面が表示設定だけを変更するための能力契約。
export interface ProteinDisplayController {
  readonly display: ProteinDisplaySettings;
  setDisplay(display: ProteinDisplaySettings): void;
}

// 具象ProteinEnemyを知らずに、表示設定変更能力だけを取得する。
export function proteinDisplayControllerOf(entity: DynamicEntity): ProteinDisplayController | null {
  const candidate = entity as DynamicEntity & Partial<{
    readonly proteinDisplayController: ProteinDisplayController;
  }>;
  return candidate.proteinDisplayController ?? null;
}
