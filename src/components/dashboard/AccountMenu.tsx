"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { logout } from "@/app/actions/auth";
import { updateProfile, type ProfileFormState } from "@/app/actions/profile";

const SKILL_LEVELS = ["2.5", "3.0", "3.5", "4.0", "4.5", "5.0+"];

/**
 * Who you are, what the app knows about you, and the way out.
 *
 * THE CORNER USED TO BE A NAME AND A "LOG OUT" LINK, which is the one thing
 * nobody opens an account menu to do first. Everything the app actually knows
 * about a player — the skill level and paddle hand that go into every coaching
 * prompt, how many games they have analysed, how long they have been here —
 * lived either in a form buried in the analysis setup or nowhere at all. A
 * player could not see the numbers their coaching was being written against,
 * let alone correct them.
 *
 * So the menu is: who you are, what we are assuming about you (editable, in
 * place), what you have done, and then the way out — last, because logging out
 * is a thing you do once and the rest is a thing you check.
 *
 * ON THE CLIENT because a menu has to open and close, but the writes are
 * server actions: nothing here holds a session token or talks to the database.
 */
export function AccountMenu({
  name, email, initial, skillLevel, paddleHand, gamesAnalysed, memberSince,
}: {
  name: string;
  email: string;
  initial: string;
  skillLevel: string | null;
  paddleHand: string | null;
  gamesAnalysed: number;
  /** ISO date the profile row was created. */
  memberSince: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    updateProfile, {}
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // CLOSE ON AN OUTSIDE CLICK AND ON ESCAPE. A menu that can only be dismissed
  // by hitting the same button again is a menu people leave open and then
  // click straight through.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // NO EFFECT CLOSES THE EDITOR ON A SUCCESSFUL SAVE, and not closing it is
  // the better behaviour anyway. Auto-closing means the confirmation is a
  // panel disappearing, which is indistinguishable from a cancel; staying
  // open with "Saved." beside the field shows what happened and to what. It
  // also avoids setting state inside an effect, which is a cascading render
  // and which the linter is right to refuse.

  const since = memberSince
    ? new Date(memberSince).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : null;

  return (
    <div className="acct" ref={wrapRef}>
      <button
        type="button"
        className="acct-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${name}`}
      >
        <span className="rail-av">{initial}</span>
        <span className="acct-who">
          <span className="nm">{name}</span>
          <span className="sub">{skillLevel ? `${skillLevel} · ` : ""}Account</span>
        </span>
        <span className="acct-caret" aria-hidden="true">⌃</span>
      </button>

      {open ? (
        <div className="acct-menu" role="menu">
          <div className="acct-head">
            <span className="rail-av lg">{initial}</span>
            <span className="acct-id">
              <strong>{name}</strong>
              <span className="acct-email" title={email}>{email}</span>
            </span>
          </div>

          <div className="acct-stats">
            <div>
              <span className="acct-num">{gamesAnalysed}</span>
              <span className="acct-lbl">{gamesAnalysed === 1 ? "game" : "games"} analysed</span>
            </div>
            {since ? (
              <div>
                <span className="acct-num sm">{since}</span>
                <span className="acct-lbl">member since</span>
              </div>
            ) : null}
          </div>

          {/* WHAT THE COACHING IS ASSUMING ABOUT YOU. These two go into the
              prompt on every run — a read written for a 3.0 says different
              things than one written for a 4.5 — so a player who cannot see
              them cannot tell whether their coaching is aimed at them. */}
          {editing ? (
            <form action={action} className="acct-form">
              <label className="acct-field">
                <span>Name</span>
                <input name="display_name" defaultValue={name} maxLength={60} />
              </label>
              <label className="acct-field">
                <span>Skill level</span>
                <select name="skill_level" defaultValue={skillLevel ?? ""}>
                  <option value="">Not set</option>
                  {SKILL_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label className="acct-field">
                <span>Paddle hand</span>
                <select name="paddle_hand" defaultValue={paddleHand ?? ""}>
                  <option value="">Not set</option>
                  <option value="right">Right</option>
                  <option value="left">Left</option>
                </select>
              </label>
              {state.error ? <p className="acct-err">{state.error}</p> : null}
              {state.message && !state.error ? <p className="acct-ok">{state.message}</p> : null}
              <div className="acct-actions">
                <button type="submit" className="btn btn-optic btn-sm" disabled={pending}>
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button" className="btn btn-soft btn-sm"
                  onClick={() => setEditing(false)}
                >
                  {state.message && !state.error ? "Done" : "Cancel"}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="acct-rows">
                <div className="acct-row">
                  <span>Skill level</span>
                  <strong className={skillLevel ? "" : "unset"}>{skillLevel ?? "Not set"}</strong>
                </div>
                <div className="acct-row">
                  <span>Paddle hand</span>
                  <strong className={paddleHand ? "" : "unset"}>
                    {paddleHand ? paddleHand[0].toUpperCase() + paddleHand.slice(1) : "Not set"}
                  </strong>
                </div>
              </div>
              <p className="acct-note">
                Both go into every coaching read, so a wrong one changes the advice.
              </p>
              <button type="button" className="acct-item" onClick={() => setEditing(true)}>
                <span aria-hidden="true">✎</span> Edit these details
              </button>
            </>
          )}

          {/* LAST, and visually separated. Logging out is the thing you do once
              and the rest is what you came to check — putting it first is how
              somebody signs out reaching for their own skill level. */}
          <form action={logout} className="acct-out">
            <button type="submit" className="acct-item danger">
              <span aria-hidden="true">→]</span> Log out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
