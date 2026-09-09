/**
 * Is this process running on a laptop, or on the hosted server?
 *
 * Two places need the answer and they must not drift: the upload page decides
 * whether to show the "paste a link" box at all, and the fetch route decides
 * which failure message to write. They used to compute the same expression
 * separately under different names — one called it `linkFetchWorks`, the other
 * `selfHosted` — which is how one gets updated and the other does not.
 *
 * FLY_APP_NAME is injected by Fly into every Machine, so it is the direct
 * signal. NODE_ENV is the backstop for any other host: a production build is
 * not a laptop.
 */
export function isLocalDev(): boolean {
  return !process.env.FLY_APP_NAME && process.env.NODE_ENV !== "production";
}

/**
 * Whether pasting a video link can actually work here.
 *
 * It cannot on the server, and that is a property of the internet rather than
 * a bug in this code: YouTube treats datacenter IPs as suspicious and answers
 * "Sign in to confirm you're not a bot". Getting past that means handing it a
 * real account's cookies or renting a residential proxy — defeating a bot
 * check with a personal account, or paying to break the same rule. Neither is
 * something this product should do, so the feature is simply local-only.
 */
export function linkFetchAvailable(): boolean {
  return isLocalDev();
}
