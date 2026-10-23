// A small stand-in deck for the fallback player, used when no PDF and no
// exported config have been loaded. It exercises every module once.
// `title` is only for the placeholder slides the player draws; a real deck
// carries its own headings.

export const DEMO_DECK = {
  presentationId: 'demo',
  title: 'Pop Quiz demo deck',
  slides: {
    'demo-join': { kind: 'join', index: 2, headline: 'Join the quiz', title: 'Phones out' },
    'demo-cloud': {
      kind: 'question', index: 3, type: 'cloud', seconds: 0, title: 'Your week, in one word?',
      text: 'Your week, in one word?', place: { x: 0.06, y: 0.36, w: 0.88, h: 0.56 },
    },
    'demo-open': {
      kind: 'question', index: 4, type: 'open', seconds: 0, title: 'Best thing that happened this week?',
      text: 'Best thing that happened this week?', place: { x: 0.06, y: 0.3, w: 0.88, h: 0.62 },
    },
    'demo-q1': {
      kind: 'question', index: 5, type: 'mc', seconds: 15, display: 'bars', correct: 1, title: 'Which planet has the most moons?',
      text: 'Which planet has the most moons?', options: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'], place: { x: 0.06, y: 0.36, w: 0.88, h: 0.56 },
    },
    'demo-q2': {
      kind: 'question', index: 6, type: 'tf', seconds: 10, display: 'numbers', correct: 0, title: 'True or false: a group of flamingos is called a flamboyance.',
      text: 'True or false: a group of flamingos is called a flamboyance.', place: { x: 0.06, y: 0.4, w: 0.88, h: 0.5 },
    },
    'demo-q3': {
      kind: 'question', index: 7, type: 'mc', seconds: 20, display: 'pie', correct: 0, title: 'Which country has the most time zones?',
      text: 'Which country has the most time zones?',
      options: ['France', 'Russia', 'The United States', 'China'], place: { x: 0.06, y: 0.36, w: 0.88, h: 0.56 },
    },
    'demo-poll': {
      kind: 'question', index: 8, type: 'poll', seconds: 20, display: 'table', title: 'Best Friday lunch?',
      text: 'Best Friday lunch?', options: ['Pizza', 'Sushi', 'Burgers', 'Salad'], place: { x: 0.5, y: 0.3, w: 0.44, h: 0.62 },
    },
    'demo-text': {
      kind: 'question', index: 9, type: 'text', seconds: 30, title: 'What is the capital of Australia?',
      text: 'What is the capital of Australia?', accepts: ['Canberra'], place: { x: 0.06, y: 0.36, w: 0.88, h: 0.56 },
    },
    'demo-board': { kind: 'leaderboard', index: 10, top: 5, final: true, title: '', headline: '' },
  },
};

export const DEMO_PAGES = 11;
