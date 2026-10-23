// engine.js — pure game rules (no DOM). Works in the browser (window.Engine) and in Node (require).
(function (root) {
  // Skill -> ability, used only when a pregen has no explicit `skills` entry for that skill.
  // (Designer's pregens list card totals in `skills`; Designer's format says unlisted skills are +0,
  //  so the stat fallback is OFF by default — set USE_STAT_FALLBACK = true to enable it.)
  const SKILL_STAT = { athletics:'str', acrobatics:'dex', stealth:'dex', 'sleight of hand':'dex',
    arcana:'int', investigation:'int', history:'int', insight:'wis', perception:'wis', medicine:'wis',
    survival:'wis', persuasion:'cha', deception:'cha', intimidation:'cha', performance:'cha' };
  const USE_STAT_FALLBACK = false;

  const statMod = s => Math.floor(((+s || 10) - 10) / 2);
  const truthy = v => typeof v === 'number' ? v > 0 : !!v;

  // ---- validation: returns a list of human-readable problems; never throws ----
  function validate(d) {
    const e = [], need = (o, k, where) => { if (o == null || o[k] === undefined) e.push(`${where}: missing "${k}"`); };
    if (!d || typeof d !== 'object') return ['scenes.json is not an object'];
    need(d, 'start', 'top'); need(d, 'pregens', 'top'); need(d, 'scenes', 'top');
    const ids = new Set((d.scenes || []).map(s => s && s.id));
    if (d.start && !ids.has(d.start)) e.push(`top: start "${d.start}" is not a scene id`);
    if ((d.pregens || []).length < 3) e.push('top: need 3 pregens');
    (d.pregens || []).forEach((p, i) => ['name', 'class', 'hp'].forEach(k => need(p, k, `pregens[${i}]`)));
    (d.scenes || []).forEach((s, i) => {
      const w = `scene ${s && s.id || '#' + i}`;
      ['id', 'title', 'text', 'options'].forEach(k => need(s, k, w));
      if (!s || !Array.isArray(s.options)) return;
      if (!s.end && s.options.length !== 3) e.push(`${w}: expected 3 options, got ${s.options.length}`);
      if (s.combat && s.combat.on_win && !ids.has(s.combat.on_win)) e.push(`${w}: combat.on_win "${s.combat.on_win}" unknown`);
      s.options.forEach((o, j) => {
        const ow = `${w} option ${j}`;
        need(o, 'label', ow); need(o, 'success', ow);
        if (o.roll) { need(o.roll, 'skill', ow + ' roll'); need(o.roll, 'dc', ow + ' roll'); }
        ['success', 'fail'].forEach(b => {
          const br = o[b]; if (!br) { if (b === 'fail' && !o.roll) return; e.push(`${ow}: missing "${b}"`); return; }
          need(br, 'next_scene_id', `${ow}.${b}`);
          if (br.next_scene_id && !ids.has(br.next_scene_id)) e.push(`${ow}.${b}: next_scene_id "${br.next_scene_id}" unknown`);
          (br.effects || []).forEach((f, k) => { if (!['hp', 'flag'].includes(f.type)) e.push(`${ow}.${b}.effects[${k}]: bad type`); });
        });
      });
    });
    return e;
  }

  const sceneOf = (d, id) => d.scenes.find(s => s.id === id);
  // Names come from the data ("Bran" -> "Bran the Fighter"). Fallback: a generic "The Fighter" uses its optional
  // `nickname` field, else stays "The Fighter". No names are hard-coded here.
  const cap = s => String(s || '')[0] ? String(s)[0].toUpperCase() + String(s).slice(1) : '';
  const displayName = p => {
    if (!p) return '?';
    const n = /^the /i.test(p.name) ? p.nickname : p.name;
    return n ? `${n} the ${cap(p.class)}` : p.name;
  };

  // ---- seats: the first 3 pregens in the data, in order (Bran, Doran, Rook). No seat swapping.
  // Old live saves whose seat 3 was Vex simply get whoever is 3rd in the data now (Rook); HP is clamped in normalize.
  const seatPregens = d => d.pregens.slice(0, 3);
  const heroOf = (d, doc, i) => seatPregens(d)[i];
  const party = (d, doc) => [0, 1, 2].map(i => heroOf(d, doc, i));

  // Old saves (13-scene era, or Firebase dropping empty objects) may lack flags/combatActions/done; fill defaults.
  // Unknown scene id (scene removed from data) -> restart at data.start rather than crash. Returns the same doc.
  // Scenes removed from the data after live games started (Oct 22). Saves sitting in one move to the nearest
  // existing scene instead of restarting. Any other unknown id falls back to data.start.
  const REDIRECT = { fork: 'ranger_arrives', road: 'ranger_arrives', sky_sword: 'ranger_arrives', goblin_fight: 'mine_gate' };
  function normalize(doc, d) {
    if (!doc) return doc;
    if (!doc.flags || typeof doc.flags !== 'object') doc.flags = {};
    if (!Array.isArray(doc.log)) doc.log = [];
    if (!Array.isArray(doc.hp)) doc.hp = [];
    const P = party(d, doc);
    for (let i = 0; i < 3; i++) doc.hp[i] = Math.min(P[i].hp, Math.max(1, +doc.hp[i] || P[i].hp));
    doc.turn = (+doc.turn || 0) % 3;
    doc.combatActions = +doc.combatActions || 0;
    doc.done = !!doc.done;
    if (!sceneOf(d, doc.scene) && REDIRECT[doc.scene] && sceneOf(d, REDIRECT[doc.scene])) { doc.scene = REDIRECT[doc.scene]; doc.combatActions = 0; }
    if (!sceneOf(d, doc.scene)) { doc.log.push({ t: 'scene', text: `(scene "${doc.scene}" no longer exists, back to the start)` }); doc.scene = d.start; doc.done = false; }
    return doc;
  }

  function modFor(p, skill, scene) {
    if (scene && scene.combat && p.attack) return +p.attack.to_hit || 0;   // decision (2)
    const sk = p.skills || {};
    if (skill in sk) return sk[skill];
    if (skill.replace(/_/g, ' ') in sk) return sk[skill.replace(/_/g, ' ')];
    return USE_STAT_FALLBACK && SKILL_STAT[skill] ? statMod(p[SKILL_STAT[skill]]) : 0;
  }

  function applyEffects(doc, d, effects, actor) {
    for (const f of effects || []) {
      if (f.type === 'hp') {
        const who = f.target === 'party' ? [0, 1, 2] : [actor];
        who.forEach(i => { const max = heroOf(d, doc, i).hp;
          doc.hp[i] = Math.min(max, Math.max(1, doc.hp[i] + f.delta)); });   // decision (1): floor at 1
      } else if (f.type === 'flag') {
        doc.flags[f.key] = typeof f.value === 'number' ? (+doc.flags[f.key] || 0) + f.value : f.value; // decision (3)
      }
    }
  }

  function enter(doc, d, id, actor) {
    doc.scene = id; doc.combatActions = 0;
    const s = sceneOf(d, id);
    if (s) { applyEffects(doc, d, s.on_enter, actor); if (s.end) doc.done = true; }
  }

  function newGame(d) {
    const doc = { scene: null, turn: 0, hp: seatPregens(d).map(p => p.hp), flags: {}, log: [], done: false, combatActions: 0 };
    enter(doc, d, d.start, 0);
    doc.log.push({ t: 'scene', text: sceneOf(d, d.start).title });
    return doc;
  }

  const available = (o, doc) => !o.requires || truthy((doc.flags || {})[o.requires.flag]);
  const hasAdvantage = (s, o, doc) => !!(o.roll && s.advantage_if_any_flag &&
      (!s.advantage_applies_to || s.advantage_applies_to === o.roll.skill) && s.advantage_if_any_flag.some(k => truthy((doc.flags || {})[k])));

  // Resolve one action by the current player. rng() -> [0,1). Returns a NEW doc.
  function act(doc0, d, optIndex, rng = Math.random) {
    const doc = normalize(JSON.parse(JSON.stringify(doc0)), d), actor = doc.turn, p = heroOf(d, doc, actor);
    const s = sceneOf(d, doc.scene), o = s.options[optIndex];
    if (!o || !available(o, doc) || doc.done) throw new Error('option not available');
    const who = displayName(p);
    let ok = true, entry = { t: 'act', who, label: o.label };
    if (o.roll) {
      const d20 = () => 1 + Math.floor(rng() * 20);
      const adv = hasAdvantage(s, o, doc), dice = adv ? [d20(), d20()] : [d20()];
      const die = Math.max(...dice), mod = modFor(p, o.roll.skill, s), total = die + mod;
      ok = total >= o.roll.dc;                           // tie = success (source rule)
      Object.assign(entry, { dice, adv, mod, total, dc: o.roll.dc, skill: s.combat ? 'attack' : o.roll.skill, ok });
    }
    const br = ok ? o.success : (o.fail || o.success);
    entry.text = br.text;
    applyEffects(doc, d, br.effects, actor);
    let next = br.next_scene_id;
    const c = s.combat;
    if (c && next === s.id) {                            // still in the fight: check counter / round limit
      doc.combatActions++;
      const hits = c.hit_counter_flag ? (+doc.flags[c.hit_counter_flag] || 0) : 0;
      const won = c.hit_counter_flag && hits >= c.hits_to_win;
      const timeout = c.max_rounds && doc.combatActions >= c.max_rounds * 3;
      if (won || timeout) {
        applyEffects(doc, d, c.on_win_effects, actor);
        entry.text += won ? (c.surrender_text ? ' ' + c.surrender_text : ' The fight is won!') : ' The monsters give up and flee.';
        next = c.on_win;
      }
    }
    doc.log.push(entry);
    if (next !== doc.scene) { enter(doc, d, next, actor); doc.log.push({ t: 'scene', text: sceneOf(d, next).title }); }
    doc.turn = (doc.turn + 1) % 3;
    return doc;
  }

  const api = { validate, newGame, act, available, hasAdvantage, modFor, displayName, sceneOf, heroOf, party, normalize, SKILL_STAT };
  if (typeof module !== 'undefined') module.exports = api; else root.Engine = api;
})(this);
