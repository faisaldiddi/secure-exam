/**
 * Deterministic Marks Distribution & Examination Pattern Engine
 */

/**
 * Distributes total marks across modules according to their weightage percentages
 * using the Largest Remainder Method (Hare-Niemeyer Method).
 */
function distributeMarksByWeightage(totalMarks, modules) {
  if (!modules || modules.length === 0) return {};

  const totalWeightage = modules.reduce((sum, m) => sum + (m.marksWeightagePercent || 0), 0);

  // If weights don't exist or sum to 0, distribute equally
  if (totalWeightage <= 0) {
    const base = Math.floor(totalMarks / modules.length);
    let remainder = totalMarks % modules.length;
    const allocation = {};
    modules.forEach((m, i) => {
      allocation[m.moduleNumber] = base + (i < remainder ? 1 : 0);
    });
    return allocation;
  }

  // Largest remainder algorithm
  const quotas = modules.map(m => {
    const exact = (totalMarks * (m.marksWeightagePercent || 0)) / totalWeightage;
    const integerPart = Math.floor(exact);
    const fractionPart = exact - integerPart;
    return {
      moduleNumber: m.moduleNumber,
      integerPart,
      fractionPart
    };
  });

  let allocatedSum = quotas.reduce((sum, q) => sum + q.integerPart, 0);
  let remainder = totalMarks - allocatedSum;

  // Sort descending by fractional part
  quotas.sort((a, b) => b.fractionPart - a.fractionPart);

  for (let i = 0; i < remainder; i++) {
    quotas[i % quotas.length].integerPart += 1;
  }

  const result = {};
  for (const q of quotas) {
    result[q.moduleNumber] = q.integerPart;
  }

  return result;
}

/**
 * Builds standard paper pattern based on total marks
 */
function generateAutoPattern(totalMarks = 20) {
  totalMarks = parseInt(totalMarks, 10) || 20;

  if (totalMarks === 20) {
    return [
      {
        sectionId: 'SEC-1',
        title: 'Section A: Short Answer Questions',
        instruction: 'Answer any 5 questions out of 6 (Compulsory section).',
        availableQuestions: 6,
        questionsToAttempt: 5,
        marksPerQuestion: 2,
        hasChoiceGroups: false,
        choiceGroups: []
      },
      {
        sectionId: 'SEC-2',
        title: 'Section B: Descriptive & Analytical Questions',
        instruction: 'Answer any 2 questions out of 3.',
        availableQuestions: 3,
        questionsToAttempt: 2,
        marksPerQuestion: 5,
        hasChoiceGroups: false,
        choiceGroups: []
      }
    ];
  }

  if (totalMarks === 50) {
    return [
      {
        sectionId: 'SEC-1',
        title: 'Section 1: Conceptual & Short Questions',
        instruction: 'Answer any 5 out of 6 questions.',
        availableQuestions: 6,
        questionsToAttempt: 5,
        marksPerQuestion: 2,
        hasChoiceGroups: false,
        choiceGroups: []
      },
      {
        sectionId: 'SEC-2',
        title: 'Section 2: Intermediate Analytical Questions',
        instruction: 'Answer any 4 out of 5 questions.',
        availableQuestions: 5,
        questionsToAttempt: 4,
        marksPerQuestion: 5,
        hasChoiceGroups: false,
        choiceGroups: []
      },
      {
        sectionId: 'SEC-3',
        title: 'Section 3: Comprehensive / Long Questions',
        instruction: 'Answer any 2 out of 3 questions.',
        availableQuestions: 3,
        questionsToAttempt: 2,
        marksPerQuestion: 10,
        hasChoiceGroups: false,
        choiceGroups: []
      }
    ];
  }

  if (totalMarks === 80) {
    return [
      {
        sectionId: 'SEC-1',
        title: 'Question 1: Short Answer Questions',
        instruction: 'Answer any 4 out of 5 questions.',
        availableQuestions: 5,
        questionsToAttempt: 4,
        marksPerQuestion: 5,
        hasChoiceGroups: false,
        choiceGroups: []
      },
      {
        sectionId: 'SEC-2',
        title: 'Question 2: Detailed Questions',
        instruction: 'Attempt any 2 questions out of 3.',
        availableQuestions: 3,
        questionsToAttempt: 2,
        marksPerQuestion: 10,
        hasChoiceGroups: false,
        choiceGroups: []
      },
      {
        sectionId: 'SEC-3',
        title: 'Question 3: In-Depth Analytical Questions',
        instruction: 'Attempt any 2 questions out of 3.',
        availableQuestions: 3,
        questionsToAttempt: 2,
        marksPerQuestion: 10,
        hasChoiceGroups: false,
        choiceGroups: []
      },
      {
        sectionId: 'SEC-4',
        title: 'Question 4: Design / Case-Study Questions',
        instruction: 'Attempt any 2 questions out of 3.',
        availableQuestions: 3,
        questionsToAttempt: 2,
        marksPerQuestion: 10,
        hasChoiceGroups: false,
        choiceGroups: []
      }
    ];
  }

  // Default custom pattern
  return [
    {
      sectionId: 'SEC-1',
      title: 'Section 1',
      instruction: 'Answer all questions.',
      availableQuestions: Math.max(1, Math.floor(totalMarks / 5)),
      questionsToAttempt: Math.max(1, Math.floor(totalMarks / 5)),
      marksPerQuestion: 5,
      hasChoiceGroups: false,
      choiceGroups: []
    }
  ];
}

/**
 * Calculates printed marks vs attemptable marks
 */
function calculateMarksSummary(sections) {
  let totalPrinted = 0;
  let totalAttemptable = 0;

  for (const s of sections) {
    const avail = s.availableQuestions || s.availableCount || (s.questions ? s.questions.length : 0);
    const attempt = s.questionsToAttempt || s.attemptCount || avail;
    const marksEach = s.marksPerQuestion || 2;

    const printed = avail * marksEach;
    const attemptable = attempt * marksEach;

    s.printedMarks = printed;
    s.attemptableMarks = attemptable;

    totalPrinted += printed;
    totalAttemptable += attemptable;
  }

  return {
    totalPrinted,
    totalAttemptable
  };
}

module.exports = {
  distributeMarksByWeightage,
  generateAutoPattern,
  calculateMarksSummary
};
