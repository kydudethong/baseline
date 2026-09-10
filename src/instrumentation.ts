/**
 * Server start-up hook. Next.js calls register() once per server process.
 *
 * This is where the idle watchdog goes rather than in middleware, because
 * middleware runs on the Edge runtime: no setInterval that outlives a request,
 * no shared module state with the Node server, and no route to Fly's 6PN
 * network. The watchdog needs all three.
 */
export async function register(): Promise<void> {
  // Guarded: the same file is evaluated for the edge runtime too, where the
  // import would pull Node-only assumptions into a bundle that cannot use them.
  // NEXT_RUNTIME is inlined per bundle at build time ("nodejs" | "edge"), but
  // do not treat an ABSENT value as "not node". If it ever fails to be
  // inlined, an early return here would silently disable the watchdog and the
  // only symptom would be a bill.
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { startIdleWatchdog } = await import("@/lib/analysis/idle-sleep");
  startIdleWatchdog();
}
