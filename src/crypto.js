const crypto = require('crypto');
function key(){ return crypto.createHash('sha256').update(process.env.APP_ENCRYPTION_KEY || 'review1-demo-key-change-me').digest(); }
function encrypt(text){ const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm', key(), iv); const enc=Buffer.concat([cipher.update(String(text),'utf8'), cipher.final()]); const tag=cipher.getAuthTag(); return [iv.toString('hex'),tag.toString('hex'),enc.toString('hex')].join(':'); }
function decrypt(payload){ const [ivHex,tagHex,dataHex]=String(payload).split(':'); const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(ivHex,'hex')); decipher.setAuthTag(Buffer.from(tagHex,'hex')); return Buffer.concat([decipher.update(Buffer.from(dataHex,'hex')),decipher.final()]).toString('utf8'); }
module.exports={encrypt,decrypt};
