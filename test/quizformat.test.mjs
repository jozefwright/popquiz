import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readQuiz, describeQuiz } from '../app/shared/quizformat.js';

test('the documented JSON reads, every type', () => {
  const { questions, skipped, title } = readQuiz({
    popquiz: 1,
    title: 'Friday',
    questions: [
      { type: 'quiz', text: 'Most moons?', options: ['Jupiter', 'Saturn', 'Uranus'], answer: 'B' },
      { type: 'truefalse', text: 'Flamingos are pink from birth.', answer: false },
      { type: 'poll', text: 'Lunch?', options: ['Pizza', 'Sushi'] },
      { type: 'number', text: 'Home Alone year?', answer: 1990, min: 1975, max: 2005 },
      { type: 'typed', text: 'Capital of Australia?', accepts: ['Canberra'] },
      { type: 'wordcloud', text: 'Your week?' },
      { type: 'open', text: 'Best thing this week?' },
      { type: 'order', text: 'Oldest first', options: ['Rome', 'Paris', 'Wellington'] },
    ],
  });
  assert.equal(title, 'Friday');
  assert.deepEqual(skipped, []);
  assert.deepEqual(questions.map((q) => q.type), ['mc', 'tf', 'poll', 'num', 'text', 'cloud', 'open', 'rank']);
  assert.equal(questions[0].correct, 1);
  assert.deepEqual(questions[1].options, ['True', 'False']);
  assert.equal(questions[1].correct, 1);
  assert.equal(questions[3].answer, 1990);
  assert.deepEqual(questions[4].accepts, ['Canberra']);
  assert.deepEqual(questions.map((q) => q.n), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('JSON inside a chat reply and a fence is found', () => {
  const pasted = 'Sure! Here is your quiz:\n```json\n{"questions":[{"text":"2+2?","options":["3","4"],"answer":"4"}]}\n```\nHave fun.';
  const { questions } = readQuiz(pasted);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].type, 'mc');
  assert.equal(questions[0].correct, 1);
});

test('answers as letters, 1-based text numbers, 0-based JSON numbers, option text and flags', () => {
  const opts = ['A one', 'B two', 'C three'];
  assert.equal(readQuiz({ questions: [{ text: 'q', options: opts, answer: 2 }] }).questions[0].correct, 2); // JSON number: position from 0
  assert.equal(readQuiz({ questions: [{ text: 'q', options: opts, answer: 'C three' }] }).questions[0].correct, 2);
  assert.equal(readQuiz({ questions: [{ text: 'q', options: [{ text: 'x' }, { text: 'y', correct: true }] }] }).questions[0].correct, 1);
  const multi = readQuiz({ questions: [{ text: 'q', options: opts, answer: ['A', 'C'] }] }).questions[0];
  assert.equal(multi.multi, true);
  assert.deepEqual(multi.corrects, [0, 2]);
});

test('a plain numbered list reads, with marks, answer lines and type hints', () => {
  const text = `Here you go:

1. Which planet has the most moons?
A) Jupiter
B) Saturn *
C) Uranus

2. **Capital of Australia?**
Answer: Canberra

3. Best Friday lunch? [poll]
A. Pizza
B. Sushi

4. True or false: a group of flamingos is a flamboyance.
Answer: True

5. In what year did Home Alone come out?
Answer: 1990

6. Which ocean is largest?
a) Atlantic
b) Pacific
c) Indian
Answer: B`;
  const { questions, skipped } = readQuiz(text);
  assert.deepEqual(skipped, []);
  assert.deepEqual(questions.map((q) => q.type), ['mc', 'text', 'poll', 'tf', 'num', 'mc']);
  assert.equal(questions[0].correct, 1);
  assert.equal(questions[0].text, 'Which planet has the most moons?');
  assert.deepEqual(questions[1].accepts, ['Canberra']);
  assert.equal(questions[3].correct, 0);
  assert.equal(questions[4].answer, 1990);
  assert.ok(questions[4].min < 1990 && questions[4].max > 1990);
  assert.notEqual((questions[4].min + questions[4].max) / 2, 1990, 'the slider does not start on the answer');
  assert.equal(questions[5].correct, 1);
});

test('questions that cannot work are skipped with a reason, the rest kept', () => {
  const { questions, skipped } = readQuiz({ questions: [{ text: 'no options quiz', type: 'quiz' }, { text: 'ok?', options: ['a', 'b'], answer: 'Z' }, { text: 'fine', type: 'poll', options: ['x', 'y'] }, {}] });
  assert.equal(questions.length, 1);
  assert.equal(skipped.length, 3);
});

test('an old saved question list passes through', () => {
  const saved = [{ n: 7, type: 'mc', text: 'q', options: ['a', 'b'], correct: 1, seconds: 20 }];
  const { questions } = readQuiz(saved);
  assert.equal(questions[0].correct, 1);
  assert.equal(questions[0].n, 1);
});

test('limits hold: at most 12 options, text clipped', () => {
  const many = Array.from({ length: 20 }, (_, i) => `o${i}`);
  const { questions } = readQuiz({ questions: [{ type: 'poll', text: 'x'.repeat(900), options: many }] });
  assert.equal(questions[0].options.length, 12);
  assert.equal(questions[0].text.length, 600);
});

test('nothing usable says so', () => {
  assert.equal(readQuiz('hello there').questions.length, 0);
  assert.match(readQuiz('hello there').skipped[0], /No questions found/);
  assert.equal(describeQuiz(readQuiz({ questions: [{ text: 'a', options: ['x', 'y'], answer: 'A' }, { text: 'b', options: ['x', 'y'] }] }).questions), '2 questions: 1 quiz, 1 poll');
});

const XMAS = new URL('../launch/content/files/christmas-quiz-for-work.json', import.meta.url);
test('the Christmas quiz file reads as it is', { skip: !(await import('node:fs')).existsSync(XMAS) && 'the site content is not in this copy' }, async () => {
  const { readFile } = await import('node:fs/promises');
  const file = JSON.parse(await readFile(XMAS, 'utf8'));
  const { questions, skipped } = readQuiz(file);
  assert.equal(questions.length, 51);
  assert.deepEqual(skipped, []);
});

test('several right answers written as letters in text', () => {
  const { questions } = readQuiz('1. Which are planets?\nA) Mars\nB) Moon\nC) Venus\nAnswer: A, C\n\n2. Pick both\nA) x *\nB) y *');
  assert.deepEqual(questions[0].corrects, [0, 2]);
  assert.equal(questions[0].multi, true);
  assert.deepEqual(questions[1].corrects, [0, 1]);
});

test('type hints in brackets: word cloud, open answer, order', () => {
  const { questions } = readQuiz('1. Your week in one word? [word cloud]\n\n2. Best thing this week? [open answer]\n\n3. Oldest first [order]\nA) Rome\nB) Paris');
  assert.deepEqual(questions.map((q) => q.type), ['cloud', 'open', 'rank']);
});
