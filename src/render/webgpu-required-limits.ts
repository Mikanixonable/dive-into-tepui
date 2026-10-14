// アダプタが持つ描画先の上限を、WebGPU device の要求へ渡す。
export async function webGpuRequiredLimits(): Promise<Record<string, number>> {
  if (typeof navigator === 'undefined') return {};
  const gpu = (navigator as Navigator & {
    readonly gpu?: {
      requestAdapter(options: {
        readonly powerPreference: undefined;
        readonly featureLevel: 'compatibility';
        readonly xrCompatible: false;
      }): Promise<{
        readonly limits: {
          readonly maxColorAttachmentBytesPerSample: number;
          readonly maxColorAttachments: number;
        };
      } | null>;
    };
  }).gpu;
  if (gpu === undefined) return {};
  const adapter = await gpu.requestAdapter({
    powerPreference: undefined, featureLevel: 'compatibility', xrCompatible: false,
  });
  if (adapter === null) return {};
  return {
    maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample,
    maxColorAttachments: adapter.limits.maxColorAttachments,
  };
}
