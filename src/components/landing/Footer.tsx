export function Footer() {
  return (
    <footer className="bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-slate-500 sm:flex-row">
        <span>© {new Date().getFullYear()} Baseline. All rights reserved.</span>
        <span>Built for players who want to get better, faster.</span>
      </div>
    </footer>
  );
}
