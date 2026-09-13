// next-battle.js — pure post-match choice generation and tally resolution.
import { contentAvailable } from './content-gating.js';

export const NEXT_BATTLE_CHOICES = 3;

const validMode = mode => mode === 'tdm' || mode === 'koth' || mode === 'ctf';

function hash(seed, value) {
  let n = (Number.isFinite(seed) ? seed : 0) ^ (value * 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

function candidatesFor({ maps, publicRoom = false, privateContent = true }) {
  return (maps ?? []).flatMap((map, mapIndex) => {
    if (!map || !Number.isInteger(mapIndex)) return [];
    return (map.modes ?? []).filter(validMode)
      .filter(mode => contentAvailable(mode, mapIndex, {
        publicOnly: publicRoom,
        privateContent,
      }))
      .map(mode => ({ mode, map: mapIndex, name: map.name, key: map.key }));
  });
}

export function nextBattleChoices({ maps, mode, mapIndex = 0, publicRoom = false,
  privateContent = true, seed = 0 } = {}) {
  const all = candidatesFor({ maps, publicRoom, privateContent })
    .filter(choice => !(choice.mode === mode && choice.map === mapIndex))
    .sort((a, b) => hash(seed, a.map * 7 + a.mode.length)
      - hash(seed, b.map * 7 + b.mode.length) || a.map - b.map || a.mode.localeCompare(b.mode));
  if (!all.length) return [];
  const result = [];
  const add = choice => {
    if (choice && result.length < NEXT_BATTLE_CHOICES
        && !result.some(row => row.mode === choice.mode && row.map === choice.map)) result.push(choice);
  };
  // Public quick play must visibly offer a mode change every round.
  if (publicRoom) {
    add(all.find(choice => choice.mode === 'tdm'));
    add(all.find(choice => choice.mode === 'koth'));
  }
  for (const choice of all) add(choice);
  return result.slice(0, NEXT_BATTLE_CHOICES);
}

export function resolveBattleVote(choices, votes, eligible = []) {
  const valid = (choices ?? []).slice(0, NEXT_BATTLE_CHOICES);
  if (!valid.length) return null;
  const counts = Array.from({ length: valid.length }, () => 0);
  const allowed = new Set(eligible);
  for (const vote of votes ?? []) {
    if (!vote || !allowed.has(vote.actor) || !Number.isInteger(vote.choice)
        || vote.choice < 0 || vote.choice >= valid.length) continue;
    counts[vote.choice]++;
  }
  let winner = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[winner]) winner = i;
  return { index: winner, choice: valid[winner], counts };
}

export function validBattleChoice(choice, maps, { publicRoom = false, privateContent = true } = {}) {
  if (!choice || !validMode(choice.mode) || !Number.isInteger(choice.map)
      || !maps?.[choice.map] || !maps[choice.map].modes.includes(choice.mode)) return false;
  return contentAvailable(choice.mode, choice.map, {
    publicOnly: publicRoom,
    privateContent,
  });
}

export function validBattleChoices(choices, maps, options = {}) {
  if (!Array.isArray(choices) || choices.length !== NEXT_BATTLE_CHOICES
      || !choices.every(choice => validBattleChoice(choice, maps, options))
      || new Set(choices.map(choice => `${choice.mode}:${choice.map}`)).size
        !== NEXT_BATTLE_CHOICES) return false;
  return !options.publicRoom
    || new Set(choices.map(choice => choice.mode)).has('tdm')
      && new Set(choices.map(choice => choice.mode)).has('koth');
}
