// Vercel serverless function: /api/chat
// Env vars: GEMINI_API_KEY (required), GEMINI_MODEL (optional, default gemini-2.5-flash)

const LANG = {
  en: 'English',
  hi: 'Hindi (Devanagari script)',
  mr: 'Marathi (Devanagari script)',
  hn: 'Hinglish (Hindi written in Roman/English letters, mixed with English words)',
};

const clip = (s, n) => String(s || '').slice(0, n);

async function gemini(system, contents, temperature) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const generationConfig = { responseMimeType: 'application/json', temperature };
  if (model.includes('2.5') && model.includes('flash')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Gemini error');
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch { return { _raw: clean }; }
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
