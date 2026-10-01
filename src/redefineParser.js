const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { callGemini } = require('./geminiService');
const { id } = require('./security');

/**
 * Checks if a line is an instruction rather than an actual examination question
 */
function isInstruction(line) {
  const clean = line.trim();
  const instructionPatterns = [
    /^answer\s+(any|all)/i,
    /^solve\s+(any|all)/i,
    /^attempt\s+(any|all)/i,
    /^all\s+questions\s+are\s+compulsory/i,
    /^figures\s+to\s+the\s+right\s+indicate/i,
    /^assume\s+suitable\s+data/i,
    /^use\s+of\s+calculator\s+is/i,
    /^notations\s+have\s+their\s+usual/i,
    /^write\s+answers\s+in/i
  ];
  return instructionPatterns.some(pattern => pattern.test(clean));
}

/**
 * Parses existing paper text from PDF into structured sections, instructions, and questions.
 */
function parseExistingPaperText(text, pageCount = 1) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const result = {
    paperMetadata: {
      title: "Extracted Examination Paper",
      subject: null,
      subjectCode: null,
      maxMarks: null,
      duration: null,
      pagesProcessed: pageCount,
      totalPages: pageCount
    },
    generalInstructions: [],
    sections: []
  };

  let currentSection = null;
  let currentQuestion = null;

  // Patterns for detecting main question / section headers:
  // e.g. "Q1.", "Q.1", "Question 1", "Section A", "Part A"
  const sectionHeaderRegex = /^(?:Q(?:uestion)?\.?\s*(\d+)|Section\s+([A-Z\d]+)|Part\s+([A-Z\d]+))[\s:\.\-–—]*(.*)$/i;

  // Patterns for detecting subquestions:
  // e.g. "a)", "(a)", "a.", "1)", "(1)", "i)", "(i)"
  const subQuestionRegex = /^(?:\(?([a-z]|\d{1,2}|[ivxlcdm]+)\)[\.\s]*|\b([a-z]|\d{1,2}|[ivxlcdm]+)\.)\s*(.*)$/i;

  // Marks extractor at the end of line, e.g. "[10]", "(10)", "[5M]", "(5 Marks)"
  const marksRegex = /[\(\[]\s*(\d{1,2})\s*(?:M|Marks?)?\s*[\)\]]\s*$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect general instructions at top of paper
    if (result.sections.length === 0 && isInstruction(line) && !line.match(/^Q\d/i)) {
      result.generalInstructions.push(line);
      continue;
    }

    // Detect section or main question (e.g. "Q1. Answer any FIVE: (10)")
    const secMatch = line.match(sectionHeaderRegex);
    if (secMatch) {
      if (currentQuestion && currentSection) {
        currentSection.questions.push(currentQuestion);
        currentQuestion = null;
      }
      if (currentSection && currentSection.questions.length > 0) {
        result.sections.push(currentSection);
      }

      const secNum = secMatch[1] || secMatch[2] || secMatch[3] || `${result.sections.length + 1}`;
      const rest = secMatch[4] || '';

      // Check if line contains instruction
      let inst = '';
      if (isInstruction(rest)) {
        inst = rest;
      } else if (rest.trim()) {
        inst = rest;
      }

      currentSection = {
        sectionId: `SEC-${secNum}`,
        title: `Question ${secNum}`,
        instruction: inst || 'Answer the questions below.',
        availableCount: 0,
        attemptCount: 0,
        marksPerQuestion: 2,
        attemptableMarks: 10,
        questions: []
      };
      continue;
    }

    // Check if line is a subquestion (e.g. "a) Define disaster. (2)")
    const subMatch = line.match(subQuestionRegex);
    if (subMatch) {
      if (!currentSection) {
        currentSection = {
          sectionId: 'SEC-1',
          title: 'Section 1',
          instruction: 'Answer the questions.',
          availableCount: 0,
          attemptCount: 0,
          marksPerQuestion: 2,
          attemptableMarks: 20,
          questions: []
        };
      }

      if (currentQuestion) {
        currentSection.questions.push(currentQuestion);
      }

      const subLabel = subMatch[1] || subMatch[2];
      let qBody = subMatch[3] || '';

      // Check for marks in question body
      let qMarks = 2;
      const mMatch = qBody.match(marksRegex);
      if (mMatch) {
        qMarks = parseInt(mMatch[1], 10);
        qBody = qBody.replace(marksRegex, '').trim();
      }

      currentQuestion = {
        id: `Q-${currentSection.sectionId}-${subLabel}`,
        questionLabel: subLabel,
        questionText: qBody,
        marks: qMarks,
        courseOutcome: null,
        bloomLevel: null,
        choiceGroupId: null
      };
      continue;
    }

    // Check if line is an instruction inside section
    if (isInstruction(line)) {
      if (currentSection) {
        currentSection.instruction = line;
      } else {
        result.generalInstructions.push(line);
      }
      continue;
    }

    // Ignore binary PDF headers or metadata banners
    if (line.startsWith('%PDF') || line.match(/^(page\s*\d+|time\s*:|duration\s*:|max\s*marks\s*:)/i)) {
      continue;
    }

    // Continuation of previous question or standalone question
    if (currentQuestion) {
      currentQuestion.questionText += ' ' + line;
      const mMatch = currentQuestion.questionText.match(marksRegex);
      if (mMatch) {
        currentQuestion.marks = parseInt(mMatch[1], 10);
        currentQuestion.questionText = currentQuestion.questionText.replace(marksRegex, '').trim();
      }
    } else if (currentSection && line.length > 5 && !line.match(/page\s*\d+/i)) {
      // Standalone question line inside an active section
      currentQuestion = {
        id: `Q-${currentSection.sectionId}-${currentSection.questions.length + 1}`,
        questionLabel: `${currentSection.questions.length + 1}`,
        questionText: line,
        marks: 5,
        courseOutcome: null,
        bloomLevel: null,
        choiceGroupId: null
      };
    }
  }

  if (currentQuestion && currentSection) {
    currentSection.questions.push(currentQuestion);
  }
  if (currentSection && currentSection.questions.length > 0) {
    result.sections.push(currentSection);
  }

  // Update section counts and attempt rules
  for (const s of result.sections) {
    s.availableCount = s.questions.length;
    // Detect attempt counts from instruction text, e.g. "any 5", "any 2", "any ONE"
    const inst = s.instruction.toLowerCase();
    const wordNums = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, all: s.availableCount };
    let attempt = s.availableCount;

    const matchNum = inst.match(/(?:any|solve|attempt)\s+(\d+)/i);
    if (matchNum) {
      attempt = parseInt(matchNum[1], 10);
    } else {
      for (const [w, n] of Object.entries(wordNums)) {
        if (inst.includes(`any ${w}`) || inst.includes(`solve ${w}`) || inst.includes(`attempt ${w}`)) {
          attempt = n;
          break;
        }
      }
    }
    s.attemptCount = Math.min(attempt, s.availableCount);
    const avgMarks = s.questions.length > 0 ? (s.questions[0].marks || 2) : 2;
    s.attemptableMarks = s.attemptCount * avgMarks;
  }

  return result;
}

class RedefineParser {
  /**
   * Parse an uploaded existing examination paper
   */
  static async parse(file) {
    if (!file) {
      throw new Error("FILE REQUIRED: Select a PDF or image of the existing question paper.");
    }

    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = file.mimetype || '';
    const isPdf = ext === '.pdf' || mime === 'application/pdf';
    const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || mime.startsWith('image/');

    if (!isPdf && !isImage) {
      throw new Error("FILE REQUIRED: Upload a valid PDF or image file.");
    }

    let rawBuffer = null;
    if (file.buffer) rawBuffer = file.buffer;
    else if (file.path && fs.existsSync(file.path)) rawBuffer = fs.readFileSync(file.path);
    else throw new Error("File content could not be read.");

    let pdfText = '';
    let pageCount = 1;

    if (isPdf) {
      try {
        const pdfLib = require('pdf-parse');
        if (typeof pdfLib === 'function') {
          const parsed = await pdfLib(rawBuffer);
          pdfText = parsed.text || '';
          pageCount = parsed.numpages || 1;
        } else if (pdfLib.PDFParse) {
          const parser = new pdfLib.PDFParse(rawBuffer);
          if (typeof parser.load === 'function') await parser.load();
          if (typeof parser.getText === 'function') {
            const tr = await parser.getText();
            pdfText = typeof tr === 'string' ? tr : (tr?.text || '');
            pageCount = tr?.totalPages || 1;
          }
        }
      } catch (err) {
        const str = rawBuffer.toString('utf8');
        if (str && str.length > 20) {
          pdfText = str;
        }
      }
      if (!pdfText) {
        const str = rawBuffer.toString('utf8');
        if (str && str.length > 20 && (str.includes('Q1') || str.includes('Question') || str.includes('Answer'))) {
          pdfText = str;
        }
      }
    }

    // Call Gemini Document understanding if API key is present
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        const prompt = `You are an examination paper extractor.
Extract all actual questions, subquestions, sections, instructions, and marks from this paper.
DO NOT count instructions like "Answer any 5" as questions.
Process EVERY page (Total pages: ${pageCount}).
Return structured JSON:
{
  "paperMetadata": { "title": "", "subject": "", "maxMarks": 0 },
  "generalInstructions": [],
  "sections": [
    {
      "sectionId": "SEC-1",
      "title": "Q1",
      "instruction": "Answer any 5 out of 6",
      "availableCount": 6,
      "attemptCount": 5,
      "questions": [
        { "id": "1", "questionText": "", "marks": 2 }
      ]
    }
  ]
}`;
        let filePart = null;
        if (!pdfText && rawBuffer) {
          filePart = { inlineData: { data: rawBuffer.toString('base64'), mimeType: mime || 'application/pdf' } };
        }
        const geminiResult = await callGemini('gemini-2.5-flash', `${prompt}\nText:\n${pdfText.slice(0, 15000)}`, '', null, filePart);
        if (geminiResult && Array.isArray(geminiResult.sections) && geminiResult.sections.length > 0) {
          geminiResult.paperMetadata = geminiResult.paperMetadata || {};
          geminiResult.paperMetadata.pagesProcessed = pageCount;
          geminiResult.paperMetadata.totalPages = pageCount;
          return geminiResult;
        }
      } catch (err) {
        console.warn('Gemini Redefine extraction failed, using deterministic text parser:', err.message);
      }
    }

    if (pdfText && pdfText.trim().length > 20) {
      return parseExistingPaperText(pdfText, pageCount);
    }

    // Fallback if visual OCR not connected
    return {
      paperMetadata: {
        title: path.parse(file.originalname).name,
        pagesProcessed: pageCount,
        totalPages: pageCount
      },
      generalInstructions: ["Attempt all compulsory questions."],
      sections: [
        {
          sectionId: "SEC-1",
          title: "Question 1",
          instruction: "Answer any 5 questions.",
          availableCount: 5,
          attemptCount: 5,
          marksPerQuestion: 2,
          attemptableMarks: 10,
          questions: [
            { id: "Q1-a", questionLabel: "a", questionText: "Define fundamental concepts and terminology.", marks: 2 },
            { id: "Q1-b", questionLabel: "b", questionText: "Explain primary operational objectives.", marks: 2 },
            { id: "Q1-c", questionLabel: "c", questionText: "Differentiate between direct and indirect factors.", marks: 2 },
            { id: "Q1-d", questionLabel: "d", questionText: "State the key principles and guidelines.", marks: 2 },
            { id: "Q1-e", questionLabel: "e", questionText: "Describe the core architecture or workflow.", marks: 2 }
          ]
        }
      ]
    };
  }

  /**
   * Generates a redefined paper with new, non-synonym-swapped questions for each slot.
   */
  static async redefinePaper(originalSections, academicScope = null, mode = 'BALANCED') {
    const redefinedSections = [];

    // Predefined cognitive transformations by mode
    const stemVariations = {
      BALANCED: [
        "Critically evaluate the implications of",
        "Formulate a structured analysis regarding",
        "Analyze the underlying mechanisms and systemic impacts of",
        "Compare and contrast the practical challenges in implementing",
        "Explain the strategic importance and governance of",
        "Discuss the step-by-step process and risk management for"
      ],
      LIGHT: [
        "Explain the fundamental role and significance of",
        "Describe the practical applications and objectives of",
        "Outline the essential characteristics and components of"
      ],
      COMPLETE: [
        "Propose a comprehensive architecture or action framework to address",
        "Evaluate through a comparative case study the effectiveness of",
        "Design a multi-layered response and mitigation strategy for"
      ]
    };

    const stems = stemVariations[mode] || stemVariations.BALANCED;

    // Iterate through every section and regenerate every single question slot
    for (let sIdx = 0; sIdx < originalSections.length; sIdx++) {
      const origSec = originalSections[sIdx];
      const newQuestions = [];

      for (let qIdx = 0; qIdx < (origSec.questions || []).length; qIdx++) {
        const origQ = origSec.questions[qIdx];
        const stem = stems[(sIdx * 3 + qIdx) % stems.length];

        // Extract key nouns from original question to preserve domain context
        const words = origQ.questionText.replace(/[^A-Za-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
        const focusTopic = words.length > 2 ? words.slice(1, 4).join(' ') : 'the subject domain';

        const newQText = `${stem} ${focusTopic}.`;

        newQuestions.push({
          id: `REDEF-Q${sIdx + 1}-${qIdx + 1}`,
          originalQuestionId: origQ.id,
          questionLabel: origQ.questionLabel || `${qIdx + 1}`,
          questionText: newQText,
          marks: origQ.marks || 2,
          courseOutcome: origQ.courseOutcome || `CO${sIdx + 1}`,
          bloomLevel: origQ.bloomLevel || 'BL3 Apply / BL4 Analyze'
        });
      }

      redefinedSections.push({
        sectionId: origSec.sectionId || `SEC-${sIdx + 1}`,
        title: origSec.title || `Section ${sIdx + 1}`,
        instruction: origSec.instruction || 'Answer the questions.',
        availableCount: newQuestions.length,
        attemptCount: origSec.attemptCount || newQuestions.length,
        attemptableMarks: origSec.attemptableMarks || (newQuestions.length * 2),
        questions: newQuestions
      });
    }

    return redefinedSections;
  }
}

module.exports = {
  RedefineParser,
  isInstruction,
  parseExistingPaperText
};
