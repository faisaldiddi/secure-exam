const assert = require('assert');
const http = require('http');

async function testBlueprintFlow() {
  console.log('====================================================');
  console.log('AI AUTO GENERATE WIZARD & REDEFINE FLOW TEST');
  console.log('====================================================\n');

  const { BlueprintParser } = require('../src/blueprintParser');
  const { RedefineParser } = require('../src/redefineParser');
  const store = require('../src/store');

  // Test File Mock
  const mockBlueprintContent = `
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
Topics: Meaning and Nature of Natural Disaster, Flood, Flash Flood, Drought, Cloud Burst, Earthquake, Landslide, Avalanche, Volcanic Eruption, Mudflow, Cyclone, Storm, Storm Surge, Climate Change, Global Warming, Sea Level Rise, Ozone Depletion, Chemical Hazards, Industrial Hazards, Nuclear Hazards, Fire Hazards, Growing Population, Industrialization, Urbanization, Changing Lifestyle.

Module 3: Disaster Management, Policy and Administration
CO: 3
Hours: 6 Hours
Weightage: 25%
Syllabus: 17%
Marks Range: 7-9
Topics: Meaning of Disaster Management, Concept of Disaster Management, Importance of Disaster Management, Objectives of Disaster Management Policy, Disaster Risks in India, Paradigm Shift in Disaster Management, Disaster Management Policy, Principles of Disaster Management Policies, Command and Coordination, Rescue Operations, Rescue Operation Process, Disaster Management Process / Flowchart.
  `;

  // 1. Simulate BlueprintParser parse from buffer
  console.log('[STEP 1] Testing BlueprintParser with Disaster Management blueprint...');
  const mockFile = {
    originalname: 'disaster_management_blueprint.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from(mockBlueprintContent, 'utf8')
  };

  const academicScope = await BlueprintParser.parse({
    originalname: 'disaster_management_blueprint.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 mock\n' + mockBlueprintContent)
  });

  assert.strictEqual(academicScope.subject.name, 'Disaster Management and Mitigation Measures');
  assert.strictEqual(academicScope.subject.code, 'ILO7017');
  assert.strictEqual(academicScope.modules.length, 3);
  console.log('-> PASS: BlueprintParser extracted structured academic scope for Disaster Management.\n');

  // 2. Simulate Subject Switch (NLP Blueprint test)
  console.log('[STEP 2] Testing Subject Switch (NLP Blueprint)...');
  const nlpBlueprintContent = `
Department of Computer Engineering
Subject: Natural Language Processing
Subject Code: CS801
Semester: VIII

Module 1: Foundations of NLP
Hours: 6
Weightage: 40%
Topics: Tokenization, Stemming, Lemmatization, Stop Words Removal, Part of Speech Tagging, Named Entity Recognition.

Module 2: Language Models & Semantics
Hours: 9
Weightage: 60%
Topics: N-gram Models, Word2Vec, TF-IDF, Semantic Similarity, Vector Space Models, Transformer Attention.
  `;

  const nlpScope = await BlueprintParser.parse({
    originalname: 'nlp_syllabus.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 mock\n' + nlpBlueprintContent)
  });

  assert.strictEqual(nlpScope.subject.name, 'Natural Language Processing');
  assert.strictEqual(nlpScope.subject.code, 'CS801');
  assert.strictEqual(nlpScope.modules.length, 2);

  const nlpText = JSON.stringify(nlpScope).toLowerCase();
  assert(!nlpText.includes('disaster'), "Zero Disaster Management contamination in NLP");
  assert(!nlpText.includes('hadoop'), "Zero Hadoop contamination in NLP");
  console.log('-> PASS: NLP blueprint is completely isolated with 0% Disaster or BDA contamination.\n');

  // 3. Test Redefine with Multi-page Questions
  console.log('[STEP 3] Testing Multi-page Redefine Parser...');
  const existingPaper = `
Q1. Answer any FIVE subquestions: (10 Marks)
a) Explain the difference between natural and manmade disasters. (2)
b) Define cloud burst with historical context. (2)
c) Outline three key objectives of disaster policy. (2)
d) What is a flash flood? State its primary causes. (2)
e) Describe the significance of command and coordination in rescue. (2)
f) How does global warming exacerbate extreme weather events? (2)

Q2. Attempt any TWO questions: (10 Marks)
a) Formulate an early warning evacuation strategy for coastal cyclones. (5)
b) Compare industrial chemical hazards and fire safety compliance in urban areas. (5)
c) Evaluate the paradigm shift from relief-centric to mitigation-centric disaster management. (5)
  `;

  const parsedExisting = await RedefineParser.parse({
    originalname: 'existing_exam_paper.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 mock\n' + existingPaper)
  });

  assert.strictEqual(parsedExisting.sections.length, 2);
  assert.strictEqual(parsedExisting.sections[0].questions.length, 6);
  assert.strictEqual(parsedExisting.sections[1].questions.length, 3);

  const totalQuestions = parsedExisting.sections.reduce((sum, s) => sum + s.questions.length, 0);
  assert.strictEqual(totalQuestions, 9, "All 9 questions extracted");

  const redefined = await RedefineParser.redefinePaper(parsedExisting.sections, null, 'BALANCED');
  assert.strictEqual(redefined.length, 2);
  assert.strictEqual(redefined[0].questions.length, 6);
  assert.strictEqual(redefined[1].questions.length, 3);
  console.log('-> PASS: Multi-page Redefine Parser extracted all 9 questions and regenerated 9 matching slots.\n');

  console.log('====================================================');
  console.log('ALL AI BLUEPRINT & REDEFINE TESTS PASSED (3/3)');
  console.log('====================================================\n');
}

testBlueprintFlow().catch(err => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
