import Link from "next/link";
import type { Metadata } from "next";
import { login } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth/AuthForm";
import { Ball } from "@/components/motifs/Motifs";

export const metadata: Metadata = { title: "Log in — Baseline" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main
      className="row"
      style={{ minHeight: "100vh", justifyContent: "center", alignItems: "center", padding: "var(--a4)" }}
    >
      <div style={{ width: "100%", maxWidth: 340 }} className="stack g5">
        <Link href="/" className="logo" style={{ justifyContent: "center" }}>
          <Ball size={22} />
          <span className="wm">Baseline</span>
        </Link>
        <div className="card stack g4">
          <h1 className="h2">Welcome back</h1>
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
