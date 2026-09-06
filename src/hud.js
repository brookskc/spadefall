import { holdClock } from './match-modes.js';

export function matchClockPresentation(overtime, remaining) {
  return {
    text: overtime ? 'OVERTIME' : holdClock(Math.max(0, remaining ?? 0)),
    urgent: !overtime && (remaining ?? 0) <= 60,
  };
}

export function scorePresentation(captures, hill) {
  return hill
    ? `<span class="g">GREEN ${holdClock(captures.green)}</span><span style="opacity:.4">—</span><span class="b">${holdClock(captures.blue)} BLUE</span>`
    : `<span class="g">GREEN ${captures.green}</span><span style="opacity:.4">—</span><span class="b">${captures.blue} BLUE</span>`;
}

export function objectiveBearing(player, target) {
  if (!player?.alive || !target) return null;
  const dx = target.x - player.body.pos.x;
  const dz = target.z - player.body.pos.z;
  const look = player.lookDir();
  return {
    angle: Math.atan2(look.x * dz - look.z * dx, look.x * dx + look.z * dz),
    distance: Math.round(Math.hypot(dx, dz)),
  };
}

const MULTIKILL = {
  double: { text: 'DOUBLE KILL', color: '#ffd97a', notes: 2 },
  triple: { text: 'TRIPLE KILL', color: '#ffd97a', notes: 3 },
  multi:  { text: 'MULTI KILL',  color: '#e05a4e', notes: 5 },
};

/**
 * Build the browser HUD adapter around the game dependencies it consumes.
 * Keeping the game instance out of this module prevents an import cycle while
 * allowing the presentation layer to retain the legacy method surface.
 */
export function createHud(deps = {}) {
  const {
    TOOLS, BREATH_MAX, AIRSTRIKE_COST, BASE, SEA, SX, PALETTE,
    CAP_TIME, HILL_MOVE_WARNING, HOLD_LIMIT, KILL_LIMIT, WIN_SCORE,
    POST_MATCH_TIME, stats, sfx, deathRecapCopy, ctfObjectiveKind,
    occupiedScoringTeam, nextHillIndex, rankContributionRows, teamCss = team => team,
  } = deps;
  // The HUD deliberately addresses the existing page contract by ID. Keep
  // this adapter's dynamic DOM surface local instead of leaking HTMLElement
  // casts through every legacy method.
  const getDom = () => /** @type {any} */ (
    typeof document === 'undefined' ? null : document);
  /** @param {string} id @returns {any} */
  const $ = id => getDom()?.getElementById(id);
  return {
  refreshTool(p) {
    const t = TOOLS[p.tool];
    $('toolname').textContent = t.name;
    if (t.key === 'block') $('ammo').innerHTML = `${p.blocks} <small>blocks</small>`;
    else if (t.key === 'nade') $('ammo').innerHTML = `${p.grenades} <small>grenades</small>`;
    else if (t.key === 'spade') $('ammo').innerHTML = `∞`;
    else $('ammo').innerHTML = p.reloading > 0
      ? `<small>reloading…</small>`
      : `${p.ammo[p.tool]} <small>/ ${t.mag}</small>`;
    $('toolhint').textContent = '1 gun · 2 spade · 3 blocks · 4 grenade · R reload';
  },
  health(p) {
    $('healthfill').style.width = Math.max(0, p.health) + '%';
    $('healthnum').textContent = Math.max(0, Math.ceil(p.health)) + ' HP'
      + (p.protT > 0 ? ' · SAFE' : '');
    $('healthfill').style.background = p.health > 40
      ? 'linear-gradient(90deg,#5db85d,#8fd98f)' : 'linear-gradient(90deg,#c0392b,#e74c3c)';
  },
  air(breath, visible) {
    const el = $('air');
    if (!el) return;
    const seconds = Math.max(0, Math.min(BREATH_MAX, breath));
    const shown = !!visible;
    el.classList.toggle('on', shown);
    // The vitals panel grows upward when its air meter appears. Move chat by
    // the same state rather than leaving its lowest line behind the meter.
    $('hud')?.classList.toggle('air-visible', shown);
    el.classList.toggle('low', seconds <= 4);
    $('airfill').style.width = (seconds / BREATH_MAX * 100) + '%';
    $('airnum').textContent = seconds > 0 ? `${Math.ceil(seconds)}s` : 'EMPTY';
  },
  danger(row) {
    const el = $('dangerCue');
    if (!el) return;
    el.classList.toggle('on', !!row);
    if (!row) return;
    el.style.setProperty('--bearing', `${row.bearing}rad`);
    $('dangerText').style.transform = `rotate(${-row.bearing}rad)`;
    $('dangerText').textContent = `FRAG · ${Math.max(1, Math.ceil(row.distance))}m`;
  },
  ready(count, total, mine = false) {
    const button = $('readyBtn');
    if (!button) return;
    button.textContent = mine ? `READY · ${count}/${total}` : `READY FOR NEXT · ${count}/${total}`;
    button.classList.toggle('voted', mine);
    button.disabled = mine;
  },
  // Round trip to the host, piggybacked on traffic that already exists (see
  // the 'ts' field on the client uplink and its echo in _broadcastSnapshot)
  // — no separate ping message and no extra round trip. Only clients have a
  // meaningful round trip to show; solo and host leave the corner clear.
  ping(g) {
    const el = $('ping');
    if (!el) return;
    if (g.mode !== 'client') {
      el.textContent = ''; el.className = ''; el.style.display = 'none'; return;
    }
    el.style.display = '';
    const ms = g.pingMs;
    if (ms == null) { el.textContent = '‥ ms'; el.className = ''; return; }
    el.textContent = Math.round(ms) + ' ms';
    el.className = ms > 150 ? 'bad' : ms > 80 ? 'warn' : '';
  },
  // p is always the LOCAL player — purely personal HUD state, never shown
  // for anyone else's contribution/airstrike status.
  streakStatus(p) {
    const ready = $('airstrikeReady');
    if (ready) {
      const points = Math.floor(p._streak ?? 0);
      const ability = p.game.availableStreak(p);
      ready.classList.toggle('building', !ability);
      if (p._piloting || p._fallingT > 0 || p._lingerT > 0) ready.style.display = 'none';
      else if (ability === 'airstrike') {
        ready.textContent = 'airstrike ready — [F]'; ready.style.display = 'block';
      } else if (points > 0) {
        ready.textContent = `airstrike progress · ${points}/${AIRSTRIKE_COST}`;
        ready.style.display = 'block';
      } else ready.style.display = 'none';
    }
    const overlay = $('airstrikeHud');
    if (overlay) {
      overlay.classList.toggle('on', !!p._piloting || p._fallingT > 0);
      // Same reticle, different label: nothing left to confirm once a
      // target's locked in, and the fall itself is now interactive —
      // "click to confirm" would be actively wrong once WASD is steering.
      const label = overlay.querySelector('.label');
      if (label) label.textContent = p._piloting ? 'airstrike — click to confirm' : 'airstrike falling — WASD to guide';
    }
  },
  firstMinute(view) {
    const el = $('firstMinute');
    if (!el) return;
    $('hud')?.classList.toggle('orientation', !!view?.visible);
    const key = view?.visible
      ? [view.prompt, view.hint, view.objective,
          ...Object.values(view.progress).map(Number)].join('|') : 'off';
    if (key === this._firstMinuteKey) return;
    this._firstMinuteKey = key;
    el.classList.toggle('on', !!view?.visible);
    if (!view?.visible) return;
    $('firstMinutePrompt').textContent = view.prompt;
    $('firstMinuteHint').textContent = view.hint;
    $('firstMinuteObjective').textContent = `OBJECTIVE · ${view.objective}`;
    const mark = done => done ? '■' : '□';
    $('firstMinuteProgress').textContent = [
      `${mark(view.progress.move)} MOVE`, `${mark(view.progress.fire)} FIRE`,
      `${mark(view.progress.terrain)} TERRAIN`, `${mark(view.progress.ping)} PING`,
    ].join('  ·  ');
  },
  score(g) {
    const next = scorePresentation(g.captures, g.hill);
    if (next !== this._lastScore) { this._lastScore = next; $('score').innerHTML = next; }
    this._flagState(g);
    this.clock(g);
  },
  clock(g) {
    const el = $('matchclock');
    if (!el) return;
    const view = matchClockPresentation(g.overtime, g.matchRemaining), text = view.text;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('overtime', !!g.overtime);
    el.classList.toggle('urgent', view.urgent);
  },
  objective(g) {
    const el = $('objective');
    if (!el) return;
    const p = g.player;
    let target = null, label = '';
    if (g.hill) { target = g.hill.pos; label = g.hill.label ?? 'HILL'; }
    else if (g.flags) {
      const enemy = p.team === 'green' ? 'blue' : 'green';
      const ownFlag = g.flags[p.team], enemyFlag = g.flags[enemy];
      const kind = ctfObjectiveKind({ carrier: p.carrier,
        ownState: ownFlag.state, enemyState: enemyFlag.state });
      if (kind === 'return') { target = ownFlag.home; label = 'RETURN'; }
      else if (kind === 'recover') { target = ownFlag.pos; label = 'RECOVER'; }
      else if (kind === 'escort') { target = enemyFlag.pos; label = 'ESCORT'; }
      else if (kind === 'secure') { target = enemyFlag.pos; label = 'SECURE'; }
      else { target = enemyFlag.home; label = 'ATTACK'; }
    }
    const bearing = objectiveBearing(p, target);
    if (!bearing) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.querySelector('.arrow').style.transform = `rotate(${bearing.angle}rad)`;
    el.querySelector('.label').textContent = `${label} ${bearing.distance}m`;
  },
  teamPing(g) {
    const el = $('teamPing');
    if (!el) return;
    const p = g.player;
    const mark = g.teamPings?.filter(m => m.team === p.team)
      .sort((a, b) => p.body.pos.distanceToSquared(a.pos) - p.body.pos.distanceToSquared(b.pos))[0];
    const bearing = objectiveBearing(p, mark?.pos);
    if (!mark || !bearing) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.querySelector('.arrow').style.transform = `rotate(${bearing.angle}rad)`;
    el.querySelector('.label').textContent = `${mark.kind} · ${mark.name} · ${bearing.distance}m`;
  },
  staySquad(g, voters = []) {
    const wrap = $('squadReady');
    const btn = $('squadBtn');
    if (!wrap || !btn) return;
    const state = g.staySquadState(voters);
    const supported = g.engagementFeatures.stayAsSquad
      && (g.mode !== 'client' || g._squadHostEnabled);
    wrap.classList.toggle('on', supported && state.available);
    if (!supported || !state.available) return;
    btn.disabled = state.voted;
    btn.classList.toggle('voted', state.voted);
    btn.textContent = state.formed
      ? `SQUAD READY · ${state.ready}/${state.teammates}`
      : state.voted
        ? `WAITING FOR TEAM · ${state.ready}/${state.teammates}`
        : `STAY AS SQUAD · ${state.ready}/${state.teammates}`;
  },
  _flagState(g) {
    if (g.hill) { // king of the hill: who owns the point, who's taking it
      const h = g.hill;
      const scoring = occupiedScoringTeam(h.owner, h.presence);
      const state = h.contested ? 'CONTESTED — NO SCORE'
        : h.progress > 0.1 ? `${h.capTeam.toUpperCase()} CAPTURING ${Math.round(h.progress / CAP_TIME * 100)}%`
        : scoring ? `${scoring.toUpperCase()} OCCUPIES THE HILL`
        : h.owner ? `${h.owner.toUpperCase()} CONTROLS · HILL VACANT — NO SCORE`
        : `capture and occupy for ${holdClock(HOLD_LIMIT)} to win`;
      const moving = !g.overtime && h.rotateIn <= HILL_MOVE_WARNING
        ? ` · MOVES IN ${Math.max(1, Math.ceil(h.rotateIn))}` : '';
      const text = state + moving;
      if (text !== this._lastFlags) { this._lastFlags = text; $('flagstate').textContent = text; }
      return;
    }
    if (!g.flags) { // team deathmatch: kills are the score
      const text = `first to ${KILL_LIMIT} kills`;
      if (text !== this._lastFlags) { this._lastFlags = text; $('flagstate').textContent = text; }
      return;
    }
    const parts = [];
    for (const team of ['green', 'blue']) {
      const f = g.flags[team];
      const label = team.toUpperCase() + ' FLAG';
      if (f.state === 'carried') parts.push(`${label} TAKEN`);
      else if (f.state === 'dropped') parts.push(`${label} DROPPED ${Math.ceil(f.dropTimer)}s`);
    }
    const text = parts.join(' · ') || `first to ${WIN_SCORE} captures`;
    if (text !== this._lastFlags) { this._lastFlags = text; $('flagstate').textContent = text; }
  },
  // Scoreboard table, sorted by total contribution. Shared by the TAB overlay and the
  // end-of-round summary. Names are composed here from map keys that were
  // cleanName'd (local) or sanitized on receipt (client), so plain text.
  kdTable(g, { groupTeams = false } = {}) {
    const rows = rankContributionRows(g.kd.entries());
    const me = g.player ? g._kdKey(g.player) : null;
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let html = '<table class="kd"><tr><th></th><th>SCORE</th><th>K</th><th>D</th><th>A</th><th>OBJ</th></tr>';
    const ordered = groupTeams ? ['green', 'blue'].flatMap(team => {
      const teamRows = rows.filter(([, r]) => r.team === team);
      return teamRows.length ? [['__group__' + team, { team, group: true }], ...teamRows] : teamRows;
    }) : rows;
    for (const [key, r] of ordered) {
      if (r.group) {
        html += `<tr class="teamGroup ${r.team}"><td colspan="6">${r.team.toUpperCase()} FORCE</td></tr>`;
        continue;
      }
      const c = teamCss(r.team);
      const isMe = key === me;
      const name = esc(r.name);
      html += `<tr${isMe ? ' class="me"' : ''}>`
        + `<td style="color:${c}">${name}</td>`
        + `<td>${Math.floor(r.score ?? 0)}</td><td>${r.k}</td><td>${r.d}</td>`
        + `<td>${r.a ?? 0}</td><td>${Math.floor(r.objective ?? 0)}</td></tr>`;
    }
    return html + '</table>';
  },
  matchReport(g, report, recordUpdate) {
    const r = report.local;
    $('endStats').innerHTML = [
      ['SCORE', Math.round(r.score), `${report.overallRank === 1 ? 'match leader' : 'contribution'}`],
      ['K / D / A', `${r.k} / ${r.d} / ${r.a}`, `${r.d ? (r.k / r.d).toFixed(2) : r.k.toFixed(2)} K/D`],
      ['OBJECTIVE', Math.round(r.objective), g.gameMode === 'koth' ? 'actions + hold time' : 'objective actions'],
      ['RANK', `#${report.overallRank} / ${report.overallSize}`,
        `#${report.teamRank} of ${report.teamSize} on team`],
    ].map(([label, value, note]) => `<div class="reportStat"><span>${label}</span>`
      + `<b>${value}</b><small>${note}</small></div>`).join('');

    $('endMedals').innerHTML = report.medals.length
      ? report.medals.map(m => `<div class="medal ${m.id}"><b>${m.name}</b><span>${m.detail}</span></div>`).join('')
      : '<div class="noMedals">NO MEDALS THIS ROUND</div>';

    const bests = recordUpdate.newBests;
    if (bests.length) {
      $('endBests').classList.add('new');
      $('endBests').textContent = `NEW ${recordUpdate.mode.toUpperCase()} BEST${bests.length > 1 ? 'S' : ''} · `
        + bests.map(b => `${b.label} ${b.value}`).join(' · ');
    } else {
      $('endBests').classList.remove('new');
      const saved = stats.get().records?.[recordUpdate.mode] ?? {};
      $('endBests').textContent = `${recordUpdate.mode.toUpperCase()} PERSONAL BESTS · `
        + `SCORE ${Math.round(saved.score ?? 0)} · KILLS ${Math.round(saved.k ?? 0)} · `
        + `ASSISTS ${Math.round(saved.a ?? 0)} · OBJECTIVE ${Math.round(saved.objective ?? 0)}`;
    }
    const mastery = recordUpdate.mastery ?? stats.mastery();
    $('endMastery').textContent = (recordUpdate.newMasteryTier
      ? `${recordUpdate.newMasteryTier.name} MASTERY RANK UNLOCKED`
      : mastery.next
        ? `${mastery.tier.name} MASTERY · ${mastery.remaining} SCORE TO ${mastery.next.name}`
        : `${mastery.tier.name} MASTERY · MAXIMUM RANK`)
      + (recordUpdate.specialty ? ` · ${recordUpdate.specialty.toUpperCase()} SPECIALTY` : '');
  },
  voxelStory(story) {
    const el = $('endStory');
    if (!el) return;
    el.className = story ? `on ${story.kind}` : '';
    if (!story) return;
    const labels = {
      'collapse-kill': 'COLLAPSE KILL', collapse: 'COLLAPSE', airstrike: 'AIRSTRIKE',
      rewritten: 'BUILD + DIG', blast: 'BLAST DAMAGE', built: 'BUILDING',
      dug: 'DIGGING', changed: 'TERRAIN CHANGED',
    };
    // The result screen reports the event like a field log. The old dramatic
    // headline repeated a generic achievement-card voice that did not belong
    // to the rest of the game; the measured detail remains unchanged.
    $('endStoryTitle').textContent = labels[story.kind] ?? 'TERRAIN CHANGED';
    $('endStoryDetail').textContent = story.detail;
    const m = story.metrics ?? {};
    const values = [['impactBuilt', m.built], ['impactRemoved', m.removed],
      ['impactBlast', m.blastRemoved], ['impactCollapsed', m.collapsed],
      ['impactCrush', m.collapseKills]];
    const peak = Math.max(1, ...values.map(([, value]) => Math.floor(value ?? 0)));
    for (const [id, value] of values) {
      const node = $(id);
      if (!node) continue;
      const count = Math.floor(value ?? 0);
      node.textContent = count;
      node.parentElement?.style.setProperty('--fill', count
        ? `${Math.max(8, Math.round(count / peak * 100))}%` : '0%');
    }
  },
  rotationProgress(seconds, active = true) {
    const rail = $('endProgress');
    const label = $('endProgressLabel');
    if (!rail || !label) return;
    rail.style.display = active ? 'flex' : 'none';
    label.style.display = active ? 'block' : 'none';
    if (!active) return;
    const remaining = Math.max(0, Math.min(POST_MATCH_TIME, Number(seconds) || 0));
    const blocks = Math.ceil(remaining / POST_MATCH_TIME * rail.children.length);
    for (let i = 0; i < rail.children.length; i++)
      rail.children[i].classList.toggle('on', i < blocks);
    label.textContent = `ROTATION IN ${Math.ceil(remaining)} SEC`;
  },
  statsShow(g) {
    $('statsbody').innerHTML = this.kdTable(g);
    $('stats').style.display = 'block';
  },
  statsHide() { $('stats').style.display = 'none'; },
  statsRefresh(g) {
    if ($('stats').style.display === 'block')
      $('statsbody').innerHTML = this.kdTable(g);
  },
  feed(html) {
    const div = getDom().createElement('div');
    div.innerHTML = html;
    $('feed').prepend(div);
    setTimeout(() => { div.style.transition = 'opacity .6s'; div.style.opacity = 0; }, 3600);
    setTimeout(() => div.remove(), 4300);
    while ($('feed').children.length > 6) $('feed').lastChild.remove();
  },
  message(text, color = '#fff') {
    const m = $('msg');
    m.textContent = text;
    m.style.color = color;
    m.style.opacity = 1;
    clearTimeout(this._mt);
    this._mt = setTimeout(() => (m.style.opacity = 0), 2200);
  },
  // killed=true swaps the mark to the kill styling (see CSS) — same pop
  // animation mechanism (remove class, force reflow, re-add), just an
  // extra class so a kill and a plain hit look and feel different instead
  // of the exact same "+" every time regardless of what actually happened.
  hitmark(killed) {
    const h = $('hitmark');
    h.classList.remove('pop', 'kill');
    void h.offsetWidth;
    h.classList.toggle('kill', !!killed);
    h.classList.add('pop');
  },
  damage() {
    const v = $('vignette');
    v.style.transition = 'none'; v.style.opacity = 1;
    requestAnimationFrame(() => { v.style.transition = 'opacity .7s'; v.style.opacity = 0; });
  },
  // bearing: radians, 0 = source straight ahead, computed by Game#_bearingTo.
  // Same instant-flash-then-fade pattern as damage() above — snap the
  // rotation and opacity in with transitions off, then re-enable the
  // transition next frame so the browser actually animates the fade
  // instead of jumping straight to the end state.
  damageDir(bearing) {
    const el = $('dmgDir');
    el.style.transform = `rotate(${bearing}rad)`;
    const c = el.firstElementChild;
    c.style.transition = 'none'; c.style.opacity = 1;
    requestAnimationFrame(() => { c.style.transition = 'opacity 1.5s linear'; c.style.opacity = 0; });
  },
  // tier: 'double' | 'triple' | 'multi'. Owns BOTH the sound and the text —
  // the fanfare replaces the ordinary kill chime entirely rather than
  // layering under it (see sfx.multiKill's own comment for why), so
  // whichever call site triggers this is the one place that decides "this
  // kill gets the escalated treatment instead of the plain one," not two
  // separate decisions that could disagree with each other.
  killCallout(tier) {
    const spec = MULTIKILL[tier];
    if (!spec) return;
    sfx.multiKill(spec.notes);
    const el = $('killcallout');
    el.textContent = spec.text;
    el.style.color = spec.color;
    el.classList.remove('pop');
    void el.offsetWidth; // force reflow so a chain (double -> triple -> multi) restarts the pop each time
    el.classList.add('pop');
  },
  respawn(t) {
    $('respawn').style.opacity = t > 0 ? 1 : 0;
    if (t > 0) $('respawn').textContent = `TEAM WAVE IN ${Math.ceil(t)}…`;
    $('classPick').style.opacity = t > 0 ? 1 : 0;
    $('spawnPick').style.opacity = t > 0 ? 1 : 0;
    if (!(t > 0)) this.deathRecap(null);
  },
  spawnPreference(pref = 'front') {
    const el = $('spawnPick');
    if (!el) return;
    el.innerHTML = `<span class="${pref === 'front' ? 'picked' : ''}">F FRONT</span>`
      + ` · <span class="${pref === 'base' ? 'picked' : ''}">B BASE</span>`;
  },
  deathRecap(recap) {
    const el = $('deathRecap');
    if (!el) return;
    const copy = deathRecapCopy(recap);
    el.className = copy ? `on${copy.team ? ` ${copy.team}` : ''}` : '';
    if (!copy) return;
    $('deathRecapLabel').textContent = copy.label;
    $('deathRecapTitle').textContent = copy.title;
    $('deathRecapDetail').textContent = copy.detail;
  },
  // Highlights which class is currently PENDING for the next life — called
  // once on death (to show the persisted/previous choice) and again each
  // time the player changes it.
  classPick(idx) {
    for (const el of getDom()?.querySelectorAll('#classPick .opt, #endClassOpts .opt, #startClassOpts .opt') ?? [])
      el.classList.toggle('picked', Number(el.dataset.cls) === idx);
  },
  // Chat line. The text goes in as a TEXT NODE — never HTML — so a message
  // can't inject markup.
  chatMsg(m) {
    const log = $('chatlog');
    $('chat').classList.add('haslog');
    const div = getDom().createElement('div');
    if (m.scope === 'team') {
    const tag = getDom().createElement('span');
      tag.className = 'tm';
      tag.textContent = 'TEAM';
      div.append(tag);
    }
    const n = getDom().createElement('span');
    n.className = 'cn';
    n.style.color = teamCss(m.team);
    n.textContent = m.name;
    div.append(n, getDom().createTextNode(m.text));
    log.append(div);
    while (log.children.length > 8) log.firstChild.remove();
    clearTimeout(div._ft); clearTimeout(div._rt);
    div._ft = setTimeout(() => div.classList.add('faded'), 11000);
    div._rt = setTimeout(() => div.remove(), 12000);
  },

  // ---------------- minimap ----------------
  // Chunky top-down view: the world is sampled into MAP_G×MAP_G cells of
  // 4×4 blocks apiece, the tallest column winning so bridges and towers
  // still show. One offscreen pixel per cell, then a nearest-neighbor
  // upscale to the display canvas — crisp voxel squares, no bilinear blur.
  // Brightness bands by height give a terraced look, and a cell standing
  // well above its west/north neighbor catches light while a sunken one
  // sits in shade, so cliffs and craters read as steps. Edits dirty single
  // cells (world.onEdit); markers redraw every frame over the cached terrain.
  mapInit(world) {
    const G = (this._mapG = 64);
    this._mapStep = SX / G;
    const off = getDom().createElement('canvas');
    off.width = G; off.height = G;
    this._mapOff = off;
    this._mapCtx = off.getContext('2d');
    this._mapImg = this._mapCtx.createImageData(G, G);
    this._mapDirty = new Set();
    this._mapH = new Int16Array(G * G); // tallest surface per cell
    for (let gz = 0; gz < G; gz++)       // row-major: west/north neighbors
      for (let gx = 0; gx < G; gx++)     // are shaded before they are read
        this._mapCell(world, gx, gz);
    this._mapCtx.putImageData(this._mapImg, 0, 0);
  },
  _cellTop(world, gx, gz) {
    const STEP = this._mapStep;
    let top = -1, block = 0;
    for (let dz = 0; dz < STEP; dz++)
      for (let dx = 0; dx < STEP; dx++) {
        const x = gx * STEP + dx, z = gz * STEP + dz;
        const y = world.surface(x, z);
        if (y > top) { top = y; block = world.get(x, y, z); }
      }
    this._mapH[gz * this._mapG + gx] = top;
    return { top, block };
  },
  _mapCell(world, gx, gz) {
    const G = this._mapG;
    const { top, block } = this._cellTop(world, gx, gz);
    const i = (gz * G + gx) * 4;
    const d = this._mapImg.data;
    let r, g, b;
    if (top < SEA) {
      const band = Math.min(3, (SEA - top) >> 1); // discrete depth steps
      const f = 1 - 0.14 * band;
      r = 47 * f; g = 111 * f; b = 184 * f;
    } else {
      const c = PALETTE[block]?.color ?? 0x8a8d94;
      let br = 0.60 + 0.045 * Math.floor(top / 3); // terraced height bands
      const west = gx > 0 ? this._mapH[gz * G + gx - 1] : top;
      const north = gz > 0 ? this._mapH[(gz - 1) * G + gx] : top;
      if (top - Math.min(west, north) >= 3) br += 0.10; // sunlit ledge
      if (Math.max(west, north) - top >= 3) br -= 0.12; // shaded foot
      r = Math.min(255, ((c >> 16) & 255) * br);
      g = Math.min(255, ((c >> 8) & 255) * br);
      b = Math.min(255, (c & 255) * br);
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  },
  mapDirty(x, z) {
    if (!this._mapDirty) return;
    const G = this._mapG, STEP = this._mapStep;
    const gx = (x / STEP) | 0, gz = (z / STEP) | 0;
    // The east/south neighbors shade off this cell's height too.
    for (let dz = 0; dz <= 1; dz++)
      for (let dx = 0; dx <= 1; dx++) {
        const nx = gx + dx, nz = gz + dz;
        if (nx < G && nz < G) this._mapDirty.add(nz * G + nx);
      }
  },
  minimap(g) {
    const cv = $('minimap');
    if (!cv || !this._mapOff) return;
    // Flush edited cells in one putImageData over their bounding box.
    if (this._mapDirty.size) {
      const G = this._mapG;
      let x0 = G, z0 = G, x1 = -1, z1 = -1;
      for (const k of this._mapDirty) {
        const gx = k % G, gz = (k - gx) / G;
        this._mapCell(g.world, gx, gz);
        if (gx < x0) x0 = gx; if (gx > x1) x1 = gx;
        if (gz < z0) z0 = gz; if (gz > z1) z1 = gz;
      }
      this._mapCtx.putImageData(this._mapImg, 0, 0, x0, z0, x1 - x0 + 1, z1 - z0 + 1);
      this._mapDirty.clear();
    }
    const ctx = cv.getContext('2d');
    const W = cv.width, s = W / SX;
    ctx.imageSmoothingEnabled = false; // crisp voxel squares
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(this._mapOff, 0, 0, this._mapG, this._mapG, 0, 0, W, W);
    // Base plateaus: team-colored diamonds, always visible — your bearings.
    // Read from BASE rather than the flags so deathmatch (flagless) maps too.
    for (const team of ['green', 'blue']) {
      const st = BASE[team].flag;
      const cx = (st.x + 0.5) * s, cz = (st.z + 0.5) * s;
      ctx.fillStyle = teamCss(team);
      ctx.beginPath();
      ctx.moveTo(cx, cz - 4); ctx.lineTo(cx + 4, cz);
      ctx.lineTo(cx, cz + 4); ctx.lineTo(cx - 4, cz);
      ctx.fill();
    }
    // Flags: solid dot at home, hollow when dropped, pulsing ring when carried.
    // (Deathmatch has no flags — bases and the wedge carry the map.)
    if (g.flags) for (const team of ['green', 'blue']) {
      const f = g.flags[team];
      const cx = f.pos.x * s, cz = f.pos.z * s;
      const col = teamCss(team);
      if (f.state === 'carried') {
        const r = 6 + 1.6 * Math.sin(g.time * 6);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, cz, r, 0, 7); ctx.stroke();
      }
      ctx.lineWidth = 1.2;
      if (f.state === 'dropped') {
        ctx.strokeStyle = col;
        ctx.beginPath(); ctx.arc(cx, cz, 3, 0, 7); ctx.stroke();
      } else {
        ctx.fillStyle = col;
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.beginPath(); ctx.arc(cx, cz, 3, 0, 7); ctx.fill(); ctx.stroke();
      }
    }
    // King of the hill: the point as a ground ring, tinted by the owner,
    // pulsing while contested. It reads through craters because it's drawn
    // over the terrain, not into it.
    if (g.hill) {
      const h = g.hill;
      const cx = h.pos.x * s, cz = h.pos.z * s;
      const col = h.owner ? teamCss(h.owner) : '#e8ecf2';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cz, h.r * s, 0, 7); ctx.stroke();
      if (h.contested) {
        const r = h.r * s + 2 + 1.6 * Math.sin(g.time * 6);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, cz, r, 0, 7); ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(cx, cz, 2.4, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
      // During the relocation warning, preview the next point so squads can
      // rotate early instead of learning the destination after the jump.
      if (!g.overtime && h.rotateIn <= HILL_MOVE_WARNING && h.spots?.length > 1) {
        const next = h.spots[nextHillIndex(h.index, h.spots.length)];
        ctx.strokeStyle = 'rgba(255,217,122,.9)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc((next.x + 0.5) * s, (next.z + 0.5) * s,
          (next.r ?? h.r) * s, 0, 7); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Tactical marks are team-only and expire quickly; a pulsing diamond
    // gives them enough map presence without obscuring terrain or enemies.
    for (const mark of g.teamPings ?? []) {
      if (mark.team !== g.player.team) continue;
      const cx = mark.pos.x * s, cz = mark.pos.z * s;
      const r = 3.5 + Math.sin(g.time * 8) * 0.8;
      ctx.save(); ctx.translate(cx, cz);
      ctx.strokeStyle = '#ffd97a'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, 0);
      ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath(); ctx.stroke();
      ctx.restore();
    }
    // You: a white wedge pointed where you look. lookDir's ground projection
    // is (cos yaw, -sin yaw) in world (x,z), and canvas z runs downward.
    const p = g.player;
    ctx.save();
    ctx.translate(p.body.pos.x * s, p.body.pos.z * s);
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(8,12,20,.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-4, 3.6); ctx.lineTo(-4, -3.6);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  },
  };
}
