// app.js — UI glue: read link -> load scenes -> subscribe to the shared game doc -> render.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let DATA, store, doc, me, lastRoll = null;

// Link format: #g=<gameId>&p=<1..3>. No g -> make a new game and show the 3 player links.
function parseHash() { const h = new URLSearchParams(location.hash.slice(1)); return { g: h.get('g'), p: +h.get('p') }; }
function newId() { const a = new Uint8Array(16); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }

async function loadScenes() {
  for (const u of GAME_CONFIG.scenesUrls) {
    try { const r = await fetch(u, { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (e) {}
  }
  throw new Error('no scenes.json found');
}

async function main() {
  try { DATA = await loadScenes(); } catch (e) { $('#app').innerHTML = '<p>Could not load scenes.json.</p>'; console.error(e); return; }
  const errs = Engine.validate(DATA);
  if (errs.length) { console.error('scenes.json validation:\n' + errs.join('\n')); }   // shown in console, not a crash
  let { g, p } = parseHash();
  if (!g) { g = newId(); location.hash = `g=${g}&p=1`; p = 1; }
  if (!(p >= 1 && p <= 3)) p = 1;
  me = p - 1;
  store = makeStore(g, GAME_CONFIG);
  doc = await store.get();
  if (!doc) { await store.cas(0, Engine.newGame(DATA)); doc = await store.get(); }   // first visitor creates the game
  store.subscribe(d => { doc = d; render(); });
  window.addEventListener('hashchange', () => location.reload());
  render();
}

async function choose(i) {
  if (doc.turn !== me || doc.done) return;
  const base = doc;
  let next;
  try { next = Engine.act(base, DATA, i); } catch (e) { console.warn(e.message); return; }
  const ok = await store.cas(base.v, next);           // only wins if nobody else moved first
  doc = await store.get();
  if (ok) lastRoll = next.log.filter(x => x.t === 'act').pop();
  render();
}

function render() {
  if (!doc) return;
  const s = Engine.sceneOf(DATA, doc.scene), P = DATA.pregens.slice(0, 3);
  const name = i => Engine.displayName(P[i]);
  const mine = doc.turn === me && !doc.done;
  const links = [1, 2, 3].map(n => `${location.href.split('#')[0]}#g=${parseHash().g}&p=${n}`);
  let h = `<div id="turn" class="card ${mine ? 'mine' : 'wait'}">${doc.done ? '🏁 The adventure is over!'
          : mine ? `⭐ Your turn, ${esc(name(me))}!` : `⏳ Waiting for ${esc(name(doc.turn))}…`}</div>`;
  h += `<div id="party">${P.map((p, i) => `<div class="${i === doc.turn ? 'now' : ''}">${i === me ? '🫵 ' : ''}<b>${esc(name(i))}</b><br>HP ${doc.hp[i]}/${p.hp}</div>`).join('')}</div>`;
  if (lastRoll && lastRoll.dice) h += rollHtml(lastRoll);
  h += `<div class="card"><h2>${esc(s.title)}</h2><p>${esc(s.text)}</p>`;
  if (s.end) {
    if (s.wrap_up_prompt) h += `<p><b>${esc(s.wrap_up_prompt)}</b></p>`;
    if (s.rewards) h += `<p>🪙 ${esc(s.rewards.gold)}<br>✨ ${esc(s.rewards.item)}<br>⬆️ Level ${esc(s.rewards.level)}</p>`;
  } else {
    s.options.forEach((o, i) => {
      if (!Engine.available(o, doc)) return;               // `requires` hides the option
      const adv = Engine.hasAdvantage(s, o, doc);
      const tag = o.roll ? `d20 ${fmt(Engine.modFor(P[me], o.roll.skill, s))} vs ${o.roll.dc}${adv ? ' · advantage' : ''}` : 'no roll';
      h += `<button data-i="${i}" ${mine ? '' : 'disabled'}><span class="tag">${tag}</span>${esc(o.label)}</button>`;
    });
  }
  h += `</div><div class="card"><h2>Log</h2><div id="log">${doc.log.slice().reverse().map(logHtml).join('')}</div></div>`;
  h += `<details class="card" id="links"><summary>Player links (send one to each friend)</summary>${links.map((l, i) => `<label>${esc(name(i))}<input readonly value="${esc(l)}"></label>`).join('')}</details>`;
  $('#app').innerHTML = h;
  document.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => choose(+b.dataset.i));
}
const fmt = n => (n >= 0 ? '+' : '') + n;
const rollHtml = r => `<div id="roll" class="card">🎲 ${r.dice.join(' / ')}${r.adv ? ' (keep higher)' : ''} ${fmt(r.mod)} = <b>${r.total}</b> vs ${r.dc} — <span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'Success!' : 'Fail'}</span></div>`;
const logHtml = e => e.t === 'scene' ? `<p class="sc">— ${esc(e.text)} —</p>`
  : `<p><b>${esc(e.who)}</b>: ${esc(e.label)}${e.dice ? ` <i>(🎲${e.dice.join('/')} ${fmt(e.mod)} = ${e.total} vs ${e.dc}, ${e.ok ? 'success' : 'fail'})</i>` : ''}. ${esc(e.text)}</p>`;

main();
