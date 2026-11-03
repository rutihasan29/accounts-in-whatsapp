const BENGALI_DIGIT_MAP = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9'
};

function toStandardNumber(str) {
  if (!str || typeof str !== 'string') return null;
  const normalized = str.replace(/[০-৯]/g, (char) => BENGALI_DIGIT_MAP[char] || char).trim();
  if (normalized === '') return null;
  const num = Number(normalized);
  return isNaN(num) ? null : num;
}

const BILL_REGEX = /^বিল\s+([০-৯\d]+(?:\.[০-৯\d]+)?)\s*টাকা$/i;
const PAYMENT_REGEX = /^([০-৯\d]+(?:\.[০-৯\d]+)?)\s*টাকা\s*পেয়েছি(?:[,\s]+ধন্যবাদ)?$/i;
const SET_DUE_REGEX = /^বকেয়া\s+([০-৯\d]+(?:\.[০-৯\d]+)?)\s*টাকা$/i;
const DUE_CMD_REGEX = /^(?:!|\/)?(?:due|dues|baki|বকেয়া|বকেয়া\s*তালিকা)$/i;
const VIDEO_CMD_REGEX = /^(?:!|\/)?(?:video|ভিডিও)(?:\s+(add|remove|delete|list))?(?:\s+([+\d]+)(?:\s+(.*))?)?$/i;
const HELP_CMD_REGEX = /^(?:!|\/)?(?:help|menu|commands|cmd|helpme|সাহায্য|হেল্প)$/i;
const STATUS_CMD_REGEX = /^(?:!|\/)?(?:status|bot|uptime|ping|পিং|স্ট্যাটাস)$/i;
const STATS_CMD_REGEX = /^(?:!|\/)?(?:stats|summary|হিসাব|রিপোর্ট|report)$/i;

function parseMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  if (HELP_CMD_REGEX.test(trimmed)) {
    return { type: 'COMMAND_HELP', rawText: trimmed };
  }

  if (STATUS_CMD_REGEX.test(trimmed)) {
    return { type: 'COMMAND_STATUS', rawText: trimmed };
  }

  if (STATS_CMD_REGEX.test(trimmed)) {
    return { type: 'COMMAND_STATS', rawText: trimmed };
  }

  if (DUE_CMD_REGEX.test(trimmed)) {
    return { type: 'COMMAND_DUE', rawText: trimmed };
  }

  const videoMatch = trimmed.match(VIDEO_CMD_REGEX);
  if (videoMatch) {
    let subAction = (videoMatch[1] || 'list').toLowerCase();
    if (subAction === 'delete') subAction = 'remove';
    return {
      type: 'COMMAND_VIDEO',
      subAction,
      phone: videoMatch[2] ? videoMatch[2].replace(/\D/g, '') : null,
      note: videoMatch[3] ? videoMatch[3].trim() : null,
      rawText: trimmed
    };
  }

  const setDueMatch = trimmed.match(SET_DUE_REGEX);
  if (setDueMatch) {
    const amount = toStandardNumber(setDueMatch[1]);
    if (amount !== null && amount >= 0) {
      return { type: 'SET_DUE', amount, rawText: trimmed };
    }
  }

  const billMatch = trimmed.match(BILL_REGEX);
  if (billMatch) {
    const amount = toStandardNumber(billMatch[1]);
    if (amount !== null && amount > 0) {
      return { type: 'BILL', amount, rawText: trimmed };
    }
  }

  const paymentMatch = trimmed.match(PAYMENT_REGEX);
  if (paymentMatch) {
    const amount = toStandardNumber(paymentMatch[1]);
    if (amount !== null && amount > 0) {
      return { type: 'PAYMENT', amount, rawText: trimmed };
    }
  }

  return null;
}

module.exports = {
  toStandardNumber,
  parseMessage
};
