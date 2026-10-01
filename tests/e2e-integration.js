const assert = require('assert');
const http = require('http');

// Helper to make requests with cookie jar
class TestClient {
  constructor(port) {
    this.port = port;
    this.cookies = [];
  }

  request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: this.port,
        path: path,
        method: method,
        headers: {
          ...headers
        }
      };

      if (this.cookies.length > 0) {
        options.headers['Cookie'] = this.cookies.join('; ');
      }

      let payload = null;
      if (body) {
        if (typeof body === 'object') {
          payload = new URLSearchParams(body).toString();
          options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
          payload = body;
        }
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const setCookies = res.headers['set-cookie'];
          if (setCookies) {
            setCookies.forEach(c => {
              const part = c.split(';')[0];
              this.cookies = this.cookies.filter(existing => !existing.startsWith(part.split('=')[0]));
              this.cookies.push(part);
            });
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

async function runE2E() {
  console.log('====================================================');
  console.log('EXAM SENTRY END-TO-END HTTP WORKFLOW TEST');
  console.log('====================================================\n');

  const store = require('../src/store');
  store.mutate(d => {
    d.users = d.users.filter(u => u.role === 'AUTHORIZER');
    d.whitelist = [];
  });

  const client = new TestClient(3000);

  // 1. Landing Page
  console.log('[E2E 1] GET / (Landing page)...');
  const resLanding = await client.request('GET', '/');
  assert.strictEqual(resLanding.statusCode, 200);
  assert(resLanding.body.includes('EXAM SENTRY'));
  assert(resLanding.body.includes('SECURE. MONITOR. TRACE.'));
  console.log('-> PASS: Landing page renders EXAM SENTRY branding.\n');

  // 2. Default-Deny: Whitelist check for unknown email
  console.log('[E2E 2] Default-Deny: Check whitelist for unauthorized email...');
  const resCheckUnknown = await client.request('GET', '/api/check-whitelist?email=random@gmail.com');
  const unknownData = JSON.parse(resCheckUnknown.body);
  assert.strictEqual(unknownData.status, 'NOT_WHITELISTED');
  console.log('-> PASS: random@gmail.com is NOT_WHITELISTED (Default Deny verified).\n');

  // 3. Attempt Signup without Whitelist (Must Fail)
  console.log('[E2E 3] Attempt Paper Setter signup without authorization...');
  const resDeniedSignup = await client.request('POST', '/signup', {
    name: 'Unauth User',
    email: 'random@gmail.com',
    password: 'Password@123',
    confirmPassword: 'Password@123'
  });
  assert(resDeniedSignup.body.includes('Your email has not been authorized by the Exam Sentry Authorizer'));
  console.log('-> PASS: Unauthorized registration denied.\n');

  // 4. Authorizer Login
  console.log('[E2E 4] Authorizer Login (faisaldiddi@gmail.com)...');
  const resAuthLogin = await client.request('POST', '/login', {
    email: 'faisaldiddi@gmail.com',
    password: 'Pass@123'
  });
  assert.strictEqual(resAuthLogin.statusCode, 302);
  assert.strictEqual(resAuthLogin.headers.location, '/otp');

  // Retrieve OTP from store
  const db = store.read();
  const authOtpEntry = db.otps.find(o => o.email === 'faisaldiddi@gmail.com');
  assert(authOtpEntry, "OTP exists for Authorizer");

  // Since hash is bcrypt, find corresponding OTP or set known OTP
  const bcrypt = require('bcryptjs');
  let validOtp = null;
  // Test otp from session or generate match
  for (let i = 100000; i <= 999999; i += 10000) {
    if (bcrypt.compareSync(String(i), authOtpEntry.hash)) { validOtp = String(i); break; }
  }
  if (!validOtp) {
    // Override hash with known OTP for test
    validOtp = '123456';
    store.mutate(d => {
      const o = d.otps.find(x => x.email === 'faisaldiddi@gmail.com');
      if (o) o.hash = bcrypt.hashSync('123456', 8);
    });
  }

  const resAuthOtp = await client.request('POST', '/otp', { otp: validOtp });
  assert.strictEqual(resAuthOtp.statusCode, 302);
  assert.strictEqual(resAuthOtp.headers.location, '/dashboard');

  const resAuthDash = await client.request('GET', '/dashboard');
  assert.strictEqual(resAuthDash.statusCode, 200);
  assert(resAuthDash.body.includes('Authorizer Command Center'));
  console.log('-> PASS: Authorizer authenticated and dashboard accessed.\n');

  // 5. Authorizer Whitelists a Paper Setter
  console.log('[E2E 5] Authorizer Whitelists faculty setter@institution.edu...');
  const resWhitelist = await client.request('POST', '/authorizer/whitelist', {
    email: 'setter@institution.edu',
    notes: 'Mechanical Engineering Department'
  });
  assert.strictEqual(resWhitelist.statusCode, 302);

  const resCheckSetter = await client.request('GET', '/api/check-whitelist?email=setter@institution.edu');
  const setterData = JSON.parse(resCheckSetter.body);
  assert.strictEqual(setterData.status, 'WHITELISTED');
  console.log('-> PASS: setter@institution.edu is now WHITELISTED.\n');

  // 6. Paper Setter Registers Successfully
  console.log('[E2E 6] Paper Setter completes registration...');
  const setterClient = new TestClient(3000);
  const resSetterSignup = await setterClient.request('POST', '/signup', {
    name: 'Prof. Faisal Setter',
    email: 'setter@institution.edu',
    password: 'Password@123',
    confirmPassword: 'Password@123'
  });
  assert(resSetterSignup.body.includes('Registration authorized and completed successfully'));

  const resCheckSetterAfter = await client.request('GET', '/api/check-whitelist?email=setter@institution.edu');
  const setterDataAfter = JSON.parse(resCheckSetterAfter.body);
  assert.strictEqual(setterDataAfter.status, 'REGISTERED');
  console.log('-> PASS: Paper Setter registered and whitelist status updated to REGISTERED.\n');

  // 7. Paper Setter Logs in
  console.log('[E2E 7] Paper Setter logs in...');
  const resSetterLogin = await setterClient.request('POST', '/login', {
    email: 'setter@institution.edu',
    password: 'Password@123'
  });
  assert.strictEqual(resSetterLogin.statusCode, 302);

  // Set known OTP for setter
  store.mutate(d => {
    const o = d.otps.find(x => x.email === 'setter@institution.edu');
    if (o) o.hash = bcrypt.hashSync('654321', 8);
  });
  const resSetterOtp = await setterClient.request('POST', '/otp', { otp: '654321' });
  assert.strictEqual(resSetterOtp.statusCode, 302);

  const resSetterDash = await setterClient.request('GET', '/dashboard');
  assert.strictEqual(resSetterDash.statusCode, 200);
  assert(resSetterDash.body.includes('Paper Setter Workspace'));
  assert(resSetterDash.body.includes('AI Auto Generate'));
  assert(resSetterDash.body.includes('Manual Create'));
  assert(resSetterDash.body.includes('Redefine Existing Paper'));
  console.log('-> PASS: Paper Setter dashboard active with 3 authoring modes.\n');

  // 8. Revocation Test: Authorizer Revokes Paper Setter
  console.log('[E2E 8] Authorizer Revokes Paper Setter Access...');
  const resRevoke = await client.request('POST', '/authorizer/revoke', {
    email: 'setter@institution.edu'
  });
  assert.strictEqual(resRevoke.statusCode, 302);

  // Check Setter Whitelist Status
  const resCheckRevoked = await client.request('GET', '/api/check-whitelist?email=setter@institution.edu');
  const revokedData = JSON.parse(resCheckRevoked.body);
  assert.strictEqual(revokedData.status, 'REVOKED');

  // Next protected request from Setter MUST receive 403 ACCESS REVOKED
  console.log('[E2E 9] Verifying Revoked User is immediately blocked with 403...');
  const resBlocked = await setterClient.request('GET', '/papers/ai-wizard');
  assert.strictEqual(resBlocked.statusCode, 403);
  assert(resBlocked.body.includes('Access Revoked'));
  console.log('-> PASS: Revoked user received 403 Access Revoked.\n');

  // 9. Restore Test: Authorizer Restores Paper Setter
  console.log('[E2E 10] Authorizer Restores Paper Setter...');
  const resRestore = await client.request('POST', '/authorizer/restore', {
    email: 'setter@institution.edu'
  });
  assert.strictEqual(resRestore.statusCode, 302);

  const resCheckRestored = await client.request('GET', '/api/check-whitelist?email=setter@institution.edu');
  const restoredData = JSON.parse(resCheckRestored.body);
  assert.strictEqual(restoredData.status, 'REGISTERED');

  // Restored user logs in again without re-registering
  const resReLogin = await setterClient.request('POST', '/login', {
    email: 'setter@institution.edu',
    password: 'Password@123'
  });
  assert.strictEqual(resReLogin.statusCode, 302);
  console.log('-> PASS: Restored user can log in again without re-registering.\n');

  console.log('====================================================');
  console.log('ALL E2E WORKFLOW TESTS COMPLETED SUCCESSFULLY (10/10)');
  console.log('====================================================\n');
  process.exit(0);
}

runE2E().catch(err => {
  console.error('E2E TEST FAILURE:', err);
  process.exit(1);
});
