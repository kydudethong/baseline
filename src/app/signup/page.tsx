import Link from "next/link";
import type { Metadata } from "next";
import { signup } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata: Metadata = { title: "Sign up — Baseline" };

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block text-center text-lg font-bold text-slate-900">
          Baseline
        </Link>
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="mb-6 text-xl font-semibold text-slate-900">Create your account</h1>
          <AuthForm
            mode="signup"
            action={signup}
            fields={[
              {
                name: "displayName",
                label: "Name",
                type: "text",
                autoComplete: "name",
              },
              { name: "email", label: "Email", type: "email", autoComplete: "email" },
              {
                name: "password",
                label: "Password",
                type: "password",
                autoComplete: "new-password",
                placeholder: "At least 8 characters",
              },
            ]}
          />
        </div>
      </div>
    </main>
  );
}
