require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const path = require('path');
const multer = require('multer');
const store = require('./src/store');
const { encrypt, decrypt } = require('./src/crypto');
const { id, normalizeEmail, riskFrom } = require('./src/security');
const { BlueprintParser } = require('./src/blueprintParser');
const { RedefineParser } = require('./src/redefineParser');
const { generateQuestionsWithGemini } = require('./src/geminiService');
const { distributeMarksByWeightage, generateAutoPattern, calculateMarksSummary } = require('./src/patternEngine');
const { validatePaperCompliance } = require('./src/validator');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTHORIZER_EMAIL = normalizeEmail(process.env.AUTHORIZER_EMAIL || 'faisaldiddi@gmail.com');

// Multer in-memory storage for handling uploaded blueprints and question papers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB limit
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'exam-sentry-session-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 8 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax'
    }
  })
);

function now() {
  return new Date().toISOString();
}

function audit(userId, action, meta = {}, userEmail = '') {
  store.mutate(db => {
    db.auditLogs.unshift({
      id: id('LOG'),
      userId,
      userEmail,
      action,
      meta,
      createdAt: now()
    });
  });
}

function event(userId, type, severity = 'MEDIUM', meta = {}) {
  store.mutate(db => {
    db.securityEvents.unshift({
      id: id('SEC'),
      userId,
      type,
      severity,
      meta,
      createdAt: now()
    });
  });
}

// Ensure default authorizer exists on startup; zero paper setters in whitelist
function seedAuthorizer() {
  store.mutate(db => {
    const existing = db.users.find(u => u.role === 'AUTHORIZER' || u.email === AUTHORIZER_EMAIL);
    if (!existing) {
      const pwHash = bcrypt.hashSync('Pass@123', 10);
      db.users.push({
        id: 'USR-AUTHORIZER-1',
        name: 'Exam Sentry Authorizer',
        email: AUTHORIZER_EMAIL,
        passwordHash: pwHash,
        role: 'AUTHORIZER',
        staffCode: 'AUTH-001',
        active: true,
        sessionVersion: 1,
        createdAt: now()
      });
      console.log(`[EXAM SENTRY] Seeded Authorizer: ${AUTHORIZER_EMAIL}`);
    }
  });
}
seedAuthorizer();

// Authentication middleware
function auth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// Role-based authorization middleware
function role(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      if (req.session.user) {
        event(req.session.user.id, 'UNAUTHORIZED_ACTION', 'HIGH', { path: req.path });
      }
      return res.status(403).render('message', {
        title: 'Access Denied',
        message: 'Your role is not authorized to perform this operation.'
      });
    }
    next();
  };
}

// Strict Paper Setter Whitelist Enforcement Middleware
function requirePaperSetterAuthorization(req, res, next) {
  if (!req.session.user) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }

  // Authorizer has separate authority
  if (req.session.user.role === 'AUTHORIZER') {
    return next();
  }

  if (req.session.user.role === 'PAPER_SETTER') {
    const db = store.read();
    const user = db.users.find(u => u.id === req.session.user.id);
    const normalized = normalizeEmail(user?.email || req.session.user.email);
    const whitelistEntry = db.whitelist.find(w => normalizeEmail(w.email) === normalized);

    // If revoked or not active or session version bumped
    const isRevoked = !whitelistEntry ||
                      whitelistEntry.status === 'REVOKED' ||
                      !user ||
                      user.active === false ||
                      (user.sessionVersion && user.sessionVersion !== req.session.user.sessionVersion);

    if (isRevoked) {
      req.session.destroy(() => {});
      if (req.xhr || req.headers.accept?.includes('json')) {
        return res.status(403).json({
          code: 'ACCESS_REVOKED',
          error: 'Your Paper Setter access has been revoked by the Exam Sentry Authorizer.'
        });
      }
      return res.status(403).render('message', {
        title: 'Access Revoked',
        message: 'Your Paper Setter access has been revoked by the Exam Sentry Authorizer.'
      });
    }
  }

  next();
}

function viewData(req, extra = {}) {
  const db = store.read();
  const user = req.session.user ? db.users.find(u => u.id === req.session.user.id) : null;
  return {
    user,
    risk: user ? riskFrom(db, user.id) : { score: 0, level: 'LOW' },
    ...extra
  };
}

async function sendOtp(email, otp) {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await t.sendMail({
      from: process.env.SMTP_FROM || 'EXAM SENTRY <no-reply@examsentry.internal>',
      to: email,
      subject: 'EXAM SENTRY — Two-Factor Verification Code',
      text: `Your EXAM SENTRY verification code is ${otp}. It expires in 5 minutes.`
    });
  } else {
    console.log(`\n=========================================\n[EXAM SENTRY OTP] For ${email}: ${otp}\n=========================================\n`);
  }
}

// ----------------------------------------------------------------------
// PUBLIC & AUTHENTICATION ROUTES
// ----------------------------------------------------------------------

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('landing', { user: null });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, email: req.query.email || '' });
});

app.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  const db = store.read();

  const user = db.users.find(u => normalizeEmail(u.email) === email);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    if (user) event(user.id, 'FAILED_LOGIN', 'MEDIUM', { email });
    return res.render('login', { error: 'Invalid email address or password.', email });
  }

  // Paper Setter authorization verification (Default Deny check)
  if (user.role === 'PAPER_SETTER') {
    const whitelistEntry = db.whitelist.find(w => normalizeEmail(w.email) === email);
    if (!whitelistEntry || whitelistEntry.status !== 'REGISTERED' || !user.active) {
      if (whitelistEntry && whitelistEntry.status === 'REVOKED') {
        event(user.id, 'UNAUTHORIZED_LOGIN_ATTEMPT', 'HIGH', { reason: 'User revoked' });
        return res.render('login', {
          error: 'Your Paper Setter access has been revoked by the Exam Sentry Authorizer.',
          email
        });
      }
      return res.render('login', {
        error: 'Your email has not been authorized by the Exam Sentry Authorizer.',
        email
      });
    }
  }

  // Generate 6-digit OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const hash = bcrypt.hashSync(otp, 8);

  store.mutate(d => {
    d.otps = d.otps.filter(o => o.email !== email);
    d.otps.push({ email, hash, expiresAt: Date.now() + 5 * 60 * 1000 });
  });

  req.session.pendingUserId = user.id;
  req.session.demoOtp = !process.env.SMTP_HOST ? otp : null;

  await sendOtp(user.email, otp);
  res.redirect('/otp');
});

app.get('/otp', (req, res) => {
  if (!req.session.pendingUserId) return res.redirect('/login');
  res.render('otp', { error: null, demoOtp: req.session.demoOtp });
});

app.post('/otp', (req, res) => {
  const db = store.read();
  const user = db.users.find(u => u.id === req.session.pendingUserId);
  const otpEntry = db.otps.find(o => o.email === user?.email);

  if (!user || !otpEntry || Date.now() > otpEntry.expiresAt || !bcrypt.compareSync(String(req.body.otp), otpEntry.hash)) {
    if (user) event(user.id, 'WRONG_OTP', 'MEDIUM');
    return res.render('otp', { error: 'Invalid or expired OTP verification code.', demoOtp: req.session.demoOtp });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sessionVersion: user.sessionVersion || 1
  };
  delete req.session.pendingUserId;
  delete req.session.demoOtp;

  store.mutate(d => {
    d.otps = d.otps.filter(x => x.email !== user.email);
  });

  audit(user.id, 'LOGIN_SUCCESS', { role: user.role }, user.email);
  res.redirect('/dashboard');
});

app.post('/logout', auth, (req, res) => {
  if (req.session.user) {
    audit(req.session.user.id, 'LOGOUT', {}, req.session.user.email);
  }
  req.session.destroy(() => res.redirect('/login'));
});

// ----------------------------------------------------------------------
// PAPER SETTER SIGNUP & WHITELIST VERIFICATION API
// ----------------------------------------------------------------------

app.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('signup', { error: null });
});

// Live whitelist verification endpoint
app.get('/api/check-whitelist', (req, res) => {
  const email = normalizeEmail(req.query.email);
  if (!email) return res.json({ status: 'INVALID_EMAIL' });

  const db = store.read();
  const entry = db.whitelist.find(w => normalizeEmail(w.email) === email);

  if (!entry) {
    return res.json({ status: 'NOT_WHITELISTED' });
  }
  return res.json({ status: entry.status });
});

app.post('/signup', async (req, res) => {
  const { name, password, confirmPassword } = req.body;
  const email = normalizeEmail(req.body.email);

  if (!name || !email || !password) {
    return res.render('signup', { error: 'All fields are required.', name, email });
  }

  if (password !== confirmPassword) {
    return res.render('signup', { error: 'Passwords do not match.', name, email });
  }

  const db = store.read();
  const whitelistEntry = db.whitelist.find(w => normalizeEmail(w.email) === email);

  if (!whitelistEntry) {
    return res.render('signup', {
      error: 'Your email has not been authorized by the Exam Sentry Authorizer.',
      name,
      email
    });
  }

  if (whitelistEntry.status === 'REVOKED') {
    return res.render('signup', {
      error: 'Your Paper Setter access has been revoked by the Exam Sentry Authorizer.',
      name,
      email
    });
  }

  if (whitelistEntry.status === 'REGISTERED') {
    return res.render('signup', {
      error: 'This email is already registered. Please sign in.',
      name,
      email
    });
  }

  // Create Paper Setter user and update whitelist status in atomic mutation
  const userId = id('USR-SET');
  const passwordHash = bcrypt.hashSync(password, 10);

  store.mutate(d => {
    d.users.push({
      id: userId,
      name: name.trim(),
      email: email,
      passwordHash: passwordHash,
      role: 'PAPER_SETTER',
      staffCode: id('STF'),
      active: true,
      sessionVersion: 1,
      createdAt: now()
    });

    const w = d.whitelist.find(x => normalizeEmail(x.email) === email);
    if (w) {
      w.status = 'REGISTERED';
      w.registeredUserId = userId;
      w.updatedAt = now();
    }
  });

  audit(userId, 'PAPER_SETTER_REGISTERED', { email }, email);
  res.render('login', {
    error: null,
    success: 'Registration authorized and completed successfully! Please sign in.',
    email
  });
});

// ----------------------------------------------------------------------
// AUTHORIZER DASHBOARD & WHITELIST ACTIONS
// ----------------------------------------------------------------------

app.get('/dashboard', auth, (req, res) => {
  const db = store.read();
  const user = req.session.user;

  if (user.role === 'AUTHORIZER') {
    const tab = req.query.tab || 'overview';
    const whitelistedEntries = db.whitelist.filter(w => w.status === 'WHITELISTED');
    const registeredUsers = db.users
      .filter(u => u.role === 'PAPER_SETTER' && u.active)
      .map(u => ({
        ...u,
        paperCount: db.papers.filter(p => p.createdBy === u.id).length
      }));
    const revokedUsers = db.whitelist
      .filter(w => w.status === 'REVOKED')
      .map(w => {
        const u = db.users.find(x => x.id === w.registeredUserId || normalizeEmail(x.email) === normalizeEmail(w.email));
        return {
          email: w.email,
          name: u?.name || 'Educator',
          revokedAt: w.revokedAt,
          revokedBy: w.revokedBy
        };
      });

    const counts = {
      whitelisted: whitelistedEntries.length,
      registered: registeredUsers.length,
      revoked: revokedUsers.length,
      totalPapers: db.papers.length,
      approvedPapers: db.papers.filter(p => p.status === 'APPROVED' || p.status === 'LOCKED').length
    };

    return res.render(
      'authorizer-dashboard',
      viewData(req, {
        currentTab: tab,
        counts,
        whitelistedEntries,
        registeredUsers,
        revokedUsers,
        papers: db.papers,
        message: req.query.message || null,
        error: req.query.error || null,
        geminiAvailable: Boolean(process.env.GEMINI_API_KEY)
      })
    );
  }

  // Paper Setter Dashboard
  const myPapers = db.papers.filter(p => p.createdBy === user.id);
  const counts = {
    total: myPapers.length,
    draft: myPapers.filter(p => p.status === 'DRAFT' || p.status === 'BLUEPRINT_ANALYSED').length,
    pending: myPapers.filter(p => p.status === 'VALIDATED' || p.status === 'GENERATED').length,
    approved: myPapers.filter(p => p.status === 'APPROVED' || p.status === 'LOCKED').length
  };

  res.render(
    'dashboard',
    viewData(req, {
      counts,
      papers: myPapers
    })
  );
});

// Shortcut routes for Authorizer tabs
app.get('/authorizer/whitelist', auth, role('AUTHORIZER'), (req, res) => res.redirect('/dashboard?tab=whitelist'));
app.get('/authorizer/setters', auth, role('AUTHORIZER'), (req, res) => res.redirect('/dashboard?tab=setters'));
app.get('/authorizer/revoked', auth, role('AUTHORIZER'), (req, res) => res.redirect('/dashboard?tab=revoked'));

// Authorizer adds email to whitelist
app.post('/authorizer/whitelist', auth, role('AUTHORIZER'), (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email || !email.includes('@')) {
    return res.redirect('/dashboard?tab=whitelist&error=Invalid email address provided.');
  }

  const db = store.read();
  const existing = db.whitelist.find(w => normalizeEmail(w.email) === email);

  if (existing) {
    if (existing.status === 'REGISTERED') {
      return res.redirect('/dashboard?tab=whitelist&error=User is already registered.');
    }
    if (existing.status === 'REVOKED') {
      return res.redirect('/dashboard?tab=revoked&error=User is revoked. Use Restore User to re-grant access.');
    }
    return res.redirect('/dashboard?tab=whitelist&error=Email is already on whitelist.');
  }

  store.mutate(d => {
    d.whitelist.push({
      id: id('WHT'),
      email: email,
      status: 'WHITELISTED',
      createdBy: req.session.user.email,
      createdAt: now(),
      updatedAt: now(),
      registeredUserId: null,
      revokedAt: null,
      revokedBy: null
    });
  });

  audit(req.session.user.id, 'PAPER_SETTER_WHITELISTED', { email }, req.session.user.email);
  res.redirect(`/dashboard?tab=whitelist&message=${encodeURIComponent(`Successfully whitelisted ${email}`)}`);
});

// Authorizer removes whitelist entry
app.post('/authorizer/remove-whitelist', auth, role('AUTHORIZER'), (req, res) => {
  const { id: entryId } = req.body;
  store.mutate(d => {
    d.whitelist = d.whitelist.filter(w => w.id !== entryId);
  });
  res.redirect('/dashboard?tab=whitelist&message=Whitelist entry removed.');
});

// Authorizer revokes a paper setter
app.post('/authorizer/revoke', auth, role('AUTHORIZER'), (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { userId } = req.body;

  store.mutate(d => {
    // Update whitelist entry
    const w = d.whitelist.find(x => normalizeEmail(x.email) === email);
    if (w) {
      w.status = 'REVOKED';
      w.revokedAt = now();
      w.revokedBy = req.session.user.email;
      w.updatedAt = now();
    } else {
      d.whitelist.push({
        id: id('WHT'),
        email: email,
        status: 'REVOKED',
        createdBy: req.session.user.email,
        createdAt: now(),
        updatedAt: now(),
        registeredUserId: userId || null,
        revokedAt: now(),
        revokedBy: req.session.user.email
      });
    }

    // Invalidate user account and bump session version
    const u = d.users.find(x => (userId && x.id === userId) || normalizeEmail(x.email) === email);
    if (u) {
      u.active = false;
      u.sessionVersion = (u.sessionVersion || 1) + 1;
    }
  });

  audit(req.session.user.id, 'PAPER_SETTER_REVOKED', { email, userId }, req.session.user.email);
  res.redirect(`/dashboard?tab=setters&message=${encodeURIComponent(`Access revoked for ${email}. Active sessions invalidated.`)}`);
});

// Authorizer restores a revoked paper setter
app.post('/authorizer/restore', auth, role('AUTHORIZER'), (req, res) => {
  const email = normalizeEmail(req.body.email);

  store.mutate(d => {
    const w = d.whitelist.find(x => normalizeEmail(x.email) === email);
    if (w) {
      w.status = 'REGISTERED';
      w.revokedAt = null;
      w.revokedBy = null;
      w.updatedAt = now();
    }
    const u = d.users.find(x => normalizeEmail(x.email) === email);
    if (u) {
      u.active = true;
      u.sessionVersion = (u.sessionVersion || 1) + 1;
    }
  });

  audit(req.session.user.id, 'PAPER_SETTER_RESTORED', { email }, req.session.user.email);
  res.redirect(`/dashboard?tab=revoked&message=${encodeURIComponent(`Access restored for ${email}. User may log in immediately.`)}`);
});

// ----------------------------------------------------------------------
// AI AUTO GENERATE WIZARD (STRICT CLOSED-SCOPE & ZERO CONTAMINATION)
// ----------------------------------------------------------------------

// Launch wizard with brand new paperId (Fresh isolation: clears old subject/blueprint/context)
app.get('/papers/ai-wizard', auth, requirePaperSetterAuthorization, (req, res) => {
  const newPaperId = id('ES-PAP');
  const freshPaper = {
    id: newPaperId,
    title: 'Automated Examination Paper',
    subject: '',
    subjectCode: '',
    institution: '',
    department: '',
    semester: '',
    exam: 'Semester Examination',
    duration: '2 Hours',
    marks: 20,
    difficulty: 'MODERATE',
    mode: 'AI_AUTO_GENERATE',
    status: 'DRAFT',
    sections: [],
    encryptedContent: '',
    createdBy: req.session.user.id,
    creatorEmail: req.session.user.email,
    createdAt: now(),
    updatedAt: now()
  };

  store.mutate(d => {
    d.papers.unshift(freshPaper);
  });

  audit(req.session.user.id, 'PAPER_GENERATION_STARTED', { paperId: newPaperId }, req.session.user.email);

  res.render(
    'ai-wizard',
    viewData(req, {
      paper: freshPaper,
      step: 1,
      error: null,
      academicScope: null
    })
  );
});

// Step 1: Upload Blueprint
app.post(
  '/papers/:id/ai/upload-blueprint',
  auth,
  requirePaperSetterAuthorization,
  upload.single('blueprintFile'),
  async (req, res) => {
    const paperId = req.params.id;
    const db = store.read();
    const paper = db.papers.find(p => p.id === paperId);

    if (!paper) {
      return res.status(404).render('message', { title: 'Not Found', message: 'Paper session not found.' });
    }

    if (!req.file) {
      return res.render(
        'ai-wizard',
        viewData(req, {
          paper,
          step: 1,
          error: 'BLUEPRINT REQUIRED: Upload a blueprint PDF or image before generating a paper.',
          academicScope: null
        })
      );
    }

    try {
      // Parse blueprint using BlueprintParser
      const academicScope = await BlueprintParser.parse(req.file);

      // Save extracted academic scope attached to paper
      store.mutate(d => {
        const p = d.papers.find(x => x.id === paperId);
        if (p) {
          p.academicScope = academicScope;
          p.status = 'BLUEPRINT_ANALYSED';
          p.institution = academicScope.institution?.name || p.institution;
          p.department = academicScope.institution?.department || p.department;
          p.updatedAt = now();
        }
      });

      audit(req.session.user.id, 'BLUEPRINT_ANALYSED', { paperId, subject: academicScope.subject?.name }, req.session.user.email);

      res.render(
        'ai-wizard',
        viewData(req, {
          paper,
          step: 2,
          error: null,
          academicScope
        })
      );
    } catch (err) {
      console.error('Error parsing blueprint:', err);
      res.render(
        'ai-wizard',
        viewData(req, {
          paper,
          step: 1,
          error: err.message || 'Failed to extract syllabus from document.',
          academicScope: null
        })
      );
    }
  }
);

// Allow user to reset blueprint
app.post('/papers/:id/ai/change-blueprint', auth, requirePaperSetterAuthorization, (req, res) => {
  const paperId = req.params.id;
  store.mutate(d => {
    const p = d.papers.find(x => x.id === paperId);
    if (p) {
      p.academicScope = null;
      p.status = 'DRAFT';
      delete d.blueprintSnapshots[paperId];
    }
  });
  res.redirect('/papers/ai-wizard');
});

// Step 2 -> 3: Teacher Confirms Blueprint and Locks Academic Scope
app.post('/papers/:id/ai/confirm-blueprint', auth, requirePaperSetterAuthorization, (req, res) => {
  const paperId = req.params.id;
  const db = store.read();
  const paper = db.papers.find(p => p.id === paperId);

  if (!paper || !paper.academicScope) {
    return res.redirect('/papers/ai-wizard');
  }

  const scope = paper.academicScope;

  // Lock subject and subject code to paper, create ConfirmedBlueprintVersion
  store.mutate(d => {
    const p = d.papers.find(x => x.id === paperId);
    if (p) {
      p.subject = scope.subject?.name || 'General Examination';
      p.subjectCode = scope.subject?.code || '';
      p.semester = scope.exam?.semesterOrStandard || p.semester;
      p.status = 'BLUEPRINT_CONFIRMED';
      p.updatedAt = now();
    }
    d.blueprintSnapshots[paperId] = {
      blueprintId: id('BLU'),
      version: 1,
      paperId: paperId,
      subject: scope.subject?.name,
      subjectCode: scope.subject?.code,
      institution: scope.institution?.name,
      department: scope.institution?.department,
      modules: scope.modules,
      confirmedBy: req.session.user.email,
      confirmedAt: now()
    };
  });

  audit(req.session.user.id, 'BLUEPRINT_CONFIRMED', { paperId, subject: scope.subject?.name }, req.session.user.email);

  res.render(
    'ai-wizard',
    viewData(req, {
      paper: {
        ...paper,
        subject: scope.subject?.name,
        subjectCode: scope.subject?.code,
        status: 'BLUEPRINT_CONFIRMED'
      },
      step: 3,
      error: null,
      academicScope: scope
    })
  );
});

// Step 3 -> 4: Review confirmed blueprint
app.get('/papers/:id/ai/review-blueprint', auth, requirePaperSetterAuthorization, (req, res) => {
  const paperId = req.params.id;
  const db = store.read();
  const paper = db.papers.find(p => p.id === paperId);
  const snapshot = db.blueprintSnapshots[paperId];

  if (!paper || !snapshot) {
    return res.redirect('/papers/ai-wizard');
  }

  res.render(
    'ai-wizard',
    viewData(req, {
      paper,
      step: 2,
      error: null,
      academicScope: paper.academicScope || snapshot
    })
  );
});

// Step 4 -> 5: Generate Questions Inside Confirmed Scope
app.post('/papers/:id/ai/generate', auth, requirePaperSetterAuthorization, async (req, res) => {
  const paperId = req.params.id;
  const db = store.read();
  const paper = db.papers.find(p => p.id === paperId);
  const confirmedBlueprint = db.blueprintSnapshots[paperId];

  if (!paper || !confirmedBlueprint) {
    return res.status(400).render('message', {
      title: 'Blueprint Not Confirmed',
      message: 'BLUEPRINT NOT CONFIRMED: Examination generation cannot proceed without confirmed blueprint.'
    });
  }

  const marks = parseInt(req.body.marks || 20, 10);
  const difficulty = req.body.difficulty || 'MODERATE';

  try {
    // 1. Calculate deterministic marks distribution per module
    const marksAllocation = distributeMarksByWeightage(marks, confirmedBlueprint.modules);

    // 2. Generate examination sections pattern
    const patternSections = generateAutoPattern(marks);

    // 3. Generate questions strictly inside confirmed scope
    const generatedSections = await generateQuestionsWithGemini(confirmedBlueprint, patternSections, difficulty);

    // Calculate attemptable & printed marks
    calculateMarksSummary(generatedSections);

    // 4. Validate paper compliance
    const draftPaper = {
      ...paper,
      marks,
      difficulty,
      sections: generatedSections
    };

    const complianceReport = validatePaperCompliance(draftPaper, confirmedBlueprint);

    // 5. Encrypt content for secure persistence
    const serializedContent = JSON.stringify(generatedSections);
    const encryptedContent = encrypt(serializedContent);

    // Save paper
    store.mutate(d => {
      const p = d.papers.find(x => x.id === paperId);
      if (p) {
        p.marks = marks;
        p.difficulty = difficulty;
        p.sections = generatedSections;
        p.encryptedContent = encryptedContent;
        p.status = complianceReport.isValid ? 'VALIDATED' : 'VALIDATION_FAILED';
        p.complianceScore = complianceReport.complianceScore;
        p.complianceReport = complianceReport;
        p.updatedAt = now();
      }
    });

    audit(req.session.user.id, 'PAPER_GENERATED', { paperId, complianceScore: complianceReport.complianceScore }, req.session.user.email);

    res.render(
      'ai-wizard',
      viewData(req, {
        paper: {
          ...paper,
          marks,
          difficulty,
          sections: generatedSections,
          complianceScore: complianceReport.complianceScore
        },
        step: 5,
        error: null,
        complianceReport
      })
    );
  } catch (err) {
    console.error('Question generation failed:', err);
    res.render(
      'ai-wizard',
      viewData(req, {
        paper,
        step: 3,
        error: `Generation Failed: ${err.message}`
      })
    );
  }
});

// ----------------------------------------------------------------------
// MANUAL CREATE ROUTES (SUBJECT-AGNOSTIC & CLEAN OF BDA)
// ----------------------------------------------------------------------

app.get('/papers/new', auth, requirePaperSetterAuthorization, (req, res) => {
  res.render(
    'manual-create',
    viewData(req, {
      paper: null,
      error: null
    })
  );
});

app.post('/papers/manual', auth, requirePaperSetterAuthorization, (req, res) => {
  const { institution, department, subject, subjectCode, semester, duration, marks, sections } = req.body;

  if (!subject || !institution) {
    return res.render(
      'manual-create',
      viewData(req, {
        paper: req.body,
        error: 'Institution and Subject Title are required.'
      })
    );
  }

  // Parse structured dynamic sections
  const parsedSections = [];
  if (sections && typeof sections === 'object') {
    Object.keys(sections).forEach(sKey => {
      const s = sections[sKey];
      const questions = [];
      if (s.questions && typeof s.questions === 'object') {
        Object.keys(s.questions).forEach(qKey => {
          const q = s.questions[qKey];
          if (q.text && q.text.trim()) {
            questions.push({
              id: `Q${parseInt(sKey) + 1}-${parseInt(qKey) + 1}`,
              questionLabel: String.fromCharCode(97 + questions.length),
              questionText: q.text.trim(),
              marks: parseInt(s.marksPerQuestion || 2, 10),
              courseOutcome: null,
              bloomLevel: null
            });
          }
        });
      }

      const avail = parseInt(s.availableQuestions || questions.length, 10);
      const attempt = parseInt(s.questionsToAttempt || avail, 10);
      const marksPerQ = parseInt(s.marksPerQuestion || 2, 10);

      parsedSections.push({
        sectionId: `SEC-${parseInt(sKey) + 1}`,
        title: s.title || `Section ${parseInt(sKey) + 1}`,
        instruction: s.instruction || '',
        availableCount: avail,
        attemptCount: attempt,
        marksPerQuestion: marksPerQ,
        attemptableMarks: attempt * marksPerQ,
        questions
      });
    });
  }

  const paperId = id('ES-MAN');
  const serialized = JSON.stringify(parsedSections);

  const newPaper = {
    id: paperId,
    title: subject,
    subject: subject.trim(),
    subjectCode: (subjectCode || '').trim(),
    institution: institution.trim(),
    department: (department || '').trim(),
    semester: semester || 'Standard',
    exam: 'Examination',
    duration: duration || '2 Hours',
    marks: parseInt(marks || 20, 10),
    mode: 'MANUAL',
    status: 'DRAFT',
    sections: parsedSections,
    complianceScore: 100,
    encryptedContent: encrypt(serialized),
    createdBy: req.session.user.id,
    creatorEmail: req.session.user.email,
    createdAt: now(),
    updatedAt: now()
  };

  store.mutate(d => {
    d.papers.unshift(newPaper);
  });

  audit(req.session.user.id, 'PAPER_CREATED_MANUAL', { paperId, subject }, req.session.user.email);
  res.redirect('/papers');
});

// ----------------------------------------------------------------------
// REDEFINE EXISTING PAPER ROUTES
// ----------------------------------------------------------------------

app.get('/papers/redefine', auth, requirePaperSetterAuthorization, (req, res) => {
  res.render(
    'redefine',
    viewData(req, {
      step: 1,
      error: null,
      extractedData: null,
      paper: null
    })
  );
});

// Step 1: Upload Paper to Redefine (FILE REQUIRED)
app.post(
  '/papers/redefine/upload',
  auth,
  requirePaperSetterAuthorization,
  upload.single('paperFile'),
  async (req, res) => {
    if (!req.file) {
      return res.render(
        'redefine',
        viewData(req, {
          step: 1,
          error: 'FILE REQUIRED: Select a PDF or image of the existing question paper.',
          extractedData: null,
          paper: null
        })
      );
    }

    try {
      const extractedData = await RedefineParser.parse(req.file);

      // Verify that actual questions were found (not just instructions)
      const totalQuestions = (extractedData.sections || []).reduce((sum, s) => sum + (s.questions?.length || 0), 0);
      if (totalQuestions === 0) {
        return res.render(
          'redefine',
          viewData(req, {
            step: 1,
            error: 'INCOMPLETE PAPER EXTRACTION: No questions detected in document. Please upload a clear document.',
            extractedData: null,
            paper: null
          })
        );
      }

      req.session.redefineCache = extractedData;

      audit(req.session.user.id, 'REDEFINE_FILE_UPLOADED', { filename: req.file.originalname, totalQuestions }, req.session.user.email);

      res.render(
        'redefine',
        viewData(req, {
          step: 2,
          error: null,
          extractedData,
          paper: null
        })
      );
    } catch (err) {
      console.error('Error during redefine parse:', err);
      res.render(
        'redefine',
        viewData(req, {
          step: 1,
          error: err.message || 'Failed to process question paper.',
          extractedData: null,
          paper: null
        })
      );
    }
  }
);

// Step 2 -> 3: Confirm and Generate Redefined Paper
app.post('/papers/redefine/generate', auth, requirePaperSetterAuthorization, async (req, res) => {
  const extractedData = req.session.redefineCache;
  if (!extractedData || !extractedData.sections || extractedData.sections.length === 0) {
    return res.redirect('/papers/redefine');
  }

  const mode = req.body.redefineMode || 'BALANCED';

  try {
    const redefinedSections = await RedefineParser.redefinePaper(extractedData.sections, null, mode);

    const paperId = id('ES-RED');
    const totalAttemptable = redefinedSections.reduce((sum, s) => sum + (s.attemptableMarks || 0), 0);

    const newPaper = {
      id: paperId,
      title: `Redefined: ${extractedData.paperMetadata?.title || 'Examination Paper'}`,
      subject: extractedData.paperMetadata?.subject || 'Examination Subject',
      subjectCode: extractedData.paperMetadata?.subjectCode || '',
      institution: 'Academic Institution',
      department: 'Examination Division',
      semester: 'Standard / Semester VII',
      duration: '2 Hours',
      marks: totalAttemptable || 20,
      mode: 'REDEFINE',
      status: 'GENERATED',
      sections: redefinedSections,
      complianceScore: 100,
      encryptedContent: encrypt(JSON.stringify(redefinedSections)),
      createdBy: req.session.user.id,
      creatorEmail: req.session.user.email,
      createdAt: now(),
      updatedAt: now()
    };

    store.mutate(d => {
      d.papers.unshift(newPaper);
    });

    audit(req.session.user.id, 'REDEFINE_GENERATED', { paperId, mode }, req.session.user.email);

    res.render(
      'redefine',
      viewData(req, {
        step: 3,
        error: null,
        extractedData,
        paper: newPaper
      })
    );
  } catch (err) {
    console.error('Error generating redefined paper:', err);
    res.render(
      'redefine',
      viewData(req, {
        step: 2,
        error: `Redefinition failed: ${err.message}`,
        extractedData,
        paper: null
      })
    );
  }
});

// ----------------------------------------------------------------------
// PAPERS REPOSITORY, APPROVAL & SECURE VIEWER
// ----------------------------------------------------------------------

app.get('/papers', auth, (req, res) => {
  const db = store.read();
  let papers = db.papers;

  if (req.session.user.role === 'PAPER_SETTER') {
    papers = papers.filter(p => p.createdBy === req.session.user.id);
  }

  res.render(
    'papers',
    viewData(req, {
      papers,
      filter: req.query.filter || 'all'
    })
  );
});

// Approve & Lock paper
app.post('/papers/:id/approve', auth, (req, res) => {
  const paperId = req.params.id;

  store.mutate(d => {
    const p = d.papers.find(x => x.id === paperId);
    if (p) {
      p.status = 'APPROVED';
      p.approvedBy = req.session.user.email;
      p.approvedAt = now();
      p.updatedAt = now();
    }
  });

  audit(req.session.user.id, 'PAPER_APPROVED', { paperId }, req.session.user.email);
  res.redirect('/papers');
});

// Secure Paper Viewer (White A4 sheet with dynamic session watermark & webcam tamper monitoring)
app.get('/papers/:id/view', auth, (req, res) => {
  const db = store.read();
  const paper = db.papers.find(x => x.id === req.params.id);

  if (!paper) {
    return res.status(404).render('message', { title: 'Not Found', message: 'Paper not found in repository.' });
  }

  if (req.session.user.role === 'PAPER_SETTER' && paper.createdBy !== req.session.user.id) {
    return res.status(403).render('message', { title: 'Access Denied', message: 'You are not the authorized creator of this paper.' });
  }

  audit(req.session.user.id, 'PAPER_OPENED', { paperId: paper.id }, req.session.user.email);

  const token = `ES-${req.session.user.id.slice(-4)}-${Date.now().toString(36).toUpperCase()}`;

  // If paper has encryptedContent string, decrypt it
  let sections = paper.sections;
  let decryptedText = '';
  if (!sections || sections.length === 0) {
    if (paper.encryptedContent) {
      try {
        const raw = decrypt(paper.encryptedContent);
        if (raw.startsWith('[') || raw.startsWith('{')) {
          sections = JSON.parse(raw);
        } else {
          decryptedText = raw;
        }
      } catch (err) {
        decryptedText = 'Encrypted content could not be displayed.';
      }
    }
  }

  res.render(
    'viewer',
    viewData(req, {
      paper: {
        ...paper,
        sections,
        content: decryptedText
      },
      token
    })
  );
});

// Endpoint to demonstrate ciphertext in database
app.get('/debug/encrypted/:id', auth, role('AUTHORIZER'), (req, res) => {
  const p = store.read().papers.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({
    paperId: p.id,
    subject: p.subject,
    status: p.status,
    encryptionAlgorithm: 'AES-256-GCM',
    encryptedContent: p.encryptedContent || 'Empty'
  });
});

// Real-time security event telemetry (webcam loss, window blur, tab-switch)
app.post('/api/security-event', auth, (req, res) => {
  const allowed = ['FACE_LOST', 'CAMERA_BLOCKED', 'REPEATED_OPEN', 'TAB_SWITCH', 'WINDOW_BLUR'];
  const type = allowed.includes(req.body.type) ? req.body.type : 'FACE_LOST';

  event(req.session.user.id, type, type === 'CAMERA_BLOCKED' ? 'HIGH' : 'MEDIUM', {
    paperId: req.body.paperId || null
  });

  audit(req.session.user.id, type, { paperId: req.body.paperId || null }, req.session.user.email);

  const db = store.read();
  res.json(riskFrom(db, req.session.user.id));
});

// Audit and Security views
app.get('/audit', auth, (req, res) => {
  const db = store.read();
  let logs = db.auditLogs;
  if (req.session.user.role !== 'AUTHORIZER') {
    logs = logs.filter(l => l.userId === req.session.user.id);
  }
  res.render('audit', viewData(req, { logs: logs.slice(0, 100), users: db.users }));
});

app.get('/security', auth, (req, res) => {
  const db = store.read();
  let events = db.securityEvents;
  if (req.session.user.role !== 'AUTHORIZER') {
    events = events.filter(e => e.userId === req.session.user.id);
  }
  res.render('security', viewData(req, { events: events.slice(0, 50), users: db.users }));
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('message', {
    title: '404 - Not Found',
    message: 'The requested EXAM SENTRY route does not exist.'
  });
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  EXAM SENTRY — "SECURE. MONITOR. TRACE."`);
  console.log(`  Active at: http://localhost:${PORT}`);
  console.log(`  Authorizer Email: ${AUTHORIZER_EMAIL}`);
  console.log(`  Default-Deny Policy: ACTIVE (Whitelist: Empty)`);
  console.log(`======================================================\n`);
});
