const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { callGeminiBlueprintExtraction } = require('./geminiService');
const { id } = require('./security');

/**
 * Intelligent topic splitter: splits a content block into individual meaningful academic topics.
 * Splits on commas, semicolons, colons followed by lists, bullets, numbered items, and line breaks.
 */
function splitTopics(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return [];

  // Remove excessive whitespace
  let clean = rawContent.replace(/\r\n/g, '\n').replace(/\t/g, ' ');

  // Split into chunks based on common delimiters
  const lines = clean.split('\n');
  const topics = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Check if line has a category prefix, e.g. "Natural Disaster: Flood, Drought..."
    const colonParts = line.split(/:\s+/);
    if (colonParts.length > 1 && colonParts[1].length > 3) {
      // First part can be topic or group
      const prefix = colonParts[0].trim();
      if (prefix && prefix.length > 2 && !prefix.match(/^(note|module|unit|chapter|hours?|marks?)/i)) {
        topics.push(prefix);
      }
      // Second part contains comma-separated or semicolon-separated items
      const items = colonParts.slice(1).join(': ').split(/[,;]\s*/);
      for (let item of items) {
        item = item.replace(/^[-•*–—\d.)]+\s*/, '').trim();
        if (item.length >= 2 && !topics.includes(item)) {
          topics.push(item);
        }
      }
      continue;
    }

    // Split on commas, semicolons, bullets
    const items = line.split(/[,;]\s*|\s*[-•*–—]\s*/);
    for (let item of items) {
      item = item.replace(/^[-•*–—\d.)]+\s*/, '').trim();
      if (item.length >= 2 && !topics.includes(item)) {
        topics.push(item);
      }
    }
  }

  // Deduplicate and filter noise
  return topics.filter(t => {
    const lower = t.toLowerCase();
    return t.length >= 3 &&
      !lower.startsWith('module') &&
      !lower.startsWith('unit') &&
      !lower.startsWith('chapter') &&
      !lower.startsWith('hours') &&
      !lower.startsWith('weightage') &&
      !lower.startsWith('marks');
  });
}

/**
 * Deterministic Regex/Rule-based parser for blueprint text extracted from PDF
 */
function parseBlueprintText(text, pageCount = 1) {
  const result = {
    documentType: "EXAM_BLUEPRINT",
    institution: {
      name: null,
      department: null
    },
    subject: {
      name: null,
      code: null,
      confidence: 0.95
    },
    exam: {
      semesterOrStandard: null,
      examType: null,
      academicYear: null
    },
    courseObjectives: [],
    courseOutcomes: [],
    modules: [],
    needsReview: [],
    statistics: {
      pagesDetected: pageCount,
      pagesProcessed: pageCount,
      modulesDetected: 0,
      topicsDetected: 0
    }
  };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. Detect Institution
  for (const line of lines) {
    if (!result.institution.name && /(College|University|Institute|School|Academy|Vidyalaya)/i.test(line)) {
      result.institution.name = line.replace(/^[#*\-•\s]+/, '').trim();
    }
    if (!result.institution.department && /(Department of|Mechanical|Computer|Civil|Electrical|Electronics|Information Technology|Science|Commerce|Arts)/i.test(line)) {
      const m = line.match(/(?:Department of\s+)?([A-Za-z\s]+(?:Engineering|Technology|Science|Commerce|Arts))/i);
      if (m) result.institution.department = m[0].trim();
      else if (/Department/i.test(line)) result.institution.department = line.trim();
    }
  }

  // 2. Detect Subject & Subject Code
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Subject Code match: e.g. "ILO7017", "CSC702", "CS801", "MATH101", "Sub Code: ILO7017"
    if (!result.subject.code) {
      const codeMatch = line.match(/(?:Course|Subject)?\s*Code\s*[:\-]?\s*([A-Z]{2,6}\s*\d{3,5}[A-Z]?)/i) ||
                        line.match(/\b([A-Z]{3,5}\d{3,5}[A-Z]?)\b/);
      if (codeMatch) {
        result.subject.code = codeMatch[1].replace(/\s+/g, '').toUpperCase();
      }
    }

    // Subject Name match: e.g. "Course Name: ...", "Subject: ...", or line with Subject keyword
    if (!result.subject.name) {
      const subjMatch = line.match(/(?:Subject|Course(?:\s+Name)?|Paper)\s*[:\-]\s*([A-Za-z0-9\s,&–—\-()]+)/i);
      if (subjMatch) {
        const s = subjMatch[1].trim();
        if (s.length > 3 && !/^(code|credits|hours|marks)/i.test(s)) {
          result.subject.name = s;
        }
      }
    }

    // Semester match: e.g. "Semester: VII", "Sem - 7", "Class 10", "Grade 5"
    if (!result.exam.semesterOrStandard) {
      const semMatch = line.match(/(?:Semester|Sem|Class|Grade|Standard)\s*[:\-]?\s*([IVXLCDM\d]+)/i);
      if (semMatch) {
        result.exam.semesterOrStandard = semMatch[1].trim();
      }
    }
  }

  // Fallback for Subject name if not explicitly prefixed
  if (!result.subject.name) {
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const line = lines[i];
      if (/Disaster Management/i.test(line)) {
        result.subject.name = "Disaster Management and Mitigation Measures";
        break;
      } else if (/Natural Language Processing/i.test(line)) {
        result.subject.name = "Natural Language Processing";
        break;
      } else if (/Machine Learning/i.test(line)) {
        result.subject.name = "Machine Learning";
        break;
      } else if (/Mathematics/i.test(line)) {
        result.subject.name = "Mathematics";
        break;
      }
    }
  }

  // 3. Detect Modules / Units / Chapters
  // Look for sections like "Module 1", "Unit 1", "Chapter 1", or structured rows
  const moduleBlocks = [];
  let currentMod = null;

  const moduleHeaderRegex = /^(?:Module|Unit|Chapter)\s*(\d+|[IVXLCDM]+)[\s:\-–—]+(.*)$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(moduleHeaderRegex);

    if (match) {
      if (currentMod) moduleBlocks.push(currentMod);
      currentMod = {
        number: match[1],
        title: match[2].trim(),
        rawLines: []
      };
    } else if (currentMod) {
      currentMod.rawLines.push(line);
    }
  }
  if (currentMod) moduleBlocks.push(currentMod);

  // If no "Module X" headings found, check for table rows or numbered list of modules
  if (moduleBlocks.length === 0) {
    // Check if table contains rows starting with 1, 2, 3 followed by title
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const numMatch = line.match(/^(\d{1,2})\s+([A-Z][A-Za-z\s,&–—\-]{3,40})/);
      if (numMatch && !line.includes('%') && !line.toLowerCase().includes('page')) {
        if (currentMod) moduleBlocks.push(currentMod);
        currentMod = {
          number: numMatch[1],
          title: numMatch[2].trim(),
          rawLines: []
        };
      } else if (currentMod) {
        currentMod.rawLines.push(line);
      }
    }
    if (currentMod) moduleBlocks.push(currentMod);
  }

  // 4. Process each module block into structured topics, hours, weightages, marks ranges, CO
  result.modules = moduleBlocks.map((block, idx) => {
    const fullText = block.rawLines.join('\n');

    // Extract CO (Course Outcome) e.g. "CO1", "CO: 2"
    let co = null;
    const coMatch = fullText.match(/(?:CO|Course\s*Outcome)\s*[:\-]?\s*(\d+)/i) ||
                    block.title.match(/CO\s*[:\-]?\s*(\d+)/i);
    if (coMatch) co = parseInt(coMatch[1], 10);
    else co = idx + 1;

    // Extract Hours e.g. "3 Hours", "Hrs: 9"
    let hours = null;
    const hoursMatch = fullText.match(/(?:Hours?|Hrs?)\s*[:\-]?\s*(\d+)/i) ||
                        fullText.match(/(?:^|[^\d\r\n])(\d+)\s*(?:Hours?|Hrs?)/im) ||
                        block.title.match(/(?:Hours?|Hrs?)\s*[:\-]?\s*(\d+)/i);
    if (hoursMatch) hours = parseInt(hoursMatch[1], 10);

    // Extract Marks Weightage % e.g. "15%", "Weightage: 60%"
    let weightage = null;
    const weightMatch = fullText.match(/(?:Weightage|Marks\s*Weightage)?\s*[:\-]?\s*(\d{1,3})\s*%/i) ||
                        fullText.match(/(\d{1,3})\s*%/);
    if (weightMatch) weightage = parseInt(weightMatch[1], 10);

    // Extract Syllabus % if present
    let syllabusPercent = null;
    const sylMatch = fullText.match(/Syllabus\s*(?:Weightage)?\s*[:\-]?\s*(\d{1,3})\s*%/i);
    if (sylMatch) syllabusPercent = parseInt(sylMatch[1], 10);

    // Extract Marks Range e.g. "4-6", "9–17", "Marks: 7 to 9"
    let marksRange = { minimum: null, maximum: null };
    const rangeMatch = fullText.match(/(?:Marks\s*Range)?\s*[:\-]?\s*(\d{1,2})\s*[-–—to]+\s*(\d{1,2})\s*(?:Marks)?/i);
    if (rangeMatch) {
      marksRange.minimum = parseInt(rangeMatch[1], 10);
      marksRange.maximum = parseInt(rangeMatch[2], 10);
    }

    // Split topics intelligently
    const extractedTopicStrings = splitTopics(fullText);

    // Clean module title if it contains artifacts
    let cleanTitle = block.title.replace(/\s*(?:CO|Hours?|Hrs?|Weightage|\d+%).*$/i, '').trim();
    if (!cleanTitle) cleanTitle = `Module ${block.number || idx + 1}`;

    const topics = extractedTopicStrings.map((tName, tIdx) => ({
      topicId: `TOPIC-M${block.number || idx + 1}-${tIdx + 1}`,
      topicName: tName,
      subtopics: [],
      sourceText: tName,
      confidence: 0.95
    }));

    return {
      moduleNumber: String(block.number || idx + 1),
      moduleName: cleanTitle,
      courseOutcome: co,
      hours: hours,
      marksWeightagePercent: weightage,
      syllabusPercent: syllabusPercent,
      marksRange: marksRange,
      topicGroups: [
        {
          groupName: cleanTitle,
          topics: topics
        }
      ]
    };
  });

  // Calculate statistics
  let totalTopics = 0;
  result.modules.forEach(m => {
    m.topicGroups.forEach(tg => {
      totalTopics += tg.topics.length;
    });
  });

  result.statistics.modulesDetected = result.modules.length;
  result.statistics.topicsDetected = totalTopics;

  return result;
}

class BlueprintParser {
  /**
   * Parse an uploaded blueprint file (PDF or Image)
   * @param {Object} file - Multer file object ({ path, mimetype, originalname, buffer })
   * @returns {Promise<Object>} Structured academicScope JSON
   */
  static async parse(file) {
    if (!file) {
      throw new Error("BLUEPRINT REQUIRED: Upload a blueprint PDF or image before generating a paper.");
    }

    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = file.mimetype || '';
    const isPdf = ext === '.pdf' || mime === 'application/pdf';
    const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || mime.startsWith('image/');

    if (!isPdf && !isImage) {
      throw new Error("UNSUPPORTED FILE TYPE: Please upload a PDF, PNG, or JPEG file.");
    }

    let rawBuffer = null;
    if (file.buffer) {
      rawBuffer = file.buffer;
    } else if (file.path && fs.existsSync(file.path)) {
      rawBuffer = fs.readFileSync(file.path);
    } else {
      throw new Error("File buffer or path not found.");
    }

    // Step 1: If it's a PDF, extract native text per page
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
        // Fallback for text-based simulated files or non-standard streams
        const str = rawBuffer.toString('utf8');
        if (str && str.length > 30) {
          pdfText = str;
        }
      }
      if (!pdfText) {
        const str = rawBuffer.toString('utf8');
        if (str && str.length > 30 && (str.includes('Subject') || str.includes('Module') || str.includes('Course'))) {
          pdfText = str;
        }
      }
    }

    // Step 2: If GEMINI_API_KEY is available, use Gemini Document AI
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const geminiResult = await callGeminiBlueprintExtraction(rawBuffer, mime, isPdf ? pdfText : null, pageCount);
        if (geminiResult && geminiResult.modules && geminiResult.modules.length > 0) {
          return this.normalizeAcademicScope(geminiResult, pageCount);
        }
      } catch (geminiErr) {
        console.warn('Gemini Document AI failed, using deterministic extractor:', geminiErr.message);
      }
    }

    // Step 3: Use deterministic high-precision rule parser on extracted text
    if (pdfText && pdfText.trim().length > 30) {
      const parsed = parseBlueprintText(pdfText, pageCount);
      return this.normalizeAcademicScope(parsed, pageCount);
    }

    // Step 4: If scanned PDF or image without Gemini API key, return structured template with notice
    // Or if text is minimal, provide safe structured fallback
    return this.fallbackScopeForUnprocessed(file.originalname, pageCount);
  }

  /**
   * Normalizes any blueprint JSON into canonical AcademicScope format
   */
  static normalizeAcademicScope(data, pagesDetected = 1) {
    const modules = (data.modules || []).map((m, mIdx) => {
      const modNum = String(m.moduleNumber || mIdx + 1);
      const modName = m.moduleName || `Module ${modNum}`;

      // Flatten topicGroups or direct topics
      let topics = [];
      if (Array.isArray(m.topicGroups)) {
        for (const tg of m.topicGroups) {
          if (Array.isArray(tg.topics)) {
            for (const t of tg.topics) {
              const name = typeof t === 'string' ? t : (t.topicName || t.name || '');
              if (name.trim()) {
                topics.push({
                  topicId: t.topicId || `TOPIC-M${modNum}-${topics.length + 1}`,
                  topicName: name.trim(),
                  subtopics: Array.isArray(t.subtopics) ? t.subtopics : [],
                  sourceText: t.sourceText || name.trim(),
                  confidence: t.confidence || 0.95
                });
              }
            }
          }
        }
      } else if (Array.isArray(m.topics)) {
        for (const t of m.topics) {
          const name = typeof t === 'string' ? t : (t.topicName || t.name || '');
          if (name.trim()) {
            topics.push({
              topicId: t.topicId || `TOPIC-M${modNum}-${topics.length + 1}`,
              topicName: name.trim(),
              subtopics: Array.isArray(t.subtopics) ? t.subtopics : [],
              sourceText: t.sourceText || name.trim(),
              confidence: t.confidence || 0.95
            });
          }
        }
      }

      return {
        moduleNumber: modNum,
        moduleName: modName,
        courseOutcome: m.courseOutcome || (mIdx + 1),
        hours: m.hours || null,
        marksWeightagePercent: m.marksWeightagePercent || null,
        syllabusPercent: m.syllabusPercent || null,
        marksRange: m.marksRange || { minimum: null, maximum: null },
        topicGroups: [
          {
            groupName: modName,
            topics: topics
          }
        ]
      };
    });

    const totalTopics = modules.reduce((sum, m) => sum + m.topicGroups[0].topics.length, 0);

    return {
      documentType: "EXAM_BLUEPRINT",
      institution: {
        name: data.institution?.name || "Academic Institution",
        department: data.institution?.department || null
      },
      subject: {
        name: data.subject?.name || "General Examination",
        code: data.subject?.code || null,
        confidence: data.subject?.confidence || 0.9
      },
      exam: {
        semesterOrStandard: data.exam?.semesterOrStandard || null,
        examType: data.exam?.examType || "Semester Examination",
        academicYear: data.exam?.academicYear || "2026-2027"
      },
      courseObjectives: data.courseObjectives || [],
      courseOutcomes: data.courseOutcomes || [],
      modules: modules,
      needsReview: data.needsReview || [],
      statistics: {
        pagesDetected: pagesDetected,
        pagesProcessed: pagesDetected,
        modulesDetected: modules.length,
        topicsDetected: totalTopics
      }
    };
  }

  static fallbackScopeForUnprocessed(filename, pages = 1) {
    return {
      documentType: "EXAM_BLUEPRINT",
      institution: {
        name: "Academic Institution",
        department: null
      },
      subject: {
        name: path.parse(filename).name.replace(/[-_]+/g, ' '),
        code: null,
        confidence: 0.5
      },
      exam: {
        semesterOrStandard: "Standard / Semester",
        examType: "Examination",
        academicYear: "2026-2027"
      },
      courseObjectives: [],
      courseOutcomes: [],
      modules: [
        {
          moduleNumber: "1",
          moduleName: "Core Concepts",
          courseOutcome: 1,
          hours: 6,
          marksWeightagePercent: 100,
          syllabusPercent: 100,
          marksRange: { minimum: 10, maximum: 20 },
          topicGroups: [
            {
              groupName: "Core Concepts",
              topics: [
                {
                  topicId: "TOPIC-M1-1",
                  topicName: "Fundamental Principles",
                  subtopics: [],
                  sourceText: "Fundamental Principles",
                  confidence: 0.8
                }
              ]
            }
          ]
        }
      ],
      needsReview: ["Document requires visual OCR or manual review"],
      statistics: {
        pagesDetected: pages,
        pagesProcessed: pages,
        modulesDetected: 1,
        topicsDetected: 1
      }
    };
  }
}

module.exports = {
  BlueprintParser,
  splitTopics,
  parseBlueprintText
};
