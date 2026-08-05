/**
 * main.js
 * ---------------------------------------------------------------------------
 * Browser entry point: imports the App singleton and boots it against the
 * real DOM (see App.js#start). Kept separate from App.js itself so App.js
 * stays importable/testable in Node without any browser side effects —
 * this is the only file that assumes it's running in a page.
 * ---------------------------------------------------------------------------
 */

import app from './App.js';

app.start();
