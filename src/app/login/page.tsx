import Link from "next/link";
import type { Metadata } from "next";
import { login } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata: Metadata = { title: "Log in — Baseline" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block text-center text-lg font-bold text-slate-900">
          Baseline
        </Link>
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="mb-6 text-xl font-semibold text-slate-900">Welcome back</h1>
          <AuthForm
            mode="login"
            action={login}
            next={next}
            fields={[
              { name: "email", label: "Email", type: "email", autoComplete: "email" },
              {
                name: "password",
                label: "Password",
                type: "password",
                autoComplete: "current-password",
              },
            ]}
          />
        </div>
      </div>
    </main>
  );
}
