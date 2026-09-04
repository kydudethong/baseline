"use client";

import { useActionState } from "react";
import Link from "next/link";
import type { AuthFormState } from "@/lib/auth/schema";

type Field = {
  name: string;
  label: string;
  type: string;
  autoComplete: string;
  placeholder?: string;
};

export function AuthForm({
  mode,
  action,
  fields,
  next,
}: {
  mode: "login" | "signup";
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  fields: Field[];
  next?: string;
}) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(
    action,
    undefined
  );

  if (state?.message) {
    return (
      <div className="note" style={{ color: "var(--good)", background: "var(--good-wash)" }}>
        {state.message}
      </div>
    );
  }

  return (
    <form action={formAction} className="stack g4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {fields.map((field) => (
        <div key={field.name} className="stack g1">
          <label htmlFor={field.name} className="sm" style={{ fontWeight: 600, color: "var(--ink)" }}>
            {field.label}
          </label>
          <input
            id={field.name}
            name={field.name}
            type={field.type}
            autoComplete={field.autoComplete}
            placeholder={field.placeholder}
            required
            style={{
              width: "100%",
              height: 42,
              borderRadius: "var(--r2)",
              border: "1px solid var(--line-strong)",
              background: "var(--card)",
              padding: "0 12px",
              fontSize: 14,
              color: "var(--ink)",
              outline: "none",
            }}
          />
          {state?.fieldErrors?.[field.name] ? (
            <p className="xs" style={{ color: "var(--bad)" }}>
              {state.fieldErrors[field.name][0]}
            </p>
          ) : null}
        </div>
      ))}

      {state?.error ? <div className="error">{state.error}</div> : null}

      <button type="submit" disabled={pending} className="btn btn-primary" style={{ width: "100%" }}>
        {pending ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
      </button>

      <p className="sm" style={{ textAlign: "center" }}>
        {mode === "login" ? (
          <>
            Don&apos;t have an account?{" "}
            <Link href="/signup" style={{ fontWeight: 600, color: "var(--blue-deep)" }}>
              Sign up
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" style={{ fontWeight: 600, color: "var(--blue-deep)" }}>
              Log in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
