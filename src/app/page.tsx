import { createClient } from "@/lib/supabase/server";
import { Nav } from "@/components/landing/Nav";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Features } from "@/components/landing/Features";
import { Footer } from "@/components/landing/Footer";

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const analyzeHref = user ? "/dashboard/new" : "/signup";

  return (
    <div className="min-h-screen" style={{ background: "var(--paper)" }}>
      <Nav isAuthed={Boolean(user)} />
      <Hero analyzeHref={analyzeHref} />
      <HowItWorks />
      <Features />
      <Footer />
    </div>
  );
}
