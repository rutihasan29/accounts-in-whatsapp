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
const PAYMENT_REGEX = /^([০-৯\d]+(?:\.[০-৯\d]+)?)\s*টাকা\s*পেয়েছি[,\s]+ধন্যবাদ$/i;
const DUE_CMD_REGEX = /^!due$/i;

function parseMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  if (DUE_CMD_REGEX.test(trimmed)) {
    return { type: 'COMMAND_DUE', rawText: trimmed };
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
