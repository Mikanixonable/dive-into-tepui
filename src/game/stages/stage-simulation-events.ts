// 時刻が固定されたイベントを持つステージが答える面。次に来るイベントの時刻を答え、
// その時刻に達したイベントを適用する。
export interface StageSimulationEvents {
  // 次に適用すべきイベントの simTime。以降イベントが無ければ null。
  nextSimulationEventTime(simTime: number): number | null;
  // simTime までに来たイベントを適用する。
  applySimulationEvents(simTime: number): void;
}
