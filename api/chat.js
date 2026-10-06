// Vercel serverless function: /api/chat
// Env vars: GEMINI_API_KEY (required), GEMINI_MODEL (optional), GEMINI_FALLBACK_MODEL (optional)

export const config = { maxDuration: 60 };

const DEFAULT_MODEL = 'gemini-3.8-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta';

const LANG = {
  en: 'English',
  hi: 'Hindi (Devanagari script)',
  mr: 'Marathi (Devanagari script)',
  hn: 'Hinglish (Hindi written in Roman/English letters, mixed with English words)',
};

const clip = (s, n) => String(s || '').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isBusy = (status, msg) =>
  [429, 500, 502, 503, 504].includes(status) || /high demand|overloaded|try again later|temporarily/i.test(msg || '');

// One single call to one model. Throws an error with .busy = true if retrying makes sense.
async function callModel(model, system, contents, temperature) {
  const generationConfig = { responseMimeType: 'application/json', temperature };
  if (model.includes('2.5') && model.includes('flash')) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  let r;
  try {
    r = await fetch(`${API}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
    });
  } catch (e) {
    const err = new Error('Network error');
    err.busy = true;
    throw err;
  }

  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = data?.error?.message || 'Gemini error';
    const err = new Error(msg);
    err.status = r.status;
    err.busy = isBusy(r.status, msg);
    throw err;
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text.trim()) {
    const err = new Error('Empty response');
    err.busy = true;
    throw err;
  }
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch { return { _raw: clean }; }
}

// Asks Google which Flash models this key can use (only used when the main models fail).
let cachedModels = null;
async function discoverModels() {
  if (cachedModels) return cachedModels;
  try {
    const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
    const d = await r.json();
    const names = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace('models/', ''))
      .filter((n) => /flash/i.test(n) && !/image|tts|audio|live|native|robotics|computer|embed/i.test(n));
    const stable = names.filter((n) => !/preview|exp/i.test(n));
    const rest = names.filter((n) => /preview|exp/i.test(n));
    const sort = (a, b) => b.localeCompare(a, undefined, { numeric: true });
    cachedModels = [...stable.sort(sort), ...rest.sort(sort)];
  } catch {
    cachedModels = [];
  }
  return cachedModels;
}

function friendly(e) {
  const msg = (e && e.message) || '';
  if (e && e.status === 429 && /quota|limit/i.test(msg)) return 'Free usage limit reached for now. Please wait a few minutes and try again.';
  if (e && e.busy) return 'The AI is busy right now. Please wait a minute and try again.';
  return msg || 'Server error';
}

// Tries the main model (with retries), then backup models.
async function gemini(system, contents, temperature) {
  const deadline = Date.now() + 40000;
  const queue = [(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim()];
  if (process.env.GEMINI_FALLBACK_MODEL) queue.push(process.env.GEMINI_FALLBACK_MODEL.trim());
  const tried = new Set();
  let discovered = false;
  let lastErr = null;

  while (queue.length || !discovered) {
    if (!queue.length) {
      discovered = true;
      const list = await discoverModels();
      queue.push(...list.filter((m) => !tried.has(m)).slice(0, 3));
      if (!queue.length) break;
    }
    const model = queue.shift();
    if (!model || tried.has(model)) continue;
    tried.add(model);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callModel(model, system, contents, temperature);
      } catch (e) {
        lastErr = e;
        if (!e.busy) break; // not a busy error: go to the next model
        const wait = 1500 * (attempt + 1);
        if (attempt === 2 || Date.now() + wait > deadline) break;
        await sleep(wait);
      }
    }
    if (Date.now() > deadline) break;
  }
  throw new Error(friendly(lastErr));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
  try {
    const { action, setup = {}, messages = [] } = req.body || {};
    const lang = LANG[setup.lang] || LANG.en;
    const field = clip(setup.field, 80), role = clip(setup.role, 120);
    const level = ['Easy', 'Medium', 'Hard'].includes(setup.difficulty) ? setup.difficulty : 'Medium';
    const resume = clip(setup.resume, 4000);
    const panel = setup.mode === 'panel';
    const msgs = messages.slice(-40).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', text: clip(m.text, 3000) }));

    if (action === 'interview') {
      const system = `You are running a REALISTIC spoken mock interview.
Candidate field: ${field}. Target role/exam: ${role}. Difficulty: ${level}.
${resume ? 'Candidate resume (ask personalised questions from it):\n' + resume : 'No resume given.'}
${panel
  ? 'PANEL MODE: two interviewers. "Priya" is HR (motivation, behaviour, communication, situational questions). "Rahul" is Technical (deep subject knowledge of the field). Choose the speaker who fits best; alternate naturally, usually Priya first with a short intro and easy opening question.'
  : 'SINGLE MODE: one interviewer, speaker name must be "Interviewer". Mix subject and personal questions.'}
You are an expert in "${field}" with full, accurate, up-to-date subject knowledge (concepts, laws, procedures, formulas, current affairs of that field). Ask real questions asked in actual interviews/exams for "${role}".
RULES:
- Ask exactly ONE question per turn. Max 55 words. Spoken style, no markdown, no lists.
- If the last answer was correct and good: briefly acknowledge (a few words) and ask a deeper follow-up or a new topic.
- If wrong/incomplete: NEVER reveal the correct answer. Give a small hint or a counter-question that makes them rethink.
- If the candidate says they don't know, give one small hint; if still stuck, move on to another topic.
- Difficulty ${level}: Easy = basics, friendly; Medium = applied and scenario-based; Hard = tricky, edge cases, pressure.
- Speak ONLY in ${lang}. Be warm but professional, like a real Indian interview panel.
- If the first user message is START, greet the candidate and ask the first question.
Return ONLY JSON: {"speaker":"${panel ? 'Priya or Rahul' : 'Interviewer'}","text":"what you say"}`;
      const contents = msgs.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
      if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'START' }] });
      const out = await gemini(system, contents, 0.8);
      const text = out.text || out._raw || '...';
      return res.status(200).json({ speaker: out.speaker || (panel ? 'Priya' : 'Interviewer'), text });
    }

    if (action === 'report') {
      const transcript = msgs
        .map((m) => {
          if (m.role === 'user') return m.text === 'START' ? '' : 'CANDIDATE: ' + m.text;
          let t = m.text; try { const j = JSON.parse(m.text); t = `${j.speaker}: ${j.text}`; } catch {}
          return 'INTERVIEWER ' + t;
        })
        .filter(Boolean).join('\n');
      const system = `You are a senior interview coach evaluating a mock interview.
Field: ${field}. Role/exam: ${role}. Difficulty: ${level}.
Judge technical correctness strictly and honestly, using your real subject knowledge. Write all text values in ${lang}.
Return ONLY JSON with this exact shape:
{"overall":0-100,"knowledge":0-100,"communication":0-100,"confidence":0-100,"summary":"2 sentences",
"strengths":["..."],
"mistakes":[{"question":"...","yourAnswer":"short","issue":"what was wrong or missing","betterAnswer":"a model answer, 2-4 sentences"}],
"nextSteps":["specific topics/actions to practise"]}
Give 2-4 strengths, up to 5 mistakes (only real ones), 3-5 next steps.`;
      const out = await gemini(system, [{ role: 'user', parts: [{ text: transcript || 'No answers given.' }] }], 0.4);
      return res.status(200).json({ report: out });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
