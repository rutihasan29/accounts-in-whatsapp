const { getEligibleCallers } = require('./schedule');
const { getSetting, setSetting, getLeadById } = require('./db');

const TIMEOUT_SECONDS = 20;

function assignFreshLead(db, leadId, timestamp = new Date()) {
  const now = typeof timestamp === 'string' || typeof timestamp === 'number'
    ? new Date(timestamp)
    : timestamp;

  const eligible = getEligibleCallers(db, now);

  if (!eligible || eligible.length === 0) {
    db.prepare(`
      UPDATE crm_leads SET assigned_caller_id = NULL WHERE id = ?
    `).run(leadId);
    return { lead_id: leadId, assigned_caller_id: null, status: 'unassigned' };
  }

  const lastCallerId = getSetting(db, 'last_assigned_caller_id', null);
  let nextIndex = 0;

  if (lastCallerId) {
    const prevIndex = eligible.findIndex(c => c.id === lastCallerId);
    if (prevIndex !== -1) {
      nextIndex = (prevIndex + 1) % eligible.length;
    }
  }

  const selectedCaller = eligible[nextIndex];
  setSetting(db, 'last_assigned_caller_id', selectedCaller.id);

  const expiresAt = new Date(now.getTime() + TIMEOUT_SECONDS * 1000).toISOString();
  const nowIso = now.toISOString();

  db.prepare(`
    UPDATE crm_leads
    SET assigned_caller_id = ?,
        assignment_expires_at = ?
    WHERE id = ?
  `).run(selectedCaller.id, expiresAt, leadId);

  const assignmentId = 'asgn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  db.prepare(`
    INSERT INTO crm_lead_assignments (id, lead_id, caller_id, assigned_at, status)
    VALUES (?, ?, ?, ?, 'assigned')
  `).run(assignmentId, leadId, selectedCaller.id, nowIso);

  return {
    lead_id: leadId,
    assigned_caller_id: selectedCaller.id,
    assignment_expires_at: expiresAt,
    status: 'assigned'
  };
}

function claimLead(db, leadId, callerId, timestamp = new Date()) {
  const claimTime = typeof timestamp === 'string' || typeof timestamp === 'number'
    ? new Date(timestamp)
    : timestamp;

  const lead = getLeadById(db, leadId);
  if (!lead) {
    throw new Error('Lead not found');
  }

  const createdAtStr = lead.created_at.includes('Z')
    ? lead.created_at
    : lead.created_at.replace(' ', 'T') + 'Z';
  const startTime = new Date(createdAtStr);

  const speedSeconds = Math.max(0, Math.round((claimTime.getTime() - startTime.getTime()) / 1000));
  const slaStatus = speedSeconds <= 60 ? 'met_sla' : 'breached_sla';
  const claimIso = claimTime.toISOString();

  const updateResult = db.prepare(`
    UPDATE crm_leads
    SET status = 'in_progress',
        claimed_at = ?,
        assigned_caller_id = ?,
        speed_to_lead_seconds = ?,
        sla_status = ?
    WHERE id = ? AND (claimed_at IS NULL OR assigned_caller_id = ?)
  `).run(claimIso, callerId, speedSeconds, slaStatus, leadId, callerId);

  if (updateResult.changes === 0) {
    throw new Error('Lead has already been claimed or re-assigned');
  }

  db.prepare(`
    UPDATE crm_lead_assignments
    SET status = 'claimed', claimed_at = ?
    WHERE lead_id = ? AND caller_id = ? AND status = 'assigned'
  `).run(claimIso, leadId, callerId);

  return getLeadById(db, leadId);
}

function checkAndEscalateTimeouts(db, timestamp = new Date()) {
  const now = typeof timestamp === 'string' || typeof timestamp === 'number'
    ? new Date(timestamp)
    : timestamp;
  const nowIso = now.toISOString();

  const timedOutLeads = db.prepare(`
    SELECT * FROM crm_leads
    WHERE status = 'fresh'
      AND claimed_at IS NULL
      AND assigned_caller_id IS NOT NULL
      AND assignment_expires_at <= ?
  `).all(nowIso);

  const escalations = [];

  for (const lead of timedOutLeads) {
    const prevCallerId = lead.assigned_caller_id;

    db.prepare(`
      UPDATE crm_lead_assignments
      SET status = 'timed_out'
      WHERE lead_id = ? AND caller_id = ? AND status = 'assigned'
    `).run(lead.id, prevCallerId);

    const timedOutCallerIds = db.prepare(`
      SELECT caller_id FROM crm_lead_assignments WHERE lead_id = ? AND status = 'timed_out'
    `).all(lead.id).map(r => r.caller_id);

    const eligible = getEligibleCallers(db, now);
    const availableForEscalation = eligible.filter(c => !timedOutCallerIds.includes(c.id));

    if (availableForEscalation.length > 0) {
      let nextCaller = availableForEscalation[0];
      const prevIndex = eligible.findIndex(c => c.id === prevCallerId);
      if (prevIndex !== -1) {
        for (let i = 1; i < eligible.length; i++) {
          const candidate = eligible[(prevIndex + i) % eligible.length];
          if (!timedOutCallerIds.includes(candidate.id)) {
            nextCaller = candidate;
            break;
          }
        }
      }

      setSetting(db, 'last_assigned_caller_id', nextCaller.id);

      const nextExpiresAt = new Date(now.getTime() + TIMEOUT_SECONDS * 1000).toISOString();

      db.prepare(`
        UPDATE crm_leads
        SET assigned_caller_id = ?, assignment_expires_at = ?
        WHERE id = ?
      `).run(nextCaller.id, nextExpiresAt, lead.id);

      const assignmentId = 'asgn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      db.prepare(`
        INSERT INTO crm_lead_assignments (id, lead_id, caller_id, assigned_at, status)
        VALUES (?, ?, ?, ?, 'assigned')
      `).run(assignmentId, lead.id, nextCaller.id, nowIso);

      escalations.push({
        lead_id: lead.id,
        from_caller_id: prevCallerId,
        to_caller_id: nextCaller.id
      });
    } else {
      db.prepare(`
        UPDATE crm_leads
        SET assigned_caller_id = NULL, assignment_expires_at = NULL
        WHERE id = ?
      `).run(lead.id);
    }
  }

  return escalations;
}

module.exports = {
  assignFreshLead,
  claimLead,
  checkAndEscalateTimeouts,
  TIMEOUT_SECONDS
};
