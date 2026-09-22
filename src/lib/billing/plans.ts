/**
 * The plans as the MARKETING pages describe them.
 *
 * Allowances come from quota.ts, the same constants the run gate enforces, so
 * the pricing page cannot promise a minute the product will refuse. Prices are
 * the one thing duplicated here, because the public pages render without a
 * Stripe call: CHANGE A PRICE IN STRIPE, CHANGE IT HERE. Inside the app the
 * buttons read the live price from Stripe and cannot drift.
 */
import { GAME_MAX_MINUTES, MINUTES_PER_MONTH, PRO_MINUTES_PER_MONTH } from "@/lib/db/quota";

export const PLAN_PRICE = "$14.99";
export const GAME_PRICE = "$3.99";

export interface PlanCard {
  key: "free" | "game" | "pro";
  name: string;
  price: string;
  per: string;
  summary: string;
  points: string[];
  cta: string;
  featured?: boolean;
}

export const PLANS: PlanCard[] = [
  {
    key: "free",
    name: "Free",
    price: "$0",
    per: "every month",
    summary: "See what a read is, on your own game.",
    points: [
      `${MINUTES_PER_MONTH} minutes a month — about one game`,
      "The full read: rallies, technique, what to fix first",
      "Drills matched to what it found",
      "Your partner read, if you tag your partner",
      "Share the read with a link, no account needed to view it",
    ],
    cta: "Start free",
  },
  {
    key: "pro",
    name: "Monthly",
    price: PLAN_PRICE,
    per: "a month",
    summary: "For people who play every week.",
    points: [
      `${PRO_MINUTES_PER_MONTH} minutes a month — about six games`,
      "Everything in Free, on every game",
      "Enough games to see your progress week to week",
      "Cancel any time from your account",
    ],
    cta: "Get the monthly plan",
    featured: true,
  },
  {
    key: "game",
    name: "One game",
    price: GAME_PRICE,
    per: "per game",
    summary: "Out of free minutes and just want this one read.",
    points: [
      `One game up to ${GAME_MAX_MINUTES} minutes`,
      "Doesn't touch your monthly minutes",
      "No subscription",
    ],
    cta: "Start free, buy a game when you need one",
  },
];
