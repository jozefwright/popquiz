// The Pop Quiz quiz format: how a list of questions is written down so that
// anyone, or any AI assistant, can hand Pop Quiz a ready-made quiz. Documented
// for people at popquiz.fun/quiz-format/. The panel's "Paste a quiz" and
// "Load a question list" both read it with readQuiz().
//
// Two ways to write it, both forgiving:
//
// 1. JSON, on its own or inside a chat reply or a ```json fence:
//    { "popquiz": 1, "title": "Friday quiz", "questions": [
//      { "type": "quiz", "text": "Which planet has the most moons?",
//        "options": ["Jupiter", "Saturn", "Uranus"], "answer": "B" },
//      { "type": "truefalse", "text": "Flamingos are pink from birth.", "answer": false },
//      { "type": "poll", "text": "Best lunch?", "options": ["Pizza", "Sushi"] },
//      { "type": "number", "text": "Guess the year Home Alone came out", "answer": 1990, "min": 1975, "max": 2005 },
//      { "type": "typed", "text": "Capital of Australia?", "accepts": ["Canberra"] },
//      { "type": "wordcloud", "text": "Your week in one word?" },
//      { "type": "open", "text": "Best thing that happened this week?" },
//      { "type": "order", "text": "Oldest first", "options": ["Rome", "Paris", "Wellington"] } ] }
//
// 2. Plain text, the way people write a quiz anyway:
//    1. Which planet has the most moons?
//    A) Jupiter
//    B) Saturn *
//    C) Uranus
//    Answer: B
//
// What comes out is the panel's question-list shape (what bankPicker() reads):
// { n, type: 'mc'|'tf'|'poll'|'cloud'|'num'|'rank'|'text'|'open', text,
//   options?, correct?, multi?, corrects?, answer?, accepts?, min?, max?, step?,
//   unit?, seconds?, points? }

import { LIMITS } from './protocol.js';

const LETTERS = 'ABCDEFGHIJKL';

// Every name a person or an assistant is likely to use for each type.
const TYPE_NAMES = [
  ['mc', ['mc', 'quiz', 'multiple choice', 'multiplechoice', 'multiple-choice', 'choice', 'question']],
  ['tf', ['tf', 'truefalse', 'true false', 'true/false', 'true or false', 'true-false', 'boolean']],
  ['poll', ['poll', 'vote', 'survey']],
  ['cloud', ['cloud', 'wordcloud', 'word cloud', 'word-cloud', 'words']],
  ['open', ['open', 'open answer', 'open-answer', 'openanswer', 'open ended', 'open-ended', 'free text']],
  ['num', ['num', 'number', 'numeric', 'guess the number', 'closest', 'estimate', 'slider']],
  ['text', ['text', 'typed', 'type the answer', 'type-the-answer', 'short answer', 'fill in', 'fill in the blank']],
  ['rank', ['rank', 'order', 'put in order', 'ranking', 'sort', 'judging']],
];
const TYPE_OF = new Map(TYPE_NAMES.flatMap(([t, names]) => names.map((n) => [n, t])));
const typeOf = (raw) => TYPE_OF.get(String(raw || '').trim().toLowerCase().replace(/_/g, ' ')) || null;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const truthy = (v) => (typeof v === 'boolean' ? v : /^(true|t|yes|y|correct|right)$/i.test(String(v).trim()) ? true : /^(false|f|no|n|wrong|incorrect)$/i.test(String(v).trim()) ? false : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v.replace(/,/g, '')) ? +v.replace(/,/g, '') : null);

// Which option an answer points at: a letter ("B"), a 1-based number when the
// options are not themselves numbers, a 0-based index from JSON, or the
// option's own text.
function optionIndex(answer, options, fromJson) {
  if (answer == null) return -1;
  const s = String(answer).trim();
  const byText = options.findIndex((o) => o.toLowerCase() === s.toLowerCase());
  if (byText >= 0) return byText;
  const letter = /^\(?([A-La-l])\)?[.)]?$/.exec(s);
  if (letter) return LETTERS.indexOf(letter[1].toUpperCase());
  if (/^\d+$/.test(s)) {
    const n = +s;
    // JSON numbers are positions from 0 (as `correct` is); written text counts from 1.
    if (fromJson && typeof answer === 'number') return n < options.length ? n : -1;
    return n >= 1 && n <= options.length ? n - 1 : -1;
  }
  const lead = /^\(?([A-La-l])\)?[.):]\s+(.+)$/.exec(s); // "B) Saturn"
  if (lead) return LETTERS.indexOf(lead[1].toUpperCase());
  return options.findIndex((o) => o.toLowerCase().startsWith(s.toLowerCase()) && s.length > 2);
}

// One question, from whatever an author wrote, to the panel's shape. Returns
// { q } or { skip: 'why' }.
function shape(raw, n, fromJson) {
  if (!raw || typeof raw !== 'object') return { skip: 'not a question' };
  const text = clip(raw.text ?? raw.question ?? raw.q ?? raw.prompt ?? raw.title, LIMITS.questionText);
  if (!text) return { skip: 'no question text' };
  let options = Array.isArray(raw.options ?? raw.choices ?? raw.answers) ? (raw.options ?? raw.choices ?? raw.answers) : [];
  options = options.map((o) => clip(typeof o === 'object' && o ? (o.text ?? o.label ?? o.option) : o, LIMITS.optionText)).filter(Boolean).slice(0, LIMITS.options);
  // An option object can carry its own "correct": true.
  const flagged = Array.isArray(raw.options ?? raw.choices) ? (raw.options ?? raw.choices).map((o, i) => (o && typeof o === 'object' && (o.correct === true || o.isCorrect === true) ? i : -1)).filter((i) => i >= 0) : [];
  let answerRaw = raw.answer ?? raw.correct ?? raw.correctAnswer ?? raw.correct_answer ?? raw.solution;
  // "A, C" or "A and C": several right answers, written as text.
  if (typeof answerRaw === 'string' && /^\(?[A-L]\)?(\s*(,|&|and)\s*\(?[A-L]\)?)+$/i.test(answerRaw.trim())) answerRaw = answerRaw.match(/[A-L]/gi);
  let type = typeOf(raw.type ?? raw.kind);

  // No type given: work it out from what is there.
  if (!type) {
    if (options.length) type = answerRaw == null && !flagged.length && !raw.corrects ? 'poll' : 'mc';
    else if (truthy(answerRaw) !== null && typeof answerRaw !== 'number') type = 'tf';
    else if (num(answerRaw) !== null) type = 'num';
    else if (answerRaw != null || raw.accepts) type = 'text';
    else type = 'open';
  }

  const q = { n, type, text };
  if (num(raw.seconds ?? raw.time ?? raw.timer) !== null) q.seconds = Math.max(5, Math.min(300, Math.round(num(raw.seconds ?? raw.time ?? raw.timer))));
  const points = num(raw.points);
  if (points !== null && points > 1) q.points = points >= 5 ? 5 : points >= 3 ? 3 : 2;

  if (type === 'mc' || type === 'poll' || type === 'rank') {
    if (options.length < 2) return { skip: `“${text.slice(0, 40)}” needs at least two options` };
    q.options = options;
    if (type === 'mc') {
      const many = Array.isArray(answerRaw) ? answerRaw : Array.isArray(raw.corrects) ? raw.corrects : null;
      if (many) {
        const idx = [...new Set(many.map((a) => optionIndex(a, options, fromJson)).filter((i) => i >= 0))].sort((a, b) => a - b);
        if (!idx.length) return { skip: `“${text.slice(0, 40)}” has no right answer that matches an option` };
        if (idx.length > 1) Object.assign(q, { multi: true, corrects: idx, correct: idx[0] });
        else q.correct = idx[0];
      } else {
        const i = flagged.length ? flagged[0] : optionIndex(answerRaw, options, fromJson);
        if (flagged.length > 1) Object.assign(q, { multi: true, corrects: flagged, correct: flagged[0] });
        else if (i >= 0) q.correct = i;
        else return { skip: `“${text.slice(0, 40)}” has no right answer that matches an option` };
      }
    }
  } else if (type === 'tf') {
    const t = typeof answerRaw === 'number' && fromJson ? answerRaw === 0 : truthy(answerRaw);
    if (t === null) return { skip: `“${text.slice(0, 40)}” needs true or false as its answer` };
    Object.assign(q, { options: ['True', 'False'], correct: t ? 0 : 1 });
  } else if (type === 'num') {
    const answer = num(answerRaw);
    if (answer === null) return { skip: `“${text.slice(0, 40)}” needs a number as its answer` };
    let min = num(raw.min);
    let max = num(raw.max);
    if (min === null || max === null || max <= min) {
      // No range given: one around the answer, off-centre so the middle isn't it.
      const span = Math.max(10, Math.abs(answer) * 0.5);
      min = Math.floor(answer - span * 0.6);
      max = Math.ceil(answer + span * 0.4);
    }
    Object.assign(q, { answer, min, max, step: num(raw.step) || (Number.isInteger(answer) ? 1 : 0.1) });
    if (raw.unit) q.unit = clip(raw.unit, LIMITS.unit);
  } else if (type === 'text') {
    const accepts = (Array.isArray(raw.accepts) ? raw.accepts : Array.isArray(answerRaw) ? answerRaw : [answerRaw]).map((a) => clip(a, LIMITS.typed)).filter(Boolean).slice(0, LIMITS.accepts);
    if (!accepts.length) return { skip: `“${text.slice(0, 40)}” needs an accepted answer` };
    q.accepts = accepts;
  }
  return { q };
}

// The JSON inside whatever was pasted: a bare object or list, or the first
// ```json fence, or the outermost {...} / [...] in a chat reply.
function findJson(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const s = c.trim();
    try {
      return JSON.parse(s);
    } catch {}
    for (const [open, close] of [['{', '}'], ['[', ']']]) {
      const a = s.indexOf(open);
      const b = s.lastIndexOf(close);
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(s.slice(a, b + 1));
        } catch {}
      }
    }
  }
  return null;
}

// Plain text: numbered questions, lettered options, an "Answer:" line or a
// mark (*, ✓, "(correct)") on the right option.
function fromText(text) {
  const out = [];
  let cur = null;
  const push = () => cur && out.push(cur);
  const MARK = /\s*(\*+|✓|✔|✅|\((?:correct|right|answer)\))\s*$/i;
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    const line = rawLine.replace(/^\s*[-•]\s*/, '').replace(/\*\*/g, '').trim();
    if (!line) continue;
    let m;
    if ((m = /^(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.):\-]\s*(.+)$/i.exec(line)) && !(cur && /^[A-L][.)]/i.test(line))) {
      push();
      cur = { text: m[2], options: [] };
      const typeHint = /\[(\w[\w /-]*)\]\s*$/.exec(cur.text); // "1. Best lunch? [poll]"
      if (typeHint) {
        cur.type = typeHint[1];
        cur.text = cur.text.slice(0, typeHint.index).trim();
      }
      continue;
    }
    if (!cur) continue;
    if ((m = /^(?:answer|correct(?: answer)?|solution)\s*[:\-]\s*(.+)$/i.exec(line))) {
      cur.answer = m[1].replace(/[.]$/, '').trim();
      continue;
    }
    if ((m = /^\(?([A-La-l])\s*[.):]\s*(.+)$/.exec(line))) {
      let opt = m[2];
      if (MARK.test(opt)) {
        opt = opt.replace(MARK, '').trim();
        cur.marked = [...(cur.marked || []), cur.options.length];
      }
      cur.options.push(opt);
      continue;
    }
    if ((m = /^(?:type|kind)\s*[:\-]\s*(.+)$/i.exec(line))) {
      cur.type = m[1];
      continue;
    }
    if ((m = /^(?:seconds|time|timer)\s*[:\-]\s*(\d+)/i.exec(line))) {
      cur.seconds = +m[1];
      continue;
    }
    if (!cur.options.length && cur.answer == null) cur.text += ` ${line}`; // a question that wraps
  }
  push();
  return out.map((q) => {
    if (q.marked?.length) q.answer = q.marked.length > 1 ? q.marked.map((i) => LETTERS[i]) : LETTERS[q.marked[0]];
    delete q.marked;
    return q;
  });
}

// Whatever was pasted or loaded, to { questions, skipped, title }.
export function readQuiz(input) {
  let data = typeof input === 'string' ? findJson(input) : input;
  let fromJson = true;
  let raw;
  if (data && typeof data === 'object') raw = Array.isArray(data) ? data : data.questions ?? data.quiz ?? data.items;
  if (!Array.isArray(raw) && typeof input === 'string') {
    raw = fromText(input);
    fromJson = false;
    data = null;
  }
  if (!Array.isArray(raw)) return { questions: [], skipped: ['No questions found. Paste a numbered list or the Pop Quiz JSON.'], title: '' };
  const questions = [];
  const skipped = [];
  for (const r of raw) {
    // A list in the panel's own shape (a saved question list, the Christmas
    // quiz file) reads the same way: its type names and its 0-based `correct`
    // are among the forms shape() accepts, and it gets the same limits.
    const { q, skip } = shape(r, questions.length + 1, fromJson);
    if (q) questions.push(q);
    else skipped.push(skip);
  }
  if (!questions.length && !skipped.length) skipped.push('No questions found. Paste a numbered list or the Pop Quiz JSON.');
  return { questions, skipped, title: clip(data?.title, 120) };
}

// "12 questions: 8 quiz, 2 polls, 1 true or false, 1 word cloud"
const LABEL = { mc: ['quiz', 'quiz'], tf: ['true or false', 'true or false'], poll: ['poll', 'polls'], cloud: ['word cloud', 'word clouds'], open: ['open answer', 'open answers'], num: ['guess the number', 'guess the number'], text: ['type the answer', 'type the answer'], rank: ['put in order', 'put in order'] };
export function describeQuiz(questions) {
  const count = {};
  for (const q of questions) count[q.type] = (count[q.type] || 0) + 1;
  const parts = Object.entries(count).map(([t, n]) => `${n} ${LABEL[t][n === 1 ? 0 : 1]}`);
  return `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}
