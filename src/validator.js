/**
 * Comprehensive Validation Engine for Exam Sentry
 */

/**
 * Calculates string similarity using Levenshtein distance & token overlap
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 1.0;

  const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  const union = new Set([...words1, ...words2]).size;
  return intersection / union;
}

/**
 * Validates an entire generated examination paper against confirmed academic scope
 */
function validatePaperCompliance(paper, confirmedBlueprint) {
  const report = {
    isValid: true,
    complianceScore: 100,
    subjectIntegrity: {
      passed: true,
      paperSubject: paper.subject,
      blueprintSubject: confirmedBlueprint?.subject?.name || null
    },
    blueprintScope: {
      passed: true,
      totalModulesInBlueprint: confirmedBlueprint?.modules?.length || 0,
      totalTopicsInBlueprint: 0
    },
    questionsMapped: {
      passed: true,
      totalQuestions: 0,
      mappedQuestions: 0
    },
    outOfSyllabusCount: 0,
    crossSubjectCount: 0,
    marksValidation: {
      passed: true,
      targetMarks: paper.marks || 0,
      calculatedAttemptable: 0,
      calculatedPrinted: 0
    },
    duplicatesDetected: [],
    errors: [],
    warnings: []
  };

  // 1. Subject match verification
  if (confirmedBlueprint?.subject?.name) {
    const s1 = (paper.subject || '').toLowerCase().trim();
    const s2 = confirmedBlueprint.subject.name.toLowerCase().trim();
    if (s1 !== s2 && !s1.includes(s2) && !s2.includes(s1)) {
      report.subjectIntegrity.passed = false;
      report.errors.push(`SUBJECT MISMATCH: Paper subject "${paper.subject}" does not match confirmed blueprint subject "${confirmedBlueprint.subject.name}".`);
      report.isValid = false;
    }
  }

  // 2. Blueprint topics set
  const allowedTopicIds = new Set();
  const allowedTopicNames = [];
  if (confirmedBlueprint?.modules) {
    for (const m of confirmedBlueprint.modules) {
      for (const tg of (m.topicGroups || [])) {
        for (const t of (tg.topics || [])) {
          if (t.topicId) allowedTopicIds.add(t.topicId);
          if (t.topicName) allowedTopicNames.push(t.topicName.toLowerCase());
        }
      }
    }
  }
  report.blueprintScope.totalTopicsInBlueprint = allowedTopicIds.size;

  // 3. Question check
  const allQuestions = [];
  (paper.sections || []).forEach(sec => {
    (sec.questions || []).forEach(q => {
      allQuestions.push(q);
    });
  });
  report.questionsMapped.totalQuestions = allQuestions.length;

  for (let i = 0; i < allQuestions.length; i++) {
    const q = allQuestions[i];

    // Check if mapped to valid topic
    let isMapped = false;
    if (Array.isArray(q.topicIds) && q.topicIds.some(id => allowedTopicIds.has(id))) {
      isMapped = true;
    } else if (allowedTopicNames.length > 0) {
      // Name overlap check
      const text = (q.questionText || '').toLowerCase();
      if (allowedTopicNames.some(t => text.includes(t))) {
        isMapped = true;
      }
    } else {
      isMapped = true; // No blueprint required mode
    }

    if (isMapped) {
      report.questionsMapped.mappedQuestions++;
    } else {
      report.outOfSyllabusCount++;
      report.warnings.push(`Question "${q.id || i + 1}" could not be strictly verified against a confirmed topic ID.`);
    }

    // Alien cross-subject check
    const alienKeywords = ['hadoop', 'mapreduce', 'hdfs', 'r programming'];
    const textLower = (q.questionText || '').toLowerCase();
    const isBigData = (paper.subject || '').toLowerCase().includes('big data');
    if (!isBigData && alienKeywords.some(k => textLower.includes(k))) {
      report.crossSubjectCount++;
      report.errors.push(`CROSS-SUBJECT ALIEN CONTENT DETECTED in question ${q.id}: Unrelated terminology found.`);
      report.isValid = false;
    }

    // 4. Duplicate checks
    for (let j = i + 1; j < allQuestions.length; j++) {
      const q2 = allQuestions[j];
      const sim = calculateSimilarity(q.questionText, q2.questionText);
      if (sim >= 0.85) {
        report.duplicatesDetected.push({
          q1: q.id,
          q2: q2.id,
          similarity: Math.round(sim * 100)
        });
        report.errors.push(`DUPLICATE DETECTED: Questions ${q.id} and ${q2.id} have ${Math.round(sim * 100)}% similarity.`);
        report.isValid = false;
      }
    }
  }

  // 5. Marks validation
  let totalAttemptable = 0;
  let totalPrinted = 0;
  for (const s of (paper.sections || [])) {
    const marksPerQ = s.marksPerQuestion || (s.questions?.[0]?.marks || 2);
    const avail = s.availableQuestions || s.availableCount || (s.questions ? s.questions.length : 0);
    const attempt = s.questionsToAttempt || s.attemptCount || avail;

    totalPrinted += avail * marksPerQ;
    totalAttemptable += attempt * marksPerQ;
  }
  report.marksValidation.calculatedAttemptable = totalAttemptable;
  report.marksValidation.calculatedPrinted = totalPrinted;

  if (paper.marks && totalAttemptable !== parseInt(paper.marks, 10)) {
    report.warnings.push(`Total attemptable marks (${totalAttemptable}) differs from paper target marks (${paper.marks}).`);
  }

  // Calculate compliance score
  if (!report.isValid) {
    report.complianceScore = Math.max(40, 100 - (report.errors.length * 20));
  } else if (report.outOfSyllabusCount > 0) {
    report.complianceScore = Math.max(75, 100 - (report.outOfSyllabusCount * 5));
  } else {
    report.complianceScore = 100;
  }

  return report;
}

module.exports = {
  calculateSimilarity,
  validatePaperCompliance
};
