// The public demo's deck: short, light, and every slide plays by itself. The
// question text is drawn by the module (showText), since there is no real
// slide underneath to carry it.

const Q = { x: 0.05, y: 0.08, w: 0.9, h: 0.84 };

export const DEMO_ID = 'site-demo';

export const DEMO_SITE_DECK = {
  presentationId: DEMO_ID,
  title: 'Pop Quiz live demo',
  slides: {
    'd-join': { kind: 'join', index: 1, headline: 'Phones out', title: 'Phones out' },
    'd-planets': {
      kind: 'question', index: 2, type: 'mc', seconds: 15, display: 'bars', correct: 1, showText: true, place: Q,
      text: 'Which planet has the most moons?', options: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'],
    },
    'd-flamingo': {
      kind: 'question', index: 3, type: 'tf', seconds: 10, display: 'bars', correct: 0, showText: true, place: Q,
      text: 'True or false: a group of flamingos is called a flamboyance.',
    },
    'd-lunch': {
      kind: 'question', index: 4, type: 'poll', seconds: 12, display: 'bars', showText: true, place: Q,
      text: 'Best Friday lunch?', options: ['Pizza', 'Sushi', 'Burgers', 'Salad'],
    },
    'd-zones': {
      kind: 'question', index: 5, type: 'mc', seconds: 15, display: 'bars', correct: 0, showText: true, place: Q,
      text: 'Which country has the most time zones?', options: ['France', 'Russia', 'The United States', 'China'],
    },
    'd-board': { kind: 'leaderboard', index: 6, top: 5, final: true, title: '', headline: '' },
  },
};

export const ORDER = ['d-join', 'd-planets', 'd-flamingo', 'd-lunch', 'd-zones', 'd-board'];
