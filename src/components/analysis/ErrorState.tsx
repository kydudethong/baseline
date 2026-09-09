import type { ReactNode } from "react";

/**
 * What happened, and what to do about it — never a stack trace.
 *
 * `detail` is the machine's own words. It is shown, because hiding it leaves
 * someone with nothing to search for or paste to us, but it sits BELOW the
 * plain-language explanation so it never has to be read first.
 */
export function ErrorState({
  title, body, detail, action,
}: {
  title: string;
  body: string;
  detail?: string | null;
  action?: ReactNode;
}) {
  return (
    <div className="errbox" role="alert">
      <span className="errbox-t">{title}</span>
      <span className="errbox-b">{body}</span>
      {detail ? <span className="xs mono" style={{ wordBreak: "break-word" }}>{detail}</span> : null}
      {action ? <div className="errbox-a">{action}</div> : null}
    </div>
  );
}
