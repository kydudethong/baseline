import Link from "next/link";

export function Nav({ isAuthed }: { isAuthed: boolean }) {
  return (
    <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-slate-900">
          Baseline
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-slate-600 sm:flex">
          <a href="#how-it-works" className="hover:text-slate-900">
            How it works
          </a>
          <a href="#features" className="hover:text-slate-900">
            What you get
          </a>
        </nav>
        <div className="flex items-center gap-3">
          {isAuthed ? (
            <Link
              href="/dashboard"
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden text-sm font-medium text-slate-600 hover:text-slate-900 sm:block"
              >
                Log in
              </Link>
              <Link
                href="/signup"
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
