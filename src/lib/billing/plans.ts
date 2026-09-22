/**
 * The plans as the MARKETING pages describe them.
 *
 * Allowances come from quota.ts, the same constants the run gate enforces, so
 * the pricing page cannot promise a minute the product will refuse. Prices are
 * the one thing duplicated here, because the public pages render without a
 * Stripe call: CHANGE A PRICE IN STRIPE, CHANGE IT HERE. Inside the app the
 * buttons read the live price from Stripe and cannot drift.
 */
import { MINUTES_PER_MONTH, PRO_MINUTES_PER_MONTH } from "@/lib/db/quota";

export const PLAN_PRICE = "$20";

export interface PlanCard {
  key: "free" | "pro";
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
    summary: "Try it on part of a game.",
    points: [
      `${MINUTES_PER_MONTH} minutes a month — a stretch of one game`,
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
      `${PRO_MINUTES_PER_MONTH} minutes a month — about six full games`,
      "Everything in Free, on whole games",
      "Enough games to see your progress week to week",
      "Cancel any time from your account",
    ],
    cta: "Get the monthly plan",
    featured: true,
  },
];
