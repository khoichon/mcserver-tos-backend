'use strict';

/**
 * Khoi's Minecraft Server — ToS verification backend.
 *
 * Two client groups talk to this API:
 *   1. The Paper plugin (server-to-server, authenticated with X-API-Key)
 *   2. policy.html, the public verification webpage (authenticated only by
 *      possession of the 8-character code — no login system needed)
 *
 * Storage: Supabase (Postgres). Run supabase_schema.sql once against your
 * project before starting the server. Requires SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY (the service role key, NOT the anon key — this
 * server does its own access control and needs to bypass RLS).
 */

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-me-please';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CODE_TTL_MS = 30 * 60 * 1000; // pending verification codes expire after 30 minutes
const QUIZ_SIZE = 5; // number of questions asked per verification attempt
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion

// ---------------------------------------------------------------------------
// Quiz bank. Add/edit freely — questions are picked at random per session.
// ---------------------------------------------------------------------------
const QUIZ_BANK = [
  { q: 'What is the only formal way to appeal a ban?', options: ['Messaging staff on Discord', 'Submitting a new bug report', 'Waiting for it to expire automatically', 'Creating an alternate account'], answer: 0 },
  { q: 'How many calendar days do you have to submit a ban appeal after first seeing the ban notice?', options: ['24 hours', '3 days', '14 days', '30 days'], answer: 2 },
  { q: 'Is using an alternate account to bypass a ban allowed?', options: ['Yes, as long as you don\u2019t get caught', 'No, it is a separate violation', 'Yes, if the original ban was unfair', 'Only with staff permission granted after the ban'], answer: 1 },
  { q: 'Is X-ray or similar client-side cheating allowed on the server?', options: ['Yes, if used sparingly', 'No, it is prohibited', 'Only in the Nether', 'Only for staff'], answer: 1 },
  { q: 'If you discover a serious exploit or bug, what should you do?', options: ['Abuse it before it gets patched', 'Sell access to it to other players', 'Report it to staff', 'Ignore it'], answer: 2 },
  { q: 'Does accidentally damaging another player\u2019s build always count as griefing?', options: ['Yes, always', 'No, accidental damage is not automatically griefing, but should be repaired when possible', 'Only on weekends', 'Only if reported within 24 hours'], answer: 1 },
  { q: 'Can you avoid a rule by getting a mob, mechanism, or another player to do the prohibited action for you?', options: ['Yes, indirect actions are always fine', 'No, indirect rule violations are still violations', 'Only with a Wither', 'Only if you don\u2019t press any buttons yourself'], answer: 1 },
  { q: 'Is PvP allowed on the server?', options: ['Never, under any circumstances', 'Yes, when all participating players consent to it', 'Only against staff', 'Only using bare fists'], answer: 1 },
  { q: 'Who is affiliated with or endorses Khoi\u2019s Minecraft Server?', options: ['Mojang Studios', 'Microsoft', 'Neither \u2014 it is an independent community server', 'Both Mojang and Microsoft'], answer: 2 },
  { q: 'Are you responsible for actions taken through your account, even if someone else was using it?', options: ['No, never', 'Yes, generally you are responsible for conduct on your account', 'Only if you admit to it', 'Only if it happened on Java Edition'], answer: 1 },
  { q: 'What should you do if you witness a serious rule violation instead of retaliating?', options: ['Punish the player yourself', 'Report it to staff with evidence if possible', 'Post about it publicly in chat', 'Nothing, it\u2019s not your problem'], answer: 1 },
  { q: 'Can staff take enforcement action against clearly harmful behavior even if it is not explicitly listed in the rules?', options: ['No, only explicitly listed rules can be enforced', 'Yes, under the common-sense / unlisted conduct provision', 'Only with a unanimous player vote', 'Only if a moderator personally witnesses it'], answer: 1 },
  { q: 'What happens to submitting duplicate or repeated appeals for the same ban?', options: ['Each one gets reviewed fully from scratch', 'They may be rejected without further review', 'They automatically shorten the ban', 'They are forwarded to Mojang'], answer: 1 },
  { q: 'Are large automated farms allowed on the server?', options: ['Never', 'Yes, unless they cause excessive server performance issues', 'Only in creative mode', 'Only if built by staff'], answer: 1 },
  { q: 'Where can you find the full day-to-day Server Rules referenced by the Terms of Service?', options: ['They are not published anywhere', 'khoichon.dev/mcserver/rules.html', 'Only shared privately by staff', 'In the server MOTD only'], answer: 1 },
  { q: 'Does staff have to disclose every piece of evidence, including reporter identities, to a banned player?', options: ['Yes, always in full', 'No, staff may withhold some details to protect security and privacy', 'Only if the player asks nicely', 'Only for permanent bans'], answer: 1 },
];

// ---------------------------------------------------------------------------
// Supabase-backed datastore helpers
//
// Tables (see supabase_schema.sql):
//   players(uuid text pk, username text, verified bool, verified_at timestamptz, verified_by text)
//   pending(code text pk, uuid text, username text, quiz jsonb, created_at timestamptz, expires_at timestamptz)
// ---------------------------------------------------------------------------

async function getPlayer(uuid) {
  const { data, error } = await supabase.from('players').select('*').eq('uuid', uuid).maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertPlayer(uuid, fields) {
  const { error } = await supabase.from('players').upsert({ uuid, ...fields });
  if (error) throw error;
}

async function getPending(code) {
  const { data, error } = await supabase.from('pending').select('*').eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
}

async function findPendingByUuid(uuid) {
  const { data, error } = await supabase
    .from('pending')
    .select('*')
    .eq('uuid', uuid)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function insertPending(code, { uuid, username, quiz }) {
  const now = Date.now();
  const { error } = await supabase.from('pending').insert({
    code,
    uuid,
    username,
    quiz,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + CODE_TTL_MS).toISOString(),
  });
  if (error) throw error;
}

async function updatePendingQuiz(code, quiz) {
  const { error } = await supabase.from('pending').update({ quiz }).eq('code', code);
  if (error) throw error;
}

async function deletePending(code) {
  const { error } = await supabase.from('pending').delete().eq('code', code);
  if (error) throw error;
}

async function deletePendingByUuid(uuid) {
  const { error } = await supabase.from('pending').delete().eq('uuid', uuid);
  if (error) throw error;
}

async function purgeExpired() {
  const { error } = await supabase.from('pending').delete().lt('expires_at', new Date().toISOString());
  if (error) throw error;
}

function isExpired(entry) {
  return !entry || Date.now() > new Date(entry.expires_at).getTime();
}

async function generateUniqueCode() {
  let code;
  let existing;
  do {
    code = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    existing = await getPending(code);
  } while (existing);
  return code;
}

function pickQuiz() {
  const pool = [...QUIZ_BANK];
  const picked = [];
  for (let i = 0; i < QUIZ_SIZE && pool.length; i++) {
    const idx = crypto.randomInt(pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked.map((item, i) => ({ id: `q${i}`, question: item.q, options: item.options, answer: item.answer }));
}

function stripAnswers(quiz) {
  return quiz.map(({ id, question, options }) => ({ id, question, options }));
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Permissive CORS for the public site routes only.
app.use('/api/site', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requireApiKey(req, res, next) {
  const key = req.header('X-API-Key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ message: 'Invalid or missing API key.' });
  }
  next();
}

// Wrap async route handlers so thrown/rejected errors reach Express's error handler
// instead of crashing the process.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Plugin routes (server-to-server, X-API-Key required)
// ---------------------------------------------------------------------------

// Called on player login: returns whether they're verified, or issues/reuses a code.
app.post('/api/plugin/session', requireApiKey, asyncRoute(async (req, res) => {
  const { uuid, username } = req.body || {};
  if (!uuid || !username) return res.status(400).json({ message: 'uuid and username are required.' });

  await purgeExpired();
  const player = await getPlayer(uuid);
  if (player && player.verified) {
    return res.json({ verified: true });
  }

  await upsertPlayer(uuid, {
    username,
    verified: player ? player.verified : false,
  });

  const existing = await findPendingByUuid(uuid);
  if (existing) {
    return res.json({ verified: false, code: existing.code });
  }

  const code = await generateUniqueCode();
  const quiz = pickQuiz();
  await insertPending(code, { uuid, username, quiz });
  res.json({ verified: false, code });
}));

// Quick status check (used by /tos test, and can be polled if desired).
app.get('/api/plugin/status/:uuid', requireApiKey, asyncRoute(async (req, res) => {
  const player = await getPlayer(req.params.uuid);
  res.json({ verified: !!(player && player.verified) });
}));

// Force a player back into an unverified state and issue a fresh code.
// Used by the in-game "trigger verification with kick" command.
app.post('/api/plugin/reset', requireApiKey, asyncRoute(async (req, res) => {
  const { uuid, username } = req.body || {};
  if (!uuid || !username) return res.status(400).json({ message: 'uuid and username are required.' });

  await purgeExpired();
  await upsertPlayer(uuid, { username, verified: false, verified_at: null, verified_by: null });
  await deletePendingByUuid(uuid);

  const code = await generateUniqueCode();
  const quiz = pickQuiz();
  await insertPending(code, { uuid, username, quiz });
  res.json({ code });
}));

// Staff manually verifies a player by the code the player read out to them.
// Used by /tos verifycode <code> (requires the tos-control permission in-game).
app.post('/api/plugin/manual-verify', requireApiKey, asyncRoute(async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ message: 'code is required.' });

  const upperCode = code.toUpperCase();
  const entry = await getPending(upperCode);
  if (isExpired(entry)) {
    return res.status(404).json({ message: 'No pending verification found for that code.' });
  }

  await upsertPlayer(entry.uuid, {
    username: entry.username,
    verified: true,
    verified_at: new Date().toISOString(),
    verified_by: 'staff',
  });
  await deletePending(upperCode);
  res.json({ success: true, username: entry.username });
}));

// ---------------------------------------------------------------------------
// Public site routes (used by policy.html — no API key, code is the secret)
// ---------------------------------------------------------------------------

app.get('/api/site/lookup/:code', asyncRoute(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const entry = await getPending(code);
  if (isExpired(entry)) {
    return res.status(404).json({ message: 'That code is invalid or has expired. Please rejoin the server to get a new one.' });
  }
  res.json({ username: entry.username, quiz: stripAnswers(entry.quiz) });
}));

app.post('/api/site/submit', asyncRoute(async (req, res) => {
  const { code, sections, answers } = req.body || {};
  const upperCode = String(code || '').toUpperCase();
  const entry = await getPending(upperCode);
  if (isExpired(entry)) {
    return res.status(404).json({ message: 'That code is invalid or has expired. Please rejoin the server to get a new one.' });
  }

  const allSectionsAgreed = Array.from({ length: 12 }, (_, i) => String(i + 1))
    .every((key) => sections && sections[key] === true);
  if (!allSectionsAgreed) {
    return res.status(400).json({
      success: false,
      message: 'You must check every section before submitting.',
      quiz: stripAnswers(entry.quiz),
    });
  }

  const allCorrect = entry.quiz.every((q) => answers && answers[q.id] === q.answer);
  if (!allCorrect) {
    // Give a fresh set of questions on retry so answers can't just be memorized by position.
    const freshQuiz = pickQuiz();
    await updatePendingQuiz(upperCode, freshQuiz);
    return res.status(400).json({
      success: false,
      message: 'One or more answers were incorrect. Please review the Terms and try again.',
      quiz: stripAnswers(freshQuiz),
    });
  }

  await upsertPlayer(entry.uuid, {
    username: entry.username,
    verified: true,
    verified_at: new Date().toISOString(),
    verified_by: 'self',
  });
  await deletePending(upperCode);
  res.json({ success: true });
}));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback error handler for anything thrown/rejected in asyncRoute handlers
// (e.g. Supabase connectivity issues).
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`ToS verification backend listening on port ${PORT}`);
  if (API_KEY === 'change-me-please') {
    console.warn('WARNING: API_KEY is still the default value. Set the API_KEY environment variable before deploying.');
  }
});
