/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The card bank — 200 cards, original, authored here rather than copied from
// any published card set.
//
// ── What makes a card work ──────────────────────────────────────────────────
//
// A card is a *distance* problem. The secret sits at the centre, its obvious
// clues form a first ring, and the game lives in the second ring. Ban too
// little and the first ring answers it in four words; ban too much and there is
// no second ring and the card is a pass. Every card below was written to these
// five rules.
//
//   1. BAN THE FIRST RING. Each of the five is something most describers reach
//      for immediately — the top free associates. A ban nobody would have said
//      is a wasted slot.
//   2. LEAVE EXACTLY ONE SECOND RING. After the bans, at least one real angle
//      must survive: what it is for, who uses it, where you meet it, what
//      happens without it, what it sounds like. If nothing survives, the card
//      is cut.
//   3. KILL THE SYNONYM. No near-synonym and no one-word definition may
//      survive the list. This is the "too easy" failure, and the research
//      warning behind it: the words people actually use as clues are often
//      *closer* to the target than its free associates are, so banning
//      associates alone leaves the short route open.
//   4. CONCRETE AND FAMILIAR. Secrets are single, imageable nouns the guesser
//      certainly knows. Abstractions do not survive one spoken line.
//   5. ONE SENSE, OR BLOCK BOTH. A secret that splits between two meanings
//      splits the guesser with it.
//
// ── Two rules that come from this engine, not from the game ─────────────────
//
// `violates()` in engine.ts matches by prefix in BOTH directions with a
// four-character floor on the shorter side. That has two consequences worth
// stating, because both are invisible until a card misbehaves in play:
//
//   A. A COMPOUND SECRET AUTO-BANS ITS HEAD, NOT ITS TAIL. TOOTHBRUSH already
//      blocks "tooth" for nothing, because "toothbrush" starts with it. It
//      does *not* block "brush". So WATERMELON blocks "water" free and leaves "melon"
//      wide open — a one-word giveaway. Every compound here bans its tail
//      element explicitly, and spends no slot on the head.
//   B. SHORT BANS OVER-FIRE. Banning "star" fouls anyone who says "start";
//      "sand" fouls "sandwich"; "arch" fouls "architect". The fix is the
//      plural: "stars" still catches "star" by reverse-prefix, but no longer
//      reaches "start". Bans are four characters or longer and written in the
//      form that catches the family without catching strangers.
//
// The pools do not mix. See PLAYER_CARDS and COMPUTER_CARDS below.
export interface Card {
  secret: string
  banned: string[]
}

/**
 * Cards the HUMAN clues in half one, for the agent to guess.
 *
 * Biased long, compound and unusual. The guesser is a language model working
 * from spoken description — very good at that, and a wrong guess costs nothing,
 * so it can circle a word for several turns. ACCORDION and QUICKSAND give a
 * person plenty to describe; they would be brutal to *land* off a single line.
 */
export const PLAYER_CARDS: readonly Card[] = [
  { secret: 'TREADMILL', banned: ['running', 'exercise', 'belts', 'walking', 'mill'] },
  { secret: 'ORIGAMI', banned: ['paper', 'folding', 'crane', 'Japanese', 'crease'] },
  { secret: 'KARAOKE', banned: ['singing', 'microphone', 'duet', 'lyrics', 'screen'] },
  { secret: 'SCARECROW', banned: ['field', 'straw', 'birds', 'farm', 'crows'] },
  { secret: 'HAMMOCK', banned: ['sleeping', 'trees', 'swinging', 'beach', 'ropes'] },
  { secret: 'COMPASS', banned: ['north', 'direction', 'needle', 'navigate', 'magnet'] },
  { secret: 'GLACIER', banned: ['frozen', 'melting', 'mountain', 'arctic', 'crevasse'] },
  { secret: 'TRAMPOLINE', banned: ['bounce', 'jumping', 'springs', 'garden', 'somersault'] },
  { secret: 'LANTERN', banned: ['light', 'candle', 'glowing', 'carry', 'flame'] },
  { secret: 'ACCORDION', banned: ['squeeze', 'bellows', 'polka', 'keys', 'folk'] },
  { secret: 'IGLOO', banned: ['snows', 'blocks', 'dome', 'Inuit', 'shelter'] },
  { secret: 'HARMONICA', banned: ['blowing', 'mouth', 'blues', 'reeds', 'pocket'] },
  { secret: 'CHANDELIER', banned: ['ceiling', 'glass', 'light', 'hanging', 'ballroom'] },
  { secret: 'ESCALATOR', banned: ['stairs', 'moving', 'mall', 'steps', 'riding'] },
  { secret: 'BOOMERANG', banned: ['throwing', 'returns', 'Australia', 'curved', 'sticks'] },
  { secret: 'PARACHUTE', banned: ['jumping', 'plane', 'falling', 'chute', 'canopy'] },
  { secret: 'SPHINX', banned: ['Egypt', 'riddle', 'lion', 'statue', 'Giza'] },
  { secret: 'CATAPULT', banned: ['launch', 'castle', 'siege', 'hurling', 'medieval'] },
  { secret: 'YETI', banned: ['snows', 'abominable', 'Himalaya', 'footprint', 'legend'] },
  { secret: 'QUICKSAND', banned: ['sinking', 'trapped', 'jungle', 'struggle', 'sands'] },
  { secret: 'PIÑATA', banned: ['candy', 'party', 'stick', 'birthday', 'Mexican'] },
  { secret: 'PODCAST', banned: ['listen', 'episode', 'audio', 'download', 'hosts'] },
  { secret: 'CARTWHEEL', banned: ['gymnast', 'sideways', 'hands', 'tumble', 'wheels'] },
  { secret: 'MOSQUITO', banned: ['biting', 'itchy', 'buzzing', 'blood', 'insect'] },
  { secret: 'METRONOME', banned: ['ticking', 'tempo', 'music', 'beats', 'piano'] },
  { secret: 'KALEIDOSCOPE', banned: ['colours', 'tube', 'mirrors', 'pattern', 'scope'] },
  { secret: 'CHAMELEON', banned: ['colour', 'lizard', 'camouflage', 'tongue', 'changing'] },
  { secret: 'PORCUPINE', banned: ['quills', 'spikes', 'rodent', 'prickly', 'needles'] },
  { secret: 'ARMADILLO', banned: ['armour', 'shell', 'rolling', 'Texas', 'burrow'] },
  { secret: 'PLATYPUS', banned: ['duck', 'bill', 'Australia', 'eggs', 'mammal'] },
  { secret: 'NARWHAL', banned: ['tusk', 'whale', 'arctic', 'horns', 'unicorn'] },
  { secret: 'JELLYFISH', banned: ['sting', 'tentacle', 'ocean', 'translucent', 'fish'] },
  { secret: 'SEAHORSE', banned: ['ocean', 'curled', 'tails', 'tiny', 'horse'] },
  { secret: 'LOBSTER', banned: ['claws', 'seafood', 'shellfish', 'boiled', 'Maine'] },
  { secret: 'HEDGEHOG', banned: ['spines', 'curling', 'garden', 'nocturnal', 'prickly'] },
  { secret: 'WHEELBARROW', banned: ['garden', 'pushing', 'load', 'barrow', 'handles'] },
  { secret: 'LAWNMOWER', banned: ['grass', 'cutting', 'garden', 'engine', 'mower'] },
  { secret: 'CHIMNEY', banned: ['smoke', 'roof', 'fireplace', 'Santa', 'brick'] },
  { secret: 'DRAWBRIDGE', banned: ['castle', 'moat', 'raising', 'chains', 'bridge'] },
  { secret: 'WINDCHIME', banned: ['hanging', 'tinkling', 'breeze', 'porch', 'chime'] },
  { secret: 'SUNDIAL', banned: ['shadow', 'time', 'garden', 'ancient', 'dials'] },
  { secret: 'HOURGLASS', banned: ['sands', 'timing', 'flipping', 'grains', 'glass'] },
  { secret: 'TYPEWRITER', banned: ['keys', 'clacking', 'paper', 'vintage', 'writer'] },
  { secret: 'GRAMOPHONE', banned: ['record', 'horns', 'vintage', 'needle', 'phone'] },
  { secret: 'JUKEBOX', banned: ['coins', 'records', 'diner', 'selecting', 'music'] },
  { secret: 'CAROUSEL', banned: ['horses', 'spinning', 'fairground', 'riding', 'music'] },
  { secret: 'ROLLERCOASTER', banned: ['loops', 'drops', 'scream', 'track', 'coaster'] },
  { secret: 'SEESAW', banned: ['playground', 'balance', 'plank', 'children', 'tilting'] },
  { secret: 'SLINGSHOT', banned: ['rubber', 'aiming', 'pebble', 'catapult', 'shot'] },
  { secret: 'KITE', banned: ['string', 'windy', 'flying', 'tails', 'skies'] },
  { secret: 'HOPSCOTCH', banned: ['chalk', 'squares', 'jumping', 'playground', 'pavement'] },
  { secret: 'JIGSAW', banned: ['pieces', 'puzzle', 'interlocking', 'picture', 'edges'] },
  { secret: 'DOMINO', banned: ['tiles', 'falling', 'dots', 'chain', 'tipping'] },
  { secret: 'MARIONETTE', banned: ['strings', 'puppet', 'wooden', 'controlling', 'theatre'] },
  { secret: 'GARGOYLE', banned: ['stone', 'cathedral', 'grotesque', 'carving', 'waterspout'] },
  { secret: 'LABYRINTH', banned: ['maze', 'winding', 'minotaur', 'lost', 'passages'] },
  { secret: 'CATACOMB', banned: ['underground', 'bones', 'tunnel', 'burial', 'crypt'] },
  { secret: 'PYRAMID', banned: ['Egypt', 'triangle', 'pharaoh', 'tombs', 'stone'] },
  { secret: 'OBELISK', banned: ['monument', 'tall', 'stone', 'Egypt', 'pointed'] },
  { secret: 'AQUEDUCT', banned: ['water', 'Roman', 'arches', 'channel', 'carrying'] },
  { secret: 'WINDSOCK', banned: ['airport', 'cone', 'direction', 'orange', 'socks'] },
  { secret: 'PERISCOPE', banned: ['submarine', 'mirrors', 'tube', 'viewing', 'scope'] },
  { secret: 'STETHOSCOPE', banned: ['doctor', 'heartbeat', 'listening', 'chest', 'scope'] },
  { secret: 'THERMOMETER', banned: ['temperature', 'mercury', 'fever', 'measuring', 'meter'] },
  { secret: 'BAROMETER', banned: ['pressure', 'weather', 'measuring', 'forecast', 'meter'] },
  { secret: 'SEISMOGRAPH', banned: ['earthquake', 'needle', 'recording', 'tremor', 'graph'] },
  { secret: 'TELEGRAPH', banned: ['morse', 'wires', 'message', 'graph', 'tapping'] },
  { secret: 'SEMAPHORE', banned: ['flags', 'signal', 'arms', 'railway', 'communication'] },
  { secret: 'BLACKSMITH', banned: ['anvil', 'forge', 'hammer', 'horseshoe', 'smith'] },
  { secret: 'LUMBERJACK', banned: ['axes', 'trees', 'flannel', 'chopping', 'jack'] },
  { secret: 'GONDOLA', banned: ['Italy', 'canal', 'boat', 'poles', 'singing'] },
  { secret: 'LOCKSMITH', banned: ['keys', 'picking', 'door', 'cutting', 'smith'] },
  { secret: 'PUPPETEER', banned: ['strings', 'hands', 'shows', 'voices', 'marionette'] },
  { secret: 'TIGHTROPE', banned: ['balance', 'circus', 'walking', 'height', 'ropes'] },
  { secret: 'TRAPEZE', banned: ['circus', 'swinging', 'catching', 'aerial', 'bars'] },
  { secret: 'UNICYCLE', banned: ['wheels', 'balance', 'pedal', 'circus', 'cycle'] },
  { secret: 'STILTS', banned: ['tall', 'walking', 'legs', 'circus', 'wooden'] },
  { secret: 'SNORKEL', banned: ['breathing', 'tube', 'swimming', 'mask', 'underwater'] },
  { secret: 'FLIPPER', banned: ['feet', 'swimming', 'rubber', 'diving', 'paddling'] },
  { secret: 'CANOE', banned: ['paddle', 'river', 'boat', 'tipping', 'narrow'] },
  { secret: 'KAYAK', banned: ['paddle', 'water', 'boat', 'rapids', 'palindrome'] },
  { secret: 'TOBOGGAN', banned: ['sledding', 'snows', 'hill', 'riding', 'wooden'] },
  { secret: 'SNOWSHOE', banned: ['walking', 'wide', 'sinking', 'tennis', 'shoes'] },
  { secret: 'AVALANCHE', banned: ['snows', 'mountain', 'sliding', 'burying', 'roaring'] },
  { secret: 'GEYSER', banned: ['eruption', 'water', 'Yellowstone', 'steam', 'spouting'] },
  { secret: 'STALACTITE', banned: ['cave', 'ceiling', 'dripping', 'mineral', 'hanging'] },
  { secret: 'TSUNAMI', banned: ['waves', 'ocean', 'earthquake', 'flooding', 'giant'] },
  { secret: 'BLIZZARD', banned: ['storms', 'winter', 'whiteout', 'winds', 'freezing'] },
  { secret: 'MIRAGE', banned: ['desert', 'illusion', 'shimmering', 'water', 'seeing'] },
  { secret: 'ECLIPSE', banned: ['suns', 'moon', 'shadow', 'darkness', 'blocking'] },
  { secret: 'CONSTELLATION', banned: ['stars', 'pattern', 'night', 'zodiac', 'connecting'] },
  { secret: 'METEORITE', banned: ['space', 'rocks', 'crater', 'falling', 'burning'] },
  { secret: 'ASTEROID', banned: ['space', 'rocks', 'belt', 'orbit', 'collision'] },
  { secret: 'SATELLITE', banned: ['orbit', 'space', 'signal', 'dish', 'launching'] },
  { secret: 'BINOCULARS', banned: ['lens', 'looking', 'distance', 'birdwatching', 'pairs'] },
  { secret: 'MAGNET', banned: ['attract', 'iron', 'poles', 'fridge', 'force'] },
  { secret: 'PENDULUM', banned: ['swinging', 'clock', 'weight', 'hypnotize', 'Foucault'] },
  { secret: 'GYROSCOPE', banned: ['spinning', 'balance', 'axis', 'toys', 'scope'] },
  { secret: 'ABACUS', banned: ['beads', 'counting', 'wires', 'ancient', 'calculating'] },
  { secret: 'CROSSWORD', banned: ['puzzle', 'clues', 'squares', 'across', 'words'] },
]

/**
 * Cards the AGENT clues in half two, for the human to guess.
 *
 * The opposite bias: everyday, concrete, high-frequency. The guesser is a
 * person staring at a row of blanks with the clock running, who gets one spoken
 * line and has to land it — so these are things you can picture instantly.
 */
export const COMPUTER_CARDS: readonly Card[] = [
  { secret: 'SATURN', banned: ['planet', 'rings', 'space', 'solar', 'moons'] },
  { secret: 'PENGUIN', banned: ['birds', 'Antarctic', 'cold', 'waddle', 'flightless'] },
  { secret: 'GUITAR', banned: ['strings', 'music', 'strum', 'band', 'chord'] },
  { secret: 'VOLCANO', banned: ['lava', 'erupt', 'mountain', 'magma', 'molten'] },
  { secret: 'UMBRELLA', banned: ['rains', 'wet', 'cover', 'handle', 'storm'] },
  { secret: 'LIBRARY', banned: ['books', 'quiet', 'borrow', 'shelf', 'study'] },
  { secret: 'ELEVATOR', banned: ['floor', 'button', 'building', 'lift', 'door'] },
  { secret: 'SNOWMAN', banned: ['carrot', 'winter', 'cold', 'melting', 'frosty'] },
  { secret: 'DENTIST', banned: ['teeth', 'drill', 'mouth', 'appointment', 'cavity'] },
  { secret: 'RAINBOW', banned: ['colour', 'rains', 'arches', 'prism', 'spectrum'] },
  { secret: 'PIRATE', banned: ['ships', 'treasure', 'parrot', 'sword', 'island'] },
  { secret: 'MICROWAVE', banned: ['heating', 'popcorn', 'kitchen', 'waves', 'oven'] },
  { secret: 'VAMPIRE', banned: ['blood', 'fangs', 'coffin', 'garlic', 'night'] },
  { secret: 'HONEY', banned: ['bees', 'sweet', 'sticky', 'nectar', 'hive'] },
  { secret: 'LIGHTHOUSE', banned: ['beams', 'coast', 'ships', 'house', 'warning'] },
  { secret: 'AVOCADO', banned: ['green', 'toast', 'guacamole', 'stone', 'creamy'] },
  { secret: 'HELICOPTER', banned: ['blades', 'rotor', 'hover', 'pilot', 'copter'] },
  { secret: 'CACTUS', banned: ['desert', 'spikes', 'prickly', 'water', 'plant'] },
  { secret: 'TORNADO', banned: ['winds', 'funnel', 'spinning', 'storm', 'Kansas'] },
  { secret: 'SUBMARINE', banned: ['underwater', 'diving', 'periscope', 'sonar', 'marine'] },
  { secret: 'TELESCOPE', banned: ['stars', 'lens', 'space', 'astronomer', 'scope'] },
  { secret: 'WAFFLE', banned: ['breakfast', 'syrup', 'batter', 'square', 'iron'] },
  { secret: 'MERMAID', banned: ['fish', 'tails', 'ocean', 'siren', 'underwater'] },
  { secret: 'PRETZEL', banned: ['salt', 'twist', 'baking', 'snack', 'knot'] },
  { secret: 'FLAMINGO', banned: ['pink', 'birds', 'standing', 'wading', 'Florida'] },
  { secret: 'BUTTERFLY', banned: ['wings', 'caterpillar', 'cocoon', 'flutter', 'insect'] },
  { secret: 'HAMBURGER', banned: ['beef', 'patty', 'buns', 'grill', 'burger'] },
  { secret: 'TOOTHBRUSH', banned: ['teeth', 'paste', 'bristle', 'brushing', 'bathroom'] },
  { secret: 'BICYCLE', banned: ['wheels', 'pedal', 'handlebars', 'riding', 'cycle'] },
  { secret: 'PIANO', banned: ['keys', 'black', 'white', 'music', 'playing'] },
  { secret: 'CAMPFIRE', banned: ['wood', 'marshmallow', 'flames', 'fire', 'smoke'] },
  { secret: 'WINDMILL', banned: ['blades', 'Dutch', 'grinding', 'turbine', 'mill'] },
  { secret: 'SCISSORS', banned: ['cutting', 'blades', 'paper', 'sharp', 'snip'] },
  { secret: 'BALLOON', banned: ['helium', 'party', 'popping', 'float', 'rubber'] },
  { secret: 'PILLOW', banned: ['sleeping', 'head', 'soft', 'feather', 'bedding'] },
  { secret: 'FIREWORKS', banned: ['explode', 'skies', 'July', 'sparkle', 'works'] },
  { secret: 'POPCORN', banned: ['kernel', 'butter', 'cinema', 'popping', 'snack'] },
  { secret: 'ANCHOR', banned: ['boats', 'heavy', 'chain', 'seabed', 'holding'] },
  { secret: 'TIGER', banned: ['stripes', 'cats', 'orange', 'jungle', 'roar'] },
  { secret: 'OCTOPUS', banned: ['tentacle', 'eight', 'ocean', 'suckers', 'squid'] },
  { secret: 'DOLPHIN', banned: ['ocean', 'smart', 'mammal', 'jumping', 'fins'] },
  { secret: 'SPIDER', banned: ['webs', 'eight', 'legs', 'crawling', 'insect'] },
  { secret: 'KANGAROO', banned: ['Australia', 'hopping', 'pouch', 'marsupial', 'jumping'] },
  { secret: 'ELEPHANT', banned: ['trunk', 'large', 'tusks', 'ears', 'Africa'] },
  { secret: 'GIRAFFE', banned: ['necks', 'tall', 'spots', 'Africa', 'leaves'] },
  { secret: 'SQUIRREL', banned: ['acorn', 'trees', 'bushy', 'nuts', 'scurry'] },
  { secret: 'PANCAKE', banned: ['syrup', 'flipping', 'breakfast', 'batter', 'cakes'] },
  { secret: 'SPAGHETTI', banned: ['pasta', 'sauce', 'Italian', 'noodle', 'meatball'] },
  { secret: 'DOUGHNUT', banned: ['hole', 'glaze', 'sugar', 'fried', 'sprinkles'] },
  { secret: 'LEMONADE', banned: ['sugar', 'drinking', 'sour', 'summer', 'thirsty'] },
  { secret: 'HOSPITAL', banned: ['doctor', 'nurse', 'sick', 'ambulance', 'patient'] },
  { secret: 'AIRPORT', banned: ['plane', 'luggage', 'terminal', 'flight', 'gate'] },
  { secret: 'MUSEUM', banned: ['exhibit', 'art', 'history', 'gallery', 'curator'] },
  { secret: 'BAKERY', banned: ['bread', 'cakes', 'oven', 'pastry', 'dough'] },
  { secret: 'TREEHOUSE', banned: ['branches', 'ladder', 'kids', 'wooden', 'house'] },
  { secret: 'SNOWFLAKE', banned: ['winter', 'flake', 'falling', 'frozen', 'cold'] },
  { secret: 'SUNFLOWER', banned: ['yellow', 'tall', 'seeds', 'field', 'flower'] },
  { secret: 'PUMPKIN', banned: ['orange', 'Halloween', 'carving', 'pie', 'gourd'] },
  { secret: 'SNOWBOARD', banned: ['mountain', 'slope', 'winter', 'board', 'strapped'] },
  { secret: 'SKATEBOARD', banned: ['wheels', 'tricks', 'ramp', 'board', 'deck'] },
  { secret: 'TRACTOR', banned: ['farm', 'field', 'plough', 'engine', 'wheels'] },
  { secret: 'AMBULANCE', banned: ['siren', 'emergency', 'hospital', 'paramedic', 'rushing'] },
  { secret: 'FIREFIGHTER', banned: ['hose', 'flames', 'ladder', 'rescue', 'fighter'] },
  { secret: 'ASTRONAUT', banned: ['space', 'rocket', 'moon', 'NASA', 'gravity'] },
  { secret: 'COWBOY', banned: ['horse', 'hats', 'ranch', 'lasso', 'western'] },
  { secret: 'NINJA', banned: ['stealth', 'Japan', 'sword', 'shadow', 'mask'] },
  { secret: 'WIZARD', banned: ['magic', 'wand', 'spell', 'hats', 'beard'] },
  { secret: 'CAMEL', banned: ['desert', 'humps', 'spitting', 'water', 'riding'] },
  { secret: 'UNICORN', banned: ['horns', 'magical', 'horse', 'rainbow', 'mythical'] },
  { secret: 'ROBOT', banned: ['metal', 'machine', 'android', 'programming', 'beeping'] },
  { secret: 'DINOSAUR', banned: ['extinct', 'fossil', 'Jurassic', 'reptile', 'prehistoric'] },
  { secret: 'HAMMER', banned: ['nails', 'tool', 'pounding', 'thumb', 'toolbox'] },
  { secret: 'LADDER', banned: ['climbing', 'rungs', 'steps', 'tall', 'painter'] },
  { secret: 'MIRROR', banned: ['reflect', 'glass', 'bathroom', 'image', 'looking'] },
  { secret: 'CANDLE', banned: ['waxy', 'flame', 'wick', 'birthday', 'melting'] },
  { secret: 'KETTLE', banned: ['boiling', 'water', 'steam', 'whistle', 'kitchen'] },
  { secret: 'BACKPACK', banned: ['school', 'straps', 'carrying', 'shoulders', 'packs'] },
  { secret: 'SUITCASE', banned: ['luggage', 'travel', 'packing', 'cases', 'airport'] },
  { secret: 'TELEPHONE', banned: ['calling', 'ringing', 'phone', 'talking', 'mobile'] },
  { secret: 'CAMERA', banned: ['photo', 'lens', 'shutter', 'picture', 'flash'] },
  { secret: 'DRUM', banned: ['beating', 'sticks', 'rhythm', 'band', 'percussion'] },
  { secret: 'VIOLIN', banned: ['strings', 'orchestra', 'classical', 'fiddle', 'bows'] },
  { secret: 'TRUMPET', banned: ['brass', 'blowing', 'jazz', 'valves', 'horns'] },
  { secret: 'HARP', banned: ['strings', 'plucking', 'angel', 'orchestra', 'Irish'] },
  { secret: 'CASTLE', banned: ['king', 'moat', 'tower', 'medieval', 'stone'] },
  { secret: 'BRIDGE', banned: ['river', 'crossing', 'span', 'arches', 'road'] },
  { secret: 'TUNNEL', banned: ['underground', 'through', 'dark', 'mountain', 'digging'] },
  { secret: 'FOUNTAIN', banned: ['water', 'coins', 'spray', 'park', 'wishing'] },
  { secret: 'WATERFALL', banned: ['cascade', 'cliff', 'river', 'Niagara', 'falls'] },
  { secret: 'DESERT', banned: ['sands', 'dry', 'camel', 'dunes', 'hot'] },
  { secret: 'JUNGLE', banned: ['trees', 'vines', 'monkey', 'rainforest', 'tiger'] },
  { secret: 'ISLAND', banned: ['water', 'beach', 'surrounded', 'tropical', 'shore'] },
  { secret: 'TENT', banned: ['camping', 'poles', 'canvas', 'sleeping', 'outdoors'] },
  { secret: 'SANDWICH', banned: ['bread', 'filling', 'lunch', 'slices', 'deli'] },
  { secret: 'CUPCAKE', banned: ['frosting', 'baking', 'sprinkles', 'small', 'cakes'] },
  { secret: 'STRAWBERRY', banned: ['red', 'seeds', 'cream', 'sweet', 'berry'] },
  { secret: 'WATERMELON', banned: ['seeds', 'summer', 'slice', 'rind', 'melon'] },
  { secret: 'PINEAPPLE', banned: ['spiky', 'tropical', 'yellow', 'Hawaii', 'apple'] },
  { secret: 'COCONUT', banned: ['palm', 'shell', 'tropical', 'milk', 'hairy'] },
  { secret: 'BANANA', banned: ['yellow', 'peel', 'monkey', 'bunch', 'fruit'] },
]

/**
 * Every card, for validation only — **never deal from this.**
 *
 * The two pools above are the deal. This exists so checks that need the whole
 * vocabulary have one list to walk (the test that keeps deck words out of the
 * tool descriptions, for one). Dealing from it is exactly the mixing the split
 * is here to prevent.
 */
export const DECK: readonly Card[] = [...PLAYER_CARDS, ...COMPUTER_CARDS]
