/**
 * Pro playstyle reference set, and how a player is matched to one.
 *
 * WHY A TS FILE AND NOT A TABLE. This is reference data, not user data: it is
 * the same for every account, it changes when someone edits this file, and it
 * wants to be reviewed in a diff when it does. Putting it in Postgres would
 * add a migration and a seed to keep in sync with a code constant that still
 * has to exist for the types, and would buy nothing -- nobody edits a pro
 * profile at runtime.
 *
 * WHAT THE RATINGS MEAN, AND WHAT THEY DO NOT. Every number here is RELATIVE
 * EMPHASIS WITHIN THAT PLAYER'S OWN GAME, on the same 1-5 scale the analyst
 * uses for the user. A 2 does not mean a pro is bad at something -- Jorja
 * Johnson's 2 for dinking is still a professional dink. It means that is
 * comparatively not what she leans on. Rating pros on an absolute scale would
 * make every profile a row of fives and the whole feature would be noise.
 *
 * That is also why the match is computed on SHAPE rather than level: each
 * vector is centred on its own mean before comparison, so what survives is
 * "what does this player lean on relative to the rest of their own game",
 * which is the only thing a 3.5 and a world number one can share. A 3.5 whose
 * strongest area is hands and whose weakest is resets has Jorja Johnson's
 * shape, and saying so is true and useful. Comparing raw ratings would just
 * rank everyone by how good they are and hand every beginner the same answer.
 *
 * Sources for each profile are in `sources` -- they are real, and this file is
 * the wrong place to invent a player's tendencies. If a profile cannot be
 * sourced it does not belong here.
 */
import { SKILL_KEYS } from "./types";

/**
 * Where to go and watch this player actually play.
 *
 * A SEARCH, not a video id, and that is a deliberate trade. A specific clip is
 * better to watch and worse to maintain: the tour pulls videos, channels
 * reorganise, and a dead embed under "you play like Ben Johns" is worse than
 * no embed at all -- it makes the claim look unmaintained. A search for the
 * player's name never breaks and always lands on current footage.
 *
 * If curated clips are added later, this is the function that changes.
 */
export function watchUrl(pro: { name: string }): string {
  return `https://www.youtube.com/results?search_query=${
    encodeURIComponent(`${pro.name} pickleball highlights`)
  }`;
}

export interface ProPlaystyle {
  slug: string;
  name: string;
  format: "doubles" | "singles" | "both";
  /** The single thing that most defines how they play. */
  oneLine: string;
  /** Concrete, observable style -- things you could see watching a match. */
  signature: string;
  /** What a rec player can actually take from them. */
  watchFor: string;
  /** Relative emphasis, 1-5, keyed by Baseline's own skill keys. */
  ratings: Record<string, number>;
  /** How well-sourced the profile is. Shown, not hidden. */
  confidence: "high" | "medium" | "low";
  sources: string[];
}

export const PRO_PLAYSTYLES: ProPlaystyle[] = [
  {
    slug: "ben-johns",
    name: "Ben Johns",
    format: "both",
    oneLine:
      "Wins by out-constructing you — engineering rallies with spin, placement and patience until the ball you have to hit is one you can't attack.",
    signature:
      "Lives in the soft game: varies depth, height and angle on dinks, resets midcourt balls instead of counter-attacking, and uses the topspin backhand roll to keep balls low and unattackable. Moves in small balanced steps and rarely gets caught mid-transition, so he holds the kitchen line while opponents are still fighting to get there. Pace is a surprise, not a default.",
    watchFor:
      "Vary the height, depth and angle of your dinks instead of hitting the same safe crosscourt ball every time, and reset rather than counter when you're below net level.",
    ratings: r(5, 5, 4, 4, 5, 4, 5, 5, 3, 4, 5, 3, 5, 5, 5),
    confidence: "high",
    sources: [
      "https://pickleballunion.com/what-you-can-learn-from-ben-johns/",
      "https://pickleballus.org/about/pros/ben-johns/",
      "https://pickleball.com/learn/mastering-pickleballs-fourth-shot-with-ben-johns",
    ],
  },
  {
    slug: "federico-staksrud",
    name: "Federico Staksrud",
    format: "both",
    oneLine:
      "A tennis-built grinder who wins by never missing and never tiring — depth, legs and shot tolerance rather than one knockout weapon.",
    signature:
      "In singles the tennis background shows immediately: huge returns, heavy groundstrokes from behind the baseline, passing shots instead of net rushes. In doubles he plays the stabiliser — reliable third-shot drops, clean positioning, setting up an aggressive partner rather than finishing himself. Very low error rates in long rallies.",
    watchFor:
      "Hit a genuinely deep, aggressive return every single time — the highest-leverage habit in his game, and it needs no hand speed to copy.",
    ratings: r(4, 4, 3, 3, 4, 5, 4, 4, 4, 5, 4, 3, 4, 4, 5),
    confidence: "medium",
    sources: [
      "https://www.thedinkpickleball.com/how-fed-staksruds-right-side-gamble-paid-off-reinvented-a-winning-doubles-team/",
      "https://www.thedinkpickleball.com/federico-staksrud-your-new-world-1-mens-doubles-player/",
    ],
  },
  {
    slug: "jw-johnson",
    name: "JW Johnson",
    format: "doubles",
    oneLine:
      "The fastest hands in the sport — baits you into speeding up so he can win the firefight you started.",
    signature:
      "Stands at the kitchen with the paddle low and body language loose, which invites attacks, then counters with a compact two-handed backhand that hides direction until contact. Counters are aimed down at feet rather than swung hard, forcing the pop-up he finishes next ball. Thrives at fast tempo; his weaker mode is the passive grind.",
    watchFor: "Keep your counters compact and aim them at the opponent's feet instead of trying to hit through them.",
    ratings: r(3, 5, 5, 5, 3, 3, 3, 4, 2, 3, 3, 5, 4, 4, 4),
    confidence: "high",
    sources: [
      "https://pickleballunion.com/jw-johnsons-hand-speed/",
      "https://www.thedinkpickleball.com/episode-38-the-fastest-hands-in-the-game-w-jw-johnson/",
    ],
  },
  {
    slug: "christian-alshon",
    name: "Christian Alshon",
    format: "both",
    oneLine:
      "Raw offensive firepower delivered with a disguised, short-backswing forehand that arrives before you've read it.",
    signature:
      "The defining shot is the forehand attack: backswing shortened as far as possible while keeping the power, so the swing looks identical to a dink until it isn't. Disciplined about what he attacks — takes the dead dink, not the aggressive one — but varies the target constantly between line, middle and the opponent's hip. High-energy, explosive, effective in singles as well as doubles.",
    watchFor: "Shorten your backswing on speed-ups so the ball arrives sooner and your opponent can't read it from your motion.",
    ratings: r(3, 3, 4, 4, 3, 3, 3, 3, 5, 4, 3, 5, 4, 3, 3),
    confidence: "medium",
    sources: [
      "https://www.thedinkpickleball.com/christian-alshon-teaches-the-forehand-attack-in-pickleball/",
      "https://www.ppatour.com/athletes/christian-alshon/",
    ],
  },
  {
    slug: "gabriel-tardio",
    name: "Gabriel Tardio",
    format: "doubles",
    oneLine:
      "A counter-puncher at the kitchen line — a low loaded ready position, then your speed-up punched back at your feet faster than you can recover.",
    signature:
      "Chokes up on the paddle so it feels lighter and whips faster, which is the mechanical source of the hand speed. Ready position sits lower than normal with shoulders tilted forward, so he covers both wings and never gets stuck in a chicken wing. The backhand counter is a compact punch angled down toward the feet, not a full swing. Uses reach to poach and press the net.",
    watchFor: "Lower your ready position and keep the paddle out in front so you counter with a punch, not a swing.",
    ratings: r(3, 4, 5, 5, 3, 3, 3, 4, 4, 3, 3, 5, 3, 3, 3),
    confidence: "medium",
    sources: [
      "https://www.thedinkpickleball.com/paddle-grip-technique-gabe-tardios-choking-up-secret/",
      "https://pickleball.com/learn/gabe-tardio-shares-secrets-behind-backhand-counter",
    ],
  },
  {
    slug: "riley-newman",
    name: "Riley Newman",
    format: "doubles",
    oneLine:
      "Hides a two-handed backhand speed-up inside a normal-looking dink and uses it to break open kitchen exchanges.",
    signature:
      "Stance and body language are identical to his dink motion; he drops the paddle tip early to load topspin, contacts at the apex and cuts the follow-through short so he's balanced for the counter. Aims crosscourt at the inside hip to jam the hands, and treats the speed-up as a setup rather than a winner. Athletic mover with a low centre of gravity who stays alive in defensive scrambles.",
    watchFor: "Make your speed-up look exactly like your dink — same stance, same relaxed body — and aim it at the opponent's inside hip.",
    ratings: r(4, 5, 5, 4, 4, 5, 4, 4, 3, 4, 3, 4, 4, 4, 3),
    confidence: "medium",
    sources: [
      "https://pickleballunion.com/riley-newman-backhand-speed-up-pickleball/",
      "https://www.theskilledpickle.com/blog/riley-newman-player-profile",
    ],
  },
  {
    slug: "tyson-mcguffin",
    name: "Tyson McGuffin",
    format: "doubles",
    oneLine:
      "A high-energy athlete who wins by retrieving what shouldn't be retrievable and refusing to give you a free ball.",
    signature:
      "Defensive coverage is the visible trait — quickness and digging out balls that look already gone. Starts points with a power serve meant to force errors rather than just begin the rally, drives the forehand to set up the net approach, and moves through the transition zone deliberately: attack only once balance, position and strike zone are set.",
    watchFor: "Don't attack until your feet are set and the ball is in your strike zone — reset instead, and only take the aggressive ball when you're balanced.",
    ratings: r(4, 4, 3, 3, 4, 5, 5, 5, 5, 5, 4, 3, 4, 4, 3),
    confidence: "medium",
    sources: [
      "https://www.calvinkeeney.com/pickleball-tips-i-learned-from-tyson-mcguffin/",
      "https://www.ppatour.com/athletes/tyson-mcguffin/",
    ],
  },
  {
    slug: "anna-leigh-waters",
    name: "Anna Leigh Waters",
    format: "both",
    oneLine:
      "Attacks off the ball before the rally can become a grind, reading the opponent's swing and firing first.",
    signature:
      "Runs around her forehand to hit a two-handed backhand that looks identical whether she dinks it or speeds it up, so opponents never get an early read. Holds the kitchen line with her weight forward and takes balls out of the air. Wins most points either as the initiator of a speed-up or as the counterattacker who wins the resulting hands battle, and takes low-margin drops to get to the line early and dictate.",
    watchFor: "Use the same setup and contact point for your dink and your speed-up so opponents can't tell which is coming.",
    ratings: r(4, 5, 5, 5, 3, 3, 3, 5, 4, 4, 4, 5, 4, 5, 4),
    confidence: "high",
    sources: [
      "https://www.thedinkpickleball.com/pro-analysis-the-real-reason-anna-leigh-waters-is-unbeatable/",
      "https://pickleball.com/people/why-is-anna-leigh-waters-so-dominant-zane-navratil-explains",
    ],
  },
  {
    slug: "catherine-parenteau",
    name: "Catherine Parenteau",
    format: "both",
    oneLine: "Wins by refusing to miss — a patient, high-percentage game built on the return and the third-shot drop.",
    signature:
      "Returns from a foot or two behind the baseline, stops her feet to hit cleanly, and drives the return deep and low so the opposing third shot has to come up. The drop is the signature: loose grip, shoulder-driven swing with no wrist, contact just after the apex on the way down, almost always crosscourt for the bigger target. Would rather dink one more ball than force a speed-up.",
    watchFor: "Loosen your grip and contact the ball after the apex on the way down — that alone stops most popped-up drops.",
    ratings: r(5, 4, 3, 3, 5, 4, 4, 4, 3, 5, 5, 2, 5, 4, 5),
    confidence: "high",
    sources: [
      "https://pickleballunion.com/catherine-parenteaus-third-shot-drop/",
      "https://pickleball.com/learn/mastering-the-return-of-serve-with-catherine-parenteau",
    ],
  },
  {
    slug: "anna-bright",
    name: "Anna Bright",
    format: "doubles",
    oneLine: "Elite decision-making — plays the situation rather than the ball, and almost never hands over a free point.",
    signature:
      "Takes her dinks at the apex rather than off the short hop, which keeps her upright at the line and lets her take the next ball out of the air. Won't speed up into a balanced, ready opponent — holds the dink until the geometry actually opens, then finishes with fast hands or an unexpected angle. Treats an unforced error as worse than a loss.",
    watchFor: "Before every speed-up, ask whether your opponent is balanced and ready — if they are, dink again.",
    ratings: r(5, 5, 5, 4, 4, 4, 3, 4, 3, 3, 4, 4, 5, 5, 5),
    confidence: "high",
    sources: [
      "https://www.thedinkpickleball.com/anna-bright-5-pickleball-iq-decisions-pros-make-every-point/",
      "https://www.thedinkpickleball.com/5-pickleball-improvement-tips-from-anna-bright/",
    ],
  },
  {
    slug: "parris-todd",
    name: "Parris Todd",
    format: "both",
    oneLine:
      "A disciplined, well-rounded game anchored by a compact two-handed backhand counter that turns opponents' attacks into her offense.",
    signature:
      "Low tight ready position with hands near the belly button and almost no backswing, so she is never late in a hands exchange; the power comes from core rotation, not arm swing, leaving her balanced for the next ball. Pushes anything hip-height or above flat rather than brushing for spin, and covers the down-the-line counter first. Very few unnecessary risks.",
    watchFor: "Shrink your backswing at the kitchen and counter flat with a body turn instead of an arm swing.",
    ratings: r(4, 4, 4, 4, 5, 4, 4, 5, 3, 4, 4, 3, 5, 4, 5),
    confidence: "medium",
    sources: [
      "https://www.thedinkpickleball.com/two-handed-backhand-counter-parris-todds-5-keys/",
      "https://pickleball.com/learn/parris-todd-breaks-down-the-two-handed-backhand-counter",
    ],
  },
  {
    slug: "jorja-johnson",
    name: "Jorja Johnson",
    format: "doubles",
    oneLine: "Pure offensive creativity — sees attack windows nobody else sees and fires into them, for better and worse.",
    signature:
      "Has the fastest hands in the women's game after Waters and can survive a full-speed firefight, so she wants the ball moving fast and finishes rallies with real power. Plays short-hop dinks off the bounce rather than at the apex, which leaves her lower and later than opponents in long crosscourt exchanges. The flick is her escape hatch and she over-reaches for it, so matches swing between untouchable winners and strings of unforced errors.",
    watchFor: "Her willingness to take the ball out of the air and end the point instead of passively dinking a fifteenth ball.",
    ratings: r(2, 3, 5, 5, 2, 3, 3, 3, 3, 3, 3, 5, 2, 4, 2),
    confidence: "medium",
    sources: [
      "https://thekitchenpickle.com/blogs/news/jw-jorja-johnson-2026-results-losses-finals-drought/",
      "https://www.ppatour.com/athletes/jorja-johnson/",
    ],
  },
  {
    slug: "callie-jo-smith",
    name: "Callie Jo Smith",
    format: "both",
    oneLine: "Athletic, defense-first aggression — digs out balls most pros wave at, then punishes anything that floats.",
    signature:
      "Constant lateral movement along the kitchen line looking to jump the sideline and cut off crosscourt dinks. Favourite balls are high ones: the forehand volley and the overhead are her best shots, and she uses a backhand flick to take crosscourt dinks out of the air and redirect them at the net player. Reload speed between shots in a firefight is a visible asset, and the fitness shows late in games.",
    watchFor: "Step into the kitchen as the ball bounces rather than reaching for it — her own fix for popping dinks up.",
    ratings: r(4, 4, 4, 5, 3, 5, 4, 4, 3, 3, 3, 4, 3, 3, 3),
    confidence: "medium",
    sources: [
      "https://pickleballcentral.com/blog/meet-the-pro-callie-jo-smith/",
      "https://www.pickleballmagazine.com/meet-the-pros/callie-jo-smith",
    ],
  },
  {
    slug: "lea-jansen",
    name: "Lea Jansen",
    format: "both",
    oneLine: "Firepower and forward pressure — drives the ball and crashes the net rather than playing the soft game.",
    signature:
      "The forehand is the engine: pace from the back of the court to take control of rallies and force opponents into reactive positions instead of settling into a crosscourt dink battle. The signature doubles pattern is the shake and bake — hit a hard third or fifth and immediately crash forward so the partner can poach the block — which makes transition-zone play far more central than her reset game.",
    watchFor: "The shake and bake — drive the third, then move forward immediately so your partner can put away the block.",
    ratings: r(2, 3, 4, 4, 2, 3, 5, 3, 3, 3, 2, 5, 2, 3, 3),
    confidence: "medium",
    sources: [
      "https://www.topcourt.com/p/lea-jansen",
      "https://www.theskilledpickle.com/blog/lea-janse-player-profile",
    ],
  },
];

/** Positional helper so a profile's ratings read as one line in SKILL_KEYS order. */
function r(...values: number[]): Record<string, number> {
  if (values.length !== SKILL_KEYS.length) {
    throw new Error(`pro playstyle ratings must give all ${SKILL_KEYS.length} skills, got ${values.length}`);
  }
  return Object.fromEntries(SKILL_KEYS.map((k, i) => [k, values[i]]));
}

export interface PlaystyleMatch {
  slug: string;
  name: string;
  oneLine: string;
  signature: string;
  watchFor: string;
  confidence: ProPlaystyle["confidence"];
  sources: string[];
  /** -1..1 shape agreement. Above ~0.5 is a real resemblance. */
  similarity: number;
  /** The skills that pushed this match, strongest first -- why it was chosen. */
  sharedStrengths: string[];
  /** Where the player and the pro most disagree -- the honest half. */
  divergences: string[];
}

/**
 * Fewer rated skills than this and the shape is noise, not a resemblance.
 *
 * FOUR, down from six. The analyst is told to rate "only skills this clip
 * supports" and to omit a skill rather than invent a number -- which is the
 * right instruction, and means a two-minute clip legitimately comes back with
 * four or five ratings. Six was set without checking that, and it silently
 * turned the whole feature off on exactly the short clips people test with.
 * Four is still enough for a shape: three points can only ever describe a
 * plane, and with two the cosine of the centred vectors is +/-1 for everyone.
 */
export const MIN_RATED_SKILLS = 4;

/**
 * Closest pros by SHAPE, best first. Empty when there is not enough to compare.
 *
 * Centring on each side's own mean is the whole method and the reason this is
 * not just "who is also good at dinking". A 3.0 rated {dinking 3, hands 2,
 * offense 2} and Ben Johns rated {dinking 5, hands 4, offense 3} have the same
 * SHAPE -- soft game ahead of hands ahead of offense -- even though every raw
 * number differs by two. Cosine similarity on the centred vectors is exactly
 * that comparison, and it is scale-free, so improving across the board does
 * not silently change who you play like.
 *
 * Only skills the analysis actually rated are used: an unrated skill is
 * dropped from BOTH vectors rather than imputed, because a zero would read as
 * "nothing like a pro at this" when it means "not seen in this clip".
 */
export function matchPlaystyles(
  userRatings: Record<string, number>,
  limit = 3
): PlaystyleMatch[] {
  const keys = SKILL_KEYS.filter((k) => typeof userRatings[k] === "number" && Number.isFinite(userRatings[k]));
  if (keys.length < MIN_RATED_SKILLS) return [];

  const user = keys.map((k) => userRatings[k]);
  const userC = centre(user);
  // A player rated identically across the board has no shape to match. That is
  // a real outcome for a short clip, and saying nothing is better than picking
  // whichever pro happens to sit nearest to flat.
  if (norm(userC) === 0) return [];

  const scored = PRO_PLAYSTYLES.map((pro) => {
    const proVec = keys.map((k) => pro.ratings[k]);
    const proC = centre(proVec);
    const similarity = cosine(userC, proC);
    // Shared strengths: both sides above their own average, ranked by how much
    // the pair agrees. "We both lean on this" is the sentence being justified.
    const agreement = keys.map((k, i) => ({ k, score: userC[i] * proC[i], userAbove: userC[i] > 0 }));
    const sharedStrengths = agreement
      .filter((a) => a.score > 0 && a.userAbove)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((a) => a.k);
    const divergences = agreement
      .filter((a) => a.score < 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 2)
      .map((a) => a.k);
    return { pro, similarity, sharedStrengths, divergences };
  })
    .filter((s) => Number.isFinite(s.similarity))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored.map(({ pro, similarity, sharedStrengths, divergences }) => ({
    slug: pro.slug,
    name: pro.name,
    oneLine: pro.oneLine,
    signature: pro.signature,
    watchFor: pro.watchFor,
    confidence: pro.confidence,
    sources: pro.sources,
    similarity: Math.round(similarity * 1000) / 1000,
    sharedStrengths,
    divergences,
  }));
}

function centre(v: number[]): number[] {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return v.map((x) => x - mean);
}

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((a, b) => a + b * b, 0));
}

function cosine(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return Number.NaN;
  return a.reduce((sum, x, i) => sum + x * b[i], 0) / (na * nb);
}
