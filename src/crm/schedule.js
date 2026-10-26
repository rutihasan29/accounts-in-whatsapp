const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseTimeToMinutes(timeStr) {
  if (typeof timeStr !== 'string') return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return 0;
  return parts[0] * 60 + parts[1];
}

function isCallerOnShift(schedule, dateOrTimestamp = new Date()) {
  const date = typeof dateOrTimestamp === 'string' || typeof dateOrTimestamp === 'number'
    ? new Date(dateOrTimestamp)
    : dateOrTimestamp;

  if (!date || Number.isNaN(date.getTime())) {
    return false;
  }

  const dayKey = DAY_KEYS[date.getDay()];
  const currentMinutes = date.getHours() * 60 + date.getMinutes();

  let scheduleObj = schedule;
  if (typeof schedule === 'string') {
    try {
      scheduleObj = JSON.parse(schedule);
    } catch {
      return false;
    }
  }

  if (!scheduleObj || typeof scheduleObj !== 'object') {
    return false;
  }

  const dayIntervals = scheduleObj[dayKey] || scheduleObj[dayKey.toUpperCase()];
  if (!Array.isArray(dayIntervals) || dayIntervals.length === 0) {
    return false;
  }

  return dayIntervals.some(interval => {
    if (!interval || typeof interval.start !== 'string' || typeof interval.end !== 'string') {
      return false;
    }

    const startMin = parseTimeToMinutes(interval.start);
    let endMin = parseTimeToMinutes(interval.end);
    if (interval.end === '23:59' || interval.end === '24:00') {
      endMin = 24 * 60;
    }

    if (endMin < startMin) {
      // Over-midnight shift (e.g., 22:00 - 06:00)
      return currentMinutes >= startMin || currentMinutes < endMin;
    }

    return currentMinutes >= startMin && currentMinutes < endMin;
  });
}

function getEligibleCallers(db, dateOrTimestamp = new Date()) {
  const activeCallers = db.prepare(`
    SELECT * FROM crm_callers WHERE status = 'active'
  `).all();

  return activeCallers.filter(caller => {
    return isCallerOnShift(caller.shift_schedule_json, dateOrTimestamp);
  });
}

module.exports = {
  isCallerOnShift,
  getEligibleCallers
};
