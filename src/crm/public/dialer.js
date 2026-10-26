// Telecaller CRM Mobile-First Dialer Logic
let currentLead = null;
let lastAlertedLeadId = null;
let timerInterval = null;
let queuePollInterval = null;
let selectedDisposition = null;

// Determine current caller ID from URL or default to 'c1'
const urlParams = new URLSearchParams(window.location.search);
let currentCallerId = urlParams.get('caller_id') || 'c1';

// Dual Audio Chime + Web Vibration Alert
function playChime() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      const audioCtx = new AudioContextClass();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
      osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.15); // A5

      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.6);
    }
  } catch (err) {
    console.log('Audio autoplay prevented or not supported:', err);
  }

  // Web Vibration API Alert: [300ms, pause 100ms, 300ms]
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate([300, 100, 300]);
    } catch (err) {
      console.log('Vibration alert error:', err);
    }
  }
}

// Clean phone number for WhatsApp deep link
function cleanPhoneNumber(rawPhone) {
  if (!rawPhone) return '';
  return rawPhone.replace(/\D/g, '');
}

// Load caller details and queue
async function initDialer() {
  await loadCallerProfile();
  await loadQueue();

  if (queuePollInterval) clearInterval(queuePollInterval);
  queuePollInterval = setInterval(loadQueue, 4000);
}

async function loadCallerProfile() {
  try {
    const res = await fetch('/api/crm/callers');
    if (!res.ok) return;
    const data = await res.json();
    if (data.callers && Array.isArray(data.callers)) {
      const caller = data.callers.find(c => c.id === currentCallerId) || data.callers[0];
      if (caller) {
        currentCallerId = caller.id;
        const nameEl = document.getElementById('caller-name');
        if (nameEl) nameEl.textContent = caller.name;

        const statusSelect = document.getElementById('status-select');
        if (statusSelect) {
          statusSelect.value = caller.status || 'active';
        }
      }
    }
  } catch (err) {
    console.error('Failed to load caller profile:', err);
  }
}

// Fetch prioritized queue for current caller
async function loadQueue() {
  try {
    const res = await fetch(`/api/crm/callers/${currentCallerId}/queue`);
    if (!res.ok) return;
    const data = await res.json();
    const queue = data.queue || [];

    const queueCountEl = document.getElementById('queue-count');
    if (queueCountEl) {
      queueCountEl.textContent = `${queue.length} in queue`;
    }

    if (queue.length > 0) {
      displayLead(queue[0]);
    } else {
      displayEmptyQueue();
    }
  } catch (err) {
    console.error('Failed to load queue:', err);
  }
}

// Display active lead in dialer
function displayLead(lead) {
  const isNewLead = !currentLead || currentLead.id !== lead.id;
  currentLead = lead;

  const leadContainer = document.getElementById('lead-container');
  const emptyContainer = document.getElementById('empty-container');
  if (leadContainer) leadContainer.style.display = 'block';
  if (emptyContainer) emptyContainer.style.display = 'none';

  // Fill in lead fields
  const nameEl = document.getElementById('lead-name');
  if (nameEl) nameEl.textContent = lead.name || 'Anonymous';

  const phoneEl = document.getElementById('lead-phone');
  if (phoneEl) phoneEl.textContent = lead.phone_number;

  const sourceEl = document.getElementById('lead-source');
  if (sourceEl) sourceEl.textContent = (lead.source || 'WhatsApp').toUpperCase();

  const retryEl = document.getElementById('lead-retry-count');
  if (retryEl) retryEl.textContent = String(lead.retry_count || 0);

  // Configure WhatsApp Call Button
  const cleanPhone = cleanPhoneNumber(lead.phone_number);
  const waBtn = document.getElementById('btn-call');
  if (waBtn) {
    waBtn.href = `whatsapp://send?phone=${cleanPhone}`;
    waBtn.classList.remove('disabled');
  }

  const webLink = document.getElementById('btn-web-fallback');
  if (webLink) {
    webLink.href = `https://wa.me/${cleanPhone}`;
  }

  // Handle lead SLA and status
  const badgeEl = document.getElementById('lead-status-badge');
  const timerEl = document.getElementById('timer-display');

  if (lead.status === 'fresh') {
    if (badgeEl) {
      badgeEl.className = 'badge badge-fresh';
      badgeEl.textContent = '🔥 FRESH LEAD';
    }

    // Play chime on fresh lead alert
    if (isNewLead && lastAlertedLeadId !== lead.id) {
      lastAlertedLeadId = lead.id;
      playChime();
    }

    // Calculate remaining countdown seconds from assignment_expires_at
    let remaining = 20;
    if (lead.assignment_expires_at) {
      const expiresAt = new Date(lead.assignment_expires_at).getTime();
      const diff = Math.round((expiresAt - Date.now()) / 1000);
      remaining = Math.max(0, Math.min(20, diff));
    }

    startCountdown(remaining);
  } else {
    clearInterval(timerInterval);

    if (lead.status === 'callback_set') {
      if (badgeEl) {
        badgeEl.className = 'badge badge-callback';
        badgeEl.textContent = '⏰ SCHEDULED CALLBACK';
      }
      if (timerEl) {
        timerEl.className = 'countdown-timer timer-safe';
        timerEl.textContent = 'DUE NOW';
      }
    } else if (lead.status === 'unreachable') {
      if (badgeEl) {
        badgeEl.className = 'badge badge-retry';
        badgeEl.textContent = `🔄 RETRY #${lead.retry_count || 1}`;
      }
      if (timerEl) {
        timerEl.className = 'countdown-timer timer-warn';
        timerEl.textContent = 'RETRY DUE';
      }
    } else {
      if (badgeEl) {
        badgeEl.className = 'badge badge-fresh';
        badgeEl.textContent = '📞 IN PROGRESS';
      }
      if (timerEl) {
        timerEl.className = 'countdown-timer timer-safe';
        timerEl.textContent = 'ACTIVE';
      }
    }
  }
}

// Display empty state when no leads are queued
function displayEmptyQueue() {
  currentLead = null;
  clearInterval(timerInterval);

  const leadContainer = document.getElementById('lead-container');
  const emptyContainer = document.getElementById('empty-container');
  if (leadContainer) leadContainer.style.display = 'none';
  if (emptyContainer) emptyContainer.style.display = 'block';

  const waBtn = document.getElementById('btn-call');
  if (waBtn) {
    waBtn.href = '#';
    waBtn.classList.add('disabled');
  }
}

// 20s Tabular Countdown Timer
function startCountdown(seconds) {
  clearInterval(timerInterval);
  let remaining = seconds;
  const display = document.getElementById('timer-display');

  function updateDisplay() {
    if (!display) return;
    const formatted = `00:${remaining < 10 ? '0' : ''}${remaining}s`;
    display.textContent = formatted;

    if (remaining <= 5) {
      display.className = 'countdown-timer timer-danger';
    } else if (remaining <= 10) {
      display.className = 'countdown-timer timer-warn';
    } else {
      display.className = 'countdown-timer timer-safe';
    }
  }

  updateDisplay();

  timerInterval = setInterval(() => {
    remaining--;
    updateDisplay();

    if (remaining <= 0) {
      clearInterval(timerInterval);
      // Lead timed out and escalated, reload queue
      loadQueue();
    }
  }, 1000);
}

// Claim lead & open bottom sheet
async function handleCallClick() {
  if (!currentLead) return;

  clearInterval(timerInterval);

  try {
    await fetch(`/api/crm/leads/${currentLead.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caller_id: currentCallerId }),
      keepalive: true
    });
  } catch (err) {
    console.error('Error claiming lead:', err);
  }

  // Open slide-up disposition sheet
  openDispositionSheet();
}

// Bottom sheet controls
function openDispositionSheet() {
  const sheet = document.getElementById('disposition-sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  if (sheet) sheet.classList.add('open');
  if (backdrop) backdrop.classList.add('open');
}

function closeDispositionSheet() {
  const sheet = document.getElementById('disposition-sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  if (sheet) sheet.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');

  // Reset selected state
  selectedDisposition = null;
  document.querySelectorAll('.btn-disposition').forEach(btn => btn.classList.remove('selected'));
  const cbGroup = document.getElementById('callback-picker-group');
  if (cbGroup) cbGroup.classList.remove('visible');
}

// Select a disposition button
function selectDisposition(dispCode, btnElement) {
  selectedDisposition = dispCode;

  document.querySelectorAll('.btn-disposition').forEach(btn => btn.classList.remove('selected'));
  if (btnElement) btnElement.classList.add('selected');

  const cbGroup = document.getElementById('callback-picker-group');
  if (cbGroup) {
    if (dispCode === 'callback_requested') {
      cbGroup.classList.add('visible');
      // Set default callback time to 1 hour from now
      const cbInput = document.getElementById('callback-time');
      if (cbInput && !cbInput.value) {
        const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
        cbInput.value = inOneHour.toISOString().slice(0, 16);
      }
    } else {
      cbGroup.classList.remove('visible');
    }
  }
}

// Submit call disposition
async function submitDisposition() {
  if (!currentLead) return;
  if (!selectedDisposition) {
    alert('Please select a call outcome before submitting.');
    return;
  }

  const notesEl = document.getElementById('call-notes');
  const notes = notesEl ? notesEl.value.trim() : '';

  let callbackTime = null;
  if (selectedDisposition === 'callback_requested') {
    const cbInput = document.getElementById('callback-time');
    if (cbInput && cbInput.value) {
      callbackTime = new Date(cbInput.value).toISOString();
    } else {
      callbackTime = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    }
  }

  try {
    const res = await fetch(`/api/crm/leads/${currentLead.id}/disposition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caller_id: currentCallerId,
        disposition: selectedDisposition,
        notes,
        callback_time: callbackTime
      })
    });

    if (res.ok) {
      closeDispositionSheet();
      if (notesEl) notesEl.value = '';
      await loadQueue();
    } else {
      const data = await res.json();
      alert('Error saving disposition: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('Error submitting disposition:', err);
    alert('Failed to submit disposition. Please check connection.');
  }
}

// Update duty status
async function handleStatusChange(event) {
  const newStatus = event.target.value;
  try {
    await fetch(`/api/crm/callers/${currentCallerId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    await loadQueue();
  } catch (err) {
    console.error('Failed to update caller status:', err);
  }
}

// Attach event listeners upon DOM load
document.addEventListener('DOMContentLoaded', () => {
  const callBtn = document.getElementById('btn-call');
  if (callBtn) {
    callBtn.addEventListener('click', handleCallClick);
  }

  const openSheetBtn = document.getElementById('btn-open-sheet');
  if (openSheetBtn) {
    openSheetBtn.addEventListener('click', openDispositionSheet);
  }

  const closeBtn = document.getElementById('btn-close-sheet');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDispositionSheet);
  }

  const backdrop = document.getElementById('sheet-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', closeDispositionSheet);
  }

  const submitBtn = document.getElementById('btn-submit-disposition');
  if (submitBtn) {
    submitBtn.addEventListener('click', submitDisposition);
  }

  const refreshBtn = document.getElementById('btn-refresh-queue');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadQueue);
  }

  const statusSelect = document.getElementById('status-select');
  if (statusSelect) {
    statusSelect.addEventListener('change', handleStatusChange);
  }

  initDialer();
});
