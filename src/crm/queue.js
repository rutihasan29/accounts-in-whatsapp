function logCallDisposition(db, {
  leadId,
  callerId,
  disposition,
  notes = '',
  callbackTime = null,
  timestamp = new Date()
}) {
  const now = typeof timestamp === 'string' || typeof timestamp === 'number'
    ? new Date(timestamp)
    : (timestamp || new Date());
  const nowIso = now.toISOString();

  let nextStatus = 'in_progress';
  let nextCallbackAt = callbackTime ? (callbackTime instanceof Date ? callbackTime.toISOString() : callbackTime) : null;
  let retryIncrement = 0;

  switch (disposition) {
    case 'callback_requested':
      nextStatus = 'callback_set';
      nextCallbackAt = callbackTime ? (callbackTime instanceof Date ? callbackTime.toISOString() : callbackTime) : null;
      break;

    case 'ringing_no_answer':
      nextStatus = 'unreachable';
      retryIncrement = 1;
      // 2 hours cooldown
      nextCallbackAt = new Date(now.getTime() + 2 * 3600 * 1000).toISOString();
      break;

    case 'busy_declined':
      nextStatus = 'unreachable';
      retryIncrement = 1;
      // 30 mins cooldown
      nextCallbackAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
      break;

    case 'switched_off':
      nextStatus = 'unreachable';
      retryIncrement = 1;
      // Next day morning (+18 hours)
      nextCallbackAt = new Date(now.getTime() + 18 * 3600 * 1000).toISOString();
      break;

    case 'order_won':
      nextStatus = 'won';
      nextCallbackAt = null;
      break;

    case 'not_interested':
      nextStatus = 'lost';
      nextCallbackAt = null;
      break;

    case 'connected_interested':
      nextStatus = 'in_progress';
      break;
  }

  // Record call log
  const logId = 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const callbackScheduled = callbackTime ? (callbackTime instanceof Date ? callbackTime.toISOString() : callbackTime) : nextCallbackAt;
  db.prepare(`
    INSERT INTO crm_call_logs (id, lead_id, caller_id, disposition, call_notes, callback_scheduled_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(logId, leadId, callerId, disposition, notes, callbackScheduled, nowIso);

  // Update lead
  db.prepare(`
    UPDATE crm_leads
    SET status = ?,
        assigned_caller_id = ?,
        next_callback_at = ?,
        retry_count = COALESCE(retry_count, 0) + ?
    WHERE id = ?
  `).run(nextStatus, callerId, nextCallbackAt, retryIncrement, leadId);

  return db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(leadId);
}

function getCallerQueue(db, callerId, timestamp = new Date()) {
  const now = typeof timestamp === 'string' || typeof timestamp === 'number'
    ? new Date(timestamp)
    : (timestamp || new Date());
  const nowIso = now.toISOString();

  const leads = db.prepare(`
    SELECT *,
      CASE
        WHEN status = 'fresh' AND assigned_caller_id = :callerId THEN 1
        WHEN status = 'callback_set' AND assigned_caller_id = :callerId AND (next_callback_at <= :now OR datetime(next_callback_at) <= datetime(:now)) THEN 2
        WHEN status = 'unreachable' AND assigned_caller_id = :callerId AND (next_callback_at <= :now OR datetime(next_callback_at) <= datetime(:now)) THEN 3
        ELSE 4
      END AS queue_priority
    FROM crm_leads
    WHERE assigned_caller_id = :callerId
      AND status NOT IN ('won', 'lost')
      AND (
        (status = 'fresh') OR
        (status = 'callback_set' AND (next_callback_at <= :now OR datetime(next_callback_at) <= datetime(:now))) OR
        (status = 'unreachable' AND (next_callback_at <= :now OR datetime(next_callback_at) <= datetime(:now))) OR
        (status = 'in_progress')
      )
    ORDER BY queue_priority ASC, created_at DESC
  `).all({ callerId, now: nowIso });

  return leads;
}

module.exports = {
  logCallDisposition,
  getCallerQueue
};
