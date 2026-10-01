const crypto = require('crypto');

function id(prefix = 'ES') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function riskFrom(db, userId) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const events = (db.securityEvents || []).filter(
    e => e.userId === userId && new Date(e.createdAt).getTime() >= since
  );
  let score = 5;
  const weights = {
    FAILED_LOGIN: 10,
    WRONG_OTP: 10,
    FACE_LOST: 20,
    CAMERA_BLOCKED: 30,
    CAMERA_DISCONNECTED: 30,
    UNAUTHORIZED_ACTION: 25,
    REPEATED_OPEN: 10,
    TAB_SWITCH: 15,
    WINDOW_BLUR: 15
  };
  for (const e of events) {
    score += weights[e.type] || 5;
  }
  score = Math.min(100, score);
  return {
    score,
    level: score <= 30 ? 'LOW' : score <= 60 ? 'MEDIUM' : 'HIGH'
  };
}

module.exports = {
  id,
  normalizeEmail,
  riskFrom
};
