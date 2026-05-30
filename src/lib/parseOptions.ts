export type ParsedOption = { label: string; emoji?: string };

export type FilterReason =
  | 'too-long'
  | 'has-question-mark'
  | 'ends-with-colon'
  | 'colon-followed-by-chinese'
  | 'prompt-keyword'
  | 'too-short'
  | 'exceeds-max-length'
  | 'no-pattern-match';

export type ParseDebugEntry = {
  line: string;
  reason: FilterReason;
  detail?: string;
};

// Detect dev mode in both Vite (browser) and Node/Vitest environments
const isDev = (() => {
  try {
    // @ts-ignore - import.meta.env exists in Vite
    if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV) return true;
  } catch {
    /* noop */
  }
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') return true;
  return false;
})();

// Return the reason a line looks like a question/prompt rather than an option, or null.
// When `quotedExempt` is true, the text is wrapped in quotes (示例对白) so we skip
// the question-mark / length checks — the question mark belongs to the quoted dialog,
// not to the prompt itself.
function questionReason(text: string, quotedExempt = false): FilterReason | null {
  if (!quotedExempt && text.length > 35) return 'too-long';
  if (!quotedExempt && /[?？]/.test(text)) return 'has-question-mark';
  if (/[:：]\s*$/.test(text)) return 'ends-with-colon';
  if (!quotedExempt && /[:：].*[\u4e00-\u9fa5]/.test(text)) return 'colon-followed-by-chinese';
  if (/(想法是|请选择|你目前|你的打算|你的想法)/.test(text)) return 'prompt-keyword';
  return null;
}

// Detect if a label is wrapped in (Chinese or English) quotes — meaning it is
// example dialog, not a direct question to the user.
const isQuoted = (text: string) =>
  /^[「""''""『]/.test(text.trim()) && /[」""''""』]\s*$/.test(text.trim());

const stripEmoji = (text: string) =>
  text.replace(/[\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}\uFE0F\u200D]/gu, '').trim();

const REASON_LABEL: Record<FilterReason, string> = {
  'too-long': '行内文本超过 35 字',
  'has-question-mark': '包含问号',
  'ends-with-colon': '以冒号结尾（问题/提示语）',
  'colon-followed-by-chinese': '冒号后含中文（提示语）',
  'prompt-keyword': '命中提示语关键词（如 想法是/你目前）',
  'too-short': '解析后少于 2 个字符',
  'exceeds-max-length': '解析后超过最大长度',
  'no-pattern-match': '未匹配任何编号/字母选项模式',
};

function logFiltered(entries: ParseDebugEntry[]) {
  if (!isDev || entries.length === 0) return;
  // eslint-disable-next-line no-console
  console.groupCollapsed(`[parseOptions] 过滤了 ${entries.length} 行`);
  entries.forEach((e) => {
    // eslint-disable-next-line no-console
    console.log(`✕ ${REASON_LABEL[e.reason]}${e.detail ? ` · ${e.detail}` : ''}\n  → ${e.line}`);
  });
  // eslint-disable-next-line no-console
  console.groupEnd();
}

/**
 * Parse numbered/lettered options from an AI message for interactive buttons.
 * Filters out lines that look like questions, headings, or prompts.
 *
 * In development, emits a collapsed console group listing every filtered line and reason.
 * Pass `collectDebug: true` to also return the entries for inspection/tests.
 */
export function parseOptions(
  content: string,
  opts?: { collectDebug?: boolean }
): ParsedOption[] & { debug?: ParseDebugEntry[] } {
  const options: ParsedOption[] = [];
  const debug: ParseDebugEntry[] = [];
  const lines = content.split('\n');

  const pushFiltered = (line: string, reason: FilterReason, detail?: string) => {
    debug.push({ line, reason, detail });
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let match = trimmed.match(/^([A-Z])[.．）、)]\s*\*{0,2}(.+?)\*{0,2}$/);
    let captured: string | null = null;
    let maxLen = 40;

    if (match && match.length >= 3) {
      captured = stripEmoji(match[2].replace(/\*{1,2}/g, '').trim());
      maxLen = 40;
    } else {
      match = trimmed.match(/^\d+[.．）、)]\s*\*{0,2}(.+?)\*{0,2}$/);
      if (match) {
        captured = stripEmoji(match[1].replace(/\*{1,2}/g, '').trim());
        maxLen = 35;
      }
    }

    // If the captured text still contains an inline option marker (letter or
    // digit), the whole line is actually multiple inline options — skip and
    // let the inline fallback handle it.
    if (captured && /\s(?:[A-Z]|\d+)[.．、)）]\s/.test(captured)) {
      captured = null;
    }
    if (captured === null) continue;

    if (captured === null) {
      // Only flag prose lines that look like they were *meant* to be options
      // (avoid spamming for empty/heading/markdown lines)
      if (/^[\d一二三四五六七八九十A-Z]/.test(trimmed)) {
        pushFiltered(trimmed, 'no-pattern-match');
      }
      continue;
    }

    // Strong signal: line starts with A./1./etc. — be permissive when the
    // label contains quoted dialog (示例对白), strict otherwise.
    const hasQuotedDialog = /["「『'][^"」』']{2,}["」』']/.test(captured);
    if (captured.length < 2) {
      pushFiltered(trimmed, 'too-short', `提取: "${captured}"`);
      continue;
    }
    const effectiveMax = hasQuotedDialog ? 120 : maxLen;
    if (captured.length > effectiveMax) {
      pushFiltered(trimmed, 'exceeds-max-length', `${captured.length} > ${effectiveMax}`);
      continue;
    }
    if (/[:：]\s*$/.test(captured)) {
      pushFiltered(trimmed, 'ends-with-colon', `提取: "${captured}"`);
      continue;
    }
    if (/(想法是|请选择|你目前|你的打算|你的想法)/.test(captured)) {
      pushFiltered(trimmed, 'prompt-keyword', `提取: "${captured}"`);
      continue;
    }
    // Only enforce no-question-mark when label does NOT contain quoted dialog.
    if (!hasQuotedDialog && /[?？]/.test(captured)) {
      pushFiltered(trimmed, 'has-question-mark', `提取: "${captured}"`);
      continue;
    }
    options.push({ label: captured });
  }

  // Fallback 1: options crammed onto a single line, e.g.
  //   "A. 直接就业 💼 B. 国内考研/保研 📚 C. 出国留学 ✈️ D. 考公 🏛️ E. 迷茫 😵"
  // Split on letter-prefix markers and parse each segment.
  if (options.length === 0) {
    const inlineLetterRegex = /([A-Z])[.．、)）]\s*([^A-Z\n]+?)(?=\s+[A-Z][.．、)）]|$)/g;
    let m: RegExpExecArray | null;
    const inlineCandidates: string[] = [];
    while ((m = inlineLetterRegex.exec(content)) !== null) {
      const label = stripEmoji(m[2].replace(/\*{1,2}/g, '').trim());
      // Strong signal (A./B./C. markers detected) — only drop on prompt-keyword
      // or pure ends-with-colon, allow long quoted dialog with question marks.
      if (label.length < 2 || label.length > 120) continue;
      if (/(想法是|请选择|你目前|你的打算|你的想法)/.test(label)) continue;
      if (/^[^「『""'']*[:：]\s*$/.test(label)) continue; // bare prompt ending with colon (no quotes)
      inlineCandidates.push(label);
    }
    if (inlineCandidates.length >= 2) {
      inlineCandidates.forEach((c) => options.push({ label: c }));
    }
  }

  // Fallback 1b: digit-prefix markers on a single line, e.g.
  //   "1. 打算考研 📚 2. 打算就业 💼 3. 打算留学 ✈️"
  if (options.length === 0) {
    const inlineDigitRegex = /(\d+)[.．、)）]\s*([^\n]+?)(?=\s+\d+[.．、)）]|$)/g;
    let m: RegExpExecArray | null;
    const inlineCandidates: string[] = [];
    while ((m = inlineDigitRegex.exec(content)) !== null) {
      const label = stripEmoji(m[2].replace(/\*{1,2}/g, '').trim());
      if (label.length < 2 || label.length > 120) continue;
      if (/(想法是|请选择|你目前|你的打算|你的想法)/.test(label)) continue;
      if (/^[^「『""'']*[:：]\s*$/.test(label)) continue;
      inlineCandidates.push(label);
    }
    if (inlineCandidates.length >= 2) {
      inlineCandidates.forEach((c) => options.push({ label: c }));
    }
  }

  // Fallback 2: quoted inline candidates
  if (options.length === 0) {
    const inlinePattern = /[「""]([^「""」]{2,25})[」""]/g;
    let inlineMatch: RegExpExecArray | null;
    const candidates: string[] = [];
    while ((inlineMatch = inlinePattern.exec(content)) !== null) {
      candidates.push(inlineMatch[1]);
    }
    if (candidates.length >= 2) {
      candidates.forEach((c) => options.push({ label: c }));
    }
  }

  // Fallback 3: bold comma-separated items like **保研、考研、就业、留学**
  // or **保研**、**考研**、**就业**、**留学**
  if (options.length === 0) {
    const candidates: string[] = [];
    // Pattern A: single bold span with 、 separated items
    const boldGroupRegex = /\*\*([^*\n]{2,60})\*\*/g;
    let bm: RegExpExecArray | null;
    while ((bm = boldGroupRegex.exec(content)) !== null) {
      const inner = bm[1];
      if (/[、,，]/.test(inner)) {
        const parts = inner.split(/[、,，]/).map(s => stripEmoji(s.trim())).filter(Boolean);
        if (parts.length >= 2 && parts.every(p => p.length >= 2 && p.length <= 12 && !questionReason(p))) {
          parts.forEach(p => candidates.push(p));
          break;
        }
      }
    }
    // Pattern B: multiple adjacent bold tokens separated by 、
    if (candidates.length === 0) {
      const seqRegex = /(\*\*[^*\n]{2,12}\*\*)(?:\s*[、,，]\s*\*\*[^*\n]{2,12}\*\*){1,}/g;
      const seqMatch = seqRegex.exec(content);
      if (seqMatch) {
        const parts = seqMatch[0].split(/[、,，]/).map(s => stripEmoji(s.replace(/\*\*/g, '').trim())).filter(Boolean);
        if (parts.length >= 2) parts.forEach(p => candidates.push(p));
      }
    }
    if (candidates.length >= 2) {
      candidates.forEach(c => options.push({ label: c }));
    }
  }

  logFiltered(debug);

  const result = options as ParsedOption[] & { debug?: ParseDebugEntry[] };
  if (opts?.collectDebug) result.debug = debug;
  return result;
}
