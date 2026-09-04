export function Footer() {
  return (
    <footer style={{ background: "var(--card)" }}>
      <div
        className="row"
        style={{
          maxWidth: 1140,
          margin: "0 auto",
          padding: "var(--a5)",
          justifyContent: "space-between",
          gap: "var(--a3)",
        }}
      >
        <span className="xs">© {new Date().getFullYear()} Baseline. All rights reserved.</span>
        <span className="xs">Built for players who want to get better, faster.</span>
      </div>
    </footer>
  );
}
