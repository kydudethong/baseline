/**
 * What each skill IS, and what to do about yours.
 *
 * WHY THIS IS WRITTEN DOWN RATHER THAN GENERATED. A rating is a number with no
 * handle on it: told your kitchen game is a 2, a player's next question is
 * "a 2 at what?", and the model's one-line basis answers that for THIS clip
 * without saying what the skill is or how anyone gets better at it. Asking a
 * model for that on every page load would cost a call, take seconds, and
 * return a slightly different answer each time to a question whose answer does
 * not change between Tuesday and Thursday.
 *
 * So the durable half -- what good looks like, the faults that actually cost
 * points, what to work on -- is written here once, and the per-game half stays
 * where it belongs: the model's `basis` for this rating, shown alongside.
 *
 * WRITTEN AS A COACH WOULD SAY IT. "Common faults" are the mistakes real
 * players make at 3.0-4.0, not an exhaustive list, and "how to improve" names
 * something doable this week rather than a principle. Nothing here is
 * personalised, and the UI must never present it as though it were.
 */

export interface SkillGuide {
  /** One sentence: what this skill actually covers. */
  what: string;
  /** What it looks like when it is a strength. */
  strength: string;
  /** The way it usually goes wrong. */
  weakness: string;
  /** Something to work on, concrete enough to do at the next session. */
  improve: string;
}

export const SKILL_GUIDES: Record<string, SkillGuide> = {
  dinking: {
    what: "Soft shots into the kitchen that keep the ball unattackable.",
    strength:
      "Your dinks land low over the net and deep enough in the kitchen that nobody can lean in on them, and you can do it from both wings without changing your grip pressure.",
    weakness:
      "Dinks float. A ball that crosses the net above net height is an invitation, and the point is usually lost two shots later rather than immediately — which is why it does not feel like the dink was the mistake.",
    improve:
      "Push from the shoulder with a quiet wrist and aim to clear the tape by inches, not feet. Cross-court first: it is the longer, safer diagonal and it is where most kitchen points are actually played.",
  },
  kitchen: {
    what: "Everything that happens once both teams are at the non-volley line.",
    strength:
      "You get to the line and stay there, you are patient in long exchanges, and you recognise the ball you can speed up rather than forcing one.",
    weakness:
      "Backing off the line under pressure. One step back turns every following ball into a half-volley and hands the net to the other team for the rest of the point.",
    improve:
      "Make holding the line the rule and stepping back the exception. When a ball is on you, take it out of the air with a soft block instead of retreating to let it bounce.",
  },
  hands: {
    what: "Fast exchanges at the net where there is no time to swing.",
    strength:
      "Your paddle is up and in front before the exchange starts, so you are blocking and redirecting rather than reacting late.",
    weakness:
      "Paddle drifting down between shots. Hand battles are decided by where the paddle already is — nobody is fast enough to fix that once the ball is travelling.",
    improve:
      "Paddle tip up, out in front of your chest, every single reset. Then drill firefights from six feet: the point is not to win them, it is to stop the paddle dropping.",
  },
  volleys: {
    what: "Balls taken out of the air, usually at or near the kitchen line.",
    strength:
      "You punch through the ball with a compact motion and keep it low, rather than swinging at it.",
    weakness:
      "Over-swinging. A volley has no backswing; the pace is already there and adding to it mostly sends the ball long.",
    improve:
      "Practise catching the ball on the paddle face with no follow-through at all, then add the smallest punch that still gets it deep.",
  },
  resets: {
    what: "Taking pace off a hard ball and dropping it into the kitchen.",
    strength:
      "Under attack you can absorb and land the ball soft and short, which turns a defensive point back into a neutral one.",
    weakness:
      "Popping the reset up. A reset that lands above net height is worse than no reset — it hands over an attackable ball from a position you were already defending.",
    improve:
      "Soft hands and a still paddle: let the ball come to you and take the grip pressure almost to nothing at contact. Have a partner drive at your feet from the kitchen and reset every one.",
  },
  defense: {
    what: "What you do when the other team has the advantage — including the return.",
    strength:
      "You stay in points you should have lost: blocking, resetting, and getting one more ball back rather than swinging for a way out.",
    weakness:
      "Trying to escape with one big shot. Counter-attacking from a bad position mostly ends the point in the other team's favour a shot earlier.",
    improve:
      "Decide before the point that your first answer to pressure is a reset, not a counter. Give yourself permission to hit three boring balls in a row.",
  },
  transition: {
    what: "Moving from the baseline to the kitchen line without getting caught in between.",
    strength:
      "You move in behind good shots, stop when you need to split-step, and arrive at the line balanced rather than sprinting through it.",
    weakness:
      "Running through the transition zone. Being caught mid-court with the ball at your feet is the worst place on the court, and it is usually caused by advancing behind a shot that did not earn it.",
    improve:
      "Advance only as far as your shot deserves, and split-step before every contact. Drill it: drop, two steps, freeze, reset, two more steps.",
  },
  positioning: {
    what: "Where you stand, and whether you and your partner move as a pair.",
    strength:
      "You and your partner stay connected — moving up, back and side to side together, without a lane opening between you.",
    weakness:
      "Drifting apart. Most balls that go 'between' a team went through a gap somebody created several shots earlier by not moving with their partner.",
    improve:
      "Imagine a rope eight to ten feet long tying you to your partner. If it would have gone slack or snapped, one of you moved wrong.",
  },
  serve: {
    what: "Starting the point: depth, consistency and where you put it.",
    strength:
      "Deep serves that land consistently in, pushing the returner back and taking away their easy approach.",
    weakness:
      "Going long while chasing depth. A serve fault is the only free point in pickleball you can give away without an opponent doing anything.",
    improve:
      "Aim three feet inside the baseline rather than at it, and add shape rather than pace. A deep serve that lands is worth far more than a deeper one that sometimes does not.",
  },
  return: {
    what: "Neutralising the serve and getting yourself to the net.",
    strength:
      "Deep returns that give you time to walk in, so you arrive at the kitchen line before the third shot arrives.",
    weakness:
      "Short returns. A return that lands mid-court lets the serving team hit the third shot from close in and keeps you back.",
    improve:
      "Hit high and deep rather than hard — height buys you the seconds you need to get to the line. Follow it in every time, without exception.",
  },
  thirdshot: {
    what: "The serving team's shot after the return — drop or drive.",
    strength:
      "You pick the right one for the ball you got, and your drop lands in the kitchen rather than at the other team's feet.",
    weakness:
      "Forcing the drop from a bad ball, or driving every third because the drop feels risky. Both are the same mistake: not letting the return you got decide the shot.",
    improve:
      "Drop from a deep return, drive from a short one. Drill both from the baseline until the choice stops feeling like a decision.",
  },
  offense: {
    what: "Creating and finishing points — speed-ups, drives and put-aways.",
    strength:
      "You attack the ball that is actually attackable, and when you do you finish it rather than restarting the rally.",
    weakness:
      "Speeding up balls below net height. Attacking from under the tape means hitting up, which gives the other team the first genuine attack of the exchange.",
    improve:
      "One rule: only speed up a ball you can contact at or above net height. Count how often you break it in a session — the number is usually surprising.",
  },
  selection: {
    what: "Choosing the right shot for the situation.",
    strength:
      "Your shot fits the ball and the position — patient when patience is right, aggressive when the ball genuinely offers it.",
    weakness:
      "One default shot for every situation, usually the most aggressive one available.",
    improve:
      "After each point you lose, name the one shot you would take back. Patterns show up within a single session.",
  },
  iq: {
    what: "Reading the point: score, positioning, and what the other team is doing.",
    strength:
      "You play the score, target the weaker opponent, and notice patterns within a game rather than after it.",
    weakness:
      "Playing every point identically regardless of score or who is in front of you.",
    improve:
      "Pick one thing to notice per game — which opponent's backhand is weaker, say — and play to it deliberately.",
  },
  consistency: {
    what: "Unforced errors, and how many balls you keep in play.",
    strength:
      "You rarely give points away. Most of your losses are earned by the other team rather than handed over.",
    weakness:
      "Errors clustering under pressure or late in games, usually from trying to end points early.",
    improve:
      "Count your unforced errors for one session. Just counting them tends to halve them, and it tells you which shot is actually costing you.",
  },
};

export function skillGuide(key: string): SkillGuide | null {
  return SKILL_GUIDES[key] ?? null;
}

/**
 * The four groups on the radar, explained.
 *
 * SEPARATE FROM THE PER-SKILL GUIDES ABOVE, because an axis is not a skill. A
 * player looking at "Offense 4.00" is looking at an average of their serve,
 * their third shot and their attacking, and telling them how to improve "the
 * serve" would be answering a question they did not ask. The group entry has
 * to describe the group.
 *
 * These are the ones the chart shows, so these are the ones that get an icon.
 */
export const GROUP_GUIDES: Record<string, SkillGuide> = {
  Kitchen: {
    what: "Everything at the non-volley line: dinks, hands battles, volleys and the patience to stay there.",
    strength:
      "You get to the line early and hold it. Your dinks stay low and unattackable, and in a fast exchange your paddle is already up rather than catching up.",
    weakness:
      "Backing off the line, and floating dinks. Both hand the net to the other team — one immediately, one two shots later, which is why the dink rarely feels like the mistake.",
    improve:
      "Make holding the line the rule and stepping back the exception. Dink cross-court until you can clear the tape by inches on demand, and keep the paddle tip up between every shot.",
  },
  Movement: {
    what: "Getting where you need to be: transition from the baseline, court coverage, and moving as a pair.",
    strength:
      "You advance behind shots that earn it, split-step before contact, and stay connected to your partner rather than drifting.",
    weakness:
      "Running through the transition zone, and gaps opening between partners. Being caught mid-court with the ball at your feet is the worst place to stand in this sport.",
    improve:
      "Advance only as far as your shot deserves, and split-step every time. Imagine a ten-foot rope to your partner: if it would have gone slack, one of you moved wrong.",
  },
  Offense: {
    what: "Creating pressure and finishing points — the serve, the third shot, drives and speed-ups.",
    strength:
      "Deep serves that land, a third shot chosen to fit the return you got, and attacks you actually finish rather than restarting the rally.",
    weakness:
      "Speeding up balls below net height, and going long chasing serve depth. A serve fault is the only free point you can hand over without an opponent doing anything.",
    improve:
      "One rule for attacking: only speed up a ball you can contact at or above net height. For serves, aim three feet inside the baseline and add shape rather than pace.",
  },
  Defense: {
    what: "Staying in points you are losing — the return, resets, blocks and absorbing pace.",
    strength:
      "Deep returns that buy you time to reach the net, and resets that land soft and low when you are under attack.",
    weakness:
      "Trying to escape with one big counter, and popping resets above net height. Both end the point in the other team's favour a shot earlier than necessary.",
    improve:
      "Decide before the point that your first answer to pressure is a reset, not a counter. Return high and deep, and follow it in every single time.",
  },
};

export function groupGuide(group: string): SkillGuide | null {
  return GROUP_GUIDES[group] ?? null;
}
