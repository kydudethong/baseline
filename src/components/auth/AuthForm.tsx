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
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        {state.message}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {fields.map((field) => (
        <div key={field.name}>
          <label
            htmlFor={field.name}
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            {field.label}
          </label>
          <input
            id={field.name}
            name={field.name}
            type={field.type}
            autoComplete={field.autoComplete}
            placeholder={field.placeholder}
            required
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
          />
          {state?.fieldErrors?.[field.name] ? (
            <p className="mt-1 text-sm text-red-600">
              {state.fieldErrors[field.name][0]}
            </p>
          ) : null}
        </div>
      ))}

      {state?.error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending
          ? "Please wait…"
          : mode === "login"
            ? "Log in"
            : "Create account"}
      </button>

      <p className="text-center text-sm text-slate-500">
        {mode === "login" ? (
          <>
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-emerald-700 hover:underline">
              Sign up
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-emerald-700 hover:underline">
              Log in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
