// Same format as server/src/temppass.js: two capitalized words + 4 digits, no symbols, no look-alike characters.
const WORDS = 'Amber Aspen Badger Banana Barn Basket Beach Berry Breaker Breeze Bucket Buffet Butter Cactus Camera Candy Canvas Carpet Cascade Cashew Cedar Charter Cherry Chess Crane Crater Cypress Dance Desert Dune Ember Farm Feather Fern Ferry Garage Garden Garnet Grape Gust Hammer Hamper Harvest Hunter Jacket Jasper Kayak Magnet Market Matter Nectar Nugget Number Panda Paper Parade Pasture Peach Pepper Quartz Radar Ranch Ranger Raven Reef Remedy Rescue Sand Saturn Scarab Sketch Spark Spruce Squash Star Stream Summer Sunset Swan Tavern Tempest Thread Thrush Thunder Tundra Verse Wander Water Weaver Wren Yacht Zebra Zephyr'.split(' ');
const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
export function tempPassword() {
  const w1 = WORDS[rnd(WORDS.length)];
  let w2 = WORDS[rnd(WORDS.length)];
  while (w2 === w1) w2 = WORDS[rnd(WORDS.length)];
  let n = '';
  for (let i = 0; i < 4; i++) n += '23456789'[rnd(8)];
  return `${w1}${w2}${n}`;
}
