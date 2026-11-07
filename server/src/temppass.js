// Temporary passwords people have to read and type (punch list 4a): two capitalized words and 4 digits, e.g.
// "HarvestRaven4827". No symbols, and no look-alike characters: the words avoid l, i, o (and capital I, O, L),
// and the digits avoid 0 and 1. Always temporary: the person must replace it at first sign-in.
import crypto from 'node:crypto';

export const WORDS = 'Amber Aspen Badger Banana Barn Basket Beach Berry Breaker Breeze Bucket Buffet Butter Cactus Camera Candy Canvas Carpet Cascade Cashew Cedar Charter Cherry Chess Crane Crater Cypress Dance Desert Dune Ember Farm Feather Fern Ferry Garage Garden Garnet Grape Gust Hammer Hamper Harvest Hunter Jacket Jasper Kayak Magnet Market Matter Nectar Nugget Number Panda Paper Parade Pasture Peach Pepper Quartz Radar Ranch Ranger Raven Reef Remedy Rescue Sand Saturn Scarab Sketch Spark Spruce Squash Star Stream Summer Sunset Swan Tavern Tempest Thread Thrush Thunder Tundra Verse Wander Water Weaver Wren Yacht Zebra Zephyr'.split(' ');
const DIGITS = '23456789';
export function tempPassword() {
  const w1 = WORDS[crypto.randomInt(WORDS.length)];
  let w2 = WORDS[crypto.randomInt(WORDS.length)];
  while (w2 === w1) w2 = WORDS[crypto.randomInt(WORDS.length)];
  let n = '';
  for (let i = 0; i < 4; i++) n += DIGITS[crypto.randomInt(DIGITS.length)];
  return `${w1}${w2}${n}`;
}
export const TEMP_PASSWORD_RE = /^[A-Z][a-z]+[A-Z][a-z]+[2-9]{4}$/;
