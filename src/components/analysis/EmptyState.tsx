import type { ReactNode } from "react";

/**
 * A screen with nothing in it should still tell you what to do next.
 *
 * Deliberately says what is missing rather than what went wrong: "no games
 * yet" is a stage of using the product, not a failure, and dressing it as an
 * error makes a new account feel broken.
 */
export function EmptyState({
  title, body, action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="blank">
      <p className="blank-t">{title}</p>
      <p className="blank-b">{body}</p>
      {action ? <div className="blank-a">{action}</div> : null}
    </div>
  );
}
