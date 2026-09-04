import Link from "next/link";
import type { Metadata } from "next";
import { signup } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth/AuthForm";
import { Ball } from "@/components/motifs/Motifs";

export const metadata: Metadata = { title: "Sign up — Baseline" };

export default function SignupPage() {
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
          <h1 className="h2">Create your account</h1>
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
