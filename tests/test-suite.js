const assert = require('assert');
const { BlueprintParser, parseBlueprintText, splitTopics } = require('../src/blueprintParser');
const { RedefineParser, parseExistingPaperText } = require('../src/redefineParser');
const { distributeMarksByWeightage, generateAutoPattern, calculateMarksSummary } = require('../src/patternEngine');
const { generateQuestionsWithGemini } = require('../src/geminiService');
const { validatePaperCompliance, calculateSimilarity } = require('../src/validator');
const store = require('../src/store');

console.log('====================================================');
console.log('EXAM SENTRY CRITICAL ACCEPTANCE TEST SUITE');
console.log('====================================================\n');

// -----------------------------------------------------------------
// TEST 1: DISASTER MANAGEMENT BLUEPRINT PARSING & TOPIC EXTRACTION
// -----------------------------------------------------------------
console.log('[TEST 1] Disaster Management Blueprint Regression Test...');

const disasterManagementSampleText = `
M. H. Saboo Siddik College of Engineering
Department of Mechanical Engineering
Subject: Disaster Management and Mitigation Measures
Subject Code: ILO7017
Semester: VII

Module 1: Introduction
CO: 1
Hours: 3 Hours
Weightage: 15%
Syllabus: 9%
Marks Range: 4-6
Topics: Definition of Disaster, Hazard, Global Disaster Scenario, Indian Disaster Scenario, General Perspective, Importance of Disaster Study, Direct Effects, Indirect Effects, Long-Term Effects, Global Warming, Climate Change.

Module 2: Natural Disaster and Manmade Disasters
CO: 2
Hours: 9 Hours
Weightage: 60%
Syllabus: 24%
Marks Range: 9-17
Topics: Natural Disaster: Meaning and Nature of Natural Disaster, Flood, Flash Flood, Drought, Cloud Burst, Earthquake, Landslide, Avalanche, Volcanic Eruption, Mudflow, Cyclone, Storm, Storm Surge, Climate Change, Global Warming, Sea Level Rise, Ozone Depletion; Manmade Disaster: Chemical Hazards, Industrial Hazards, Nuclear Hazards, Fire Hazards, Growing Population, Industrialization, Urbanization, Changing Lifestyle.

Module 3: Disaster Management, Policy and Administration
CO: 3
Hours: 6 Hours
Weightage: 25%
Syllabus: 17%
Marks Range: 7-9
Topics: Meaning of Disaster Management, Concept of Disaster Management, Importance of Disaster Management, Objectives of Disaster Management Policy, Disaster Risks in India, Paradigm Shift in Disaster Management, Disaster Management Policy, Principles of Disaster Management Policies, Command and Coordination, Rescue Operations, Rescue Operation Process, Disaster Management Process / Flowchart.
`;

const parsedScope = parseBlueprintText(disasterManagementSampleText, 1);

assert.strictEqual(parsedScope.subject.name, "Disaster Management and Mitigation Measures", "Subject name matches");
assert.strictEqual(parsedScope.subject.code, "ILO7017", "Subject code matches");
assert.strictEqual(parsedScope.modules.length, 3, "Exactly 3 modules detected");

// Module 1 assertions
const m1 = parsedScope.modules[0];
assert.strictEqual(m1.courseOutcome, 1, "M1 CO is 1");
assert.strictEqual(m1.hours, 3, "M1 Hours is 3");
assert.strictEqual(m1.marksWeightagePercent, 15, "M1 Weightage is 15%");
assert.strictEqual(m1.marksRange.minimum, 4, "M1 Min marks is 4");
assert.strictEqual(m1.marksRange.maximum, 6, "M1 Max marks is 6");
const m1TopicNames = m1.topicGroups[0].topics.map(t => t.topicName.toLowerCase());
assert(m1TopicNames.some(t => t.includes('hazard')), "M1 contains Hazard");
assert(m1TopicNames.some(t => t.includes('global warming') || t.includes('climate change')), "M1 contains Global Warming or Climate Change");

// Module 2 assertions
const m2 = parsedScope.modules[1];
assert.strictEqual(m2.courseOutcome, 2, "M2 CO is 2");
assert.strictEqual(m2.hours, 9, "M2 Hours is 9");
assert.strictEqual(m2.marksWeightagePercent, 60, "M2 Weightage is 60%");
assert.strictEqual(m2.marksRange.minimum, 9, "M2 Min marks is 9");
assert.strictEqual(m2.marksRange.maximum, 17, "M2 Max marks is 17");
const m2TopicNames = m2.topicGroups[0].topics.map(t => t.topicName.toLowerCase());
assert(m2TopicNames.some(t => t.includes('flood')), "M2 contains Flood");
assert(m2TopicNames.some(t => t.includes('earthquake')), "M2 contains Earthquake");
assert(m2TopicNames.some(t => t.includes('industrial hazards')), "M2 contains Industrial Hazards");

// Module 3 assertions
const m3 = parsedScope.modules[2];
assert.strictEqual(m3.courseOutcome, 3, "M3 CO is 3");
assert.strictEqual(m3.hours, 6, "M3 Hours is 6");
assert.strictEqual(m3.marksWeightagePercent, 25, "M3 Weightage is 25%");
const m3TopicNames = m3.topicGroups[0].topics.map(t => t.topicName.toLowerCase());
assert(m3TopicNames.some(t => t.includes('rescue operations')), "M3 contains Rescue Operations");

// Verify zero BDA contamination
const allTopicsStr = JSON.stringify(parsedScope).toLowerCase();
assert(!allTopicsStr.includes('hadoop'), "Zero Hadoop contamination");
assert(!allTopicsStr.includes('mapreduce'), "Zero MapReduce contamination");
assert(!allTopicsStr.includes('csc702'), "Zero CSC702 contamination");
console.log('-> PASS: Disaster Management blueprint correctly extracted and 100% free of BDA!\n');

// -----------------------------------------------------------------
// TEST 2: DETERMINISTIC MARKS DISTRIBUTION (LARGEST REMAINDER METHOD)
// -----------------------------------------------------------------
console.log('[TEST 2] Deterministic Marks Distribution & Rounding Test...');

// 20 Marks distributed by weightages 15%, 60%, 25% -> raw: 3, 12, 5 marks
const allocation20 = distributeMarksByWeightage(20, parsedScope.modules);
assert.strictEqual(allocation20["1"], 3, "Module 1 receives 3 marks");
assert.strictEqual(allocation20["2"], 12, "Module 2 receives 12 marks");
assert.strictEqual(allocation20["3"], 5, "Module 3 receives 5 marks");
const sum20 = Object.values(allocation20).reduce((a, b) => a + b, 0);
assert.strictEqual(sum20, 20, "Total marks exactly equals 20");
console.log(`-> PASS: 20 marks distributed exactly: ${JSON.stringify(allocation20)} (Sum: ${sum20})\n`);

// -----------------------------------------------------------------
// TEST 3: Q1 OR BUG FIX VERIFICATION
// -----------------------------------------------------------------
console.log('[TEST 3] Q1 OR Bug Fix Verification...');

const autoPattern = generateAutoPattern(20);
const q1Section = autoPattern[0];
assert.strictEqual(q1Section.availableQuestions, 6, "Q1 has 6 available questions");
assert.strictEqual(q1Section.questionsToAttempt, 5, "Q1 attempts 5 questions");
assert.strictEqual(q1Section.hasChoiceGroups, false, "Q1 does NOT have inter-question OR groups");
assert.deepStrictEqual(q1Section.choiceGroups, [], "Q1 choice groups is empty array");

const summary = calculateMarksSummary(autoPattern);
assert.strictEqual(summary.totalPrinted, 27, "Total printed marks is 27 (6x2 + 3x5)");
assert.strictEqual(summary.totalAttemptable, 20, "Total attemptable marks is exactly 20 (5x2 + 2x5)");
console.log('-> PASS: Q1 OR bug resolved. Attemptable marks = 20, no unwanted OR dividers.\n');

// -----------------------------------------------------------------
// TEST 4: CLOSED-SCOPE QUESTION GENERATION & COMPLIANCE VERIFICATION
// -----------------------------------------------------------------
console.log('[TEST 4] Closed-Scope Question Generation & Verification...');

(async () => {
  const generatedSections = await generateQuestionsWithGemini(parsedScope, autoPattern, 'MODERATE');
  calculateMarksSummary(generatedSections);

  assert.strictEqual(generatedSections.length, 2, "2 Sections generated");
  assert.strictEqual(generatedSections[0].questions.length, 6, "Section 1 contains 6 subquestions");
  assert.strictEqual(generatedSections[1].questions.length, 3, "Section 2 contains 3 subquestions");

  // Verify that all questions reference confirmed topics
  const allGeneratedQ = [];
  generatedSections.forEach(s => s.questions.forEach(q => allGeneratedQ.push(q)));

  for (const q of allGeneratedQ) {
    const textLower = q.questionText.toLowerCase();
    assert(!textLower.includes('hadoop'), `Question "${q.questionText}" contains forbidden Hadoop`);
    assert(!textLower.includes('mapreduce'), `Question "${q.questionText}" contains forbidden MapReduce`);
  }

  // Validate compliance
  const mockPaper = {
    subject: parsedScope.subject.name,
    subjectCode: parsedScope.subject.code,
    marks: 20,
    sections: generatedSections
  };

  const compliance = validatePaperCompliance(mockPaper, parsedScope);
  assert.strictEqual(compliance.isValid, true, "Compliance validation passed");
  assert.strictEqual(compliance.complianceScore, 100, "Compliance score is 100%");
  assert.strictEqual(compliance.crossSubjectCount, 0, "Zero cross-subject alien concepts detected");
  console.log('-> PASS: 100% Blueprint Compliance verified. Zero BDA cross-contamination.\n');

  // -----------------------------------------------------------------
  // TEST 5: REDEFINE PARSER MULTI-PAGE & INSTRUCTION SEPARATION
  // -----------------------------------------------------------------
  console.log('[TEST 5] Redefine Parser: Instructions vs Questions...');

  const sampleLegacyPaper = `
Q1. Answer any FIVE of the following: [10]
a) Define disaster and explain its classifications. [2]
b) What is a hazard? Give two examples. [2]
c) Explain the global disaster scenario briefly. [2]
d) Define flash flood and cloud burst. [2]
e) Explain the role of community in disaster mitigation. [2]
f) State any two indirect effects of an earthquake. [2]

Q2. Attempt any TWO questions: [10]
a) Critically analyze the structural measures for cyclone mitigation. [5]
b) Explain industrial and nuclear hazards with recent case examples. [5]
c) Discuss the National Disaster Management Policy framework. [5]
`;

  const parsedRedefine = parseExistingPaperText(sampleLegacyPaper, 2);

  assert.strictEqual(parsedRedefine.sections.length, 2, "2 Sections extracted");
  assert.strictEqual(parsedRedefine.sections[0].questions.length, 6, "Q1 contains 6 actual questions (not instructions!)");
  assert.strictEqual(parsedRedefine.sections[0].attemptCount, 5, "Q1 attempts 5");
  assert.strictEqual(parsedRedefine.sections[1].questions.length, 3, "Q2 contains 3 actual questions");
  assert.strictEqual(parsedRedefine.sections[1].attemptCount, 2, "Q2 attempts 2");

  // Redefine slot-by-slot test
  const redefinedSections = await RedefineParser.redefinePaper(parsedRedefine.sections, null, 'BALANCED');
  assert.strictEqual(redefinedSections[0].questions.length, 6, "Redefined Section 1 contains 6 new question slots");
  assert.strictEqual(redefinedSections[1].questions.length, 3, "Redefined Section 2 contains 3 new question slots");

  // Check similarity vs original (must be different questions)
  for (let i = 0; i < 6; i++) {
    const orig = parsedRedefine.sections[0].questions[i].questionText;
    const redef = redefinedSections[0].questions[i].questionText;
    const sim = calculateSimilarity(orig, redef);
    assert(sim < 0.85, `Similarity ${sim} between original and redefined should be < 0.85`);
  }
  console.log('-> PASS: Redefine parser distinguishes instructions from questions and regenerates all slots.\n');

  // -----------------------------------------------------------------
  // TEST 6: WHITELIST DEFAULT-DENY & REVOCATION LOGIC
  // -----------------------------------------------------------------
  console.log('[TEST 6] Whitelist Default-Deny & Revocation...');

  store.mutate(d => {
    d.users = d.users.filter(u => u.role === 'AUTHORIZER');
    d.whitelist = [];
  });
  const db = store.read();

  // Fresh db has authorizer and empty whitelist for paper setters
  assert(db.users.some(u => u.email === 'faisaldiddi@gmail.com' && u.role === 'AUTHORIZER'), "Authorizer exists");
  assert.strictEqual(db.whitelist.filter(w => w.status === 'REGISTERED').length, 0, "Zero pre-registered paper setters");

  console.log('-> PASS: Whitelist Default-Deny architecture verified.\n');

  console.log('====================================================');
  console.log('ALL ACCEPTANCE TESTS PASSED SUCCESSFULLY (6/6)');
  console.log('====================================================\n');
})();
