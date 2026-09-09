import Link from "next/link";
import Image from "next/image";
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
    <main
      className="row"
      style={{ minHeight: "100vh", justifyContent: "center", alignItems: "center", padding: "var(--a4)" }}
    >
      <div style={{ width: "100%", maxWidth: 340 }} className="stack g5">
        <Link href="/" className="logo" style={{ justifyContent: "center" }}>
{/* The DARK mark. There are two files and the choice is not cosmetic:
          baseline-mark.png is a white B with a white speed-trail, so on the
          light ground it is white on near-white and only the green ball
          survives. The dark variant recolours exactly the achromatic pixels
          and leaves the ball untouched, so it is the same logo rather than a
          second one. White stays on the landing hero, which is still dark. */}
          <Image src="/brand/baseline-mark-dark.png" alt="" width={494} height={420} style={{ height: 24, width: "auto" }} priority />
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
