export function formatEta(seconds: number): string {
  const totalMinutes = Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds / 60))
    : 0;
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (hours > 0 && minutes > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${days}d ${hours}h`;
  return minutes > 0 ? `${days}d ${minutes}m` : `${days}d`;
}
