const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function getDefaultDb() {
  return {
    users: [],
    whitelist: [],
    papers: [],
    blueprintSnapshots: {},
    otps: [],
    auditLogs: [],
    securityEvents: []
  };
}

function read() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const initial = getDefaultDb();
      write(initial);
      return initial;
    }
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    // Ensure all required collections exist
    return {
      users: data.users || [],
      whitelist: data.whitelist || [],
      papers: data.papers || [],
      blueprintSnapshots: data.blueprintSnapshots || {},
      otps: data.otps || [],
      auditLogs: data.auditLogs || [],
      securityEvents: data.securityEvents || []
    };
  } catch (err) {
    console.error('Error reading db.json:', err);
    return getDefaultDb();
  }
}

function write(db) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function mutate(fn) {
  const db = read();
  const result = fn(db);
  write(db);
  return result;
}

module.exports = {
  read,
  write,
  mutate,
  getDefaultDb
};
