const maxReset = (windows) => {
  const resets = windows.map((window) => window.resetsAt).filter((value) => value != null);
  return resets.length > 0 ? Math.max(...resets) : null;
};

export function decideUsage(runtime, { claude, devinPaidQuota, threshold, claudeResetAt }) {
  if (runtime === 'claude') {
    if (!claude?.known) return { verdict: 'UNKNOWN', wakeAt: claudeResetAt ?? null };
    const windows = [claude.fiveHour, claude.sevenDay].filter(Boolean);
    if (windows.length === 0 || windows.some((window) => !Number.isFinite(window.usedPct))) {
      return { verdict: 'UNKNOWN', wakeAt: claudeResetAt ?? null };
    }
    const exhausted = windows.filter((window) => window.usedPct >= threshold);
    return {
      verdict: exhausted.length > 0 ? 'SLEEP' : 'CONTINUE',
      wakeAt: exhausted.length > 0 ? maxReset(exhausted) ?? claudeResetAt ?? null : null,
    };
  }

  if (runtime === 'devin-luna') {
    if (!devinPaidQuota?.known) return { verdict: 'UNKNOWN', wakeAt: null };
    const windows = [devinPaidQuota.daily, devinPaidQuota.weekly].filter(Boolean);
    if (windows.length === 0 || windows.some((window) => !Number.isFinite(window.remainingPct))) {
      return { verdict: 'UNKNOWN', wakeAt: null };
    }
    const exhausted = windows.filter((window) => window.remainingPct <= 0);
    return {
      verdict: exhausted.length > 0 ? 'SLEEP' : 'CONTINUE',
      wakeAt: exhausted.length > 0 ? maxReset(exhausted) : null,
    };
  }

  throw new Error(`Unsupported usage runtime: ${runtime}`);
}
