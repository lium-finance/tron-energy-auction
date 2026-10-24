const MS_PER_HOUR = 3_600_000;

/** The unix hour (seconds since epoch divided by 3600, floored) of a moment, in UTC. A display helper: the hour job stamps its own target hour on every row it writes. */
export function hourOf(at: Date): number {
  return Math.floor(at.getTime() / MS_PER_HOUR);
}

export function hourStart(hour: number): Date {
  return new Date(hour * MS_PER_HOUR);
}

/** Milliseconds from `from` to the next time the UTC minute hand reads `minute` (0 to 59), strictly after `from`. */
export function msUntilMinute(minute: number, from: Date): number {
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError("minute must be an integer from 0 to 59");
  }
  if (Number.isNaN(from.getTime())) throw new RangeError("from is not a valid date");
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(minute);
  if (next.getTime() <= from.getTime()) next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - from.getTime();
}
